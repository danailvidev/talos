import type { Database } from "bun:sqlite";
import { fromIso, fromJson, toIso, toJson } from "./database.ts";
import type { ClaimStatus, ProcessedEvent, StateStore } from "./state-store.ts";

interface EventRow {
  task_id: string;
  external_id: string;
  event_type: string;
  status: ClaimStatus;
  claimed_at: string;
  completed_at: string | null;
  attempts: number;
  error: string | null;
  metadata: string | null;
}

const WATERMARK_KEY = "watermark";

/**
 * SQLite-backed idempotency store.
 *
 * The atomicity guarantee rests on the unique index over
 * (task_id, external_id). Two processes racing to claim the same event both
 * issue the same INSERT; exactly one wins, and the loser sees zero changed rows.
 * No lock is taken and no read precedes the write, so there is no window between
 * checking and acting.
 *
 * Run this against tests/state-store.test.ts — it is a contract suite shared with
 * MemoryStateStore, so both implementations are held to identical behaviour.
 */
export class SqliteStateStore implements StateStore {
  constructor(private readonly db: Database) {}

  async claimEvent(
    taskId: string,
    externalId: string,
    eventType: string,
  ): Promise<boolean> {
    const now = toIso(new Date());

    /*
     * One statement, two cases:
     *
     *   - no row exists          -> INSERT wins, claim granted
     *   - a 'failed' row exists  -> conflict fires, the WHERE re-claims it and
     *                               increments attempts
     *   - a 'claimed' or 'completed' row exists
     *                           -> conflict fires, the WHERE blocks the update,
     *                              zero rows change, claim refused
     *
     * Doing this as a read followed by a write would reintroduce exactly the race
     * the claim protocol exists to eliminate.
     */
    const result = this.db.run(
      `INSERT INTO processed_events
         (task_id, external_id, event_type, status, claimed_at, attempts)
       VALUES (?, ?, ?, 'claimed', ?, 1)
       ON CONFLICT (task_id, external_id) DO UPDATE SET
         status     = 'claimed',
         claimed_at = excluded.claimed_at,
         event_type = excluded.event_type,
         attempts   = processed_events.attempts + 1,
         error      = NULL
       WHERE processed_events.status = 'failed'`,
      [taskId, externalId, eventType, now],
    );

    return result.changes > 0;
  }

  async completeEvent(
    taskId: string,
    externalId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    this.db.run(
      `UPDATE processed_events
          SET status = 'completed', completed_at = ?, metadata = ?, error = NULL
        WHERE task_id = ? AND external_id = ?`,
      [toIso(new Date()), toJson(metadata), taskId, externalId],
    );
  }

  async failEvent(
    taskId: string,
    externalId: string,
    error: string,
  ): Promise<void> {
    // Guarded on status so a late failure report cannot undo a completed event
    // and re-open it for a duplicate side effect.
    this.db.run(
      `UPDATE processed_events
          SET status = 'failed', error = ?
        WHERE task_id = ? AND external_id = ? AND status != 'completed'`,
      [error, taskId, externalId],
    );
  }

  async findStaleClaims(
    taskId: string,
    olderThan: Date,
  ): Promise<ProcessedEvent[]> {
    const rows = this.db
      .query<EventRow, [string, string]>(
        `SELECT * FROM processed_events
          WHERE task_id = ? AND status = 'claimed' AND claimed_at < ?
          ORDER BY claimed_at`,
      )
      .all(taskId, toIso(olderThan));

    return rows.map(toEvent);
  }

  async getEvent(
    taskId: string,
    externalId: string,
  ): Promise<ProcessedEvent | null> {
    const row = this.db
      .query<EventRow, [string, string]>(
        `SELECT * FROM processed_events
          WHERE task_id = ? AND external_id = ?`,
      )
      .get(taskId, externalId);

    return row ? toEvent(row) : null;
  }

  async getWatermark(taskId: string): Promise<Date | null> {
    const row = this.db
      .query<{ value: string }, [string, string]>(
        "SELECT value FROM task_state WHERE task_id = ? AND key = ?",
      )
      .get(taskId, WATERMARK_KEY);

    if (!row) return null;

    // A corrupt timestamp is treated as absent, so the task reseeds rather
    // than polling from an Invalid Date and fetching the world.
    const parsed = new Date(row.value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  async setWatermark(taskId: string, at: Date): Promise<void> {
    this.db.run(
      `INSERT INTO task_state (task_id, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (task_id, key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at`,
      [taskId, WATERMARK_KEY, toIso(at), toIso(new Date())],
    );
  }

  /* ----------------------------------------------------------------------- */
  /* Beyond the StateStore contract                                          */
  /* ----------------------------------------------------------------------- */

  /** Recent events for a task, for `talos task logs`. */
  async recentEvents(taskId: string, limit = 20): Promise<ProcessedEvent[]> {
    const rows = this.db
      .query<EventRow, [string, number]>(
        `SELECT * FROM processed_events
          WHERE task_id = ?
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(taskId, limit);

    return rows.map(toEvent);
  }

  async countByStatus(taskId: string): Promise<Record<ClaimStatus, number>> {
    const rows = this.db
      .query<{ status: ClaimStatus; n: number }, [string]>(
        `SELECT status, COUNT(*) AS n FROM processed_events
          WHERE task_id = ? GROUP BY status`,
      )
      .all(taskId);

    const out: Record<ClaimStatus, number> = {
      claimed: 0,
      completed: 0,
      failed: 0,
    };
    for (const row of rows) out[row.status] = row.n;
    return out;
  }

  async clearTaskState(taskId: string): Promise<void> {
    this.db.transaction(() => {
      this.db.run("DELETE FROM processed_events WHERE task_id = ?", [taskId]);
      this.db.run("DELETE FROM task_state WHERE task_id = ?", [taskId]);
    })();
  }
}

function toEvent(row: EventRow): ProcessedEvent {
  return {
    taskId: row.task_id,
    externalId: row.external_id,
    eventType: row.event_type,
    status: row.status,
    claimedAt: fromIso(row.claimed_at),
    completedAt: fromIso(row.completed_at),
    attempts: row.attempts,
    error: row.error ?? undefined,
    metadata: fromJson<Record<string, unknown>>(row.metadata),
  };
}
