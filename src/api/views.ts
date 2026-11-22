/**
 * JSON shapes the web UI consumes.
 *
 * Kept separate from the route handlers because these are a contract: the React
 * app is typed against them, and a field renamed here is a compile error there
 * rather than an `undefined` in a table cell.
 *
 * Dates cross as ISO strings. `Date` does not survive JSON, and a numeric epoch
 * reads as a mystery integer in a network inspector.
 */
import { z } from "zod";
import type * as ApiContract from "../../shared/api-contract.ts";
import {
  fieldNamesInScope,
  INTEGRATION_FIELD_NAMES,
  integrationField,
} from "../../shared/integrations.ts";
import type { App } from "../app.ts";
import { agentCapacitySnapshot } from "../infrastructure/agent/capacity.ts";
import { nextRunForTrigger } from "../config/croner-job.ts";
import type { ScheduledTask } from "../config/resolve-schedule.ts";
import { GITLAB_API_URL, GitLabConfigSchema } from "../connectors/gitlab/client.ts";
import {
  extractJiraIssueKey,
  jiraBrowseUrl,
  JiraConfigSchema,
} from "../connectors/jira/client.ts";
// Re-exported rather than redefined: both now live with the Jira connector, which
// is where "what a Jira key looks like" and "how a browse URL is built" belong —
// see `connectors/jira/client.ts`. The existing `./views.ts` import sites (and
// `graph-view.ts`) keep working unchanged.
export { extractJiraIssueKey, jiraBrowseUrl };
import type { Branch, GitLabProject, MergeRequest } from "../connectors/gitlab/types.ts";
import type { TaskExecutionRecord, StepRecord } from "../core/executor.ts";
import {
  describeField,
  describeParamsSchemaLoosely,
  type ParamField,
} from "../core/params-schema.ts";
import type { Task } from "../core/task.ts";
import type {
  DatadogArea,
  DatadogIssue,
  DatadogRoutingRule,
  DatadogServiceTarget,
  Feedback,
  FlakyTestRow,
  NotificationRecord,
  RegressionTestRecord,
  RegressionTestSource,
  ReleaseConfig,
  WorkSubject,
} from "../application/ports.ts";
import { datadogLogQuery } from "../connectors/datadog/client.ts";
import { slackReleaseChannel } from "../connectors/slack/client.ts";
import { severityRank } from "../application/datadog-triage.ts";
import type {
  ReleaseHistorySource,
  ReleaseManifestSource,
  ReleaseRevertPreview,
} from "../application/release-service.ts";
import {
  type PullRequest,
  type PullRequestChanges,
  type PullRequestDetail,
  type PullRequestListing,
  type PullRequestMergeability,
  type PullRequestScope,
  type PullRequestState,
  type PullRequestThread,
} from "../application/pull-requests.ts";
import { activePullRequestActions, type ActivePullRequestAction } from "./pull-request-actions.ts";
import { activeFixIssueActions } from "./ticket-actions.ts";
import {
  activeRegressionTests,
  regressionTestKey,
  regressionTestRefusal,
  regressionTestsByIssue,
  toRegressionTestView,
} from "./regression-test-actions.ts";
// The loop's own classifier, imported rather than reimplemented: a second
// definition of "flaky" here would let the page label a spec differently from the
// run that decided its fate.
import { CI_FAILURE_SOURCE, CI_FAILURE_TASK_ID } from "../tasks/ci-failure/index.ts";
import { DATADOG_SCAN_TASK_ID } from "../tasks/datadog-scan/index.ts";
import { WRITE_REGRESSION_TEST_TASK_ID } from "../tasks/write-regression-test/index.ts";
import { TRIAGE_DATADOG_ERROR_TASK_ID } from "../tasks/triage-datadog-error/index.ts";
import {
  DEFAULT_FLAKE_OPTIONS,
  judge,
  type FlakeOptions,
} from "../application/flake.ts";
import { logRocketFixRefusal } from "./logrocket-actions.ts";
import {
  datadogFixRefusal,
  datadogRegressionTestRefusal,
  datadogRegressionTestTarget,
  datadogScanRefusal,
  datadogScanTaskId,
  datadogServiceProjectPrefix,
  DATADOG_SERVICE_TARGET_BRANCH,
  explorerUrl,
  activeDatadogAiTriage,
} from "./datadog-actions.ts";
import type { AuthUser } from "../auth.ts";
import { PROMPT_TEMPLATES } from "../tasks/prompt-registry.ts";
import type { Visibility } from "../persistence/instance-store.ts";
import type { TaskRunMetrics, TaskRunSummary } from "../application/ports.ts";
import type { JiraSearchIssue, JiraUser } from "../connectors/jira/types.ts";
import { CONNECTORS, missingSecrets } from "../connectors/registry.ts";
import { ACTOR_SECRETS, KNOWN_SECRETS, type SecretStore } from "../secrets/secret-store.ts";
import { VERSION } from "../version.ts";

export interface TaskRunView {
  executionId: string;
  taskId: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: "running" | "success" | "failure" | "cancelled";
  dryRun: boolean;
  params?: unknown;
  itemsSeen?: number;
  itemsProcessed?: number;
  itemsSkipped?: number;
  error?: string;
  details?: Record<string, unknown>;
}

export interface StepView {
  stepId: string;
  startedAt: string;
  durationMs: number;
  status: "success" | "failure";
  attempts: number;
  error?: string;
}

/** One line from a run's logger, oldest first — the UI autoscrolls this. */
export interface LogLineView {
  /** Monotonic per-database cursor used to resume a live execution log. */
  id: number;
  ts: string;
  level: string;
  step?: string;
  message: string;
  meta?: Record<string, unknown>;
}

/** A task as the list needs it: enough to render a row without a second call. */
export interface TaskSummaryView {
  id: string;
  /** The task definition this instance was created from (equals `id` for a non-instantiated task). */
  definitionId: string;
  name: string;
  description?: string;
  /**
   * Never `"job"`: job handlers are invoked by the worker pool, not shown as
   * rows. `isListedTask` is what keeps them out.
   */
  kind: "task" | "loop";
  /** True if the UI may create new, separately-configured instances of this definition. */
  instantiable: boolean;
  paramsSchema: ParamField[];
  /**
   * Set only for a user-created instance; a code-registered task has no
   * `task_instances` row to read it from. Displayed only — see the migration
   * that introduced the column.
   */
  visibility?: Visibility;
  /** ISO instant. Set only for a user-created instance. */
  createdAt?: string;
  enabled: boolean;
  enabledOrigin: string;
  /** Null means manual-only, which is a valid configuration, not missing data. */
  schedule: string | null;
  /** ISO instant for a one-shot trigger. */
  onceAt?: string;
  /** ISO instant: cron jobs do not fire before this. */
  startAt?: string;
  timezone?: string;
  nextRun: string | null;
  /** Set when the cron expression itself is invalid, so the UI can show why. */
  scheduleError?: string;
  maxItemsPerRun: number;
  lastRun?: TaskRunView;
  stats: { total: number; successes: number; failures: number; avgDurationMs: number | null };
  openIssues: number;
  /** Jobs this loop enqueued that are queued or leased right now — not yet done or dead. */
  activeJobs: number;
  /**
   * The task is wired to a GitLab project — either its params schema has a
   * `gitlab.projectId` block, or stored params already name one. The list uses
   * this to swap the loop glyph for a GitLab logo.
   */
  usesGitLab: boolean;
  /**
   * The task files (or otherwise talks to) a Jira project — schema has a
   * `jira.project` block, or stored params already name one. Shown next to
   * the GitLab glyph when both are in play.
   */
  usesJira: boolean;
  /** Present when this instance is scoped to one GitLab merge request. */
  gitlabMr?: { iid: number; url: string };
  /** Present when a Jira issue is stored on the instance (or extracted from its MR). */
  jiraIssue?: { key: string; url?: string };
  /** Per-loop prompt template override. Null/undefined means use the global template. */
  promptTemplate?: string;
}

export interface TaskDetailView extends TaskSummaryView {
  watermark: string | null;
  events: { completed: number; claimed: number; failed: number };
  runs: TaskRunView[];
  issues: FiledIssueView[];
  /** The task's own stored schedule params, or {} if unset. */
  params: unknown;
  /** Whether `params` (and enabled/trigger/maxItemsPerRun) came from a stored row or the defaults. */
  paramsOrigin: string;
  /**
   * Last-run step graph. The current UI no longer renders this (it uses the
   * activity log instead), but a previously-built SPA still reads
   * `graph.executionId` on every detail page — omitting the field crashes it.
   */
  graph: {
    executionId?: string;
    startedAt?: string;
    nodes: unknown[];
    edges: unknown[];
  };
}

/**
 * One thing a loop is tracking, as a row in the task detail table.
 *
 * Still named for the filed ticket it was built to show, because the wire
 * contract and the SPA reading it are named that too — but it is now a
 * `work_subjects` row, so a review loop's rows are its merge requests and a
 * CI-failure loop's are its Jira tickets. `issueKey` is whatever the loop
 * produced for the subject (`TP-3012`, `!6193`).
 */
