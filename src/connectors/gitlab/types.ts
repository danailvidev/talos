import { z } from "zod";

/**
 * Response schemas for the GitLab.com REST v4 endpoints we use.
 *
 * Deliberately partial: only fields the task reads are declared, and every
 * object is loose so GitLab adding a field never breaks a running install. What
 * we *do* declare is required, so a rename fails loudly at the boundary instead
 * of surfacing as `undefined` inside a Jira ticket.
 */

/** Timestamps arrive as ISO 8601 strings; parse once, at the boundary. */
const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "expected an ISO 8601 timestamp",
  })
  .transform((value) => new Date(value));

export const GitLabUserSchema = z.looseObject({
  id: z.number(),
  username: z.string(),
  name: z.string().optional(),
  bot: z.boolean().optional(),
  /** Absolute URL to the user's avatar — GitLab always returns one, including its own generated default. */
  avatar_url: z.string().optional(),
});

export type GitLabUser = z.infer<typeof GitLabUserSchema>;

export const GitLabProjectSchema = z.looseObject({
  id: z.number(),
  path_with_namespace: z.string(),
  web_url: z.string(),
  default_branch: z.string().nullish(),
});

export type GitLabProject = z.infer<typeof GitLabProjectSchema>;

export const GitLabProjectListSchema = z.array(GitLabProjectSchema);

/**
 * A group the token user belongs to. `full_path` is what every group-scoped
 * endpoint takes, and — for a top-level group — is also the closest thing
 * GitLab has to "which organisation is this person in".
 */
export const GitLabGroupSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  full_path: z.string(),
});

export type GitLabGroup = z.infer<typeof GitLabGroupSchema>;

export const GitLabGroupListSchema = z.array(GitLabGroupSchema);

/**
 * GitLab pipeline statuses. Declared as an enum rather than a string so a new
 * status is a visible validation failure rather than a silently unhandled state.
 */
export const PIPELINE_STATUSES = [
  "created",
  "waiting_for_resource",
  "waiting_for_callback",
  "preparing",
  "pending",
  "running",
  "success",
  "failed",
  "canceled",
  "canceling",
  "skipped",
  "manual",
  "scheduled",
] as const;

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export const PipelineSchema = z.looseObject({
  id: z.number(),
  iid: z.number().optional(),
  project_id: z.number(),
  status: z.enum(PIPELINE_STATUSES),
  ref: z.string(),
  sha: z.string(),
  web_url: z.string(),
  /**
   * Pipeline name, set by the `workflow:name:` keyword.
   *
   * Almost always null in practice — notably, a scheduled pipeline does *not*
   * inherit its schedule's description here, as gitlab.com returns null for every
   * pipeline on a project that never sets `workflow:name:`. Target a schedule
   * through `/pipeline_schedules/:id/pipelines` instead of this field.
   */
  name: z.string().nullish(),
  /** `push`, `schedule`, `web`, `merge_request_event`, … */
  source: z.string().optional(),
  created_at: isoDate.optional(),
  updated_at: isoDate,
});

export type Pipeline = z.infer<typeof PipelineSchema>;

export const PipelineListSchema = z.array(PipelineSchema);

/** The single-pipeline endpoint carries the fields the list endpoint omits. */
export const PipelineDetailSchema = PipelineSchema.extend({
  user: GitLabUserSchema.nullish(),
  duration: z.number().nullish(),
  started_at: isoDate.nullish(),
  finished_at: isoDate.nullish(),
  commit: z
    .looseObject({
      id: z.string().optional(),
      title: z.string().optional(),
      author_name: z.string().optional(),
      author_email: z.string().optional(),
    })
    .nullish(),
});

export type PipelineDetail = z.infer<typeof PipelineDetailSchema>;

/**
 * A pipeline schedule. Its `description` is what the GitLab UI shows as the
 * schedule's name, and the only reliable way to tie a pipeline to a schedule —
 * see the note on `PipelineSchema.name`.
 */
export const PipelineScheduleSchema = z.looseObject({
  id: z.number(),
  description: z.string(),
  ref: z.string(),
  cron: z.string().optional(),
  cron_timezone: z.string().optional(),
  next_run_at: isoDate.nullish(),
  active: z.boolean().optional(),
  created_at: isoDate.optional(),
  updated_at: isoDate.optional(),
  owner: GitLabUserSchema.optional(),
});

