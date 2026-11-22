import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";

import type { TaskConnectorFactory } from "../src/application/gateways.ts";
import type { AutomationPipelineSnapshot } from "../src/application/ports.ts";
import { GitLabClient } from "../src/connectors/gitlab/client.ts";
import type { TaskContext } from "../src/core/task.ts";
import { createLogger } from "../src/logging/logger.ts";
import {
  SqliteAutomationConfigStore,
  SqliteAutomationStore,
} from "../src/persistence/automation-store.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { MemoryStateStore } from "../src/persistence/state-store.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import {
  AUTOMATION_REPORT_SYNC_DEFAULT_CRON,
  createAutomationReportSyncTask,
} from "../src/tasks/automation-report-sync/index.ts";
import {
  AUTOMATION_REPORT_VERSION,
  failureSignature,
  safeAttachment,
} from "../src/tasks/automation-report-sync/failure-details.ts";
import { FakeHttp, type Route } from "./fixtures/http.ts";
import {
  PIPELINE_SCHEDULE_DETAIL,
  PIPELINE_TEST_REPORT,
  PIPELINE_TEST_REPORT_SUMMARY,
  job,
  pipeline,
} from "./fixtures/gitlab.ts";

const BASE = "https://gitlab.test/api/v4";
const PROJECT = "42";
const SCHEDULE = 22;

function context(maxItemsPerRun = 10): TaskContext {
  return {
    taskId: "automation-report-sync",
    executionId: crypto.randomUUID(),
    logger: createLogger({
      destination: new PassThrough(),
      pretty: false,
      level: "fatal",
    }),
    state: new MemoryStateStore(),
    secrets: new EnvSecretStore({}),
    dryRun: false,
    maxItemsPerRun,
    force: false,
    signal: new AbortController().signal,
    llm: { provider: "anthropic", maxTokens: 2048 },
    prompts: {},
    step: async (_id, fn) => fn(),
  };
}

function harness(routes: Route[], maxItemsPerRun = 10) {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  const config = new SqliteAutomationConfigStore(db);
  const automation = new SqliteAutomationStore(db);
  config.set({ projectId: PROJECT, schedules: [{ scheduleId: SCHEDULE }] });
  const http = new FakeHttp(routes);
  const gitlab = new GitLabClient({
    token: "glpat-test",
    baseUrl: BASE,
    fetch: http.fetch,
  });
  const connectors = {
    gitlab: () => gitlab,
  } as unknown as TaskConnectorFactory;
  const task = createAutomationReportSyncTask({
    connectors,
    automationConfig: config,
    automation,
  });
  return {
    db,
    config,
    automation,
    http,
    task,
    ctx: context(maxItemsPerRun),
  };
}

function scheduleRoute(): Route {
  return {
    match: `/api/v4/projects/${PROJECT}/pipeline_schedules/${SCHEDULE}`,
    respond: { json: PIPELINE_SCHEDULE_DETAIL },
  };
}

function pipelineRoutes(options: {
  pipelines: unknown[];
  details?: Record<number, unknown>;
  jobs?: Record<number, unknown[]>;
  summary?: Route["respond"];
  full?: Route["respond"];
}): Route[] {
  const routes: Route[] = [
    scheduleRoute(),
    {
      match: `/api/v4/projects/${PROJECT}/pipeline_schedules/${SCHEDULE}/pipelines`,
      respond: { json: options.pipelines },
    },
    {
      match: /\/api\/v4\/projects\/42\/pipelines\/\d+$/,
      respond: (call) => {
        const id = Number(call.url.pathname.match(/pipelines\/(\d+)$/)?.[1]);
        return {
          json:
            options.details?.[id] ??
            pipeline({
              id,
              status: "success",
              source: "schedule",
              duration: 20,
              started_at: "2026-09-24T02:00:01.000Z",
              finished_at: "2026-09-24T02:00:20.000Z",
            }),
        };
      },
    },
    {
      match: /\/api\/v4\/projects\/42\/pipelines\/\d+\/jobs$/,
      respond: (call) => {
        const id = Number(call.url.pathname.match(/pipelines\/(\d+)\/jobs$/)?.[1]);
        return { json: options.jobs?.[id] ?? [] };
      },
    },
  ];
  if (options.summary) {
    routes.push({
      match: /\/api\/v4\/projects\/42\/pipelines\/\d+\/test_report_summary$/,
      respond: options.summary,
    });
  }
  if (options.full) {
    routes.push({
      match: /\/api\/v4\/projects\/42\/pipelines\/\d+\/test_report$/,
      respond: options.full,
    });
  }
  return routes;
}

