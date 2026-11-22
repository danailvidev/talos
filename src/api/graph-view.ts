/**
 * The ticket graph: the Jira↔GitLab round trip, assembled per request.
 *
 * The roots are Jira's board tickets for the requested scope: assigned to the
 * asking developer for Mine, or every readable board ticket for Team. Work the
 * loops know about is then hung off those roots.
 *
 * There is no `ticket → merge request` link table, and while this page is
 * experimental there deliberately is not going to be one. The edge is recovered
 * from three places that already record it, strongest first:
 *
 * 1. `task_runs.details` — the handler tasks write the join themselves
 *    (`{ issueKey, action: "opened", mrIid, mrUrl }`). Authoritative.
 * 2. `work_subjects.subject_key` / `external_ref` — the key names its own system,
 *    and for `ci-failure` the external ref *is* the Jira key it filed.
 * 3. The subject's `metadata.title` — `jira-ticket-to-mr` titles its merge
 *    requests `${key} ${summary}`, so a ticket falls out of an MR title.
 *
 * Kept out of `views.ts` because that file is already long and this is one
 * self-contained read. If the page earns its keep, the honest fix is an indexed
 * link table written at the point the MR is opened; see the plan.
 */
import type * as ApiContract from "../../shared/api-contract.ts";
import type { AssignedTicket } from "../application/assigned-tickets.ts";
import type { App } from "../app.ts";
import type { AuthUser } from "../auth.ts";
import type { Job } from "../core/job.ts";
import type { FixIssueDefaults, WorkSubject } from "../application/ports.ts";
import type { PullRequest } from "../application/pull-requests.ts";
import { DONE_CATEGORY } from "../connectors/jira/types.ts";
import type { TaskRunSummary } from "../persistence/sqlite-task-sink.ts";
import { fixIssueBranchName } from "../tasks/fix-jira-issue/branch.ts";
import { ticketFingerprint } from "../tasks/jira-ticket-to-mr/ticket.ts";
import {
  ticketActionHistory,
  ticketActionRefusal,
  TICKET_ACTION_IDS,
  type TicketActionId,
} from "./ticket-actions.ts";
import { activePullRequestActions } from "./pull-request-actions.ts";
import { e2eTestMrJobsBySource } from "./e2e-test-mr-actions.ts";
import { cachedBoardTickets, cachedPullRequestListing } from "./cached-reads.ts";
import { extractJiraIssueKey, isListedTask, jiraBrowseUrl } from "./views.ts";
import { e2eTestProject } from "../tasks/write-e2e-test/index.ts";

export type GraphNodeKind = "ticket" | "loop" | "job" | "run" | "mr" | "action";
export type GraphStatus = "running" | "success" | "failure" | "waiting" | "dead" | "idle";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  sublabel?: string;
  status: GraphStatus;
  url?: string;
  taskId?: string;
  executionId?: string;
  job?: { attempts: number; maxAttempts: number; error?: string; enqueuedAt: string };
  /** Set while the job behind this node is still queued or leased — cancellable. */
  jobId?: string;
  /**
   * When this job/run actually happened — finished, else started, else
   * enqueued — for the Activity tab's chronological ordering. Distinct from
   * `nodes`' own id-sorted order, which exists for stable graph-canvas layout
   * and says nothing about time (ids are random UUIDs).
   */
  at?: string;
  subjectKey?: string;
  /** Set on every `mr` node whose project and iid could be recovered. */
  pullRequest?: { projectId: string; mrIid: number };
  /** Completed QA browser-test result on an E2E action node. */
  e2e?: ApiContract.E2eTestResultView;
  /** Set on `ticket` nodes built from a Jira search hit. */
  ticket?: ApiContract.TicketFactsView;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  status: GraphStatus;
}

