import { describe, expect, test } from "bun:test";

import {
  datadogScanConfig,
  withDatadogScanConfig,
} from "../src/datadog-scan-params.ts";

describe("Datadog scan settings params", () => {
  test("reads saved scan and Jira ticket fields", () => {
    expect(
      datadogScanConfig({
        query: "status:error service:checkout",
        lookbackHours: 12,
        maxServices: 50,
        samplesPerService: 300,
        jira: {
          project: "TP",
          issueType: "Bug",
          assigneeMode: "fixed",
          assignee: "alice",
          labels: ["talos", "prod-regression"],
          bugFoundBy: "Automation",
          feBeUx: "BE",
          useActiveSprint: true,
          boardId: 21,
        },
      }),
    ).toEqual({
      query: "status:error service:checkout",
      lookbackHours: "12",
      servicePageSize: "50",
      samplesPerService: "300",
      jiraProject: "TP",
      issueType: "Bug",
      assigneeMode: "fixed",
      assignee: "alice",
      labels: ["talos", "prod-regression"],
      bugFoundBy: "Automation",
      feBeUx: "BE",
      useActiveSprint: true,
      boardId: "21",
    });
  });

  test("writes nested Jira params without discarding unrelated settings", () => {
    const params = withDatadogScanConfig(
      { unrelated: true, jira: { legacy: "kept" } },
      {
        query: "status:error",
        lookbackHours: "24",
        servicePageSize: "20",
        samplesPerService: "200",
        jiraProject: "tp",
        issueType: "Bug",
        assigneeMode: "automatic",
        assignee: "",
        labels: ["talos", "datadog"],
        bugFoundBy: "",
        feBeUx: "BE",
        useActiveSprint: false,
        boardId: "",
      },
    );

    expect(params).toMatchObject({
      unrelated: true,
      query: "status:error",
      lookbackHours: 24,
      maxServices: 20,
      samplesPerService: 200,
      jira: {
        legacy: "kept",
        project: "TP",
        issueType: "Bug",
        assigneeMode: "automatic",
        labels: ["talos", "datadog"],
        feBeUx: "BE",
        useActiveSprint: true,
      },
    });
    expect((params.jira as Record<string, unknown>).assignee).toBeUndefined();
    expect((params.jira as Record<string, unknown>).boardId).toBeUndefined();
  });
});
