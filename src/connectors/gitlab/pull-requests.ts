/**
 * GitLab as a pull request provider.
 *
 * The only file in the codebase that knows a pull request is spelled "merge
 * request" over there. Everything above it — the application service, the API
 * route, the React page — holds the neutral `PullRequest` from
 * `application/pull-requests.ts`.
 */
import {
  byNewestFirst,
  DEFAULT_PULL_REQUEST_STATES,
  type ListPullRequestsOptions,
  type PullRequest,
  type PullRequestAsset,
  type PullRequestApprovals,
  type PullRequestAuthor,
  type PullRequestChanges,
  type PullRequestDetail,
  type PullRequestFetchOptions,
  type PullRequestFileChange,
  type PullRequestProvider,
  type PullRequestProviderFactory,
  type PullRequestRef,
  type PullRequestState,
  type PullRequestThread,
} from "../../application/pull-requests.ts";
import { extractJiraIssueKey } from "../jira/client.ts";
import { mapConcurrent } from "../../core/map-concurrent.ts";
import { ConnectorError, ValidationError } from "../../core/errors.ts";
import { createGitLabClient, type DraftFilter, type GitLabClient } from "./client.ts";
import {
  isDraftMergeRequest,
  mergeRequestConflictState,
  mergeRequestProjectPath,
  type GitLabUser,
  type MergeRequest,
  type MergeRequestApprovals,
  type MergeRequestDiff,
  type MergeRequestDiscussion,
} from "./types.ts";

/** Exactly what this provider needs from the client, so a test can pass a handful of functions. */
export type GitLabPullRequestGateway = Pick<
  GitLabClient,
  | "listMergeRequestsByScope"
  | "listMemberGroups"
  | "listGroupMergeRequests"
  | "listMergeRequests"
  | "currentUser"
  | "mergeRequest"
  | "mergeRequestApprovals"
  | "mergeRequestCommits"
  | "mergeRequestPipelines"
  | "mergeRequestDiffs"
  | "commitDiff"
  | "listMergeRequestDiscussions"
  | "markdownUpload"
>;

const DEFAULT_LIMIT = 50;
const DETAIL_PIPELINE_LIMIT = 20;

/**
 * How many of the user's groups the team tab will query.
 *
 * One request per group, in parallel, each a few seconds against a busy group.
 * Somebody who belongs to twenty organisations gets the first few rather than a
 * page that takes a minute to draw; in practice a developer has one or two.
 */
const MAX_GROUPS = 6;
const LIST_FANOUT_CONCURRENCY = 4;

export class GitLabPullRequestProvider implements PullRequestProvider {
  readonly name = "gitlab";

  constructor(private readonly gitlab: GitLabPullRequestGateway) {}

  async authenticatedUser(options: PullRequestFetchOptions = {}): Promise<PullRequestAuthor> {
    return toAuthor(await this.gitlab.currentUser(options.signal));
  }

  async asset(
    ref: PullRequestRef,
    path: string,
    options: PullRequestFetchOptions = {},
  ): Promise<PullRequestAsset> {
    const upload = parseMarkdownUploadPath(path);
    if (!upload) {
      throw new ValidationError("GitLab pull request images must use an /uploads/<secret>/<file> path.");
    }
    return this.gitlab.markdownUpload(
      ref.repository,
      upload.secret,
      upload.filename,
      options.signal,
    );
  }

