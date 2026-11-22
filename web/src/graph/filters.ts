import type { GraphNode, SprintView, TicketCluster, TicketGraphView } from "../api.ts";

/**
 * What narrows the ticket graph, and how a cluster is tested against it.
 *
 * Client-side on purpose. The payload already holds every cluster the developer can
 * see — assembled from Jira's complete board read and a SQLite overlay — so
 * filtering here costs nothing, answers instantly, and lets every facet show a live
 * count. Pushing the sprint into the JQL instead would spend a Jira round trip per
 * click, invalidate the cache the three-second poll depends on, and still leave the
 * counts unknowable without asking again.
 *
 * Pure and separate from the components so the rules are readable in one place: a
 * cluster is in or out for reasons, and those reasons are the page's whole model of
 * "manageable".
 */

/**
 * Which sprint the page is showing.
 *
 * `active` is stored rather than any one sprint id: Jira permits parallel active
 * sprints, and its board shows their union by default. A number appears only when
 * one sprint has been picked explicitly.
 */
export type SprintSelection = "active" | "all" | "backlog" | number;

/**
 * A cut across the *work*, not the ticket — the dimension a Jira board cannot
 * offer.
 *
 * These are why the filter bar is worth having over Jira's own: "which of my sprint
 * tickets has an agent given up on" and "which has nobody started" are the two
 * questions this console can answer and the board cannot.
 */
export type WorkFacet = "attention" | "running" | "has-mr" | "untouched" | "fixable";

export const WORK_FACETS: readonly { id: WorkFacet; label: string; hint: string }[] = [
  {
    id: "attention",
    label: "Needs attention",
    hint: "A run failed, or an agent gave up",
  },
  { id: "running", label: "In flight", hint: "A run or job is going right now" },
  { id: "has-mr", label: "Has a merge request", hint: "At least one MR names this ticket" },
  {
    id: "untouched",
    label: "Nothing started",
    hint: "No merge request, no job, no run",
  },
  { id: "fixable", label: "Can be handed off", hint: "\"Fix this issue\" would run" },
];

/** Every dimension a value can be picked from, besides the sprint and the query. */
export type FacetKey = "work" | "status" | "type" | "priority" | "label";

export interface GraphFilters {
  sprint: SprintSelection;
  /** Free text over the ticket *and* its work — see `matchesQuery`. */
  query: string;
  work: WorkFacet[];
  /** Jira's own status names, because that is what a developer thinks in. */
  status: string[];
  type: string[];
  priority: string[];
  label: string[];
}

/**
 * Current sprint, nothing else narrowed.
 *
 * The one filter that is on by default, because the page's own answer to "what am I
 * working on" is the active sprint set — and when there is no active sprint,
 * `resolveSprint` falls back to everything rather than to an empty canvas.
 */
export const DEFAULT_FILTERS: GraphFilters = {
  sprint: "active",
  query: "",
  work: [],
  status: [],
  type: [],
  priority: [],
  label: [],
};

/** This page's row in `user_preferences` — see `usePreference`. */
export const FILTERS_PREFERENCE_KEY = "graph.filters";

/**
 * A stored value back into filters, defaulting field by field.
 *
 * Defensive to the point of paranoia because the value outlives the code that wrote
 * it: it comes from a server row that another machine — possibly another release —
 * last wrote, so every field is treated as untrusted and anything unrecognised falls
 * back to its default rather than reaching a component.
 *
 * The free-text query is deliberately *not* restored. A sprint or a facet is a
 * standing preference; a half-typed ticket key is a thing you did once, and coming
 * back tomorrow to a canvas mysteriously showing two tickets is the bug that pattern
 * always produces.
 */
export function parseFilters(raw: unknown): GraphFilters {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_FILTERS;
  const stored = raw as Partial<GraphFilters>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  return {
    sprint: normalizeSelection(stored.sprint),
    query: "",
    work: strings(stored.work).filter((entry): entry is WorkFacet =>
      WORK_FACETS.some((facet) => facet.id === entry),
    ),
    status: strings(stored.status),
    type: strings(stored.type),
    priority: strings(stored.priority),
    label: strings(stored.label),
  };
}

/** What gets stored: everything but the query, for the reason `parseFilters` gives. */
export function filtersToStore(filters: GraphFilters): GraphFilters {
  return { ...filters, query: "" };
}

/**
 * Whether two filter sets differ in anything worth *storing*.
 *
 * The query is excluded, which is the entire point: without this, every keystroke in
 * the search box would be a PUT, and a five-letter ticket key would write the row
 * five times to save a value that is never read back.
 */
