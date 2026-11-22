import { z } from "zod";
import type { JiraGateway, TaskConnectorFactory } from "../../application/gateways.ts";
import type { JobRepository } from "../../application/ports.ts";
import type { FetchLike } from "../../connectors/http.ts";
import type { MergeRequest } from "../../connectors/gitlab/types.ts";
import {
  adfToText,
  doc,
  fitDocument,
  linkParagraph,
  paragraph,
} from "../../connectors/jira/adf.ts";
import {
  DONE_CATEGORY,
  isResolved,
  type JiraIssueDetail,
} from "../../connectors/jira/types.ts";
import { ConfigError } from "../../core/errors.ts";
import { defaultDedupeKey } from "../../core/job.ts";
import { NO_RETRY } from "../../core/retry.ts";
import { mutate } from "../../core/step.ts";
import type { SubjectTracker } from "../../core/subject.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import { ensureAgentImage } from "../../infrastructure/agent/index.ts";
import { PLAN_JIRA_ISSUE_TASK_ID } from "../plan-jira-issue/index.ts";
import {
  runTicketAgent,
  TICKET_PROMPT_ID,
  type TicketAgentResult,
  type TicketContext,
} from "./agent.ts";
import {
  ticketBranchName,
  ticketFingerprint,
  ticketLabels,
  ticketSubjectKey,
} from "./ticket.ts";


/**
 * Jira tickets to draft merge requests. One branch per ticket version, one draft
 * MR per branch, and a human on the other end of every one of them.
 *
 * The loop only *selects*: it asks Jira for tickets matching a JQL query, decides
 * which of them it has not already attempted at their current version, and queues
 * one job each. Everything expensive — cloning, the agent, the push, the MR —
 * happens in the handler, one ticket at a time, bounded by the worker pool.
 *
 * The delicate part is not the agent, it is what happens when a job dies halfway.
 * Three things are created in sequence and each one is a separate failure point: a
 * branch, a merge request, a Jira comment. So the handler starts by asking GitLab
 * what already exists, in the order those things are created:
 *
 * 1. Is there already an MR from this ticket's branch? Then the work is done, and
 *    the job's only remaining duty is to record that.
 * 2. Does the *branch* exist without an MR? Then the agent already did the
 *    expensive part and died before the MR existed — open the MR from what is
 *    there. Emphatically without re-running the agent: that would either duplicate
 *    the work or, since the container refuses to push over an existing branch,
 *    burn twenty minutes to fail.
 * 3. Neither exists? Run the agent.
 *
 * The branch name is what ties those three cases together, which is why it is
 * derived deterministically from the ticket and its version rather than from a
 * timestamp — see `ticket.ts`.
 *
 * Draft is not configurable. The whole loop is built on the premise that an agent
 * proposes and a developer decides, and a non-draft MR from a machine invites
 * exactly the "it looked ready so I merged it" failure the draft flag exists to
 * prevent.
 */

const DEFAULT_COMMIT = { name: "Talos", email: "talos@talos.local" };

const CommitSchema = z
  .object({
    name: z.string().min(1).default(DEFAULT_COMMIT.name),
    email: z.email().default(DEFAULT_COMMIT.email),
  })
  .default(DEFAULT_COMMIT);

/**
 * Hourly by default.
 *
 * Unlike the GitLab loops there is no webhook to lean on — Jira's own webhooks
 * are a separate integration this does not yet ingest — so this poll *is* the
 * clock. Hourly rather than every few minutes because the unit of work here is a
 * whole ticket: a developer who labels one does not expect a merge request within
 * ninety seconds, and each attempt costs an agent container.
 */
export const JIRA_TICKET_TO_MR_CRON = "0 * * * *";

