import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";

import type { TaskConnectorFactory } from "../src/application/gateways.ts";
import type { DatadogProblemFinding } from "../src/application/datadog-scan.ts";
import {
  ticketDatadogRegressions,
  type DatadogJiraTicketConfig,
} from "../src/application/datadog-ticketing.ts";
import type { DatadogSeverity } from "../src/application/ports.ts";
import type { TaskContext } from "../src/core/task.ts";
import { fitDocument } from "../src/connectors/jira/adf.ts";
import { createLogger } from "../src/logging/logger.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteDatadogIssueStore } from "../src/persistence/datadog-issue-store.ts";
import { SqliteDatadogRoutingStore } from "../src/persistence/datadog-routing-store.ts";
import { SqliteSubjectStore } from "../src/persistence/subject-store.ts";
import { MemoryStateStore } from "../src/persistence/state-store.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import { issueResponse, searchResult } from "./fixtures/jira.ts";

interface Harness {
  db: Database;
  issues: SqliteDatadogIssueStore;
  subjects: SqliteSubjectStore;
  created: { key: string; input: unknown }[];
  context(options?: { dryRun?: boolean; maxItemsPerRun?: number }): TaskContext;
  finding(options?: {
    severity?: DatadogSeverity;
    confirmed?: boolean;
    dismissed?: boolean;
    previousJiraIssueKeys?: string[];
    sampleMessage?: string;
    sampleStack?: string;
  }): DatadogProblemFinding;
  run(problem: DatadogProblemFinding, context?: TaskContext): ReturnType<
    typeof ticketDatadogRegressions
  >;
  runMany(problems: DatadogProblemFinding[], context?: TaskContext): ReturnType<
    typeof ticketDatadogRegressions
  >;
  runConfigured(
    problem: DatadogProblemFinding,
    config: DatadogJiraTicketConfig,
    context?: TaskContext,
  ): ReturnType<typeof ticketDatadogRegressions>;
}

