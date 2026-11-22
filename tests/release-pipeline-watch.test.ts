import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";

import type { TaskConnectorFactory } from "../src/application/gateways.ts";
import type { TaskContext } from "../src/core/task.ts";
import { createLogger } from "../src/logging/logger.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteJobQueue } from "../src/persistence/job-queue.ts";
import { SqliteNotificationStore } from "../src/persistence/notification-store.ts";
import { MemoryStateStore } from "../src/persistence/state-store.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import {
  createReleasePipelineWatchTask,
  RELEASE_PIPELINE_WATCH_LOOP_ID,
} from "../src/tasks/release-pipeline-watch/index.ts";

const config = {
  projectId: "group/releases",
  mrIid: 42,
  mrUrl: "https://gitlab.example/group/releases/-/merge_requests/42",
  environment: "beta",
  services: ["web"],
  openedAt: new Date().toISOString(),
};

function harness() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  return {
    db,
    jobs: new SqliteJobQueue(db),
    notifications: new SqliteNotificationStore(db),
  };
}

function context(): TaskContext {
  return {
    taskId: "release-pipeline-watch",
    executionId: crypto.randomUUID(),
    logger: createLogger({
      destination: new PassThrough(),
      pretty: false,
      level: "fatal",
    }),
    state: new MemoryStateStore(),
    secrets: new EnvSecretStore({}),
    actor: {
      id: "actor-1",
      email: "developer@example.com",
      name: "Developer",
    },
    dryRun: false,
    maxItemsPerRun: 1,
    force: false,
    signal: new AbortController().signal,
    llm: { provider: "anthropic", maxTokens: 2048 },
    prompts: {},
    step: async (_id, fn) => fn(),
  };
}

function connectors(
  headPipeline: { id: number; status: string; web_url: string } | null,
  state = "opened",
  autoMergeEnabled = headPipeline?.status === "success",
) {
  return {
    gitlab: () => ({
      mergeRequest: async () => ({
        state,
        head_pipeline: headPipeline,
        merge_when_pipeline_succeeds: autoMergeEnabled,
      }),
    }),
  } as unknown as TaskConnectorFactory;
}

describe("release pipeline watch", () => {
  test("notifies with the failed pipeline link", async () => {
    const { db, jobs, notifications } = harness();
    const task = createReleasePipelineWatchTask({
      connectors: connectors({
        id: 9001,
        status: "failed",
        web_url: "https://gitlab.example/pipelines/9001",
      }),
      jobs,
      notifications,
    });

    const result = await task.run(context(), config);

    expect(result).toMatchObject({
      itemsProcessed: 1,
      notifiedIndividually: true,
      details: {
        action: "pipeline-failed",
        pipelineId: 9001,
        pipelineStatus: "failed",
      },
    });
    expect(notifications.list()).toEqual([
      expect.objectContaining({
        kind: "release-pipeline-watch",
        title: "beta release pipeline failed",
        link: "https://gitlab.example/pipelines/9001",
      }),
    ]);
    expect(jobs.byLoop(RELEASE_PIPELINE_WATCH_LOOP_ID)).toEqual([]);
    db.close();
  });

  test("requeues while the pipeline is running without notifying", async () => {
    const { db, jobs, notifications } = harness();
    const task = createReleasePipelineWatchTask({
      connectors: connectors({
        id: 9002,
        status: "running",
        web_url: "https://gitlab.example/pipelines/9002",
      }),
      jobs,
      notifications,
    });

    const result = await task.run(context(), config);
    const queued = jobs.byLoop(RELEASE_PIPELINE_WATCH_LOOP_ID);

    expect(result.details).toMatchObject({
      action: "pipeline-pending",
      pipelineId: 9002,
      pipelineStatus: "running",
    });
    expect(notifications.list()).toEqual([]);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: "release-pipeline-watch",
      actorId: "actor-1",
      params: config,
    });
    expect(queued[0]!.availableAt.getTime()).toBeGreaterThan(Date.now());
    db.close();
  });

  test("keeps polling after pipeline success until the merge request merges", async () => {
    const { db, jobs, notifications } = harness();
    const task = createReleasePipelineWatchTask({
      connectors: connectors({
        id: 9003,
        status: "success",
        web_url: "https://gitlab.example/pipelines/9003",
      }),
      jobs,
      notifications,
    });

    const result = await task.run(context(), config);

    expect(result.details).toMatchObject({
      action: "waiting-for-merge",
      pipelineId: 9003,
      pipelineStatus: "success",
    });
    expect(notifications.list()).toEqual([]);
    expect(jobs.byLoop(RELEASE_PIPELINE_WATCH_LOOP_ID)).toHaveLength(1);
    db.close();
  });

  test("repairs a successful release whose auto-merge was not enabled", async () => {
    const { db, jobs, notifications } = harness();
    let mergeCalls = 0;
    const task = createReleasePipelineWatchTask({
      connectors: {
        gitlab: () => ({
          mergeRequest: async () => ({
            state: "opened",
            head_pipeline: {
              id: 9004,
              status: "success",
              web_url: "https://gitlab.example/pipelines/9004",
            },
            merge_when_pipeline_succeeds: false,
          }),
          mergeMergeRequest: async (
            _project: string,
            _mrIid: number,
            options: { autoMerge?: boolean },
          ) => {
            mergeCalls += 1;
            expect(options.autoMerge).toBe(true);
            return {
              state: "merged",
              merge_when_pipeline_succeeds: false,
            };
          },
        }),
      } as unknown as TaskConnectorFactory,
      jobs,
      notifications,
    });

    const result = await task.run(context(), config);

    expect(mergeCalls).toBe(1);
    expect(result.details).toMatchObject({
      action: "merged",
      pipelineId: 9004,
      pipelineStatus: "success",
    });
    expect(notifications.list()).toEqual([]);
    expect(jobs.byLoop(RELEASE_PIPELINE_WATCH_LOOP_ID)).toEqual([]);
    db.close();
  });

  test("stops polling only after the merge request is merged", async () => {
    const { db, jobs, notifications } = harness();
    const task = createReleasePipelineWatchTask({
      connectors: connectors(null, "merged"),
      jobs,
      notifications,
    });

    const result = await task.run(context(), config);

    expect(result.details).toMatchObject({ action: "merged" });
    expect(notifications.list()).toEqual([]);
    expect(jobs.byLoop(RELEASE_PIPELINE_WATCH_LOOP_ID)).toEqual([]);
    db.close();
  });
});
