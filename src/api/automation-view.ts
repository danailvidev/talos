import type * as ApiContract from "../../shared/api-contract.ts";
import type { App } from "../app.ts";
import {
  AUTOMATION_RUNNING_STATUSES,
  automationPipelineOutcome,
} from "../application/automation-pipeline-outcome.ts";
import type {
  AutomationAiTriageRecord,
  AutomationFailureAssignee,
  AutomationFailureInboxPage,
  AutomationFailureInboxItem,
  AutomationFailureClusterDetail,
  AutomationFailureClusterPage,
  AutomationFailureClusterSummary,
  AutomationJobRetryWave,
  AutomationPipelineSnapshot,
  AutomationSchedule,
  AutomationTestReportCounts,
} from "../application/ports.ts";
import { TRIAGE_AUTOMATION_FAILURE_TASK_ID } from "../tasks/triage-automation-failure/index.ts";

const DAY_MS = 86_400_000;
const SCHEDULE_OVERDUE_GRACE_MS = 2 * 60 * 60_000;
const UNKNOWN_SCHEDULE_STALE_MS = 26 * 60 * 60_000;

const RUNNING_STATUSES = AUTOMATION_RUNNING_STATUSES;

export interface AutomationDashboardOptions {
  days: 1 | 7 | 30;
  scheduleId?: number;
  status?: string;
  recentLimit: number;
  recentOffset: number;
  now?: Date;
}

export { automationPipelineOutcome };

