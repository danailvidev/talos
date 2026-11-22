/**
 * Pull request management, independent of any one forge.
 *
 * The platform already talks to GitLab, but "merge request" is GitLab's word for
 * something GitHub calls a pull request and Azure DevOps calls a pull request
 * too. The point of this file is that the application service, the API route and
 * the web UI never learn which of those answered: they hold a `PullRequest` and
 * a `PullRequestProvider`, and a second forge is a new
 * `PullRequestProviderFactory` in the registry rather than an edit to any of
 * them.
 *
 * Deliberately a *read* model. Merging, approving and commenting are the next
 * phase, and adding them here now would mean guessing at three forges' rules
 * for who may do what. The agent *actions* the detail view offers are not an
 * exception: those go through the job queue against a repository checkout, and
 * the only forge write they need — a push — belongs to git, not to this
 * interface.
 */
import type { Logger } from "../logging/logger.ts";
import type { SecretStore } from "../secrets/secret-store.ts";

/**
 * Whose pull requests to list.
 *
 * `team` is "everything else I can see", not a configured roster — a forge
 * already knows which projects a token can read, and asking an operator to
 * maintain a second list of them would go stale the first time somebody joined
 * a project.
 */
export type PullRequestScope = "mine" | "team";

/** Normalised lifecycle. `draft` is a distinct state, not a flag on `open`, because that is the distinction a reviewer cares about. */
export type PullRequestState = "open" | "draft" | "merged" | "closed";

/** Every state, in the order a filter UI should offer them: still-active work first. */
export const PULL_REQUEST_STATES = ["open", "draft", "merged", "closed"] as const;

/** What a listing shows when nobody has said otherwise — the work still in flight. */
export const DEFAULT_PULL_REQUEST_STATES: readonly PullRequestState[] = ["open", "draft"];

export function isPullRequestState(value: string): value is PullRequestState {
  return (PULL_REQUEST_STATES as readonly string[]).includes(value);
}

export interface PullRequestAuthor {
  username: string;
  name?: string;
  avatarUrl?: string;
}

export interface PullRequest {
  /** Which provider answered, e.g. `gitlab`. */
  provider: string;
  /**
   * Stable and provider-qualified, e.g. `gitlab:acme/webportal!6193`. Two
   * forges can both call a pull request #12, so the provider and repository
   * have to be part of the identity.
   */
  id: string;
  /** What the forge's UI calls it — GitLab's `iid`, GitHub's PR number. */
  number: number;
  title: string;
  state: PullRequestState;
  sourceBranch: string;
  targetBranch: string;
  webUrl: string;
  /** `group/project`, when the forge's listing carries it. */
  repository?: string;
  author?: PullRequestAuthor;
  createdAt?: Date;
  updatedAt: Date;
  /** True when a resolvable discussion is still open. Absent when the forge doesn't say. */
  hasUnresolvedThreads?: boolean;
  /** Markdown body, when the listing included one. Used to notice a name mention. */
  description?: string;
  /** People asked to review, when the listing included them. */
  reviewers?: PullRequestAuthor[];
}

export interface ListPullRequestsOptions {
  scope: PullRequestScope;
  /**
   * Which states to include. Defaults to `DEFAULT_PULL_REQUEST_STATES`.
   *
   * A set rather than a single state or an `includeClosed` flag, because the
   * combinations a reviewer wants are not a ladder: "open but not draft" and
   * "merged only" are both ordinary requests, and neither is expressible as a
   * point on a scale from open to closed.
   */
  states?: readonly PullRequestState[];
  /**
   * The developer's own Team MRs repository allow-list, forwarded so a
   * provider that has a cheap per-repository query can use it instead of a
   * broad "the whole team" fetch it would otherwise have to filter down —
   * see `GitLabPullRequestProvider`, where an unfiltered group fetch caps at
   * a page of the newest N merge requests *across the whole org*, which can
   * miss an older-but-still-open MR in one specific project entirely. The
   * application service still re-filters by this afterward regardless, so a
   * provider that ignores it is still correct, just less precise.
   */
  repositoryFilter?: readonly string[];
  limit?: number;
  signal?: AbortSignal;
}

/**
 * One pull request, addressed rather than listed.
 *
 * The provider-qualified `PullRequest.id` is a *display* identity — one opaque
 * string a URL and a React key can hold. This is the same thing taken apart,
 * which is what a second request needs. Kept as a pair of functions so the
 * format is defined once: a UI that round-trips an id through a route must get
 * back exactly what the provider produced.
 */
export interface PullRequestRef {
  provider: string;
  /** `group/project`. Required here, unlike on `PullRequest`: without it there is nothing to fetch. */
  repository: string;
  number: number;
}

