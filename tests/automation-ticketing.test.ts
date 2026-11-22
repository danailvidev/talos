import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  AutomationTicketService,
  automationClusterIdentity,
  automationFingerprintLabel,
  automationFingerprintMarker,
  automationPipelineIdentity,
} from "../src/application/automation-ticketing.ts";
import type {
  AutomationConfig,
  AutomationPipelineSnapshot,
} from "../src/application/ports.ts";
import { adfToText } from "../src/connectors/jira/adf.ts";
import {
  SqliteAutomationConfigStore,
  SqliteAutomationStore,
} from "../src/persistence/automation-store.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteAutomationAiTriageStore } from "../src/persistence/automation-ai-triage-store.ts";

const SIGNATURE = "0123456789abcdef0123456789abcdef";

function harness(configOverrides: Partial<AutomationConfig> = {}) {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  const config = new SqliteAutomationConfigStore(db);
  const automation = new SqliteAutomationStore(db);
  const aiTriage = new SqliteAutomationAiTriageStore(db);
  config.set({
    projectId: "42",
    schedules: [{ scheduleId: 22, displayName: "Nightly browser" }],
    jira: {
      projectKey: "QA",
      issueType: "Bug",
      useActiveSprint: true,
      labels: ["talos", "automation"],
      assigneeMode: "automatic",
    },
    ...configOverrides,
  });
  automation.upsertSchedule({
    projectId: "42",
    scheduleId: 22,
    description: "Nightly browser tests",
    ref: "main",
    active: true,
    syncedAt: new Date("2026-09-24T02:05:00.000Z"),
  });
  automation.recordPipeline(pipeline());
  return { db, config, automation, aiTriage };
}

function pipeline(): AutomationPipelineSnapshot {
  return {
    projectId: "42",
    pipelineId: 9001,
    scheduleId: 22,
    status: "failed",
    ref: "main",
    sha: "abc123",
    webUrl: "https://gitlab.example/acme/tests/-/pipelines/9001",
    updatedAt: new Date("2026-09-24T02:04:00.000Z"),
    reportState: "complete",
    reportVersion: 2,
    jobs: [
      {
        jobId: 501,
        name: "browser chrome",
        stage: "test",
        status: "failed",
        allowFailure: false,
        webUrl: "https://gitlab.example/acme/tests/-/jobs/501",
      },
    ],
    suites: [
      {
        index: 0,
        name: "browser",
        buildIds: [501],
        totalTime: 2,
        totalCount: 2,
        successCount: 0,
        failedCount: 2,
        skippedCount: 0,
        errorCount: 0,
      },
    ],
    failedTests: [
      {
        suiteIndex: 0,
        caseIndex: 0,
        jobId: 501,
        status: "failed",
        name: "rejects an invalid card",
        classname: "CheckoutSpec",
        executionTime: 1,
        systemOutput: "expected 400, got 500",
        stackTrace: "at checkout/payment.test.ts:42",
        attachmentJobId: 501,
        attachmentPath: "screenshots/failure shot.png",
        attachmentName: "failure shot.png",
        signatureKey: SIGNATURE,
        signatureTitle: "AssertionFailure: expected 400, got 500",
      },
      {
        suiteIndex: 0,
        caseIndex: 1,
        jobId: 501,
        status: "failed",
        name: "reports the checkout error",
        classname: "CheckoutApiSpec",
        executionTime: 1,
        signatureKey: SIGNATURE,
        signatureTitle: "AssertionFailure: expected 400, got 500",
      },
    ],
  };
}

function jiraStub(overrides: Record<string, unknown> = {}) {
  const creates: any[] = [];
  const stub = {
    creates,
    myself: async () => ({ accountId: "integration-account" }),
    accountIdForEmail: async (email: string) => `resolved:${email}`,
    resolveActiveSprint: async () => ({
      reason: "board 7 has no active sprint",
    }),
    searchIssues: async () => [],
    createIssue: async (input: unknown) => {
      creates.push(input);
      return { id: "100", key: "QA-100", self: "https://jira.test/issue/100" };
    },
    issueUrl: (key: string) => `https://jira.test/browse/${key}`,
    ...overrides,
  };
  return stub;
}

