import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type {
  AutomationPipelineSnapshot,
  AutomationSchedule,
  AutomationTestReportCounts,
} from "../src/application/ports.ts";
import {
  AUTOMATION_FAILURE_TEXT_MAX_BYTES,
  SqliteAutomationConfigStore,
  SqliteAutomationStore,
} from "../src/persistence/automation-store.ts";
import { migrate } from "../src/persistence/migrations.ts";

function harness() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  return {
    db,
    config: new SqliteAutomationConfigStore(db),
    store: new SqliteAutomationStore(db),
  };
}

const counts: AutomationTestReportCounts = {
  totalTime: 7.25,
  totalCount: 3,
  successCount: 1,
  failedCount: 1,
  skippedCount: 1,
  errorCount: 0,
};

function schedule(overrides: Partial<AutomationSchedule> = {}): AutomationSchedule {
  return {
    projectId: "42",
    scheduleId: 22,
    description: "Web portal tests",
    ref: "refs/heads/main",
    cron: "0 2 * * *",
    cronTimezone: "Europe/Sofia",
    nextRunAt: new Date("2026-09-25T02:00:00.000Z"),
    active: true,
    syncedAt: new Date("2026-09-24T02:05:00.000Z"),
    ...overrides,
  };
}

function pipeline(
  overrides: Partial<AutomationPipelineSnapshot> = {},
): AutomationPipelineSnapshot {
  return {
    projectId: "42",
    pipelineId: 9001,
    scheduleId: 22,
    status: "failed",
    ref: "main",
    sha: "0f1e2d3c",
    webUrl: "https://gitlab.example/acme/web/-/pipelines/9001",
    createdAt: new Date("2026-09-24T02:00:00.000Z"),
    updatedAt: new Date("2026-09-24T02:04:00.000Z"),
    startedAt: new Date("2026-09-24T02:00:05.000Z"),
    finishedAt: new Date("2026-09-24T02:04:00.000Z"),
    duration: 235,
    reportState: "complete",
    reportVersion: 2,
    report: { ...counts, suiteError: "one suite warning" },
    jobs: [
      {
        jobId: 501,
        name: "unit",
        stage: "test",
        status: "failed",
        failureReason: "script_failure",
        allowFailure: false,
        webUrl: "https://gitlab.example/jobs/501",
        duration: 20,
        report: counts,
      },
    ],
    suites: [
      {
        index: 0,
        name: "unit",
        buildIds: [501],
        ...counts,
      },
    ],
    failedTests: [
      {
        suiteIndex: 0,
        jobId: 501,
        status: "failed",
        name: "rejects an invalid card",
        classname: "checkout/payment.test.ts",
        executionTime: 0.25,
        systemOutput: "expected 400, got 500",
        stackTrace: "at checkout/payment.test.ts:42",
        testFile: "checkout/payment.test.ts",
        attachmentJobId: 501,
        attachmentPath: "screenshots/failure.png",
        attachmentName: "failure.png",
        signatureKey: "0123456789abcdef0123456789abcdef",
        signatureTitle: "AssertionFailure: expected 400, got 500",
      },
    ],
    ...overrides,
  };
}