export function sameStoredFilters(a: GraphFilters, b: GraphFilters): boolean {
  const same = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && x.every((entry, index) => entry === y[index]);
  return (
    a.sprint === b.sprint &&
    same(a.work, b.work) &&
    same(a.status, b.status) &&
    same(a.type, b.type) &&
    same(a.priority, b.priority) &&
    same(a.label, b.label)
  );
}

function normalizeSelection(value: unknown): SprintSelection {
  // `current` was the pre-parallel-sprint spelling. Treat the stored preference
  // as the new active union rather than stranding an existing account on one id.
  if (value === "current") return "active";
  if (value === "all" || value === "backlog" || value === "active") return value;
  return typeof value === "number" && Number.isFinite(value) ? value : "active";
}

export function isFiltered(filters: GraphFilters): boolean {
  return (
    filters.sprint !== DEFAULT_FILTERS.sprint ||
    filters.query.trim() !== "" ||
    filters.work.length > 0 ||
    filters.status.length > 0 ||
    filters.type.length > 0 ||
    filters.priority.length > 0 ||
    filters.label.length > 0
  );
}

/** Everything off, including the sprint — "show me literally all of it". */
export const NO_FILTERS: GraphFilters = { ...DEFAULT_FILTERS, sprint: "all" };

/**
 * What `filters.sprint` means against the payload in hand.
 *
 * `active` needs resolving because it names every sprint Jira currently marks
 * active, and that set may be empty. Rather than draw an empty canvas the
 * selection degrades to `all` and says it did, which the bar shows as a note — an
 * empty page with a filter silently on is the single most confusing state this
 * feature could produce.
 */
export interface ResolvedSprint {
  mode: "all" | "backlog" | "active" | "sprint";
  sprint?: SprintView;
  sprints?: SprintView[];
  /** True when a sprint was asked for and the payload does not have it. */
  fellBack: boolean;
}

export function resolveSprint(
  selection: SprintSelection,
  view: Pick<TicketGraphView, "sprints"> | undefined,
): ResolvedSprint {
  if (selection === "all") return { mode: "all", fellBack: false };
  if (selection === "backlog") return { mode: "backlog", fellBack: false };

  const sprints = view?.sprints ?? [];
  if (selection === "active") {
    const active = sprints.filter((entry) => entry.state === "active");
    if (active.length > 0) {
      return { mode: "active", sprints: active, fellBack: false };
    }
    return { mode: "all", fellBack: sprints.length > 0 };
  }
  const sprint = sprints.find((entry) => entry.id === selection);
  if (sprint) return { mode: "sprint", sprint, fellBack: false };
  // A sprint that has gone from the payload — it closed, or its last ticket was
  // reassigned — is not a reason to show nothing.
  return { mode: "all", fellBack: true };
}

/** The ticket facts a cluster's root node carries, if it has any. */
export function factsOf(cluster: TicketCluster): GraphNode["ticket"] {
  return cluster.nodes.find((node) => node.kind === "ticket")?.ticket;
}

/**
 * Which sprint bucket a cluster falls in.
 *
 * A cluster with no ticket facts at all — one only a loop knows about, so Jira was
 * never asked whose sprint it is in — is *not* backlog: "we do not know" and "it is
 * in no sprint" would otherwise be filed together, and the loop-only ticket would
 * vanish from a backlog view it does not belong in either. It shows under a sprint
 * filter only when nothing else matches, which is `matchesSprint`'s job below.
 */
function sprintBucket(cluster: TicketCluster): "sprint" | "backlog" | "unknown" {
  if (cluster.sprints.length > 0) return "sprint";
  return factsOf(cluster) ? "backlog" : "unknown";
}

function matchesSprint(cluster: TicketCluster, resolved: ResolvedSprint): boolean {
  if (resolved.mode === "all") return true;
  const bucket = sprintBucket(cluster);
  // Unknown rides along with whatever is on screen rather than being hidden by a
  // filter that cannot honestly judge it: a merge request an agent has open right
  // now is the last thing to drop off the canvas silently.
  if (bucket === "unknown") return true;
  if (resolved.mode === "backlog") return bucket === "backlog";
  if (resolved.mode === "active") {
    const activeIds = new Set(resolved.sprints?.map((sprint) => sprint.id));
    return cluster.sprints.some((sprint) => activeIds.has(sprint.id));
  }
  return cluster.sprints.some((sprint) => sprint.id === resolved.sprint?.id);
}

function matchesWork(cluster: TicketCluster, facets: readonly WorkFacet[]): boolean {
  // Any rather than all: these are alternatives you scan by ("failed or running"),
  // not conditions you stack, and `attention AND running` would be empty anyway.
  return facets.length === 0 || facets.some((facet) => hasWorkFacet(cluster, facet));
}