const JiraSelectorSchema = z.object({
  /** Project key, e.g. `TP`. */
  project: z.string().min(1),
  /**
   * Full JQL, replacing the label-based default entirely.
   *
   * The escape hatch for a team whose selection rule is a component, a sprint or
   * a custom field. `project` is still required alongside it, because the Jira
   * link the UI shows and the labels a raised MR carries are derived from it.
   */
  jql: z.string().min(1).optional(),
  /**
   * The label that opts a ticket in. Deliberately opt-in and deliberately a
   * label: nothing should send an agent at a ticket because it merely exists, and
   * a label is the one selector a developer can apply from the ticket they are
   * already looking at.
   */
  label: z.string().min(1).default("talos"),
  /**
   * Move the ticket to this status once its merge request is open, e.g.
   * "In Review". Matched by name against the transitions the issue actually
   * offers; a mismatch warns rather than failing the job.
   */
  transitionTo: z.string().min(1).optional(),
});

const GitLabTargetSchema = z.object({
  /** `group/project` the change belongs in. Required — there is nothing to guess. */
  projectId: z.string().min(1),
  /** Branch to work from and merge into. Omitted uses the project's default. */
  targetBranch: z.string().min(1).optional(),
});

const ConfigSchema = z.object({
  jira: JiraSelectorSchema,
  gitlab: GitLabTargetSchema,
  commit: CommitSchema,
  /**
   * Plan first, and wait for a human, instead of attempting the ticket outright.
   *
   * Off by default, and that default is the whole point of the flag: turning it on
   * converts an unattended loop into one that stops on every ticket until somebody
   * reads a plan, which is a deliberate choice about how this team works and not
   * something an existing loop should acquire in an upgrade.
   *
   * When on, the loop queues `plan-jira-issue` in place of the attempt. Approving the
   * plan is what queues code — from the API, not from here, so a plan sitting in
   * review costs no agent slot and no tick.
   */
  plan: z
    .object({ required: z.boolean().default(false) })
    .default({ required: false }),
});

const WorkerConfigSchema = z.object({
  jira: JiraSelectorSchema.extend({ issueKey: z.string().min(1) }),
  gitlab: GitLabTargetSchema,
  commit: CommitSchema,
});

type Config = z.infer<typeof ConfigSchema>;
type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export const JIRA_TICKET_TO_MR_TASK_ID = "jira-ticket-to-mr";
export const JIRA_TICKET_TO_MR_ONE_TASK_ID = "jira-ticket-to-mr-one";

/** How many tickets one poll considers before the item cap applies. */
const TICKET_SCAN_LIMIT = 50;

export interface JiraTicketToMrDeps {
  fetch?: FetchLike;
  connectors?: TaskConnectorFactory;
  subjects?: SubjectTracker;
  jobs?: JobRepository;
  ensureImage?: typeof ensureAgentImage;
  runAgent?: typeof runTicketAgent;
}

export function createJiraTicketToMrTask(
  deps: JiraTicketToMrDeps = {},
): Task<Config> {
  return {
    id: JIRA_TICKET_TO_MR_TASK_ID,
    name: "Jira tickets to merge requests",
    description:
      "Picks up Jira tickets carrying a configured opt-in label (talos by default), attempts each one in an isolated branch workspace, and opens a draft merge request for a human to review.",
    kind: "loop",
    instantiable: true,
    defaultTrigger: { type: "cron", expression: JIRA_TICKET_TO_MR_CRON },
    paramsSchema: ConfigSchema,
    run: (ctx, config) => runLoop(ctx, config, deps),
  };
}

export const jiraTicketToMrTask = createJiraTicketToMrTask();

export function createJiraTicketToMrWorkerTask(
  deps: JiraTicketToMrDeps = {},
): Task<WorkerConfig> {
  return {
    id: JIRA_TICKET_TO_MR_ONE_TASK_ID,
    name: "Jira ticket attempt",
    description:
      "Attempts one Jira ticket in an isolated branch workspace and opens a draft merge request. Queued by the Jira ticket loop rather than run directly.",
    kind: "job",
    agent: true,
    paramsSchema: WorkerConfigSchema,
    run: (ctx, config) => runWorker(ctx, config, deps),
  };
}