describe("Automation config persistence", () => {
  test("round-trips schedules and optional Jira defaults in operator order", () => {
    const { db, config } = harness();
    expect(config.get()).toBeNull();

    config.set({
      projectId: "42",
      schedules: [
        {
          scheduleId: 90,
          displayName: "Nightly browser",
          autoRetry: { enabled: true, maxJobsPerPipeline: 5 },
        },
        { scheduleId: 12 },
        { scheduleId: 44, displayName: "API smoke" },
      ],
      jira: {
        projectKey: "TP",
        parentKey: "TP-100",
        issueType: "Bug",
        boardId: 21,
        useActiveSprint: true,
        labels: ["talos", "automation"],
        assigneeMode: "fixed",
        fixedAssignee: "alice@example.com",
      },
    });

    expect(config.get()).toEqual({
      projectId: "42",
      schedules: [
        {
          scheduleId: 90,
          displayName: "Nightly browser",
          autoRetry: { enabled: true, maxJobsPerPipeline: 5 },
        },
        {
          scheduleId: 12,
          autoRetry: { enabled: false, maxJobsPerPipeline: 3 },
        },
        {
          scheduleId: 44,
          displayName: "API smoke",
          autoRetry: { enabled: false, maxJobsPerPipeline: 3 },
        },
      ],
      jira: {
        projectKey: "TP",
        parentKey: "TP-100",
        issueType: "Bug",
        boardId: 21,
        useActiveSprint: true,
        labels: ["talos", "automation"],
        assigneeMode: "fixed",
        fixedAssignee: "alice@example.com",
      },
    });

    expect(() =>
      config.set({
        projectId: "would-not-stick",
        schedules: [{ scheduleId: 1 }],
        jira: {
          projectKey: "TP",
          issueType: "Bug",
          useActiveSprint: true,
          labels: ["duplicate", "duplicate"],
          assigneeMode: "automatic",
        },
      }),
    ).toThrow();
    expect(config.get()?.projectId).toBe("42");
    expect(config.get()?.schedules).toHaveLength(3);

    config.set({
      projectId: "84",
      schedules: [{ scheduleId: 7 }],
    });
    expect(config.get()).toEqual({
      projectId: "84",
      schedules: [
        {
          scheduleId: 7,
          autoRetry: { enabled: false, maxJobsPerPipeline: 3 },
        },
      ],
    });
    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM automation_jira_labels",
      ).get()?.count,
    ).toBe(0);
    db.close();
  });
});