export function toAutomationDashboard(
  app: App,
  options: AutomationDashboardOptions,
): ApiContract.AutomationDashboardView {
  const generatedAt = options.now ?? new Date();
  const config = app.automationConfig.get();
  const range = dashboardRange(generatedAt, options.days);
  if (!config) {
    return {
      configured: false,
      projectId: null,
      generatedAt: generatedAt.toISOString(),
      lastSyncedAt: null,
      days: options.days,
      filters: {
        scheduleId: options.scheduleId ?? null,
        status: options.status ?? null,
      },
      totals: aggregate([]),
      trend: emptyTrend(range.from, options.days),
      scheduleTrends: [],
      schedules: [],
      attentionItems: [
        {
          code: "configuration-required",
          severity: "warning",
          scheduleId: null,
          pipelineId: null,
          message: "Automation is not configured.",
        },
      ],
      recentPipelines: {
        limit: options.recentLimit,
        offset: options.recentOffset,
        total: 0,
        items: [],
      },
    };
  }

  const configuredSchedules = config.schedules.filter(
    (schedule) =>
      options.scheduleId == null || schedule.scheduleId === options.scheduleId,
  );
  const configuredIds = new Set(configuredSchedules.map((schedule) => schedule.scheduleId));
  const metadataById = new Map(
    app.automation
      .listSchedules(config.projectId)
      .map((schedule) => [schedule.scheduleId, schedule]),
  );
  const pipelines = app.automation
    .listPipelines({
      projectId: config.projectId,
      from: range.from,
      to: generatedAt,
      ...(options.scheduleId != null ? { scheduleId: options.scheduleId } : {}),
      ...(options.status != null ? { status: options.status } : {}),
    })
    .filter((pipeline) => configuredIds.has(pipeline.scheduleId));

  const scheduleViews = configuredSchedules.map((configured) => {
    const metadata = metadataById.get(configured.scheduleId);
    const schedulePipelines = pipelines.filter(
      (pipeline) => pipeline.scheduleId === configured.scheduleId,
    );
    // Deliberately ignores days and status: "latest" is the schedule's actual
    // latest pipeline, not the latest row left by the current dashboard filters.
    const latest = app.automation
      .listPipelines({
        projectId: config.projectId,
        scheduleId: configured.scheduleId,
        limit: 1,
      })
      .at(0);
    const stale = metadata != null && scheduleIsStale(metadata, generatedAt);
    return {
      scheduleId: configured.scheduleId,
      displayName:
        configured.displayName ?? metadata?.description ?? `Schedule ${configured.scheduleId}`,
      metadata: metadata ? toScheduleMetadata(metadata) : null,
      latestPipeline: latest
        ? toCompactPipeline(
            latest,
            app.automation.getJobRetryWave(config.projectId, latest.pipelineId),
          )
        : null,
      rangeStats: aggregate(schedulePipelines),
      noData: schedulePipelines.length === 0,
      stale,
    } satisfies ApiContract.AutomationScheduleDashboardView;
  });

  const attentionItems: ApiContract.AutomationAttentionItemView[] = [];
  for (const schedule of scheduleViews) {
    if (!schedule.metadata) {
      attentionItems.push({
        code: "schedule-not-synced",
        severity: "warning",
        scheduleId: schedule.scheduleId,
        pipelineId: null,
        message: `${schedule.displayName} has not been synchronized yet.`,
      });
    } else if (schedule.stale) {
      attentionItems.push({
        code: "schedule-stale",
        severity: "warning",
        scheduleId: schedule.scheduleId,
        pipelineId: null,
        message: `${schedule.displayName} has stale synchronization data.`,
      });
    }
    if (schedule.noData) {
      attentionItems.push({
        code: "schedule-no-data",
        severity: "info",
        scheduleId: schedule.scheduleId,
        pipelineId: null,
        message: `${schedule.displayName} has no pipelines in this range.`,
      });
    }
    const latest = schedule.latestPipeline;
    if (
      latest &&
      latest.outcome !== "passed" &&
      latest.outcome !== "running" &&
      latest.outcome !== "canceled-skipped"
    ) {
      attentionItems.push({
        code: "latest-pipeline-needs-attention",
        severity: "error",
        scheduleId: schedule.scheduleId,
        pipelineId: latest.pipelineId,
        message: `${schedule.displayName}'s latest pipeline is ${latest.outcome}.`,
      });
    }
  }

  const synced = config.schedules
    .map((schedule) => metadataById.get(schedule.scheduleId)?.syncedAt)
    .filter((value): value is Date => value != null);
  const scheduleNames = new Map(
    scheduleViews.map((schedule) => [schedule.scheduleId, schedule.displayName]),
  );

  return {
    configured: true,
    projectId: config.projectId,
    generatedAt: generatedAt.toISOString(),
    lastSyncedAt:
      synced.length > 0
        ? new Date(Math.max(...synced.map((value) => value.getTime()))).toISOString()
        : null,
    days: options.days,
    filters: {
      scheduleId: options.scheduleId ?? null,
      status: options.status ?? null,
    },
    totals: aggregate(pipelines),
    trend: trend(pipelines, range.from, options.days),
    scheduleTrends: scheduleTrends(
      scheduleViews,
      pipelines,
      range.from,
      options.days,
    ),
    schedules: scheduleViews,
    attentionItems,
    recentPipelines: {
      limit: options.recentLimit,
      offset: options.recentOffset,
      total: pipelines.length,
      items: pipelines
        .slice(
          options.recentOffset,
          options.recentOffset + options.recentLimit,
        )
        .map((pipeline) => ({
          ...toCompactPipeline(
            pipeline,
            app.automation.getJobRetryWave(config.projectId, pipeline.pipelineId),
          ),
          scheduleName:
            scheduleNames.get(pipeline.scheduleId) ??
            `Schedule ${pipeline.scheduleId}`,
        })),
    },
  };
}

/**
 * Schedule freshness follows the source cadence, not TALOS's polling cadence.
 * A daily suite remains current until GitLab says its next run is overdue.
 */
export function scheduleIsStale(
  schedule: AutomationSchedule,
  now: Date,
): boolean {
  if (!schedule.active) return false;
  if (schedule.nextRunAt) {
    return now.getTime() > schedule.nextRunAt.getTime() + SCHEDULE_OVERDUE_GRACE_MS;
  }
  return now.getTime() - schedule.syncedAt.getTime() > UNKNOWN_SCHEDULE_STALE_MS;
}

