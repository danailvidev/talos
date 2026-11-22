import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import type { AgentUsageEvent } from "../src/application/ports.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteAgentUsageStore } from "../src/persistence/agent-usage-store.ts";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, store: new SqliteAgentUsageStore(db) };
}

function event(
  overrides: Partial<Omit<AgentUsageEvent, "id">> = {},
): Omit<AgentUsageEvent, "id"> {
  return {
    userId: "user-a",
    accountId: "account-a",
    accountLabel: "Work Claude",
    optionId: "claude:key-oauth",
    authSource: "connected",
    provider: "claude",
    model: "claude-sonnet-4-5",
    source: "task",
    executionId: "execution-1",
    status: "success",
    startedAt: new Date("2026-10-20T10:00:00.000Z"),
    finishedAt: new Date("2026-10-20T10:00:02.000Z"),
    tokens: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 40,
    },
    ...overrides,
  };
}

describe("SqliteAgentUsageStore", () => {
  test("isolates users and aggregates tokens by day, account, model, and source", () => {
    const { store } = setup();
    store.record(event());
    store.record(event({
      userId: "user-b",
      accountId: undefined,
      accountLabel: "Host Claude runtime",
      optionId: undefined,
      authSource: "host",
      source: "assistant",
    }));

    const report = store.report("user-a", {
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-11-01T00:00:00.000Z"),
      limit: 25,
      offset: 0,
    });

    expect(report.eventCount).toBe(1);
    expect(report.totals.tokens).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 40,
    });
    expect(report.daily).toEqual([{
      date: "2026-10-20",
      invocations: 1,
      tokens: report.totals.tokens,
    }]);
    expect(report.accounts[0]).toMatchObject({ key: "account-a", label: "Work Claude" });
    expect(report.models[0]).toMatchObject({ key: "claude-sonnet-4-5" });
    expect(report.sources[0]).toMatchObject({ key: "task", label: "Agent tasks" });

    const global = store.report(undefined, {
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-11-01T00:00:00.000Z"),
      limit: 25,
      offset: 0,
    });
    expect(global.eventCount).toBe(2);
  });

  test("filters host fallback and source, paginates, and distinguishes unknown usage", () => {
    const { store } = setup();
    store.record(event());
    store.record(event({
      accountId: undefined,
      accountLabel: "Host Claude runtime",
      optionId: undefined,
      authSource: "host",
      source: "assistant",
      tokens: undefined,
      startedAt: new Date("2026-10-21T10:00:00.000Z"),
      finishedAt: new Date("2026-10-21T10:00:01.000Z"),
    }));

    const report = store.report("user-a", {
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-11-01T00:00:00.000Z"),
      account: "host",
      source: "assistant",
      limit: 1,
      offset: 0,
    });

    expect(report.eventCount).toBe(1);
    expect(report.totals).toMatchObject({ invocations: 1, knownUsageInvocations: 0 });
    expect(report.events[0]).toMatchObject({
      authSource: "host",
      accountLabel: "Host Claude runtime",
      source: "assistant",
    });
    expect(report.events[0]?.tokens).toBeUndefined();
  });

  test("keeps usage after a connected account is deleted", () => {
    const { db, store } = setup();
    db.run(
      `INSERT INTO agent_accounts
        (id, user_id, provider, label, method, option_id, created_at, updated_at, use_for_runs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        "account-a",
        "user-a",
        "claude",
        "Work Claude",
        "cli",
        "claude:cli",
        "2026-10-01T00:00:00.000Z",
        "2026-10-01T00:00:00.000Z",
      ],
    );
    store.record(event());
    db.run("DELETE FROM agent_accounts WHERE id = ?", ["account-a"]);

    const report = store.report("user-a", {
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-11-01T00:00:00.000Z"),
      limit: 25,
      offset: 0,
    });
    expect(report.events[0]).toMatchObject({
      accountId: "account-a",
      accountLabel: "Work Claude",
    });
  });
});
