import { z } from "zod";
import type { TaskConnectorFactory } from "../../application/gateways.ts";
import type { JobRepository, NotificationRepository } from "../../application/ports.ts";
import type { FetchLike } from "../../connectors/http.ts";
import {
  isDraftMergeRequest,
  mergeRequestProjectPath,
  type MergeRequest,
} from "../../connectors/gitlab/types.ts";
import { ConfigError } from "../../core/errors.ts";
import { defaultDedupeKey } from "../../core/job.ts";
import type { SubjectTracker } from "../../core/subject.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import { REVIEW_ONE_TASK_ID } from "../code-review/review-job.ts";

/**
 * Polls GitLab for non-draft merge requests the token user has been asked to
 * review, and queues one review job per merge request that needs one.
 *
 * A discoverer, and nothing more: it decides *what* needs reviewing and hands it
 * off. It does not run Claude, does not create tasks, and does not decide how
 * much runs at once — `core/worker-pool.ts` does that, bounded by a number
 * instead of the boolean `anyCodeReviewRunning()` ceiling this loop used to hit,
 * which allowed exactly one review at a time across the whole server.
 *
 * Idempotency is one question asked once. The subject is the merge request
 * (`gitlab:mr:group/project!123`), the fingerprint is its head sha, and
 * `subjects.observe` reports whether that pair has been handled. The queue's own
 * dedupe index then absorbs the window between enqueueing a job and the pool
 * finishing it, during which this loop may well tick again.
 *
 * "Me" is the GitLab account behind `GITLAB_TOKEN`. Teammates must add that user
 * as reviewer.
 */

const ConfigSchema = z.object({
  gitlab: z
    .object({
      /** Limit to this `group/project`. Omitted means every accessible repo. */
      projectId: z.string().min(1).optional(),
      /**
       * Limit to projects under this namespace (`example-org` matches
       * `example-org/webapp` and `example-org/services/foo`, not
       * `example-org-other/x`).
       */
      group: z.string().min(1).optional(),
    })
    .optional(),
});

type Config = z.infer<typeof ConfigSchema>;

/**
 * Default sweep: every fifteen minutes.
 *
 * It used to be every two, because polling was the only way to hear about a
 * review request — 720 GitLab sweeps a day to notice something GitLab already
 * knew. A webhook now delivers that within seconds (`api/webhooks.ts`), so this
 * is the safety net rather than the clock: it catches a delivery lost to a blip,
 * a hook nobody has configured yet, and work created while the server was down.
 * Fifteen minutes is the worst case for a *missed* delivery, not the normal case.
 */
export const REVIEW_REQUESTED_CRON = "*/15 * * * *";

export interface ReviewRequestedDeps {
  fetch?: FetchLike;
  connectors?: TaskConnectorFactory;
  subjects?: SubjectTracker;
  jobs?: JobRepository;
  /** Backs the topbar Bell — surfaces a queued review the loop would otherwise start silently. */
  notifications?: NotificationRepository;
}

export function createReviewRequestedTask(deps: ReviewRequestedDeps = {}): Task<Config> {
  return {
    id: "gitlab-review-requested",
    name: "GitLab review requests",
    description:
      "When you are added as a reviewer on a ready GitLab merge request, queues an AI code review of it (drafts wait until they are marked ready).",
    kind: "loop",
    instantiable: true,
    defaultTrigger: { type: "cron", expression: REVIEW_REQUESTED_CRON },
    paramsSchema: ConfigSchema,
    run: (ctx, config) => run(ctx, config, deps),
  };
}

export const reviewRequestedTask: Task<Config> = createReviewRequestedTask();

/** Namespaced so one subject table can hold every loop's subjects without collision. */
export function mergeRequestSubjectKey(projectId: string, mrIid: number): string {
  return `gitlab:mr:${projectId}!${mrIid}`;
}