function multiScheduleRoutes(): Route[] {
  return [
    {
      match: /\/api\/v4\/projects\/42\/pipeline_schedules\/\d+$/,
      respond: (call) => {
        const scheduleId = Number(call.url.pathname.match(/pipeline_schedules\/(\d+)$/)?.[1]);
        return {
          json: {
            ...PIPELINE_SCHEDULE_DETAIL,
            id: scheduleId,
            description: `Schedule ${scheduleId}`,
          },
        };
      },
    },
    {
      match: /\/api\/v4\/projects\/42\/pipeline_schedules\/\d+\/pipelines$/,
      respond: (call) => {
        const scheduleId = Number(
          call.url.pathname.match(/pipeline_schedules\/(\d+)\/pipelines$/)?.[1],
        );
        return {
          json: [
            pipeline({
              id: scheduleId * 100,
              status: "success",
              source: "schedule",
              updated_at: new Date(Date.now() - scheduleId * 1_000).toISOString(),
            }),
          ],
        };
      },
    },
    {
      match: /\/api\/v4\/projects\/42\/pipelines\/\d+$/,
      respond: (call) => {
        const pipelineId = Number(call.url.pathname.match(/pipelines\/(\d+)$/)?.[1]);
        return {
          json: pipeline({
            id: pipelineId,
            status: "success",
            source: "schedule",
          }),
        };
      },
    },
    {
      match: /\/api\/v4\/projects\/42\/pipelines\/\d+\/jobs$/,
      respond: { json: [] },
    },
    {
      match: /\/api\/v4\/projects\/42\/pipelines\/\d+\/test_report_summary$/,
      respond: { json: EMPTY_SUMMARY },
    },
  ];
}

const EMPTY_SUMMARY = {
  total: {
    time: 0,
    count: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    error: 0,
    suite_error: null,
  },
  test_suites: [],
};

