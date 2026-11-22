import type { Database } from "bun:sqlite";
import type {
  NotificationRepository,
  RunRepository,
  TaskRunMetrics,
  TaskRunSummary,
} from "../application/ports.ts";
import type {
  TaskExecutionRecord,
} from "../core/executor.ts";
import type { RunStatus, StepRecord, StepStatus } from "../core/step.ts";
import type { ExecutionLogLine } from "../logging/capture.ts";
import { fromIso, fromJson, toIso, toJson } from "./database.ts";

interface TaskRunRow {
  execution_id: string;
  task_id: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  status: "running" | RunStatus;
  dry_run: number;
  params: string | null;
  items_seen: number | null;
  items_processed: number | null;
  items_skipped: number | null;
  error: string | null;
  details: string | null;
  project_id: string | null;
  mr_iid: number | null;
}

interface StepRow {
  step_id: string;
  started_at: string;
  duration_ms: number;
  status: StepStatus;
  attempts: number;
  error: string | null;
}

interface LogRow {
  id: number;
  ts: string;
  level: string;
  step: string | null;
  message: string;
  meta: string | null;
}

interface PendingLog {
  args: [string, string, string, string | null, string, string | null];
  level: string;
  bytes: number;
}

interface InFlightLogBatch {
  id: number;
  rows: PendingLog[];
  bytes: number;
}

const LOG_BATCH_SIZE = 100;
const LOG_FLUSH_MS = 25;
const MAX_PENDING_LOG_BYTES = 2 * 1024 * 1024;
const MAX_LOG_MESSAGE_BYTES = 128 * 1024;

export type { TaskRunMetrics, TaskRunSummary } from "../application/ports.ts";

/**
 * Persists task execution history: one run row opened before the task runs
 * and closed afterwards, so a crashed run leaves a visible 'running' row
 * rather than disappearing.
 */
export class SqliteTaskSink implements RunRepository {
  private pendingLogs: PendingLog[] = [];
  private pendingLogBytes = 0;
  private logFlushTimer?: ReturnType<typeof setTimeout>;
  private droppedLogs = 0;
  private logBusyRetries = 0;
  private logWriteErrors = 0;
  private flushedLogBatches = 0;
  private logWorker?: Worker;
  private inFlightLogBatch?: InFlightLogBatch;
  private nextLogBatchId = 1;
  private readonly logAcknowledgement?: Int32Array;
  private closing = false;
  constructor(
    private readonly db: Database,
    private readonly notifications?: NotificationRepository,
    /**
     * `gitlab-review-requested` means nothing in a notification; "GitLab review
     * requests" does. A function rather than a registry reference because the
     * registry does not exist yet when the composition root builds this sink —
     * see `app.ts`.
     */
    private readonly taskName?: (taskId: string) => string | undefined,
    logDatabasePath?: string,
  ) {
    if (logDatabasePath && logDatabasePath !== ":memory:") {
      const acknowledgement = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      this.logAcknowledgement = new Int32Array(acknowledgement);
      this.logWorker = new Worker(new URL("./log-writer-worker.ts", import.meta.url).href, {
        type: "module",
      });
      this.logWorker.onmessage = (event: MessageEvent<{ type: "ack"; id: number; error?: string }>) => {
        const batch = this.inFlightLogBatch;
        if (!batch || batch.id !== event.data.id) return;
        if (event.data.error) this.logWriteErrors += 1;
        else this.flushedLogBatches += 1;
        this.pendingLogBytes -= batch.bytes;
        this.inFlightLogBatch = undefined;
        if (!this.closing && this.pendingLogs.length > 0) this.flushLogBatch();
      };
      this.logWorker.onerror = () => {
        this.logWriteErrors += 1;
        const batch = this.inFlightLogBatch;
        if (batch) this.pendingLogs.unshift(...batch.rows);
        this.inFlightLogBatch = undefined;
        this.logWorker?.terminate();
        this.logWorker = undefined;
        if (!this.closing) this.flushLogBatch();
      };
    }
  }

