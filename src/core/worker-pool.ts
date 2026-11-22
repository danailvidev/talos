import { randomUUID } from "node:crypto";
import type { NotificationRepository } from "../application/ports.ts";
import type { Actor } from "./actor.ts";
import { describeError, isRetryableCause, isTerminal } from "./errors.ts";
import type { TaskExecutor } from "./executor.ts";
import { retryDelayMs, type Job, type JobQueue } from "./job.ts";
import type { TaskRegistry } from "./registry.ts";
import type { Logger } from "../logging/logger.ts";

/**
 * Runs queued jobs, bounded.
 *
 * The counterpart to `startScheduler`: the scheduler decides *when a loop looks*,
 * this decides *how much work happens at once*. Before it existed, concurrency
 * was a global boolean — `anyCodeReviewRunning()` refused to start a second AI
 * review anywhere on the server — which is a throughput ceiling of one for a team
 * of fifteen. Here it is a number, per kind, because a Claude container wants 2GB
 * and a Jira API call wants nothing.
 *
 * Polling rather than event-driven, deliberately. A one-second floor is invisible
 * next to a job that clones a repository, and polling is what makes a second
 * worker process correct with no coordination beyond the database.
 */
export interface WorkerPool {
  /**
   * Stops leasing and resolves once in-flight jobs have settled.
   *
   * Cancel the executor *first* (`executor.cancelAll()`): its runs abort, their
   * jobs are released back to the queue, and this resolves promptly. Calling it
   * alone waits for every job to finish naturally.
   */
  stop(): Promise<void>;
  /** In-flight job count exposed by `/api/system`. */
  active(): number;
}

export interface WorkerPoolDeps {
  logger: Logger;
  executor: TaskExecutor;
  taskRegistry: TaskRegistry;
  queue: JobQueue;
  /**
   * Resolves `job.actorId` to the developer the handler runs as, so the review
   * comment it posts carries the name of whoever owns the loop that found the
   * work rather than the shared bot's. Omitted, every job runs on the shared
   * credentials.
   */
  actorFor?(userId: string): Actor | undefined;
  /** Re-reads the registry so a job kind registered after boot is found. */
  refresh?(): void;
  /**
   * Backs the topbar Bell. When set, a job's "queued"/"running" notification
   * (see `review-requested/index.ts`) is removed the moment the job itself is
   * done — succeeded, or failed with no attempts left — so it never outlives
   * the work it was about.
   */
  notifications?: NotificationRepository;
}

export interface WorkerPoolOptions {
  /** Ceiling across every kind. */
  concurrency?: number;
  /**
   * Per-kind ceilings, by handler task id. A kind absent here is bounded only by
   * `concurrency`. Set agent-backed kinds low; they are memory-bound, not
   * IO-bound.
   */
  limits?: Record<string, number>;
  /**
   * Shared ceiling across every kind declared `agent: true`. Keep it at the
   * agent admission limit and below `concurrency`; unset leaves agent kinds
   * bounded only by `concurrency` and `limits`.
   */
  agentConcurrency?: number;
  pollMs?: number;
  /**
   * How long a lease is good for. Short enough that a crashed worker's job is
   * picked up quickly, since it is renewed on a heartbeat rather than sized to
   * the longest possible job.
   */
  leaseMs?: number;
  /** Lease renewal interval. Must be comfortably under `leaseMs`. */
  heartbeatMs?: number;
  /** How long `stop()` waits for in-flight jobs before giving up on them. */
  drainMs?: number;
}

const DEFAULTS = {
  concurrency: 4,
  pollMs: 1_000,
  leaseMs: 60_000,
  heartbeatMs: 20_000,
  drainMs: 30_000,
} as const;

