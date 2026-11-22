import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  defaultDedupeKey,
  type EnqueueJob,
  type EnqueueResult,
  type Job,
  type JobStatus,
  type LeaseOptions,
} from "../core/job.ts";
import type { JobCounts, JobRepository } from "../application/ports.ts";
import type { JobControlState } from "../core/orchestration.ts";
import { fromIso, fromJson, toIso, toJson } from "./database.ts";
import { newId } from "./id.ts";

/**
 * The job queue, on SQLite.
 *
 * Two properties carry the whole design, and both live in the schema rather than
 * in this file:
 *
 * Enqueue is idempotent, via a unique index on `dedupe_key` restricted to
 * in-flight rows. A webhook and the reconciliation poll can both report the same
 * merge request in the same second; only one job exists. Once that job finishes
 * the key is free again, so the *next* comment on the same MR is new work.
 *
 * Leasing is atomic, via a single UPDATE whose target is chosen by a subquery.
 * SQLite serialises writers, so two workers racing on the same row cannot both
 * win — one of them updates zero rows and gets null. This is the same reasoning
 * `SqliteStateStore.claimEvent` uses: do not check then act, act and see what
 * happened.
 */
export class SqliteJobQueue implements JobRepository {
  constructor(private readonly db: Database) {}

  enqueue(input: EnqueueJob): EnqueueResult {
    const now = new Date();
    const id = newId();
    const dedupeKey = input.dedupeKey ?? defaultDedupeKey(input);

    const result = this.db.run(
      `INSERT INTO jobs
         (id, kind, loop_id, subject_key, fingerprint, actor_id, parent_execution_id, dedupe_key,
          params, priority, status, attempts, max_attempts, available_at, enqueued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
       ON CONFLICT (dedupe_key) WHERE status IN ('queued', 'leased')
         DO NOTHING`,
      [
        id,
        input.kind,
        input.loopId,
        input.subjectKey ?? null,
        input.fingerprint ?? null,
        input.actorId ?? null,
        input.parentExecutionId ?? null,
        dedupeKey,
        toJson(input.params),
        input.priority ?? 0,
        input.maxAttempts ?? 3,
        toIso(input.availableAt ?? now),
        toIso(now),
      ],
    );

    // Zero changes means an identical job is already queued or leased. Not an
    // error to raise: "this work is already pending" is the answer the caller
    // wanted, and a discoverer that re-reports unchanged work every poll is the
    // normal case, not a fault.
    if (result.changes === 0) return { job: null, enqueued: false };
    return { job: this.get(id), enqueued: true };
  }

  /**
   * Takes the best eligible job for one of `kinds`, atomically.
   *
   * The ordering is priority, then how long the job has been eligible, then
   * enqueue time — so a retry that just came off backoff does not jump ahead of
   * work that has been waiting, and equal-priority work is FIFO.
   *
   * Within the top ready priority, the actor with the fewest leased jobs goes
   * first, so one developer's batch cannot hold every worker while a teammate's
   * single click waits behind it. Each fairness tier is the same indexed lease
   * query with busier actors filtered out; the tiers are bounded by the number
   * of distinct leased-job counts, which the worker concurrency bounds.
   */
  lease(options: LeaseOptions): Job | null {
    const kinds = options.kinds.filter(
      (kind) => !options.excludeKinds?.includes(kind),
    );
    if (kinds.length === 0) return null;

    const leased = this.leasedByActor();
    if (leased.size === 0) return this.leaseNext(kinds, options);

    const top = this.db
      .query<{ priority: number }, string[]>(
        `SELECT priority FROM jobs
          WHERE status = 'queued'
            AND held_at IS NULL
            AND available_at <= ?
            AND kind IN (${kinds.map(() => "?").join(", ")})
            AND NOT EXISTS (
              SELECT 1 FROM agent_execution_attempts AS attempt
               WHERE attempt.job_id = jobs.id
                 AND attempt.state IN ('starting', 'running', 'stopping', 'uncertain')
            )
          ORDER BY priority DESC, available_at ASC, enqueued_at ASC
          LIMIT 1`,
      )
      .get(toIso(new Date()), ...kinds);
    if (!top) return null;

    const ceilings = [0, ...new Set([...leased.values()].sort((a, b) => a - b))];
    for (const ceiling of ceilings) {
      const busier = [...leased].filter(([, count]) => count > ceiling).map(([actor]) => actor);
      const job = this.leaseNext(kinds, options, { priority: top.priority, excludeActors: busier });
      if (job) return job;
    }
    return null;
  }

