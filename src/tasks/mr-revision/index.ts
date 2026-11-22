import { z } from "zod";
import type { TaskConnectorFactory } from "../../application/gateways.ts";
import type { FetchLike } from "../../connectors/http.ts";
import { ConfigError } from "../../core/errors.ts";
import { NO_RETRY } from "../../core/retry.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import { ensureAgentImage } from "../../infrastructure/agent/index.ts";
import {
  MR_REVISION_PROMPT_ID,
  runMrRevisionAgent,
  type MrRevisionAgentOptions,
} from "./agent.ts";

const DEFAULT_COMMIT = { name: "Talos", email: "talos@talos.local" };

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(20_000),
});

const ConfigSchema = z.object({
  gitlab: z.object({
    projectId: z.string().min(1),
    mrIid: z.number().int().positive(),
  }),
  instruction: z.string().trim().min(1).max(20_000),
  history: z.array(MessageSchema).max(20).default([]),
  commit: z
    .object({
      name: z.string().min(1).default(DEFAULT_COMMIT.name),
      email: z.email().default(DEFAULT_COMMIT.email),
    })
    .default(DEFAULT_COMMIT),
});

type Config = z.infer<typeof ConfigSchema>;

export const MR_REVISION_ONE_TASK_ID = "gitlab-mr-revision-one";

export interface MrRevisionDeps {
  fetch?: FetchLike;
  connectors?: TaskConnectorFactory;
  ensureImage?: typeof ensureAgentImage;
  runAgent?: (options: MrRevisionAgentOptions) => Promise<Awaited<ReturnType<typeof runMrRevisionAgent>>>;
}

export function createMrRevisionWorkerTask(deps: MrRevisionDeps = {}): Task<Config> {
  return {
    id: MR_REVISION_ONE_TASK_ID,
    name: "GitLab MR revision",
    description:
      "Applies one human-requested revision to an existing merge request in an isolated branch workspace.",
    kind: "job",
    agent: true,
    paramsSchema: ConfigSchema,
    run: (ctx, config) => run(ctx, config, deps),
  };
}

async function run(
  ctx: TaskContext,
  config: Config,
  deps: MrRevisionDeps,
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
        action: "not-open",
        instruction: config.instruction,
        response: `Merge request !${mr.iid} is ${mr.state}; it was not changed.`,
      },
    };
  }
  if (!mr.sha) throw new ConfigError(`MR !${mr.iid} has no head SHA`);

  if (ctx.dryRun) {
    return {
      itemsSeen: 1,
      itemsProcessed: 0,
      itemsSkipped: 1,
      details: {
        mrIid: mr.iid,
        action: "dry-run",
        instruction: config.instruction,
        response: `Dry run: would revise !${mr.iid}.`,
      },
    };
  }

  const sourceProject = mr.source_project_id
    ? await ctx.step("source-project", () => gitlab.project(mr.source_project_id!, ctx.signal))
    : await ctx.step("source-project", () => gitlab.project(projectId, ctx.signal));

  await ctx.step("ensure-agent-image", () =>
    (deps.ensureImage ?? ensureAgentImage)(ctx.logger),
  );
  const result = await ctx.step(
    `revise:${mr.iid}`,
    () =>
      (deps.runAgent ?? runMrRevisionAgent)({
        executionId: ctx.executionId,
        mrIid: mr.iid,
        project: sourceProject.path_with_namespace,
        branch: mr.source_branch,
        targetBranch: mr.target_branch,
        startSha: mr.sha!,
        token: ctx.secrets.require("GITLAB_TOKEN"),
        title: mr.title,
        webUrl: mr.web_url,
        instruction: config.instruction,
        history: config.history,
        commitName: ctx.actor?.name ?? config.commit.name,
        commitEmail: ctx.actor?.email ?? config.commit.email,
        ...(ctx.llm.model ? { model: ctx.llm.model } : {}),
        ...(ctx.llm.effort ? { effort: ctx.llm.effort } : {}),
        promptTemplate: ctx.prompts[MR_REVISION_PROMPT_ID],
        signal: ctx.signal,
        logger: ctx.logger,
        ...(ctx.actor ? { actor: ctx.actor } : {}),
      }),
    // A branch move must restart the whole queue job so the MR and start SHA are
    // fetched again. Retrying only this step would reuse the stale lease.
    { retry: NO_RETRY, meta: { mrIid: mr.iid, startSha: mr.sha } },
  );

  const changed = result.commitSha != null;
  return {
    itemsSeen: 1,
    itemsProcessed: changed ? 1 : 0,
    itemsSkipped: changed ? 0 : 1,
    details: {
      mrIid: mr.iid,
      action: changed ? "revised" : "no-change",
      instruction: config.instruction,
      response: result.response,
      ...(result.commitSha ? { commitSha: result.commitSha } : {}),
      ...(result.toolErrors ? { agentErrors: result.toolErrors } : {}),
    },
  };
}

function requireConnectorFactory(deps: MrRevisionDeps): TaskConnectorFactory {
  if (!deps.connectors) {
    throw new ConfigError(
      `${MR_REVISION_ONE_TASK_ID} requires connector gateways; the composition root must provide them.`,
    );
  }
  return deps.connectors;
}