function harness(options: {
  jiraCategory?: "new" | "done";
  orphan?: string;
  orphanCategory?: "new" | "done";
  activeMrKey?: string;
  noActiveSprint?: boolean;
} = {}): Harness {
  const db = new Database(":memory:");
  migrate(db);
  const issues = new SqliteDatadogIssueStore(db);
  const routing = new SqliteDatadogRoutingStore(db);
  const subjects = new SqliteSubjectStore(db);
  const created: { key: string; input: unknown }[] = [];
  let nextKey = 100;

  const jira = {
    issue: async (key: string) => issueResponse(key, options.jiraCategory ?? "new"),
    issueUrl: (key: string) => `https://jira.test/browse/${key}`,
    searchIssues: async () =>
      searchResult(
        options.orphan
          ? [{ key: options.orphan, category: options.orphanCategory }]
          : [],
      ).issues,
    createIssue: async (input: unknown) => {
      const key = `TP-${nextKey++}`;
      created.push({ key, input });
      return { id: String(nextKey), key, self: `https://jira.test/rest/api/3/issue/${key}` };
    },
    accountIdForEmail: async () => "integration-account",
    findSprintFieldId: async () => "customfield_10020",
    resolveActiveSprint: async () =>
      options.noActiveSprint
        ? { reason: "board has no active sprint" }
        : { sprint: { id: 3128, name: "Current", state: "active" } },
    extraSelectFields: async (
      fields: { name: string; value: string }[],
    ) =>
      Object.fromEntries(
        fields.map((field, index) => [`customfield_${10101 + index}`, field.value]),
      ),
  };
  const gitlab = {
    listMergeRequests: async () =>
      options.activeMrKey
        ? [
            {
              id: 1,
              iid: 7,
              project_id: 1,
              title: `Fix ${options.activeMrKey}`,
              state: "opened",
              source_branch: `fix/${options.activeMrKey}`,
              target_branch: "master",
              web_url: "https://gitlab.test/group/service/-/merge_requests/7",
              updated_at: new Date("2026-09-23T00:00:00Z"),
            },
          ]
        : [],
  };
  const connectors = {
    jira: () => jira,
    gitlab: () => gitlab,
  } as unknown as TaskConnectorFactory;

  const context = (
    runOptions: { dryRun?: boolean; maxItemsPerRun?: number } = {},
  ): TaskContext =>
    ({
      taskId: "datadog-loop-instance",
      executionId: "run-1",
      logger: createLogger({
        destination: new PassThrough(),
        pretty: false,
        level: "fatal",
      }),
      state: new MemoryStateStore(),
      secrets: new EnvSecretStore({
        DATADOG_SITE: "datadoghq.com",
        DATADOG_JIRA_PROJECT: "TP",
      }),
      dryRun: runOptions.dryRun ?? false,
      maxItemsPerRun: runOptions.maxItemsPerRun ?? 10,
      force: false,
      signal: new AbortController().signal,
      llm: { provider: "none", maxTokens: 1 },
      prompts: {},
      step: async (_id, fn) => await fn(),
    }) as TaskContext;

  const finding = (
    findingOptions: {
      severity?: DatadogSeverity;
      confirmed?: boolean;
      dismissed?: boolean;
      previousJiraIssueKeys?: string[];
      sampleMessage?: string;
      sampleStack?: string;
    } = {},
  ): DatadogProblemFinding => {
    const issue = issues.record({
      service: "checkout",
      signature: "CheckoutWorker failed for order <NUM>",
      title: "checkout: CheckoutWorker failed",
      problemKey: "scan-problem",
      problemTitle: "checkout: CheckoutWorker failed",
      problemEventCount: 12,
      severity: findingOptions.severity ?? "critical",
      area: "backend",
      eventCount: 12,
      sampleCount: 3,
      sampleSize: 20,
      status: "error",
      env: "prod",
      sampleLogId: "log-1",
      sampleMessage:
        findingOptions.sampleMessage ?? "CheckoutWorker failed for order 42",
      sampleStack: findingOptions.sampleStack,
      query: "status:error env:prod service:checkout",
      firstSeenAt: new Date("2026-09-22T23:00:00Z"),
      lastSeenAt: new Date("2026-09-23T00:00:00Z"),
    });
    if (findingOptions.dismissed) issues.setState(issue.id, "dismissed");
    const current = issues.get(issue.id)!;
    return {
      key: "scan-problem",
      title: "checkout: CheckoutWorker failed",
      service: "checkout",
      eventCount: 12,
      severity: findingOptions.severity ?? "critical",
      isNew: true,
      confirmedOnPriorDailyScan: findingOptions.confirmed ?? false,
      dismissed: findingOptions.dismissed ?? false,
      previousJiraIssueKeys: findingOptions.previousJiraIssueKeys ?? [],
      members: [current],
      memberFingerprints: [current.fingerprint],
    };
  };

  return {
    db,
    issues,
    subjects,
    created,
    context,
    finding,
    run: (problem, ctx = context()) =>
      ticketDatadogRegressions(ctx, [problem], {
        issues,
        routing,
        subjects,
        connectors,
      }),
    runMany: (problems, ctx = context()) =>
      ticketDatadogRegressions(ctx, problems, {
        issues,
        routing,
        subjects,
        connectors,
      }),
    runConfigured: (problem, config, ctx = context()) =>
      ticketDatadogRegressions(
        ctx,
        [problem],
        { issues, routing, subjects, connectors },
        config,
      ),
  };
}

