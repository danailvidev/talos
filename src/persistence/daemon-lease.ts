import type { Database } from "bun:sqlite";
import { toIso } from "./database.ts";

/** Database-backed single-daemon ownership for the SQLite deployment mode. */
export class SqliteDaemonLease {
  constructor(private readonly db: Database) {}

  acquire(owner: string, leaseMs: number): boolean {
    const now = new Date();
    return this.db.run(
      `INSERT INTO daemon_lease (singleton, owner, expires_at) VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
       WHERE daemon_lease.expires_at < ? OR daemon_lease.owner = excluded.owner`,
      [owner, toIso(new Date(now.getTime() + leaseMs)), toIso(now)],
    ).changes > 0;
  }

  renew(owner: string, leaseMs: number): boolean {
    return this.db.run(
      "UPDATE daemon_lease SET expires_at = ? WHERE singleton = 1 AND owner = ?",
      [toIso(new Date(Date.now() + leaseMs)), owner],
    ).changes > 0;
  }

  release(owner: string): boolean {
    return this.db.run("DELETE FROM daemon_lease WHERE singleton = 1 AND owner = ?", [owner]).changes > 0;
  }
}
