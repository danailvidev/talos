import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";
import type {
  AutomationPipelineSnapshot,
} from "../src/application/ports.ts";
import type { TaskContext } from "../src/core/task.ts";
import { createLogger } from "../src/logging/logger.ts";
import { SqliteAutomationAiTriageStore } from "../src/persistence/automation-ai-triage-store.ts";
import {
  SqliteAutomationConfigStore,
  SqliteAutomationStore,
} from "../src/persistence/automation-store.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteNotificationStore } from "../src/persistence/notification-store.ts";
import { MemoryStateStore } from "../src/persistence/state-store.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import {
  AutomationFailureTriageOutputSchema,
  automationFailureTriagePrompt,
} from "../src/tasks/triage-automation-failure/agent.ts";
import {
  createTriageAutomationFailureTask,
  type TriageAutomationFailureDeps,
} from "../src/tasks/triage-automation-failure/index.ts";

const params = {
  projectId: "42",
  pipelineId: 9001,
  scheduleId: 22,
  signatureKey: "root-cause",
  targetRef: "main",
};

function snapshot(): AutomationPipelineSnapshot {
  return {
    projectId: "42",
    pipelineId: 9001,
    scheduleId: 22,
    status: "failed",
    ref: "main",
    sha: "abc",
    webUrl: "https://gitlab.test/acme/tests/-/pipelines/9001",
    updatedAt: new Date(),
    reportState: "complete",
    reportVersion: 2,
    jobs: [
      {
        jobId: 501,
        name: "browser",
        stage: "test",
        status: "failed",
        allowFailure: false,
        webUrl: "https://gitlab.test/acme/tests/-/jobs/501",
      },
    ],
    suites: [
      {
        index: 0,
        name: "browser",
        buildIds: [501],
        totalTime: 1,
        totalCount: 1,
        successCount: 0,
        failedCount: 1,
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
        name: "renders checkout",
        classname: "CheckoutSpec",
        executionTime: 1,
        systemOutput: "expected Buy now, got Continue",
        stackTrace: "at checkout.spec.ts:42",
        testFile: "checkout.spec.ts",
        attachmentJobId: 501,
        attachmentPath: "screenshots/checkout.png",
        attachmentName: "checkout.png",
        signatureKey: "root-cause",
        signatureTitle: "AssertionError: expected Buy now",
      },
    ],
  };
}

function context(): TaskContext {
  return {
    taskId: "triage-automation-failure",
    executionId: "run-1",
    logger: createLogger({
      destination: new PassThrough(),
      pretty: false,
      level: "fatal",
    }),
    state: new MemoryStateStore(),
    secrets: new EnvSecretStore({ GITLAB_TOKEN: "glpat-test" }),
    dryRun: false,
    maxItemsPerRun: 1,
    force: false,
    signal: new AbortController().signal,
    llm: { provider: "anthropic", model: "sonnet", maxTokens: 2048 },
    prompts: {},
    step: async (_id, fn) => fn(),
  };
}

function harness(runAgent: NonNullable<TriageAutomationFailureDeps["runAgent"]>) {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  const config = new SqliteAutomationConfigStore(db);
  const automation = new SqliteAutomationStore(db);
  const triage = new SqliteAutomationAiTriageStore(db);
  const notifications = new SqliteNotificationStore(db);
  config.set({ projectId: "42", schedules: [{ scheduleId: 22 }] });
  automation.upsertSchedule({
    projectId: "42",
    scheduleId: 22,
    description: "Nightly",
    ref: "main",
    active: true,
    syncedAt: new Date(),
  });
  automation.recordPipeline(snapshot());
  return {
    db,
    triage,
    notifications,
    task: createTriageAutomationFailureTask({
      config,
      automation,
      triage,
      notifications,
      ensureImage: async () => undefined,
      runAgent,
    }),
  };
}

describe("Automation failure triage agent contract", () => {
  test("accepts only the required taxonomy and bounded confidence", () => {
    expect(
      AutomationFailureTriageOutputSchema.parse({
        verdict: "ui-change",
        confidence: 0.85,
        rationale: "The selector targets copy removed by the current page object.",
        recommendation: "Confirm the copy change and update the page object.",
      }),
    ).toMatchObject({ verdict: "ui-change" });
    expect(
      AutomationFailureTriageOutputSchema.safeParse({
        verdict: "code",
        confidence: 2,
        rationale: "",
        recommendation: "",
      }).success,
    ).toBe(false);
  });

  test("prompt is read-only, evidence-led, and prohibits side effects", () => {
    const prompt = automationFailureTriagePrompt();
    for (const term of [
      "bad-data",
      "service-breaking-change",
      "ui-change",
      "test-bug",
      "infrastructure",
      "unknown",
      "concrete evidence",
      "Do not edit files",
      "create Jira tickets",
      "open merge requests",
      "do not use MCP tools",
      "locate files with Glob or Grep before reading",
    ]) {
      expect(prompt).toContain(term);
    }
  });
});

describe("triage-automation-failure task", () => {
  test("passes bounded cluster evidence, persists the verdict, and notifies", async () => {
    const calls: any[] = [];
    const h = harness(async (options) => {
      calls.push(options);
      return {
        verdict: "ui-change",
        confidence: 0.88,
        rationale: "The current page object still asserts the previous button copy.",
        recommendation: "Confirm the product copy and update the page object.",
      };
    });
    const result = await h.task.run(
      context(),
      h.task.paramsSchema.parse(params),
    );

    expect(result.itemsProcessed).toBe(1);
    expect(calls[0]).toMatchObject({
      project: "42",
      targetRef: "main",
      token: "glpat-test",
      cluster: {
        normalizedSignature: "AssertionError: expected Buy now",
        affectedTests: [{ name: "renders checkout", testFile: "checkout.spec.ts" }],
        affectedJobs: [{ id: 501, name: "browser" }],
        screenshots: [
          {
            name: "checkout.png",
            artifactPath: "screenshots/checkout.png",
            jobId: 501,
          },
        ],
      },
    });
    expect(h.triage.get("42", 22, "root-cause")).toMatchObject({
      verdict: "ui-change",
      taskRunId: "run-1",
      signature: "AssertionError: expected Buy now",
    });
    expect(h.notifications.list()).toEqual([
      expect.objectContaining({
        kind: "triage-automation-failure",
        taskRunId: "run-1",
      }),
    ]);
    h.db.close();
  });

  test("does not persist or notify when the agent fails", async () => {
    const h = harness(async () => {
      throw new Error("agent unavailable");
    });
    await expect(
      h.task.run(context(), h.task.paramsSchema.parse(params)),
    ).rejects.toThrow("agent unavailable");
    expect(h.triage.get("42", 22, "root-cause")).toBeUndefined();
    expect(h.notifications.list()).toEqual([]);
    h.db.close();
  });

  test("refuses a job whose stored pipeline ref no longer matches", async () => {
    let called = false;
    const h = harness(async () => {
      called = true;
      throw new Error("should not run");
    });
    await expect(
      h.task.run(
        context(),
        h.task.paramsSchema.parse({ ...params, targetRef: "other" }),
      ),
    ).rejects.toThrow(/no longer matches/i);
    expect(called).toBe(false);
    h.db.close();
  });
});