function hasWorkFacet(cluster: TicketCluster, facet: WorkFacet): boolean {
  const { counts, status } = cluster;
  switch (facet) {
    case "attention":
      return status === "failure" || status === "dead";
    case "running":
      return status === "running" || counts.activeJobs > 0;
    case "has-mr":
      return counts.mrs > 0;
    case "untouched":
      return counts.mrs + counts.jobs + counts.runs + counts.actions === 0;
    case "fixable":
      return cluster.actions["fix-issue"].available;
  }
}

/**
 * Free text against everything on the row, the ticket's own fields *and* its work.
 *
 * The work is included because of how the page is actually used: "gitlab-review",
 * the name of a loop, or a word from a merge request title are all things a
 * developer types when they mean "the ticket where that is happening", and a search
 * over ticket keys alone answers only the question you did not need help with.
 */
function matchesQuery(cluster: TicketCluster, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const facts = factsOf(cluster);
  const haystack = [
    cluster.key,
    cluster.title,
    cluster.sprint?.name,
    facts?.status,
    facts?.type,
    facts?.priority,
    facts?.reporter,
    ...(facts?.labels ?? []),
    ...cluster.nodes.flatMap((node) => [node.label, node.sublabel]),
  ];
  // Every word has to land somewhere, so "review TP-12" narrows rather than widens.
  return needle
    .split(/\s+/)
    .every((word) =>
      haystack.some((value) => value != null && value.toLowerCase().includes(word)),
    );
}

/** The values a cluster offers for one facet — several, in the case of labels. */
function valuesFor(cluster: TicketCluster, key: FacetKey): string[] {
  const facts = factsOf(cluster);
  switch (key) {
    case "work":
      return WORK_FACETS.filter((facet) => hasWorkFacet(cluster, facet.id)).map(
        (facet) => facet.id,
      );
    case "status":
      return facts?.status ? [facts.status] : [];
    case "type":
      return facts?.type ? [facts.type] : [];
    case "priority":
      return facts?.priority ? [facts.priority] : [];
    case "label":
      return facts?.labels ?? [];
  }
}

function matchesValues(
  cluster: TicketCluster,
  key: FacetKey,
  selected: readonly string[],
): boolean {
  if (selected.length === 0) return true;
  const values = valuesFor(cluster, key);
  return selected.some((wanted) => values.includes(wanted));
}

/**
 * One dimension left out, which is what makes the counts beside each value
 * meaningful.
 *
 * A facet's numbers have to be counted against the *other* filters only — otherwise
 * a picked value shows its own count and every sibling shows zero, and the menu
 * stops being able to tell you where the rest of your tickets went. Standard
 * faceted search; the subtlety is only that it must not include itself.
 */
function matchesExcept(
  cluster: TicketCluster,
  filters: GraphFilters,
  resolved: ResolvedSprint,
  except: FacetKey | "sprint" | "query" | null,
): boolean {
  return (
    (except === "sprint" || matchesSprint(cluster, resolved)) &&
    (except === "query" || matchesQuery(cluster, filters.query)) &&
    (except === "work" || matchesWork(cluster, filters.work)) &&
    (except === "status" || matchesValues(cluster, "status", filters.status)) &&
    (except === "type" || matchesValues(cluster, "type", filters.type)) &&
    (except === "priority" || matchesValues(cluster, "priority", filters.priority)) &&
    (except === "label" || matchesValues(cluster, "label", filters.label))
  );
}

export function applyFilters(
  clusters: readonly TicketCluster[],
  filters: GraphFilters,
  resolved: ResolvedSprint,
): TicketCluster[] {
  return clusters.filter((cluster) => matchesExcept(cluster, filters, resolved, null));
}

export interface FacetOption {
  value: string;
  label: string;
  hint?: string;
  count: number;
  selected: boolean;
}

/**
 * One facet's options, ordered the way it should be read.
 *
 * Work facets keep their declared order — it runs worst-first, so the menu reads
 * like a triage list. The rest sort by count, because they are open sets read off
 * whatever Jira happens to return and the useful ones are the big ones.
 *
 * A selected value is kept even at zero, so unticking is always possible: a filter
 * you can turn on but not off is a trap.
 */
export function facetOptions(
  clusters: readonly TicketCluster[],
  filters: GraphFilters,
  resolved: ResolvedSprint,
  key: FacetKey,
): FacetOption[] {
  const selected = filters[key] as readonly string[];
  const counts = new Map<string, number>();
  for (const value of selected) counts.set(value, 0);

  for (const cluster of clusters) {
    if (!matchesExcept(cluster, filters, resolved, key)) continue;
    for (const value of valuesFor(cluster, key)) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  const options = [...counts].map(([value, count]) => ({
    value,
    label: key === "work" ? workLabel(value) : value,
    ...(key === "work" ? { hint: workHint(value) } : {}),
    count,
    selected: selected.includes(value),
  }));

  if (key === "work") {
    const order = WORK_FACETS.map((facet) => facet.id as string);
    return options.sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value));
  }
  return options.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function workLabel(id: string): string {
  return WORK_FACETS.find((facet) => facet.id === id)?.label ?? id;
}

