import { keepPreviousData, queryOptions, type QueryClient } from "@tanstack/react-query";

import { api } from "./api.ts";
import type {
  AgentUsageFilter,
  AutomationDashboardFilter,
  AutomationFailureClusterFilter,
  AutomationFailureInboxFilter,
} from "./api.ts";
import { keys, type PageParam } from "./query-keys.ts";
import type {
  DatadogAreaView,
  EnvironmentVersionView,
  PullRequestDetailView,
  PullRequestScope,
  PullRequestState,
  PullRequestsView,
  SlackConversationSearchFilters,
  TicketGraphView,
} from "../../shared/api-contract.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ACTIVE_AUTOMATION_PIPELINE_STATUSES = new Set([
  "created",
  "waiting_for_resource",
  "waiting_for_callback",
  "preparing",
  "pending",
  "running",
  "manual",
  "scheduled",
]);

/**
 * Every read the console does, with its cache key, its staleness and its polling
 * policy in one place.
 *
 * The point of collecting these is that the two rules that matter are easy to
 * lose when they live at 26 call sites:
 *
 * - **Never poll a forge-backed read.** `pullRequests`, `pr`, `prChanges`,
 *   `prRuns` and `releases` each cost one or more GitLab round trips, and
 *   `/api/pull-requests` fans out per state or per repository. Refreshing those
 *   is a decision, not a timer.
 * - **Poll the cheap ones instead.** `system`, `tasks`, `prActions`,
 *   `prActivity`, `prActiveActions` and `runSteps` answer from the job queue or
 *   from SQLite, so a few seconds' interval costs nothing.
 *
 * Where the server already answers "is anything still happening?" — the `live`
 * flag on `TicketGraphView` and `PullRequestActionsView`, a run's `status` — that
 * answer *is* the interval. `refetchInterval` takes a function of the query, so
 * the tick that reports nothing is running is the tick that stops the timer, with
 * no effect and no dependency array to get wrong.
 */
/**
 * Whether this read is allowed to be answered from the server's TTL cache.
 *
 * Deliberately *not* part of any cache key: `bypassCache` describes how one fetch
 * is performed, not what it returns, so a refresh must land in the same entry the
 * page is already showing. That is what `refresh` below relies on.
 */
export interface ForgeReadOptions {
  bypassCache?: boolean;
}

export interface ReleaseHistoryQueryOptions extends ForgeReadOptions {
  environment?: string;
  since?: string;
  enabled?: boolean;
}

