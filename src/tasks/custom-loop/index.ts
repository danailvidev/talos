import { z } from "zod";
import type { TaskConnectorFactory } from "../../application/gateways.ts";
import { LlmEffortSchema, LlmModelSchema } from "../../config/schema.ts";
import { ConfigError } from "../../core/errors.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import type { JobRepository } from "../../application/ports.ts";
import {
  AGENT_PROVIDERS,
  ensureAgentImage,
  runAgentJob,
  type WritePolicy,
} from "../../infrastructure/agent/index.ts";
import { buildCustomLoopPrompt } from "./prompt.ts";

export const CUSTOM_LOOP_TASK_ID = "custom-loop";
export const CUSTOM_LOOP_TARGET_TASK_ID = "custom-loop-target";

/**
 * What the loop's agent may do with what it concludes, in the operator's words
 * rather than the engine's. Maps onto `WritePolicy` in `writePolicyFor`, one
 * level removed on purpose: "Read-only" is a promise about the loop, while
 * `"none"` is a fact about which tools one container gets, and the loop form
 * should not have to know the second to state the first.
 *
 * `read-only` is the default everywhere it is absent, including on rows written
 * before this field existed. A loop that fires unattended on a cron and pushes
 * is a thing an operator should have to ask for.
 */
export const CUSTOM_LOOP_PERMISSIONS = ["read-only", "push", "push-mr"] as const;

export type CustomLoopPermission = (typeof CUSTOM_LOOP_PERMISSIONS)[number];

const RepositoryTargetSchema = z.object({
  /** `group/project` — the agent clones by path, so a numeric id is refused. */
  projectId: z.string().min(1),
  branch: z.string().min(1),
});

export const CustomLoopParamsSchema = z.object({
  /**
   * The operator's own instructions. The whole point of the loop, and the reason
   * the bare `custom-loop` definition is not runnable as itself: there is no
   * sensible default for "what should the agent do", so the error says where the
   * prompt is supposed to come from instead of reporting a missing string.
   */
  prompt: z
    .string({
      error:
        "needs the instructions the agent should run. A custom loop is created " +
        "from the Loops page, which is where the prompt is typed — the " +
        "'custom-loop' definition itself has nothing to run.",
    })
    .min(1, { error: "cannot be empty — this is what the agent is asked to do." }),
  /**
   * Where to run, one agent per entry, capped by `ctx.maxItemsPerRun`. Empty
   * means run once in a scratch workspace with nothing checked out — see
   * `runAgentJob`'s optional `workspace`.
   */
  repositories: z.array(RepositoryTargetSchema).default([]),
  /**
   * Which locally signed-in agent account the operator picked. Recorded for
   * attribution and forward compatibility rather than dispatch: only Claude runs
   * today (`infrastructure/agent`), and anything else is refused up front rather
   * than silently running as Claude.
   */
  agent: z
    .object({
      provider: z.enum(AGENT_PROVIDERS).default("claude"),
      /** The account email as detected on the host, for the run log. */
      account: z.string().optional(),
    })
    .default({ provider: "claude" }),
  /** Overrides the instance-wide LLM defaults for this loop only. */
  llm: z
    .object({
      model: LlmModelSchema.optional(),
      effort: LlmEffortSchema.optional(),
    })
    .default({}),
  permissions: z.enum(CUSTOM_LOOP_PERMISSIONS).default("read-only"),
});

export type CustomLoopParams = z.infer<typeof CustomLoopParamsSchema>;

/**
 * What the agent is asked to end its reply with. Loose on purpose: the prompt is
 * the operator's, not ours, so a reply that ignores the JSON request is accepted
 * as prose rather than failed — see `unstructuredOutcome`.
 */
const OutcomeSchema = z.object({
  summary: z.string(),
  /** What it actually did or found, one line each. */
  actions: z.array(z.string()).default([]),
});

type Outcome = z.infer<typeof OutcomeSchema>;

function unstructuredOutcome(rawText: string): Outcome {
  const text = rawText.trim();
  return {
    summary: text === "" ? "The agent finished without saying anything." : text,
    actions: [],
  };
}

export interface CustomLoopDeps {
  connectors?: TaskConnectorFactory;
  jobs?: JobRepository;
}

/**
 * A loop the operator writes themselves: a prompt, optionally some repositories
 * and branches to run it against, a schedule, and how much the agent is allowed
 * to do with its conclusions.
 *
 * Every other loop in this codebase encodes a specific job — file the CI
 * failure, review the merge request, follow up on feedback. This one encodes
 * none, which is what makes it useful: the shape "run these instructions against
 * this branch on this schedule" covers the long tail of team-specific chores
 * that will never be worth their own task file, and it is the only loop a user
 * can create without a code change.
 *
 * It is deliberately thin. There is no watermark and no subject ledger, because
 * an arbitrary prompt has no notion of an "item" to have already handled — a
 * tick runs the instructions again, which is what a person asking for a daily
 * audit means by daily. Loops that need dedupe are the ones written as real
 * tasks.
 */
