import { z } from "zod";
import type { TaskConnectorFactory } from "../../application/gateways.ts";
import type { NotificationRepository, PlanRepository } from "../../application/ports.ts";
import type { FetchLike } from "../../connectors/http.ts";
import { adfToText } from "../../connectors/jira/adf.ts";
import type { JiraIssueDetail } from "../../connectors/jira/types.ts";
import type { MergeRequest } from "../../connectors/gitlab/types.ts";
import { ConfigError } from "../../core/errors.ts";
import { mutate } from "../../core/step.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import { ensureAgentImage } from "../../infrastructure/agent/index.ts";
import {
  FIX_JIRA_ISSUE_PLANNED_PROMPT_ID,
  FIX_JIRA_ISSUE_PROMPT_ID,
  runFixIssueAgent,
  type FixIssueContext,
} from "./agent.ts";
import { fixIssueBranchName } from "./branch.ts";
import { fixIssueMergeRequestTitle } from "./title.ts";

/**
 * One Jira issue, picked by hand from the "Fix Jira issue" dropdown, to one
 * draft merge request.
 *
 * Deliberately one-shot, not a loop like `jira-ticket-to-mr`: the operator
 * already chose the issue and clicked Run, so there is nothing to poll for
 * and nothing to queue — the whole pipeline runs inside this one `run()`
 * call, the same way `gitlab-code-review`'s branch scope does.
 */

const DEFAULT_COMMIT = { name: "Talos", email: "talos@talos.local" };

const CommitSchema = z
  .object({
    name: z.string().min(1).default(DEFAULT_COMMIT.name),
    email: z.email().default(DEFAULT_COMMIT.email),
  })
  .default(DEFAULT_COMMIT);

const ConfigSchema = z.object({
  jira: z.object({
    issueKey: z.string().min(1),
  }),
  gitlab: z.object({
    /** `group/project` the fix belongs in. Required — there is nothing to guess. */
    projectId: z.string().min(1),
    /** Branch to work from and merge into. Defaults to `develop`. */
    targetBranch: z.string().min(1).default("develop"),
  }),
  commit: CommitSchema,
  /**
   * The approved implementation plan this fix is carrying out, when it was gated.
   *
   * Absent on the ungated path, which is unchanged. The body travels in the job
   * params rather than being read back from the store at lease time, so the job row
   * is a self-contained record of exactly what a human authorised — and re-reading
   * the row later could hand the container text nobody approved.
   */
  plan: z
    .object({
      id: z.string().min(1),
      body: z.string().min(1),
    })
    .optional(),
});

type Config = z.infer<typeof ConfigSchema>;

export const FIX_JIRA_ISSUE_TASK_ID = "fix-jira-issue";

export interface FixJiraIssueDeps {
  fetch?: FetchLike;
  connectors?: TaskConnectorFactory;
  notifications?: NotificationRepository;
  /**
   * Only used to close the loop on a gated fix: the plan is marked implemented once
   * a merge request exists for it. Absent on the ungated path, where there is no
   * plan to close.
   */
  plans?: PlanRepository;
  ensureImage?: typeof ensureAgentImage;
  runAgent?: typeof runFixIssueAgent;
}

export function createFixJiraIssueTask(deps: FixJiraIssueDeps = {}): Task<Config> {
  return {
    id: FIX_JIRA_ISSUE_TASK_ID,
    name: "Fix Jira issue",
    description:
      "Reads a Jira issue, branches off develop, attempts a fix in an isolated workspace, and opens a draft merge request for a human to review.",
    kind: "task",
    instantiable: true,
    paramsSchema: ConfigSchema,
    run: (ctx, config) => run(ctx, config, deps),
  };
}

export const fixJiraIssueTask: Task<Config> = createFixJiraIssueTask();

/**
 * The same pipeline, registered a second time as a queue handler.
 *
 * A separate registration rather than flipping `kind` on the one above, because
 * both entry points are real and mean different things to the console: the
 * `task` is the "Fix Jira issue" form an operator fills in and runs, while this
 * is what a click on a ticket node in the graph enqueues. The worker pool only
 * ever leases `kind: "job"` tasks (see `core/worker-pool.ts`), so a queued click
 * on the form's registration would sit there forever.
 *
 * Identical config and identical `run`: a fix started from the graph must do
 * exactly what the form does, or "it worked from the form" becomes a debugging
 * step rather than a fact.
 */
export const FIX_JIRA_ISSUE_ONE_TASK_ID = "fix-jira-issue-one";

export function createFixJiraIssueWorkerTask(deps: FixJiraIssueDeps = {}): Task<Config> {
  return {
    id: FIX_JIRA_ISSUE_ONE_TASK_ID,
    name: "Fix Jira issue (queued)",
    description:
      "Attempts one Jira issue in an isolated workspace and opens a draft merge request. Queued from a ticket node on the graph rather than run directly.",
    kind: "job",
    agent: true,
    paramsSchema: ConfigSchema,
    run: (ctx, config) => run(ctx, config, deps),
  };
}

