/**
 * The daily Datadog scan, as a loop.
 *
 * Thin on purpose: the work is `application/datadog-scan.ts`, because the same
 * pass runs from the "Scan now" button on the Datadog page and neither caller
 * should own it. What this file adds is the loop's own concerns — the window, the
 * cap, the dry-run guard, and a result the run history can be read from.
 *
 * Notably it does *not* use a watermark, and that is a departure from every other
 * loop here worth explaining. A watermark answers "what has changed since I last
 * looked", which is the right question for tickets and merge requests. This loop
 * asks "what is broken now, and how much", and the answer is a measurement over a
 * fixed window: a scan that only counted logs since 04:00 yesterday-plus-a-minute
 * would report a number nobody can compare with the one from the day before. So
 * the window is `lookbackHours` wide, every run, and re-seeing yesterday's issue
 * is the point — that is what `scan_count` and the trend arrow are built from.
 *
 * Nothing here writes to Datadog or starts an agent. Confirmed production
 * regressions are filed to Jira under the executor's per-run write cap; creating
 * a branch or merge request remains a person's explicit action.
 */
import { z } from "zod";
import {
  createDatadogClient,
  datadogLogQuery,
  DEFAULT_LOG_QUERY,
} from "../../connectors/datadog/client.ts";
import { scanDatadog } from "../../application/datadog-scan.ts";
import {
  ticketDatadogRegressions,
  type DatadogJiraTicketConfig,
} from "../../application/datadog-ticketing.ts";
import type { TaskConnectorFactory } from "../../application/gateways.ts";
import type {
  DatadogIssueRepository,
  DatadogRoutingRepository,
  DatadogServiceTargetRepository,
  SubjectRepository,
} from "../../application/ports.ts";
import { ConfigError } from "../../core/errors.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";

export const DATADOG_SCAN_TASK_ID = "datadog-scan";

/**
 * 06:15 local. After the overnight batch jobs have finished failing and before
 * anybody starts triage, and off the hour because every other scheduler in the
 * world fires on it.
 */
const DATADOG_SCAN_CRON = "15 6 * * *";

const DatadogJiraParamsSchema: z.ZodType<DatadogJiraTicketConfig> = z
  .object({
    project: z
      .string()
      .trim()
      .min(1)
      .transform((value) => value.toUpperCase())
      .optional(),
    issueType: z.string().trim().min(1).default("Bug"),
    assigneeMode: z.enum(["automatic", "fixed"]).default("automatic"),
    assignee: z.string().trim().min(1).optional(),
    boardId: z.number().int().positive().optional(),
    // Retained in stored params for compatibility; Datadog tickets always use
    // the active sprint regardless of an older false value.
    useActiveSprint: z.boolean().default(true),
    labels: z.array(z.string().trim().min(1)).default(["talos", "datadog"]),
    bugFoundBy: z.string().trim().min(1).optional(),
    feBeUx: z.string().trim().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.assigneeMode === "fixed" && !value.assignee) {
      ctx.addIssue({
        code: "custom",
        path: ["assignee"],
        message: "A fixed Jira assignee is required.",
      });
    }
  });

export const DatadogScanParamsSchema = z.object({
  /**
   * Overrides `DATADOG_LOG_QUERY` for this loop. Empty means the configured
   * query, which is what keeps one setting authoritative for the page and the
   * loop both.
   */
  query: z.string().trim().optional(),
  /**
   * The measurement window. A day by default, matching the schedule: a window
   * shorter than the interval leaves gaps nobody can see, and a much longer one
   * makes "new today" mean nothing.
   */
  lookbackHours: z.number().int().min(1).max(168).default(24),
  /** Service buckets per aggregate page. Every page is consumed. */
  maxServices: z.number().int().min(1).max(100).default(20),
  /**
   * Log bodies read per service, and so the denominator of every estimate. 200
   * distinguishes a 90%-of-the-noise cluster from a 2% one, which is the decision
   * this feeds; 1000 would sharpen numbers nobody reads to that precision.
   */
  samplesPerService: z.number().int().min(10).max(1000).default(200),
  /** Jira fields used for automatic regression tickets. Absent keeps legacy defaults. */
  jira: DatadogJiraParamsSchema.optional(),
});

export type DatadogScanParams = z.infer<typeof DatadogScanParamsSchema>;

export interface DatadogScanDeps {
  issues?: DatadogIssueRepository;
  routing?: DatadogRoutingRepository;
  serviceTargets?: DatadogServiceTargetRepository;
  subjects?: SubjectRepository;
  connectors?: TaskConnectorFactory;
}

