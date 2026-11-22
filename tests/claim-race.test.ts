import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteStateStore } from "../src/persistence/sqlite-state-store.ts";

const WORKER = join(import.meta.dir, "fixtures", "claim-race-worker.ts");

/**
 * The interpreter running this suite, rather than the string "bun". Bun is not
 * necessarily on PATH — spawning by name fails outright in that case, which
 * would read as a broken atomicity guarantee rather than a missing binary.
 */
const BUN = process.execPath;

const paths: string[] = [];

function tempDb(name: string): string {
  const path = join(tmpdir(), `talos-race-${name}-${crypto.randomUUID()}.db`);
  paths.push(path);

  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  migrate(db);
  db.close();

  return path;
}

afterEach(async () => {
  // WAL leaves -wal and -shm siblings behind.
  await Promise.all(
    paths.splice(0).flatMap((p) =>
      [p, `${p}-wal`, `${p}-shm`].map((f) => rm(f, { force: true })),
    ),
  );
});

/**
 * The whole idempotency design rests on claimEvent being atomic under real
 * contention. bun:sqlite is synchronous, so a single-process Promise.all only
 * proves the SQL is correct, not that it holds when two schedulers overlap.
 * These tests use separate processes against a shared file.
 */
describe("claim atomicity across processes", () => {
  test("exactly one of eight processes wins the same event", async () => {
    const path = tempDb("eight");
    const startAt = Date.now() + 400;

    const workers = Array.from({ length: 8 }, () =>
      Bun.spawn(
        [BUN, "run", WORKER, path, "wf", "contended", String(startAt)],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );

    const outcomes = await Promise.all(
      workers.map(async (proc) => {
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (code !== 0) throw new Error(`worker failed (${code}): ${err}`);
        return out.trim();
      }),
    );

    expect(outcomes.filter((o) => o === "won")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "lost")).toHaveLength(7);
  }, 30_000);

  test("the surviving row records a single claim, not eight", async () => {
    const path = tempDb("single-row");
    const startAt = Date.now() + 400;

    const workers = Array.from({ length: 4 }, () =>
      Bun.spawn([BUN, "run", WORKER, path, "wf", "once", String(startAt)], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    await Promise.all(workers.map((p) => p.exited));

    const db = new Database(path);
    const rows = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM processed_events")
      .get();
    expect(rows?.n).toBe(1);

    // The losers must not have inflated the attempt count: they never held the
    // claim, so retry accounting stays honest.
    const event = await new SqliteStateStore(db).getEvent("wf", "once");
    expect(event?.attempts).toBe(1);
    expect(event?.status).toBe("claimed");
    db.close();
  }, 30_000);

  test("a crashed holder's claim is visible as stale, not lost", async () => {
    const path = tempDb("stale");

    // Simulates a process that claimed and died before completing.
    const claimer = Bun.spawn(
      [BUN, "run", WORKER, path, "wf", "abandoned", String(Date.now())],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect((await new Response(claimer.stdout).text()).trim()).toBe("won");
    await claimer.exited;

    const db = new Database(path);
    const store = new SqliteStateStore(db);

    // Still held, so nobody re-runs it blindly.
    expect(await store.claimEvent("wf", "abandoned", "race")).toBe(false);

    // But visible for reconciliation.
    const stale = await store.findStaleClaims("wf", new Date(Date.now() + 60_000));
    expect(stale.map((e) => e.externalId)).toEqual(["abandoned"]);
    db.close();
  }, 30_000);
});