export function toAutomationPipelineDetail(
  pipeline: AutomationPipelineSnapshot,
  retry?: AutomationJobRetryWave,
): ApiContract.AutomationPipelineDetailView {
  return {
    ...toCompactPipeline(pipeline, retry),
    projectId: pipeline.projectId,
    createdAt: pipeline.createdAt?.toISOString() ?? null,
    report: pipeline.report ? toReport(pipeline.report) : null,
    jobs: pipeline.jobs.map((job) => ({
      jobId: job.jobId,
      name: job.name,
      stage: job.stage,
      status: job.status,
      failureReason: job.failureReason ?? null,
      allowFailure: job.allowFailure,
      webUrl: job.webUrl,
      durationSeconds: job.duration ?? null,
      createdAt: job.createdAt?.toISOString() ?? null,
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      report: job.report ? toReport(job.report) : null,
    })),
    suites: pipeline.suites.map((suite) => ({
      index: suite.index,
      name: suite.name,
      buildIds: suite.buildIds,
      ...toReport(suite),
    })),
    failedTests: pipeline.failedTests.map((test) => ({
      suiteIndex: test.suiteIndex,
      caseIndex: test.caseIndex ?? null,
      jobId: test.jobId ?? null,
      status: test.status,
      name: test.name,
      classname: test.classname ?? null,
      executionTimeSeconds: test.executionTime,
      systemOutput: test.systemOutput ?? null,
      stackTrace: test.stackTrace ?? null,
      ...automationAttachmentView(pipeline, test),
    })),
  };
}

export function toAutomationFailureClusterList(
  app: App,
  pipelineId: number,
  scheduleId: number,
  limit: number,
  offset: number,
  page: AutomationFailureClusterPage,
): ApiContract.AutomationFailureClusterListView {
  const ai = automationAiTriagePresentation(app, page.items);
  const ticketRefusal = automationTicketRefusal(app);
  return {
    pipelineId,
    scheduleId,
    limit,
    offset,
    total: page.total,
    items: page.items.map((cluster) =>
      toAutomationFailureCluster(
        cluster,
        ticketRefusal,
        ai.get(cluster.signatureKey),
      ),
    ),
    facets: page.facets,
  };
}

export function toAutomationFailureInbox(
  app: App,
  options: {
    days: 1 | 7 | 30;
    presence: ApiContract.AutomationFailurePresence;
    limit: number;
    offset: number;
    now: Date;
    openMergeRequests: number | null;
    openMergeRequestsUrl: string | null;
  },
  page: AutomationFailureInboxPage,
): ApiContract.AutomationFailureInboxView {
  const configured = app.automationConfig.get();
  const metadata = new Map(
    (configured
      ? app.automation.listSchedules(configured.projectId)
      : []
    ).map((schedule) => [schedule.scheduleId, schedule.description]),
  );
  const configuredNames = new Map(
    (configured?.schedules ?? []).map((schedule) => [
      schedule.scheduleId,
      schedule.displayName ??
        metadata.get(schedule.scheduleId) ??
        `Schedule ${schedule.scheduleId}`,
    ]),
  );
  const ai = new Map<string, AutomationAiTriagePresentation>();
  const assignees = new Map<string, AutomationFailureAssignee>();
  const bySchedule = new Map<number, AutomationFailureInboxItem[]>();
  for (const item of page.items) {
    const items = bySchedule.get(item.scheduleId);
    if (items) items.push(item);
    else bySchedule.set(item.scheduleId, [item]);
  }
  for (const items of bySchedule.values()) {
    for (const [signatureKey, presentation] of automationAiTriagePresentation(
      app,
      items,
    )) {
      ai.set(`${items[0]!.scheduleId}\u001f${signatureKey}`, presentation);
    }
    for (const [signatureKey, assignee] of app.automationFailureAssignees.listFor(
      items[0]!.projectId,
      items[0]!.scheduleId,
      items.map((item) => item.signatureKey),
    )) {
      assignees.set(`${items[0]!.scheduleId}\u001f${signatureKey}`, assignee);
    }
  }
  const ticketRefusal = automationTicketRefusal(app);
  return {
    generatedAt: options.now.toISOString(),
    days: options.days,
    presence: options.presence,
    limit: options.limit,
    offset: options.offset,
    total: page.total,
    items: page.items.map((item) =>
      toAutomationFailureInboxItem(
        item,
        configuredNames.get(item.scheduleId) ?? `Schedule ${item.scheduleId}`,
        ticketRefusal,
        automationFailureAssigneeView(
          app,
          assignees.get(`${item.scheduleId}\u001f${item.signatureKey}`),
        ),
        ai.get(`${item.scheduleId}\u001f${item.signatureKey}`),
        app.automation.getJobRetryWave(item.projectId, item.latestPipelineId),
      ),
    ),
    facets: {
      states: page.facets.states,
      schedules: page.facets.schedules.map((schedule) => ({
        ...schedule,
        scheduleName:
          configuredNames.get(schedule.scheduleId) ??
          `Schedule ${schedule.scheduleId}`,
      })),
      current: page.facets.current,
      recent: page.facets.recent,
      openMergeRequests: options.openMergeRequests,
      openMergeRequestsUrl: options.openMergeRequestsUrl,
    },
  };
}

