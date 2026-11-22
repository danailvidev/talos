import { z } from "zod";
import type {
  GitLabGateway,
  TaskConnectorFactory,
} from "../../application/gateways.ts";
import type { JobRepository } from "../../application/ports.ts";
import type { FetchLike } from "../../connectors/http.ts";
import {
  isDraftMergeRequest,
  mergeRequestProjectPath,
  type MergeRequest,
} from "../../connectors/gitlab/types.ts";
import { ConfigError } from "../../core/errors.ts";
import { describeError } from "../../core/executor.ts";
import { defaultDedupeKey } from "../../core/job.ts";
import { NO_RETRY } from "../../core/retry.ts";
import { mutate } from "../../core/step.ts";
import type { SubjectTracker } from "../../core/subject.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../infrastructure/agent/run.ts";
import { ensureAgentImage } from "../../infrastructure/agent/index.ts";
import {
  FOLLOW_UP_PROMPT_ID,
  runFollowUpAgent,
  type FollowUpAgentResult,
} from "./agent.ts";
import {
  discussionEventId,
  pendingDiscussions,
  pendingFingerprint,
  type PendingDiscussion,
} from "./discussions.ts";

export const MR_FOLLOW_UP_CRON = "0 * * * *";

// The default has to satisfy `z.email()` itself. It did not: 'talos@localhost'
// has no dot in its domain, so every job the loop queued with default commit
// settings died on params validation before the agent started. Git accepts either
// form; Zod does not.
const DEFAULT_COMMIT = { name: "Talos", email: "talos@talos.local" };

const CommitSchema = z
  .object({
    name: z.string().min(1).default(DEFAULT_COMMIT.name),
    email: z.email().default(DEFAULT_COMMIT.email),
  })
  .default(DEFAULT_COMMIT);

const ConfigSchema = z.object({
  gitlab: z
    .object({
      projectId: z.string().min(1).optional(),
      group: z.string().min(1).optional(),
    })
    .optional(),
  commit: CommitSchema,
});

const WorkerConfigSchema = z.object({
  gitlab: z.object({
    projectId: z.string().min(1),
    mrIid: z.number().int().positive(),
  }),
  commit: CommitSchema,
});

type Config = z.infer<typeof ConfigSchema>;
type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export const MR_FOLLOW_UP_ONE_TASK_ID = "gitlab-mr-follow-up-one";

/**
 * Threads one job will answer.
 *
 * Deliberately a constant and not `ctx.maxItemsPerRun`. The pool runs a handler
 * with that cap set to 1 — correctly, since a job *is* one item — and this task's
 * item is the merge request, not the thread. Slicing threads by it would answer
 * one of three, then spend another agent container on the next one an hour later.
 * The bound that matters here is the agent's context window, so it is sized for
 * that.
 */
const MAX_DISCUSSIONS_PER_JOB = 20;

/**
 * How long a claimed discussion can sit unreported before it is treated as
 * abandoned rather than in-flight.
 *
 * `claimEvent` only reopens a *failed* claim — a crash that kills this process
 * (an app restart, an OOM) skips the `catch` block below, so `failEvent` never
 * runs and the claim would otherwise stay 'claimed' forever. The time window
 * is only the backstop for a claim whose holder might still be the live agent.
 * A new job reclaims sooner when no other follow-up job is leased for the
 * merge request: the retry after a restart was reporting false success,
 * because every discussion looked already claimed and returning zero processed
 * with no error is indistinguishable from "nothing needed doing". Set
 * comfortably above `DEFAULT_AGENT_TIMEOUT_MS` (30 min) so a merely slow run
 * is never mistaken for an abandoned one while that other job is still leased.
 */
const STALE_CLAIM_MS = DEFAULT_AGENT_TIMEOUT_MS + 15 * 60_000;

/** Namespaced, and distinct from the review loop's key for the same merge request. */
export function feedbackSubjectKey(projectId: string, mrIid: number): string {
  return `gitlab:mr-feedback:${projectId}!${mrIid}`;
}

export interface MrFollowUpDeps {
  fetch?: FetchLike;
  connectors?: TaskConnectorFactory;
  subjects?: SubjectTracker;
  jobs?: JobRepository;
  ensureImage?: typeof ensureAgentImage;
  runAgent?: typeof runFollowUpAgent;
}