export function pullRequestId(ref: PullRequestRef): string {
  return `${ref.provider}:${ref.repository}!${ref.number}`;
}

/**
 * The inverse of `pullRequestId`. Null for anything that is not one, which is
 * every hand-edited URL — so a caller validates by parsing rather than by
 * trusting a path segment.
 *
 * The provider name is taken up to the *first* colon and the number after the
 * *last* `!`, because the middle is a repository path that may legitimately
 * contain neither, either, or both.
 */
export function parsePullRequestId(id: string): PullRequestRef | null {
  const colon = id.indexOf(":");
  const bang = id.lastIndexOf("!");
  if (colon <= 0 || bang <= colon + 1) return null;
  const number = Number(id.slice(bang + 1));
  if (!Number.isInteger(number) || number <= 0) return null;
  return {
    provider: id.slice(0, colon),
    repository: id.slice(colon + 1, bang),
    number,
  };
}

/**
 * Whether a pull request can be merged as it stands.
 *
 * `unknown` is a first-class answer, not a failure to determine one: a forge
 * computes mergeability lazily, so a branch pushed seconds ago genuinely has no
 * verdict yet. Collapsing that into `clean` would offer "Address merge
 * conflicts" as *not needed* on a merge request nobody has checked.
 */
export type PullRequestMergeability = "clean" | "conflicts" | "unknown";

/** How many approvals a pull request has, and how many it still needs. */
export interface PullRequestApprovals {
  /** Absent when the forge will not say — approvals are a paid feature on GitLab. */
  required?: number;
  outstanding?: number;
  approvedBy: PullRequestAuthor[];
}

export interface PullRequestComment {
  id: string;
  author?: PullRequestAuthor;
  /** Markdown, as the author wrote it. Rendered by the client, never here. */
  body: string;
  createdAt: Date;
  /**
   * A note the forge wrote about itself ("changed target branch to main").
   * Carried rather than dropped so the conversation reads as a timeline, but
   * flagged so the UI can play it down and the open-thread count can ignore it.
   */
  system: boolean;
}

/**
 * One conversation. A standalone comment is a thread of one — modelling the two
 * separately would mean every consumer handling both shapes, and a forge can
 * turn the first into the second the moment somebody replies.
 */
export interface PullRequestThread {
  id: string;
  /** Whether this thread can be marked resolved at all. A plain comment cannot. */
  resolvable: boolean;
  resolved: boolean;
  /** Set when the thread hangs off one or more lines of the diff rather than the pull request as a whole. */
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
  comments: PullRequestComment[];
}

/**
 * One commit on the branch. Everything but the sha and subject line is optional:
 * these come straight off the forge's commit listing, and a self-managed instance
 * old enough not to report an author or a date should still list its commits.
 */
export interface PullRequestCommit {
  sha: string;
  title: string;
  url?: string;
  author?: string;
  committedAt?: string;
}

/** A tracker issue this pull request is about. */
export interface LinkedIssue {
  key: string;
  /** Absent when no tracker site is configured — the key is still worth showing. */
  url?: string;
}

/**
 * Everything the detail view shows, so a developer does not have to open the
 * forge. A superset of the list row rather than a parallel type: the list has
 * already been fetched by the time this arrives, and two shapes for one merge
 * request would mean reconciling them in the UI.
 */
export interface PullRequestDetail extends PullRequest {
  /** Markdown. Absent on a pull request opened from the command line. */
  description?: string;
  reviewers: PullRequestAuthor[];
  assignees: PullRequestAuthor[];
  approvals?: PullRequestApprovals;
  mergeability: PullRequestMergeability;
  /**
   * The forge's own wording for why it cannot be merged, when it cannot
   * (`conflict`, `not_approved`, …). Passed through verbatim rather than
   * translated: a forge adds values here between releases, and inventing our own
   * vocabulary would make a new one read as a bug.
   */
  mergeBlockedReason?: string;
  threads: PullRequestThread[];
  /**
   * Resolvable threads still open — precomputed because it is what the "Address
   * open comments" button is enabled by, and a client counting it would have to
   * re-derive "which comments count" identically.
   */
  openThreadCount: number;
  commits: PullRequestCommit[];
  /** GitLab pipelines associated with this merge request, newest first. */
  pipelines: {
    id: number;
    status: string;
    ref: string;
    sha: string;
    url: string;
    createdAt?: Date;
    updatedAt: Date;
  }[];
  /**
   * Recovered from the branch name, title or description rather than read from a
   * field: a GitLab↔Jira link is a naming convention here, not stored data.
   */
  issue?: LinkedIssue;
  /** Forge labels, verbatim — no colour, no grouping, just names for the sidebar. */
  labels: string[];
}