export interface FiledIssueView {
  issueKey: string;
  issueUrl?: string;
  subject: string;
  /** `metadata.author` from the loop that observed it — the MR/ticket author, when known. */
  author?: string;
  state: "open" | "closed";
  seenCount: number;
  filedAt: string;
  lastSeenAt: string;
}

export function toRunView(run: TaskRunSummary): TaskRunView {
  return {
    executionId: run.executionId,
    taskId: run.taskId,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString(),
    durationMs: run.durationMs,
    status: run.status,
    dryRun: run.dryRun,
    params: run.params,
    itemsSeen: run.itemsSeen,
    itemsProcessed: run.itemsProcessed,
    itemsSkipped: run.itemsSkipped,
    error: run.error,
    details: run.details,
  };
}

function toRunViewsWithChildren(app: App, runs: readonly TaskRunSummary[]): TaskRunView[] {
  const children = app.jobs.byParents(runs.map((run) => run.executionId));
  return runs.map((run) => {
    const view = toRunView(run);
    const jobs = children.get(run.executionId);
    if (!jobs?.length) return view;
    const childRuns = {
      total: jobs.length,
      queued: jobs.filter((job) => job.status === "queued").length,
      running: jobs.filter((job) => job.status === "leased").length,
      succeeded: jobs.filter((job) => job.status === "done").length,
      failed: jobs.filter((job) => job.status === "dead").length,
      executions: jobs.flatMap((job) => job.executionId ? [job.executionId] : []),
    };
    return { ...view, details: { ...view.details, childRuns } };
  });
}

export function toStepView(step: StepRecord): StepView {
  return {
    stepId: step.stepId,
    startedAt: step.startedAt.toISOString(),
    durationMs: step.durationMs,
    status: step.status,
    attempts: step.attempts,
    error: step.error,
  };
}

export function toLogLineView(line: {
  id?: number;
  ts: Date;
  level: string;
  step?: string;
  message: string;
  meta?: Record<string, unknown>;
}): LogLineView {
  return {
    // Persisted run-log reads always provide this. Keep the fallback only for
    // adapter compatibility while callers migrate off in-memory lines.
    id: line.id ?? 0,
    ts: line.ts.toISOString(),
    level: line.level,
    step: line.step,
    message: line.message,
    meta: line.meta,
  };
}

function toIssueView(subject: WorkSubject): FiledIssueView {
  // `metadata.title` is the MR/ticket title a loop stored when it observed the
  // subject (see `review-requested/index.ts`'s `observe` call) — far more
  // useful in the Tracked table than the raw subject key
  // (`gitlab:mr:group/project!123`), which is what's left when a loop
  // recorded no title.
  const title = subject.metadata?.title;
  const author = subject.metadata?.author;
  return {
    // A subject with nothing produced for it yet still deserves a row; falling
    // back to the key keeps the cell from rendering blank.
    issueKey: subject.externalRef ?? subject.subjectKey,
    issueUrl: subject.externalUrl,
    subject: typeof title === "string" && title.length > 0 ? title : subject.subjectKey,
    author: typeof author === "string" && author.length > 0 ? author : undefined,
    state: subject.state,
    seenCount: subject.seenCount,
    filedAt: subject.firstSeenAt.toISOString(),
    lastSeenAt: subject.lastSeenAt.toISOString(),
  };
}

/** Backs the "choose merge requests" autocomplete in the Add-task dialog. */
export interface MergeRequestView {
  iid: number;
  title: string;
  sourceBranch: string;
  webUrl: string;
}

export function toMergeRequestView(mr: MergeRequest): MergeRequestView {
  return { iid: mr.iid, title: mr.title, sourceBranch: mr.source_branch, webUrl: mr.web_url };
}

/** One entry in the Add-task panel's repository dropdown. */
export interface GitLabProjectView {
  pathWithNamespace: string;
  webUrl: string;
}

export function toGitLabProjectView(project: GitLabProject): GitLabProjectView {
  return { pathWithNamespace: project.path_with_namespace, webUrl: project.web_url };
}

/** Backs the "Branch" scope's dropdown. */
export interface BranchView {
  name: string;
}

export function toBranchView(branch: Branch): BranchView {
  return { name: branch.name };
}

/** Backs the "Issue" scope's Jira autocomplete. */
export interface JiraIssueView {
  key: string;
  summary?: string;
}

export function toJiraIssueView(issue: JiraSearchIssue): JiraIssueView {
  return { key: issue.key, summary: issue.fields?.summary };
}

export interface JiraUserView {
  accountId: string;
  displayName: string;
  email?: string;
}

export function toJiraUserView(user: JiraUser): JiraUserView {
  return {
    accountId: user.accountId,
    displayName: user.displayName?.trim() || user.emailAddress?.trim() || user.accountId,
    ...(user.emailAddress ? { email: user.emailAddress } : {}),
  };
}

/**
 * One row on the Pull requests page. Forge-neutral by the time it gets here —
 * `provider` is a label, not a branch in the UI's logic.
 */
export interface PullRequestView {
  provider: string;
  id: string;
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
  activeAction?: { action: ApiContract.PullRequestActionId; status: "queued" | "running" };
}

export interface PullRequestsView {
  scope: PullRequestScope;
  states: PullRequestState[];
  repositoryFilter: string[];
  pullRequests: PullRequestView[];
  unavailable: { provider: string; label: string; missing: string[] }[];
  failed: { provider: string; label: string; message: string }[];
}

/** GET/PUT `/api/me/pull-request-repos`. */
export interface PullRequestRepoFilterView {
  repositories: string[];
}

export function toPullRequestRepoFilterView(repositories: string[]): PullRequestRepoFilterView {
  return { repositories };
}

/**
 * Whether releases can be announced, and where.
 *
 * Read from the instance-wide secrets rather than the acting developer's: the
 * announcing app is a team setting — see `SlackReleaseNotifierDeps`.
 */
export function toReleaseSlackState(
  secrets: SecretStore,
): { slackConfigured: boolean; slackChannel?: string } {
  const token = secrets.get("SLACK_BOT_TOKEN");
  const channel = slackReleaseChannel(secrets);
  return {
    slackConfigured: token != null && token !== "" && channel != null,
    ...(channel ? { slackChannel: channel } : {}),
  };
}

export function toReleasesView(
  source: ReleaseManifestSource,
  slack: { slackConfigured: boolean; slackChannel?: string },
): ApiContract.ReleasesView {
  return {
    configured: true,
    projectId: source.projectId,
    manifestPath: source.manifestPath,
    targetBranch: source.targetBranch,
    ...slack,
    environments: source.environments.map((env) => ({
      name: env.name,
      services: env.services.map((s) => ({
        name: s.name,
        version: s.version,
        section: s.section,
        ...(s.image ? { image: s.image } : {}),
      })),
    })),
  };
}

/** GET /api/releases/history — past deployments, newest first. */
export function toReleaseHistoryView(
  source: ReleaseHistorySource,
): ApiContract.ReleaseHistoryView {
  return {
    configured: true,
    projectId: source.projectId,
    targetBranch: source.targetBranch,
    environments: source.environments,
    commitsScanned: source.commitsScanned,
    entries: source.deployments.map(toReleaseHistoryEntryView),
  };
}

function toReleaseHistoryEntryView(
  deployment: ReleaseHistorySource["deployments"][number],
): ApiContract.ReleaseHistoryEntryView {
  return {
    environment: deployment.environment,
    sha: deployment.sha,
    shortSha: deployment.shortSha,
    title: deployment.title,
    authorName: deployment.authorName,
    authorEmail: deployment.authorEmail,
    committedAt: deployment.committedAt.toISOString(),
    webUrl: deployment.webUrl,
    changes: deployment.changes.map((change) => ({
      service: change.service,
      ...(change.section ? { section: change.section } : {}),
      from: change.from,
      to: change.to,
    })),
  };
}

export function toReleaseRevertPreviewView(
  preview: ReleaseRevertPreview,
): ApiContract.ReleaseRevertPreviewView {
  return {
    environment: preview.deployment.environment,
    deployment: toReleaseHistoryEntryView(preview.deployment),
    changes: preview.changes.map((change) => {
      const deployed = preview.deployment.changes.find(
        (candidate) =>
          candidate.service === change.service &&
          (candidate.section == null || candidate.section === change.section),
      )!;
      return {
        service: change.service,
        section: change.section,
        from: deployed.to,
        to: change.version,
      };
    }),
  };
}

/**
 * GET /api/releases/watches — every production release the watcher has opened,
 * newest first, with the error signatures it found in each.
 *
 * Unfiltered by project on purpose: an install with one releases repo has one
 * project id anyway, and filtering would only cost a param nobody asked for yet.
 */