export const queries = {
  // ─── cheap, local, shared by every indicator ──────────────────────────────

  dashboards: () =>
    queryOptions({
      queryKey: keys.dashboards(),
      queryFn: () => api.dashboards(),
    }),
  dashboard: (id: string) =>
    queryOptions({
      queryKey: keys.dashboard(id),
      queryFn: () => api.dashboard(id),
      enabled: id.length > 0,
    }),
  dashboardDatasets: () =>
    queryOptions({
      queryKey: keys.dashboardDatasets(),
      queryFn: () => api.dashboardDatasets(),
      staleTime: 5 * MINUTE,
    }),
  talosUsers: () =>
    queryOptions({
      queryKey: keys.talosUsers(),
      queryFn: () => api.talosUsers(),
      staleTime: 5 * MINUTE,
    }),
  system: () =>
    queryOptions({
      queryKey: keys.system(),
      queryFn: () => api.system(),
      staleTime: 10_000,
      // `runningJobs` is a live number in a view that is otherwise static config,
      // and with no interval the footer badge froze at whatever it said when the
      // job was queued — "1 job running" long after the job was done, until some
      // unrelated action happened to invalidate this key. Polled on its own answer
      // like every other live read here: the tick that reports nothing running is
      // the tick that stops the timer, and an idle footer costs nothing.
      refetchInterval: (q) => ((q.state.data?.runningJobs ?? 0) > 0 ? 3_000 : false),
    }),

  /** The "something is running" poll every status pill in the app reads from. */
  tasks: (query = "") =>
    queryOptions({
      queryKey: keys.tasks(query),
      queryFn: () => api.tasks(query),
      staleTime: 5_000,
      refetchInterval: (q) =>
        q.state.data?.tasks.some((task) => task.lastRun?.status === "running")
          ? 3_000
          : false,
    }),

  /**
   * `settleUntil` is a timestamp the caller pushes forward when it starts a run:
   * a just-queued run has no `running` status to poll on yet, so without it the
   * page would sit still until the next thing happened to refetch.
   */
  task: (id: string, options: { settleUntil?: number } = {}) =>
    queryOptions({
      queryKey: keys.task(id),
      queryFn: () => api.task(id),
      staleTime: 1_000,
      refetchInterval: (q) => {
        if (q.state.data?.lastRun?.status === "running") return 1_000;
        return Date.now() < (options.settleUntil ?? 0) ? 1_500 : false;
      },
    }),

  taskIssues: (id: string, page: PageParam) =>
    queryOptions({
      queryKey: keys.taskIssues(id, page),
      queryFn: () => api.taskIssues(id, page),
      staleTime: 6_000,
      placeholderData: keepPreviousData,
    }),

  taskRuns: (id: string, page: PageParam) =>
    queryOptions({
      queryKey: keys.taskRuns(id, page),
      queryFn: () => api.taskRuns(id, page),
      staleTime: 6_000,
      placeholderData: keepPreviousData,
      refetchInterval: (q) =>
        q.state.data?.runs.some((run) => run.status === "running") ? 6_000 : false,
    }),

  /** A one-time metadata and history snapshot; live lines use `runLogPage`. */
  runSteps: (executionId: string) =>
    queryOptions({
      queryKey: keys.runSteps(executionId),
      queryFn: () => api.steps(executionId),
      enabled: executionId.length > 0,
      staleTime: 1_000,
    }),

  runJiraOutcomes: (executionId: string, enabled: boolean) =>
    queryOptions({
      queryKey: keys.runJiraOutcomes(executionId),
      queryFn: () => api.runJiraOutcomes(executionId),
      enabled: enabled && executionId.length > 0,
      staleTime: 5 * MINUTE,
    }),

  // ─── forge-backed: expensive, never polled ────────────────────────────────

  pullRequests: (
    scope: PullRequestScope,
    states: readonly PullRequestState[],
    options: ForgeReadOptions = {},
  ) =>
    queryOptions({
      queryKey: keys.prs(scope, states),
      queryFn: ({ signal }) => api.pullRequests(scope, states, { signal, ...options }),
      staleTime: MINUTE,
      // The list a reviewer pages back to all day.
      gcTime: 15 * MINUTE,
    }),

  /** Four GitLab calls. Also what the runs tab reads to authorize itself. */
  pr: (id: string, options: ForgeReadOptions = {}) =>
    queryOptions({
      queryKey: keys.pr(id),
      queryFn: ({ signal }) => api.pullRequest(id, { signal, ...options }),
      staleTime: 30_000,
    }),

  /**
   * Up to 300 file diffs — the largest response in the API, hence the short gcTime.
   *
   * `sha` asks for one commit's diff instead of the whole branch's. That answer is
   * immutable — a commit's diff against its parent never changes — but it is left
   * on the same five minutes as the branch diff rather than cached forever, because
   * the entries are large and a reviewer clicking through twelve commits should not
   * hold all twelve in memory for the session.
   */
  prChanges: (id: string, sha?: string, options: ForgeReadOptions = {}) =>
    queryOptions({
      queryKey: keys.prChanges(id, sha ?? null),
      queryFn: ({ signal }) =>
        api.pullRequestChanges(id, { signal, ...options, ...(sha ? { sha } : {}) }),
      staleTime: 5 * MINUTE,
      gcTime: 5 * MINUTE,
    }),

  /**
   * `live` is the job queue's answer to "is there work in flight on this merge
   * request", and it is what makes a *newly started* run show up at all: a job
   * that has been queued but not yet leased has no run row for the poll below to
   * notice, so a table whose own rows are all finished would sit still through
   * the entire run and only learn about it on a remount. The caller passes what
   * the activity feed already polls for, rather than this query guessing.
   */
  prRuns: (id: string, page: PageParam, { live = false }: { live?: boolean } = {}) =>
    queryOptions({
      queryKey: keys.prRuns(id, page),
      queryFn: () => api.pullRequestRuns(id, page),
      staleTime: 6_000,
      placeholderData: keepPreviousData,
      // Deliberately slower than the toolbar's tick: a page of runs here is
      // authorized by fetching the merge request, so each refresh costs a forge
      // call. A row landing on "success" a few seconds late is the better trade.
      refetchInterval: (q) =>
        live || q.state.data?.runs.some((run) => run.status === "running") ? 6_000 : false,
    }),

  releases: (options: ForgeReadOptions = {}) =>
    queryOptions({
      queryKey: keys.releases(),
      queryFn: () => api.releases(options),
      staleTime: 2 * MINUTE,
    }),

  confluenceReleases: (enabled = true) =>
    queryOptions({
      queryKey: keys.confluenceReleases(),
      queryFn: ({ signal }) => api.confluenceReleases({ signal }),
      enabled,
      staleTime: 2 * MINUTE,
    }),

  /**
   * The deployment history. The costliest forge read on the page — a commit
   * listing plus one diff per commit — but history is append-only, so a long
   * stale time costs nothing beyond seeing a just-merged release late, which the
   * refresh button answers.
   */
  releaseHistory: (limit: number, options: ReleaseHistoryQueryOptions = {}) =>
    queryOptions({
      queryKey: keys.releaseHistory(limit, options.environment, options.since),
      queryFn: ({ signal }) =>
        api.releaseHistory(limit, {
          signal,
          bypassCache: options.bypassCache,
          environment: options.environment,
          since: options.since,
        }),
      enabled: options.enabled,
      // A confirmation asks who deployed immediately before this click. It must
      // not reuse a five-minute-old answer that predates another developer's MR.
      staleTime: options.bypassCache ? 0 : 5 * MINUTE,
    }),

  releaseRevertPreview: (environment: string, enabled = true) =>
    queryOptions({
      queryKey: keys.releaseRevertPreview(environment),
      queryFn: ({ signal }) =>
        api.releaseRevertPreview(environment, { signal, bypassCache: true }),
      enabled: enabled && environment.length > 0,
      // A confirmation must describe the latest commit each time it opens.
      staleTime: 0,
      gcTime: 0,
    }),

  // ─── job-queue reads: safe to poll, no forge call ─────────────────────────

  prActions: (id: string) =>
    queryOptions({
      queryKey: keys.prActions(id),
      queryFn: () => api.pullRequestActions(id),
      staleTime: 1_500,
      refetchInterval: (q) => (q.state.data?.live ? 1_500 : false),
    }),

  /** No `live` flag on this view, so the poll reads the entries themselves. */
  prActivity: (id: string) =>
    queryOptions({
      queryKey: keys.prActivity(id),
      queryFn: () => api.pullRequestActivity(id),
      staleTime: 1_500,
      refetchInterval: (q) =>
        q.state.data?.entries.some(
          (entry) => entry.status === "running" || entry.status === "queued",
        )
          ? 1_500
          : false,
    }),

  prActiveActions: () =>
    queryOptions({
      queryKey: keys.prActiveActions(),
      queryFn: () => api.pullRequestActiveActions(),
      staleTime: 3_000,
      refetchInterval: 3_000,
    }),

  // ─── the graph: forge-backed, but the poll watches local job state ────────

  graph: (scope: PullRequestScope, options: ForgeReadOptions = {}) =>
    queryOptions({
      queryKey: keys.graph(scope),
      queryFn: ({ signal }) => api.ticketGraph(scope, { signal, ...options }),
      staleTime: 3_000,
      refetchInterval: (q) => (q.state.data?.live ? 3_000 : false),
    }),

  /**
   * One ticket in full, for the detail panel.
   *
   * Not polled, unlike everything above it in this section. A description and a
   * comment thread change when a person edits them, which is not something worth
   * two Jira calls every three seconds — and the panel's own refresh button, plus
   * the twenty-second server-side entry behind it, cover the case where somebody
   * has just commented from the Jira tab next door.
   */
  ticket: (key: string, options: ForgeReadOptions = {}) =>
    queryOptions({
      queryKey: keys.ticket(key),
      queryFn: ({ signal }) => api.ticket(key, { signal, ...options }),
      staleTime: 20_000,
    }),

  ticketAttachmentText: (key: string, attachmentId: string) =>
    queryOptions({
      queryKey: keys.ticketAttachmentText(key, attachmentId),
      queryFn: ({ signal }) => api.ticketAttachmentText(key, attachmentId, { signal }),
      staleTime: Infinity,
    }),

  /**
   * The plan awaiting review on one ticket, for the panel's Plan tab.
   *
   * Polled, unlike `ticket` above it: this is a local SQLite read with no forge
   * call behind it, and the thing it is watching for is a planning container
   * finishing — which happens while the tab is open and which the reviewer would
   * otherwise have to guess at. `enabled` keeps it from firing for every ticket
   * the panel has ever shown; only the open Plan tab asks.
   */
  ticketPlan: (key: string) =>
    queryOptions({
      queryKey: keys.ticketPlan(key),
      queryFn: ({ signal }) => api.ticketPlan(key, { signal }),
      staleTime: 3_000,
      refetchInterval: 5_000,
    }),

  /** Every plan waiting on somebody. Local read, so it may poll. */
  planInbox: () =>
    queryOptions({
      queryKey: keys.planInbox(),
      queryFn: () => api.planInbox(),
      staleTime: 10_000,
      refetchInterval: 10_000,
    }),

  // ─── the rest ─────────────────────────────────────────────────────────────

  notifications: (unreadOnly = false) =>
    queryOptions({
      queryKey: keys.notifications(unreadOnly),
      queryFn: () => api.notifications(unreadOnly),
      staleTime: 10_000,
      refetchInterval: 10_000,
    }),

  /**
   * `enabled` is what stops an `/api/search` firing on app load, before anybody
   * has typed. `keepPreviousData` keeps the popover's current results on screen
   * while the next term is in flight, rather than flashing a skeleton per
   * keystroke — one of only two places that is the right trade.
   */
  search: (query: string) =>
    queryOptions({
      queryKey: keys.search(query),
      queryFn: ({ signal }) => api.search(query, { signal }),
      enabled: query.trim().length > 0,
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    }),

  /**
   * The empty search, fired once when the box is first focused.
   *
   * It answers with no hits by design; what it is for is the server side, where
   * both halves of a search read through caches the console shares with the
   * ticket board and the Pull requests page (see `src/api/search-view.ts`). An
   * empty query warms exactly those two entries, so the first term someone types
   * is answered from memory instead of waiting on Jira and GitLab. Same key as
   * `search("")`, which is the disabled state of the box above, so the two can
   * never fire twice.
   */
  searchWarmup: () =>
    queryOptions({
      queryKey: keys.search(""),
      queryFn: ({ signal }) => api.search("", { signal }),
      staleTime: 30_000,
    }),

  // Config-shaped: read once, changed by a button. The long staleTime is what
  // replaces the half-dozen `version` counters these pages used to keep.
  settings: () =>
    queryOptions({
      queryKey: keys.settings(),
      queryFn: () => api.settings(),
      staleTime: 5 * MINUTE,
    }),
  // What the aliases in `settings()` actually resolved to on their most recent
  // run — a shorter staleTime than settings itself, since a new run can change
  // it at any time without the operator doing anything.
  resolvedModels: () =>
    queryOptions({
      queryKey: keys.resolvedModels(),
      queryFn: () => api.resolvedModels(),
      staleTime: MINUTE,
    }),
  e2eTestSettings: () =>
    queryOptions({
      queryKey: keys.e2eTestSettings(),
      queryFn: () => api.e2eTestSettings(),
      staleTime: 5 * MINUTE,
    }),
  prompts: () =>
    queryOptions({
      queryKey: keys.prompts(),
      queryFn: () => api.prompts(),
      staleTime: 5 * MINUTE,
    }),
  integrations: () =>
    queryOptions({
      queryKey: keys.integrations(),
      queryFn: () => api.integrations(),
      staleTime: 5 * MINUTE,
    }),
  /**
   * Your own provider credentials. Nothing but the dialog that reads it can
   * change it — there is no way to spell somebody else's — so it is not polled
   * and the dialog invalidates on write.
   */
  providerAccess: () =>
    queryOptions({
      queryKey: keys.providerAccess(),
      queryFn: () => api.providerAccess(),
      staleTime: 5 * MINUTE,
    }),
  slackConnection: () =>
    queryOptions({
      queryKey: keys.slackConnection(),
      queryFn: () => api.slackConnection(),
      staleTime: 5 * MINUTE,
    }),
  slackActivity: () =>
    queryOptions({
      queryKey: keys.slackActivity(),
      queryFn: () => api.slackActivity(),
      staleTime: 5 * MINUTE,
    }),
  slackChannels: () =>
    queryOptions({
      queryKey: keys.slackChannels(),
      queryFn: () => api.slackChannels(),
      staleTime: MINUTE,
    }),
  slackInbox: (cursor = "") =>
    queryOptions({
      queryKey: keys.slackInbox(cursor),
      queryFn: ({ signal }) => api.slackInbox(cursor || undefined, { signal }),
      staleTime: MINUTE,
      // Loading the inbox also imports read cursors that advanced in Slack.
      // Always run that reconciliation when returning from another page.
      refetchOnMount: "always",
      refetchInterval: MINUTE,
      refetchIntervalInBackground: false,
    }),
  slackUsers: (query = "", enabled = true) =>
    queryOptions({
      queryKey: keys.slackUsers(query),
      queryFn: ({ signal }) => api.slackUsers(query || undefined, { signal }),
      enabled,
      staleTime: MINUTE,
    }),
  slackUserProfile: (userId: string, enabled = true) =>
    queryOptions({
      queryKey: keys.slackUserProfile(userId),
      queryFn: ({ signal }) => api.slackUserProfile(userId, { signal }),
      enabled: enabled && userId.length > 0,
      staleTime: MINUTE,
    }),
  slackConversationMembers: (conversationId: string, enabled = true) =>
    queryOptions({
      queryKey: keys.slackConversationMembers(conversationId),
      queryFn: ({ signal }) => api.slackConversationMembers(conversationId, { signal }),
      enabled: enabled && conversationId.length > 0,
      staleTime: MINUTE,
    }),
  slackConversationDetails: (conversationId: string, enabled = true) =>
    queryOptions({
      queryKey: keys.slackConversationDetails(conversationId),
      queryFn: ({ signal }) => api.slackConversationDetails(conversationId, { signal }),
      enabled: enabled && conversationId.length > 0,
      staleTime: MINUTE,
    }),
  slackConversationSearch: (
    conversationId: string,
    search: string,
    page = 1,
    filters: SlackConversationSearchFilters = {},
    enabled = true,
  ) =>
    queryOptions({
      queryKey: keys.slackConversationSearch(conversationId, search, page, filters),
      queryFn: ({ signal }) =>
        api.searchSlackConversation(conversationId, search, page, filters, { signal }),
      enabled: enabled && conversationId.length > 0 && search.trim().length > 0,
      staleTime: MINUTE,
    }),
  slackMessages: (conversationId: string, cursor = "", focus = "") =>
    queryOptions({
      queryKey: keys.slackMessages(conversationId, cursor, focus),
      queryFn: ({ signal }) =>
        api.slackMessages(
          conversationId,
          cursor || undefined,
          { signal },
          focus || undefined,
        ),
      enabled: conversationId.length > 0,
      staleTime: MINUTE,
    }),
  slackThread: (
    conversationId: string,
    threadTs: string,
    cursor = "",
    focus = "",
  ) =>
    queryOptions({
      queryKey: keys.slackThread(conversationId, threadTs, cursor, focus),
      queryFn: ({ signal }) =>
        api.slackThread(
          conversationId,
          threadTs,
          cursor || undefined,
          { signal },
          focus || undefined,
        ),
      enabled: conversationId.length > 0 && threadTs.length > 0,
      staleTime: MINUTE,
    }),
  releaseConfig: () =>
    queryOptions({
      queryKey: keys.releaseConfig(),
      queryFn: () => api.releaseConfig(),
      staleTime: 5 * MINUTE,
    }),
  automationDashboard: (filter: AutomationDashboardFilter) =>
    queryOptions({
      queryKey: keys.automationDashboard(filter),
      queryFn: () => api.automationDashboard(filter),
      staleTime: 5 * MINUTE,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
      placeholderData: keepPreviousData,
    }),
  automationPipeline: (pipelineId: number) =>
    queryOptions({
      queryKey: keys.automationPipeline(pipelineId),
      queryFn: () => api.automationPipeline(pipelineId),
      enabled: Number.isSafeInteger(pipelineId) && pipelineId > 0,
      staleTime: 30_000,
      refetchInterval: (query) => {
        const pipeline = query.state.data;
        return pipeline &&
          (ACTIVE_AUTOMATION_PIPELINE_STATUSES.has(pipeline.status) ||
            pipeline.reportState === "pending" ||
            pipeline.reportState === "error")
          ? MINUTE
          : false;
      },
      placeholderData: keepPreviousData,
    }),
  automationFailureInbox: (filter: AutomationFailureInboxFilter) =>
    queryOptions({
      queryKey: keys.automationFailureInbox(filter),
      queryFn: () => api.automationFailureInbox(filter),
      staleTime: 15_000,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
      refetchInterval: (query) =>
        query.state.data?.items.some(
          (item) => item.aiTriageInFlight || item.creating,
        )
          ? 1_500
          : false,
      placeholderData: keepPreviousData,
    }),
  automationFailureClusters: (
    pipelineId: number,
    filter: AutomationFailureClusterFilter,
  ) =>
    queryOptions({
      queryKey: keys.automationFailureClusters(pipelineId, filter),
      queryFn: () => api.automationFailureClusters(pipelineId, filter),
      enabled: Number.isSafeInteger(pipelineId) && pipelineId > 0,
      staleTime: 15_000,
      refetchInterval: (query) =>
        query.state.data?.items.some(
          (cluster) => cluster.aiTriageInFlight || cluster.creating,
        )
          ? 1_500
          : false,
      placeholderData: keepPreviousData,
    }),
  automationFailureCluster: (
    pipelineId: number,
    signatureKey: string,
    enabled = true,
  ) =>
    queryOptions({
      queryKey: keys.automationFailureCluster(pipelineId, signatureKey),
      queryFn: () => api.automationFailureCluster(pipelineId, signatureKey),
      enabled:
        enabled &&
        Number.isSafeInteger(pipelineId) &&
        pipelineId > 0 &&
        signatureKey.length > 0,
      staleTime: 15_000,
      refetchInterval: (query) =>
        query.state.data?.aiTriageInFlight || query.state.data?.creating
          ? 1_500
          : false,
    }),
  automationFailureTicketDraft: (
    pipelineId: number,
    signatureKey: string,
    enabled = true,
  ) =>
    queryOptions({
      queryKey: keys.automationFailureTicketDraft(pipelineId, signatureKey),
      queryFn: () => api.automationFailureTicketDraft(pipelineId, signatureKey),
      enabled:
        enabled &&
        Number.isSafeInteger(pipelineId) &&
        pipelineId > 0 &&
        signatureKey.length > 0,
      staleTime: 5 * MINUTE,
    }),
  automationConfig: () =>
    queryOptions({
      queryKey: keys.automationConfig(),
      queryFn: () => api.automationConfig(),
      staleTime: 5 * MINUTE,
    }),
  automationSchedules: (projectId: string, enabled: boolean) =>
    queryOptions({
      queryKey: keys.automationSchedules(projectId),
      queryFn: () => api.automationSchedules(projectId),
      enabled: enabled && projectId.trim().length > 0,
      staleTime: MINUTE,
    }),
  releaseWatches: () =>
    queryOptions({
      queryKey: keys.releaseWatches(),
      queryFn: () => api.releaseWatches(),
      staleTime: 30_000,
    }),
  releaseDeploymentStatus: (
    environments: EnvironmentVersionView[],
    enabled = true,
  ) =>
    queryOptions({
      queryKey: keys.releaseDeploymentStatus(
        JSON.stringify(
          environments.map((environment) => [
            environment.name,
            environment.services.map((service) => [
              service.name,
              service.image ?? "",
              service.version,
            ]),
          ]),
        ),
      ),
      queryFn: ({ signal }) =>
        api.releaseDeploymentStatus({ environments }, { signal }),
      enabled: enabled && environments.length > 0,
      staleTime: 10_000,
      refetchInterval: 30_000,
    }),
  fixIssueDefaults: () =>
    queryOptions({
      queryKey: keys.me.fixIssueDefaults(),
      queryFn: () => api.fixIssueDefaults(),
      staleTime: 5 * MINUTE,
    }),
  agentRunPreferences: () =>
    queryOptions({
      queryKey: keys.me.agentRunPreferences(),
      queryFn: () => api.agentRunPreferences(),
      staleTime: 5 * MINUTE,
    }),
  agentUsage: (filter: AgentUsageFilter) =>
    queryOptions({
      queryKey: keys.me.agentUsage(filter),
      queryFn: () => api.agentUsage(filter),
      staleTime: MINUTE,
      refetchInterval: MINUTE,
      placeholderData: keepPreviousData,
    }),
  /**
   * How this developer has set the console up. Read once at boot and then left
   * alone: every write goes through `setPreference`, which updates this cache
   * directly, so there is nothing a refetch could learn.
   */
  preferences: () =>
    queryOptions({
      queryKey: keys.me.preferences(),
      queryFn: () => api.preferences(),
      staleTime: Infinity,
    }),
  pullRequestRepoFilter: () =>
    queryOptions({
      queryKey: keys.me.pullRequestRepoFilter(),
      queryFn: () => api.pullRequestRepoFilter(),
      staleTime: 5 * MINUTE,
    }),
  /**
   * This developer's own account. Long stale time and no interval: the only things
   * that change it are the two writes on the same screen, both of which answer with
   * the new profile — except a verification link followed elsewhere, which is why
   * Profile refetches on mount rather than trusting the cache forever.
   */
  profile: () =>
    queryOptions({
      queryKey: keys.me.profile(),
      queryFn: () => api.profile(),
      staleTime: MINUTE,
    }),
  notificationSubscriptions: () =>
    queryOptions({
      queryKey: keys.me.notificationSubscriptions(),
      queryFn: () => api.notificationSubscriptions(),
      staleTime: 5 * MINUTE,
    }),

  // SQLite-backed issue lists. No interval: their refresh buttons are the trigger.
  datadogIssues: (filter: {
    includeDismissed: boolean;
    team?: string;
    area?: DatadogAreaView;
  }) =>
    queryOptions({
      queryKey: keys.datadogIssues(filter),
      queryFn: () => api.datadogIssues(filter),
      staleTime: 30_000,
      refetchInterval: (query) =>
        query.state.data?.services.some((service) =>
          service.problems.some(
            (problem) =>
              problem.regressionTestInFlight ||
              problem.aiTriageInFlight ||
              problem.fixInFlight,
          ),
        )
          ? 1_500
          : false,
    }),
  datadogRouting: () =>
    queryOptions({
      queryKey: keys.datadogRouting(),
      queryFn: () => api.datadogRouting(),
      staleTime: 30_000,
    }),
  datadogServiceTargets: () =>
    queryOptions({
      queryKey: keys.datadogServiceTargets(),
      queryFn: () => api.datadogServiceTargets(),
      staleTime: 30_000,
    }),
  datadogActivity: (page: { limit: number; offset: number }) =>
    queryOptions({
      queryKey: keys.datadogActivity(page),
      queryFn: () => api.datadogActivity(page),
      staleTime: 2_000,
      refetchInterval: (query) => {
        const data = query.state.data;
        return data &&
          (data.activeJobs.length > 0 || data.runs.some((run) => run.status === "running"))
          ? 1_500
          : false;
      },
    }),
  datadogRuns: (page: { limit: number; offset: number }) =>
    queryOptions({
      queryKey: keys.datadogRuns(page),
      queryFn: () => api.datadogRuns(page),
      staleTime: 2_000,
      refetchInterval: (query) =>
        query.state.data?.runs.some((run) => run.status === "running") ? 1_500 : false,
    }),
  logRocketIssues: (filter: { includeDismissed: boolean }) =>
    queryOptions({
      queryKey: keys.logRocketIssues(filter),
      queryFn: () => api.logRocketIssues(filter),
      staleTime: 30_000,
    }),
  flakySpecs: (filter: { includeDismissed: boolean; project?: string }) =>
    queryOptions({
      queryKey: keys.flakySpecs(filter),
      queryFn: () => api.flakySpecs(filter),
      staleTime: 30_000,
    }),

  /**
   * The Add-task pickers. The caller still debounces, but it debounces the term
   * *into the key* rather than the request — so typing back over something you
   * already typed answers from cache with no request at all, which no amount of
   * debouncing achieves on its own.
   */
  gitlabMergeRequests: (project: string, search: string) =>
    queryOptions({
      queryKey: keys.gitlab.mergeRequests(project, search),
      queryFn: () => api.gitlabMergeRequests(project, search),
      enabled: project.length > 0,
      staleTime: 5 * MINUTE,
      placeholderData: keepPreviousData,
    }),
  gitlabProjects: (group: string) =>
    queryOptions({
      queryKey: keys.gitlab.projects(group),
      queryFn: () => api.gitlabGroupProjects(group),
      enabled: group.length > 0,
      staleTime: 10 * MINUTE,
    }),
  gitlabBranches: (project: string, search: string) =>
    queryOptions({
      queryKey: keys.gitlab.branches(project, search),
      queryFn: () => api.gitlabBranches(project, search),
      enabled: project.length > 0,
      staleTime: 5 * MINUTE,
      placeholderData: keepPreviousData,
    }),
  /**
   * Detected once per session, not polled: signing into Cursor is something the
   * operator does in another window and then comes back, so a reload is the
   * natural refresh and a timer would only re-stat four directories forever.
   */
  agents: () =>
    queryOptions({
      queryKey: keys.agents,
      queryFn: () => api.agents(),
      staleTime: 10 * MINUTE,
    }),
  /**
   * The connectable-agent catalog and the accounts on it.
   *
   * Not polled either, and for a stronger reason than `agents`: nothing changes
   * this but the dialog that reads it, which invalidates on every write. The
   * catalog itself is a constant compiled into the server.
   */
  agentAccounts: () =>
    queryOptions({
      queryKey: keys.agentAccounts,
      queryFn: () => api.agentAccounts(),
      staleTime: 10 * MINUTE,
    }),
  jiraIssues: (search: string, statuses: readonly string[] = []) =>
    queryOptions({
      queryKey: keys.jira.issues(search, statuses),
      queryFn: () => api.jiraIssues(search, { statuses: [...statuses] }),
      enabled: search.trim().length > 0 || statuses.length > 0,
      staleTime: 5 * MINUTE,
      placeholderData: keepPreviousData,
    }),
  jiraUsers: (project: string) =>
    queryOptions({
      queryKey: keys.jira.users(project),
      queryFn: () => api.jiraUsers(project),
      enabled: project.trim().length > 0,
      staleTime: 3 * DAY,
      placeholderData: keepPreviousData,
    }),
};