  async runStarted(record: {
    executionId: string;
    taskId: string;
    startedAt: Date;
    dryRun: boolean;
    params: unknown;
  }): Promise<void> {
    // Recorded at open, not at finish: a queued PR action is worth showing on
    // the merge request while it is still running, and `details` (the other
    // place the MR shows up) is only written once the run is over.
    const mr = mrKeyFromParams(record.params);

    this.db.run(
      `INSERT INTO task_runs
         (execution_id, task_id, started_at, status, dry_run, params,
          project_id, mr_iid)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
      [
        record.executionId,
        record.taskId,
        toIso(record.startedAt),
        record.dryRun ? 1 : 0,
        toJson(record.params),
        mr?.projectId ?? null,
        mr?.mrIid ?? null,
      ],
    );
  }

  async stepFinished(executionId: string, step: StepRecord): Promise<void> {
    this.db.run(
      `INSERT INTO task_steps
         (execution_id, step_id, started_at, duration_ms, status, attempts, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        executionId,
        step.stepId,
        toIso(step.startedAt),
        step.durationMs,
        step.status,
        step.attempts,
        step.error ?? null,
      ],
    );
  }

  async runFinished(record: TaskExecutionRecord): Promise<void> {
    await this.flushLogsForCompletion();
    this.db.transaction(() => {
      this.db.run(
      `UPDATE task_runs
          SET finished_at = ?, duration_ms = ?, status = ?,
              items_seen = ?, items_processed = ?, items_skipped = ?, error = ?,
              details = ?
        WHERE execution_id = ?`,
      [
        toIso(record.finishedAt),
        record.durationMs,
        record.status,
        record.result?.itemsSeen ?? null,
        record.result?.itemsProcessed ?? null,
        record.result?.itemsSkipped ?? null,
        record.error ?? null,
        toJson(record.result?.details),
        record.executionId,
      ],
      );
      const details = record.result?.details;
      if (!details || typeof details !== "object") return;
      const values = details as Record<string, unknown>;
      const resources: Array<["ticket" | "merge-request", string]> = [];
      if (typeof values.issueKey === "string" && values.issueKey.length > 0) {
        resources.push(["ticket", values.issueKey]);
      }
      if (typeof values.mrUrl === "string" && values.mrUrl.length > 0) {
        resources.push(["merge-request", values.mrUrl]);
      }
      for (const [kind, key] of resources) {
        this.db.run(
          `INSERT INTO execution_resources
             (execution_id, resource_kind, resource_key, provenance, created_at)
           VALUES (?, ?, ?, 'handler-details', ?)
           ON CONFLICT (execution_id, resource_kind, resource_key) DO UPDATE SET
             provenance = excluded.provenance`,
          [record.executionId, kind, key, toIso(record.finishedAt)],
        );
      }
    })();

    // Create notification for successful task completion — unless the task
    // already posted its own per-item notification(s), in which case a generic
    // "X completed" would just double up on the same event.
    if (this.notifications && record.status === "success" && !record.result?.notifiedIndividually) {
      const { itemsProcessed, itemsSkipped, itemsSeen } = record.result ?? {};
      const parts: string[] = [];
      if (itemsProcessed) parts.push(`${itemsProcessed} processed`);
      if (itemsSkipped) parts.push(`${itemsSkipped} skipped`);
      if (itemsSeen && !itemsProcessed && !itemsSkipped) parts.push(`${itemsSeen} seen`);

      const name = this.taskName?.(record.taskId) ?? record.taskId;
      this.notifications.create({
        kind: "task-success",
        title: `${name} completed`,
        body: parts.length > 0 ? parts.join(", ") : undefined,
        taskRunId: record.executionId,
      });
    }
  }