function automationFailureAssigneeView(
  app: App,
  assignment: AutomationFailureAssignee | undefined,
): ApiContract.AutomationFailureAssigneeView | null {
  if (!assignment) return null;
  const user = app.auth.byId(assignment.userId);
  return {
    id: assignment.userId,
    name: user?.name ?? "Former Talos user",
    email: user?.email ?? "",
    assignedAt: assignment.assignedAt.toISOString(),
  };
}

function toAutomationFailureInboxItem(
  item: AutomationFailureInboxItem,
  scheduleName: string,
  ticketRefusal: string | null,
  assignee: ApiContract.AutomationFailureAssigneeView | null,
  ai?: AutomationAiTriagePresentation,
  retry?: AutomationJobRetryWave,
): ApiContract.AutomationFailureInboxItemView {
  return {
    scheduleId: item.scheduleId,
    scheduleName,
    signatureKey: item.signatureKey,
    title: item.title,
    severity: item.severity,
    firstSeenAt: item.firstSeenAt.toISOString(),
    lastSeenAt: item.lastSeenAt.toISOString(),
    pipelineCount: item.pipelineCount,
    latestPipelineId: item.latestPipelineId,
    latestPipelineUrl: item.latestPipelineUrl,
    latestRef: item.latestRef,
    latestSha: item.latestSha,
    latestUpdatedAt: item.latestUpdatedAt.toISOString(),
    occurrenceCount: item.occurrenceCount,
    affectedTestCount: item.affectedTestCount,
    sampleTestName: item.sampleTestName,
    sampleClassname: item.sampleClassname ?? null,
    current: item.current,
    assignee,
    triageState: item.triageState,
    creating: item.creating,
    work: item.work
      ? {
          state: item.work.state,
          jiraKey: item.work.jiraKey ?? null,
          jiraUrl: item.work.jiraUrl ?? null,
          mrIid: item.work.mrIid ?? null,
          mrUrl: item.work.mrUrl ?? null,
          updatedAt: item.work.updatedAt.toISOString(),
        }
      : null,
    ticketRefusal,
    aiTriage: ai?.result
      ? {
          verdict: ai.result.verdict,
          confidence: ai.result.confidence,
          rationale: ai.result.rationale,
          recommendation: ai.result.recommendation,
          taskRunId: ai.result.taskRunId,
          updatedAt: ai.result.updatedAt.toISOString(),
        }
      : null,
    aiTriageInFlight: ai?.inFlight ?? false,
    aiTriageRefusal: ai?.refusal ?? null,
    autoRetry: retry ? toAutomationJobRetrySummary(retry) : null,
  };
}