/**
 * What each kind of write invalidates, collected for the same reason the reads
 * are: an action's blast radius is a decision about the *product*, not about the
 * component that happens to fire it, and three pages queue an agent run the same
 * way. A missed invalidation shows somebody stale data after they changed it,
 * which is the failure mode this file exists to make hard.
 *
 * Deliberately not `useMutation`: the ~30 writes in the console are imperative
 * `await api.x()` calls inside event handlers, and converting them all would be a
 * large diff for nothing but the invalidation these functions already give.
 */
export const invalidate = {
  automation: (client: QueryClient) =>
    void client.invalidateQueries({ queryKey: keys.allAutomation() }),
  automationFailureTriage: (
    client: QueryClient,
    pipelineId: number,
    signatureKeys: readonly string[] = [],
  ) => {
    const refreshes = [
      client.invalidateQueries({
        queryKey: keys.allAutomationFailureClusters(pipelineId),
      }),
    ];
    for (const signatureKey of signatureKeys) {
      refreshes.push(
        client.invalidateQueries({
          queryKey: keys.automationFailureCluster(pipelineId, signatureKey),
        }),
      );
    }
    refreshes.push(
      client.invalidateQueries({ queryKey: keys.automationPipeline(pipelineId) }),
      client.invalidateQueries({ queryKey: keys.allAutomationDashboards() }),
      client.invalidateQueries({
        queryKey: keys.allAutomationFailureInboxes(),
      }),
    );
    return Promise.all(refreshes).then(() => undefined);
  },
  /**
   * Anything that queued, cancelled or finished a job — every "fix this", every
   * "write a test for this", every run and cancel.
   *
   * Broader than it looks on purpose: `allTasks()` is the prefix, so a queued job
   * refreshes every task listing whatever its search term *and* the open task's
   * detail and run history, not just the unfiltered list the footer reads.
   */
  jobQueue: (client: QueryClient) => {
    void client.invalidateQueries({ queryKey: keys.system() });
    void client.invalidateQueries({ queryKey: keys.allTasks() });
  },

  /**
   * A triage list, across every filter rather than the one on screen.
   *
   * Dismissing a row changes what the "hide dismissed" list contains as much as
   * what the "show dismissed" one does, and a team filter somebody flips back to
   * must not still be showing the row they just acted on. `refetchType` decides
   * whether the entry on screen refetches or is merely marked stale — pass
   * `"none"` when the caller is about to write the response into it by hand.
   */
  datadogIssues: (client: QueryClient, refetchType: "active" | "none" = "active") =>
    void client.invalidateQueries({ queryKey: keys.allDatadogIssues(), refetchType }),
  logRocketIssues: (client: QueryClient, refetchType: "active" | "none" = "active") =>
    void client.invalidateQueries({ queryKey: keys.allLogRocketIssues(), refetchType }),
  /** Every project and both dismissal filters — this panel is mounted once per loop. */
  flakySpecs: (client: QueryClient, refetchType: "active" | "none" = "active") =>
    void client.invalidateQueries({ queryKey: keys.allFlakySpecs(), refetchType }),

  /**
   * Connecting or disconnecting an agent account.
   *
   * Takes `agents` with it: `/api/agents` reports what this host is signed in to,
   * and a delegated login just signed it into something.
   */
  agentAccounts: (client: QueryClient) => {
    void client.invalidateQueries({ queryKey: keys.agentAccounts });
    void client.invalidateQueries({ queryKey: keys.agents });
    void client.invalidateQueries({ queryKey: keys.me.agentRunPreferences() });
  },

  /** Every scope's graph: an action taken from one is visible in the others. */
  graph: (client: QueryClient) =>
    void client.invalidateQueries({ queryKey: keys.allGraph() }),

  /**
   * A decision on one plan: approve, reject, or a fresh plan queued.
   *
   * Four things, because a plan decision is the one write that touches all of
   * them — the document itself, the inbox it was waiting in, the graph (the
   * ticket stops being gold and grows a job), and the job queue that now holds
   * the fix.
   */
  plan: (client: QueryClient, issueKey: string) => {
    void client.invalidateQueries({ queryKey: keys.ticketPlan(issueKey) });
    void client.invalidateQueries({ queryKey: keys.planInbox() });
    void client.invalidateQueries({ queryKey: keys.allGraph() });
    void client.invalidateQueries({ queryKey: keys.system() });
  },

  /**
   * The job-queue half of one merge request: which action is running on it, the
   * activity feed, every page of its run history, and the badge the listing draws
   * from `active-actions`. Deliberately not the forge-backed detail or listing —
   * queueing a job does not change the merge request.
   */
  prJobs: (client: QueryClient, prId: string) => {
    void client.invalidateQueries({ queryKey: keys.prActions(prId) });
    void client.invalidateQueries({ queryKey: keys.prActivity(prId) });
    void client.invalidateQueries({ queryKey: keys.allPrRuns(prId) });
    void client.invalidateQueries({ queryKey: keys.prActiveActions() });
  },
};

