import { describe, expect, test } from "bun:test";

import { DEFAULT_DASHBOARD_ID } from "../shared/dashboard.ts";
import { dashboardToReopen, parseLastDashboard } from "../web/src/dashboard/last-dashboard.ts";

describe("last overview", () => {
  test("reopens the custom overview that was last active", () => {
    expect(dashboardToReopen("custom", [{ id: "newer" }, { id: "custom" }])).toBe("custom");
  });

  test("reopens the built-in dashboard when that was last active", () => {
    expect(dashboardToReopen(DEFAULT_DASHBOARD_ID, [{ id: "custom" }])).toBe(DEFAULT_DASHBOARD_ID);
  });

  test("skips a remembered overview that was deleted", () => {
    expect(dashboardToReopen("gone", [{ id: "custom" }])).toBe("custom");
    expect(dashboardToReopen("gone", [])).toBeUndefined();
  });

  test("rejects a stored value that is not a dashboard id", () => {
    expect(parseLastDashboard("custom")).toBe("custom");
    expect(parseLastDashboard("  ")).toBeUndefined();
    expect(parseLastDashboard(12)).toBeUndefined();
  });
});
