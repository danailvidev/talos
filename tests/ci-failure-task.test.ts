import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";
import { TaskExecutor, type TaskExecutionRecord } from "../src/core/executor.ts";
import { createLogger } from "../src/logging/logger.ts";
import { taskConnectorFactory } from "../src/connectors/task-factory.ts";
import { SqliteSubjectStore } from "../src/persistence/subject-store.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteTaskSink } from "../src/persistence/sqlite-task-sink.ts";
import { SqliteStateStore } from "../src/persistence/sqlite-state-store.ts";
import { SqliteTestRunHistoryStore } from "../src/persistence/test-run-history-store.ts";
import { MemoryStateStore } from "../src/persistence/state-store.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import { createCiFailureTask } from "../src/tasks/ci-failure/index.ts";
import { FakeHttp, type RecordedCall, type Route } from "./fixtures/http.ts";
import { GITLAB_PROJECT, PIPELINE_DETAIL, job, pipeline } from "./fixtures/gitlab.ts";
import { JEST_FAILURE_TRACE } from "./fixtures/jest-trace.ts";
import {
  JIRA_ACTIVE_SPRINT,
  JIRA_CREATED_ISSUE,
  JIRA_FIELDS,
  JIRA_MYSELF,
  JIRA_PROJECT,
  issueResponse,
  searchResult,
} from "./fixtures/jira.ts";

/**
 * End-to-end runs of the CI-failure task against real persistence and a fake
 * fetch.
 *
 * The behaviour worth testing here cannot be tested any other way: "does a second
 * run refile yesterday's tickets" is a question about two runs sharing one
 * database, so these use the real TaskExecutor, the real SQLite stack and the
 * real subject store — only the network is a double.
 */

const TASK_ID = "gitlab-ci-failure";
const PROJECT = "acme/webportal";

/** The two spec files in JEST_FAILURE_TRACE. */
const CHECKOUT = "src/app/checkout/checkout.component.spec.ts";
const CHECKOUT_SOURCE = "src/app/checkout/checkout.component.ts";
const BILLING = "projects/parent-portal/src/app/billing/billing.service.spec.ts";

const CONFIG = {
  gitlab: { projectId: PROJECT },
  jira: { project: "TP", issueType: "Bug", boardId: 21 },
  anyStatus: true,
  includeAllowedFailures: true,
};

const LAST_PAGE = { "x-next-page": "" };

interface Harness {
  db: Database;
  http: FakeHttp;
  subjects: SqliteSubjectStore;
  testRuns: SqliteTestRunHistoryStore;
  state: SqliteStateStore;
  run(options?: {
    dryRun?: boolean;
    maxItemsPerRun?: number;
    force?: boolean;
  }): Promise<TaskExecutionRecord>;
  created(): RecordedCall[];
  comments(): RecordedCall[];
}

/**
 * Jira responses. Each created issue gets a distinct key, so a test can tell a
 * refile from an adoption.
 */
function jiraRoutes(
  options: { existing?: string[]; issueStatus?: string; firstKey?: number } = {},
): Route[] {
  let nextIssue = options.firstKey ?? 100;
  return [
    { match: "/rest/api/3/myself", respond: { json: JIRA_MYSELF } },
    {
      match: "/rest/api/3/user",
      respond: (call) => {
        const accountId = call.url.searchParams.get("accountId") ?? "";
        return {
          json: {
            accountId,
            displayName:
              accountId === JIRA_MYSELF.accountId
                ? JIRA_MYSELF.displayName
                : accountId === "alice-account"
                  ? "Alice"
                  : accountId,
            active: true,
            accountType: "atlassian",
          },
        };
      },
    },
    { match: "/rest/api/3/project/TP", respond: { json: JIRA_PROJECT } },
    { match: "/rest/api/3/field", respond: { json: JIRA_FIELDS } },
    {
      match: "/rest/agile/1.0/board/21/sprint",
      respond: { json: JIRA_ACTIVE_SPRINT },
    },
    {
      // Reconciliation of an open subject: open unless the test says otherwise.
      match: /^\/rest\/api\/3\/issue\/TP-\d+$/,
      method: "GET",
      respond: (call) => ({
        json: issueResponse(
          call.url.pathname.split("/").pop()!,
          options.issueStatus ?? "new",
        ),
      }),
    },
    {
      match: /^\/rest\/api\/3\/issue\/TP-\d+\/comment$/,
      method: "POST",
      respond: { json: { id: "9000" } },
    },
    {
      // The orphan search. Empty by default: our own subject row is the primary guard and
      // most tests exercise it rather than JQL.
      match: "/rest/api/3/search/jql",
      method: "POST",
      respond: { json: searchResult((options.existing ?? []).map((key) => ({ key }))) },
    },
    {
      match: "/rest/api/3/issue",
      method: "POST",
      respond: () => ({ json: { ...JIRA_CREATED_ISSUE, key: `TP-${nextIssue++}` } }),
    },
  ];
}

