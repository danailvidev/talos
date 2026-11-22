import { z } from "zod";
import type { TaskConnectorFactory } from "../../application/gateways.ts";
import type { NotificationRepository } from "../../application/ports.ts";
import { mergeRequestConflictState } from "../../connectors/gitlab/types.ts";
import type { FetchLike } from "../../connectors/http.ts";
import { ConfigError } from "../../core/errors.ts";
import { NO_RETRY } from "../../core/retry.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import { ensureAgentImage } from "../../infrastructure/agent/index.ts";
import {
  RESOLVE_CONFLICTS_PROMPT_ID,
  runResolveConflictsAgent,
  type ResolveConflictsAgentResult,
} from "./agent.ts";

/**
 * Rebases one merge request onto its target branch, letting an agent resolve the
 * conflicts, and force-pushes the result.
 *
 * A queue handler with no loop in front of it, unlike the review and follow-up
 * tasks. That is deliberate: nothing should rewrite somebody's branch on a timer.
 * A conflicted merge request is a fact a developer looks at and decides about, so
 * the only thing that enqueues this is a person pressing the button on the pull
 * request detail view.
 */

const DEFAULT_COMMIT = { name: "Talos", email: "talos@talos.local" };

const CommitSchema = z
  .object({
    name: z.string().min(1).default(DEFAULT_COMMIT.name),
    email: z.email().default(DEFAULT_COMMIT.email),
  })
  .default(DEFAULT_COMMIT);

const WorkerConfigSchema = z.object({
  gitlab: z.object({
    projectId: z.string().min(1),
    mrIid: z.number().int().positive(),
  }),
  commit: CommitSchema,
});

type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export const RESOLVE_CONFLICTS_ONE_TASK_ID = "gitlab-resolve-conflicts-one";

export interface ResolveConflictsDeps {
  fetch?: FetchLike;
  connectors?: TaskConnectorFactory;
  notifications?: NotificationRepository;
  ensureImage?: typeof ensureAgentImage;
  runAgent?: typeof runResolveConflictsAgent;
}

export function createResolveConflictsWorkerTask(
  deps: ResolveConflictsDeps = {},
): Task<WorkerConfig> {
  return {
    id: RESOLVE_CONFLICTS_ONE_TASK_ID,
    name: "GitLab MR conflict resolution",
    description:
      "Rebases one merge request onto its target branch in an isolated workspace, resolves the conflicts, and force-pushes the branch. Queued from the pull request view rather than run directly.",
    kind: "job",
    agent: true,
    paramsSchema: WorkerConfigSchema,
    run: (ctx, config) => runWorker(ctx, config, deps),
  };
}