export function createCustomLoopTask(deps: CustomLoopDeps = {}): Task<CustomLoopParams> {
  return {
    id: CUSTOM_LOOP_TASK_ID,
    name: "Custom loop",
    description:
      "Your own instructions, run by an agent against the repositories and branches you pick, on your schedule.",
    kind: "loop",
    instantiable: true,
    paramsSchema: CustomLoopParamsSchema,
    run: (ctx, params) => run(ctx, params, deps),
  };
}

const CustomLoopTargetParamsSchema = z.object({
  parentExecutionId: z.string().min(1),
  loop: CustomLoopParamsSchema,
  target: RepositoryTargetSchema.optional(),
});

export function createCustomLoopTargetTask(
  deps: CustomLoopDeps = {},
): Task<z.infer<typeof CustomLoopTargetParamsSchema>> {
  return {
    id: CUSTOM_LOOP_TARGET_TASK_ID,
    name: "Custom loop target",
    description: "Runs one durable repository/scratch target admitted by a custom loop.",
    kind: "job",
    agent: true,
    paramsSchema: CustomLoopTargetParamsSchema,
    async run(ctx, params) {
      await ctx.step("ensure-agent-image", () => ensureAgentImage(ctx.logger));
      const permission = params.loop.permissions;
      const outcome = await runOne(ctx, params.loop, deps, params.target, writePolicyFor(permission));
      return {
        itemsSeen: 1,
        itemsProcessed: 1,
        itemsSkipped: 0,
        details: { permissions: permission, target: targetLabel(params.target), outcome },
      };
    },
  };
}

async function run(
  ctx: TaskContext,
  params: CustomLoopParams,
  deps: CustomLoopDeps,
): Promise<TaskResult> {
  if (params.agent.provider !== "claude") {
    throw new ConfigError(
      `This loop is set to run on ${params.agent.provider}, which talos cannot drive yet — ` +
        "the agent container ships the Claude Code CLI only. Change the loop's agent to Claude.",
    );
  }

  const permission = params.permissions;
  const jobs = deps.jobs;
  if (!jobs) throw new ConfigError("custom-loop requires the durable job queue");

  if (!ctx.force && jobs.hasActiveChildren(ctx.taskId, CUSTOM_LOOP_TARGET_TASK_ID)) {
    ctx.logger.info("the previous custom-loop invocation still has targets pending; skipping overlap");
    return { itemsSeen: 0, itemsProcessed: 0, itemsSkipped: 1, details: { action: "overlap-skipped" } };
  }

  // One entry means one agent run; no repositories at all still means one run,
  // in a scratch workspace. `[undefined]` rather than a branch further down: the
  // body below is identical either way apart from the workspace it builds.
  const all = params.repositories.length > 0 ? params.repositories : [undefined];
  const targets = all.slice(0, ctx.maxItemsPerRun);
  if (targets.length < all.length) {
    ctx.logger.warn(
      { repositories: all.length, cap: ctx.maxItemsPerRun },
      `capped at ${ctx.maxItemsPerRun} repositories; the rest wait for the next run`,
    );
  }

  ctx.logger.info(
    {
      repositories: params.repositories.length,
      permissions: permission,
      model: params.llm.model ?? ctx.llm.model,
      effort: params.llm.effort ?? ctx.llm.effort,
      account: params.agent.account,
    },
    `custom loop running against ${targets.length} target(s) with ${permission} permissions`,
  );

  let admitted = 0;
  for (const target of targets) {
    const label = targetLabel(target);
    const result = jobs.enqueue({
      kind: CUSTOM_LOOP_TARGET_TASK_ID,
      loopId: ctx.taskId,
      actorId: ctx.actor?.id,
      parentExecutionId: ctx.executionId,
      dedupeKey: `${ctx.executionId}:${CUSTOM_LOOP_TARGET_TASK_ID}:${label}`,
      params: { parentExecutionId: ctx.executionId, loop: params, ...(target ? { target } : {}) },
      maxAttempts: 3,
    });
    if (result.enqueued) admitted += 1;
  }

  return {
    itemsSeen: all.length,
    itemsProcessed: admitted,
    itemsSkipped: all.length - targets.length,
    details: { action: "queued", permissions: permission, admitted, parentExecutionId: ctx.executionId },
  };
}

function targetLabel(target: { projectId: string; branch: string } | undefined): string {
  return target ? `${target.projectId}@${target.branch}` : "scratch";
}