export function toAutomationFailureClusterDetail(
  app: App,
  cluster: AutomationFailureClusterDetail,
): ApiContract.AutomationFailureClusterDetailView {
  const ai = automationAiTriagePresentation(app, [cluster]).get(
    cluster.signatureKey,
  );
  return {
    ...toAutomationFailureCluster(cluster, automationTicketRefusal(app), ai),
    pipelineId: cluster.pipelineId,
    scheduleId: cluster.scheduleId,
    pipelineUrl: cluster.pipelineUrl,
    members: cluster.members.map((member) => ({
      suiteIndex: member.suiteIndex,
      suiteName: member.suiteName,
      caseIndex: member.caseIndex,
      jobId: member.jobId ?? null,
      jobName: member.jobName ?? null,
      jobUrl: member.jobUrl ?? null,
      status: member.status,
      name: member.name,
      classname: member.classname ?? null,
      executionTimeSeconds: member.executionTime,
      testFile: member.testFile ?? null,
      ...automationAttachmentValues(
        cluster.pipelineUrl,
        cluster.pipelineId,
        member.suiteIndex,
        member.caseIndex,
        member.attachmentJobId,
        member.attachmentPath,
        member.attachmentName,
      ),
    })),
    membersTruncated: cluster.membersTruncated,
    representative: {
      suiteIndex: cluster.representative.suiteIndex,
      caseIndex: cluster.representative.caseIndex,
      systemOutput: cluster.representative.systemOutput ?? null,
      stackTrace: cluster.representative.stackTrace ?? null,
    },
  };
}

function toAutomationFailureCluster(
  cluster: AutomationFailureClusterSummary,
  ticketRefusal: string | null,
  ai?: AutomationAiTriagePresentation,
): ApiContract.AutomationFailureClusterView {
  return {
    signatureKey: cluster.signatureKey,
    title: cluster.title,
    severity: cluster.severity,
    occurrenceCount: cluster.occurrenceCount,
    affectedTestCount: cluster.affectedTestCount,
    sampleTestName: cluster.sampleTestName,
    sampleClassname: cluster.sampleClassname ?? null,
    jobIds: cluster.jobIds,
    suiteIndexes: cluster.suiteIndexes,
    triageState: cluster.triageState,
    creating: cluster.creating,
    work: cluster.work
      ? {
          state: cluster.work.state,
          jiraKey: cluster.work.jiraKey ?? null,
          jiraUrl: cluster.work.jiraUrl ?? null,
          mrIid: cluster.work.mrIid ?? null,
          mrUrl: cluster.work.mrUrl ?? null,
          updatedAt: cluster.work.updatedAt.toISOString(),
        }
      : null,
    ticketRefusal,
    aiTriage: ai?.result
      ? {
          verdict: ai.result.verdict,
          confidence: ai.result.confidence,
          rationale: ai.result.rationale,
          recommendation: ai.result.recommendation,
          taskRunId: ai.result.taskRunId,
          updatedAt: ai.result.updatedAt.toISOString(),
        }
      : null,
    aiTriageInFlight: ai?.inFlight ?? false,
    aiTriageRefusal: ai?.refusal ?? null,
  };
}

function automationTicketRefusal(app: App): string | null {
  return app.automationConfig.get()?.jira
    ? null
    : "Automation Jira ticketing is not configured.";
}

interface AutomationAiTriagePresentation {
  result?: AutomationAiTriageRecord;
  inFlight: boolean;
  refusal: string | null;
}

/**
 * Joins one page in two batched reads: saved verdicts and all active handler
 * jobs. No row asks the queue whether its own action is running.
 */
