import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";
import type {
  GitLabGateway,
  JiraGateway,
  TaskConnectorFactory,
} from "../src/application/gateways.ts";
import type { TaskContext } from "../src/core/task.ts";
import { createLogger } from "../src/logging/logger.ts";
import { SqliteDeployWatchStore } from "../src/persistence/deploy-watch-store.ts";
import { SqliteJobQueue } from "../src/persistence/job-queue.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { MemoryStateStore } from "../src/persistence/state-store.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import {
  createReleaseRepoPollTask,
  RELEASE_REPO_POLL_DEFAULT_CRON,
  RELEASE_REPO_POLL_TASK_ID,
} from "../src/tasks/release-repo-poll/index.ts";

const PROD_DIFF = [
  "@@ -1,3 +1,3 @@ applications:",
  "   - name: web",
  "-    version: old",
  "+    version: new",
].join("\n");

function context(state = new MemoryStateStore()): TaskContext {
  return {
    taskId: RELEASE_REPO_POLL_TASK_ID,
    executionId: crypto.randomUUID(),
    logger: createLogger({
      destination: new PassThrough(),
      pretty: false,
      level: "fatal",
    }),
    state,
    secrets: new EnvSecretStore({ GITLAB_TOKEN: "glpat-test" }),
    dryRun: false,
    maxItemsPerRun: 10,
    force: false,
    signal: new AbortController().signal,
    llm: { provider: "anthropic", maxTokens: 2048 },
    prompts: {},
    step: async (_id, fn) => fn(),
  };
}

function connectors(gitlab: Partial<GitLabGateway>): TaskConnectorFactory {
  return {
    gitlab: () => gitlab as GitLabGateway,
    jira: () => ({}) as JiraGateway,
  };
}

function harness(gitlab: Partial<GitLabGateway>) {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  const watches = new SqliteDeployWatchStore(db);
  const jobs = new SqliteJobQueue(db);
  const task = createReleaseRepoPollTask({
    connectors: connectors(gitlab),
    releaseConfig: () => ({
      projectId: "group/releases",
      manifestPath: "cluster.yaml",
      targetBranch: "main",
    }),
    deployWatches: watches,
    jobs,
  });
  return { db, watches, jobs, task };
}

describe("external release repository polling", () => {
  test("seeds on first run without reading historical commits", async () => {
    let listed = false;
    const { db, task, watches } = harness({
      listCommits: async () => {
        listed = true;
        return [];
      },
    });

    const result = await task.run(context(), {});

    expect(task.kind).toBe("loop");
    expect(task.defaultTrigger).toEqual({
      type: "cron",
      expression: RELEASE_REPO_POLL_DEFAULT_CRON,
    });
    expect(result.details?.action).toBe("seeded");
    expect(listed).toBe(false);
    expect(watches.list()).toEqual([]);
    db.close();
  });

  test("opens deduplicated watches for merged MRs and direct PROD commits", async () => {
    const now = Date.now();
    const mrCommit = {
      id: "aaaaaaaa11111111",
      short_id: "aaaaaaaa",
      title: "Release web",
      web_url: "https://gitlab.example/group/releases/-/commit/aaaaaaaa",
      committed_date: new Date(now - 120_000).toISOString(),
      parent_ids: ["parent"],
    };
    const directCommit = {
      id: "bbbbbbbb22222222",
      short_id: "bbbbbbbb",
      title: "Hotfix web",
      web_url: "https://gitlab.example/group/releases/-/commit/bbbbbbbb",
      committed_date: new Date(now - 60_000).toISOString(),
      parent_ids: ["parent"],
    };
    const stageCommit = {
      id: "cccccccc33333333",
      short_id: "cccccccc",
      title: "Stage only",
      web_url: "https://gitlab.example/group/releases/-/commit/cccccccc",
      committed_date: new Date(now - 30_000).toISOString(),
      parent_ids: ["parent"],
    };
    const gitlab: Partial<GitLabGateway> = {
      listCommits: async () => [stageCommit, directCommit, mrCommit],
      commitDiff: async (_project, sha) => [
        {
          old_path: sha === stageCommit.id ? "STAGE/cluster.yaml" : "PROD/cluster.yaml",
          new_path: sha === stageCommit.id ? "STAGE/cluster.yaml" : "PROD/cluster.yaml",
          diff: PROD_DIFF,
        },
      ],
      commitMergeRequests: async (_project, sha) =>
        sha === mrCommit.id
          ? ([
              {
                id: 100,
                iid: 42,
                project_id: 1,
                title: "Release web",
                state: "merged",
                source_branch: "release/web",
                target_branch: "main",
                web_url: "https://gitlab.example/group/releases/-/merge_requests/42",
                updated_at: new Date(now - 100_000),
                merged_at: new Date(now - 100_000),
              },
            ] as Awaited<ReturnType<GitLabGateway["commitMergeRequests"]>>)
          : [],
    };
    const { db, task, watches, jobs } = harness(gitlab);
    const state = new MemoryStateStore();
    await state.setWatermark(
      RELEASE_REPO_POLL_TASK_ID,
      new Date(now - 10 * 60_000),
    );

    const first = await task.run(context(state), {});
    const second = await task.run(context(state), {});

    expect(first.itemsProcessed).toBe(2);
    expect(second.itemsProcessed).toBe(0);
    expect(watches.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          releaseKind: "merge-request",
          mrIid: 42,
          commitSha: mrCommit.id,
          state: "watching",
          services: ["web"],
        }),
        expect.objectContaining({
          releaseKind: "commit",
          commitSha: directCommit.id,
          state: "watching",
          services: ["web"],
        }),
      ]),
    );
    expect(watches.list()).toHaveLength(2);
    expect(jobs.recent().filter((job) => job.kind === "deploy-watch")).toHaveLength(2);
    db.close();
  });

  test("does not open a watch after the six-hour window elapsed", async () => {
    const committedAt = new Date(Date.now() - 7 * 60 * 60_000);
    const commit = {
      id: "dddddddd44444444",
      short_id: "dddddddd",
      title: "Old release",
      web_url: "https://gitlab.example/group/releases/-/commit/dddddddd",
      committed_date: committedAt.toISOString(),
      parent_ids: ["parent"],
    };
    const { db, task, watches } = harness({
      listCommits: async () => [commit],
      commitDiff: async () => [
        {
          old_path: "PROD/cluster.yaml",
          new_path: "PROD/cluster.yaml",
          diff: PROD_DIFF,
        },
      ],
      commitMergeRequests: async () => [],
    });
    const state = new MemoryStateStore();
    await state.setWatermark(
      RELEASE_REPO_POLL_TASK_ID,
      new Date(committedAt.getTime() - 60_000),
    );

    const result = await task.run(context(state), {});

    expect(result.itemsProcessed).toBe(0);
    expect(result.itemsSkipped).toBeGreaterThan(0);
    expect(watches.list()).toEqual([]);
    db.close();
  });
});