describe("Automation report sync", () => {
  test("is a built-in ten-minute loop and fails clearly without configuration", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const task = createAutomationReportSyncTask({
      connectors: {} as TaskConnectorFactory,
      automationConfig: new SqliteAutomationConfigStore(db),
      automation: new SqliteAutomationStore(db),
    });

    expect(task.defaultTrigger).toEqual({
      type: "cron",
      expression: AUTOMATION_REPORT_SYNC_DEFAULT_CRON,
    });
    await expect(task.run(context(), {})).rejects.toThrow(
      "requires an instance Automation configuration",
    );
    db.close();
  });

  test("uses a 30-day initial bound and stores terminal success atomically", async () => {
    const updatedAt = new Date(Date.now() - 60_000);
    const h = harness(
      pipelineRoutes({
        pipelines: [
          pipeline({
            status: "success",
            source: "schedule",
            updated_at: updatedAt.toISOString(),
          }),
        ],
        summary: { json: EMPTY_SUMMARY },
      }),
    );

    const result = await h.task.run(h.ctx, {});
    const listCall = h.http.callsTo(`/pipeline_schedules/${SCHEDULE}/pipelines`)[0]!;
    const lower = new Date(listCall.url.searchParams.get("updated_after")!);
    const upper = new Date(listCall.url.searchParams.get("updated_before")!);

    expect(Date.now() - lower.getTime()).toBeGreaterThan(
      30 * 86_400_000 - 5_000,
    );
    expect(Date.now() - lower.getTime()).toBeLessThan(
      30 * 86_400_000 + 5_000,
    );
    expect(Math.abs(Date.now() - upper.getTime())).toBeLessThan(5_000);
    expect(result).toMatchObject({ itemsProcessed: 1, itemsFailed: 0 });
    expect(h.automation.getPipeline(PROJECT, 9001)).toMatchObject({
      status: "success",
      reportState: "complete",
      report: { totalCount: 0 },
      jobs: [],
      suites: [],
    });
    expect(h.automation.listSchedules(PROJECT)[0]).toMatchObject({
      cron: "0 2 * * *",
      cronTimezone: "UTC",
      active: true,
    });
    h.db.close();
  });

  test("ignores non-scheduled pipelines even if GitLab returns them from a schedule endpoint", async () => {
    const h = harness(
      pipelineRoutes({
        pipelines: [
          pipeline({
            status: "success",
            source: "merge_request_event",
          }),
        ],
      }),
    );

    const result = await h.task.run(h.ctx, {});

    expect(result).toMatchObject({ itemsSeen: 0, itemsProcessed: 0 });
    expect(h.automation.getPipeline(PROJECT, 9001)).toBeUndefined();
    expect(
      h.http.calls.filter((call) =>
        call.url.pathname.endsWith("/pipelines/9001"),
      ),
    ).toHaveLength(0);
    h.db.close();
  });

  test("does not fetch or add an unchanged completed pipeline twice", async () => {
    const updatedAt = new Date(Date.now() - 60_000);
    const h = harness(
      pipelineRoutes({
        pipelines: [
          pipeline({
            status: "success",
            source: "schedule",
            updated_at: updatedAt.toISOString(),
          }),
        ],
        summary: { json: EMPTY_SUMMARY },
      }),
    );

    const first = await h.task.run(h.ctx, {});
    const second = await h.task.run(h.ctx, {});

    expect(first.itemsProcessed).toBe(1);
    expect(second.itemsProcessed).toBe(0);
    expect(
      h.http.calls.filter(
        (call) => call.url.pathname === `/api/v4/projects/${PROJECT}/pipelines/9001`,
      ),
    ).toHaveLength(1);
    expect(
      h.http.calls.filter((call) =>
        call.url.pathname.endsWith("/pipelines/9001/test_report_summary"),
      ),
    ).toHaveLength(1);
    expect(
      h.db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM automation_pipelines WHERE pipeline_id = 9001",
      ).get()?.count,
    ).toBe(1);
    h.db.close();
  });

  test("maps failed cases and aggregates multiple suites onto their job", async () => {
    const summary = {
      ...PIPELINE_TEST_REPORT_SUMMARY,
      total: {
        ...PIPELINE_TEST_REPORT_SUMMARY.total,
        count: 4,
        failed: 2,
      },
      test_suites: [
        PIPELINE_TEST_REPORT_SUMMARY.test_suites[0],
        {
          ...PIPELINE_TEST_REPORT_SUMMARY.test_suites[0],
          name: "integration",
          total_time: 2,
          total_count: 1,
          success_count: 0,
          failed_count: 1,
        },
      ],
    };
    const full = {
      ...PIPELINE_TEST_REPORT,
      test_suites: [
        PIPELINE_TEST_REPORT.test_suites[0],
        {
          ...PIPELINE_TEST_REPORT.test_suites[0],
          name: "integration",
          test_cases: [
            {
              status: "error",
              name: "starts the service",
              classname: "smoke",
              execution_time: 0,
              system_output: "boot failed",
              stack_trace: null,
            },
          ],
        },
      ],
    };
    const h = harness(
      pipelineRoutes({
        pipelines: [pipeline({ status: "failed", source: "schedule" })],
        details: {
          9001: pipeline({
            id: 9001,
            status: "failed",
            source: "schedule",
            duration: 20,
          }),
        },
        jobs: { 9001: [job()] },
        summary: { json: summary },
        full: { json: full },
      }),
    );

    await h.task.run(h.ctx, {});
    const stored = h.automation.getPipeline(PROJECT, 9001)!;

    expect(stored.reportState).toBe("complete");
    expect(stored.jobs[0]?.report).toMatchObject({
      totalCount: 4,
      failedCount: 2,
      totalTime: 9.25,
    });
    expect(stored.failedTests).toEqual([
      expect.objectContaining({
        suiteIndex: 0,
        jobId: 7001,
        status: "failed",
        name: "applies a percentage discount",
      }),
      expect.objectContaining({
        suiteIndex: 1,
        jobId: 7001,
        status: "error",
        name: "starts the service",
      }),
    ]);
    h.db.close();
  });

  test("stores only validated real-shaped failure attachments and normalized signatures", async () => {
    const jobId = 16_698_778_194;
    const projectUrl = "https://gitlab.com/example-org/qa/test-automation";
    const summary = {
      ...PIPELINE_TEST_REPORT_SUMMARY,
      test_suites: [
        {
          ...PIPELINE_TEST_REPORT_SUMMARY.test_suites[0],
          build_ids: [jobId],
        },
      ],
    };
    const full = {
      ...PIPELINE_TEST_REPORT,
      test_suites: [
        {
          ...PIPELINE_TEST_REPORT.test_suites[0],
          test_cases: [
            {
              ...PIPELINE_TEST_REPORT.test_suites[0]!.test_cases[0],
              file: "web/tests/checkout.test.ts",
              attachment_url:
                `${projectUrl}/-/jobs/${jobId}/artifacts/file/` +
                "web/target/screenshots/foo.png?job_token=must-not-be-stored",
              stack_trace:
                "AssertionError: locator('#checkout') timed out for request 123456\n" +
                "    at checkout (/builds/group/project/web/tests/checkout.test.ts:41:29)",
            },
          ],
        },
      ],
    };
    const h = harness(
      pipelineRoutes({
        pipelines: [
          pipeline({
            status: "failed",
            source: "schedule",
            web_url: `${projectUrl}/-/pipelines/9001`,
          }),
        ],
        details: {
          9001: pipeline({
            status: "failed",
            source: "schedule",
            web_url: `${projectUrl}/-/pipelines/9001`,
          }),
        },
        jobs: {
          9001: [
            job({
              id: jobId,
              web_url: `${projectUrl}/-/jobs/${jobId}`,
            }),
          ],
        },
        summary: { json: summary },
        full: { json: full },
      }),
    );

    await h.task.run(h.ctx, {});

    const stored = h.automation.getPipeline(PROJECT, 9001)!;
    expect(stored.reportVersion).toBe(AUTOMATION_REPORT_VERSION);
    expect(stored.failedTests[0]).toMatchObject({
      jobId,
      testFile: "web/tests/checkout.test.ts",
      attachmentJobId: jobId,
      attachmentPath: "web/target/screenshots/foo.png",
      attachmentName: "foo.png",
      signatureTitle:
        "AssertionError: locator(<selector>) timed out for request <id>",
    });
    expect(stored.failedTests[0]?.signatureKey).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(stored.failedTests[0])).not.toContain("job_token");
    h.db.close();
  });

  test("rejects attachment URLs with the wrong origin, project, job, or unsafe path", () => {
    const pipelineUrl =
      "https://gitlab.com/example-org/qa/test-automation/-/pipelines/9001";
    const valid =
      "https://gitlab.com/example-org/qa/test-automation/-/jobs/7001/" +
      "artifacts/file/web/target/screenshots/foo.png?token=secret";

    expect(safeAttachment(valid, pipelineUrl, [7001])).toEqual({
      jobId: 7001,
      path: "web/target/screenshots/foo.png",
      name: "foo.png",
    });
    for (const invalid of [
      valid.replace("https://gitlab.com", "https://evil.example"),
      valid.replace("/example-org/qa/test-automation/", "/other/project/"),
      valid.replace("/jobs/7001/", "/jobs/7002/"),
      valid.replace("foo.png", "%2Fetc%2Fpasswd"),
      valid.replace("artifacts/file", "artifacts/download"),
    ]) {
      expect(safeAttachment(invalid, pipelineUrl, [7001])).toBeUndefined();
    }
  });

  test("normalizes volatile ids, timestamps, line numbers, and quoted selectors", () => {
    const one = failureSignature({
      status: "error",
      name: "opens checkout",
      file: "web/tests/checkout.test.ts",
      system_output: null,
      stack_trace:
        "TimeoutError: locator('#order-123') failed for request 123456 at 2026-09-24T10:11:12.000Z\n" +
        "    at checkout (/builds/a/web/tests/checkout.test.ts:41:29)",
    });
    const two = failureSignature({
      status: "error",
      name: "opens checkout",
      file: "web/tests/checkout.test.ts",
      system_output: null,
      stack_trace:
        "TimeoutError: locator('#order-999') failed for request 987654 at 2026-09-25T20:21:22.000Z\n" +
        "    at checkout (/builds/b/web/tests/checkout.test.ts:99:3)",
    });

    expect(two).toEqual(one);
  });

  test("refreshes complete v1 reports once and skips unchanged v2 reports", async () => {
    const updatedAt = new Date(Date.now() - 60_000).toISOString();
    const h = harness(
      pipelineRoutes({
        pipelines: [
          pipeline({ status: "success", source: "schedule", updated_at: updatedAt }),
        ],
        summary: { json: EMPTY_SUMMARY },
      }),
    );
    await h.task.run(h.ctx, {});
    h.db.run(
      "UPDATE automation_pipelines SET report_version = 1 WHERE pipeline_id = 9001",
    );

    const refreshed = await h.task.run(h.ctx, {});
    const unchanged = await h.task.run(h.ctx, {});

    expect(refreshed.itemsProcessed).toBe(1);
    expect(unchanged.itemsProcessed).toBe(0);
    expect(h.automation.getPipeline(PROJECT, 9001)?.reportVersion).toBe(2);
    expect(
      h.http.calls.filter((call) =>
        call.url.pathname.endsWith("/pipelines/9001/test_report_summary"),
      ),
    ).toHaveLength(2);
    h.db.close();
  });

  test("reserves first-sync capacity for every configured schedule", async () => {
    const scheduleIds = [22, 23, 24];
    const h = harness(multiScheduleRoutes(), 3);
    h.config.set({
      projectId: PROJECT,
      schedules: scheduleIds.map((scheduleId) => ({ scheduleId })),
    });

    const result = await h.task.run(h.ctx, {});

    expect(result).toMatchObject({ itemsProcessed: 3, itemsSkipped: 0 });
    for (const scheduleId of scheduleIds) {
      expect(h.automation.getPipeline(PROJECT, scheduleId * 100)).toMatchObject({
        scheduleId,
        status: "success",
        reportState: "complete",
      });
    }
    h.db.close();
  });

  test("stores nonterminal pipelines as pending without requesting reports", async () => {
    const h = harness(
      pipelineRoutes({
        pipelines: [pipeline({ status: "running", source: "schedule" })],
        details: {
          9001: pipeline({ status: "running", source: "schedule" }),
        },
        jobs: { 9001: [job({ status: "running" })] },
      }),
    );

    await h.task.run(h.ctx, {});

    expect(h.automation.getPipeline(PROJECT, 9001)).toMatchObject({
      reportState: "pending",
      jobs: [{ jobId: 7001, status: "running" }],
    });
    expect(h.http.calls.some((call) => call.url.pathname.includes("test_report")))
      .toBe(false);
    h.db.close();
  });

  test("records a missing report on GitLab 404", async () => {
    const h = harness(
      pipelineRoutes({
        pipelines: [pipeline({ status: "success", source: "schedule" })],
        summary: {
          status: 404,
          json: { message: "404 Not Found" },
        },
      }),
    );

    const result = await h.task.run(h.ctx, {});

    expect(result.itemsFailed).toBe(0);
    expect(h.automation.getPipeline(PROJECT, 9001)).toMatchObject({
      reportState: "missing",
      reportVersion: AUTOMATION_REPORT_VERSION,
      jobs: [],
      suites: [],
    });
    h.db.close();
  });

  test("preserves summary on full-report errors and retries idempotently", async () => {
    const h = harness(
      pipelineRoutes({
        pipelines: [pipeline({ status: "failed", source: "schedule" })],
        jobs: { 9001: [job()] },
        summary: { json: PIPELINE_TEST_REPORT_SUMMARY },
        full: (call) =>
          call.routeCallCount === 1
            ? { status: 500, json: { message: "temporary failure" } }
            : { json: PIPELINE_TEST_REPORT },
      }),
    );

    const first = await h.task.run(h.ctx, {});
    expect(first.itemsFailed).toBe(1);
    expect(h.automation.getPipeline(PROJECT, 9001)).toMatchObject({
      reportState: "error",
      report: { failedCount: 1 },
      suites: [{ index: 0 }],
      failedTests: [],
    });

    const second = await h.task.run(h.ctx, {});
    expect(second.itemsFailed).toBe(0);
    expect(h.automation.getPipeline(PROJECT, 9001)).toMatchObject({
      reportState: "complete",
      failedTests: [{ name: "applies a percentage discount", jobId: 7001 }],
    });
    expect(
      h.db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM automation_pipelines",
      ).get()?.count,
    ).toBe(1);
    h.db.close();
  });

  test("auto-retries a failed test job once and records the accepted retry", async () => {
    const h = harness([
      ...pipelineRoutes({
        pipelines: [pipeline({ status: "failed", source: "schedule" })],
        jobs: { 9001: [job()] },
        summary: { json: PIPELINE_TEST_REPORT_SUMMARY },
        full: { json: PIPELINE_TEST_REPORT },
      }),
      {
        match: `/api/v4/projects/${PROJECT}/jobs/7001/retry`,
        method: "POST",
        respond: {
          json: job({
            id: 8001,
            status: "pending",
            web_url: "https://gitlab.test/jobs/8001",
          }),
        },
      },
    ]);
    h.config.set({
      projectId: PROJECT,
      schedules: [
        {
          scheduleId: SCHEDULE,
          autoRetry: { enabled: true, maxJobsPerPipeline: 3 },
        },
      ],
    });

    const result = await h.task.run(h.ctx, {});

    expect(result.details).toMatchObject({
      autoRetry: {
        pipelinesClaimed: 1,
        jobsAccepted: 1,
        jobsFailed: 0,
      },
    });
    expect(
      h.http.calls.filter((call) =>
        call.url.pathname.endsWith("/jobs/7001/retry"),
      ),
    ).toHaveLength(1);
    expect(h.automation.getJobRetryWave(PROJECT, 9001)).toMatchObject({
      state: "complete",
      attempts: [{ sourceJobId: 7001, retryJobId: 8001 }],
    });
    h.db.close();
  });

  test("imports the latest pipeline first without skipping the remaining backfill", async () => {
    const firstAt = new Date(Date.now() - 120_000);
    const secondAt = new Date(Date.now() - 60_000);
    const pipelines = [
      pipeline({
        id: 9001,
        status: "success",
        source: "schedule",
        updated_at: firstAt.toISOString(),
      }),
      pipeline({
        id: 9002,
        status: "success",
        source: "schedule",
        updated_at: secondAt.toISOString(),
      }),
    ];
    const h = harness(
      pipelineRoutes({
        pipelines,
        summary: { json: EMPTY_SUMMARY },
      }),
      1,
    );

    await h.task.run(h.ctx, {});
    expect(h.automation.getPipeline(PROJECT, 9002)).toBeDefined();
    expect(h.automation.getPipeline(PROJECT, 9001)).toBeUndefined();

    const old: AutomationPipelineSnapshot = {
      projectId: PROJECT,
      pipelineId: 1,
      scheduleId: SCHEDULE,
      status: "success",
      ref: "main",
      sha: "old",
      webUrl: "https://gitlab.test/old",
      updatedAt: new Date(Date.now() - 181 * 86_400_000),
      reportState: "missing",
      reportVersion: AUTOMATION_REPORT_VERSION,
      jobs: [],
      suites: [],
      failedTests: [],
    };
    h.automation.recordPipeline(old);

    await h.task.run(h.ctx, {});
    expect(h.automation.getPipeline(PROJECT, 9001)).toBeDefined();
    expect(h.automation.getPipeline(PROJECT, 1)).toBeUndefined();
    const secondScan = h.http.callsTo(`/pipeline_schedules/${SCHEDULE}/pipelines`)[1]!;
    const lower = new Date(secondScan.url.searchParams.get("updated_after")!);
    expect(Date.now() - lower.getTime()).toBeGreaterThan(30 * 86_400_000 - 5_000);
    expect(Date.now() - lower.getTime()).toBeLessThan(30 * 86_400_000 + 5_000);
    h.db.close();
  });
});
