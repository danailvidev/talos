import { describe, expect, test } from "bun:test";

import {
  automationJiraDraft,
  automationJiraPatch,
  automationJiraValidationError,
} from "../src/automation-jira-config.ts";

describe("Automation Jira settings", () => {
  test("supplies ticketing defaults while keeping Jira optional", () => {
    const draft = automationJiraDraft({ jira: null });
    expect(draft).toEqual({
      projectKey: "",
      parentKey: "",
      issueType: "Bug",
      boardId: "",
      useActiveSprint: true,
      labels: ["talos", "automation"],
      assigneeMode: "automatic",
      fixedAssignee: "",
    });
    expect(automationJiraPatch(draft)).toBeNull();
    expect(automationJiraValidationError(draft)).toBeUndefined();
  });

  test("normalizes a configured fixed assignee without retaining automatic values", () => {
    const fixed = automationJiraDraft({
      jira: {
        projectKey: "TP",
        issueType: "Task",
        boardId: 21,
        useActiveSprint: false,
        labels: ["talos", "automation"],
        assigneeMode: "fixed",
        fixedAssignee: "alice",
      },
    });
    fixed.projectKey = " tp ";
    fixed.parentKey = " tp-100 ";
    fixed.fixedAssignee = " alice ";
    expect(automationJiraPatch(fixed)).toEqual({
      projectKey: "TP",
      parentKey: "TP-100",
      issueType: "Task",
      boardId: 21,
      useActiveSprint: false,
      labels: ["talos", "automation"],
      assigneeMode: "fixed",
      fixedAssignee: "alice",
    });

    fixed.assigneeMode = "automatic";
    expect(automationJiraPatch(fixed)).not.toHaveProperty("fixedAssignee");
  });

  test("rejects incomplete fixed assignment and invalid board or labels", () => {
    const draft = automationJiraDraft({ jira: null });
    draft.projectKey = "TP";
    draft.assigneeMode = "fixed";
    expect(automationJiraValidationError(draft)).toMatch(/assignee/i);

    draft.fixedAssignee = "alice";
    draft.boardId = "0";
    expect(automationJiraValidationError(draft)).toMatch(/board/i);

    draft.boardId = "";
    draft.labels = ["talos", "not valid"];
    expect(automationJiraValidationError(draft)).toMatch(/labels/i);
  });
});
