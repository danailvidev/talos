import { z } from "zod";
import type {
  DatadogAiTriageRepository,
  DatadogIssueRepository,
  NotificationRepository,
} from "../../application/ports.ts";
import { ConfigError } from "../../core/errors.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import { ensureAgentImage } from "../../infrastructure/agent/index.ts";
import {
  runDatadogAiTriageAgent,
  type DatadogAiTriageContext,
} from "./agent.ts";

export const TRIAGE_DATADOG_ERROR_TASK_ID = "triage-datadog-error";

const ConfigSchema = z.object({
  source: z.literal("datadog").default("datadog"),
  issueId: z.string().min(1),
  gitlab: z.object({
    projectId: z.string().min(1),
    targetBranch: z.string().min(1),
  }),
});

type Config = z.infer<typeof ConfigSchema>;

export interface TriageDatadogErrorDeps {
  issues?: DatadogIssueRepository;
  triage?: DatadogAiTriageRepository;
  notifications?: NotificationRepository;
  ensureImage?: typeof ensureAgentImage;
  runAgent?: typeof runDatadogAiTriageAgent;
}

export function createTriageDatadogErrorTask(
  deps: TriageDatadogErrorDeps = {},
): Task<Config> {
  return {
    id: TRIAGE_DATADOG_ERROR_TASK_ID,
    name: "AI triage a Datadog error",
    description:
      "Inspects a production error and its service repository without changing code, then classifies the likely root cause.",
    kind: "job",
    agent: true,
    paramsSchema: ConfigSchema,
    run: (ctx, config) => run(ctx, config, deps),
  };
}

async function run(
  ctx: TaskContext,
  config: Config,
  deps: TriageDatadogErrorDeps,
): Promise<TaskResult> {
  const issue = deps.issues?.get(config.issueId);
  if (!issue) throw new ConfigError(`No Datadog issue ${config.issueId}.`);
  if (!deps.triage) {
    throw new ConfigError("Datadog AI triage storage is not configured.");
  }

  const error: DatadogAiTriageContext = {
    issueId: issue.id,
    title: issue.problemTitle ?? issue.title,
    signature: issue.signature,
    ...(issue.service ? { service: issue.service } : {}),
    ...(issue.sampleMessage ? { sampleMessage: issue.sampleMessage } : {}),
    ...(issue.sampleStack ? { sampleStack: issue.sampleStack.slice(0, 20_000) } : {}),
    ...(issue.env ? { env: issue.env } : {}),
    ...(issue.source ? { source: issue.source } : {}),
  };

  await ctx.step("ensure-agent-image", () =>
    (deps.ensureImage ?? ensureAgentImage)(ctx.logger),
  );
  const result = await ctx.step("triage-error", () =>
    (deps.runAgent ?? runDatadogAiTriageAgent)({
      executionId: ctx.executionId,
      project: config.gitlab.projectId,
      baseBranch: config.gitlab.targetBranch,
      token: ctx.secrets.require("GITLAB_TOKEN"),
      error,
      ...(ctx.llm.model ? { model: ctx.llm.model } : {}),
      ...(ctx.llm.effort ? { effort: ctx.llm.effort } : {}),
      signal: ctx.signal,
      logger: ctx.logger,
      ...(ctx.actor ? { actor: ctx.actor } : {}),
    }),
  );

  deps.triage.record({
    issueId: issue.id,
    fingerprint: issue.fingerprint,
    verdict: result.verdict,
    confidence: result.confidence,
    rationale: result.rationale,
    recommendation: result.recommendation,
    taskRunId: ctx.executionId,
  });
  deps.notifications?.create({
    kind: TRIAGE_DATADOG_ERROR_TASK_ID,
    title: `Datadog triage: ${result.verdict}`,
    body: `${issue.problemTitle ?? issue.title} — ${result.recommendation}`,
    link: "/datadog?tab=activity",
    taskRunId: ctx.executionId,
  });

  return {
    itemsSeen: 1,
    itemsProcessed: 1,
    itemsSkipped: 0,
    notifiedIndividually: true,
    details: {
      source: "datadog",
      issueId: issue.id,
      service: issue.service,
      action: "triaged",
      verdict: result.verdict,
      confidence: result.confidence,
      summary: result.rationale,
      recommendation: result.recommendation,
      ...(result.toolErrors ? { agentErrors: result.toolErrors } : {}),
    },
  };
}
