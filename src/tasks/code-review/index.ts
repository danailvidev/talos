import { z } from "zod";
import type {
  GitLabGateway,
  TaskConnectorFactory,
} from "../../application/gateways.ts";
import type { ReviewRepository } from "../../application/ports.ts";
import { GitLabConfigSchema } from "../../connectors/gitlab/client.ts";
import type { FetchLike } from "../../connectors/http.ts";
import { ensureAgentImage, runAgentJob } from "../../infrastructure/agent/index.ts";
import { ConfigError } from "../../core/errors.ts";
import { describeError } from "../../core/executor.ts";
import { NO_RETRY } from "../../core/retry.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import type { MergeRequest } from "../../connectors/gitlab/types.ts";
import { buildReviewPrompt, REVIEW_PROMPT_ID } from "./prompt.ts";
import { ReviewOutputSchema, unstructuredReview } from "./review-result.ts";
import { projectPathOrThrow, reviewOne } from "./review-one.ts";

/**
 * AI code review of open GitLab merge requests, run against the operator's
 * own Claude subscription rather than a metered API key — see
 * `infrastructure/agent`.
 *
 * One MR earns one summary comment per head commit on a *scheduled* tick:
 * `ReviewLedger` records `(task, project, mr_iid) -> sha`. A cron re-run
 * after nothing changed reviews nothing. A new commit is a different sha and
 * earns a fresh review. An explicit run (UI Rerun, CLI, POST /run) sets
 * `ctx.force` and reviews again even at the same sha.
 */

const ConfigSchema = z.object({
  gitlab: GitLabConfigSchema.extend({
    /**
     * A specific merge request to review, by iid — what the web UI's "choose
     * merge request" scope fills in. Omitted means "every currently open
     * MR", bounded by `maxItemsPerRun`. Mutually exclusive with `branch` and
     * `jiraIssueKey` — the web UI's scope control only ever sets one.
     */
    mrIid: z.number().int().positive().optional(),
    /**
     * The "Branch" scope: review this branch directly rather than any MR.
     * There is nothing to comment on without an MR, so this path reviews and
     * reports in the run's result only — see `runBranchReview`.
     */
    branch: z.string().min(1).optional(),
    /**
     * The "Issue" scope: a Jira issue key (e.g. `TP-3012`). Resolved to the
     * open MR(s) whose branch name or title mentions it — the convention
     * this codebase's branches already follow (`fix/TP-3012`,
     * `SP-3034-fix-...`) — and reviewed through the normal MR flow.
     */
    jiraIssueKey: z.string().min(1).optional(),
  }),
});

type Config = z.infer<typeof ConfigSchema>;

export interface CodeReviewDeps {
  /** Same testability seam every connector-backed task takes. */
  fetch?: FetchLike;
  /** Durable task-specific state, supplied by the composition root. */
  reviews?: ReviewRepository;
  connectors?: TaskConnectorFactory;
}

export function createCodeReviewTask(deps: CodeReviewDeps = {}): Task<Config> {
  return {
    id: "gitlab-code-review",
    name: "GitLab AI code review",
    description:
      "Checks out each open merge request, reviews it with your Claude subscription, and leaves one summary comment per MR.",
    // A loop, not an ad-hoc task, since the console retired its Tasks page. Not a
    // reclassification of convenience: this is the only shape it ever really had —
    // a batch over every open MR, a per-sha ledger that makes a repeat tick a
    // no-op, and a cron that suits both. The per-MR button on a pull request is
    // `gitlab-review-one` (`kind: "job"`), a different registration entirely.
    //
    // Keeping it listed matters beyond tidiness: the Branch and Issue scopes in
    // `CreateTaskPanel` have no pull-request equivalent — a branch with no MR is
    // not reachable from a PR page by definition — so this registration is their
    // only entry point.
    kind: "loop",
    instantiable: true,
    paramsSchema: ConfigSchema,
    run: (ctx, config) => run(ctx, config, deps),
  };
}

export const codeReviewTask: Task<Config> = createCodeReviewTask();