export function automationAiTriagePresentation(
  app: App,
  clusters: readonly Pick<
    AutomationFailureClusterSummary,
    "projectId" | "scheduleId" | "signatureKey" | "title"
  >[],
): Map<string, AutomationAiTriagePresentation> {
  if (clusters.length === 0) return new Map();
  const first = clusters[0]!;
  const refusal = app.taskRegistry.get(TRIAGE_AUTOMATION_FAILURE_TASK_ID)
    ? null
    : "No Automation AI triage task is registered.";
  const saved = app.automationAiTriage.listFor(
    first.projectId,
    first.scheduleId,
    clusters.map((cluster) => cluster.signatureKey),
  );
  const active = new Set(
    app.jobs
      .activeForKind(TRIAGE_AUTOMATION_FAILURE_TASK_ID)
      .flatMap((job) => {
        const params = job.params as {
          projectId?: unknown;
          scheduleId?: unknown;
          signatureKey?: unknown;
        } | undefined;
        return params?.projectId === first.projectId &&
          params.scheduleId === first.scheduleId &&
          typeof params.signatureKey === "string"
          ? [params.signatureKey]
          : [];
      }),
  );
  return new Map(
    clusters.map((cluster) => {
      const result = saved.get(cluster.signatureKey);
      return [
        cluster.signatureKey,
        {
          // The key is stable identity; the text proves this verdict was
          // produced for the same normalized failure represented by this row.
          ...(result?.signature === cluster.title ? { result } : {}),
          inFlight: active.has(cluster.signatureKey),
          refusal,
        },
      ];
    }),
  );
}

function automationAttachmentView(
  pipeline: AutomationPipelineSnapshot,
  test: AutomationPipelineSnapshot["failedTests"][number],
): Pick<
  ApiContract.AutomationFailedTestView,
  "attachmentName" | "attachmentUrl" | "attachmentProxyUrl"
> {
  return automationAttachmentValues(
    pipeline.webUrl,
    pipeline.pipelineId,
    test.suiteIndex,
    test.caseIndex,
    test.attachmentJobId,
    test.attachmentPath,
    test.attachmentName,
  );
}

function automationAttachmentValues(
  pipelineWebUrl: string,
  pipelineId: number,
  suiteIndex: number,
  caseIndex: number | undefined,
  attachmentJobId: number | undefined,
  attachmentPath: string | undefined,
  attachmentName: string | undefined,
): Pick<
  ApiContract.AutomationFailedTestView,
  "attachmentName" | "attachmentUrl" | "attachmentProxyUrl"
> {
  if (attachmentJobId == null || attachmentPath == null || caseIndex == null) {
    return {
      attachmentName: null,
      attachmentUrl: null,
      attachmentProxyUrl: null,
    };
  }
  const segments = safeArtifactPathSegments(attachmentPath);
  const projectUrl = safePipelineProjectUrl(pipelineWebUrl);
  if (!segments || !projectUrl) {
    return {
      attachmentName: null,
      attachmentUrl: null,
      attachmentProxyUrl: null,
    };
  }
  const encodedPath = segments.map(encodeURIComponent).join("/");
  return {
    attachmentName: attachmentName ?? segments.at(-1)!,
    attachmentUrl:
      `${projectUrl}/-/jobs/${attachmentJobId}/artifacts/file/${encodedPath}`,
    attachmentProxyUrl:
      `/api/automation/pipelines/${pipelineId}/failed-tests/` +
      `${suiteIndex}/${caseIndex}/attachment`,
  };
}

function safePipelineProjectUrl(pipelineWebUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(pipelineWebUrl);
  } catch {
    return undefined;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    return undefined;
  }
  const markerIndex = url.pathname.indexOf("/-/pipelines/");
  if (markerIndex <= 0) return undefined;
  return `${url.origin}${url.pathname.slice(0, markerIndex)}`;
}

function safeArtifactPathSegments(path: string): string[] | undefined {
  if (!path || path.length > 8_192) return undefined;
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.length > 255 ||
        segment.includes("\\") ||
        /[\u0000-\u001f\u007f]/.test(segment),
    )
  ) {
    return undefined;
  }
  return segments;
}

