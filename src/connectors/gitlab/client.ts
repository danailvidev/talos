import { z } from "zod";
import { ConfigError, ConnectorError } from "../../core/errors.ts";
import type { Logger } from "../../logging/logger.ts";
import type { SecretStore } from "../../secrets/secret-store.ts";
import { report, runCheck, type Connector, type HealthReport } from "../connector.ts";
import { HttpClient, type FetchLike } from "../http.ts";
import {
  BranchListSchema,
  CommitSchema,
  FileDiffListSchema,
  RepositoryCommitListSchema,
  TreeEntryListSchema,
  FAILED_PIPELINE_STATUS,
  GitLabGroupListSchema,
  GitLabProjectListSchema,
  GitLabProjectSchema,
  GitLabUserSchema,
  JobSchema,
  JobListSchema,
  MergeRequestApprovalsSchema,
  MergeRequestCommitListSchema,
  MergeRequestDiscussionListSchema,
  MergeRequestDiscussionNoteSchema,
  MergeRequestDiffListSchema,
  MergeRequestListSchema,
  MergeRequestNoteSchema,
  MergeRequestSchema,
  isDraftMergeRequest,
  PipelineDetailSchema,
  PipelineListSchema,
  PipelineScheduleDetailSchema,
  PipelineScheduleListSchema,
  PipelineTestReportSchema,
  PipelineTestReportSummarySchema,
  type Branch,
  type Commit,
  type FileDiff,
  type RepositoryCommit,
  type TreeEntry,
  type GitLabGroup,
  type GitLabProject,
  type GitLabUser,
  type Job,
  type JobTrace,
  type MergeRequest,
  type MergeRequestApprovals,
  type MergeRequestCommit,
  type MergeRequestDiscussion,
  type MergeRequestDiscussionNote,
  type MergeRequestDiff,
  type MergeRequestNote,
  type Pipeline,
  type PipelineDetail,
  type PipelineSchedule,
  type PipelineScheduleDetail,
  type PipelineTestReport,
  type PipelineTestReportSummary,
} from "./types.ts";

export const GITLAB_API_URL = "https://gitlab.com/api/v4";

/** Per-job trace cap. Traces reach tens of megabytes; this bounds them early. */
export const DEFAULT_MAX_TRACE_BYTES = 1_048_576;
/** Screenshots should be viewable without allowing an unbounded proxy response. */
export const MAX_GITLAB_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_MARKDOWN_UPLOAD_BYTES = MAX_GITLAB_IMAGE_BYTES;

export interface GitLabMarkdownUpload {
  body: Uint8Array;
  contentType: string;
  filename: string;
}

export interface GitLabArtifactFile {
  body: Uint8Array;
  contentType: string;
  filename: string;
}

/** GitLab's page cap is 100. Asking for more is silently reduced. */
const PAGE_SIZE = 100;

/**
 * Refuses to walk forever if `updated_after` is wrong or the watermark was lost.
 * A run that would need more pages than this has a bug upstream, and paging on
 * regardless would mean thousands of pipelines in one poll.
 */
const MAX_PAGES = 20;

/**
 * What to do with drafts on a merge request listing.
 *
 * Three states rather than a boolean because "drafts only" is a real question —
 * a reviewer filtering for work in progress — and is not the negation of
 * "no drafts" on a list that also contains merged and closed rows.
 */
export type DraftFilter = "include" | "exclude" | "only";

/** GitLab's server-side draft filter. `include` asks for nothing, which is its default. */
function draftQuery(drafts: DraftFilter): Record<string, string> {
  if (drafts === "exclude") return { wip: "no" };
  if (drafts === "only") return { wip: "yes" };
  return {};
}

/**
 * Applied on top of `draftQuery`, not instead of it: a `Draft:` title prefix
 * alone does not set GitLab's `wip` flag on older payloads, so the server-side
 * filter narrows the query and this one makes the answer exact.
 */
function filterDrafts(mrs: MergeRequest[], drafts: DraftFilter): MergeRequest[] {
  if (drafts === "include") return mrs;
  const wantDraft = drafts === "only";
  return mrs.filter((mr) => isDraftMergeRequest(mr) === wantDraft);
}

export interface GitLabClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: FetchLike;
  logger?: Logger;
  timeoutMs?: number;
  priority?: "interactive" | "background";
}

export interface ListPipelinesOptions {
  /** Numeric id or URL-encodable `group/project` path. */
  project: string | number;
  /** Watermark. Passed to GitLab as `updated_after` rather than filtered here. */
  updatedAfter?: Date;
  /** Optional branch filter. */
  ref?: string;
  status?: string;
  /**
   * Pipeline source, e.g. `schedule` or `push`. Filtered server-side.
   *
   * Narrowing to `schedule` before `name` matters: it turns a client-side scan
   * of every push pipeline into a query that returns only candidates.
   */
  source?: string;
  /**
   * Exact `workflow:name:` value, applied client-side — GitLab has no `name`
   * query parameter, which is why `limit` counts matches rather than rows
   * fetched.
   *
   * Usually the wrong tool: the field is null unless the project sets
   * `workflow:name:`, and it is *not* a scheduled pipeline's schedule
   * description. To target a schedule, use `scheduleDescription`.
   */
  name?: string;
  /**
   * Exact description of a pipeline schedule, as shown in the GitLab UI — e.g.
   * "Scheduled pipeline for webportal tests".
   *
   * Resolved to a schedule id and then queried through
   * `/pipeline_schedules/:id/pipelines`, so it returns that schedule's pipelines
   * and nothing else. Exact rather than substring, so a second schedule added
   * later cannot quietly widen the match — but trimmed on both sides, because a
   * trailing space in a schedule description is invisible in the UI and easy to
   * save by accident.
   */
  scheduleDescription?: string;
  /**
   * Hard cap on pipelines returned. Paging stops as soon as this is reached, so
   * a large window costs one request rather than twenty.
   */
  limit?: number;
  /**
   * Take the newest pipelines rather than the oldest when `limit` bites.
   *
   * The result is still returned oldest-first; only which end of the history the
   * cap keeps changes. Two callers want opposite things and the difference is not
   * cosmetic:
   *
   * - The watermark poller wants the oldest, so a capped run leaves the rest
   *   behind a watermark it has not yet advanced past.
   * - Anything answering "what just happened" wants the newest, or `--limit 10`
   *   on a five-year-old project reports 2019.
   */
  newestFirst?: boolean;
  signal?: AbortSignal;
}

export interface ListSchedulePipelinesOptions {
  /** All date bounds are passed through to GitLab and evaluated server-side. */
  updatedAfter?: Date;
  updatedBefore?: Date;
  createdAfter?: Date;
  createdBefore?: Date;
  status?: string;
  limit?: number;
  /** Fetch the newest matching pipelines while preserving oldest-first output. */
  newestFirst?: boolean;
  signal?: AbortSignal;
}

/**
 * GitLab.com REST v4, read-only.
 *
 * Every method takes the project explicitly rather than binding one at
 * construction: a single token serves several tasks, each with its own
 * project, and one client per task would multiply connections for nothing.
 */