/**
 * The refresh buttons, which are the one path allowed past both caches.
 *
 * `invalidateQueries` is not enough for these. It refetches, but the refetch goes
 * through the same `queryFn`, so the server answers it from its own TTL cache and
 * the button does nothing visible for up to a minute — the caching turning into a
 * bug report the first time somebody clicks it. `fetchQuery` with a bypassing
 * `queryFn` writes into the very same key, so every observer of the page's query
 * updates from it; only *how* the value was obtained differs.
 *
 * Each returns void and swallows its own failure, which is not laziness: a failed
 * `fetchQuery` still records the error against the query, so the page renders it
 * through `AsyncState.error` exactly as it renders a failed initial load. Letting the
 * promise reject as well would report the same failure a second time as an unhandled
 * rejection in the console — and it is a rejection every one of these callers is a
 * click handler for, so remembering the `.catch` would be per-call-site and
 * forgettable. Handled here once instead.
 */
const settled = (work: Promise<unknown>): void => void work.catch(() => {});

/**
 * `staleTime: 0` on top of the page's own options, because `fetchQuery` honours
 * `staleTime`: it calls the `queryFn` only when the entry is already stale, and
 * otherwise resolves with the cached value. Reusing the query definitions as-is
 * would therefore hand these helpers the very window they exist to escape —
 * `releases` is cached for two minutes, so a click inside those two minutes made
 * no request, spun nothing, and changed nothing on screen. Only the freshness
 * check is dropped; the entry, its key and its observers are untouched.
 */