async function run(ctx: TaskContext, config: Config, deps: FixJiraIssueDeps): Promise<TaskResult> {
  const connectors = requireConnectorFactory(deps);
  const jira = connectors.jira(ctx, deps.fetch);
  const gitlab = connectors.gitlab(ctx, deps.fetch);
  const issueKey = config.jira.issueKey;
  const projectId = config.gitlab.projectId;
  const targetBranch = config.gitlab.targetBranch;

  const issue = await ctx.step("issue", () => jira.issueDetail(issueKey, ctx.signal));
  if (!issue) {
    throw new ConfigError(`${issueKey} does not exist, or is not visible to this Jira token.`);
  }

  const branch = fixIssueBranchName(issueKey, issue.fields?.summary ?? issueKey);

  // A previous run at this exact issue may have gotten partway: pushed the
  // branch, opened the MR, or both, then died before finishing (see the
  // JSON-parse incident this recovers from). Re-running the agent against a
  // branch it already pushed would just refuse (`push+mr` never overwrites),
  // so check what already exists first — same order `jira-ticket-to-mr` uses,
  // for the same reason: MR before branch, since the MR is the expensive part
  // a rerun must not silently duplicate or lose.
  const existingMr = await ctx.step("existing-merge-request", () =>
    gitlab.listMergeRequests(projectId, { state: "all", sourceBranch: branch, limit: 1, signal: ctx.signal }),
  );
  if (existingMr[0]) {
    return await adopt(ctx, deps, issueKey, existingMr[0], branch, config.plan?.id);
  }

  if (ctx.dryRun) {
    ctx.logger.info(
      { issue: issueKey, branch },
      `[dry-run] would attempt ${issueKey} and open a draft merge request from ${branch}`,
    );
    return { itemsSeen: 1, itemsProcessed: 0, itemsSkipped: 1, details: { issueKey, branch } };
  }

  // A branch with no MR means a previous attempt pushed a real change and died
  // before opening the merge request — but we have no agent output from that
  // attempt (it was never persisted), so there is no title, description or
  // release notes to build a proper MR from. Opening one anyway produced a
  // degraded MR (no release notes, generic title); notifying and stopping
  // leaves the decision — open it by hand, or delete the branch and rerun —
  // with the human, same as adopting an existing MR does.
  const pushed = await ctx.step("existing-branch", async () => {
    const branches = await gitlab.listBranches(projectId, { search: branch, limit: 20, signal: ctx.signal });
    return branches.some((candidate) => candidate.name === branch);
  });
  if (pushed) return branchNeedsAttention(ctx, deps, issueKey, branch, projectId, targetBranch);

  await ctx.step("ensure-agent-image", () => (deps.ensureImage ?? ensureAgentImage)(ctx.logger));

  const agent = await ctx.step("fix-issue", () =>
    (deps.runAgent ?? runFixIssueAgent)({
      executionId: ctx.executionId,
      project: projectId,
      baseBranch: targetBranch,
      pushBranch: branch,
      token: ctx.secrets.require("GITLAB_TOKEN"),
      issue: issueContext(issue, jira.issueUrl(issueKey)),
      ...(config.plan ? { plan: config.plan } : {}),
      commitName: ctx.actor?.name ?? config.commit.name,
      commitEmail: ctx.actor?.email ?? config.commit.email,
      ...(ctx.llm.model ? { model: ctx.llm.model } : {}),
      ...(ctx.llm.effort ? { effort: ctx.llm.effort } : {}),
      // Each path resolves its own override, so a rewritten ungated prompt cannot
      // reach the gated run and drop the plan clauses on the floor.
      promptTemplate:
        ctx.prompts[config.plan ? FIX_JIRA_ISSUE_PLANNED_PROMPT_ID : FIX_JIRA_ISSUE_PROMPT_ID],
      signal: ctx.signal,
      logger: ctx.logger,
      ...(ctx.actor ? { actor: ctx.actor } : {}),
    }),
  );

  // Nothing pushed means no merge request, which is the whole point of this task —
  // so it is *skipped*, not processed. Counted as processed, this run reported
  // "succeeded, 1 item processed" for a run whose only product was an opinion,
  // which is indistinguishable in the list from one that opened an MR.
  //
  // Still a success rather than a failure: "this is already fixed" is a correct,
  // useful answer. `action: "no-change"` is what the console renders instead of a
  // merge request link, and `agentErrors` is what stops that answer from looking
  // clean when the investigation behind it was not.
  if (!agent.pushedBranch) {
    ctx.logger.info(
      { issue: issueKey, summary: agent.summary, ...(agent.toolErrors ? { toolErrors: agent.toolErrors } : {}) },
      `${issueKey}: no change made — ${agent.summary}`,
    );
    return {
      itemsSeen: 1,
      itemsProcessed: 0,
      itemsSkipped: 1,
      details: {
        issueKey,
        action: "no-change",
        summary: agent.summary,
        ...(agent.toolErrors ? { agentErrors: agent.toolErrors } : {}),
      },
    };
  }

  const summary = issue.fields?.summary ?? issueKey;
  const mr = await mutate(
    ctx,
    `open a draft merge request from ${branch} in ${projectId}`,
    () =>
      gitlab.createMergeRequest(projectId, {
        sourceBranch: branch,
        targetBranch,
        title: fixIssueMergeRequestTitle(issueKey, agent.title, summary),
        description: mergeRequestDescription({
          issueKey,
          issueUrl: jira.issueUrl(issueKey),
          summary,
          body: agent.description,
          releaseNotes: agent.releaseNotes,
        }),
        draft: true,
        removeSourceBranch: true,
        labels: mrLabelsFor(issue),
        signal: ctx.signal,
      }),
    { issue: issueKey, branch, targetBranch },
  );
  if (!mr) throw new ConfigError("merge request creation was unexpectedly suppressed");

  ctx.logger.info(
    { issue: issueKey, mrIid: mr.iid, webUrl: mr.web_url, branch },
    `opened draft !${mr.iid} for ${issueKey}`,
  );

  // Transition the Jira ticket to CODE REVIEW status
  await ctx.step("transition-to-code-review", async () => {
    try {
      const transition = await jira.transitionIssueTo(issueKey, "CODE REVIEW", ctx.signal);
      ctx.logger.info(
        { issue: issueKey, transition: transition.to?.name },
        `moved ${issueKey} to CODE REVIEW`,
      );
      return transition;
    } catch (err) {
      // Log but don't fail the entire task if transition fails
      ctx.logger.warn(
        { issue: issueKey, error: err },
        `could not transition ${issueKey} to CODE REVIEW — manual transition may be needed`,
      );
      return null;
    }
  });

  notifyMrReady(ctx, deps, issueKey, mr);
  closePlan(ctx, deps, config.plan?.id);

  return {
    itemsSeen: 1,
    itemsProcessed: 1,
    itemsSkipped: 0,
    details: {
      issueKey,
      action: "opened",
      mrIid: mr.iid,
      mrUrl: mr.web_url,
      branch,
      targetBranch,
      commitSha: agent.commitSha,
      ...(config.plan ? { planId: config.plan.id } : {}),
      ...(agent.toolErrors ? { agentErrors: agent.toolErrors } : {}),
    },
  };
}