export interface TicketClusterView {
  key: string;
  title?: string;
  url?: string;
  status: GraphStatus;
  counts: { mrs: number; jobs: number; runs: number; actions: number; activeJobs: number };
  /** At least one merge request open for review — see `ApiContract.TicketCluster`. */
  inReview: boolean;
  updatedAt: string;
  source: "jira" | "loops";
  columnId?: string;
  sprint?: ApiContract.SprintView;
  sprints: ApiContract.SprintView[];
  actions: Record<TicketActionId, { available: boolean; reason?: string; branch?: string }>;
  e2ePullRequests: ApiContract.E2ePullRequestCandidateView[];
  e2eCoverage?: ApiContract.TicketCluster["e2eCoverage"];
  /** The newest unresolved plan — see `ApiContract.TicketCluster.plan`. */
  plan?: ApiContract.TicketPlanSummaryView;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface TicketGraphView {
  clusters: TicketClusterView[];
  total: number;
  offset: number;
  limit: number;
  live: boolean;
  warnings: string[];
  board?: ApiContract.TicketBoardView;
  sprints: ApiContract.SprintView[];
  currentSprintId?: number;
  fixDefaults: FixIssueDefaults | null;
  generatedAt: string;
}

/** How many runs back to read per loop. Matches the depth `toTaskDetail` already uses. */
const RUNS_PER_LOOP = 25;

/**
 * Jobs shown per subject, newest first. A loop that re-checks the same merge
 * request every hour has dozens of identical done jobs; showing them all buries
 * the one that matters under its own history.
 */
const JOBS_PER_SUBJECT = 4;

/**
 * Ranked worst-first, so a cluster card can summarise its nodes with `worstOf`.
 * A failure is what you want to see from across the room; idle is noise.
 */
const SEVERITY: readonly GraphStatus[] = [
  "failure",
  "dead",
  "running",
  "waiting",
  "success",
  "idle",
];

function worstOf(statuses: readonly GraphStatus[]): GraphStatus {
  for (const candidate of SEVERITY) {
    if (statuses.includes(candidate)) return candidate;
  }
  return "idle";
}

function jobStatus(job: Job): GraphStatus {
  switch (job.status) {
    case "queued":
      return "waiting";
    case "leased":
      return "running";
    case "dead":
      return "dead";
    case "done":
      return "success";
  }
}

function runStatus(run: TaskRunSummary): GraphStatus {
  switch (run.status) {
    case "running":
      return "running";
    case "success":
      return "success";
    case "failure":
      return "failure";
    // A cancelled run is not a fault, and colouring it dusty red like a failure
    // would have people chasing a shutdown they asked for.
    case "cancelled":
      return "idle";
  }
}

/**
 * What a run's `details.action` says about the merge request it touched.
 * `no-change` and `needs-attention` are successes for the *run* and yet exactly
 * the cases a human has to look at, hence gold rather than cyan.
 */
function mrStatusForAction(action: unknown): GraphStatus {
  return action === "opened" || action === "adopted" ? "success" : "waiting";
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * The Jira key a subject belongs to.
 *
 * `jira:ticket-mr:TP-1204` carries it in the key; `ci-failure` files a ticket and
 * stores the key as the external ref; a merge request subject only has its title
 * to go on. Each of the three is tried in that order of confidence.
 */
function ticketForSubject(subject: WorkSubject): string | undefined {
  const metadata = subject.metadata;
  return extractJiraIssueKey(
    subject.subjectKey.startsWith("jira:") ? subject.subjectKey : undefined,
    subject.externalRef,
    stringField(metadata, "issueKey"),
    stringField(metadata, "title"),
    stringField(metadata, "summary"),
  );
}

/**
 * What a subject *is* to its loop, which decides which way the edges point.
 *
 * The three cases are genuinely different relationships, and drawing them the
 * same way asserts things that are not true:
 *
 * - `ticket-input` (`jira:ticket-mr:TP-1204`) — the loop polls Jira and consumes
 *   the ticket, so the ticket feeds the loop.
 * - `mr` (`gitlab:mr:…`, `gitlab:mr-feedback:…`) — the loop consumes the *merge
 *   request*. The Jira key here was only recovered from the MR's title, so the
 *   ticket relates to the merge request and has nothing to do with the loop.
 * - `ticket-output` (`spec:project:file`) — a `ci-failure` loop consumes a failing
 *   spec and *files* the ticket, so the ticket is the run's result, not its input.
 */
type SubjectRole = "ticket-input" | "mr" | "ticket-output";

function subjectRoleOf(subject: WorkSubject): SubjectRole {
  if (subject.subjectKey.startsWith("gitlab:mr")) return "mr";
  if (subject.subjectKey.startsWith("jira:")) return "ticket-input";
  return "ticket-output";
}

/**
 * One merge request is one node, however it was found.
 *
 * The same MR is tracked under two different subject keys — `gitlab:mr:…` by the
 * review loop and `gitlab:mr-feedback:…` by the follow-up loop — and a run's
 * `details` names it by URL. Keying the node on any of those drew the same merge
 * request two or three times side by side, so the id is canonicalised to the pair
 * that actually identifies it.
 */
function mrNodeIdFor(projectId: string, iid: number): string {
  return `mr:${projectId}!${iid}`;
}

function mrTargetFromSubjectKey(subjectKey: string): { projectId: string; iid: number } | null {
  const match = subjectKey.match(/^gitlab:mr(?:-feedback)?:(.+)!(\d+)$/);
  if (!match) return null;
  return { projectId: match[1]!, iid: Number(match[2]) };
}

/** `https://gitlab.com/group/proj/-/merge_requests/412` → the same pair. */
function mrTargetFromUrl(url: string): { projectId: string; iid: number } | null {
  const match = url.match(/^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/);
  if (!match) return null;
  return { projectId: match[1]!, iid: Number(match[2]) };
}

/** `gitlab:mr:group/proj!412` → `!412`, so a node reads like the forge does. */
function subjectLabel(subject: WorkSubject): string {
  if (subject.externalRef) return subject.externalRef;
  const bang = subject.subjectKey.lastIndexOf("!");
  if (bang !== -1) return subject.subjectKey.slice(bang);
  return subject.subjectKey;
}

interface ClusterDraft {
  key: string;
  title?: string;
  url?: string;
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  updatedAt: Date;
  activeJobs: number;
  /**
   * Merge requests on this ticket in state `open` — see `TicketCluster.inReview`.
   * Only `attachOwnPullRequests` can count these; every other path that draws an
   * `mr` node infers it from a subject key or a run's details and never sees the
   * forge's state.
   */
  openMrs: number;
  /** Set once the Jira search confirms this ticket is the developer's own. */
  ticket?: AssignedTicket;
  /**
   * The ticket actions with a job in flight right now — filled by
   * `markRunningTickets`.
   *
   * Per action rather than a single running flag, because they are independent
   * work: a requirements review must not grey out the fix, and vice versa.
   */
  runningActions: Set<TicketActionId>;
  /** The ticket's newest unresolved plan — filled by `attachPlans`. */
  plan?: ApiContract.TicketPlanSummaryView;
  /** Linked active MRs offered by the QA E2E action. */
  e2ePullRequests: ApiContract.E2ePullRequestCandidateView[];
}

function draftFor(clusters: Map<string, ClusterDraft>, key: string): ClusterDraft {
  const existing = clusters.get(key);
  if (existing) return existing;
  const draft: ClusterDraft = {
    key,
    nodes: new Map(),
    edges: new Map(),
    updatedAt: new Date(0),
    activeJobs: 0,
    openMrs: 0,
    runningActions: new Set(),
    e2ePullRequests: [],
  };
  clusters.set(key, draft);
  return draft;
}

function addNode(draft: ClusterDraft, node: GraphNode): void {
  // First writer wins on identity, but a later sighting may know more: a run row
  // read after its job carries the step count the job node had no idea about.
  const existing = draft.nodes.get(node.id);
  draft.nodes.set(node.id, existing ? { ...existing, ...node } : node);
}

function addEdge(draft: ClusterDraft, source: string, target: string, status: GraphStatus): void {
  const id = `${source}->${target}`;
  draft.edges.set(id, { id, source, target, status });
}

function touch(draft: ClusterDraft, at: Date | undefined): void {
  if (at && at.getTime() > draft.updatedAt.getTime()) draft.updatedAt = at;
}

/**
 * The cluster's ticket node, created once however the key was recovered.
 *
 * Every cluster is named after a ticket, so every cluster needs a node for it —
 * including the common case where the key came out of a merge request title and
 * no subject or run points at the ticket directly. Without this the chain would
 * start halfway through the story, at the MR.
 */
function ensureTicketNode(
  app: App,
  draft: ClusterDraft,
  ticket: string,
  extras: { title?: string; url?: string } = {},
): string {
  const id = `ticket:jira:${ticket}`;
  draft.title ??= extras.title;
  draft.url ??= extras.url ?? jiraBrowseUrl(app.secrets, ticket);
  addNode(draft, {
    id,
    kind: "ticket",
    label: ticket,
    ...(draft.title ? { sublabel: draft.title } : {}),
    // A ticket is a subject, not an outcome, so it never reports health of its
    // own — except "done", which is the one thing about a ticket that *is* an
    // outcome and the one a developer scanning the column wants to see.
    status: draft.ticket?.statusCategory === DONE_CATEGORY ? "success" : "waiting",
    ...(draft.url ? { url: draft.url } : {}),
    ...(draft.ticket ? { ticket: toTicketFacts(draft.ticket) } : {}),
  });
  return id;
}

function toTicketFacts(ticket: AssignedTicket): ApiContract.TicketFactsView {
  return {
    ...(ticket.statusId ? { statusId: ticket.statusId } : {}),
    ...(ticket.status ? { status: ticket.status } : {}),
    ...(ticket.statusCategory ? { statusCategory: ticket.statusCategory } : {}),
    ...(ticket.type ? { type: ticket.type } : {}),
    ...(ticket.priority ? { priority: ticket.priority } : {}),
    labels: ticket.labels,
    ...(ticket.assignee ? { assignee: ticket.assignee } : {}),
    ...(ticket.reporter ? { reporter: ticket.reporter } : {}),
    ...(ticket.createdAt ? { createdAt: ticket.createdAt } : {}),
    ...(ticket.updatedAt ? { updatedAt: ticket.updatedAt } : {}),
    ...(ticket.sprint ? { sprint: ticket.sprint } : {}),
    ...(ticket.parentKey ? { parentKey: ticket.parentKey } : {}),
  };
}

/**
 * The sprints the built clusters are in, and which one the page opens on.
 *
 * Read off the complete set of clusters so the switcher and canvas cannot
 * disagree: every sprint option has at least one ticket in this developer's board
 * result, including closed sprints whose cards are all done.
 */
function collectSprints(clusters: readonly TicketClusterView[]): {
  sprints: ApiContract.SprintView[];
  currentSprintId?: number;
} {
  const byId = new Map<number, ApiContract.SprintView>();
  for (const cluster of clusters) {
    for (const sprint of cluster.sprints) byId.set(sprint.id, sprint);
  }

  const rank: Record<ApiContract.SprintView["state"], number> = {
    active: 0,
    future: 1,
    closed: 2,
    unknown: 3,
  };
  // Future sprints read forwards (the next one is the one you care about) and
  // closed ones backwards (the one that just ended is), so a straight date sort is
  // wrong for one of the two groups whichever way it runs.
  const sprints = [...byId.values()].sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    const dates = (a.startDate ?? "").localeCompare(b.startDate ?? "");
    return a.state === "active" || a.state === "closed" ? -dates : dates;
  });