  async list(options: ListPullRequestsOptions): Promise<PullRequest[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const queries = toGitLabQuery(options.states ?? DEFAULT_PULL_REQUEST_STATES);
    if (queries.length === 0) return [];

    if (options.scope === "mine") {
      // One request per GitLab state rather than `state=all` plus a local
      // filter: `all` on a busy account is mostly years of merged work, which
      // would push the open merge requests off the first page.
      const perState = await mapConcurrent(
        queries,
        LIST_FANOUT_CONCURRENCY,
        (query) =>
          this.gitlab.listMergeRequestsByScope({
            scope: "created_by_me",
            ...query,
            orderBy: "created_at",
            limit,
            signal: options.signal,
          }),
        options.signal,
      );
      return dedupe(perState.flat())
        .map((mr) => toPullRequest(mr, this.name))
        .sort(byNewestFirst)
        .slice(0, limit);
    }

    const me = await this.gitlab.currentUser(options.signal);
    const repositoryFilter = options.repositoryFilter ?? [];

    if (repositoryFilter.length > 0) {
      // Exact and complete, unlike the group fan-out below: that path caps at
      // the newest `limit` merge requests *across the whole organisation*, so
      // once narrowed to a specific project, an older-but-still-open MR there
      // can be pushed off the page entirely by newer activity elsewhere in the
      // org — which is exactly the undercount a developer would notice first
      // in the one repository they actually filtered down to. One request
      // per chosen project instead. A project this token cannot see (renamed,
      // removed, mistyped) 404s and is skipped rather than failing the whole
      // page over one stale entry in someone's settings.
      const requests = repositoryFilter.flatMap((repo) =>
        queries.map((query) => ({ repo, query })),
      );
      const perRepo = await mapConcurrent(
        requests,
        LIST_FANOUT_CONCURRENCY,
        async ({ repo, query }) => {
          try {
            return await this.gitlab.listMergeRequests(repo, {
              ...query, limit, signal: options.signal,
            });
          } catch (error) {
            if (error instanceof ConnectorError && error.status === 404) return [] as MergeRequest[];
            throw error;
          }
        },
        options.signal,
      );
      return dedupe(perRepo.flat())
        .filter((mr) => mr.author?.username !== me.username)
        .map((mr) => toPullRequest(mr, this.name))
        .sort(byNewestFirst)
        .slice(0, limit);
    }

    // Unfiltered: "the team" is the groups this person belongs to, which
    // GitLab already knows — so the tab works the moment a token exists, with
    // no group path for an operator to configure and keep up to date. A group
    // listing covers its subgroups, so the top-level ones are the whole
    // organisation.
    const groups = await this.gitlab.listMemberGroups({
      topLevelOnly: true,
      signal: options.signal,
    });

    const groupRequests = groups.slice(0, MAX_GROUPS).flatMap((group) =>
      queries.map((query) => ({ group: group.full_path, query })),
    );
    const perGroup = await mapConcurrent(
      groupRequests,
      LIST_FANOUT_CONCURRENCY,
      ({ group, query }) =>
          this.gitlab.listGroupMergeRequests(group, {
            ...query,
            orderBy: "created_at",
            limit,
            signal: options.signal,
          }),
      options.signal,
    );

    // The user's own merge requests already have their own tab; listing them
    // here too would make the team look busier than it is. Filtering after the
    // server-side cap can leave the tab with slightly fewer than `limit` rows,
    // which is a better trade than a `per_page` large enough to time out.
    return dedupe(perGroup.flat())
      .filter((mr) => mr.author?.username !== me.username)
      .map((mr) => toPullRequest(mr, this.name))
      // Each group answered its own newest-first; interleaving them is what
      // makes `limit` mean "the newest N across the team" rather than "all of
      // the first group and none of the second".
      .sort(byNewestFirst)
      .slice(0, limit);
  }

