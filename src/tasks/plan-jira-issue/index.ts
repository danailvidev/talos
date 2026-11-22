import { z } from "zod";
import type { TaskConnectorFactory } from "../../application/gateways.ts";
import type { NotificationRepository, PlanRepository } from "../../application/ports.ts";
import type { FetchLike } from "../../connectors/http.ts";
import { ConfigError } from "../../core/errors.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import { ensureAgentImage } from "../../infrastructure/agent/index.ts";
import { issueContext } from "../fix-jira-issue/index.ts";
import { ticketFingerprint } from "../jira-ticket-to-mr/ticket.ts";
import {
  PLAN_JIRA_ISSUE_PROMPT_ID,
  planDocument,
  runPlanIssueAgent,
} from "./agent.ts";

/**
 * One Jira issue to one implementation plan, for a human to approve before any
 * code is written.
 *
 * The first half of the gated pipeline: this produces a plan and stops, and
 * approving it (see `api/plan-actions.ts`) enqueues `fix-jira-issue-one` carrying
 * the approved text. Two jobs rather than one run that pauses, because agent
 * capacity is a semaphore of two by default and it is held for exactly as long as
 * a container lives (`acquireAgentCapacity`, released in `runAgentJob`'s finally).
 * A run that waited for a human with its container alive would hold a slot for
 * hours, and two of them would stall every other agent on the daemon — the
 * semaphore queues rather than refusing, so the symptom would be silence.
 * Finishing the job instead releases the slot, and the plan waits in SQLite, where
 * waiting is free.
 *
 * A queue handler with no loop in front of it, like `review-ticket`: a plan is
 * written when somebody asks for one, or when a loop configured to require one
 * finds a ticket. It is never written on a timer for its own sake.
 */

const ConfigSchema = z.object({
  jira: z.object({
    issueKey: z.string().min(1),
  }),
  gitlab: z.object({
    /** `group/project` to plan against. Required — there is nothing to guess. */
    projectId: z.string().min(1),
    /** The branch the plan is written against. Defaults to `develop`. */
    targetBranch: z.string().min(1).default("develop"),
  }),
});

type Config = z.infer<typeof ConfigSchema>;

export const PLAN_JIRA_ISSUE_TASK_ID = "plan-jira-issue";

export interface PlanJiraIssueDeps {
  fetch?: FetchLike;
  connectors?: TaskConnectorFactory;
  notifications?: NotificationRepository;
  /** Where the plan is recorded for a human to decide on. */
  plans?: PlanRepository;
  ensureImage?: typeof ensureAgentImage;
  runAgent?: typeof runPlanIssueAgent;
}

export function createPlanJiraIssueTask(deps: PlanJiraIssueDeps = {}): Task<Config> {
  return {
    id: PLAN_JIRA_ISSUE_TASK_ID,
    name: "Plan a Jira issue",
    description:
      "Reads a Jira issue and the repository, then writes an implementation plan for a human to review, edit and approve. Writes no code and opens no merge request — approving the plan is what starts the fix.",
    kind: "job",
    agent: true,
    paramsSchema: ConfigSchema,
    run: (ctx, config) => run(ctx, config, deps),
  };
}