function dashboardRange(now: Date, days: number): { from: Date } {
  return {
    from: new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - (days - 1),
      ),
    ),
  };
}

function emptyOutcomes(): Record<ApiContract.AutomationPipelineOutcome, number> {
  return {
    passed: 0,
    "test-failed": 0,
    "infrastructure-failed": 0,
    running: 0,
    "canceled-skipped": 0,
    "report-missing": 0,
    "report-error": 0,
  };
}

function aggregate(
  pipelines: readonly AutomationPipelineSnapshot[],
): ApiContract.AutomationDashboardTotalsView {
  const outcomes = emptyOutcomes();
  let pipelineSuccesses = 0;
  let pipelineAttempts = 0;
  let durationTotal = 0;
  let durationCount = 0;
  const tests = { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 };

  for (const pipeline of pipelines) {
    outcomes[automationPipelineOutcome(pipeline)] += 1;
    if (pipeline.status === "success" || pipeline.status === "failed") {
      pipelineAttempts += 1;
      if (pipeline.status === "success") pipelineSuccesses += 1;
    }
    if (pipeline.duration != null) {
      durationTotal += pipeline.duration;
      durationCount += 1;
    }
    if (pipeline.report) {
      tests.total += pipeline.report.totalCount;
      tests.passed += pipeline.report.successCount;
      tests.failed += pipeline.report.failedCount;
      tests.skipped += pipeline.report.skippedCount;
      tests.errors += pipeline.report.errorCount;
    }
  }

  const testAttempts = tests.passed + tests.failed + tests.errors;
  return {
    pipelines: pipelines.length,
    outcomes,
    pipelineSuccessRate:
      pipelineAttempts > 0 ? pipelineSuccesses / pipelineAttempts : null,
    testPassRate: testAttempts > 0 ? tests.passed / testAttempts : null,
    tests,
    averageDurationSeconds:
      durationCount > 0 ? durationTotal / durationCount : null,
  };
}

function emptyTrend(from: Date, days: number): ApiContract.AutomationTrendDayView[] {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(from.getTime() + index * DAY_MS);
    return {
      date: date.toISOString().slice(0, 10),
      pipelines: 0,
      outcomes: emptyOutcomes(),
      tests: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 },
    };
  });
}

function trend(
  pipelines: readonly AutomationPipelineSnapshot[],
  from: Date,
  days: number,
): ApiContract.AutomationTrendDayView[] {
  const rows = emptyTrend(from, days);
  const byDate = new Map(rows.map((row) => [row.date, row]));
  for (const pipeline of pipelines) {
    const row = byDate.get(pipeline.updatedAt.toISOString().slice(0, 10));
    if (!row) continue;
    row.pipelines += 1;
    row.outcomes[automationPipelineOutcome(pipeline)] += 1;
    if (pipeline.report) {
      row.tests.total += pipeline.report.totalCount;
      row.tests.passed += pipeline.report.successCount;
      row.tests.failed += pipeline.report.failedCount;
      row.tests.skipped += pipeline.report.skippedCount;
      row.tests.errors += pipeline.report.errorCount;
    }
  }
  return rows;
}