async function run(ctx: TaskContext, config: Config, deps: CodeReviewDeps): Promise<TaskResult> {
  const gitlab = requireConnectorFactory(deps).gitlab(ctx, deps.fetch);

  // A one-time cost the first time this runs on a host: later runs see the
  // image already built and skip straight past. Its own step, rather than
  // hiding inside the first MR's review, so a slow first build shows up as
  // what it is rather than looking like a stuck review.
  await ctx.step("ensure-agent-image", () => ensureAgentImage(ctx.logger));
  ctx.logger.info(
    { model: ctx.llm.model, effort: ctx.llm.effort },
    "code review using Claude " +
      (ctx.llm.model ?? "default") +
      (ctx.llm.effort ? ` at ${ctx.llm.effort} effort` : ""),
  );

  // The "Branch" scope has no MR to comment on or dedupe against, so it
  // skips the ledger-backed MR flow below entirely.
  if (config.gitlab.branch) {
    return runBranchReview(ctx, String(config.gitlab.projectId), config.gitlab.branch);
  }

  const ledger = requireReviewRepository(deps);

  const mergeRequests = await ctx.step("resolve-merge-requests", () =>
    resolveMergeRequests(gitlab, config, ctx),
  );
  ctx.logger.info(
    { count: mergeRequests.length },
    `resolved ${mergeRequests.length} merge request(s) to review`,
  );

  if (mergeRequests.length === 0) {
    ctx.logger.info({ project: config.gitlab.projectId }, "no open merge requests to review");
    return { itemsSeen: 0, itemsProcessed: 0, itemsSkipped: 0 };
  }

  const projectId = String(config.gitlab.projectId);
  const inScope = mergeRequests.slice(0, ctx.maxItemsPerRun);
  const deferred = mergeRequests.length - inScope.length;
  if (deferred > 0) {
    ctx.logger.warn(
      { cap: ctx.maxItemsPerRun, deferred },
      `reached the ${ctx.maxItemsPerRun}-item cap; ${deferred} merge request(s) wait for the next run`,
    );
  }

  let reviewed = 0;
  let skipped = 0;
  let failed = 0;
  const details: string[] = [];

  for (const mr of inScope) {
    if (ctx.signal.aborted) {
      ctx.logger.warn("shutdown requested, stopping early");
      break;
    }

    if (!mr.sha) {
      skipped++;
      details.push(`skipped !${mr.iid}: no head commit reported`);
      continue;
    }

    if (!ctx.force && ledger.lastReviewedSha(ctx.taskId, projectId, mr.iid) === mr.sha) {
      skipped++;
      ctx.logger.info(
        { mrIid: mr.iid, sha: mr.sha },
        `skipped !${mr.iid}: already reviewed at ${mr.sha.slice(0, 8)}`,
      );
      details.push(`skipped !${mr.iid}: already reviewed at ${mr.sha.slice(0, 8)}`);
      continue;
    }
    if (ctx.force && ledger.lastReviewedSha(ctx.taskId, projectId, mr.iid) === mr.sha) {
      ctx.logger.info(
        { mrIid: mr.iid, sha: mr.sha },
        `re-reviewing !${mr.iid} at ${mr.sha.slice(0, 8)} (explicit run)`,
      );
    }

    try {
      const outcome = await ctx.step(
        `mr:${mr.iid}`,
        () => reviewOne({ ctx, gitlab, ledger, projectId, mr }),
        { retry: NO_RETRY, meta: { mrIid: mr.iid } },
      );
      if (outcome.action === "reviewed") {
        reviewed++;
        details.push(`reviewed !${mr.iid}: ${outcome.noteUrl}`);
      } else if (outcome.action === "already-reviewed") {
        skipped++;
        details.push(
          `skipped !${mr.iid}: GitLab already has a review comment at ${outcome.sha.slice(0, 8)}`,
        );
      } else {
        details.push(`dry run: would review !${mr.iid}`);
      }
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      failed++;
      ctx.logger.error(
        { mrIid: mr.iid, err: describeError(err) },
        `could not review MR !${mr.iid}; continuing with the remaining merge requests`,
      );
      details.push(`failed !${mr.iid}: ${describeError(err)}`);
    }
  }

  return {
    itemsSeen: mergeRequests.length,
    itemsProcessed: reviewed,
    itemsSkipped: skipped + deferred,
    // Non-zero fails the run (see TaskResult.itemsFailed) after the rest of
    // the batch has been given a chance — one broken MR must not look like
    // a successful review.
    itemsFailed: failed,
    details: { reviewed, skipped, failed, deferred, notes: details },
  };
}

