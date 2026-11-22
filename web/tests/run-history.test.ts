import { describe, expect, test } from "bun:test";

import type { LogLineView } from "../src/api.ts";
import {
  jiraTicketOutcomesFromLogs,
  mergeJiraOutcomeDetails,
} from "../src/runs/RunHistory.tsx";

function finalLog(details: Record<string, unknown>): LogLineView {
  return {
    id: 1,
    ts: "2026-09-21T08:35:48.000Z",
    level: "info",
    message: "task succeeded",
    meta: { details },
  };
}

describe("Jira outcomes in run history", () => {
  test("reads structured links and assignees", () => {
    const outcomes = jiraTicketOutcomesFromLogs([
      finalLog({
        ticketOutcomes: [
          {
            action: "filed",
            issueKey: "TP-1842",
            issueUrl: "https://jira.example.com/browse/TP-1842",
            assignee: "Alice Example",
            file: "src/all-practice-list.component.spec.ts",
          },
        ],
      }),
    ]);

    expect(outcomes).toEqual([
      {
        action: "filed",
        issueKey: "TP-1842",
        issueUrl: "https://jira.example.com/browse/TP-1842",
        assignee: "Alice Example",
        file: "src/all-practice-list.component.spec.ts",
      },
    ]);
  });

  test("keeps older string-only run records readable", () => {
    const recorded = jiraTicketOutcomesFromLogs([
      finalLog({ issues: ["unchanged TP-1843 core/sp-gtm.service.spec.ts"] }),
    ]);
    expect(recorded).toEqual([
      {
        action: "unchanged",
        issueKey: "TP-1843",
        file: "core/sp-gtm.service.spec.ts",
      },
    ]);

    expect(
      mergeJiraOutcomeDetails(recorded, [
        {
          action: "unchanged",
          issueKey: "TP-1843",
          issueUrl: "https://jira.example.com/browse/TP-1843",
          assignee: "Bob Example",
          file: "core/sp-gtm.service.spec.ts",
        },
      ]),
    ).toEqual([
      {
        action: "unchanged",
        issueKey: "TP-1843",
        issueUrl: "https://jira.example.com/browse/TP-1843",
        assignee: "Bob Example",
        file: "core/sp-gtm.service.spec.ts",
      },
    ]);
  });
});