export type PipelineSchedule = z.infer<typeof PipelineScheduleSchema>;

export const PipelineScheduleListSchema = z.array(PipelineScheduleSchema);

/** The compact pipeline metadata embedded by the single-schedule endpoint. */
export const PipelineScheduleLastPipelineSchema = z.looseObject({
  id: z.number(),
  sha: z.string(),
  ref: z.string(),
  status: z.enum(PIPELINE_STATUSES),
});

export const PipelineScheduleDetailSchema = PipelineScheduleSchema.extend({
  last_pipeline: PipelineScheduleLastPipelineSchema.nullish(),
});

export type PipelineScheduleDetail = z.infer<typeof PipelineScheduleDetailSchema>;

const TestReportCountsSchema = z.object({
  total_time: z.number(),
  total_count: z.number(),
  success_count: z.number(),
  failed_count: z.number(),
  skipped_count: z.number(),
  error_count: z.number(),
});

export const PipelineTestReportSummaryTotalSchema = z.looseObject({
  time: z.number(),
  count: z.number(),
  success: z.number(),
  failed: z.number(),
  skipped: z.number(),
  error: z.number(),
  suite_error: z.string().nullish(),
});

export const PipelineTestReportSummarySuiteSchema = z.looseObject({
  ...TestReportCountsSchema.shape,
  name: z.string(),
  build_ids: z.array(z.number()),
  suite_error: z.string().nullish(),
});

export const PipelineTestReportSummarySchema = z.looseObject({
  total: PipelineTestReportSummaryTotalSchema,
  test_suites: z.array(PipelineTestReportSummarySuiteSchema),
});

export type PipelineTestReportSummary = z.infer<
  typeof PipelineTestReportSummarySchema
>;

export const TEST_CASE_STATUSES = ["success", "failed", "skipped", "error"] as const;

// GitLab normally returns JUnit output as a string, but Playwright reports can
// produce `{ message: string }` for skipped tests. Normalize both forms at the
// connector boundary so an irrelevant skipped-test annotation cannot reject an
// otherwise valid pipeline report.
const PipelineTestOutputSchema = z.preprocess(
  (value) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { message?: unknown }).message === "string"
      ? (value as { message: string }).message
      : value,
  z.string().nullish(),
);

export const PipelineTestCaseSchema = z.looseObject({
  status: z.enum(TEST_CASE_STATUSES),
  name: z.string(),
  classname: z.string().nullish(),
  // Both are nullable in GitLab's real test-report payloads. `file` comes from
  // the JUnit testcase attribute; `attachment_url` is synthesized when GitLab
  // recognizes an attachment marker in system output.
  file: z.string().nullish(),
  attachment_url: z.string().nullish(),
  execution_time: z.number(),
  system_output: PipelineTestOutputSchema,
  stack_trace: PipelineTestOutputSchema,
});

export type PipelineTestCase = z.infer<typeof PipelineTestCaseSchema>;

export const PipelineTestReportSuiteSchema = z.looseObject({
  ...TestReportCountsSchema.shape,
  name: z.string(),
  suite_error: z.string().nullish().optional(),
  test_cases: z.array(PipelineTestCaseSchema),
});

export const PipelineTestReportSchema = z.looseObject({
  ...TestReportCountsSchema.shape,
  test_suites: z.array(PipelineTestReportSuiteSchema),
});

export type PipelineTestReport = z.infer<typeof PipelineTestReportSchema>;

export const JOB_STATUSES = [
  "created",
  "pending",
  "running",
  "failed",
  "success",
  "canceled",
  "canceling",
  "skipped",
  "manual",
  "waiting_for_resource",
] as const;

export const JobSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  stage: z.string(),
  status: z.enum(JOB_STATUSES),
  /**
   * Present only on failed jobs. `script_failure` versus `runner_system_failure`
   * is the difference between a real test break and infrastructure noise, so the
   * task reads it rather than treating every failure alike.
   */
  failure_reason: z.string().nullish(),
  /** True when the job failed but the pipeline passed anyway. */
  allow_failure: z.boolean().optional(),
  web_url: z.string(),
  ref: z.string().optional(),
  duration: z.number().nullish(),
  created_at: isoDate.optional(),
  started_at: isoDate.nullish(),
  finished_at: isoDate.nullish(),
});

export type Job = z.infer<typeof JobSchema>;

