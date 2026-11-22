import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";
import type { FollowUpAgentOptions } from "../src/tasks/mr-follow-up/agent.ts";
import { taskConnectorFactory } from "../src/connectors/task-factory.ts";
import { TaskExecutor, type TaskExecutionRecord } from "../src/core/executor.ts";
import { createLogger } from "../src/logging/logger.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteStateStore } from "../src/persistence/sqlite-state-store.ts";
import { SqliteTaskSink } from "../src/persistence/sqlite-task-sink.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import type { Job } from "../src/core/job.ts";
import type { JobRepository } from "../src/application/ports.ts";
import { discussionEventId } from "../src/tasks/mr-follow-up/discussions.ts";
import {
  createMrFollowUpWorkerTask,
  MR_FOLLOW_UP_ONE_TASK_ID,
} from "../src/tasks/mr-follow-up/index.ts";
import { discussion, GITLAB_PROJECT, GITLAB_USER, mergeRequest } from "./fixtures/gitlab.ts";
import { FakeHttp } from "./fixtures/http.ts";

const LAST_PAGE = { "x-next-page": "" };

function harness(options: { dryRun?: boolean; jobs?: JobRepository } = {}) {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  const http = new FakeHttp([
    { match: "/api/v4/user", respond: { json: GITLAB_USER } },
    {
      match: /\/projects\/acme%2Fwebportal\/merge_requests\/6193$/,
      respond: { json: mergeRequest({ author: GITLAB_USER }) },
    },
    {
      match: /\/merge_requests\/6193\/discussions$/,
      method: "GET",
      respond: { json: [discussion()], headers: LAST_PAGE },
    },
    { match: "/api/v4/projects/42", respond: { json: GITLAB_PROJECT } },
    {
      match: /\/merge_requests\/6193\/discussions\/discussion-1\/notes$/,
      method: "POST",
      respond: {
        json: {
          id: 502,
          body: "Handled.",
          created_at: "2026-08-25T10:10:00.000Z",
        },
      },
    },
    {
      match: /\/merge_requests\/6193\/discussions\/discussion-1\/notes\/501$/,
      method: "PUT",
      respond: {
        json: {
          id: 501,
          body: "Could you handle the empty value here?",
          author: { id: 6001, username: "reviewer" },
          created_at: "2026-08-25T10:05:00.000Z",
          resolvable: true,
          resolved: true,
        },
      },
    },
  ]);
  const agentCalls: FollowUpAgentOptions[] = [];
  let failAgent = false;
  const task = createMrFollowUpWorkerTask({
    connectors: taskConnectorFactory,
    fetch: http.fetch,
    ...(options.jobs ? { jobs: options.jobs } : {}),
    ensureImage: async () => undefined,
    runAgent: async (input) => {
      agentCalls.push(input);
      if (failAgent) throw new Error("agent failed");
      return {
        summary: "handled",
        replies: [{ discussionId: "discussion-1", noteId: 501, body: "Handled.", fixed: true }],
        commitSha: "1234567890abcdef",
      };
    },
  });
  const executor = new TaskExecutor({
    logger: createLogger({ destination: new PassThrough(), pretty: false, level: "fatal" }),
    state: new SqliteStateStore(db),
    secrets: new EnvSecretStore({ GITLAB_TOKEN: "glpat-test" }),
    sink: new SqliteTaskSink(db),
    defaultRetry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
  });

  return {
    db,
    http,
    agentCalls,
    setFailAgent(value: boolean) {
      failAgent = value;
    },
    run(extra: { maxItemsPerRun?: number } = {}): Promise<TaskExecutionRecord> {
      return executor.run(task, {
        params: {
          gitlab: { projectId: "acme/webportal", mrIid: 6193 },
          commit: { name: "Example Developer", email: "dev@example.com" },
        },
        dryRun: options.dryRun,
        maxItemsPerRun: extra.maxItemsPerRun,
      });
    },
  };
}

