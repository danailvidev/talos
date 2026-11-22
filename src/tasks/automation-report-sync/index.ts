import { z } from "zod";

import type { TaskConnectorFactory } from "../../application/gateways.ts";
import { maybeRetryAutomationJobs } from "../../application/automation-job-retry.ts";
import type {
  AutomationConfigRepository,
  AutomationPipelineJob,
  AutomationPipelineSnapshot,
  AutomationRepository,
  AutomationTestReportCounts,
  AutomationTestSuite,
} from "../../application/ports.ts";
import type {
  Job,
  PipelineTestReport,
  PipelineTestReportSummary,
} from "../../connectors/gitlab/types.ts";
import {
  ConfigError,
  ConnectorError,
  describeError,
} from "../../core/errors.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import {
  AUTOMATION_REPORT_VERSION,
  failureSignature,
  safeAttachment,
  safeTestFile,
} from "./failure-details.ts";

export const AUTOMATION_REPORT_SYNC_TASK_ID = "automation-report-sync";
export const AUTOMATION_REPORT_SYNC_DEFAULT_CRON = "*/10 * * * *";
export const AUTOMATION_REPORT_SYNC_DEFAULT_MAX_ITEMS = 100;

const INITIAL_BACKFILL_DAYS = 30;
const RETENTION_DAYS = 180;
const MAX_DISCOVERY_PIPELINES = 2_000;
const ParamsSchema = z.object({}).strict();
const TERMINAL_PIPELINE_STATUSES = new Set([
  "success",
  "failed",
  "canceled",
  "skipped",
]);

type Params = z.infer<typeof ParamsSchema>;

interface PipelineCandidate {
  id: number;
  status: string;
  ref: string;
  sha: string;
  webUrl: string;
  createdAt?: Date;
  updatedAt: Date;
}

export interface AutomationReportSyncDeps {
  connectors?: TaskConnectorFactory;
  automationConfig?: AutomationConfigRepository;
  automation?: AutomationRepository;
}

export function createAutomationReportSyncTask(
  deps: AutomationReportSyncDeps = {},
): Task<Params> {
  return {
    id: AUTOMATION_REPORT_SYNC_TASK_ID,
    name: "Automation report sync",
    description:
      "Synchronizes configured GitLab scheduled pipelines, jobs, and test reports.",
    kind: "loop",
    defaultTrigger: {
      type: "cron",
      expression: AUTOMATION_REPORT_SYNC_DEFAULT_CRON,
    },
    paramsSchema: ParamsSchema,
    run: (ctx) => run(ctx, deps),
  };
}