  /** Leased job counts by actor; "" stands for jobs with no actor. */
  private leasedByActor(): Map<string, number> {
    const rows = this.db
      .query<{ actor: string; n: number }, []>(
        `SELECT COALESCE(actor_id, '') AS actor, COUNT(*) AS n
           FROM jobs WHERE status = 'leased' GROUP BY 1`,
      )
      .all();
    return new Map(rows.map((row) => [row.actor, row.n]));
  }

  private leaseNext(
    kinds: readonly string[],
    options: LeaseOptions,
    filter: { priority?: number; excludeActors?: readonly string[] } = {},
  ): Job | null {
    const now = new Date();
    const leaseToken = randomUUID();
    const placeholders = kinds.map(() => "?").join(", ");
    const excluded = filter.excludeActors ?? [];
    const priorityClause = filter.priority == null ? "" : "AND priority = ?";
    const actorClause = excluded.length === 0
      ? ""
      : `AND COALESCE(actor_id, '') NOT IN (${excluded.map(() => "?").join(", ")})`;

    const row = this.db
      .query<Row, (string | number)[]>(
        `UPDATE jobs
            SET status       = 'leased',
                lease_until  = ?,
                lease_owner  = ?,
                lease_token  = ?,
                attempts     = attempts + 1,
                started_at   = COALESCE(started_at, ?)
          WHERE id = (
                  SELECT id FROM jobs
                   WHERE status = 'queued'
                     AND held_at IS NULL
                     AND available_at <= ?
                     AND kind IN (${placeholders})
                     AND NOT EXISTS (
                       SELECT 1 FROM agent_execution_attempts AS attempt
                        WHERE attempt.job_id = jobs.id
                          AND attempt.state IN ('starting', 'running', 'stopping', 'uncertain')
                     )
                     ${priorityClause}
                     ${actorClause}
                   ORDER BY priority DESC, available_at ASC, enqueued_at ASC
                   LIMIT 1
                )
          RETURNING *`,
      )
      .get(
        toIso(new Date(now.getTime() + options.leaseMs)),
        options.owner,
        leaseToken,
        toIso(now),
        toIso(now),
        ...kinds,
        ...(filter.priority == null ? [] : [filter.priority]),
        ...excluded,
      );

    return row ? toJob(row) : null;
  }

  renew(id: string, leaseToken: string, leaseMs: number): boolean {
    const result = this.db.run(
      `UPDATE jobs SET lease_until = ?
        WHERE id = ? AND status = 'leased' AND lease_token = ?`,
      [toIso(new Date(Date.now() + leaseMs)), id, leaseToken],
    );
    return result.changes > 0;
  }

  /**
   * Records which run a leased job started, at the moment it starts it.
   *
   * `complete` and `fail` also write this column, but only once the work is over,
   * and by then it is history. The graph builds a job's node from this row, and a
   * node with no `executionId` has no log to open — so a job whose run was only
   * named at the end showed a spinner for twenty minutes and its activity feed
   * only after there was nothing left to watch. `cancelJob` reads the same field
   * to abort the run behind the job, which for a leased job it could never find.
   *
   * Guarded on `leased` so a reclaimed job cannot rewrite the column out from
   * under the worker that now owns it.
   */
  attachExecution(id: string, leaseToken: string, executionId: string): boolean {
    return this.db.run(
      `UPDATE jobs SET execution_id = ?
        WHERE id = ? AND status = 'leased' AND lease_token = ?`,
      [executionId, id, leaseToken],
    ).changes > 0;
  }

  complete(
    id: string,
    leaseToken: string,
    args: {
      executionId?: string;
      subject?: { loopId: string; subjectKey: string; fingerprint: string };
    } = {},
  ): boolean {
    const now = toIso(new Date());
    return this.db.transaction(() => {
      const completed = this.db.run(
        `UPDATE jobs
              SET status = 'done', finished_at = ?, lease_until = NULL,
              lease_owner = NULL, lease_token = NULL, error = NULL,
              terminal_outcome = NULL,
              execution_id = COALESCE(?, execution_id)
        WHERE id = ? AND status = 'leased' AND lease_token = ?`,
        [now, args.executionId ?? null, id, leaseToken],
      ).changes > 0;
      if (!completed || !args.subject) return completed;

      // A completed job whose subject remains unchanged is indistinguishable to
      // its discoverer from work that was never handled. Keep both transitions in
      // this ownership-checked transaction so neither a stale worker nor a crash
      // between two independent writes can create that false retry signal.
      this.db.run(
        `UPDATE work_subjects
            SET fingerprint = ?, updated_at = ?
          WHERE loop_id = ? AND subject_key = ? AND state = 'open'`,
        [
          args.subject.fingerprint,
          now,
          args.subject.loopId,
          args.subject.subjectKey,
        ],
      );
      return true;
    })();
  }

