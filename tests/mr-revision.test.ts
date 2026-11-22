import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";
import { taskConnectorFactory } from "../src/connectors/task-factory.ts";
import { TaskExecutor } from "../src/core/executor.ts";
import { createLogger } from "../src/logging/logger.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteStateStore } from "../src/persistence/sqlite-state-store.ts";
import { SqliteTaskSink } from "../src/persistence/sqlite-task-sink.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import type { MrRevisionAgentOptions } from "../src/tasks/mr-revision/agent.ts";
import { createMrRevisionWorkerTask } from "../src/tasks/mr-revision/index.ts";
import { GITLAB_PROJECT, mergeRequest } from "./fixtures/gitlab.ts";
import { FakeHttp } from "./fixtures/http.ts";

function harness(state = "opened") {
  const db = new Database(":memory:");
  migrate(db);
  const http = new FakeHttp([
    {
      match: /\/projects\/acme%2Fwebportal\/merge_requests\/6193$/,
      respond: { json: mergeRequest({ state }) },
    },
    { match: "/api/v4/projects/42", respond: { json: GITLAB_PROJECT } },
  ]);
  const calls: MrRevisionAgentOptions[] = [];
  const task = createMrRevisionWorkerTask({
    connectors: taskConnectorFactory,
    fetch: http.fetch,
    ensureImage: async () => undefined,
    runAgent: async (options) => {
      calls.push(options);
      return {
        response: "Adjusted the empty-value behavior and ran the unit tests.",
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
    calls,
    run: () =>
      executor.run(task, {
        params: {
          gitlab: { projectId: "acme/webportal", mrIid: 6193 },
          instruction: "Keep the old behavior for an empty value.",
          history: [
            { role: "user", content: "Please simplify this." },
            { role: "assistant", content: "I simplified the parser." },
          ],
        },
      }),
  };
}

describe("gitlab-mr-revision-one", () => {
  test("checks out the current MR head and pushes one conversational revision", async () => {
    const h = harness();
    const record = await h.run();

    expect(record.result?.itemsProcessed).toBe(1);
    expect(record.result?.details).toMatchObject({
      action: "revised",
      instruction: "Keep the old behavior for an empty value.",
      response: "Adjusted the empty-value behavior and ran the unit tests.",
      commitSha: "1234567890abcdef",
    });
    expect(h.calls[0]).toMatchObject({
      mrIid: 6193,
      project: "acme/webportal",
      branch: "fix/TP-3012",
      targetBranch: "main",
      startSha: "abcdef12deadbeef",
      history: [
        { role: "user", content: "Please simplify this." },
        { role: "assistant", content: "I simplified the parser." },
      ],
    });
    h.db.close();
  });

  test("does not start an agent after the merge request closes", async () => {
    const h = harness("closed");
    const record = await h.run();

    expect(record.result?.itemsProcessed).toBe(0);
    expect(record.result?.details).toMatchObject({ action: "not-open" });
    expect(h.calls).toEqual([]);
    h.db.close();
  });
});