function gitlabRoutes(options: { pipelines?: unknown[]; trace?: string } = {}): Route[] {
  const list = options.pipelines ?? [pipeline({ id: 9001 })];
  return [
    {
      match: /\/api\/v4\/projects\/[^/]+\/pipelines$/,
      // GitLab filters on `updated_after` server-side, and the watermark is the
      // whole reason the first run files nothing — so the double honours it too.
      respond: (call) => {
        const after = call.url.searchParams.get("updated_after");
        return {
          json: after
            ? list.filter((p) => String((p as { updated_at: string }).updated_at) > after)
            : list,
          headers: LAST_PAGE,
        };
      },
    },
    {
      match: /\/api\/v4\/projects\/[^/]+\/pipelines\/\d+$/,
      respond: (call) => ({
        json: { ...PIPELINE_DETAIL, id: Number(call.url.pathname.split("/").pop()) },
      }),
    },
    {
      match: /\/api\/v4\/projects\/[^/]+\/pipelines\/\d+\/jobs$/,
      respond: { json: [job({ id: 7001 })], headers: LAST_PAGE },
    },
    {
      match: /\/api\/v4\/projects\/[^/]+\/jobs\/\d+\/trace$/,
      respond: { text: options.trace ?? JEST_FAILURE_TRACE },
    },
    { match: /\/api\/v4\/projects\/[^/]+$/, respond: { json: GITLAB_PROJECT } },
  ];
}

function harness(
  routes: Route[],
  harnessOptions: { testHistory?: boolean; config?: Record<string, unknown> } = {},
): Harness {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);

  const state = new SqliteStateStore(db);
  const http = new FakeHttp(routes);
  const subjects = new SqliteSubjectStore(db);
  const testRuns = new SqliteTestRunHistoryStore(db);

  const executor = new TaskExecutor({
    logger: createLogger({ destination: new PassThrough(), pretty: false, level: "fatal" }),
    state,
    secrets: new EnvSecretStore({
      GITLAB_TOKEN: "glpat-test",
      JIRA_BASE_URL: "https://jira.test",
      JIRA_EMAIL: "bot@example.com",
      JIRA_TOKEN: "jira-token",
    }),
    sink: new SqliteTaskSink(db),
    defaultRetry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
  });

  const task = createCiFailureTask({
    fetch: http.fetch,
    subjects,
    ...(harnessOptions.testHistory ? { testRunHistory: testRuns } : {}),
    connectors: taskConnectorFactory,
  });

  return {
    db,
    http,
    state,
    subjects,
    testRuns,
    run: (runOptions = {}) =>
      executor.run(task, {
        params: harnessOptions.config ?? CONFIG,
        maxItemsPerRun: runOptions.maxItemsPerRun ?? 10,
        dryRun: runOptions.dryRun,
        force: runOptions.force,
      }),
    created: () =>
      http.calls.filter(
        (call) => call.method === "POST" && call.url.pathname.endsWith("/api/3/issue"),
      ),
    comments: () =>
      http.calls.filter(
        (call) => call.method === "POST" && call.url.pathname.endsWith("/comment"),
      ),
  };
}

const BACKDATE = new Date("2026-08-01T00:00:00Z");
const FAIL_SHA = PIPELINE_DETAIL.sha;
const SINGLE_FAILURE_TRACE = [
  `FAIL ${CHECKOUT}`,
  "  ● Checkout › applies a discount",
  "    Expected: 90",
  "    Received: 100",
  `Tests:       1 failed, 0 passed, 1 total`,
].join("\n");

function commitHistoryRoute(commits: unknown[]): Route {
  return {
    match: /\/api\/v4\/projects\/[^/]+\/repository\/commits$/,
    respond: { json: commits, headers: LAST_PAGE },
  };
}

function jiraUserSearchRoute(users: unknown[]): Route {
  return {
    match: "/rest/api/3/user/search",
    respond: { json: users },
  };
}