  const current = sprints.find((sprint) => sprint.state === "active");
  return { sprints, ...(current ? { currentSprintId: current.id } : {}) };
}

/**
 * The whole payload: Jira's answer for the roots, the loops' for everything
 * hanging off them.
 *
 * Async because two of the three sources are network reads, and both are
 * deliberately best-effort — `Promise.all` over independent calls, each of which
 * degrades to a warning rather than a throw. A graph missing its Jira roots still
 * usefully shows what is running; a red box shows nothing at all.
 */
export async function toTicketGraph(
  app: App,
  user: AuthUser,
  options: { scope: "mine" | "team"; bypass?: boolean },
): Promise<TicketGraphView> {
  // Both reads are cached for half a minute; the rest of this function is not.
  // The client polls this endpoint every three seconds to watch job state flip,
  // and that overlay is pure SQLite — see `CACHE_TTL.graphSources`. `bypass`
  // is the refresh button's promise to actually reach the forge rather than
  // answer from either of these two entries.
  const [assigned, mine] = await Promise.all([
    cachedBoardTickets(app, user, options.scope, { bypass: options.bypass }),
    myPullRequests(app, user, { bypass: options.bypass }),
  ]);

  const clusters = collectLoopWork(app, user, options.scope);
  const warnings = [assigned.warning, mine.warning].filter(
    (warning): warning is string => warning != null,
  );

  // Jira's hits second, so a ticket a loop already anchored keeps the work
  // attached to it and simply learns whose it is.
  for (const ticket of assigned.tickets) {
    const draft = draftFor(clusters, ticket.key);
    draft.ticket = ticket;
    draft.title ??= ticket.summary;
    draft.url = ticket.url;
    if (ticket.updatedAt) touch(draft, new Date(ticket.updatedAt));
    ensureTicketNode(app, draft, ticket.key, {
      ...(ticket.summary ? { title: ticket.summary } : {}),
      url: ticket.url,
    });
  }

  attachOwnPullRequests(app, clusters, mine.pullRequests);
  markRunningMergeRequests(app, clusters);
  attachTicketActions(app, clusters);
  attachPlans(app, clusters);

  // A healthy Jira answer defines the roots. Loop and merge-request reads enrich
  // those tickets but must not add cards Jira's own board does not contain — doing
  // so is how the former "Other" column grew beyond every Jira column's count.
  if (!assigned.warning) {
    for (const [key, draft] of clusters) {
      if (!draft.ticket) clusters.delete(key);
    }
  }

  const fixDefaults = app.fixIssueDefaults.get(user.id) ?? null;
  // One refusal per action for the whole payload, evaluated once: an unset default
  // project or an unregistered handler is a fact about the server and the
  // developer, not about any one ticket. Per-ticket reasons are added in
  // `toClusterView`.
  const refusals = Object.fromEntries(
    TICKET_ACTION_IDS.map((id) => [id, ticketActionRefusal(app, user, id)] as const),
  ) as Record<TicketActionId, string | null>;

  const allBuilt = [...clusters.values()]
    .map((draft) => toClusterView(draft, refusals))
    // Most recently touched first: "what is going on" is a recency question.
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // Sprint and facet filters are client-side, so the payload has to contain the
  // complete board. Paging before filtering made a sprint disappear merely
  // because its cards sorted onto a later transport page.
  const built = allBuilt;
  const sprintView = collectSprints(built);

  return {
    clusters: built,
    total: allBuilt.length,
    offset: 0,
    limit: allBuilt.length,
    live: allBuilt.some(
      (cluster) => cluster.counts.activeJobs > 0 || cluster.status === "running",
    ),
    warnings,
    ...(assigned.board ? { board: assigned.board } : {}),
    ...sprintView,
    ...(assigned.currentSprintId != null
      ? { currentSprintId: assigned.currentSprintId }
      : {}),
    fixDefaults,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * The developer's recent merge requests, straight from the forge.
 *
 * Without this the graph could only see a merge request some loop happened to be
 * tracking, which made the "Fix this issue" button lie: a ticket the developer
 * had already opened an MR for by hand looked untouched, and the honest answer to
 * "has anyone started this" was one API call away the whole time. Completed states
 * are included too: Jira keeps merged/closed work in its Development panel, and a
 * ticket-to-MR link does not stop existing when the MR leaves the open list.
 */
async function myPullRequests(
  app: App,
  user: AuthUser,
  options: { bypass?: boolean } = {},
): Promise<{ pullRequests: PullRequest[]; warning?: string }> {
  try {
    // The same entry the Pull requests page and the global search read: one
    // listing per user per minute, however many places ask for it.
    const listing = await cachedPullRequestListing(
      app,
      user,
      "mine",
      {
        states: ["open", "draft", "merged", "closed"],
        // The provider bounds completed states to the last 90 days. A wider page
        // prevents active MRs from crowding a recently completed linked MR out of
        // the graph while keeping this one cached forge read finite.
        limit: 100,
      },
      options,
    );
    // A forge with no token stored is not an error — the developer simply has not
    // connected it — but it does explain a graph with no merge requests on it.
    const unavailable = listing.unavailable.map((provider) => provider.label).join(", ");
    const failed = listing.failed.map((provider) => `${provider.label}: ${provider.message}`);
    return {
      pullRequests: listing.pullRequests,
      ...(failed.length > 0
        ? { warning: `Could not read merge requests — ${failed.join("; ")}` }
        : unavailable
          ? { warning: `No credentials stored for ${unavailable}, so its merge requests are missing.` }
          : {}),
    };
  } catch (err) {
    return {
      pullRequests: [],
      warning: `Could not read your merge requests: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Hangs each of the developer's own merge requests off the ticket it names.
 *
 * The link is the same naming convention `views.ts` already relies on — the key
 * in the branch or the title — and a merge request whose ticket cannot be
 * recovered is skipped rather than given a root of its own: this list is "every
 * MR I have open", most of which have nothing to do with the graph.
 */
function attachOwnPullRequests(
  app: App,
  clusters: Map<string, ClusterDraft>,
  pullRequests: readonly PullRequest[],
): void {
  for (const pr of pullRequests) {
    const ticket = extractJiraIssueKey(pr.sourceBranch, pr.title);
    if (!ticket) continue;
    const target = mrTargetFromUrl(pr.webUrl);
    const projectId = target?.projectId ?? pr.repository;
    if (!projectId) continue;

    const draft = draftFor(clusters, ticket);
    touch(draft, pr.updatedAt);
    // Only `open`. A draft is still being written and a merged one is finished, so
    // neither is sitting on a reviewer — which is the whole point of the signal.
    if (pr.state === "open") draft.openMrs++;
    if (pr.state !== "closed") {
      draft.e2ePullRequests.push({
        projectId,
        mrIid: pr.number,
        title: pr.title,
        url: pr.webUrl,
        sourceBranch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
        draft: pr.state === "draft",
        updatedAt: pr.updatedAt.toISOString(),
      });
    }
    const ticketNodeId = ensureTicketNode(app, draft, ticket);
    const mrNodeId = mrNodeIdFor(projectId, pr.number);
    addNode(draft, {
      id: mrNodeId,
      kind: "mr",
      label: `!${pr.number}`,
      sublabel: pr.title,
      // The forge's own state, which is more than a loop's runs can say: a merged
      // MR is done, a draft is still being written.
      status: pr.state === "merged" ? "success" : pr.state === "closed" ? "idle" : "waiting",
      url: pr.webUrl,
      pullRequest: { projectId, mrIid: pr.number },
    });
    addEdge(draft, ticketNodeId, mrNodeId, "waiting");
  }
}

function collectLoopWork(
  app: App,
  user: AuthUser,
  scope: "mine" | "team",
): Map<string, ClusterDraft> {
  // Same reason `/api/tasks` does it: a schedule edit or a just-created instance
  // must show up on a browser refresh without restarting the server.
  app.refresh();

  const loops = app
    .scheduledTasks()
    .filter((scheduled) => canSee(app, scheduled.id, user, scope))
    .map((scheduled) => app.taskRegistry.get(scheduled.id))
    .filter((task): task is NonNullable<typeof task> => task != null)
    .filter(isListedTask);

  const clusters = new Map<string, ClusterDraft>();
  const loopIds = loops.map((loop) => loop.id);
  const runsByLoop = app.sink.recentRunsFor(loopIds, RUNS_PER_LOOP);
  const resourcesByRun = app.sink.resourcesForRuns(
    [...runsByLoop.values()].flat().map((run) => run.executionId),
  );
  const subjectsByLoop = app.subjects.openSubjectsFor(loopIds);
  const jobsBySubject = app.jobs.bySubjectsForLoops(loopIds, JOBS_PER_SUBJECT);

  for (const loop of loops) {
    const loopNodeId = `loop:${loop.id}`;
    const runs = runsByLoop.get(loop.id) ?? [];
    const activeLoop = runs.some((run) => run.status === "running");

    const loopNode = (): GraphNode => ({
      id: loopNodeId,
      kind: "loop",
      label: loop.name,
      sublabel: loop.kind === "loop" ? "loop" : "task",
      status: activeLoop ? "running" : "idle",
      taskId: loop.id,
    });

    // Subjects first: they are the durable record of what this loop is tracking,
    // and they anchor a cluster even for a ticket no run has touched yet.
    for (const subject of subjectsByLoop.get(loop.id) ?? []) {
      // No ticket, no root. The graph is a ticket graph now: an "unlinked work"
      // pile used to stand in for whatever could not be traced back, and it read
      // as a bucket of noise beside the tickets a person is actually answerable
      // for. Loop work with no ticket is still on the task and loop pages.
      const ticket = ticketForSubject(subject);
      if (!ticket) continue;
      const draft = draftFor(clusters, ticket);
      touch(draft, subject.updatedAt);
      addNode(draft, loopNode());

      const role = subjectRoleOf(subject);
      const title = stringField(subject.metadata, "title") ?? stringField(subject.metadata, "summary");

      // A ticket-kind subject collapses into the cluster's anchor rather than
      // duplicating it, so the subject's own URL becomes the ticket's.
      const ticketNodeId = ensureTicketNode(app, draft, ticket, {
        title,
        ...(role !== "mr" && subject.externalUrl ? { url: subject.externalUrl } : {}),
      });

      // Only a ticket the loop actually consumes feeds it. For a merge request
      // subject the ticket is linked to the MR below instead: the loop polls
      // GitLab and has never heard of the ticket.
      if (role === "ticket-input") {
        addEdge(draft, ticketNodeId, loopNodeId, "waiting");
      }

      const mrTarget = role === "mr" ? mrTargetFromSubjectKey(subject.subjectKey) : null;
      const mrNodeId =
        role === "mr"
          ? mrTarget
            ? mrNodeIdFor(mrTarget.projectId, mrTarget.iid)
            : `mr:${subject.subjectKey}`
          : undefined;
      if (mrNodeId) {
        addNode(draft, {
          id: mrNodeId,
          kind: "mr",
          label: subjectLabel(subject),
          ...(title ? { sublabel: title } : {}),
          status: "waiting",
          ...(subject.externalUrl ? { url: subject.externalUrl } : {}),
          taskId: loop.id,
          // What makes this node actionable: the toolbar sends these back.
          subjectKey: subject.subjectKey,
          ...(mrTarget ? { pullRequest: { projectId: mrTarget.projectId, mrIid: mrTarget.iid } } : {}),
        });
        // The relationship that actually exists: this merge request implements
        // that ticket. Recovered from the MR title, and nothing to do with the loop.
        if (ticketNodeId) addEdge(draft, ticketNodeId, mrNodeId, "waiting");
      }

      // Jobs raised for this exact subject, and the run each produced. Capped:
      // an hourly loop watching one MR piles up near-identical rows, and the
      // newest few are the only ones that answer "what is going on".
      const runNodeIds: string[] = [];
      for (const job of jobsBySubject.get(`${loop.id}\0${subject.subjectKey}`) ?? []) {
        const status = jobStatus(job);
        const jobNodeId = `job:${job.id}`;
        if (job.status === "queued" || job.status === "leased") draft.activeJobs++;
        const jobAt = job.finishedAt ?? job.startedAt ?? job.enqueuedAt;
        touch(draft, jobAt);

        addNode(draft, {
          id: jobNodeId,
          kind: "job",
          label: job.kind,
          sublabel: `attempt ${job.attempts}/${job.maxAttempts}`,
          status,
          taskId: loop.id,
          at: jobAt.toISOString(),
          ...(job.executionId ? { executionId: job.executionId } : {}),
          // Only while there is something to cancel. A finished job with a
          // cancel button would answer 409, which reads as a broken button
          // rather than as "this already ran".
          ...(job.status === "queued" || job.status === "leased" ? { jobId: job.id } : {}),
          job: {
            attempts: job.attempts,
            maxAttempts: job.maxAttempts,
            ...(job.error ? { error: job.error } : {}),
            enqueuedAt: job.enqueuedAt.toISOString(),
          },
        });
        addEdge(draft, loopNodeId, jobNodeId, status);

        if (job.executionId) {
          const runNodeId = `run:${job.executionId}`;
          addNode(draft, {
            id: runNodeId,
            kind: "run",
            label: job.kind,
            status,
            taskId: loop.id,
            executionId: job.executionId,
            at: jobAt.toISOString(),
          });
          addEdge(draft, jobNodeId, runNodeId, status);
          runNodeIds.push(runNodeId);
        }
      }

      // Whatever the work arrived at hangs off the runs that produced it — or off
      // the loop directly when nothing has run yet. For an MR subject that is the
      // merge request the runs commented on; for a `spec:` subject it is the Jira
      // ticket the run filed.
      const sinkNodeId = mrNodeId ?? (role === "ticket-output" ? ticketNodeId : undefined);
      if (sinkNodeId) {
        if (runNodeIds.length === 0) addEdge(draft, loopNodeId, sinkNodeId, "waiting");
        for (const runNodeId of runNodeIds) {
          addEdge(draft, runNodeId, sinkNodeId, draft.nodes.get(runNodeId)?.status ?? "waiting");
        }
      }
    }

    // Runs second: `details` is where the ticket→MR edge actually lives, and a
    // one-shot task like `fix-jira-issue` writes no subject at all, so this is
    // the only place its work shows up.
    for (const run of runs) {
      const details = run.details;
      const resources = resourcesByRun.get(run.executionId) ?? [];
      const ticket = resources.find((resource) => resource.kind === "ticket")?.key
        ?? extractJiraIssueKey(stringField(details, "issueKey"), stringField(details, "branch"));
      const mrUrl = resources.find((resource) => resource.kind === "merge-request")?.key
        ?? stringField(details, "mrUrl");
      const mrIid = numberField(details, "mrIid");
      // Same rule as the subjects above: a run whose ticket cannot be recovered
      // has no root to hang from, however much it did.
      if (!ticket) continue;

      const draft = draftFor(clusters, ticket);
      const runAt = run.finishedAt ?? run.startedAt;
      touch(draft, runAt);
      addNode(draft, loopNode());

      const status = runStatus(run);
      const runNodeId = `run:${run.executionId}`;
      addNode(draft, {
        id: runNodeId,
        kind: "run",
        label: run.taskId,
        ...(stringField(details, "action") ? { sublabel: stringField(details, "action") } : {}),
        status,
        taskId: loop.id,
        executionId: run.executionId,
        at: runAt.toISOString(),
      });

      addEdge(draft, ensureTicketNode(app, draft, ticket), loopNodeId, "waiting");
      addEdge(draft, loopNodeId, runNodeId, status);

      if (mrUrl != null || mrIid != null) {
        // Same canonical id as the subject path, so a run that commented on a
        // tracked merge request points at that node rather than growing a second
        // copy of it beside it.
        const target = mrUrl ? mrTargetFromUrl(mrUrl) : null;
        const mrNodeId = target
          ? mrNodeIdFor(target.projectId, target.iid)
          : `mr:${mrUrl ?? `${loop.id}!${mrIid}`}`;
        addNode(draft, {
          id: mrNodeId,
          kind: "mr",
          label: mrIid != null ? `!${mrIid}` : "merge request",
          status: mrStatusForAction(details?.action),
          ...(mrUrl ? { url: mrUrl } : {}),
          ...(target ? { pullRequest: { projectId: target.projectId, mrIid: target.iid } } : {}),
        });
        addEdge(draft, runNodeId, mrNodeId, status);
      }
    }
  }

  return clusters;
}

/**
 * A merge request node otherwise only ever reports "waiting" or the outcome of
 * its last completed run — nothing marks it running *while* an agent is on it.
 * That is exactly true of an action queued from the pull request page: it has no
 * work subject, so it never passes through `bySubject` above and the node it
 * belongs to would sit there looking idle for the whole run. Matched on the
 * canonical `mr:<project>!<iid>` id, so a graph-started action (which does reach
 * the mr node via its subject already) is simply confirmed, not doubled.
 */
function markRunningMergeRequests(app: App, clusters: Map<string, ClusterDraft>): void {
  const activeByMrNodeId = new Map(
    activePullRequestActions(app).map(
      (action) => [mrNodeIdFor(action.projectId, action.mrIid), action] as const,
    ),
  );
  for (const draft of clusters.values()) {
    for (const node of draft.nodes.values()) {
      if (node.kind !== "mr") continue;
      const running = activeByMrNodeId.get(node.id);
      if (!running) continue;
      draft.nodes.set(node.id, {
        ...node,
        status: "running",
        jobId: running.job.id,
        ...(running.job.executionId ? { executionId: running.job.executionId } : {}),
      });
    }
  }
}

/**
 * The plan waiting on a human for each ticket, and the gold that says so.
 *
 * The override is the point of this function, not a detail of it. A plan job that
 * finished is a `done` job, which draws as `success`, and `runningActions` empties
 * the instant it completes — so without this, the board turns green at the exact
 * moment somebody needs to look at something, and plans rot unnoticed. Which is the
 * one failure that would make the whole gate worse than not having it.
 *
 * Only `awaiting-review` colours the node. An `approved` plan is on the queue and its
 * own fix job draws itself; nobody is being waited on.
 */
function attachPlans(app: App, clusters: Map<string, ClusterDraft>): void {
  if (clusters.size === 0) return;
  for (const plan of app.plans.unresolvedForIssues([...clusters.keys()])) {
    const draft = clusters.get(plan.issueKey);
    // Newest first out of the query, so the first plan seen for a ticket is the one
    // to report and any older one is left alone.
    if (!draft || draft.plan) continue;

    const stale =
      plan.ticketFingerprint != null &&
      draft.ticket != null &&
      ticketFingerprint(plan.issueKey, draft.ticket.updatedAt) !== plan.ticketFingerprint;

    draft.plan = {
      id: plan.id,
      status: plan.status,
      ...(plan.summary ? { summary: plan.summary } : {}),
      stale,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    };

    if (plan.status !== "awaiting-review") continue;
    const ticketNodeId = ensureTicketNode(app, draft, plan.issueKey);
    const node = draft.nodes.get(ticketNodeId)!;
    // Never over a running overlay: an agent actually working on the ticket right now
    // is the more urgent thing to say, and a re-plan in flight would otherwise read
    // as though it were already finished and waiting.
    if (node.status === "running") continue;
    draft.nodes.set(ticketNodeId, {
      ...node,
      status: "waiting",
    });
  }
}

/** What the ticket node says about itself while each action runs. */
const RUNNING_SUBLABEL: Record<TicketActionId, string> = {
  "fix-issue": "fix in progress",
  "plan-issue": "writing a plan",
  "review-description": "reviewing the description",
  "e2e-test": "testing in QA",
};

/** What each action's own node calls itself. */
const ACTION_LABEL: Record<TicketActionId, string> = {
  "fix-issue": "Fix issue",
  "plan-issue": "Plan issue",
  "review-description": "Review description",
  "e2e-test": "E2E test",
};

function e2eResult(
  details: Record<string, unknown> | undefined,
  jobId: string,
  testMr?: ApiContract.E2eTestResultView["testMr"],
): ApiContract.E2eTestResultView | undefined {
  const source = details ?? {};
  const verdict = source.verdict;
  const summary = source.summary;
  if (
    (verdict !== "pass" && verdict !== "fail" && verdict !== "inconclusive") ||
    typeof summary !== "string"
  ) {
    return undefined;
  }
  const scenarios: ApiContract.E2eTestResultView["scenarios"] = Array.isArray(source.scenarios)
    ? source.scenarios.flatMap((value) => {
        if (!isRecord(value)) return [];
        const outcome = value.outcome;
        if (
          typeof value.name !== "string" ||
          typeof value.detail !== "string" ||
          (outcome !== "pass" && outcome !== "fail" && outcome !== "blocked")
        ) return [];
        return [{
          name: value.name,
          outcome: outcome as "pass" | "fail" | "blocked",
          detail: value.detail,
          evidence: stringArray(value.evidence),
          ...(automationView(value.automation) ? { automation: automationView(value.automation) } : {}),
        }];
      })
    : [];
  const findings: ApiContract.E2eTestResultView["findings"] = Array.isArray(source.findings)
    ? source.findings.flatMap((value) => {
        if (!isRecord(value)) return [];
        const severity = value.severity;
        if (
          typeof value.title !== "string" ||
          typeof value.detail !== "string" ||
          (severity !== "critical" && severity !== "major" && severity !== "minor")
        ) return [];
        return [{
          severity: severity as "critical" | "major" | "minor",
          title: value.title,
          detail: value.detail,
          evidence: stringArray(value.evidence),
        }];
      })
    : [];
  const artifacts: ApiContract.E2eTestResultView["artifacts"] = Array.isArray(source.artifacts)
    ? source.artifacts.flatMap((value) => {
        if (!isRecord(value)) return [];
        const kind = value.kind;
        if (
          typeof value.name !== "string" ||
          typeof value.contentType !== "string" ||
          typeof value.bytes !== "number" ||
          (kind !== "screenshot" && kind !== "trace" && kind !== "log")
        ) return [];
        return [{
          name: value.name,
          kind: kind as "screenshot" | "trace" | "log",
          contentType: value.contentType,
          bytes: value.bytes,
          url:
            `/api/e2e/jobs/${encodeURIComponent(jobId)}/artifacts/` +
            encodeURIComponent(value.name),
        }];
      })
    : [];
  const exportable =
    source.projectId === e2eTestProject() &&
    scenarios.some((scenario) => scenario.outcome !== "blocked" && scenario.automation);
  const sourceBranch = typeof source.sourceBranch === "string" ? source.sourceBranch : undefined;
  const targetBranch = typeof source.targetBranch === "string" ? source.targetBranch : undefined;
  return {
    jobId,
    exportable,
    ...(sourceBranch ? { sourceBranch } : {}),
    ...(targetBranch ? { targetBranch } : {}),
    verdict,
    summary,
    scenarios,
    findings,
    artifacts,
    ...(testMr ? { testMr } : {}),
  };
}

function automationView(
  value: unknown,
): ApiContract.E2eTestResultView["scenarios"][number]["automation"] | undefined {
  if (!isRecord(value)) return undefined;
  const portal = value.portal;
  if (portal !== "main" && portal !== "parent" && portal !== "student") return undefined;
  const steps = Array.isArray(value.steps)
    ? value.steps.flatMap((step) => {
      if (
        !isRecord(step) ||
        !isAutomationAction(step.action) ||
        typeof step.target !== "string"
      ) {
        return [];
      }
      return [{
        action: step.action,
        target: step.target,
        ...(typeof step.locatorHint === "string" ? { locatorHint: step.locatorHint } : {}),
        ...(typeof step.value === "string" ? { value: step.value } : {}),
        ...(typeof step.expected === "string" ? { expected: step.expected } : {}),
      }];
    })
    : [];
  if (steps.length === 0) return undefined;
  return { portal, preconditions: stringArray(value.preconditions), steps };
}

function isAutomationAction(
  value: unknown,
): value is NonNullable<
  ApiContract.E2eTestResultView["scenarios"][number]["automation"]
>["steps"][number]["action"] {
  return typeof value === "string" && [
    "navigate",
    "click",
    "fill",
    "select",
    "check",
    "press",
    "assert",
    "wait",
  ].includes(value);
}

function e2eTestMrView(
  job: Job,
  run: TaskRunSummary | undefined,
): NonNullable<ApiContract.E2eTestResultView["testMr"]> {
  const details = run?.details;
  const mrUrl = stringField(details, "mrUrl");
  const action = stringField(details, "action");
  const status =
    job.status === "queued"
      ? "queued"
      : job.status === "leased"
        ? "running"
        : job.status === "dead"
          ? "dead"
          : action === "opened" || action === "adopted"
            ? "opened"
            : "no-change";
  return {
    status,
    jobId: job.id,
    ...(mrUrl ? { mrUrl } : {}),
    ...(typeof details?.draft === "boolean" ? { draft: details.draft } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Everything anybody has triggered on each ticket, as a node per action, plus the
 * running overlay on the ticket itself.
 *
 * A ticket action's job carries no work subject — the ticket came from Jira, not
 * from a loop — and its handler is registered `kind: "job"`, so it is not a listed
 * scheduled task and `collectLoopWork` never reads its runs either. Between the
 * two, nothing in the payload mentioned these jobs at all: the only sign a click
 * had landed was the ticket node turning coral, and the moment the run finished
 * even that went away, taking the way back to its log with it. So each action gets
 * a node of its own hanging off the ticket, carrying its `executionId` — which is
 * what makes the panel stream that run's steps and log.
 *
 * Only in-flight actions may *create* a cluster, and finished ones never do. The
 * page's buttons are the usual way to start a fix but not the only one — the
 * endpoint takes any issue key, so a fix queued over the API can name a ticket
 * Jira does not say is yours and no loop has ever tracked, and that run has to be
 * visible somewhere while it happens. History is the other way round: it reaches
 * back as far as the queue does, and a fix that ran last month for a since-closed
 * ticket would otherwise put that ticket back on the canvas permanently.
 */
function attachTicketActions(app: App, clusters: Map<string, ClusterDraft>): void {
  const history = ticketActionHistory(app);
  const exportsBySource = e2eTestMrJobsBySource(app);
  const runs = app.sink.getRuns(
    [
      ...[...history.values()].flatMap((entries) =>
        entries.flatMap(({ job }) => job.executionId ? [job.executionId] : [])
      ),
      ...[...exportsBySource.values()].flatMap((job) =>
        job.executionId ? [job.executionId] : []
      ),
    ],
  );
  for (const [issueKey, entries] of history) {
    const active = entries.filter(
      ({ job }) => job.status === "queued" || job.status === "leased",
    );
    if (active.length === 0 && !clusters.has(issueKey)) continue;

    const conjured = !clusters.has(issueKey);
    const draft = draftFor(clusters, issueKey);
    const ticketNodeId = ensureTicketNode(app, draft, issueKey);
    // A cluster conjured here has `updatedAt` at the epoch and would sort last,
    // under every ticket nothing is happening to. Only the conjured ones: a
    // cluster that already existed has a real timestamp off its own work, and
    // overwriting that would reorder the page for a reason the developer cannot
    // see.
    if (conjured) touch(draft, new Date());

    for (const { action, job } of entries) {
      const run = job.executionId ? runs.get(job.executionId) : undefined;
      const details = run?.details;
      const exportJob = action === "e2e-test" ? exportsBySource.get(job.id) : undefined;
      const exportRun = exportJob?.executionId ? runs.get(exportJob.executionId) : undefined;
      if (exportJob?.status === "queued" || exportJob?.status === "leased") {
        draft.activeJobs++;
      }
      const e2e = action === "e2e-test"
        ? e2eResult(details, job.id, exportJob ? e2eTestMrView(exportJob, exportRun) : undefined)
        : undefined;
      const status = e2e?.verdict === "fail"
        ? "failure"
        : e2e?.verdict === "inconclusive"
          ? "waiting"
          : jobStatus(job);
      const actionAt = job.finishedAt ?? job.startedAt ?? job.enqueuedAt;
      touch(draft, actionAt);
      addNode(draft, {
        id: `action:${job.id}`,
        kind: "action",
        label: ACTION_LABEL[action],
        sublabel: `attempt ${job.attempts}/${job.maxAttempts}`,
        status,
        at: actionAt.toISOString(),
        // No `taskId`: the handler behind these is registered `kind: "job"` and is
        // deliberately absent from the task list, so an `Open task` button here
        // would point at a page that lists nothing.
        ...(job.executionId ? { executionId: job.executionId } : {}),
        ...(e2e ? { e2e } : {}),
        // Only while there is something to cancel, same rule as a job node.
        ...(job.status === "queued" || job.status === "leased" ? { jobId: job.id } : {}),
        job: {
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          ...(job.error ? { error: job.error } : {}),
          enqueuedAt: job.enqueuedAt.toISOString(),
        },
      });
      const actionNodeId = `action:${job.id}`;
      addEdge(draft, ticketNodeId, actionNodeId, status);

      // A completed "Fix issue" action records the merge request it opened in
      // the run details/execution resources, but it has no work subject and is
      // therefore invisible to `collectLoopWork`. Keep that durable output on the
      // ticket after the action finishes: it is the exact Development link the
      // ticket drawer needs, including when the MR is no longer in the user's
      // current open-MR listing.
      const mrUrl = stringField(details, "mrUrl");
      const target = mrUrl ? mrTargetFromUrl(mrUrl) : null;
      if (target && mrUrl) {
        const mrNodeId = mrNodeIdFor(target.projectId, target.iid);
        addNode(draft, {
          id: mrNodeId,
          kind: "mr",
          label: `!${target.iid}`,
          status: mrStatusForAction(details?.action),
          url: mrUrl,
          pullRequest: { projectId: target.projectId, mrIid: target.iid },
        });
        addEdge(draft, actionNodeId, mrNodeId, status);

        const sourceBranch = stringField(details, "branch");
        const targetBranch = stringField(details, "targetBranch");
        const alreadyCandidate = draft.e2ePullRequests.some(
          (candidate) =>
            candidate.projectId === target.projectId &&
            candidate.mrIid === target.iid,
        );
        if (sourceBranch && targetBranch && !alreadyCandidate) {
          draft.e2ePullRequests.push({
            projectId: target.projectId,
            mrIid: target.iid,
            title: draft.title ?? `Merge request !${target.iid}`,
            url: mrUrl,
            sourceBranch,
            targetBranch,
            draft: false,
            updatedAt: actionAt.toISOString(),
          });
        }
      }
    }

    // The ticket node keeps saying so itself, on top of its action nodes: the root
    // is the only part of a collapsed row a developer can see, and "something is
    // happening here" is exactly what a collapsed row has to be able to say.
    for (const { action, job } of active) {
      draft.activeJobs++;
      draft.runningActions.add(action);
      const node = draft.nodes.get(ticketNodeId)!;
      draft.nodes.set(ticketNodeId, {
        ...node,
        status: "running",
        sublabel: node.sublabel ?? RUNNING_SUBLABEL[action],
        jobId: job.id,
        ...(job.executionId ? { executionId: job.executionId } : {}),
      });
    }
  }
}

function toClusterView(
  draft: ClusterDraft,
  refusals: Record<TicketActionId, string | null>,
): TicketClusterView {
  // Sorted by id so identical data lays out identically — the client derives
  // node positions from this order, and an unstable sort makes the canvas jump
  // on every poll.
  const nodes = [...draft.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const ticketNode = nodes.find((node) => node.kind === "ticket");
  const work = nodes.filter((node) => node.kind !== "ticket");
  const mrs = nodes.filter((node) => node.kind === "mr").length;
  const latestE2e = nodes
    .filter((node): node is GraphNode & { e2e: ApiContract.E2eTestResultView } => node.e2e != null)
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))[0]?.e2e;
  const e2eCoverage = latestE2e
    ? {
        status:
          latestE2e.testMr?.status === "opened"
            ? "mr-ready" as const
            : latestE2e.testMr?.status === "queued" || latestE2e.testMr?.status === "running"
              ? "writing" as const
              : latestE2e.verdict === "pass"
                ? "passed" as const
                : latestE2e.verdict === "fail"
                  ? "failed" as const
                  : "inconclusive" as const,
        scenarios: latestE2e.scenarios.filter((scenario) => scenario.outcome !== "blocked").length,
        ...(latestE2e.testMr?.mrUrl ? { mrUrl: latestE2e.testMr.mrUrl } : {}),
      }
    : undefined;

  return {
    key: draft.key,
    ...(draft.title ? { title: draft.title } : {}),
    ...(draft.url ?? ticketNode?.url ? { url: draft.url ?? ticketNode?.url } : {}),
    // The summary comes from the work hanging off the ticket, because the ticket
    // node says nothing about health. With nothing hanging off it there is no
    // work to summarise, so the ticket's own state stands — otherwise a ticket
    // nobody has started would be reported as `idle`, which sounds like a
    // verdict on the work rather than the absence of any.
    // A plan awaiting review is folded in as `waiting` rather than left to the work
    // nodes, because the work that produced it *succeeded* — the plan job is `done`
    // — and a collapsed row summarised off that alone reads green while a person is
    // being waited on. `worstOf` ranks `waiting` above `success` and below both
    // `running` and `failure`, which is the right precedence: a failing fix on the
    // same ticket is the more urgent thing to say.
    status: worstOf([
      work.length > 0
        ? worstOf(work.map((node) => node.status))
        : (ticketNode?.status ?? "waiting"),
      ...(draft.plan?.status === "awaiting-review" ? (["waiting"] as const) : []),
    ]),
    source: draft.ticket ? "jira" : "loops",
    ...(draft.ticket?.columnId ? { columnId: draft.ticket.columnId } : {}),
    ...(draft.ticket?.sprint ? { sprint: draft.ticket.sprint } : {}),
    sprints: draft.ticket?.sprints ?? [],
    actions: ticketActions(draft, refusals, mrs),
    e2ePullRequests: [...draft.e2ePullRequests].sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    ),
    ...(e2eCoverage ? { e2eCoverage } : {}),
    ...(draft.plan ? { plan: draft.plan } : {}),
    counts: {
      mrs,
      jobs: nodes.filter((node) => node.kind === "job").length,
      runs: nodes.filter((node) => node.kind === "run").length,
      actions: nodes.filter((node) => node.kind === "action").length,
      activeJobs: draft.activeJobs,
    },
    inReview: draft.openMrs > 0,
    updatedAt: draft.updatedAt.toISOString(),
    nodes,
    edges: [...draft.edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Every action's answer for one ticket, in one record — see `TicketActionAvailability`. */
function ticketActions(
  draft: ClusterDraft,
  refusals: Record<TicketActionId, string | null>,
  mrs: number,
): TicketClusterView["actions"] {
  const out = {} as TicketClusterView["actions"];
  for (const id of TICKET_ACTION_IDS) {
    out[id] = availability(id, draft, refusals[id], mrs);
  }
  return out;
}

/**
 * Whether one action can run against this ticket.
 *
 * The refusals differ because the actions ask for different things. A fix writes
 * code, so the interesting refusal is "it already has a merge request": the action
 * exists for the ticket nobody has started, and offering it beside an open MR
 * invites a second branch for the same work. `fix-jira-issue` would in fact adopt
 * the existing branch rather than duplicate it, so this is a matter of not asking
 * a developer to guess what the button will do — hence a reason rather than a
 * hidden button.
 *
 * A description review writes only a comment, so none of that applies: reviewing
 * the requirements of a ticket that already has an MR is unusual but harmless, and
 * a ticket only a loop has heard of can be reviewed like any other — the agent
 * reads it from Jira by key, not from what the graph happens to know. What it does
 * refuse is a finished ticket, where questions about the requirements are asked
 * too late to be worth anybody's reply.
 *
 * Planning sits between the two. It clones, so it wants the same "is there already a
 * merge request" answer a fix does — planning work that has been written is a wasted
 * container. What is particular to it is that a ticket may hold only one unresolved
 * plan: a second draft for the same ticket gives one reviewer two documents to
 * reconcile, which is worse than no plan at all.
 *
 * The branch rides along on the fix when the answer is yes, because the client
 * shows it in the confirmation step and must not have to reimplement the slug
 * rules.
 */
function availability(
  action: TicketActionId,
  draft: ClusterDraft,
  refusal: string | null,
  mrs: number,
): TicketClusterView["actions"][TicketActionId] {
  if (refusal) return { available: false, reason: refusal };
  if (draft.runningActions.has(action) && action !== "e2e-test") {
    return { available: false, reason: RUNNING_REFUSAL[action] };
  }
  if (draft.ticket?.statusCategory === DONE_CATEGORY) {
    return { available: false, reason: `This ticket is ${draft.ticket.status ?? "done"}.` };
  }

  if (action === "e2e-test") {
    if (draft.e2ePullRequests.length === 0) {
      return {
        available: false,
        reason: "This ticket has no linked merge request to test.",
      };
    }
    return { available: true };
  }

  if (action === "review-description") return { available: true };

  // One plan at a time, whichever action asks. Two drafts for one ticket is two
  // documents and one reviewer, and the store's unique index would refuse the second
  // insert only after its container had already run.
  if (action === "plan-issue" && draft.plan) {
    return {
      available: false,
      reason:
        draft.plan.status === "awaiting-review"
          ? "A plan for this ticket is already waiting for your review."
          : "This ticket's plan has been approved and is being implemented.",
    };
  }

  if (mrs > 0) {
    return {
      available: false,
      reason:
        mrs === 1
          ? "This ticket already has a merge request."
          : `This ticket already has ${mrs} merge requests.`,
    };
  }
  if (!draft.ticket) {
    return {
      available: false,
      reason: "This ticket is not assigned to you, so its state is only what a loop reported.",
    };
  }
  // The branch rides along on the fix only: it is the branch that will be pushed, and
  // a planning run pushes nothing. Naming one there would promise a branch that
  // approving the plan might never produce.
  if (action === "plan-issue") return { available: true };
  return { available: true, branch: fixIssueBranchName(draft.key, draft.title ?? draft.key) };
}

const RUNNING_REFUSAL: Record<TicketActionId, string> = {
  "fix-issue": "A fix is already running for this ticket.",
  "plan-issue": "A plan is already being written for this ticket.",
  "review-description": "A review is already running for this ticket.",
  "e2e-test": "An E2E test is already running for this ticket.",
};

/**
 * Access, plus the scope filter.
 *
 * The access half mirrors `canAccessTask` in `router.ts`: a code-registered task
 * with no instance row is visible to everyone, an instance is visible when public
 * or owned. `mine` then narrows to instances this account owns.
 */
function canSee(app: App, taskId: string, user: AuthUser, scope: "mine" | "team"): boolean {
  const instance = app.instances.get(taskId);
  if (!instance) return scope === "team";
  if (instance.ownerId === user.id) return true;
  return scope === "team" && instance.visibility === "public";
}

type ContractCheck<T extends U, U> = T;
type _TicketGraphContract = ContractCheck<TicketGraphView, ApiContract.TicketGraphView>;
type _TicketClusterContract = ContractCheck<TicketClusterView, ApiContract.TicketCluster>;
type _GraphNodeContract = ContractCheck<GraphNode, ApiContract.GraphNode>;
type _GraphEdgeContract = ContractCheck<GraphEdge, ApiContract.GraphEdge>;