describe("Automation snapshot persistence", () => {
  test("round-trips schedule and pipeline detail, replacing children idempotently", () => {
    const { db, store } = harness();
    store.upsertSchedule(schedule());
    store.recordPipeline(pipeline());

    expect(store.getPipeline("42", 9001)).toMatchObject({
      pipelineId: 9001,
      reportState: "complete",
      report: counts,
      jobs: [{ jobId: 501, report: counts }],
      suites: [{ index: 0, buildIds: [501] }],
      failedTests: [
        {
          name: "rejects an invalid card",
          caseIndex: 0,
          testFile: "checkout/payment.test.ts",
          attachmentJobId: 501,
          attachmentPath: "screenshots/failure.png",
          attachmentName: "failure.png",
          signatureKey: "0123456789abcdef0123456789abcdef",
        },
      ],
    });

    store.recordPipeline(
      pipeline({
        status: "success",
        reportState: "missing",
        report: undefined,
        jobs: [],
        suites: [
          {
            index: 1,
            name: "integration",
            buildIds: [777],
            ...counts,
            failedCount: 0,
          },
        ],
        failedTests: [],
      }),
    );

    expect(store.getPipeline("42", 9001)).toMatchObject({
      status: "success",
      reportState: "missing",
      jobs: [],
      suites: [{ index: 1, name: "integration" }],
      failedTests: [],
    });
    expect(store.getPipeline("42", 9001)?.report).toBeUndefined();
    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM automation_pipeline_test_suites",
      ).get()?.count,
    ).toBe(1);
    db.close();
  });

  test("lists and filters newest-first with a pipeline-id tie breaker", () => {
    const { db, store } = harness();
    store.upsertSchedule(schedule());
    store.upsertSchedule(schedule({ scheduleId: 23, description: "Smoke" }));
    store.recordPipeline(pipeline({ pipelineId: 1, status: "success" }));
    store.recordPipeline(
      pipeline({
        pipelineId: 3,
        scheduleId: 23,
        updatedAt: new Date("2026-09-25T02:04:00.000Z"),
      }),
    );
    store.recordPipeline(
      pipeline({
        pipelineId: 2,
        updatedAt: new Date("2026-09-25T02:04:00.000Z"),
      }),
    );

    expect(store.listPipelines({ projectId: "42" }).map((item) => item.pipelineId))
      .toEqual([3, 2, 1]);
    expect(
      store
        .listPipelines({ projectId: "42", scheduleId: 22, status: "failed" })
        .map((item) => item.pipelineId),
    ).toEqual([2]);
    expect(
      store
        .listPipelines({
          projectId: "42",
          from: new Date("2026-09-25T00:00:00.000Z"),
          to: new Date("2026-09-25T23:59:59.999Z"),
        })
        .map((item) => item.pipelineId),
    ).toEqual([3, 2]);
    expect(
      store
        .listPipelines({ projectId: "42", reportVersionBelow: 2 })
        .map((item) => item.pipelineId),
    ).toEqual([]);
    db.close();
  });

  test("returns a tie-safe latest cursor per project and schedule", () => {
    const { db, store } = harness();
    store.upsertSchedule(schedule());
    expect(store.latestUpdatedCursor("42", 22)).toBeNull();
    const updatedAt = new Date("2026-09-25T02:04:00.000Z");
    store.recordPipeline(pipeline({ pipelineId: 3, updatedAt }));
    store.recordPipeline(pipeline({ pipelineId: 8, updatedAt }));

    expect(store.latestUpdatedCursor("42", 22)).toEqual({
      updatedAt,
      pipelineId: 8,
    });
    db.close();
  });

  test("bounds failure output and stack trace before storage", () => {
    const { db, store } = harness();
    store.upsertSchedule(schedule());
    const tooLong = "🙂".repeat(AUTOMATION_FAILURE_TEXT_MAX_BYTES);
    store.recordPipeline(
      pipeline({
        failedTests: [
          {
            suiteIndex: 0,
            status: "error",
            name: "does not start",
            executionTime: 0,
            systemOutput: tooLong,
            stackTrace: tooLong,
            signatureKey: "error-key",
            signatureTitle: "TestError: does not start",
          },
        ],
      }),
    );

    const stored = store.getPipeline("42", 9001)!.failedTests[0]!;
    expect(new TextEncoder().encode(stored.systemOutput).byteLength).toBe(
      AUTOMATION_FAILURE_TEXT_MAX_BYTES,
    );
    expect(new TextEncoder().encode(stored.stackTrace).byteLength).toBe(
      AUTOMATION_FAILURE_TEXT_MAX_BYTES,
    );
    db.close();
  });

  test("marks schedules synced and pruning cascades to every pipeline child", () => {
    const { db, store } = harness();
    store.upsertSchedule(schedule());
    const syncedAt = new Date("2026-09-25T12:00:00.000Z");
    store.markScheduleSynced("42", 22, syncedAt);
    expect(store.listSchedules("42")[0]?.syncedAt).toEqual(syncedAt);

    store.recordPipeline(pipeline());
    expect(store.prune(new Date("2026-09-25T00:00:00.000Z"))).toBe(1);
    expect(store.getPipeline("42", 9001)).toBeUndefined();
    for (const table of [
      "automation_pipeline_jobs",
      "automation_pipeline_test_suites",
      "automation_pipeline_failed_tests",
    ]) {
      expect(
        db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()
          ?.count,
      ).toBe(0);
    }
    db.close();
  });
});