const forced = <T extends { staleTime?: unknown }>(options: T): T => ({ ...options, staleTime: 0 });

/**
 * Reconcile the list's cheap merge-request summary with the discussion state
 * from a freshly fetched detail.
 *
 * GitLab's listing exposes `blocking_discussions_resolved`, while the detail
 * endpoint computes `openThreadCount` from the discussions themselves. Those
 * two reads are cached independently and GitLab can also update the summary
 * flag after the discussions response, so refreshing only the detail used to
 * leave an obsolete warning on the row. The detail's thread count is the
 * authoritative answer for this one field; all other list fields stay intact.
 */
export function reconcilePullRequestThreadState(
  client: QueryClient,
  detail: PullRequestDetailView,
): void {
  client.setQueriesData<PullRequestsView>(
    { queryKey: ["prs", "list"] },
    (listing) => {
      if (!listing || !listing.pullRequests.some((pr) => pr.id === detail.id)) return listing;

      return {
        ...listing,
        pullRequests: listing.pullRequests.map((pr) => {
          if (pr.id !== detail.id) return pr;

          const { hasUnresolvedThreads: _stale, ...current } = pr;
          return detail.openThreadCount > 0
            ? { ...current, hasUnresolvedThreads: true }
            : current;
        }),
      };
    },
  );
}