function workHint(id: string): string | undefined {
  return WORK_FACETS.find((facet) => facet.id === id)?.hint;
}

/** What the sprint switcher offers, in payload order, with the backlog on the end. */
export interface SprintOption {
  selection: SprintSelection;
  label: string;
  /** `active`, `future`, `closed`, or absent for the backlog and "all". */
  state?: SprintView["state"];
  count: number;
  sprint?: SprintView;
}

/**
 * Sprint counts are taken against the *other* filters too, for the same reason the
 * facet counts are: switching sprint with a type filter on should show how many
 * bugs are in the next sprint, not how many tickets of any kind.
 */
export function sprintOptions(
  clusters: readonly TicketCluster[],
  filters: GraphFilters,
  view: Pick<TicketGraphView, "sprints"> | undefined,
): SprintOption[] {
  // Closed sprints remain part of "All tickets", but no longer turn the sprint
  // chooser into years of history. Jira's active and future choices are the ones
  // a developer can act on from this board.
  const sprints = (view?.sprints ?? []).filter((sprint) => sprint.state !== "closed");
  // Every other filter honoured, the sprint left out — the dimension being counted
  // never counts itself. See `matchesExcept`.
  const candidates = clusters.filter((cluster) =>
    matchesExcept(cluster, filters, { mode: "all", fellBack: false }, "sprint"),
  );

  const active = sprints.filter((sprint) => sprint.state === "active");
  const options: SprintOption[] = active.length > 0
    ? [{
        selection: "active",
        label: "Active sprints",
        state: "active",
        count: candidates.filter((cluster) =>
          cluster.sprints.some((membership) =>
            active.some((sprint) => sprint.id === membership.id),
          ),
        ).length,
      }]
    : [];
  options.push(...sprints.map((sprint) => ({
    selection: sprint.id,
    label: sprint.name,
    state: sprint.state,
    // How many tickets are *in* that sprint, which is a smaller number than the
    // canvas will show: a cluster whose sprint is unknown rides along with whatever
    // is selected, and counting it under every option would make each number look
    // like the total.
    count: candidates.filter((cluster) =>
      cluster.sprints.some((membership) => membership.id === sprint.id),
    ).length,
    sprint,
  })));

  const backlog = candidates.filter((cluster) => sprintBucket(cluster) === "backlog");
  // Offered only when there is something in it: a developer whose every ticket is
  // planned does not need a bucket that reads zero.
  if (backlog.length > 0) {
    options.push({ selection: "backlog", label: "Backlog", count: backlog.length });
  }
  options.push({ selection: "all", label: "All tickets", count: candidates.length });
  return options;
}

/**
 * True for the option the current selection resolves to.
 *
 * Against the resolved selection rather than the stored value, so a selection
 * that fell back to everything highlights "All tickets" rather than nothing.
 */
export function isSelectedSprint(option: SprintOption, resolved: ResolvedSprint): boolean {
  if (option.selection === "all") return resolved.mode === "all";
  if (option.selection === "backlog") return resolved.mode === "backlog";
  if (option.selection === "active") return resolved.mode === "active";
  return resolved.mode === "sprint" && resolved.sprint?.id === option.selection;
}

/**
 * How far through a sprint we are, in the words a standup uses.
 *
 * Days rather than a percentage: "3 days left" is what changes a decision about
 * what to pick up, and it is the same phrase people say out loud.
 */
export function sprintTiming(sprint: SprintView): string | undefined {
  if (sprint.state === "closed") return "ended";
  const end = sprint.endDate ? new Date(sprint.endDate) : undefined;
  if (sprint.state === "future") {
    const start = sprint.startDate ? new Date(sprint.startDate) : undefined;
    const days = start ? daysFromNow(start) : undefined;
    return days == null ? "not started" : days <= 0 ? "starting" : `starts in ${days}d`;
  }
  const days = end ? daysFromNow(end) : undefined;
  if (days == null) return undefined;
  if (days < 0) return "overran";
  return days === 0 ? "ends today" : `${days}d left`;
}

/** Whole days from now, rounded up — a sprint ending tonight has "1 day left". */
function daysFromNow(date: Date): number | undefined {
  const ms = date.getTime() - Date.now();
  return Number.isFinite(ms) ? Math.ceil(ms / 86_400_000) : undefined;
}
