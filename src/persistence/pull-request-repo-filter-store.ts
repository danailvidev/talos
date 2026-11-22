import type { Database } from "bun:sqlite";
import type { PullRequestRepoFilterRepository } from "../application/ports.ts";
import { toIso } from "./database.ts";

/**
 * One developer's Team MRs repository filter, in plain SQLite — see
 * `application/ports.ts` for why this needs no encryption.
 */
export class SqlitePullRequestRepoFilterStore implements PullRequestRepoFilterRepository {
  constructor(private readonly db: Database) {}

  list(userId: string): string[] {
    return this.db
      .query<{ repository: string }, [string]>(
        "SELECT repository FROM user_pull_request_repos WHERE user_id = ? ORDER BY repository",
      )
      .all(userId)
      .map((row) => row.repository);
  }

  set(userId: string, repositories: readonly string[]): void {
    const normalized = normalize(repositories);
    const now = toIso(new Date());
    // Replace-the-whole-set rather than diffing: the settings UI always saves
    // its full list, and a delete-then-insert in one transaction is simpler
    // than reconciling adds against removes for a table this small.
    this.db.transaction(() => {
      this.db.run("DELETE FROM user_pull_request_repos WHERE user_id = ?", [userId]);
      for (const repository of normalized) {
        this.db.run(
          "INSERT INTO user_pull_request_repos (user_id, repository, created_at) VALUES (?, ?, ?)",
          [userId, repository, now],
        );
      }
    })();
  }
}

/** Trimmed, deduplicated, and sorted, so saving the same set twice is a no-op. */
function normalize(repositories: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of repositories) {
    const trimmed = raw.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen].sort();
}