export function toDeployWatchesView(app: App): ApiContract.DeployWatchesView {
  return {
    watches: app.deployWatches.list().map((watch) => ({
        id: watch.id,
        environment: watch.environment,
        releaseKind: watch.releaseKind,
        releaseLabel:
          watch.releaseKind === "merge-request"
            ? `!${watch.mrIid}`
            : `commit ${watch.commitSha?.slice(0, 8) ?? ""}`.trim(),
        releaseUrl:
          (watch.releaseKind === "merge-request" ? watch.mrUrl : watch.commitUrl) ?? "",
        mrIid: watch.mrIid ?? null,
        mrUrl: watch.mrUrl ?? null,
        commitSha: watch.commitSha ?? null,
        commitUrl: watch.commitUrl ?? null,
        services: watch.services,
        actorEmail: watch.actorId ? (app.auth.byId(watch.actorId)?.email ?? null) : null,
        state: watch.state,
        openedAt: watch.openedAt.toISOString(),
        mergedAt: watch.mergedAt?.toISOString() ?? null,
        watchUntil: watch.watchUntil?.toISOString() ?? null,
        findings: app.deployWatches.findings(watch.id).map((finding) => ({
          source: finding.source,
          service: finding.service ?? null,
          signature: finding.signature,
          eventCount: finding.eventCount,
          externalUrl: finding.externalUrl ?? null,
          issueType: finding.issueType ?? null,
          sampleMessage: finding.sampleMessage ?? null,
          firstSeenAt: finding.firstSeenAt.toISOString(),
          createdAt: finding.createdAt.toISOString(),
        })),
      })),
  };
}

export function toReleaseConfigView(config: ReleaseConfig | null): ApiContract.ReleaseConfigView {
  return {
    configured: config != null,
    projectId: config?.projectId ?? "",
    manifestPath: config?.manifestPath ?? "",
    targetBranch: config?.targetBranch ?? "",
  };
}

/**
 * Every integration field's state, for Settings → Integrations.
 *
 * `origin` is computed from both layers rather than reported by the store,
 * because "is there an override" and "is anything in effect" are different
 * questions and the page needs both: an override that exists but cannot be
 * decrypted is stored, not effective, and only `env` can say what would answer
 * instead. Secret values never appear — `app.env.get` is consulted for
 * *presence* only.
 */
export function toIntegrationsView(app: App): ApiContract.IntegrationsView {
  const stored = new Map(app.integrationConfig.list().map((s) => [s.name, s]));

  return {
    secretsEnabled: app.integrationConfig.secretsEnabled,
    fields: INTEGRATION_FIELD_NAMES.map((name) => {
      const override = stored.get(name);
      const field = integrationField(name);
      const inEnv = app.env.get(name) != null;
      const effective = override != null && override.unreadable !== true;

      return {
        name,
        origin: effective ? "override" : inEnv ? "environment" : "unset",
        // A non-secret override is echoed back so the input shows what is
        // configured; a token is not, and the field's own `secret` flag decides
        // rather than the presence of a value.
        value: field?.secret === false ? (override?.value ?? null) : null,
        updatedAt: override?.updatedAt.toISOString() ?? null,
        ...(override?.unreadable ? { unreadable: true } : {}),
      };
    }),
  };
}

/**
 * One developer's own credentials, for My provider access.
 *
 * The counterpart of `toIntegrationsView`, and it reports the same two layers
 * from the other end: what *you* have stored, and — when you have not — whether
 * the shared account behind you can answer at all. That second half is the
 * reason this is not just `credentials.list()`. "No token stored" and "no token
 * stored and nothing to fall back on" look identical in a list of names, and
 * only one of them means your next run fails.
 *
 * Values never cross for a secret field. A non-secret one (the Jira account
 * email) does, because a typo in an email you cannot read back is otherwise
 * invisible — and it is not scrubbed from the logs either, for the same reason.
 */
export function toProviderAccessView(
  app: App,
  user: AuthUser,
): ApiContract.ProviderAccessView {
  const mine = new Map(app.credentials.list(user.id).map((row) => [row.name, row]));
  const slack = app.slackConnections.describe(user.id);

  return {
    enabled: app.credentials.enabled,
    supported: [...ACTOR_SECRETS],
    slack: slack
      ? {
          configured: !slack.unreadable,
          storable: app.slackConnections.secretsEnabled,
          workspaceId: slack.teamId,
          ...(slack.teamName ? { workspaceName: slack.teamName } : {}),
          userId: slack.slackUserId,
          ...(slack.slackUserName ? { userName: slack.slackUserName } : {}),
          connectedAt: slack.connectedAt.toISOString(),
          groupDmsEnabled:
            slack.scopes.includes("mpim:read") && slack.scopes.includes("mpim:history"),
          liveUpdatesConfigured: !!app.secrets.get("SLACK_APP_TOKEN")?.trim(),
          reliableUnreadEnabled: slack.scopes.includes("search:read"),
          postingEnabled: slack.scopes.includes("chat:write"),
          reactionsEnabled: slack.scopes.includes("reactions:write"),
          imageUploadsEnabled:
            slack.scopes.includes("files:read") && slack.scopes.includes("files:write"),
          readSyncAvailable: [
            "channels:write",
            "groups:write",
            "im:write",
            "mpim:write",
          ].every((scope) => slack.scopes.includes(scope)),
          ...(slack.unreadable ? { unreadable: true } : {}),
        }
      : {
          configured: false,
          storable: app.slackConnections.secretsEnabled,
          liveUpdatesConfigured: !!app.secrets.get("SLACK_APP_TOKEN")?.trim(),
        },
    fields: fieldNamesInScope("user").map((name) => {
      const stored = mine.get(name);
      const field = integrationField(name);
      // Decrypting to find out: the store has no "is this readable" question, and
      // a credential this process cannot decrypt is stored without being in
      // effect — which is the one state that looks like a working one otherwise.
      let value: string | undefined;
      let unreadable = false;
      if (stored) {
        try {
          value = app.credentials.get(user.id, name);
          unreadable = value == null;
        } catch {
          unreadable = true;
        }
      }
      const effective = stored != null && !unreadable;
      // The shared layer, exactly as the settings page computes it: a readable
      // instance override, or `config/.env` behind it.
      const sharedValue = app.integrationConfig.all()[name];
      const shared = (sharedValue != null && sharedValue !== "") || app.env.get(name) != null;

      return {
        name,
        origin: effective ? "user" : shared ? "shared" : "unset",
        value: field?.secret === false && effective ? (value ?? null) : null,
        updatedAt: stored?.updatedAt.toISOString() ?? null,
        ...(unreadable ? { unreadable: true } : {}),
      };
    }),
  };
}

/**
 * Everything the two error pages need to say about regression tests, read once.
 *
 * Bundled into one object rather than passed as two arguments because it is
 * threaded three levels down (`toDatadogIssuesView` → `toDatadogServiceViews` →
 * `toDatadogProblemView`), and read once per request rather than per row: a page
 * with forty problems on it must not run forty queue scans.
 */
interface RegressionTestLookup {
  records: ReadonlyMap<string, RegressionTestRecord>;
  inFlight: ReadonlySet<string>;
}

function regressionTestLookup(app: App): RegressionTestLookup {
  return { records: regressionTestsByIssue(app), inFlight: activeRegressionTests(app) };
}

/**
 * The two regression-test fields for one row, given every issue id it covers.
 *
 * Takes a list rather than one id because a Datadog problem groups several
 * signatures and the attempt was recorded against whichever one was chosen at the
 * time — the same reason `filed` searches all members for a Jira key. First match
 * wins, in the caller's order, which is loudest first.
 */
function regressionTestFieldsFor(
  lookup: RegressionTestLookup,
  source: RegressionTestSource,
  issueIds: readonly string[],
): {
  regressionTest: ApiContract.RegressionTestView | null;
  regressionTestInFlight: boolean;
} {
  let record: RegressionTestRecord | undefined;
  let inFlight = false;
  for (const id of issueIds) {
    const key = regressionTestKey(source, id);
    record ??= lookup.records.get(key);
    if (lookup.inFlight.has(key)) inFlight = true;
  }
  return {
    regressionTest: record ? toRegressionTestView(record) : null,
    regressionTestInFlight: inFlight,
  };
}

/**
 * The LogRocket page: the issues we were told about, plus the page's setup state.
 *
 * The setup half is not decoration. LogRocket exposes no way to list issues, so
 * an empty table is ambiguous in a way an empty pull request list is not — it can
 * mean "nothing is broken" or "no alert has ever arrived because nobody pasted the
 * URL". The view answers that, including the URL to paste.
 */
