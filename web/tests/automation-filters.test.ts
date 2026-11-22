import { describe, expect, test } from "bun:test";

import {
  mergeAutomationDashboardCardOrder,
  parseAutomationDashboardCardOrder,
  parseAutomationDashboardHiddenCards,
  parseAutomationFilters,
} from "../src/automation-filters.ts";

describe("Automation dashboard filters", () => {
  test("defaults an absent or stale preference", () => {
    expect(parseAutomationFilters(undefined)).toEqual({ days: 30 });
    expect(
      parseAutomationFilters({
        days: 90,
        scheduleId: -1,
        status: "unknown",
      }),
    ).toEqual({ days: 30 });
  });

  test("restores every valid dashboard filter", () => {
    expect(
      parseAutomationFilters({
        days: 1,
        scheduleId: 15540194,
        status: "failed",
      }),
    ).toEqual({
      days: 1,
      scheduleId: 15540194,
      status: "failed",
    });
  });
});

describe("Automation dashboard card visibility", () => {
  test("keeps only unique current card ids", () => {
    expect(
      parseAutomationDashboardHiddenCards([
        "attention",
        "retired-card",
        "attention",
        42,
        "quality",
      ]),
    ).toEqual(["attention", "quality"]);
    expect(parseAutomationDashboardHiddenCards(undefined)).toEqual([]);
  });

  test("reorders visible cards without moving hidden cards", () => {
    expect(
      mergeAutomationDashboardCardOrder(
        ["readiness", "quality", "duration", "suite-health", "outcomes", "attention"],
        ["outcomes", "readiness", "duration", "quality"],
        new Set(["suite-health", "attention"]),
      ),
    ).toEqual([
      "outcomes",
      "readiness",
      "duration",
      "suite-health",
      "quality",
      "attention",
    ]);
  });
});

describe("Automation dashboard card order", () => {
  test("restores valid unique positions and appends missing cards", () => {
    expect(
      parseAutomationDashboardCardOrder([
        "duration",
        "placeholder-1",
        "readiness",
        "duration",
        "retired-card",
      ]),
    ).toEqual([
      "duration",
      "readiness",
      "quality",
      "suite-health",
      "outcomes",
      "attention",
    ]);
  });

  test("uses the complete default order for invalid preferences", () => {
    expect(parseAutomationDashboardCardOrder(undefined)).toEqual([
      "readiness",
      "quality",
      "duration",
      "suite-health",
      "outcomes",
      "attention",
    ]);
  });
});
