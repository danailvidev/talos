import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteConfigStore } from "../src/persistence/config-store.ts";
import { migrate } from "../src/persistence/migrations.ts";

function harness() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, store: new SqliteConfigStore(db) };
}

describe("SqliteConfigStore", () => {
  test("returns null for an untouched task", () => {
    const { store, db } = harness();
    expect(store.get("t1")).toBeNull();
    expect(store.all().size).toBe(0);
    db.close();
  });

  test("setConfig on a fresh task fills in defaults for everything else", () => {
    const { store, db } = harness();
    store.setConfig("t1", { enabled: true });

    expect(store.get("t1")).toEqual({
      enabled: true,
      trigger: { type: "manual" },
      maxItemsPerRun: 10,
      params: {},
    });
    db.close();
  });

  test("a later setConfig call merges over the existing row rather than replacing it", () => {
    const { store, db } = harness();
    store.setConfig("t1", { enabled: true, maxItemsPerRun: 5 });
    store.setConfig("t1", { trigger: { type: "cron", expression: "*/5 * * * *" } });

    expect(store.get("t1")).toEqual({
      enabled: true,
      trigger: { type: "cron", expression: "*/5 * * * *" },
      maxItemsPerRun: 5,
      params: {},
    });
    db.close();
  });

  test("round-trips a cron trigger with a timezone", () => {
    const { store, db } = harness();
    store.setConfig("t1", {
      trigger: { type: "cron", expression: "0 9 * * 1", timezone: "Europe/Berlin" },
    });

    expect(store.get("t1")?.trigger).toEqual({
      type: "cron",
      expression: "0 9 * * 1",
      timezone: "Europe/Berlin",
    });
    db.close();
  });

  test("round-trips a cron first-run and a one-shot trigger", () => {
    const { store, db } = harness();
    store.setConfig("t1", {
      trigger: {
        type: "cron",
        expression: "30 14 * * *",
        timezone: "Europe/Sofia",
        startAt: "2026-08-26T11:30:00.000Z",
      },
    });
    expect(store.get("t1")?.trigger).toEqual({
      type: "cron",
      expression: "30 14 * * *",
      timezone: "Europe/Sofia",
      startAt: "2026-08-26T11:30:00.000Z",
    });

    store.setConfig("t1", {
      trigger: { type: "once", at: "2026-08-26T11:30:00.000Z", timezone: "Europe/Sofia" },
    });
    expect(store.get("t1")?.trigger).toEqual({
      type: "once",
      at: "2026-08-26T11:30:00.000Z",
      timezone: "Europe/Sofia",
    });
    db.close();
  });

  test("round-trips a task-specific params blob", () => {
    const { store, db } = harness();
    store.setConfig("t1", { params: { itemCount: 5, nested: { a: 1 } } });

    expect(store.get("t1")?.params).toEqual({ itemCount: 5, nested: { a: 1 } });
    db.close();
  });

  test("clear removes the row entirely, reverting to defaults on next get", () => {
    const { store, db } = harness();
    store.setConfig("t1", { enabled: true });
    store.clear("t1");

    expect(store.get("t1")).toBeNull();
    db.close();
  });

  test("rows are scoped per task", () => {
    const { store, db } = harness();
    store.setConfig("a", { enabled: true });
    store.setConfig("b", { enabled: false });

    const all = store.all();
    expect(all.get("a")?.enabled).toBe(true);
    expect(all.get("b")?.enabled).toBe(false);
    db.close();
  });
});