export function toLogRocketIssuesView(
  app: App,
  user: AuthUser,
  options?: { includeDismissed?: boolean },
): ApiContract.LogRocketIssuesView {
  const webhookSecret = app.secrets.get("LOGROCKET_WEBHOOK_SECRET");
  const inFlight = new Set(activeFixIssueActions(app).map((action) => action.issueKey));
  const tests = regressionTestLookup(app);

  return {
    enabled: app.secrets.get("LOGROCKET_API_KEY") != null,
    webhookConfigured: webhookSecret != null,
    // The secret is in the path, so showing the URL means showing it. Acceptable
    // and necessary: this response needs a session, the operator typed the secret
    // in the first place, and a URL you cannot see is a URL you cannot paste.
    webhookPath: webhookSecret
      ? `/webhooks/logrocket/${encodeURIComponent(webhookSecret)}`
      : null,
    fixRefusal: logRocketFixRefusal(app, user),
    regressionTestRefusal: regressionTestRefusal(app, user),
    includesDismissed: options?.includeDismissed === true,
    issues: app.logRocketIssues
      .list({ includeDismissed: options?.includeDismissed === true })
      .map((issue) => ({
      id: issue.id,
      issueType: issue.issueType ?? null,
      title: issue.title,
      label: issue.label ?? null,
      description: issue.description ?? null,
      summary: issue.summary ?? null,
      userImpact: issue.userImpact ?? null,
      url: issue.url ?? null,
      screenshotUrl: issue.screenshotUrl ?? null,
      sessionCount: issue.sessionCount ?? null,
      sessionRate: issue.sessionRate ?? null,
      firstSeenAt: issue.firstSeenAt?.toISOString() ?? null,
      lastAlertAt: issue.lastAlertAt.toISOString(),
      alertCount: issue.alertCount,
      state: issue.state,
      jiraIssueKey: issue.jiraIssueKey ?? null,
      jiraIssueUrl: issue.jiraIssueKey
        ? (jiraBrowseUrl(app.secrets, issue.jiraIssueKey) ?? null)
        : null,
      fixInFlight: issue.jiraIssueKey ? inFlight.has(issue.jiraIssueKey) : false,
      ...regressionTestFieldsFor(tests, "logrocket", [issue.id]),
    })),
  };
}

/**
 * The Datadog page: the clustered issues, worst first, plus the page's own state.
 *
 * The setup half matters here for the same reason it does on the LogRocket page,
 * with a different ambiguity to resolve. Nothing is pushed to us — the list is
 * whatever the last daily scan recorded — so an empty table can mean "no token",
 * "no scan has run yet" or "a clean day", and `enabled`/`lastScanAt` are how the
 * page tells the three apart instead of showing the same shrug for all of them.
 *
 * `query` is echoed for a subtler reason: everything on this page is scoped to one
 * log search, and a person looking at four rows deserves to know they are four
 * rows *of `status:error env:prod` minus the exclusions*, not of everything Datadog
 * holds.
 */
export function toDatadogIssuesView(
  app: App,
  user: AuthUser,
  options?: { includeDismissed?: boolean; team?: string; area?: DatadogArea },
): ApiContract.DatadogIssuesView {
  const inFlight = new Set(activeFixIssueActions(app).map((action) => action.issueKey));
  const tests = regressionTestLookup(app);
  const triageInFlight = activeDatadogAiTriage(app);
  const issues = app.datadogIssues.list({
    includeDismissed: options?.includeDismissed === true,
    ...(options?.team ? { team: options.team } : {}),
    ...(options?.area ? { area: options.area } : {}),
  });
  const facets = app.datadogIssues.facets();

  // The freshest scan across every issue, filters included or not: this is the
  // page's "as of", and computing it from a filtered list would make it move when
  // somebody clicked a chip.
  const lastScanAt = app.datadogIssues
    .list({ includeDismissed: true })
    .reduce<Date | null>(
      (latest, issue) =>
        latest == null || issue.lastScanAt > latest ? issue.lastScanAt : latest,
      null,
    );

  return {
    enabled: app.secrets.get("DATADOG_TOKEN") != null,
    query: datadogLogQuery(app.secrets),
    lastScanAt: lastScanAt?.toISOString() ?? null,
    fixRefusal: datadogFixRefusal(app, user),
    regressionTestRefusal: app.taskRegistry.get("write-regression-test")
      ? null
      : "No task is registered to write regression tests on this server.",
    scanRefusal: datadogScanRefusal(app),
    teams: facets.teams,
    areas: facets.areas,
    includesDismissed: options?.includeDismissed === true,
    services: toDatadogServiceViews(app, user, issues, inFlight, tests, triageInFlight),
    issues: issues.map((issue) => toDatadogIssueView(app, issue, inFlight)),
  };
}

/**
 * The Flaky specs page: what the CI-failure loop chose not to file, and why.
 *
 * The verdict is computed here from the same `judge` the loop uses rather than
 * stored alongside the rows. Two reasons: the thresholds are per-instance config an
 * operator can change, and a stored verdict would then be a claim about a rule that
 * no longer exists — and a stale label on this page is worse than no page, because
 * the whole point is deciding what to trust.
 */
export function toFlakySpecsView(
  app: App,
  options?: { includeDismissed?: boolean; project?: string },
): ApiContract.FlakySpecsView {
  // The thresholds as some instance of the loop actually has them. Any instance
  // will do when there are several: they share one history table, and showing one
  // instance's numbers is honest in a way showing the schema defaults is not.
  const instance = app
    .scheduledTasks()
    .find(
      (scheduled) =>
        scheduled.id === CI_FAILURE_TASK_ID ||
        app.instances.get(scheduled.id)?.definitionId === CI_FAILURE_TASK_ID,
    );
  const params = (instance?.params ?? {}) as Partial<FlakeOptions>;
  const flakeOptions: FlakeOptions = { ...DEFAULT_FLAKE_OPTIONS, ...params };

  const rows = app.testRunHistory.listFlaky({
    source: CI_FAILURE_SOURCE,
    includeDismissed: options?.includeDismissed === true,
    window: flakeOptions.historyWindow,
    ...(options?.project ? { project: options.project } : {}),
  });

  return {
    enabled: instance != null,
    window: flakeOptions.historyWindow,
    quarantineFlakeRate: flakeOptions.quarantineFlakeRate,
    failuresBeforeFiling: flakeOptions.failuresBeforeFiling,
    includesDismissed: options?.includeDismissed === true,
    fileRefusal:
      instance == null
        ? "No GitLab CI failure loop is configured on this server, so nothing would " +
          "file the ticket."
        : null,
    specs: rows.map((row) => toFlakySpecView(app, row, flakeOptions)),
  };
}

function toFlakySpecView(
  app: App,
  row: FlakyTestRow,
  flakeOptions: FlakeOptions,
): ApiContract.FlakySpecView {
  const assessment = judge(
    {
      observed: row.observed,
      failed: row.failed,
      consecutiveFailures: row.consecutiveFailures,
      ...(row.lastPassedRunId != null ? { lastPassedRunId: row.lastPassedRunId } : {}),
      suiteFailedToRun: row.lastSuiteFailedToRun,
    },
    flakeOptions,
  );

  // Pipeline ids on this contract are numbers, kept that way for the page — the
  // generic store's `runId` is a string because a future producer's run
  // identifier need not be numeric, but `gitlab-ci-failure` always writes its
  // own pipeline id, so the round trip back to a number is exact.
  const lastFailedPipelineId = Number(row.lastFailedRunId);
  const lastPassedPipelineId = row.lastPassedRunId != null ? Number(row.lastPassedRunId) : null;

  return {
    project: row.project,
    specFile: row.testId,
    name: row.testId.split("/").pop() ?? row.testId,
    verdict: assessment.verdict,
    observed: assessment.observed,
    failed: assessment.failed,
    flakeRate: assessment.flakeRate,
    consecutiveFailures: assessment.consecutiveFailures,
    firstFailedAt: row.firstFailedAt.toISOString(),
    lastFailedAt: row.lastFailedAt.toISOString(),
    lastFailedPipelineId,
    lastPassedPipelineId,
    lastSignature: row.lastSignature ?? null,
    lastSuiteFailedToRun: row.lastSuiteFailedToRun,
    quarantine: assessment.quarantine,
    quarantineSuggestedAt: row.quarantineSuggestedAt?.toISOString() ?? null,
    state: row.state,
    lastFailedPipelineUrl: pipelineUrl(app, row.project, lastFailedPipelineId),
  };
}

/**
 * A pipeline's page on GitLab, built from the project path.
 *
 * Null for a numeric project id: `/-/pipelines/:id` needs the *path*, and a
 * fabricated link that 404s is worse than no link. Every instance of the loop this
 * was built for configures a path.
 */
function pipelineUrl(app: App, project: string, pipelineId: number): string | null {
  if (/^\d+$/.test(project)) return null;
  const base = app.secrets.get("GITLAB_API_URL") ?? GITLAB_API_URL;
  try {
    return `${new URL(base).origin}/${project}/-/pipelines/${pipelineId}`;
  } catch {
    return null;
  }
}

