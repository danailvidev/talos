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
      defaultRetry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    }),
  };
}

/**
 * The crash-recovery path, which is the reason claims exist at all. A process
 * that dies between performing a side effect and recording it must not cause that
 * side effect to happen twice.
 */
describe("crash recovery", () => {
  test("a stranded claim is skipped, not silently repeated", async () => {
    const { executor, state, db } = harness();

    // Window open, so items are in scope.
    await state.setWatermark("example-loop", new Date(Date.now() - 3_600_000));
    // What a process killed mid-item leaves behind.
    await state.claimEvent("example-loop", "item-1", "example-item");

    const record = await executor.run(exampleScheduledTask, {
      params: { itemCount: 3 },
      maxItemsPerRun: 10,
    });

    // The critical assertion: item-1 was not re-notified. A blind retry here is
    // how a duplicate Jira ticket gets filed.
    expect(record.result?.itemsProcessed).toBe(2);
    expect(record.result?.itemsSkipped).toBe(1);
    expect(record.steps.map((s) => s.stepId)).not.toContain("notify:item-1");
    db.close();
  });

  test("a stranded claim stays stranded until explicitly released", async () => {
    const { executor, state, db } = harness();
    await state.setWatermark("example-loop", new Date(Date.now() - 3_600_000));
    await state.claimEvent("example-loop", "item-1", "example-item");

    // Repeated runs must not erode the guarantee.
    for (let i = 0; i < 3; i++) {
      await executor.run(exampleScheduledTask, {
        params: { itemCount: 3 },
        maxItemsPerRun: 10,
      });
    }

    expect((await state.getEvent("example-loop", "item-1"))?.status).toBe("claimed");
    db.close();
  });

  test("releasing a stranded claim lets the next run retry it", async () => {
    const { executor, state, db } = harness();
    await state.setWatermark("example-loop", new Date(Date.now() - 3_600_000));
    await state.claimEvent("example-loop", "item-1", "example-item");

    await executor.run(exampleScheduledTask, {
      params: { itemCount: 3 },
      maxItemsPerRun: 10,
    });

    // What `talos doctor --release` does.
    await state.failEvent("example-loop", "item-1", "released after being stranded");

    const after = await executor.run(exampleScheduledTask, {
      params: { itemCount: 3 },
      maxItemsPerRun: 10,
    });

    expect(after.result?.itemsProcessed).toBe(1);
    expect((await state.getEvent("example-loop", "item-1"))?.status).toBe("completed");
    db.close();
  });

  test("findStaleClaims surfaces the stranded item for the operator", async () => {
    const { state, db } = harness();
    await state.claimEvent("example-loop", "item-1", "example-item");
    await state.claimEvent("example-loop", "item-2", "example-item");
    await state.completeEvent("example-loop", "item-2");

    const stale = await state.findStaleClaims("example-loop", new Date(Date.now() + 1000));

    expect(stale.map((e) => e.externalId)).toEqual(["item-1"]);
    expect(stale[0]?.attempts).toBe(1);
    db.close();
  });

  test("a fresh claim from a live run is not reported as stranded", async () => {
    const { state, db } = harness();
    await state.claimEvent("example-loop", "in-progress", "example-item");

    // A 30-minute cutoff must not flag a claim taken seconds ago, or doctor would
    // invite an operator to release work that is actively running.
    const cutoff = new Date(Date.now() - 30 * 60_000);
    expect(await state.findStaleClaims("example-loop", cutoff)).toEqual([]);
    db.close();
  });

  test("a run killed mid-flight leaves a visible open row", async () => {
    const { sink, db } = harness();

    // The executor writes this row before the task starts; a kill -9 leaves
    // it open.
    await sink.runStarted({
      executionId: "exec-killed",
      taskId: "example-loop",
      startedAt: new Date(),
      dryRun: false,
      params: {},
    });

    const orphans = sink.findOrphanedRuns();
    expect(orphans.map((r) => r.executionId)).toEqual(["exec-killed"]);
    db.close();
  });

  test("closing open runs does not touch event claims", async () => {
    const { state, sink, db } = harness();

    await sink.runStarted({
      executionId: "exec-killed",
      taskId: "example-loop",
      startedAt: new Date(),
      dryRun: false,
      params: {},
    });
    await state.claimEvent("example-loop", "item-1", "example-item");

    sink.closeOrphanedRuns("closed by doctor");

    // Tidying run history must not implicitly release claims — that decision
    // requires checking the target system.
    expect((await state.getEvent("example-loop", "item-1"))?.status).toBe("claimed");
    db.close();
  });
});