/** The JQL the loop uses when none was configured. */
export function defaultTicketJql(project: string, label: string): string {
  return (
    `project = "${project}" AND labels = "${label}" AND statusCategory != Done ` +
    "ORDER BY updated ASC"
  );
}

async function runLoop(
  ctx: TaskContext,
  config: Config,
  deps: JiraTicketToMrDeps,
): Promise<TaskResult> {
  const connectors = requireConnectorFactory(deps);
  const jira = connectors.jira(ctx, deps.fetch);
  const subjects = requireSubjectTracker(deps);
  const jobs = requireJobRepository(deps);

  const jql = config.jira.jql ?? defaultTicketJql(config.jira.project, config.jira.label);
  const issues = await ctx.step("search-tickets", () =>
    // `updated` is what the fingerprint is, so it has to be requested explicitly.
    jira.searchIssues(jql, {
      limit: TICKET_SCAN_LIMIT,
      fields: ["summary", "status", "updated"],
      signal: ctx.signal,
    }),
  );

  const open = issues.filter((issue) => !isResolved(issue));
  ctx.logger.info(
    { jql, listed: issues.length, open: open.length },
    `matched ${issues.length} ticket(s), ${open.length} still open`,
  );

  let queued = 0;
  let skipped = issues.length - open.length;
  let deferred = 0;
  const notes: string[] = [];

  for (const issue of open) {
    if (ctx.signal.aborted) {
      ctx.logger.warn("shutdown requested, stopping early");
      break;
    }

    const subjectKey = ticketSubjectKey(issue.key);
    const fingerprint = ticketFingerprint(issue.key, issue.fields?.updated);

    // Recorded on every poll whether or not anything is queued: this doubles as
    // the "still labelled, still open" sighting a later sweep needs.
    const { changed } = subjects.observe({
      loopId: ctx.taskId,
      subjectKey,
      fingerprint,
      externalRef: issue.key,
      externalUrl: jira.issueUrl(issue.key),
      metadata: {
        issueKey: issue.key,
        summary: issue.fields?.summary,
        projectId: config.gitlab.projectId,
      },
    });

    if (!changed && !ctx.force) {
      skipped++;
      continue;
    }

    // Bounds new work admitted per tick, not work running — the pool does that.
    if (queued >= ctx.maxItemsPerRun) {
      deferred++;
      continue;
    }

    // Gated or not, the same subject and the same fingerprint. That is what makes a
    // plan awaiting review stop the loop: the worker pool advances the subject when
    // the *plan* job completes, so this version of the ticket counts as handled and
    // no second plan is written on the next tick. Editing the ticket moves the
    // fingerprint and admits new work, which is the same human gesture the dead-job
    // brake below already relies on.
    const enqueue = config.plan.required
      ? {
          kind: PLAN_JIRA_ISSUE_TASK_ID,
          loopId: ctx.taskId,
          subjectKey,
          fingerprint,
          ...(ctx.actor ? { actorId: ctx.actor.id } : {}),
          parentExecutionId: ctx.executionId,
          params: {
            jira: { issueKey: issue.key },
            gitlab: {
              projectId: config.gitlab.projectId,
              ...(config.gitlab.targetBranch
                ? { targetBranch: config.gitlab.targetBranch }
                : {}),
            },
          },
        }
      : {
          kind: JIRA_TICKET_TO_MR_ONE_TASK_ID,
          loopId: ctx.taskId,
          subjectKey,
          fingerprint,
          // So the branch is pushed and the MR opened as whoever owns this loop.
          ...(ctx.actor ? { actorId: ctx.actor.id } : {}),
          parentExecutionId: ctx.executionId,
          params: {
            jira: { ...config.jira, issueKey: issue.key },
            gitlab: config.gitlab,
            commit: config.commit,
          },
        };

    // An attempt that failed every retry at this version of the ticket is not
    // retried hourly. Editing the ticket moves the fingerprint and gets through,
    // which is also the right human gesture: the agent could not do it as written.
    const dead = jobs.deadFor(defaultDedupeKey(enqueue));
    if (dead && !ctx.force) {
      skipped++;
      ctx.logger.warn(
        { issue: issue.key, job: dead.id, err: dead.error },
        `skipped ${issue.key}: job ${dead.id} already failed every attempt at this ` +
          `version of the ticket; edit the ticket or revive the job to try again`,
      );
      notes.push(`skipped ${issue.key}: job ${dead.id} gave up on this version`);
      continue;
    }

    if (ctx.dryRun) {
      notes.push(`dry run: would ${queuedVerb(config)} ${issue.key}`);
      continue;
    }

    const result = jobs.enqueue(enqueue);
    if (!result.enqueued) {
      // Already queued or in flight for this same version — the normal case when
      // the loop ticks while an agent is still working.
      skipped++;
      continue;
    }

    queued++;
    const queuedNote = config.plan.required
      ? `queued a plan for ${issue.key}; nothing changes until somebody approves it`
      : `queued an attempt at ${issue.key}`;
    notes.push(queuedNote);
    ctx.logger.info(
      { issue: issue.key, projectId: config.gitlab.projectId, job: result.job?.id },
      queuedNote,
    );
  }

  if (deferred > 0) {
    ctx.logger.warn(
      { cap: ctx.maxItemsPerRun, deferred },
      `reached the ${ctx.maxItemsPerRun}-item cap; ${deferred} ticket(s) wait for the next run`,
    );
  }

  return {
    itemsSeen: issues.length,
    itemsProcessed: queued,
    itemsSkipped: skipped + deferred,
    details: { jql, queued, skipped, deferred, notes },
  };
}

