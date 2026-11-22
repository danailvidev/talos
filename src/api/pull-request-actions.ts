/**
 * The agent actions a merge request offers, in one place.
 *
 * Two pages queue them — the graph canvas's node toolbar and the pull request
 * detail view's header — and they must mean the same thing from both. That is why
 * the dedupe key is derived from the *merge request* rather than from either
 * caller's idea of a subject key: the graph knows an MR as
 * `gitlab:mr-feedback:group/proj!12` or `gitlab:mr:group/proj!12` depending on
 * which loop found it, while the pull request page has no subject at all. Keying
 * on `group/proj!12` is what makes a review started from the canvas show up as
 * the same job in flight on the pull request page, instead of letting a developer
 * start a second container over the first.
 */
import type * as ApiContract from "../../shared/api-contract.ts";
import type { PullRequestDetail } from "../application/pull-requests.ts";
import type { App } from "../app.ts";
import type { AuthUser } from "../auth.ts";
import type { Job } from "../core/job.ts";
import { MR_FOLLOW_UP_ONE_TASK_ID } from "../tasks/mr-follow-up/index.ts";
import { MR_REVISION_ONE_TASK_ID } from "../tasks/mr-revision/index.ts";
import { REVIEW_ONE_TASK_ID } from "../tasks/code-review/review-job.ts";
import { RESOLVE_CONFLICTS_ONE_TASK_ID } from "../tasks/resolve-conflicts/index.ts";

/** The three one-click actions, followed by the instruction-driven revision chat. */
export const PULL_REQUEST_ACTIONS: readonly ApiContract.PullRequestActionId[] = [
  "resolve-conflicts",
  "address-comments",
  "code-review",
  "revise",
];

/** The handler task each action enqueues. */
const HANDLERS: Record<ApiContract.PullRequestActionId, string> = {
  "resolve-conflicts": RESOLVE_CONFLICTS_ONE_TASK_ID,
  "address-comments": MR_FOLLOW_UP_ONE_TASK_ID,
  "code-review": REVIEW_ONE_TASK_ID,
  revise: MR_REVISION_ONE_TASK_ID,
};

const MUTATING_ACTIONS: readonly ApiContract.PullRequestActionId[] = [
  "resolve-conflicts",
  "address-comments",
  "revise",
];

export function isPullRequestAction(value: string): value is ApiContract.PullRequestActionId {
  return (PULL_REQUEST_ACTIONS as readonly string[]).includes(value);
}

export function handlerFor(action: ApiContract.PullRequestActionId): string {
  return HANDLERS[action];
}

/**
 * `jobs.loop_id` is `NOT NULL`, but a click on the pull request page has no loop
 * behind it — the row was read live from the forge. This stands in, and is safe
 * to invent because the only thing the worker pool does with a loop id is
 * `subjects.markActedOn`, which it skips unless the job also carries a
 * fingerprint (see `core/worker-pool.ts`). Jobs under this id therefore never
 * touch a `work_subjects` row and never appear on the graph, which reads jobs per
 * loop and subject.
 */
export const PULL_REQUEST_ACTION_LOOP_ID = "pull-request-actions";

/**
 * Identifies "this action, on this merge request", regardless of which page asked
 * or which loop discovered it. Deliberately not the subject fingerprint and not
 * the queue's default key: the default would collapse into whatever a loop had
 * already queued for this version of the MR, and the click would silently do
 * nothing.
 *
 * The dedupe index covers `queued` and `leased` only, so a second click while one
 * is in flight is refused while a re-run after it finishes is allowed.
 */
export function actionDedupeKey(
  action: ApiContract.PullRequestActionId,
  projectId: string,
  mrIid: number,
): string {
  return `manual:${action}:gitlab:${projectId}!${mrIid}`;
}

const DEDUPE_KEY_PATTERN = /^manual:([a-z-]+):gitlab:(.+)!(\d+)$/;

/** The inverse of `actionDedupeKey` — undefined for anything that is not one of ours. */
export function parseActionDedupeKey(
  dedupeKey: string,
): { action: ApiContract.PullRequestActionId; projectId: string; mrIid: number } | undefined {
  const match = DEDUPE_KEY_PATTERN.exec(dedupeKey);
  if (!match) return undefined;
  const [, action, projectId, mrIidText] = match;
  if (!isPullRequestAction(action!)) return undefined;
  return { action, projectId: projectId!, mrIid: Number(mrIidText) };
}

export interface ActivePullRequestAction {
  action: ApiContract.PullRequestActionId;
  projectId: string;
  mrIid: number;
  job: Job;
}

/**
 * Every manual action in flight right now, decoded straight from the queue.
 *
 * Exists for the two places that need "is anything running on this merge
 * request" without already knowing which one to ask about: the pull request
 * *list*, which would otherwise need one job lookup per row, and the ticket
 * graph's merge request nodes, which have no subject to key a lookup on when the
 * action was started from the pull request page rather than the canvas.
 */
export function activePullRequestActions(app: App): ActivePullRequestAction[] {
  const out: ActivePullRequestAction[] = [];
  for (const job of app.jobs.activeManualActions()) {
    const parsed = parseActionDedupeKey(job.dedupeKey);
    if (parsed) out.push({ ...parsed, job });
  }
  return out;
}