export const JobListSchema = z.array(JobSchema);

/** A job's log, already truncated by the client. */
export interface JobTrace {
  jobId: number;
  jobName: string;
  text: string;
  /** Byte length before truncation. */
  bytes: number;
  truncated: boolean;
}

/** Statuses that mean "this pipeline failed and a human should look". */
export const FAILED_PIPELINE_STATUS = "failed" as const;

export const MERGE_REQUEST_STATES = ["opened", "closed", "locked", "merged"] as const;

/**
 * Why a merge request cannot be merged right now, in GitLab's own words.
 *
 * Declared as a loose string rather than an enum: GitLab has added values here
 * across releases (`not_approved`, `jira_association_missing`, …) and a new one
 * must not fail the whole detail request — the UI shows it verbatim and only
 * `conflict` is branched on.
 */
export const MERGE_CONFLICT_STATUS = "conflict" as const;

export const MergeRequestSchema = z.looseObject({
  id: z.number(),
  iid: z.number(),
  project_id: z.number(),
  source_project_id: z.number().nullish(),
  target_project_id: z.number().nullish(),
  title: z.string(),
  state: z.enum(MERGE_REQUEST_STATES),
  source_branch: z.string(),
  target_branch: z.string(),
  sha: z.string().nullish(),
  web_url: z.string(),
  /** Optional rather than required only because older self-managed payloads omit it. */
  created_at: isoDate.optional(),
  updated_at: isoDate,
  /** Set once `state` is `merged`. The deploy watcher's baseline/watch split hinges on it. */
  merged_at: isoDate.nullish(),
  author: GitLabUserSchema.nullish(),
  /**
   * Markdown. Present on the single-MR endpoint and on list payloads; nullish
   * because an MR opened from the command line often has none at all.
   */
  description: z.string().nullish(),
  /** Who was asked to review, as distinct from who was assigned to fix it up. */
  reviewers: z.array(GitLabUserSchema).nullish(),
  assignees: z.array(GitLabUserSchema).nullish(),
  /**
   * Detail-endpoint only, and the reason the "address merge conflicts" button
   * can be offered honestly rather than always. GitLab computes it lazily, so
   * `false` on a freshly pushed branch can mean "not checked yet" — which is why
   * `detailed_merge_status` is read too.
   */
  has_conflicts: z.boolean().nullish(),
  /** `can_be_merged`, `conflict`, `checking`, `not_approved`, … — see `MERGE_CONFLICT_STATUS`. */
  detailed_merge_status: z.string().nullish(),
  /** The older, coarser field. Still the only one some self-managed versions send. */
  merge_status: z.string().nullish(),
  /** True once "merge when pipeline succeeds" has been requested and is still pending. */
  merge_when_pipeline_succeeds: z.boolean().nullish(),
  /** Latest pipeline for this MR's head commit, present on the detail endpoint. */
  head_pipeline: z
    .looseObject({
      id: z.number(),
      status: z.string(),
      web_url: z.string().nullish(),
    })
    .nullish(),
  /** False while any resolvable thread is still open, when the project requires them resolved. */
  blocking_discussions_resolved: z.boolean().nullish(),
  user_notes_count: z.number().nullish(),
  /** Modern GitLab list/detail field. Older payloads use `work_in_progress`. */
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  /**
   * Present on list payloads. `full` is `group/project!iid` — the only
   * namespaced path the global `/merge_requests` endpoint carries, which the
   * review container needs in order to clone.
   */
  references: z
    .looseObject({
      full: z.string().optional(),
    })
    .optional(),
  labels: z.array(z.string()).optional(),
});

export type MergeRequest = z.infer<typeof MergeRequestSchema>;

const MergeRequestNoteRangePointSchema = z.looseObject({
  old_line: z.number().nullish(),
  new_line: z.number().nullish(),
});

/**
 * Where a diff note is anchored. GitLab Duo commonly comments on a multi-line
 * selection, represented by `line_range`; keep both sides' coordinates because
 * a range may belong to either the old or new half of the diff.
 */
export const MergeRequestNotePositionSchema = z.looseObject({
  new_path: z.string().nullish(),
  old_path: z.string().nullish(),
  new_line: z.number().nullish(),
  old_line: z.number().nullish(),
  line_range: z
    .looseObject({
      start: MergeRequestNoteRangePointSchema,
      end: MergeRequestNoteRangePointSchema,
    })
    .nullish(),
});