async function run(
  ctx: TaskContext,
  deps: AutomationReportSyncDeps,
): Promise<TaskResult> {
  const configStore = requireConfig(deps);
  const automation = requireAutomation(deps);
  const config = configStore.get();
  if (!config) {
    throw new ConfigError(
      "Automation report sync requires an instance Automation configuration.",
    );
  }
  if (config.schedules.length === 0) {
    throw new ConfigError(
      "Automation report sync requires at least one configured GitLab schedule.",
    );
  }

  const gitlab = requireConnectors(deps).gitlab(ctx);
  const now = new Date();
  // Every configured schedule must get a chance to produce a card on its first
  // sync. A single shared budget let the first schedule's 30-day backfill consume
  // all ten default items and left every later schedule at "No data".
  const budgets = scheduleBudgets(
    Math.max(ctx.maxItemsPerRun, config.schedules.length),
    config.schedules.length,
  );
  let seen = 0;
  let processed = 0;
  let skipped = 0;
  let failures = 0;
  let schedulesSynced = 0;
  let retryPipelinesClaimed = 0;
  let retryJobsAccepted = 0;
  let retryJobsFailed = 0;

  for (const [scheduleIndex, configured] of config.schedules.entries()) {
    const scheduleId = configured.scheduleId;
    try {
      const detail = await ctx.step(`schedule-${scheduleId}`, () =>
        gitlab.schedule(config.projectId, scheduleId, ctx.signal),
      );
      const previous = automation
        .listSchedules(config.projectId)
        .find((schedule) => schedule.scheduleId === scheduleId);
      automation.upsertSchedule({
        projectId: config.projectId,
        scheduleId,
        description: detail.description,
        ref: detail.ref,
        ...(detail.cron != null ? { cron: detail.cron } : {}),
        ...(detail.cron_timezone != null
          ? { cronTimezone: detail.cron_timezone }
          : {}),
        ...(detail.next_run_at ? { nextRunAt: detail.next_run_at } : {}),
        active: detail.active ?? false,
        // This is not advanced until the complete bounded scan below succeeds.
        syncedAt: previous?.syncedAt ?? new Date(0),
      });

      // Re-scan the bounded history window while backfill is incomplete. This
      // lets us store the newest pipeline first without advancing a derived
      // high-water mark past older, not-yet-imported pipelines.
      const updatedAfter = new Date(
        now.getTime() - INITIAL_BACKFILL_DAYS * 86_400_000,
      );
      const discovered = await ctx.step(`pipelines-${scheduleId}`, () =>
        gitlab.listSchedulePipelines(config.projectId, scheduleId, {
          updatedAfter,
          updatedBefore: now,
          limit: MAX_DISCOVERY_PIPELINES,
          signal: ctx.signal,
        }),
      );
      const discoveredCandidates = discovered
        // The schedule-scoped endpoint should only return scheduled pipelines.
        // Keep the source check explicit so merge-request and push pipelines can
        // never enter Automation if GitLab returns an unexpected row.
        .filter((pipeline) => pipeline.source === "schedule")
        .map((pipeline) => ({
          id: pipeline.id,
          status: pipeline.status,
          ref: pipeline.ref,
          sha: pipeline.sha,
          webUrl: pipeline.web_url,
          ...(pipeline.created_at ? { createdAt: pipeline.created_at } : {}),
          updatedAt: pipeline.updated_at,
        }))
        .sort(compareCandidates);
      const stored = new Map(
        automation
          .listPipelines({
            projectId: config.projectId,
            scheduleId,
            from: updatedAfter,
          })
          .map((pipeline) => [pipeline.pipelineId, pipeline]),
      );
      const newCandidates = discoveredCandidates.filter((pipeline) => {
        const existing = stored.get(pipeline.id);
        return (
          !existing ||
          pipeline.updatedAt.getTime() > existing.updatedAt.getTime() ||
          pipeline.status !== existing.status
        );
      });

      // Pending and failed collections are retried even after they age beyond
      // the tiny tie-safe discovery overlap.
      const retryCandidates = automation
        .listPipelines({
          projectId: config.projectId,
          scheduleId,
          reportStates: ["pending", "error"],
          limit: MAX_DISCOVERY_PIPELINES,
        })
        .map(candidateFromSnapshot)
        .sort(compareCandidates);
      const outdatedCandidates = automation
        .listPipelines({
          projectId: config.projectId,
          scheduleId,
          reportStates: ["complete"],
          reportVersionBelow: AUTOMATION_REPORT_VERSION,
          limit: MAX_DISCOVERY_PIPELINES,
        })
        .map(candidateFromSnapshot)
        .sort(compareCandidates);
      const newIds = new Set(newCandidates.map((pipeline) => pipeline.id));
      const retryIds = new Set(retryCandidates.map((pipeline) => pipeline.id));
      const candidates = prioritizeLatest([
        ...newCandidates,
        ...retryCandidates.filter((pipeline) => !newIds.has(pipeline.id)),
        ...outdatedCandidates.filter(
          (pipeline) => !newIds.has(pipeline.id) && !retryIds.has(pipeline.id),
        ),
      ], discoveredCandidates.at(-1)?.id);

      seen += candidates.length;
      const selected = candidates.slice(0, budgets[scheduleIndex]);
      skipped += candidates.length - selected.length;
      for (const candidate of selected) {
        const collected = await collectPipeline(
          ctx,
          gitlab,
          automation,
          config.projectId,
          scheduleId,
          candidate,
        );
        automation.recordPipeline(collected.snapshot);
        if (configured.autoRetry?.enabled) {
          const retry = await maybeRetryAutomationJobs({
            ctx,
            gitlab,
            automation,
            snapshot: collected.snapshot,
            config: configured.autoRetry,
          });
          if (retry.claimed) retryPipelinesClaimed += 1;
          retryJobsAccepted += retry.jobsAccepted;
          retryJobsFailed += retry.jobsFailed;
        }
        processed += 1;
        if (collected.failed) failures += 1;
      }

      automation.markScheduleSynced(config.projectId, scheduleId, now);
      schedulesSynced += 1;
    } catch (err) {
      failures += 1;
      ctx.logger.warn(
        { projectId: config.projectId, scheduleId, err },
        "could not synchronize Automation schedule",
      );
    }
  }

  const pruned = automation.prune(
    new Date(now.getTime() - RETENTION_DAYS * 86_400_000),
  );
  return {
    itemsSeen: seen,
    itemsProcessed: processed,
    itemsSkipped: skipped,
    itemsFailed: failures,
    details: {
      projectId: config.projectId,
      schedulesConfigured: config.schedules.length,
      schedulesSynced,
      pipelinesPruned: pruned,
      autoRetry: {
        pipelinesClaimed: retryPipelinesClaimed,
        jobsAccepted: retryJobsAccepted,
        jobsFailed: retryJobsFailed,
      },
    },
  };
}