function scheduleTrends(
  schedules: readonly ApiContract.AutomationScheduleDashboardView[],
  pipelines: readonly AutomationPipelineSnapshot[],
  from: Date,
  days: number,
): ApiContract.AutomationScheduleTrendView[] {
  const dates = emptyTrend(from, days).map((day) => day.date);
  return schedules.map((schedule) => {
    const byDate = new Map<string, AutomationPipelineSnapshot[]>();
    for (const pipeline of pipelines) {
      if (pipeline.scheduleId !== schedule.scheduleId) continue;
      const date = pipeline.updatedAt.toISOString().slice(0, 10);
      const rows = byDate.get(date);
      if (rows) rows.push(pipeline);
      else byDate.set(date, [pipeline]);
    }
    return {
      scheduleId: schedule.scheduleId,
      displayName: schedule.displayName,
      days: dates.map((date) => {
        // Repository reads are newest-first. Prefer the latest terminal run so
        // an in-progress rerun does not erase the day's completed verdict.
        const runs = byDate.get(date) ?? [];
        const representativeIndex = runs.findIndex(
          (pipeline) => !RUNNING_STATUSES.has(pipeline.status),
        );
        const selected =
          runs[representativeIndex === -1 ? 0 : representativeIndex];
        const outcome = selected ? automationPipelineOutcome(selected) : null;
        return {
          date,
          pipelineId: selected?.pipelineId ?? null,
          outcome,
          tests: selected?.report ? toTestCounts(selected.report) : null,
          durationSeconds: selected?.duration ?? null,
          runCount: runs.length,
          unstable:
            outcome === "passed" &&
            runs
              .slice((representativeIndex === -1 ? 0 : representativeIndex) + 1)
              .some((pipeline) =>
                isUnhealthyOutcome(automationPipelineOutcome(pipeline)),
              ),
        };
      }),
    };
  });
}

function isUnhealthyOutcome(
  outcome: ApiContract.AutomationPipelineOutcome,
): boolean {
  return (
    outcome === "test-failed" ||
    outcome === "infrastructure-failed" ||
    outcome === "report-missing" ||
    outcome === "report-error"
  );
}

function toScheduleMetadata(
  schedule: AutomationSchedule,
): ApiContract.AutomationScheduleMetadataView {
  return {
    description: schedule.description,
    ref: schedule.ref,
    cron: schedule.cron ?? null,
    cronTimezone: schedule.cronTimezone ?? null,
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    active: schedule.active,
    syncedAt: schedule.syncedAt.toISOString(),
  };
}

function toCompactPipeline(
  pipeline: AutomationPipelineSnapshot,
  retry?: AutomationJobRetryWave,
): ApiContract.AutomationPipelineCompactView {
  return {
    pipelineId: pipeline.pipelineId,
    scheduleId: pipeline.scheduleId,
    status: pipeline.status,
    outcome: automationPipelineOutcome(pipeline),
    ref: pipeline.ref,
    sha: pipeline.sha,
    webUrl: pipeline.webUrl,
    updatedAt: pipeline.updatedAt.toISOString(),
    startedAt: pipeline.startedAt?.toISOString() ?? null,
    finishedAt: pipeline.finishedAt?.toISOString() ?? null,
    durationSeconds: pipeline.duration ?? null,
    reportState: pipeline.reportState,
    tests: pipeline.report ? toTestCounts(pipeline.report) : null,
    autoRetry: retry ? toAutomationJobRetrySummary(retry) : null,
  };
}

function toAutomationJobRetrySummary(
  retry: AutomationJobRetryWave,
): ApiContract.AutomationJobRetrySummaryView {
  return {
    state: retry.state,
    requestedAt: retry.requestedAt.toISOString(),
    completedAt: retry.completedAt?.toISOString() ?? null,
    acceptedJobs: retry.attempts.filter((attempt) => attempt.status === "accepted")
      .length,
    failedJobs: retry.attempts.filter((attempt) => attempt.status === "failed")
      .length,
    error: retry.error ?? null,
  };
}

function toTestCounts(
  report: AutomationTestReportCounts,
): ApiContract.AutomationTestCountsView {
  return {
    total: report.totalCount,
    passed: report.successCount,
    failed: report.failedCount,
    skipped: report.skippedCount,
    errors: report.errorCount,
  };
}

function toReport(
  report: AutomationTestReportCounts,
): ApiContract.AutomationTestReportView {
  return {
    totalTimeSeconds: report.totalTime,
    totalCount: report.totalCount,
    successCount: report.successCount,
    failedCount: report.failedCount,
    skippedCount: report.skippedCount,
    errorCount: report.errorCount,
    suiteError: report.suiteError ?? null,
  };
}
