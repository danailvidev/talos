import { describe, expect, test } from "bun:test";
import { nextRunForTrigger } from "../src/config/croner-job.ts";

describe("nextRunForTrigger", () => {
  test("a future one-shot reports that instant", () => {
    const at = new Date(Date.now() + 60_000).toISOString();
    const { nextRun, scheduleError } = nextRunForTrigger({ type: "once", at });
    expect(scheduleError).toBeUndefined();
    expect(nextRun).toBe(at);
  });

  test("a daily cron does not fire before startAt", () => {
    const startAt = new Date(Date.now() + 86400_000 * 3).toISOString();
    const { nextRun } = nextRunForTrigger({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "UTC",
      startAt,
    });
    expect(nextRun).not.toBeNull();
    expect(new Date(nextRun!).getTime()).toBeGreaterThanOrEqual(new Date(startAt).getTime() - 1000);
  });

  test("manual has no next run", () => {
    expect(nextRunForTrigger({ type: "manual" })).toEqual({ nextRun: null });
  });
});
