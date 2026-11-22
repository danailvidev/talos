import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { TaskExecutor } from "../src/core/executor.ts";
import { TransientError } from "../src/core/errors.ts";
import { EMPTY_RESULT, type Task } from "../src/core/task.ts";
import { createLogger } from "../src/logging/logger.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteTaskSink } from "../src/persistence/sqlite-task-sink.ts";
import { SqliteStateStore } from "../src/persistence/sqlite-state-store.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";

function harness() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);

  const sink = new SqliteTaskSink(db);
  let n = 0;

  return {
    db,
    sink,
    executor: new TaskExecutor({
      logger: createLogger({
        destination: new PassThrough(),
        pretty: false,
        level: "fatal",
      }),
      state: new SqliteStateStore(db),
      secrets: new EnvSecretStore({}),
      sink,
      generateExecutionId: () => `exec-${++n}`,
      defaultRetry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    }),
  };
}

const noParams = z.object({}).loose();

function task(id: string, run: Task<{}>["run"]): Task<{}> {
  return { id, name: id, kind: "task", paramsSchema: noParams, run };
}

describe("SqliteTaskSink", () => {
  test("file-backed completion waits for the dedicated log writer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "talos-log-worker-test-"));
    const path = join(dir, "state.sqlite");
    const { db } = openDatabase(path);
    const sink = new SqliteTaskSink(db, undefined, undefined, path);
    try {
      const startedAt = new Date();
      await sink.runStarted({ executionId: "worker-run", taskId: "worker", startedAt, dryRun: false, params: {} });
      sink.appendLog("worker-run", { ts: startedAt, level: "info", message: "from worker" });
      await sink.runFinished({
        executionId: "worker-run",
        taskId: "worker",
        startedAt,
        finishedAt: new Date(),
        durationMs: 1,
        status: "success",
        dryRun: false,
        params: {},
        result: EMPTY_RESULT,
        steps: [],
      });
      expect(sink.logs("worker-run").map((line) => line.message)).toContain("from worker");
      sink.close();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("records a successful run with its result counts", async () => {
    const { executor, sink, db } = harness();

    await executor.run(
      task("ok", async () => ({
        itemsSeen: 5,
        itemsProcessed: 3,
        itemsSkipped: 2,
      })),
    );

    const run = sink.lastRun("ok");
    expect(run?.status).toBe("success");
    expect(run?.itemsSeen).toBe(5);
    expect(run?.itemsProcessed).toBe(3);
    expect(run?.itemsSkipped).toBe(2);
    expect(run?.durationMs).toBeGreaterThanOrEqual(0);
    expect(run?.finishedAt).toBeDefined();
    db.close();
  });

  test("persists structured execution resources with provenance", async () => {
    const { executor, sink, db } = harness();
    const record = await executor.run(
      task("resource-task", async () => ({
        itemsSeen: 1,
        itemsProcessed: 1,
        itemsSkipped: 0,
        details: { issueKey: "AUTO-42", mrUrl: "https://gitlab.test/a/b/-/merge_requests/7" },
      })),
    );

    expect(sink.resourcesForRuns([record.executionId]).get(record.executionId)).toEqual([
      { kind: "merge-request", key: "https://gitlab.test/a/b/-/merge_requests/7", provenance: "handler-details" },
      { kind: "ticket", key: "AUTO-42", provenance: "handler-details" },
    ]);
    db.close();
  });

  test("records a failed run with its error", async () => {
    const { executor, sink, db } = harness();

    await expect(
      executor.run(
        task("bad", async () => {
          throw new Error("exploded");
        }),
      ),
    ).rejects.toThrow();

    const run = sink.lastRun("bad");
    expect(run?.status).toBe("failure");
    expect(run?.error).toContain("exploded");
    db.close();
  });

  test("records the params a run was invoked with", async () => {
    const { executor, sink, db } = harness();
    const withParam: Task<{ n: number }> = {
      id: "params",
      kind: "task",
      name: "params",
      paramsSchema: z.object({ n: z.number().default(7) }),
      async run() {
        return EMPTY_RESULT;
      },
    };

    await executor.run(withParam, { params: { n: 3 } });
    expect(sink.lastRun("params")?.params).toEqual({ n: 3 });
    db.close();
  });

  test("records steps in order with attempt counts", async () => {
    const { executor, sink, db } = harness();
    let calls = 0;

    await executor.run(
      task("steps", async (ctx) => {
        await ctx.step("first", async () => {});
        await ctx.step("flaky", async () => {
          if (++calls === 1) throw new TransientError("hiccup");
        });
        return EMPTY_RESULT;
      }),
    );

    const steps = sink.steps("exec-1");
    expect(steps.map((s) => s.stepId)).toEqual(["first", "flaky"]);
    expect(steps[1]?.attempts).toBe(2);
    db.close();
  });

  test("marks a dry run as such, so history distinguishes it from a real one", async () => {
    const { executor, sink, db } = harness();
    await executor.run(task("dry", async () => EMPTY_RESULT), { dryRun: true });

    expect(sink.lastRun("dry")?.dryRun).toBe(true);
    db.close();
  });

  test("recentRuns returns newest first and honours the limit", async () => {
    const { executor, sink, db } = harness();
    const t = task("many", async () => EMPTY_RESULT);

    for (let i = 0; i < 5; i++) await executor.run(t);

    const runs = sink.recentRuns("many", 3);
    expect(runs).toHaveLength(3);
    expect(runs[0]?.executionId).toBe("exec-5");
    db.close();
  });

  test("lastRun reflects the most recent run even after a later failure", async () => {
    const { executor, sink, db } = harness();

    await executor.run(task("mixed", async () => EMPTY_RESULT));
    await expect(
      executor.run(
        task("mixed", async () => {
          throw new Error("nope");
        }),
      ),
    ).rejects.toThrow();

    expect(sink.lastRun("mixed")?.status).toBe("failure");
    db.close();
  });

  test("lastSuccessfulRun skips later failures", async () => {
    const { executor, sink, db } = harness();

    await executor.run(task("mixed2", async () => EMPTY_RESULT));
    await expect(
      executor.run(
        task("mixed2", async () => {
          throw new Error("nope");
        }),
      ),
    ).rejects.toThrow();

    expect(sink.lastRun("mixed2")?.status).toBe("failure");
    expect(sink.lastSuccessfulRun("mixed2")?.executionId).toBe("exec-1");
    db.close();
  });

  test("history is scoped per task", async () => {
    const { executor, sink, db } = harness();
    await executor.run(task("a", async () => EMPTY_RESULT));
    await executor.run(task("b", async () => EMPTY_RESULT));

    expect(sink.recentRuns("a")).toHaveLength(1);
    expect(sink.recentRuns("b")).toHaveLength(1);
    db.close();
  });

  test("stats compute success rate and average duration", async () => {
    const { executor, sink, db } = harness();

    await executor.run(task("stats", async () => EMPTY_RESULT));
    await executor.run(task("stats", async () => EMPTY_RESULT));
    await expect(
      executor.run(
        task("stats", async () => {
          throw new Error("nope");
        }),
      ),
    ).rejects.toThrow();

    const stats = sink.stats("stats");
    expect(stats).toMatchObject({ total: 3, successes: 2, failures: 1 });
    expect(stats.avgDurationMs).not.toBeNull();
    db.close();
  });

  test("stats on an unknown task are zero rather than undefined", () => {
    const { sink, db } = harness();
    expect(sink.stats("never-ran")).toEqual({
      total: 0,
      successes: 0,
      failures: 0,
      avgDurationMs: null,
    });
    db.close();
  });

  test("metricsFor batches latest runs and aggregates while retaining zero-history tasks", async () => {
    const { executor, sink, db } = harness();
    await executor.run(task("a", async () => EMPTY_RESULT));
    await expect(
      executor.run(
        task("a", async () => {
          throw new Error("failed latest run");
        }),
      ),
    ).rejects.toThrow();
    await executor.run(task("b", async () => EMPTY_RESULT));

    const metrics = sink.metricsFor(["a", "b", "never-ran"]);
    expect(metrics.get("a")).toMatchObject({
      lastRun: { executionId: "exec-2", status: "failure" },
      stats: { total: 2, successes: 1, failures: 1 },
    });
    expect(metrics.get("b")?.lastRun?.executionId).toBe("exec-3");
    expect(metrics.get("never-ran")).toEqual({
      lastRun: null,
      stats: { total: 0, successes: 0, failures: 0, avgDurationMs: null },
    });
    db.close();
  });
});

describe("orphaned runs", () => {
  test("a run row opened but never closed is visible as running", () => {
    const { sink, db } = harness();

    // What a process killed mid-run leaves behind.
    db.run(
      `INSERT INTO task_runs (execution_id, task_id, started_at, status)
       VALUES ('crashed', 'wf', '2026-01-01T00:00:00.000Z', 'running')`,
    );

    const orphans = sink.findOrphanedRuns();
    expect(orphans.map((r) => r.executionId)).toEqual(["crashed"]);
    expect(orphans[0]?.status).toBe("running");
    db.close();
  });

  test("closeOpenRun marks one hanging row cancelled", () => {
    const { sink, db } = harness();
    db.run(
      `INSERT INTO task_runs (execution_id, task_id, started_at, status)
       VALUES ('hung', 'wf', '2026-01-01T00:00:00.000Z', 'running')`,
    );

    expect(sink.closeOpenRun("hung", { status: "cancelled", error: "cancelled by operator" })).toBe(
      true,
    );
    expect(sink.getRun("hung")?.status).toBe("cancelled");
    expect(sink.closeOpenRun("hung", { status: "cancelled", error: "again" })).toBe(false);
    db.close();
  });

  test("closing orphans marks them failed with a reason", () => {
    const { sink, db } = harness();
    db.run(
      `INSERT INTO task_runs (execution_id, task_id, started_at, status)
       VALUES ('crashed', 'wf', '2026-01-01T00:00:00.000Z', 'running')`,
    );

    expect(sink.closeOrphanedRuns("process exited unexpectedly")).toBe(1);
    expect(sink.findOrphanedRuns()).toEqual([]);

    const run = sink.lastRun("wf");
    expect(run?.status).toBe("failure");
    expect(run?.error).toBe("process exited unexpectedly");
    db.close();
  });

  test("a completed run is never treated as an orphan", async () => {
    const { executor, sink, db } = harness();
    await executor.run(task("fine", async () => EMPTY_RESULT));

    expect(sink.findOrphanedRuns()).toEqual([]);
    db.close();
  });
});

describe("run retention", () => {
  test("can purge raw logs independently in bounded batches", async () => {
    const { executor, sink, db } = harness();
    const run = await executor.run(task("logged", async () => EMPTY_RESULT));
    db.run("UPDATE task_runs SET finished_at = ? WHERE execution_id = ?", [
      new Date(0).toISOString(), run.executionId,
    ]);
    const existing = sink.logs(run.executionId).length;
    for (let i = 0; i < 3; i++) {
      sink.appendLog(run.executionId, { ts: new Date(), level: "info", message: `line ${i}` });
    }
    expect(sink.rawLogRetentionCount(new Date())).toBe(existing + 3);
    expect(sink.purgeRawLogs(new Date(), 2)).toBe(2);
    expect(sink.rawLogRetentionCount(new Date())).toBe(existing + 1);
    expect(sink.getRun(run.executionId)).not.toBeNull();
    db.close();
  });

  test("deletes only bounded finished batches and cascades their logs", async () => {
    const { executor, sink, db } = harness();
    await executor.run(task("old", async () => EMPTY_RESULT));
    await executor.run(task("old", async () => EMPTY_RESULT));
    db.run("UPDATE task_runs SET finished_at = ?", [new Date(0).toISOString()]);
    for (const run of sink.recentRuns("old")) {
      sink.appendLog(run.executionId, { ts: new Date(), level: "info", message: "line" });
    }
    const before = sink.recentRuns("old").map((run) => run.executionId);
    expect(sink.purgeFinishedRuns(new Date(), 1)).toBe(1);
    const remaining = sink.recentRuns("old").map((run) => run.executionId);
    expect(remaining).toHaveLength(1);
    expect(sink.logs(before.find((id) => !remaining.includes(id))!)).toEqual([]);
    expect(sink.retentionCounts(new Date()).runs).toBe(0);
    expect(sink.stats("old").total).toBe(2);
    expect(sink.lastRun("old")).not.toBeNull();
    db.close();
  });
});
