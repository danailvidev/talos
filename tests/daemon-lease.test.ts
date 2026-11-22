import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteDaemonLease } from "../src/persistence/daemon-lease.ts";
import { migrate } from "../src/persistence/migrations.ts";

describe("daemon ownership", () => {
  test("rejects a second live owner and permits takeover after expiry", () => {
    const db = new Database(":memory:");
    migrate(db);
    const lease = new SqliteDaemonLease(db);
    expect(lease.acquire("a", 30_000)).toBe(true);
    expect(lease.acquire("b", 30_000)).toBe(false);
    db.run("UPDATE daemon_lease SET expires_at = ?", [new Date(0).toISOString()]);
    expect(lease.acquire("b", 30_000)).toBe(true);
    expect(lease.renew("a", 30_000)).toBe(false);
    expect(lease.release("b")).toBe(true);
    db.close();
  });
});
