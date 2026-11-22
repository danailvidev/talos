import type { Database } from "bun:sqlite";
import type { ReleaseConfig, ReleaseConfigRepository } from "../application/ports.ts";
import { toIso } from "./database.ts";

interface Row {
  project_id: string;
  manifest_path: string;
  target_branch: string;
}

/**
 * The instance-wide releases config, in a single-row SQLite table — see
 * `application/ports.ts` for why it is one row and not per-user.
 */
export class SqliteReleaseConfigStore implements ReleaseConfigRepository {
  constructor(private readonly db: Database) {}

  get(): ReleaseConfig | null {
    const row = this.db
      .query<Row, []>(
        "SELECT project_id, manifest_path, target_branch FROM release_config WHERE id = 1",
      )
      .get();
    if (!row) return null;
    return {
      projectId: row.project_id,
      manifestPath: row.manifest_path,
      targetBranch: row.target_branch,
    };
  }

  set(config: ReleaseConfig): void {
    // Upsert the one row rather than insert-or-update by hand: the CHECK on
    // `id` guarantees there is never more than one.
    this.db.run(
      `INSERT INTO release_config (id, project_id, manifest_path, target_branch, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id,
         manifest_path = excluded.manifest_path,
         target_branch = excluded.target_branch,
         updated_at = excluded.updated_at`,
      [config.projectId, config.manifestPath, config.targetBranch, toIso(new Date())],
    );
  }
}