async function runOne(
  ctx: TaskContext,
  params: CustomLoopParams,
  deps: CustomLoopDeps,
  target: { projectId: string; branch: string } | undefined,
  writePolicy: WritePolicy,
): Promise<Record<string, unknown>> {
  const label = target ? `${target.projectId}@${target.branch}` : "scratch";
  const writes = writePolicy !== "none";

  // Only resolved when something is going to be pushed: the policies lease their
  // push against the head the job started from, so this is a safety input, not a
  // display value, and a read-only run should not pay for it.
  const startSha =
    target && writes ? await ctx.step(`head:${label}`, () => branchHead(ctx, deps, target)) : undefined;

  const pushBranch =
    writePolicy === "push+mr" && target
      ? `talos/custom-loop-${ctx.executionId.slice(0, 8)}`
      : undefined;

  const { output, commitSha, pushedBranch } = await ctx.step(`agent:${label}`, () =>
    runAgentJob({
      executionId: ctx.executionId,
      label,
      ...(target
        ? {
            workspace: {
              project: projectPathOrThrow(target.projectId),
              branch: target.branch,
              ...(startSha ? { startSha } : {}),
              token: ctx.secrets.require("GITLAB_TOKEN"),
            },
          }
        : {}),
      prompt: buildCustomLoopPrompt(params.prompt, target),
      output: OutcomeSchema,
      onUnstructured: unstructuredOutcome,
      writePolicy,
      ...(writes
        ? {
            commit: {
              name: ctx.actor?.name ?? "Talos",
              email: ctx.actor?.email ?? "talos@localhost",
              message: `Talos custom loop: ${firstLine(params.prompt)}`.slice(0, 200),
              ...(pushBranch ? { branch: pushBranch } : {}),
            },
          }
        : {}),
      ...(params.llm.model ?? ctx.llm.model ? { model: params.llm.model ?? ctx.llm.model } : {}),
      ...(params.llm.effort ?? ctx.llm.effort
        ? { effort: params.llm.effort ?? ctx.llm.effort }
        : {}),
      signal: ctx.signal,
      logger: ctx.logger,
      ...(ctx.actor ? { actor: ctx.actor } : {}),
    }),
  );

  ctx.logger.info({ target: label, actions: output.actions.length }, output.summary);

  // Nothing pushed means nothing to open a merge request from — an agent that
  // decided no change was needed is a success, not a missing MR.
  const mr =
    writePolicy === "push+mr" && target && pushedBranch
      ? await ctx.step(`merge-request:${label}`, () =>
          openMergeRequest(ctx, deps, target, pushedBranch, params.prompt),
        )
      : undefined;

  return {
    summary: output.summary,
    ...(output.actions.length > 0 ? { actions: output.actions } : {}),
    ...(commitSha ? { commitSha } : {}),
    ...(pushedBranch ? { pushedBranch } : {}),
    ...(mr ? { mergeRequest: mr } : {}),
  };
}

/** The sha a push will be leased against. */
async function branchHead(
  ctx: TaskContext,
  deps: CustomLoopDeps,
  target: { projectId: string; branch: string },
): Promise<string> {
  const gitlab = requireConnectorFactory(deps).gitlab(ctx);
  const branches = await gitlab.listBranches(target.projectId, {
    search: target.branch,
    signal: ctx.signal,
  });
  const match = branches.find((branch) => branch.name === target.branch);
  if (!match) {
    throw new ConfigError(
      `Branch '${target.branch}' does not exist in ${target.projectId} any more.`,
    );
  }
  const sha = match.commit?.id;
  if (!sha) {
    throw new ConfigError(
      `GitLab did not report a head commit for ${target.projectId}@${target.branch}, ` +
        "so a push cannot be leased against it safely.",
    );
  }
  return sha;
}

async function openMergeRequest(
  ctx: TaskContext,
  deps: CustomLoopDeps,
  target: { projectId: string; branch: string },
  sourceBranch: string,
  prompt: string,
): Promise<{ iid: number; url: string }> {
  const gitlab = requireConnectorFactory(deps).gitlab(ctx);
  const mr = await gitlab.createMergeRequest(target.projectId, {
    sourceBranch,
    targetBranch: target.branch,
    title: firstLine(prompt).slice(0, 200),
    description:
      `Opened by a Talos custom loop. The instructions it was given:\n\n> ${prompt.replace(/\n/g, "\n> ")}`,
    draft: true,
    removeSourceBranch: true,
    signal: ctx.signal,
  });
  ctx.logger.info({ mr: mr.iid, url: mr.web_url }, `opened draft merge request !${mr.iid}`);
  return { iid: mr.iid, url: mr.web_url };
}

function writePolicyFor(permission: CustomLoopPermission): WritePolicy {
  if (permission === "push") return "push";
  if (permission === "push-mr") return "push+mr";
  return "none";
}

/** The prompt's first line, which is as close to a title as a free-form prompt gets. */
function firstLine(prompt: string): string {
  return prompt.trim().split("\n")[0]?.trim() || "custom loop";
}

function projectPathOrThrow(projectId: string): string {
  if (/^\d+$/.test(projectId)) {
    throw new ConfigError(
      `A custom loop checks the repository out inside a container, so it needs a ` +
        `'group/project' path; '${projectId}' is a numeric id, which only the REST API accepts.`,
    );
  }
  return projectId;
}

function requireConnectorFactory(deps: CustomLoopDeps): TaskConnectorFactory {
  if (!deps.connectors) {
    throw new ConfigError(
      "custom-loop requires connector gateways; the composition root must provide " +
        "them before the task can run.",
    );
  }
  return deps.connectors;
}