export interface EnqueueActionInput {
  action: ApiContract.PullRequestActionId;
  projectId: string;
  mrIid: number;
  instruction?: string;
  history?: ApiContract.AssistantMessage[];
  /**
   * The loop to attribute the job to, when there is one. Omitted by the pull
   * request page; the graph passes the loop that discovered the merge request.
   */
  loopId?: string;
  /**
   * The `work_subjects` key, when the caller has one. Set only by the graph.
   * Never combined with a fingerprint, so the pool leaves the subject alone —
   * the loop that owns it decides when it has been dealt with.
   */
  subjectKey?: string;
}

/**
 * Enqueues one action, or reports that it is already in flight.
 *
 * A job rather than `tasks.run` directly, which buys the whole queue: retry with
 * backoff, the dead-job brake, per-kind concurrency, and a row the UI already
 * knows how to poll.
 */
export function enqueuePullRequestAction(
  app: App,
  user: AuthUser,
  input: EnqueueActionInput,
): ApiContract.PullRequestActionResult {
  // Belt-and-suspenders alongside `pullRequestActionRefusal`'s own check: that
  // one runs moments earlier in the same request, so a loop tick landing in
  // between would otherwise slip a second, concurrent job past it.
  const running = MUTATING_ACTIONS.includes(input.action)
    ? runningMutationFor(app, input.projectId, input.mrIid)
    : runningJobFor(app, input.action, input.projectId, input.mrIid);
  if (running) {
    return {
      queued: false,
      message: `Another agent action is already running for !${input.mrIid}.`,
    };
  }

  const result = app.jobs.enqueue({
    kind: handlerFor(input.action),
    loopId: input.loopId ?? PULL_REQUEST_ACTION_LOOP_ID,
    ...(input.subjectKey ? { subjectKey: input.subjectKey } : {}),
    dedupeKey: actionDedupeKey(input.action, input.projectId, input.mrIid),
    // The person who pressed the button, not the loop's owner: the agent pushes
    // and comments as them.
    actorId: user.id,
    params: {
      gitlab: { projectId: input.projectId, mrIid: input.mrIid },
      ...(input.action === "revise"
        ? { instruction: input.instruction, history: input.history ?? [] }
        : {}),
    },
  });

  if (!result.enqueued || !result.job) {
    return {
      queued: false,
      message: `Already queued for !${input.mrIid}; waiting on the run in flight.`,
    };
  }
  return { queued: true, jobId: result.job.id, message: `Queued for !${input.mrIid}.` };
}

/** Job state for every action on one merge request. No forge call — pollable. */
export function pullRequestActionStates(
  app: App,
  projectId: string,
  mrIid: number,
): ApiContract.PullRequestActionsView {
  const actions = PULL_REQUEST_ACTIONS.map((action) =>
    toActionState(action, latestJob(app, action, projectId, mrIid)),
  );
  return {
    actions,
    live: actions.some((state) => state.status === "queued" || state.status === "running"),
  };
}

/**
 * The toolbar as the detail view needs it: the polled state above, plus whether
 * each button makes sense against this merge request as it stands.
 */
export function pullRequestActionViews(
  app: App,
  projectId: string,
  detail: PullRequestDetail,
): ApiContract.PullRequestActionView[] {
  const { actions } = pullRequestActionStates(app, projectId, detail.number);
  return actions.map((state) => {
    const reason = pullRequestActionRefusal(app, state.action, projectId, detail);
    return {
      ...state,
      available: reason == null,
      ...(reason != null ? { unavailableReason: reason } : {}),
    };
  });
}

/**
 * The handler's own job already queued or leased for this merge request, raised
 * by *anything* — the automatic loop's hourly tick or a click on either page's
 * toolbar — rather than only the one dedupe-key namespace the caller happens to
 * be checking.
 *
 * Necessary because the loop and the manual button key their jobs differently
 * on purpose (`loopId:kind:subjectKey:fingerprint` vs. `manual:<action>:…`), so
 * a job the loop already has in flight is invisible to `byDedupeKey` and
 * `activeManualActions` alike. Without this, a click while the loop is mid-run
 * enqueues a second, genuinely concurrent agent against the same branch and
 * the same GitLab discussions.
 */
function runningJobFor(
  app: App,
  action: ApiContract.PullRequestActionId,
  projectId: string,
  mrIid: number,
): Job | undefined {
  return app.jobs.activeForKind(handlerFor(action)).find((job) => {
    const gitlab = (job.params as { gitlab?: { projectId?: string; mrIid?: number } } | null)
      ?.gitlab;
    return gitlab?.projectId === projectId && gitlab?.mrIid === mrIid;
  });
}

/** At most one branch-writing action may work against an MR head at a time. */
function runningMutationFor(
  app: App,
  projectId: string,
  mrIid: number,
): Job | undefined {
  for (const action of MUTATING_ACTIONS) {
    const job = runningJobFor(app, action, projectId, mrIid);
    if (job) return job;
  }
  return undefined;
}

