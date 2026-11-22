import { Cron } from "croner";
import type { Actor } from "./actor.ts";
import { cronerJob } from "../config/croner-job.ts";
import type { ScheduledTask } from "../config/resolve-schedule.ts";
import type { Logger } from "../logging/logger.ts";
import { describeError } from "./errors.ts";
import type { TaskExecutor } from "./executor.ts";
import type { TaskRegistry } from "./registry.ts";
import type { TriggerQueue } from "./webhook.ts";

/**
 * Fires enabled cron-triggered loops on their own schedule. Nothing else in the
 * process does this: the rest of the app only ever computes "what would the
 * next run be" for display (see `nextRunOf` in `api/views.ts`). This is what
 * makes that display true.
 *
 * Each fire is a normal `executor.run()` — a loop is a task like any other, so
 * a scheduled run lands in `task_runs`/`task_steps` exactly like a manual or
 * API-triggered one, with its own executionId, steps, and error, and shows up
 * in `/api/activity` independently of every other run.
 */
export interface Scheduler {
  stop(): void;
}

interface Job {
  key: string;
  cron: SchedulerCron;
}

interface SchedulerCron {
  stop(): void;
}

type CronSpec = NonNullable<ReturnType<typeof cronerJob>>;

export type SchedulerCronFactory = (
  pattern: CronSpec["pattern"],
  options: CronSpec["options"],
  callback: () => void,
) => SchedulerCron;

export interface SchedulerDeps {
  logger: Logger;
  executor: TaskExecutor;
  taskRegistry: TaskRegistry;
  refresh(): void;
  scheduledTasks(): ScheduledTask[];
  scheduledTask(id: string): ScheduledTask | undefined;
  /**
   * The developer a scheduled tick of this loop acts as: the owner of the
   * instance, when it has one. This is what makes "my nightly loop, my token"
   * true without anyone being present to click Run — and it is per loop rather
   * than per process, so fifteen people's loops tick under fifteen identities.
   */
  actorForTask?(taskId: string): Actor | undefined;
  /**
   * Webhook deliveries waiting to become runs. Absent in a process that only
   * runs cron (or in a test), in which case loops behave exactly as before.
   */
  triggers?: TriggerQueue;
}

/** One job's identity: rebuilt only when the trigger, timezone, or enabled state actually changes. */
function jobKey(task: ScheduledTask): string {
  const trigger = task.trigger.value;
  if (trigger.type === "cron") {
    return `${task.id}:${task.enabled.value}:${trigger.expression}:${trigger.timezone ?? ""}:${trigger.startAt ?? ""}`;
  }
  if (trigger.type === "once") {
    return `${task.id}:${task.enabled.value}:once:${trigger.at}:${trigger.timezone ?? ""}`;
  }
  return `${task.id}:${task.enabled.value}:manual`;
}

/**
 * Starts the scheduler and returns a handle to stop it. Re-reads
 * `app.scheduledTasks()` on a poll rather than reacting to individual writes,
 * so a schedule edited through the API takes effect without restarting.
 */