async function runWorker(
  ctx: TaskContext,
  config: WorkerConfig,
  deps: ResolveConflictsDeps,
): Promise<TaskResult> {
  const gitlab = requireConnectorFactory(deps).gitlab(ctx, deps.fetch);
  const projectId = config.gitlab.projectId;
  const mr = await ctx.step("merge-request", () =>
    gitlab.mergeRequest(projectId, config.gitlab.mrIid, ctx.signal),
  );

  if (mr.state !== "opened") {
    return {
      itemsSeen: 1,
      itemsProcessed: 0,
      itemsSkipped: 1,
      details: {
        mrIid: mr.iid,
        action: "skipped",
        summary: `!${mr.iid} is ${mr.state}, so there is nothing to rebase.`,
      },
    };
  }
  if (!mr.sha) throw new ConfigError(`MR !${mr.iid} has no head SHA`);
  if (mr.source_branch === mr.target_branch) {
    throw new ConfigError(
      `MR !${mr.iid} has ${mr.source_branch} as both source and target; there is nothing to rebase onto`,
    );
  }

  // Rebasing a merge request that is already clean is not wrong, only pointless —
  // it rewrites every SHA on the branch, invalidates the pipeline and the review
  // comments' line anchors, and gains nothing. Note that "unknown" is *not*
  // treated as clean: GitLab computes mergeability lazily, and refusing to act
  // while it has not answered would make the button randomly do nothing.
  if (mergeRequestConflictState(mr) === "clean") {
    return {
      itemsSeen: 1,
      itemsProcessed: 0,
      itemsSkipped: 1,
      details: {
        mrIid: mr.iid,
        action: "skipped",
        summary:
          `!${mr.iid} merges cleanly into ${mr.target_branch}, so there is nothing to ` +
          "resolve — rebasing anyway would rewrite every SHA for no gain.",
      },
    };
  }

  if (ctx.dryRun) {
    return {
      itemsSeen: 1,
      itemsProcessed: 0,
      itemsSkipped: 1,
      details: {
        mrIid: mr.iid,
        action: "dry-run",
        summary: `Dry run: would rebase ${mr.source_branch} onto ${mr.target_branch}.`,
      },
    };
  }

  // A merge request from a fork lives on the fork's own path; pushing the rebased
  // branch to the target project would create a branch nobody asked for.
  const sourceProject = await ctx.step("source-project", () =>
    gitlab.project(mr.source_project_id ?? projectId, ctx.signal),
  );

  await ctx.step("ensure-agent-image", () => (deps.ensureImage ?? ensureAgentImage)(ctx.logger));

  const result = await ctx.step(
    `resolve-conflicts:${mr.iid}`,
    () =>
      (deps.runAgent ?? runResolveConflictsAgent)({
        executionId: ctx.executionId,
        mrIid: mr.iid,
        project: sourceProject.path_with_namespace,
        branch: mr.source_branch,
        targetBranch: mr.target_branch,
        startSha: mr.sha!,
        token: ctx.secrets.require("GITLAB_TOKEN"),
        context: {
          mergeRequest: {
            iid: mr.iid,
            title: mr.title,
            ...(mr.description ? { description: mr.description } : {}),
            sourceBranch: mr.source_branch,
            targetBranch: mr.target_branch,
            webUrl: mr.web_url,
          },
        },
        // The developer who pressed the button, so `git log` on their branch shows
        // a commit made on their behalf rather than one from a bot.
        commitName: ctx.actor?.name ?? config.commit.name,
        commitEmail: ctx.actor?.email ?? config.commit.email,
        ...(ctx.llm.model ? { model: ctx.llm.model } : {}),
        ...(ctx.llm.effort ? { effort: ctx.llm.effort } : {}),
        ...(ctx.prompts[RESOLVE_CONFLICTS_PROMPT_ID]
          ? { promptTemplate: ctx.prompts[RESOLVE_CONFLICTS_PROMPT_ID] }
          : {}),
        signal: ctx.signal,
        logger: ctx.logger,
        ...(ctx.actor ? { actor: ctx.actor } : {}),
      }),
    // Never retried: the first attempt may already have force-pushed, and a
    // second rebase would start from a head the job was not raised for.
    { retry: NO_RETRY, meta: { mrIid: mr.iid, target: mr.target_branch } },
  );

  notify(deps, ctx, mr.iid, mr.web_url, result);

  return {
    itemsSeen: 1,
    itemsProcessed: result.unresolved.length > 0 ? 0 : 1,
    itemsSkipped: result.unresolved.length > 0 ? 1 : 0,
    details: {
      mrIid: mr.iid,
      action: result.unresolved.length > 0 ? "partly-resolved" : "resolved",
      commitSha: result.commitSha,
      resolved: result.resolved.map((file) => file.path),
      unresolved: result.unresolved.map((file) => file.path),
      summary: result.summary,
    },
    // The notification below already says what happened per outcome; the sink's
    // generic "completed" notice on top of it would be a second bell for one click.
    notifiedIndividually: true,
  };
}

/**
 * One notification per outcome, because the three outcomes need three different
 * things from the developer: nothing, a look at the branch, or a hand-resolve.
 * The user asked for the branch and got told about it — that is the point of the
 * action.
 */
function notify(
  deps: ResolveConflictsDeps,
  ctx: TaskContext,
  mrIid: number,
  webUrl: string,
  result: ResolveConflictsAgentResult,
): void {
  const unresolved = result.unresolved.length;
  const title =
    unresolved > 0
      ? `!${mrIid}: ${unresolved} conflict${unresolved === 1 ? "" : "s"} need you`
      : result.commitSha
        ? `!${mrIid}: conflicts resolved`
        : `!${mrIid}: nothing to rebase`;

  const body =
    unresolved > 0
      ? `${result.unresolved.map((file) => `${file.path} — ${file.reasoning}`).join("; ")}. The rebase was abandoned, so the branch is untouched.`
      : result.commitSha
        ? `Rebased and force-pushed as ${result.commitSha.slice(0, 12)}. ${result.summary}`
        : result.summary;

  deps.notifications?.create({
    kind: RESOLVE_CONFLICTS_ONE_TASK_ID,
    title,
    body,
    link: webUrl,
    taskRunId: ctx.executionId,
  });
}

function requireConnectorFactory(deps: ResolveConflictsDeps): TaskConnectorFactory {
  if (!deps.connectors) {
    throw new ConfigError(
      `${RESOLVE_CONFLICTS_ONE_TASK_ID} requires connector gateways; the composition root must provide them.`,
    );
  }
  return deps.connectors;
}
