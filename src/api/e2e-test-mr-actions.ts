import type * as ApiContract from "../../shared/api-contract.ts";
import type { App } from "../app.ts";
import type { AuthUser } from "../auth.ts";
import type { Job } from "../core/job.ts";
import {
  e2eTestProject,
  WRITE_E2E_TEST_TASK_ID,
} from "../tasks/write-e2e-test/index.ts";

export const E2E_TEST_MR_ACTION_LOOP_ID = "e2e-test-mr-actions";

export function e2eTestMrDedupeKey(issueKey: string, sourceJobId: string): string {
  return `manual:write-e2e-test:jira:${issueKey}:e2e-job:${sourceJobId}`;
}

export function enqueueE2eTestMr(
  app: App,
  user: AuthUser,
  issueKey: string,
  sourceJobId: string,
  targetBranch: string,
): ApiContract.MrActionResult {
  if (!app.taskRegistry.get(WRITE_E2E_TEST_TASK_ID)) {
    return { queued: false, message: "No task is registered to write E2E tests." };
  }
  const result = app.jobs.enqueue({
    kind: WRITE_E2E_TEST_TASK_ID,
    loopId: E2E_TEST_MR_ACTION_LOOP_ID,
    dedupeKey: e2eTestMrDedupeKey(issueKey, sourceJobId),
    actorId: user.id,
    params: { sourceJobId, targetBranch },
  });
  if (!result.enqueued || !result.job) {
    return {
      queued: false,
      message: `Already writing Playwright coverage for this E2E run.`,
    };
  }
  return {
    queued: true,
    jobId: result.job.id,
    message:
      `Queued Playwright coverage in ${e2eTestProject()}; the merge request will target ` +
      `${targetBranch}.`,
  };
}

/** Newest export attempt per source E2E job. */
export function e2eTestMrJobsBySource(app: App): Map<string, Job> {
  const out = new Map<string, Job>();
  for (const job of app.jobs.manualTicketActionHistory()) {
    if (job.kind !== WRITE_E2E_TEST_TASK_ID) continue;
    const sourceJobId = sourceJobIdOf(job.params);
    if (sourceJobId && !out.has(sourceJobId)) out.set(sourceJobId, job);
  }
  return out;
}

function sourceJobIdOf(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const value = (params as Record<string, unknown>).sourceJobId;
  return typeof value === "string" ? value : undefined;
}