export function createMrFollowUpTask(deps: MrFollowUpDeps = {}): Task<Config> {
  return {
    id: "gitlab-mr-follow-up",
    name: "GitLab MR follow-up",
    description:
      "Checks your open authored merge requests for unresolved reviewer feedback, pushes a safe branch fix when appropriate, and replies in-thread.",
    kind: "loop",
    instantiable: true,
    defaultTrigger: { type: "cron", expression: MR_FOLLOW_UP_CRON },
    paramsSchema: ConfigSchema,
    run: (ctx, config) => runLoop(ctx, config, deps),
  };
}

export const mrFollowUpTask = createMrFollowUpTask();

export function createMrFollowUpWorkerTask(
  deps: MrFollowUpDeps = {},
): Task<WorkerConfig> {
  return {
    id: MR_FOLLOW_UP_ONE_TASK_ID,
    name: "GitLab MR feedback task",
    description:
      "Handles unresolved feedback for one authored merge request in an isolated branch workspace. Queued by the MR follow-up loop rather than run directly.",
    // Was an instantiable task the loop created one of per merge request. Now a
    // queue handler: one job, one MR. The instance rows those spawns left behind
    // are skipped by `loadInstances`, which only registers instantiable
    // definitions, so they stop appearing as tasks without needing to be deleted.
    kind: "job",
    agent: true,
    paramsSchema: WorkerConfigSchema,
    run: (ctx, config) => runWorker(ctx, config, deps),
  };
}

async function runLoop(
  ctx: TaskContext,
  config: Config,
  deps: MrFollowUpDeps,
): Promise<TaskResult> {
  const gitlab = requireConnectorFactory(deps).gitlab(ctx, deps.fetch);
  const subjects = requireSubjectTracker(deps);
  const jobs = requireJobRepository(deps);
  const currentUser = await ctx.step("current-user", () => gitlab.currentUser(ctx.signal));
  const mergeRequests = await ctx.step("list-authored-merge-requests", () =>
    gitlab.listMergeRequestsAuthoredByMe({ state: "opened", limit: 100, signal: ctx.signal }),
  );
  const candidates = mergeRequests.filter(
    (mr) => !isDraftMergeRequest(mr) && matchesFilter(mr, config.gitlab),
  );

  let seen = 0;
  let queued = 0;
  let skipped = 0;
  let deferred = 0;
  const notes: string[] = [];

  for (const mr of candidates) {
    if (ctx.signal.aborted) break;
    const projectId = mergeRequestProjectPath(mr);
    if (!projectId || !mr.sha) {
      skipped++;
      notes.push(`skipped !${mr.iid}: missing project path or head SHA`);
      continue;
    }

    const discussions = await ctx.step(`discussions:${mr.iid}`, () =>
      gitlab.listMergeRequestDiscussions(projectId, mr.iid, {
        limit: 100,
        signal: ctx.signal,
      }),
    );
    const pending = pendingDiscussions(discussions);
    seen += pending.length;
    if (pending.length === 0) continue;

    const subjectKey = feedbackSubjectKey(projectId, mr.iid);
    const fingerprint = pendingFingerprint(pending);
    const { changed } = subjects.observe({
      loopId: ctx.taskId,
      subjectKey,
      fingerprint,
      externalRef: `!${mr.iid}`,
      externalUrl: mr.web_url,
      metadata: {
        projectId,
        mrIid: mr.iid,
        title: mr.title,
        pending: pending.length,
      },
    });

    if (!changed && !ctx.force) {
      skipped += pending.length;
      continue;
    }

    // Bounds new work admitted per tick, not work running — the pool does that.
    if (queued >= ctx.maxItemsPerRun) {
      deferred += pending.length;
      continue;
    }

    const enqueue = {
      kind: MR_FOLLOW_UP_ONE_TASK_ID,
      loopId: ctx.taskId,
      subjectKey,
      fingerprint,
      // So the agent pushes as the loop's owner rather than as the shared bot.
      ...(ctx.actor ? { actorId: ctx.actor.id } : {}),
      parentExecutionId: ctx.executionId,
      params: {
        gitlab: { projectId, mrIid: mr.iid },
        commit: config.commit,
      },
    };

    // Same brake as the review loop: an agent that failed every attempt on this
    // exact set of threads is not retried hourly. New feedback changes the
    // fingerprint and gets through.
    const dead = jobs.deadFor(defaultDedupeKey(enqueue));
    if (dead && !ctx.force) {
      skipped += pending.length;
      ctx.logger.warn(
        { mrIid: mr.iid, job: dead.id, err: dead.error },
        `skipped !${mr.iid}: job ${dead.id} already failed every attempt on this ` +
          `feedback; new review comments or reviving the job will retry it`,
      );
      notes.push(`skipped !${mr.iid}: job ${dead.id} gave up on this feedback`);
      continue;
    }

    if (ctx.dryRun) {
      notes.push(
        `dry run: would queue follow-up for ${pending.length} discussion(s) on !${mr.iid}`,
      );
      continue;
    }

    const result = jobs.enqueue(enqueue);
    if (!result.enqueued) {
      // Already queued or in flight for this same feedback — the normal case
      // when the loop ticks while an agent is still working.
      skipped += pending.length;
      continue;
    }

    queued++;
    notes.push(`queued follow-up for !${mr.iid} (${pending.length} discussion(s))`);
    ctx.logger.info(
      { mrIid: mr.iid, projectId, pending: pending.length, job: result.job?.id },
      `queued follow-up for !${mr.iid} (${pending.length} discussion(s))`,
    );
  }

  if (deferred > 0) {
    ctx.logger.warn(
      { cap: ctx.maxItemsPerRun, deferred },
      `reached the ${ctx.maxItemsPerRun}-item cap; ${deferred} discussion(s) wait for the next run`,
    );
  }

  return {
    itemsSeen: seen,
    itemsProcessed: queued,
    itemsSkipped: skipped + deferred,
    details: { mergeRequests: candidates.length, queued, skipped, deferred, notes },
  };
}

