import type { TtlCache } from "../core/ttl-cache.ts";

/**
 * Who a cached answer belongs to.
 *
 * There is no default, and that is the whole design. Every forge-backed read in
 * this API is answered with the *caller's* credentials and narrowed by the
 * caller's own repo filter — `routePullRequests` says it outright: "my merge
 * requests" has no meaning under a shared bot token. A cache key that forgets the
 * user therefore turns "my merge requests" into "whoever asked first's merge
 * requests", and leaks the private repositories user A can see and user B cannot.
 *
 * That failure is silent, invisible in single-user testing, and confidentiality-
 * grade. So `"shared"` has to be written out at the call site as a claim somebody
 * can disagree with in review, rather than being what you get by forgetting.
 */
export type CacheScope = { userId: string } | "shared";

export interface CacheSpec {
  /**
   * The resource, first in the composed key so `invalidate("pull-requests|")`
   * reaches every user's copy. Scope-first ordering would make resource-level
   * invalidation a full scan.
   */
  resource: string;
  scope: CacheScope;
  /**
   * Everything else that changes the answer — path segments, query parameters,
   * and anything credential-adjacent that is *not* in the URL. The Team MRs repo
   * filter is the example that matters: it is stored per user and read
   * server-side, so it never appears in the request, and leaving it out of the
   * key means one developer's narrowed listing is served to another whose filter
   * happens to differ.
   */
  params?: readonly (string | number | boolean)[];
  ttlMs: number;
}

/**
 * How long each cached read is served for, and why that number.
 *
 * The unit here is not latency — it is somebody's forge rate limit. So the
 * question behind each figure is "how long is it acceptable for this to be behind
 * the forge, given that a refresh button bypasses it entirely", not "how fast can
 * we make the page".
 *
 * Nothing that answers from SQLite is in this table. `/api/tasks`,
 * `/api/notifications`, the three triage lists, the pull request job-queue routes,
 * settings and prompts are all synchronous `bun:sqlite` reads measured in
 * microseconds; their cost is query *count*, not latency, and a TTL there would
 * buy staleness for nothing.
 */
export const CACHE_TTL = {
  /** The worst fan-out in the API: one GitLab call per state, or per repository. */
  pullRequests: 60_000,
  /** Four GitLab calls per merge request opened. Also authorizes `/runs`. */
  pullRequestDetail: 30_000,
  /**
   * The largest response in the product. Long because it is keyed by head sha,
   * which makes the value immutable rather than merely stale — a new commit is a
   * new key, so ten minutes costs no staleness at all.
   */
  pullRequestChanges: 10 * 60_000,
  /** A `listTree` plus one `getFileRaw` per environment; changes when an MR merges. */
  releases: 120_000,
  /**
   * The heaviest read on the releases page: a commit listing plus one diff per
   * commit in the window. Longer than the manifest itself because history is
   * append-only — everything already in it is immutable, so the only thing a
   * shorter TTL would buy is seeing the newest release a few minutes sooner, and
   * the refresh button already bypasses this.
   */
  releaseHistory: 5 * 60_000,
  /** Two 50-row forge listings per debounced keystroke. */
  search: 15_000,
  /** A group's project list barely changes, and the Add-task panel reads it on open. */
  gitlabProjects: 10 * 60_000,
  /** Autocompletes: typing back over a term you just typed should be free. */
  gitlabBranches: 60_000,
  gitlabMergeRequests: 60_000,
  /** One project-level count shown on the Automation failure inbox. */
  automationOpenMergeRequests: 60_000,
  jiraIssues: 60_000,
  /**
   * Project-assignable people change rarely, while opening either Jira settings
   * form otherwise repeats a relatively expensive directory lookup.
   */
  jiraUsers: 3 * 24 * 60 * 60_000,
  /**
   * The two outbound reads inside the ticket graph, *not* the graph payload.
   * The console polls that endpoint every three seconds specifically to watch job
   * state flip, and the overlay it is watching is assembled from SQLite — so a TTL
   * on the whole response would make the feature the poll exists for arrive late.
   * Caching only the Jira search and the merge request listing means a three-second
   * poll costs zero forge calls nine ticks in ten and the overlay stays instant.
   */
  graphSources: 30_000,
  /**
   * One ticket in full: two Jira calls, made when a developer clicks a ticket
   * node. Short because the panel is what you read *while* triaging — a comment
   * you just posted from Jira should be there when you look back — and because a
   * click on a ticket already open costs nothing at all.
   */
  ticketDetail: 20_000,
  /** One widget query. The refresh button bypasses it. */
  dashboardQuery: 60_000,
} as const;

/** `|` because it appears in no GitLab path, Jira key, user id or state name. */
const SEPARATOR = "|";

/**
 * The composed key. Exported for the invalidation helpers and for tests that
 * assert two callers do not collide — not something a route should build itself.
 */
export function cacheKey(spec: Pick<CacheSpec, "resource" | "scope" | "params">): string {
  const scope = spec.scope === "shared" ? "shared" : `user:${spec.scope.userId}`;
  return [spec.resource, scope, ...(spec.params ?? []).map(String)].join(SEPARATOR);
}

/** Everything under one resource, whoever it belongs to. */
export function resourcePrefix(resource: string): string {
  return `${resource}${SEPARATOR}`;
}

/**
 * The only way a route reads through the response cache.
 *
 * Keeping it to one function is what makes the scope requirement enforceable:
 * `scripts/check-boundaries.ts` refuses a direct `app.responseCache.fetch(`
 * anywhere but here, so "did this key include the user?" is a question about one
 * file rather than about twenty routes.
 *
 * `bypass` is the refresh button. Both of this app's refresh buttons promise the
 * latest state of the forge, and after this cache exists that promise crosses two
 * layers — so a request that says `Cache-Control: no-store` drops the key and
 * reloads. Without it the caching becomes a bug report the first time somebody
 * clicks refresh and sees the same data.
 */
export function cached<T>(
  cache: TtlCache,
  spec: CacheSpec,
  load: () => Promise<T>,
  options: { bypass?: boolean } = {},
): Promise<T> {
  const key = cacheKey(spec);
  return options.bypass
    ? cache.refresh(key, spec.ttlMs, load)
    : cache.fetch(key, spec.ttlMs, load);
}

/**
 * Whether this request asked to skip the cache.
 *
 * `no-store` rather than `no-cache`: browsers send `no-cache` on their own during
 * a hard reload, and honouring that would be fine, but `fetch()` also sends
 * `cache: "no-store"` for anything the client marked uncacheable. Reading only
 * `no-store` keeps the bypass something the console asks for deliberately.
 */
export function wantsFreshData(request: Request): boolean {
  return (request.headers.get("cache-control") ?? "").includes("no-store");
}
