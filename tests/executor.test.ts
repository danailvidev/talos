import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { TaskExecutor, type TaskExecutionRecord } from "../src/core/executor.ts";
import { TaskError, TransientError, ValidationError } from "../src/core/errors.ts";
import { EMPTY_RESULT, type Task } from "../src/core/task.ts";
import { mutate } from "../src/core/step.ts";
import { MemoryStateStore } from "../src/persistence/state-store.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import { createLogger } from "../src/logging/logger.ts";
import { PassThrough } from "node:stream";

function silentLogger() {
  // A sink that discards output; level stays high enough to exercise formatting.
  return createLogger({ destination: new PassThrough(), pretty: false, level: "fatal" });
}

function makeExecutor(state = new MemoryStateStore()) {
  let n = 0;
  return {
    state,
    executor: new TaskExecutor({
      logger: silentLogger(),
      state,
      secrets: new EnvSecretStore({}),
      generateExecutionId: () => `exec-${++n}`,
      defaultRetry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    }),
  };
}

const noParams = z.object({}).loose();

describe("TaskExecutor lifecycle", () => {
  test("records a successful run with a deterministic execution id", async () => {
    const { executor } = makeExecutor();
    const task: Task<{}> = {
      id: "ok",
      kind: "task",
      name: "ok",
      paramsSchema: noParams,
      async run() {
        return { itemsSeen: 2, itemsProcessed: 2, itemsSkipped: 0 };
      },
    };
    const record = await executor.run(task);
    expect(record.executionId).toBe("exec-1");
    expect(record.status).toBe("success");
    expect(record.result).toEqual({ itemsSeen: 2, itemsProcessed: 2, itemsSkipped: 0 });
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("records a failed run and wraps the cause in a TaskError", async () => {
    const { executor } = makeExecutor();
    const task: Task<{}> = {
      id: "boom",
      kind: "task",
      name: "boom",
      paramsSchema: noParams,
      async run() {
        throw new Error("kaboom");
      },
    };

    let thrown: unknown;
    try {
      await executor.run(task);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TaskError);
    expect((thrown as TaskError).cause).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("kaboom");
  });

  test("fails the run when the task reports itemsFailed, even though it returned", async () => {
    const sink: { status?: string; error?: string; result?: unknown } = {};
    const recording = new TaskExecutor({
      logger: silentLogger(),
      state: new MemoryStateStore(),
      secrets: new EnvSecretStore({}),
      generateExecutionId: () => "exec-failed-items",
      sink: {
        async runStarted() {},
        async stepFinished() {},
        async runFinished(record) {
          sink.status = record.status;
          sink.error = record.error;
          sink.result = record.result;
        },
      },
    });
    const task: Task<{}> = {
      id: "partial",
      kind: "task",
      name: "partial",
      paramsSchema: noParams,
      async run() {
        return {
          itemsSeen: 1,
          itemsProcessed: 0,
          itemsSkipped: 0,
          itemsFailed: 1,
          details: { notes: ["failed !6193: LlmError: container timed out"] },
        };
      },
    };

    let thrown: unknown;
    try {
      await recording.run(task);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TaskError);
    expect((thrown as Error).message).toContain("failed !6193");
    expect(sink.status).toBe("failure");
    expect(sink.error).toContain("failed !6193");
    expect(sink.result).toMatchObject({ itemsFailed: 1, itemsProcessed: 0 });
  });

  test("rejects params that fail the task's schema", async () => {
    const { executor } = makeExecutor();
    const task: Task<{ projectId: number }> = {
      id: "typed",
      kind: "task",
      name: "typed",
      paramsSchema: z.object({ projectId: z.number() }),
      async run() {
        return EMPTY_RESULT;
      },
    };

    await expect(
      executor.run(task, { params: { projectId: "forty-two" } }),
    ).rejects.toThrow(ValidationError);
  });

  test("passes validated, defaulted params through to run", async () => {
    const { executor } = makeExecutor();
    let seen: unknown;
    const task: Task<{ n: number }> = {
      id: "cfg",
      kind: "task",
      name: "cfg",
      paramsSchema: z.object({ n: z.number().default(7) }),
      async run(_ctx, params) {
        seen = params;
        return EMPTY_RESULT;
      },
    };

    await executor.run(task, { params: {} });
    expect(seen).toEqual({ n: 7 });
  });

  test("dry-run is threaded through to ctx and the record", async () => {
    const { executor } = makeExecutor();
    let seenDryRun: boolean | undefined;
    const task: Task<{}> = {
      id: "dryflag",
      kind: "task",
      name: "dryflag",
      paramsSchema: noParams,
      async run(ctx) {
        seenDryRun = ctx.dryRun;
        return EMPTY_RESULT;
      },
    };

    const record = await executor.run(task, { dryRun: true });
    expect(seenDryRun).toBe(true);
    expect(record.dryRun).toBe(true);
  });

  test("maxItemsPerRun defaults to 10 and is threaded through to ctx", async () => {
    const { executor } = makeExecutor();
    let seenCap: number | undefined;
    const task: Task<{}> = {
      id: "cap-default",
      kind: "task",
      name: "cap-default",
      paramsSchema: noParams,
      async run(ctx) {
        seenCap = ctx.maxItemsPerRun;
        return EMPTY_RESULT;
      },
    };

    await executor.run(task);
    expect(seenCap).toBe(10);
  });

  test("an explicit maxItemsPerRun overrides the default", async () => {
    const { executor } = makeExecutor();
    let seenCap: number | undefined;
    const task: Task<{}> = {
      id: "cap-explicit",
      kind: "task",
      name: "cap-explicit",
      paramsSchema: noParams,
      async run(ctx) {
        seenCap = ctx.maxItemsPerRun;
        return EMPTY_RESULT;
      },
    };

    await executor.run(task, { maxItemsPerRun: 3 });
    expect(seenCap).toBe(3);
  });

  test("force is off by default and on when the caller asks", async () => {
    const { executor } = makeExecutor();
    const seen: boolean[] = [];
    const task: Task<{}> = {
      id: "force-flag",
      kind: "task",
      name: "force-flag",
      paramsSchema: noParams,
      async run(ctx) {
        seen.push(ctx.force);
        return EMPTY_RESULT;
      },
    };

    await executor.run(task);
    await executor.run(task, { force: true });
    expect(seen).toEqual([false, true]);
  });
});

describe("ctx.step", () => {
  test("records duration, status and order for each step", async () => {
    const { executor } = makeExecutor();
    const task: Task<{}> = {
      id: "steps",
      kind: "task",
      name: "steps",
      paramsSchema: noParams,
      async run(ctx) {
        await ctx.step("first", async () => "a");
        await ctx.step("second", async () => "b");
        return EMPTY_RESULT;
      },
    };

    const record = await executor.run(task);
    expect(record.steps.map((s) => s.stepId)).toEqual(["first", "second"]);
    expect(record.steps.every((s) => s.status === "success")).toBe(true);
    expect(record.steps.every((s) => s.attempts === 1)).toBe(true);
  });

  test("returns the step's value to the task", async () => {
    const { executor } = makeExecutor();
    let value: string | undefined;
    const task: Task<{}> = {
      id: "value",
      kind: "task",
      name: "value",
      paramsSchema: noParams,
      async run(ctx) {
        value = await ctx.step("compute", async () => "computed");
        return EMPTY_RESULT;
      },
    };

    await executor.run(task);
    expect(value).toBe("computed");
  });

  test("retries a transient step failure and reports the attempt count", async () => {
    const { executor } = makeExecutor();
    let calls = 0;
    const task: Task<{}> = {
      id: "retry",
      kind: "task",
      name: "retry",
      paramsSchema: noParams,
      async run(ctx) {
        await ctx.step("flaky", async () => {
          calls++;
          if (calls === 1) throw new TransientError("hiccup");
          return "ok";
        });
        return EMPTY_RESULT;
      },
    };

    const record = await executor.run(task);
    expect(calls).toBe(2);
    expect(record.steps[0]?.attempts).toBe(2);
    expect(record.steps[0]?.status).toBe("success");
  });

  test("records a failed step before the run record closes", async () => {
    const { executor } = makeExecutor();
    const task: Task<{}> = {
      id: "failstep",
      kind: "task",
      name: "failstep",
      paramsSchema: noParams,
      async run(ctx) {
        await ctx.step("bad", async () => {
          throw new Error("step exploded");
        });
        return EMPTY_RESULT;
      },
    };

    await expect(executor.run(task)).rejects.toThrow(TaskError);
  });

  test("a per-step retry policy overrides the executor default", async () => {
    const { executor } = makeExecutor();
    let calls = 0;
    const task: Task<{}> = {
      id: "noretry",
      kind: "task",
      name: "noretry",
      paramsSchema: noParams,
      async run(ctx) {
        await ctx.step(
          "once",
          async () => {
            calls++;
            throw new TransientError("no second chance");
          },
          { retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 } },
        );
        return EMPTY_RESULT;
      },
    };

    await expect(executor.run(task)).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("dry run", () => {
  test("suppresses the write and returns null so callers must handle it", async () => {
    const { executor } = makeExecutor();
    let performed = false;
    let returned: unknown = "unset";

    const task: Task<{}> = {
      id: "dry",
      kind: "task",
      name: "dry",
      paramsSchema: noParams,
      async run(ctx) {
        returned = await mutate(ctx, "create a Jira issue", async () => {
          performed = true;
          return { key: "DEV-1" };
        });
        return EMPTY_RESULT;
      },
    };

    const record = await executor.run(task, { dryRun: true });
    expect(record.dryRun).toBe(true);
    expect(performed).toBe(false);
    expect(returned).toBeNull();
  });

  test("performs the write when not a dry run", async () => {
    const { executor } = makeExecutor();
    let performed = false;

    const task: Task<{}> = {
      id: "wet",
      kind: "task",
      name: "wet",
      paramsSchema: noParams,
      async run(ctx) {
        await mutate(ctx, "create a Jira issue", async () => {
          performed = true;
        });
        return EMPTY_RESULT;
      },
    };

    await executor.run(task, { dryRun: false });
    expect(performed).toBe(true);
  });
});

describe("LLM settings", () => {
  test("exposes live LLM settings on the task context", async () => {
    const { executor } = makeExecutor();
    let seen: { model?: string; effort?: string } | undefined;
    const task: Task<{}> = {
      id: "llm",
      kind: "task",
      name: "llm",
      paramsSchema: noParams,
      async run(ctx) {
        seen = { model: ctx.llm.model, effort: ctx.llm.effort };
        return EMPTY_RESULT;
      },
    };

    const withLlm = new TaskExecutor({
      logger: silentLogger(),
      state: new MemoryStateStore(),
      secrets: new EnvSecretStore({}),
      generateExecutionId: () => "exec-llm",
      getLlm: () => ({ provider: "anthropic", model: "opus", effort: "high", maxTokens: 2048 }),
    });
    await withLlm.run(task);
    expect(seen).toEqual({ model: "opus", effort: "high" });

    await executor.run(task);
    expect(seen).toEqual({ model: undefined, effort: undefined });
  });

  test("resolves actor defaults unless a loop requests instance defaults", async () => {
    const selected: string[] = [];
    const task: Task<{}> = {
      id: "llm-scope",
      kind: "task",
      name: "llm scope",
      paramsSchema: noParams,
      async run(ctx) {
        selected.push(ctx.llm.model ?? "none");
        return EMPTY_RESULT;
      },
    };
    const loop: Task<{}> = {
      ...task,
      id: "llm-loop-scope",
      name: "llm loop scope",
      kind: "loop",
    };
    const executor = new TaskExecutor({
      logger: silentLogger(),
      state: new MemoryStateStore(),
      secrets: new EnvSecretStore({}),
      getLlm: (_actor, scope) => ({
        provider: "anthropic",
        model: scope === "actor" ? "opus" : "sonnet",
        maxTokens: 2048,
      }),
    });
    const actor = { id: "user-1", name: "User", email: "user@example.com" };

    await executor.run(task, { actor });
    await executor.run(loop, { actor });
    await executor.run(task, { actor, llmScope: "instance" });

    expect(selected).toEqual(["opus", "sonnet", "sonnet"]);
  });
});

describe("TaskExecutionSink", () => {
  test("receives run and step events in order", async () => {
    const events: string[] = [];
    const state = new MemoryStateStore();
    const executor = new TaskExecutor({
      logger: silentLogger(),
      state,
      secrets: new EnvSecretStore({}),
      sink: {
        async runStarted(r) {
          events.push(`run-started:${r.executionId}`);
        },
        async stepFinished(_id, step) {
          events.push(`step:${step.stepId}:${step.status}`);
        },
        async runFinished(r: TaskExecutionRecord) {
          events.push(`run-finished:${r.status}`);
        },
      },
    });

    const task: Task<{}> = {
      id: "sink",
      kind: "task",
      name: "sink",
      paramsSchema: noParams,
      async run(ctx) {
        await ctx.step("one", async () => {});
        return EMPTY_RESULT;
      },
    };

    await executor.run(task);
    expect(events).toEqual([
      "run-started:" + events[0]!.split(":")[1],
      "step:one:success",
      "run-finished:success",
    ]);
  });
});

describe("cancellation", () => {
  test("exposes an already-aborted signal to the task", async () => {
    const { executor } = makeExecutor();
    const controller = new AbortController();
    controller.abort();

    let aborted: boolean | undefined;
    const task: Task<{}> = {
      id: "cancel",
      kind: "task",
      name: "cancel",
      paramsSchema: noParams,
      async run(ctx) {
        aborted = ctx.signal.aborted;
        return EMPTY_RESULT;
      },
    };

    const record = await executor.run(task, { signal: controller.signal });
    expect(aborted).toBe(true);
    expect(record.status).toBe("cancelled");
  });

  test("cancel() aborts a live run and records cancelled", async () => {
    const { executor } = makeExecutor();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const task: Task<{}> = {
      id: "hang",
      kind: "task",
      name: "hang",
      paramsSchema: noParams,
      async run(ctx) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            ctx.signal.removeEventListener("abort", onAbort);
            reject(new DOMException("aborted", "AbortError"));
          };
          ctx.signal.addEventListener("abort", onAbort);
          void gate.then(() => {
            ctx.signal.removeEventListener("abort", onAbort);
            resolve();
          });
        });
        return EMPTY_RESULT;
      },
    };

    const running = executor.run(task);
    for (let i = 0; i < 50 && !executor.isActive("exec-1"); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(executor.cancel("exec-1")).toBe(true);
    const record = await running;
    release();
    expect(record.status).toBe("cancelled");
    expect(record.error).toContain("cancelled");
    expect(executor.isActive("exec-1")).toBe(false);
  });

  test("cancel() of an unknown execution is a no-op", () => {
    const { executor } = makeExecutor();
    expect(executor.cancel("nope")).toBe(false);
  });
});