async function runWorker(
  ctx: TaskContext,
  config: WorkerConfig,
  deps: MrFollowUpDeps,
): Promise<TaskResult> {
  const gitlab = requireConnectorFactory(deps).gitlab(ctx, deps.fetch);
  const projectId = config.gitlab.projectId;
  const mr = await ctx.step("merge-request", () =>
    gitlab.mergeRequest(projectId, config.gitlab.mrIid, ctx.signal),
  );
  const discussions = await ctx.step(`discussions:${mr.iid}`, () =>
    gitlab.listMergeRequestDiscussions(projectId, mr.iid, {
      limit: 100,
      signal: ctx.signal,
    }),
  );
  const pending = pendingDiscussions(discussions);
  // Every no-op below records an `action` and a `summary`. A job that returns in
  // a second with an empty result reads as a silent failure to whoever pressed
  // the button, even when doing nothing was the right answer.
  if (pending.length === 0) {
    return {
      itemsSeen: 0,
      itemsProcessed: 0,
      itemsSkipped: 0,
      details: {
        mrIid: mr.iid,
        action: "nothing-pending",
        summary: `No unresolved reviewer discussions on !${mr.iid} to follow up on.`,
      },
    };
  }
  const inScope = pending.slice(0, MAX_DISCUSSIONS_PER_JOB);
  if (ctx.dryRun) {
    return {
      itemsSeen: pending.length,
      itemsProcessed: inScope.length,
      itemsSkipped: pending.length - inScope.length,
      details: {
        mrIid: mr.iid,
        action: "dry-run",
        summary: `Dry run: would answer ${inScope.length} discussion(s) on !${mr.iid}.`,
      },
    };
  }

  // A claim a previous attempt never resolved — reopened so this attempt can
  // retry it instead of skipping it as already handled. See `STALE_CLAIM_MS`.
  const stale = await ctx.state.findStaleClaims(
    ctx.taskId,
    new Date(Date.now() - STALE_CLAIM_MS),
  );
  for (const event of stale) {
    await ctx.state.failEvent(
      ctx.taskId,
      event.externalId,
      "stale claim reclaimed: a previous attempt never reported completion or failure",
    );
  }
  // The restart case: the run that claimed these threads is already gone, but
  // the claim is younger than `STALE_CLAIM_MS`. Leaving it blocks every later
  // job with "already claimed" while the GitLab threads stay unresolved.
  if (!followUpClaimHeldByLiveJob(deps.jobs, ctx.executionId, projectId, mr.iid)) {
    let released = 0;
    for (const discussion of inScope) {
      const eventId = discussionEventId(projectId, mr.iid, discussion);
      const event = await ctx.state.getEvent(ctx.taskId, eventId);
      if (event?.status !== "claimed") continue;
      await ctx.state.failEvent(
        ctx.taskId,
        eventId,
        "claim released: no follow-up job is still running for this merge request",
      );
      released++;
    }
    if (released > 0) {
      ctx.logger.warn(
        { mrIid: mr.iid, released },
        `released ${released} discussion claim(s) on !${mr.iid}: no other follow-up job is running`,
      );
    }
  }

  const claimed: { discussion: PendingDiscussion; eventId: string }[] = [];
  for (const discussion of inScope) {
    const eventId = discussionEventId(projectId, mr.iid, discussion);
    if (await ctx.state.claimEvent(ctx.taskId, eventId, "gitlab-mr-discussion")) {
      claimed.push({ discussion, eventId });
    }
  }
  if (claimed.length === 0) {
    return {
      itemsSeen: pending.length,
      itemsProcessed: 0,
      itemsSkipped: pending.length,
      details: {
        mrIid: mr.iid,
        action: "already-claimed",
        summary:
          `All ${pending.length} pending discussion(s) on !${mr.iid} are already claimed ` +
          "by another run, so this one had nothing left to answer.",
      },
    };
  }

  try {
    await ctx.step("ensure-agent-image", () =>
      (deps.ensureImage ?? ensureAgentImage)(ctx.logger),
    );
    const result = await ctx.step(
      `follow-up:${mr.iid}`,
      () =>
        handleMr({
          ctx,
          config,
          deps,
          projectId,
          mr,
          claimed: claimed.map((item) => item.discussion),
        }),
      { retry: NO_RETRY, meta: { mrIid: mr.iid, discussions: claimed.length } },
    );
    validateReplies(result, claimed.map((item) => item.discussion));
    await postReplies({ ctx, gitlab, projectId, mr, claimed, result });
    return {
      itemsSeen: pending.length,
      itemsProcessed: claimed.length,
      itemsSkipped: pending.length - claimed.length,
      details: {
        mrIid: mr.iid,
        action: "replied",
        commitSha: result.commitSha,
        discussions: claimed.length,
        summary: `Replied to ${claimed.length} discussion(s) on !${mr.iid}.`,
      },
    };
  } catch (err) {
    for (const item of claimed) {
      await ctx.state.failEvent(ctx.taskId, item.eventId, describeError(err));
    }
    throw err;
  }
}