async function collectPipeline(
  ctx: TaskContext,
  gitlab: ReturnType<TaskConnectorFactory["gitlab"]>,
  automation: AutomationRepository,
  projectId: string,
  scheduleId: number,
  candidate: PipelineCandidate,
): Promise<{ snapshot: AutomationPipelineSnapshot; failed: boolean }> {
  let failed = false;
  let detail:
    | Awaited<ReturnType<typeof gitlab.pipeline>>
    | undefined;
  try {
    detail = await ctx.step(`pipeline-${candidate.id}`, () =>
      gitlab.pipeline(projectId, candidate.id, ctx.signal),
    );
  } catch (err) {
    failed = true;
    logCollectionError(ctx, candidate.id, "pipeline detail", err);
  }

  let jobs: Job[] = [];
  try {
    jobs = await ctx.step(`jobs-${candidate.id}`, () =>
      gitlab.listJobs(projectId, candidate.id, ctx.signal),
    );
  } catch (err) {
    failed = true;
    logCollectionError(ctx, candidate.id, "pipeline jobs", err);
  }

  const status = detail?.status ?? candidate.status;
  let reportState: AutomationPipelineSnapshot["reportState"] =
    failed ? "error" : "pending";
  let report: AutomationTestReportCounts | undefined;
  let suites: AutomationTestSuite[] = [];
  let failedTests: AutomationPipelineSnapshot["failedTests"] = [];
  let mappedJobs = jobs.map(mapJob);

  if (TERMINAL_PIPELINE_STATUSES.has(status)) {
    try {
      const summary = await ctx.step(`report-summary-${candidate.id}`, () =>
        gitlab.pipelineTestReportSummary(projectId, candidate.id, ctx.signal),
      );
      report = countsFromSummary(summary);
      suites = suitesFromSummary(summary);
      mappedJobs = attachJobReports(mappedJobs, suites);
      reportState = failed ? "error" : "complete";

      if (summary.total.failed > 0 || summary.total.error > 0) {
        try {
          const full = await ctx.step(`report-${candidate.id}`, () =>
            gitlab.pipelineTestReport(projectId, candidate.id, ctx.signal),
          );
          failedTests = failedCases(
            full,
            suites,
            mappedJobs,
            detail?.web_url ?? candidate.webUrl,
          );
        } catch (err) {
          failed = true;
          reportState = "error";
          logCollectionError(ctx, candidate.id, "full test report", err);
        }
      }
    } catch (err) {
      if (isNotFound(err) && !failed) {
        reportState = "missing";
      } else {
        failed = true;
        reportState = "error";
        logCollectionError(ctx, candidate.id, "test report summary", err);
      }
    }
  }

  const existing = automation.getPipeline(projectId, candidate.id);
  const snapshot: AutomationPipelineSnapshot = {
    projectId,
    pipelineId: candidate.id,
    scheduleId,
    status,
    ref: detail?.ref ?? candidate.ref,
    sha: detail?.sha ?? candidate.sha,
    webUrl: detail?.web_url ?? candidate.webUrl,
    ...(detail?.created_at ?? candidate.createdAt
      ? { createdAt: detail?.created_at ?? candidate.createdAt }
      : {}),
    updatedAt: candidate.updatedAt,
    ...(detail?.started_at
      ? { startedAt: detail.started_at }
      : existing?.startedAt
        ? { startedAt: existing.startedAt }
        : {}),
    ...(detail?.finished_at
      ? { finishedAt: detail.finished_at }
      : existing?.finishedAt
        ? { finishedAt: existing.finishedAt }
        : {}),
    ...(detail?.duration != null
      ? { duration: detail.duration }
      : existing?.duration != null
        ? { duration: existing.duration }
        : {}),
    reportState,
    reportVersion: AUTOMATION_REPORT_VERSION,
    ...(report ? { report } : {}),
    jobs: mappedJobs,
    suites,
    failedTests,
  };
  return { snapshot, failed };
}