/**
 * What a gated tick is about to do, in the notes. A gated loop queues a plan for a
 * human to read, and calling that "an attempt at TP-1" would read as a branch about to
 * appear — the opposite of what the gate promises.
 */
function queuedVerb(config: Config): string {
  return config.plan.required ? "queue a plan for" : "queue an attempt at";
}

/** What one job decided about one ticket. */
type TicketAction =
  /** A draft merge request was opened. */
  | "opened"
  /** One already existed from this ticket's branch. */
  | "adopted"
  /** The agent judged the ticket not actionable and said why on the ticket. */
  | "no-change"
  /** Dry run, or the ticket vanished/closed before the job ran. */
  | "skipped";

async function runWorker(
  ctx: TaskContext,
  config: WorkerConfig,
  deps: JiraTicketToMrDeps,
): Promise<TaskResult> {
  const connectors = requireConnectorFactory(deps);
  const jira = connectors.jira(ctx, deps.fetch);
  const gitlab = connectors.gitlab(ctx, deps.fetch);
  const issueKey = config.jira.issueKey;
  const projectId = config.gitlab.projectId;

  const issue = await ctx.step("ticket", () => jira.issueDetail(issueKey, ctx.signal));
  if (!issue) {
    ctx.logger.warn({ issue: issueKey }, `${issueKey} no longer exists; nothing to attempt`);
    return { itemsSeen: 0, itemsProcessed: 0, itemsSkipped: 1, details: { issueKey, action: "skipped" } };
  }
  if (issue.fields?.status?.statusCategory?.key === DONE_CATEGORY) {
    ctx.logger.info(
      { issue: issueKey, status: issue.fields?.status?.name },
      `${issueKey} was resolved before this job ran; leaving it alone`,
    );
    return { itemsSeen: 1, itemsProcessed: 0, itemsSkipped: 1, details: { issueKey, action: "skipped" } };
  }

  // Jira resolves a moved/renamed issue's old key transparently and hands back the
  // issue's *current* key in the body. `issueKey` is whatever was frozen into this
  // job's params when it was enqueued — possibly weeks ago, possibly stale if the
  // ticket was since moved to another project — so everything user-visible from
  // here on (branch, title, labels, comments) is keyed on the live value instead.
  const key = issue.key || issueKey;
  if (key !== issueKey) {
    ctx.logger.warn(
      { queued: issueKey, current: key },
      `${issueKey} is now ${key}; using the current key for the branch, title and labels`,
    );
  }

  const fingerprint = ticketFingerprint(key, issue.fields?.updated);
  const branch = ticketBranchName(key, fingerprint);

  // Step 1: an MR from this branch means a previous attempt finished the part that
  // matters. Every state, not just `opened`: a merge request the developer already
  // merged or closed must not cause a second identical one.
  const existing = await ctx.step("existing-merge-request", () =>
    gitlab.listMergeRequests(projectId, {
      state: "all",
      sourceBranch: branch,
      limit: 1,
      signal: ctx.signal,
    }),
  );
  if (existing[0]) return adopt(ctx, key, existing[0], branch);

  if (ctx.dryRun) {
    ctx.logger.info(
      { issue: key, branch },
      `[dry-run] would attempt ${key} and open a draft merge request from ${branch}`,
    );
    return { itemsSeen: 1, itemsProcessed: 0, itemsSkipped: 1, details: { issueKey: key, branch, action: "skipped" } };
  }

  const targetBranch = await ctx.step("target-branch", async () => {
    if (config.gitlab.targetBranch) return config.gitlab.targetBranch;
    const project = await gitlab.project(projectId, ctx.signal);
    const fallback = project.default_branch;
    if (!fallback) {
      throw new ConfigError(
        `${projectId} reports no default branch; set gitlab.targetBranch explicitly`,
      );
    }
    return fallback;
  });

  // Step 2: the branch exists but no MR does — a previous attempt pushed and died.
  // Its work is on the remote, so the only thing left is to open the merge request.
  const pushed = await ctx.step("existing-branch", async () => {
    const branches = await gitlab.listBranches(projectId, {
      search: branch,
      limit: 20,
      signal: ctx.signal,
    });
    return branches.some((candidate) => candidate.name === branch);
  });

  let agent: TicketAgentResult | undefined;
  if (pushed) {
    ctx.logger.warn(
      { issue: key, branch },
      `${branch} already exists with no merge request; opening one from it rather ` +
        `than running the agent again`,
    );
  } else {
    // Step 3: nothing exists. Do the work.
    await ctx.step("ensure-agent-image", () =>
      (deps.ensureImage ?? ensureAgentImage)(ctx.logger),
    );
    agent = await ctx.step(
      `attempt:${key}`,
      () =>
        (deps.runAgent ?? runTicketAgent)({
          executionId: ctx.executionId,
          project: projectId,
          baseBranch: targetBranch,
          pushBranch: branch,
          token: ctx.secrets.require("GITLAB_TOKEN"),
          ticket: ticketContext(issue, jira.issueUrl(key)),
          // The actor's own identity on the commit when there is one, so `git log`
          // shows work done on a person's behalf rather than by an anonymous bot.
          commitName: ctx.actor?.name ?? config.commit.name,
          commitEmail: ctx.actor?.email ?? config.commit.email,
          ...(ctx.llm.model ? { model: ctx.llm.model } : {}),
          ...(ctx.llm.effort ? { effort: ctx.llm.effort } : {}),
          promptTemplate: ctx.prompts[TICKET_PROMPT_ID],
          signal: ctx.signal,
          logger: ctx.logger,
          ...(ctx.actor ? { actor: ctx.actor } : {}),
        }),
      // The agent is not idempotent and the container refuses to push over the
      // branch a previous attempt left, so a retry inside one job would fail on
      // the push having spent the whole run. Recovery is the next job's business,
      // via the two checks above.
      { retry: NO_RETRY, meta: { issue: key, branch } },
    );

    // No pushed branch means the agent left the working tree clean — either it
    // said so, or it claimed a change and made none. Both are "a human has to look
    // at this ticket", and both are worth saying on the ticket rather than
    // silently. Reported as a *success*, which is what stops it being re-attempted:
    // the worker pool marks the ticket acted on at this version when a job
    // succeeds, and an edited ticket is the signal that another attempt is wanted.
    if (!agent.pushedBranch) {
      if (agent.status === "changed") {
        ctx.logger.warn(
          { issue: key },
          `the agent reported a change for ${key} but left no edits; treating it ` +
            `as no-change`,
        );
      }
      await comment(ctx, jira, key, noChangeComment(agent.summary));
      // Skipped rather than processed: the run's product is a Jira comment, not a
      // merge request, and the counters are what the console reads to decide
      // whether a run did anything. The *status* is still success, which is what
      // marks the ticket acted on at this version — see the comment above.
      return {
        itemsSeen: 1,
        itemsProcessed: 0,
        itemsSkipped: 1,
        details: {
          issueKey: key,
          action: "no-change" satisfies TicketAction,
          summary: agent.summary,
          ...(agent.toolErrors ? { agentErrors: agent.toolErrors } : {}),
        },
      };
    }
  }

  const summary = issue.fields?.summary ?? key;
  const mr = await mutate(
    ctx,
    `open a draft merge request from ${branch} in ${projectId}`,
    () =>
      gitlab.createMergeRequest(projectId, {
        sourceBranch: branch,
        targetBranch,
        title: agent?.title ?? `${key} ${summary}`,
        description: mergeRequestDescription({
          issueKey: key,
          issueUrl: jira.issueUrl(key),
          summary,
          body: agent?.description,
        }),
        draft: true,
        removeSourceBranch: true,
        labels: ticketLabels(key),
        signal: ctx.signal,
      }),
    { issue: key, branch, targetBranch },
  );
  if (!mr) throw new ConfigError("merge request creation was unexpectedly suppressed");

  ctx.logger.info(
    { issue: key, mrIid: mr.iid, webUrl: mr.web_url, branch, commitSha: agent?.commitSha },
    `opened draft !${mr.iid} for ${key}`,
  );

  // The MR exists from here on, which is what makes the remaining two writes
  // best-effort: neither a Jira outage nor a workflow nobody configured should
  // fail a job whose valuable side effect already happened. The next attempt would
  // adopt the MR and stop, so a failure here is not silently retried either —
  // hence the warnings.
  await comment(ctx, jira, key, openedComment(mr, agent?.summary));
  const transitioned = await transition(ctx, jira, key, config.jira.transitionTo);

  return {
    itemsSeen: 1,
    itemsProcessed: 1,
    itemsSkipped: 0,
    details: {
      issueKey: key,
      action: "opened" satisfies TicketAction,
      mrIid: mr.iid,
      mrUrl: mr.web_url,
      branch,
      targetBranch,
      commitSha: agent?.commitSha,
      transitionedTo: transitioned ?? null,
      recovered: pushed,
    },
  };
}

