import { z } from "zod";

import type { AppPermission } from "../../../shared/authorization.ts";
import type { DatasetField } from "../../../shared/dashboard.ts";
import type { Actor } from "../../core/actor.ts";
import { ConnectorError } from "../../core/errors.ts";
import type { JiraClient } from "../../connectors/jira/client.ts";
import type { GitLabClient } from "../../connectors/gitlab/client.ts";
import { mergeRequestProjectPath, type MergeRequest } from "../../connectors/gitlab/types.ts";
import { PULL_REQUEST_STATES, type PullRequest, type PullRequestState } from "../pull-requests.ts";
import type { PullRequestApplicationService } from "../pull-request-service.ts";
import type {
  AgentUsageRepository,
  AutomationConfigRepository,
  AutomationRepository,
  DatadogIssueRepository,
  InstanceRepository,
  LogRocketIssueRepository,
  RunRepository,
  TaskRunSummary,
  TestRunHistoryRepository,
} from "../ports.ts";
import type { ScheduledTask } from "../../config/resolve-schedule.ts";

/** A live read stops here even when the source has more. The widget says it was truncated. */
const LIVE_ROW_CAP = 1_000;
const STORED_ROW_CAP = 5_000;
const PIPELINE_PROJECT_CAP = 8;

export interface DatasetFetchOptions {
  bypass: boolean;
  signal: AbortSignal;
}

export interface DatasetRows {
  rows: Record<string, unknown>[];
  truncated: boolean;
}

export interface Dataset {
  id: string;
  label: string;
  description: string;
  requires: AppPermission | null;
  fields: DatasetField[];
  params?: z.ZodType;
  paramsHint?: string;
  fetch(actor: Actor, params: unknown, options: DatasetFetchOptions): Promise<DatasetRows>;
}

export interface DatasetSources {
  jiraFor(actor: Actor): JiraClient;
  gitLabFor(actor: Actor): GitLabClient;
  pullRequests: PullRequestApplicationService;
  automationConfig: AutomationConfigRepository;
  automation: AutomationRepository;
  instances: InstanceRepository;
  runs: RunRepository;
  scheduledTasks(): ScheduledTask[];
  taskName(id: string): string | undefined;
  agentUsage: AgentUsageRepository;
  datadogIssues: DatadogIssueRepository;
  logRocketIssues: LogRocketIssueRepository;
  testRunHistory: TestRunHistoryRepository;
}

const JiraParams = z.object({
  jql: z.string().trim().min(1).max(2_000).optional(),
}).strict();

const MergeRequestParams = z.object({
  scope: z.enum(["mine", "team"]).optional(),
  states: z.array(z.enum(PULL_REQUEST_STATES)).max(4).optional(),
  /** Open merge requests where the user is a reviewer or their name is mentioned. */
  attention: z.literal("needs-attention").optional(),
}).strict();

const PipelineParams = z.object({
  project: z.string().trim().min(1).max(200).optional(),
}).strict();

const DEFAULT_JQL = "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC";
const JIRA_FIELDS = [
  "summary",
  "status",
  "created",
  "updated",
  "issuetype",
  "priority",
  "assignee",
  "reporter",
  "labels",
];

/**
 * Phase-1 sources. Live connectors are the user's own clients, and SQLite
 * reads go through the same repositories the rest of the product uses.
 * Nothing here keeps a daily snapshot: counts are of the records as they
 * stand, grouped by a date those records already carry.
 */
