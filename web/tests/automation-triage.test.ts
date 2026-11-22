import { describe, expect, test } from "bun:test";

import type { AutomationFailureClusterView } from "../src/api.ts";
import {
  AUTOMATION_BULK_TICKET_LIMIT,
  automationAiTriageVerdictLabel,
  automationClusterActionState,
  automationFailureWorkStatus,
  canSelectForTicket,
  parseAutomationTriageFilters,
  selectablePageKeys,
  updateClusterSelection,
} from "../src/automation-triage.ts";
import { keys } from "../src/query-keys.ts";

const cluster = (
  signatureKey: string,
  triageState: AutomationFailureClusterView["triageState"] = "untriaged",
  creating = false,
): AutomationFailureClusterView => ({
  signatureKey,
  title: signatureKey,
  severity: "failed",
  occurrenceCount: 1,
  affectedTestCount: 1,
  sampleTestName: "works",
  sampleClassname: null,
  jobIds: [],
  suiteIndexes: [],
  triageState,
  creating,
  work: null,
  ticketRefusal: null,
  aiTriage: null,
  aiTriageInFlight: false,
  aiTriageRefusal: null,
});

describe("Automation failure triage filters", () => {
  test("defaults invalid persisted fields independently", () => {
    expect(
      parseAutomationTriageFilters({
        search: 42,
        jobId: 0,
        suiteIndex: -1,
        state: "creating",
        limit: 100,
      }),
    ).toEqual({ search: "", limit: 25 });
  });

  test("restores valid server-side filters and caps search length", () => {
    expect(
      parseAutomationTriageFilters({
        search: "x".repeat(240),
        jobId: 91,
        suiteIndex: 0,
        state: "active-mr",
        limit: 50,
      }),
    ).toEqual({
      search: "x".repeat(200),
      jobId: 91,
      suiteIndex: 0,
      state: "active-mr",
      limit: 50,
    });
  });

  test("normalizes all filter fields into deterministic query keys", () => {
    expect(
      keys.automationFailureClusters(123, {
        limit: 25,
        offset: 50,
        search: "  timeout  ",
        jobId: 9,
        suiteIndex: 0,
        state: "untriaged",
      }),
    ).toEqual([
      "automation",
      "failure-clusters",
      123,
      {
        limit: 25,
        offset: 50,
        search: "timeout",
        jobId: 9,
        suiteIndex: 0,
        state: "untriaged",
      },
    ]);
  });
});

describe("Automation bulk triage selection", () => {
  test("only untriaged, non-creating clusters are selectable", () => {
    expect(canSelectForTicket(cluster("new"))).toBe(true);
    expect(canSelectForTicket(cluster("busy", "untriaged", true))).toBe(false);
    expect(canSelectForTicket(cluster("ticketed", "ticketed"))).toBe(false);
    expect(canSelectForTicket(cluster("mr", "active-mr"))).toBe(false);
    expect(
      selectablePageKeys([
        cluster("new"),
        cluster("busy", "untriaged", true),
        cluster("covered", "ticketed"),
      ]),
    ).toEqual(["new"]);
  });

  test("enforces the backend cap but always permits deselection", () => {
    const full = new Set(
      Array.from({ length: AUTOMATION_BULK_TICKET_LIMIT }, (_, index) => `key-${index}`),
    );
    expect(
      updateClusterSelection(full, "overflow", true, true),
    ).toEqual(full);
    expect(
      updateClusterSelection(full, "key-0", false, false).has("key-0"),
    ).toBe(false);
  });

  test("refuses covered clusters even below the cap", () => {
    expect(
      updateClusterSelection(new Set(["first"]), "covered", true, false),
    ).toEqual(new Set(["first"]));
  });
});

describe("Automation cluster actions", () => {
  test("animates only active creation and keeps completed tickets stable", () => {
    expect(automationFailureWorkStatus(cluster("creating", "untriaged", true))).toBe(
      "running",
    );
    expect(automationFailureWorkStatus(cluster("ticketed", "ticketed"))).toBe(
      "enabled",
    );
    expect(automationFailureWorkStatus(cluster("mr", "active-mr"))).toBe(
      "success",
    );
  });

  test("uses QA-facing labels for every AI verdict", () => {
    expect(
      [
        "service-breaking-change",
        "ui-change",
        "bad-data",
        "test-bug",
        "infrastructure",
        "unknown",
      ].map(automationAiTriageVerdictLabel),
    ).toEqual([
      "Service breaking change",
      "UI change",
      "Bad data",
      "Test bug",
      "Infrastructure",
      "Unknown",
    ]);
  });

  test("disables Jira creation for covered, busy, and unconfigured clusters", () => {
    expect(automationClusterActionState(cluster("new")).ticket.disabled).toBe(false);
    expect(
      automationClusterActionState(cluster("creating", "untriaged", true)).ticket,
    ).toMatchObject({ disabled: true });
    expect(
      automationClusterActionState(cluster("ticketed", "ticketed")).ticket,
    ).toMatchObject({
      disabled: true,
      reason: "A Jira ticket already covers this cluster.",
    });
    expect(
      automationClusterActionState({
        ...cluster("new"),
        ticketRefusal: "Automation Jira ticketing is not configured.",
      }).ticket,
    ).toEqual({
      disabled: true,
      reason: "Automation Jira ticketing is not configured.",
    });
  });

  test("labels fresh, active, saved, and refused triage states", () => {
    expect(automationClusterActionState(cluster("fresh")).triage).toEqual({
      active: false,
      disabled: false,
      label: "Triage",
    });

    const active = { ...cluster("active"), aiTriageInFlight: true };
    expect(automationClusterActionState(active).triage).toMatchObject({
      active: true,
      disabled: true,
      label: "Triaging…",
    });

    const saved = {
      ...cluster("saved"),
      aiTriage: {
        verdict: "ui-change" as const,
        confidence: 0.86,
        rationale: "The UI changed.",
        recommendation: "Update the test.",
        taskRunId: "run-1",
        updatedAt: "2026-09-24T12:00:00.000Z",
      },
    };
    expect(automationClusterActionState(saved).triage).toEqual({
      active: false,
      disabled: false,
      label: "Re-run triage",
    });

    const refused = {
      ...cluster("refused"),
      aiTriageRefusal: "No Automation AI triage task is registered.",
    };
    expect(automationClusterActionState(refused).triage).toEqual({
      active: false,
      disabled: true,
      label: "Triage",
      reason: "No Automation AI triage task is registered.",
    });
  });
});