/**
 * Reports a merge request a previous attempt already opened, and stops.
 *
 * A success rather than a failure, and deliberately so: the job's purpose is
 * "there is a draft merge request for this version of this ticket", and there is.
 * Succeeding is also what lets the worker pool mark the ticket acted on, which is
 * what stops the loop queueing the same attempt every hour.
 */
function adopt(
  ctx: TaskContext,
  issueKey: string,
  mr: MergeRequest,
  branch: string,
): TaskResult {
  ctx.logger.info(
    { issue: issueKey, mrIid: mr.iid, state: mr.state, branch },
    `${issueKey} already has !${mr.iid} from ${branch}; nothing to do`,
  );
  return {
    itemsSeen: 1,
    itemsProcessed: 0,
    itemsSkipped: 1,
    details: {
      issueKey,
      action: "adopted" satisfies TicketAction,
      mrIid: mr.iid,
      mrUrl: mr.web_url,
    },
  };
}

/** What the agent is shown about the ticket. */
export function ticketContext(issue: JiraIssueDetail, url: string): TicketContext {
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
 * `Closes` deliberately absent: GitLab closes GitLab issues from that keyword and
 * does nothing with a Jira key, so it would read as a promise nothing keeps. The
 * link and the ticket key are what a reviewer needs, and the key in the branch
 * name is what Jira's own GitLab integration matches on.
 */
export function mergeRequestDescription(args: {
  issueKey: string;
  issueUrl: string;
  summary: string;
  body?: string;
}): string {
  return (
    `Implements [${args.issueKey}](${args.issueUrl}) — ${args.summary}\n\n` +
    (args.body ? `${args.body.trim()}\n\n` : "") +
    "---\n\nOpened as a draft by Talos from an AI attempt at the ticket above. " +
    "Every line of it needs a human review before this is marked ready."
  );
}

function openedComment(mr: MergeRequest, summary?: string) {
  return fitDocument(
    doc(
      paragraph(
        "Talos attempted this ticket and opened a draft merge request. It needs a " +
          "human review before it is marked ready.",
      ),
      linkParagraph(`!${mr.iid} ${mr.title}`, mr.web_url),
      summary ? paragraph(summary) : undefined,
    ),
  );
}

function noChangeComment(summary: string) {
  return fitDocument(
    doc(
      paragraph(
        "Talos looked at this ticket and did not change any code. Its reasoning:",
      ),
      paragraph(summary),
      paragraph(
        "Nothing further will be attempted until the ticket is edited — updating the " +
          "description is what asks for another attempt.",
      ),
    ),
  );
}

/** Posts a comment, and treats a failure as a warning: the MR already exists. */
async function comment(
  ctx: TaskContext,
  jira: JiraGateway,
  issueKey: string,
  body: ReturnType<typeof fitDocument>,
): Promise<void> {
  try {
    await mutate(ctx, `comment on ${issueKey}`, () => jira.addComment(issueKey, body, ctx.signal), {
      issue: issueKey,
    });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.logger.warn(
      { issue: issueKey, err: String(err) },
      `could not comment on ${issueKey}; the merge request is unaffected`,
    );
  }
}

/**
 * Moves the ticket on, if the operator asked for it.
 *
 * A warning and not a failure, and the message lists what the issue does offer:
 * the merge request — the thing this job exists to produce — already exists, and
 * failing the job over a workflow name would retry the whole attempt to fix a
 * status field. `transitionIssueTo` throws with the available names for exactly
 * this log line.
 */
async function transition(
  ctx: TaskContext,
  jira: JiraGateway,
  issueKey: string,
  target?: string,
): Promise<string | undefined> {
  if (!target) return undefined;
  try {
    const applied = await mutate(
      ctx,
      `transition ${issueKey} to '${target}'`,
      () => jira.transitionIssueTo(issueKey, target, ctx.signal),
      { issue: issueKey },
    );
    if (!applied) return undefined;
    ctx.logger.info(
      { issue: issueKey, transition: applied.name, to: applied.to?.name },
      `moved ${issueKey} to ${applied.to?.name ?? applied.name ?? target}`,
    );
    return applied.to?.name ?? applied.name ?? target;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.logger.warn(
      { issue: issueKey, target, err: String(err) },
      `could not move ${issueKey} to '${target}'; the merge request is open either way`,
    );
    return undefined;
  }
}

function requireConnectorFactory(deps: JiraTicketToMrDeps): TaskConnectorFactory {
  if (!deps.connectors) {
    throw new ConfigError(
      `${JIRA_TICKET_TO_MR_TASK_ID} requires connector gateways; the composition root must provide them.`,
    );
  }
  return deps.connectors;
}

function requireSubjectTracker(deps: JiraTicketToMrDeps): SubjectTracker {
  if (!deps.subjects) {
    throw new ConfigError(
      `${JIRA_TICKET_TO_MR_TASK_ID} requires a subject tracker; the composition root must provide one.`,
    );
  }
  return deps.subjects;
}

function requireJobRepository(deps: JiraTicketToMrDeps): JobRepository {
  if (!deps.jobs) {
    throw new ConfigError(
      `${JIRA_TICKET_TO_MR_TASK_ID} requires a job queue; the composition root must provide one.`,
    );
  }
  return deps.jobs;
}