  fail(
    id: string,
    leaseToken: string,
    error: string,
    args: { retryAt?: Date; executionId?: string; terminal?: boolean } = {},
  ): boolean {
    const now = toIso(new Date());
    // A terminal failure is dead on arrival however many attempts the row has
    // left; bound into the same three `CASE`s rather than branching in JS so the
    // decision stays in one place. Repeated in the parameter list because these
    // are positional binds.
    const done = args.terminal ? 1 : 0;
    // Whether this was the last attempt is decided in SQL against the row's own
    // counters, not from a value read a moment ago — the attempt count was
    // incremented by `lease`, and re-reading it here would be a race.
    return this.db.run(
      `UPDATE jobs
          SET status       = CASE WHEN ? = 1 OR attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
              available_at = CASE WHEN ? = 1 OR attempts >= max_attempts THEN available_at ELSE ? END,
              finished_at  = CASE WHEN ? = 1 OR attempts >= max_attempts THEN ? ELSE NULL END,
              terminal_outcome = CASE WHEN ? = 1 OR attempts >= max_attempts THEN 'failed' ELSE NULL END,
              lease_until  = NULL,
              lease_owner  = NULL,
              lease_token  = NULL,
              error        = ?,
              execution_id = COALESCE(?, execution_id)
        WHERE id = ? AND status = 'leased' AND lease_token = ?`,
      [
        done,
        done,
        toIso(args.retryAt ?? new Date()),
        done,
        now,
        done,
        error,
        args.executionId ?? null,
        id,
        leaseToken,
      ],
    ).changes > 0;
  }

  release(id: string, leaseToken: string, args: { retryAt?: Date } = {}): boolean {
    // Same dead-vs-queued decision as `fail`: a job whose worker keeps dying
    // must still exhaust its attempts, or a shutdown loop would requeue it
    // forever.
    return this.db.run(
      `UPDATE jobs
          SET status       = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
              available_at = CASE WHEN attempts >= max_attempts THEN available_at ELSE ? END,
              terminal_outcome = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE NULL END,
              lease_until  = NULL,
              lease_owner  = NULL,
              lease_token  = NULL
        WHERE id = ? AND status = 'leased' AND lease_token = ?`,
      [toIso(args.retryAt ?? new Date()), id, leaseToken],
    ).changes > 0;
  }

  reclaimExpired(now: Date = new Date()): number {
    const result = this.db.run(
      `UPDATE jobs
          SET status       = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
              available_at = ?,
              terminal_outcome = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE NULL END,
              lease_until  = NULL,
              lease_owner  = NULL,
              lease_token  = NULL,
              error        = COALESCE(error, 'lease expired: the worker holding this job stopped reporting')
        WHERE status = 'leased' AND lease_until IS NOT NULL AND lease_until < ?`,
      [toIso(now), toIso(now)],
    );
    return result.changes;
  }

  get(id: string): Job | null {
    const row = this.db
      .query<Row, [string]>("SELECT * FROM jobs WHERE id = ?")
      .get(id);
    return row ? toJob(row) : null;
  }

  /** Jobs for a loop, newest first — backs a loop's "what did this discover" pane. */
  byLoop(loopId: string, limit = 50): Job[] {
    return this.db
      .query<Row, [string, number]>(
        `SELECT * FROM jobs WHERE loop_id = ?
          ORDER BY enqueued_at DESC LIMIT ?`,
      )
      .all(loopId, limit)
      .map(toJob);
  }

  bySubject(loopId: string, subjectKey: string, limit = 20): Job[] {
    return this.db
      .query<Row, [string, string, number]>(
        `SELECT * FROM jobs WHERE loop_id = ? AND subject_key = ?
          ORDER BY enqueued_at DESC LIMIT ?`,
      )
      .all(loopId, subjectKey, limit)
      .map(toJob);
  }

