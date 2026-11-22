import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import {
  resolveAllScheduledTasks,
  resolveScheduledTask,
} from "../src/config/resolve-schedule.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import type { Task } from "../src/core/task.ts";
import { SqliteConfigStore } from "../src/persistence/config-store.ts";
import { migrate } from "../src/persistence/migrations.ts";

const testTask: Task<{ itemCount: number }> = {
  id: "wf",
  kind: "task",
  name: "Test task",
  paramsSchema: z.object({ itemCount: z.number().int().default(3) }),
  async run() {
    return { itemsSeen: 0, itemsProcessed: 0, itemsSkipped: 0 };
  },
};

function harness() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, store: new SqliteConfigStore(db) };
}

describe("resolveScheduledTask", () => {
  test("defaults to disabled/manual when there is no stored row", () => {
    const resolved = resolveScheduledTask(testTask, null);
    expect(resolved.enabled).toEqual({ value: false, origin: "default" });
    expect(resolved.trigger).toEqual({ value: { type: "manual" }, origin: "default" });
    expect(resolved.maxItemsPerRun).toBe(10);
    // Not defaulted at resolve time when the schema cannot parse `{}` (required
    // fields with no default). A schema that *can* parse empty input fills in
    // its defaults — see gitlab-ci-failure's gitlab/jira targets.
    expect(resolved.params).toEqual({ itemCount: 3 });
  });

  test("a defaultTrigger replaces leftover enabled+manual so the scheduler can fire", () => {
    const loop: Task<{}> = {
      ...testTask,
      id: "gitlab-review-requested",
      defaultTrigger: { type: "cron", expression: "*/2 * * * *" },
    };
    const { store, db } = harness();
    store.setConfig("gitlab-review-requested", { enabled: true, trigger: { type: "manual" } });

    const resolved = resolveScheduledTask(loop, store.get("gitlab-review-requested"));
    expect(resolved.enabled).toEqual({ value: true, origin: "db" });
    expect(resolved.trigger).toEqual({
      value: { type: "cron", expression: "*/2 * * * *" },
      origin: "default",
    });
    db.close();
  });

  test("uses the stored row when present", () => {
    const { store, db } = harness();
    store.setConfig("wf", {
      enabled: true,
      trigger: { type: "cron", expression: "*/5 * * * *" },
      maxItemsPerRun: 20,
      params: { itemCount: 7 },
    });

    const resolved = resolveScheduledTask(testTask, store.get("wf"));
    expect(resolved.enabled).toEqual({ value: true, origin: "db" });
    expect(resolved.trigger).toEqual({
      value: { type: "cron", expression: "*/5 * * * *" },
      origin: "db",
    });
    expect(resolved.maxItemsPerRun).toBe(20);
    expect(resolved.params).toEqual({ itemCount: 7 });
    db.close();
  });

});

describe("resolveAllScheduledTasks", () => {
  test("resolves every registered task, defaulting the unconfigured ones", () => {
    const { store, db } = harness();
    store.setConfig("wf", { enabled: true });

    const registry = new TaskRegistry().register(testTask);
    const resolved = resolveAllScheduledTasks(registry, store);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ id: "wf", enabled: { value: true, origin: "db" } });
    db.close();
  });
});
