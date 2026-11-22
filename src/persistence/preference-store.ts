import type { Database } from "bun:sqlite";
import type { PreferenceRepository } from "../application/ports.ts";
import { toIso } from "./database.ts";

interface Row {
  key: string;
  value: string;
}

/**
 * One developer's console preferences, in plain SQLite — see `PreferenceRepository`
 * for why the values are opaque here, and migration 46 for what belongs in this
 * table and what stays in the browser.
 */
export class SqlitePreferenceStore implements PreferenceRepository {
  constructor(private readonly db: Database) {}

  all(userId: string): Record<string, string> {
    const rows = this.db
      .query<Row, [string]>("SELECT key, value FROM user_preferences WHERE user_id = ?")
      .all(userId);
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  set(userId: string, key: string, value: string): void {
    this.db.run(
      `INSERT INTO user_preferences (user_id, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
      [userId, key, value, toIso(new Date())],
    );
  }

  clear(userId: string, key: string): void {
    this.db.run("DELETE FROM user_preferences WHERE user_id = ? AND key = ?", [userId, key]);
  }
}
