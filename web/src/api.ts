import type {
  AccountDeletedView,
  AdminFeedbackView,
  AdminLogsView,
  AdminRoleInput,
  AdminRolesView,
  AdminRoleView,
  AdminUserCreate,
  AdminUserDetailView,
  AdminUserInvitationView,
  AdminUserPatch,
  AdminUsersView,
  AdminUserView,
  AgentAccountsView,
  AgentAccountView,
  AgentRunPreferencesPatch,
  AgentRunPreferencesView,
  AgentConnectionView,
  AgentLoginView,
  AgentUsageReportView,
  AutomationConfigPatch,
  AutomationConfigView,
  AutomationDashboardView,
  AutomationAiTriageActionView,
  AutomationBulkTicketActionPatch,
  AutomationBulkTicketActionView,
  AutomationFailureAssignmentPatch,
  AutomationFailureAssignmentView,
  AutomationFailureClusterDetailView,
  AutomationFailureClusterListView,
  AutomationFailureInboxView,
  AutomationTicketActionPatch,
  AutomationTicketActionView,
  AutomationTicketDraftView,
  AutomationPipelineDetailView,
  AutomationScheduleDiscoveryResponse,
  AssistantChatRequest,
  AssistantMessage,
  AssistantStreamEvent,
  ConfluenceReleaseDetailView,
  ConfluenceReleasesView,
  AuthSession,
  BranchView,
  CreateTaskInstance,
  E2eTestMrRequest,
  E2eTestSettingsPatch,
  E2eTestSettingsView,
  GeneralSettings,
  GeneralSettingsPatch,
  FeedbackRequest,
  FeedbackView,
  PendingFeedbackView,
  FixIssueDefaultsView,
  GitLabProjectView,
  IntegrationsPatch,
  IntegrationsView,
  JiraIssueView,
  JiraUserView,
  JobCancelResult,
  LogRocketFixResult,
  LogRocketIssuesView,
  LogRocketStatePatch,
  DatadogAreaView,
  DatadogActivityView,
  DatadogAiTriageResult,
  DatadogFixResult,
  DatadogIssuesView,
  DatadogRoutingRulePatch,
  DatadogRoutingRuleView,
  DatadogRoutingView,
  DatadogScanResult,
  DatadogServiceTargetPatch,
  DatadogServiceTargetView,
  DatadogServiceTargetsView,
  DatadogStatePatch,
  FlakySpecFileResult,
  FlakySpecsView,
  FlakySpecStatePatch,
  MergeRequestView,
  MrActionRequest,
  MrActionResult,
  NotificationsView,
  NotificationSubscriptionsPatch,
  NotificationSubscriptionsView,
  PreferencesView,
  ProfilePatch,
  ProfileView,
  PromptsPatch,
  PromptsView,
  ProviderAccessPatch,
  ProviderAccessView,
  RegressionTestResult,
  RegressionTestRequest,
  RunJiraOutcomesView,
  DeployWatchesView,
  ReleaseDeploymentStatusRequest,
  ReleaseDeploymentStatusView,
  ReleaseConfigPatch,
  ReleaseConfigView,
  ReleaseHistoryView,
  ReleaseRevertPreviewView,
  ReleaseRevertRequest,
  ReleaseUploadRequest,
  ReleaseUploadResultView,
  ReleasesView,
  ResolvedModelsView,
  PullRequestActionId,
  PullRequestActionResult,
  PullRequestActionsView,
  PullRequestActiveActionsView,
  PullRequestActivityView,
  PullRequestChangesView,
  PullRequestDetailView,
  PullRequestRepoFilterView,
  PullRequestRunPageView,
  PullRequestScope,
  PullRequestState,
  PullRequestsView,
  PlanDecisionRequest,
  PlanInboxView,
  SchedulePatch,
  ScheduleView,
  SearchResult,
  SlackChannelsView,
  SlackActivityView,
  SlackChannelSelectionPatch,
  SlackConnectionView,
  SlackConversationMembersView,
  SlackConversationDetailsPatch,
  SlackConversationDetailsView,
  SlackConversationSearchFilters,
  SlackConversationSearchView,
  SlackConversationView,
  SlackDirectMessageRequest,
  SlackInboxView,
  SlackMessageSendRequest,
  SlackMessageSendResult,
  SlackMessageUpdateRequest,
  SlackMessageUpdateResult,
  SlackMessagesView,
  SlackOAuthStartView,
  SlackReactionPatch,
  SlackReadPatch,
  SlackUserProfileView,
  SlackWorkspaceUsersView,
  StepView,
  LogLineView,
  OrchestrationView,
  SystemView,
  TalosUsersView,
  TaskDeletedView,
  TaskDetail,
  TaskIssuePage,
  TaskRunPage,
  TaskRunStartedView,
  TaskSummary,
  TicketActionId,
  TicketActionRequest,
  TicketDetailResponse,
  TicketGraphView,
  TicketPlanView,
  TicketTextAttachmentResponse,
  TicketStatusChangeResult,
  UpdateTaskInstance,
} from "../../shared/api-contract.ts";

export * from "../../shared/api-contract.ts";

export interface AgentUsageFilter {
  days: 7 | 30 | 90 | 365;
  /** Global usage is accepted only for the built-in administrator role. */
  scope?: "all";
  account?: string;
  source?: "task" | "assistant" | "e2e";
  limit: number;
  offset: number;
}

let unauthorizedHandler: (() => void) | undefined;

/** Called once from `App` so a 401 on any non-auth request can drop back to the login screen. */
export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler;
}