  recentRuns(taskId: string, limit = 10, offset = 0): TaskRunSummary[] {
    return this.db
      .query<TaskRunRow, [string, number, number]>(
        `SELECT * FROM task_runs
          WHERE task_id = ?
          ORDER BY started_at DESC, rowid DESC
          LIMIT ? OFFSET ?`,
      )
      .all(taskId, limit, offset)
      .map(toSummary);
  }

  recentRunsFor(taskIds: readonly string[], limitPerTask = 10): Map<string, TaskRunSummary[]> {
    const result = new Map(taskIds.map((id) => [id, [] as TaskRunSummary[]]));
    if (taskIds.length === 0) return result;
    const placeholders = taskIds.map(() => "?").join(", ");
    const rows = this.db.query<TaskRunRow, (string | number)[]>(
      `SELECT * FROM (
         SELECT task_runs.*, ROW_NUMBER() OVER (
           PARTITION BY task_id ORDER BY started_at DESC, rowid DESC
         ) AS position
           FROM task_runs WHERE task_id IN (${placeholders})
       ) WHERE position <= ? ORDER BY task_id, position`,
    ).all(...taskIds, limitPerTask);
    for (const row of rows) result.get(row.task_id)?.push(toSummary(row));
    return result;
  }

  resourcesForRuns(executionIds: readonly string[]): Map<string, Array<{
    kind: "ticket" | "merge-request";
    key: string;
    provenance: string;
  }>> {
    const result = new Map<string, Array<{
      kind: "ticket" | "merge-request";
      key: string;
      provenance: string;
    }>>();
    if (executionIds.length === 0) return result;
    const placeholders = executionIds.map(() => "?").join(", ");
    const rows = this.db.query<{
      execution_id: string;
      resource_kind: "ticket" | "merge-request";
      resource_key: string;
      provenance: string;
    }, string[]>(
      `SELECT execution_id, resource_kind, resource_key, provenance
         FROM execution_resources WHERE execution_id IN (${placeholders})
        ORDER BY execution_id, resource_kind, resource_key`,
    ).all(...executionIds);
    for (const row of rows) {
      const bucket = result.get(row.execution_id) ?? [];
      bucket.push({ kind: row.resource_kind, key: row.resource_key, provenance: row.provenance });
      result.set(row.execution_id, bucket);
    }
    return result;
  }

  lastRun(taskId: string): TaskRunSummary | null {
    return this.recentRuns(taskId, 1)[0] ?? null;
  }

  runsFor(
    projectId: string,
    mrIid: number,
    limit = 10,
    offset = 0,
  ): TaskRunSummary[] {
    return this.db
      .query<TaskRunRow, [string, number, number, number]>(
        `SELECT * FROM task_runs
          WHERE project_id = ? AND mr_iid = ?
          ORDER BY started_at DESC, rowid DESC
          LIMIT ? OFFSET ?`,
      )
      .all(projectId, mrIid, limit, offset)
      .map(toSummary);
  }

  countFor(projectId: string, mrIid: number): number {
    return (
      this.db
        .query<{ total: number }, [string, number]>(
          `SELECT COUNT(*) AS total FROM task_runs
            WHERE project_id = ? AND mr_iid = ?`,
        )
        .get(projectId, mrIid)?.total ?? 0
    );
  }

  getRun(executionId: string): TaskRunSummary | null {
    const row = this.db
      .query<TaskRunRow, [string]>(
        "SELECT * FROM task_runs WHERE execution_id = ?",
      )
      .get(executionId);
    return row ? toSummary(row) : null;
  }

  getRuns(executionIds: readonly string[]): Map<string, TaskRunSummary> {
    const ids = [...new Set(executionIds)].filter(Boolean);
    const out = new Map<string, TaskRunSummary>();
    for (let offset = 0; offset < ids.length; offset += 250) {
      const chunk = ids.slice(offset, offset + 250);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .query<TaskRunRow, string[]>(
          `SELECT * FROM task_runs WHERE execution_id IN (${placeholders})`,
        )
        .all(...chunk);
      for (const row of rows) out.set(row.execution_id, toSummary(row));
    }
    return out;
  }

