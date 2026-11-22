import type { Database } from "bun:sqlite";
import type {
  RecordReviewInput,
  ReviewedMergeRequest,
  ReviewRepository,
} from "../application/ports.ts";
import { fromIso, toIso } from "./database.ts";

export type {
  RecordReviewInput,
  ReviewedMergeRequest,
} from "../application/ports.ts";

/**
 * Tracks which merge request, at which head commit, has already earned a
 * review comment.
 *
 * Simpler than `IssueLedger`: there is no open/closed lifecycle to track, only
 * "is this exact commit already reviewed". A new commit on the same MR is a
 * new row's worth of content but the same primary key, so `record` upserts
 * rather than inserts — the previous review's identity does not matter once
 * superseded.
 */
export class ReviewLedger implements ReviewRepository {
  constructor(private readonly db: Database) {}

  /** The sha last reviewed for this MR, or null if it has never been reviewed. */
  lastReviewedSha(taskId: string, projectId: string, mrIid: number): string | null {
    const row = this.db
      .query<{ sha: string }, [string, string, number]>(
        `SELECT sha FROM reviewed_merge_requests
          WHERE task_id = ? AND project_id = ? AND mr_iid = ?`,
      )
      .get(taskId, projectId, mrIid);
    return row?.sha ?? null;
  }

  record(input: RecordReviewInput): ReviewedMergeRequest {
    const reviewedAt = new Date();
    this.db.run(
      `INSERT INTO reviewed_merge_requests (task_id, project_id, mr_iid, sha, note_url, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (task_id, project_id, mr_iid) DO UPDATE SET
         sha = excluded.sha,
         note_url = excluded.note_url,
         reviewed_at = excluded.reviewed_at`,
      [
        input.taskId,
        input.projectId,
        input.mrIid,
        input.sha,
        input.noteUrl ?? null,
        toIso(reviewedAt),
      ],
    );
    return { ...input, reviewedAt };
  }

  /** Every MR this task has reviewed, most recent first — for `task logs`-style visibility. */
  all(taskId: string): ReviewedMergeRequest[] {
    return this.db
      .query<Row, [string]>(
        `SELECT * FROM reviewed_merge_requests
          WHERE task_id = ?
          ORDER BY reviewed_at DESC`,
      )
      .all(taskId)
      .map(toReviewed);
  }
}

interface Row {
  task_id: string;
  project_id: string;
  mr_iid: number;
  sha: string;
  note_url: string | null;
  reviewed_at: string;
}

function toReviewed(row: Row): ReviewedMergeRequest {
  return {
    taskId: row.task_id,
    projectId: row.project_id,
    mrIid: row.mr_iid,
    sha: row.sha,
    noteUrl: row.note_url ?? undefined,
    reviewedAt: fromIso(row.reviewed_at),
  };
}
