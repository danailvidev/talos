import { z } from "zod";
import type {
  AutomationAiTriageRepository,
  AutomationConfigRepository,
  AutomationRepository,
  NotificationRepository,
} from "../../application/ports.ts";
import { ConfigError } from "../../core/errors.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import { ensureAgentImage } from "../../infrastructure/agent/index.ts";
import {
  runAutomationFailureTriageAgent,
  type AutomationFailureTriageContext,
} from "./agent.ts";

export const TRIAGE_AUTOMATION_FAILURE_TASK_ID =
  "triage-automation-failure";

const ConfigSchema = z.object({
  projectId: z.string().min(1),
  pipelineId: z.number().int().positive(),
  scheduleId: z.number().int().nonnegative(),
  signatureKey: z.string().min(1).max(256),
  targetRef: z.string().min(1),
});

type Config = z.infer<typeof ConfigSchema>;

export interface TriageAutomationFailureDeps {
  config?: AutomationConfigRepository;
  automation?: AutomationRepository;
  triage?: AutomationAiTriageRepository;
  notifications?: NotificationRepository;
  ensureImage?: typeof ensureAgentImage;
  runAgent?: typeof runAutomationFailureTriageAgent;
}

export function createTriageAutomationFailureTask(
  deps: TriageAutomationFailureDeps = {},
): Task<Config> {
  return {
    id: TRIAGE_AUTOMATION_FAILURE_TASK_ID,
    name: "AI triage an Automation failure cluster",
    description:
      "Inspects a stored Automation failure cluster and its test repository without changing code.",
    kind: "job",
    agent: true,
    paramsSchema: ConfigSchema,
    run: (ctx, config) => run(ctx, config, deps),
  };
}

async function run(
  ctx: TaskContext,
  params: Config,
  deps: TriageAutomationFailureDeps,
): Promise<TaskResult> {
  if (!deps.config || !deps.automation || !deps.triage) {
    throw new ConfigError("Automation AI triage is not configured.");
  }
  const configured = deps.config.get();
  if (
    !configured ||
    configured.projectId !== params.projectId ||
    !configured.schedules.some(
      (schedule) => schedule.scheduleId === params.scheduleId,
    )
  ) {
    throw new ConfigError(
      "The Automation project or schedule changed before AI triage started.",
    );
  }
  const pipeline = deps.automation.getPipeline(
    params.projectId,
    params.pipelineId,
    { includeFailureDiagnostics: false },
  );
  if (
    !pipeline ||
    pipeline.scheduleId !== params.scheduleId ||
    pipeline.ref !== params.targetRef
  ) {
    throw new ConfigError(
      "The stored Automation pipeline no longer matches the requested project, schedule, or ref.",
    );
  }
  const cluster = deps.automation.getFailureCluster(
    params.projectId,
    params.pipelineId,
    params.signatureKey,
    50,
  );
  if (
    !cluster ||
    cluster.projectId !== params.projectId ||
    cluster.scheduleId !== params.scheduleId
  ) {
    throw new ConfigError(
      `Failure cluster '${params.signatureKey}' is not part of Automation pipeline ${params.pipelineId}.`,
    );
  }

  const context: AutomationFailureTriageContext = {
    projectId: cluster.projectId,
    pipelineId: cluster.pipelineId,
    scheduleId: cluster.scheduleId,
    targetRef: params.targetRef,
    signatureKey: cluster.signatureKey,
    normalizedSignature: cluster.title,
    affectedTests: cluster.members.map((member) => ({
      name: member.name,
      ...(member.classname ? { classname: member.classname } : {}),
      ...(member.testFile ? { testFile: member.testFile } : {}),
      status: member.status,
    })),
    affectedJobs: [
      ...new Map(
        cluster.members
          .filter((member) => member.jobId != null)
          .map((member) => [
            member.jobId!,
            {
              id: member.jobId!,
              ...(member.jobName ? { name: member.jobName } : {}),
            },
          ]),
      ).values(),
    ],
    representative: {
      ...(cluster.representative.systemOutput
        ? { systemOutput: cluster.representative.systemOutput.slice(0, 20_000) }
        : {}),
      ...(cluster.representative.stackTrace
        ? { stackTrace: cluster.representative.stackTrace.slice(0, 20_000) }
        : {}),
    },
    screenshots: cluster.members.flatMap((member) =>
      member.attachmentJobId != null && member.attachmentPath
        ? [
            {
              ...(member.attachmentName
                ? { name: member.attachmentName }
                : {}),
              artifactPath: member.attachmentPath,
              jobId: member.attachmentJobId,
              testName: member.name,
            },
          ]
        : [],
    ),
  };

  await ctx.step("ensure-agent-image", () =>
    (deps.ensureImage ?? ensureAgentImage)(ctx.logger),
  );
  const result = await ctx.step("triage-automation-failure", () =>
    (deps.runAgent ?? runAutomationFailureTriageAgent)({
      executionId: ctx.executionId,
      project: params.projectId,
      targetRef: params.targetRef,
      token: ctx.secrets.require("GITLAB_TOKEN"),
      cluster: context,
      ...(ctx.llm.model ? { model: ctx.llm.model } : {}),
      ...(ctx.llm.effort ? { effort: ctx.llm.effort } : {}),
      signal: ctx.signal,
      logger: ctx.logger,
      ...(ctx.actor ? { actor: ctx.actor } : {}),
    }),
  );

  deps.triage.record({
    projectId: cluster.projectId,
    scheduleId: cluster.scheduleId,
    signatureKey: cluster.signatureKey,
    signature: cluster.title,
    verdict: result.verdict,
    confidence: result.confidence,
    rationale: result.rationale,
    recommendation: result.recommendation,
    taskRunId: ctx.executionId,
  });
  deps.notifications?.create({
    kind: TRIAGE_AUTOMATION_FAILURE_TASK_ID,
    title: `Automation triage: ${result.verdict}`,
    body: `${cluster.title} — ${result.recommendation}`,
    link: `/automation?pipelineId=${cluster.pipelineId}`,
    taskRunId: ctx.executionId,
  });

  return {
    itemsSeen: 1,
    itemsProcessed: 1,
    itemsSkipped: 0,
    notifiedIndividually: true,
    details: {
      projectId: cluster.projectId,
      pipelineId: cluster.pipelineId,
      scheduleId: cluster.scheduleId,
      signatureKey: cluster.signatureKey,
      action: "triaged",
      verdict: result.verdict,
      confidence: result.confidence,
      summary: result.rationale,
      recommendation: result.recommendation,
      ...(result.toolErrors ? { agentErrors: result.toolErrors } : {}),
    },
  };
}