function automaticConfig(): Record<string, unknown> {
  return {
    ...CONFIG,
    jira: { ...CONFIG.jira, assigneeMode: "automatic" },
    failuresBeforeFiling: 1,
  };
}

/**
 * Puts the watermark behind the fixture pipeline, so the run has a window.
 *
 * Without this the first run seeds it to now and processes nothing — correct
 * behaviour, tested separately, but it would make every other test here empty.
 * A successful run advances it to *now*, which is ahead of the fixture pipeline —
 * so a test wanting to re-run over the same pipeline backdates again between
 * runs, exactly as a real second night would have a newer pipeline to find.
 */
function backdate(state: SqliteStateStore): Promise<void> {
  return state.setWatermark(TASK_ID, BACKDATE);
}

describe("the first run", () => {
  test("seeds the watermark and files nothing historical", async () => {
    const h = harness([...gitlabRoutes(), ...jiraRoutes()]);

    const record = await h.run();

    expect(record.status).toBe("success");
    expect(h.created()).toHaveLength(0);
    expect(await h.state.getWatermark(TASK_ID)).not.toBeNull();
    h.db.close();
  });
});

describe("an explicit rerun", () => {
  test("still examines the latest pipeline after the watermark has moved past it", async () => {
    const h = harness([...gitlabRoutes(), ...jiraRoutes()]);
    await backdate(h.state);

    const first = await h.run();
    expect(first.status).toBe("success");
    expect(h.created().length).toBeGreaterThan(0);

    // A successful run advances the watermark to now, ahead of the fixture.
    // A scheduled tick would correctly see nothing; Rerun must not.
    const second = await h.run({ force: true });
    expect(second.status).toBe("success");
    expect(second.result?.details).toMatchObject({ pipelines: 1 });
    expect((second.result?.itemsSeen ?? 0) + (second.result?.itemsProcessed ?? 0)).toBeGreaterThan(0);
    h.db.close();
  });
});

describe("filing", () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness([...gitlabRoutes(), ...jiraRoutes()]);
    await backdate(h.state);
  });

  test("files one ticket per failing spec file, not per test or per pipeline", async () => {
    const record = await h.run();

    // JEST_FAILURE_TRACE has three failures — two assertions in one file and one
    // suite that would not load — across two files.
    expect(h.created()).toHaveLength(2);
    expect(record.result?.itemsProcessed).toBe(2);
    expect(record.result?.details?.ticketOutcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "filed",
          issueKey: "TP-100",
          issueUrl: "https://jira.test/browse/TP-100",
          assignee: "Talos Bot",
        }),
      ]),
    );

    const subjects = h.subjects.openSubjects(TASK_ID).map((subject) => subject.subjectKey);
    expect(subjects.sort()).toEqual([`spec:${PROJECT}:${BILLING}`, `spec:${PROJECT}:${CHECKOUT}`]);
    h.db.close();
  });

  test("assigns to the JIRA_EMAIL account and puts the issue in the active sprint", async () => {
    await h.run();

    const fields = JSON.parse(h.created()[0]!.body!).fields;
    expect(fields.assignee).toEqual({ id: JIRA_MYSELF.accountId });
    // The sprint field is the per-site custom field, holding a bare id.
    expect(fields.customfield_10020).toBe(3128);
    expect(fields.issuetype).toEqual({ id: "10024" });
    expect(fields.customfield_10101).toEqual({ value: "automation" });
    expect(fields.customfield_10102).toEqual({ value: "FE" });
    h.db.close();
  });

  test("writes a title and an ADF description carrying the failure detail", async () => {
    await h.run();

    const bodies = h.created().map((c) => JSON.parse(c.body!).fields);
    const checkout = bodies.find((f) => String(f.summary).includes("checkout"))!;

    expect(checkout.summary).toContain("checkout.component.spec.ts");
    expect(checkout.summary).toContain("applies a percentage discount");
    expect(checkout.description.type).toBe("doc");

    const json = JSON.stringify(checkout.description);
    expect(json).toContain(CHECKOUT);
    expect(json).toContain("Received: 100");
    expect(json).toContain(PIPELINE_DETAIL.web_url);
    h.db.close();
  });

  test("labels each ticket with its file, which is how a ticket is found again", async () => {
    await h.run();

    const labels = JSON.parse(h.created()[0]!.body!).fields.labels as string[];
    expect(labels).toContain("talos");
    expect(labels).toContain("ci-failure");
    expect(labels.some((l) => l.startsWith("spec:"))).toBe(true);
    // Jira rejects whitespace in a label.
    expect(labels.every((l) => !/\s/.test(l))).toBe(true);
    h.db.close();
  });

  test("records every filed ticket with its audit trail", async () => {
    await h.run();

    const recorded = h.subjects.findOpen(TASK_ID, `spec:${PROJECT}:${CHECKOUT}`)!;
    expect(recorded.externalRef).toMatch(/^TP-\d+$/);
    expect(recorded.externalUrl).toBe(`https://jira.test/browse/${recorded.externalRef}`);
    expect(recorded.metadata).toMatchObject({
      action: "filed",
      file: CHECKOUT,
      pipelineId: 9001,
      jobId: 7001,
      jobName: "test:unit",
      ref: "main",
    });
    h.db.close();
  });

  test("records a step per spec file, so filing is visible in the history", async () => {
    const record = await h.run();

    const filing = record.steps.filter((s) => s.stepId.startsWith("file:"));
    expect(filing.map((s) => s.stepId).sort()).toEqual([
      `file:${BILLING}`,
      `file:${CHECKOUT}`,
    ]);
    expect(filing.every((s) => s.status === "success")).toBe(true);
    h.db.close();
  });
});

