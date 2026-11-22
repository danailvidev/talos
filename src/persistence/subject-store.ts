import type { Database } from "bun:sqlite";
import type {
  ObserveSubjectInput,
  OpenSubjectInput,
  SubjectRepository,
  WorkSubject,
  WorkSubjectState,
} from "../application/ports.ts";
import { fromIso, fromJson, toIso, toJson } from "./database.ts";

/**
 * What each loop has already seen and acted on.
 *
 * Every loop in this codebase asks the same question — *have I already handled
 * this thing, at this version?* — and each answered it differently: a watermark
 * plus `filed_issues` for CI failures, a `reviewed_merge_requests` sha for code
 * review, a `processed_events` claim for MR discussions. Three tables, three code
 * paths, three sets of bugs. This is that one question, once.
 *
 * A **subject** is a thing that persists across polls: a spec file, a merge
 * request, a Jira ticket. Its key is namespaced (`spec:…`, `gitlab:mr:…`,
 * `jira:…`) and chosen so it survives the events that touch it — the lesson from
 * `ci-failure`, where keying on the pipeline would have refiled every ticket
 * nightly and keying on the test would have orphaned tickets on rename.
 *
 * A **fingerprint** is the version last acted on: an MR head sha, a failure
 * signature, a ticket's `updated` timestamp. Comparing it is what makes a second
 * poll a no-op and a genuine change actionable.
 *
 * The "at most one open subject per key" rule is a partial unique index, not a
 * check here, so two concurrent runs cannot both decide to act.
 */
export class SqliteSubjectStore implements SubjectRepository {
  constructor(private readonly db: Database) {}

  findOpen(loopId: string, subjectKey: string): WorkSubject | null {
    const row = this.db
      .query<Row, [string, string]>(
        `SELECT * FROM work_subjects
          WHERE loop_id = ? AND subject_key = ? AND state = 'open'`,
      )
      .get(loopId, subjectKey);
    return row ? toSubject(row) : null;
  }

