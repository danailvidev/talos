import { describe, expect, test } from "bun:test";

import type { SprintView, TicketCluster } from "../shared/api-contract.ts";
import {
  applyFilters,
  DEFAULT_FILTERS,
  parseFilters,
  resolveSprint,
  sprintOptions,
} from "../web/src/graph/filters.ts";

const july: SprintView = { id: 1, name: "July", state: "active" };
const october: SprintView = { id: 2, name: "October", state: "active" };
const september: SprintView = { id: 3, name: "September", state: "closed" };

function cluster(key: string, sprints: SprintView[]): TicketCluster {
  return {
    key,
    status: "waiting",
    counts: { mrs: 0, jobs: 0, runs: 0, actions: 0, activeJobs: 0 },
    inReview: false,
    updatedAt: "2026-09-12T00:00:00.000Z",
    source: "jira",
    sprint: sprints[0],
    sprints,
    actions: {
      "fix-issue": { available: true },
      "plan-issue": { available: true },
      "review-description": { available: true },
      "e2e-test": { available: false },
    },
    e2ePullRequests: [],
    nodes: [
      {
        id: `ticket:jira:${key}`,
        kind: "ticket",
        label: key,
        status: "waiting",
        ticket: { labels: [] },
      },
    ],
    edges: [],
  };
}

describe("active sprint filtering", () => {
  const clusters = [
    cluster("TP-1", [july]),
    cluster("TP-2", [october]),
    cluster("TP-3", [september]),
    cluster("TP-4", []),
  ];
  const view = { sprints: [july, october, september] };

  test("defaults to the union of every active sprint", () => {
    const resolved = resolveSprint(DEFAULT_FILTERS.sprint, view);
    expect(applyFilters(clusters, DEFAULT_FILTERS, resolved).map((ticket) => ticket.key)).toEqual([
      "TP-1",
      "TP-2",
    ]);
  });

  test("keeps active sprints selectable individually and hides closed ones", () => {
    const options = sprintOptions(clusters, DEFAULT_FILTERS, view);
    expect(options.map((option) => option.label)).toEqual([
      "Active sprints",
      "July",
      "October",
      "Backlog",
      "All tickets",
    ]);
    expect(options[0]?.count).toBe(2);
  });

  test("migrates the old current-sprint preference to active sprints", () => {
    expect(parseFilters({ sprint: "current" }).sprint).toBe("active");
  });

  test("restores an explicit sprint and defaults missing or invalid values to active", () => {
    expect(parseFilters({ sprint: 2 }).sprint).toBe(2);
    expect(parseFilters(undefined).sprint).toBe("active");
    expect(parseFilters({ sprint: "not-a-sprint" }).sprint).toBe("active");
  });
});