export function startScheduler(
  app: SchedulerDeps,
  pollMs = 15_000,
  createCron: SchedulerCronFactory = (pattern, options, callback) =>
    new Cron(pattern, options, callback),
  triggerPollMs = 3_000,
): Scheduler {
  const jobs = new Map<string, Job>();
  const running = new Set<string>();

  const fire = async (taskId: string) => {
    // A loop still mid-run when its next tick lands is skipped rather than
    // queued — overlapping runs of the same loop would race on the same
    // watermark/state, and a slow run is a signal to look at duration, not to
    // pile more runs behind it.
    if (running.has(taskId)) {
      app.logger.warn({ task: taskId }, `loop ${taskId} skipped: previous run still in progress`);
      return;
    }

    const task = app.taskRegistry.get(taskId);
    const scheduled = app.scheduledTask(taskId);
    if (!task || !scheduled) return; // dropped from the registry/config since the job was built

    running.add(taskId);
    try {
      const actor = app.actorForTask?.(taskId);
      await app.executor.run(task, {
        params: scheduled.params,
        maxItemsPerRun: scheduled.maxItemsPerRun,
        llmScope: "instance",
        ...(actor ? { actor } : {}),
      });
    } catch (err) {
      // The executor already recorded and logged the failure; a scheduler tick
      // must never throw, or one broken loop would take down every other job.
      app.logger.error(
        { task: taskId, err: describeError(err) },
        `scheduled run of ${taskId} failed`,
      );
    } finally {
      running.delete(taskId);
    }
  };

  /**
   * Turns webhook deliveries into runs.
   *
   * Polls a table rather than being called by the ingress directly, and that is
   * what makes it robust: the request survives a delivery arriving mid-run, a
   * request made by another process, and a restart between the delivery and the
   * run. The one gap is a crash between the claim and the fire, where the request
   * is lost and the slow sweep is what catches the work — which is the whole
   * reason the sweeps stay on.
   */
  const drainTriggers = () => {
    if (!app.triggers) return;
    for (const pending of app.triggers.pending()) {
      // Left on the queue, not claimed: the loop is mid-run, and it will be
      // picked up on the next tick after that run ends. Claiming here would
      // either drop the news or overlap two runs on the same watermark.
      if (running.has(pending.taskId)) continue;

      const claimed = app.triggers.claim(pending.taskId);
      if (!claimed) continue; // another poll got it

      const scheduled = app.scheduledTask(claimed.taskId);
      if (!scheduled || !scheduled.enabled.value) {
        app.logger.warn(
          { task: claimed.taskId, source: claimed.source },
          `dropped a webhook trigger for ${claimed.taskId}: the loop is disabled or gone`,
        );
        continue;
      }

      app.logger.info(
        {
          task: claimed.taskId,
          source: claimed.source,
          events: claimed.events,
          waitedMs: Date.now() - claimed.requestedAt.getTime(),
        },
        `running ${claimed.taskId} for ${claimed.events} webhook event(s) from ${claimed.source}`,
      );
      void fire(claimed.taskId);
    }
  };

  const reconcile = () => {
    app.refresh();
    const desired = new Map(
      app
        .scheduledTasks()
        .filter((t) => t.enabled.value && cronerJob(t.trigger.value) != null)
        .map((t) => [t.id, t] as const),
    );

    for (const [taskId, job] of jobs) {
      const stillDesired = desired.get(taskId);
      if (!stillDesired || jobKey(stillDesired) !== job.key) {
        job.cron.stop();
        jobs.delete(taskId);
      }
    }

    for (const scheduled of desired.values()) {
      if (jobs.has(scheduled.id)) continue;
      const trigger = scheduled.trigger.value;
      const job = cronerJob(trigger);
      if (!job) continue;
      try {
        const cron = createCron(job.pattern, job.options, () => void fire(scheduled.id));
        jobs.set(scheduled.id, { key: jobKey(scheduled), cron });
      } catch (err) {
        // An invalid expression is already surfaced in the UI via
        // `scheduleError` (api/views.ts); the scheduler just declines to run it.
        app.logger.error(
          { task: scheduled.id, trigger, err: describeError(err) },
          `loop ${scheduled.id} has an invalid schedule, not scheduled`,
        );
      }
    }
  };

  reconcile();
  // Immediately, not on the first tick: anything that arrived while the process
  // was down is news that has already waited long enough.
  drainTriggers();
  const poll = setInterval(reconcile, pollMs);
  // Faster than the reconcile poll, because this one is answering a person. It
  // reads one small table, and only has work to do when something happened. The
  // interval is also the collapse window: deliveries from one push land inside it
  // and become a single run.
  const triggerPoll = setInterval(drainTriggers, triggerPollMs);

  return {
    stop: () => {
      clearInterval(poll);
      clearInterval(triggerPoll);
      for (const job of jobs.values()) job.cron.stop();
      jobs.clear();
    },
  };
}
