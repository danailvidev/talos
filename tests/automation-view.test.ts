import { describe, expect, test } from "bun:test";

import type { AutomationSchedule } from "../src/application/ports.ts";
import { scheduleIsStale } from "../src/api/automation-view.ts";

function schedule(
  overrides: Partial<AutomationSchedule> = {},
): AutomationSchedule {
  return {
    projectId: "example-org/qa/test-automation",
    scheduleId: 1554200,
    description: "Lesson Planner Scheduled",
    ref: "main",
    active: true,
    syncedAt: new Date("2026-09-24T12:00:00.000Z"),
    nextRunAt: new Date("2026-09-25T04:00:00.000Z"),
    ...overrides,
  };
}

describe("Automation schedule freshness", () => {
  test("does not call daily data stale just because TALOS last polled 30 minutes ago", () => {
    expect(
      scheduleIsStale(
        schedule(),
        new Date("2026-09-24T12:33:00.000Z"),
      ),
    ).toBe(false);
  });

  test("becomes stale only after the expected run plus grace", () => {
    expect(
      scheduleIsStale(
        schedule(),
        new Date("2026-09-25T06:00:01.000Z"),
      ),
    ).toBe(true);
  });

  test("inactive schedules are not stale", () => {
    expect(
      scheduleIsStale(
        schedule({ active: false, nextRunAt: new Date(0) }),
        new Date("2026-09-25T12:00:00.000Z"),
      ),
    ).toBe(false);
  });
});
