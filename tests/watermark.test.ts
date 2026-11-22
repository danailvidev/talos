import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { advanceWatermark, resolveWindow } from "../src/core/watermark.ts";
import { createLogger } from "../src/logging/logger.ts";
import { MemoryStateStore } from "../src/persistence/state-store.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import type { TaskContext } from "../src/core/task.ts";

function context(state = new MemoryStateStore()): TaskContext {
  return {
    taskId: "wf",
    executionId: "exec-1",
    logger: createLogger({
      destination: new PassThrough(),
      pretty: false,
      level: "fatal",
    }),
    state,
    secrets: new EnvSecretStore({}),
    dryRun: false,
    maxItemsPerRun: 10,
    force: false,
    signal: new AbortController().signal,
    llm: { provider: "anthropic", maxTokens: 2048 },
    prompts: {},
    step: async (_id, fn) => fn(),
  };
}

describe("resolveWindow", () => {
  test("seeds to now on the first run and reports it", async () => {
    const ctx = context();
    const now = new Date("2026-08-21T12:00:00.000Z");

    const window = await resolveWindow(ctx, now);

    expect(window.seeded).toBe(true);
    expect(window.since).toEqual(now);
    // Persisted, so a crash before the next run does not reseed and flood.
    expect(await ctx.state.getWatermark("wf")).toEqual(now);
  });

  test("uses the stored watermark on later runs", async () => {
    const state = new MemoryStateStore();
    const stored = new Date("2026-08-01T00:00:00.000Z");
    await state.setWatermark("wf", stored);

    const window = await resolveWindow(context(state), new Date());

    expect(window.seeded).toBe(false);
    expect(window.since).toEqual(stored);
  });

  test("a --since backfill is respected rather than overwritten", async () => {
    const state = new MemoryStateStore();
    const backfill = new Date("2020-01-01T00:00:00.000Z");
    await state.setWatermark("wf", backfill);

    // This is the path `task run --since` takes: write, then run.
    const window = await resolveWindow(context(state), new Date());
    expect(window.since).toEqual(backfill);
  });
});

describe("advanceWatermark", () => {
  test("advances after a clean run", async () => {
    const state = new MemoryStateStore();
    await state.setWatermark("wf", new Date("2026-08-01T00:00:00.000Z"));
    const to = new Date("2026-08-21T12:00:00.000Z");

    expect(await advanceWatermark(context(state), to, { failures: 0 })).toBe(true);
    expect(await state.getWatermark("wf")).toEqual(to);
  });

  test("holds after a failure, so the missed item is re-polled", async () => {
    const state = new MemoryStateStore();
    const original = new Date("2026-08-01T00:00:00.000Z");
    await state.setWatermark("wf", original);

    // Advancing here would push the failed item behind the window forever.
    expect(
      await advanceWatermark(context(state), new Date("2026-08-21T12:00:00.000Z"), {
        failures: 1,
      }),
    ).toBe(false);
    expect(await state.getWatermark("wf")).toEqual(original);
  });

  test("never moves backwards", async () => {
    const state = new MemoryStateStore();
    const later = new Date("2026-08-21T12:00:00.000Z");
    await state.setWatermark("wf", later);

    expect(
      await advanceWatermark(context(state), new Date("2026-08-01T00:00:00.000Z"), {
        failures: 0,
      }),
    ).toBe(false);
    expect(await state.getWatermark("wf")).toEqual(later);
  });

  test("sets the watermark when none exists yet", async () => {
    const state = new MemoryStateStore();
    const to = new Date("2026-08-21T12:00:00.000Z");

    expect(await advanceWatermark(context(state), to, { failures: 0 })).toBe(true);
    expect(await state.getWatermark("wf")).toEqual(to);
  });
});