describe("unresolved Jest failures", () => {
  test("reports a parser diagnostic instead of creating a synthetic spec", async () => {
    const trace = [
      "  ● MysteryComponent › fails",
      "    Expected: true",
      "Tests:       1 failed, 0 passed, 1 total",
    ].join("\n");
    const h = harness(
      [...gitlabRoutes({ trace }), ...jiraRoutes()],
      { testHistory: true },
    );
    await backdate(h.state);

    const record = await h.run();

    expect(h.created()).toHaveLength(0);
    expect(record.result?.details?.parserIssues).toEqual([
      expect.objectContaining({
        pipelineId: 9001,
        jobId: 7001,
        failures: ["MysteryComponent › fails"],
      }),
    ]);
    expect(h.testRuns.listFlaky({ source: TASK_ID, project: PROJECT })).toEqual([]);
    expect(
      h.db
        .query<{ outcome: string }, []>(
          "SELECT outcome FROM test_runs WHERE source = 'gitlab-ci-failure'",
        )
        .get()?.outcome,
    ).toBe("inconclusive");
    h.db.close();
  });
});

describe("automatic assignee attribution", () => {
  test("assigns the last person who touched the implementation file", async () => {
    const h = harness(
      [
        ...gitlabRoutes({ trace: SINGLE_FAILURE_TRACE }),
        commitHistoryRoute([
          { id: FAIL_SHA, author_name: "Alice", author_email: "Alice@Example.com" },
        ]),
        jiraUserSearchRoute([
          {
            accountId: "alice-account",
            displayName: "Alice",
            emailAddress: "alice@example.com",
            active: true,
            accountType: "atlassian",
          },
        ]),
        ...jiraRoutes(),
      ],
      { config: automaticConfig() },
    );
    await backdate(h.state);

    await h.run();

    const fields = JSON.parse(h.created()[0]!.body!).fields;
    expect(fields.assignee).toEqual({ id: "alice-account" });
    const commitCall = h.http.calls.find((call) =>
      call.url.pathname.endsWith("/repository/commits"),
    );
    expect(commitCall?.url.searchParams.get("ref_name")).toBe(FAIL_SHA);
    expect(commitCall?.url.searchParams.get("path")).toBe(CHECKOUT_SOURCE);
    expect(commitCall?.url.searchParams.get("per_page")).toBe("1");
    h.db.close();
  });

  test("uses the newest source-file commit when GitLab returns extra commits", async () => {
    const h = harness(
      [
        ...gitlabRoutes({ trace: SINGLE_FAILURE_TRACE }),
        commitHistoryRoute([
          { id: FAIL_SHA, author_name: "Alice", author_email: "alice@example.com" },
          {
            id: "2222222222222222222222222222222222222222",
            author_name: "Bob",
            author_email: "bob@example.com",
          },
        ]),
        jiraUserSearchRoute([
          {
            accountId: "alice-account",
            displayName: "Alice",
            emailAddress: "alice@example.com",
            active: true,
            accountType: "atlassian",
          },
        ]),
        ...jiraRoutes(),
      ],
      { config: automaticConfig() },
    );
    await backdate(h.state);

    await h.run();

    const fields = JSON.parse(h.created()[0]!.body!).fields;
    expect(fields.assignee).toEqual({ id: "alice-account" });
    h.db.close();
  });

  test("falls back when the implementation file has no commit history", async () => {
    const h = harness(
      [
        ...gitlabRoutes({ trace: SINGLE_FAILURE_TRACE }),
        commitHistoryRoute([]),
        ...jiraRoutes(),
      ],
      { config: automaticConfig() },
    );
    await backdate(h.state);

    await h.run();

    const fields = JSON.parse(h.created()[0]!.body!).fields;
    expect(fields.assignee).toEqual({ id: JIRA_MYSELF.accountId });
    h.db.close();
  });

  test("falls back when the latest source author does not resolve in Jira", async () => {
    const h = harness(
      [
        ...gitlabRoutes({ trace: SINGLE_FAILURE_TRACE }),
        commitHistoryRoute([
          { id: FAIL_SHA, author_name: "Unknown", author_email: "unknown@example.com" },
        ]),
        jiraUserSearchRoute([]),
        ...jiraRoutes(),
      ],
      { config: automaticConfig() },
    );
    await backdate(h.state);

    await h.run();

    const fields = JSON.parse(h.created()[0]!.body!).fields;
    expect(fields.assignee).toEqual({ id: JIRA_MYSELF.accountId });
    h.db.close();
  });

  test("uses explicit and legacy fixed account ids without attribution", async () => {
    for (const jira of [
      { ...CONFIG.jira, assigneeMode: "fixed", assignee: "fixed-account" },
      { ...CONFIG.jira, assignee: "legacy-account" },
    ]) {
      const h = harness(
        [...gitlabRoutes({ trace: SINGLE_FAILURE_TRACE }), ...jiraRoutes()],
        { config: { ...CONFIG, jira } },
      );
      await backdate(h.state);

      await h.run();

      const fields = JSON.parse(h.created()[0]!.body!).fields;
      expect(fields.assignee).toEqual({
        id: "assigneeMode" in jira ? "fixed-account" : "legacy-account",
      });
      expect(
        h.http.calls.some((call) => call.url.pathname.endsWith("/repository/commits")),
      ).toBe(false);
      h.db.close();
    }
  });
});