/** One file's diff, exactly as the forge's own "changes" view would show it. */
export interface PullRequestFileChange {
  path: string;
  /** Differs from `path` only on a rename. */
  previousPath?: string;
  status: "added" | "removed" | "renamed" | "modified";
  /**
   * Unified diff text for this file, absent when the forge refused to produce it
   * (`tooLarge`) — a binary asset or a generated lockfile. The client renders
   * the hunks; parsing them is not this layer's business.
   */
  diff?: string;
  tooLarge: boolean;
}

export interface PullRequestChanges {
  files: PullRequestFileChange[];
  /**
   * True when the forge's own pagination cut the list off. Said out loud so the
   * UI can tell "this is the whole diff" from "this is the first hundred files".
   */
  truncated: boolean;
}

export interface PullRequestFetchOptions {
  signal?: AbortSignal;
}

/** An image uploaded through a forge's Markdown editor. */
export interface PullRequestAsset {
  body: Uint8Array;
  contentType: string;
  filename: string;
}

/** One forge, already authenticated as whoever asked. */
export interface PullRequestProvider {
  readonly name: string;
  /** The forge account behind this provider's credentials, when the forge exposes it. */
  authenticatedUser?(options?: PullRequestFetchOptions): Promise<PullRequestAuthor>;
  list(options: ListPullRequestsOptions): Promise<PullRequest[]>;
  /**
   * One pull request in full. Throws if it does not exist or the token cannot see
   * it — unlike `list`, there is no partial answer worth rendering.
   */
  detail(ref: PullRequestRef, options?: PullRequestFetchOptions): Promise<PullRequestDetail>;
  /**
   * The diff, fetched separately from `detail` on purpose: it is by far the
   * largest part of the response and the Changes tab is not what the pane opens
   * on, so the common case never pays for it.
   */
  changes(ref: PullRequestRef, options?: PullRequestFetchOptions): Promise<PullRequestChanges>;
  /**
   * The same diff for a single commit on the branch, when the forge can narrow it.
   *
   * Optional because it is a nicety rather than the page: a forge that cannot
   * answer it still renders a Changes tab, just without the per-commit view. The
   * caller must have already checked that the sha belongs to this pull request —
   * a provider is free to read any commit the token can reach.
   */
  commitChanges?(
    ref: PullRequestRef,
    sha: string,
    options?: PullRequestFetchOptions,
  ): Promise<PullRequestChanges>;
  /**
   * Reads a forge-hosted image referenced by Markdown. Optional because not
   * every provider exposes authenticated uploads through its API.
   */
  asset?(
    ref: PullRequestRef,
    path: string,
    options?: PullRequestFetchOptions,
  ): Promise<PullRequestAsset>;
}

/**
 * How the platform discovers a provider without depending on it.
 *
 * `requiredSecrets` is declared rather than discovered by attempting a call:
 * "you have not stored a GitLab token yet" is an entirely different message
 * from "GitLab rejected your token", and a UI can only say the first if it is
 * told before the request goes out.
 */
export interface PullRequestProviderFactory {
  readonly name: string;
  /** Display name for the "token missing" notice. */
  readonly label: string;
  readonly requiredSecrets: readonly string[];
  create(deps: { secrets: SecretStore; logger?: Logger }): PullRequestProvider;
}

/** A provider that could not even be asked, and why. */
export interface UnavailableProvider {
  provider: string;
  label: string;
  missing: string[];
}

/** A provider that was asked and failed. Reported alongside whatever else succeeded. */
export interface FailedProvider {
  provider: string;
  label: string;
  message: string;
}

/**
 * The answer to one listing, partial failures included.
 *
 * Not a bare array and not a thrown error: with two forges configured, one
 * being down or unconfigured must not hide the other's pull requests, and the
 * UI still has to be able to explain the gap.
 */
export interface PullRequestListing {
  scope: PullRequestScope;
  /** The states actually applied, so the response explains itself. */
  states: PullRequestState[];
  /**
   * The repositories `team` was narrowed to by the developer's own settings.
   * Empty means unfiltered. Always empty for `mine` — the filter only ever
   * narrows other people's work, never hides the developer's own.
   */
  repositoryFilter: string[];
  pullRequests: PullRequest[];
  unavailable: UnavailableProvider[];
  failed: FailedProvider[];
}

/** Newest first — a pull request opened this morning is the one being asked about. */
export function byNewestFirst(a: PullRequest, b: PullRequest): number {
  const at = (a.createdAt ?? a.updatedAt).getTime();
  const bt = (b.createdAt ?? b.updatedAt).getTime();
  return bt - at;
}