async function request<T>(
  path: string,
  options?: {
    method?: "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    formData?: FormData;
    /**
     * Aborts the request. Worth threading on the expensive reads only: the
     * server passes `request.signal` down into the forge calls, so an abort on
     * navigation actually stops a GitLab fan-out mid-flight rather than paying
     * for a page nobody is looking at any more.
     */
    signal?: AbortSignal;
    /**
     * Skips the server's short-lived response cache for this one read. What the
     * refresh buttons send: they promise the latest from the forge, and that
     * promise has to survive a cache sitting in front of it.
     */
    bypassCache?: boolean;
  },
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options?.body !== undefined) headers["content-type"] = "application/json";
  if (options?.bypassCache) headers["cache-control"] = "no-store";

  const response = await fetch(path, {
    method: options?.method,
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(options?.formData
      ? { body: options.formData }
      : options?.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
  });
  const text = await response.text();

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `${path} returned ${response.status} and a non-JSON body — is the TALOS server running?`,
    );
  }

  if (!response.ok) {
    // Auth endpoints 401 on bad credentials / no session, which is expected
    // and already handled by their callers — only mid-session expiry on
    // everything else should kick the user back to the login screen.
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      unauthorizedHandler?.();
    }
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `request failed with ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

const get = <T>(path: string, options?: ReadOptions) => request<T>(path, options);

/** Cancellation and cache-bypass, for the reads where either is worth the parameter. */
export interface ReadOptions {
  signal?: AbortSignal;
  bypassCache?: boolean;
}

export interface ReleaseHistoryReadOptions extends ReadOptions {
  environment?: string;
  /** ISO instant used as GitLab's inclusive lower bound. */
  since?: string;
}
const send = <T>(
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
) => request<T>(path, { method, body });

async function streamAssistant(
  body: AssistantChatRequest,
  onEvent: (event: AssistantStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/assistant/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    if (response.status === 401) unauthorizedHandler?.();
    const text = await response.text();
    let message = `request failed with ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      if (text.trim()) message = text.trim();
    }
    throw new Error(message);
  }
  if (!response.body) throw new Error("Assistant returned no response stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line) as AssistantStreamEvent);
    }
    if (done) {
      if (pending.trim()) onEvent(JSON.parse(pending) as AssistantStreamEvent);
      return;
    }
  }
}

/**
 * The three triage lists' filters, named because each one is now sent twice: once
 * on the GET, and again on the POST that changes a row's state.
 *
 * That second one is what makes them worth a type. Those POSTs answer with the
 * whole list, and the caller writes the answer straight into the cache entry it is
 * already showing rather than paying for a refetch — which is only correct if the
 * server was told which entry that is. Send a dismissal without the filter and the
 * response describes a list nobody asked for.
 */
export interface LogRocketIssuesFilter {
  includeDismissed?: boolean;
}
export interface DatadogIssuesFilter {
  includeDismissed?: boolean;
  team?: string;
  area?: DatadogAreaView;
}
export interface FlakySpecsFilter {
  includeDismissed?: boolean;
  project?: string;
}

export interface AutomationDashboardFilter {
  days: 1 | 7 | 30;
  scheduleId?: number;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface AutomationFailureClusterFilter {
  limit: 25 | 50;
  offset: number;
  search?: string;
  jobId?: number;
  suiteIndex?: number;
  state?: "untriaged" | "ticketed" | "active-mr";
}

export interface AutomationFailureInboxFilter {
  days: 1 | 7 | 30;
  scheduleId?: number;
  pipelineId?: number;
  presence: "current" | "recent";
  state?: "untriaged" | "ticketed" | "active-mr";
  search?: string;
  limit: 25 | 50;
  offset: number;
}

/** `?a=b` including the leading `?`, or `""` — never a bare `?`. */
const query = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value) search.set(name, value);
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
};

const flag = (value: boolean | undefined) => (value ? "1" : undefined);

const logRocketQuery = (filter?: LogRocketIssuesFilter) =>
  query({ includeDismissed: flag(filter?.includeDismissed) });

const datadogQuery = (filter?: DatadogIssuesFilter) =>
  query({
    includeDismissed: flag(filter?.includeDismissed),
    team: filter?.team,
    area: filter?.area,
  });

const flakySpecsQuery = (filter?: FlakySpecsFilter) =>
  query({
    includeDismissed: flag(filter?.includeDismissed),
    project: filter?.project,
  });

export interface DashboardSummary {
  id: string;
  name: string;
  description?: string;
  updatedAt: string;
}

export interface DashboardListView {
  dashboards: DashboardSummary[];
}

export interface DashboardDetail {
  id: string;
  ownerUserId: string;
  name: string;
  description?: string;
  version: 1;
  widgets: import("../../shared/dashboard.ts").Widget[];
  createdAt: string;
  updatedAt: string;
}

export interface DashboardDatasetList {
  datasets: import("../../shared/dashboard.ts").DatasetCatalogEntry[];
}

export type DashboardQuery = import("../../shared/dashboard.ts").DashboardQuery;
export type DashboardQueryResult = import("../../shared/dashboard.ts").QueryResult;
export type DashboardSpecInput = import("../../shared/dashboard.ts").DashboardSpec;