function countsFromSummary(
  summary: PipelineTestReportSummary,
): AutomationTestReportCounts {
  return {
    totalTime: summary.total.time,
    totalCount: summary.total.count,
    successCount: summary.total.success,
    failedCount: summary.total.failed,
    skippedCount: summary.total.skipped,
    errorCount: summary.total.error,
    ...(summary.total.suite_error != null
      ? { suiteError: summary.total.suite_error }
      : {}),
  };
}

function suitesFromSummary(
  summary: PipelineTestReportSummary,
): AutomationTestSuite[] {
  return summary.test_suites.map((suite, index) => ({
    index,
    name: suite.name,
    buildIds: suite.build_ids,
    totalTime: suite.total_time,
    totalCount: suite.total_count,
    successCount: suite.success_count,
    failedCount: suite.failed_count,
    skippedCount: suite.skipped_count,
    errorCount: suite.error_count,
    ...(suite.suite_error != null ? { suiteError: suite.suite_error } : {}),
  }));
}

function mapJob(job: Job): AutomationPipelineJob {
  return {
    jobId: job.id,
    name: job.name,
    stage: job.stage,
    status: job.status,
    ...(job.failure_reason != null
      ? { failureReason: job.failure_reason }
      : {}),
    allowFailure: job.allow_failure ?? false,
    webUrl: job.web_url,
    ...(job.duration != null ? { duration: job.duration } : {}),
    ...(job.created_at ? { createdAt: job.created_at } : {}),
    ...(job.started_at ? { startedAt: job.started_at } : {}),
    ...(job.finished_at ? { finishedAt: job.finished_at } : {}),
  };
}

function attachJobReports(
  jobs: AutomationPipelineJob[],
  suites: AutomationTestSuite[],
): AutomationPipelineJob[] {
  const byJob = new Map<number, AutomationTestReportCounts>();
  for (const suite of suites) {
    for (const jobId of suite.buildIds) {
      byJob.set(jobId, addCounts(byJob.get(jobId), suite));
    }
  }
  return jobs.map((job) => {
    const report = byJob.get(job.jobId);
    return report ? { ...job, report } : job;
  });
}

function addCounts(
  current: AutomationTestReportCounts | undefined,
  next: AutomationTestReportCounts,
): AutomationTestReportCounts {
  if (!current) {
    return {
      totalTime: next.totalTime,
      totalCount: next.totalCount,
      successCount: next.successCount,
      failedCount: next.failedCount,
      skippedCount: next.skippedCount,
      errorCount: next.errorCount,
      ...(next.suiteError ? { suiteError: next.suiteError } : {}),
    };
  }
  const errors = [current.suiteError, next.suiteError].filter(
    (value): value is string => Boolean(value),
  );
  return {
    totalTime: current.totalTime + next.totalTime,
    totalCount: current.totalCount + next.totalCount,
    successCount: current.successCount + next.successCount,
    failedCount: current.failedCount + next.failedCount,
    skippedCount: current.skippedCount + next.skippedCount,
    errorCount: current.errorCount + next.errorCount,
    ...(errors.length > 0 ? { suiteError: [...new Set(errors)].join("\n") } : {}),
  };
}