export function dashboardDatasets(sources: DatasetSources): Dataset[] {
  return [
    {
      id: "jira.issues",
      label: "Jira issues",
      description: "Issues assigned to the signed-in user that are still unresolved, unless a JQL query says otherwise. Not a history of how many were open on a past day.",
      requires: "tickets:access",
      params: JiraParams,
      paramsHint: "Optional jql. Defaults to unresolved issues assigned to the current user.",
      fields: [
        { key: "key", label: "Key", type: "string" },
        { key: "summary", label: "Summary", type: "string" },
        { key: "status", label: "Status", type: "string" },
        { key: "statusCategory", label: "Status category", type: "string" },
        { key: "type", label: "Type", type: "string" },
        { key: "priority", label: "Priority", type: "string" },
        { key: "assignee", label: "Assignee", type: "string" },
        { key: "reporter", label: "Reporter", type: "string" },
        { key: "labels", label: "Labels", type: "string" },
        { key: "created", label: "Created", type: "date" },
        { key: "updated", label: "Updated", type: "date" },
        { key: "url", label: "Link", type: "string" },
      ],
      async fetch(actor, params, options) {
        const parsed = JiraParams.parse(params ?? {});
        const jira = sources.jiraFor(actor);
        const issues = await jira.searchIssues(parsed.jql || DEFAULT_JQL, {
          limit: LIVE_ROW_CAP,
          fields: JIRA_FIELDS,
          signal: options.signal,
        });
        return {
          truncated: issues.length >= LIVE_ROW_CAP,
          rows: issues.map((issue) => ({
            key: issue.key,
            summary: issue.fields?.summary ?? "",
            status: issue.fields?.status?.name ?? "",
            statusCategory: issue.fields?.status?.statusCategory?.name ?? "",
            type: issue.fields?.issuetype?.name ?? "",
            priority: issue.fields?.priority?.name ?? "",
            assignee: issue.fields?.assignee?.displayName ?? "",
            reporter: issue.fields?.reporter?.displayName ?? "",
            labels: (issue.fields?.labels ?? []).join(", "),
            created: issue.fields?.created ?? null,
            updated: issue.fields?.updated ?? null,
            url: jira.issueUrl(issue.key),
          })),
        };
      },
    },
    {
      id: "gitlab.merge_requests",
      label: "GitLab merge requests",
      description: "Merge requests the signed-in user can list. Created and updated are the dates on the merge request, not a stored daily snapshot.",
      requires: "pull-requests:access",
      params: MergeRequestParams,
      paramsHint: "Optional scope (mine or team), states, or attention=needs-attention for reviewer and mention lists.",
      fields: [
        { key: "id", label: "Id", type: "string" },
        { key: "number", label: "Number", type: "number" },
        { key: "title", label: "Title", type: "string" },
        { key: "state", label: "State", type: "enum", enumValues: [...PULL_REQUEST_STATES] },
        { key: "repository", label: "Repository", type: "string" },
        { key: "author", label: "Author", type: "string" },
        { key: "sourceBranch", label: "Source branch", type: "string" },
        { key: "targetBranch", label: "Target branch", type: "string" },
        { key: "createdAt", label: "Created", type: "date" },
        { key: "updatedAt", label: "Updated", type: "date" },
        { key: "webUrl", label: "Link", type: "string" },
        { key: "reason", label: "Why", type: "string" },
      ],
      async fetch(actor, params, options) {
        const parsed = MergeRequestParams.parse(params ?? {});
        if (parsed.attention === "needs-attention") {
          return attentionMergeRequests(sources, actor, options.signal);
        }
        const states = parsed.states as PullRequestState[] | undefined;
        const listing = await sources.pullRequests.list(actor, parsed.scope ?? "mine", {
          ...(states?.length ? { states } : { states: [...PULL_REQUEST_STATES] }),
          limit: LIVE_ROW_CAP,
          signal: options.signal,
        });
        if (listing.pullRequests.length === 0 && listing.failed.length > 0) {
          throw new ConnectorError(listing.failed.map((failure) => failure.message).join("; "), {
            connector: "gitlab",
          });
        }
        const rows = listing.pullRequests.slice(0, LIVE_ROW_CAP).map((request) => ({
          id: request.id,
          number: request.number,
          title: request.title,
          state: request.state,
          repository: request.repository ?? "",
          author: request.author?.name || request.author?.username || "",
          sourceBranch: request.sourceBranch,
          targetBranch: request.targetBranch,
          createdAt: request.createdAt?.toISOString() ?? null,
          updatedAt: request.updatedAt.toISOString(),
          webUrl: request.webUrl,
          reason: "",
        }));
        return { rows, truncated: listing.pullRequests.length >= LIVE_ROW_CAP };
      },
    },
    {
      id: "gitlab.pipelines",
      label: "GitLab pipelines",
      description: "Pipelines Automation has already stored for the configured project. Status is the stored pipeline status.",
      requires: "automation:access",
      params: PipelineParams,
      paramsHint: "Optional project path or id. Defaults to the projects Automation is configured for.",
      fields: [
        { key: "id", label: "Id", type: "number" },
        { key: "project", label: "Project", type: "string" },
        { key: "status", label: "Status", type: "string" },
        { key: "ref", label: "Ref", type: "string" },
        { key: "source", label: "Source", type: "string" },
        { key: "name", label: "Name", type: "string" },
        { key: "createdAt", label: "Created", type: "date" },
        { key: "updatedAt", label: "Updated", type: "date" },
      ],
      async fetch(_actor, params) {
        const parsed = PipelineParams.parse(params ?? {});
        const projects = parsed.project ? [parsed.project] : pipelineProjects(sources).slice(0, PIPELINE_PROJECT_CAP);
        if (projects.length === 0) return { rows: [], truncated: false };
        const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        const perProject = 500;
        const rows = projects.flatMap((project) =>
          sources.automation.listPipelineStatuses({
            projectId: project,
            from: since,
            limit: perProject,
          }).map((pipeline) => ({
            id: pipeline.pipelineId,
            project,
            status: pipeline.status,
            ref: pipeline.ref,
            source: "",
            name: "",
            createdAt: pipeline.createdAt?.toISOString() ?? null,
            updatedAt: pipeline.updatedAt.toISOString(),
          })),
        );
        return { rows, truncated: rows.length >= perProject * projects.length };
      },
    },
    {
      id: "talos.task_runs",
      label: "Loop runs",
      description: "Recent runs of loops this user is allowed to see.",
      requires: "loops:access",
      fields: [
        { key: "executionId", label: "Run", type: "string" },
        { key: "taskId", label: "Loop id", type: "string" },
        { key: "taskName", label: "Loop", type: "string" },
        { key: "status", label: "Status", type: "string" },
        { key: "startedAt", label: "Started", type: "date" },
        { key: "finishedAt", label: "Finished", type: "date" },
        { key: "durationMs", label: "Duration", type: "number" },
        { key: "dryRun", label: "Dry run", type: "enum", enumValues: ["yes", "no"] },
      ],
      async fetch(actor) {
        const taskIds = sources.scheduledTasks()
          .map((task) => task.id)
          .filter((id) => canSeeTask(sources, actor, id));
        const runs = new Map<string, TaskRunSummary[]>();
        for (const chunk of chunks(taskIds, 200)) {
          for (const [id, rows] of sources.runs.recentRunsFor(chunk, 40)) runs.set(id, rows);
        }
        const rows = [...runs.values()].flat().slice(0, STORED_ROW_CAP).map((run) => ({
          executionId: run.executionId,
          taskId: run.taskId,
          taskName: sources.instances.get(run.taskId)?.name ?? sources.taskName(run.taskId) ?? run.taskId,
          status: run.status,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
          durationMs: run.durationMs ?? null,
          dryRun: run.dryRun ? "yes" : "no",
        }));
        return { rows, truncated: rows.length >= STORED_ROW_CAP };
      },
    },
    {
      id: "talos.agent_usage",
      label: "My agent usage",
      description: "The signed-in user's own agent invocations. Token totals are what the provider reported.",
      requires: null,
      fields: [
        { key: "startedAt", label: "Started", type: "date" },
        { key: "status", label: "Status", type: "string" },
        { key: "provider", label: "Provider", type: "string" },
        { key: "model", label: "Model", type: "string" },
        { key: "source", label: "Source", type: "string" },
        { key: "durationMs", label: "Duration", type: "number" },
        { key: "inputTokens", label: "Input tokens", type: "number" },
        { key: "outputTokens", label: "Output tokens", type: "number" },
        { key: "totalTokens", label: "Tokens", type: "number" },
      ],
      async fetch(actor) {
        const to = new Date();
        const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
        const report = sources.agentUsage.report(actor.id, { from, to, limit: STORED_ROW_CAP, offset: 0 });
        const rows = report.events.map((event) => {
          const input = event.tokens?.inputTokens ?? 0;
          const output = event.tokens?.outputTokens ?? 0;
          const cacheRead = event.tokens?.cacheReadInputTokens ?? 0;
          const cacheWrite = event.tokens?.cacheCreationInputTokens ?? 0;
          return {
            startedAt: event.startedAt.toISOString(),
            status: event.status,
            provider: event.provider,
            model: event.model ?? "",
            source: event.source,
            durationMs: event.durationMs ?? null,
            inputTokens: input,
            outputTokens: output,
            totalTokens: input + output + cacheRead + cacheWrite,
          };
        });
        return { rows, truncated: report.eventCount > rows.length };
      },
    },
    {
      id: "talos.automation_results",
      label: "Automation results",
      description: "Pipeline snapshots Automation has already stored, including failed-test counts.",
      requires: "automation:access",
      fields: [
        { key: "projectId", label: "Project", type: "string" },
        { key: "pipelineId", label: "Pipeline", type: "number" },
        { key: "status", label: "Status", type: "string" },
        { key: "ref", label: "Ref", type: "string" },
        { key: "updatedAt", label: "Updated", type: "date" },
        { key: "createdAt", label: "Created", type: "date" },
        { key: "duration", label: "Duration", type: "number" },
        { key: "failedTests", label: "Failed tests", type: "number" },
        { key: "successCount", label: "Passed", type: "number" },
        { key: "failedCount", label: "Failed", type: "number" },
      ],
      async fetch() {
        const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        const projects = pipelineProjects(sources).slice(0, PIPELINE_PROJECT_CAP);
        const rows = projects.flatMap((projectId) => sources.automation.listPipelines({
          projectId,
          from: since,
          limit: Math.ceil(STORED_ROW_CAP / Math.max(projects.length, 1)),
        })).slice(0, STORED_ROW_CAP).map((pipeline) => ({
          projectId: pipeline.projectId,
          pipelineId: pipeline.pipelineId,
          status: pipeline.status,
          ref: pipeline.ref,
          updatedAt: pipeline.updatedAt.toISOString(),
          createdAt: pipeline.createdAt?.toISOString() ?? null,
          duration: pipeline.duration ?? null,
          failedTests: pipeline.failedTests.length,
          successCount: pipeline.report?.successCount ?? 0,
          failedCount: pipeline.report?.failedCount ?? 0,
        }));
        return { rows, truncated: rows.length >= STORED_ROW_CAP };
      },
    },
    {
      id: "talos.flaky_specs",
      label: "Flaky specs",
      description: "Tests with an intermittent recent history.",
      requires: "automation:access",
      fields: [
        { key: "project", label: "Project", type: "string" },
        { key: "testId", label: "Test", type: "string" },
        { key: "source", label: "Source", type: "string" },
        { key: "observed", label: "Observed", type: "number" },
        { key: "failed", label: "Failed", type: "number" },
        { key: "consecutiveFailures", label: "Consecutive failures", type: "number" },
        { key: "state", label: "State", type: "enum", enumValues: ["open", "dismissed"] },
        { key: "lastFailedAt", label: "Last failed", type: "date" },
      ],
      async fetch() {
        const listed = sources.testRunHistory.listFlaky({ includeDismissed: false, window: 20 });
        const rows = listed.slice(0, STORED_ROW_CAP).map((spec) => ({
          project: spec.project,
          testId: spec.testId,
          source: spec.source,
          observed: spec.observed,
          failed: spec.failed,
          consecutiveFailures: spec.consecutiveFailures,
          state: spec.state,
          lastFailedAt: spec.lastFailedAt.toISOString(),
        }));
        return { rows, truncated: listed.length > rows.length };
      },
    },
    {
      id: "talos.datadog_issues",
      label: "Datadog issues",
      description: "Issues the Datadog scan has stored.",
      requires: "datadog:access",
      fields: [
        { key: "title", label: "Title", type: "string" },
        { key: "severity", label: "Severity", type: "string" },
        { key: "area", label: "Area", type: "string" },
        { key: "team", label: "Team", type: "string" },
        { key: "service", label: "Service", type: "string" },
        { key: "state", label: "State", type: "string" },
        { key: "eventCount", label: "Events", type: "number" },
        { key: "lastSeenAt", label: "Last seen", type: "date" },
      ],
      async fetch() {
        const listed = sources.datadogIssues.list({ includeDismissed: false, limit: STORED_ROW_CAP });
        return {
          truncated: listed.length >= STORED_ROW_CAP,
          rows: listed.map((issue) => ({
            title: issue.title,
            severity: issue.severity,
            area: issue.area,
            team: issue.team ?? "",
            service: issue.service ?? "",
            state: issue.state,
            eventCount: issue.eventCount,
            lastSeenAt: issue.lastSeenAt.toISOString(),
          })),
        };
      },
    },
    {
      id: "talos.logrocket_issues",
      label: "LogRocket issues",
      description: "Frontend issues LogRocket has alerted TALOS about.",
      requires: "logrocket:access",
      fields: [
        { key: "title", label: "Title", type: "string" },
        { key: "issueType", label: "Type", type: "string" },
        { key: "state", label: "State", type: "string" },
        { key: "sessionCount", label: "Sessions", type: "number" },
        { key: "alertCount", label: "Alerts", type: "number" },
        { key: "lastAlertAt", label: "Last alert", type: "date" },
      ],
      async fetch() {
        const listed = sources.logRocketIssues.list({ includeDismissed: false, limit: STORED_ROW_CAP });
        return {
          truncated: listed.length >= STORED_ROW_CAP,
          rows: listed.map((issue) => ({
            title: issue.title,
            issueType: issue.issueType ?? "",
            state: issue.state,
            sessionCount: issue.sessionCount ?? 0,
            alertCount: issue.alertCount,
            lastAlertAt: issue.lastAlertAt.toISOString(),
          })),
        };
      },
    },
  ];
}