describe("a Jira failure on one file", () => {
  /**
   * Jira rejects the creates for one spec file and accepts the other. Which file
   * fails is decided by the summary, since that is the only thing in the request
   * that identifies it.
   */
  function rejecting(file: string): Route[] {
    const routes = jiraRoutes();
    const create = routes.findIndex(
      (r) => typeof r.match === "string" && r.match === "/rest/api/3/issue",
    );

    const original = routes[create]!;
    routes[create] = {
      ...original,
      respond: (call) => {
        const summary = String(JSON.parse(call.body!).fields.summary);
        if (summary.includes(file.split("/").pop()!)) {
          return {
            status: 400,
            json: { errorMessages: ["Field 'summary' is too long."] },
          };
        }
        return typeof original.respond === "function"
          ? original.respond(call)
          : original.respond;
      },
    };
    return routes;
  }

  test("still files the other files, and fails only that file's step", async () => {
    const h = harness([...gitlabRoutes(), ...rejecting(CHECKOUT)]);
    await backdate(h.state);

    const record = await h.run();

    // The run as a whole survives: billing is filed even though checkout 400s.
    expect(record.status).toBe("success");
    expect(h.subjects.openSubjects(TASK_ID).map((subject) => subject.subjectKey)).toEqual([
      `spec:${PROJECT}:${BILLING}`,
    ]);

    const failed = record.steps.find((s) => s.stepId === `file:${CHECKOUT}`)!;
    expect(failed.status).toBe("failure");
    expect(failed.error).toContain("400");
    expect(record.steps.find((s) => s.stepId === `file:${BILLING}`)!.status).toBe(
      "success",
    );
    h.db.close();
  });

  test("does not retry the create, which would risk filing twice", async () => {
    const h = harness([...gitlabRoutes(), ...rejecting(CHECKOUT)]);
    await backdate(h.state);

    const record = await h.run();

    expect(record.steps.find((s) => s.stepId === `file:${CHECKOUT}`)!.attempts).toBe(1);
    h.db.close();
  });

  test("holds the watermark open, so the failed file is retried next run", async () => {
    const h = harness([...gitlabRoutes(), ...rejecting(CHECKOUT)]);
    await backdate(h.state);

    await h.run();

    // Unchanged: a run that could not file everything must not declare the
    // window covered.
    expect(await h.state.getWatermark(TASK_ID)).toEqual(BACKDATE);
    h.db.close();
  });
});

