/**
 * The header's global search: tickets and merge requests, and deliberately
 * nothing else.
 *
 * It used to answer with three kinds of thing — loops, filed issues, merge
 * requests — each matched a different way and each landing somewhere different
 * when clicked. Two of those were never what anybody typed into it: a loop is
 * found on the Loops page, and a filed issue is an internal row keyed by spec
 * path, not a thing with a name. So this searches the two nouns a developer
 * actually looks for by name, and both come from reads the console has already
 * paid for:
 *
 *  - tickets: the caller's Jira board, via `cachedBoardTickets` — the same
 *    set the ticket board draws, which is why every hit has somewhere to open.
 *  - merge requests: their `mine` and `team` listings, via
 *    `cachedPullRequestListing`.
 *
 * Nothing here calls a forge with the typed text in it. That is the whole
 * performance story: the needle is not in any cache key because it is not in any
 * request either, so the second keystroke costs nothing and a search run while
 * the board or the Pull requests page is open costs nothing at all.
 */
import type * as ApiContract from "../../shared/api-contract.ts";
import type { App } from "../app.ts";
import type { AuthUser } from "../auth.ts";
import type { AssignedTicket } from "../application/assigned-tickets.ts";
import type { PullRequest } from "../application/pull-requests.ts";
import { cachedBoardTickets, cachedPullRequestListing } from "./cached-reads.ts";
import { activePullRequestActions } from "./pull-request-actions.ts";
import { toPullRequestView, type PullRequestView } from "./views.ts";

/** A Jira ticket as a search hit: enough to recognise it, not enough to render a panel. */
export interface SearchTicketView {
  key: string;
  summary?: string;
  status?: string;
  statusCategory?: string;
  type?: string;
  url: string;
}

export interface SearchResultView {
  tickets: SearchTicketView[];
  pullRequests: PullRequestView[];
}

/** Hits per group. A popover, not a results page — more rows than this is a filter's job. */
const GROUP_LIMIT = 6;

/**
 * How deep each merge request scope is read for searching, and why the two
 * numbers differ.
 *
 * `mine` is read four times deeper than the Pull requests page asks for. A search
 * that can only find what is already on the first page of a listing fails exactly
 * when it is needed — when the merge request is too old to be in front of you —
 * and depth is nearly free here: GitLab answers "created by me" per state, so 200
 * of your own merge requests cost about what 50 do (measured: ~0.5s either way).
 * The price is a cache entry of its own, not shared with that page's 50.
 *
 * `team` stays at the page's 50 for the opposite reason. "The team" has no query;
 * it is a fan-out across every group this token belongs to, so depth multiplies
 * pages by groups — 50 rows took ~3s against a real instance and 200 took ~9s,
 * on a read that would then no longer share the Pull requests page's entry
 * either. Six seconds and a doubled GitLab bill is not worth reaching the 150th
 * merge request of somebody else's week, which is what the Pull requests page's
 * own filters are for.
 */
const MINE_DEPTH = 200;
const TEAM_DEPTH = 50;

export async function toSearchResult(
  app: App,
  user: AuthUser,
  query: string,
  access: { tickets: boolean; pullRequests: boolean } = {
    tickets: true,
    pullRequests: true,
  },
): Promise<SearchResultView> {
  const needle = query.trim().toLowerCase();

  const [tickets, pullRequests] = await Promise.all([
    access.tickets ? searchTickets(app, user, needle) : Promise.resolve([]),
    access.pullRequests ? searchPullRequests(app, user, needle) : Promise.resolve([]),
  ]);
  // An empty query matches nothing — `score` says so — but it is not pointless:
  // it is the warm-up the console fires when the box is first focused, and its
  // whole job is to have populated the two cache entries above by the time
  // somebody has finished typing. See `queries.searchWarmup`.
  return { tickets, pullRequests };
}

/**
 * How well a haystack matches, or nothing when it does not match at all.
 *
 * Ranked rather than merely filtered because the two things being searched both
 * have a short identifier and a long title, and a substring hit in a title is
 * never what someone typing `TP-3018` meant. Lower is better, so the identifier
 * beats the title and a prefix beats a hit in the middle.
 */