  bySubjectsForLoops(loopIds: readonly string[], limitPerSubject = 20): Map<string, Job[]> {
    const result = new Map<string, Job[]>();
    if (loopIds.length === 0) return result;
    const placeholders = loopIds.map(() => "?").join(", ");
    const rows = this.db.query<Row, (string | number)[]>(
      `SELECT * FROM (
         SELECT jobs.*, ROW_NUMBER() OVER (
           PARTITION BY loop_id, subject_key ORDER BY enqueued_at DESC
         ) AS position
           FROM jobs
          WHERE subject_key IS NOT NULL AND loop_id IN (${placeholders})
       ) WHERE position <= ? ORDER BY loop_id, subject_key, position`,
    ).all(...loopIds, limitPerSubject);
    for (const row of rows) {
      const key = `${row.loop_id}\0${row.subject_key ?? ""}`;
      const bucket = result.get(key) ?? [];
      bucket.push(toJob(row));
      result.set(key, bucket);
    }
    return result;
  }

  byParent(parentExecutionId: string): Job[] {
    return this.db.query<Row, [string]>(
      `SELECT * FROM jobs WHERE parent_execution_id = ? ORDER BY enqueued_at`,
    ).all(parentExecutionId).map(toJob);
  }

  byParents(parentExecutionIds: readonly string[]): Map<string, Job[]> {
    const result = new Map<string, Job[]>();
    if (parentExecutionIds.length === 0) return result;
    const placeholders = parentExecutionIds.map(() => "?").join(", ");
    const rows = this.db.query<Row, string[]>(
      `SELECT * FROM jobs WHERE parent_execution_id IN (${placeholders})
        ORDER BY parent_execution_id, enqueued_at`,
    ).all(...parentExecutionIds);
    for (const row of rows) {
      const parent = row.parent_execution_id!;
      const bucket = result.get(parent) ?? [];
      bucket.push(toJob(row));
      result.set(parent, bucket);
    }
    return result;
  }

  hasActiveChildren(loopId: string, kind: string): boolean {
    return this.db.query<{ present: number }, [string, string]>(
      `SELECT 1 AS present FROM jobs
        WHERE loop_id = ? AND kind = ? AND status IN ('queued', 'leased') LIMIT 1`,
    ).get(loopId, kind) != null;
  }

  byDedupeKey(dedupeKey: string, limit = 5): Job[] {
    return this.db
      .query<Row, [string, number]>(
        `SELECT * FROM jobs WHERE dedupe_key = ?
          ORDER BY enqueued_at DESC LIMIT ?`,
      )
      .all(dedupeKey, limit)
      .map(toJob);
  }

  /**
   * Every job currently queued or leased for a manual pull request action
   * (`manual:<action>:gitlab:<project>!<iid>`), across every merge request at
   * once. The ticket graph reads this to light up a merge request node for an
   * action that has no subject behind it — the pull request page's own clicks
   * enqueue under a synthetic loop with no subject at all, so `bySubject` alone
   * can never find them. Cheap by construction: `idx_jobs_dedupe_history`
   * covers `dedupe_key`, and only queued/leased rows ever match `LIKE`.
   */
  activeManualActions(): Job[] {
    return this.db
      .query<Row, []>(
        `SELECT * FROM jobs WHERE status IN ('queued', 'leased') AND dedupe_key LIKE 'manual:%'`,
      )
      .all()
      .map(toJob);
  }

  /**
   * Every job of one handler kind that is queued or leased right now, across
   * every dedupe key and every loop that might have raised it.
   *
   * Exists because the automatic loop and a manual click enqueue the *same*
   * handler under two different dedupe keys (the loop's own
   * `loopId:kind:subjectKey:fingerprint` vs. the button's `manual:<action>:…`),
   * so neither can see the other is already running one. `idx_jobs_kind`
   * covers `(kind, status)`, so this is as cheap as `activeManualActions`.
   */
  activeForKind(kind: string): Job[] {
    return this.db
      .query<Row, [string]>(
        `SELECT * FROM jobs WHERE kind = ? AND status IN ('queued', 'leased')`,
      )
      .all(kind)
      .map(toJob);
  }

