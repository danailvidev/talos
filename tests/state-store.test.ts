import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/persistence/migrations.ts";
import { MemoryStateStore, type StateStore } from "../src/persistence/state-store.ts";
import { SqliteStateStore } from "../src/persistence/sqlite-state-store.ts";

/**
 * Contract suite. Every StateStore implementation is held to identical
 * behaviour, so the SQLite store's atomicity claim is proven rather than
 * assumed — and MemoryStateStore cannot quietly drift from it.
 */
const IMPLEMENTATIONS: Array<{
  name: string;
  create: () => { store: StateStore; close: () => void };
}> = [
  {
    name: "MemoryStateStore",
    create: () => ({ store: new MemoryStateStore(), close: () => {} }),
  },
  {
    name: "SqliteStateStore",
    create: () => {
      const db = new Database(":memory:");
      db.run("PRAGMA foreign_keys = ON");
      migrate(db);
      return { store: new SqliteStateStore(db), close: () => db.close() };
    },
  },
];

for (const impl of IMPLEMENTATIONS) {
  describe(`${impl.name} — claims`, () => {
    let harness: { store: StateStore; close: () => void };
    const setup = () => {
      harness = impl.create();
      return harness.store;
    };
    afterEach(() => harness?.close());

    test("the first claim succeeds", async () => {
      const store = setup();
      expect(await store.claimEvent("wf", "id-1", "t")).toBe(true);
    });

    test("a second claim on a held event is refused", async () => {
      const store = setup();
      await store.claimEvent("wf", "id-1", "t");
      expect(await store.claimEvent("wf", "id-1", "t")).toBe(false);
    });

    test("a completed event is never re-claimable — this is the duplicate guard", async () => {
      const store = setup();
      await store.claimEvent("wf", "id-1", "t");
      await store.completeEvent("wf", "id-1");
      expect(await store.claimEvent("wf", "id-1", "t")).toBe(false);
    });

    test("a released claim is re-claimable, so a transient failure can retry", async () => {
      const store = setup();
      await store.claimEvent("wf", "id-1", "t");
      await store.failEvent("wf", "id-1", "network died");
      expect(await store.claimEvent("wf", "id-1", "t")).toBe(true);
    });

    test("attempts accumulate across re-claims", async () => {
      const store = setup();
      await store.claimEvent("wf", "id-1", "t");
      await store.failEvent("wf", "id-1", "err");
      await store.claimEvent("wf", "id-1", "t");

      expect((await store.getEvent("wf", "id-1"))?.attempts).toBe(2);
    });

    test("claims are scoped per task", async () => {
      const store = setup();
      expect(await store.claimEvent("wf-a", "shared", "t")).toBe(true);
      expect(await store.claimEvent("wf-b", "shared", "t")).toBe(true);
    });

    test("completing clears a previous error and stores metadata", async () => {
      const store = setup();
      await store.claimEvent("wf", "id-1", "t");
      await store.failEvent("wf", "id-1", "transient");
      await store.claimEvent("wf", "id-1", "t");
      await store.completeEvent("wf", "id-1", { ticket: "DEV-9" });

      const event = await store.getEvent("wf", "id-1");
      expect(event?.status).toBe("completed");
      expect(event?.error).toBeUndefined();
      expect(event?.metadata).toEqual({ ticket: "DEV-9" });
    });

    test("getEvent returns null for an unknown event", async () => {
      const store = setup();
      expect(await store.getEvent("wf", "never-seen")).toBeNull();
    });

    test("records the event type given at claim time", async () => {
      const store = setup();
      await store.claimEvent("wf", "id-1", "pipeline-failure");
      expect((await store.getEvent("wf", "id-1"))?.eventType).toBe("pipeline-failure");
    });
  });

  describe(`${impl.name} — stale claims`, () => {
    let harness: { store: StateStore; close: () => void };
    const setup = () => {
      harness = impl.create();
      return harness.store;
    };
    afterEach(() => harness?.close());

    test("finds claims older than the cutoff and ignores completed ones", async () => {
      const store = setup();
      await store.claimEvent("wf", "stuck", "t");
      await store.claimEvent("wf", "done", "t");
      await store.completeEvent("wf", "done");

      const stale = await store.findStaleClaims("wf", new Date(Date.now() + 60_000));
      expect(stale.map((e) => e.externalId)).toEqual(["stuck"]);
    });

    test("a fresh claim is not stale", async () => {
      const store = setup();
      await store.claimEvent("wf", "fresh", "t");
      expect(await store.findStaleClaims("wf", new Date(Date.now() - 60_000))).toEqual([]);
    });

    test("a released claim is not stale — it is available, not stranded", async () => {
      const store = setup();
      await store.claimEvent("wf", "released", "t");
      await store.failEvent("wf", "released", "err");

      const stale = await store.findStaleClaims("wf", new Date(Date.now() + 60_000));
      expect(stale).toEqual([]);
    });

    test("stale claims are scoped per task", async () => {
      const store = setup();
      await store.claimEvent("wf-a", "x", "t");
      const stale = await store.findStaleClaims("wf-b", new Date(Date.now() + 60_000));
      expect(stale).toEqual([]);
    });
  });

  describe(`${impl.name} — watermarks`, () => {
    let harness: { store: StateStore; close: () => void };
    const setup = () => {
      harness = impl.create();
      return harness.store;
    };
    afterEach(() => harness?.close());

    test("starts null so the first run knows to seed itself", async () => {
      const store = setup();
      expect(await store.getWatermark("wf")).toBeNull();
    });

    test("round-trips and is scoped per task", async () => {
      const store = setup();
      const at = new Date("2026-08-01T10:00:00.000Z");
      await store.setWatermark("wf-a", at);

      expect((await store.getWatermark("wf-a"))?.toISOString()).toBe(at.toISOString());
      expect(await store.getWatermark("wf-b")).toBeNull();
    });

    test("overwrites an existing watermark", async () => {
      const store = setup();
      await store.setWatermark("wf", new Date("2026-08-01T00:00:00.000Z"));
      const later = new Date("2026-08-15T00:00:00.000Z");
      await store.setWatermark("wf", later);

      expect((await store.getWatermark("wf"))?.toISOString()).toBe(later.toISOString());
    });
  });
}