function failedCases(
  report: PipelineTestReport,
  suites: AutomationTestSuite[],
  jobs: AutomationPipelineJob[],
  pipelineWebUrl: string,
): AutomationPipelineSnapshot["failedTests"] {
  const jobIds = new Set(jobs.map((job) => job.jobId));
  const used = new Set<number>();
  const result: AutomationPipelineSnapshot["failedTests"] = [];

  for (const [fullIndex, fullSuite] of report.test_suites.entries()) {
    let suite = suites[fullIndex];
    if (!suite || used.has(suite.index) || suite.name !== fullSuite.name) {
      suite = suites.find(
        (candidate) =>
          !used.has(candidate.index) && candidate.name === fullSuite.name,
      );
    }
    if (!suite) continue;
    used.add(suite.index);
    const matchingJobs = suite.buildIds.filter((id) => jobIds.has(id));
    const jobId = matchingJobs.length === 1 ? matchingJobs[0] : undefined;

    for (const [caseIndex, testCase] of fullSuite.test_cases.entries()) {
      if (testCase.status !== "failed" && testCase.status !== "error") continue;
      const attachment = safeAttachment(
        testCase.attachment_url,
        pipelineWebUrl,
        suite.buildIds,
      );
      const signature = failureSignature(testCase);
      const testFile = safeTestFile(testCase.file);
      result.push({
        suiteIndex: suite.index,
        caseIndex,
        ...(jobId != null ? { jobId } : {}),
        status: testCase.status,
        name: testCase.name,
        ...(testCase.classname != null
          ? { classname: testCase.classname }
          : {}),
        executionTime: testCase.execution_time,
        ...(testCase.system_output != null
          ? { systemOutput: testCase.system_output }
          : {}),
        ...(testCase.stack_trace != null
          ? { stackTrace: testCase.stack_trace }
          : {}),
        ...(testFile ? { testFile } : {}),
        ...(attachment
          ? {
              attachmentJobId: attachment.jobId,
              attachmentPath: attachment.path,
              attachmentName: attachment.name,
            }
          : {}),
        signatureKey: signature.key,
        signatureTitle: signature.title,
      });
    }
  }
  return result;
}

function candidateFromSnapshot(
  snapshot: AutomationPipelineSnapshot,
): PipelineCandidate {
  return {
    id: snapshot.pipelineId,
    status: snapshot.status,
    ref: snapshot.ref,
    sha: snapshot.sha,
    webUrl: snapshot.webUrl,
    ...(snapshot.createdAt ? { createdAt: snapshot.createdAt } : {}),
    updatedAt: snapshot.updatedAt,
  };
}

function compareCandidates(a: PipelineCandidate, b: PipelineCandidate): number {
  return a.updatedAt.getTime() - b.updatedAt.getTime() || a.id - b.id;
}

function prioritizeLatest(
  candidates: PipelineCandidate[],
  latestPipelineId: number | undefined,
): PipelineCandidate[] {
  if (latestPipelineId == null) return candidates;
  const latest = candidates.find((candidate) => candidate.id === latestPipelineId);
  return latest
    ? [latest, ...candidates.filter((candidate) => candidate.id !== latestPipelineId)]
    : candidates;
}

function scheduleBudgets(total: number, schedules: number): number[] {
  if (schedules <= 0) return [];
  const base = Math.floor(total / schedules);
  const remainder = total % schedules;
  return Array.from(
    { length: schedules },
    (_, index) => base + (index < remainder ? 1 : 0),
  );
}

function isNotFound(err: unknown): boolean {
  return err instanceof ConnectorError && err.status === 404;
}

function logCollectionError(
  ctx: TaskContext,
  pipelineId: number,
  part: string,
  err: unknown,
): void {
  ctx.logger.warn(
    { pipelineId, part, error: describeError(err) },
    `could not collect Automation ${part}`,
  );
}

function requireConnectors(
  deps: AutomationReportSyncDeps,
): TaskConnectorFactory {
  if (!deps.connectors) {
    throw new ConfigError(
      `${AUTOMATION_REPORT_SYNC_TASK_ID} requires GitLab connectors.`,
    );
  }
  return deps.connectors;
}

function requireConfig(
  deps: AutomationReportSyncDeps,
): AutomationConfigRepository {
  if (!deps.automationConfig) {
    throw new ConfigError(
      `${AUTOMATION_REPORT_SYNC_TASK_ID} requires Automation configuration storage.`,
    );
  }
  return deps.automationConfig;
}

function requireAutomation(
  deps: AutomationReportSyncDeps,
): AutomationRepository {
  if (!deps.automation) {
    throw new ConfigError(
      `${AUTOMATION_REPORT_SYNC_TASK_ID} requires Automation report storage.`,
    );
  }
  return deps.automation;
}