describe("the day after", () => {
  test("does not refile a ticket that is already open", async () => {
    // The single most important assertion in this suite.
    const h = harness([...gitlabRoutes(), ...jiraRoutes()]);
    await backdate(h.state);

    await h.run();
    expect(h.created()).toHaveLength(2);

    await backdate(h.state);
    const second = await h.run();

    expect(h.created()).toHaveLength(2);
    expect(h.comments()).toHaveLength(0);
    expect(second.result?.itemsProcessed).toBe(0);
    expect(second.result?.details?.ticketOutcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "unchanged", assignee: "Talos Bot" }),
      ]),
    );
    expect(h.subjects.countByState(TASK_ID)).toEqual({ open: 2, closed: 0 });
    h.db.close();
  });

  test("counts another sighting instead, so a stale ticket is distinguishable", async () => {
    const h = harness([...gitlabRoutes(), ...jiraRoutes()]);
    await backdate(h.state);

    for (let night = 0; night < 3; night++) {
      await backdate(h.state);
      await h.run();
    }

    expect(h.subjects.findOpen(TASK_ID, `spec:${PROJECT}:${CHECKOUT}`)!.seenCount).toBe(3);
    h.db.close();
  });

  test("comments once when the file's failures change, then goes quiet again", async () => {
    const h = harness([...gitlabRoutes(), ...jiraRoutes()]);
    await backdate(h.state);
    await h.run();

    // The same file, now failing a different test.
    const changed = JEST_FAILURE_TRACE.replace(
      "rejects a negative quantity",
      "rejects a zero quantity",
    );
    const h2 = harness([...gitlabRoutes({ trace: changed }), ...jiraRoutes()]);
    // Carry the first run's subjects over by replaying them into the second harness.
    for (const subject of h.subjects.openSubjects(TASK_ID)) {
      h2.subjects.open({
        loopId: TASK_ID,
        subjectKey: subject.subjectKey,
        externalRef: subject.externalRef,
        fingerprint: subject.fingerprint!,
      });
    }
    await backdate(h2.state);

    const second = await h2.run();
    expect(h2.created()).toHaveLength(0);
    expect(h2.comments()).toHaveLength(1);
    expect(second.result?.itemsProcessed).toBe(1);

    const comment = JSON.stringify(JSON.parse(h2.comments()[0]!.body!));
    expect(comment).toContain("rejects a zero quantity");
    expect(comment).toContain("No longer failing");

    // The new fingerprint is stored, so a third identical run says nothing. The
    // window is reopened first, or the run would find no pipeline and pass
    // whatever the fingerprint said.
    await backdate(h2.state);
    const third = await h2.run();
    expect(h2.comments()).toHaveLength(1);
    expect(third.result?.itemsProcessed).toBe(0);

    h.db.close();
    h2.db.close();
  });

  test("refiles once the old ticket is closed and the file breaks again", async () => {
    // Jira reports every issue resolved, so reconciliation closes the subjects.
    const h = harness([...gitlabRoutes(), ...jiraRoutes()]);
    await backdate(h.state);
    await h.run();
    const firstKeys = h.subjects.openSubjects(TASK_ID).map((subject) => subject.externalRef);

    const h2 = harness([
      ...gitlabRoutes(),
      ...jiraRoutes({ issueStatus: "done", firstKey: 900 }),
    ]);
    for (const subject of h.subjects.openSubjects(TASK_ID)) {
      h2.subjects.open({
        loopId: TASK_ID,
        subjectKey: subject.subjectKey,
        externalRef: subject.externalRef,
        fingerprint: subject.fingerprint!,
      });
    }
    await backdate(h2.state);

    await h2.run();

    expect(h2.created()).toHaveLength(2);
    expect(h2.subjects.countByState(TASK_ID)).toEqual({ open: 2, closed: 2 });
    // New keys, and the closed rows survive as the file's history.
    expect(h2.subjects.openSubjects(TASK_ID).map((subject) => subject.externalRef)).not.toEqual(firstKeys);
    h.db.close();
    h2.db.close();
  });

  test("never closes a subject just because the tests changed", async () => {
    // Whether a ticket is accepted and closed is its owner's decision.
    const h = harness([...gitlabRoutes(), ...jiraRoutes()]);
    await backdate(h.state);
    await h.run();

    // Second run sees only one of the two files failing.
    const h2 = harness([
      ...gitlabRoutes({ trace: "FAIL src/app/checkout/checkout.component.spec.ts\n  ● x › y\n    boom" }),
      ...jiraRoutes(),
    ]);
    for (const subject of h.subjects.openSubjects(TASK_ID)) {
      h2.subjects.open({
        loopId: TASK_ID,
        subjectKey: subject.subjectKey,
        externalRef: subject.externalRef,
        fingerprint: subject.fingerprint!,
      });
    }
    await backdate(h2.state);
    await h2.run();

    // The billing ticket is still open even though billing did not fail tonight.
    expect(h2.subjects.findOpen(TASK_ID, `spec:${PROJECT}:${BILLING}`)).not.toBeNull();
    h.db.close();
    h2.db.close();
  });
});