function score(needle: string, identifier: string, title: string | undefined): number | undefined {
  // Nothing matches nothing: without this, the warm-up's empty query would rank
  // every row a prefix hit and answer with an arbitrary six.
  if (!needle) return undefined;

  const id = identifier.toLowerCase();
  // Punctuation-blind, so `tp3018` and `3018` both find `TP-3018` — a partly
  // typed key is the single most common thing this box receives.
  const bareId = id.replace(/[^a-z0-9]/g, "");
  const bareNeedle = needle.replace(/[^a-z0-9]/g, "");

  if (id === needle || bareId === bareNeedle) return 0;
  if (bareId.startsWith(bareNeedle)) return 1;
  if (bareId.includes(bareNeedle)) return 2;

  const text = (title ?? "").toLowerCase();
  if (text.startsWith(needle)) return 3;
  if (text.includes(needle)) return 4;
  return undefined;
}

/**
 * Ranks by `score` and keeps the best `GROUP_LIMIT`, with ties broken by the
 * order the caller passed — which is each source's own newest-first order, so
 * two equally good matches come back most-recent first.
 */
function bestMatches<T>(
  items: readonly T[],
  scoreOf: (item: T) => number | undefined,
): T[] {
  return items
    .map((item, index) => ({ item, index, rank: scoreOf(item) }))
    .filter((row): row is { item: T; index: number; rank: number } => row.rank !== undefined)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, GROUP_LIMIT)
    .map((row) => row.item);
}

/**
 * The caller's board, matched on key and summary.
 *
 * Read through the same cache entry the ticket board polls, so searching while
 * that page is open is free, and searching before it has ever been opened costs
 * the one Jira read that page would have cost anyway.
 *
 * Only tickets on the board, which is also what keeps the click honest: every hit
 * is a ticket `/jira/:spaceKey?ticket=KEY` can open, because it is the same set that page
 * draws. A ticket assigned to nobody on the team is not findable here — see the
 * ticket board's own search for narrowing what is already on screen.
 */
async function searchTickets(
  app: App,
  user: AuthUser,
  needle: string,
): Promise<SearchTicketView[]> {
  const { tickets } = await cachedBoardTickets(app, user);
  return bestMatches(tickets, (ticket) => score(needle, ticket.key, ticket.summary)).map(
    toSearchTicketView,
  );
}

function toSearchTicketView(ticket: AssignedTicket): SearchTicketView {
  return {
    key: ticket.key,
    ...(ticket.summary ? { summary: ticket.summary } : {}),
    ...(ticket.status ? { status: ticket.status } : {}),
    ...(ticket.statusCategory ? { statusCategory: ticket.statusCategory } : {}),
    ...(ticket.type ? { type: ticket.type } : {}),
    url: ticket.url,
  };
}

/**
 * Merge requests, matched on number, title and repository.
 *
 * Both scopes are read because "team" excludes the asker's own merge requests —
 * a search that skipped `mine` would miss exactly the ones their author is most
 * likely to be looking for. Asked in parallel, deduped by id, and the `mine`
 * copy wins the tie because it is listed first.
 */
async function searchPullRequests(
  app: App,
  user: AuthUser,
  needle: string,
): Promise<PullRequestView[]> {
  const [mine, team] = await Promise.all([
    cachedPullRequestListing(app, user, "mine", { limit: MINE_DEPTH }),
    cachedPullRequestListing(app, user, "team", { limit: TEAM_DEPTH }),
  ]);

  const seen = new Set<string>();
  const unique = [...mine.pullRequests, ...team.pullRequests].filter((pr) =>
    seen.has(pr.id) ? false : (seen.add(pr.id), true),
  );

  const active = activePullRequestActions(app);
  return bestMatches(unique, (pr) => score(needle, `!${pr.number}`, titleOf(pr))).map((pr) =>
    toPullRequestView(pr, active),
  );
}

/** Title and repository as one haystack, so `webportal auth` finds a repo's MR by both. */
function titleOf(pr: PullRequest): string {
  return pr.repository ? `${pr.title} ${pr.repository}` : pr.title;
}

// Compile-time wire-contract checks, as in `views.ts`: the browser imports the
// shared contract directly, so a DTO that drifts here fails typecheck.
type ContractCheck<T extends U, U> = T;
type _SearchTicketContract = ContractCheck<SearchTicketView, ApiContract.SearchTicket>;
type _SearchContract = ContractCheck<SearchResultView, ApiContract.SearchResult>;
