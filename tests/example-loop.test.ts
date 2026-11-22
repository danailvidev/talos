import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";
import { TaskExecutor } from "../src/core/executor.ts";
import { createLogger } from "../src/logging/logger.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteTaskSink } from "../src/persistence/sqlite-task-sink.ts";
import { SqliteStateStore } from "../src/persistence/sqlite-state-store.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import { exampleScheduledTask } from "../src/tasks/example-loop.ts";

/**
 * Runs the example scheduled task against the real persistence stack, so
 * these double as integration tests for claims, watermarks and execution
 * history.
 */
function harness() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);

  const state = new SqliteStateStore(db);
  const sink = new SqliteTaskSink(db);

  return {
    db,
    state,
    sink,
    executor: new TaskExecutor({
      logger: createLogger({
        destination: new PassThrough(),
        pretty: false,
        level: "fatal",
      }),
      state,
      secrets: new EnvSecretStore({}),
      sink,
      defaultRetry: { attempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    }),
  };
}

describe("example scheduled task", () => {
  test("first run seeds the watermark and processes current items", async () => {
    const { executor, state, db } = harness();

    const record = await executor.run(exampleScheduledTask, {
      params: { itemCount: 3 },
      maxItemsPerRun: 10,
    });

    expect(record.status).toBe("success");
    expect(record.result?.itemsProcessed).toBe(3);
    expect(record.result?.details?.seeded).toBe(true);
    expect(await state.getWatermark("example-loop")).not.toBeNull();
    db.close();
  });

  test("first run ignores everything older than the seeded watermark", async () => {
    const { executor, db } = harness();

    // The install-day flood scenario: history exists, none of it should be acted
    // on.
    const record = await executor.run(exampleScheduledTask, {
      params: { itemCount: 20, itemsAreHistorical: true },
      maxItemsPerRun: 10,
    });

    expect(record.result?.itemsSeen).toBe(20);
    expect(record.result?.itemsProcessed).toBe(0);
    db.close();
  });

  test("a second run skips already-processed items", async () => {
    const { executor, db } = harness();
    const params = { itemCount: 3 };

    await executor.run(exampleScheduledTask, { params, maxItemsPerRun: 10 });
    const second = await executor.run(exampleScheduledTask, { params, maxItemsPerRun: 10 });

    expect(second.result?.itemsProcessed).toBe(0);
    expect(second.result?.itemsSkipped).toBe(3);
    db.close();
  });

  test("state survives a new TaskExecutor over the same database", async () => {
    const { executor, state, sink, db } = harness();
    const params = { itemCount: 2 };

    await executor.run(exampleScheduledTask, { params, maxItemsPerRun: 10 });

    // A fresh executor, as a later CLI invocation would build.
    const restarted = new TaskExecutor({
      logger: createLogger({
        destination: new PassThrough(),
        pretty: false,
        level: "fatal",
      }),
      state,
      secrets: new EnvSecretStore({}),
      sink,
    });

    const second = await restarted.run(exampleScheduledTask, { params, maxItemsPerRun: 10 });
    expect(second.result?.itemsSkipped).toBe(2);
    db.close();
  });

  test("maxItemsPerRun caps the batch, leaving the rest for the next run", async () => {
    const { executor, db } = harness();
    const params = { itemCount: 5 };

    const first = await executor.run(exampleScheduledTask, { params, maxItemsPerRun: 2 });
    expect(first.result?.itemsProcessed).toBe(2);
    expect(first.result?.itemsSeen).toBe(5);

    const second = await executor.run(exampleScheduledTask, { params, maxItemsPerRun: 2 });
    expect(second.result?.itemsSkipped).toBe(2);
    db.close();
  });

  test("retries a transient poll failure and still completes", async () => {
    const { executor, db } = harness();

    const record = await executor.run(exampleScheduledTask, {
      params: { itemCount: 1, failTimes: 2 },
      maxItemsPerRun: 10,
    });

    expect(record.status).toBe("success");
    expect(record.steps[0]?.stepId).toBe("poll-items");
    expect(record.steps[0]?.attempts).toBe(3);
    db.close();
  });

  test("cancellation holds the watermark so nothing is silently skipped", async () => {
    const { executor, state, db } = harness();

    // Seed a watermark first, so this run is not the seeding run.
    const seeded = new Date(Date.now() - 60_000);
    await state.setWatermark("example-loop", seeded);

    const controller = new AbortController();
    controller.abort();

    const record = await executor.run(exampleScheduledTask, {
      params: { itemCount: 3 },
      maxItemsPerRun: 10,
      signal: controller.signal,
    });
    expect(record.status).toBe("cancelled");

    // Unchanged: an aborted run does not advance the window.
    expect((await state.getWatermark("example-loop"))?.toISOString()).toBe(
      seeded.toISOString(),
    );
    db.close();
  });

  test("an empty poll is a success, not an error", async () => {
    const { executor, db } = harness();

    const record = await executor.run(exampleScheduledTask, {
      params: { itemCount: 0 },
      maxItemsPerRun: 10,
    });

    expect(record.status).toBe("success");
    expect(record.result?.itemsSeen).toBe(0);
    db.close();
  });

  test("a dry run claims what it reports, so a real run finds nothing new", async () => {
    const { executor, state, db } = harness();
    const params = { itemCount: 2 };

    const dry = await executor.run(exampleScheduledTask, {
      params,
      maxItemsPerRun: 10,
      dryRun: true,
    });
    expect(dry.dryRun).toBe(true);

    // Dry-run state is real state; `task reset` is the deliberate way back.
    // Asserted rather than glossed over so the behaviour is not a surprise.
    const real = await executor.run(exampleScheduledTask, { params, maxItemsPerRun: 10 });
    expect(real.result?.itemsSkipped).toBe(2);
    expect((await state.getEvent("example-loop", "item-1"))?.status).toBe("completed");
    db.close();
  });

  test("records execution history for each run", async () => {
    const { executor, sink, db } = harness();
    const params = { itemCount: 1 };

    await executor.run(exampleScheduledTask, { params, maxItemsPerRun: 10 });
    await executor.run(exampleScheduledTask, { params, maxItemsPerRun: 10 });

    const runs = sink.recentRuns("example-loop");
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === "success")).toBe(true);

    const steps = sink.steps(runs[1]!.executionId);
    expect(steps.map((s) => s.stepId)).toEqual(["poll-items", "notify:item-1"]);
    db.close();
  });
});