export function createDatadogScanTask(deps: DatadogScanDeps = {}): Task<DatadogScanParams> {
  return {
    id: DATADOG_SCAN_TASK_ID,
    name: "Datadog error scan",
    description:
      "Clusters production error logs into issues by service and error shape, " +
      "assigns severity and an owning team, and files confirmed regressions to Jira.",
    kind: "loop",
    // The installation's configured team scan is a UUID-backed public instance.
    instantiable: true,
    defaultTrigger: { type: "cron", expression: DATADOG_SCAN_CRON },
    paramsSchema: DatadogScanParamsSchema,
    run: (ctx, params) => run(ctx, params, deps),
  };
}

async function run(
  ctx: TaskContext,
  params: DatadogScanParams,
  deps: DatadogScanDeps,
): Promise<TaskResult> {
  if (!deps.issues || !deps.routing || !deps.subjects || !deps.connectors) {
    throw new ConfigError(
      "The Datadog scan needs issue, routing, subject, and connector dependencies. " +
        "This task was registered without them — see registerBuiltInTasks in tasks/index.ts.",
    );
  }

  const client = createDatadogClient(ctx.secrets, { logger: ctx.logger });
  const query = params.query?.trim() || datadogLogQuery(ctx.secrets);
  const to = new Date();
  const from = new Date(to.getTime() - params.lookbackHours * 3_600_000);

  const summary = await ctx.step("scan", () =>
    scanDatadog(
      {
        client,
        issues: deps.issues!,
        routing: deps.routing!,
        logger: ctx.logger,
      },
      {
        query,
        from,
        to,
        maxServices: params.maxServices,
        samplesPerService: params.samplesPerService,
        // Dry-run still reads Datadog so it can report what it found, while both
        // local issue writes and later Jira writes remain suppressed.
        dryRun: ctx.dryRun,
        signal: ctx.signal,
      },
    ),
  );

  if (summary.partial) {
    // Not a failure: Datadog returned real buckets, just not all of them. Loud
    // because it means the totals under-report, and a quiet under-report is how a
    // service's errors go missing from triage for a week.
    ctx.logger.warn(
      { query: summary.query },
      "Datadog could not finish scanning the window; counts are partial",
    );
  }

  const tickets = await ticketDatadogRegressions(
    ctx,
    summary.problems,
    {
      issues: deps.issues,
      routing: deps.routing,
      subjects: deps.subjects,
      connectors: deps.connectors,
      ...(deps.serviceTargets ? { serviceTargets: deps.serviceTargets } : {}),
    },
    params.jira,
  );

  return {
    itemsSeen: summary.issuesFound,
    itemsProcessed: summary.issuesRecorded,
    itemsSkipped: summary.issuesIgnored,
    itemsFailed: tickets.failed,
    details: {
      query: summary.query,
      window: { from: from.toISOString(), to: to.toISOString() },
      totalEvents: summary.totalEvents,
      servicesSeen: summary.servicesSeen,
      servicesScanned: summary.servicesScanned,
      servicesIgnored: summary.servicesIgnored,
      issuesNew: summary.issuesNew,
      issuesPruned: summary.issuesPruned,
      // The number the page shows, and the one worth watching over time: clusters
      // are log lines, problems are failures, and the gap between them is what the
      // grouping earned on this run.
      problemsFound: summary.problemsFound,
      problemsMerged: summary.problemsMerged,
      bySeverity: summary.bySeverity,
      filed: tickets.filed,
      adopted: tickets.adopted,
      existing: tickets.existing,
      activePr: tickets.activePr,
      held: tickets.held,
      dismissed: tickets.dismissed,
      deferred: tickets.deferred,
      suppressed: tickets.suppressed,
      jiraFailed: tickets.failed,
      ticketOutcomes: tickets.outcomes.flatMap((outcome) =>
        outcome.issueKey
          ? [
              {
                action: outcome.action,
                issueKey: outcome.issueKey,
                issueUrl: outcome.issueUrl,
                // Named `file` for the shared run-history contract. Datadog's
                // equivalent unit is the grouped problem title.
                file: outcome.title,
              },
            ]
          : [],
      ),
      partial: summary.partial,
      // The worst handful by name: a run row that says "recorded 38" is a number,
      // and this is the answer somebody actually wanted from it.
      worst: summary.issues.slice(0, 5).map((issue) => ({
        severity: issue.severity,
        title: issue.problemTitle ?? issue.title,
        events: issue.problemEventCount ?? issue.eventCount,
        team: issue.team ?? issue.area,
      })),
    },
  };
}

/** The query a fresh install scans, for the settings hint and the docs. */
export { DEFAULT_LOG_QUERY };