async function run(ctx: TaskContext, config: Config, deps: PlanJiraIssueDeps): Promise<TaskResult> {
  const connectors = requireConnectorFactory(deps);
  const plans = requirePlanRepository(deps);
  const jira = connectors.jira(ctx, deps.fetch);
  const gitlab = connectors.gitlab(ctx, deps.fetch);
  const issueKey = config.jira.issueKey;
  const projectId = config.gitlab.projectId;
  const targetBranch = config.gitlab.targetBranch;

  const issue = await ctx.step("issue", () => jira.issueDetail(issueKey, ctx.signal));
  if (!issue) {
    throw new ConfigError(`${issueKey} does not exist, or is not visible to this Jira token.`);
  }

  if (ctx.dryRun) {
    ctx.logger.info(
      { issue: issueKey, projectId, targetBranch },
      `[dry-run] would plan ${issueKey} against ${targetBranch} in ${projectId}`,
    );
    return { itemsSeen: 1, itemsProcessed: 0, itemsSkipped: 1, details: { issueKey } };
  }

  // The head the plan is reasoning about. Best-effort: without it the plan simply
  // carries no base sha and the console shows no drift warning, which is a worse
  // review but not a reason to refuse to plan. Same listing-and-exact-match shape
  // `fix-jira-issue` uses to notice an already-pushed branch.
  const baseSha = await ctx.step("base-sha", async () => {
    try {
      const branches = await gitlab.listBranches(projectId, {
        search: targetBranch,
        limit: 20,
        signal: ctx.signal,
      });
      return branches.find((candidate) => candidate.name === targetBranch)?.commit?.id;
    } catch (err) {
      ctx.logger.warn(
        { issue: issueKey, projectId, targetBranch, error: err },
        `could not read the head of ${targetBranch}; the plan will carry no base commit`,
      );
      return undefined;
    }
  });

  await ctx.step("ensure-agent-image", () => (deps.ensureImage ?? ensureAgentImage)(ctx.logger));

  const agent = await ctx.step("plan-issue", () =>
    (deps.runAgent ?? runPlanIssueAgent)({
      executionId: ctx.executionId,
      project: projectId,
      baseBranch: targetBranch,
      token: ctx.secrets.require("GITLAB_TOKEN"),
      issue: issueContext(issue, jira.issueUrl(issueKey)),
      ...(ctx.llm.model ? { model: ctx.llm.model } : {}),
      ...(ctx.llm.effort ? { effort: ctx.llm.effort } : {}),
      promptTemplate: ctx.prompts[PLAN_JIRA_ISSUE_PROMPT_ID],
      signal: ctx.signal,
      logger: ctx.logger,
      ...(ctx.actor ? { actor: ctx.actor } : {}),
    }),
  );

  const body = planDocument(agent);

  // No plan worth reviewing. A success, not a failure — "nobody can build this as
  // written" is the answer the gate exists to surface, and surfacing it before a
  // container wrote code is the cheap version of finding out. Skipped rather than
  // processed for the same reason `fix-jira-issue` counts `no-change` that way:
  // the run's product is an opinion, not a plan, and the list must not read alike.
  if (agent.verdict === "not-plannable" || body.length === 0) {
    ctx.logger.info(
      { issue: issueKey, summary: agent.summary, ...(agent.toolErrors ? { toolErrors: agent.toolErrors } : {}) },
      `${issueKey}: not plannable — ${agent.summary}`,
    );
    deps.notifications?.create({
      kind: PLAN_JIRA_ISSUE_TASK_ID,
      title: `${issueKey} cannot be planned`,
      body: agent.summary,
      taskRunId: ctx.executionId,
    });
    return {
      itemsSeen: 1,
      itemsProcessed: 0,
      itemsSkipped: 1,
      details: {
        issueKey,
        action: "not-plannable",
        summary: agent.summary,
        ...(agent.toolErrors ? { agentErrors: agent.toolErrors } : {}),
      },
    };
  }

  const plan = plans.create({
    issueKey,
    projectId,
    targetBranch,
    draftBody: body,
    summary: agent.summary,
    ticketFingerprint: ticketFingerprint(issueKey, issue.fields?.updated),
    ...(baseSha ? { baseSha } : {}),
    planRunId: ctx.executionId,
    ...(ctx.actor ? { requestedBy: ctx.actor.id } : {}),
  });

  ctx.logger.info(
    { issue: issueKey, plan: plan.id, chars: body.length },
    `wrote a plan for ${issueKey}; waiting on a human to approve it`,
  );

  // `taskRunId`, never `jobId`: the worker pool calls `notifications.deleteByJob`
  // the moment this job completes, so a bell tagged with the job id would be
  // deleted a moment after being raised. Same reason `fix-jira-issue` tags its
  // "draft MR ready" notification with the run.
  deps.notifications?.create({
    kind: PLAN_JIRA_ISSUE_TASK_ID,
    title: `Plan ready to review: ${issueKey}`,
    body: agent.summary,
    taskRunId: ctx.executionId,
  });

  return {
    itemsSeen: 1,
    itemsProcessed: 1,
    itemsSkipped: 0,
    details: {
      issueKey,
      action: "planned",
      planId: plan.id,
      summary: agent.summary,
      ...(agent.toolErrors ? { agentErrors: agent.toolErrors } : {}),
    },
  };
}

function requireConnectorFactory(deps: PlanJiraIssueDeps): TaskConnectorFactory {
  if (!deps.connectors) {
    throw new ConfigError(
      `${PLAN_JIRA_ISSUE_TASK_ID} requires connector gateways; the composition root must provide them.`,
    );
  }
  return deps.connectors;
}

function requirePlanRepository(deps: PlanJiraIssueDeps): PlanRepository {
  if (!deps.plans) {
    throw new ConfigError(
      `${PLAN_JIRA_ISSUE_TASK_ID} requires a plan repository; the composition root must provide one.`,
    );
  }
  return deps.plans;
}
