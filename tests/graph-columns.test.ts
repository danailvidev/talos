import { describe, expect, test } from "bun:test";

import type { TicketBoardView, TicketCluster } from "../shared/api-contract.ts";
import { boardColumns, columnOf } from "../web/src/graph/columns.ts";

const board: TicketBoardView = {
  id: 20,
  name: "Web Portal",
  columns: [
    {
      id: "jira:20:column:0",
      name: "Dev Queue",
      statusIds: ["1", "10010"],
    },
  ],
};

function cluster(statusId: string, columnId?: string): TicketCluster {
  return {
    key: "TP-1",
    status: "waiting",
    counts: { mrs: 0, jobs: 0, runs: 0, actions: 0, activeJobs: 0 },
    inReview: false,
    updatedAt: "2026-09-12T00:00:00.000Z",
    source: "jira",
    sprints: [],
    ...(columnId ? { columnId } : {}),
    actions: {
      "fix-issue": { available: true },
      "plan-issue": { available: true },
      "review-description": { available: true },
      "e2e-test": { available: false },
    },
    e2ePullRequests: [],
    nodes: [
      {
        id: "ticket:jira:TP-1",
        kind: "ticket",
        label: "TP-1",
        status: "waiting",
        ticket: { statusId, status: "New", labels: [] },
      },
    ],
    edges: [],
  };
}

describe("Jira board columns", () => {
  test("uses Jira's status-id mapping instead of comparing display names", () => {
    const ticket = cluster("1", "jira:20:column:0");
    const columns = boardColumns(board, [ticket]);

    expect(columns.map((column) => column.name)).toEqual(["Dev Queue"]);
    expect(columnOf(ticket, columns)).toBe("jira:20:column:0");
  });

  test("can recover the Jira column from the status id when columnId is absent", () => {
    const ticket = cluster("10010");
    const columns = boardColumns(board, [ticket]);

    expect(columnOf(ticket, columns)).toBe("jira:20:column:0");
  });

  test("falls back to status columns instead of putting every ticket in Other", () => {
    const ticket = cluster("unmapped");
    const columns = boardColumns(board, [ticket]);

    expect(columns.map((column) => column.name)).toEqual(["New"]);
    expect(columnOf(ticket, columns)).toBe("jira:fallback:unmapped");
  });
});
