import { describe, expect, test } from "bun:test";

import { DEFAULT_TALOS_DASHBOARD } from "../shared/dashboard.ts";
import {
  dashboardAccessPurpose,
  providerForDataset,
  providersForWidgets,
} from "../web/src/dashboard/access.ts";

describe("dashboard provider access", () => {
  test("the built-in dashboard reads GitLab and Jira as the viewer", () => {
    expect(providersForWidgets(DEFAULT_TALOS_DASHBOARD.widgets)).toEqual(["gitlab", "jira"]);
  });

  test("stored datasets do not ask for a personal token", () => {
    expect(providerForDataset("gitlab.pipelines")).toBeUndefined();
    expect(providerForDataset("talos.task_runs")).toBeUndefined();
    expect(providerForDataset("talos.agent_usage")).toBeUndefined();
    expect(providersForWidgets([
      { query: { dataset: "gitlab.pipelines" } },
      { query: { dataset: "talos.task_runs" } },
    ])).toEqual([]);
  });

  test("the notice names only the providers still missing", () => {
    expect(dashboardAccessPurpose(["gitlab", "jira"])).toBe(
      "Showing merge requests and tickets on this dashboard",
    );
    expect(dashboardAccessPurpose(["gitlab"])).toBe(
      "Showing merge requests on this dashboard",
    );
    expect(dashboardAccessPurpose(["jira"])).toBe(
      "Showing tickets on this dashboard",
    );
  });
});