  /**
   * Every job ever queued for any manual action on one merge request, newest
   * first — the Activity tab's job history. `%`/`_` in the project id are
   * escaped so a path segment containing either can't widen the match beyond
   * this one merge request.
   */
  manualActionHistory(projectId: string, mrIid: number, limit = 50): Job[] {
    const escapedProjectId = projectId.replace(/[%_\\]/g, (char) => `\\${char}`);
    const pattern = `manual:%:gitlab:${escapedProjectId}!${mrIid}`;
    return this.db
      .query<Row, [string, number]>(
        `SELECT * FROM jobs WHERE dedupe_key LIKE ? ESCAPE '\\'
          ORDER BY enqueued_at DESC LIMIT ?`,
      )
      .all(pattern, limit)
      .map(toJob);
  }

  /**
   * Every job ever queued for any manual *ticket* action, newest first, across
   * every ticket at once — the ticket graph's per-ticket action history.
   *
   * One query rather than one per ticket on purpose: the graph endpoint is polled
   * every few seconds and a `LIKE` per cluster would be sixty of these a poll. The
   * caller buckets by issue key and caps per ticket, so this limit only has to sit
   * comfortably above `clusters × cap` — beyond that the tail is history nothing
   * on the canvas would draw anyway.
   */
  manualTicketActionHistory(limit = 500): Job[] {
    return this.db
      .query<Row, [number]>(
        `SELECT * FROM jobs WHERE dedupe_key LIKE 'manual:%:jira:%'
          ORDER BY enqueued_at DESC LIMIT ?`,
      )
      .all(limit)
      .map(toJob);
  }

  recent(limit = 50): Job[] {
    return this.db
      .query<Row, [number]>(
        "SELECT * FROM jobs ORDER BY enqueued_at DESC LIMIT ?",
      )
      .all(limit)
      .map(toJob);
  }

