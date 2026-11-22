import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteGeneralConfigStore } from "../src/persistence/general-config-store.ts";
import { migrate } from "../src/persistence/migrations.ts";

function harness() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, store: new SqliteGeneralConfigStore(db) };
}

describe("SqliteGeneralConfigStore", () => {
  test("returns the empty defaults before anything is set", () => {
    const { store, db } = harness();
    expect(store.get()).toEqual({
      logLevel: null,
      timezone: null,
      llmProvider: null,
      llmModel: null,
      llmEffort: null,
      llmMaxTokens: null,
    });
    db.close();
  });

  test("setConfig merges over the existing row rather than replacing it", () => {
    const { store, db } = harness();
    store.setConfig({ logLevel: "debug" });
    store.setConfig({ timezone: "Europe/Berlin" });

    expect(store.get()).toEqual({
      logLevel: "debug",
      timezone: "Europe/Berlin",
      llmProvider: null,
      llmModel: null,
      llmEffort: null,
      llmMaxTokens: null,
    });
    db.close();
  });

  test("setting a field to null clears that override", () => {
    const { store, db } = harness();
    store.setConfig({ logLevel: "debug", timezone: "Europe/Berlin" });
    store.setConfig({ logLevel: null });

    expect(store.get()).toEqual({
      logLevel: null,
      timezone: "Europe/Berlin",
      llmProvider: null,
      llmModel: null,
      llmEffort: null,
      llmMaxTokens: null,
    });
    db.close();
  });

  test("clear removes the row entirely, reverting every field", () => {
    const { store, db } = harness();
    store.setConfig({ logLevel: "debug", llmProvider: "openai" });
    store.clear();

    expect(store.get()).toEqual({
      logLevel: null,
      timezone: null,
      llmProvider: null,
      llmModel: null,
      llmEffort: null,
      llmMaxTokens: null,
    });
    db.close();
  });
});