  findOpenByExternalRef(loopId: string, externalRef: string): WorkSubject | null {
    const row = this.db
      .query<Row, [string, string]>(
        `SELECT * FROM work_subjects
          WHERE loop_id = ? AND external_ref = ? AND state = 'open'
          ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .get(loopId, externalRef);
    return row ? toSubject(row) : null;
  }

  /**
   * Records that a subject was seen, and reports whether it is new work.
   *
   * This is the call a discoverer makes per item. `changed` is the decision:
   * true for a subject never seen open, or one whose fingerprint differs from
   * what was last acted on. That is the only thing a discoverer needs in order
   * to decide whether to enqueue, and it is computed against durable state
   * rather than against a watermark — so a run that examined the wrong window
   * cannot silently skip work.
   *
   * Note what is *not* stored here: the fingerprint is only advanced by
   * `markActedOn`, after the work succeeds. Recording it on observation would
   * mean a crashed handler never retried, which is the failure this whole
   * mechanism exists to prevent.
   */
  observe(input: ObserveSubjectInput): { subject: WorkSubject; changed: boolean } {
    const now = toIso(new Date());
    const existing = this.findOpen(input.loopId, input.subjectKey);

    if (!existing) {
      this.db.run(
        `INSERT INTO work_subjects
           (loop_id, subject_key, fingerprint, state, external_ref, external_url,
            metadata, first_seen_at, updated_at, last_seen_at, seen_count)
         VALUES (?, ?, NULL, 'open', ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (loop_id, subject_key) WHERE state = 'open'
           DO NOTHING`,
        [
          input.loopId,
          input.subjectKey,
          input.externalRef ?? null,
          input.externalUrl ?? null,
          toJson(input.metadata),
          now,
          now,
          now,
        ],
      );
      // A concurrent run may have inserted between the read and the write; the
      // index refused ours and its row is the live one. Re-reading rather than
      // trusting our own insert is what makes that harmless.
      const subject = this.findOpen(input.loopId, input.subjectKey)!;
      return { subject, changed: subject.fingerprint !== input.fingerprint };
    }

    // Refreshed on every poll that provides a value, not just at insert — a
    // subject observed months ago under an older loop version would otherwise
    // carry a permanently stale (or missing) title and author forever, since
    // nothing else touches this row while it stays open. COALESCE rather than
    // an unconditional overwrite: `ci-failure`'s bare re-sighting call passes
    // none of these, and must leave what `open()` already stored untouched.
    this.db.run(
      `UPDATE work_subjects
          SET last_seen_at = ?, seen_count = seen_count + 1, updated_at = ?,
              external_ref = COALESCE(?, external_ref),
              external_url = COALESCE(?, external_url),
              metadata = COALESCE(?, metadata)
        WHERE id = ?`,
      [
        now,
        now,
        input.externalRef ?? null,
        input.externalUrl ?? null,
        toJson(input.metadata),
        existing.id,
      ],
    );

    return {
      subject: {
        ...existing,
        lastSeenAt: new Date(now),
        seenCount: existing.seenCount + 1,
        externalRef: input.externalRef ?? existing.externalRef,
        externalUrl: input.externalUrl ?? existing.externalUrl,
        metadata: input.metadata ?? existing.metadata,
      },
      changed: existing.fingerprint !== input.fingerprint,
    };
  }

  /**
   * Opens a subject for something that already exists outside.
   *
   * The mirror image of `observe`: there, the fingerprint is left NULL so a
   * handler that dies still retries. Here the side effect has already happened —
   * a Jira ticket was created, or an existing one adopted — so the fingerprint
   * and the external ref go in with the row, and the row's whole purpose is to
   * stop a second ticket being filed for the same subject.
   *
   * Returns null when the index refused the insert, meaning a concurrent run
   * filed first. That is not an error: the caller's job is then to reconcile with
   * the winner's ticket rather than to fail the run.
   */
  open(input: OpenSubjectInput): WorkSubject | null {
    const now = toIso(new Date());
    const result = this.db.run(
      `INSERT INTO work_subjects
         (loop_id, subject_key, fingerprint, state, external_ref, external_url,
          metadata, first_seen_at, updated_at, last_seen_at, seen_count)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (loop_id, subject_key) WHERE state = 'open'
         DO NOTHING`,
      [
        input.loopId,
        input.subjectKey,
        input.fingerprint,
        input.externalRef ?? null,
        input.externalUrl ?? null,
        toJson(input.metadata),
        now,
        now,
        now,
      ],
    );

    return result.changes > 0 ? this.findOpen(input.loopId, input.subjectKey) : null;
  }

  /**
   * Advances the fingerprint after work on this version succeeded.
   *
   * Called *after* the side effect, never before. The ordering is the whole
   * guarantee: acting then recording can leave work repeated, which
   * a fingerprint comparison or an adoption query recovers from; recording then
   * acting can leave work permanently suppressed, which nothing recovers from.
   */
  markActedOn(
    loopId: string,
    subjectKey: string,
    fingerprint: string,
    args: {
      externalRef?: string;
      externalUrl?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ): void {
    const now = toIso(new Date());
    this.db.run(
      `UPDATE work_subjects
          SET fingerprint  = ?,
              external_ref = COALESCE(?, external_ref),
              external_url = COALESCE(?, external_url),
              metadata     = COALESCE(?, metadata),
              updated_at   = ?
        WHERE loop_id = ? AND subject_key = ? AND state = 'open'`,
      [
        fingerprint,
        args.externalRef ?? null,
        args.externalUrl ?? null,
        toJson(args.metadata),
        now,
        loopId,
        subjectKey,
      ],
    );
  }

  /**
   * Closes a subject, freeing its key to be opened again.
   *
   * Always an observation of the outside world — the Jira ticket was resolved,
   * the merge request was merged — never inferred from our own success. Whether
   * the work is finished is the owner's call, not ours.
   */
  close(loopId: string, subjectKey: string, reason?: string): void {
    const now = toIso(new Date());
    this.db.run(
      `UPDATE work_subjects
          SET state = 'closed', closed_at = ?, updated_at = ?,
              metadata = CASE
                WHEN ? IS NULL THEN metadata
                ELSE json_patch(COALESCE(metadata, '{}'), json_object('closedReason', ?))
              END
        WHERE loop_id = ? AND subject_key = ? AND state = 'open'`,
      [now, now, reason ?? null, reason ?? null, loopId, subjectKey],
    );
  }

  /** Newest first — the audit trail for one subject across reopenings. */
  history(loopId: string, subjectKey: string): WorkSubject[] {
    return this.db
      .query<Row, [string, string]>(
        `SELECT * FROM work_subjects
          WHERE loop_id = ? AND subject_key = ?
          ORDER BY first_seen_at DESC, id DESC`,
      )
      .all(loopId, subjectKey)
      .map(toSubject);
  }

  openSubjects(loopId: string, limit = 200, offset = 0): WorkSubject[] {
    return this.db
      .query<Row, [string, number, number]>(
        `SELECT * FROM work_subjects
          WHERE loop_id = ? AND state = 'open'
          ORDER BY last_seen_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(loopId, limit, offset)
      .map(toSubject);
  }

  openSubjectsFor(loopIds: readonly string[], limitPerLoop = 200): Map<string, WorkSubject[]> {
    const result = new Map(loopIds.map((id) => [id, [] as WorkSubject[]]));
    if (loopIds.length === 0) return result;
    const placeholders = loopIds.map(() => "?").join(", ");
    const rows = this.db.query<Row, (string | number)[]>(
      `SELECT * FROM (
         SELECT work_subjects.*, ROW_NUMBER() OVER (
           PARTITION BY loop_id ORDER BY last_seen_at DESC
         ) AS position
           FROM work_subjects
          WHERE state = 'open' AND loop_id IN (${placeholders})
       ) WHERE position <= ? ORDER BY loop_id, position`,
    ).all(...loopIds, limitPerLoop);
    for (const row of rows) result.get(row.loop_id)?.push(toSubject(row));
    return result;
  }

  countByState(loopId: string): Record<WorkSubjectState, number> {
    const rows = this.db
      .query<{ state: WorkSubjectState; n: number }, [string]>(
        `SELECT state, COUNT(*) AS n FROM work_subjects
          WHERE loop_id = ? GROUP BY state`,
      )
      .all(loopId);

    const counts: Record<WorkSubjectState, number> = { open: 0, closed: 0 };
    for (const row of rows) counts[row.state] = row.n;
    return counts;
  }

  /** Open-subject counts for a task-list page, in one grouped indexed query. */
  openCounts(loopIds: readonly string[]): Map<string, number> {
    if (loopIds.length === 0) return new Map();
    const placeholders = loopIds.map(() => "?").join(", ");
    const rows = this.db
      .query<{ loop_id: string; n: number }, string[]>(
        `SELECT loop_id, COUNT(*) AS n FROM work_subjects
          WHERE state = 'open' AND loop_id IN (${placeholders}) GROUP BY loop_id`,
      )
      .all(...loopIds);
    return new Map(rows.map((row) => [row.loop_id, row.n]));
  }

  clearLoop(loopId: string): void {
    this.db.run("DELETE FROM work_subjects WHERE loop_id = ?", [loopId]);
  }
}

interface Row {
  id: number;
  loop_id: string;
  subject_key: string;
  fingerprint: string | null;
  state: WorkSubjectState;
  external_ref: string | null;
  external_url: string | null;
  metadata: string | null;
  first_seen_at: string;
  updated_at: string;
  last_seen_at: string;
  seen_count: number;
  closed_at: string | null;
}

function toSubject(row: Row): WorkSubject {
  return {
    id: row.id,
    loopId: row.loop_id,
    subjectKey: row.subject_key,
    fingerprint: row.fingerprint ?? undefined,
    state: row.state,
    externalRef: row.external_ref ?? undefined,
    externalUrl: row.external_url ?? undefined,
    metadata: fromJson<Record<string, unknown>>(row.metadata),
    firstSeenAt: fromIso(row.first_seen_at),
    updatedAt: fromIso(row.updated_at),
    lastSeenAt: fromIso(row.last_seen_at),
    seenCount: row.seen_count,
    closedAt: fromIso(row.closed_at),
  };
}
