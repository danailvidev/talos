import type { LoopApplicationService } from "./loop-service.ts";
import type { Actor } from "../core/actor.ts";
import type { Logger } from "../logging/logger.ts";
import type { TaskRegistry } from "../core/registry.ts";
import type { ScheduledTask } from "../config/resolve-schedule.ts";
import type { SecretStore } from "../secrets/secret-store.ts";
import { createGitLabClient } from "../connectors/gitlab/client.ts";
import { createJiraClient } from "../connectors/jira/client.ts";
import {
  createDatadogClient,
  datadogLogQuery,
} from "../connectors/datadog/client.ts";
import type {
  DatadogArea,
  DatadogIssueRepository,
  InstanceRepository,
  LogRocketIssueRepository,
  NotificationRepository,
  RunRepository,
} from "./ports.ts";
import type { PullRequestApplicationService } from "./pull-request-service.ts";
import type { DashboardApplicationService } from "./dashboards/service.ts";
import type { AppPermission } from "../../shared/authorization.ts";
import { DashboardQuerySchema } from "../../shared/dashboard.ts";
import type { AssignedTicketService } from "./assigned-tickets.ts";
import type { TicketDetailService } from "./ticket-detail.ts";
import type { ReleaseApplicationService } from "./release-service.ts";
import {
  PULL_REQUEST_STATES,
  type PullRequestScope,
  type PullRequestState,
} from "./pull-requests.ts";

export const ASSISTANT_TOOL_NAMES = [
  "gitlab_merge_requests",
  "gitlab_merge_request",
  "gitlab_repository",
  "jira_assigned_tickets",
  "jira_ticket",
  "jira_search",
  "datadog_issues",
  "datadog_logs",
  "logrocket_issues",
  "talos_tasks",
  "talos_loop_definitions",
  "talos_loop_get",
  "talos_loop_create",
  "talos_loop_update",
  "talos_loop_delete",
  "talos_loop_schedule",
  "talos_task_runs",
  "talos_releases",
  "talos_notifications",
  "talos_dashboard_datasets",
  "talos_dashboard_query",
  "talos_dashboard_list",
  "talos_dashboard_get",
  "talos_dashboard_create",
  "talos_dashboard_update",
  "talos_dashboard_delete",
] as const;

export type AssistantToolName = (typeof ASSISTANT_TOOL_NAMES)[number];

export interface AssistantToolCall {
  name: AssistantToolName;
  arguments: Record<string, unknown>;
}

interface AssistantServiceDeps {
  loops: LoopApplicationService;
  secretsFor(actor: Actor): SecretStore;
  sharedSecrets: SecretStore;
  logger: Logger;
  pullRequests: PullRequestApplicationService;
  assignedTickets: AssignedTicketService;
  ticketDetails: TicketDetailService;
  releases: ReleaseApplicationService;
  taskRegistry: TaskRegistry;
  scheduledTasks(): ScheduledTask[];
  instances: InstanceRepository;
  runs: RunRepository;
  datadogIssues: DatadogIssueRepository;
  logRocketIssues: LogRocketIssueRepository;
  notifications: NotificationRepository;
  dashboards: DashboardApplicationService;
  permissionsFor(actor: Actor): readonly AppPermission[];
}

/**
 * The only application surface the chat model can reach.
 *
 * Loop mutations delegate to the same authorized service as the HTTP API.
 * Connector queries remain bounded and read-only.
 */
export class AssistantApplicationService {
  constructor(private readonly deps: AssistantServiceDeps) {}