export const api = {
  assistantChat: streamAssistant,
  session: () => get<AuthSession>("/api/auth/session"),
  login: (email: string, password: string) =>
    send<AuthSession>("/api/auth/login", "POST", { email, password }),
  logout: () => send<Record<string, never>>("/api/auth/logout", "POST"),
  forgotPassword: (email: string) =>
    send<{ ok: boolean }>("/api/auth/forgot-password", "POST", { email }),
  resetPassword: (token: string, password: string) =>
    send<{ ok: boolean }>("/api/auth/reset-password", "POST", { token, password }),
  acceptInvitation: (token: string, password: string) =>
    send<AuthSession>("/api/auth/accept-invitation", "POST", { token, password }),
  adminUsers: () => get<AdminUsersView>("/api/admin/users"),
  adminRoles: () => get<AdminRolesView>("/api/admin/roles"),
  createAdminRole: (body: AdminRoleInput) =>
    send<AdminRoleView>("/api/admin/roles", "POST", body),
  updateAdminRole: (id: string, body: AdminRoleInput) =>
    send<AdminRoleView>(`/api/admin/roles/${encodeURIComponent(id)}`, "PATCH", body),
  deleteAdminRole: (id: string) =>
    send<{ deleted: true }>(`/api/admin/roles/${encodeURIComponent(id)}`, "DELETE"),
  adminUser: (id: string) =>
    get<AdminUserDetailView>(`/api/admin/users/${encodeURIComponent(id)}`),
  createAdminUser: (body: AdminUserCreate) =>
    send<AdminUserInvitationView>("/api/admin/users", "POST", body),
  createAdminUserInvitation: (id: string) =>
    send<AdminUserInvitationView>(
      `/api/admin/users/${encodeURIComponent(id)}/invitation`,
      "POST",
    ),
  updateAdminUser: (id: string, body: AdminUserPatch) =>
    send<AdminUserView>(`/api/admin/users/${encodeURIComponent(id)}`, "PATCH", body),
  deleteAdminUser: (id: string) =>
    send<AccountDeletedView>(`/api/admin/users/${encodeURIComponent(id)}`, "DELETE"),
  adminLogs: (limit = 200) => get<AdminLogsView>(`/api/admin/logs?limit=${limit}`),
  adminOrchestration: () => get<OrchestrationView>("/api/admin/orchestration"),
  drainOrchestration: () =>
    send<{ capacity: OrchestrationView["capacity"] }>("/api/admin/orchestration/drain", "POST"),
  resumeOrchestration: () =>
    send<{ capacity: OrchestrationView["capacity"] }>("/api/admin/orchestration/resume", "POST"),
  holdJob: (id: string, reason = "held by operator") =>
    send(`/api/jobs/${encodeURIComponent(id)}/hold`, "POST", { reason }),
  resumeJob: (id: string) =>
    send(`/api/jobs/${encodeURIComponent(id)}/resume`, "POST"),
  setJobPriority: (id: string, priority: number) =>
    send(`/api/jobs/${encodeURIComponent(id)}/priority`, "POST", { priority }),
  adminFeedback: () => get<AdminFeedbackView>("/api/admin/feedback"),
  deleteAdminFeedback: (id: string) =>
    send<{ deleted: true }>(`/api/admin/feedback/${encodeURIComponent(id)}`, "DELETE"),
  system: () => get<SystemView>("/api/system"),
  tasks: (
    query: string,
    page?: { limit: number; offset: number },
    options: ReadOptions = {},
  ) => {
    const params = new URLSearchParams({
        ...(query ? { q: query } : {}),
        ...(page ? { limit: String(page.limit), offset: String(page.offset) } : {}),
    });
    const suffix = params.size > 0 ? `?${params}` : "";
    return get<{ tasks: TaskSummary[]; total: number }>(`/api/tasks${suffix}`, options);
  },
  task: (id: string) =>
    get<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`),
  taskIssues: (id: string, { limit, offset }: { limit: number; offset: number }) =>
    get<TaskIssuePage>(
      `/api/tasks/${encodeURIComponent(id)}/issues?limit=${limit}&offset=${offset}`,
    ),
  taskRuns: (id: string, { limit, offset }: { limit: number; offset: number }) =>
    get<TaskRunPage>(
      `/api/tasks/${encodeURIComponent(id)}/runs?limit=${limit}&offset=${offset}`,
    ),
  createInstance: (body: CreateTaskInstance) =>
    send<TaskDetail>("/api/tasks", "POST", body),
  updateInstance: (id: string, body: UpdateTaskInstance) =>
    send<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`, "PUT", body),
  /** Owner-only, and refused while a run is in flight — see `routeTaskDelete`. */
  deleteInstance: (id: string) =>
    send<TaskDeletedView>(`/api/tasks/${encodeURIComponent(id)}`, "DELETE"),
  gitlabMergeRequests: (project: string, search: string) =>
    get<{ mergeRequests: MergeRequestView[] }>(
      `/api/gitlab/merge-requests?project=${encodeURIComponent(project)}` +
        (search ? `&search=${encodeURIComponent(search)}` : ""),
    ),
  gitlabGroupProjects: (group: string) =>
    get<{ projects: GitLabProjectView[] }>(
      `/api/gitlab/projects?group=${encodeURIComponent(group)}`,
    ),
  gitlabBranches: (project: string, search: string) =>
    get<{ branches: BranchView[] }>(
      `/api/gitlab/branches?project=${encodeURIComponent(project)}` +
        (search ? `&search=${encodeURIComponent(search)}` : ""),
    ),
  /** The coding agents this host is signed in to — the custom loop's Agent dropdown. */
  agents: () => get<{ agents: AgentConnectionView[] }>("/api/agents"),

  /** The catalog of connectable agents, with the accounts you have added. */
  agentAccounts: () => get<AgentAccountsView>("/api/me/agent-accounts"),
  agentUsage: (filter: AgentUsageFilter) =>
    get<AgentUsageReportView>(
      `${filter.scope === "all" ? "/api/admin/agent-usage" : "/api/me/agent-usage"}${query({
        days: String(filter.days),
        account: filter.account,
        source: filter.source,
        limit: String(filter.limit),
        offset: String(filter.offset),
      })}`,
    ),
  /** Model defaults for agent work this developer starts directly. */
  agentRunPreferences: () =>
    get<AgentRunPreferencesView>("/api/me/agent-run-preferences"),
  setAgentRunPreferences: (body: AgentRunPreferencesPatch) =>
    send<AgentRunPreferencesView>("/api/me/agent-run-preferences", "PUT", body),
  /** For the paste-a-credential options. The delegated ones go through `startAgentLogin`. */
  /** `values` is keyed by the option's field names — `{ AWS_REGION: "us-east-1", … }`. */
  addAgentAccount: (body: {
    optionId: string;
    label: string;
    values: Record<string, string>;
  }) =>
    send<AgentAccountView>("/api/me/agent-accounts", "POST", body),
  /** Points every agent run at this account, install-wide, from the next run on. */
  useAgentAccountForRuns: (id: string) =>
    send<AgentAccountView>("/api/me/agent-accounts/use-for-runs", "POST", { id }),
  deleteAgentAccount: (id: string) =>
    send<{ id: string; removed: boolean }>(
      `/api/me/agent-accounts?id=${encodeURIComponent(id)}`,
      "DELETE",
    ),
  /** Runs the vendor's own login on the host — poll `agentLogin` for what it prints. */
  startAgentLogin: (body: { optionId: string; label: string }) =>
    send<AgentLoginView>("/api/me/agent-accounts/login", "POST", body),
  agentLogin: (id: string) =>
    get<AgentLoginView>(`/api/me/agent-accounts/login?id=${encodeURIComponent(id)}`),
  /** Answers whatever the command asked for — the pasted code, usually. */
  respondAgentLogin: (id: string, input: string) =>
    send<AgentLoginView>(`/api/me/agent-accounts/login?id=${encodeURIComponent(id)}`, "PUT", {
      input,
    }),
  cancelAgentLogin: (id: string) =>
    send<{ id: string }>(
      `/api/me/agent-accounts/login?id=${encodeURIComponent(id)}`,
      "DELETE",
    ),
  jiraIssues: (search: string, options?: { statuses?: string[] }) =>
    get<{ issues: JiraIssueView[] }>(
      `/api/jira/issues?search=${encodeURIComponent(search)}` +
        (options?.statuses?.length
          ? `&statuses=${encodeURIComponent(options.statuses.join(","))}`
          : ""),
    ),
  jiraUsers: (project: string) =>
    get<{ users: JiraUserView[] }>(
      `/api/jira/users?project=${encodeURIComponent(project)}`,
    ),
  pullRequests: (
    scope: PullRequestScope,
    states: readonly PullRequestState[],
    options?: ReadOptions,
  ) =>
    get<PullRequestsView>(
      `/api/pull-requests?scope=${scope}&states=${states.join(",")}`,
      options,
    ),
  // The id is provider-qualified and contains slashes (`gitlab:group/proj!12`), so
  // it is encoded whole — the router matches one path segment and decodes it back.
  pullRequest: (id: string, options?: ReadOptions) =>
    get<PullRequestDetailView>(`/api/pull-requests/${encodeURIComponent(id)}`, options),
  // A `sha` narrows the diff to one commit on the branch. The server refuses a sha
  // that is not on this merge request, so this is not a way to read the project.
  pullRequestChanges: (id: string, options?: ReadOptions & { sha?: string }) =>
    get<PullRequestChangesView>(
      `/api/pull-requests/${encodeURIComponent(id)}/changes${
        options?.sha ? `/${encodeURIComponent(options.sha)}` : ""
      }`,
      options,
    ),
  pullRequestActions: (id: string) =>
    get<PullRequestActionsView>(`/api/pull-requests/${encodeURIComponent(id)}/actions`),
  pullRequestActivity: (id: string) =>
    get<PullRequestActivityView>(`/api/pull-requests/${encodeURIComponent(id)}/activity`),
  // Every recorded run against this merge request, whoever started it — unlike
  // `pullRequestActivity`, which reads the job queue and so covers only the
  // toolbar's own clicks (plus anything still queued, which has no run yet).
  pullRequestRuns: (id: string, { limit, offset }: { limit: number; offset: number }) =>
    get<PullRequestRunPageView>(
      `/api/pull-requests/${encodeURIComponent(id)}/runs?limit=${limit}&offset=${offset}`,
    ),
  runPullRequestAction: (id: string, action: PullRequestActionId) =>
    send<PullRequestActionResult>(
      `/api/pull-requests/${encodeURIComponent(id)}/actions`,
      "POST",
      { action },
    ),
  runPullRequestRevision: (
    id: string,
    instruction: string,
    history: AssistantMessage[],
  ) =>
    send<PullRequestActionResult>(
      `/api/pull-requests/${encodeURIComponent(id)}/actions`,
      "POST",
      { action: "revise", instruction, history },
    ),
  // Local to the job queue, no forge call — safe for the list page to poll on a
  // short interval for a running badge, unlike `pullRequests` itself.
  pullRequestActiveActions: () =>
    get<PullRequestActiveActionsView>("/api/pull-requests/active-actions"),
  ticketGraph: (
    scope: PullRequestScope,
    options?: ReadOptions,
  ) =>
    get<TicketGraphView>(
      `/api/graph/tickets?scope=${scope}`,
      options,
    ),
  /**
   * One ticket in full, fetched when its node is selected rather than carried on
   * the graph — see `TicketDetailView` for why the two are separate reads.
   */
  ticket: (key: string, options?: ReadOptions) =>
    get<TicketDetailResponse>(`/api/tickets/${encodeURIComponent(key)}`, options),
  ticketAttachmentText: (
    key: string,
    attachmentId: string,
    options?: ReadOptions,
  ) =>
    get<TicketTextAttachmentResponse>(
      `/api/tickets/${encodeURIComponent(key)}/attachments/${encodeURIComponent(attachmentId)}/text`,
      options,
    ),
  /**
   * The implementation plan waiting on this ticket, plus the plans that came before
   * it. A separate read from `ticket` and from the graph: the document is kilobytes
   * of markdown and only the Plan tab ever wants it.
   */
  ticketPlan: (key: string, options?: ReadOptions) =>
    get<TicketPlanView>(`/api/tickets/${encodeURIComponent(key)}/plan`, options),
  /** Every plan waiting on somebody, across every ticket. */
  planInbox: () => get<PlanInboxView>("/api/plans"),
  /**
   * Approve or reject one plan. On approve, `body` is the text the reviewer signed
   * off — edits included — and it is what the container is handed, so it is sent
   * whether or not it was edited rather than falling back to the draft server-side.
   */
  decidePlan: (planId: string, body: PlanDecisionRequest) =>
    send<MrActionResult>(`/api/plans/${encodeURIComponent(planId)}/decision`, "POST", body),
  runMrAction: (body: MrActionRequest) =>
    send<MrActionResult>("/api/graph/mr-action", "POST", body),
  /** One of a ticket node's actions — see `TicketActionId`. */
  runTicketAction: (
    issueKey: string,
    action: TicketActionId,
    options: Pick<TicketActionRequest, "targetBranch" | "pullRequest"> = {},
  ) =>
    send<MrActionResult>("/api/graph/ticket-action", "POST", {
      issueKey,
      action,
      ...(options.targetBranch === undefined ? {} : { targetBranch: options.targetBranch }),
      ...(options.pullRequest === undefined ? {} : { pullRequest: options.pullRequest }),
    } satisfies TicketActionRequest),
  writeE2eTestMr: (body: E2eTestMrRequest) =>
    send<MrActionResult>("/api/e2e/test-mr", "POST", body),
  /** Dragging a ticket to a new board column — see `TicketStatusChangeResult`. */
  setTicketStatus: (issueKey: string, status: string, statusIds?: string[]) =>
    send<TicketStatusChangeResult>("/api/graph/ticket-status", "POST", {
      issueKey,
      status,
      ...(statusIds ? { statusIds } : {}),
    }),
  // Null until the developer sets it — the graph's fix button explains itself
  // from that, rather than failing on the click.
  fixIssueDefaults: () => get<FixIssueDefaultsView | null>("/api/me/fix-issue-defaults"),
  setFixIssueDefaults: (body: FixIssueDefaultsView) =>
    send<FixIssueDefaultsView>("/api/me/fix-issue-defaults", "PUT", body),
  /**
   * Every stored preference in one read — see `PreferencesView` for why it is not
   * one request per key.
   */
  preferences: () => get<PreferencesView>("/api/me/preferences"),
  /** One key. `null` clears it rather than storing null; see `PreferencePatch`. */
  setPreference: (key: string, value: unknown) =>
    send<PreferencesView>("/api/me/preferences", "PUT", { key, value }),
  pullRequestRepoFilter: () => get<PullRequestRepoFilterView>("/api/me/pull-request-repos"),
  setPullRequestRepoFilter: (repositories: string[]) =>
    send<PullRequestRepoFilterView>("/api/me/pull-request-repos", "PUT", { repositories }),
  notifications: (unreadOnly?: boolean) =>
    get<NotificationsView>(`/api/notifications${unreadOnly ? "?unreadOnly=1" : ""}`),
  markNotificationsRead: () => send<{ ok: boolean }>("/api/notifications/read-all", "POST"),
  /** Which notification kinds reach the bell — My notifications. */
  notificationSubscriptions: () =>
    get<NotificationSubscriptionsView>("/api/me/notification-subscriptions"),
  /**
   * The whole set at once — what Save sends. Answers with the saved list, so the
   * cache needs no refetch.
   */
  setNotificationSubscriptions: (body: NotificationSubscriptionsPatch) =>
    send<NotificationSubscriptionsView>("/api/me/notification-subscriptions", "PUT", body),

  /** The signed-in developer's own account — My profile. */
  profile: () => get<ProfileView>("/api/me/profile"),
  /** Display name only; the address is the login and is not editable. */
  updateProfile: (body: ProfilePatch) => send<ProfileView>("/api/me/profile", "PUT", body),
  /** Password re-entry, then gone — see `routeDeleteMyAccount`. */
  deleteAccount: (password: string) =>
    send<AccountDeletedView>("/api/me/profile", "DELETE", { password }),
  search: (query: string, options?: ReadOptions) =>
    get<SearchResult>(
      `/api/search${query ? `?q=${encodeURIComponent(query)}` : ""}`,
      options,
    ),
  steps: (executionId: string) =>
    get<{ executionId: string; steps: StepView[]; logs?: LogLineView[] }>(
      `/api/task-runs/${encodeURIComponent(executionId)}/steps?logs=none`,
    ),
  runJiraOutcomes: (executionId: string) =>
    get<RunJiraOutcomesView>(
      `/api/task-runs/${encodeURIComponent(executionId)}/jira-outcomes`,
    ),
  logPage: (executionId: string, afterLogId: number, limit = 200) =>
    get<{
      executionId: string;
      logs: LogLineView[];
      nextCursor: number;
      hasMore: boolean;
      status: "running" | "success" | "failure" | "cancelled";
    }>(
      `/api/task-runs/${encodeURIComponent(executionId)}/logs?afterLogId=${afterLogId}&limit=${limit}`,
    ),
  logTail: (executionId: string, beforeLogId?: number, limit = 500) =>
    get<{
      executionId: string;
      logs: LogLineView[];
      previousCursor: number;
      hasOlder: boolean;
      status: "running" | "success" | "failure" | "cancelled";
    }>(
      `/api/task-runs/${encodeURIComponent(executionId)}/logs?${
        beforeLogId == null ? "tail=1" : `beforeLogId=${beforeLogId}`
      }&limit=${limit}`,
    ),
  updateSchedule: (id: string, patch: SchedulePatch) =>
    send<ScheduleView>(
      `/api/tasks/${encodeURIComponent(id)}/schedule`,
      "PUT",
      patch,
    ),
  clearSchedule: (id: string) =>
    send<ScheduleView>(
      `/api/tasks/${encodeURIComponent(id)}/schedule`,
      "DELETE",
    ),
  runTask: (id: string, params?: unknown) =>
    send<TaskRunStartedView>(
      `/api/tasks/${encodeURIComponent(id)}/run`,
      "POST",
      params,
    ),
  cancelTask: (id: string) =>
    send<{ taskId: string; runs: { executionId: string; status: string }[] }>(
      `/api/tasks/${encodeURIComponent(id)}/cancel`,
      "POST",
    ),
  cancelRun: (executionId: string) =>
    send<{ executionId: string; status: string }>(
      `/api/task-runs/${encodeURIComponent(executionId)}/cancel`,
      "POST",
    ),
  /**
   * Drops a queued job, or aborts the run of one already leased.
   *
   * Not `cancelRun` on the job's `executionId`: a queued job has no run yet, and
   * cancelling only the run of a leased one lets the queue hand the work to the
   * next worker (see `CancellationService.cancelJob`).
   */
  cancelJob: (jobId: string) =>
    send<JobCancelResult>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, "POST"),
  settings: () => get<GeneralSettings>("/api/settings"),
  resolvedModels: () => get<ResolvedModelsView>("/api/settings/resolved-models"),
  updateSettings: (patch: GeneralSettingsPatch) =>
    send<GeneralSettings>("/api/settings", "PUT", patch),
  e2eTestSettings: () => get<E2eTestSettingsView>("/api/settings/e2e-tests"),
  updateE2eTestSettings: (patch: E2eTestSettingsPatch) =>
    send<E2eTestSettingsView>("/api/settings/e2e-tests", "PUT", patch),
  prompts: () => get<PromptsView>("/api/prompts"),
  updatePrompts: (patch: PromptsPatch) =>
    send<PromptsView>("/api/prompts", "PUT", patch),
  releases: (options?: ReadOptions) => get<ReleasesView>("/api/releases", options),
  confluenceReleases: (options?: ReadOptions) =>
    get<ConfluenceReleasesView>("/api/releases/confluence", options),
  confluenceRelease: (pageId: string) =>
    get<ConfluenceReleaseDetailView>(
      `/api/releases/confluence?pageId=${encodeURIComponent(pageId)}`,
    ),
  uploadRelease: (body: ReleaseUploadRequest) =>
    send<ReleaseUploadResultView>("/api/releases/upload", "POST", body),
  releaseRevertPreview: (environment: string, options?: ReadOptions) =>
    get<ReleaseRevertPreviewView>(
      `/api/releases/revert?environment=${encodeURIComponent(environment)}`,
      options,
    ),
  revertRelease: (body: ReleaseRevertRequest) =>
    send<ReleaseUploadResultView>("/api/releases/revert", "POST", body),
  releaseWatches: () => get<DeployWatchesView>("/api/releases/watches"),
  releaseDeploymentStatus: (
    body: ReleaseDeploymentStatusRequest,
    options?: Pick<ReadOptions, "signal">,
  ) =>
    request<ReleaseDeploymentStatusView>("/api/releases/deployment-status", {
      method: "POST",
      body,
      ...(options?.signal ? { signal: options.signal } : {}),
    }),
  /**
   * Past deployments. `limit` is a number of commits rather than a page: the
   * history tab widens the window instead of paging, because "further back" is
   * the only direction anybody reads it in.
   */
  releaseHistory: (limit: number, options: ReleaseHistoryReadOptions = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (options.environment) params.set("environment", options.environment);
    if (options.since) params.set("since", options.since);
    return get<ReleaseHistoryView>(`/api/releases/history?${params}`, options);
  },
  integrations: () => get<IntegrationsView>("/api/settings/integrations"),
  logRocketIssues: (filter?: LogRocketIssuesFilter) =>
    get<LogRocketIssuesView>(`/api/logrocket/issues${logRocketQuery(filter)}`),
  fixLogRocketIssue: (id: string) =>
    send<LogRocketFixResult>(
      `/api/logrocket/issues/${encodeURIComponent(id)}/fix`,
      "POST",
      {},
    ),
  // `filter` decides which list comes back, so pass the one on screen: the answer
  // is written into that cache entry without a refetch.
  setLogRocketIssueState: (
    id: string,
    state: LogRocketStatePatch["state"],
    filter?: LogRocketIssuesFilter,
  ) =>
    send<LogRocketIssuesView>(
      `/api/logrocket/issues/${encodeURIComponent(id)}/state${logRocketQuery(filter)}`,
      "POST",
      { state } satisfies LogRocketStatePatch,
    ),
  // Queues the agent that writes a failing test for this error. No Jira ticket is
  // filed on the way, unlike `fixLogRocketIssue`: a test is worth having whether or
  // not anybody is tracking the bug.
  writeLogRocketRegressionTest: (id: string) =>
    send<RegressionTestResult>(
      `/api/logrocket/issues/${encodeURIComponent(id)}/regression-test`,
      "POST",
      {},
    ),
  datadogIssues: (filter?: DatadogIssuesFilter) =>
    get<DatadogIssuesView>(`/api/datadog/issues${datadogQuery(filter)}`),
  datadogActivity: ({ limit, offset }: { limit: number; offset: number }) =>
    get<DatadogActivityView>(`/api/datadog/activity?limit=${limit}&offset=${offset}`),
  datadogRuns: async ({ limit, offset }: { limit: number; offset: number }) => {
    const { runs, total } = await get<DatadogActivityView>(
      `/api/datadog/activity?limit=${limit}&offset=${offset}`,
    );
    return { runs, total } satisfies TaskRunPage;
  },
  // Keyed by problem, not by signature: one root cause is one ticket and one
  // dismissal, and the server fans the action out to every member row.
  fixDatadogProblem: (key: string) =>
    send<DatadogFixResult>(
      `/api/datadog/problems/${encodeURIComponent(key)}/fix`,
      "POST",
      {},
    ),
  // As with LogRocket: `filter` names the list to answer with, which is the one the
  // caller then writes into its own cache entry.
  setDatadogProblemState: (
    key: string,
    state: DatadogStatePatch["state"],
    filter?: DatadogIssuesFilter,
  ) =>
    send<DatadogIssuesView>(
      `/api/datadog/problems/${encodeURIComponent(key)}/state${datadogQuery(filter)}`,
      "POST",
      { state } satisfies DatadogStatePatch,
    ),
  // Also keyed by problem: the server picks the member signature with a stack
  // trace, since that is the one an agent can actually work from.
  writeDatadogRegressionTest: (key: string, body: RegressionTestRequest = {}) =>
    send<RegressionTestResult>(
      `/api/datadog/problems/${encodeURIComponent(key)}/regression-test`,
      "POST",
      body,
    ),
  triageDatadogProblem: (key: string) =>
    send<DatadogAiTriageResult>(
      `/api/datadog/problems/${encodeURIComponent(key)}/ai-triage`,
      "POST",
      {},
    ),
  // Synchronous and slow by nature — a scan is ~20 aggregation calls against
  // Datadog — so callers show a spinner rather than polling for a result.
  scanDatadog: () => send<DatadogScanResult>("/api/datadog/scan", "POST", {}),
  datadogRouting: () => get<DatadogRoutingView>("/api/datadog/routing"),
  datadogServiceTargets: () =>
    get<DatadogServiceTargetsView>("/api/datadog/service-targets"),
  setDatadogServiceTarget: (service: string, body: DatadogServiceTargetPatch) =>
    send<DatadogServiceTargetView>(
      `/api/datadog/service-targets/${encodeURIComponent(service)}`,
      "PUT",
      body,
    ),
  deleteDatadogServiceTarget: (service: string) =>
    send<DatadogServiceTargetsView>(
      `/api/datadog/service-targets/${encodeURIComponent(service)}`,
      "DELETE",
    ),
  createDatadogRule: (body: DatadogRoutingRulePatch) =>
    send<DatadogRoutingRuleView>("/api/datadog/routing", "POST", body),
  updateDatadogRule: (id: string, body: DatadogRoutingRulePatch) =>
    send<DatadogRoutingRuleView>(
      `/api/datadog/routing/${encodeURIComponent(id)}`,
      "POST",
      body,
    ),
  deleteDatadogRule: (id: string) =>
    send<DatadogRoutingView>(
      `/api/datadog/routing/${encodeURIComponent(id)}`,
      "DELETE",
    ),
  flakySpecs: (filter?: FlakySpecsFilter) =>
    get<FlakySpecsView>(`/api/flaky-specs${flakySpecsQuery(filter)}`),
  // `filter` is separate from the `project` in the body on purpose: the body names
  // the spec being dismissed, the query names the list to answer with. They are
  // usually the same project, but the panel can be showing every project at once.
  setFlakySpecState: (
    project: string,
    specFile: string,
    state: FlakySpecStatePatch["state"],
    filter?: FlakySpecsFilter,
  ) =>
    send<FlakySpecsView>(`/api/flaky-specs/state${flakySpecsQuery(filter)}`, "POST", {
      project,
      specFile,
      state,
    } satisfies FlakySpecStatePatch),
  // Records an override rather than filing: the loop builds the ticket on its next
  // run -- see `FlakySpecFileResult`.
  fileFlakySpec: (project: string, specFile: string) =>
    send<FlakySpecFileResult>("/api/flaky-specs/file", "POST", { project, specFile }),
  submitFeedback: (feedback: FeedbackRequest, attachments: readonly File[] = []) => {
    if (attachments.length === 0) {
      return send<FeedbackView>("/api/feedback", "POST", feedback);
    }
    const formData = new FormData();
    formData.set("type", feedback.type);
    formData.set("title", feedback.title);
    formData.set("description", feedback.description);
    for (const attachment of attachments) formData.append("attachments", attachment);
    return request<FeedbackView>("/api/feedback", { method: "POST", formData });
  },
  pendingFeedback: () => get<PendingFeedbackView>("/api/feedback/pending"),
  publishFeedback: (id: string) =>
    send<FeedbackView>(`/api/feedback/${encodeURIComponent(id)}/publish`, "POST"),
  updateIntegrations: (patch: IntegrationsPatch) =>
    send<IntegrationsView>("/api/settings/integrations", "PUT", patch),

  /** Your own GitLab/Jira identity — My provider access, not the instance settings. */
  providerAccess: () => get<ProviderAccessView>("/api/me/credentials"),
  /** A whole card at once: `null` removes the user's credential and disconnects that identity. */
  updateProviderAccess: (patch: ProviderAccessPatch) =>
    send<ProviderAccessView>("/api/me/credentials", "PUT", patch),
  slackConnection: () => get<SlackConnectionView>("/api/me/slack/connection"),
  slackActivity: () => get<SlackActivityView>("/api/me/slack/activity"),
  resyncSlack: () => send<{ ok: boolean }>("/api/me/slack/resync", "POST"),
  startSlackOAuth: () =>
    send<SlackOAuthStartView>("/api/me/slack/oauth/start", "POST"),
  disconnectSlack: () =>
    send<{ removed: boolean }>("/api/me/slack/connection", "DELETE"),
  slackChannels: () => get<SlackChannelsView>("/api/me/slack/channels"),
  setSlackChannels: (patch: SlackChannelSelectionPatch) =>
    send<SlackChannelsView>("/api/me/slack/channels", "PUT", patch),
  slackInbox: (cursor?: string, options?: ReadOptions) =>
    get<SlackInboxView>(
      `/api/slack/inbox${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      options,
    ),
  slackUsers: (query?: string, options?: ReadOptions) =>
    get<SlackWorkspaceUsersView>(
      `/api/slack/users${query ? `?q=${encodeURIComponent(query)}` : ""}`,
      options,
    ),
  slackUserProfile: (userId: string, options?: ReadOptions) =>
    get<SlackUserProfileView>(
      `/api/slack/users/${encodeURIComponent(userId)}/profile`,
      options,
    ),
  slackConversationMembers: (conversationId: string, options?: ReadOptions) =>
    get<SlackConversationMembersView>(
      `/api/slack/conversations/${encodeURIComponent(conversationId)}/members`,
      options,
    ),
  slackConversationDetails: (conversationId: string, options?: ReadOptions) =>
    get<SlackConversationDetailsView>(
      `/api/slack/conversations/${encodeURIComponent(conversationId)}/details`,
      options,
    ),
  updateSlackConversationDetails: (
    conversationId: string,
    patch: SlackConversationDetailsPatch,
  ) =>
    send<SlackConversationDetailsView>(
      `/api/slack/conversations/${encodeURIComponent(conversationId)}/details`,
      "PATCH",
      patch,
    ),
  searchSlackConversation: (
    conversationId: string,
    search: string,
    page = 1,
    filters: SlackConversationSearchFilters = {},
    options?: ReadOptions,
  ) => {
    const params = new URLSearchParams({
      q: search,
      page: String(page),
      ...(filters.fromMe ? { fromMe: "true" } : {}),
      ...(filters.includesMe ? { includesMe: "true" } : {}),
      ...(filters.hasLink ? { hasLink: "true" } : {}),
      ...(filters.threadsOnly ? { threadsOnly: "true" } : {}),
    });
    return get<SlackConversationSearchView>(
      `/api/slack/conversations/${encodeURIComponent(conversationId)}/search?${params}`,
      options,
    );
  },
  openSlackDirectMessage: (body: SlackDirectMessageRequest) =>
    send<SlackConversationView>("/api/slack/direct-messages", "POST", body),
  hideSlackDirectMessage: (conversationId: string) =>
    send<{ hidden: boolean }>(
      `/api/slack/direct-messages/${encodeURIComponent(conversationId)}`,
      "DELETE",
    ),
  slackMessages: (
    conversationId: string,
    cursor?: string,
    options?: ReadOptions,
    focus?: string,
  ) =>
    get<SlackMessagesView>(
      `/api/slack/conversations/${encodeURIComponent(conversationId)}/messages${
        cursor || focus
          ? `?${new URLSearchParams({
              ...(cursor ? { cursor } : {}),
              ...(focus ? { focus } : {}),
            }).toString()}`
          : ""
      }`,
      options,
    ),
  sendSlackMessage: (conversationId: string, body: SlackMessageSendRequest) =>
    send<SlackMessageSendResult>(
      `/api/slack/conversations/${encodeURIComponent(conversationId)}/messages`,
      "POST",
      body,
    ),
  updateSlackMessage: (
    conversationId: string,
    timestamp: string,
    body: SlackMessageUpdateRequest,
  ) =>
    send<SlackMessageUpdateResult>(
      `/api/slack/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(timestamp)}`,
      "PUT",
      body,
    ),
  deleteSlackMessage: (conversationId: string, timestamp: string) =>
    send<{ ok: boolean }>(
      `/api/slack/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(timestamp)}`,
      "DELETE",
    ),
  setSlackReaction: (
    conversationId: string,
    timestamp: string,
    body: SlackReactionPatch,
  ) =>
    send<{ ok: boolean }>(
      `/api/slack/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(timestamp)}/reaction`,
      "POST",
      body,
    ),
  slackImageUrl: (
    conversationId: string,
    fileId: string,
    variant: "thumbnail" | "original",
  ) =>
    `/api/slack/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(fileId)}${
      variant === "thumbnail" ? "?variant=thumbnail" : ""
    }`,
  uploadSlackImages: (
    conversationId: string,
    input: { images: readonly File[]; text?: string; threadTs?: string },
  ) => {
    const formData = new FormData();
    for (const image of input.images) formData.append("images", image);
    if (input.text) formData.set("text", input.text);
    if (input.threadTs) formData.set("threadTs", input.threadTs);
    return request<SlackMessageSendResult>(
      `/api/slack/conversations/${encodeURIComponent(conversationId)}/images`,
      { method: "POST", formData },
    );
  },
  slackThread: (
    conversationId: string,
    threadTs: string,
    cursor?: string,
    options?: ReadOptions,
    focus?: string,
  ) =>
    get<SlackMessagesView>(
      `/api/slack/conversations/${encodeURIComponent(conversationId)}/threads/${encodeURIComponent(threadTs)}${
        cursor || focus
          ? `?${new URLSearchParams({
              ...(cursor ? { cursor } : {}),
              ...(focus ? { focus } : {}),
            }).toString()}`
          : ""
      }`,
      options,
    ),
  markSlackRead: (patch: SlackReadPatch) =>
    send<{ ok: boolean }>("/api/me/slack/read", "POST", patch),
  releaseConfig: () => get<ReleaseConfigView>("/api/releases/config"),
  setReleaseConfig: (patch: ReleaseConfigPatch) =>
    send<ReleaseConfigView>("/api/releases/config", "PUT", patch),
  talosUsers: () => get<TalosUsersView>("/api/users"),
  automationDashboard: (filter: AutomationDashboardFilter) =>
    get<AutomationDashboardView>(
      `/api/automation/dashboard${query({
        days: String(filter.days),
        scheduleId: filter.scheduleId == null ? undefined : String(filter.scheduleId),
        status: filter.status,
        limit: String(filter.limit ?? 25),
        offset: String(filter.offset ?? 0),
      })}`,
    ),
  automationPipeline: (pipelineId: number) =>
    get<AutomationPipelineDetailView>(
      `/api/automation/pipelines/${encodeURIComponent(String(pipelineId))}`,
    ),
  automationFailureInbox: (filter: AutomationFailureInboxFilter) =>
    get<AutomationFailureInboxView>(
      `/api/automation/failure-inbox${query({
        days: String(filter.days),
        scheduleId:
          filter.scheduleId == null ? undefined : String(filter.scheduleId),
        pipelineId:
          filter.pipelineId == null ? undefined : String(filter.pipelineId),
        presence: filter.presence,
        state: filter.state,
        search: filter.search?.trim() || undefined,
        limit: String(filter.limit),
        offset: String(filter.offset),
      })}`,
    ),
  automationFailureClusters: (
    pipelineId: number,
    filter: AutomationFailureClusterFilter,
  ) =>
    get<AutomationFailureClusterListView>(
      `/api/automation/pipelines/${encodeURIComponent(String(pipelineId))}/failure-clusters${query({
        limit: String(filter.limit),
        offset: String(filter.offset),
        search: filter.search?.trim() || undefined,
        jobId: filter.jobId == null ? undefined : String(filter.jobId),
        suiteIndex: filter.suiteIndex == null ? undefined : String(filter.suiteIndex),
        state: filter.state,
      })}`,
    ),
  automationFailureCluster: (pipelineId: number, signatureKey: string) =>
    get<AutomationFailureClusterDetailView>(
      `/api/automation/pipelines/${encodeURIComponent(String(pipelineId))}/failure-clusters/${encodeURIComponent(signatureKey)}`,
    ),
  triageAutomationFailure: (pipelineId: number, signatureKey: string) =>
    send<AutomationAiTriageActionView>(
      `/api/automation/pipelines/${encodeURIComponent(String(pipelineId))}/failure-clusters/${encodeURIComponent(signatureKey)}/triage`,
      "POST",
    ),
  assignAutomationFailure: (
    pipelineId: number,
    signatureKey: string,
    body: AutomationFailureAssignmentPatch,
  ) =>
    send<AutomationFailureAssignmentView>(
      `/api/automation/pipelines/${encodeURIComponent(String(pipelineId))}/failure-clusters/${encodeURIComponent(signatureKey)}/assignee`,
      "PUT",
      body,
    ),
  automationFailureTicketDraft: (pipelineId: number, signatureKey: string) =>
    get<AutomationTicketDraftView>(
      `/api/automation/pipelines/${encodeURIComponent(String(pipelineId))}/failure-clusters/${encodeURIComponent(signatureKey)}/ticket`,
    ),
  createAutomationFailureTicket: (
    pipelineId: number,
    signatureKey: string,
    body: AutomationTicketActionPatch,
  ) =>
    send<AutomationTicketActionView>(
      `/api/automation/pipelines/${encodeURIComponent(String(pipelineId))}/failure-clusters/${encodeURIComponent(signatureKey)}/ticket`,
      "POST",
      body,
    ),
  createAutomationFailureTickets: (
    pipelineId: number,
    body: AutomationBulkTicketActionPatch,
  ) =>
    send<AutomationBulkTicketActionView>(
      `/api/automation/pipelines/${encodeURIComponent(String(pipelineId))}/failure-clusters/bulk-ticket`,
      "POST",
      body,
    ),
  automationConfig: () => get<AutomationConfigView>("/api/automation/config"),
  setAutomationConfig: (patch: AutomationConfigPatch) =>
    send<AutomationConfigView>("/api/automation/config", "PUT", patch),
  automationSchedules: (projectId: string) =>
    get<AutomationScheduleDiscoveryResponse>(
      `/api/automation/config/schedules?projectId=${encodeURIComponent(projectId)}`,
    ),
  syncAutomation: () =>
    send<TaskRunStartedView>("/api/automation/sync", "POST", {}),
  dashboards: () => get<DashboardListView>("/api/dashboards"),
  dashboard: (id: string) => get<DashboardDetail>(`/api/dashboards/${encodeURIComponent(id)}`),
  dashboardDatasets: () => get<DashboardDatasetList>("/api/dashboards/datasets"),
  dashboardQuery: (query: DashboardQuery, options?: ReadOptions) =>
    request<DashboardQueryResult>("/api/dashboards/query", { method: "POST", body: query, ...options }),
  createDashboard: (spec: DashboardSpecInput) =>
    send<DashboardDetail>("/api/dashboards", "POST", spec),
  updateDashboard: (
    id: string,
    patch: { name?: string; description?: string | null; widgets?: DashboardDetail["widgets"] },
  ) => send<DashboardDetail>(`/api/dashboards/${encodeURIComponent(id)}`, "PUT", patch),
  deleteDashboard: (id: string) =>
    send<{ ok: boolean }>(`/api/dashboards/${encodeURIComponent(id)}`, "DELETE"),
};