export const refresh = {
  pullRequests: (
    client: QueryClient,
    scope: PullRequestScope,
    states: readonly PullRequestState[],
  ) => settled(client.fetchQuery(forced(queries.pullRequests(scope, states, { bypassCache: true })))),

  /** The detail pane's button: the merge request, and its diff only if fetched once. */
  pullRequest: (client: QueryClient, id: string) =>
    settled(
      Promise.all([
        client.fetchQuery(forced(queries.pr(id, { bypassCache: true }))),
        // Guarded rather than unconditional: the diff is the largest response in the
        // API and the tab holding it is usually closed, so refreshing it for someone
        // who never opened it would make the button cost more than the page. When it
        // *has* been opened the server keys the entry by head sha, so this pays for a
        // diff only if the merge request actually moved.
        // Only the branch's own diff. A commit-scoped entry is keyed by its sha and
        // is the same bytes forever, so there is nothing for a refresh to correct.
        client.getQueryData(keys.prChanges(id)) === undefined
          ? undefined
          : client.fetchQuery(forced(queries.prChanges(id, undefined, { bypassCache: true }))),
      ]).then(([detail]) => {
        reconcilePullRequestThreadState(client, detail);
      }),
    ),

  releases: (client: QueryClient) =>
    settled(client.fetchQuery(forced(queries.releases({ bypassCache: true })))),

  releaseHistory: (client: QueryClient, limit: number) =>
    settled(client.fetchQuery(forced(queries.releaseHistory(limit, { bypassCache: true })))),

  graph: (client: QueryClient, scope: PullRequestScope) =>
    settled(client.fetchQuery(forced(queries.graph(scope, { bypassCache: true })))),

  /**
   * The ticket panel's own button: the full Jira ticket plus the Development
   * section hanging off it.
   *
   * Development starts with the graph's fresh Jira/GitLab association data, then
   * deepens every related merge request with its current commits and pipelines.
   * Waiting for the graph before enumerating those ids is important: otherwise a
   * merge request linked since the panel opened would not be refreshed or shown.
   */
  ticket: (client: QueryClient, key: string, scope: PullRequestScope) => {
    const graph = client.fetchQuery(
      forced(queries.graph(scope, { bypassCache: true })),
    );
    settled(
      Promise.all([
        client.fetchQuery(forced(queries.ticket(key, { bypassCache: true }))),
        graph.then((view) => {
          const cluster = view.clusters.find((candidate) => candidate.key === key);
          const ids = new Set(
            (cluster?.nodes ?? []).flatMap((node) =>
              node.pullRequest
                ? [`gitlab:${node.pullRequest.projectId}!${node.pullRequest.mrIid}`]
                : [],
            ),
          );
          return Promise.all(
            [...ids].map((id) =>
              client.fetchQuery(forced(queries.pr(id, { bypassCache: true }))),
            ),
          );
        }),
      ]),
    );
  },
};

/** Awaitable release refresh used when a watched merge unlocks Kubernetes polling. */
export function refreshReleasesAwait(client: QueryClient) {
  return client.fetchQuery(
    forced(queries.releases({ bypassCache: true })),
  );
}

/**
 * Same forced, cache-bypassing read as `refresh.graph`, but awaitable.
 *
 * A drag that moves a ticket writes straight to Jira and is right the moment
 * it resolves — the routine 3s poll behind `queries.graph` is the one thing
 * still wrong, because it never bypasses the server's own 30s cache entry for
 * assigned tickets. Left alone, the very next poll can read that stale entry
 * and the board reverts a card that Jira already moved. The kanban board
 * awaits this immediately after a successful transition so the query cache —
 * server and client both — is caught up before it trusts a poll again.
 */
export function refreshGraphAwait(
  client: QueryClient,
  scope: PullRequestScope,
): Promise<TicketGraphView> {
  return client.fetchQuery(forced(queries.graph(scope, { bypassCache: true })));
}