export class GitLabClient implements Connector {
  readonly name = "gitlab";
  private readonly http: HttpClient;
  private readonly webHttp: HttpClient;

  constructor(options: GitLabClientOptions) {
    if (!options.token) {
      throw new ConfigError("GitLab client requires a token (GITLAB_TOKEN).");
    }

    const apiUrl = options.baseUrl ?? GITLAB_API_URL;
    this.http = new HttpClient({
      baseUrl: apiUrl,
      connector: "gitlab",
      fetch: options.fetch,
      logger: options.logger,
      timeoutMs: options.timeoutMs,
      priority: options.priority,
      // Header auth, never a query parameter: query strings end up in access
      // logs and error messages.
      headers: { "private-token": options.token },
    });
    this.webHttp = new HttpClient({
      baseUrl: apiUrl.replace(/\/api\/v4\/?$/, ""),
      connector: "gitlab",
      fetch: options.fetch,
      logger: options.logger,
      timeoutMs: options.timeoutMs,
      priority: options.priority,
      // Older GitLab versions expose Markdown uploads only through the web
      // project path. Bearer authentication works there where PRIVATE-TOKEN can
      // be limited to /api routes; sending both keeps self-managed variants
      // compatible without putting the token in the URL.
      headers: {
        authorization: `Bearer ${options.token}`,
        "private-token": options.token,
      },
    });
  }

  /** The token's own user. The cheapest proof that authentication works. */
  async currentUser(signal?: AbortSignal): Promise<GitLabUser> {
    const { data } = await this.http.getJson(GitLabUserSchema, "/user", { signal });
    return data;
  }

  /** Downloads one project Markdown upload through GitLab's authenticated API. */
  async markdownUpload(
    project: string | number,
    secret: string,
    filename: string,
    signal?: AbortSignal,
  ): Promise<GitLabMarkdownUpload> {
    const path =
      `/projects/${encodeProject(project)}/uploads/` +
      `${encodeURIComponent(secret)}/${encodeURIComponent(filename)}`;
    const request = {
      signal,
      accept: "image/*",
      maxBytes: MAX_GITLAB_IMAGE_BYTES,
    };
    let response;
    try {
      response = await this.http.request(path, request);
    } catch (error) {
      if (
        !(error instanceof ConnectorError) ||
        ![400, 404, 405].includes(error.status ?? 0) ||
        typeof project !== "string"
      ) {
        throw error;
      }
      response = await this.webHttp.request(
        `/${encodeProjectWebPath(project)}/uploads/` +
          `${encodeURIComponent(secret)}/${encodeURIComponent(filename)}`,
        request,
      );
    }
    return validatedRasterImage(response, `Markdown upload ${filename}`, filename);
  }

  /**
   * Groups the token user is a member of — their teams, as GitLab already
   * knows them.
   *
   * Top-level only by default, because a group-scoped query already covers
   * every descendant: including the subgroups would ask the same question
   * several times over. `min_access_level=10` (Guest) is the widest membership
   * filter, and the point is to exclude the entire rest of gitlab.com rather
   * than to judge how involved someone is.
   */
  async listMemberGroups(
    options: {
      minAccessLevel?: number;
      topLevelOnly?: boolean;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<GitLabGroup[]> {
    const limit = options.limit ?? PAGE_SIZE;
    const { data } = await this.http.getJson(GitLabGroupListSchema, "/groups", {
      signal: options.signal,
      query: {
        min_access_level: options.minAccessLevel ?? 10,
        top_level_only: options.topLevelOnly ?? true,
        order_by: "name",
        per_page: Math.min(PAGE_SIZE, limit),
        page: 1,
      },
    });
    return data.length <= limit ? data : data.slice(0, limit);
  }

  /**
   * Open (by default) merge requests across a group and every project beneath
   * it — GitLab includes descendant subgroups here without being asked.
   *
   * This is how "what is my team working on" is answered. The instance-wide
   * `/merge_requests?scope=all` is not: on gitlab.com that scope means every
   * public project on the internet, so it returns strangers' work and times out
   * doing it.
   */
  async listGroupMergeRequests(
    group: string | number,
    options: {
      state?: "opened" | "closed" | "locked" | "merged" | "all";
      drafts?: DraftFilter;
      orderBy?: "created_at" | "updated_at";
      /**
       * Lower bound on creation date, as GitLab's `created_after`.
       *
       * Not an optimisation: `state=merged` across a group with years of history
       * returns 408 from gitlab.com at every page size down to 10, and answers in
       * ~1.5s once bounded. Any caller asking for merged or closed work has to
       * say how far back it cares about.
       */
      createdAfter?: Date;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<MergeRequest[]> {
    const limit = options.limit ?? PAGE_SIZE;
    const drafts = options.drafts ?? "exclude";
    const out: MergeRequest[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, headers } = await this.http.getJson(
        MergeRequestListSchema,
        `/groups/${encodeProject(group)}/merge_requests`,
        {
          signal: options.signal,
          query: {
            state: options.state ?? "opened",
            ...draftQuery(drafts),
            ...(options.createdAfter
              ? { created_after: options.createdAfter.toISOString() }
              : {}),
            order_by: options.orderBy ?? "updated_at",
            sort: "desc",
            per_page: Math.min(PAGE_SIZE, limit - out.length),
            page,
          },
        },
      );

      out.push(...filterDrafts(data, drafts));
      if (out.length >= limit) break;

      const next = headers.get("x-next-page");
      if (!next || next.trim() === "") break;
    }

    return out.length <= limit ? out : out.slice(0, limit);
  }

  /**
   * Every project in a group (or subgroup), non-recursive by default.
   *
   * Backs the repository dropdown in the web UI's Add-task panel: a group
   * like `example-org/services` holds dozens of projects, and typing each
   * `group/project` path by hand is exactly the kind of thing a dropdown
   * exists to avoid.
   */
  async listGroupProjects(
    group: string | number,
    options: { includeSubgroups?: boolean; limit?: number; signal?: AbortSignal } = {},
  ): Promise<GitLabProject[]> {
    const limit = options.limit ?? PAGE_SIZE;
    const out: GitLabProject[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, headers } = await this.http.getJson(
        GitLabProjectListSchema,
        `/groups/${encodeProject(group)}/projects`,
        {
          signal: options.signal,
          query: {
            include_subgroups: options.includeSubgroups ?? false,
            simple: true,
            order_by: "name",
            per_page: Math.min(PAGE_SIZE, limit - out.length),
            page,
          },
        },
      );

      out.push(...data);
      if (out.length >= limit) break;

      const next = headers.get("x-next-page");
      if (!next || next.trim() === "") break;
    }

    return out.length <= limit ? out : out.slice(0, limit);
  }

  async project(project: string | number, signal?: AbortSignal): Promise<GitLabProject> {
    const { data } = await this.http.getJson(
      GitLabProjectSchema,
      `/projects/${encodeProject(project)}`,
      { signal },
    );
    return data;
  }

  /**
   * Pipelines updated since the watermark, oldest first.
   *
   * Ascending order matters: the task advances its watermark to the newest
   * item it saw, so processing newest-first would strand older pipelines behind
   * the watermark the moment the run is capped by `maxItemsPerRun`.
   */
  async listPipelines(options: ListPipelinesOptions): Promise<Pipeline[]> {
    const limit = options.limit ?? PAGE_SIZE;
    const out: Pipeline[] = [];

    const schedule = options.scheduleDescription
      ? await this.scheduleByDescription(
          options.project,
          options.scheduleDescription,
          options.signal,
        )
      : undefined;

    if (schedule) {
      // GitLab can apply the expensive date/status work on this endpoint. Only
      // filters it does not support need a bounded client-side pass.
      const needsClientFilter =
        options.name != null || options.ref != null || options.source != null;
      const scheduled = await this.listSchedulePipelines(
        options.project,
        schedule.id,
        {
          updatedAfter: options.updatedAfter,
          status: options.status,
          newestFirst: options.newestFirst,
          limit: needsClientFilter ? PAGE_SIZE * MAX_PAGES : limit,
          signal: options.signal,
        },
      );
      const filtered = scheduled.filter((pipeline) => {
        if (options.name != null && pipeline.name !== options.name) return false;
        if (options.ref != null && pipeline.ref !== options.ref) return false;
        if (options.source != null && pipeline.source !== options.source) return false;
        return true;
      });
      if (filtered.length <= limit) return filtered;
      return options.newestFirst ? filtered.slice(-limit) : filtered.slice(0, limit);
    }

    const path = `/projects/${encodeProject(options.project)}/pipelines`;
    const clientSideFilter = options.name != null;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, headers } = await this.http.getJson(
        PipelineListSchema,
        path,
        {
          signal: options.signal,
          query: {
            // GitLab compares updated_after exclusively enough for our purposes,
            // and claimEvent makes an inclusive boundary harmless anyway.
            updated_after: options.updatedAfter?.toISOString(),
            ref: options.ref,
            status: options.status,
            source: options.source,
            order_by: "updated_at",
            // Fetching descending is the only way to reach the newest page: a
            // capped ascending query returns the start of history, so no amount
            // of client-side trimming recovers the recent end.
            sort: options.newestFirst ? "desc" : "asc",
            // Any client-side filter is applied after the response arrives, so a
            // full page must be requested regardless of how few matches remain.
            per_page: clientSideFilter ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - out.length),
            page,
          },
        },
      );

      out.push(
        ...data.filter((p) => {
          if (options.name != null && p.name !== options.name) return false;
          return true;
        }),
      );
      // Only safe to stop early when the server did the filtering and ordered the
      // result: with a client-side filter, a later page can still hold a match
      // that belongs in the answer. Breaking rather than returning, so the sort
      // and trim below apply to every path.
      if (!clientSideFilter && out.length >= limit) break;

      const next = headers.get("x-next-page");
      if (!next || next.trim() === "") break;
    }

