/**
 * "Write a regression test for this" — the second thing a production error can
 * become, next to a Jira ticket and a fix.
 *
 * A sibling of `ticket-actions.ts` and shaped like it deliberately: a queued
 * job rather than a direct `tasks.run`, so the click inherits retry with backoff,
 * the dead-job brake, per-kind concurrency and a row the graph can draw.
 *
 * The repository is resolved before this shared enqueue step: Datadog uses its
 * team-owned service mapping and LogRocket uses the clicking developer's
 * `FixIssueDefaults`. Only the base branch may be overridden for one confirmed
 * Datadog run; the browser never gets to redirect a click to another project.
 */
import type * as ApiContract from "../../shared/api-contract.ts";
import type { App } from "../app.ts";
import type { RegressionTestRecord, RegressionTestSource } from "../application/ports.ts";
import type { AuthUser } from "../auth.ts";
import { WRITE_REGRESSION_TEST_TASK_ID } from "../tasks/write-regression-test/index.ts";

/**
 * `jobs.loop_id` is `NOT NULL` and this click has no loop behind it. Safe to
 * invent for the same reason `FIX_ISSUE_ACTION_LOOP_ID` is: the pool only uses
 * the loop id for `subjects.markActedOn`, which it skips for a job carrying no
 * fingerprint.
 */
export const REGRESSION_TEST_ACTION_LOOP_ID = "regression-test-actions";

/**
 * Identifies "a regression test in flight for this error", whoever asked. The
 * dedupe index covers `queued` and `leased` only, so a second click while one is
 * running is refused and a re-run after it finishes is allowed — which matters
 * here, because re-trying an error that came back `not-reachable` once the code
 * has moved on is a reasonable thing to want.
 */
export function regressionTestDedupeKey(
  source: RegressionTestSource,
  issueId: string,
): string {
  return `manual:regression-test:${source}:${issueId}`;
}

const DEDUPE_KEY_PATTERN = /^manual:regression-test:(datadog|logrocket):(.+)$/;

/**
 * Every attempt in flight right now, decoded from the queue and keyed the way the
 * views index it.
 *
 * These jobs touch no work subject, so nothing else in the payload would ever
 * mention them and a row would sit there looking untouched for the whole run.
 */
export function activeRegressionTests(app: App): Set<string> {
  const keys = new Set<string>();
  for (const job of app.jobs.activeManualActions()) {
    const match = DEDUPE_KEY_PATTERN.exec(job.dedupeKey);
    if (match) keys.add(regressionTestKey(match[1] as RegressionTestSource, match[2]!));
  }
  return keys;
}

/** `datadog:<id>` — how both the in-flight set and the record map are indexed. */
export function regressionTestKey(
  source: RegressionTestSource,
  issueId: string,
): string {
  return `${source}:${issueId}`;
}

/** Every recorded attempt, indexed by `regressionTestKey`. */
export function regressionTestsByIssue(app: App): Map<string, RegressionTestRecord> {
  return new Map(
    app.regressionTests
      .list()
      .map((record) => [regressionTestKey(record.source, record.issueId), record]),
  );
}

/**
 * Why an error cannot be turned into a test from here, or null if it can.
 *
 * Both the button's hint and the server's own check, as everywhere else that ends
 * in a container pushing a branch: a greyed-out button must not be the only thing
 * between a hand-written POST and a commit in somebody's repository.
 */
export function regressionTestRefusal(app: App, user: AuthUser): string | null {
  if (!app.taskRegistry.get(WRITE_REGRESSION_TEST_TASK_ID)) {
    return "No task is registered to write regression tests on this server.";
  }
  if (!app.fixIssueDefaults.get(user.id)) {
    return "Set a default project and branch in Settings → Pull requests first.";
  }
  return null;
}

/**
 * Queues one attempt, or reports why it did not.
 *
 * `label` is only for the message — what a person sees after clicking — while the
 * job itself carries the issue id, and reads the error out of the store when it
 * runs. A stack trace does not belong in a queue row, and a job leased twenty
 * minutes later should work from what the row says then.
 */
export function enqueueRegressionTest(
  app: App,
  user: AuthUser,
  source: RegressionTestSource,
  issueId: string,
  label: string,
  target?: { projectId: string; targetBranch: string },
): ApiContract.RegressionTestResult {
  if (!app.taskRegistry.get(WRITE_REGRESSION_TEST_TASK_ID)) {
    return {
      queued: false,
      message: "No task is registered to write regression tests on this server.",
    };
  }

  const destination = target ?? app.fixIssueDefaults.get(user.id);
  if (!destination) {
    return {
      queued: false,
      message: "Set a default project and branch in Settings → Pull requests first.",
    };
  }

  const result = app.jobs.enqueue({
    kind: WRITE_REGRESSION_TEST_TASK_ID,
    loopId: REGRESSION_TEST_ACTION_LOOP_ID,
    dedupeKey: regressionTestDedupeKey(source, issueId),
    // The person who pressed the button: the agent branches, pushes and opens the
    // merge request as them.
    actorId: user.id,
    params: {
      source,
      issueId,
      gitlab: {
        projectId: destination.projectId,
        targetBranch: destination.targetBranch,
      },
    },
  });

  if (!result.enqueued || !result.job) {
    return {
      queued: false,
      message: `Already writing a test for ${label}; waiting on the run in flight.`,
    };
  }
  return {
    queued: true,
    jobId: result.job.id,
    message:
      `Queued a regression test for ${label} in ${destination.projectId} off ` +
      `${destination.targetBranch}. It opens a draft merge request if the test is red.`,
  };
}

/** The API shape, so the router and the views do no mapping of their own. */
export function toRegressionTestView(
  record: RegressionTestRecord,
): ApiContract.RegressionTestView {
  return {
    verdict: record.verdict,
    summary: record.summary ?? null,
    howVerified: record.howVerified ?? null,
    testFile: record.testFile ?? null,
    mrIid: record.mrIid ?? null,
    mrUrl: record.mrUrl ?? null,
    branch: record.branch ?? null,
    taskRunId: record.taskRunId ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