async function attentionMergeRequests(
  sources: DatasetSources,
  actor: Actor,
  signal: AbortSignal,
): Promise<DatasetRows> {
  const gitlab = sources.gitLabFor(actor);
  const me = await gitlab.currentUser(signal);
  const [reviews, team] = await Promise.all([
    gitlab.listMergeRequestsForReview({ state: "opened", limit: 50, signal }),
    sources.pullRequests.list(actor, "team", { states: ["open"], limit: 100, signal }),
  ]);
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const review of reviews) {
    const row = gitlabMergeRequestRow(review, "Reviewer");
    seen.add(String(row.webUrl));
    rows.push(row);
  }
  if (team.pullRequests.length === 0 && team.failed.length > 0 && rows.length === 0) {
    throw new ConnectorError(team.failed.map((failure) => failure.message).join("; "), {
      connector: "gitlab",
    });
  }
  for (const request of team.pullRequests) {
    if (seen.has(request.webUrl) || request.author?.username === me.username) continue;
    const text = `${request.title}\n${request.description ?? ""}`;
    if (!mentionsUser(text, me.username, me.name)) continue;
    rows.push(pullRequestRow(request, "Mention"));
  }
  return { rows: rows.slice(0, 100), truncated: rows.length > 100 };
}

function gitlabMergeRequestRow(mr: MergeRequest, reason: string): Record<string, unknown> {
  const repository = mergeRequestProjectPath(mr) ?? "";
  return {
    id: `gitlab:${repository || mr.project_id}!${mr.iid}`,
    number: mr.iid,
    title: mr.title,
    state: "open",
    repository,
    author: mr.author?.name || mr.author?.username || "",
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    createdAt: mr.created_at?.toISOString() ?? null,
    updatedAt: mr.updated_at.toISOString(),
    webUrl: mr.web_url,
    reason,
  };
}

