import { z } from "zod";
import type { TaskConnectorFactory } from "../../application/gateways.ts";
import type { ReviewRepository } from "../../application/ports.ts";
import type { FetchLike } from "../../connectors/http.ts";
import { ConfigError } from "../../core/errors.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import { ensureAgentImage } from "../../infrastructure/agent/index.ts";
import { reviewOne } from "./review-one.ts";

/**
 * Reviews one merge request. The handler side of `gitlab-review-requested`.
 *
 * This replaces what used to be a spawned `gitlab-code-review` *instance* per
 * merge request: a configuration row, created by a loop, for a unit of work that
 * was over the moment it ran. The queue holds the work now, so an MR leaves
 * behind a job and a run record instead of a permanent task nobody created.
 *
 * One job, one MR, always reviewed — the discoverer already decided this sha
 * needs looking at, and the worker pool advances the subject's fingerprint once
 * this returns. Concurrency is the pool's business, not this task's; the old
 * "one review anywhere on the server at a time" ceiling is gone.
 */

const ParamsSchema = z.object({
  gitlab: z.object({
    /** `group/project`. A numeric id cannot be cloned inside the container. */
    projectId: z.string().min(1),
    mrIid: z.number().int().positive(),
  }),
});

type Params = z.infer<typeof ParamsSchema>;

export const REVIEW_ONE_TASK_ID = "gitlab-review-one";

export interface ReviewJobDeps {
  fetch?: FetchLike;
  reviews?: ReviewRepository;
  connectors?: TaskConnectorFactory;
}

export function createReviewJobTask(deps: ReviewJobDeps = {}): Task<Params> {
  return {
    id: REVIEW_ONE_TASK_ID,
    name: "AI review of one merge request",
    description:
      "Reviews a single GitLab merge request with Claude and posts the summary comment. Queued by the review-requests loop rather than run directly.",
    kind: "job",
    agent: true,
    paramsSchema: ParamsSchema,
    run: (ctx, params) => run(ctx, params, deps),
  };
}

async function run(ctx: TaskContext, params: Params, deps: ReviewJobDeps): Promise<TaskResult> {
  const gitlab = requireConnectorFactory(deps).gitlab(ctx, deps.fetch);
  const ledger = requireReviewRepository(deps);
  const { projectId, mrIid } = params.gitlab;

  await ctx.step("ensure-agent-image", () => ensureAgentImage(ctx.logger));

  // Re-read rather than trusting the params: the title, branches and head commit
  // may all have moved between the discoverer's poll and this lease. Reviewing
  // the current state is the useful thing to do; if the sha advanced, the loop
  // sees a changed fingerprint on its next tick and queues another job for it.
  const mr = await ctx.step("fetch-merge-request", () =>
    gitlab.mergeRequest(projectId, mrIid, ctx.signal),
  );

  if (!mr.sha) {
    // Nothing to review and nothing the ledger can key on. Not an error: the MR
    // is real, GitLab just has not reported a head commit for it yet.
    ctx.logger.warn({ mrIid }, `!${mrIid} has no head commit reported; nothing to review`);
    return {
      itemsSeen: 1,
      itemsProcessed: 0,
      itemsSkipped: 1,
      details: {
        mrIid,
        action: "no-commit",
        summary: `GitLab reports no head commit for !${mrIid}, so there is nothing to review yet.`,
      },
    };
  }

  ctx.logger.info(
    { mrIid, sha: mr.sha, model: ctx.llm.model, effort: ctx.llm.effort },
    `reviewing !${mrIid} at ${mr.sha.slice(0, 8)} with Claude ` +
      (ctx.llm.model ?? "default") +
      (ctx.llm.effort ? ` at ${ctx.llm.effort} effort` : ""),
  );

  // No try/catch: a failure must reach the executor, which is what turns this
  // job's attempt into a retry with backoff. Swallowing it here would report a
  // successful review that never happened.
  const outcome = await reviewOne({ ctx, gitlab, ledger, projectId, mr });

  // Every branch records an `action` and, when it did not review, a `summary`
  // saying why. Without them a skip that returned in a second is displayed as a
  // bare "success" with an empty Result column, which reads as a silent failure.
  if (outcome.action === "already-reviewed") {
    return {
      itemsSeen: 1,
      itemsProcessed: 0,
      itemsSkipped: 1,
      details: {
        mrIid,
        action: "already-reviewed",
        sha: outcome.sha,
        summary:
          `!${mrIid} already has a review comment at ${outcome.sha.slice(0, 8)}. ` +
          "Push a new commit to get a fresh review.",
      },
    };
  }

  if (outcome.action === "dry-run") {
    return {
      itemsSeen: 1,
      itemsProcessed: 0,
      itemsSkipped: 1,
      details: {
        mrIid,
        action: "dry-run",
        summary: `Dry run: the review was produced but not posted to !${mrIid}.`,
      },
    };
  }

  return {
    itemsSeen: 1,
    itemsProcessed: 1,
    itemsSkipped: 0,
    details: { mrIid, action: "reviewed", sha: mr.sha, noteUrl: outcome.noteUrl },
  };
}

function requireReviewRepository(deps: ReviewJobDeps): ReviewRepository {
  if (!deps.reviews) {
    throw new ConfigError(
      `${REVIEW_ONE_TASK_ID} requires a durable review repository; the composition ` +
        "root must provide one before the task can run.",
    );
  }
  return deps.reviews;
}

function requireConnectorFactory(deps: ReviewJobDeps): TaskConnectorFactory {
  if (!deps.connectors) {
    throw new ConfigError(
      `${REVIEW_ONE_TASK_ID} requires connector gateways; the composition root must ` +
        "provide them before the task can run.",
    );
  }
  return deps.connectors;
}