describe("reconciling with Jira", () => {
  test("adopts a ticket that exists in Jira but not in our own table", async () => {
    // A crash between creating and recording, or a hand-filed ticket.
    const h = harness([...gitlabRoutes(), ...jiraRoutes({ existing: ["TP-500"] })]);
    await backdate(h.state);

    const record = await h.run();

    expect(h.created()).toHaveLength(0);
    expect(record.result?.itemsProcessed).toBe(0);
    expect(h.subjects.findOpen(TASK_ID, `spec:${PROJECT}:${CHECKOUT}`)?.externalRef).toBe("TP-500");
    h.db.close();
  });

  test("files anyway when the reconciliation search fails", async () => {
    // A JQL permission problem must not silently stop all reporting. The failing
    // route goes first: FakeHttp matches in registration order, so this shadows
    // the successful search in jiraRoutes().
    const failing = harness([
      {
        match: "/rest/api/3/search/jql",
        method: "POST",
        respond: { status: 403, json: { errorMessages: ["no"] } },
      },
      ...gitlabRoutes(),
      ...jiraRoutes(),
    ]);
    await backdate(failing.state);

    const record = await failing.run();
    expect(record.status).toBe("success");
    expect(failing.created()).toHaveLength(2);
    failing.db.close();
  });

  test("releases a subject whose ticket was deleted in Jira", async () => {
    const h = harness([
      {
        match: /^\/rest\/api\/3\/issue\/TP-\d+$/,
        method: "GET",
        respond: { status: 404, json: { errorMessages: ["Issue does not exist"] } },
      },
      ...gitlabRoutes(),
      ...jiraRoutes(),
    ]);
    await backdate(h.state);

    h.subjects.open({
      loopId: TASK_ID,
      subjectKey: `spec:${PROJECT}:${CHECKOUT}`,
      externalRef: "TP-77",
      fingerprint: "stale",
    });

    await h.run();

    expect(h.subjects.history(TASK_ID, `spec:${PROJECT}:${CHECKOUT}`)).toHaveLength(2);
    expect(h.subjects.findOpen(TASK_ID, `spec:${PROJECT}:${CHECKOUT}`)?.externalRef).not.toBe(
      "TP-77",
    );
    h.db.close();
  });
});