    // A descending fetch arrives backwards, so normalise once here to keep the
    // oldest-first contract every caller relies on.
    out.sort((a, b) => a.updated_at.getTime() - b.updated_at.getTime());

    if (out.length <= limit) return out;
    // Now that the list is ascending, "newest" means the tail.
    return options.newestFirst ? out.slice(-limit) : out.slice(0, limit);
  }

  /**
   * Every pipeline schedule on the project. Rarely more than a handful, so this
   * is a single page.
   */
  async listSchedules(
    project: string | number,
    signal?: AbortSignal,
  ): Promise<PipelineSchedule[]> {
    const { data } = await this.http.getJson(
      PipelineScheduleListSchema,
      `/projects/${encodeProject(project)}/pipeline_schedules`,
      { signal, query: { per_page: PAGE_SIZE } },
    );
    return data;
  }

  /** Full schedule metadata, including its next run and most recent pipeline. */
  async schedule(
    project: string | number,
    scheduleId: number,
    signal?: AbortSignal,
  ): Promise<PipelineScheduleDetail> {
    const { data } = await this.http.getJson(
      PipelineScheduleDetailSchema,
      `/projects/${encodeProject(project)}/pipeline_schedules/${scheduleId}`,
      { signal },
    );
    return data;
  }

  /**
   * Pipelines triggered by one schedule, oldest first.
   *
   * Unlike a project-wide scan, this endpoint can apply schedule identity,
   * status, and all date bounds in GitLab before returning a page.
   */
  async listSchedulePipelines(
    project: string | number,
    scheduleId: number,
    options: ListSchedulePipelinesOptions = {},
  ): Promise<Pipeline[]> {
    const limit = options.limit ?? PAGE_SIZE;
    const out: Pipeline[] = [];

    for (let page = 1; page <= MAX_PAGES && out.length < limit; page++) {
      const { data, headers } = await this.http.getJson(
        PipelineListSchema,
        `/projects/${encodeProject(project)}/pipeline_schedules/${scheduleId}/pipelines`,
        {
          signal: options.signal,
          query: {
            updated_after: options.updatedAfter?.toISOString(),
            updated_before: options.updatedBefore?.toISOString(),
            created_after: options.createdAfter?.toISOString(),
            created_before: options.createdBefore?.toISOString(),
            status: options.status,
            sort: options.newestFirst ? "desc" : "asc",
            per_page: Math.min(PAGE_SIZE, limit - out.length),
            page,
          },
        },
      );
      out.push(...data);
      const next = headers.get("x-next-page");
      if (!next || next.trim() === "") break;
    }

    out.sort((a, b) => a.updated_at.getTime() - b.updated_at.getTime());
    if (out.length <= limit) return out;
    return options.newestFirst ? out.slice(-limit) : out.slice(0, limit);
  }

  /**
   * The one schedule with this description.
   *
   * Descriptions are compared trimmed: a trailing space is invisible in the UI,
   * and someone who typed the name correctly should not get an empty result over
   * it. Ambiguity is an error rather than a guess — two schedules sharing a
   * description means the caller's intent is genuinely unknown.
   */
  async scheduleByDescription(
    project: string | number,
    description: string,
    signal?: AbortSignal,
  ): Promise<PipelineSchedule> {
    const wanted = description.trim();
    const schedules = await this.listSchedules(project, signal);
    const matches = schedules.filter((s) => s.description.trim() === wanted);

    if (matches.length === 0) {
      throw new ConfigError(
        `No pipeline schedule on ${project} is described '${description}'. ` +
          `Known schedules: ${
            schedules.map((s) => `'${s.description.trim()}'`).join(", ") || "(none)"
          }`,
      );
    }
    if (matches.length > 1) {
      throw new ConfigError(
        `${matches.length} pipeline schedules on ${project} are described ` +
          `'${description}' (ids ${matches.map((s) => s.id).join(", ")}). ` +
          `Disambiguate by schedule id.`,
      );
    }
    return matches[0]!;
  }

  /** Failed pipelines only, which is what gitlab-ci-failure acts on. */
  listFailedPipelines(
    options: Omit<ListPipelinesOptions, "status">,
  ): Promise<Pipeline[]> {
    return this.listPipelines({ ...options, status: FAILED_PIPELINE_STATUS });
  }

  async pipeline(
    project: string | number,
    pipelineId: number,
    signal?: AbortSignal,
  ): Promise<PipelineDetail> {
    const { data } = await this.http.getJson(
      PipelineDetailSchema,
      `/projects/${encodeProject(project)}/pipelines/${pipelineId}`,
      { signal },
    );
    return data;
  }

  /** Aggregate and per-suite unit-test counts for a pipeline. */
  async pipelineTestReportSummary(
    project: string | number,
    pipelineId: number,
    signal?: AbortSignal,
  ): Promise<PipelineTestReportSummary> {
    let report: PipelineTestReportSummary | undefined;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, headers } = await this.http.getJson(
        PipelineTestReportSummarySchema,
        `/projects/${encodeProject(project)}/pipelines/${pipelineId}/test_report_summary`,
        { signal, query: { per_page: PAGE_SIZE, page } },
      );
      if (report) report.test_suites.push(...data.test_suites);
      else report = data;
      const next = headers.get("x-next-page");
      if (!next || next.trim() === "") break;
    }
    return report!;
  }

  /** Full pipeline unit-test report, including every parsed test case. */
  async pipelineTestReport(
    project: string | number,
    pipelineId: number,
    signal?: AbortSignal,
  ): Promise<PipelineTestReport> {
    let report: PipelineTestReport | undefined;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, headers } = await this.http.getJson(
        PipelineTestReportSchema,
        `/projects/${encodeProject(project)}/pipelines/${pipelineId}/test_report`,
        { signal, query: { per_page: PAGE_SIZE, page } },
      );
      if (report) report.test_suites.push(...data.test_suites);
      else report = data;
      const next = headers.get("x-next-page");
      if (!next || next.trim() === "") break;
    }
    return report!;
  }

  async listJobs(
    project: string | number,
    pipelineId: number,
    signal?: AbortSignal,
  ): Promise<Job[]> {
    const out: Job[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, headers } = await this.http.getJson(
        JobListSchema,
        `/projects/${encodeProject(project)}/pipelines/${pipelineId}/jobs`,
        { signal, query: { per_page: PAGE_SIZE, page, include_retried: false } },
      );

      out.push(...data);
      const next = headers.get("x-next-page");
      if (!next || next.trim() === "") break;
    }

    return out;
  }

  /** Starts one new attempt for a failed job in its existing pipeline. */
  async retryJob(
    project: string | number,
    jobId: number,
    signal?: AbortSignal,
  ): Promise<Job> {
    const { data } = await this.http.postJson(
      JobSchema,
      `/projects/${encodeProject(project)}/jobs/${jobId}/retry`,
      {},
      { signal },
    );
    return data;
  }

  /**
   * Jobs that failed and mattered.
   *
   * `allow_failure` jobs are excluded by default: they failed by design and the
   * pipeline did not fail because of them, so putting them in a ticket buries the
   * real cause. Retried jobs are excluded at the API level above, so a job that
   * failed then passed on retry does not appear.
   *
   * `includeAllowedFailures` exists because that default is wrong for a test job
   * marked `allow_failure: true` so it never blocks a deploy — a very common
   * setup. There the failing job is the *only* thing worth a ticket, and the
   * pipeline reports `success` while tests are broken.
   */
  async listFailedJobs(
    project: string | number,
    pipelineId: number,
    options: { includeAllowedFailures?: boolean; signal?: AbortSignal } = {},
  ): Promise<Job[]> {
    const jobs = await this.listJobs(project, pipelineId, options.signal);
    return jobs.filter(
      (job) =>
        job.status === "failed" &&
        (options.includeAllowedFailures || job.allow_failure !== true),
    );
  }

  /**
   * A job's log, truncated at fetch.
   *
   * Truncation happens here rather than in the LLM step (plan §8) because the
   * text also lands in SQLite and in a Jira description; capping it at the LLM
   * boundary alone would protect the token budget and nothing else.
   */
  async jobTrace(
    project: string | number,
    job: Pick<Job, "id" | "name">,
    options: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<JobTrace> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_TRACE_BYTES;
    const { text, bytes, truncated } = await this.http.getText(
      `/projects/${encodeProject(project)}/jobs/${job.id}/trace`,
      { maxBytes, signal: options.signal },
    );

    return { jobId: job.id, jobName: job.name, text, bytes, truncated };
  }

  /**
   * One file from a job's artifact archive.
   *
   * Every path component is encoded separately: GitLab uses the slashes to
   * address the archive hierarchy, while spaces, `#`, `?`, and non-ASCII bytes
   * belong inside their component rather than in the request URL.
   */
  async jobArtifactFile(
    project: string | number,
    jobId: number,
    artifactPath: string,
    signal?: AbortSignal,
  ): Promise<GitLabArtifactFile> {
    if (!Number.isSafeInteger(jobId) || jobId <= 0) {
      throw new ConfigError(`Invalid GitLab job id: ${jobId}`);
    }
    const { encodedPath, filename } = encodeArtifactPath(artifactPath);
    const response = await this.http.request(
      `/projects/${encodeProject(project)}/jobs/${jobId}/artifacts/${encodedPath}`,
      {
        signal,
        accept: "image/png, image/jpeg, image/gif, image/webp, application/octet-stream",
        maxBytes: MAX_GITLAB_IMAGE_BYTES,
      },
    );
    return validatedRasterImage(
      response,
      `job ${jobId} artifact ${filename}`,
      filename,
    );
  }

  /**
   * Traces for several jobs, each capped individually and the set capped in
   * aggregate. Jobs are fetched in order and the budget is spent as it goes, so
   * an early 60MB trace cannot starve the rest silently — the omission is
   * reported rather than inferred from a short list.
   */
  async jobTraces(
    project: string | number,
    jobs: Pick<Job, "id" | "name">[],
    options: { maxBytesPerJob?: number; maxTotalBytes?: number; signal?: AbortSignal } = {},
  ): Promise<{ traces: JobTrace[]; omittedJobs: number }> {
    const traces: JobTrace[] = [];
    let spent = 0;

    for (const job of jobs) {
      if (options.maxTotalBytes != null && spent >= options.maxTotalBytes) {
        return { traces, omittedJobs: jobs.length - traces.length };
      }

      const remaining =
        options.maxTotalBytes == null
          ? options.maxBytesPerJob
          : Math.min(
              options.maxBytesPerJob ?? Number.POSITIVE_INFINITY,
              options.maxTotalBytes - spent,
            );

      const trace = await this.jobTrace(project, job, {
        maxBytes: remaining,
        signal: options.signal,
      });
      traces.push(trace);
      spent += new TextEncoder().encode(trace.text).byteLength;
    }

    return { traces, omittedJobs: 0 };
  }

  /**
   * Open (by default) merge requests on a project.
   *
   * `search` matches title/description server-side, which is what backs the
   * web UI's MR picker — the caller narrows before the user has typed much.
   * To act on a specific, already-known set of MRs (e.g. ones a user chose in
   * that picker), fetch each by iid with `mergeRequest` instead — GitLab's
   * `iids[]` array filter needs repeated query keys, which this client's
   * single-value query builder does not support, and fetching a handful of
   * known iids individually is simpler than adding that.
   */
  async listMergeRequests(
    project: string | number,
    options: {
      state?: "opened" | "closed" | "locked" | "merged" | "all";
      search?: string;
      /**
       * Exact source branch. This is how a job asks "did I already open an MR
       * from the branch I pushed" — the question that makes reopening one after a
       * crash between the push and the MR safe.
       */
      sourceBranch?: string;
      /** Defaults to `include`, unlike the group/instance-wide listings — every existing caller here wants drafts too. */
      drafts?: DraftFilter;
      /** Lower bound on creation date — see `listGroupMergeRequests`. Unset by default: a single project's history is cheap enough not to need one. */
      createdAfter?: Date;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<MergeRequest[]> {
    const limit = options.limit ?? PAGE_SIZE;
    const drafts = options.drafts ?? "include";
    const out: MergeRequest[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, headers } = await this.http.getJson(
        MergeRequestListSchema,
        `/projects/${encodeProject(project)}/merge_requests`,
        {
          signal: options.signal,
          query: {
            state: options.state ?? "opened",
            search: options.search,
            source_branch: options.sourceBranch,
            ...draftQuery(drafts),
            ...(options.createdAfter
              ? { created_after: options.createdAfter.toISOString() }
              : {}),
            order_by: "updated_at",
            sort: "desc",
            per_page: Math.min(PAGE_SIZE, limit - out.length),
            page,
          },
        },
      );

      out.push(...filterDrafts(data, drafts));
      if (out.length >= limit) break;

      const next = headers.get("x-next-page");
      if (!next || next.trim() === "") break;
    }

    return out.length <= limit ? out : out.slice(0, limit);
  }

  /**
   * Exact number of open merge requests on one project, including drafts.
   *
   * GitLab returns the collection total in `x-total`, so dashboard counters do
   * not need to download every merge request merely to count them.
   */
  async countOpenMergeRequests(
    project: string | number,
    signal?: AbortSignal,
  ): Promise<number> {
    const { headers } = await this.http.getJson(
      MergeRequestListSchema,
      `/projects/${encodeProject(project)}/merge_requests`,
      {
        signal,
        query: {
          state: "opened",
          per_page: 1,
          page: 1,
        },
      },
    );
    const rawTotal = headers.get("x-total");
    if (rawTotal != null && /^(0|[1-9]\d*)$/.test(rawTotal)) {
      const total = Number(rawTotal);
      if (Number.isSafeInteger(total)) return total;
    }

    // Some proxies strip GitLab's pagination headers. Preserve correctness for
    // ordinary projects instead of turning a one-row response into a false 1.
    const rest = await this.listMergeRequests(project, {
      state: "opened",
      drafts: "include",
      limit: PAGE_SIZE * MAX_PAGES,
      signal,
    });
    return rest.length;
  }

  /**
   * The instance-wide `GET /merge_requests` endpoint, across every project the
   * token can see.
   *
   * The scope is required rather than defaulted: GitLab's own default is
   * `created_by_me`, so an omitted scope silently answers a different question
   * than the caller asked. Drafts are dropped unless `drafts` says otherwise —
   * an automation commenting on WIP work is a bug, but a human browsing their
   * own merge requests expects to see the drafts they opened.
   *
   * There is deliberately no `all` scope here. On gitlab.com it means every
   * public project on the internet — it returns strangers' merge requests, and
   * times out doing it. For "everything my team has open", use
   * `listGroupMergeRequests` over `listMemberGroups`.
   */
  async listMergeRequestsByScope(options: {
    scope: "created_by_me" | "assigned_to_me" | "reviews_for_me";
    state?: "opened" | "closed" | "locked" | "merged";
    drafts?: DraftFilter;
    orderBy?: "created_at" | "updated_at";
    /** Lower bound on creation date — see `listGroupMergeRequests`. */
    createdAfter?: Date;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<MergeRequest[]> {
    const limit = options.limit ?? PAGE_SIZE;
    const drafts = options.drafts ?? "exclude";
    const out: MergeRequest[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, headers } = await this.http.getJson(
        MergeRequestListSchema,
        "/merge_requests",
        {
          signal: options.signal,
          query: {
            scope: options.scope,
            state: options.state ?? "opened",
            ...draftQuery(drafts),
            ...(options.createdAfter
              ? { created_after: options.createdAfter.toISOString() }
              : {}),
            order_by: options.orderBy ?? "updated_at",
            sort: "desc",
            per_page: Math.min(PAGE_SIZE, limit - out.length),
            page,
          },
        },
      );

      out.push(...filterDrafts(data, drafts));
      if (out.length >= limit) break;

      const next = headers.get("x-next-page");
      if (!next || next.trim() === "") break;
    }

    return out.length <= limit ? out : out.slice(0, limit);
  }

  /**
   * Open (by default), non-draft merge requests the token user has been asked
   * to review, across every project they can see.
   */
  async listMergeRequestsForReview(
    options: {
      state?: "opened" | "closed" | "locked" | "merged";
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<MergeRequest[]> {
    return this.listMergeRequestsByScope({ ...options, scope: "reviews_for_me" });
  }

  /**
   * Open, non-draft merge requests authored by the token user across every
   * accessible project. GitLab calls this scope `created_by_me`.
   */
  async listMergeRequestsAuthoredByMe(
    options: {
      state?: "opened" | "closed" | "locked" | "merged";
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<MergeRequest[]> {
    return this.listMergeRequestsByScope({ ...options, scope: "created_by_me" });
  }

  /**
   * Branches on a project, optionally narrowed by a search term (GitLab
   * matches it against the branch name server-side). Backs the "Branch"
   * scope's dropdown in the web UI's Add-task panel.
   */
  async listBranches(
    project: string | number,
    options: { search?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<Branch[]> {
    const limit = options.limit ?? PAGE_SIZE;
    const out: Branch[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, headers } = await this.http.getJson(
        BranchListSchema,
        `/projects/${encodeProject(project)}/repository/branches`,
        {
          signal: options.signal,
          query: {
            search: options.search,
            per_page: Math.min(PAGE_SIZE, limit - out.length),
            page,
          },
        },
      );

      out.push(...data);
      if (out.length >= limit) break;

      const next = headers.get("x-next-page");
      if (!next || next.trim() === "") break;
    }

    return out.length <= limit ? out : out.slice(0, limit);
  }

  /**
   * Entries in the repo tree at `path` (the root by default) on a ref — how the
   * releases feature discovers environment folders, each of which holds a
   * `cluster.yaml`. Not recursive: only the immediate children of `path`.
   * Read-only — `read_api` is enough.
   */
  async listTree(
    project: string | number,
    options: { path?: string; ref: string; signal?: AbortSignal },
  ): Promise<TreeEntry[]> {
    const out: TreeEntry[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, headers } = await this.http.getJson(
        TreeEntryListSchema,
        `/projects/${encodeProject(project)}/repository/tree`,
        {
          signal: options.signal,
          query: {
            ref: options.ref,
            ...(options.path ? { path: options.path } : {}),
            per_page: PAGE_SIZE,
            page,
          },
        },
      );
      out.push(...data);
      const next = headers.get("x-next-page");
      if (!next || next.trim() === "") break;
    }
    return out;
  }

  /**
   * The raw text of a file at a ref — the releases manifest, in practice.
   *
   * `GET .../repository/files/:path/raw?ref=<ref>`. The path is a single
   * URL-encoded segment (slashes and all), which is how GitLab addresses a
   * nested file. A 404 surfaces through `errorFromHttpStatus` as a
   * non-retryable error the service turns into a clean "manifest not found"
   * message. Read-only — `read_api` is enough.
   */
  async getFileRaw(
    project: string | number,
    path: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<{ content: string; ref: string }> {
    const { text } = await this.http.getText(
      `/projects/${encodeProject(project)}/repository/files/${encodeURIComponent(path)}/raw`,
      { query: { ref }, signal },
    );
    return { content: text, ref };
  }

  /**
   * Commits on a ref, newest first — how the release history reads back who
   * deployed what and when.
   *
   * `path` narrows to the commits that touched one file or folder, which is
   * GitLab doing the filtering rather than us fetching a repo's whole history to
   * throw most of it away. Read-only — `read_api` is enough.
   */
  async listCommits(
    project: string | number,
    options: {
      ref: string;
      path?: string;
      /** Only commits after this instant, as GitLab's `since`. */
      since?: Date;
      /** Hard cap on commits returned; paging stops as soon as it is reached. */
      limit?: number;
      signal?: AbortSignal;
    },
  ): Promise<RepositoryCommit[]> {
    const limit = options.limit ?? PAGE_SIZE;
    const out: RepositoryCommit[] = [];
    for (let page = 1; page <= MAX_PAGES && out.length < limit; page++) {
      const { data, headers } = await this.http.getJson(
        RepositoryCommitListSchema,
        `/projects/${encodeProject(project)}/repository/commits`,
        {
          signal: options.signal,
          query: {
            ref_name: options.ref,
            ...(options.path ? { path: options.path } : {}),
            ...(options.since ? { since: options.since.toISOString() } : {}),
            per_page: Math.min(PAGE_SIZE, limit - out.length),
            page,
          },
        },
      );
      out.push(...data);
      const next = headers.get("x-next-page");
      if (!next || next.trim() === "") break;
    }
    return out.length <= limit ? out : out.slice(0, limit);
  }

  /**
   * The files one commit changed, with their hunks — the diff against its first
   * parent, which is what GitLab shows for a commit.
   *
   * The release history reads the manifest's `version:` lines out of these hunks
   * rather than fetching the file at every commit: one request per commit either
   * way, but the diff already says which lines moved. Read-only — `read_api` is
   * enough.
   */
  async commitDiff(
    project: string | number,
    sha: string,
    signal?: AbortSignal,
  ): Promise<FileDiff[]> {
    const { data } = await this.http.getJson(
      FileDiffListSchema,
      `/projects/${encodeProject(project)}/repository/commits/${encodeURIComponent(sha)}/diff`,
      { signal, query: { per_page: PAGE_SIZE } },
    );
    return data;
  }

  /** Merge requests associated with a repository commit, newest first. */
  async commitMergeRequests(
    project: string | number,
    sha: string,
    signal?: AbortSignal,
  ): Promise<MergeRequest[]> {
    const { data } = await this.http.getJson(
      MergeRequestListSchema,
      `/projects/${encodeProject(project)}/repository/commits/${encodeURIComponent(sha)}/merge_requests`,
      { signal },
    );
    return data;
  }

  /**
   * Creates a branch and commits file changes to it in one call.
   *
   * `POST .../repository/commits` with `start_branch` makes GitLab branch off
   * `start_branch` and apply the actions atomically — no separate
   * create-branch round trip, and nothing left behind if the commit is
   * rejected. Requires the `api` scope, same as `createMergeRequest`.
   */
  async createCommit(
    project: string | number,
    input: {
      branch: string;
      startBranch: string;
      commitMessage: string;
      actions: { action: "create" | "update" | "delete"; filePath: string; content?: string }[];
      signal?: AbortSignal;
    },
  ): Promise<Commit> {
    const { data } = await this.http.postJson(
      CommitSchema,
      `/projects/${encodeProject(project)}/repository/commits`,
      {
        branch: input.branch,
        start_branch: input.startBranch,
        commit_message: input.commitMessage,
        actions: input.actions.map((a) => ({
          action: a.action,
          file_path: a.filePath,
          ...(a.content != null ? { content: a.content } : {}),
        })),
      },
      { signal: input.signal },
    );
    return data;
  }

  /** A single merge request by iid. */
  async mergeRequest(
    project: string | number,
    mrIid: number,
    signal?: AbortSignal,
  ): Promise<MergeRequest> {
    const { data } = await this.http.getJson(
      MergeRequestSchema,
      `/projects/${encodeProject(project)}/merge_requests/${mrIid}`,
      { signal },
    );
    return data;
  }

  /**
   * Who has approved a merge request, and how many approvals it still needs.
   *
   * Returns null rather than throwing when GitLab will not answer: approvals are
   * a paid-tier feature, so a free-tier project 404s here and a restrictive
   * self-managed instance 403s. Neither is a broken merge request, and failing
   * the whole detail request over an optional field would take the description,
   * the threads and the diff down with it.
   */
  async mergeRequestApprovals(
    project: string | number,
    mrIid: number,
    signal?: AbortSignal,
  ): Promise<MergeRequestApprovals | null> {
    try {
      const { data } = await this.http.getJson(
        MergeRequestApprovalsSchema,
        `/projects/${encodeProject(project)}/merge_requests/${mrIid}/approvals`,
        { signal },
      );
      return data;
    } catch {
      return null;
    }
  }

  /**
   * File diffs GitLab shows on the MR Changes tab — every commit on the MR
   * versus the target, not `git show HEAD`. Paginated; GitLab's `per_page`
   * cap is 100.
   */
  async mergeRequestDiffs(
    project: string | number,
    mrIid: number,
    signal?: AbortSignal,
  ): Promise<MergeRequestDiff[]> {
    const out: MergeRequestDiff[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, headers } = await this.http.getJson(
        MergeRequestDiffListSchema,
        `/projects/${encodeProject(project)}/merge_requests/${mrIid}/diffs`,
        {
          signal,
          query: { per_page: PAGE_SIZE, page },
        },
      );
      out.push(...data);
      const next = headers.get("x-next-page");
      if (!next || next.trim() === "") break;
    }
    return out;
  }

  /** Commits GitLab lists on the MR, oldest to newest as returned. */
  async mergeRequestCommits(
    project: string | number,
    mrIid: number,
    signal?: AbortSignal,
  ): Promise<MergeRequestCommit[]> {
    const out: MergeRequestCommit[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, headers } = await this.http.getJson(
        MergeRequestCommitListSchema,
        `/projects/${encodeProject(project)}/merge_requests/${mrIid}/commits`,
        {
          signal,
          query: { per_page: PAGE_SIZE, page },
        },
      );
      out.push(...data);
      const next = headers.get("x-next-page");
      if (!next || next.trim() === "") break;
    }
    return out;
  }

  /** Pipelines GitLab associates with one merge request, newest first. */
  async mergeRequestPipelines(
    project: string | number,
    mrIid: number,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<Pipeline[]> {
    const limit = options.limit ?? 20;
    const out: Pipeline[] = [];
    for (let page = 1; page <= MAX_PAGES && out.length < limit; page++) {
      const { data, headers } = await this.http.getJson(
        PipelineListSchema,
        `/projects/${encodeProject(project)}/merge_requests/${mrIid}/pipelines`,
        {
          signal: options.signal,
          query: {
            per_page: Math.min(PAGE_SIZE, limit - out.length),
            page,
          },
        },
      );
      out.push(...data);
      const next = headers.get("x-next-page");
      if (!next || next.trim() === "") break;
    }
    return out.length <= limit ? out : out.slice(0, limit);
  }

  /**
   * Opens a merge request from a branch that has already been pushed.
   *
   * Requires the `api` scope. Draft is the caller's decision and
   * `jira-ticket-to-mr` always sets it: an agent's work reaches a human as a
   * draft, never as something that looks ready to merge.
   *
   * New merge requests belong to the authenticated user by default. Keeping
   * that policy here applies it consistently to every task that opens an MR;
   * callers can still name a different assignee explicitly.
   *
   * A 409 here means "an MR from this source branch already exists", which is a
   * fact worth knowing rather than a failure — the caller finds it with
   * `listMergeRequests({ sourceBranch })` and continues.
   */
  async createMergeRequest(
    project: string | number,
    input: {
      sourceBranch: string;
      targetBranch: string;
      title: string;
      description?: string;
      /** Prefixes the title with `Draft:`, which is how GitLab marks a draft. */
      draft?: boolean;
      removeSourceBranch?: boolean;
      squash?: boolean;
      assigneeId?: number;
      reviewerIds?: number[];
      labels?: string[];
      signal?: AbortSignal;
    },
  ): Promise<MergeRequest> {
    const title =
      input.draft && !/^draft:/i.test(input.title) ? `Draft: ${input.title}` : input.title;
    const assigneeId = input.assigneeId ?? (await this.currentUser(input.signal)).id;
    const { data } = await this.http.postJson(
      MergeRequestSchema,
      `/projects/${encodeProject(project)}/merge_requests`,
      {
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title,
        ...(input.description ? { description: input.description } : {}),
        ...(input.removeSourceBranch != null
          ? { remove_source_branch: input.removeSourceBranch }
          : {}),
        ...(input.squash != null ? { squash: input.squash } : {}),
        assignee_id: assigneeId,
        ...(input.reviewerIds?.length ? { reviewer_ids: input.reviewerIds } : {}),
        ...(input.labels?.length ? { labels: input.labels.join(",") } : {}),
      },
      { signal: input.signal },
    );
    return data;
  }

  /**
   * Approves a merge request as the authenticated user.
   *
   * `POST /merge_requests/:iid/approve`, returning the resulting approval state.
   * Requires the `api` scope. Approvals are a paid-tier feature, so a free-tier
   * or restrictively-configured project answers 404/403 — the caller decides
   * whether that is fatal (an upload opts to surface it as a soft warning rather
   * than undo an already-opened MR).
   */
  async approveMergeRequest(
    project: string | number,
    mrIid: number,
    signal?: AbortSignal,
  ): Promise<MergeRequestApprovals> {
    const { data } = await this.http.postJson(
      MergeRequestApprovalsSchema,
      `/projects/${encodeProject(project)}/merge_requests/${mrIid}/approve`,
      {},
      { signal },
    );
    return data;
  }

  /**
   * Merges a merge request as the authenticated user.
   *
   * `PUT /merge_requests/:iid/merge`. Requires the `api` scope. With
   * `autoMerge`, GitLab waits for every merge check instead of merging
   * immediately — the right choice whenever a pipeline still has to run, since
   * merging before it finishes would skip the check entirely rather than wait
   * for it. `auto_merge` replaced the deprecated
   * `merge_when_pipeline_succeeds` request parameter in GitLab 17.11; the
   * response still exposes `merge_when_pipeline_succeeds` as the state flag.
   * GitLab answers 405/406 when the MR cannot be merged or
   * queued at all (conflicts, an unresolved discussion, missing approvals) —
   * the caller decides whether that is fatal (an upload opts to surface it as
   * a soft warning rather than undo the open, approved MR).
   */
  async mergeMergeRequest(
    project: string | number,
    mrIid: number,
    opts?: { autoMerge?: boolean; signal?: AbortSignal },
  ): Promise<MergeRequest> {
    const { data } = await this.http.putJson(
      MergeRequestSchema,
      `/projects/${encodeProject(project)}/merge_requests/${mrIid}/merge`,
      opts?.autoMerge ? { auto_merge: true } : {},
      { signal: opts?.signal },
    );
    return data;
  }

  /**
   * Posts a top-level comment on a merge request.
   *
   * Requires the `api` scope — `read_api` (everything else in this client)
   * cannot write. See the connector scopes table in README.md.
   */
  async createMergeRequestNote(
    project: string | number,
    mrIid: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<MergeRequestNote> {
    const { data } = await this.http.postJson(
      MergeRequestNoteSchema,
      `/projects/${encodeProject(project)}/merge_requests/${mrIid}/notes`,
      { body },
      { signal },
    );
    return data;
  }

  /** Lists every discussion thread on a merge request, oldest first. */
  async listMergeRequestDiscussions(
    project: string | number,
    mrIid: number,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<MergeRequestDiscussion[]> {
    const limit = options.limit ?? PAGE_SIZE;
    const out: MergeRequestDiscussion[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, headers } = await this.http.getJson(
        MergeRequestDiscussionListSchema,
        `/projects/${encodeProject(project)}/merge_requests/${mrIid}/discussions`,
        {
          signal: options.signal,
          query: {
            per_page: Math.min(PAGE_SIZE, limit - out.length),
            page,
          },
        },
      );
      out.push(...data);
      if (out.length >= limit) break;
      const next = headers.get("x-next-page");
      if (!next || next.trim() === "") break;
    }

    return out.length <= limit ? out : out.slice(0, limit);
  }

  /** Replies inside an existing merge-request discussion. */
  async createMergeRequestDiscussionNote(
    project: string | number,
    mrIid: number,
    discussionId: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<MergeRequestNote> {
    const { data } = await this.http.postJson(
      MergeRequestNoteSchema,
      `/projects/${encodeProject(project)}/merge_requests/${mrIid}/discussions/${encodeURIComponent(discussionId)}/notes`,
      { body },
      { signal },
    );
    return data;
  }

  /** Resolves the resolvable note that owns a merge-request discussion. */
  async resolveMergeRequestDiscussion(
    project: string | number,
    mrIid: number,
    discussionId: string,
    noteId: number,
    signal?: AbortSignal,
  ): Promise<MergeRequestDiscussionNote> {
    const { data } = await this.http.putJson(
      MergeRequestDiscussionNoteSchema,
      `/projects/${encodeProject(project)}/merge_requests/${mrIid}/discussions/${encodeURIComponent(discussionId)}/notes/${noteId}`,
      { resolved: true },
      { signal },
    );
    return data;
  }

  /**
   * Replaces the body of an existing merge-request note. Used to turn the
   * "review started" placeholder into the finished review without a second
   * comment.
   */
  async updateMergeRequestNote(
    project: string | number,
    mrIid: number,
    noteId: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<MergeRequestNote> {
    const { data } = await this.http.putJson(
      MergeRequestNoteSchema,
      `/projects/${encodeProject(project)}/merge_requests/${mrIid}/notes/${noteId}`,
      { body },
      { signal },
    );
    return data;
  }

  /**
   * Removes a merge-request note. Used to take down the "review started"
   * placeholder when the run is cancelled, rather than leaving it up or
   * rewriting it as a failure.
   */
  async deleteMergeRequestNote(
    project: string | number,
    mrIid: number,
    noteId: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.delete(
      `/projects/${encodeProject(project)}/merge_requests/${mrIid}/notes/${noteId}`,
      { signal },
    );
  }

  /**
   * Health check for `talos connector test gitlab`. Read-only, and it reports
   * every failure it can rather than stopping at the first: an operator with a
   * bad token and a wrong project id should learn both at once.
   */
  async check(
    options: { project?: string | number; signal?: AbortSignal } = {},
  ): Promise<HealthReport> {
    const checks = [
      await runCheck("authentication", async () => {
        const user = await this.currentUser(options.signal);
        return {
          detail: `authenticated as ${user.username}${user.name ? ` (${user.name})` : ""}`,
        };
      }),
    ];

    // Every later check uses the same token, so once authentication has failed
    // they can only repeat the same 401. Stopping here keeps the report about the
    // one thing the operator has to fix.
    if (!checks[0]!.ok) {
      checks.push({
        name: "project access",
        ok: false,
        detail: "not attempted — fix authentication first",
      });
      return report(this.name, checks);
    }

    if (options.project == null) {
      checks.push({
        name: "project access",
        ok: true,
        detail: "skipped — no project configured for any task",
      });
      return report(this.name, checks);
    }

    checks.push(
      await runCheck("project access", async () => {
        const project = await this.project(options.project!, options.signal);
        return {
          detail: `${project.path_with_namespace} (id ${project.id})`,
          values: [
            `web_url: ${project.web_url}`,
            `default_branch: ${project.default_branch ?? "(none)"}`,
          ],
        };
      }),
    );

    // read_api is what the scope table promises; listing pipelines is the
    // narrowest call that actually proves it, since /user works with any scope.
    checks.push(
      await runCheck("pipeline read (read_api)", async () => {
        const pipelines = await this.listPipelines({
          project: options.project!,
          limit: 1,
          newestFirst: true,
          signal: options.signal,
        });
        // Ascending, so the newest is the last element. Naming the pipeline it
        // found is what turns "readable" into something an operator can sanity
        // check against the GitLab UI — a five-year-old pipeline here would mean
        // the ordering is wrong.
        const newest = pipelines[pipelines.length - 1];
        return newest
          ? {
              detail: `readable; most recently updated: #${newest.id} ${newest.status} on ${
                newest.ref
              } (${newest.updated_at.toISOString()})`,
            }
          : { detail: "readable; this project has no pipelines yet" };
      }),
    );

    return report(this.name, checks);
  }
}

/**
 * `group/project` must be URL-encoded including the slash; a numeric id must
 * not be. Passing an unencoded path yields a 404 that reads like a missing
 * project, which is a confusing way to learn about encoding.
 */
export function encodeProject(project: string | number): string {
  if (typeof project === "number") {
    if (!Number.isInteger(project) || project <= 0) {
      throw new ConfigError(`Invalid GitLab project id: ${project}`);
    }
    return String(project);
  }

  const trimmed = project.trim();
  if (trimmed === "") {
    throw new ConfigError("GitLab project must not be empty.");
  }
  // A numeric string is an id, not a path.
  return /^\d+$/.test(trimmed) ? trimmed : encodeURIComponent(trimmed);
}

const RASTER_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function validatedRasterImage(
  response: {
    bytes: Uint8Array;
    headers: Headers;
    truncated: boolean;
  },
  resource: string,
  filename: string,
): GitLabArtifactFile {
  if (response.truncated) {
    throw new ConnectorError(
      `gitlab: ${resource} exceeds the ${MAX_GITLAB_IMAGE_BYTES}-byte limit`,
      { connector: "gitlab", retryable: false },
    );
  }
  const declaredType =
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const contentType = RASTER_IMAGE_TYPES.has(declaredType)
    ? declaredType
    : declaredType === "application/octet-stream"
      ? rasterImageContentType(response.bytes)
      : undefined;
  if (!contentType) {
    throw new ConnectorError(
      `gitlab: ${resource} returned '${declaredType || "unknown"}', not a supported raster image`,
      { connector: "gitlab", retryable: false },
    );
  }
  return { body: response.bytes, contentType, filename };
}

function encodeArtifactPath(path: string): { encodedPath: string; filename: string } {
  if (!path || path.length > 8_192) {
    throw new ConfigError("GitLab artifact path must be between 1 and 8192 characters.");
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.length > 255 ||
        segment.includes("\\") ||
        /[\u0000-\u001f\u007f]/.test(segment),
    )
  ) {
    throw new ConfigError(`Invalid GitLab artifact path: ${path}`);
  }
  return {
    encodedPath: segments.map(encodeURIComponent).join("/"),
    filename: segments.at(-1)!,
  };
}

function rasterImageContentType(bytes: Uint8Array): string | undefined {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif";
  }
  if (
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWithBytes(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  return undefined;
}

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function encodeProjectWebPath(project: string): string {
  const segments = project.trim().split("/");
  if (
    segments.length < 2 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new ConfigError(`Invalid GitLab project path: ${project}`);
  }
  return segments.map(encodeURIComponent).join("/");
}

/** Shared config block for any task that talks to GitLab. */
export const GitLabConfigSchema = z.object({
  /** Numeric id or `group/project`. Both are accepted by the API. */
  projectId: z.union([z.number().int().positive(), z.string().min(1)]),
  /** Optional branch filter, e.g. `main`. */
  ref: z.string().min(1).optional(),
  maxTraceBytes: z
    .number()
    .int()
    .positive()
    .max(10_000_000)
    .default(DEFAULT_MAX_TRACE_BYTES),
});

export type GitLabConfig = z.infer<typeof GitLabConfigSchema>;

/**
 * Builds a client from the secret store, so no call site reads env directly.
 *
 * `GITLAB_API_URL` is optional and only matters for a self-hosted instance; an
 * explicit `options.baseUrl` still wins, since a caller that knows the host is
 * more specific than a global setting.
 */
export function createGitLabClient(
  secrets: SecretStore,
  options: Omit<GitLabClientOptions, "token"> = {},
): GitLabClient {
  const baseUrl = options.baseUrl ?? secrets.get("GITLAB_API_URL");
  return new GitLabClient({
    ...options,
    ...(baseUrl ? { baseUrl } : {}),
    token: secrets.require("GITLAB_TOKEN"),
  });
}

/** Narrow guard used when reporting which connector produced a failure. */
export function isGitLabError(err: unknown): err is ConnectorError {
  return err instanceof ConnectorError && err.connector === "gitlab";
}
