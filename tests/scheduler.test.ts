import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { z } from "zod";
import type { ScheduledTask } from "../src/config/resolve-schedule.ts";
import type { TaskExecutor } from "../src/core/executor.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { startScheduler, type SchedulerCronFactory } from "../src/core/scheduler.ts";
import type { Task } from "../src/core/task.ts";
import { createLogger } from "../src/logging/logger.ts";

const task: Task<unknown> = {
  id: "loop",
  kind: "loop",
  name: "Loop",
  paramsSchema: z.object({}),
  async run() {
    return { itemsSeen: 0, itemsProcessed: 0, itemsSkipped: 0 };
  },
};

function scheduled(expression: string): ScheduledTask {
  return {
    id: task.id,
    enabled: { value: true, origin: "db" },
    trigger: {
      value: { type: "cron", expression },
      origin: "db",
    },
    maxItemsPerRun: 10,
    params: {},
  };
}

describe("startScheduler", () => {
  test("stops and replaces a cron job after a stored schedule changes", async () => {
    let current = scheduled("*/5 * * * *");
    const created: string[] = [];
    const stopped: string[] = [];
    const createCron: SchedulerCronFactory = (pattern) => {
      const key = String(pattern);
      created.push(key);
      return {
        stop() {
          stopped.push(key);
        },
      };
    };

    const scheduler = startScheduler(
      {
        logger: createLogger({
          destination: new PassThrough(),
          pretty: false,
          level: "fatal",
        }),
        executor: {} as TaskExecutor,
        taskRegistry: new TaskRegistry().register(task),
        refresh() {},
        scheduledTasks: () => [current],
        scheduledTask: () => current,
      },
      5,
      createCron,
    );

    expect(created).toEqual(["*/5 * * * *"]);
    current = scheduled("0 9 * * *");
    await Bun.sleep(20);

    expect(created).toEqual(["*/5 * * * *", "0 9 * * *"]);
    expect(stopped).toEqual(["*/5 * * * *"]);

    scheduler.stop();
    expect(stopped).toEqual(["*/5 * * * *", "0 9 * * *"]);
  });
});