describe("failing early", () => {
  test("resolves the Jira target before filing anything, so a bad issue type files nothing", async () => {
    // A project whose scheme lacks the configured type, shadowing jiraRoutes().
    const broken = harness([
      {
        match: "/rest/api/3/project/TP",
        respond: { json: { id: "10012", key: "TP", issueTypes: [{ id: "1", name: "Task" }] } },
      },
      ...gitlabRoutes(),
      ...jiraRoutes(),
    ]);
    await backdate(broken.state);

    await expect(broken.run()).rejects.toThrow(/issue type 'Bug'/);
    expect(broken.created()).toHaveLength(0);
    // The trace was never even fetched: the failure is at the front of the run.
    expect(broken.http.callsTo("/trace")).toHaveLength(0);
    broken.db.close();
  });

  test("refuses to run without a durable subject repository", async () => {
    const memory = new MemoryStateStore();
    const executor = new TaskExecutor({
      logger: createLogger({ destination: new PassThrough(), pretty: false, level: "fatal" }),
      state: memory,
      secrets: new EnvSecretStore({
        GITLAB_TOKEN: "t",
        JIRA_BASE_URL: "https://jira.test",
        JIRA_EMAIL: "bot@example.com",
        JIRA_TOKEN: "t",
      }),
      defaultRetry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    const http = new FakeHttp([]);
    await expect(
      executor.run(createCiFailureTask({ fetch: http.fetch }), {
        params: CONFIG,
        maxItemsPerRun: 10,
      }),
    ).rejects.toThrow(/durable subject repository/);
  });

  test("files to the backlog rather than failing when there is no active sprint", async () => {
    const h = harness([
      { match: "/rest/agile/1.0/board/21/sprint", respond: { json: { values: [], isLast: true } } },
      ...gitlabRoutes(),
      ...jiraRoutes(),
    ]);
    await backdate(h.state);

    const record = await h.run();

    expect(record.status).toBe("success");
    expect(h.created()).toHaveLength(2);
    // A broken test is worth a ticket even when the sprint is unknown.
    expect(JSON.parse(h.created()[0]!.body!).fields.customfield_10020).toBeUndefined();
    expect(record.result?.details?.sprintSkipped).toMatch(/no active sprint/);
    h.db.close();
  });
});

describe("dry run", () => {
  test("creates nothing and records nothing, so a real run still files", async () => {
    const h = harness([...gitlabRoutes(), ...jiraRoutes()]);
    await backdate(h.state);

    const dry = await h.run({ dryRun: true });
    expect(h.created()).toHaveLength(0);
    expect(h.subjects.countByState(TASK_ID)).toEqual({ open: 0, closed: 0 });
    expect(dry.result?.itemsSeen).toBe(2);

    await backdate(h.state);
    await h.run();
    expect(h.created()).toHaveLength(2);
    h.db.close();
  });

  test("suppresses a comment without storing the new fingerprint", async () => {
    const h = harness([...gitlabRoutes(), ...jiraRoutes()]);
    await backdate(h.state);
    h.subjects.open({
      loopId: TASK_ID,
      subjectKey: `spec:${PROJECT}:${CHECKOUT}`,
      externalRef: "TP-77",
      fingerprint: "something else entirely",
    });

    await h.run({ dryRun: true });

    expect(h.comments()).toHaveLength(0);
    // Storing it would make the next real run believe the comment was posted.
    expect(h.subjects.findOpen(TASK_ID, `spec:${PROJECT}:${CHECKOUT}`)!.fingerprint).toBe(
      "something else entirely",
    );
    h.db.close();
  });
});

describe("the item cap", () => {
  test("bounds tickets per run and holds the watermark for the rest", async () => {
    const h = harness([...gitlabRoutes(), ...jiraRoutes()]);
    const watermark = new Date("2026-08-01T00:00:00Z");
    await h.state.setWatermark(TASK_ID, watermark);

    const record = await h.run({ maxItemsPerRun: 1 });

    expect(h.created()).toHaveLength(1);
    expect(record.result?.itemsProcessed).toBe(1);
    // Not advanced: the unexamined file would otherwise fall behind it forever.
    expect((await h.state.getWatermark(TASK_ID))!.getTime()).toBe(watermark.getTime());

    // The next run picks up what was deferred.
    const second = await h.run({ maxItemsPerRun: 10 });
    expect(h.created()).toHaveLength(2);
    expect(second.result?.itemsProcessed).toBe(1);
    h.db.close();
  });
});

describe("nothing to do", () => {
  test("advances the watermark when no pipeline is in the window", async () => {
    const h = harness([...gitlabRoutes({ pipelines: [] }), ...jiraRoutes()]);
    await backdate(h.state);

    const record = await h.run();

    expect(record.result?.itemsSeen).toBe(0);
    expect(h.created()).toHaveLength(0);
    expect((await h.state.getWatermark(TASK_ID))!.getTime()).toBeGreaterThan(
      new Date("2026-08-01T00:00:00Z").getTime(),
    );
    h.db.close();
  });

  test("files nothing for a job whose failure is not a test failure", async () => {
    const h = harness([
      ...gitlabRoutes({ trace: "$ npm ci\nnpm error EBADENGINE\nERROR: Job failed: exit code 1" }),
      ...jiraRoutes(),
    ]);
    await backdate(h.state);

    const record = await h.run();
    expect(h.created()).toHaveLength(0);
    expect(record.result?.itemsSeen).toBe(0);
    h.db.close();
  });
});