/**
 * Why an action should not be run, or null if it should.
 *
 * Both a UI hint and the server's own check, deliberately the same function: each
 * of these starts a container that pushes to somebody's branch, so "the button was
 * greyed out" cannot be the only thing standing between a hand-written POST and a
 * rebase of a merge request that had no conflicts.
 */
export function pullRequestActionRefusal(
  app: App,
  action: ApiContract.PullRequestActionId,
  projectId: string,
  detail: PullRequestDetail,
): string | null {
  if (!app.taskRegistry.get(handlerFor(action))) {
    return `No task is registered to handle '${action}' on this server.`;
  }
  if (detail.state === "merged" || detail.state === "closed") {
    return `This merge request is ${detail.state}.`;
  }
  // Checked before the action-specific facts below: a loop-raised run already
  // answers "is there anything to do", so a click while one is in flight should
  // point at it rather than re-ask the forge and start a second one.
  const running = MUTATING_ACTIONS.includes(action)
    ? runningMutationFor(app, projectId, detail.number)
    : runningJobFor(app, action, projectId, detail.number);
  if (running !== undefined) {
    return MUTATING_ACTIONS.includes(action)
      ? "Another branch-writing action is already running. Watch it below."
      : "Already running. Watch it below.";
  }
  if (action === "resolve-conflicts") {
    // "unknown" is left available on purpose: the forge computes mergeability
    // lazily, so refusing while it has not answered would make the button
    // randomly do nothing on a branch pushed seconds ago.
    if (detail.mergeability === "clean") return "There are no conflicts to resolve.";
    return null;
  }
  if (action === "address-comments" && detail.openThreadCount === 0) {
    return "There are no open comments.";
  }
  return null;
}

/**
 * Every past attempt at any action on one merge request, newest
 * first — the Activity tab. Unlike `pullRequestActionStates`, this is not
 * "the latest per action" but the full run history, so a resolve-conflicts
 * retried three times shows all three rows, not just the last.
 */
export function pullRequestActivity(
  app: App,
  projectId: string,
  mrIid: number,
): ApiContract.PullRequestActivityView {
  const entries = app.jobs
    .manualActionHistory(projectId, mrIid)
    .map((job) => {
      const parsed = parseActionDedupeKey(job.dedupeKey);
      return parsed ? toActivityEntry(parsed.action, job) : undefined;
    })
    .filter((entry): entry is ApiContract.PullRequestActivityEntryView => entry != null);
  return { entries };
}

function toActivityEntry(
  action: ApiContract.PullRequestActionId,
  job: Job,
): ApiContract.PullRequestActivityEntryView {
  const status = toActionStatus(job);
  return {
    action,
    status,
    jobId: job.id,
    ...(job.executionId ? { runId: job.executionId } : {}),
    message: actionMessage(job, status),
    startedAt: (job.startedAt ?? job.enqueuedAt).toISOString(),
    ...(job.finishedAt ? { finishedAt: job.finishedAt.toISOString() } : {}),
  };
}

/**
 * The most recent job for this action, whatever state it ended in. Newest wins
 * rather than "the one still running", so a finished run's log stays reachable
 * from the pill instead of disappearing the moment it succeeds.
 *
 * Checks for anything currently active first, not only the manual dedupe key:
 * the automatic loop's job for this exact merge request is queued/leased under
 * its own key, invisible to `byDedupeKey`, so without this the pill would sit
 * on "idle" while a run `runningJobFor` and the refusal check already know
 * about is streaming logs underneath it.
 */
function latestJob(
  app: App,
  action: ApiContract.PullRequestActionId,
  projectId: string,
  mrIid: number,
): Job | undefined {
  return (
    runningJobFor(app, action, projectId, mrIid) ??
    app.jobs.byDedupeKey(actionDedupeKey(action, projectId, mrIid), 1)[0]
  );
}

function toActionState(
  action: ApiContract.PullRequestActionId,
  job: Job | undefined,
): ApiContract.PullRequestActionStateView {
  if (!job) return { action, status: "idle" };

  const status = toActionStatus(job);
  const updatedAt = job.finishedAt ?? job.startedAt ?? job.enqueuedAt;
  return {
    action,
    status,
    jobId: job.id,
    ...(job.executionId ? { runId: job.executionId } : {}),
    message: actionMessage(job, status),
    updatedAt: updatedAt.toISOString(),
  };
}

function toActionStatus(job: Job): ApiContract.PullRequestActionStatus {
  if (job.status === "leased") return "running";
  if (job.status === "done") return "done";
  if (job.status === "dead") return "failed";
  // 'queued' covers both fresh work and a job backing off between attempts; the
  // difference matters to the queue, not to somebody watching a spinner.
  return "queued";
}

function actionMessage(job: Job, status: ApiContract.PullRequestActionStatus): string {
  switch (status) {
    case "queued":
      return job.attempts > 0
        ? `Retrying (attempt ${job.attempts + 1} of ${job.maxAttempts}).`
        : "Queued — waiting for a worker.";
    case "running":
      return "Running in a container.";
    case "done":
      return "Finished.";
    case "failed":
      return job.error ?? "Failed after every attempt.";
    default:
      return "";
  }
}