  /** Counts by status, for one loop or the whole queue. */
  counts(loopId?: string): JobCounts {
    const rows = loopId
      ? this.db
          .query<{ status: JobStatus; n: number }, [string]>(
            "SELECT status, COUNT(*) AS n FROM jobs WHERE loop_id = ? GROUP BY status",
          )
          .all(loopId)
      : this.db
          .query<{ status: JobStatus; n: number }, []>(
            "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status",
          )
          .all();

    const counts: JobCounts = { queued: 0, leased: 0, done: 0, dead: 0 };
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  countsByActor(actorId: string): JobCounts {
    const rows = this.db
      .query<{ status: JobStatus; n: number }, [string]>(
        "SELECT status, COUNT(*) AS n FROM jobs WHERE actor_id = ? GROUP BY status",
      )
      .all(actorId);
    const counts: JobCounts = { queued: 0, leased: 0, done: 0, dead: 0 };
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  /** Active work by loop, without grouping completed/dead history. */
  activeCounts(loopIds: readonly string[]): Map<string, number> {
    if (loopIds.length === 0) return new Map();
    const placeholders = loopIds.map(() => "?").join(", ");
    const rows = this.db
      .query<{ loop_id: string; n: number }, string[]>(
        `SELECT loop_id, COUNT(*) AS n FROM jobs
          WHERE status IN ('queued', 'leased') AND loop_id IN (${placeholders})
          GROUP BY loop_id`,
      )
      .all(...loopIds);
    return new Map(rows.map((row) => [row.loop_id, row.n]));
  }

  activeTotal(): number {
    return this.db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued', 'leased')",
    ).get()?.count ?? 0;
  }

  queuePressure(now: Date = new Date()): { ready: number; oldestReadyAgeMs: number } {
    const row = this.db.query<{ ready: number; oldest: string | null }, [string]>(
      `SELECT COUNT(*) AS ready, MIN(available_at) AS oldest
         FROM jobs
        WHERE status = 'queued' AND held_at IS NULL AND available_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM agent_execution_attempts AS attempt
             WHERE attempt.job_id = jobs.id
               AND attempt.state IN ('starting', 'running', 'stopping', 'uncertain')
          )`,
    ).get(toIso(now));
    return {
      ready: row?.ready ?? 0,
      oldestReadyAgeMs: row?.oldest
        ? Math.max(0, now.getTime() - fromIso(row.oldest).getTime())
        : 0,
    };
  }

  /** Kinds with work waiting, so the pool can skip a lease query that would find nothing. */
  pendingKinds(now: Date = new Date()): string[] {
    return this.db
      .query<{ kind: string }, [string]>(
        `SELECT DISTINCT kind FROM jobs
          WHERE status = 'queued' AND held_at IS NULL AND available_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM agent_execution_attempts AS attempt
               WHERE attempt.job_id = jobs.id
                 AND attempt.state IN ('starting', 'running', 'stopping', 'uncertain')
            )`,
      )
      .all(toIso(now))
      .map((row) => row.kind);
  }

  /**
   * The newest job that died on this dedupe key. A discoverer's brake against
   * re-enqueueing work that has already exhausted its attempts — see
   * `JobRepository.deadFor`.
   */
  deadFor(dedupeKey: string): Job | null {
    const row = this.db
      .query<Row, [string]>(
        `SELECT * FROM jobs WHERE dedupe_key = ? AND status = 'dead'
          ORDER BY finished_at DESC, enqueued_at DESC LIMIT 1`,
      )
      .get(dedupeKey);
    return row ? toJob(row) : null;
  }

  /**
   * Retries a dead job by hand — the UI's "run it again" on a job that gave up.
   * Resets the attempt count, because an operator retrying deliberately is not
   * the same as the automatic retry that already ran out.
   */
  revive(id: string): boolean {
    const result = this.db.run(
      `UPDATE jobs
          SET status = 'queued', attempts = 0, available_at = ?,
              finished_at = NULL, error = NULL, terminal_outcome = NULL,
              held_at = NULL, hold_reason = NULL, superseded_by_job_id = NULL
        WHERE id = ? AND status = 'dead'`,
      [toIso(new Date()), id],
    );
    return result.changes > 0;
  }

  hold(id: string, reason = "held by operator"): boolean {
    return this.db.run(
      `UPDATE jobs SET held_at = ?, hold_reason = ?
        WHERE id = ? AND status = 'queued' AND held_at IS NULL`,
      [toIso(new Date()), reason, id],
    ).changes > 0;
  }

  resume(id: string): boolean {
    return this.db.run(
      `UPDATE jobs SET held_at = NULL, hold_reason = NULL,
          available_at = CASE WHEN available_at > ? THEN available_at ELSE ? END
        WHERE id = ? AND status = 'queued' AND held_at IS NOT NULL`,
      [toIso(new Date()), toIso(new Date()), id],
    ).changes > 0;
  }

  setPriority(id: string, priority: number): boolean {
    if (!Number.isSafeInteger(priority)) return false;
    return this.db.run(
      "UPDATE jobs SET priority = ? WHERE id = ? AND status = 'queued'",
      [priority, id],
    ).changes > 0;
  }

  supersede(
    id: string,
    replacementJobId: string,
    reason: string,
    includeRunning = false,
  ): boolean {
    return this.db.run(
      `UPDATE jobs
          SET status = 'dead', finished_at = ?, lease_until = NULL,
              lease_owner = NULL, lease_token = NULL, error = ?,
              terminal_outcome = 'superseded', superseded_by_job_id = ?
        WHERE id = ? AND (
          status = 'queued' OR (? = 1 AND status = 'leased')
        )`,
      [toIso(new Date()), reason, replacementJobId, id, includeRunning ? 1 : 0],
    ).changes > 0;
  }

  controlState(id: string): JobControlState | null {
    const row = this.db.query<{
      id: string;
      held_at: string | null;
      hold_reason: string | null;
      terminal_outcome: JobControlState["terminalOutcome"] | null;
      superseded_by_job_id: string | null;
    }, [string]>(
      `SELECT id, held_at, hold_reason, terminal_outcome, superseded_by_job_id
         FROM jobs WHERE id = ?`,
    ).get(id);
    return row ? {
      jobId: row.id,
      held: row.held_at != null,
      heldAt: fromIso(row.held_at),
      holdReason: row.hold_reason ?? undefined,
      terminalOutcome: row.terminal_outcome ?? undefined,
      supersededByJobId: row.superseded_by_job_id ?? undefined,
    } : null;
  }

  /**
   * Drops finished history older than `before`.
   *
   * The newest dead row for a dedupe key remains: `deadFor()` is the durable
   * brake that prevents a discoverer from burning a fresh agent attempt on the
   * exact fingerprint that already exhausted its retries. Retention may discard
   * older dead attempts once a later attempt exists, but deleting that last row
   * would turn routine cleanup into an automatic retry storm.
   */
  purgeFinished(before: Date, limit = 250): number {
    const result = this.db.run(
      `DELETE FROM jobs WHERE id IN (
        SELECT id FROM jobs
        WHERE finished_at IS NOT NULL AND finished_at < ?
          AND (
            status = 'done'
            OR (
              status = 'dead'
              AND EXISTS (
                SELECT 1 FROM jobs AS newer
                 WHERE newer.dedupe_key = jobs.dedupe_key
                   AND newer.id <> jobs.id
                   AND newer.enqueued_at > jobs.enqueued_at
              )
            )
          )
        ORDER BY finished_at
        LIMIT ?
      )`,
      [toIso(before), limit],
    );
    return result.changes;
  }

  retentionCounts(before: Date): { done: number; deadProtected: number; deadRemovable: number } {
    const cutoff = toIso(before);
    const row = this.db.query<{ done: number; dead_protected: number; dead_removable: number }, [string]>(
      `SELECT
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status = 'dead' AND NOT EXISTS (
           SELECT 1 FROM jobs AS newer
            WHERE newer.dedupe_key = jobs.dedupe_key
              AND newer.id <> jobs.id AND newer.enqueued_at > jobs.enqueued_at
         ) THEN 1 ELSE 0 END) AS dead_protected,
         SUM(CASE WHEN status = 'dead' AND EXISTS (
           SELECT 1 FROM jobs AS newer
            WHERE newer.dedupe_key = jobs.dedupe_key
              AND newer.id <> jobs.id AND newer.enqueued_at > jobs.enqueued_at
         ) THEN 1 ELSE 0 END) AS dead_removable
       FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ?`,
    ).get(cutoff);
    return {
      done: row?.done ?? 0,
      deadProtected: row?.dead_protected ?? 0,
      deadRemovable: row?.dead_removable ?? 0,
    };
  }

  /**
   * Marks one in-flight job dead at an operator's request.
   *
   * Dead rather than `done`, and deliberately the *first* half of cancelling: a
   * leased job's run is aborted after this, and the pool's cancelled branch
   * answers by calling `release`, which requeues the job. `release` only touches
   * a row that is still `leased`, so killing the row first is what stops the
   * cancel from handing the work straight back to the next worker.
   *
   * Returns false for an unknown id or a job that already finished, so the
   * caller can say "already done" rather than reporting a cancel that cancelled
   * nothing.
   */
  cancelJob(id: string, reason: string): boolean {
    const result = this.db.run(
      `UPDATE jobs
          SET status = 'dead', finished_at = ?, lease_until = NULL,
              lease_owner = NULL, lease_token = NULL, error = ?,
              terminal_outcome = 'cancelled'
        WHERE id = ? AND status IN ('queued', 'leased')`,
      [toIso(new Date()), reason, id],
    );
    return result.changes > 0;
  }

  /** Marks every in-flight job of a loop dead — used when its config is deleted. */
  cancelLoop(loopId: string, reason: string): number {
    const result = this.db.run(
      `UPDATE jobs
          SET status = 'dead', finished_at = ?, lease_until = NULL,
              lease_owner = NULL, lease_token = NULL, error = ?,
              terminal_outcome = 'cancelled'
        WHERE loop_id = ? AND status IN ('queued', 'leased')`,
      [toIso(new Date()), reason, loopId],
    );
    return result.changes;
  }
}

interface Row {
  id: string;
  kind: string;
  loop_id: string;
  subject_key: string | null;
  fingerprint: string | null;
  actor_id: string | null;
  parent_execution_id: string | null;
  dedupe_key: string;
  params: string | null;
  priority: number;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  available_at: string;
  lease_until: string | null;
  lease_owner: string | null;
  lease_token: string | null;
  execution_id: string | null;
  error: string | null;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function toJob(row: Row): Job {
  return {
    id: row.id,
    kind: row.kind,
    loopId: row.loop_id,
    subjectKey: row.subject_key ?? undefined,
    fingerprint: row.fingerprint ?? undefined,
    actorId: row.actor_id ?? undefined,
    parentExecutionId: row.parent_execution_id ?? undefined,
    dedupeKey: row.dedupe_key,
    params: fromJson<unknown>(row.params),
    priority: row.priority,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: fromIso(row.available_at),
    leaseUntil: fromIso(row.lease_until),
    leaseOwner: row.lease_owner ?? undefined,
    leaseToken: row.lease_token ?? undefined,
    executionId: row.execution_id ?? undefined,
    error: row.error ?? undefined,
    enqueuedAt: fromIso(row.enqueued_at),
    startedAt: fromIso(row.started_at),
    finishedAt: fromIso(row.finished_at),
  };
}
