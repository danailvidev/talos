import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";

import type { GitLabGateway } from "../src/application/gateways.ts";
import {
  automationRetryCandidates,
  maybeRetryAutomationJobs,
} from "../src/application/automation-job-retry.ts";
import type { AutomationPipelineSnapshot } from "../src/application/ports.ts";
import type { TaskContext } from "../src/core/task.ts";
import { createLogger } from "../src/logging/logger.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteAutomationStore } from "../src/persistence/automation-store.ts";
import { MemoryStateStore } from "../src/persistence/state-store.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import { job } from "./fixtures/gitlab.ts";

function snapshot(): AutomationPipelineSnapshot {
  const report = {
    totalTime: 1,
    totalCount: 2,
    successCount: 0,
    failedCount: 2,
    skippedCount: 0,
    errorCount: 0,
  };
  return {
    projectId: "42",
    pipelineId: 9001,
    scheduleId: 22,
    status: "failed",
    ref: "main",
    sha: "abc",
    webUrl: "https://gitlab.test/pipelines/9001",
    updatedAt: new Date("2026-09-25T06:00:00.000Z"),
    reportState: "complete",
    reportVersion: 2,
    report,
    jobs: [
      {
        jobId: 501,
        name: "browser",
        stage: "test",
        status: "failed",
        failureReason: "script_failure",
        allowFailure: true,
        webUrl: "https://gitlab.test/jobs/501",
        report,
      },
      {
        jobId: 502,
        name: "runner",
        stage: "test",
        status: "failed",
        failureReason: "runner_system_failure",
        allowFailure: false,
        webUrl: "https://gitlab.test/jobs/502",
        report,
      },
    ],
    suites: [],
    failedTests: [
      {
        suiteIndex: 0,
        jobId: 501,
        status: "failed",
        name: "checkout",
        executionTime: 1,
        signatureKey: "sig",
        signatureTitle: "Assertion failure",
      },
    ],
  };
}

function context(dryRun = false): TaskContext {
  return {
    taskId: "automation-report-sync",
    executionId: "run-1",
    logger: createLogger({
      destination: new PassThrough(),
      pretty: false,
      level: "fatal",
    }),
    state: new MemoryStateStore(),
    secrets: new EnvSecretStore({}),
    dryRun,
    maxItemsPerRun: 10,
    force: false,
    signal: new AbortController().signal,
    llm: { provider: "anthropic", maxTokens: 2048 },
    prompts: {},
    step: async (_id, fn) => fn(),
  };
}

describe("Automation guarded job retry", () => {
  test("selects failed test jobs, includes allowed failures, and excludes runner failures", () => {
    expect(
      automationRetryCandidates(snapshot(), {
        enabled: true,
        maxJobsPerPipeline: 20,
      }).map((candidate) => candidate.jobId),
    ).toEqual([501]);
    expect(
      automationRetryCandidates(snapshot(), {
        enabled: true,
        maxJobsPerPipeline: 1,
      }),
    ).toHaveLength(1);
    expect(
      automationRetryCandidates(snapshot(), {
        enabled: false,
        maxJobsPerPipeline: 20,
      }),
    ).toEqual([]);
  });

  test("persists the wave before GitLab and never retries the same pipeline twice", async () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    migrate(db);
    const automation = new SqliteAutomationStore(db);
    let calls = 0;
    const gitlab = {
      retryJob: async () => {
        calls += 1;
        return job({
          id: 601,
          status: "pending",
          web_url: "https://gitlab.test/jobs/601",
        });
      },
    } as unknown as GitLabGateway;
    const input = {
      ctx: context(),
      gitlab,
      automation,
      snapshot: snapshot(),
      config: { enabled: true, maxJobsPerPipeline: 3 },
    };
    expect(await maybeRetryAutomationJobs(input)).toMatchObject({
      claimed: true,
      jobsAccepted: 1,
      jobsFailed: 0,
    });
    expect(await maybeRetryAutomationJobs(input)).toMatchObject({
      claimed: false,
    });
    expect(calls).toBe(1);
    expect(automation.getJobRetryWave("42", 9001)).toMatchObject({
      state: "complete",
      attempts: [{ sourceJobId: 501, retryJobId: 601, status: "accepted" }],
    });
    db.close();
  });

  test("dry-run selects jobs without claiming or writing", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const automation = new SqliteAutomationStore(db);
    const result = await maybeRetryAutomationJobs({
      ctx: context(true),
      gitlab: {} as GitLabGateway,
      automation,
      snapshot: snapshot(),
      config: { enabled: true, maxJobsPerPipeline: 3 },
    });
    expect(result).toMatchObject({ jobsSelected: 1, claimed: false });
    expect(automation.getJobRetryWave("42", 9001)).toBeUndefined();
    db.close();
  });
});