function gitlabStub(mergeRequests: any[] = []) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    listMergeRequests: async () => {
      calls += 1;
      return mergeRequests;
    },
  };
}

function mergeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    iid: 7,
    project_id: 42,
    title: "Fix nightly failure",
    state: "opened",
    source_branch: "fix/nightly",
    target_branch: "main",
    web_url: "https://gitlab.example/acme/tests/-/merge_requests/7",
    updated_at: new Date("2026-09-24T03:00:00.000Z"),
    description: "",
    ...overrides,
  };
}

function service(
  stores: ReturnType<typeof harness>,
  jira: ReturnType<typeof jiraStub>,
  gitlab = gitlabStub(),
) {
  return new AutomationTicketService({
    config: stores.config,
    automation: stores.automation,
    aiTriage: stores.aiTriage,
    jira: () => jira as any,
    gitlab: () => gitlab as any,
    now: () => new Date("2026-09-24T12:00:00.000Z"),
  });
}

describe("Automation ticket action", () => {
  test("creates a descriptive ADF issue with automatic assignee and explicit backlog fallback", async () => {
    const stores = harness();
    const jira = jiraStub();
    const result = await service(stores, jira).ticket(9001, SIGNATURE);

    expect(result).toMatchObject({
      action: "created",
      jiraKey: "QA-100",
      sprint: {
        applied: false,
        fallbackReason: "board 7 has no active sprint",
      },
    });
    expect(jira.creates).toHaveLength(1);
    const input = jira.creates[0]!;
    expect(input).toMatchObject({
      projectKey: "QA",
      issueType: "Bug",
      assigneeAccountId: "integration-account",
      labels: [
        "talos",
        "automation",
        automationFingerprintLabel(
          automationClusterIdentity("42", 22, SIGNATURE),
        ),
      ],
    });
    expect(input.sprintId).toBeUndefined();
    const text = adfToText(input.description);
    expect(text).toContain("Nightly browser");
    expect(text).toContain("2 distinct test(s)");
    expect(text).toContain("CheckoutSpec · rejects an invalid card");
    expect(text).toContain("expected 400, got 500");
    expect(text).toContain("Pipeline #9001");
    expect(JSON.stringify(input.description)).toContain(
      "https://gitlab.example/acme/tests/-/jobs/501/artifacts/file/" +
        "screenshots/failure%20shot.png",
    );
    expect(text).toContain(
      automationFingerprintMarker(
        automationClusterIdentity("42", 22, SIGNATURE),
      ),
    );
    stores.db.close();
  });

  test("previews defaults and preserves diagnostics around reviewed ticket fields", async () => {
    const stores = harness({
      jira: {
        projectKey: "QA",
        parentKey: "QA-10",
        issueType: "Bug",
        useActiveSprint: false,
        labels: ["talos"],
        assigneeMode: "automatic",
      },
    });
    const jira = jiraStub();
    const ticketing = service(stores, jira);

    expect(ticketing.draft(9001, SIGNATURE)).toMatchObject({
      projectKey: "QA",
      parentKey: "QA-10",
      summary: "[Automation · Nightly browser] AssertionFailure: expected 400, got 500",
      description: expect.stringContaining("2 distinct test(s)"),
    });

    await ticketing.ticket(9001, SIGNATURE, {
      summary: "Reviewed failure title",
      description: "Customer-visible checkout regression.",
      parentKey: "QA-20",
    });

    expect(jira.creates[0]).toMatchObject({
      projectKey: "QA",
      parentKey: "QA-20",
      summary: "Reviewed failure title",
    });
    const text = adfToText(jira.creates[0]!.description);
    expect(text).toContain("Customer-visible checkout regression.");
    expect(text).toContain("CheckoutSpec · rejects an invalid card");
    expect(text).toContain("talos-automation-fingerprint");
    stores.db.close();
  });

  test("resolves a fixed email assignee and applies an active sprint", async () => {
    const stores = harness({
      jira: {
        projectKey: "QA",
        issueType: "Task",
        boardId: 9,
        useActiveSprint: true,
        labels: [],
        assigneeMode: "fixed",
        fixedAssignee: "qa@example.com",
      },
    });
    const jira = jiraStub({
      resolveActiveSprint: async (input: unknown) => {
        expect(input).toMatchObject({ projectKey: "QA", boardId: 9 });
        return { sprint: { id: 88, name: "Sprint 88" } };
      },
    });
    const result = await service(stores, jira).ticket(9001, SIGNATURE);

    expect(result.sprint).toEqual({ applied: true });
    expect(jira.creates[0]).toMatchObject({
      issueType: "Task",
      assigneeAccountId: "resolved:qa@example.com",
      sprintId: 88,
    });
    stores.db.close();
  });

  test("includes a current AI triage result in a subsequently created Jira description", async () => {
    const stores = harness();
    stores.aiTriage.record({
      projectId: "42",
      scheduleId: 22,
      signatureKey: SIGNATURE,
      signature: "AssertionFailure: expected 400, got 500",
      verdict: "service-breaking-change",
      confidence: 0.94,
      rationale: "The service response no longer contains the asserted field.",
      recommendation: "Confirm the API contract before updating the test.",
      taskRunId: "triage-run",
    });
    const jira = jiraStub();
    await service(stores, jira).ticket(9001, SIGNATURE);

    const text = adfToText(jira.creates[0]!.description);
    expect(text).toContain("AI triage");
    expect(text).toContain("Verdict: service-breaking-change");
    expect(text).toContain("Confidence: 94%");
    expect(text).toContain(
      "Rationale: The service response no longer contains the asserted field.",
    );
    expect(text).toContain(
      "Recommendation: Confirm the API contract before updating the test.",
    );
    stores.db.close();
  });

  test("adopts Jira by deterministic label without creating", async () => {
    const stores = harness();
    const jira = jiraStub({
      searchIssues: async (jql: string) => {
        expect(jql).toContain(
          automationFingerprintLabel(
            automationClusterIdentity("42", 22, SIGNATURE),
          ),
        );
        return [{ key: "QA-55", fields: {} }];
      },
    });
    const result = await service(stores, jira).ticket(9001, SIGNATURE);

    expect(result).toMatchObject({ action: "adopted", jiraKey: "QA-55" });
    expect(jira.creates).toHaveLength(0);
    expect(
      stores.automation.getFailureClusterWork("42", 22, SIGNATURE),
    ).toMatchObject({ state: "ticketed", jiraKey: "QA-55" });
    stores.db.close();
  });

  test("blocks creation only for an exact marker or linked Jira key", async () => {
    const stores = harness();
    const identity = automationClusterIdentity("42", 22, SIGNATURE);
    const similar = mergeRequest({
      iid: 6,
      title: "Fix rejects an invalid card",
      description: "A similarly named test, with no authoritative marker.",
    });
    const marker = mergeRequest({
      iid: 7,
      description: `Root cause\n${automationFingerprintMarker(identity)}`,
    });
    const jira = jiraStub();
    const result = await service(
      stores,
      jira,
      gitlabStub([similar, marker]),
    ).ticket(9001, SIGNATURE);

    expect(result).toMatchObject({
      action: "active-mr",
      mrIid: 7,
      mrUrl: marker.web_url,
    });
    expect(jira.creates).toHaveLength(0);
    const afterMarkerClosed = await service(
      stores,
      jiraStub(),
      gitlabStub([]),
    ).ticket(9001, SIGNATURE);
    expect(afterMarkerClosed.action).toBe("created");

    const storesByKey = harness();
    storesByKey.automation.recordFailureClusterTicket({
      projectId: "42",
      scheduleId: 22,
      signatureKey: SIGNATURE,
      identity,
      jiraKey: "QA-321",
      jiraUrl: "https://jira.test/browse/QA-321",
      now: new Date(),
    });
    const keyMr = mergeRequest({
      iid: 8,
      source_branch: "fix/QA-321-checkout",
    });
    const keyResult = await service(
      storesByKey,
      jiraStub(),
      gitlabStub([similar, keyMr]),
    ).ticket(9001, SIGNATURE);
    expect(keyResult).toMatchObject({ action: "active-mr", mrIid: 8 });
    const afterKeyMrClosed = await service(
      storesByKey,
      jiraStub(),
      gitlabStub([]),
    ).ticket(9001, SIGNATURE);
    expect(afterKeyMrClosed).toMatchObject({
      action: "existing-ticket",
      jiraKey: "QA-321",
    });
    stores.db.close();
    storesByKey.db.close();
  });

  test("a similar test name alone is not an MR match", async () => {
    const stores = harness();
    const jira = jiraStub();
    const result = await service(
      stores,
      jira,
      gitlabStub([
        mergeRequest({
          title: "Fix rejects an invalid card",
          source_branch: "fix/checkout-test",
        }),
      ]),
    ).ticket(9001, SIGNATURE);

    expect(result.action).toBe("created");
    expect(jira.creates).toHaveLength(1);
    stores.db.close();
  });

  test("concurrent actions share the claim and perform one external write", async () => {
    const stores = harness();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let searches = 0;
    const jira = jiraStub({
      searchIssues: async () => {
        searches += 1;
        entered.resolve();
        await release.promise;
        return [];
      },
    });
    const ticketing = service(stores, jira);

    const first = ticketing.ticket(9001, SIGNATURE);
    await entered.promise;
    const second = await ticketing.ticket(9001, SIGNATURE);
    expect(second.action).toBe("creating");
    release.resolve();
    expect((await first).action).toBe("created");
    expect(searches).toBe(1);
    expect(jira.creates).toHaveLength(1);
    stores.db.close();
  });

  test("releases a failed create without retrying and allows safe recovery", async () => {
    const stores = harness();
    let attempts = 0;
    const jira = jiraStub({
      createIssue: async () => {
        attempts += 1;
        throw new Error("Jira unavailable");
      },
    });
    await expect(service(stores, jira).ticket(9001, SIGNATURE)).rejects.toThrow(
      "Jira unavailable",
    );
    expect(attempts).toBe(1);
    expect(
      stores.automation.getFailureClusterWork("42", 22, SIGNATURE),
    ).toBeUndefined();

    const recovered = await service(stores, jiraStub()).ticket(9001, SIGNATURE);
    expect(recovered.action).toBe("created");
    stores.db.close();
  });

  test("bulk selection creates one pipeline ticket listing every selected failed test", async () => {
    const stores = harness();
    const snapshot = pipeline();
    snapshot.failedTests.push({
      suiteIndex: 0,
      caseIndex: 2,
      jobId: 501,
      status: "failed",
      name: "another independent failure",
      executionTime: 1,
      signatureKey: "second-signature",
      signatureTitle: "TimeoutError: independent",
    });
    stores.automation.recordPipeline(snapshot);
    const gitlab = gitlabStub();
    const jira = jiraStub();
    const outcomes = await service(stores, jira, gitlab).ticketBulk(
      9001,
      [SIGNATURE, "second-signature"],
    );

    expect(gitlab.calls).toBe(1);
    expect(outcomes).toHaveLength(2);
    expect(outcomes).toEqual([
      expect.objectContaining({
        signatureKey: SIGNATURE,
        ok: true,
        result: expect.objectContaining({ action: "created", jiraKey: "QA-100" }),
      }),
      expect.objectContaining({
        signatureKey: "second-signature",
        ok: true,
        result: expect.objectContaining({ action: "created", jiraKey: "QA-100" }),
      }),
    ]);
    expect(jira.creates).toHaveLength(1);
    expect(jira.creates[0]!.labels).toContain(
      automationFingerprintLabel(automationPipelineIdentity("42", 22, 9001)),
    );
    const text = adfToText(jira.creates[0]!.description);
    expect(text).toContain("CheckoutSpec · rejects an invalid card");
    expect(text).toContain("another independent failure");
    expect(text).toContain("Pipeline #9001");
    expect(
      stores.automation.getFailureClusterWork("42", 22, "second-signature"),
    ).toMatchObject({ state: "ticketed", jiraKey: "QA-100" });

    const repeated = await service(stores, jira, gitlab).ticketBulk(
      9001,
      ["second-signature"],
    );
    expect(repeated[0]).toMatchObject({
      ok: true,
      result: { action: "existing-ticket", jiraKey: "QA-100" },
    });
    expect(jira.creates).toHaveLength(1);
    stores.db.close();
  });
});