/**
 * A branch exists from a previous attempt but no MR does, and there is no
 * agent output left to build one from — see the comment at the call site.
 * A success, not a failure: the run correctly determined nothing more can be
 * done automatically, and said so.
 */
function branchNeedsAttention(
  ctx: TaskContext,
  deps: FixJiraIssueDeps,
  issueKey: string,
  branch: string,
  projectId: string,
  targetBranch: string,
): TaskResult {
  const compareUrl = `https://gitlab.com/${projectId}/-/compare/${encodeURIComponent(targetBranch)}...${encodeURIComponent(branch)}`;
  ctx.logger.warn(
    { issue: issueKey, branch, compareUrl },
    `${branch} already exists with no merge request; a previous attempt at ${issueKey} was ` +
      `interrupted after pushing — review it by hand or delete the branch and rerun`,
  );
  deps.notifications?.create({
    kind: FIX_JIRA_ISSUE_TASK_ID,
    title: `${issueKey} needs attention`,
    body: `${branch} was already pushed by a previous attempt, but no merge request exists. Review the diff or delete the branch and rerun.`,
    link: compareUrl,
    taskRunId: ctx.executionId,
  });
  return {
    itemsSeen: 1,
    itemsProcessed: 0,
    itemsSkipped: 1,
    details: { issueKey, action: "needs-attention", branch },
  };
}

/**
 * Reports a merge request a previous attempt already opened, rather than
 * running the agent — and a *success*, not a failure: the run's purpose,
 * "there is a draft merge request for this issue", is already true.
 */