async function run(
  ctx: TaskContext,
  config: Config,
  deps: ReviewRequestedDeps,
): Promise<TaskResult> {
  const gitlab = requireConnectorFactory(deps).gitlab(ctx, deps.fetch);
  const subjects = requireSubjectTracker(deps);
  const jobs = requireJobRepository(deps);

  const mergeRequests = await ctx.step("list-review-requests", () =>
    gitlab.listMergeRequestsForReview({ state: "opened", signal: ctx.signal }),
  );

  const inScope: { mr: MergeRequest; projectId: string }[] = [];
  for (const mr of mergeRequests) {
    const projectId = mergeRequestProjectPath(mr);
    if (!projectId) {
      ctx.logger.warn(
        { mrIid: mr.iid, webUrl: mr.web_url },
        `skipped !${mr.iid}: could not parse a group/project path`,
      );
      continue;
    }
    if (!matchesReviewFilter(projectId, config.gitlab)) continue;
    if (isDraftMergeRequest(mr)) {
      ctx.logger.info(
        { mrIid: mr.iid, projectId },
        `skipped !${mr.iid}: draft merge requests are not reviewed until marked ready`,
      );
      continue;
    }
    inScope.push({ mr, projectId });
  }

  ctx.logger.info(
    { listed: mergeRequests.length, inScope: inScope.length },
    `listed ${mergeRequests.length} review request(s), ${inScope.length} in filter`,
  );

  let queued = 0;
  let skipped = 0;
  let deferred = 0;
  const notes: string[] = [];

  for (const { mr, projectId } of inScope) {
    if (ctx.signal.aborted) {
      ctx.logger.warn("shutdown requested, stopping early");
      break;
    }

    if (!mr.sha) {
      skipped++;
      ctx.logger.warn({ mrIid: mr.iid }, `skipped !${mr.iid}: no head commit reported`);
      continue;
    }

    const subjectKey = mergeRequestSubjectKey(projectId, mr.iid);
    // Recorded on every poll, even for merge requests that need nothing: this is
    // also the "still open, still assigned to me" signal, and `lastSeenAt` is
    // what a future sweep will use to close subjects that quietly went away.
    const { changed } = subjects.observe({
      loopId: ctx.taskId,
      subjectKey,
      fingerprint: mr.sha,
      externalRef: `!${mr.iid}`,
      externalUrl: mr.web_url,
      metadata: {
        projectId,
        mrIid: mr.iid,
        title: mr.title,
        author: mr.author?.name ?? mr.author?.username,
      },
    });

    // Unlike an action task, `ctx.force` here means "sweep now," not "ignore
    // the sha this MR was last reviewed at": a manual Run/Rerun must still
    // skip merge requests whose head commit hasn't changed, or every click
    // re-reviews and re-comments on everything already reviewed.
    if (!changed) {
      skipped++;
      continue;
    }

    // The cap bounds how much *new* work this tick admits, not how much runs —
    // the pool decides that. Anything over the cap is picked up next tick, and
    // the subject was already observed above, so nothing is lost by waiting.
    if (queued >= ctx.maxItemsPerRun) {
      deferred++;
      continue;
    }

    const enqueue = {
      kind: REVIEW_ONE_TASK_ID,
      loopId: ctx.taskId,
      subjectKey,
      fingerprint: mr.sha,
      // Carried so the review runs as whoever owns this loop, hours later and in
      // another process. Not part of the dedupe key — two loops finding the same
      // merge request is one review, not two.
      ...(ctx.actor ? { actorId: ctx.actor.id } : {}),
      parentExecutionId: ctx.executionId,
      params: { gitlab: { projectId, mrIid: mr.iid } },
    };

    // A job that used up its attempts at this exact sha is not retried on a
    // timer. Waiting for a new commit — or an operator reviving the job — is the
    // only sane reading of "three container runs in a row failed", and without
    // this the loop would start a fresh one every two minutes indefinitely.
    const dead = jobs.deadFor(defaultDedupeKey(enqueue));
    if (dead && !ctx.force) {
      skipped++;
      ctx.logger.warn(
        { mrIid: mr.iid, sha: mr.sha, job: dead.id, err: dead.error },
        `skipped !${mr.iid}: job ${dead.id} already failed every attempt at ` +
          `${mr.sha.slice(0, 8)}; push a commit or revive the job to try again`,
      );
      notes.push(`skipped !${mr.iid}: job ${dead.id} gave up at ${mr.sha.slice(0, 8)}`);
      continue;
    }

    if (ctx.dryRun) {
      notes.push(`dry run: would queue a review of !${mr.iid} at ${mr.sha.slice(0, 8)}`);
      continue;
    }

    const result = jobs.enqueue(enqueue);
    if (!result.enqueued) {
      // A job for this MR at this sha is already queued or in flight — the
      // normal case for a loop that ticks faster than a review takes to run.
      skipped++;
      continue;
    }

    queued++;
    notes.push(`queued a review of !${mr.iid} at ${mr.sha.slice(0, 8)}`);
    ctx.logger.info(
      { mrIid: mr.iid, projectId, sha: mr.sha, job: result.job?.id },
      `queued a review of !${mr.iid} at ${mr.sha.slice(0, 8)}`,
    );

    // The loop only inserts a job row here; a worker picks it up out-of-band,
    // possibly minutes later. Without this, "you were added as a reviewer" is
    // a fact only the database knows until the review itself posts a note.
    // `jobId` lets the worker pool remove this once the job actually finishes
    // (`core/worker-pool.ts`), so it doesn't sit in the Bell as "queued"
    // forever after the review is already done.
    deps.notifications?.create({
      kind: "gitlab-review-requested",
      title: `Review queued: !${mr.iid}`,
      body: mr.title,
      link: mr.web_url,
      taskRunId: ctx.executionId,
      ...(result.job?.id ? { jobId: result.job.id } : {}),
    });
  }

  if (deferred > 0) {
    ctx.logger.warn(
      { cap: ctx.maxItemsPerRun, deferred },
      `reached the ${ctx.maxItemsPerRun}-item cap; ${deferred} merge request(s) wait for the next run`,
    );
  }

  return {
    itemsSeen: inScope.length,
    itemsProcessed: queued,
    itemsSkipped: skipped + deferred,
    // A "Review queued: !N" notification already went out per queued MR above;
    // this tells the sink not to also post a generic "completed" notice.
    notifiedIndividually: queued > 0 && Boolean(deps.notifications),
    // Deliberately absent: enqueueing does not fail per-item, and the review
    // itself fails against its own job and run record, not against this loop.
    details: { queued, skipped, deferred, notes },
  };
}

