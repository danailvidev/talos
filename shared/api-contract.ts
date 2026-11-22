import type { AppPermission } from "./authorization.ts";

export type RunStatus = "running" | "success" | "failure" | "cancelled";
export type { AppPermission } from "./authorization.ts";

export interface RoleReference {
  id: string;
  name: string;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: RoleReference;
  permissions: AppPermission[];
}

export interface AuthSession {
  user: AuthUser;
}

/** Minimal authenticated directory entry used by collaborative owner pickers. */
export interface TalosUserView {
  id: string;
  name: string;
  email: string;
}

export interface TalosUsersView {
  users: TalosUserView[];
}

export interface AdminUserView extends AuthUser {
  builtIn: boolean;
  accountStatus: "pending" | "active";
  /** Present while a live invitation exists; the secret token is never returned by list APIs. */
  invitationExpiresAt?: string;
  createdAt?: string;
  /** Most recent authenticated request or login. Absent until the account is first used. */
  lastSeenAt?: string;
  /** Stored, decryptable personal access used for work performed as this developer. */
  connections: {
    gitlab: boolean;
    jira: boolean;
    slack: boolean;
  };
  agentAccountCount: number;
  ownedLoopCount: number;
}

export interface AdminUsersView {
  users: AdminUserView[];
}

export interface AdminRoleView extends RoleReference {
  description: string;
  system: boolean;
  permissions: AppPermission[];
  userCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminRolesView {
  roles: AdminRoleView[];
}

export interface AdminRoleInput {
  name: string;
  description?: string;
  permissions: AppPermission[];
}

export interface AdminUserDetailView extends AdminUserView {
  sessions: {
    createdAt: string;
    expiresAt: string;
  }[];
  providerConnections: {
    gitlab?: { updatedAt: string };
    jira?: { updatedAt: string };
    slack?: SlackConnectionView;
  };
  agentAccounts: AgentAccountView[];
  ownedLoops: {
    id: string;
    name: string;
    createdAt: string;
  }[];
  jobs: {
    queued: number;
    leased: number;
    done: number;
    dead: number;
  };
  pullRequestRepositories: string[];
  fixIssueDefaults: FixIssueDefaultsView | null;
}

export interface AdminFeedbackEntryView {
  id: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  type: FeedbackType;
  title: string;
  description: string;
  labels: string[];
  publicationStatus: FeedbackPublicationStatus;
  publicationReason?: FeedbackPublicationReason;
  issueState?: "opened" | "closed";
  externalIssueUrl?: string;
  externalIssueNumber?: number;
  createdAt: string;
}

export interface AdminFeedbackView {
  feedback: AdminFeedbackEntryView[];
  gitlabSync:
    | { status: "synced"; syncedAt: string }
    | {
        status: "unavailable";
        reason: FeedbackPublicationReason;
      };
}

export type FeedbackType = "bug" | "feature" | "general" | "security";
export type FeedbackPublicationStatus = "pending" | "published";
export type FeedbackPublicationReason =
  | "missing_token"
  | "invalid_token"
  | "insufficient_access"
  | "temporary_failure";

export interface AdminUserCreate {
  name: string;
  email: string;
  roleId: string;
}

export interface AdminUserInvitationView {
  user: AdminUserView;
  /** Returned only when generated so the administrator can deliver it once. */
  invitationUrl: string;
  expiresAt: string;
}

export interface AdminUserPatch {
  name: string;
  email: string;
  roleId: string;
}

export interface AcceptInvitationRequest {
  token: string;
  password: string;
}

export interface AdminLogLineView {
  id: number;
  timestamp: string;
  level: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface AdminLogsView {
  logs: AdminLogLineView[];
}

export interface TaskRunView {
  executionId: string;
  taskId: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: RunStatus;
  dryRun: boolean;
  params?: unknown;
  itemsSeen?: number;
  itemsProcessed?: number;
  itemsSkipped?: number;
  error?: string;
  /**
   * Free-form per-task outcome, e.g.
   * `{ action: 'no-change' | 'opened', mrUrl, summary, agentErrors }`.
   *
   * `agentErrors` is the number of the agent's own tool calls that failed. Not a
   * failure — but a verdict of "nothing to change" reached through failing
   * commands is worth seeing next to the outcome rather than only in the log.
   */
  details?: Record<string, unknown>;
}

export interface TaskRunPage {
  runs: TaskRunView[];
  total: number;
}

export interface TaskRunStartedView extends TaskRunView {
  status: "running";
  steps: StepView[];
}

export interface StepView {
  stepId: string;
  startedAt: string;
  durationMs: number;
  status: "success" | "failure";
  attempts: number;
  error?: string;
}

export interface LogLineView {
  /** Monotonic log cursor; use it as `afterLogId` to fetch later lines. */
  id: number;
  ts: string;
  level: string;
  step?: string;
  message: string;
  meta?: Record<string, unknown>;
}

/** Jira metadata for one CI-failure outcome, including historical run enrichment. */
export interface RunJiraOutcomeView {
  action: string;
  issueKey: string;
  issueUrl: string;
  file: string;
  assignee?: string;
}

export interface RunJiraOutcomesView {
  outcomes: RunJiraOutcomeView[];
}

export interface ParamField {
  name: string;
  kind: "string" | "number" | "boolean" | "enum";
  required: boolean;
  default?: unknown;
  description?: string;
  choices?: string[];
}

export type Visibility = "public" | "private";
export type Trigger =
  | { type: "cron"; expression: string; timezone?: string; startAt?: string }
  | { type: "once"; at: string; timezone?: string }
  | { type: "manual" };

export interface TaskSummary {
  id: string;
  /** The task definition this instance was created from (equals `id` for a non-instantiated task). */
  definitionId: string;
  name: string;
  description?: string;
  kind: "task" | "loop";
  instantiable: boolean;
  paramsSchema: ParamField[];
  visibility?: Visibility;
  createdAt?: string;
  enabled: boolean;
  enabledOrigin: string;
  schedule: string | null;
  onceAt?: string;
  startAt?: string;
  timezone?: string;
  nextRun: string | null;
  scheduleError?: string;
  maxItemsPerRun: number;
  lastRun?: TaskRunView;
  stats: {
    total: number;
    successes: number;
    failures: number;
    avgDurationMs: number | null;
  };
  openIssues: number;
  /** Jobs this loop enqueued that are queued or leased right now — not yet done or dead. */
  activeJobs: number;
  usesGitLab: boolean;
  usesJira: boolean;
  gitlabMr?: { iid: number; url: string };
  jiraIssue?: { key: string; url?: string };
  promptTemplate?: string;
}

export interface FiledIssueView {
  issueKey: string;
  issueUrl?: string;
  subject: string;
  author?: string;
  /** Current Jira assignee for ticket-backed tracked rows. */
  assignee?: TicketPersonView;
  state: "open" | "closed";
  seenCount: number;
  filedAt: string;
  lastSeenAt: string;
}

export interface TaskIssuePage {
  issues: FiledIssueView[];
  total: number;
}

export interface TaskDetail extends TaskSummary {
  watermark: string | null;
  events: { completed: number; claimed: number; failed: number };
  runs: TaskRunView[];
  /** First page only; subsequent tracked rows come from `/api/tasks/:id/issues`. */
  issues: FiledIssueView[];
  params: unknown;
  paramsOrigin: string;
  graph: {
    executionId?: string;
    startedAt?: string;
    nodes: unknown[];
    edges: unknown[];
  };
}

export interface ScheduleView {
  id: string;
  enabled: boolean;
  enabledOrigin: string;
  trigger: Trigger;
  maxItemsPerRun: number;
  params: unknown;
}

export interface SchedulePatch {
  enabled?: boolean;
  trigger?: Trigger;
  maxItemsPerRun?: number;
  params?: unknown;
}

/** A Jira ticket as the header's search box shows it — enough to recognise, not to render. */
export interface SearchTicket {
  key: string;
  summary?: string;
  status?: string;
  statusCategory?: string;
  type?: string;
  url: string;
}

/**
 * The header's global search: the two things people look for by name.
 *
 * Tickets and merge requests only. Loops and filed issues used to be in here and
 * were never what anybody typed — a loop is found on its own page, and a filed
 * issue is an internal row keyed by spec path. See `src/api/search-view.ts`.
 */
export interface SearchResult {
  tickets: SearchTicket[];
  pullRequests: PullRequestView[];
}

/**
 * The ticket graph: the Jira↔GitLab round trip as nodes and edges.
 *
 * One payload, one canvas. The roots are the tickets assigned to whoever asked,
 * read live from Jira; everything else — the loops watching them, the jobs and
 * runs those raised, the merge requests that came out — hangs off a root and is
 * only drawn when that root is expanded. There is no ticket→merge request link
 * table; see `src/api/graph-view.ts` for how the edge is recovered.
 *
 * `action` is the odd one out: not something a loop discovered but something a
 * person triggered from the ticket's own Actions menu, one node per attempt,
 * newest five per ticket. It exists because those jobs belong to no loop and no
 * work subject, so nothing else in this payload would ever mention them.
 */
export type GraphNodeKind = "ticket" | "loop" | "job" | "run" | "mr" | "action";

/**
 * Operational state, in the vocabulary `design.md` gives colour: running is coral,
 * success cyan, waiting gold, failure and dead dusty red. Wider than `RunStatus`
 * because a queued job and a dead one are both things a run never is.
 */
export type GraphStatus = "running" | "success" | "failure" | "waiting" | "dead" | "idle";

/**
 * A ticket's own facts, as Jira reports them.
 *
 * Carried on the `ticket` node rather than fetched per click: the panel opens on
 * the first frame that way, and the graph has already paid for one Jira search.
 * Every field is optional because a Jira site can hide or rename any of them.
 */
export interface TicketFactsView {
  /** Stable Jira workflow status id; unlike the display name it is what board columns map. */
  statusId?: string;
  status?: string;
  /** `new`, `indeterminate` or `done` — portable, unlike a translated status name. */
  statusCategory?: string;
  type?: string;
  priority?: string;
  labels: string[];
  assignee?: TicketPersonView;
  reporter?: string;
  createdAt?: string;
  updatedAt?: string;
  /** The sprint this ticket is in, absent for a backlog one. See `SprintView`. */
  sprint?: SprintView;
  /** This ticket's parent key — set on a subtask, or a story under an epic. */
  parentKey?: string;
}

/**
 * One Jira sprint, as the graph's filter bar needs it.
 *
 * The dates are here because the sprint switcher shows them: "which sprint is
 * current" is a question the server answers (`TicketGraphView.currentSprintId`),
 * but "how much of it is left" is one the client draws, and both come off the same
 * object rather than a second read.
 */
export interface SprintView {
  id: number;
  name: string;
  state: "active" | "future" | "closed" | "unknown";
  startDate?: string;
  endDate?: string;
  boardId?: number;
}

export interface GraphNode {
  /** Stable across polls, so the canvas does not re-mount nodes: `job:<id>`, `run:<executionId>`. */
  id: string;
  kind: GraphNodeKind;
  /** Short identity: `TP-1204`, `!412`, a loop name. */
  label: string;
  sublabel?: string;
  status: GraphStatus;
  /** Outward deep link — the Jira browse URL or the merge request's `web_url`. */
  url?: string;
  /** Present on loop/job/run nodes, so a click can reach the existing task page. */
  taskId?: string;
  /** Present on run nodes, for `GET /api/task-runs/:executionId/steps`. */
  executionId?: string;
  /** Job facts inlined so the side panel needs no second request; `jobs` has no route. */
  job?: { attempts: number; maxAttempts: number; error?: string; enqueuedAt: string };
  /**
   * The queue row behind this node, when it is still queued or leased — what
   * `POST /api/jobs/:id/cancel` needs.
   *
   * Present on more than `job` nodes: a manual action carries no work subject, so
   * the only thing on the canvas that stands for it is the merge request or
   * ticket node it was marked running on. Absent once the job finishes, because
   * there is then nothing to cancel.
   */
  jobId?: string;
  /**
   * When this job/run actually happened — finished, else started, else
   * enqueued. `nodes` itself is sorted by `id` (a random UUID) for stable
   * canvas layout, not by time, so a chronological list (the ticket's
   * Activity tab) has to re-sort by this instead.
   */
  at?: string;
  /**
   * The work subject an `mr` node stands for, when it came from one. Together with
   * `taskId` (the discovering loop) it is everything `POST /api/graph/mr-action`
   * needs. Absent on a merge request recovered from a run's `details`, which has
   * no subject row behind it — such a node can be read but not acted on.
   */
  subjectKey?: string;
  /**
   * The merge request itself, on every `mr` node whose project and number could be
   * recovered. What makes a node with no `subjectKey` actionable anyway: the client
   * falls back to `POST /api/pull-requests/:id/actions`, which authorises the same
   * three actions against the forge with the developer's own token. So an MR read
   * from their own listing offers the same toolbar as one a loop is tracking.
   */
  pullRequest?: { projectId: string; mrIid: number };
  /** Completed QA browser-test result carried by an `e2e-test` action node. */
  e2e?: E2eTestResultView;
  /** Set on `ticket` nodes. See `TicketFactsView`. */
  ticket?: TicketFactsView;
}

export interface MrActionRequest {
  /** The loop that discovered the merge request — `GraphNode.taskId`. */
  loopId: string;
  subjectKey: string;
  action: MrActionId;
}

/**
 * What a ticket node's Actions menu can start.
 *
 * `fix-issue` writes code — a branch and a draft merge request. `review-description`
 * writes nothing but a Jira comment: it reads the ticket the way a developer picking
 * it up would and asks, in the ticket's own thread, about the requirements that are
 * missing or ambiguous. `plan-issue` sits between them: it reads the ticket *and* the
 * code and writes an implementation plan, which changes nothing until a human
 * approves it, and approving it is what starts a fix. `e2e-test` selects an
 * already-linked merge request and verifies it against QA. They are listed together
 * because they are the same decision — "what should talos do with this ticket" —
 * taken at different points in its life: the review is what you want before anybody
 * starts, the plan is what you want when you would rather argue about the approach
 * than about a diff, and the fix is what you want once neither is in doubt.
 */
export type TicketActionId =
  | "fix-issue"
  | "plan-issue"
  | "review-description"
  | "e2e-test";

export interface E2ePullRequestCandidateView {
  projectId: string;
  mrIid: number;
  title: string;
  url: string;
  sourceBranch: string;
  targetBranch: string;
  draft: boolean;
  updatedAt: string;
}

export interface E2eTestArtifactView {
  name: string;
  kind: "screenshot" | "trace" | "log";
  contentType: string;
  bytes: number;
  url: string;
}

export interface E2eTestResultView {
  /** Queue job that produced this result; identifies it for test-MR export. */
  jobId: string;
  /** True when this run has conclusive structured steps in the supported target repository. */
  exportable: boolean;
  sourceBranch?: string;
  targetBranch?: string;
  verdict: "pass" | "fail" | "inconclusive";
  summary: string;
  scenarios: Array<{
    name: string;
    outcome: "pass" | "fail" | "blocked";
    detail: string;
    evidence: string[];
    automation?: {
      portal: "main" | "parent" | "student";
      preconditions: string[];
      steps: Array<{
        action: "navigate" | "click" | "fill" | "select" | "check" | "press" | "assert" | "wait";
        target: string;
        locatorHint?: string;
        value?: string;
        expected?: string;
      }>;
    };
  }>;
  findings: Array<{
    severity: "critical" | "major" | "minor";
    title: string;
    detail: string;
    evidence: string[];
  }>;
  artifacts: E2eTestArtifactView[];
  testMr?: {
    status: "queued" | "running" | "opened" | "no-change" | "dead";
    jobId: string;
    mrUrl?: string;
    draft?: boolean;
    error?: string;
  };
}

/** POST `/api/e2e/test-mr` — export one completed exploratory run as Playwright coverage. */
export interface E2eTestMrRequest {
  sourceJobId: string;
  /** Server-restricted to `develop` or the tested MR's source branch. */
  targetBranch: string;
}

/** POST body for `/api/graph/ticket-action`. */
export interface TicketActionRequest {
  issueKey: string;
  action: TicketActionId;
  /** Per-run override for fix/plan; omitted callers use the developer's saved default. */
  targetBranch?: string;
  /** Required for `e2e-test`; selected from this ticket's linked merge requests. */
  pullRequest?: { projectId: string; mrIid: number };
}

/**
 * POST body for the older `/api/graph/fix-issue`, kept as an alias of
 * `{ action: "fix-issue" }` for scripts that already call it.
 */
export interface FixIssueRequest {
  issueKey: string;
  /** Per-run override; omitted callers use the developer's saved default. */
  targetBranch?: string;
}

export interface MrActionResult {
  /** False when an identical action is already queued or in flight. */
  queued: boolean;
  jobId?: string;
  /** Plain-language outcome, shown verbatim on the canvas. */
  message: string;
}

/**
 * The same answer from the pull request view's toolbar. Aliased rather than
 * duplicated: both routes enqueue the same job through the same helper, so a
 * second shape could only ever be the first one drifting.
 */
export type PullRequestActionResult = MrActionResult;

/** POST body for `/api/graph/ticket-status` — dragging a ticket to a new board column. */
export interface TicketStatusChangeRequest {
  issueKey: string;
  /** The target column's label, matched against the ticket's Jira transitions by name. */
  status: string;
  /** Jira workflow statuses configured in the target column, preferred over its label. */
  statusIds?: string[];
}

export interface TicketStatusChangeResult {
  ok: boolean;
  /** Plain-language outcome, shown verbatim on the board. */
  message: string;
}

/** The answer from `POST /api/jobs/:id/cancel`. */
export interface JobCancelResult {
  jobId: string;
  /** The handler the job was for — `fix-jira-issue-one`, `gitlab-review-one`. */
  kind: string;
  /**
   * The run aborted alongside the queue row, when the job had already started.
   * Absent for a job cancelled while still queued: there was nothing running.
   */
  run?: { executionId: string; status: string };
  /** False when the job had already finished; the route answers 409 for that. */
  cancelled: boolean;
  status: "cancelled" | "already-finished" | "unknown";
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  status: GraphStatus;
}

/**
 * Where a plan is in its one decision.
 *
 * `awaiting-review` is the only state a human can act on. `superseded` is what a plan
 * becomes when a newer one is written for the same ticket — kept rather than deleted,
 * because "what did we decide, and what did we decide before that" is the question
 * this whole gate exists to be able to answer later.
 */
export type PlanStatusView =
  | "awaiting-review"
  | "approved"
  | "rejected"
  | "superseded"
  | "implemented";

/** Enough of a plan to colour a node and word a menu. No plan text — see `TicketCluster.plan`. */
export interface TicketPlanSummaryView {
  id: string;
  status: PlanStatusView;
  /** The agent's one-or-two-sentence account of what it proposes. */
  summary?: string;
  /**
   * The ticket has been edited since this plan was written.
   *
   * Blocks approval rather than warning about it: the ticket text is the plan's
   * premise, and approving a conclusion drawn from a premise that has since changed
   * is the mistake this gate is supposed to make impossible. The panel offers
   * "Re-plan" in place of "Approve".
   */
  stale: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GET `/api/tickets/:key/plan` — the plan document itself, plus the ticket's plan history. */
export interface TicketPlanView {
  /** The newest plan for this ticket, in any state. Null when none was ever written. */
  plan: PlanView | null;
  /** Every earlier plan for the ticket, newest first. */
  history: TicketPlanSummaryView[];
}

export interface PlanView {
  id: string;
  issueKey: string;
  status: PlanStatusView;
  projectId: string;
  /** The branch the plan was written against, and the one a fix would branch off. */
  targetBranch: string;
  summary?: string;
  /**
   * What the agent wrote. Never mutated — keeping it alongside `approvedBody` is what
   * makes "did a human change this plan, and how" answerable after the fact.
   */
  draftBody: string;
  /** What a human approved, and the only text ever mounted into a container. */
  approvedBody?: string;
  /** Why approving right now may be a mistake. Absent when nothing has moved. */
  staleness?: {
    /** The ticket was edited after the plan was written — approval is refused. */
    ticket?: boolean;
    /**
     * The base branch has moved since the plan was written. A warning only: branches
     * move constantly, and blocking on it would block every plan on a busy repo.
     */
    base?: { plannedSha: string; currentSha?: string };
  };
  /** The run that wrote the plan, for the Activity tab's link. */
  planRunId?: string;
  /** The fix approving it queued. */
  implementJobId?: string;
  /** Display name of whoever decided, once somebody has. */
  reviewer?: string;
  /** Why it was rejected. */
  reviewNote?: string;
  createdAt: string;
  updatedAt: string;
}

/** One row of the review queue: which ticket is waiting, and since when. */
export interface PlanInboxItemView {
  id: string;
  issueKey: string;
  status: PlanStatusView;
  projectId: string;
  targetBranch: string;
  summary?: string;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * GET `/api/plans` — every plan waiting on a human, oldest first.
 *
 * Oldest first unlike every other listing in this file: this one is a work queue for
 * a person, and the plan that has waited longest is the one to look at next.
 */
export interface PlanInboxView {
  plans: PlanInboxItemView[];
}

/**
 * POST `/api/plans/:id/decision` — the human's one decision on a plan.
 *
 * `body` is the approved text, which may be the reviewer's edit of the draft rather
 * than the draft itself; it is what reaches the container, so an approval that
 * omitted it would silently approve something nobody read.
 */
export interface PlanDecisionRequest {
  decision: "approve" | "reject";
  /** Required for `approve`: the plan text as the reviewer is approving it. */
  body?: string;
  /** Optional for `reject`: what was wrong with it. */
  note?: string;
}

export interface TicketActionAvailability {
  available: boolean;
  reason?: string;
  /**
   * `fix-issue` only: the branch a fix would push, when one can run —
   * `fixIssueBranchName`'s answer for this ticket.
   *
   * Server-computed so the confirmation step shows the branch that will actually
   * appear rather than a client-side guess at the same slug rules, which would
   * drift the first time either side changed.
   */
  branch?: string;
}

export interface TicketCluster {
  /** A Jira issue key. */
  key: string;
  title?: string;
  url?: string;
  /** Worst-of the cluster's nodes: failure beats running beats waiting beats success. */
  status: GraphStatus;
  /** `actions` counts the ticket's own triggered actions — see `GraphNodeKind`. */
  counts: { mrs: number; jobs: number; runs: number; actions: number; activeJobs: number };
  /**
   * This ticket has at least one merge request open for review right now.
   *
   * `open`, not `draft` and not `merged`: a draft is still being written and a
   * merged one is over, so neither is waiting on a reviewer. The graph colours
   * these roots with the success hue rather than the amber every unfinished ticket
   * otherwise gets, because "the code is written and somebody has to look at it"
   * is a different thing to do about a ticket than "nothing has started".
   *
   * Counted off the developer's own pull request listing, which is the only source
   * on this page that knows a merge request's forge state — an MR node inferred
   * from a loop's subject or a run's details has no state to read.
   */
  inReview: boolean;
  updatedAt: string;
  /**
   * Where the root came from: `jira` for a ticket assigned to the asking
   * developer, `loops` for one only a loop knows about. Shown, because "assigned
   * to me but nothing has touched it" and "somebody's loop is on it" are
   * different situations even when both draw the same node.
   */
  source: "jira" | "loops";
  /** Jira board column containing this ticket's workflow status. */
  columnId?: string;
  /**
   * The sprint this cluster's ticket is in, lifted from its ticket node so the
   * filter bar can bucket a cluster without walking its nodes. Absent for a backlog
   * ticket, and for a `loops` cluster — which is a ticket nobody asked Jira about,
   * not a ticket known to be sprintless.
   */
  sprint?: SprintView;
  /** Every sprint membership Jira carries on the issue, including parallel active sprints. */
  sprints: SprintView[];
  /**
   * Which of the ticket's actions can run right now, and why not when one cannot.
   * Server-decided so the menu never has to guess — a missing default project and
   * an already-open merge request read the same to the canvas.
   *
   * Every id is present, always: an action left out of the record would silently
   * disappear from the menu, and the whole point of this shape is that an action
   * you cannot use is shown greyed with the reason rather than hidden.
   */
  actions: Record<TicketActionId, TicketActionAvailability>;
  /** Linked merge requests offered by the E2E dialog; the server revalidates current state. */
  e2ePullRequests: E2ePullRequestCandidateView[];
  /** Latest completed E2E coverage state, summarized for the board card. */
  e2eCoverage?: {
    status: "passed" | "failed" | "inconclusive" | "writing" | "mr-ready";
    scenarios: number;
    mrUrl?: string;
  };
  /**
   * The ticket's newest unresolved implementation plan, if it has one.
   *
   * Deliberately a summary with no plan text in it. A graph read returns dozens of
   * clusters and polls every few seconds, while a plan document runs to kilobytes —
   * so this carries only what the canvas needs to colour the node gold and word the
   * menu's refusals, and the panel fetches the document itself from
   * `GET /api/tickets/:key/plan` when somebody opens the Plan tab.
   */
  plan?: TicketPlanSummaryView;
  /** The ticket root, plus the subgraph a client draws once the root is expanded. */
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface TicketGraphView {
  clusters: TicketCluster[];
  /** Total matching clusters before this bounded page was selected. */
  total: number;
  offset: number;
  limit: number;
  /** True while any cluster holds a running run or an active job. Drives the client's poll. */
  live: boolean;
  /**
   * What the graph could not read — an unconfigured Jira token, a forge that
   * refused. Reported rather than thrown: a partial graph with an explanation is
   * more use than a red box, and a silently short one hides the outage.
   */
  warnings: string[];
  /** Jira's actual board and status-to-column mapping. */
  board?: TicketBoardView;
  /**
   * Every sprint the clusters mention, once each, ordered the way the switcher
   * walks them: active first, then future by start date, then closed most recent
   * first.
   *
   * Derived from the tickets rather than read from the board on purpose — it is
   * "the sprints your work is in", so the list costs no extra Jira call and can
   * never offer a sprint that would filter the page down to nothing. Empty on a
   * site with no sprint field, which is how the client knows to hide the switcher
   * rather than show one with a single choice.
   */
  sprints: SprintView[];
  /**
   * The sprint the page opens on: the active one your work is in. Decided here so
   * "current sprint" means one thing across clients, and so the client's stored
   * preference can say `current` rather than pinning an id that goes stale the
   * moment the sprint rolls over.
   */
  currentSprintId?: number;
  /** Null until the developer sets it; the fix action is refused without it. */
  fixDefaults: FixIssueDefaultsView | null;
  generatedAt: string;
}

export interface TicketBoardColumnView {
  id: string;
  name: string;
  /** Workflow statuses Jira groups into this column. */
  statusIds: string[];
}

export interface TicketBoardView {
  id: number;
  name: string;
  /** Jira API's project key, named for the corresponding Jira UI concept. */
  spaceKey?: string;
  spaceName?: string;
  columns: TicketBoardColumnView[];
}

/**
 * One ticket in full — `GET /api/tickets/:key`.
 *
 * A second read rather than more fields on `TicketFactsView`, because the graph
 * gets its tickets from one bulk Jira search and everything here needs a call per
 * ticket: fetching it for all fifty clusters to draw one open panel would be fifty
 * requests to Jira on every poll. So the facts ride along with the graph and this
 * arrives when a ticket is actually clicked, cached per user for half a minute.
 *
 * Deliberately shaped for reading, not for round-tripping: ADF descriptions and
 * comment bodies are rendered to plain text on the server (`adfToText`), because
 * the alternative is shipping an ADF renderer to the browser to display something
 * whose canonical rendering is one click away in Jira.
 */
export interface TicketDetailView {
  key: string;
  url: string;
  summary?: string;
  /**
   * Markdown, rendered from ADF by `adfToMarkdown` — never HTML, so the client can
   * render it without sanitising anything. A bug report is mostly structure, and the
   * headings, numbered steps, tables and fenced traces are the readable part of it.
   * Empty string and absent both mean "no description".
   */
  description?: string;
  /**
   * The parent ticket's Markdown description when this ticket has none of its own.
   * Kept separate so the panel can name the source instead of presenting inherited
   * requirements as though they were written on the child.
   */
  parentDescription?: string;
  /**
   * Same-site Confluence Smart Links resolved with the asking developer's
   * credentials. The Markdown renderer matches these by URL and embeds the
   * bounded page body; an absent entry leaves the ordinary external-link card.
   */
  confluencePreviews?: ConfluencePreviewView[];
  /** Jira's separate "Environment" field, which several teams use as the repro steps. */
  environment?: string;
  status?: string;
  statusCategory?: string;
  type?: string;
  priority?: string;
  resolution?: string;
  labels: string[];
  components: string[];
  fixVersions: string[];
  assignee?: TicketPersonView;
  reporter?: TicketPersonView;
  createdAt?: string;
  updatedAt?: string;
  dueAt?: string;
  resolvedAt?: string;
  /**
   * The sprint the ticket is in, read on this fetch rather than taken from the
   * node: the panel is where "when is this meant to be done" gets asked, and the
   * answer wants the sprint's dates, not just its name. Absent for a backlog ticket
   * and on a site with no sprint field at all.
   */
  sprint?: SprintView;
  /** The epic or parent story this sits under, when it has one. */
  parent?: TicketRelationView;
  subtasks: TicketRelationView[];
  /** `blocks`, `is blocked by`, `relates to` — grouped by that verb in the panel. */
  links: TicketRelationView[];
  attachments: TicketAttachmentView[];
  comments: TicketCommentView[];
  /**
   * How many comments the ticket has, against however many are in `comments`. The
   * panel shows the newest few and needs this to say so honestly rather than
   * implying a truncated thread is the whole thread.
   */
  commentCount?: number;
}

export interface ConfluencePreviewView {
  /** The exact Smart Link URL present in Jira, including a tiny-link path. */
  url: string;
  pageId: string;
  title: string;
  /** Markdown converted from Confluence ADF and capped by the ticket service. */
  body: string;
}

export interface TicketPersonView {
  /** Stable Jira identity; display names are not unique. */
  accountId?: string;
  name: string;
  email?: string;
  /** Jira's own 24px avatar, already a full URL. Absent for a deleted account. */
  avatarUrl?: string;
}

/**
 * Another ticket this one points at: a parent, a subtask, or either end of a link.
 *
 * `relation` is the phrasing from *this* ticket's side — Jira gives both readings
 * of a link type and which one applies depends on which end you are standing at.
 */
export interface TicketRelationView {
  key: string;
  url: string;
  summary?: string;
  status?: string;
  statusCategory?: string;
  type?: string;
  /** "blocks", "is blocked by", "parent", "subtask". */
  relation: string;
  assignee?: string;
}

export interface TicketCommentView {
  id: string;
  author?: TicketPersonView;
  /** Markdown, from ADF. See `TicketDetailView.description`. */
  body: string;
  createdAt?: string;
  /** Only when it differs from `createdAt` — an edited comment is worth flagging. */
  updatedAt?: string;
  /**
   * The role or group this comment is restricted to, when it is restricted. Shown
   * as a badge: a panel that renders an internal note like a public reply is a way
   * to quote it to the wrong audience.
   */
  restrictedTo?: string;
}

export interface TicketAttachmentView {
  id?: string;
  filename: string;
  mimeType?: string;
  /** The description contains an ADF media node for this file. */
  inline?: boolean;
  /** Bytes, as Jira reports them. Formatted by the client. */
  size?: number;
  createdAt?: string;
  author?: string;
  /** Jira's authenticated download URL — only opens for a browser signed in to Jira. */
  url?: string;
}

export interface TicketTextAttachmentResponse {
  text: string;
  /** True when the source exceeded the server's bounded preview size. */
  truncated: boolean;
}

export interface TicketDetailResponse {
  ticket: TicketDetailView | null;
  /**
   * Why `ticket` is null or thin — an unconfigured Jira token, a ticket this
   * account cannot see. Same contract as `TicketGraphView.warnings`: reported so
   * the panel can explain itself instead of collapsing into a red box.
   */
  warning?: string;
}

/** GET/PUT body for `/api/me/fix-issue-defaults`. */
export interface FixIssueDefaultsView {
  /** A GitLab project — numeric id or `group/project`. */
  projectId: string;
  targetBranch: string;
}

/**
 * Every preference this developer has set — `GET /api/me/preferences`.
 *
 * Values are whatever JSON the owning page put there, typed as `unknown` because
 * that is the truth: a row written by last month's release outlives the code that
 * wrote it, so the page reading a key is the only thing that can say whether the
 * value still makes sense. Each reader parses defensively and falls back to its own
 * defaults — see the client's `usePreference`.
 *
 * One request for all of them rather than one per key: they are read once at boot to
 * decide what the first paint shows, and five round trips to draw one screen is the
 * shape that makes people put things back in localStorage.
 */
export interface PreferencesView {
  values: Record<string, unknown>;
}

/**
 * PUT `/api/me/preferences` — one key at a time.
 *
 * `null` clears the key rather than storing null, so "back to the default" and
 * "the default happens to be null" cannot be confused, and an abandoned preference
 * leaves no row behind.
 */
export interface PreferencePatch {
  key: string;
  value: unknown;
}

export interface CreateTaskInstance {
  definitionId: string;
  name: string;
  description?: string;
  params?: unknown;
  visibility?: Visibility;
  schedule?: Omit<SchedulePatch, "params">;
  promptTemplate?: string;
}

export interface UpdateTaskInstance {
  name?: string;
  description?: string | null;
  promptTemplate?: string | null;
}

/**
 * DELETE `/api/tasks/:id`. The id is echoed back so the caller can evict the
 * right cache entry from the response alone.
 */
export interface TaskDeletedView {
  id: string;
  deleted: true;
}

export interface MergeRequestView {
  iid: number;
  title: string;
  sourceBranch: string;
  webUrl: string;
}

export interface GitLabProjectView {
  pathWithNamespace: string;
  webUrl: string;
}

export interface BranchView {
  name: string;
}

export interface JiraIssueView {
  key: string;
  summary?: string;
}

export interface JiraUserView {
  accountId: string;
  displayName: string;
  email?: string;
}

/** Whose pull requests a listing covers — the two tabs on the Pull requests page. */
export type PullRequestScope = "mine" | "team";

export type PullRequestState = "open" | "draft" | "merged" | "closed";

/** One open pull/merge request, forge-neutral — see `application/pull-requests.ts`. */
export interface PullRequestView {
  provider: string;
  /** Provider-qualified, e.g. `gitlab:acme/webportal!6193`. Unique across forges. */
  id: string;
  /** What the forge calls it: GitLab's `iid`, GitHub's PR number. */
  number: number;
  title: string;
  state: PullRequestState;
  sourceBranch: string;
  targetBranch: string;
  webUrl: string;
  repository?: string;
  author?: { username: string; name?: string; avatarUrl?: string };
  createdAt?: string;
  updatedAt: string;
  /**
   * Set when an agent action is queued or running for this pull
   * request right now, however it was started — the pull request page's own
   * toolbar or the ticket graph's canvas. Cheap on every row: it comes from one
   * scan of the queue, not a lookup per pull request.
   */
  activeAction?: { action: PullRequestActionId; status: "queued" | "running" };
  /** True when a resolvable discussion is still open. Absent when the forge doesn't say. */
  hasUnresolvedThreads?: boolean;
}

export interface PullRequestsView {
  scope: PullRequestScope;
  /** The states this listing was filtered to, after normalisation. */
  states: PullRequestState[];
  /** The developer's own repository filter, applied to `team`. Empty means unfiltered. */
  repositoryFilter: string[];
  pullRequests: PullRequestView[];
  /**
   * Forges that could not be asked because a credential is missing. Not an
   * error: the page renders whatever else it got and explains the gap.
   */
  unavailable: { provider: string; label: string; missing: string[] }[];
  /** Forges that were asked and failed. */
  failed: { provider: string; label: string; message: string }[];
}

/**
 * GET `/api/pull-requests/active-actions` — the pull requests list's badge feed.
 *
 * Reads the job queue only, no forge call, so the list can poll it on a short
 * interval for a running indicator without the rate-limit cost of refetching the
 * listing itself.
 */
export interface PullRequestActiveActionsView {
  actions: {
    projectId: string;
    mrIid: number;
    action: PullRequestActionId;
    status: "queued" | "running";
  }[];
}

/** GET/PUT `/api/me/pull-request-repos` — the signed-in developer's Team MRs repository filter. */
export interface PullRequestRepoFilterView {
  /** `group/project` paths. Empty means unfiltered. */
  repositories: string[];
}

export interface PullRequestUserView {
  username: string;
  name?: string;
  avatarUrl?: string;
}

export interface PullRequestCommentView {
  id: string;
  author?: PullRequestUserView;
  /** Markdown, as written. The client renders it. */
  body: string;
  createdAt: string;
  /** A note the forge wrote about itself ("changed target branch"). Played down, not hidden. */
  system: boolean;
}

/** One conversation. A standalone comment is a thread of one. */
export interface PullRequestThreadView {
  id: string;
  resolvable: boolean;
  resolved: boolean;
  /** Set when the thread hangs off one or more lines of the diff. */
  anchor?: {
    path: string;
    line?: number;
    oldLine?: number;
    newLine?: number;
    range?: {
      start: { oldLine?: number; newLine?: number };
      end: { oldLine?: number; newLine?: number };
    };
  };
  comments: PullRequestCommentView[];
}

/** Whether the forge says this can be merged. `unknown` means it has not checked yet. */
export type PullRequestMergeability = "clean" | "conflicts" | "unknown";

/**
 * GET `/api/pull-requests/:id` — everything the detail pane shows, so a developer
 * never has to open the forge. A superset of the list row rather than a parallel
 * shape, so the UI has one object per pull request.
 */
export interface PullRequestDetailView extends PullRequestView {
  description?: string;
  reviewers: PullRequestUserView[];
  assignees: PullRequestUserView[];
  /** Absent when the forge will not say — approvals are a paid feature on GitLab. */
  approvals?: {
    required?: number;
    outstanding?: number;
    approvedBy: PullRequestUserView[];
  };
  mergeability: PullRequestMergeability;
  /** The forge's own wording (`conflict`, `not_approved`), passed through verbatim. */
  mergeBlockedReason?: string;
  threads: PullRequestThreadView[];
  /** Resolvable threads still open — what the "Address open comments" button acts on. */
  openThreadCount: number;
  /**
   * The branch's commits, as the forge lists them. Only the sha and subject are
   * guaranteed — `url`, `author` and `committedAt` are absent on older
   * self-managed payloads, which is why the Commits tab renders around them.
   */
  commits: {
    sha: string;
    title: string;
    url?: string;
    author?: string;
    committedAt?: string;
  }[];
  /** GitLab pipelines associated with this merge request, newest first. */
  pipelines: {
    id: number;
    status: string;
    ref: string;
    sha: string;
    url: string;
    createdAt?: string;
    updatedAt: string;
  }[];
  /** Recovered from the branch name, title or description; a naming convention, not a field. */
  issue?: { key: string; url?: string };
  /** Forge labels, verbatim — no colour, no grouping, just names for the sidebar. */
  labels: string[];
  /** Inlined so the toolbar draws its buttons without a second request on open. */
  actions: PullRequestActionView[];
}

export interface PullRequestFileChangeView {
  path: string;
  /** Differs from `path` only on a rename. */
  previousPath?: string;
  status: "added" | "removed" | "renamed" | "modified";
  /** Unified diff text. Absent when the forge refused to produce it — see `tooLarge`. */
  diff?: string;
  tooLarge: boolean;
}

/**
 * GET `/api/pull-requests/:id/changes` — fetched separately from the detail
 * because it is by far the largest part of the response and the pane does not
 * open on the Changes tab.
 */
export interface PullRequestChangesView {
  files: PullRequestFileChangeView[];
  /** True when the file list was cut off, so the UI can say so. */
  truncated: boolean;
}

/**
 * What a pull request can ask an agent to do. Every action is queued and runs in
 * a container; `revise` is driven by the conversation tab rather than the
 * one-click Actions menu because it requires a human instruction.
 */
export type PullRequestActionId =
  | "resolve-conflicts"
  | "address-comments"
  | "code-review"
  | "revise";

/**
 * The graph canvas exposes only the one-click actions. Free-form revision turns
 * live on the pull-request conversation tab, where an instruction can be entered.
 */
export type MrActionId = Exclude<PullRequestActionId, "revise">;

/**
 * `idle` means nothing has been asked for yet — distinct from `done`, which the
 * UI reports. `running` covers a leased job; `failed` a dead one.
 */
export type PullRequestActionStatus = "idle" | "queued" | "running" | "done" | "failed";

/**
 * How one action's most recent attempt is going. Everything here is derived from
 * the job queue alone, which is what makes it cheap enough to poll every second.
 */
export interface PullRequestActionStateView {
  action: PullRequestActionId;
  status: PullRequestActionStatus;
  jobId?: string;
  /** The run behind the most recent attempt, for streaming its agent log inline. */
  runId?: string;
  /** Plain-language status line for the pill. */
  message?: string;
  /** When the job last changed state. */
  updatedAt?: string;
}

/**
 * A button in the toolbar: its live state, plus whether it makes sense to press.
 *
 * `available` is deliberately *not* on `PullRequestActionStateView`: answering it
 * needs the merge request itself (are there conflicts? open threads?), which is a
 * forge round trip. So it is settled once, when the detail loads, while the state
 * above polls on its own.
 */
export interface PullRequestActionView extends PullRequestActionStateView {
  available: boolean;
  /** Why not, when `available` is false — shown as the button's tooltip. */
  unavailableReason?: string;
}

/**
 * GET `/api/pull-requests/:id/actions` — job state only, no forge call, so the
 * pills can poll without re-fetching threads and commits.
 */
export interface PullRequestActionsView {
  actions: PullRequestActionStateView[];
  /** True while any action is queued or running. Drives the client's poll. */
  live: boolean;
}

/**
 * One past attempt at an action, for the Activity tab's history list — unlike
 * `PullRequestActionStateView` this is not "the latest", it is one row among
 * many, so it carries its own start time rather than a single `updatedAt`.
 */
export interface PullRequestActivityEntryView {
  action: PullRequestActionId;
  status: PullRequestActionStatus;
  jobId?: string;
  /** The run behind this attempt, for streaming its agent log inline. */
  runId?: string;
  /** Plain-language status line, same wording as the toolbar pill. */
  message?: string;
  startedAt: string;
  finishedAt?: string;
}

/**
 * GET `/api/pull-requests/:id/activity` — every past action run on this merge
 * request, newest first.
 */
export interface PullRequestActivityView {
  entries: PullRequestActivityEntryView[];
}

/**
 * GET `/api/pull-requests/:id/runs` — the recorded runs against this merge
 * request, newest first, whoever started them.
 *
 * Separate from `/activity` rather than folded into it because the two answer
 * different questions: a job that is still queued has no run row yet, so
 * `/activity` remains the only view of "asked for, not started", while this is
 * the paginated history with durations, params and logs. Reuses `TaskRunView`
 * verbatim — a run is a run whether the loops page or a merge request shows it.
 */
export interface PullRequestRunPageView {
  runs: TaskRunView[];
  total: number;
}

/** POST `/api/pull-requests/:id/actions`. */
export interface PullRequestActionRequest {
  action: PullRequestActionId;
  /** Required for `revise`; ignored by the one-click actions. */
  instruction?: string;
  /** Bounded prior turns supplied to a fresh revision container for context. */
  history?: AssistantMessage[];
}

export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body?: string;
  link?: string;
  taskRunId?: string;
  createdAt: string;
  readAt?: string;
}

export interface NotificationsView {
  notifications: NotificationView[];
  unreadCount: number;
}

/**
 * The notification kinds a developer can turn off, with what to call each one in
 * Settings → Notifications.
 *
 * A closed catalog, even though `notifications.kind` is a free-form column: the
 * point of the screen is a checkbox per thing that can reach the bell, and a list
 * derived from whatever happens to be in the table would lose a row the moment its
 * last notification aged out of the week-long window. A kind that is not listed
 * here is always delivered — an unknown kind is a new feature nobody has muted,
 * not something to hide.
 *
 * The ids are the task ids that raise them (`kind: FIX_JIRA_ISSUE_TASK_ID`, …),
 * plus `task-success` for the generic "loop finished" notice the run sink posts.
 */
export const NOTIFICATION_KINDS = [
  {
    id: "task-success",
    label: "Loop finished",
    description: "A scheduled loop completed a tick, with what it processed.",
  },
  {
    id: "fix-jira-issue",
    label: "Fix issue merge requests",
    description: "An agent turned a Jira issue into a merge request.",
  },
  {
    id: "jira-ticket-to-mr-one",
    label: "Ticket → merge request",
    description: "A ticket the loop picked up reached a merge request.",
  },
  {
    id: "gitlab-review-requested",
    label: "Review requested",
    description: "Somebody asked you to review a merge request.",
  },
  {
    id: "gitlab-resolve-conflicts-one",
    label: "Conflicts resolved",
    description: "An agent rebased or resolved conflicts on a merge request.",
  },
  {
    id: "write-regression-test",
    label: "Regression tests",
    description: "An agent wrote a test covering a production error.",
  },
  {
    id: "triage-datadog-error",
    label: "Datadog AI triage",
    description: "AI classified a Datadog error and recommended the next action.",
  },
  {
    id: "triage-automation-failure",
    label: "Automation AI triage",
    description:
      "AI classified an Automation failure cluster and recommended the next action.",
  },
  {
    id: "review-ticket-description",
    label: "Ticket reviews",
    description: "A ticket description was reviewed for missing detail.",
  },
  {
    id: "deploy-watch",
    label: "Deploy watch",
    description: "A post-deploy watch found a new Datadog or LogRocket error.",
  },
  {
    id: "release-pipeline-watch",
    label: "Release pipeline failures",
    description: "An uploaded release failed its GitLab pipeline or did not merge.",
  },
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]["id"];

/** One row of My notifications. */
export interface NotificationSubscriptionView {
  kind: string;
  label: string;
  description: string;
  /** False when this developer has unsubscribed — the bell drops these entirely. */
  subscribed: boolean;
}

/** GET/PUT `/api/me/notification-subscriptions`. */
export interface NotificationSubscriptionsView {
  subscriptions: NotificationSubscriptionView[];
}

export interface NotificationSubscriptionPatch {
  kind: string;
  subscribed: boolean;
}

/**
 * PUT `/api/me/notification-subscriptions` — the whole set, not a delta.
 *
 * The screen has a Save button, so what it holds when you press it is the answer:
 * sending the complete state makes the write idempotent and rules out the half-saved
 * outcome a per-toggle request has when the third of five calls fails. Kinds left
 * out are untouched, which is what keeps an older client from silently
 * re-subscribing you to a kind it has never heard of.
 */
export interface NotificationSubscriptionsPatch {
  subscriptions: NotificationSubscriptionPatch[];
}

/**
 * GET `/api/me/profile` — the signed-in developer's own account.
 *
 * Always the asker's own row, for the reason `/api/me/preferences` gives: a route
 * that takes a user id is a route somebody eventually reads somebody else's
 * account through.
 */
export interface ProfileView {
  id: string;
  name: string;
  email: string;
  /** Absent for the two built-in accounts, which predate the table. */
  createdAt?: string;
  /**
   * A built-in `admin`/`operator` account, which lives in code rather than in
   * `auth_users`: its name cannot be edited, its address cannot be verified, and
   * it cannot be deleted.
   */
  builtIn: boolean;
}

/** PUT `/api/me/profile` — only the display name is the developer's to change. */
export interface ProfilePatch {
  name: string;
}

/** DELETE `/api/me/profile` — password re-entry, because this cannot be undone. */
export interface DeleteAccountRequest {
  password: string;
}

export interface AccountDeletedView {
  deleted: true;
  /** Private loops removed along with the account, by id — they had no other owner. */
  deletedLoops: string[];
}

export interface SystemView {
  version: string;
  configPath: string;
  databasePath: string;
  schemaVersion: number;
  logLevel: string;
  dryRun: boolean;
  orphanedRuns: number;
  connectors: { name: string; ready: boolean; missing: string[] }[];
  secrets: { name: string; present: boolean }[];
  /** Every integrated third-party tool (connectors plus inbound-only ones like LogRocket), for the footer. */
  integrations: { name: string; ready: boolean }[];
  /** Jobs currently queued or leased, across all loops. */
  runningJobs: number;
  agentCapacity: OrchestrationCapacityView;
}

export interface OrchestrationCapacityView {
  total: number;
  interactiveReservation: number;
  occupied: number;
  uncertain: number;
  available: number;
  draining: boolean;
}

export interface OrchestrationAttemptView {
  id: string;
  executionId: string | null;
  jobId: string | null;
  actorId: string | null;
  lane: "background" | "interactive";
  workloadKind: string;
  slot: number;
  state:
    | "starting"
    | "running"
    | "stopping"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "superseded"
    | "uncertain";
  runtimeKind: "docker" | "kubernetes" | "host";
  runtimeId: string | null;
  reason: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface OrchestrationView {
  installationId: string;
  capacity: OrchestrationCapacityView;
  suspension: CheckpointCapabilityView;
  attempts: OrchestrationAttemptView[];
  jobs: OrchestrationJobView[];
  checkpoints: CheckpointView[];
}

export interface CheckpointCapabilityView {
  supported: boolean;
  provider: string | null;
  protocolVersion: number | null;
  runtimeKinds: Array<"docker" | "kubernetes" | "host">;
  cooperativeCheckpoint: boolean;
  durableWorkspace: boolean;
  durableSession: boolean;
  replaySafeEffects: boolean;
  reason: string | null;
}

export interface CheckpointView {
  id: string;
  attemptId: string;
  executionId: string;
  jobId: string | null;
  provider: string;
  protocolVersion: number;
  status: "preparing" | "ready" | "resuming" | "consumed" | "failed" | "invalid";
  reason: string | null;
  createdAt: string;
  readyAt: string | null;
  consumedAt: string | null;
}

export interface OrchestrationJobView {
  id: string;
  kind: string;
  loopId: string;
  subjectKey: string | null;
  status:
    | "queued"
    | "held"
    | "starting"
    | "running"
    | "stopping"
    | "uncertain"
    | "done"
    | "failed"
    | "cancelled"
    | "superseded";
  priority: number;
  attempts: number;
  maxAttempts: number;
  executionId: string | null;
  waitingReason: string | null;
  supersededByJobId: string | null;
  enqueuedAt: string;
}

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const LLM_MODELS = [
  "haiku",
  "sonnet",
  "opus",
  "fable",
  // Literal Bedrock inference-profile IDs, for when the alias above resolves
  // to an older snapshot than the account can actually invoke — confirmed to
  // happen for `sonnet` on Bedrock (the alias falls back to the 4.5 snapshot
  // even though `aws bedrock-runtime converse` on this exact ID succeeds).
  // Bypasses the CLI's own alias resolution entirely by asking for the
  // snapshot outright. Bedrock-specific: pick one of the four above instead
  // if the connected account authenticates directly against Anthropic's API.
  "us.anthropic.claude-sonnet-5",
  "us.anthropic.claude-opus-5",
] as const;
export type LlmModel = (typeof LLM_MODELS)[number];

/**
 * The version each alias currently tracks, shown next to the alias in Settings so
 * an operator can tell at a glance which generation a run will use.
 *
 * Advisory, not authoritative: the alias is what reaches `claude --model`, and the
 * Claude Code inside the agent image is what resolves it — an image built before a
 * release still resolves `sonnet` to the older snapshot. The run log's
 * `claude started (<model>)` line is the ground truth for a given run.
 */
export const LLM_MODEL_VERSIONS: Record<LlmModel, string> = {
  haiku: "Claude Haiku 4.5",
  sonnet: "Claude Sonnet 5",
  opus: "Claude Opus 5",
  fable: "Claude Fable 5",
  "us.anthropic.claude-sonnet-5": "Sonnet 5 — Bedrock ID, bypasses the alias",
  "us.anthropic.claude-opus-5": "Opus 5 — Bedrock ID, bypasses the alias",
};

/**
 * GET `/api/settings/resolved-models` — for each alias, the concrete snapshot
 * the most recent run that used it actually reported via the CLI's
 * `claude started (<model>)` log line. `null` if no run has used that alias
 * yet. This is the live counterpart to `LLM_MODEL_VERSIONS` above: the label
 * there is advisory, this is what actually ran.
 */
export type ResolvedModelInfo = { model: string; ts: string } | null;
export type ResolvedModelsView = Record<LlmModel, ResolvedModelInfo>;
export const LLM_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type LlmEffort = (typeof LLM_EFFORTS)[number];

const CLAUDE_DIRECT_MODELS: readonly LlmModel[] = [
  "haiku",
  "sonnet",
  "opus",
  "fable",
];

const CLAUDE_BEDROCK_MODELS: readonly LlmModel[] = [
  "haiku",
  "sonnet",
  "opus",
  "us.anthropic.claude-sonnet-5",
  "us.anthropic.claude-opus-5",
];

/**
 * The model controls that make sense for one connected agent.
 *
 * This is compatibility, not entitlement discovery: an IAM policy can still
 * deny a Bedrock model, and neither TALOS nor Claude Code has a safe generic
 * "list what this credential may invoke" operation. An unknown Claude runtime
 * (the host fallback) keeps the full list because it may itself use Bedrock.
 */
export function agentLlmCapabilities(
  provider: AgentProvider,
  optionId?: string,
): { models: readonly LlmModel[]; efforts: readonly LlmEffort[] } {
  if (provider !== "claude") return { models: [], efforts: [] };
  if (optionId?.startsWith("claude:bedrock-")) {
    return { models: CLAUDE_BEDROCK_MODELS, efforts: LLM_EFFORTS };
  }
  return {
    models: optionId ? CLAUDE_DIRECT_MODELS : LLM_MODELS,
    efforts: LLM_EFFORTS,
  };
}

/**
 * GET/PUT `/api/me/agent-run-preferences` — the model defaults for agent work
 * started by this developer. Null inherits the instance default used by loops.
 */
export interface AgentRunPreferencesView {
  model: LlmModel | null;
  effort: LlmEffort | null;
}

export type AgentRunPreferencesPatch = AgentRunPreferencesView;

export const AGENT_PROVIDERS = ["claude", "cursor", "codex", "copilot"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

/**
 * GET `/api/agents` — one entry per coding agent this host is signed in to.
 *
 * Detected, not configured: talos runs the agent locally, so the honest list
 * is whatever the vendors' own config directories say is logged in, and there is
 * nothing for the operator to connect. See `infrastructure/agent/detect.ts`.
 */
export interface AgentConnectionView {
  provider: AgentProvider;
  name: string;
  /** The signed-in account, when the vendor's config records one. */
  account?: string;
  /**
   * Whether talos can drive this agent, as opposed to merely seeing it
   * installed. Only Claude today — the others are listed so the loop form can
   * show them greyed rather than claim the host has nothing else on it.
   */
  runnable: boolean;
}

/**
 * How a stored agent account proves who it is.
 *
 * `key` is a credential the developer pastes — an API key, or a subscription
 * token the vendor's own CLI printed for them. talos encrypts it and hands it
 * to a run as the vendor's environment variable.
 *
 * `cli` delegates: talos runs the vendor's own login command against a config
 * directory reserved for this account and streams what it prints back into the
 * browser. The credential is minted by the vendor and stays in that directory —
 * talos records the provider, the label and the account it ended up as.
 *
 * There is no third option, and specifically no "sign in with ChatGPT/Claude"
 * button: none of these vendors publish an OAuth app that would let a third
 * party act on somebody's subscription. The credential is always minted on a
 * machine the developer controls, which is why the delegated path exists.
 */
export const AGENT_AUTH_METHODS = ["key", "cli"] as const;
export type AgentAuthMethod = (typeof AGENT_AUTH_METHODS)[number];

/**
 * One value a `key` option needs, and the variable it becomes.
 *
 * Plural because one credential is not always one value: Bedrock wants a region
 * and either a bearer token or an access key pair, and a form that only holds a
 * single field cannot express the way most enterprises actually run Claude. An
 * option with one field renders exactly as it did when this was a lone `env`.
 */
export interface AgentAuthField {
  /** The environment variable this becomes for the run. */
  env: string;
  /** e.g. "Access key ID". Absent for a `value` field, which is never shown. */
  label?: string;
  /**
   * Whether to mask the input. Also decides nothing about storage: the whole set
   * is encrypted together either way, because a region beside a secret key is
   * cheaper to encrypt than to split.
   */
  secret?: boolean;
  /** Placeholder, e.g. "AKIA…", "us-east-1". */
  hint?: string;
  /**
   * A fixed value that is set rather than asked for — `CLAUDE_CODE_USE_BEDROCK=1`
   * is a switch, not a credential, and putting it on screen would only invite
   * somebody to type something else into it.
   */
  value?: string;
  /** Not required to submit the form — `AWS_SESSION_TOKEN` for temporary creds. */
  optional?: boolean;
}

/** One way to connect a given provider, as offered by the Add account form. */
export interface AgentAuthOption {
  method: AgentAuthMethod;
  /** Stable within a provider — `codex:key`, `claude:cli`. */
  id: string;
  /** e.g. "API key", "Connect your ChatGPT account". */
  label: string;
  /** What this option actually does, and what it costs against. */
  description: string;
  /** For `key`: the values to collect, in the order to show them. */
  fields?: AgentAuthField[];
  /** For `cli`: the command talos will run on the host, shown before it runs. */
  command?: string;
  /** Whether the vendor's tooling has to be installed on the host for this. */
  needsCli: boolean;
}

/**
 * The login talos's own runner already gives this provider's containers.
 *
 * Not detection: `path` comes off the `docker run` argv (`hostClaudeConfigDir`),
 * so this says "every Claude run uses this directory", which is true whether or
 * not anything is signed in and needs nobody's config file opened to establish.
 * Nothing about *what* the login is — subscription, API key, Bedrock — is read or
 * reported, because that is between the operator and the vendor.
 *
 * Only sent while *you* have no account connected for the provider, because that
 * is exactly when your runs fall back to it. Connect one and your runs stop using
 * it, so your card stops claiming they do — somebody else who has connected
 * nothing still sees it, because they are still borrowing it.
 *
 * There is no disconnect for it here — it belongs to whoever runs the talos
 * process, is shared by everyone on the install, and is changed on the host.
 */
export interface AgentHostRuntime {
  /** The directory mounted into each container, e.g. `/home/you/.claude`. */
  path: string;
}

/**
 * One provider in the Agent connections catalog, with its accounts.
 *
 * `accounts` is only what somebody connected through this dialog. It deliberately
 * does not include logins found by reading the host's home directory: a page that
 * volunteers the email behind an operator's personal Codex session is reporting
 * private information nobody offered it, however convenient the reporting is.
 */
export interface AgentCatalogEntry {
  provider: AgentProvider;
  name: string;
  /** One line on what the agent is, for the card. */
  tagline: string;
  /** The vendor's own auth documentation. */
  docs: string;
  options: AgentAuthOption[];
  accounts: AgentAccountView[];
  /** Present while this developer's runs still borrow this machine's own login. */
  hostRuntime?: AgentHostRuntime;
}

/** A connected agent account, described without its credential. */
export interface AgentAccountView {
  id: string;
  provider: AgentProvider;
  /** What the developer called it — "work ChatGPT", "personal Max plan". */
  label: string;
  method: AgentAuthMethod;
  /** The option it was created through, e.g. `claude:key-oauth`. */
  optionId: string;
  /** The identity the vendor reported, when it reported one. */
  account?: string;
  /**
   * A stored secret this process cannot decrypt — `TALOS_SECRET_KEY` changed
   * or went since it was saved. Reported rather than hidden, exactly as
   * `StoredIntegrationSetting.unreadable` is: the row exists and yet the account
   * does not work, and re-entering the credential is the only fix.
   */
  unreadable?: boolean;
  /**
   * Whether *your* agent runs use this account — at most one per provider, per
   * developer. A run authenticates as whoever it is for: you, when you click Run,
   * or the owner of the loop that ticked. The first account you connect for a
   * provider takes the flag automatically, and
   * `POST /api/me/agent-accounts/use-for-runs` moves it, so this only needs
   * thinking about once you have two accounts with one vendor.
   */
  usedForRuns?: boolean;
  createdAt: string;
}

/** GET `/api/me/agent-accounts`. */
export interface AgentAccountsView {
  /** False without `TALOS_SECRET_KEY`: the `key` methods refuse to store. */
  secretsEnabled: boolean;
  catalog: AgentCatalogEntry[];
}

export interface AgentUsageTokensView {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface AgentUsageBreakdownView {
  key: string;
  label: string;
  invocations: number;
  knownUsageInvocations: number;
  tokens: AgentUsageTokensView;
}

export interface AgentUsageEventView {
  id: string;
  /** Present only in the administrator's global report. */
  user?: { id: string; name: string };
  accountId?: string;
  accountLabel: string;
  optionId?: string;
  authSource: "connected" | "host";
  provider: string;
  model?: string;
  source: "task" | "assistant" | "e2e";
  executionId?: string;
  invocationLabel?: string;
  status: "success" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string;
  durationMs?: number;
  turns?: number;
  /** Absent when the provider did not emit telemetry; this is not zero usage. */
  tokens?: AgentUsageTokensView;
}

/** GET `/api/me/agent-usage`. Actor-scoped; historical account labels are snapshots. */
export interface AgentUsageReportView {
  range: { from: string; to: string };
  totals: AgentUsageBreakdownView;
  daily: Array<{ date: string; tokens: AgentUsageTokensView; invocations: number }>;
  accounts: AgentUsageBreakdownView[];
  models: AgentUsageBreakdownView[];
  sources: AgentUsageBreakdownView[];
  events: AgentUsageEventView[];
  eventCount: number;
}

/** How a delegated login is going, polled while the modal is open. */
export const AGENT_LOGIN_STATES = ["running", "done", "failed"] as const;
export type AgentLoginState = (typeof AGENT_LOGIN_STATES)[number];

/**
 * One delegated login in flight — the vendor's CLI, running on the host, with
 * its output pointed at the browser.
 *
 * Deliberately a transcript plus a couple of extracted fields rather than a
 * state machine per vendor: these commands change their prompts between
 * releases, and a flow that only works when we recognise every line is a flow
 * that breaks on the next update. `url` and `code` are a convenience for the
 * common case; `output` is the ground truth, and `input` is how the developer
 * answers whatever it asked.
 */
export interface AgentLoginView {
  id: string;
  provider: AgentProvider;
  state: AgentLoginState;
  /** The command being run, so it is clear what was executed on the host. */
  command: string;
  /** Everything it has printed, secrets already stripped. */
  output: string;
  /** The verification URL, when one has been printed. */
  url?: string;
  /** The device/pairing code, when one has been printed. */
  code?: string;
  /** Set once `state` is `done` — the account row that was created. */
  account?: AgentAccountView;
  /** Set once `state` is `failed`. */
  error?: string;
}

/** How much a custom loop's agent may do with what it concludes. */
export const CUSTOM_LOOP_PERMISSIONS = ["read-only", "push", "push-mr"] as const;
export type CustomLoopPermission = (typeof CUSTOM_LOOP_PERMISSIONS)[number];

/** The definition id a user-authored loop is an instance of. */
export const CUSTOM_LOOP_DEFINITION_ID = "custom-loop";

/** One repository+branch a custom loop runs its prompt against. */
export interface CustomLoopRepository {
  projectId: string;
  branch: string;
}

/**
 * The params a custom loop is created with — the browser-side mirror of
 * `CustomLoopParamsSchema`, which is what actually validates them.
 */
export interface CustomLoopParams {
  prompt: string;
  repositories: CustomLoopRepository[];
  agent: { provider: AgentProvider; account?: string };
  llm: { model?: LlmModel; effort?: LlmEffort };
  permissions: CustomLoopPermission;
}

export interface GeneralSettings {
  logLevel: LogLevel;
  logLevelOrigin: "db" | "default";
  timezone: string | null;
  timezoneOrigin: "db" | "default";
  llm: {
    provider: string;
    model: string | null;
    effort: string | null;
    maxTokens: number;
  };
  llmOrigin: "db" | "default";
}

export interface GeneralSettingsPatch {
  logLevel?: LogLevel | null;
  timezone?: string | null;
  llm?: {
    provider?: string | null;
    model?: string | null;
    effort?: string | null;
    maxTokens?: number | null;
  };
}

/** One overridable LLM prompt template — a full prompt an agent task builds. */
export interface PromptTemplateView {
  id: string;
  label: string;
  description: string;
  /** `{{name}}` placeholders this template may use. */
  variables: string[];
  /** The effective template: the DB override, or `defaultTemplate` if unset. */
  template: string;
  defaultTemplate: string;
  origin: "db" | "default";
}

export interface PromptsView {
  prompts: PromptTemplateView[];
}

/** `null` reverts a prompt id to its default; an id absent from the patch is left untouched. */
export type PromptsPatch = Record<string, string | null>;

/**
 * GET `/api/settings/e2e-tests` — instance-wide inputs used by ticket E2E jobs.
 *
 * Null file overrides mean that the runner fetches the documented file from the
 * Test-Automation repository at run time. Additional instructions are owned by
 * Talos and are mounted as a separate, non-safety-critical context file.
 */
export interface E2eTestSettingsView {
  agentInstructionsOverride: string | null;
  runtimeConfigOverride: string | null;
  /** False means a runtime replacement cannot be stored securely. */
  secretsEnabled: boolean;
  /** A stored replacement could not be decrypted with the current key. */
  runtimeConfigUnreadable: boolean;
  additionalInstructions: string | null;
  sources: {
    project: string;
    ref: string;
    agentInstructionsPath: string;
    runtimeConfigPath: string;
  };
}

/** PUT body for `/api/settings/e2e-tests`; omitted fields are left unchanged. */
export interface E2eTestSettingsPatch {
  agentInstructionsOverride?: string | null;
  runtimeConfigOverride?: string | null;
  additionalInstructions?: string | null;
}

export interface AutomationJiraConfigView {
  projectKey: string;
  parentKey: string | null;
  issueType: string;
  boardId: number | null;
  useActiveSprint: boolean;
  labels: string[];
  assigneeMode: "automatic" | "fixed";
  /** Jira account id or email. Null unless fixed assignment is selected. */
  fixedAssignee: string | null;
}

export interface AutomationAutoRetryConfigView {
  enabled: boolean;
  maxJobsPerPipeline: number;
}

export interface AutomationConfiguredScheduleView {
  scheduleId: number;
  displayName?: string;
  autoRetry: AutomationAutoRetryConfigView;
}

/** Instance-wide Automation source, schedule allowlist, and ticketing defaults. */
export interface AutomationConfigView {
  /** Whether the GitLab reporting source has been configured. */
  configured: boolean;
  projectId: string | null;
  schedules: AutomationConfiguredScheduleView[];
  jiraConfigured: boolean;
  jira: AutomationJiraConfigView | null;
}

/** Complete replacement body for `PUT /api/automation/config`. */
export interface AutomationConfigPatch {
  projectId: string;
  schedules: Array<{
    scheduleId: number;
    displayName?: string | null;
    autoRetry?: {
      enabled?: boolean;
      maxJobsPerPipeline?: number;
    };
  }>;
  /** Null or omitted keeps Automation reporting usable without Jira ticketing. */
  jira?: {
    projectKey: string;
    parentKey?: string | null;
    issueType?: string | null;
    boardId?: number | null;
    useActiveSprint?: boolean;
    labels?: string[];
    assigneeMode?: "automatic" | "fixed";
    /** Jira account id or email. Required when assigneeMode is fixed. */
    fixedAssignee?: string | null;
  } | null;
}

/** One schedule returned by GitLab for the Automation settings picker. */
export interface AutomationScheduleDiscoveryView {
  id: number;
  description: string;
  ref: string;
  cron: string | null;
  active: boolean;
}

export interface AutomationScheduleDiscoveryResponse {
  schedules: AutomationScheduleDiscoveryView[];
}

/**
 * A pipeline's product-level outcome. Report collection failures are distinct
 * from a pipeline infrastructure failure, so operators know whether CI or the
 * Automation sync needs attention.
 */
export type AutomationPipelineOutcome =
  | "passed"
  | "test-failed"
  | "infrastructure-failed"
  | "running"
  | "canceled-skipped"
  | "report-missing"
  | "report-error";

export interface AutomationTestCountsView {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
}

export interface AutomationDashboardTotalsView {
  pipelines: number;
  outcomes: Record<AutomationPipelineOutcome, number>;
  /** GitLab-success pipelines divided by terminal success/failed pipelines. */
  pipelineSuccessRate: number | null;
  /** Passed tests divided by passed/failed/error tests; skipped tests are excluded. */
  testPassRate: number | null;
  tests: AutomationTestCountsView;
  averageDurationSeconds: number | null;
}

export interface AutomationJobRetrySummaryView {
  state: "claimed" | "complete" | "partial" | "failed";
  requestedAt: string;
  completedAt: string | null;
  acceptedJobs: number;
  failedJobs: number;
  error: string | null;
}

/** Compact pipeline data used in dashboard rows; child failure bodies are detail-only. */
export interface AutomationPipelineCompactView {
  pipelineId: number;
  scheduleId: number;
  status: string;
  outcome: AutomationPipelineOutcome;
  ref: string;
  sha: string;
  webUrl: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  reportState: "pending" | "complete" | "missing" | "error" | null;
  tests: AutomationTestCountsView | null;
  autoRetry: AutomationJobRetrySummaryView | null;
}

/** One server-paginated dashboard row, named from its configured schedule. */
export interface AutomationRecentPipelineView
  extends AutomationPipelineCompactView {
  scheduleName: string;
}

export interface AutomationRecentPipelinePageView {
  limit: number;
  offset: number;
  total: number;
  items: AutomationRecentPipelineView[];
}

export interface AutomationTrendDayView {
  /** UTC calendar date (`YYYY-MM-DD`). */
  date: string;
  pipelines: number;
  outcomes: Record<AutomationPipelineOutcome, number>;
  tests: AutomationTestCountsView;
}

/**
 * The representative daily run for one configured schedule. The dashboard
 * selects the newest terminal run so reruns do not inflate test inventory.
 */
export interface AutomationScheduleTrendDayView {
  /** UTC calendar date (`YYYY-MM-DD`). */
  date: string;
  pipelineId: number | null;
  outcome: AutomationPipelineOutcome | null;
  tests: AutomationTestCountsView | null;
  durationSeconds: number | null;
  /** Every matching run that day, including reruns. */
  runCount: number;
  /** A passing representative run followed an earlier unhealthy run. */
  unstable: boolean;
}

export interface AutomationScheduleTrendView {
  scheduleId: number;
  displayName: string;
  days: AutomationScheduleTrendDayView[];
}

export interface AutomationScheduleMetadataView {
  description: string;
  ref: string;
  cron: string | null;
  cronTimezone: string | null;
  nextRunAt: string | null;
  active: boolean;
  syncedAt: string;
}

export interface AutomationScheduleDashboardView {
  scheduleId: number;
  displayName: string;
  metadata: AutomationScheduleMetadataView | null;
  /** Latest stored pipeline regardless of the selected date/status filters. */
  latestPipeline: AutomationPipelineCompactView | null;
  rangeStats: AutomationDashboardTotalsView;
  noData: boolean;
  stale: boolean;
}

export interface AutomationAttentionItemView {
  code:
    | "configuration-required"
    | "schedule-not-synced"
    | "schedule-stale"
    | "schedule-no-data"
    | "latest-pipeline-needs-attention";
  severity: "info" | "warning" | "error";
  scheduleId: number | null;
  pipelineId: number | null;
  message: string;
}

export interface AutomationDashboardView {
  configured: boolean;
  projectId: string | null;
  generatedAt: string;
  lastSyncedAt: string | null;
  days: 1 | 7 | 30;
  filters: { scheduleId: number | null; status: string | null };
  totals: AutomationDashboardTotalsView;
  trend: AutomationTrendDayView[];
  scheduleTrends: AutomationScheduleTrendView[];
  schedules: AutomationScheduleDashboardView[];
  attentionItems: AutomationAttentionItemView[];
  recentPipelines: AutomationRecentPipelinePageView;
}

export interface AutomationTestReportView {
  totalTimeSeconds: number;
  totalCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  errorCount: number;
  suiteError: string | null;
}

export interface AutomationPipelineJobView {
  jobId: number;
  name: string;
  stage: string;
  status: string;
  failureReason: string | null;
  allowFailure: boolean;
  webUrl: string;
  durationSeconds: number | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  report: AutomationTestReportView | null;
}

export interface AutomationTestSuiteView extends AutomationTestReportView {
  index: number;
  name: string;
  buildIds: number[];
}

export interface AutomationFailedTestView {
  suiteIndex: number;
  caseIndex: number | null;
  jobId: number | null;
  status: "failed" | "error";
  name: string;
  classname: string | null;
  executionTimeSeconds: number;
  systemOutput: string | null;
  stackTrace: string | null;
  attachmentName: string | null;
  /** Credential-free GitLab artifact page URL. */
  attachmentUrl: string | null;
  /** Authenticated TALOS image endpoint; null when no safe attachment was stored. */
  attachmentProxyUrl: string | null;
}

export interface AutomationPipelineDetailView extends AutomationPipelineCompactView {
  projectId: string;
  createdAt: string | null;
  report: AutomationTestReportView | null;
  jobs: AutomationPipelineJobView[];
  suites: AutomationTestSuiteView[];
  failedTests: AutomationFailedTestView[];
}

export type AutomationClusterTriageState =
  | "untriaged"
  | "ticketed"
  | "active-mr";

export interface AutomationFailureClusterWorkView {
  state: "creating" | "ticketed" | "active-mr";
  jiraKey: string | null;
  jiraUrl: string | null;
  mrIid: number | null;
  mrUrl: string | null;
  updatedAt: string;
}

export type AutomationAiTriageVerdict =
  | "bad-data"
  | "service-breaking-change"
  | "ui-change"
  | "test-bug"
  | "infrastructure"
  | "unknown";

export interface AutomationAiTriageView {
  verdict: AutomationAiTriageVerdict;
  confidence: number;
  rationale: string;
  recommendation: string;
  taskRunId: string;
  updatedAt: string;
}

/** Compact cluster row. Full output and stack traces are detail-only. */
export interface AutomationFailureClusterView {
  signatureKey: string;
  title: string;
  severity: "failed" | "error";
  occurrenceCount: number;
  affectedTestCount: number;
  sampleTestName: string;
  sampleClassname: string | null;
  jobIds: number[];
  suiteIndexes: number[];
  triageState: AutomationClusterTriageState;
  creating: boolean;
  work: AutomationFailureClusterWorkView | null;
  /** Why Jira creation is unavailable, or null when it can be requested. */
  ticketRefusal: string | null;
  aiTriage: AutomationAiTriageView | null;
  aiTriageInFlight: boolean;
  aiTriageRefusal: string | null;
}

export interface AutomationFailureClusterListView {
  pipelineId: number;
  scheduleId: number;
  limit: number;
  offset: number;
  total: number;
  items: AutomationFailureClusterView[];
  facets: {
    states: Record<AutomationClusterTriageState, number>;
    jobs: Array<{ jobId: number; name: string; count: number }>;
    suites: Array<{ suiteIndex: number; name: string; count: number }>;
  };
}

export type AutomationFailurePresence = "current" | "recent";

export interface AutomationFailureAssigneeView extends TalosUserView {
  assignedAt: string;
}

export interface AutomationFailureAssignmentPatch {
  userId: string | null;
}

export interface AutomationFailureAssignmentView {
  assignee: AutomationFailureAssigneeView | null;
}

/** One schedule-scoped normalized failure aggregated across pipeline runs. */
export interface AutomationFailureInboxItemView {
  scheduleId: number;
  scheduleName: string;
  signatureKey: string;
  title: string;
  severity: "failed" | "error";
  firstSeenAt: string;
  lastSeenAt: string;
  pipelineCount: number;
  latestPipelineId: number;
  latestPipelineUrl: string;
  latestRef: string;
  latestSha: string;
  latestUpdatedAt: string;
  occurrenceCount: number;
  affectedTestCount: number;
  sampleTestName: string;
  sampleClassname: string | null;
  current: boolean;
  assignee: AutomationFailureAssigneeView | null;
  triageState: AutomationClusterTriageState;
  creating: boolean;
  work: AutomationFailureClusterWorkView | null;
  ticketRefusal: string | null;
  aiTriage: AutomationAiTriageView | null;
  aiTriageInFlight: boolean;
  aiTriageRefusal: string | null;
  autoRetry: AutomationJobRetrySummaryView | null;
}

export interface AutomationFailureInboxView {
  generatedAt: string;
  days: 1 | 7 | 30;
  presence: AutomationFailurePresence;
  limit: number;
  offset: number;
  total: number;
  items: AutomationFailureInboxItemView[];
  facets: {
    states: Record<AutomationClusterTriageState, number>;
    schedules: Array<{ scheduleId: number; scheduleName: string; count: number }>;
    current: number;
    recent: number;
    /** Live count from the configured GitLab project; null when GitLab is unavailable. */
    openMergeRequests: number | null;
    /** GitLab's open-MR listing for the configured Automation project. */
    openMergeRequestsUrl: string | null;
  };
}

export interface AutomationFailureClusterMemberView {
  suiteIndex: number;
  suiteName: string;
  caseIndex: number;
  jobId: number | null;
  jobName: string | null;
  jobUrl: string | null;
  status: "failed" | "error";
  name: string;
  classname: string | null;
  executionTimeSeconds: number;
  testFile: string | null;
  attachmentName: string | null;
  attachmentUrl: string | null;
  attachmentProxyUrl: string | null;
}

export interface AutomationFailureClusterDetailView
  extends AutomationFailureClusterView {
  pipelineId: number;
  scheduleId: number;
  pipelineUrl: string;
  members: AutomationFailureClusterMemberView[];
  membersTruncated: boolean;
  representative: {
    suiteIndex: number;
    caseIndex: number;
    systemOutput: string | null;
    stackTrace: string | null;
  };
}

export interface AutomationTicketActionView {
  signatureKey: string;
  action:
    | "created"
    | "adopted"
    | "existing-ticket"
    | "active-mr"
    | "creating";
  triageState: AutomationClusterTriageState;
  jiraKey: string | null;
  jiraUrl: string | null;
  mrIid: number | null;
  mrUrl: string | null;
  sprint: { applied: boolean; fallbackReason: string | null };
}

/** Editable fields shown before creating one Automation failure ticket. */
export interface AutomationTicketDraftView {
  projectKey: string;
  parentKey: string | null;
  summary: string;
  /**
   * Editable introduction. Diagnostics, links, and the idempotency marker are
   * appended by the server.
   */
  description: string;
}

/** Reviewed fields for one Automation failure ticket. */
export interface AutomationTicketActionPatch {
  summary: string;
  description: string;
  parentKey: string | null;
}

export interface AutomationBulkTicketActionPatch {
  /** Failure clusters to include together in one pipeline-scoped Jira ticket. */
  signatureKeys: string[];
}

export interface AutomationBulkTicketActionView {
  /** One entry per selected cluster; successful entries point to the same Jira issue. */
  results: Array<
    | { signatureKey: string; ok: true; result: AutomationTicketActionView }
    | { signatureKey: string; ok: false; error: string }
  >;
}

/** POST one read-only AI triage action for an Automation failure cluster. */
export interface AutomationAiTriageActionView {
  queued: boolean;
  jobId?: string;
  message: string;
}

/** Which list of a `cluster.yaml` an entry lives in. */
export type ManifestSection = "applications" | "services";

/** One entry in an environment's `cluster.yaml` and the version it runs. */
export interface ServiceVersionView {
  name: string;
  version: string;
  /** The container image, when the entry names one distinct from `name`. */
  image?: string;
  section: ManifestSection;
}

/**
 * One environment (a folder in the releases repo) and the entries of its
 * `cluster.yaml`, across both the `applications` and `services` sections.
 */
export interface EnvironmentVersionView {
  name: string;
  services: ServiceVersionView[];
}

/**
 * GET `/api/releases` — the current version of every service in every
 * environment, read from the per-environment `cluster.yaml` files (one per
 * top-level folder) in the configured releases repo.
 *
 * Never a hard error: when releases are unconfigured or GitLab is not connected
 * this comes back with `configured:false`/`error` so the page can guide setup,
 * the same "explain the gap" stance the pull request page takes.
 */
export interface ReleasesView {
  configured: boolean;
  /** The setup surface that can resolve an unconfigured response. */
  setupRequired?: "release-config" | "gitlab-access";
  projectId?: string;
  /** The per-environment manifest filename, e.g. `cluster.yaml`. */
  manifestPath?: string;
  targetBranch?: string;
  environments: EnvironmentVersionView[];
  /** Present when the manifest could not be read — a setup hint, not a crash. */
  error?: string;
  /**
   * Whether a release can be announced in Slack — a bot token and a channel are
   * both set. The upload dialog disables its notify toggle with a reason rather
   * than offering something that would fail at submit.
   */
  slackConfigured: boolean;
  /**
   * The channel announcements go to, e.g. `#releases`, when one is set. Present
   * so the toggle can name where it posts instead of saying "Slack" — a toggle
   * that does not say where the message lands is one nobody trusts.
   */
  slackChannel?: string;
}

/** One concrete service version from a Confluence release's Suggested column. */
export interface ConfluenceReleaseSuggestionView {
  service: string;
  version: string;
}

/** Parsed details from one selected release page. */
export interface ConfluenceReleaseView {
  title: string;
  suggestions: ConfluenceReleaseSuggestionView[];
}

/** One linked release page offered by the production release dropdown. */
export interface ConfluenceReleaseOptionView {
  pageId: string;
  title: string;
}

/** GET `/api/releases/confluence` — production release choices maintained by QA. */
export interface ConfluenceReleasesView {
  pageUrl: string;
  releases: ConfluenceReleaseOptionView[];
}

/** GET `/api/releases/confluence?pageId=…` — one selected release's table. */
export interface ConfluenceReleaseDetailView {
  pageUrl: string;
  release: ConfluenceReleaseView;
}

/**
 * POST `/api/releases/upload` — change one or more entries in one environment's
 * cluster.yaml. The MR title and description default to values generated from
 * the changes (the client prefills the same text so the developer can edit it);
 * an empty/omitted field falls back to the generated wording. The `env::<ENV>`
 * label is always derived server-side.
 */
export interface ReleaseUploadRequest {
  environment: string;
  changes: { service: string; version: string; section: ManifestSection }[];
  title?: string;
  description?: string;
  /**
   * Announce the release in the team's Slack channel once the MR is open. The
   * dialog's toggle defaults to on, but an omitted flag here means no message:
   * posting to a channel should take an explicit ask.
   */
  notifySlack?: boolean;
}

/** The merge request `/api/releases/upload` opened (or reused). */
export interface ReleaseUploadResultView {
  mrUrl: string;
  mrIid: number;
  branch: string;
  /**
   * Whether the merge request was also approved. False when it opened but
   * approval was declined (e.g. the project lacks the paid-tier approvals
   * feature) — the developer can approve it by hand.
   */
  approved: boolean;
  /**
   * Whether the merge request merged immediately. Normally false — the merge
   * request is set to auto-merge rather than merged outright, so this is only
   * true for the rare MR GitLab merges synchronously (no pipeline configured).
   */
  merged: boolean;
  /**
   * Whether the merge request was set to merge automatically once its
   * pipeline succeeds. False when that was declined (e.g. conflicts, missing
   * approvals, an unresolved discussion) — the developer can merge it by hand.
   */
  autoMergeEnabled: boolean;
  /**
   * Whether the Slack channel was told. False when the toggle was off, and also
   * when the message was attempted but failed — `notifyError` tells those apart.
   */
  notified: boolean;
  /**
   * Why the announcement failed, when one was attempted. The release itself
   * succeeded either way, so this is a warning to show, not an error to raise.
   */
  notifyError?: string;
}

/** One entry's version move inside a past deployment. */
export interface ReleaseHistoryChangeView {
  service: string;
  section?: ManifestSection;
  /** The version replaced, or null when that commit added the entry. */
  from: string | null;
  to: string;
}

/**
 * One past deployment: a commit on an environment's `cluster.yaml`, the versions
 * it moved, and who committed it.
 */
export interface ReleaseHistoryEntryView {
  environment: string;
  sha: string;
  shortSha: string;
  /** The commit subject — for a release opened from here, the merge request title. */
  title: string;
  authorName: string;
  authorEmail: string | null;
  committedAt: string;
  webUrl: string | null;
  changes: ReleaseHistoryChangeView[];
}

/**
 * GET `/api/releases/revert?environment=…` — the newest deployment GitLab
 * reports for one environment, resolved into the version edits that undo it.
 */
export interface ReleaseRevertPreviewView {
  environment: string;
  deployment: ReleaseHistoryEntryView;
  changes: {
    service: string;
    section: ManifestSection;
    from: string;
    to: string;
  }[];
}

/** POST `/api/releases/revert` — revert the previewed deployment in a new MR. */
export interface ReleaseRevertRequest {
  environment: string;
  /** Guards confirmation against a newer deployment landing while the dialog is open. */
  sha: string;
  notifySlack?: boolean;
}

/**
 * GET `/api/releases/history` — recent deployments across every environment,
 * newest first, read from the releases repo's own commit history.
 *
 * Same "explain the gap" stance as `/api/releases`: unconfigured or a missing
 * GitLab token comes back `configured:false` with an `error` to render, not a 4xx.
 */
export interface ReleaseHistoryView {
  configured: boolean;
  projectId?: string;
  targetBranch?: string;
  entries: ReleaseHistoryEntryView[];
  /** Every environment the returned window mentions, for the filter control. */
  environments: string[];
  /** Commits examined to build this window — what "showing the last N" means. */
  commitsScanned: number;
  error?: string;
}

/** GET/PUT `/api/releases/config` — the instance-wide releases repo settings. */
export interface ReleaseConfigView {
  configured: boolean;
  projectId: string;
  manifestPath: string;
  targetBranch: string;
}

/** PUT body for `/api/releases/config`. All fields required to set the config. */
export interface ReleaseConfigPatch {
  projectId: string;
  manifestPath: string;
  targetBranch: string;
}

export type DeployWatchStateView = "pending-merge" | "watching" | "done" | "abandoned";
export type DeployWatchFindingSourceView = "datadog" | "logrocket";
export type DeploymentVerificationStateView =
  | "pending"
  | "progressing"
  | "released"
  | "degraded"
  | "missing"
  | "unavailable";

export interface DeploymentTargetStatusView {
  service: string;
  expectedImage: string;
  state: DeploymentVerificationStateView;
  desiredReplicas: number;
  updatedReplicas: number;
  readyReplicas: number;
  availableReplicas: number;
  podCount: number;
  observedDigest: string | null;
  message: string | null;
}

/** Read-only Kubernetes query for the manifest versions already shown in the UI. */
export interface ReleaseDeploymentStatusRequest {
  environments: EnvironmentVersionView[];
}

export interface ReleaseEnvironmentDeploymentView {
  name: string;
  /** Kubernetes checks for the changed services are paused until this release MR merges. */
  waitingForMerge: boolean;
  services: DeploymentTargetStatusView[];
}

export interface ReleaseDeploymentStatusView {
  checkedAt: string;
  environments: ReleaseEnvironmentDeploymentView[];
}

/** One observability finding the post-deploy watch found after the release. */
export interface DeployWatchFindingView {
  source: DeployWatchFindingSourceView;
  service: string | null;
  signature: string;
  /** A Datadog sample count or LogRocket session/alert count. */
  eventCount: number;
  externalUrl: string | null;
  issueType: string | null;
  sampleMessage: string | null;
  firstSeenAt: string;
  createdAt: string;
}

/**
 * GET `/api/releases/watches` — production releases the post-deploy watcher is
 * tracking or has finished with, worst (most findings) and newest first.
 */
export interface DeployWatchView {
  id: string;
  environment: string;
  releaseKind: "merge-request" | "commit";
  releaseLabel: string;
  releaseUrl: string;
  mrIid: number | null;
  mrUrl: string | null;
  commitSha: string | null;
  commitUrl: string | null;
  services: string[];
  /** Who clicked Upload. */
  actorEmail: string | null;
  state: DeployWatchStateView;
  openedAt: string;
  mergedAt: string | null;
  watchUntil: string | null;
  findings: DeployWatchFindingView[];
}

export interface DeployWatchesView {
  watches: DeployWatchView[];
}

/**
 * One integration field's state — never its secret value.
 *
 * The field's identity (label, whether it is secret, its hint) lives in
 * `shared/integrations.ts` and is not repeated here: this is only what the
 * server knows and the catalog cannot, namely whether something is set and
 * which layer it came from.
 */
export interface IntegrationFieldState {
  /** The secret name, matching an entry in `INTEGRATIONS`. */
  name: string;
  /**
   * Which layer supplies the effective value: the stored override, `config/.env`
   * behind it, or nothing at all. This is the answer to "I saved a token and it
   * still 401s" — an override that is present says so plainly.
   */
  origin: "override" | "environment" | "unset";
  /** The value, for non-secret fields with an override. Always null for a secret. */
  value: string | null;
  /** When the override was last saved. Null when there is none. */
  updatedAt: string | null;
  /** Stored but undecryptable, so not in effect — TALOS_SECRET_KEY changed. */
  unreadable?: boolean;
}

export interface IntegrationsView {
  /**
   * False without `TALOS_SECRET_KEY`: secret fields cannot be stored at all,
   * and the form says why instead of failing on save.
   */
  secretsEnabled: boolean;
  fields: IntegrationFieldState[];
}

/**
 * PUT body for `/api/settings/integrations`. Only the named fields are touched;
 * `null` or an empty string clears that override and falls back to `config/.env`.
 */
export interface IntegrationsPatch {
  overrides: Record<string, string | null>;
}

/**
 * One per-user credential's state — never its secret value.
 *
 * The `IntegrationFieldState` of the other surface, and deliberately a separate
 * type: `origin` answers a different question here. On the settings page it is
 * "which layer configured the instance"; here it is "does my work run as me", to
 * which only `"user"` is a yes — the UI treats a shared value as missing, since an
 * instance token is not an identity this developer can be attributed to.
 */
export interface ProviderCredentialState {
  /** The secret name, matching a `scope: "user"` field in `INTEGRATIONS`. */
  name: string;
  /**
   * Which value a run of yours would authenticate with: `"user"` your own stored
   * one, `"shared"` the instance's own behind it (`config/.env` or Settings →
   * Integrations), `"unset"` nothing anywhere.
   *
   * The distinction is reported because it is true, not because the console offers
   * `"shared"` as an answer: work that has to act as you needs `"user"`, so both
   * of the other two are what `ProviderAccessNotice` calls missing.
   */
  origin: "user" | "shared" | "unset";
  /**
   * The value, for a non-secret field you have stored — the Jira account email,
   * which is worth reading back because a typo in it is otherwise invisible.
   * Always null for a token.
   */
  value: string | null;
  /** When you last stored yours. Null when you have not. */
  updatedAt: string | null;
  /** Stored but undecryptable, so not in effect — TALOS_SECRET_KEY changed. */
  unreadable?: boolean;
}

export interface ProviderAccessView {
  /**
   * False without `TALOS_SECRET_KEY`: nothing can be stored per user at all,
   * and the dialog says why instead of failing on save.
   */
  enabled: boolean;
  /** Every name the server will store per user — `ACTOR_SECRETS`. */
  supported: string[];
  fields: ProviderCredentialState[];
  /** The GitLab account authenticated by this developer's own token, when valid. */
  gitlabUser?: PullRequestUserView;
  /** This developer's OAuth-managed Slack identity; credentials are never returned. */
  slack?: SlackConnectionView;
}

/**
 * PUT body for `/api/me/credentials`. Only the named credentials are touched;
 * `null` or an empty string removes yours, leaving that provider unconnected for
 * you.
 */
export interface ProviderAccessPatch {
  credentials: Record<string, string | null>;
}

export interface SlackConnectionView {
  configured: boolean;
  storable: boolean;
  workspaceId?: string;
  workspaceName?: string;
  userId?: string;
  userName?: string;
  connectedAt?: string;
  unreadable?: boolean;
  /** Whether this connection granted mpim:read and mpim:history. */
  groupDmsEnabled?: boolean;
  /** Whether the operator configured Slack Socket Mode for live activity. */
  liveUpdatesConfigured?: boolean;
  /** Whether this user granted search:read for inactive-DM polling. */
  reliableUnreadEnabled?: boolean;
  /** Whether usergroups:read is granted, allowing user-group mentions to show their alias. */
  userGroupMentionsEnabled?: boolean;
  /** Whether this user's OAuth token granted chat:write. */
  postingEnabled?: boolean;
  /** Whether this user's OAuth token granted reactions:write. */
  reactionsEnabled?: boolean;
  /** Whether this user's OAuth token granted files:read and files:write. */
  imageUploadsEnabled?: boolean;
  /** Whether all conversation-specific write scopes needed by conversations.mark are granted. */
  readSyncAvailable?: boolean;
}

export const SLACK_READ_SYNC_PREFERENCE = "slack.markReadInSlack";

export interface SlackOAuthStartView {
  authorizeUrl: string;
}

export interface SlackChannelView {
  id: string;
  name: string;
  private: boolean;
  selected: boolean;
}

export interface SlackChannelsView {
  channels: SlackChannelView[];
  selectedIds: string[];
}

export interface SlackMessageView {
  ts: string;
  at: string;
  userId?: string;
  userName: string;
  avatarUrl?: string;
  text: string;
  /** Normalized Slack Block Kit content. When present, this supersedes fallback text. */
  blocks?: SlackMessageBlockView[];
  /** Slack user and user-group IDs referenced in mrkdwn, resolved for safe rendering. */
  mentions?: Record<string, string>;
  threadTs?: string;
  replyCount: number;
  latestReplyTs?: string;
  reactions?: SlackReactionView[];
  attachments?: SlackMessageAttachmentView[];
  /** True when this message was posted by the connected Slack user. */
  mine: boolean;
}

export interface SlackMessageBlockView {
  type: "header" | "section" | "context" | "actions" | "divider";
  text?: string;
  fields?: string[];
  actions?: SlackMessageActionView[];
}

export interface SlackMessageActionView {
  text: string;
  url: string;
  style?: "primary" | "danger";
}

export interface SlackReactionView {
  name: string;
  count: number;
  reacted: boolean;
}

export interface SlackMessageAttachmentView {
  id: string;
  name: string;
  mimeType?: string;
}

export interface SlackConversationView {
  id: string;
  kind: "dm" | "group-dm" | "channel";
  name: string;
  avatarUrl?: string;
  /** True when this DM belongs to a Slack app/bot rather than a person. */
  app?: boolean;
  /** True when Slack currently reports the peer in this 1:1 DM as active. */
  online?: boolean;
  private: boolean;
  unread: boolean;
  latestTs?: string;
  latestAt?: string;
  latest?: SlackMessageView;
}

export interface SlackInboxView {
  connection: SlackConnectionView;
  conversations: SlackConversationView[];
  nextCursor?: string;
}

export interface SlackWorkspaceUserView {
  id: string;
  name: string;
  avatarUrl?: string;
}

export interface SlackWorkspaceUsersView {
  users: SlackWorkspaceUserView[];
}

export interface SlackUserProfileView extends SlackWorkspaceUserView {
  username?: string;
  title?: string;
  statusText?: string;
  statusEmoji?: string;
  timezone?: string;
  timezoneLabel?: string;
  timezoneOffset?: number;
  presence: "active" | "away";
  self: boolean;
}

export interface SlackConversationMemberView extends SlackWorkspaceUserView {
  /** True for the Slack identity connected to this TALOS account. */
  self: boolean;
  username?: string;
  online?: boolean;
  email?: string;
}

export interface SlackConversationMembersView {
  members: SlackConversationMemberView[];
  total: number;
}

export interface SlackConversationDetailsView {
  id: string;
  name: string;
  topic?: string;
  canRename: boolean;
  canSetTopic: boolean;
}

export interface SlackConversationDetailsPatch {
  name?: string;
  topic?: string;
}

export interface SlackConversationSearchResultView {
  ts: string;
  at: string;
  userId?: string;
  userName: string;
  avatarUrl?: string;
  text: string;
  mentions?: Record<string, string>;
  threadTs?: string;
}

export interface SlackConversationSearchFilters {
  fromMe?: boolean;
  includesMe?: boolean;
  hasLink?: boolean;
  threadsOnly?: boolean;
}

export interface SlackConversationSearchView {
  results: SlackConversationSearchResultView[];
  page: number;
  pageCount: number;
  total: number;
}

export interface SlackDirectMessageRequest {
  userId: string;
}

export interface SlackMessagesView {
  conversation: {
    id: string;
    kind: "dm" | "group-dm" | "channel";
    name: string;
    private: boolean;
  };
  messages: SlackMessageView[];
  nextCursor?: string;
  /** The result to scroll to and highlight when this is a focused history page. */
  focusedTs?: string;
}

export interface SlackChannelSelectionPatch {
  channelIds: string[];
}

export interface SlackReadPatch {
  conversationId: string;
  timestamp: string;
}

export interface SlackMessageSendRequest {
  text: string;
  threadTs?: string;
}

export interface SlackMessageSendResult {
  channel: string;
  timestamp: string;
  threadTs?: string;
}

export interface SlackMessageUpdateRequest {
  text: string;
}

export interface SlackMessageUpdateResult {
  channel: string;
  timestamp: string;
}

export interface SlackReactionPatch {
  name: string;
  active: boolean;
}

export interface SlackActivityView {
  revision: number;
  unreadCount: number;
  changedConversationIds?: string[];
}

/** One row of the LogRocket page: an issue LogRocket alerted us about. */
export interface LogRocketIssueView {
  id: string;
  /** LogRocket's category — `Error`, `Rage Click`, `Network Failure`, … */
  issueType: string | null;
  title: string;
  /** The error text, when the alert carried one separately from the title. */
  label: string | null;
  description: string | null;
  /** LogRocket's own AI summary, on plans that produce one. */
  summary: string | null;
  userImpact: string | null;
  /** Deep link into LogRocket's console. */
  url: string | null;
  screenshotUrl: string | null;
  sessionCount: number | null;
  /** Sessions per minute at alert time. */
  sessionRate: number | null;
  firstSeenAt: string | null;
  lastAlertAt: string;
  alertCount: number;
  state: "open" | "linked" | "dismissed";
  jiraIssueKey: string | null;
  /** Where that ticket is, so the row can link to it without knowing the site URL. */
  jiraIssueUrl: string | null;
  /** True while a fix job for its ticket is queued or running. */
  fixInFlight: boolean;
  /** The regression test written from this issue, if one was ever attempted. */
  regressionTest: RegressionTestView | null;
  /** True while an attempt at one is queued or running. */
  regressionTestInFlight: boolean;
}

/**
 * GET `/api/logrocket/issues`.
 *
 * `enabled`/`webhookConfigured` are the page's own setup state: LogRocket cannot
 * be polled, so an empty list means either "nothing is broken" or "no alert has
 * ever reached us", and only the server can tell the page which.
 */
export interface LogRocketIssuesView {
  /** Whether the integration is on at all — the API key is set. */
  enabled: boolean;
  /** Whether a webhook secret exists, i.e. whether deliveries are accepted. */
  webhookConfigured: boolean;
  /** The path to paste into LogRocket, secret included. Null until configured. */
  webhookPath: string | null;
  /** Why the fix button is refused, or null when it works. */
  fixRefusal: string | null;
  /** Why "Write a regression test" is refused, or null when it works. */
  regressionTestRefusal: string | null;
  /** Whether dismissed issues are in `issues` — echoed back so the toggle stays honest. */
  includesDismissed: boolean;
  issues: LogRocketIssueView[];
}

/**
 * What an agent established about a production error it was asked to cover.
 *
 * `reproduced` is a test that is red against the target branch — the bug is live,
 * and its merge request is a draft so nobody merges a failing pipeline.
 * `already-fixed` is a test that passes, i.e. a guard against the error returning.
 * `not-reachable` is the agent declining to invent one, which is a real answer.
 */
export type RegressionTestVerdictView = "reproduced" | "already-fixed" | "not-reachable";

/** One attempt at a regression test, as a row on the Datadog or LogRocket page. */
export interface RegressionTestView {
  verdict: RegressionTestVerdictView;
  /** The agent's account of what it wrote, or of why it could not. */
  summary: string | null;
  /** The command it ran and what happened — the evidence behind the verdict. */
  howVerified: string | null;
  testFile: string | null;
  mrIid: number | null;
  mrUrl: string | null;
  branch: string | null;
  /** The run, so its log is one click from the row. */
  taskRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * POST `/api/datadog/problems/:key/regression-test` and
 * POST `/api/logrocket/issues/:id/regression-test`.
 *
 * Queued rather than synchronous, unlike the scan: the agent clones a repository
 * and runs a test suite, which is minutes of work no request should hold open.
 */
export interface RegressionTestResult {
  queued: boolean;
  message: string;
  jobId?: string;
}

/** Optional per-run override for the branch cloned and targeted by the MR. */
export interface RegressionTestRequest {
  targetBranch?: string;
}

/** POST `/api/logrocket/issues/:id/fix` — file a ticket, then queue the fix. */
export interface LogRocketFixResult {
  queued: boolean;
  message: string;
  jobId?: string;
  /** The ticket, whether it was filed just now or already existed. */
  jiraIssueKey?: string;
}

/** POST body for `/api/logrocket/issues/:id/state`. */
export interface LogRocketStatePatch {
  state: "open" | "dismissed";
}

export type DatadogSeverityView = "critical" | "high" | "medium" | "low";

export type DatadogAreaView =
  | "frontend"
  | "backend"
  | "infrastructure"
  | "data"
  | "unknown";

/**
 * One row of the Datadog page: a cluster of error logs that share a shape.
 *
 * Not a Datadog object. Datadog Error Tracking is not indexing this org, so an
 * "issue" here is ours: the logs from one service whose messages normalise to the
 * same `signature`. That is why the counts are two numbers rather than one —
 * `eventCount` is an estimate and `sampleCount`/`sampleSize` are the fraction it
 * was extrapolated from, and a page that showed only the first would be claiming a
 * precision the scan does not have.
 */
export interface DatadogIssueView {
  id: string;
  service: string | null;
  /** The normalised message shape, ids and numbers replaced by placeholders. */
  signature: string;
  title: string;
  severity: DatadogSeverityView;
  area: DatadogAreaView;
  team: string | null;
  /** How the team and area were decided — `rule:12`, `heuristic:kube`, `default:backend`. */
  routedBy: string | null;
  /** Estimated occurrences in the last scan's window. */
  eventCount: number;
  /** What the previous scan estimated, for the trend arrow. Null when first seen. */
  previousEventCount: number | null;
  /** Sampled logs that fell in this cluster, and how many were read in total. */
  sampleCount: number;
  sampleSize: number;
  /** Datadog's own log status — `error`, `critical`, `warn`, … */
  status: string | null;
  env: string | null;
  source: string | null;
  host: string | null;
  kubeNamespace: string | null;
  sampleMessage: string | null;
  sampleStack: string | null;
  /** Deep link into the Datadog log explorer for this issue's own search. */
  explorerUrl: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastScanAt: string;
  /** Scans that have found it. 1 means "new today". */
  scanCount: number;
  state: "open" | "linked" | "dismissed";
  jiraIssueKey: string | null;
  jiraIssueUrl: string | null;
  /** True while a fix job for its ticket is queued or running. */
  fixInFlight: boolean;
}

/**
 * One root cause: the signatures that are all the same failure.
 *
 * The level the page actually works at, and the reason it exists is arithmetic. One
 * failure writes several log lines — the method that threw, the exception that
 * wrapped it, the client on the other side of the call — and each clusters into its
 * own `DatadogIssueView`. Left at that level the first real scan of this estate
 * showed thirty-eight rows for about six problems, and the volumes added up to
 * roughly twice the errors that actually happened.
 *
 * So `eventCount` here is the **largest** member's estimate rather than the sum, and
 * `issueIds` keeps the members so the row can show its own workings. See
 * `application/datadog-problems.ts` for how membership is decided.
 */
export interface DatadogProblemView {
  /**
   * Groups one scan's rows and nothing more — it is derived from the member
   * signatures, so it changes when membership does. Not an identifier to store.
   */
  key: string;
  /** The member signature that best describes the whole thing. */
  title: string;
  /** The service all members belong to; it also selects the repository target. */
  service: string | null;
  /** The worst severity among the members. */
  severity: DatadogSeverityView;
  area: DatadogAreaView;
  team: string | null;
  /** Estimated occurrences: the largest member, never the sum. */
  eventCount: number;
  previousEventCount: number | null;
  /** Reserved for legacy cross-service groups recorded before service isolation. */
  alsoIn: string[];
  /** The members, loudest first. Only those the current filters kept. */
  issueIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  /** Scans that have found it. 1 means "new today". */
  scanCount: number;
  state: "open" | "linked" | "dismissed";
  jiraIssueKey: string | null;
  jiraIssueUrl: string | null;
  /** True while a fix job for its ticket is queued or running. */
  fixInFlight: boolean;
  /**
   * The regression test written from this problem, if one was ever attempted.
   *
   * Keyed on the primary member's issue id, which is what the button sends: a
   * problem key is recomputed every scan and identifies nothing, so a row keyed
   * on it would lose its merge request the first time the grouping shifted.
   */
  regressionTest: RegressionTestView | null;
  /** True while an attempt at one is queued or running. */
  regressionTestInFlight: boolean;
  /** Repository/base branch that the confirmation will use for this service. */
  regressionTestTarget: DatadogResolvedTargetView | null;
  /** Why this particular problem cannot start a test, or null. */
  regressionTestRefusal: string | null;
  aiTriage: DatadogAiTriageView | null;
  aiTriageInFlight: boolean;
  aiTriageRefusal: string | null;
  /** Deep link into the Datadog log explorer, from the primary member's search. */
  explorerUrl: string | null;
}

/**
 * One service and everything broken in it.
 *
 * The page's top level, because volume in this estate is concentrated to the point
 * where nothing else is a sensible default: of 2.08M daily production error logs,
 * one service writes 1.71M. A flat list is that service's list, and the four
 * services behind it — where a tripling matters and is invisible at this scale —
 * never appear above the fold.
 */
export interface DatadogServiceView {
  service: string | null;
  /** The sum of its problems' estimates. Summing across root causes is sound. */
  eventCount: number;
  problemCount: number;
  /** The worst severity in the service, which is what the collapsed row shows. */
  severity: DatadogSeverityView;
  /** From the loudest problem — a service is usually one team's. */
  area: DatadogAreaView;
  team: string | null;
  problems: DatadogProblemView[];
}

/**
 * GET `/api/datadog/issues`.
 *
 * `enabled` and `lastScanAt` are the page's setup state: an empty list means
 * "nothing is broken", "no scan has run yet" or "no token", and only the server
 * can tell the page which of the three it is.
 *
 * Both shapes of the same data are sent. `services` is the tree the page renders —
 * service, then root cause, then signature — and `issues` is every row flat, keyed
 * by id, which the tree's `issueIds` point into. Sending the tree with the issues
 * nested inside it would put each one on the wire twice.
 */
export interface DatadogIssuesView {
  /** Whether the integration is on at all — a token is set. */
  enabled: boolean;
  /** The query the scan runs, so the page can say what it is and is not looking at. */
  query: string;
  /** When a scan last recorded anything. Null before the first run. */
  lastScanAt: string | null;
  /** Why the fix button is refused, or null when it works. */
  fixRefusal: string | null;
  /** Why "Scan now" is refused, or null. */
  scanRefusal: string | null;
  /** Why "Write a regression test" is refused, or null when it works. */
  regressionTestRefusal: string | null;
  /** Filter chip options, taken from the issues that exist rather than the rules. */
  teams: string[];
  areas: DatadogAreaView[];
  /** Echoed back so the toggle stays honest. */
  includesDismissed: boolean;
  /** The tree the page renders: service → root cause → signature. */
  services: DatadogServiceView[];
  /** Every row that passed the filters, flat. `DatadogProblemView.issueIds` indexes it. */
  issues: DatadogIssueView[];
}

/**
 * What `gitlab-ci-failure` decided about one spec file's recent history.
 *
 * `regression` fails and keeps failing; `flaky` has passed on code it also failed
 * on; `new` has one sighting; `unknown` has one failure with clean runs behind it
 * and is a night away from being either. Only `regression` earns a ticket.
 */
export type SpecVerdictView = "regression" | "flaky" | "new" | "unknown";

/** One spec file on the Flaky specs page. */
export interface FlakySpecView {
  /** `group/project` on GitLab. Part of the row's identity, with `specFile`. */
  project: string;
  specFile: string;
  /** The last path segment, which is what a table column has room for. */
  name: string;
  verdict: SpecVerdictView;
  /** Conclusive pipelines in the window. A runner failure is never one. */
  observed: number;
  failed: number;
  /** `failed / observed`, 0..1. The page renders it as a percentage. */
  flakeRate: number;
  consecutiveFailures: number;
  firstFailedAt: string;
  lastFailedAt: string;
  lastFailedPipelineId: number;
  /** Null when it has never been seen passing inside the window. */
  lastPassedPipelineId: number | null;
  /** The failing test names as the last run reported them, newline-joined. */
  lastSignature: string | null;
  /** True when the whole suite failed to run — an import or syntax error. */
  lastSuiteFailedToRun: boolean;
  /** True when it is flaky enough to be worth quarantining. */
  quarantine: boolean;
  /** When the quarantine suggestion was first made, if it has been. */
  quarantineSuggestedAt: string | null;
  state: "open" | "dismissed";
  /** Deep link to the pipeline it last failed in, when the project id allows one. */
  lastFailedPipelineUrl: string | null;
}

export interface FlakySpecsView {
  /**
   * False when no loop instance records history yet, so the page can say why it is
   * empty instead of implying every spec is healthy.
   */
  enabled: boolean;
  /** How many recent pipelines the verdicts were judged over. */
  window: number;
  /** The threshold a rate has to clear to be called quarantine-worthy. */
  quarantineFlakeRate: number;
  /** Consecutive failures a spec needs before a ticket is filed. */
  failuresBeforeFiling: number;
  /** Echoed back so the toggle stays honest. */
  includesDismissed: boolean;
  /** Why "File a ticket anyway" is refused, or null when it works. */
  fileRefusal: string | null;
  specs: FlakySpecView[];
}

/** POST body for `/api/flaky-specs/state`. */
export interface FlakySpecStatePatch {
  project: string;
  specFile: string;
  state: "open" | "dismissed";
}

/**
 * POST `/api/flaky-specs/file` — file a ticket for a held spec after all.
 *
 * Marks the spec rather than calling Jira from the request: the ticket a reader
 * wants is the one the loop builds, with the pipeline, the trace excerpt and the
 * label the "already filed?" check depends on, and none of that is in this
 * process. So the override is recorded and the next run of the loop honours it —
 * which also means one code path files every ticket this tool has ever filed.
 */
export interface FlakySpecFileResult {
  accepted: boolean;
  message: string;
}

/** POST `/api/datadog/problems/:key/fix` — file a ticket, then queue the fix. */
export interface DatadogFixResult {
  queued: boolean;
  message: string;
  jobId?: string;
  /** The ticket, whether it was filed just now or already existed. */
  jiraIssueKey?: string;
}

/**
 * POST body for `/api/datadog/problems/:key/state`.
 *
 * Applies to every signature in the problem. Dismissing four of the five log lines
 * one failure emits would leave the fifth on the page, which is not a state anybody
 * asked for.
 */
export interface DatadogStatePatch {
  state: "open" | "dismissed";
}

/**
 * POST `/api/datadog/scan` — run the scan now.
 *
 * Synchronous, unlike a task rerun: a scan is a minute of aggregation calls, and
 * the page has nothing to show until it finishes. `started: false` carries the
 * refusal instead.
 */
export interface DatadogScanResult {
  started: boolean;
  message: string;
  executionId?: string;
  status?: string;
  issuesFound?: number;
  issuesRecorded?: number;
  issuesNew?: number;
  /** Root causes the clusters folded into — the number of rows the page will show. */
  problemsFound?: number;
}

/**
 * One team-routing rule.
 *
 * The whole of "which team owns this?" for now: the org tags no logs with a team,
 * so ownership is a list an operator maintains, matched against the facets Datadog
 * does send. `action: "ignore"` is the other half — dropping the CSI drivers and
 * the CI runner is what makes a top-20-services scan return product bugs.
 */
export interface DatadogRoutingRuleView {
  id: string;
  /** Lower runs first. First match wins. */
  priority: number;
  facet: "service" | "source" | "kube_namespace" | "env" | "host" | "signature";
  /** Glob against the facet's value — `csi-*`, `argocd*`. Case-insensitive. */
  pattern: string;
  action: "route" | "ignore";
  team: string | null;
  area: DatadogAreaView | null;
  /** Overrides the default Jira project for issues this rule routes. */
  jiraProject: string | null;
  note: string | null;
  updatedAt: string;
}

/** GET `/api/datadog/routing`. */
export interface DatadogRoutingView {
  rules: DatadogRoutingRuleView[];
}

/** POST/PATCH body for `/api/datadog/routing[/:id]`. */
export interface DatadogRoutingRulePatch {
  priority?: number;
  facet?: DatadogRoutingRuleView["facet"];
  pattern?: string;
  action?: "route" | "ignore";
  team?: string | null;
  area?: DatadogAreaView | null;
  jiraProject?: string | null;
  note?: string | null;
}

/** Team-owned repository configuration for one exact Datadog service name. */
export interface DatadogServiceTargetView {
  service: string;
  projectId: string;
  targetBranch: string;
  updatedAt: string;
}

export interface DatadogServiceTargetPatch {
  projectId: string;
  targetBranch: string;
}

/** GET `/api/datadog/service-targets`. */
export interface DatadogServiceTargetsView {
  targets: DatadogServiceTargetView[];
  /** Services currently present in the issue store, including unmapped ones. */
  services: string[];
  defaultProjectPrefix: string;
  defaultTargetBranch: string;
}

/** Effective destination shown before a code-writing action is queued. */
export interface DatadogResolvedTargetView {
  projectId: string;
  targetBranch: string;
  source: "service" | "service-default" | "user-default";
}

export interface DatadogActiveJobView {
  jobId: string;
  action: "write-regression-test" | "ai-triage";
  status: "queued" | "running";
  runId: string | null;
  issueId: string | null;
  service: string | null;
  message: string;
  enqueuedAt: string;
}

export interface DatadogAiTriageView {
  verdict: "code" | "bad-data" | "infrastructure" | "unknown";
  confidence: number;
  rationale: string;
  recommendation: string;
  taskRunId: string;
  updatedAt: string;
}

export interface DatadogAiTriageResult {
  queued: boolean;
  message: string;
  jobId?: string;
}

/** Datadog-only queued work and run history for the Activity tab. */
export interface DatadogActivityView extends TaskRunPage {
  activeJobs: DatadogActiveJobView[];
}

/** POST body for `/api/feedback`. */
export interface FeedbackRequest {
  type: FeedbackType;
  title: string;
  description: string;
}

/** Response for `POST /api/feedback`, from the footer's feedback link. */
export interface FeedbackView {
  id: string;
  createdAt: string;
  publicationStatus: FeedbackPublicationStatus;
  publicationReason?: FeedbackPublicationReason;
  issueUrl?: string;
  issueNumber?: number;
}

export interface PendingFeedbackEntryView extends FeedbackView {
  type: FeedbackType;
  title: string;
  attachmentCount: number;
}

export interface PendingFeedbackView {
  feedback: PendingFeedbackEntryView[];
}

export type AssistantMessageRole = "user" | "assistant";

export interface AssistantMessage {
  role: AssistantMessageRole;
  content: string;
}

/** POST body for the streamed `/api/assistant/chat` endpoint. */
export interface AssistantChatRequest {
  messages: AssistantMessage[];
}

/** One newline-delimited event emitted by `/api/assistant/chat`. */
export type AssistantStreamEvent =
  | { type: "start"; account: string }
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; status: "started" | "completed" | "failed" }
  | { type: "done" }
  | { type: "error"; message: string };

/** Runtime validator for the asynchronous run-start contract. */
export function isTaskRunStartedView(value: unknown): value is TaskRunStartedView {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.executionId === "string" &&
    typeof candidate.taskId === "string" &&
    typeof candidate.startedAt === "string" &&
    candidate.status === "running" &&
    typeof candidate.dryRun === "boolean" &&
    Array.isArray(candidate.steps)
  );
}
