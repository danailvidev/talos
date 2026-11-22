import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { importLegacyWorkflows } from "../src/config/import-legacy-workflows.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import type { Task } from "../src/core/task.ts";
import { createLogger } from "../src/logging/logger.ts";
import { SqliteConfigStore } from "../src/persistence/config-store.ts";
import { migrate } from "../src/persistence/migrations.ts";

const task: Task<unknown> = {
  id: "loop",
  kind: "loop",
  name: "Loop",
  paramsSchema: z.object({
    gitlab: z.object({
      projectId: z.string(),
      maxTraceBytes: z.number().optional(),
    }),
    anyStatus: z.boolean().default(false),
  }),
  async run() {
    return { itemsSeen: 0, itemsProcessed: 0, itemsSkipped: 0 };
  },
};

function harness(registered = true) {
  const db = new Database(":memory:");
  migrate(db);
  const schedules = new SqliteConfigStore(db);
  const registry = new TaskRegistry();
  if (registered) registry.register(task);
  const logger = createLogger({
    destination: new PassThrough(),
    pretty: false,
    level: "fatal",
  });
  return { db, schedules, registry, logger };
}

describe("importLegacyWorkflows", () => {
  test("imports a fresh legacy schedule and params into SQLite", () => {
    const h = harness();
    const result = importLegacyWorkflows({
      ...h,
      workflows: {
        loop: {
          enabled: true,
          schedule: "*/5 * * * *",
          maxItemsPerRun: 7,
          gitlab: { projectId: "group/project" },
          anyStatus: true,
        },
      },
    });

    expect(result.imported).toEqual(["loop"]);
    expect(h.schedules.get("loop")).toEqual({
      enabled: true,
      trigger: { type: "cron", expression: "*/5 * * * *" },
      maxItemsPerRun: 7,
      params: {
        gitlab: { projectId: "group/project" },
        anyStatus: true,
      },
    });
    h.db.close();
  });

  test("preserves an existing row and fills only missing nested params", () => {
    const h = harness();
    h.schedules.setConfig("loop", {
      enabled: false,
      trigger: { type: "cron", expression: "0 9 * * *" },
      maxItemsPerRun: 3,
      params: {
        gitlab: { projectId: "db/project" },
        anyStatus: false,
      },
    });

    importLegacyWorkflows({
      ...h,
      workflows: {
        loop: {
          enabled: true,
          schedule: "*/5 * * * *",
          maxItemsPerRun: 20,
          gitlab: {
            projectId: "yaml/project",
            maxTraceBytes: 262144,
          },
          anyStatus: true,
        },
      },
    });

    expect(h.schedules.get("loop")).toEqual({
      enabled: false,
      trigger: { type: "cron", expression: "0 9 * * *" },
      maxItemsPerRun: 3,
      params: {
        gitlab: {
          projectId: "db/project",
          maxTraceBytes: 262144,
        },
        anyStatus: false,
      },
    });
    h.db.close();
  });

  test("imports a task only once", () => {
    const h = harness();
    importLegacyWorkflows({
      ...h,
      workflows: { loop: { enabled: true, schedule: "*/5 * * * *" } },
    });
    h.schedules.setConfig("loop", {
      enabled: false,
      trigger: { type: "cron", expression: "0 12 * * *" },
    });

    const second = importLegacyWorkflows({
      ...h,
      workflows: { loop: { enabled: true, schedule: "*/2 * * * *" } },
    });

    expect(second.imported).toEqual([]);
    expect(second.skipped).toEqual(["loop"]);
    expect(h.schedules.get("loop")).toMatchObject({
      enabled: false,
      trigger: { type: "cron", expression: "0 12 * * *" },
    });
    h.db.close();
  });

  test("does not mark invalid or unknown workflows, allowing a later retry", () => {
    const h = harness(false);
    const unknown = importLegacyWorkflows({
      ...h,
      workflows: { loop: { schedule: "not cron" } },
    });
    expect(unknown.skipped).toEqual(["loop"]);

    h.registry.register(task);
    const invalid = importLegacyWorkflows({
      ...h,
      workflows: { loop: { schedule: "not cron" } },
    });
    expect(invalid.invalid).toEqual(["loop"]);
    expect(h.schedules.get("loop")).toBeNull();

    const retried = importLegacyWorkflows({
      ...h,
      workflows: { loop: { schedule: "0 7 * * *" } },
    });
    expect(retried.imported).toEqual(["loop"]);
    expect(h.schedules.get("loop")?.trigger).toEqual({
      type: "cron",
      expression: "0 7 * * *",
    });
    h.db.close();
  });
});