describe("Datadog regression ticket lifecycle", () => {
  test("files a critical problem and leaves later sightings on the open ticket", async () => {
    const h = harness();
    const problem = h.finding();

    expect((await h.run(problem)).filed).toBe(1);
    const linked = h.issues.get(problem.members[0]!.id)!;
    expect(linked.jiraIssueKey).toBe("TP-100");
    expect(h.subjects.openSubjects("datadog-loop-instance")[0]?.seenCount).toBe(1);

    const repeated = {
      ...problem,
      isNew: false,
      previousJiraIssueKeys: ["TP-100"],
      members: [linked],
    };
    expect((await h.run(repeated)).existing).toBe(1);
    expect(h.created).toHaveLength(1);
    expect(h.subjects.countByState("datadog-loop-instance").open).toBe(1);
    h.db.close();
  });

  test("applies saved Jira assignee, sprint, labels, issue type, and custom fields", async () => {
    const h = harness();
    const problem = h.finding();

    expect(
      (
        await h.runConfigured(problem, {
          project: "OPS",
          issueType: "Incident",
          assigneeMode: "fixed",
          assignee: "alice-account",
          boardId: 21,
          useActiveSprint: true,
          labels: ["talos", "prod-regression"],
          bugFoundBy: "Automation",
          feBeUx: "BE",
        })
      ).filed,
    ).toBe(1);

    const input = h.created[0]!.input as Record<string, unknown>;
    expect(input).toMatchObject({
      projectKey: "OPS",
      issueType: "Incident",
      assigneeAccountId: "alice-account",
      sprintId: 3128,
      extraFields: {
        customfield_10101: "Automation",
        customfield_10102: "BE",
      },
    });
    expect(input.labels).toEqual(
      expect.arrayContaining([
        "talos",
        "prod-regression",
        "datadog",
        "datadog-critical",
      ]),
    );
    h.db.close();
  });

  test("persists and includes the complete sampled stack trace in Jira", async () => {
    const h = harness();
    const stack = `${"at CheckoutWorker.capture (CheckoutWorker.ts:42)\n".repeat(450)}TRACE_END`;
    const problem = h.finding({ sampleStack: stack });

    expect(h.issues.get(problem.members[0]!.id)?.sampleStack).toBe(stack);
    expect((await h.run(problem)).filed).toBe(1);
    const description = (h.created[0]!.input as {
      description: Parameters<typeof fitDocument>[0];
    }).description;
    expect(JSON.stringify(fitDocument(description))).toContain("TRACE_END");
    h.db.close();
  });

  test("does not create a Datadog ticket without an active sprint", async () => {
    const h = harness({ noActiveSprint: true });

    const result = await h.run(h.finding());

    expect(result.failed).toBe(1);
    expect(result.outcomes[0]?.reason).toContain("require an active sprint");
    expect(h.created).toHaveLength(0);
    h.db.close();
  });

  test("holds medium problems until a later daily observation", async () => {
    const h = harness();
    const first = h.finding({ severity: "medium" });

    expect((await h.run(first)).held).toBe(1);
    expect(h.created).toHaveLength(0);
    expect((await h.run({ ...first, confirmedOnPriorDailyScan: true })).filed).toBe(1);
    h.db.close();
  });

  test("does not backfill old unticketed scan noise on rollout", async () => {
    const h = harness();
    const problem = h.finding({ confirmed: true });
    const historical = {
      ...problem,
      isNew: false,
      members: [
        {
          ...problem.members[0]!,
          scanCount: 8,
          firstSeenAt: new Date("2026-09-01T00:00:00Z"),
        },
      ],
    };

    const result = await h.run(historical);

    expect(result.held).toBe(1);
    expect(result.outcomes[0]?.reason).toContain("predates");
    expect(h.created).toHaveLength(0);
    h.db.close();
  });

  test("keeps a resolved Jira issue tracked while its merge request is open", async () => {
    const h = harness({ jiraCategory: "done", activeMrKey: "TP-9" });
    const problem = h.finding({ previousJiraIssueKeys: ["TP-9"] });
    h.issues.link(problem.members[0]!.id, "TP-9");

    const result = await h.run(problem);

    expect(result.activePr).toBe(1);
    expect(result.outcomes[0]?.mrUrl).toContain("merge_requests/7");
    expect(h.created).toHaveLength(0);
    expect(h.subjects.countByState("datadog-loop-instance").open).toBe(1);
    h.db.close();
  });

  test("refiles a resolved issue when no active merge request remains", async () => {
    const h = harness({ jiraCategory: "done" });
    const problem = h.finding({ previousJiraIssueKeys: ["TP-9"] });
    h.issues.link(problem.members[0]!.id, "TP-9");

    expect((await h.run(problem)).filed).toBe(1);
    expect(h.issues.get(problem.members[0]!.id)?.jiraIssueKey).toBe("TP-100");
    h.db.close();
  });

  test("adopts an open fingerprint-labelled ticket without creating another", async () => {
    const h = harness({ orphan: "TP-77" });
    const problem = h.finding();

    expect((await h.run(problem)).adopted).toBe(1);
    expect(h.created).toHaveLength(0);
    expect(h.issues.get(problem.members[0]!.id)?.jiraIssueKey).toBe("TP-77");
    h.db.close();
  });

  test("suppresses a resolved orphan while its fingerprint-linked MR is open", async () => {
    const h = harness({
      orphan: "TP-78",
      orphanCategory: "done",
      activeMrKey: "TP-78",
    });
    const problem = h.finding();

    expect((await h.run(problem)).activePr).toBe(1);
    expect(h.created).toHaveLength(0);
    expect(h.issues.get(problem.members[0]!.id)?.jiraIssueKey).toBe("TP-78");
    h.db.close();
  });

  test("uses a fingerprint claim to stop concurrent Jira creation", async () => {
    const h = harness();
    const problem = h.finding();
    h.subjects.open({
      loopId: "datadog-regression-ticket-claims",
      subjectKey: `datadog:problem:${problem.memberFingerprints[0]}`,
      fingerprint: problem.memberFingerprints[0]!,
      metadata: { action: "claim", title: problem.title },
    });

    const result = await h.run(problem);

    expect(result.deferred).toBe(1);
    expect(result.outcomes[0]?.reason).toContain("another run");
    expect(h.created).toHaveLength(0);
    h.db.close();
  });

  test("does not mutate existing lifecycle state during a dry run", async () => {
    const h = harness();
    const problem = h.finding({ previousJiraIssueKeys: ["TP-9"] });
    const linked = h.issues.link(problem.members[0]!.id, "TP-9")!;
    h.subjects.open({
      loopId: "datadog-loop-instance",
      subjectKey: `datadog:problem:${linked.fingerprint}`,
      fingerprint: linked.fingerprint,
      externalRef: "TP-9",
      externalUrl: "https://jira.test/browse/TP-9",
      metadata: { title: problem.title },
    });
    const before = h.subjects.openSubjects("datadog-loop-instance")[0]!;

    expect(
      (
        await h.run(
          { ...problem, members: [linked] },
          h.context({ dryRun: true }),
        )
      ).existing,
    ).toBe(1);
    const after = h.subjects.openSubjects("datadog-loop-instance")[0]!;
    expect(after.seenCount).toBe(before.seenCount);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(h.issues.get(linked.id)?.jiraFiledAt).toEqual(linked.jiraFiledAt);
    h.db.close();
  });

  test("consumes the write cap when Jira succeeds but local bookkeeping fails", async () => {
    const h = harness();
    const first = h.finding();
    const second = {
      ...first,
      key: "second-problem",
      title: "checkout: second failure",
      memberFingerprints: ["second-fingerprint"],
    };
    h.issues.link = () => {
      throw new Error("local link failed");
    };

    const result = await h.runMany(
      [first, second],
      h.context({ maxItemsPerRun: 1 }),
    );

    expect(h.created).toHaveLength(1);
    expect(result.failed).toBe(1);
    expect(result.deferred).toBe(1);
    h.db.close();
  });

  test("keeps dismissed, capped, and dry-run candidates side-effect free", async () => {
    const dismissed = harness();
    expect((await dismissed.run(dismissed.finding({ dismissed: true }))).dismissed).toBe(1);
    expect(dismissed.created).toHaveLength(0);
    dismissed.db.close();

    const capped = harness();
    expect(
      (await capped.run(capped.finding(), capped.context({ maxItemsPerRun: 0 }))).deferred,
    ).toBe(1);
    expect(capped.created).toHaveLength(0);
    capped.db.close();

    const dry = harness();
    expect(
      (await dry.run(dry.finding(), dry.context({ dryRun: true }))).suppressed,
    ).toBe(1);
    expect(dry.created).toHaveLength(0);
    dry.db.close();
  });
});