export function startWorkers(
  deps: WorkerPoolDeps,
  options: WorkerPoolOptions = {},
): WorkerPool {
  const concurrency = options.concurrency ?? DEFAULTS.concurrency;
  const limits = options.limits ?? {};
  const agentConcurrency = options.agentConcurrency;
  const pollMs = options.pollMs ?? DEFAULTS.pollMs;
  const leaseMs = options.leaseMs ?? DEFAULTS.leaseMs;
  const heartbeatMs = options.heartbeatMs ?? DEFAULTS.heartbeatMs;
  const drainMs = options.drainMs ?? DEFAULTS.drainMs;

  // Identifies this pool in `lease_owner`. A stuck job then names the process
  // that holds it instead of just being stuck.
  const owner = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;

  const inFlight = new Map<string, Promise<void>>();
  const perKind = new Map<string, number>();
  // Kinds already reported as unhandled. The check runs every poll; the warning
  // must not.
  const warnedUnhandled = new Set<string>();
  let stopping = false;

  /** Kinds this pool can run: registered tasks declared as job handlers. */
  const handlerKinds = (): string[] =>
    deps.taskRegistry
      .all()
      .filter((task) => task.kind === "job")
      .map((task) => task.id);

  const agentKinds = (): Set<string> =>
    new Set(
      deps.taskRegistry
        .all()
        .filter((task) => task.kind === "job" && task.agent)
        .map((task) => task.id),
    );

  /** Kinds already at their ceiling, excluded from the next lease query. */
  const saturated = (kinds: readonly string[]): string[] => {
    const agents = agentKinds();
    let agentsInFlight = 0;
    for (const kind of agents) agentsInFlight += perKind.get(kind) ?? 0;
    const agentsFull = agentConcurrency != null && agentsInFlight >= agentConcurrency;
    return kinds.filter((kind) => {
      if (agentsFull && agents.has(kind)) return true;
      const limit = limits[kind];
      return limit != null && (perKind.get(kind) ?? 0) >= limit;
    });
  };

  const runJob = async (job: Job): Promise<void> => {
    // `lease()` always supplies this. Treat an unexpectedly missing token as a
    // lost lease rather than falling back to an unfenced mutation.
    const leaseToken = job.leaseToken;
    if (!leaseToken) {
      deps.logger.error({ job: job.id, kind: job.kind }, `job ${job.id} has no lease token`);
      return;
    }
    const task = deps.taskRegistry.get(job.kind);
    if (!task) {
      // Leased a kind that vanished from the registry between the lease query
      // and now. Dead rather than requeued: nothing in this process will ever
      // handle it, and requeuing would spin.
      deps.queue.fail(job.id, leaseToken, `no registered task handles job kind '${job.kind}'`);
      return;
    }

    // The lease must outlive the job, and a job may run for twenty minutes. A
    // heartbeat is what lets the lease stay short — so a crash is noticed in a
    // minute — without expiring under a long but healthy job.
    const leaseAbort = new AbortController();
    const heartbeat = setInterval(() => {
      if (!deps.queue.renew(job.id, leaseToken, leaseMs)) {
        // Someone else owns this job now: stop this execution before it begins
        // another step or external operation. A request already accepted by a
        // provider is still at-least-once, but continuing locally makes that
        // window needlessly larger. The fencing token rejects every late local
        // finalization regardless.
        deps.logger.warn(
          { job: job.id, kind: job.kind },
          `lost the lease on job ${job.id}; cancelling its stale execution`,
        );
        leaseAbort.abort("job lease lost");
        clearInterval(heartbeat);
      }
    }, heartbeatMs);

    // A job whose actor no longer exists — the account was removed after the job
    // was queued — runs on the shared credentials rather than not at all. Said
    // out loud, because the comment it posts will be attributed to the bot and
    // somebody will wonder why.
    const actor = job.actorId ? deps.actorFor?.(job.actorId) : undefined;
    if (job.actorId && !actor) {
      deps.logger.warn(
        { job: job.id, kind: job.kind, actorId: job.actorId },
        `job ${job.id} names an actor that no longer exists; running with the shared credentials`,
      );
    }

    let executionId: string | undefined;
    try {
      const record = await deps.executor.run(task, {
        params: job.params,
        signal: leaseAbort.signal,
        ...(actor ? { actor } : {}),
        // Durable children discovered by a loop stay on the instance defaults
        // chosen for loops. Jobs queued directly by a developer use theirs.
        llmScope: job.parentExecutionId ? "instance" : "actor",
        // A job *is* one item. The cap that bounds a discoverer's blast radius
        // is meaningless here, and leaving it at the default 10 would let one
        // job quietly do ten things.
        maxItemsPerRun: 1,
        // A job exists because a discoverer decided this work is needed; the
        // handler must not then skip it as already-seen.
        force: true,
        onStarted: (info) => {
          executionId = info.executionId;
          // Onto the row immediately, not just into this closure. Everything that
          // watches a job in flight — the graph's node, the drawer's log, the
          // cancel button — finds the run through `jobs.execution_id`, so holding
          // it here until `complete` is what made a running job's activity appear
          // only once it had stopped being activity.
          if (!deps.queue.attachExecution(job.id, leaseToken, info.executionId)) {
            deps.logger.warn(
              { job: job.id, kind: job.kind },
              `lost the lease on job ${job.id} before its execution could be attached`,
            );
            // Cancellation can win between lease and run creation. Do not wait
            // for the next heartbeat to notice: abort before task code can
            // create a runtime or perform another external operation.
            leaseAbort.abort("job lease lost before execution attachment");
          }
        },
      });

      if (record.status === "cancelled") {
        // Shutdown, or an operator cancelling this run. Back to the queue
        // without blame, so a restart resumes it. The attempt counted at lease
        // time still stands, so a job that reliably dies here eventually goes
        // dead instead of cycling forever.
        if (deps.queue.release(job.id, leaseToken)) {
          deps.logger.info(
            { job: job.id, kind: job.kind },
            `job ${job.id} was cancelled and returned to the queue`,
          );
        } else {
          deps.logger.info(
            { job: job.id, kind: job.kind },
            `job ${job.id} was cancelled after its lease was lost`,
          );
        }
        return;
      }

      // Completion and advancing the subject fingerprint are one transaction in
      // the SQLite adapter. A stale worker cannot advance the replacement's
      // subject, and a crash cannot leave a done job that looks unhandled.
      const completed = deps.queue.complete(job.id, leaseToken, {
        executionId,
        ...(job.subjectKey && job.fingerprint
          ? {
              subject: {
                loopId: job.loopId,
                subjectKey: job.subjectKey,
                fingerprint: job.fingerprint,
              },
            }
          : {}),
      });
      if (!completed) {
        deps.logger.warn(
          { job: job.id, kind: job.kind },
          `lost the lease on job ${job.id} before completion; leaving its subject unchanged`,
        );
        return;
      }
      deps.notifications?.deleteByJob(job.id);
    } catch (err) {
      const error = describeError(err);
      const retryAt = new Date(Date.now() + retryDelayMs(job.attempts));
      // Only a failure that says a later attempt could succeed (a rate limit, a
      // provider outage, a branch that moved) earns one. A deterministic failure
      // repeats identically and, for an agent job, burns another run of tokens.
      // A crashed worker's job is still recovered by lease expiry, not here.
      const terminal = isTerminal(err) || !isRetryableCause(err);
      const failed = deps.queue.fail(job.id, leaseToken, error, { retryAt, executionId, terminal });
      if (!failed) {
        deps.logger.warn(
          { job: job.id, kind: job.kind },
          `lost the lease on job ${job.id} before its failure could be recorded`,
        );
        return;
      }
      // The executor already recorded and logged the failure against the run.
      // This line is about the *job*: whether it will be tried again, and when.
      const willRetry = !terminal && job.attempts < job.maxAttempts;
      // A retry means the job is still "in progress" from the operator's point
      // of view — only clear the notification once no attempt remains.
      if (!willRetry) deps.notifications?.deleteByJob(job.id);
      deps.logger.warn(
        {
          job: job.id,
          kind: job.kind,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          ...(willRetry ? { retryAt: retryAt.toISOString() } : {}),
          err: error,
        },
        willRetry
          ? `job ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}); retrying at ${retryAt.toISOString()}`
          : terminal
            ? `job ${job.id} failed with an error that is not retryable ` +
              `(attempt ${job.attempts}/${job.maxAttempts}); its remaining attempts were skipped`
            : `job ${job.id} failed on its last attempt and will not be retried`,
      );
    } finally {
      clearInterval(heartbeat);
    }
  };

  const start = (job: Job): void => {
    perKind.set(job.kind, (perKind.get(job.kind) ?? 0) + 1);
    const promise = runJob(job).finally(() => {
      inFlight.delete(job.id);
      perKind.set(job.kind, Math.max(0, (perKind.get(job.kind) ?? 1) - 1));
    });
    inFlight.set(job.id, promise);
  };

  const tick = (): void => {
    if (stopping) return;

    // Requeue anything whose holder stopped reporting. Cheap, indexed, and the
    // only thing that unsticks a job after an unclean shutdown — the same role
    // `closeOrphanedRuns` plays for run rows.
    const reclaimed = deps.queue.reclaimExpired();
    if (reclaimed > 0) {
      deps.logger.warn(
        { reclaimed },
        `reclaimed ${reclaimed} job(s) whose lease expired`,
      );
    }

    deps.refresh?.();
    const kinds = handlerKinds();

    // A job whose kind no registered task handles is never leased, so it waits
    // in the queue indefinitely — the failure mode of a typo in an enqueue call,
    // or of a handler removed while its jobs were still pending. Nothing else
    // would ever say so: the job is not failed, not dead, just permanently
    // ignored. Warned once per kind, and re-armed if the kind is registered
    // later, so a task appearing after boot does not stay flagged.
    for (const pending of deps.queue.pendingKinds()) {
      if (kinds.includes(pending)) {
        warnedUnhandled.delete(pending);
      } else if (!warnedUnhandled.has(pending)) {
        warnedUnhandled.add(pending);
        deps.logger.warn(
          { kind: pending },
          `queued job(s) of kind '${pending}' have no registered handler and will not run`,
        );
      }
    }

    if (kinds.length === 0) return;

    // Lease one at a time up to the ceiling rather than in a batch: leasing more
    // than we can start would hold work hostage under our lease while another
    // worker sits idle.
    while (inFlight.size < concurrency) {
      const job = deps.queue.lease({
        kinds,
        owner,
        leaseMs,
        excludeKinds: saturated(kinds),
      });
      if (!job) return;
      deps.logger.info(
        {
          job: job.id,
          kind: job.kind,
          loop: job.loopId,
          ...(job.subjectKey ? { subject: job.subjectKey } : {}),
          attempt: job.attempts,
          queueWaitMs: Math.max(0, Date.now() - job.enqueuedAt.getTime()),
        },
        `starting job ${job.id} (${job.kind})`,
      );
      start(job);
    }
  };

  tick();
  const poll = setInterval(tick, pollMs);

  return {
    active: () => inFlight.size,
    stop: async () => {
      stopping = true;
      clearInterval(poll);
      if (inFlight.size === 0) return;

      deps.logger.info(
        { active: inFlight.size },
        `waiting for ${inFlight.size} in-flight job(s)`,
      );

      const settled = Promise.allSettled([...inFlight.values()]);
      const timer = Bun.sleep(drainMs).then(() => "timeout" as const);
      const outcome = await Promise.race([settled.then(() => "done" as const), timer]);

      if (outcome === "timeout") {
        // Their leases will expire and another worker — or this one after a
        // restart — will pick them up. Releasing them here would be a lie: the
        // work may still be running in a container we no longer own.
        deps.logger.warn(
          { active: inFlight.size, drainMs },
          `${inFlight.size} job(s) did not finish within ${drainMs}ms; their leases will expire and be reclaimed`,
        );
      }
    },
  };
}