/* ------------------------------------------------------------------------- */
/* SQLite-specific behaviour                                                 */
/* ------------------------------------------------------------------------- */

describe("SqliteStateStore specifics", () => {
  function harness() {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    migrate(db);
    return { db, store: new SqliteStateStore(db) };
  }

  test("state survives a reconnect to the same file", async () => {
    const path = `/tmp/talos-persist-${Bun.hash(String(process.pid)).toString(36)}.db`;
    try {
      const first = new Database(path, { create: true });
      migrate(first);
      await new SqliteStateStore(first).claimEvent("wf", "id-1", "t");
      await new SqliteStateStore(first).completeEvent("wf", "id-1", { n: 1 });
      first.close();

      // A fresh handle, as a later process would open it.
      const second = new Database(path);
      const store = new SqliteStateStore(second);

      expect(await store.claimEvent("wf", "id-1", "t")).toBe(false);
      expect((await store.getEvent("wf", "id-1"))?.metadata).toEqual({ n: 1 });
      second.close();
    } finally {
      await Bun.file(path).delete().catch(() => {});
    }
  });

  test("the unique index rejects a duplicate row, backing the claim guarantee", () => {
    const { db } = harness();
    const insert = () =>
      db.run(
        `INSERT INTO processed_events
           (task_id, external_id, event_type, status, claimed_at)
         VALUES ('wf', 'dup', 't', 'claimed', '2026-01-01T00:00:00.000Z')`,
      );

    insert();
    expect(insert).toThrow();
  });

  test("a late failure report cannot re-open a completed event", async () => {
    const { store } = harness();
    await store.claimEvent("wf", "id-1", "t");
    await store.completeEvent("wf", "id-1");

    // A slow error path reporting after the completion must not undo it, or the
    // next run would repeat the side effect.
    await store.failEvent("wf", "id-1", "late arrival");

    expect((await store.getEvent("wf", "id-1"))?.status).toBe("completed");
    expect(await store.claimEvent("wf", "id-1", "t")).toBe(false);
  });

  test("only one of many concurrent claims wins", async () => {
    const { store } = harness();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.claimEvent("wf", "contended", "t")),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("countByStatus reports every status, including zeroes", async () => {
    const { store } = harness();
    await store.claimEvent("wf", "a", "t");
    await store.completeEvent("wf", "a");
    await store.claimEvent("wf", "b", "t");

    expect(await store.countByStatus("wf")).toEqual({
      completed: 1,
      claimed: 1,
      failed: 0,
    });
  });

  test("recentEvents returns newest first", async () => {
    const { store } = harness();
    for (const id of ["a", "b", "c"]) await store.claimEvent("wf", id, "t");

    expect((await store.recentEvents("wf")).map((e) => e.externalId)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  test("a corrupt watermark reads as unset, so the task reseeds", async () => {
    const { db, store } = harness();
    db.run(
      `INSERT INTO task_state (task_id, key, value, updated_at)
       VALUES ('wf', 'watermark', 'not-a-date', '2026-01-01T00:00:00.000Z')`,
    );

    // Returning an Invalid Date here would make the task poll from the epoch
    // and fetch everything.
    expect(await store.getWatermark("wf")).toBeNull();
  });

  test("unserializable metadata does not fail a completed event", async () => {
    const { store } = harness();
    await store.claimEvent("wf", "id-1", "t");

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    // The side effect already happened; losing an audit detail beats throwing.
    await store.completeEvent("wf", "id-1", circular);
    expect((await store.getEvent("wf", "id-1"))?.status).toBe("completed");
  });
});