export const MergeRequestDiscussionNoteSchema = z.looseObject({
  id: z.number(),
  body: z.string(),
  author: GitLabUserSchema,
  created_at: isoDate,
  updated_at: isoDate.optional(),
  system: z.boolean().optional(),
  resolvable: z.boolean().optional(),
  resolved: z.boolean().nullish(),
  /** Present on diff notes (a comment on a line); absent on plain MR comments. */
  position: MergeRequestNotePositionSchema.nullish(),
});

export type MergeRequestDiscussionNote = z.infer<
  typeof MergeRequestDiscussionNoteSchema
>;

export const MergeRequestDiscussionSchema = z.looseObject({
  id: z.string(),
  individual_note: z.boolean().optional(),
  notes: z.array(MergeRequestDiscussionNoteSchema),
});

export type MergeRequestDiscussion = z.infer<
  typeof MergeRequestDiscussionSchema
>;

export const MergeRequestDiscussionListSchema = z.array(
  MergeRequestDiscussionSchema,
);

/**
 * `group/project` path the review container clones with. GitLab's global MR
 * list has no `path_with_namespace`; it does include `references.full`
 * (`group/project!iid`) and `web_url`.
 */
export function mergeRequestProjectPath(mr: MergeRequest): string | undefined {
  const full = mr.references?.full?.trim();
  if (full) {
    const bang = full.lastIndexOf("!");
    if (bang > 0) return full.slice(0, bang);
  }
  try {
    const url = new URL(mr.web_url);
    const marker = "/-/merge_requests/";
    const idx = url.pathname.indexOf(marker);
    if (idx > 1) return decodeURIComponent(url.pathname.slice(1, idx));
  } catch {
    // not a URL
  }
  return undefined;
}

/**
 * Whether this merge request has conflicts, and whether GitLab actually knows.
 *
 * Three states rather than a boolean, because "not checked yet" is a real and
 * common answer: GitLab computes mergeability lazily, so a merge request looked
 * at seconds after a push reports `has_conflicts: false` with
 * `detailed_merge_status: "checking"` — indistinguishable from a clean branch if
 * this returned a boolean. An "Address merge conflicts" button that appears for
 * a branch GitLab has not looked at yet is worse than one that says "checking".
 *
 * `detailed_merge_status` is preferred over `has_conflicts` where both are
 * present: it is the field GitLab keeps current, and the older `merge_status`
 * (`cannot_be_merged`) is only consulted when neither newer field arrived.
 */
export function mergeRequestConflictState(
  mr: MergeRequest,
): "conflicts" | "clean" | "unknown" {
  const detailed = mr.detailed_merge_status;
  if (detailed === MERGE_CONFLICT_STATUS) return "conflicts";
  if (detailed === "checking" || detailed === "unchecked") return "unknown";
  if (mr.has_conflicts === true) return "conflicts";
  if (detailed != null) return "clean";
  // Pre-`detailed_merge_status` payloads. `cannot_be_merged` covers conflicts
  // *and* other blocks, so it is only trusted as "conflicts" alongside the
  // explicit flag — otherwise it is honestly unknown.
  if (mr.merge_status === "can_be_merged") return "clean";
  if (mr.has_conflicts === false) return "clean";
  return "unknown";
}

/**
 * Draft / WIP merge requests. GitLab sets `draft` (or the older
 * `work_in_progress`); titles still prefixed `Draft:` / `WIP:` count too.
 */
export function isDraftMergeRequest(mr: MergeRequest): boolean {
  if (mr.draft === true || mr.work_in_progress === true) return true;
  return /^(draft|wip)\s*:/i.test(mr.title.trim());
}

export const MergeRequestListSchema = z.array(MergeRequestSchema);

/** The response to creating a note — only the fields a caller needs back. */
export const MergeRequestNoteSchema = z.looseObject({
  id: z.number(),
  body: z.string(),
  created_at: isoDate,
});

export type MergeRequestNote = z.infer<typeof MergeRequestNoteSchema>;

/**
 * One file on `GET .../merge_requests/:iid/diffs` — the same hunks the GitLab
 * Changes tab shows, across every commit on the MR.
 */
