import type { Database } from "bun:sqlite";
import type { FixIssueDefaults, FixIssueDefaultsRepository } from "../application/ports.ts";
import { toIso } from "./database.ts";

interface Row {
  project_id: string;
  target_branch: string;
}

/**
 * One developer's fix target, in plain SQLite — see `application/ports.ts` for
 * why this is per-user and needs no encryption.
 */
export class SqliteFixIssueDefaultsStore implements FixIssueDefaultsRepository {
  constructor(private readonly db: Database) {}

  get(userId: string): FixIssueDefaults | null {
    const row = this.db
      .query<Row, [string]>(
        "SELECT project_id, target_branch FROM user_fix_issue_defaults WHERE user_id = ?",
      )
      .get(userId);
    if (!row) return null;
    return { projectId: row.project_id, targetBranch: row.target_branch };
  }

  set(userId: string, defaults: FixIssueDefaults): void {
    this.db.run(
      `INSERT INTO user_fix_issue_defaults (user_id, project_id, target_branch, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         project_id = excluded.project_id,
         target_branch = excluded.target_branch,
         updated_at = excluded.updated_at`,
      [userId, defaults.projectId, defaults.targetBranch, toIso(new Date())],
    );
  }
}
