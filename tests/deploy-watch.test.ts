import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";
import type {
  DeployWatchFindingAnnouncement,
  ReleaseNotifier,
} from "../src/application/ports.ts";
import type { TaskContext } from "../src/core/task.ts";
import { createLogger } from "../src/logging/logger.ts";
import { SqliteDeployWatchStore } from "../src/persistence/deploy-watch-store.ts";
import { SqliteJobQueue } from "../src/persistence/job-queue.ts";
import { SqliteLogRocketIssueStore } from "../src/persistence/logrocket-issue-store.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { MemoryStateStore } from "../src/persistence/state-store.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import { createDeployWatchTask } from "../src/tasks/deploy-watch/index.ts";
import { buildDeployWatchFindingSlackMessage } from "../shared/release-format.ts";

function harness() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  return {
    db,
    watches: new SqliteDeployWatchStore(db),
    issues: new SqliteLogRocketIssueStore(db),
    jobs: new SqliteJobQueue(db),
  };
}

function context(): TaskContext {
  return {
    taskId: "deploy-watch",
    executionId: crypto.randomUUID(),
    logger: createLogger({
      destination: new PassThrough(),
      pretty: false,
      level: "fatal",
    }),
    state: new MemoryStateStore(),
    secrets: new EnvSecretStore({ DATADOG_TOKEN: "ddpat_test-token" }),
    dryRun: false,
    maxItemsPerRun: 10,
    force: false,
    signal: new AbortController().signal,
    llm: { provider: "anthropic", maxTokens: 2048 },
    prompts: {},
    step: async (_id, fn) => fn(),
  };
}