  /**
   * Closes a still-open row (orphaned process, or cancel when this process
   * is not the one running it). No-op if the row already finished.
   */
  closeOpenRun(
    executionId: string,
    args: { status: RunStatus; error: string; finishedAt?: Date },
  ): boolean {
    const open = this.getRun(executionId);
    if (!open || open.status !== "running") return false;
    const finishedAt = args.finishedAt ?? new Date();
    return (
      this.db.run(
        `UPDATE task_runs
            SET finished_at = ?, duration_ms = ?, status = ?, error = ?
          WHERE execution_id = ? AND status = 'running'`,
        [
          toIso(finishedAt),
          Math.max(0, finishedAt.getTime() - open.startedAt.getTime()),
          args.status,
          args.error,
          executionId,
        ],
      ).changes > 0
    );
  }

  lastSuccessfulRun(taskId: string): TaskRunSummary | null {
    const row = this.db
      .query<TaskRunRow, [string]>(
        `SELECT * FROM task_runs
          WHERE task_id = ? AND status = 'success'
          ORDER BY started_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(taskId);
    return row ? toSummary(row) : null;
  }

  appendLog(executionId: string, line: ExecutionLogLine): void {
    const message = clipUtf8(line.message, MAX_LOG_MESSAGE_BYTES);
    const meta = toJson(line.meta);
    const args: PendingLog["args"] = [
      executionId,
      toIso(line.ts),
      line.level,
      line.step ?? null,
      message,
      meta,
    ];
    const bytes = Buffer.byteLength(message) + Buffer.byteLength(meta ?? "") + 96;
    while (this.pendingLogBytes + bytes > MAX_PENDING_LOG_BYTES) {
      const evict = this.pendingLogs.findIndex((entry) => entry.level !== "error");
      if (evict < 0) {
        if (line.level !== "error") {
          this.droppedLogs += 1;
          return;
        }
        // Errors get the reserved path, but the byte ceiling remains absolute:
        // if the entire queue is errors, keep the newest diagnostic evidence.
        const removed = this.pendingLogs.shift();
        if (!removed) break;
        this.pendingLogBytes -= removed.bytes;
        this.droppedLogs += 1;
        continue;
      }
      const [removed] = this.pendingLogs.splice(evict, 1);
      this.pendingLogBytes -= removed?.bytes ?? 0;
      this.droppedLogs += 1;
    }
    this.pendingLogs.push({ args, level: line.level, bytes });
    this.pendingLogBytes += bytes;
    if (this.pendingLogs.length >= LOG_BATCH_SIZE) this.flushLogBatch();
    else this.scheduleLogFlush();
  }

  lastResolvedModel(alias: string): { model: string; ts: string } | null {
    this.flushLogBatch();
    const row = this.db
      .query<{ message: string; ts: string }, [string]>(
        `SELECT message, ts FROM task_run_logs
          WHERE message LIKE 'claude started (%' AND message LIKE ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(`%${alias}%`);
    if (!row) return null;
    return { model: row.message.slice("claude started (".length, -1), ts: row.ts };
  }

  logs(executionId: string): ExecutionLogLine[] {
    this.flushLogBatch();
    return this.db
      .query<LogRow, [string]>(
        `SELECT id, ts, level, step, message, meta
           FROM task_run_logs WHERE execution_id = ? ORDER BY id`,
      )
      .all(executionId)
      .map((row) => ({
        id: row.id,
        ts: fromIso(row.ts),
        level: row.level,
        step: row.step ?? undefined,
        message: row.message,
        meta: fromJson<Record<string, unknown>>(row.meta),
      }));
  }

  logPage(executionId: string, afterId: number, limit: number): {
    lines: ExecutionLogLine[];
    hasMore: boolean;
  } {
    this.flushLogBatch();
    // Ask for one extra row so the endpoint can truthfully say whether a
    // reconnecting client must immediately drain another page.
    const rows = this.db
      .query<LogRow, [string, number, number]>(
        `SELECT id, ts, level, step, message, meta
           FROM task_run_logs
          WHERE execution_id = ? AND id > ?
          ORDER BY id
          LIMIT ?`,
      )
      .all(executionId, afterId, limit + 1);
    const hasMore = rows.length > limit;
    return {
      lines: rows.slice(0, limit).map((row) => ({
        id: row.id,
        ts: fromIso(row.ts),
        level: row.level,
        step: row.step ?? undefined,
        message: row.message,
        meta: fromJson<Record<string, unknown>>(row.meta),
      })),
      hasMore,
    };
  }

  logTail(executionId: string, beforeId: number | undefined, limit: number): {
    lines: ExecutionLogLine[];
    hasOlder: boolean;
  } {
    this.flushLogBatch();
    const rows = beforeId == null
      ? this.db.query<LogRow, [string, number]>(
          `SELECT id, ts, level, step, message, meta
             FROM task_run_logs WHERE execution_id = ?
            ORDER BY id DESC LIMIT ?`,
        ).all(executionId, limit + 1)
      : this.db.query<LogRow, [string, number, number]>(
          `SELECT id, ts, level, step, message, meta
             FROM task_run_logs WHERE execution_id = ? AND id < ?
            ORDER BY id DESC LIMIT ?`,
        ).all(executionId, beforeId, limit + 1);
    const hasOlder = rows.length > limit;
    return {
      lines: rows.slice(0, limit).reverse().map((row) => ({
        id: row.id,
        ts: fromIso(row.ts),
        level: row.level,
        step: row.step ?? undefined,
        message: row.message,
        meta: fromJson<Record<string, unknown>>(row.meta),
      })),
      hasOlder,
    };
  }

  retentionCounts(before: Date): { runs: number; logs: number } {
    const cutoff = toIso(before);
    const runs = this.db.query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM task_runs
        WHERE finished_at IS NOT NULL AND finished_at < ?
          AND rowid NOT IN (SELECT MAX(rowid) FROM task_runs GROUP BY task_id)`,
    ).get(cutoff)?.count ?? 0;
    const logs = this.db.query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM task_run_logs AS logs
        JOIN task_runs AS runs ON runs.execution_id = logs.execution_id
       WHERE runs.finished_at IS NOT NULL AND runs.finished_at < ?
         AND runs.rowid NOT IN (SELECT MAX(rowid) FROM task_runs GROUP BY task_id)`,
    ).get(cutoff)?.count ?? 0;
    return { runs, logs };
  }