/**
 * The tree: service → root cause → signature.
 *
 * Built here rather than by the scan because it has to be built from whatever the
 * filters left. Narrowing to one team can leave a problem holding three of its five
 * signatures, and the row has to describe the three it can see rather than claim
 * five and hand the page ids it was not sent.
 *
 * Rows written before problem grouping existed have no `problemKey`. They fall back
 * to a problem of one keyed by their own id, which renders as a signature that is
 * its own root cause — true, as far as anything knows.
 */
function toDatadogServiceViews(
  app: App,
  user: AuthUser,
  issues: readonly DatadogIssue[],
  inFlight: ReadonlySet<string>,
  tests: RegressionTestLookup,
  triageInFlight: ReadonlySet<string>,
): ApiContract.DatadogServiceView[] {
  const byProblem = new Map<string, DatadogIssue[]>();
  for (const issue of issues) {
    const key = issue.problemKey ?? `issue:${issue.id}`;
    const members = byProblem.get(key);
    if (members) members.push(issue);
    else byProblem.set(key, [issue]);
  }

  const byService = new Map<string, ApiContract.DatadogProblemView[]>();
  for (const [key, members] of byProblem) {
    const problem = toDatadogProblemView(
      app,
      user,
      key,
      members,
      inFlight,
      tests,
      triageInFlight,
    );
    // New scans make the service part of problem identity. The primary member is
    // still used here so legacy rows remain renderable until the next scan.
    const service = problem.service ?? "";
    const problems = byService.get(service);
    if (problems) problems.push(problem);
    else byService.set(service, [problem]);
  }

  const services = [...byService.entries()].map(([service, problems]) => {
    const ordered = [...problems].sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) || b.eventCount - a.eventCount,
    );
    const loudest = [...problems].sort((a, b) => b.eventCount - a.eventCount)[0]!;
    return {
      service: service || null,
      // Summed, unlike within a problem: two root causes in one service are two
      // separate sets of failures, and adding them is the whole point of a rollup.
      eventCount: problems.reduce((total, problem) => total + problem.eventCount, 0),
      problemCount: problems.length,
      severity: ordered[0]!.severity,
      area: loudest.area,
      team: loudest.team,
      problems: ordered,
    };
  });

  // Worst first, then loudest — the same order as the rows inside them, so opening a
  // service does not reshuffle the reasoning that got you there.
  return services.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) || b.eventCount - a.eventCount,
  );
}

function toDatadogProblemView(
  app: App,
  user: AuthUser,
  key: string,
  members: readonly DatadogIssue[],
  inFlight: ReadonlySet<string>,
  tests: RegressionTestLookup,
  triageInFlight: ReadonlySet<string>,
): ApiContract.DatadogProblemView {
  const ordered = [...members].sort((a, b) => b.eventCount - a.eventCount);
  const primary = ordered[0]!;
  const worst = [...members].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
  )[0]!;
  // Any member's ticket is the problem's ticket: filing links all of them, so this
  // only differs from "the primary's" for a problem whose membership changed after
  // it was filed.
  const filed = ordered.find((issue) => issue.jiraIssueKey);
  const triage = ordered
    .map((issue) => app.datadogAiTriage.get(issue.id))
    .find((record) => record != null);
  const target = datadogRegressionTestTarget(app, user, primary.service);

  return {
    key,
    title: primary.problemTitle ?? primary.title,
    service: primary.service ?? null,
    severity: worst.severity,
    area: primary.area,
    team: primary.team ?? null,
    // The stored problem estimate when the scan computed one, which is the max
    // across *all* members — including any the current filters removed. Falling back
    // to the max of what is here keeps a legacy row honest rather than zero.
    eventCount: primary.problemEventCount ?? primary.eventCount,
    previousEventCount:
      ordered.reduce<number | null>(
        (most, issue) =>
          issue.previousEventCount != null && (most == null || issue.previousEventCount > most)
            ? issue.previousEventCount
            : most,
        null,
      ) ?? null,
    alsoIn: [
      ...new Set(
        ordered
          .map((issue) => issue.service)
          .filter((service): service is string => !!service && service !== primary.service),
      ),
    ],
    issueIds: ordered.map((issue) => issue.id),
    firstSeenAt: new Date(
      Math.min(...ordered.map((issue) => issue.firstSeenAt.getTime())),
    ).toISOString(),
    lastSeenAt: new Date(
      Math.max(...ordered.map((issue) => issue.lastSeenAt.getTime())),
    ).toISOString(),
    scanCount: Math.max(...ordered.map((issue) => issue.scanCount)),
    // A problem is dismissed only when all of it is: one member still logging is
    // still a problem, and hiding it because a sibling was dismissed would lose it.
    state: ordered.every((issue) => issue.state === "dismissed")
      ? "dismissed"
      : filed
        ? "linked"
        : "open",
    jiraIssueKey: filed?.jiraIssueKey ?? null,
    jiraIssueUrl: filed?.jiraIssueKey
      ? (jiraBrowseUrl(app.secrets, filed.jiraIssueKey) ?? null)
      : null,
    fixInFlight: filed?.jiraIssueKey ? inFlight.has(filed.jiraIssueKey) : false,
    // Every member, loudest first: the attempt was recorded against whichever
    // signature was chosen when it ran, which is not necessarily today's primary.
    ...regressionTestFieldsFor(
      tests,
      "datadog",
      ordered.map((issue) => issue.id),
    ),
    regressionTestTarget: target,
    regressionTestRefusal: datadogRegressionTestRefusal(app, user, primary.service),
    aiTriage: triage
      ? {
          verdict: triage.verdict,
          confidence: triage.confidence,
          rationale: triage.rationale,
          recommendation: triage.recommendation,
          taskRunId: triage.taskRunId,
          updatedAt: triage.updatedAt.toISOString(),
        }
      : null,
    aiTriageInFlight: ordered.some((issue) => triageInFlight.has(issue.id)),
    aiTriageRefusal: !app.taskRegistry.get(TRIAGE_DATADOG_ERROR_TASK_ID)
      ? "No Datadog AI triage task is registered."
      : target
        ? null
        : `Configure a repository for ${primary.service ?? "this service"} in Datadog → Settings first.`,
    explorerUrl: explorerUrl(app, primary),
  };
}

export function toDatadogIssueView(
  app: App,
  issue: DatadogIssue,
  inFlight: ReadonlySet<string>,
): ApiContract.DatadogIssueView {
  return {
    id: issue.id,
    service: issue.service ?? null,
    signature: issue.signature,
    title: issue.title,
    severity: issue.severity,
    area: issue.area,
    team: issue.team ?? null,
    routedBy: issue.routedBy ?? null,
    eventCount: issue.eventCount,
    previousEventCount: issue.previousEventCount ?? null,
    sampleCount: issue.sampleCount,
    sampleSize: issue.sampleSize,
    status: issue.status ?? null,
    env: issue.env ?? null,
    source: issue.source ?? null,
    host: issue.host ?? null,
    kubeNamespace: issue.kubeNamespace ?? null,
    sampleMessage: issue.sampleMessage ?? null,
    sampleStack: issue.sampleStack ?? null,
    explorerUrl: explorerUrl(app, issue),
    firstSeenAt: issue.firstSeenAt.toISOString(),
    lastSeenAt: issue.lastSeenAt.toISOString(),
    lastScanAt: issue.lastScanAt.toISOString(),
    scanCount: issue.scanCount,
    state: issue.state,
    jiraIssueKey: issue.jiraIssueKey ?? null,
    jiraIssueUrl: issue.jiraIssueKey
      ? (jiraBrowseUrl(app.secrets, issue.jiraIssueKey) ?? null)
      : null,
    fixInFlight: issue.jiraIssueKey ? inFlight.has(issue.jiraIssueKey) : false,
  };
}

export function toDatadogRoutingView(app: App): ApiContract.DatadogRoutingView {
  return { rules: app.datadogRouting.list().map(toDatadogRoutingRuleView) };
}

export function toDatadogRoutingRuleView(
  rule: DatadogRoutingRule,
): ApiContract.DatadogRoutingRuleView {
  return {
    id: rule.id,
    priority: rule.priority,
    facet: rule.facet,
    pattern: rule.pattern,
    action: rule.action,
    team: rule.team ?? null,
    area: rule.area ?? null,
    jiraProject: rule.jiraProject ?? null,
    note: rule.note ?? null,
    updatedAt: rule.updatedAt.toISOString(),
  };
}

export function toDatadogServiceTargetsView(
  app: App,
): ApiContract.DatadogServiceTargetsView {
  const services = [
    ...new Set(
      app.datadogIssues
        .list({ includeDismissed: true })
        .flatMap((issue) => (issue.service ? [issue.service] : [])),
    ),
  ].sort((a, b) => a.localeCompare(b));
  return {
    targets: app.datadogServiceTargets.list().map(toDatadogServiceTargetView),
    services,
    defaultProjectPrefix: datadogServiceProjectPrefix(),
    defaultTargetBranch: DATADOG_SERVICE_TARGET_BRANCH,
  };
}