const emptyDatadogFetch = async () =>
  new Response(JSON.stringify({ data: [], meta: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("post-deploy watch persistence", () => {
  test("queries first-seen LogRocket issues by time regardless of triage state", () => {
    const { db, issues } = harness();
    const before = issues.record({
      title: "Before",
      url: "https://app.logrocket.com/issue/before",
      firstSeenAt: new Date("2026-09-16T08:00:00.000Z"),
      payload: {},
    });
    const during = issues.record({
      title: "During",
      url: "https://app.logrocket.com/issue/during",
      firstSeenAt: new Date("2026-09-16T10:30:00.000Z"),
      payload: {},
    });
    issues.setState(during.id, "dismissed");

    expect(
      issues
        .firstSeenBetween(
          new Date("2026-09-16T10:00:00.000Z"),
          new Date("2026-09-16T11:00:00.000Z"),
        )
        .map((issue) => issue.id),
    ).toEqual([during.id]);
    expect(before.id).not.toBe(during.id);
    db.close();
  });

  test("round-trips source metadata and deduplicates within a source", () => {
    const { db, watches } = harness();
    const watch = watches.create({
      environment: "PROD",
      projectId: "group/releases",
      mrIid: 42,
      mrUrl: "https://gitlab.example/mr/42",
      branch: "release/prod",
      services: ["web"],
    });
    const finding = {
      watchId: watch.id,
      source: "logrocket" as const,
      signature: "Checkout crashes",
      fingerprint: "logrocket:checkout",
      eventCount: 4,
      externalUrl: "https://app.logrocket.com/issue/checkout",
      issueType: "Error",
      firstSeenAt: new Date("2026-09-16T10:30:00.000Z"),
    };

    expect(watches.addFinding(finding)).toMatchObject({
      source: "logrocket",
      externalUrl: finding.externalUrl,
      issueType: "Error",
    });
    expect(watches.addFinding(finding)).toBeNull();
    expect(
      watches.addFinding({
        watchId: watch.id,
        source: "datadog",
        service: "web",
        signature: "Checkout crashes",
        fingerprint: "checkout",
        eventCount: 3,
        firstSeenAt: finding.firstSeenAt,
      }),
    ).toMatchObject({ source: "datadog" });
    expect(watches.findings(watch.id)).toHaveLength(2);
    db.close();
  });

});

describe("LogRocket post-deploy detection", () => {
  test("records only issues first seen after merge and announces each once", async () => {
    const { db, watches, issues, jobs } = harness();
    const mergedAt = new Date(Date.now() - 60 * 60_000);
    const watchUntil = new Date(Date.now() + 5 * 60 * 60_000);
    const created = watches.create({
      environment: "PROD",
      projectId: "group/releases",
      mrIid: 42,
      mrUrl: "https://gitlab.example/mr/42",
      branch: "release/prod",
      actorId: "actor-1",
      services: ["api"],
    });
    watches.update(created.id, { state: "watching", mergedAt, watchUntil });
    const watch = watches.setBaseline(created.id, [], mergedAt);

    const oldIssue = issues.record({
      title: "Known checkout error",
      url: "https://app.logrocket.com/issue/known",
      firstSeenAt: new Date(mergedAt.getTime() - 60_000),
      payload: {},
    });
    // A delivery after merge must not make a previously known issue look new.
    issues.record({
      title: oldIssue.title,
      url: oldIssue.url,
      sessionCount: 20,
      payload: {},
    });
    issues.record({
      title: "New checkout error",
      issueType: "Error",
      url: "https://app.logrocket.com/issue/new",
      sessionCount: 3,
      firstSeenAt: new Date(mergedAt.getTime() + 60_000),
      summary: "Checkout failed while confirming payment.",
      payload: {},
    });

    const announcements: DeployWatchFindingAnnouncement[] = [];
    const notifier: ReleaseNotifier = {
      configured: () => true,
      announce: async () => {},
      announceFinding: async (input) => {
        announcements.push(input);
      },
    };
    const task = createDeployWatchTask({
      deployWatches: watches,
      logRocketIssues: issues,
      jobs,
      notifier,
      fetch: emptyDatadogFetch,
    });

    const first = await task.run(context(), { watchId: watch.id });
    const second = await task.run(context(), { watchId: watch.id });

    expect(first.itemsProcessed).toBe(1);
    expect(second.itemsProcessed).toBe(0);
    expect(watches.findings(watch.id)).toEqual([
      expect.objectContaining({
        source: "logrocket",
        signature: "New checkout error",
        eventCount: 3,
        externalUrl: "https://app.logrocket.com/issue/new",
        issueType: "Error",
      }),
    ]);
    expect(announcements).toEqual([
      expect.objectContaining({
        source: "logrocket",
        signature: "New checkout error",
        externalUrl: "https://app.logrocket.com/issue/new",
      }),
    ]);
    db.close();
  });

  test("records and announces LogRocket findings when Datadog fails", async () => {
    const { db, watches, issues, jobs } = harness();
    const mergedAt = new Date(Date.now() - 60_000);
    const created = watches.create({
      environment: "PROD",
      projectId: "group/releases",
      mrIid: 43,
      mrUrl: "https://gitlab.example/mr/43",
      branch: "release/prod",
      services: ["web"],
    });
    watches.update(created.id, {
      state: "watching",
      mergedAt,
      watchUntil: new Date(Date.now() + 60 * 60_000),
    });
    const watch = watches.setBaseline(created.id, [], mergedAt);
    issues.record({
      title: "New frontend crash",
      url: "https://app.logrocket.com/issue/crash",
      firstSeenAt: new Date(mergedAt.getTime() + 1_000),
      payload: {},
    });

    const announcements: DeployWatchFindingAnnouncement[] = [];
    const task = createDeployWatchTask({
      deployWatches: watches,
      logRocketIssues: issues,
      jobs,
      notifier: {
        configured: () => true,
        announce: async () => {},
        announceFinding: async (input) => {
          announcements.push(input);
        },
      },
      fetch: async () => new Response("unavailable", { status: 500 }),
    });

    await expect(task.run(context(), { watchId: watch.id })).rejects.toThrow("returned 500");
    expect(watches.findings(watch.id)).toEqual([
      expect.objectContaining({ source: "logrocket", signature: "New frontend crash" }),
    ]);
    expect(announcements).toHaveLength(1);
    db.close();
  });
});

describe("deploy-watch Slack formatting", () => {
  test("identifies and links a LogRocket finding", () => {
    const message = buildDeployWatchFindingSlackMessage({
      source: "logrocket",
      environment: "prod",
      signature: "Checkout crashes",
      issueType: "Error",
      eventCount: 3,
      externalUrl: "https://app.logrocket.com/issue/checkout",
      releaseUrl: "https://gitlab.example/mr/42",
      releaseLabel: "!42",
    });

    expect(message).toContain("New LogRocket issue since the PROD release");
    expect(message).toContain("<https://app.logrocket.com/issue/checkout|Open in LogRocket>");
    expect(message).toContain("<https://gitlab.example/mr/42|Release !42>");
  });
});