  rawLogRetentionCount(before: Date): number {
    this.flushLogBatch();
    return this.db.query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM task_run_logs AS logs
        JOIN task_runs AS runs ON runs.execution_id = logs.execution_id
       WHERE runs.finished_at IS NOT NULL AND runs.finished_at < ?`,
    ).get(toIso(before))?.count ?? 0;
  }

  purgeRawLogs(before: Date, limit = 250): number {
    this.flushLogBatch();
    const ids = this.db.query<{ id: number }, [string, number]>(
      `SELECT logs.id FROM task_run_logs AS logs
        JOIN task_runs AS runs ON runs.execution_id = logs.execution_id
       WHERE runs.finished_at IS NOT NULL AND runs.finished_at < ?
       ORDER BY logs.id LIMIT ?`,
    ).all(toIso(before), limit).map((row) => row.id);
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    this.db.run(`DELETE FROM task_run_logs WHERE id IN (${placeholders})`, ids);
    return ids.length;
  }

  purgeFinishedRuns(before: Date, limit = 250): number {
    // Cascades remove steps and logs. Selecting a small oldest-first batch keeps
    // each writer lock bounded instead of deleting years of logs in one commit.
    const ids = this.db.query<{ execution_id: string }, [string, number]>(
      `SELECT execution_id FROM task_runs
        WHERE finished_at IS NOT NULL AND finished_at < ?
          AND rowid NOT IN (SELECT MAX(rowid) FROM task_runs GROUP BY task_id)
        ORDER BY finished_at
        LIMIT ?`,
    ).all(toIso(before), limit).map((row) => row.execution_id);
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    this.db.run(`DELETE FROM task_runs WHERE execution_id IN (${placeholders})`, ids);
    // `changes` includes cascaded step/log rows on some SQLite builds; the
    // selected parent count is the stable batch-progress contract.
    return ids.length;
  }

  close(): void {
    this.closing = true;
    if (this.logFlushTimer) clearTimeout(this.logFlushTimer);
    this.logFlushTimer = undefined;
    if (!this.logWorker || !this.logAcknowledgement) {
      while (this.pendingLogs.length > 0) this.flushLogBatch();
      return;
    }

    // Shutdown is the only synchronous wait: application work has stopped and
    // the database must not close until the persistence worker acknowledges all
    // accepted rows. Post the remaining bounded buffer behind any active batch.
    let target = this.inFlightLogBatch?.id ?? Atomics.load(this.logAcknowledgement, 0);
    if (this.pendingLogs.length > 0) {
      const rows = this.pendingLogs.splice(0);
      target = this.nextLogBatchId++;
      this.logWorker.postMessage({
        type: "batch",
        id: target,
        databasePath: this.workerDatabasePath(),
        rows: rows.map((entry) => entry.args),
        acknowledgement: this.logAcknowledgement.buffer,
      });
    }
    const deadline = Date.now() + 5_000;
    while (Atomics.load(this.logAcknowledgement, 0) < target && Date.now() < deadline) {
      const current = Atomics.load(this.logAcknowledgement, 0);
      Atomics.wait(this.logAcknowledgement, 0, current, Math.min(100, deadline - Date.now()));
    }
    this.pendingLogBytes = 0;
    this.inFlightLogBatch = undefined;
    this.logWorker.terminate();
    this.logWorker = undefined;
  }

  logBufferStats() {
    return {
      records: this.pendingLogs.length + (this.inFlightLogBatch?.rows.length ?? 0),
      bytes: this.pendingLogBytes,
      dropped: this.droppedLogs,
      busyRetries: this.logBusyRetries,
      writeErrors: this.logWriteErrors,
      batches: this.flushedLogBatches,
    };
  }

  private scheduleLogFlush(delayMs = LOG_FLUSH_MS): void {
    if (this.logFlushTimer) return;
    this.logFlushTimer = setTimeout(() => {
      this.logFlushTimer = undefined;
      if (!this.flushLogBatch()) this.scheduleLogFlush(delayMs * 2);
    }, Math.min(delayMs, 1_000));
  }

  /** Returns false only for transient SQLite contention; queued rows remain intact. */
  private flushLogBatch(): boolean {
    if (this.pendingLogs.length === 0) return true;
    if (this.logFlushTimer) clearTimeout(this.logFlushTimer);
    this.logFlushTimer = undefined;
    if (this.logWorker && this.logAcknowledgement) {
      if (this.inFlightLogBatch) return true;
      const rows = this.pendingLogs.splice(0, LOG_BATCH_SIZE);
      const batch: InFlightLogBatch = {
        id: this.nextLogBatchId++,
        rows,
        bytes: rows.reduce((total, entry) => total + entry.bytes, 0),
      };
      this.inFlightLogBatch = batch;
      this.logWorker.postMessage({
        type: "batch",
        id: batch.id,
        databasePath: this.workerDatabasePath(),
        rows: rows.map((entry) => entry.args),
        acknowledgement: this.logAcknowledgement.buffer,
      });
      return true;
    }
    const batch = this.pendingLogs.splice(0, LOG_BATCH_SIZE);
    const bytes = batch.reduce((total, entry) => total + entry.bytes, 0);
    try {
      this.db.transaction(() => {
        for (const entry of batch) {
          try {
            this.db.run(
              `INSERT INTO task_run_logs
                 (execution_id, ts, level, step, message, meta)
               VALUES (?, ?, ?, ?, ?, ?)`,
              entry.args,
            );
          } catch (err) {
            // A pino line can race ahead of runStarted. That one line has no
            // valid parent and must not poison the rest of the batch.
            if (!String(err).includes("FOREIGN KEY")) throw err;
          }
        }
      })();
      this.flushedLogBatches += 1;
      this.pendingLogBytes -= bytes;
      if (this.pendingLogs.length > 0) this.scheduleLogFlush();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.pendingLogs.unshift(...batch);
      if (message.includes("busy") || message.includes("locked")) {
        this.logBusyRetries += 1;
        return false;
      }
      // An unexpected persistence error should not recurse through the logger.
      this.logWriteErrors += 1;
      this.pendingLogBytes -= bytes;
      this.pendingLogs.splice(0, batch.length);
      return true;
    }
  }

  private async flushLogsForCompletion(): Promise<void> {
    if (this.logWorker) {
      const deadline = Date.now() + 6_000;
      while ((this.pendingLogs.length > 0 || this.inFlightLogBatch) && Date.now() < deadline) {
        this.flushLogBatch();
        await Bun.sleep(5);
      }
      return;
    }
    for (let attempt = 0; this.pendingLogs.length > 0 && attempt < 6; attempt++) {
      if (this.flushLogBatch()) continue;
      await Bun.sleep(25 * (attempt + 1));
    }
  }

  private workerDatabasePath(): string {
    return this.db.filename;
  }

  steps(executionId: string): StepRecord[] {
    return this.db
      .query<StepRow, [string]>(
        `SELECT step_id, started_at, duration_ms, status, attempts, error
           FROM task_steps WHERE execution_id = ? ORDER BY id`,
      )
      .all(executionId)
      .map((row) => ({
        stepId: row.step_id,
        startedAt: fromIso(row.started_at),
        durationMs: row.duration_ms,
        status: row.status,
        attempts: row.attempts,
        error: row.error ?? undefined,
      }));
  }

  /**
   * Runs left open by an unclean shutdown. Closed as failures at startup so
   * history does not accumulate phantom 'running' rows.
   */
  findOrphanedRuns(): TaskRunSummary[] {
    return this.db
      .query<TaskRunRow, []>(
        "SELECT * FROM task_runs WHERE status = 'running' ORDER BY started_at",
      )
      .all()
      .map(toSummary);
  }

  closeOrphanedRuns(reason: string): number {
    const count = this.db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM task_runs WHERE status = 'running'",
    ).get()?.count ?? 0;
    if (count === 0) return 0;
    this.db.run(
      `UPDATE task_runs
          SET status = 'failure', finished_at = ?, error = ?
        WHERE status = 'running'`,
      [toIso(new Date()), reason],
    );
    return count;
  }

  stats(taskId: string): {
    total: number;
    successes: number;
    failures: number;
    avgDurationMs: number | null;
  } {
    const row = this.db
      .query<
        {
          total: number;
          successes: number;
          failures: number;
          avg_duration: number | null;
        },
        [string]
      >(
        `SELECT total, successes, failures,
                CASE WHEN duration_count = 0 THEN NULL
                     ELSE CAST(duration_total AS REAL) / duration_count END AS avg_duration
           FROM task_run_statistics WHERE task_id = ?`,
      )
      .get(taskId);

    return {
      total: row?.total ?? 0,
      successes: row?.successes ?? 0,
      failures: row?.failures ?? 0,
      avgDurationMs:
        row?.avg_duration != null ? Math.round(row.avg_duration) : null,
    };
  }

  /**
   * The task list needs these three historical facts for every visible row.
   * Fetching them one task at a time turns a 100-row page into hundreds of
   * synchronous SQLite queries; this batches the indexed aggregates instead.
   */
  metricsFor(taskIds: readonly string[]): Map<string, TaskRunMetrics> {
    if (taskIds.length === 0) return new Map();
    const placeholders = taskIds.map(() => "?").join(", ");
    const stats = this.db
      .query<
        { task_id: string; total: number; successes: number; failures: number; avg_duration: number | null },
        string[]
      >(
        `SELECT task_id, total, successes, failures,
                CASE WHEN duration_count = 0 THEN NULL
                     ELSE CAST(duration_total AS REAL) / duration_count END AS avg_duration
           FROM task_run_statistics WHERE task_id IN (${placeholders})`,
      )
      .all(...taskIds);
    const latest = this.db
      .query<TaskRunRow, string[]>(
        `SELECT * FROM (
           SELECT task_runs.*, ROW_NUMBER() OVER (
             PARTITION BY task_id ORDER BY started_at DESC, rowid DESC
           ) AS position
             FROM task_runs WHERE task_id IN (${placeholders})
         ) WHERE position = 1`,
      )
      .all(...taskIds);
    const byId = new Map<string, TaskRunMetrics>();
    for (const id of taskIds) {
      byId.set(id, {
        lastRun: null,
        stats: { total: 0, successes: 0, failures: 0, avgDurationMs: null },
      });
    }
    for (const row of stats) {
      const entry = byId.get(row.task_id)!;
      entry.stats = {
        total: row.total,
        successes: row.successes,
        failures: row.failures,
        avgDurationMs: row.avg_duration == null ? null : Math.round(row.avg_duration),
      };
    }
    for (const row of latest) byId.get(row.task_id)!.lastRun = toSummary(row);
    return byId;
  }
}

function clipUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= maxBytes) return text;
  return `${new TextDecoder().decode(bytes.subarray(0, maxBytes))}\n… [log message truncated]`;
}

function toSummary(row: TaskRunRow): TaskRunSummary {
  return {
    executionId: row.execution_id,
    taskId: row.task_id,
    startedAt: fromIso(row.started_at),
    finishedAt: fromIso(row.finished_at),
    durationMs: row.duration_ms ?? undefined,
    status: row.status,
    dryRun: row.dry_run === 1,
    params: fromJson(row.params),
    itemsSeen: row.items_seen ?? undefined,
    itemsProcessed: row.items_processed ?? undefined,
    itemsSkipped: row.items_skipped ?? undefined,
    error: row.error ?? undefined,
    details: fromJson(row.details),
    projectId: row.project_id ?? undefined,
    mrIid: row.mr_iid ?? undefined,
  };
}

/**
 * The merge request a run is about, or undefined for a run that is not about
 * one. Read structurally rather than through a task's own zod schema because
 * the sink sees params as `unknown` and must not know the task types: every
 * MR-scoped task happens to share the same `gitlab: { projectId, mrIid }` block
 * (see `resolve-conflicts`, `mr-follow-up` and `code-review/review-job`), and a
 * task that ever stops doing so simply records no MR rather than failing.
 */
function mrKeyFromParams(
  params: unknown,
): { projectId: string; mrIid: number } | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const gitlab = (params as { gitlab?: unknown }).gitlab;
  if (typeof gitlab !== "object" || gitlab === null) return undefined;

  const { projectId, mrIid } = gitlab as {
    projectId?: unknown;
    mrIid?: unknown;
  };
  if (typeof projectId !== "string" || projectId === "") return undefined;
  if (typeof mrIid !== "number" || !Number.isInteger(mrIid) || mrIid <= 0) {
    return undefined;
  }

  return { projectId, mrIid };
}