async function handleMr(args: {
  ctx: TaskContext;
  config: WorkerConfig;
  deps: MrFollowUpDeps;
  projectId: string;
  mr: MergeRequest;
  claimed: PendingDiscussion[];
}): Promise<FollowUpAgentResult> {
  if (!args.mr.sha) throw new ConfigError(`MR !${args.mr.iid} has no head SHA`);
  const gitlab = requireConnectorFactory(args.deps).gitlab(args.ctx, args.deps.fetch);
  // The fork case: an MR authored from a fork has to be pushed to the fork's own
  // path, not the target project's.
  const sourceProject = args.mr.source_project_id
    ? await gitlab.project(args.mr.source_project_id, args.ctx.signal)
    : await gitlab.project(args.projectId, args.ctx.signal);

  return await (args.deps.runAgent ?? runFollowUpAgent)({
    executionId: args.ctx.executionId,
    mrIid: args.mr.iid,
    project: sourceProject.path_with_namespace,
    branch: args.mr.source_branch,
    startSha: args.mr.sha,
    token: args.ctx.secrets.require("GITLAB_TOKEN"),
    context: {
      mergeRequest: {
        iid: args.mr.iid,
        title: args.mr.title,
        sourceBranch: args.mr.source_branch,
        targetBranch: args.mr.target_branch,
        webUrl: args.mr.web_url,
      },
      discussions: args.claimed,
    },
    // The actor's own identity on the commit when there is one: a developer
    // reading `git log` on their branch should see a commit made on their behalf,
    // not one from a bot they have to go and look up. Falls back to the
    // configured bot identity for a loop nobody owns.
    commitName: args.ctx.actor?.name ?? args.config.commit.name,
    commitEmail: args.ctx.actor?.email ?? args.config.commit.email,
    ...(args.ctx.llm.model ? { model: args.ctx.llm.model } : {}),
    ...(args.ctx.llm.effort ? { effort: args.ctx.llm.effort } : {}),
    promptTemplate: args.ctx.prompts[FOLLOW_UP_PROMPT_ID],
    signal: args.ctx.signal,
    logger: args.ctx.logger,
    ...(args.ctx.actor ? { actor: args.ctx.actor } : {}),
  });
}

