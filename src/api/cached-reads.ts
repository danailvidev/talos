import type { App } from "../app.ts";
import type { AuthUser } from "../auth.ts";
import type { AssignedTicketResult } from "../application/assigned-tickets.ts";
import type {
  PullRequestDetail,
  PullRequestListing,
  PullRequestScope,
  PullRequestState,
} from "../application/pull-requests.ts";
import type { TicketDetailResult } from "../application/ticket-detail.ts";
import { CACHE_TTL, cached, resourcePrefix } from "./cached.ts";

/**
 * The forge reads more than one route makes, wrapped once each.
 *
 * Its own module because the alternative was worse: the ticket graph and the
 * global search both re-make reads the pull requests page already makes, and if
 * each composed its own cache key they would miss each other's entries — the same
 * GitLab listing paid for two or three times because two call sites spelled a key
 * slightly differently. One function per read means the key is a property of the
 * read rather than of whoever happens to want it.
 *
 * Everything here is scoped to the asking user, and none of it is optional: see
 * `CacheScope` for what an unscoped key here would leak.
 */

/** How long to serve one entry, when the caller wants to say so explicitly. */
export interface CachedReadOptions {
  /** From `wantsFreshData(request)` — the refresh button's promise to reach the forge. */
  bypass?: boolean;
}

/**
 * One scope's merge request listing, as the caller sees it.
 *
 * The repo filter is in the key even though it is nowhere in the URL: it is stored
 * per user, applied server-side, and it changes the answer. Two developers with
 * different filters must not share an entry — that is the leak, one layer below the
 * user id that is already there.
 *
 * Note what is *not* cached: `toPullRequestsView` merges a live job-queue read over
 * this to draw each row's "an agent is working on this" badge. Caching the
 * assembled response would freeze that badge for a minute, which is the opposite of
 * why `/api/pull-requests/active-actions` exists. The cached value is always the
 * expensive outbound result, never the response.
 *
 * No `signal`, deliberately, even though `PullRequestApplicationService.list`
 * accepts one and the ticket graph threads it: an entry is shared, and one caller
 * navigating away must not abort a listing two other pollers are awaiting. The
 * cancellation was there to stop paying for a fan-out nobody is waiting for, and
 * a cache hit does not pay for it in the first place.
 */
export function cachedPullRequestListing(
  app: App,
  user: AuthUser,
  scope: PullRequestScope,
  query: { states?: PullRequestState[]; limit?: number } = {},
  options: CachedReadOptions = {},
): Promise<PullRequestListing> {
  return cached(
    app.responseCache,
    {
      resource: "pull-requests",
      scope: { userId: user.id },
      params: [
        scope,
        (query.states ?? []).join(","),
        query.limit ?? "",
        app.pullRequestRepoFilters.list(user.id).join(","),
      ],
      ttlMs: CACHE_TTL.pullRequests,
    },
    () =>
      app.pullRequests.list(user, scope, {
        ...(query.states ? { states: query.states } : {}),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      }),
    options,
  );
}

/**
 * Jira tickets in one board scope, the ticket graph's other network read.
 *
 * Same reasoning as the listing above and the same reason the graph payload itself
 * stays uncached: the console polls `/api/graph/tickets` every three seconds to
 * watch job state flip, and that overlay is assembled from SQLite. Caching these
 * two reads makes nine ticks in ten cost no forge calls while leaving the thing the
 * poll exists for instant.
 */
export function cachedBoardTickets(
  app: App,
  user: AuthUser,
  scope: "mine" | "team" = "mine",
  options: CachedReadOptions = {},
): Promise<AssignedTicketResult> {
  return cached(
    app.responseCache,
    {
      resource: "assigned-tickets",
      scope: { userId: user.id },
      // Team drops Jira's current-user assignee clause, so it must never reuse a
      // personal result (or vice versa).
      params: [scope],
      ttlMs: CACHE_TTL.graphSources,
    },
    () => app.assignedTickets.list(user, { scope }),
    options,
  );
}

/**
 * One Jira ticket in full — the ticket panel's read.
 *
 * Scoped to the user like everything else here, and for a sharper reason than
 * usual: the ticket is fetched with *their* Jira token, so a shared entry would
 * hand one developer a ticket their own account cannot browse.
 *
 * Cached even though it is only fetched on a click, because a click is not one
 * fetch: React Query remounts the panel whenever the graph's three-second poll
 * replaces the selected node, and selecting back and forth between two tickets is
 * the normal way to read a board.
 */
export function cachedTicketDetail(
  app: App,
  user: AuthUser,
  issueKey: string,
  options: CachedReadOptions = {},
): Promise<TicketDetailResult> {
  return cached(
    app.responseCache,
    {
      resource: "ticket-detail",
      scope: { userId: user.id },
      params: [issueKey],
      ttlMs: CACHE_TTL.ticketDetail,
    },
    () => app.ticketDetails.get(user, issueKey),
    options,
  );
}

/**
 * One merge request in full, as the caller sees it.
 *
 * Shared by three readers of the same four GitLab calls: the detail pane, the head
 * revision the changes cache is keyed on, and the authorization check on `/runs`.
 * One entry rather than three means opening a merge request and paging through its
 * history costs one forge read, not one per request.
 *
 * Deliberately *not* used by `POST /api/pull-requests/:id/actions`. That route's
 * `detail()` call is the authorization standing between a logged-in user and an
 * agent force-pushing to any project path they can name in a URL, and it also
 * re-checks that the action still applies. Serving it from a cache would honour a
 * revoked access — or a conflict since resolved — for up to thirty seconds, on a
 * write. Read routes only.
 */
export function cachedPullRequestDetail(
  app: App,
  user: AuthUser,
  id: string,
  options: CachedReadOptions = {},
): Promise<PullRequestDetail> {
  return cached(
    app.responseCache,
    {
      resource: "pull-request-detail",
      scope: { userId: user.id },
      params: [id],
      ttlMs: CACHE_TTL.pullRequestDetail,
    },
    () => app.pullRequests.detail(user, id),
    options,
  );
}

/**
 * Every user's copy of one resource, for the writes and the webhook that make one
 * stale for everybody rather than for whoever happened to trigger it.
 *
 * Only the ones something actually invalidates. `pull-request-changes` is
 * absent on purpose and not by omission: it is keyed by the head commit set, so a
 * push produces a different key rather than a stale entry, and there is nothing for
 * an invalidation to reach.
 */
export const CACHE_PREFIX = {
  pullRequests: resourcePrefix("pull-requests"),
  pullRequestDetail: resourcePrefix("pull-request-detail"),
  releases: resourcePrefix("releases"),
  releaseHistory: resourcePrefix("release-history"),
} as const;