  async invoke(
    actor: Actor,
    call: AssistantToolCall,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    switch (call.name) {
      case "talos_loop_definitions": return this.deps.loops.definitions(actor);
      case "talos_loop_get": return this.deps.loops.read(actor, requiredString(call.arguments, "id"));
      case "talos_loop_create": return this.deps.loops.create(actor, call.arguments.config);
      case "talos_loop_update": return this.deps.loops.replace(actor, requiredString(call.arguments, "id"), call.arguments.config);
      case "talos_loop_delete": return this.deps.loops.delete(actor, requiredString(call.arguments, "id"));
      case "talos_loop_schedule": return this.deps.loops.updateSchedule(actor, requiredString(call.arguments, "id"), call.arguments.schedule);
      case "gitlab_merge_requests":
        return await this.gitlabMergeRequests(actor, call.arguments, signal);
      case "gitlab_merge_request":
        return await this.gitlabMergeRequest(actor, call.arguments, signal);
      case "gitlab_repository":
        return await this.gitlabRepository(actor, call.arguments, signal);
      case "jira_assigned_tickets":
        return await this.assignedJiraTickets(actor, signal);
      case "jira_ticket":
        return await this.deps.ticketDetails.get(
          actor,
          requiredString(call.arguments, "key"),
          { signal },
        );
      case "jira_search":
        return await this.jiraSearch(actor, call.arguments, signal);
      case "datadog_issues":
        return this.datadogIssues(call.arguments);
      case "datadog_logs":
        return await this.datadogLogs(call.arguments, signal);
      case "logrocket_issues":
        return this.deps.logRocketIssues.list({
          includeDismissed: optionalBoolean(call.arguments, "includeDismissed") ?? false,
          limit: boundedInteger(call.arguments, "limit", 20, 50),
        });
      case "talos_tasks":
        return this.talosTasks(actor);
      case "talos_task_runs":
        return this.talosTaskRuns(actor, call.arguments);
      case "talos_releases":
        return await this.talosReleases(actor, call.arguments, signal);
      case "talos_notifications":
        return this.talosNotifications(actor, call.arguments);
      case "talos_dashboard_datasets":
        return this.deps.dashboards.catalog(this.dashboardActor(actor));
      case "talos_dashboard_query":
        return await this.dashboardQuery(actor, call.arguments, signal);
      case "talos_dashboard_list":
        return this.deps.dashboards.list(this.dashboardActor(actor));
      case "talos_dashboard_get":
        return this.deps.dashboards.get(this.dashboardActor(actor), requiredString(call.arguments, "id"));
      case "talos_dashboard_create":
        return this.deps.dashboards.create(this.dashboardActor(actor), call.arguments);
      case "talos_dashboard_update":
        return this.dashboardUpdate(actor, call.arguments);
      case "talos_dashboard_delete":
        return { deleted: this.deps.dashboards.delete(this.dashboardActor(actor), requiredString(call.arguments, "id")) };
    }
  }

  private async gitlabMergeRequests(
    actor: Actor,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const scope = optionalString(args, "scope") === "team" ? "team" : "mine";
    const states = optionalStringArray(args, "states")?.filter(
      (state): state is PullRequestState =>
        (PULL_REQUEST_STATES as readonly string[]).includes(state),
    );
    return await this.deps.pullRequests.list(actor, scope satisfies PullRequestScope, {
      ...(states?.length ? { states } : {}),
      limit: boundedInteger(args, "limit", 20, 50),
      signal,
    });
  }

  private async gitlabMergeRequest(
    actor: Actor,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = requiredString(args, "id");
    const detail = await this.deps.pullRequests.detail(actor, id, { signal });
    if (!optionalBoolean(args, "includeChanges")) return { detail };
    const changes = await this.deps.pullRequests.changes(actor, id, { signal });
    return { detail, changes };
  }

  private async gitlabRepository(
    actor: Actor,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const project = requiredString(args, "project");
    const operation = requiredString(args, "operation");
    const gitlab = createGitLabClient(this.deps.secretsFor(actor), {
      logger: this.deps.logger,
      priority: "interactive",
    });

    if (operation === "branches") {
      return await gitlab.listBranches(project, {
        search: optionalString(args, "search"),
        limit: boundedInteger(args, "limit", 20, 50),
        signal,
      });
    }
    if (operation === "tree") {
      const entries = await gitlab.listTree(project, {
        ref: requiredString(args, "ref"),
        path: optionalString(args, "path"),
        signal,
      });
      return entries.slice(0, 200);
    }
    if (operation === "file") {
      const result = await gitlab.getFileRaw(
        project,
        requiredString(args, "path"),
        requiredString(args, "ref"),
        signal,
      );
      return { ...result, content: clampText(result.content, 40_000) };
    }
    if (operation === "pipelines") {
      return await gitlab.listPipelines({
        project,
        ref: optionalString(args, "ref"),
        status: optionalString(args, "status"),
        newestFirst: true,
        limit: boundedInteger(args, "limit", 10, 30),
        signal,
      });
    }
    throw new Error(`Unsupported GitLab repository operation '${operation}'.`);
  }

  private async jiraSearch(
    actor: Actor,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const jira = createJiraClient(this.deps.secretsFor(actor), {
      logger: this.deps.logger,
      priority: "interactive",
    });
    const issues = await jira.searchIssues(requiredString(args, "jql"), {
      limit: boundedInteger(args, "limit", 20, 50),
      fields: ["summary", "status", "issuetype", "priority", "assignee", "updated"],
      signal,
    });
    return issues.map((issue) => ({ ...issue, url: jira.issueUrl(issue.key) }));
  }

  private async assignedJiraTickets(
    actor: Actor,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const result = await this.deps.assignedTickets.list(actor, { signal });
    return { ...result, tickets: result.tickets.slice(0, 100) };
  }