function jobsListing(
  active: Pick<Job, "status" | "executionId" | "params">[],
): JobRepository {
  return {
    activeForKind: () => active,
  } as unknown as JobRepository;
}

describe("gitlab-mr-follow-up", () => {
  test("uses the MR source project and exact branch, pushes once, and replies in-thread", async () => {
    const h = harness();
    const first = await h.run();

    expect(first.result?.itemsProcessed).toBe(1);
    expect(h.agentCalls).toHaveLength(1);
    expect(h.agentCalls[0]).toMatchObject({
      project: "acme/webportal",
      branch: "fix/TP-3012",
      startSha: "abcdef12deadbeef",
    });
    const post = h.http.calls.find((call) => call.method === "POST");
    expect(post?.url.pathname).toContain("/discussions/discussion-1/notes");
    expect(post?.body).toContain("1234567890ab");
    const resolve = h.http.calls.find((call) => call.method === "PUT");
    expect(resolve?.url.pathname).toContain("/discussions/discussion-1/notes/501");
    expect(resolve?.body).toContain('"resolved":true');

    const second = await h.run();
    expect(second.result?.itemsProcessed).toBe(0);
    expect(h.agentCalls).toHaveLength(1);
    h.db.close();
  });

  test("failed discussion claims are retryable", async () => {
    const h = harness();
    h.setFailAgent(true);
    let failure = "";
    try {
      await h.run();
    } catch (err) {
      failure = String(err);
    }
    expect(failure).toContain("agent failed");
    h.setFailAgent(false);
    const retried = await h.run();
    expect(retried.result?.itemsProcessed).toBe(1);
    expect(h.agentCalls).toHaveLength(2);
    h.db.close();
  });

  test("reclaims a discussion a dead run left claimed when no other job is leased", async () => {
    const h = harness({ jobs: jobsListing([]) });
    h.db.run(
      `INSERT INTO processed_events
         (task_id, external_id, event_type, status, claimed_at, attempts)
       VALUES (?, ?, 'gitlab-mr-discussion', 'claimed', ?, 1)`,
      [
        MR_FOLLOW_UP_ONE_TASK_ID,
        discussionEventId("acme/webportal", 6193, { discussionId: "discussion-1", noteId: 501 }),
        new Date().toISOString(),
      ],
    );

    const retried = await h.run();

    expect(retried.result?.itemsProcessed).toBe(1);
    expect(retried.result?.details).toMatchObject({ action: "replied" });
    expect(h.agentCalls).toHaveLength(1);
    h.db.close();
  });

  test("leaves a discussion claimed while another follow-up job is leased for that merge request", async () => {
    const h = harness({
      jobs: jobsListing([
        {
          status: "leased",
          executionId: "task-other",
          params: { gitlab: { projectId: "acme/webportal", mrIid: 6193 } },
        },
      ]),
    });
    h.db.run(
      `INSERT INTO processed_events
         (task_id, external_id, event_type, status, claimed_at, attempts)
       VALUES (?, ?, 'gitlab-mr-discussion', 'claimed', ?, 1)`,
      [
        MR_FOLLOW_UP_ONE_TASK_ID,
        discussionEventId("acme/webportal", 6193, { discussionId: "discussion-1", noteId: 501 }),
        new Date().toISOString(),
      ],
    );

    const blocked = await h.run();

    expect(blocked.result?.itemsProcessed).toBe(0);
    expect(blocked.result?.details).toMatchObject({ action: "already-claimed" });
    expect(h.agentCalls).toEqual([]);
    h.db.close();
  });

  test("dry-run reports work without building, running, posting, or claiming", async () => {
    const h = harness({ dryRun: true });
    const first = await h.run();
    const second = await h.run();
    expect(first.result?.itemsProcessed).toBe(1);
    expect(second.result?.itemsProcessed).toBe(1);
    expect(h.agentCalls).toEqual([]);
    expect(h.http.calls.some((call) => call.method === "POST")).toBe(false);
    h.db.close();
  });
});