describe("Automation failure clusters", () => {
  test("groups, orders, paginates, searches, and filters without loading diagnostics", () => {
    const { db, store } = harness();
    store.upsertSchedule(schedule());
    store.recordPipeline(
      pipeline({
        jobs: [
          {
            jobId: 501,
            name: "browser chrome",
            stage: "test",
            status: "failed",
            allowFailure: false,
            webUrl: "https://gitlab.example/jobs/501",
          },
          {
            jobId: 502,
            name: "api integration",
            stage: "test",
            status: "failed",
            allowFailure: false,
            webUrl: "https://gitlab.example/jobs/502",
          },
        ],
        suites: [
          { index: 0, name: "browser", buildIds: [501], ...counts },
          { index: 1, name: "api", buildIds: [502], ...counts },
        ],
        failedTests: [
          {
            suiteIndex: 0,
            caseIndex: 0,
            jobId: 501,
            status: "failed",
            name: "checkout rejects card",
            classname: "CheckoutSpec",
            executionTime: 1,
            systemOutput: "large diagnostic A",
            signatureKey: "same-root",
            signatureTitle: "TypeError: service unavailable",
          },
          {
            suiteIndex: 1,
            caseIndex: 0,
            jobId: 502,
            status: "error",
            name: "invoice reports failure",
            classname: "InvoiceSpec",
            executionTime: 2,
            stackTrace: "large stack B",
            signatureKey: "same-root",
            signatureTitle: "TypeError: service unavailable",
          },
          {
            suiteIndex: 0,
            caseIndex: 1,
            jobId: 501,
            status: "failed",
            name: "login works",
            classname: "LoginSpec",
            executionTime: 1,
            systemOutput: "large diagnostic C",
            signatureKey: "other-root",
            signatureTitle: "AssertionError: login",
          },
        ],
      }),
    );

    const page = store.listFailureClusters({
      projectId: "42",
      pipelineId: 9001,
      limit: 1,
      offset: 0,
    });
    expect(page.total).toBe(2);
    expect(page.items).toEqual([
      expect.objectContaining({
        signatureKey: "same-root",
        severity: "error",
        occurrenceCount: 2,
        affectedTestCount: 2,
        jobIds: [501, 502],
        suiteIndexes: [0, 1],
        triageState: "untriaged",
      }),
    ]);
    expect(JSON.stringify(page)).not.toContain("large diagnostic");
    expect(page.facets.jobs).toEqual([
      { jobId: 502, name: "api integration", count: 1 },
      { jobId: 501, name: "browser chrome", count: 2 },
    ]);

    for (const options of [
      { search: "invoice" },
      { search: "INVOICESPEC" },
      { search: "api integration" },
      { jobId: 502 },
      { suiteIndex: 1 },
    ]) {
      expect(
        store.listFailureClusters({
          projectId: "42",
          pipelineId: 9001,
          limit: 50,
          offset: 0,
          ...options,
        }).items.map((item) => item.signatureKey),
      ).toEqual(["same-root"]);
    }

    const detail = store.getFailureCluster("42", 9001, "same-root", 1)!;
    expect(detail.members).toHaveLength(1);
    expect(detail.membersTruncated).toBe(true);
    expect(detail.representative).toEqual({
      suiteIndex: 1,
      caseIndex: 0,
      stackTrace: "large stack B",
    });
    db.close();
  });

  test("claims atomically, recovers stale work, releases failures, and persists links", () => {
    const { db, store } = harness();
    const now = new Date("2026-09-24T12:00:00.000Z");
    const staleBefore = new Date("2026-09-24T11:45:00.000Z");
    const first = store.claimFailureCluster(
      "42",
      22,
      "same-root",
      "identity-1",
      now,
      staleBefore,
    );
    expect(first).toMatchObject({ claimed: true, recovered: false });
    expect(
      store.claimFailureCluster(
        "42",
        22,
        "same-root",
        "identity-1",
        now,
        staleBefore,
      ),
    ).toMatchObject({ claimed: false, work: { state: "creating" } });

    const recoveredAt = new Date("2026-09-24T12:20:00.000Z");
    expect(
      store.claimFailureCluster(
        "42",
        22,
        "same-root",
        "identity-1",
        recoveredAt,
        new Date("2026-09-24T12:05:00.000Z"),
      ),
    ).toMatchObject({ claimed: true, recovered: true });
    expect(store.releaseFailureClusterClaim("42", 22, "same-root")).toBe(true);
    expect(store.getFailureClusterWork("42", 22, "same-root")).toBeUndefined();

    const ticket = store.recordFailureClusterTicket({
      projectId: "42",
      scheduleId: 22,
      signatureKey: "same-root",
      identity: "identity-1",
      jiraKey: "QA-123",
      jiraUrl: "https://jira.example/browse/QA-123",
      now,
    });
    expect(ticket).toMatchObject({ state: "ticketed", jiraKey: "QA-123" });
    const mr = store.recordFailureClusterMr({
      projectId: "42",
      scheduleId: 22,
      signatureKey: "same-root",
      identity: "identity-1",
      jiraKey: "QA-123",
      jiraUrl: "https://jira.example/browse/QA-123",
      mrIid: 77,
      mrUrl: "https://gitlab.example/acme/tests/-/merge_requests/77",
      now,
    });
    expect(mr).toMatchObject({
      state: "active-mr",
      jiraKey: "QA-123",
      mrIid: 77,
    });
    const downgraded = store.clearFailureClusterMr(
      "42",
      22,
      "same-root",
      new Date("2026-09-24T13:00:00.000Z"),
    );
    expect(downgraded).toMatchObject({
      state: "ticketed",
      jiraKey: "QA-123",
    });
    expect(downgraded?.mrIid).toBeUndefined();
    expect(store.releaseFailureClusterClaim("42", 22, "same-root")).toBe(false);
    db.close();
  });
});