  private datadogIssues(args: Record<string, unknown>): unknown {
    const area = optionalString(args, "area");
    return this.deps.datadogIssues.list({
      includeDismissed: optionalBoolean(args, "includeDismissed") ?? false,
      team: optionalString(args, "team"),
      ...(isDatadogArea(area) ? { area } : {}),
      limit: boundedInteger(args, "limit", 20, 50),
    });
  }

  private async datadogLogs(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const minutes = boundedInteger(args, "minutes", 60, 24 * 60);
    const to = new Date();
    const from = new Date(to.getTime() - minutes * 60_000);
    const query = optionalString(args, "query") ?? datadogLogQuery(this.deps.sharedSecrets);
    const client = createDatadogClient(this.deps.sharedSecrets, {
      logger: this.deps.logger,
    });
    const window = { query, from, to, signal };
    const [count, samples] = await Promise.all([
      client.count(window),
      client.sampleLogs(window, boundedInteger(args, "limit", 10, 25)),
    ]);
    return { query, from, to, count, samples, explorerUrl: client.explorerUrl(query, { from, to }) };
  }

  private talosTasks(actor: Actor): unknown {
    return this.deps.scheduledTasks()
      .filter((scheduled) => this.canAccessTask(actor, scheduled.id))
      .map((scheduled) => {
        const task = this.deps.taskRegistry.require(scheduled.id);
        return {
          id: task.id,
          name: task.name,
          kind: task.kind,
          description: task.description,
          enabled: scheduled.enabled.value,
          trigger: scheduled.trigger.value,
          lastRun: this.deps.runs.lastRun(task.id),
        };
      });
  }

  private talosTaskRuns(actor: Actor, args: Record<string, unknown>): unknown {
    const taskId = requiredString(args, "taskId");
    if (!this.canAccessTask(actor, taskId)) throw new Error(`No task '${taskId}'.`);
    return this.deps.runs.recentRuns(taskId, boundedInteger(args, "limit", 10, 30));
  }

  private async talosReleases(
    actor: Actor,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (optionalBoolean(args, "history")) {
      return await this.deps.releases.history(actor, {
        environment: optionalString(args, "environment"),
        limit: boundedInteger(args, "limit", 20, 50),
        signal,
      });
    }
    return await this.deps.releases.read(actor, signal);
  }

  private talosNotifications(actor: Actor, args: Record<string, unknown>): unknown {
    const limit = boundedInteger(args, "limit", 20, 50);
    return this.deps.notifications
      .list({ unreadOnly: optionalBoolean(args, "unreadOnly") ?? false, limit: limit * 2 })
      .filter((notification) => {
        if (!notification.taskRunId) return true;
        const run = this.deps.runs.getRun(notification.taskRunId);
        return !run || this.canAccessTask(actor, run.taskId);
      })
      .slice(0, limit);
  }

  private dashboardActor(actor: Actor) {
    return { ...actor, permissions: this.deps.permissionsFor(actor) };
  }

  private async dashboardQuery(actor: Actor, args: Record<string, unknown>, signal?: AbortSignal) {
    const parsed = DashboardQuerySchema.safeParse(args);
    if (!parsed.success) throw new Error("Dashboard query is invalid.");
    const result = await this.deps.dashboards.query(this.dashboardActor(actor), parsed.data, {
      bypass: false,
      ...(signal ? { signal } : {}),
    });
    return { ...result, rows: result.rows.slice(0, 25), rowCount: result.rows.length };
  }

  private dashboardUpdate(actor: Actor, args: Record<string, unknown>) {
    const id = requiredString(args, "id");
    const patch = { ...args };
    delete patch.id;
    const updated = this.deps.dashboards.update(this.dashboardActor(actor), id, patch);
    if (!updated) throw new Error(`No dashboard '${id}'.`);
    return updated;
  }

  private canAccessTask(actor: Actor, taskId: string): boolean {
    const instance = this.deps.instances.get(taskId);
    return !instance || instance.visibility === "public" || instance.ownerId === actor.id;
  }
}

function optionalString(
  args: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = args[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = optionalString(args, name);
  if (!value) throw new Error(`'${name}' is required.`);
  return value;
}

function optionalBoolean(
  args: Record<string, unknown>,
  name: string,
): boolean | undefined {
  return typeof args[name] === "boolean" ? args[name] : undefined;
}

function optionalStringArray(
  args: Record<string, unknown>,
  name: string,
): string[] | undefined {
  const value = args[name];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function boundedInteger(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  max: number,
): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), max);
}

function isDatadogArea(value: string | undefined): value is DatadogArea {
  return ["frontend", "backend", "infrastructure", "data", "unknown"].includes(value ?? "");
}

function clampText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n\n[truncated]`;
}