export function matchesReviewFilter(
  projectPath: string,
  gitlab: Config["gitlab"],
): boolean {
  if (!gitlab) return true;
  if (gitlab.projectId && projectPath !== gitlab.projectId) return false;
  if (gitlab.group) {
    const group = gitlab.group.replace(/\/+$/, "");
    if (projectPath !== group && !projectPath.startsWith(`${group}/`)) return false;
  }
  return true;
}

function requireConnectorFactory(deps: ReviewRequestedDeps): TaskConnectorFactory {
  if (!deps.connectors) {
    throw new ConfigError(
      "gitlab-review-requested requires connector gateways; the composition root must " +
        "provide them before the task can run.",
    );
  }
  return deps.connectors;
}

function requireSubjectTracker(deps: ReviewRequestedDeps): SubjectTracker {
  if (!deps.subjects) {
    throw new ConfigError(
      "gitlab-review-requested requires a subject tracker; the composition root must " +
        "provide one before the task can run.",
    );
  }
  return deps.subjects;
}

function requireJobRepository(deps: ReviewRequestedDeps): JobRepository {
  if (!deps.jobs) {
    throw new ConfigError(
      "gitlab-review-requested requires a job queue; the composition root must " +
        "provide one before the task can run.",
    );
  }
  return deps.jobs;
}
