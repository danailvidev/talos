import type {
  DatadogAreaView,
  PullRequestScope,
  PullRequestState,
  SlackConversationSearchFilters,
} from "../../shared/api-contract.ts";
import type {
  AgentUsageFilter,
  AutomationDashboardFilter,
  AutomationFailureClusterFilter,
  AutomationFailureInboxFilter,
  DashboardQuery,
} from "./api.ts";

/** A page of run history, as `limit`/`offset` rather than a page index. */
export interface PageParam {
  limit: number;
  offset: number;
}

/**
 * Every cache key in the console, in one place.
 *
 * Deliberately free of React and of `@tanstack/react-query` so the key
 * discipline can be read — and tested — without a browser. `queries.ts` is
 * where these get paired with a loader and a polling policy.
 *
 * The convention is `[resource, subresource?, params]`, broad to narrow, with
 * params always a single object rather than spread positionally. That is what
 * makes prefix invalidation work: `["prs"]` reaches every pull request entry,
 * `["prs", "list"]` reaches every listing, and neither can accidentally match
 * an unrelated key that happens to share a scalar.
 */
export const keys = {
  talosUsers: () => ["users", "talos"] as const,
  system: () => ["system"] as const,

  /**
   * The prefixes, for invalidating a whole resource without naming its params.
   * `allTasks()` reaches every listing whatever its search term, plus every
   * task's detail and run pages — which is what an action that changes job
   * state actually affects.
   */
  allTasks: () => ["tasks"] as const,
  allPrs: () => ["prs"] as const,
  allReleases: () => ["releases"] as const,
  allDatadog: () => ["datadog"] as const,
  /** Every filter combination of the issue list, but not the routing rules. */
  allDatadogIssues: () => ["datadog", "issues"] as const,
  allLogRocket: () => ["logrocket"] as const,
  allLogRocketIssues: () => ["logrocket", "issues"] as const,
  allFlakySpecs: () => ["flaky-specs"] as const,
  allGraph: () => ["graph"] as const,
  allSlack: () => ["slack"] as const,
  allAutomation: () => ["automation"] as const,
  allAutomationDashboards: () => ["automation", "dashboard"] as const,
  allAutomationFailureInboxes: () => ["automation", "failure-inbox"] as const,
  allAutomationFailureClusters: (pipelineId: number) =>
    ["automation", "failure-clusters", pipelineId] as const,

  tasks: (query = "") => ["tasks", "list", { query }] as const,
  task: (id: string) => ["tasks", "detail", id] as const,
  taskIssues: (id: string, page: PageParam) => ["tasks", "issues", id, page] as const,
  taskRuns: (id: string, page: PageParam) => ["tasks", "runs", id, page] as const,

  runSteps: (executionId: string) => ["runs", "steps", executionId] as const,
  runJiraOutcomes: (executionId: string) =>
    ["runs", "jira-outcomes", executionId] as const,
  runLogPage: (executionId: string, afterLogId: number) =>
    ["runs", "logs", executionId, afterLogId] as const,

  /**
   * `states` is joined rather than left an array because a call site rebuilds it
   * every render — the reason `PullRequestsPage` already keeps a `stateKey`
   * string. Normalising here means no call site has to remember.
   */
  prs: (scope: PullRequestScope, states: readonly PullRequestState[]) =>
    ["prs", "list", { scope, states: states.join(",") }] as const,
  pr: (id: string) => ["prs", "detail", id] as const,
  /**
   * The diff. A `sha` gives one commit's diff its own entry rather than
   * overwriting the whole-branch one, so switching between commits and back is
   * free — and `null` for "the whole branch" keeps the two shapes distinguishable
   * as tuple members.
   */
  prChanges: (id: string, sha: string | null = null) => ["prs", "changes", id, sha] as const,
  /** Every commit's diff plus the branch's, for the refresh button. */
  allPrChanges: (id: string) => ["prs", "changes", id] as const,
  prActions: (id: string) => ["prs", "actions", id] as const,
  prActivity: (id: string) => ["prs", "activity", id] as const,
  prRuns: (id: string, page: PageParam) => ["prs", "runs", id, page] as const,
  /** Every page of one merge request's run history, for after a run starts or is cancelled. */
  allPrRuns: (id: string) => ["prs", "runs", id] as const,
  prActiveActions: () => ["prs", "active-actions"] as const,

  graph: (scope: PullRequestScope) => ["graph", { scope }] as const,
  /**
   * One Jira ticket in full. Outside `allGraph()` on purpose: the graph's
   * three-second poll invalidates that prefix constantly to redraw job state, and
   * sharing the prefix would make the panel refetch two Jira calls every tick.
   */
  ticket: (key: string) => ["tickets", "detail", key] as const,
  ticketAttachmentText: (key: string, attachmentId: string) =>
    ["tickets", "attachment-text", key, attachmentId] as const,
  /** One ticket's plan document. Outside the graph prefix for the same reason `ticket` is. */
  ticketPlan: (key: string) => ["tickets", "plan", key] as const,
  planInbox: () => ["plans", "inbox"] as const,
  search: (query: string) => ["search", { query }] as const,
  notifications: (unreadOnly = false) => ["notifications", { unreadOnly }] as const,

  settings: () => ["settings"] as const,
  resolvedModels: () => ["settings", "resolved-models"] as const,
  e2eTestSettings: () => ["settings", "e2e-tests"] as const,
  prompts: () => ["prompts"] as const,
  integrations: () => ["integrations"] as const,
  /** The signed-in developer's own provider credentials. No user id in the key: the
      endpoint has none either, so a cache entry cannot outlive a sign-out into the
      next person's session — `queryClient.clear()` on logout is what guarantees it. */
  providerAccess: () => ["provider-access"] as const,
  slackConnection: () => ["slack", "connection"] as const,
  slackActivity: () => ["slack", "activity"] as const,
  slackChannels: () => ["slack", "channels"] as const,
  slackInbox: (cursor = "") => ["slack", "inbox", { cursor }] as const,
  slackUsers: (query = "") => ["slack", "users", { query }] as const,
  slackUserProfile: (userId: string) => ["slack", "user-profile", userId] as const,
  slackConversationMembers: (conversationId: string) =>
    ["slack", "members", conversationId] as const,
  slackConversationDetails: (conversationId: string) =>
    ["slack", "details", conversationId] as const,
  slackConversationSearch: (
    conversationId: string,
    search: string,
    page = 1,
    filters: SlackConversationSearchFilters = {},
  ) =>
    ["slack", "search", conversationId, { search, page, filters }] as const,
  slackMessages: (conversationId: string, cursor = "", focus = "") =>
    ["slack", "messages", conversationId, { cursor, focus }] as const,
  slackThread: (
    conversationId: string,
    threadTs: string,
    cursor = "",
    focus = "",
  ) =>
    ["slack", "thread", conversationId, threadTs, { cursor, focus }] as const,

  releases: () => ["releases", "list"] as const,
  confluenceReleases: () => ["releases", "confluence"] as const,
  releaseHistory: (limit: number, environment = "", since = "") =>
    ["releases", "history", { limit, environment, since }] as const,
  releaseRevertPreview: (environment: string) =>
    ["releases", "revert-preview", { environment }] as const,
  releaseWatches: () => ["releases", "watches"] as const,
  releaseDeploymentStatus: (revision: string) =>
    ["releases", "deployment-status", { revision }] as const,
  releaseConfig: () => ["releases", "config"] as const,

  automationDashboard: (filter: AutomationDashboardFilter) =>
    [
      "automation",
      "dashboard",
      {
        days: filter.days,
        scheduleId: filter.scheduleId ?? null,
        status: filter.status ?? null,
        limit: filter.limit ?? 25,
        offset: filter.offset ?? 0,
      },
    ] as const,
  automationPipeline: (pipelineId: number) =>
    ["automation", "pipeline", pipelineId] as const,
  automationFailureInbox: (filter: AutomationFailureInboxFilter) =>
    [
      "automation",
      "failure-inbox",
      {
        days: filter.days,
        scheduleId: filter.scheduleId ?? null,
        pipelineId: filter.pipelineId ?? null,
        presence: filter.presence,
        state: filter.state ?? null,
        search: filter.search?.trim() || null,
        limit: filter.limit,
        offset: filter.offset,
      },
    ] as const,
  automationFailureClusters: (
    pipelineId: number,
    filter: AutomationFailureClusterFilter,
  ) =>
    [
      "automation",
      "failure-clusters",
      pipelineId,
      {
        limit: filter.limit,
        offset: filter.offset,
        search: filter.search?.trim() || null,
        jobId: filter.jobId ?? null,
        suiteIndex: filter.suiteIndex ?? null,
        state: filter.state ?? null,
      },
    ] as const,
  automationFailureCluster: (pipelineId: number, signatureKey: string) =>
    ["automation", "failure-cluster", pipelineId, signatureKey] as const,
  automationFailureTicketDraft: (pipelineId: number, signatureKey: string) =>
    ["automation", "failure-ticket-draft", pipelineId, signatureKey] as const,
  automationConfig: () => ["automation", "config"] as const,
  automationSchedules: (projectId: string) =>
    ["automation", "schedules", { projectId }] as const,

  datadogIssues: (filter: {
    includeDismissed: boolean;
    team?: string;
    area?: DatadogAreaView;
  }) => ["datadog", "issues", filter] as const,
  datadogRouting: () => ["datadog", "routing"] as const,
  datadogServiceTargets: () => ["datadog", "service-targets"] as const,
  datadogActivity: (page: PageParam) => ["datadog", "activity", page] as const,
  datadogRuns: (page: PageParam) => ["datadog", "runs", page] as const,

  logRocketIssues: (filter: { includeDismissed: boolean }) =>
    ["logrocket", "issues", filter] as const,

  flakySpecs: (filter: { includeDismissed: boolean; project?: string }) =>
    ["flaky-specs", filter] as const,

  me: {
    agentRunPreferences: () => ["me", "agent-run-preferences"] as const,
    agentUsage: (filter: AgentUsageFilter) => ["me", "agent-usage", filter] as const,
    fixIssueDefaults: () => ["me", "fix-issue-defaults"] as const,
    preferences: () => ["me", "preferences"] as const,
    pullRequestRepoFilter: () => ["me", "pull-request-repos"] as const,
    profile: () => ["me", "profile"] as const,
    notificationSubscriptions: () => ["me", "notification-subscriptions"] as const,
  },

  gitlab: {
    mergeRequests: (project: string, search: string) =>
      ["gitlab", "merge-requests", { project, search }] as const,
    projects: (group: string) => ["gitlab", "projects", { group }] as const,
    branches: (project: string, search: string) =>
      ["gitlab", "branches", { project, search }] as const,
  },
  dashboards: () => ["dashboards"] as const,
  dashboard: (id: string) => ["dashboards", "one", id] as const,
  dashboardDatasets: () => ["dashboards", "datasets"] as const,
  dashboardQuery: (query: DashboardQuery, refreshToken: number) =>
    ["dashboards", "query", query, refreshToken] as const,
  agents: ["agents"] as const,
  agentAccounts: ["agent-accounts"] as const,
  jira: {
    issues: (search: string, statuses: readonly string[] = []) =>
      ["jira", "issues", { search, statuses: statuses.join(",") }] as const,
    users: (project: string) => ["jira", "users", { project }] as const,
  },
} as const;