export function toDatadogServiceTargetView(
  target: DatadogServiceTarget,
): ApiContract.DatadogServiceTargetView {
  return {
    service: target.service,
    projectId: target.projectId,
    targetBranch: target.targetBranch,
    updatedAt: target.updatedAt.toISOString(),
  };
}

export function toDatadogActivityView(
  app: App,
  { limit, offset }: { limit: number; offset: number },
): ApiContract.DatadogActivityView {
  const regressionRuns = app.sink
    .recentRuns(WRITE_REGRESSION_TEST_TASK_ID, 1000)
    .filter((run) => {
      const params = run.params as { source?: unknown } | undefined;
      return params?.source === "datadog";
    });
  const scanTaskId = datadogScanTaskId(app);
  const scanRuns = [
    ...app.sink.recentRuns(scanTaskId, 1000),
    ...(scanTaskId === DATADOG_SCAN_TASK_ID
      ? []
      : app.sink.recentRuns(DATADOG_SCAN_TASK_ID, 1000)),
  ];
  const triageRuns = app.sink.recentRuns("triage-datadog-error", 1000);
  const allRuns = [...regressionRuns, ...scanRuns, ...triageRuns].sort(
    (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
  );

  const activeJobs = [
    ...app.jobs.activeForKind(WRITE_REGRESSION_TEST_TASK_ID),
    ...app.jobs.activeForKind("triage-datadog-error"),
  ]
    .filter((job) => {
      const params = job.params as { source?: unknown } | undefined;
      return params?.source == null || params.source === "datadog";
    })
    .sort((a, b) => b.enqueuedAt.getTime() - a.enqueuedAt.getTime())
    .map((job): ApiContract.DatadogActiveJobView => {
      const params = job.params as { issueId?: unknown } | undefined;
      const issueId = typeof params?.issueId === "string" ? params.issueId : null;
      const service = issueId ? app.datadogIssues.get(issueId)?.service ?? null : null;
      return {
        jobId: job.id,
        action:
          job.kind === WRITE_REGRESSION_TEST_TASK_ID
            ? "write-regression-test"
            : "ai-triage",
        status: job.status === "leased" ? "running" : "queued",
        runId: job.executionId ?? null,
        issueId,
        service,
        message: job.status === "leased" ? "Agent is working" : "Waiting for a worker",
        enqueuedAt: job.enqueuedAt.toISOString(),
      };
    });

  return {
    runs: allRuns.slice(offset, offset + limit).map(toRunView),
    total: allRuns.length,
    activeJobs,
  };
}

export function toFeedbackView(feedback: Feedback): ApiContract.FeedbackView {
  return {
    id: feedback.id,
    createdAt: feedback.createdAt.toISOString(),
    publicationStatus: feedback.publicationStatus,
    ...(feedback.publicationReason
      ? { publicationReason: feedback.publicationReason }
      : {}),
    ...(feedback.externalIssueUrl ? { issueUrl: feedback.externalIssueUrl } : {}),
    ...(feedback.externalIssueNumber != null
      ? { issueNumber: feedback.externalIssueNumber }
      : {}),
  };
}

export function toPullRequestView(
  pr: PullRequest,
  active?: ActivePullRequestAction[],
): PullRequestView {
  return {
    provider: pr.provider,
    id: pr.id,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    sourceBranch: pr.sourceBranch,
    targetBranch: pr.targetBranch,
    webUrl: pr.webUrl,
    ...(pr.repository ? { repository: pr.repository } : {}),
    ...(pr.author ? { author: pr.author } : {}),
    ...(pr.createdAt ? { createdAt: pr.createdAt.toISOString() } : {}),
    updatedAt: pr.updatedAt.toISOString(),
    ...(active ? activeActionField(pr, active) : {}),
    ...(pr.hasUnresolvedThreads ? { hasUnresolvedThreads: true } : {}),
  };
}

/**
 * Matched on provider + repository + number, the same triple `pull-request-
 * actions.ts` decodes out of a dedupe key — not on `pr.id`, whose exact string
 * only the connector that built it is required to reproduce.
 */
function activeActionField(
  pr: PullRequest,
  active: ActivePullRequestAction[],
): Pick<PullRequestView, "activeAction"> {
  if (pr.provider !== "gitlab" || !pr.repository) return {};
  const match = active.find(
    (candidate) => candidate.projectId === pr.repository && candidate.mrIid === pr.number,
  );
  if (!match) return {};
  return { activeAction: { action: match.action, status: match.job.status === "leased" ? "running" : "queued" } };
}

export function toPullRequestsView(
  listing: PullRequestListing,
  active: ActivePullRequestAction[],
): PullRequestsView {
  return {
    scope: listing.scope,
    states: listing.states,
    repositoryFilter: listing.repositoryFilter,
    pullRequests: listing.pullRequests.map((pr) => toPullRequestView(pr, active)),
    unavailable: listing.unavailable,
    failed: listing.failed,
  };
}

export interface PullRequestUserView {
  username: string;
  name?: string;
  avatarUrl?: string;
}

export interface PullRequestCommentView {
  id: string;
  author?: PullRequestUserView;
  body: string;
  createdAt: string;
  system: boolean;
}

export interface PullRequestThreadView {
  id: string;
  resolvable: boolean;
  resolved: boolean;
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

/**
 * Everything the detail pane shows. Extends the list row rather than paralleling
 * it, so the UI holds one object per pull request rather than reconciling two.
 */
export interface PullRequestDetailView extends PullRequestView {
  description?: string;
  reviewers: PullRequestUserView[];
  assignees: PullRequestUserView[];
  approvals?: {
    required?: number;
    outstanding?: number;
    approvedBy: PullRequestUserView[];
  };
  mergeability: PullRequestMergeability;
  mergeBlockedReason?: string;
  threads: PullRequestThreadView[];
  openThreadCount: number;
  commits: {
    sha: string;
    title: string;
    url?: string;
    author?: string;
    committedAt?: string;
  }[];
  pipelines: {
    id: number;
    status: string;
    ref: string;
    sha: string;
    url: string;
    createdAt?: string;
    updatedAt: string;
  }[];
  issue?: { key: string; url?: string };
  labels: string[];
  actions: ApiContract.PullRequestActionView[];
}

export interface PullRequestFileChangeView {
  path: string;
  previousPath?: string;
  status: "added" | "removed" | "renamed" | "modified";
  diff?: string;
  tooLarge: boolean;
}

export interface PullRequestChangesView {
  files: PullRequestFileChangeView[];
  truncated: boolean;
}

export function toPullRequestDetailView(
  detail: PullRequestDetail,
  actions: ApiContract.PullRequestActionView[],
): PullRequestDetailView {
  return {
    ...toPullRequestView(detail),
    ...(detail.description ? { description: detail.description } : {}),
    reviewers: detail.reviewers,
    assignees: detail.assignees,
    ...(detail.approvals ? { approvals: detail.approvals } : {}),
    mergeability: detail.mergeability,
    ...(detail.mergeBlockedReason ? { mergeBlockedReason: detail.mergeBlockedReason } : {}),
    threads: detail.threads.map(toPullRequestThreadView),
    openThreadCount: detail.openThreadCount,
    commits: detail.commits,
    pipelines: detail.pipelines.map((pipeline) => ({
      id: pipeline.id,
      status: pipeline.status,
      ref: pipeline.ref,
      sha: pipeline.sha,
      url: pipeline.url,
      ...(pipeline.createdAt ? { createdAt: pipeline.createdAt.toISOString() } : {}),
      updatedAt: pipeline.updatedAt.toISOString(),
    })),
    ...(detail.issue ? { issue: detail.issue } : {}),
    labels: detail.labels,
    actions,
  };
}

function toPullRequestThreadView(thread: PullRequestThread): PullRequestThreadView {
  return {
    id: thread.id,
    resolvable: thread.resolvable,
    resolved: thread.resolved,
    ...(thread.anchor ? { anchor: thread.anchor } : {}),
    comments: thread.comments.map((comment) => ({
      id: comment.id,
      ...(comment.author ? { author: comment.author } : {}),
      body: comment.body,
      createdAt: comment.createdAt.toISOString(),
      system: comment.system,
    })),
  };
}

export function toPullRequestChangesView(changes: PullRequestChanges): PullRequestChangesView {
  return {
    files: changes.files.map((file) => ({
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      status: file.status,
      ...(file.diff ? { diff: file.diff } : {}),
      tooLarge: file.tooLarge,
    })),
    truncated: changes.truncated,
  };
}

/** Backs the topbar Bell. */
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

export function toNotificationView(record: NotificationRecord): NotificationView {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    ...(record.body ? { body: record.body } : {}),
    ...(record.link ? { link: record.link } : {}),
    ...(record.taskRunId ? { taskRunId: record.taskRunId } : {}),
    createdAt: record.createdAt.toISOString(),
    ...(record.readAt ? { readAt: record.readAt.toISOString() } : {}),
  };
}

function nextRunOf(
  scheduled: ScheduledTask,
): { nextRun: string | null; scheduleError?: string } {
  return nextRunForTrigger(scheduled.trigger.value);
}

/**
 * Whether a task belongs on the Tasks/Loops pages.
 *
 * Job handlers do not: they exist to be invoked once per queued job by the worker
 * pool, so listing them would show a permanent row for something that is really
 * an implementation detail of the loop that enqueues it.
 */
export function isListedTask(task: Task<unknown>): boolean {
  return task.kind !== "job";
}

export function toTaskSummary(
  app: App,
  task: Task<unknown>,
  scheduled: ScheduledTask,
  metrics?: {
    runs: TaskRunMetrics;
    openIssues: number;
    activeJobs: number;
    instance?: ReturnType<App["instances"]["get"]>;
  },
): TaskSummaryView {
  const trigger = scheduled.trigger.value;
  const lastRun = metrics?.runs.lastRun ?? app.sink.lastRun(task.id);
  const instance = metrics?.instance ?? app.instances.get(task.id);
  const links = taskExternalLinks(scheduled.params, app.secrets);

  return {
    id: task.id,
    definitionId: instance?.definitionId ?? task.id,
    name: task.name,
    description: task.description,
    // Narrowed rather than widened in the contract: callers filter with
    // `isListedTask`, so a handler never reaches this line.
    kind: task.kind === "job" ? "task" : task.kind,
    instantiable: Boolean(task.instantiable),
    // Nested (non-flat) schemas — gitlab-ci-failure's gitlab/jira blocks — are
    // not representable as form fields; return no generated fields so one such
    // task cannot break the whole list.
    paramsSchema: describeParamsSchemaLoosely(task.paramsSchema),
    visibility: instance?.visibility,
    createdAt: instance?.createdAt.toISOString(),
    enabled: scheduled.enabled.value,
    enabledOrigin: scheduled.enabled.origin,
    schedule: trigger.type === "cron" ? trigger.expression : null,
    onceAt: trigger.type === "once" ? trigger.at : undefined,
    startAt: trigger.type === "cron" ? trigger.startAt : undefined,
    timezone: trigger.type === "manual" ? undefined : trigger.timezone,
    ...nextRunOf(scheduled),
    maxItemsPerRun: scheduled.maxItemsPerRun,
    lastRun: lastRun ? toRunView(lastRun) : undefined,
    stats: metrics?.runs.stats ?? app.sink.stats(task.id),
    openIssues: metrics?.openIssues ?? app.subjects.countByState(task.id).open,
    activeJobs: metrics?.activeJobs ?? activeJobCount(app, task.id),
    usesGitLab: usesGitLabRepo(task.paramsSchema, scheduled.params),
    usesJira: usesJiraProject(task.paramsSchema, scheduled.params) || Boolean(links.jiraIssue),
    ...links,
    promptTemplate: instance?.promptTemplate,
  };
}

/** Builds a task-list page without one history/count query per task row. */
export function toTaskSummaries(
  app: App,
  scheduledTasks: readonly ScheduledTask[],
): TaskSummaryView[] {
  const tasks = scheduledTasks.map((scheduled) => ({
    scheduled,
    task: app.taskRegistry.require(scheduled.id),
  }));
  const ids = tasks.map(({ task }) => task.id);
  const runs = app.sink.metricsFor(ids);
  const openIssues = app.subjects.openCounts(ids);
  const activeJobs = app.jobs.activeCounts(ids);
  const instances = new Map(app.instances.all().map((instance) => [instance.id, instance]));
  return tasks.map(({ task, scheduled }) =>
    toTaskSummary(app, task, scheduled, {
      runs: runs.get(task.id)!,
      openIssues: openIssues.get(task.id) ?? 0,
      activeJobs: activeJobs.get(task.id) ?? 0,
      instance: instances.get(task.id) ?? null,
    }),
  );
}

/**
 * Jobs a loop enqueued that have not finished yet — the count behind the
 * "running" indicator on the loop card, since a job outliving the tick that
 * queued it is otherwise invisible until it succeeds or fails.
 */
function activeJobCount(app: App, loopId: string): number {
  const counts = app.jobs.counts(loopId);
  return counts.queued + counts.leased;
}

/**
 * Deep links the list can render without a second fetch: one MR when the
 * instance is scoped to an iid, and a Jira ticket when a key was stored.
 */
export function taskExternalLinks(params: unknown, secrets: SecretStore): {
  gitlabMr?: { iid: number; url: string };
  jiraIssue?: { key: string; url?: string };
} {
  const gitlab = (params as { gitlab?: Record<string, unknown> } | null | undefined)?.gitlab;
  if (gitlab == null) return {};

  const projectId = typeof gitlab.projectId === "string" ? gitlab.projectId : undefined;
  const mrIid = typeof gitlab.mrIid === "number" ? gitlab.mrIid : undefined;
  const jiraIssueKey =
    typeof gitlab.jiraIssueKey === "string" ? gitlab.jiraIssueKey.trim() : "";

  const out: {
    gitlabMr?: { iid: number; url: string };
    jiraIssue?: { key: string; url?: string };
  } = {};

  if (projectId && mrIid != null) {
    out.gitlabMr = {
      iid: mrIid,
      url: `${new URL(GITLAB_API_URL).origin}/${projectId}/-/merge_requests/${mrIid}`,
    };
  }

  if (jiraIssueKey.length > 0) {
    const url = jiraBrowseUrl(secrets, jiraIssueKey);
    out.jiraIssue = url ? { key: jiraIssueKey, url } : { key: jiraIssueKey };
  }

  return out;
}

/**
 * A GitLab repo is in play when stored params name a project, or when the
 * schema itself has a `gitlab` object with `projectId` — the same block every
 * GitLab-backed task already declares, including instantiable definitions
 * that have not been pointed at a project yet.
 */
export function usesGitLabRepo(paramsSchema: z.ZodTypeAny, params: unknown): boolean {
  const block = (params as Record<string, unknown> | null | undefined)?.gitlab;
  if (block != null && GitLabConfigSchema.safeParse(block).success) return true;

  if (!(paramsSchema instanceof z.ZodObject)) return false;
  const field = (paramsSchema.shape as Record<string, z.ZodTypeAny | undefined>).gitlab;
  if (field == null) return false;
  const { inner } = describeField(field);
  return inner instanceof z.ZodObject && "projectId" in inner.shape;
}

/**
 * A Jira project is in play when stored params name one, or when the schema
 * itself has a `jira` object with `project` — the block gitlab-ci-failure
 * (and any later ticket-filing task) already declares.
 */
export function usesJiraProject(paramsSchema: z.ZodTypeAny, params: unknown): boolean {
  const block = (params as Record<string, unknown> | null | undefined)?.jira;
  if (block != null && JiraConfigSchema.safeParse(block).success) return true;

  if (!(paramsSchema instanceof z.ZodObject)) return false;
  const field = (paramsSchema.shape as Record<string, z.ZodTypeAny | undefined>).jira;
  if (field == null) return false;
  const { inner } = describeField(field);
  return inner instanceof z.ZodObject && "project" in inner.shape;
}

export interface ScheduleView {
  id: string;
  enabled: boolean;
  enabledOrigin: string;
  trigger: { type: "cron"; expression: string; timezone?: string; startAt?: string } | { type: "once"; at: string; timezone?: string } | { type: "manual" };
  maxItemsPerRun: number;
  params: unknown;
}

/** Shape returned by GET/PUT/DELETE /api/tasks/:id/schedule — the CRUD form's contract. */
export function toScheduleView(scheduled: ScheduledTask): ScheduleView {
  return {
    id: scheduled.id,
    enabled: scheduled.enabled.value,
    enabledOrigin: scheduled.enabled.origin,
    trigger: scheduled.trigger.value,
    maxItemsPerRun: scheduled.maxItemsPerRun,
    params: scheduled.params,
  };
}

/** One page of a task's run history — backs the Activity tab's paginated table. */
export interface TaskRunPageView {
  runs: TaskRunView[];
  total: number;
}

/** One page of the open subjects shown in a task's Overview tab. */
export interface TaskIssuePageView {
  issues: FiledIssueView[];
  total: number;
}

export function toRunHistoryPage(
  app: App,
  taskId: string,
  { limit, offset }: { limit: number; offset: number },
): TaskRunPageView {
  return {
    runs: toRunViewsWithChildren(app, app.sink.recentRuns(taskId, limit, offset)),
    total: app.sink.stats(taskId).total,
  };
}

/** One page of the runs recorded against a merge request, newest first. */
export interface PullRequestRunPageView {
  runs: TaskRunView[];
  total: number;
}

export function toPullRequestRunPage(
  app: App,
  projectId: string,
  mrIid: number,
  { limit, offset }: { limit: number; offset: number },
): PullRequestRunPageView {
  return {
    runs: toRunViewsWithChildren(app, app.sink.runsFor(projectId, mrIid, limit, offset)),
    total: app.sink.countFor(projectId, mrIid),
  };
}

export function toTaskIssuePage(
  app: App,
  taskId: string,
  { limit, offset }: { limit: number; offset: number },
): TaskIssuePageView {
  return {
    issues: app.subjects.openSubjects(taskId, limit, offset).map(toIssueView),
    total: app.subjects.countByState(taskId).open,
  };
}

const TASK_ISSUES_PREVIEW_LIMIT = 15;

export async function toTaskDetail(
  app: App,
  task: Task<unknown>,
  scheduled: ScheduledTask,
): Promise<TaskDetailView> {
  const runs = app.sink.recentRuns(task.id, 25);
  const watermark = await app.state.getWatermark(task.id);
  const counts = await app.state.countByStatus(task.id);

  return {
    ...toTaskSummary(app, task, scheduled),
    watermark: watermark ? watermark.toISOString() : null,
    events: counts,
    runs: toRunViewsWithChildren(app, runs),
    // The current SPA treats this as page zero while it asks the dedicated
    // endpoint for the authoritative total. Keeping a bounded preview preserves
    // instant rendering and compatibility with older clients without making the
    // detail payload grow forever.
    issues: app.subjects.openSubjects(task.id, TASK_ISSUES_PREVIEW_LIMIT).map(toIssueView),
    params: scheduled.params,
    paramsOrigin: scheduled.enabled.origin,
    graph: graphFromRun(runs[0]),
  };
}

/** Enough of the old graph payload that a stale SPA can read `graph.executionId`. */
function graphFromRun(run: TaskRunSummary | undefined): TaskDetailView["graph"] {
  if (!run) return { nodes: [], edges: [] };
  return {
    executionId: run.executionId,
    startedAt: run.startedAt.toISOString(),
    nodes: [],
    edges: [],
  };
}

/** A task's own record of one run, immediately after it finishes — same shape as history rows. */
export function toTaskExecutionView(record: TaskExecutionRecord): TaskRunView & { steps: StepView[] } {
  return {
    executionId: record.executionId,
    taskId: record.taskId,
    startedAt: record.startedAt.toISOString(),
    finishedAt: record.finishedAt.toISOString(),
    durationMs: record.durationMs,
    status: record.status,
    dryRun: record.dryRun,
    params: record.params,
    itemsSeen: record.result?.itemsSeen,
    itemsProcessed: record.result?.itemsProcessed,
    itemsSkipped: record.result?.itemsSkipped,
    error: record.error,
    details: record.result?.details,
    steps: record.steps.map(toStepView),
  };
}

export interface SystemView {
  version: string;
  configPath: string;
  databasePath: string;
  schemaVersion: number;
  logLevel: string;
  dryRun: boolean;
  /**
   * Open run rows that nothing in this process is actually executing — a crash
   * or a kill left them claimed forever. Never counts a live run: see
   * `toSystemView`.
   */
  orphanedRuns: number;
  connectors: { name: string; ready: boolean; missing: string[] }[];
  secrets: { name: string; present: boolean }[];
  integrations: { name: string; ready: boolean }[];
  runningJobs: number;
  agentCapacity: ApiContract.OrchestrationCapacityView;
}

export function toSystemView(app: App): SystemView {
  const connectors = CONNECTORS.map((definition) => {
    const missing = missingSecrets(definition, app.secrets);
    return { name: definition.name, ready: missing.length === 0, missing };
  });

  return {
    version: VERSION,
    configPath: app.loaded.path,
    databasePath: app.loaded.databasePath,
    schemaVersion: app.schemaVersion,
    logLevel: app.settings().logLevel,
    dryRun: app.dryRun,
    // `findOrphanedRuns` is every row still marked running, which during a run
    // includes the run itself — the badge in the top bar was reporting a healthy
    // loop as "1 orphaned" for as long as it took. A row is only orphaned if this
    // process is not the one executing it; `serve` closes whatever the previous
    // process left open at boot, so anything left over is a genuine leak.
    orphanedRuns: app.sink
      .findOrphanedRuns()
      .filter((run) => !app.executor.isActive(run.executionId)).length,
    connectors,
    secrets: KNOWN_SECRETS.map((name) => ({
      name,
      present: app.secrets.presence()[name],
    })),
    // Datadog and LogRocket have no CLI health check (LogRocket is webhook-driven,
    // with nothing to connect to and probe) so they're not in CONNECTORS, but the
    // footer still wants to show them as "integrated" once their token is set.
    integrations: [
      ...connectors,
      { name: "datadog", ready: app.secrets.get("DATADOG_TOKEN") != null },
      { name: "logrocket", ready: app.secrets.get("LOGROCKET_API_KEY") != null },
    ],
    runningJobs: app.jobs.activeTotal(),
    agentCapacity: agentCapacitySnapshot(),
  };
}

/** Whether each field of GeneralSettingsView came from a live override or the YAML default. */
export interface GeneralSettingsView {
  logLevel: ApiContract.LogLevel;
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

/** GET/PUT /api/settings — the general (non-task) settings the web UI's Settings page edits. */
export function toSettingsView(app: App): GeneralSettingsView {
  const overrides = app.generalConfigStore.get();
  const settings = app.settings();

  return {
    logLevel: settings.logLevel,
    logLevelOrigin: overrides.logLevel != null ? "db" : "default",
    timezone: settings.timezone ?? null,
    timezoneOrigin: overrides.timezone != null ? "db" : "default",
    llm: {
      provider: settings.llm.provider,
      model: settings.llm.model ?? null,
      effort: settings.llm.effort ?? null,
      maxTokens: settings.llm.maxTokens,
    },
    llmOrigin:
      overrides.llmProvider != null ||
      overrides.llmModel != null ||
      overrides.llmEffort != null ||
      overrides.llmMaxTokens != null
        ? "db"
        : "default",
  };
}

/** One overridable LLM prompt, as GET/PUT /api/prompts shows and edits it. */
export interface PromptTemplateView {
  id: string;
  label: string;
  description: string;
  variables: string[];
  template: string;
  defaultTemplate: string;
  origin: "db" | "default";
}

export interface PromptsView {
  prompts: PromptTemplateView[];
}

/** GET/PUT /api/prompts — the LLM prompt templates the agent tasks build. */
export function toPromptsView(app: App): PromptsView {
  const overrides = app.promptTemplateStore.get();
  return {
    prompts: PROMPT_TEMPLATES.map((def) => ({
      id: def.id,
      label: def.label,
      description: def.description,
      variables: def.variables,
      template: overrides[def.id] ?? def.defaultTemplate,
      defaultTemplate: def.defaultTemplate,
      origin: overrides[def.id] != null ? "db" : "default",
    })),
  };
}

// Compile-time wire-contract checks. The browser imports these shared contracts
// directly; a backend DTO that drifts wider or changes a field now fails typecheck.
type ContractCheck<T extends U, U> = T;
type _TaskRunContract = ContractCheck<TaskRunView, ApiContract.TaskRunView>;
type _TaskRunPageContract = ContractCheck<TaskRunPageView, ApiContract.TaskRunPage>;
type _TaskIssuePageContract = ContractCheck<TaskIssuePageView, ApiContract.TaskIssuePage>;
type _PullRequestRunPageContract = ContractCheck<
  PullRequestRunPageView,
  ApiContract.PullRequestRunPageView
>;
type _StepContract = ContractCheck<StepView, ApiContract.StepView>;
type _LogContract = ContractCheck<LogLineView, ApiContract.LogLineView>;
type _TaskSummaryContract = ContractCheck<TaskSummaryView, ApiContract.TaskSummary>;
type _TaskDetailContract = ContractCheck<TaskDetailView, ApiContract.TaskDetail>;
type _IssueContract = ContractCheck<FiledIssueView, ApiContract.FiledIssueView>;
type _ScheduleContract = ContractCheck<ScheduleView, ApiContract.ScheduleView>;
type _SystemContract = ContractCheck<SystemView, ApiContract.SystemView>;
type _SettingsContract = ContractCheck<GeneralSettingsView, ApiContract.GeneralSettings>;
type _PromptsContract = ContractCheck<PromptsView, ApiContract.PromptsView>;
type _PullRequestContract = ContractCheck<PullRequestView, ApiContract.PullRequestView>;
type _PullRequestsContract = ContractCheck<PullRequestsView, ApiContract.PullRequestsView>;
type _PullRequestDetailContract = ContractCheck<
  PullRequestDetailView,
  ApiContract.PullRequestDetailView
>;
type _PullRequestChangesContract = ContractCheck<
  PullRequestChangesView,
  ApiContract.PullRequestChangesView
>;
type _PullRequestRepoFilterContract = ContractCheck<
  PullRequestRepoFilterView,
  ApiContract.PullRequestRepoFilterView
>;