  async detail(
    ref: PullRequestRef,
    options: PullRequestFetchOptions = {},
  ): Promise<PullRequestDetail> {
    const { signal } = options;
    const mr = await this.gitlab.mergeRequest(ref.repository, ref.number, signal);

    // Fetched together because the pane renders as one thing: four sequential
    // round trips to gitlab.com would be a visible wait, and none of the four
    // depends on another's answer. Approvals already degrades to null on its
    // own (a paid feature); discussions and commits are load-bearing enough
    // that failing the request is the honest outcome.
    const [approvals, discussions, commits, pipelines] = await Promise.all([
      this.gitlab.mergeRequestApprovals(ref.repository, ref.number, signal),
      this.gitlab.listMergeRequestDiscussions(ref.repository, ref.number, {
        limit: MAX_THREADS,
        signal,
      }),
      this.gitlab.mergeRequestCommits(ref.repository, ref.number, signal),
      this.gitlab.mergeRequestPipelines(ref.repository, ref.number, {
        limit: DETAIL_PIPELINE_LIMIT,
        signal,
      }),
    ]);

    const threads = discussions.map(toThread);
    const issueKey = extractJiraIssueKey(
      mr.source_branch,
      mr.title,
      mr.description ?? undefined,
    );

    return {
      ...toPullRequest(mr, this.name),
      // The list row's id is built from whatever the listing carried; a detail
      // request was addressed by a ref that definitely has a repository, so
      // the ref wins and the id a client round-trips stays the one it sent.
      id: `${this.name}:${ref.repository}!${ref.number}`,
      repository: ref.repository,
      ...(mr.description?.trim() ? { description: mr.description } : {}),
      reviewers: (mr.reviewers ?? []).map(toAuthor),
      assignees: (mr.assignees ?? []).map(toAuthor),
      ...(approvals ? { approvals: toApprovals(approvals) } : {}),
      mergeability: mergeRequestConflictState(mr),
      ...(mr.detailed_merge_status && mr.detailed_merge_status !== "mergeable"
        ? { mergeBlockedReason: mr.detailed_merge_status }
        : {}),
      threads,
      openThreadCount: threads.filter((t) => t.resolvable && !t.resolved).length,
      commits: commits.map((commit) => {
        // `committed_date` first: a rebase — which is what half the actions on
        // this page do — rewrites when a commit landed on the branch but not when
        // it was written, and landing order is the order a reviewer reads in.
        const at = commit.committed_date ?? commit.authored_date;
        return {
          sha: commit.id,
          title: commit.title,
          ...(commit.web_url ? { url: commit.web_url } : {}),
          ...(commit.author_name ? { author: commit.author_name } : {}),
          ...(at ? { committedAt: at } : {}),
        };
      }),
      pipelines: pipelines.map((pipeline) => ({
        id: pipeline.id,
        status: pipeline.status,
        ref: pipeline.ref,
        sha: pipeline.sha,
        url: pipeline.web_url,
        ...(pipeline.created_at ? { createdAt: pipeline.created_at } : {}),
        updatedAt: pipeline.updated_at,
      })),
      // No URL here: turning a key into a link needs the Jira site, which this
      // connector has no business knowing. The application service fills it in.
      ...(issueKey ? { issue: { key: issueKey } } : {}),
      labels: mr.labels ?? [],
    };
  }

  async changes(
    ref: PullRequestRef,
    options: PullRequestFetchOptions = {},
  ): Promise<PullRequestChanges> {
    const diffs = await this.gitlab.mergeRequestDiffs(
      ref.repository,
      ref.number,
      options.signal,
    );
    return {
      files: diffs.slice(0, MAX_DIFF_FILES).map(toFileChange),
      truncated: diffs.length > MAX_DIFF_FILES,
    };
  }

  /**
   * The same diff, narrowed to what one commit did.
   *
   * A repository read rather than a merge request one — GitLab has no
   * "this commit, within this MR" endpoint, and does not need one: a commit's
   * diff against its parent is the same hunks whichever branch is asking. The
   * caller is responsible for having established that the sha is on this merge
   * request; this method would happily diff any commit in the project.
   */
  async commitChanges(
    ref: PullRequestRef,
    sha: string,
    options: PullRequestFetchOptions = {},
  ): Promise<PullRequestChanges> {
    const diffs = await this.gitlab.commitDiff(ref.repository, sha, options.signal);
    return {
      files: diffs.slice(0, MAX_DIFF_FILES).map(toFileChange),
      truncated: diffs.length > MAX_DIFF_FILES,
    };
  }
}

