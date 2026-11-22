import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { ConnectorError, LlmError, TaskError } from "../src/core/errors.ts";
import type { TaskExecutor } from "../src/core/executor.ts";
import { TaskRegistry } from "../src/core/registry.ts";
import { startWorkers } from "../src/core/worker-pool.ts";
import { createLogger } from "../src/logging/logger.ts";
import { SqliteJobQueue } from "../src/persistence/job-queue.ts";
import { migrate } from "../src/persistence/migrations.ts";

async function runFailingJob(error: Error) {
  const db = new Database(":memory:");
  migrate(db);
  const queue = new SqliteJobQueue(db);
  const registry = new TaskRegistry();
  registry.register({ id: "handler", name: "Handler", kind: "job", paramsSchema: z.unknown(), run: async () => ({}) });
  const { job } = queue.enqueue({ kind: "handler", loopId: "loop", dedupeKey: "one" });
  const executor = { run: async () => { throw error; } } as unknown as TaskExecutor;
  const workers = startWorkers(
    {
      logger: createLogger({ destination: new PassThrough(), pretty: false, level: "fatal" }),
      executor,
      taskRegistry: registry,
      queue,
    },
    { pollMs: 60_000 },
  );
  await Bun.sleep(5);
  await workers.stop();
  const row = db.query<{ status: string; attempts: number }, [string]>(
    "SELECT status, attempts FROM jobs WHERE id = ?",
  ).get(job!.id);
  db.close();
  return row;
}

describe("worker pool retries", () => {
  test("does not spend further attempts on a failure that is not retryable", async () => {
    const cause = new LlmError("claude: Argument list too long");
    expect(await runFailingJob(new TaskError("failed", { cause }))).toEqual({ status: "dead", attempts: 1 });
  });

  test("requeues a failure whose cause is retryable", async () => {
    const cause = new ConnectorError("GitLab 503", { retryable: true });
    expect(await runFailingJob(new TaskError("failed", { cause }))).toEqual({ status: "queued", attempts: 1 });
  });
});

describe("worker pool", () => {
  test("aborts immediately when cancellation wins before execution attachment", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const queue = new SqliteJobQueue(db);
    const registry = new TaskRegistry();
    registry.register({
      id: "agent-job",
      name: "Agent",
      kind: "job",
      agent: true,
      paramsSchema: z.unknown(),
      run: async () => ({}),
    });
    const job = queue.enqueue({
      kind: "agent-job",
      loopId: "loop",
      dedupeKey: "cancel-before-attach",
    }).job!;
    let aborted = false;
    const executor = {
      run: async (_task: unknown, options: {
        signal: AbortSignal;
        onStarted(info: { executionId: string }): void;
      }) => {
        queue.cancelJob(job.id, "cancelled by operator");
        options.onStarted({ executionId: "late-run" });
        aborted = options.signal.aborted;
        return { status: "cancelled" };
      },
    } as unknown as TaskExecutor;
    const workers = startWorkers(
      {
        logger: createLogger({ destination: new PassThrough(), pretty: false, level: "fatal" }),
        executor,
        taskRegistry: registry,
        queue,
      },
      { pollMs: 60_000 },
    );

    await Bun.sleep(5);
    await workers.stop();
    expect(aborted).toBe(true);
    expect(queue.get(job.id)?.status).toBe("dead");
    db.close();
  });

  test("keeps workers free for lightweight jobs while agent jobs are capped", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const queue = new SqliteJobQueue(db);
    const registry = new TaskRegistry();
    const noop = { paramsSchema: z.unknown(), run: async () => ({}) };
    registry.register({ id: "agent-job", name: "Agent", kind: "job", agent: true, ...noop });
    registry.register({ id: "light-job", name: "Light", kind: "job", ...noop });

    for (let i = 0; i < 4; i++) {
      queue.enqueue({
        kind: "agent-job",
        loopId: "loop",
        dedupeKey: `agent-${i}`,
        availableAt: new Date(Date.now() - 60_000 + i),
      });
    }
    queue.enqueue({ kind: "light-job", loopId: "loop", dedupeKey: "light" });

    const started: string[] = [];
    const finish: Array<() => void> = [];
    const executor = {
      run: (task: { id: string }) => {
        started.push(task.id);
        return new Promise((resolve) => {
          finish.push(() => resolve({ status: "success" }));
        });
      },
    } as unknown as TaskExecutor;

    const workers = startWorkers(
      {
        logger: createLogger({ destination: new PassThrough(), pretty: false, level: "fatal" }),
        executor,
        taskRegistry: registry,
        queue,
      },
      { concurrency: 4, agentConcurrency: 2, pollMs: 60_000 },
    );
    await Bun.sleep(1);

    expect(started.filter((id) => id === "agent-job")).toHaveLength(2);
    expect(started).toContain("light-job");
    expect(workers.active()).toBe(3);

    for (const done of finish) done();
    await workers.stop();
    db.close();
  });
});