async function resolveMergeRequests(
  gitlab: GitLabGateway,
  config: Config,
  ctx: TaskContext,
): Promise<MergeRequest[]> {
  if (config.gitlab.mrIid) {
    return [await gitlab.mergeRequest(config.gitlab.projectId, config.gitlab.mrIid, ctx.signal)];
  }

  if (config.gitlab.jiraIssueKey) {
    const key = config.gitlab.jiraIssueKey.toLowerCase();
    // GitLab's MR `search` filter matches title/description, not the branch
    // name — and the Jira key convention this codebase's branches follow
    // (`fix/TP-3012`, `SP-3034-fix-...`) lives in the branch name, so this
    // scans open MRs and filters client-side rather than trusting `search`.
    const open = await gitlab.listMergeRequests(config.gitlab.projectId, {
      state: "opened",
      limit: 100,
      signal: ctx.signal,
    });
    return open.filter(
      (mr) =>
        mr.source_branch.toLowerCase().includes(key) || mr.title.toLowerCase().includes(key),
    );
  }

  return gitlab.listMergeRequests(config.gitlab.projectId, {
    state: "opened",
    limit: ctx.maxItemsPerRun,
    signal: ctx.signal,
  });
}

/**
 * The "Branch" scope: reviews a branch with no MR behind it, inside a
 * container that clones and reviews it in one run — see
 * `infrastructure/agent`. There is nothing to comment on and nothing to
 * dedupe against — a branch has no stable "head commit already reviewed"
 * record the way an MR's ledger row does, since it can be force-pushed or
 * rebased at any time — so this always reviews and reports the result
 * directly rather than writing anywhere.
 */
async function runBranchReview(
  ctx: TaskContext,
  projectId: string,
  branch: string,
): Promise<TaskResult> {
  const { output: review } = await ctx.step(`review:${branch}`, () =>
    runAgentJob({
      executionId: ctx.executionId,
      label: branch,
      workspace: {
        project: projectPathOrThrow(projectId),
        branch,
        token: ctx.secrets.require("GITLAB_TOKEN"),
      },
      prompt: buildReviewPrompt(
        `This is branch ${branch} of ${projectId}.`,
        undefined,
        ctx.prompts[REVIEW_PROMPT_ID],
      ),
      appendRepositoryGuidelines: true,
      output: ReviewOutputSchema,
      onUnstructured: unstructuredReview,
      writePolicy: "none",
      model: ctx.llm.model,
      effort: ctx.llm.effort,
      signal: ctx.signal,
      logger: ctx.logger,
      ...(ctx.actor ? { actor: ctx.actor } : {}),
    }),
  );

  ctx.logger.info(
    { branch, findings: review.findings.length },
    `reviewed ${branch}: ${review.summary}`,
  );

  return {
    itemsSeen: 1,
    itemsProcessed: 1,
    itemsSkipped: 0,
    details: { branch, summary: review.summary, findings: review.findings },
  };
}

function requireReviewRepository(deps: CodeReviewDeps): ReviewRepository {
  if (!deps.reviews) {
    throw new ConfigError(
      "gitlab-code-review requires a durable review repository; the composition " +
        "root must provide one before the task can run.",
    );
  }
  return deps.reviews;
}

function requireConnectorFactory(deps: CodeReviewDeps): TaskConnectorFactory {
  if (!deps.connectors) {
    throw new ConfigError(
      "gitlab-code-review requires connector gateways; the composition root must " +
        "provide them before the task can run.",
    );
  }
  return deps.connectors;
}