describe("Automation failure inbox and job retries", () => {
  test("keeps idempotent cross-pipeline history and distinguishes current failures", () => {
    const { db, store } = harness();
    store.upsertSchedule(schedule());
    const first = pipeline();
    store.recordPipeline(first);
    store.recordPipeline(first);

    store.recordPipeline(
      pipeline({
        pipelineId: 9002,
        updatedAt: new Date("2026-09-25T02:04:00.000Z"),
        webUrl: "https://gitlab.example/acme/web/-/pipelines/9002",
      }),
    );
    const options = {
      projectId: "42",
      scheduleIds: [22],
      from: new Date("2026-09-20T00:00:00.000Z"),
      presence: "current" as const,
      limit: 25,
      offset: 0,
    };
    expect(store.listFailureInbox(options).items[0]).toMatchObject({
      signatureKey: "0123456789abcdef0123456789abcdef",
      pipelineCount: 2,
      latestPipelineId: 9002,
      current: true,
    });

    store.recordPipeline(
      pipeline({
        pipelineId: 9003,
        status: "success",
        updatedAt: new Date("2026-09-26T02:04:00.000Z"),
        webUrl: "https://gitlab.example/acme/web/-/pipelines/9003",
        report: {
          totalTime: 2,
          totalCount: 2,
          successCount: 2,
          failedCount: 0,
          skippedCount: 0,
          errorCount: 0,
        },
        failedTests: [],
      }),
    );
    expect(store.listFailureInbox(options).total).toBe(0);
    expect(
      store.listFailureInbox({ ...options, presence: "recent" }).items[0],
    ).toMatchObject({
      pipelineCount: 2,
      current: false,
    });
    store.prune(new Date("2026-09-27T00:00:00.000Z"));
    expect(
      store.listFailureInbox({ ...options, presence: "recent" }).total,
    ).toBe(1);
    db.close();
  });

  test("claims one retry wave and records per-job outcomes", () => {
    const { db, store } = harness();
    const claimed = store.claimJobRetryWave({
      projectId: "42",
      pipelineId: 9001,
      scheduleId: 22,
      executionId: "run-1",
      jobs: [
        { jobId: 501, name: "browser" },
        { jobId: 502, name: "api" },
      ],
      now: new Date("2026-09-24T12:00:00.000Z"),
    });
    expect(claimed).toBe(true);
    expect(
      store.claimJobRetryWave({
        projectId: "42",
        pipelineId: 9001,
        scheduleId: 22,
        executionId: "run-2",
        jobs: [{ jobId: 503, name: "again" }],
        now: new Date("2026-09-24T12:01:00.000Z"),
      }),
    ).toBe(false);
    store.recordJobRetryAttemptResult({
      projectId: "42",
      pipelineId: 9001,
      sourceJobId: 501,
      retryJobId: 601,
      retryJobUrl: "https://gitlab.example/jobs/601",
      now: new Date("2026-09-24T12:02:00.000Z"),
    });
    store.recordJobRetryAttemptResult({
      projectId: "42",
      pipelineId: 9001,
      sourceJobId: 502,
      error: "forbidden",
      now: new Date("2026-09-24T12:02:00.000Z"),
    });
    store.completeJobRetryWave({
      projectId: "42",
      pipelineId: 9001,
      state: "partial",
      error: "api: forbidden",
      now: new Date("2026-09-24T12:03:00.000Z"),
    });
    expect(store.getJobRetryWave("42", 9001)).toMatchObject({
      state: "partial",
      attempts: [
        { sourceJobId: 501, status: "accepted", retryJobId: 601 },
        { sourceJobId: 502, status: "failed", error: "forbidden" },
      ],
    });
    db.close();
  });
});