export const MergeRequestDiffSchema = z.looseObject({
  old_path: z.string(),
  new_path: z.string(),
  diff: z.string().optional(),
  new_file: z.boolean().optional(),
  deleted_file: z.boolean().optional(),
  renamed_file: z.boolean().optional(),
  too_large: z.boolean().optional(),
});

export type MergeRequestDiff = z.infer<typeof MergeRequestDiffSchema>;

export const MergeRequestDiffListSchema = z.array(MergeRequestDiffSchema);

export const MergeRequestCommitSchema = z.looseObject({
  id: z.string(),
  short_id: z.string().optional(),
  title: z.string(),
  message: z.string().optional(),
  web_url: z.string().optional(),
  author_name: z.string().optional(),
  author_email: z.string().optional(),
  // Both optional because the two dates differ only on a rebased or cherry-picked
  // commit, and self-managed instances have shipped payloads without either.
  authored_date: z.string().optional(),
  committed_date: z.string().optional(),
});

export type MergeRequestCommit = z.infer<typeof MergeRequestCommitSchema>;

export const MergeRequestCommitListSchema = z.array(MergeRequestCommitSchema);

/**
 * `GET .../merge_requests/:iid/approvals`.
 *
 * Every field nullish: the endpoint exists on gitlab.com free but only reports
 * `approvals_required` on paid tiers, and some self-managed configurations 403 it
 * outright — which is why the provider treats a failure here as "no approval
 * information" rather than a failed detail request.
 */
export const MergeRequestApprovalsSchema = z.looseObject({
  approvals_required: z.number().nullish(),
  approvals_left: z.number().nullish(),
  approved_by: z
    .array(z.looseObject({ user: GitLabUserSchema }))
    .nullish(),
});

export type MergeRequestApprovals = z.infer<typeof MergeRequestApprovalsSchema>;

export const BranchSchema = z.looseObject({
  name: z.string(),
  default: z.boolean().optional(),
  /**
   * The branch head. Read by any agent job that intends to push: the write
   * policies lease their push against the sha the job started from, and a listing
   * is the cheapest place to learn it — `optional` because nothing else needs it
   * and an older GitLab omitting it should not fail the branch dropdown.
   */
  commit: z.looseObject({ id: z.string() }).optional(),
});

export type Branch = z.infer<typeof BranchSchema>;

export const BranchListSchema = z.array(BranchSchema);

/**
 * `POST .../repository/commits` — the commit the releases feature creates when
 * it edits the manifest. Only `id` and `web_url` are used; the rest of GitLab's
 * response is ignored by the loose object.
 */
export const CommitSchema = z.looseObject({
  id: z.string(),
  short_id: z.string().optional(),
  title: z.string().optional(),
  message: z.string().optional(),
  web_url: z.string().optional(),
});

export type Commit = z.infer<typeof CommitSchema>;

/**
 * `GET .../repository/commits` — one commit already in the repo's history, which
 * carries the authorship and date a freshly created commit's response does not.
 *
 * `parent_ids` is what tells a merge commit apart from a release commit: the
 * release history skips merges, because the commit they bring in is in the same
 * listing and would otherwise be reported twice.
 */
export const RepositoryCommitSchema = CommitSchema.extend({
  author_name: z.string().optional(),
  author_email: z.string().optional(),
  committed_date: z.string().optional(),
  created_at: z.string().optional(),
  parent_ids: z.array(z.string()).optional(),
});

export type RepositoryCommit = z.infer<typeof RepositoryCommitSchema>;

export const RepositoryCommitListSchema = z.array(RepositoryCommitSchema);

/**
 * `GET .../repository/commits/:sha/diff` — one file a commit touched, in the same
 * shape GitLab uses on a merge request's Changes tab (hence the reused schema).
 */
export const FileDiffSchema = MergeRequestDiffSchema;

export type FileDiff = MergeRequestDiff;

export const FileDiffListSchema = z.array(FileDiffSchema);

/**
 * `GET .../repository/tree` — one entry (a file or directory) in the repo tree.
 * The releases feature lists the root to discover environment folders, so only
 * `name`, `path` and `type` are needed.
 */
export const TreeEntrySchema = z.looseObject({
  id: z.string().optional(),
  name: z.string(),
  type: z.enum(["tree", "blob", "commit"]),
  path: z.string(),
});

export type TreeEntry = z.infer<typeof TreeEntrySchema>;

export const TreeEntryListSchema = z.array(TreeEntrySchema);
