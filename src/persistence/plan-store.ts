import type { Database } from "bun:sqlite";
import type {
  CreatePlanInput,
  Plan,
  PlanRepository,
  PlanStatus,
} from "../application/ports.ts";
import { fromIso, toIso } from "./database.ts";
import { newId } from "./id.ts";

interface Row {
  id: string;
  issue_key: string;
  project_id: string;
  target_branch: string;
  status: string;
  draft_body: string;
  approved_body: string | null;
  summary: string | null;
  ticket_fingerprint: string | null;
  base_sha: string | null;
  plan_run_id: string | null;
  implement_job_id: string | null;
  requested_by: string | null;
  reviewer_id: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, issue_key, project_id, target_branch, status, draft_body, approved_body,
                 summary, ticket_fingerprint, base_sha, plan_run_id, implement_job_id,
                 requested_by, reviewer_id, review_note, created_at, updated_at`;

/**
 * Implementation plans awaiting, or past, a human decision.
 *
 * Every state change is written as a conditional UPDATE whose WHERE names the
 * status it expects, and returns whether it changed a row. That is the same
 * check-nothing-act-once discipline `SqliteJobQueue.lease` uses, and it is what
 * stops two reviewers opening the same plan in two tabs from both queueing a fix
 * — the second UPDATE matches nothing and its caller reports the refusal.
 */
export class SqlitePlanStore implements PlanRepository {
  constructor(private readonly db: Database) {}

  create(input: CreatePlanInput): Plan {
    const id = newId();
    const now = toIso(new Date());
    // One transaction: the unique index allows a single `awaiting-review` row per
    // ticket, so superseding the old plan and inserting the new one are two halves
    // of one change. Split across two statements, a crash between them leaves the
    // ticket with no open plan and the agent's work lost.
    this.db.transaction(() => {
      this.db.run(
        `UPDATE plans SET status = 'superseded', updated_at = ?
          WHERE issue_key = ? AND status = 'awaiting-review'`,
        [now, input.issueKey],
      );
      this.db.run(
        `INSERT INTO plans
           (id, issue_key, project_id, target_branch, status, draft_body, approved_body,
            summary, ticket_fingerprint, base_sha, plan_run_id, implement_job_id,
            requested_by, reviewer_id, review_note, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'awaiting-review', ?, NULL, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`,
        [
          id,
          input.issueKey,
          input.projectId,
          input.targetBranch,
          input.draftBody,
          input.summary ?? null,
          input.ticketFingerprint ?? null,
          input.baseSha ?? null,
          input.planRunId ?? null,
          input.requestedBy ?? null,
          now,
          now,
        ],
      );
    })();
    return this.get(id)!;
  }

  get(id: string): Plan | undefined {
    const row = this.db
      .query<Row, [string]>(`SELECT ${COLUMNS} FROM plans WHERE id = ?`)
      .get(id);
    return row ? toPlan(row) : undefined;
  }

  awaitingReview(): Plan[] {
    // Oldest first, unlike every other listing here: this one is a work queue for a
    // person, and the plan that has waited longest is the one to look at.
    return this.db
      .query<Row, []>(
        `SELECT ${COLUMNS} FROM plans WHERE status = 'awaiting-review'
          ORDER BY created_at ASC`,
      )
      .all()
      .map(toPlan);
  }

  forIssue(issueKey: string): Plan[] {
    return this.db
      .query<Row, [string]>(
        `SELECT ${COLUMNS} FROM plans WHERE issue_key = ? ORDER BY created_at DESC`,
      )
      .all(issueKey)
      .map(toPlan);
  }

  openForIssue(issueKey: string): Plan | undefined {
    const row = this.db
      .query<Row, [string]>(
        `SELECT ${COLUMNS} FROM plans WHERE issue_key = ? AND status = 'awaiting-review'`,
      )
      .get(issueKey);
    return row ? toPlan(row) : undefined;
  }

  unresolvedForIssues(issueKeys: readonly string[]): Plan[] {
    if (issueKeys.length === 0) return [];
    const holes = issueKeys.map(() => "?").join(", ");
    return this.db
      .query<Row, string[]>(
        `SELECT ${COLUMNS} FROM plans
          WHERE issue_key IN (${holes}) AND status IN ('awaiting-review', 'approved')
          ORDER BY created_at DESC`,
      )
      .all(...issueKeys)
      .map(toPlan);
  }

  approve(
    id: string,
    args: { reviewerId: string; body: string; implementJobId: string },
  ): boolean {
    return (
      this.db.run(
        `UPDATE plans
            SET status = 'approved', approved_body = ?, reviewer_id = ?,
                implement_job_id = ?, updated_at = ?
          WHERE id = ? AND status = 'awaiting-review'`,
        [args.body, args.reviewerId, args.implementJobId, toIso(new Date()), id],
      ).changes > 0
    );
  }

  reject(id: string, args: { reviewerId: string; note?: string }): boolean {
    return (
      this.db.run(
        `UPDATE plans
            SET status = 'rejected', reviewer_id = ?, review_note = ?, updated_at = ?
          WHERE id = ? AND status = 'awaiting-review'`,
        [args.reviewerId, args.note ?? null, toIso(new Date()), id],
      ).changes > 0
    );
  }

  markImplemented(id: string): boolean {
    // Only from `approved`: an implemented plan is one whose approval produced a
    // merge request, and a plan that reached here from any other state would mean
    // a fix ran without one.
    return (
      this.db.run(
        `UPDATE plans SET status = 'implemented', updated_at = ?
          WHERE id = ? AND status = 'approved'`,
        [toIso(new Date()), id],
      ).changes > 0
    );
  }
}

function toPlan(row: Row): Plan {
  return {
    id: row.id,
    issueKey: row.issue_key,
    projectId: row.project_id,
    targetBranch: row.target_branch,
    status: row.status as PlanStatus,
    draftBody: row.draft_body,
    ...(row.approved_body ? { approvedBody: row.approved_body } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.ticket_fingerprint ? { ticketFingerprint: row.ticket_fingerprint } : {}),
    ...(row.base_sha ? { baseSha: row.base_sha } : {}),
    ...(row.plan_run_id ? { planRunId: row.plan_run_id } : {}),
    ...(row.implement_job_id ? { implementJobId: row.implement_job_id } : {}),
    ...(row.requested_by ? { requestedBy: row.requested_by } : {}),
    ...(row.reviewer_id ? { reviewerId: row.reviewer_id } : {}),
    ...(row.review_note ? { reviewNote: row.review_note } : {}),
    createdAt: fromIso(row.created_at),
    updatedAt: fromIso(row.updated_at),
  };
}
