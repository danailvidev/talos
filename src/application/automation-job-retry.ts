import type { GitLabGateway } from "./gateways.ts";
import { automationPipelineOutcome } from "./automation-pipeline-outcome.ts";
import type {
  AutomationAutoRetryConfig,
  AutomationPipelineJob,
  AutomationPipelineSnapshot,
  AutomationRepository,
} from "./ports.ts";
import { describeError } from "../core/errors.ts";
import { NO_RETRY } from "../core/retry.ts";
import { mutate } from "../core/step.ts";
import type { TaskContext } from "../core/task.ts";

export interface AutomationJobRetryResult {
  considered: boolean;
  claimed: boolean;
  jobsSelected: number;
  jobsAccepted: number;
  jobsFailed: number;
}

export function automationRetryCandidates(
  snapshot: AutomationPipelineSnapshot,
  config: AutomationAutoRetryConfig,
): AutomationPipelineJob[] {
  if (!config.enabled || automationPipelineOutcome(snapshot) !== "test-failed") {
    return [];
  }
  const failedTestJobs = new Set(
    snapshot.failedTests.flatMap((test) =>
      test.jobId == null ? [] : [test.jobId],
    ),
  );
  return snapshot.jobs
    .filter((job) => {
      if (job.status !== "failed") return false;
      if (job.failureReason === "runner_system_failure") return false;
      const reportFailed =
        (job.report?.failedCount ?? 0) + (job.report?.errorCount ?? 0) > 0;
      return failedTestJobs.has(job.jobId) || reportFailed;
    })
    .sort((left, right) => left.jobId - right.jobId)
    .slice(0, config.maxJobsPerPipeline);
}

/**
 * Executes one durable, at-most-once retry wave. The claim is persisted before
 * GitLab is called; an ambiguous process crash therefore favors no duplicate
 * external write over a second retry wave.
 */
export async function maybeRetryAutomationJobs(input: {
  ctx: TaskContext;
  gitlab: GitLabGateway;
  automation: AutomationRepository;
  snapshot: AutomationPipelineSnapshot;
  config: AutomationAutoRetryConfig;
  now?: () => Date;
}): Promise<AutomationJobRetryResult> {
  const jobs = automationRetryCandidates(input.snapshot, input.config);
  const considered =
    input.config.enabled &&
    automationPipelineOutcome(input.snapshot) === "test-failed";
  if (jobs.length === 0) {
    return {
      considered,
      claimed: false,
      jobsSelected: 0,
      jobsAccepted: 0,
      jobsFailed: 0,
    };
  }
  if (input.ctx.dryRun) {
    input.ctx.logger.info(
      {
        pipelineId: input.snapshot.pipelineId,
        jobs: jobs.map((job) => job.jobId),
      },
      "[dry-run] would auto-retry failed Automation test jobs",
    );
    return {
      considered: true,
      claimed: false,
      jobsSelected: jobs.length,
      jobsAccepted: 0,
      jobsFailed: 0,
    };
  }

  const now = input.now ?? (() => new Date());
  const claimed = input.automation.claimJobRetryWave({
    projectId: input.snapshot.projectId,
    pipelineId: input.snapshot.pipelineId,
    scheduleId: input.snapshot.scheduleId,
    executionId: input.ctx.executionId,
    jobs: jobs.map((job) => ({ jobId: job.jobId, name: job.name })),
    now: now(),
  });
  if (!claimed) {
    return {
      considered: true,
      claimed: false,
      jobsSelected: jobs.length,
      jobsAccepted: 0,
      jobsFailed: 0,
    };
  }

  let accepted = 0;
  const errors: string[] = [];
  for (const job of jobs) {
    try {
      const retried = await input.ctx.step(
        `auto-retry-job-${job.jobId}`,
        async () => {
          const result = await mutate(
            input.ctx,
            `retry GitLab job ${job.jobId}`,
            () =>
              input.gitlab.retryJob(
                input.snapshot.projectId,
                job.jobId,
                input.ctx.signal,
              ),
            {
              pipelineId: input.snapshot.pipelineId,
              scheduleId: input.snapshot.scheduleId,
            },
          );
          if (!result) throw new Error("Auto-retry was unexpectedly suppressed.");
          return result;
        },
        { retry: NO_RETRY },
      );
      accepted += 1;
      input.automation.recordJobRetryAttemptResult({
        projectId: input.snapshot.projectId,
        pipelineId: input.snapshot.pipelineId,
        sourceJobId: job.jobId,
        retryJobId: retried.id,
        retryJobUrl: retried.web_url,
        now: now(),
      });
    } catch (error) {
      const message = describeError(error);
      errors.push(`${job.name}: ${message}`);
      input.automation.recordJobRetryAttemptResult({
        projectId: input.snapshot.projectId,
        pipelineId: input.snapshot.pipelineId,
        sourceJobId: job.jobId,
        error: message,
        now: now(),
      });
      input.ctx.logger.warn(
        {
          pipelineId: input.snapshot.pipelineId,
          jobId: job.jobId,
          err: error,
        },
        "could not auto-retry Automation test job",
      );
    }
  }
  const failed = jobs.length - accepted;
  input.automation.completeJobRetryWave({
    projectId: input.snapshot.projectId,
    pipelineId: input.snapshot.pipelineId,
    state:
      accepted === jobs.length
        ? "complete"
        : accepted === 0
          ? "failed"
          : "partial",
    ...(errors.length > 0 ? { error: errors.join("\n") } : {}),
    now: now(),
  });
  return {
    considered: true,
    claimed: true,
    jobsSelected: jobs.length,
    jobsAccepted: accepted,
    jobsFailed: failed,
  };
}