function pullRequestRow(request: PullRequest, reason: string): Record<string, unknown> {
  return {
    id: request.id,
    number: request.number,
    title: request.title,
    state: request.state,
    repository: request.repository ?? "",
    author: request.author?.name || request.author?.username || "",
    sourceBranch: request.sourceBranch,
    targetBranch: request.targetBranch,
    createdAt: request.createdAt?.toISOString() ?? null,
    updatedAt: request.updatedAt.toISOString(),
    webUrl: request.webUrl,
    reason,
  };
}

function mentionsUser(text: string, username: string, name?: string): boolean {
  const haystack = text.toLowerCase();
  if (username && haystack.includes(`@${username.toLowerCase()}`)) return true;
  const trimmed = name?.trim().toLowerCase();
  return Boolean(trimmed && trimmed.length >= 3 && haystack.includes(trimmed));
}

function pipelineProjects(sources: DatasetSources): string[] {
  const ids = new Set<string>();
  const configured = sources.automationConfig.get();
  if (configured?.projectId) ids.add(configured.projectId);
  for (const schedule of sources.automation.listSchedules()) ids.add(schedule.projectId);
  return [...ids];
}

function canSeeTask(sources: DatasetSources, actor: Actor, taskId: string): boolean {
  const instance = sources.instances.get(taskId);
  return !instance || instance.visibility === "public" || instance.ownerId === actor.id;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

export function catalogOf(datasets: readonly Dataset[]) {
  return datasets.map((dataset) => ({
    id: dataset.id,
    label: dataset.label,
    description: dataset.description,
    requires: dataset.requires,
    fields: dataset.fields,
    ...(dataset.paramsHint ? { paramsHint: dataset.paramsHint } : {}),
  }));
}