async function adopt(
  ctx: TaskContext,
  deps: FixJiraIssueDeps,
  issueKey: string,
  mr: MergeRequest,
  branch: string,
  planId?: string,
): Promise<TaskResult> {
  ctx.logger.info(
    { issue: issueKey, mrIid: mr.iid, state: mr.state, branch },
    `${issueKey} already has !${mr.iid} from ${branch}; nothing to do`,
  );

  // Also attempt to transition the ticket if it was adopted from a previous run
  const connectors = requireConnectorFactory(deps);
  const jira = connectors.jira(ctx, deps.fetch);
  await ctx.step("transition-to-code-review", async () => {
    try {
      const transition = await jira.transitionIssueTo(issueKey, "CODE REVIEW", ctx.signal);
      ctx.logger.info(
        { issue: issueKey, transition: transition.to?.name },
        `moved ${issueKey} to CODE REVIEW`,
      );
      return transition;
    } catch (err) {
      ctx.logger.warn(
        { issue: issueKey, error: err },
        `could not transition ${issueKey} to CODE REVIEW — manual transition may be needed`,
      );
      return null;
    }
  });

  notifyMrReady(ctx, deps, issueKey, mr);
  // The plan's purpose — "there is a merge request implementing this plan" — is
  // already true, whichever attempt made it so. Leaving it `approved` would offer a
  // reviewer an Approve button for work that has shipped.
  closePlan(ctx, deps, planId);
  return {
    itemsSeen: 1,
    itemsProcessed: 0,
    itemsSkipped: 1,
    details: {
      issueKey,
      action: "adopted",
      mrIid: mr.iid,
      mrUrl: mr.web_url,
      ...(planId ? { planId } : {}),
    },
  };
}

/**
 * Marks the approved plan implemented, now that a merge request exists for it.
 *
 * Best-effort and never fatal: the merge request is the real product, and a plan row
 * left saying `approved` after one was opened is a cosmetic wrong answer in the
 * console, not a reason to fail a run that succeeded. `markImplemented` refuses
 * anything not `approved`, so a re-run cannot walk the row backwards either.
 */
function closePlan(ctx: TaskContext, deps: FixJiraIssueDeps, planId?: string): void {
  if (!planId || !deps.plans) return;
  if (!deps.plans.markImplemented(planId)) {
    ctx.logger.warn(
      { plan: planId },
      `plan ${planId} was not in the approved state when its merge request opened`,
    );
  }
}

function notifyMrReady(
  ctx: TaskContext,
  deps: FixJiraIssueDeps,
  issueKey: string,
  mr: MergeRequest,
): void {
  deps.notifications?.create({
    kind: FIX_JIRA_ISSUE_TASK_ID,
    title: `Draft MR ready: ${issueKey}`,
    body: mr.title,
    link: mr.web_url,
    taskRunId: ctx.executionId,
  });
}

/**
 * The `"unit test"` label belongs only on MRs fixing a ticket the "GitLab CI
 * failures to Jira" loop filed — identifiable by the `ci-failure` label,
 * which is part of that loop's configurable `jira.labels` (see `DEFAULT_JIRA`
 * in `ci-failure/index.ts`) and so may be absent if a user removed it there.
 * A ticket picked by hand, from any other source, gets no label at all.
 */
function mrLabelsFor(issue: JiraIssueDetail): string[] {
  return issue.fields?.labels?.includes("ci-failure") ? ["unit test"] : [];
}

/**
 * What the agent is shown about the issue.
 *
 * Exported because the planning agent must be shown *exactly* the same view. A
 * plan approved against one rendering of the ticket and implemented against
 * another is a gate that does not gate anything.
 */
export function issueContext(issue: JiraIssueDetail, url: string): FixIssueContext {
  const fields = issue.fields;
  return {
    key: issue.key,
    summary: fields?.summary ?? issue.key,
    description: adfToText(fields?.description),
    ...(fields?.issuetype?.name ? { issueType: fields.issuetype.name } : {}),
    ...(fields?.priority?.name ? { priority: fields.priority.name } : {}),
    labels: fields?.labels ?? [],
    ...(fields?.reporter?.displayName ? { reporter: fields.reporter.displayName } : {}),
    url,
  };
}

/**
 * The MR description.
 *
 * `Closes` deliberately absent — see `jira-ticket-to-mr/index.ts` for why:
 * GitLab's own `Closes` keyword does nothing with a Jira key.
 */
function mergeRequestDescription(args: {
  issueKey: string;
  issueUrl: string;
  summary: string;
  body?: string;
  /** Written by the agent per the repo's own docs/RELEASE_NOTES_GUIDELINES.md, if any. */
  releaseNotes?: string;
}): string {
  return (
    `Fixes [${args.issueKey}](${args.issueUrl}) — ${args.summary}\n\n` +
    (args.body ? `${args.body.trim()}\n\n` : "") +
    (args.releaseNotes ? `## Release notes\n\n${args.releaseNotes.trim()}\n\n` : "") +
    "---\n\nOpened as a draft by Talos from an AI attempt at the issue above. " +
    "Every line of it needs a human review before this is marked ready."
  );
}

function requireConnectorFactory(deps: FixJiraIssueDeps): TaskConnectorFactory {
  if (!deps.connectors) {
    throw new ConfigError(
      `${FIX_JIRA_ISSUE_TASK_ID} requires connector gateways; the composition root must provide them.`,
    );
  }
  return deps.connectors;
}