function parseMarkdownUploadPath(
  path: string,
): { secret: string; filename: string } | undefined {
  const match = path.match(/^\/uploads\/([a-f0-9]{32})\/([^/?#]+)$/i);
  if (!match) return undefined;
  try {
    return { secret: match[1]!, filename: decodeURIComponent(match[2]!) };
  } catch {
    return undefined;
  }
}

/**
 * Threads fetched for one detail request.
 *
 * A merge request that has been argued over for a month can carry hundreds of
 * notes, most of them GitLab's own system notes, and the pane is not a place to
 * scroll a thousand of them. High enough that a normal review arrives whole.
 */
const MAX_THREADS = 200;

/**
 * Files rendered in the Changes tab. GitLab itself would answer for up to 2000;
 * a diff that wide is a dependency bump or a generated-file churn, and shipping
 * every hunk of it to the browser would cost more than reading it there.
 */
const MAX_DIFF_FILES = 300;

function toAuthor(user: GitLabUser): PullRequestAuthor {
  return {
    username: user.username,
    ...(user.name ? { name: user.name } : {}),
    ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}),
  };
}

function toApprovals(approvals: MergeRequestApprovals): PullRequestApprovals {
  return {
    ...(approvals.approvals_required != null
      ? { required: approvals.approvals_required }
      : {}),
    ...(approvals.approvals_left != null
      ? { outstanding: approvals.approvals_left }
      : {}),
    approvedBy: (approvals.approved_by ?? []).map((entry) => toAuthor(entry.user)),
  };
}

/**
 * One GitLab discussion as a neutral thread.
 *
 * `resolvable` and `resolved` live on the *notes* over there, not on the
 * discussion, and only the first note of a diff thread carries them — so both
 * are read from whichever note has an opinion rather than from `notes[0]`.
 */
export function toThread(discussion: MergeRequestDiscussion): PullRequestThread {
  const resolvable = discussion.notes.some((note) => note.resolvable === true);
  const anchored = discussion.notes.find((note) => note.position?.new_path ?? note.position?.old_path);
  const position = anchored?.position;
  const path = position?.new_path ?? position?.old_path;
  const oldLine = position?.old_line ?? undefined;
  const newLine = position?.new_line ?? undefined;
  const line = newLine ?? oldLine;
  const rangeStart = toRangePoint(position?.line_range?.start);
  const rangeEnd = toRangePoint(position?.line_range?.end);

  return {
    id: discussion.id,
    resolvable,
    // Every resolvable note in a thread flips together in GitLab's UI, but the
    // API can report a mixture mid-flight; unresolved wins, because showing an
    // open comment as settled is the failure that matters.
    resolved: resolvable && discussion.notes.every((note) => note.resolved !== false),
    ...(path
      ? {
          anchor: {
            path,
            ...(line != null ? { line } : {}),
            ...(oldLine != null ? { oldLine } : {}),
            ...(newLine != null ? { newLine } : {}),
            ...(rangeStart && rangeEnd
              ? { range: { start: rangeStart, end: rangeEnd } }
              : {}),
          },
        }
      : {}),
    comments: discussion.notes.map((note) => ({
      id: String(note.id),
      author: toAuthor(note.author),
      body: note.body,
      createdAt: note.created_at,
      system: note.system === true,
    })),
  };
}

function toRangePoint(
  point?: { old_line?: number | null; new_line?: number | null } | null,
): { oldLine?: number; newLine?: number } | undefined {
  if (!point) return undefined;
  const oldLine = point.old_line ?? undefined;
  const newLine = point.new_line ?? undefined;
  if (oldLine == null && newLine == null) return undefined;
  return {
    ...(oldLine != null ? { oldLine } : {}),
    ...(newLine != null ? { newLine } : {}),
  };
}

function toFileChange(diff: MergeRequestDiff): PullRequestFileChange {
  return {
    path: diff.new_path,
    ...(diff.renamed_file && diff.old_path !== diff.new_path
      ? { previousPath: diff.old_path }
      : {}),
    status: diff.new_file
      ? "added"
      : diff.deleted_file
        ? "removed"
        : diff.renamed_file
          ? "renamed"
          : "modified",
    ...(diff.diff ? { diff: diff.diff } : {}),
    tooLarge: diff.too_large === true,
  };
}

/**
 * How far back finished work is fetched from.
 *
 * Required, not tuning: gitlab.com answers `state=merged` across a group with
 * 408 Request Timeout at every page size down to 10, and in ~1.5s once bounded
 * by `created_after`. Ninety days is also roughly the honest answer to "what did
 * we merge lately" — a merge request from two years ago is history, not a list a
 * reviewer scrolls.
 *
 * Open and draft listings are deliberately *not* bounded: those sets are small,
 * and cutting them off would hide the long-running merge request that most needs
 * looking at.
 */
const HISTORY_WINDOW_DAYS = 90;

/** One GitLab merge request query: a `state`, plus what to do with drafts within it. */
interface MergeRequestQuery {
  state: "opened" | "merged" | "closed";
  drafts: DraftFilter;
  createdAfter?: Date;
}

/**
 * The neutral state set, as GitLab has to be asked for it.
 *
 * The shapes do not line up: GitLab's `state` takes one value per request and
 * has no `draft` — draft is a flag on an *opened* merge request, queried through
 * `wip`. So "open + merged" becomes two requests, while "draft only" becomes one
 * request for `opened` narrowed to WIP.
 *
 * Drafts are only ever filtered on the `opened` query. A merged or closed merge
 * request is not a draft in this model (`toState` checks the lifecycle before the
 * draft flag), and an abandoned draft that somebody closed is an ordinary closed
 * merge request — narrowing those queries by `wip` would hide it.
 *
 * `locked` is folded into `closed` by `toState`, but not queried: it is the
 * transient state of a merge in progress, and asking for it would add a request
 * per group to catch a row that is about to be `merged` anyway.
 */
function toGitLabQuery(states: readonly PullRequestState[]): MergeRequestQuery[] {
  const wantOpen = states.includes("open");
  const wantDraft = states.includes("draft");

  const queries: MergeRequestQuery[] = [];
  if (wantOpen || wantDraft) {
    queries.push({
      state: "opened",
      drafts: wantOpen && wantDraft ? "include" : wantDraft ? "only" : "exclude",
    });
  }
  const createdAfter = new Date(Date.now() - HISTORY_WINDOW_DAYS * 86_400_000);
  if (states.includes("merged")) {
    queries.push({ state: "merged", drafts: "include", createdAfter });
  }
  if (states.includes("closed")) {
    queries.push({ state: "closed", drafts: "include", createdAfter });
  }

  return queries;
}

/**
 * By GitLab's global id. The same merge request can arrive twice — two of the
 * user's groups sharing a moved project, or a `wip=yes` and `wip=no` query
 * overlapping — and a duplicate would render twice under one React key.
 */
function dedupe(mrs: MergeRequest[]): MergeRequest[] {
  const seen = new Set<number>();
  return mrs.filter((mr) => !seen.has(mr.id) && (seen.add(mr.id), true));
}

function toPullRequest(mr: MergeRequest, provider: string): PullRequest {
  const repository = mergeRequestProjectPath(mr);
  return {
    provider,
    id: `${provider}:${repository ?? mr.project_id}!${mr.iid}`,
    number: mr.iid,
    title: mr.title,
    state: toState(mr),
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    webUrl: mr.web_url,
    ...(repository ? { repository } : {}),
    ...(mr.author
      ? {
          author: {
            username: mr.author.username,
            ...(mr.author.name ? { name: mr.author.name } : {}),
            ...(mr.author.avatar_url ? { avatarUrl: mr.author.avatar_url } : {}),
          },
        }
      : {}),
    ...(mr.created_at ? { createdAt: mr.created_at } : {}),
    updatedAt: mr.updated_at,
    ...(mr.blocking_discussions_resolved === false ? { hasUnresolvedThreads: true } : {}),
    ...(mr.description ? { description: mr.description } : {}),
    ...(mr.reviewers?.length ? { reviewers: mr.reviewers.map(toAuthor) } : {}),
  };
}

function toState(mr: MergeRequest): PullRequestState {
  if (mr.state === "merged") return "merged";
  // `locked` is a closed merge request mid-merge, not a fifth thing a reviewer
  // can act on.
  if (mr.state === "closed" || mr.state === "locked") return "closed";
  return isDraftMergeRequest(mr) ? "draft" : "open";
}

export const gitlabPullRequestProvider: PullRequestProviderFactory = {
  name: "gitlab",
  label: "GitLab",
  requiredSecrets: ["GITLAB_TOKEN"],
  create: ({ secrets, logger }) =>
    new GitLabPullRequestProvider(createGitLabClient(secrets, { logger })),
};