async function postReplies(args: {
  ctx: TaskContext;
  gitlab: GitLabGateway;
  projectId: string;
  mr: MergeRequest;
  claimed: { discussion: PendingDiscussion; eventId: string }[];
  result: FollowUpAgentResult;
}): Promise<void> {
  for (const item of args.claimed) {
    const reply = args.result.replies.find(
      (candidate) =>
        candidate.discussionId === item.discussion.discussionId &&
        candidate.noteId === item.discussion.noteId,
    )!;
    const fixed = reply.fixed && args.result.commitSha != null;
    const body = fixed
      ? `${reply.body}\n\nFixed in \`${args.result.commitSha!.slice(0, 12)}\`.`
      : reply.body;
    const posted = await mutate(
      args.ctx,
      `reply to discussion ${item.discussion.discussionId} on MR !${args.mr.iid}`,
      () =>
        args.gitlab.createMergeRequestDiscussionNote(
          args.projectId,
          args.mr.iid,
          item.discussion.discussionId,
          body,
          args.ctx.signal,
        ),
      { mrIid: args.mr.iid, discussionId: item.discussion.discussionId },
    );
    if (!posted) throw new ConfigError("discussion reply was unexpectedly suppressed");
    if (fixed && item.discussion.resolvableNoteId != null) {
      const resolved = await mutate(
        args.ctx,
        `resolve discussion ${item.discussion.discussionId} on MR !${args.mr.iid}`,
        () =>
          args.gitlab.resolveMergeRequestDiscussion(
            args.projectId,
            args.mr.iid,
            item.discussion.discussionId,
            item.discussion.resolvableNoteId!,
            args.ctx.signal,
          ),
        { mrIid: args.mr.iid, discussionId: item.discussion.discussionId },
      );
      if (!resolved) throw new ConfigError("discussion resolve was unexpectedly suppressed");
    }
    await args.ctx.state.completeEvent(args.ctx.taskId, item.eventId, {
      projectId: args.projectId,
      mrIid: args.mr.iid,
      discussionId: item.discussion.discussionId,
      noteId: posted.id,
      commitSha: args.result.commitSha,
      resolved: fixed && item.discussion.resolvableNoteId != null,
    });
  }
}

function validateReplies(result: FollowUpAgentResult, discussions: PendingDiscussion[]): void {
  const expected = new Set(discussions.map((item) => `${item.discussionId}:${item.noteId}`));
  const actual = new Set(result.replies.map((item) => `${item.discussionId}:${item.noteId}`));
  if (
    expected.size !== actual.size ||
    [...expected].some((key) => !actual.has(key)) ||
    result.replies.length !== actual.size
  ) {
    throw new ConfigError("the follow-up agent did not return exactly one reply per discussion");
  }
}

/**
 * True when some other leased follow-up job is still the one that may be
 * answering this merge request. Queued jobs have not claimed yet, and this
 * job's own row is leased under `executionId`.
 *
 * Absent `jobs` keeps the time-based backstop only. Releasing every fresh
 * claim with no queue to ask would let two direct runs of the handler reply
 * twice.
 */
function followUpClaimHeldByLiveJob(
  jobs: JobRepository | undefined,
  executionId: string,
  projectId: string,
  mrIid: number,
): boolean {
  if (!jobs) return true;
  return jobs.activeForKind(MR_FOLLOW_UP_ONE_TASK_ID).some(
    (job) =>
      job.status === "leased" &&
      job.executionId !== executionId &&
      sameMergeRequest(job.params, projectId, mrIid),
  );
}

function sameMergeRequest(params: unknown, projectId: string, mrIid: number): boolean {
  if (!params || typeof params !== "object") return false;
  const gitlab = (params as { gitlab?: { projectId?: unknown; mrIid?: unknown } }).gitlab;
  return gitlab?.projectId === projectId && gitlab?.mrIid === mrIid;
}

function matchesFilter(
  mr: MergeRequest,
  filter: Config["gitlab"],
): boolean {
  if (!filter) return true;
  const projectId = mergeRequestProjectPath(mr);
  if (!projectId) return false;
  if (filter.projectId && projectId !== filter.projectId) return false;
  if (filter.group) {
    const group = filter.group.replace(/\/+$/, "");
    if (projectId !== group && !projectId.startsWith(`${group}/`)) return false;
  }
  return true;
}

function requireConnectorFactory(deps: MrFollowUpDeps): TaskConnectorFactory {
  if (!deps.connectors) {
    throw new ConfigError(
      "gitlab-mr-follow-up requires connector gateways; the composition root must provide them.",
    );
  }
  return deps.connectors;
}

function requireSubjectTracker(deps: MrFollowUpDeps): SubjectTracker {
  if (!deps.subjects) {
    throw new ConfigError(
      "gitlab-mr-follow-up requires a subject tracker; the composition root must provide one.",
    );
  }
  return deps.subjects;
}

function requireJobRepository(deps: MrFollowUpDeps): JobRepository {
  if (!deps.jobs) {
    throw new ConfigError(
      "gitlab-mr-follow-up requires a job queue; the composition root must provide one.",
    );
  }
  return deps.jobs;
}
