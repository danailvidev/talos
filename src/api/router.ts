/**
 * The HTTP API.
 *
 * A `Request -> Response` function rather than a server, for two reasons: tests
 * call it directly with no port to bind or clean up, and the serving concern
 * (host, static files, shutdown) stays in `serve.ts` where it can change without
 * touching a route.
 *
 * Almost entirely read-only. The exceptions are a task's schedule
 * (GET/PUT/DELETE /api/tasks/:id/schedule), running a task
 * (POST /api/tasks/:id/run — starts the run and returns 202 while it
 * continues), cancelling one
 * (POST /api/tasks/:id/cancel, POST /api/task-runs/:id/cancel,
 * POST /api/jobs/:id/cancel), creating a
 * task instance (POST /api/tasks) and
 * the general settings (GET/PUT /api/settings) and the integration credentials
 * (GET/PUT /api/settings/integrations), all of which mutate the
 * database. Every API route except login is session-authenticated, and private
 * task routes additionally require ownership. The Kubernetes deployment-status
 * query uses POST only to carry a bounded structured read; other read routes
 * stay GET-only and refuse unsupported methods.
 */
import type { App } from "../app.ts";
import { RegistrationError, type AuthUser } from "../auth.ts";
import {
  createAppAbility,
  normalizePermissions,
  type AppPermission,
  type AppSubject,
} from "../../shared/authorization.ts";
import { ADMIN_ROLE_ID, RoleError, type Role } from "../roles.ts";
import {
  isPullRequestState,
  parsePullRequestId,
  pullRequestId,
  PULL_REQUEST_STATES,
  type PullRequestState,
} from "../application/pull-requests.ts";
import { deploymentTargetFor } from "../application/releases.ts";
import { GeneralSettingsPatchSchema } from "../config/schema.ts";
import {
  isEffort,
  isModel,
} from "../application/agent-run-preferences.ts";
import { PROMPT_TEMPLATES } from "../tasks/prompt-registry.ts";
import { CI_FAILURE_SOURCE } from "../tasks/ci-failure/index.ts";
import {
  AUTOMATION_REPORT_SYNC_DEFAULT_MAX_ITEMS,
  AUTOMATION_REPORT_SYNC_TASK_ID,
} from "../tasks/automation-report-sync/index.ts";
import { RELEASE_PIPELINE_WATCH_TASK_ID } from "../tasks/release-pipeline-watch/index.ts";
import { existsSync } from "node:fs";

import { detectAgents } from "../infrastructure/agent/detect.ts";
import { agentAuthOption, agentCatalogView } from "../infrastructure/agent/catalog.ts";
import { hostClaudeConfigDir } from "../infrastructure/agent/run.ts";
import { agentCapacitySnapshot } from "../infrastructure/agent/capacity.ts";
import { SuspensionUnavailableError } from "../core/checkpoint.ts";
import { toAccountView } from "../infrastructure/agent/login.ts";
import {
  AuthenticationError,
  ConfigError,
  ConnectorError,
  PermissionError,
  TalosError,
  ValidationError,
  describeError,
} from "../core/errors.ts";
import { registerSecretValues } from "../logging/logger.ts";
import type { Visibility } from "../persistence/instance-store.ts";
import {
  ACTOR_SECRETS,
  isActorSecret,
  isRedactedSecret,
} from "../secrets/secret-store.ts";
import {
  integrationField,
  isInstanceIntegrationField,
} from "../../shared/integrations.ts";
import {
  isListedTask,
  toBranchView,
  toGitLabProjectView,
  toJiraIssueView,
  toJiraUserView,
  toMergeRequestView,
  toNotificationView,
  toPullRequestChangesView,
  toPullRequestDetailView,
  toPullRequestsView,
  toPullRequestRepoFilterView,
  toReleasesView,
  toReleaseHistoryView,
  toReleaseRevertPreviewView,
  toDeployWatchesView,
  toReleaseSlackState,
  toIntegrationsView,
  toProviderAccessView,
  toLogRocketIssuesView,
  toDatadogIssuesView,
  toDatadogActivityView,
  toFlakySpecsView,
  toDatadogRoutingRuleView,
  toDatadogRoutingView,
  toDatadogServiceTargetView,
  toDatadogServiceTargetsView,
  toFeedbackView,
  toReleaseConfigView,
  toScheduleView,
  toSettingsView,
  toPromptsView,
  toLogLineView,
  toStepView,
  toSystemView,
  toTaskDetail,
  toTaskSummary,
  toTaskSummaries,
  toTaskIssuePage,
  toRunView,
  toPullRequestRunPage,
  toRunHistoryPage,
  type StepView,
} from "./views.ts";
import {
  enqueueTicketAction,
  TICKET_ACTION_IDS,
  type TicketActionId,
} from "./ticket-actions.ts";
import { decidePlan, planInbox, planViewFor } from "./plan-actions.ts";
import {
  fixLogRocketIssue,
  toLogRocketFixResult,
  writeLogRocketRegressionTest,
} from "./logrocket-actions.ts";
import {
  fixDatadogProblem,
  scanDatadogNow,
  setDatadogProblemState,
  toDatadogFixResult,
  triageDatadogProblem,
  writeDatadogRegressionTest,
} from "./datadog-actions.ts";
import { toTicketGraph } from "./graph-view.ts";
import { e2eArtifactResponse } from "./e2e-artifacts.ts";
import { enqueueE2eTestMr } from "./e2e-test-mr-actions.ts";
import { CACHE_TTL, cached, wantsFreshData } from "./cached.ts";
import { routeDashboards } from "./dashboards.ts";
import {
  CACHE_PREFIX,
  cachedPullRequestDetail,
  cachedPullRequestListing,
  cachedTicketDetail,
} from "./cached-reads.ts";
import { toSearchResult } from "./search-view.ts";
import {
  activePullRequestActions,
  enqueuePullRequestAction,
  handlerFor,
  isPullRequestAction,
  PULL_REQUEST_ACTIONS,
  pullRequestActionRefusal,
  pullRequestActionStates,
  pullRequestActionViews,
  pullRequestActivity,
} from "./pull-request-actions.ts";
import type * as ApiContract from "../../shared/api-contract.ts";
import { LLM_MODELS, NOTIFICATION_KINDS } from "../../shared/api-contract.ts";
import type {
  AgentUsageSource,
  DatadogArea,
  Feedback,
  FeedbackPublicationReason,
} from "../application/ports.ts";
import {
  AutomationTicketService,
  type AutomationTicketInput,
  type AutomationTicketResult,
} from "../application/automation-ticketing.ts";
import { PIPELINE_STATUSES } from "../connectors/gitlab/types.ts";
import type { GitLabFeedbackIssue } from "../connectors/gitlab/issues.ts";
import { confluencePageId } from "../connectors/jira/client.ts";
import {
  parseConfluenceReleaseLinks,
  parseConfluenceReleaseSuggestions,
} from "../application/confluence-releases.ts";
import {
  toAutomationDashboard,
  toAutomationFailureClusterDetail,
  toAutomationFailureClusterList,
  toAutomationFailureInbox,
  toAutomationPipelineDetail,
} from "./automation-view.ts";
import { TRIAGE_AUTOMATION_FAILURE_TASK_ID } from "../tasks/triage-automation-failure/index.ts";
import { e2eTestProject } from "../tasks/write-e2e-test/index.ts";
import {
  E2eAgentResultSchema,
  e2eTestSettingsSources,
  MAX_E2E_ADDITIONAL_INSTRUCTIONS_BYTES,
  MAX_E2E_FILE_OVERRIDE_BYTES,
} from "../tasks/e2e-test/index.ts";
import { parseQaRuntime } from "../tasks/e2e-test/qa-runtime.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const SLACK_OAUTH_COOKIE = "talos_slack_oauth";
const MAX_FEEDBACK_IMAGES = 5;
const MAX_FEEDBACK_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FEEDBACK_UPLOAD_BYTES = MAX_FEEDBACK_IMAGES * MAX_FEEDBACK_IMAGE_BYTES;
const FEEDBACK_IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
]);
function confluenceReleasesPage(): string {
  return Bun.env.TALOS_CONFLUENCE_RELEASES_PAGE?.trim() ?? "";
}

/** Schedule ids that are operational maintenance, not an Automation reporting source. */
function excludedAutomationScheduleIds(): Set<number> {
  const raw = Bun.env.TALOS_AUTOMATION_EXCLUDED_SCHEDULE_IDS?.trim() ?? "";
  return new Set(
    raw
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isInteger(id) && id > 0),
  );
}

/** A parsed JSON body, or a ConfigError the error handler turns into a 400. */
async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (cause) {
    throw new ConfigError("Request body is not valid JSON.", { cause });
  }
}

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function privateJson(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return json(body, status, {
    "cache-control": "private, no-store",
    vary: "Cookie",
    ...headers,
  });
}

function redirect(location: string, headers?: Record<string, string>): Response {
  return new Response(null, { status: 302, headers: { location, ...headers } });
}

function requestCookie(request: Request, name: string): string {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function slackOAuthCookie(value: string, origin: string, maxAge: number): string {
  return [
    `${SLACK_OAUTH_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/api/auth/slack/callback",
    "HttpOnly",
    "SameSite=Lax",
    ...(origin.startsWith("https://") ? ["Secure"] : []),
    `Max-Age=${maxAge}`,
  ].join("; ");
}

/**
 * A JSON response the browser is allowed to revalidate instead of re-download.
 *
 * Be clear about what this does and does not buy. It saves bandwidth and the
 * client's JSON parse; it saves no server work at all, because the body has to be
 * produced in order to be hashed. It is worth having only on the payloads that are
 * both large and repeatedly identical — a run's steps polled once a second, a
 * 300-file diff, a 50-row listing, the whole task table — and it is strictly
 * secondary to the TTL cache in `cached.ts`, which is the half that saves the forge
 * calls.
 *
 * `private, no-cache` and `Vary: Cookie` are in here rather than at the call sites
 * so they cannot be forgotten one at a time. Every one of these bodies is scoped to
 * a session: `public` or `s-maxage` on `/api/pull-requests` behind any reverse proxy
 * is the same cross-user leak as a cache key with no user in it, with a wider blast
 * radius and a longer life. `no-cache` still permits the 304 — it means "revalidate
 * before reusing", not "do not store" — so the round trip stays and only the body
 * goes away. `tests/serve.test.ts` asserts no `/api/` response ever carries the
 * other two.
 *
 * The client never sees the 304: the browser answers `fetch()` with a 200 out of its
 * own HTTP cache, which is fortunate, because `request()` in `web/src/api.ts` would
 * choke on an empty body.
 *
 * `validator` is for the cases where a content revision is already known and is
 * cheaper and more honest than a hash — the head commit set on a diff. A weak
 * validator (`W/`) because these are byte-for-byte comparisons of a serialisation,
 * not of a resource.
 */
function jsonCached(body: unknown, request: Request, validator?: string): Response {
  const headers = {
    ...JSON_HEADERS,
    "cache-control": "private, no-cache",
    vary: "Cookie",
  };
  const serialised = JSON.stringify(body);
  const etag = `W/"${validator ?? Bun.hash(serialised).toString(36)}"`;

  // `includes` rather than `===`: `If-None-Match` is a list, and a browser that has
  // more than one stored representation sends all of them.
  if ((request.headers.get("if-none-match") ?? "").includes(etag)) {
    return new Response(null, { status: 304, headers: { ...headers, etag } });
  }
  return new Response(serialised, { status: 200, headers: { ...headers, etag } });
}

function notFound(message: string): Response {
  return json({ error: message }, 404);
}

function methodNotAllowed(method: string): Response {
  return json({ error: `${method} is not supported for this route.` }, 405);
}

function inlineContentDisposition(filename: string): string {
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\\r\n]/g, "_")
    .slice(0, 200) || "slack-image";
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function isRequestAbort(err: unknown, request: Request): boolean {
  return (
    request.signal.aborted ||
    (err instanceof Error &&
      (err.name === "AbortError" ||
        err.message === "The connection was closed." ||
        err.message.includes("request was aborted")))
  );
}

/** Clamps a `?limit=` query param to a sane page size, falling back when absent or malformed. */
function clampPageParam(raw: string | null, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

async function routeAuth(request: Request, path: string, app: App): Promise<Response> {
  if (path === "/api/auth/slack/callback") {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    const url = new URL(request.url);
    const origin = app.runtime?.publicUrl?.origin ?? url.origin;
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const slackError = url.searchParams.get("error");
    const browserNonce = requestCookie(request, SLACK_OAUTH_COOKIE);
    const clearCookie = slackOAuthCookie("", origin, 0);
    if (slackError) {
      app.slackInbox.cancelOAuth(state, browserNonce);
      return redirect(
        `${origin}/slack?slack=error&message=${encodeURIComponent(`Slack authorization was cancelled (${slackError}).`)}`,
        { "set-cookie": clearCookie },
      );
    }
    try {
      if (!state || !code) {
        app.slackInbox.cancelOAuth(state, browserNonce);
        throw new ConfigError("Slack returned no authorization code.");
      }
      if (!browserNonce) {
        throw new ConfigError(
          "The Slack connection browser cookie is missing. Start Connect Slack again " +
            "from the same TALOS hostname and complete it in this browser.",
        );
      }
      await app.slackInbox.completeOAuth({
        state,
        browserNonce,
        code,
        origin,
        signal: request.signal,
      });
      return redirect(`${origin}/slack?slack=connected`, {
        "set-cookie": clearCookie,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Slack connection failed.";
      app.logger.warn({ err: message }, "Slack OAuth callback failed");
      return redirect(
        `${origin}/slack?slack=error&message=${encodeURIComponent(message)}`,
        { "set-cookie": clearCookie },
      );
    }
  }

  if (path === "/api/auth/session") {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    const user = app.auth.userFor(request);
    return user ? json({ user }) : json({ error: "Authentication required." }, 401);
  }

  if (path === "/api/auth/login") {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Request body is not valid JSON." }, 400);
    }
    const credentials = body as { email?: unknown; password?: unknown } | null;
    if (
      !credentials ||
      typeof credentials.email !== "string" ||
      typeof credentials.password !== "string"
    ) {
      return json({ error: "Email and password are required." }, 400);
    }
    const result = await app.auth.login(credentials.email, credentials.password);
    if (!result) return json({ error: "Invalid email or password." }, 401);
    return json({ user: result.user }, 200, { "set-cookie": result.cookie });
  }

  if (path === "/api/auth/register") {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    return json(
      { error: "Public registration is disabled. Ask an administrator to create your account." },
      403,
    );
  }

  if (path === "/api/auth/logout") {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    return json({}, 200, { "set-cookie": app.auth.logout(request) });
  }

  if (path === "/api/auth/forgot-password") {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Request body is not valid JSON." }, 400);
    }
    const fields = body as { email?: unknown } | null;
    if (!fields || typeof fields.email !== "string") {
      return json({ error: "Email is required." }, 400);
    }
    const token = app.auth.requestPasswordReset(fields.email);
    // No SMTP in a self-hosted talos, so the link goes to the server log
    // for whoever runs `serve` to hand to the account holder. The response
    // is identical whether or not the email exists, so it can't be used to
    // enumerate registered accounts.
    if (token) {
      const resetUrl =
        `${app.runtime?.publicUrl?.origin ?? new URL(request.url).origin}/reset-password?token=${token}`;
      app.logger.info({ email: fields.email.trim().toLowerCase() }, `password reset link: ${resetUrl}`);
    }
    return json({ ok: true });
  }

  if (path === "/api/auth/reset-password") {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Request body is not valid JSON." }, 400);
    }
    const fields = body as { token?: unknown; password?: unknown } | null;
    if (!fields || typeof fields.token !== "string" || typeof fields.password !== "string") {
      return json({ error: "Token and password are required." }, 400);
    }
    try {
      const reset = await app.auth.resetPassword(fields.token, fields.password);
      if (!reset) return json({ error: "This reset link is invalid or has expired." }, 400);
      return json({ ok: true });
    } catch (err) {
      if (err instanceof RegistrationError) return json({ error: err.message }, 400);
      throw err;
    }
  }

  if (path === "/api/auth/accept-invitation") {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Request body is not valid JSON." }, 400);
    }
    const fields = body as { token?: unknown; password?: unknown } | null;
    if (!fields || typeof fields.token !== "string" || typeof fields.password !== "string") {
      return json({ error: "Invitation token and password are required." }, 400);
    }
    try {
      const accepted = await app.auth.acceptInvitation(fields.token, fields.password);
      if (!accepted) {
        return json({ error: "This invitation link is invalid or has expired." }, 400);
      }
      return json({ user: accepted.user }, 200, { "set-cookie": accepted.cookie });
    } catch (err) {
      if (err instanceof RegistrationError) return json({ error: err.message }, 400);
      throw err;
    }
  }

  return notFound(`No API route for ${path}.`);
}

function canAccessTask(app: App, taskId: string, user: AuthUser): boolean {
  const instance = app.instances.get(taskId);
  return !instance || instance.visibility === "public" || instance.ownerId === user.id;
}

function permissionsFromBody(value: unknown): AppPermission[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ConfigError("Permissions must be an array.");
  try {
    return normalizePermissions(value);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : "Permissions are invalid.");
  }
}

function invitationUrl(request: Request, app: App, token: string): string {
  const origin = app.runtime?.publicUrl?.origin ?? new URL(request.url).origin;
  return `${origin}/accept-invite#token=${encodeURIComponent(token)}`;
}

function adminUserView(
  app: App,
  profile: ReturnType<App["auth"]["profile"]>,
): ApiContract.AdminUserView {
  if (!profile) throw new ValidationError("This account no longer exists.");
  const ownedLoops = app.instances
    .all()
    .filter((instance) => instance.ownerId === profile.id && instance.visibility === "private");
  const hasCredential = (name: string): boolean => {
    try {
      return app.credentials.get(profile.id, name) != null;
    } catch {
      // A row encrypted with an old/missing key is stored, but is not an active
      // connection and must not be presented as one.
      return false;
    }
  };
  const slack = app.slackConnections.describe(profile.id);
  const invitationExpiresAt = app.auth.invitationExpiresAt(profile.id);
  return {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    role: profile.role,
    permissions: profile.permissions,
    builtIn: profile.builtIn,
    accountStatus: profile.accountStatus,
    ...(invitationExpiresAt
      ? { invitationExpiresAt: invitationExpiresAt.toISOString() }
      : {}),
    ...(profile.createdAt ? { createdAt: profile.createdAt.toISOString() } : {}),
    ...(profile.lastSeenAt ? { lastSeenAt: profile.lastSeenAt.toISOString() } : {}),
    connections: {
      gitlab: hasCredential("GITLAB_TOKEN"),
      jira: hasCredential("JIRA_EMAIL") && hasCredential("JIRA_TOKEN"),
      slack: slack != null && !slack.unreadable,
    },
    agentAccountCount: app.agentAccounts.list(profile.id).length,
    ownedLoopCount: ownedLoops.length,
  };
}

function adminRoleView(role: Role): ApiContract.AdminRoleView {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    system: role.system,
    permissions: role.permissions,
    userCount: role.userCount,
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
  };
}

function adminUserDetailView(
  app: App,
  profile: NonNullable<ReturnType<App["auth"]["profile"]>>,
): ApiContract.AdminUserDetailView {
  const summary = adminUserView(app, profile);
  const credentialMeta = new Map(
    app.credentials.list(profile.id).map((credential) => [credential.name, credential]),
  );
  const gitlab = credentialMeta.get("GITLAB_TOKEN");
  const jiraEmail = credentialMeta.get("JIRA_EMAIL");
  const jiraToken = credentialMeta.get("JIRA_TOKEN");
  const jiraUpdatedAt =
    jiraEmail && jiraToken
      ? new Date(Math.max(jiraEmail.updatedAt.getTime(), jiraToken.updatedAt.getTime()))
      : undefined;
  const hasSlack = app.slackConnections.describe(profile.id) != null;
  const slack = hasSlack ? toProviderAccessView(app, profile).slack : undefined;
  const ownedLoops = app.instances
    .all()
    .filter((instance) => instance.ownerId === profile.id && instance.visibility === "private")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return {
    ...summary,
    sessions: app.auth.sessions(profile.id).map((session) => ({
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
    })),
    providerConnections: {
      ...(summary.connections.gitlab && gitlab
        ? { gitlab: { updatedAt: gitlab.updatedAt.toISOString() } }
        : {}),
      ...(summary.connections.jira && jiraUpdatedAt
        ? { jira: { updatedAt: jiraUpdatedAt.toISOString() } }
        : {}),
      ...(slack ? { slack } : {}),
    },
    agentAccounts: app.agentAccounts.list(profile.id).map(toAccountView),
    ownedLoops: ownedLoops.map((instance) => ({
      id: instance.id,
      name: instance.name,
      createdAt: instance.createdAt.toISOString(),
    })),
    jobs: app.jobs.countsByActor(profile.id),
    pullRequestRepositories: app.pullRequestRepoFilters.list(profile.id),
    fixIssueDefaults: app.fixIssueDefaults.get(profile.id),
  };
}

async function routeAdmin(
  request: Request,
  path: string,
  url: URL,
  app: App,
  actor: AuthUser,
): Promise<Response> {
  if (path === "/api/admin/orchestration") {
    if (request.method === "GET") {
      const attempts = app.orchestration.attempts();
      const activeAttemptByJob = new Map(
        attempts
          .filter((attempt) =>
            attempt.jobId &&
            ["starting", "running", "stopping", "uncertain"].includes(attempt.state)
          )
          .map((attempt) => [attempt.jobId!, attempt]),
      );
      const capacity = agentCapacitySnapshot();
      const suspension = app.checkpointSuspension.capability();
      return json({
        installationId: app.orchestration.installationId(),
        capacity,
        suspension: {
          supported: suspension.supported,
          provider: suspension.provider ?? null,
          protocolVersion: suspension.protocolVersion ?? null,
          runtimeKinds: suspension.runtimeKinds,
          cooperativeCheckpoint: suspension.cooperativeCheckpoint,
          durableWorkspace: suspension.durableWorkspace,
          durableSession: suspension.durableSession,
          replaySafeEffects: suspension.replaySafeEffects,
          reason: suspension.reason ?? null,
        },
        attempts: attempts.map((attempt) => ({
          id: attempt.id,
          executionId: attempt.executionId ?? null,
          jobId: attempt.jobId ?? null,
          actorId: attempt.actorId ?? null,
          lane: attempt.lane,
          workloadKind: attempt.workloadKind,
          slot: attempt.slot,
          state: attempt.state,
          runtimeKind: attempt.runtimeKind,
          runtimeId: attempt.runtimeId ?? null,
          reason: attempt.reason ?? null,
          createdAt: attempt.createdAt.toISOString(),
          finishedAt: attempt.finishedAt?.toISOString() ?? null,
        })),
        jobs: app.jobs.recent(100).map((job) => {
          const control = app.jobs.controlState(job.id);
          const activeAttempt = activeAttemptByJob.get(job.id);
          const agentBacked = app.taskRegistry.get(job.kind)?.agent === true;
          const status =
            control?.held ? "held"
            : activeAttempt
              ? activeAttempt.state === "succeeded" ? "done" : activeAttempt.state
            : job.status === "leased" ? (agentBacked ? "queued" : "running")
            : job.status === "dead" ? control?.terminalOutcome ?? "failed"
            : job.status;
          return {
            id: job.id,
            kind: job.kind,
            loopId: job.loopId,
            subjectKey: job.subjectKey ?? null,
            status,
            priority: job.priority,
            attempts: job.attempts,
            maxAttempts: job.maxAttempts,
            executionId: job.executionId ?? null,
            waitingReason:
              control?.held ? control.holdReason ?? "held by operator"
              : activeAttempt?.state === "uncertain"
                ? activeAttempt.reason ?? "prior runtime state is uncertain"
              : job.status === "queued" && activeAttempt
                ? `waiting for prior ${activeAttempt.state} attempt to finish`
              : job.status === "leased" && agentBacked && !activeAttempt
                ? capacity.draining
                  ? "agent pool is draining"
                  : "waiting for agent capacity"
              : job.status === "queued" && job.availableAt > new Date()
                ? `deferred until ${job.availableAt.toISOString()}`
                : job.status === "queued" ? "waiting for an eligible worker and capacity"
                : null,
            supersededByJobId: control?.supersededByJobId ?? null,
            enqueuedAt: job.enqueuedAt.toISOString(),
          };
        }),
        checkpoints: app.checkpointSuspension.checkpoints().map((checkpoint) => ({
          id: checkpoint.id,
          attemptId: checkpoint.attemptId,
          executionId: checkpoint.executionId,
          jobId: checkpoint.jobId ?? null,
          provider: checkpoint.provider,
          protocolVersion: checkpoint.protocolVersion,
          status: checkpoint.status,
          reason: checkpoint.reason ?? null,
          createdAt: checkpoint.createdAt.toISOString(),
          readyAt: checkpoint.readyAt?.toISOString() ?? null,
          consumedAt: checkpoint.consumedAt?.toISOString() ?? null,
        })),
      } satisfies ApiContract.OrchestrationView);
    }
    return methodNotAllowed(request.method);
  }
  if (path === "/api/admin/orchestration/drain") {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    app.orchestration.setDraining(true);
    return json({ capacity: agentCapacitySnapshot() });
  }
  if (path === "/api/admin/orchestration/resume") {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    app.orchestration.setDraining(false);
    return json({ capacity: agentCapacitySnapshot() });
  }
  const suspendExecution = path.match(
    /^\/api\/admin\/orchestration\/executions\/([^/]+)\/suspend$/,
  );
  if (suspendExecution) {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    const executionId = decodeURIComponent(suspendExecution[1]!);
    try {
      const checkpoint = await app.checkpointSuspension.suspend(
        executionId,
        request.signal,
      );
      return json({
        id: checkpoint.id,
        status: checkpoint.status,
        executionId: checkpoint.executionId,
      }, 202);
    } catch (cause) {
      if (cause instanceof SuspensionUnavailableError) {
        return json({
          error: cause.message,
          capability: app.checkpointSuspension.capability(executionId),
        }, 409);
      }
      throw cause;
    }
  }

  if (path === "/api/admin/agent-usage") {
    return routeAgentUsage(request, url, app);
  }

  if (path === "/api/admin/roles") {
    if (request.method === "GET") {
      return json({
        roles: app.roles.list().map(adminRoleView),
      } satisfies ApiContract.AdminRolesView);
    }
    if (request.method === "POST") {
      const body = (await jsonBody(request)) as Record<string, unknown>;
      if (
        typeof body.name !== "string" ||
        (body.description !== undefined && typeof body.description !== "string")
      ) {
        throw new ConfigError("Role name, description, and permissions are invalid.");
      }
      const permissions = permissionsFromBody(body.permissions);
      if (!permissions) throw new ConfigError("Permissions are required.");
      try {
        const created = app.roles.create({
          name: body.name,
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          permissions,
        });
        app.logger.info(
          { actorId: actor.id, roleId: created.id, permissions: created.permissions },
          "administrator created role",
        );
        return json(adminRoleView(created), 201);
      } catch (error) {
        if (error instanceof RoleError) throw new ValidationError(error.message);
        throw error;
      }
    }
    return methodNotAllowed(request.method);
  }

  const roleMatch = path.match(/^\/api\/admin\/roles\/([^/]+)$/);
  if (roleMatch) {
    const id = decodeURIComponent(roleMatch[1]!);
    if (request.method === "PATCH") {
      const body = (await jsonBody(request)) as Record<string, unknown>;
      if (
        typeof body.name !== "string" ||
        (body.description !== undefined && typeof body.description !== "string")
      ) {
        throw new ConfigError("Role name, description, and permissions are invalid.");
      }
      const permissions = permissionsFromBody(body.permissions);
      if (!permissions) throw new ConfigError("Permissions are required.");
      if (
        actor.role.id === id &&
        !createAppAbility(permissions).can("manage", "User")
      ) {
        return json({ error: "You cannot remove your own user-management permission." }, 409);
      }
      try {
        const updated = app.roles.update(id, {
          name: body.name,
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          permissions,
        });
        app.logger.info(
          { actorId: actor.id, roleId: id, permissions: updated.permissions },
          "administrator updated role",
        );
        return json(adminRoleView(updated));
      } catch (error) {
        if (error instanceof RoleError) throw new ValidationError(error.message);
        throw error;
      }
    }
    if (request.method === "DELETE") {
      try {
        app.roles.delete(id);
        app.logger.info({ actorId: actor.id, roleId: id }, "administrator deleted role");
        return json({ deleted: true });
      } catch (error) {
        if (error instanceof RoleError) throw new ValidationError(error.message);
        throw error;
      }
    }
    return methodNotAllowed(request.method);
  }

  if (path === "/api/admin/users") {
    if (request.method === "GET") {
      return json({
        users: app.auth.users().map((profile) => adminUserView(app, profile)),
      } satisfies ApiContract.AdminUsersView);
    }
    if (request.method === "POST") {
      const body = (await jsonBody(request)) as Record<string, unknown>;
      if (
        typeof body.name !== "string" ||
        typeof body.email !== "string" ||
        typeof body.roleId !== "string"
      ) {
        throw new ConfigError("Name, email and a valid role are required.");
      }
      try {
        const created = app.auth.createInvitedUser({
          name: body.name,
          email: body.email,
          roleId: body.roleId,
        });
        app.logger.info(
          {
            actorId: actor.id,
            targetUserId: created.user.id,
            role: created.user.role,
            permissions: created.user.permissions,
          },
          "administrator invited user",
        );
        return json({
          user: adminUserView(app, created.user),
          invitationUrl: invitationUrl(request, app, created.token),
          expiresAt: created.expiresAt.toISOString(),
        } satisfies ApiContract.AdminUserInvitationView, 201);
      } catch (err) {
        if (err instanceof RegistrationError) throw new ValidationError(err.message);
        throw err;
      }
    }
    return methodNotAllowed(request.method);
  }

  const invitationMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/invitation$/);
  if (invitationMatch) {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    const id = decodeURIComponent(invitationMatch[1]!);
    try {
      const invitation = app.auth.createInvitation(id);
      const profile = app.auth.profile(id);
      app.logger.info(
        { actorId: actor.id, targetUserId: id },
        "administrator regenerated user invitation",
      );
      return json({
        user: adminUserView(app, profile),
        invitationUrl: invitationUrl(request, app, invitation.token),
        expiresAt: invitation.expiresAt.toISOString(),
      } satisfies ApiContract.AdminUserInvitationView);
    } catch (err) {
      if (err instanceof RegistrationError) throw new ValidationError(err.message);
      throw err;
    }
  }

  const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userMatch) {
    const id = decodeURIComponent(userMatch[1]!);
    if (request.method === "GET") {
      const profile = app.auth.profile(id);
      if (!profile) return notFound(`No user '${id}'.`);
      return json(adminUserDetailView(app, profile));
    }
    if (request.method === "PATCH") {
      const body = (await jsonBody(request)) as Record<string, unknown>;
      if (
        typeof body.name !== "string" ||
        typeof body.email !== "string" ||
        typeof body.roleId !== "string"
      ) {
        throw new ConfigError("Name, email and a valid role are required.");
      }
      let permissions: AppPermission[];
      try {
        permissions = app.roles.permissions(body.roleId);
      } catch (error) {
        if (error instanceof RoleError) throw new ValidationError(error.message);
        throw error;
      }
      if (
        id === actor.id &&
        !createAppAbility(permissions).can("manage", "User")
      ) {
        return json({ error: "You cannot remove your own user-management permission." }, 409);
      }
      try {
        const updated = await app.auth.updateUser(id, {
          name: body.name,
          email: body.email,
          roleId: body.roleId,
        });
        app.logger.info(
          {
            actorId: actor.id,
            targetUserId: updated.id,
            role: updated.role,
            permissions: updated.permissions,
          },
          "administrator updated user",
        );
        return json(adminUserView(app, updated));
      } catch (err) {
        if (err instanceof RegistrationError) throw new ValidationError(err.message);
        throw err;
      }
    }

    if (request.method === "DELETE") {
      if (id === actor.id) return json({ error: "You cannot delete your own account here." }, 409);
      const profile = app.auth.profile(id);
      if (!profile) return notFound(`No user '${id}'.`);
      if (profile.builtIn) {
        return json({ error: "Built-in accounts cannot be deleted." }, 409);
      }

      const owned = app.instances
        .all()
        .filter((instance) => instance.ownerId === id && instance.visibility === "private");
      const running = owned.find(
        (instance) => app.sink.lastRun(instance.id)?.status === "running",
      );
      if (running) {
        return json(
          {
            error:
              `User '${profile.email}' owns the running loop '${running.name}'. ` +
              "Cancel it before deleting the account.",
          },
          409,
        );
      }
      for (const instance of owned) await app.tasks.deleteInstance(instance.id);
      try {
        app.auth.deleteAccount(id);
      } catch (err) {
        if (err instanceof RegistrationError) throw new ValidationError(err.message);
        throw err;
      }
      app.logger.info(
        { actorId: actor.id, targetUserId: id, deletedLoops: owned.length },
        "administrator deleted user",
      );
      return json({ deleted: true, deletedLoops: owned.map((instance) => instance.id) } satisfies
        ApiContract.AccountDeletedView);
    }
    return methodNotAllowed(request.method);
  }

  if (path === "/api/admin/feedback") {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    return json(await adminFeedbackView(app, actor, request.signal));
  }

  const feedbackMatch = path.match(/^\/api\/admin\/feedback\/([^/]+)$/);
  if (feedbackMatch) {
    if (request.method !== "DELETE") return methodNotAllowed(request.method);
    const id = decodeURIComponent(feedbackMatch[1]!);
    const feedback = app.feedback.get(id);
    if (!feedback) return notFound(`No feedback '${id}'.`);
    if (feedback.publicationStatus === "published") {
      return json(
        { error: "Published feedback is managed in GitLab and cannot be deleted locally." },
        409,
      );
    }
    if (!app.feedback.delete(id)) return notFound(`No feedback '${id}'.`);
    app.logger.info(
      { actorId: actor.id, feedbackId: id },
      "administrator deleted feedback",
    );
    return json({ deleted: true });
  }

  if (path === "/api/admin/logs") {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    const limit = clampPageParam(url.searchParams.get("limit"), 200, 1_000);
    return json({
      logs: app.applicationLogs.list(limit).map((line) => ({
        id: line.id,
        timestamp: line.timestamp.toISOString(),
        level: line.level,
        message: line.message,
        ...(line.meta ? { meta: line.meta } : {}),
      })),
    } satisfies ApiContract.AdminLogsView);
  }

  return notFound(`No API route for ${path}.`);
}

/**
 * Resolves a request to a response. Returns null for paths the caller should
 * handle instead (static assets), so route matching stays in one place.
 */
export async function handleApiRequest(
  request: Request,
  app: App,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!path.startsWith("/api/")) return null;

  try {
    if (path.startsWith("/api/auth/")) return routeAuth(request, path, app);
    const user = app.auth.userFor(request);
    if (!user) return json({ error: "Authentication required." }, 401);
    return await route(request, path, url, app, user);
  } catch (err) {
    if (isRequestAbort(err, request)) {
      app.logger.debug({ path }, "API request cancelled by the client");
      return json({ error: "Request cancelled." }, 499);
    }
    // Operator-facing errors carry a usable message; anything else is a bug and
    // must not leak its internals to a browser.
    if (err instanceof TalosError) {
      return json({ error: err.message, kind: err.name }, 400);
    }
    app.logger.error({ err: String(err), path }, "unhandled error serving API request");
    return json({ error: "internal error" }, 500);
  }
}

/** Internal capability callers share the UI router without minting a session or forwarding cookies. */
export async function handleAssistantApiRequest(
  app: App,
  actor: { id: string },
  path: string,
  init: RequestInit,
): Promise<Response> {
  const url = new URL(path, "http://talos.internal");
  if (!path.startsWith("/api/") || url.origin !== "http://talos.internal" ||
      !url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/auth/") ||
      url.pathname.startsWith("/api/assistant/") || url.hash) {
    return json({ error: "Only application API operations are available; authentication and assistant transport are excluded." }, 400);
  }
  const user = app.auth.byId(actor.id);
  if (!user || app.auth.profile(actor.id)?.accountStatus !== "active") {
    return json({ error: "Authentication required." }, 401);
  }
  const request = new Request(url.toString(), init);
  try {
    request.signal.throwIfAborted();
    return await route(request, url.pathname, url, app, user);
  } catch (error) {
    if (error instanceof TalosError) return json({ error: error.message, kind: error.name }, 400);
    app.logger.error({ actorId: actor.id, path: url.pathname, err: String(error) }, "assistant API operation failed");
    return json({ error: "Operation failed." }, 500);
  }
}

async function route(
  request: Request,
  path: string,
  url: URL,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (path.startsWith("/api/dashboards")) {
    return routeDashboards(request, path, app, user);
  }

  if (path.startsWith("/api/admin/")) {
    const ability = createAppAbility(user.permissions);
    if (path === "/api/admin/agent-usage" && user.role.id !== ADMIN_ROLE_ID) {
      return json({ error: "Administrator role is required." }, 403);
    }
    if (
      (path.startsWith("/api/admin/users") || path.startsWith("/api/admin/roles")) &&
      !ability.can("manage", "User")
    ) {
      return json({ error: "User-management permission is required." }, 403);
    }
    if (path.startsWith("/api/admin/feedback") && !ability.can("manage", "User")) {
      return json({ error: "User-management permission is required." }, 403);
    }
    if (path === "/api/admin/logs" && !ability.can("read", "ApplicationLog")) {
      return json({ error: "Application-log permission is required." }, 403);
    }
    if (
      path.startsWith("/api/admin/orchestration") &&
      !ability.can("manage", "InstanceSettings")
    ) {
      return json({ error: "Instance-settings permission is required." }, 403);
    }
    return routeAdmin(request, path, url, app, user);
  }

  if (
    requiresAdministrator(path, request.method) &&
    !createAppAbility(user.permissions).can("manage", "InstanceSettings")
  ) {
    return json({ error: "Instance-settings permission is required." }, 403);
  }

  const requiredModules = moduleSubjectsForPath(path);
  if (requiredModules) {
    const ability = createAppAbility(user.permissions);
    if (!requiredModules.some((subject) => ability.can("read", subject))) {
      return json({ error: "Access to this module is not permitted by your role." }, 403);
    }
  }

  if (path === "/api/users") {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    return json({
      users: app.auth.users()
        .filter((account) => account.accountStatus === "active")
        .map((account) => ({
          id: account.id,
          name: account.name,
          email: account.email,
        })),
    } satisfies ApiContract.TalosUsersView);
  }

  if (path === "/api/automation/dashboard") {
    return routeAutomationDashboard(request, url, app);
  }

  if (path === "/api/automation/failure-inbox") {
    return routeAutomationFailureInbox(request, url, app);
  }

  if (path === "/api/automation/config") {
    return routeAutomationConfig(request, app);
  }

  if (path === "/api/automation/config/schedules") {
    return routeAutomationScheduleDiscovery(request, url, app);
  }

  if (path === "/api/automation/sync") {
    return routeAutomationSync(request, app);
  }

  const automationAttachment = path.match(
    /^\/api\/automation\/pipelines\/([^/]+)\/failed-tests\/([^/]+)\/([^/]+)\/attachment$/,
  );
  if (automationAttachment) {
    return routeAutomationAttachment(
      request,
      automationAttachment[1]!,
      automationAttachment[2]!,
      automationAttachment[3]!,
      app,
    );
  }

  const automationClusterBulkTicket = path.match(
    /^\/api\/automation\/pipelines\/([^/]+)\/failure-clusters\/(?:ticket|bulk-ticket)$/,
  );
  if (automationClusterBulkTicket) {
    return routeAutomationFailureClusterBulkTicket(
      request,
      automationClusterBulkTicket[1]!,
      app,
    );
  }

  const automationClusterTicket = path.match(
    /^\/api\/automation\/pipelines\/([^/]+)\/failure-clusters\/([^/]+)\/ticket$/,
  );
  if (automationClusterTicket) {
    return routeAutomationFailureClusterTicket(
      request,
      automationClusterTicket[1]!,
      decodeURIComponent(automationClusterTicket[2]!),
      app,
    );
  }

  const automationClusterTriage = path.match(
    /^\/api\/automation\/pipelines\/([^/]+)\/failure-clusters\/([^/]+)\/triage$/,
  );
  if (automationClusterTriage) {
    return routeAutomationFailureClusterTriage(
      request,
      automationClusterTriage[1]!,
      decodeURIComponent(automationClusterTriage[2]!),
      app,
      user,
    );
  }

  const automationClusterAssignee = path.match(
    /^\/api\/automation\/pipelines\/([^/]+)\/failure-clusters\/([^/]+)\/assignee$/,
  );
  if (automationClusterAssignee) {
    return routeAutomationFailureClusterAssignee(
      request,
      automationClusterAssignee[1]!,
      decodeURIComponent(automationClusterAssignee[2]!),
      app,
      user,
    );
  }

  const automationClusterDetail = path.match(
    /^\/api\/automation\/pipelines\/([^/]+)\/failure-clusters\/([^/]+)$/,
  );
  if (automationClusterDetail) {
    return routeAutomationFailureClusterDetail(
      request,
      automationClusterDetail[1]!,
      decodeURIComponent(automationClusterDetail[2]!),
      app,
    );
  }

  const automationClusters = path.match(
    /^\/api\/automation\/pipelines\/([^/]+)\/failure-clusters$/,
  );
  if (automationClusters) {
    return routeAutomationFailureClusters(
      request,
      url,
      automationClusters[1]!,
      app,
    );
  }

  const automationPipeline = path.match(/^\/api\/automation\/pipelines\/([^/]+)$/);
  if (automationPipeline) {
    return routeAutomationPipeline(
      request,
      decodeURIComponent(automationPipeline[1]!),
      app,
    );
  }

  if (path === "/api/assistant/chat") {
    return routeAssistantChat(request, app, user);
  }

  const taskSchedule = path.match(/^\/api\/tasks\/([^/]+)\/schedule$/);
  if (taskSchedule) {
    const id = decodeURIComponent(taskSchedule[1]!);
    return routeTaskSchedule(request, id, app, user);
  }

  const taskRun = path.match(/^\/api\/tasks\/([^/]+)\/run$/);
  if (taskRun) {
    const id = decodeURIComponent(taskRun[1]!);
    return routeTaskRun(request, id, app, user);
  }

  // Checked ahead of the id-shaped route below, since "active-actions" would
  // otherwise parse as a (invalid) pull request id.
  if (path === "/api/pull-requests/active-actions") {
    return routePullRequestActiveActions(app);
  }

  const pullRequestAsset = path.match(/^\/api\/pull-requests\/([^/]+)\/assets$/);
  if (pullRequestAsset) {
    return routePullRequestAsset(
      request,
      url,
      decodeURIComponent(pullRequestAsset[1]!),
      app,
      user,
    );
  }

  // A provider-qualified id (`gitlab:group/project!12`) is percent-encoded whole
  // by the client, so it stays a single path segment — `%2F` survives
  // `new URL().pathname` untouched, which is what makes `[^/]+` correct here.
  // Matched ahead of the route below rather than as an optional group inside it:
  // only `changes` takes a trailing segment, and folding it in would also have
  // quietly started accepting `/actions/anything`.
  const commitChanges = path.match(/^\/api\/pull-requests\/([^/]+)\/changes\/([^/]+)$/);
  if (commitChanges) {
    return routePullRequestDetail(
      request,
      url,
      decodeURIComponent(commitChanges[1]!),
      "changes",
      app,
      user,
      decodeURIComponent(commitChanges[2]!),
    );
  }

  const pullRequest = path.match(
    /^\/api\/pull-requests\/([^/]+)(?:\/(changes|actions|activity|runs))?$/,
  );
  if (pullRequest) {
    const id = decodeURIComponent(pullRequest[1]!);
    return routePullRequestDetail(request, url, id, pullRequest[2], app, user);
  }

  const taskCancel = path.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
  if (taskCancel) {
    const id = decodeURIComponent(taskCancel[1]!);
    return routeTaskCancel(request, id, app, user);
  }

  const runCancel = path.match(/^\/api\/task-runs\/([^/]+)\/cancel$/);
  if (runCancel) {
    const executionId = decodeURIComponent(runCancel[1]!);
    return routeRunCancel(request, executionId, app, user);
  }

  const jobCancel = path.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (jobCancel) {
    const jobId = decodeURIComponent(jobCancel[1]!);
    return routeJobCancel(request, jobId, app, user);
  }
  const jobManage = path.match(/^\/api\/jobs\/([^/]+)\/(hold|resume|priority|supersede)$/);
  if (jobManage) {
    return routeJobManagement(
      request,
      decodeURIComponent(jobManage[1]!),
      jobManage[2] as "hold" | "resume" | "priority" | "supersede",
      app,
      user,
    );
  }

  if (path === "/api/tasks/loop-definitions" && request.method === "GET") {
    return json(app.loops.definitions(user));
  }
  if (path === "/api/tasks/loop-config" && request.method === "POST") {
    const input = request.headers.get("content-type")?.includes("json")
      ? await request.json() : await request.text();
    return json(app.loops.create(user, input), 201);
  }
  const loopConfig = path.match(/^\/api\/tasks\/([^/]+)\/loop-config$/);
  if (loopConfig) {
    const id = decodeURIComponent(loopConfig[1]!);
    if (request.method === "GET") return json(app.loops.read(user, id));
    if (request.method === "PUT") {
      const input = request.headers.get("content-type")?.includes("json")
        ? await request.json() : await request.text();
      return json(app.loops.replace(user, id, input));
    }
    return methodNotAllowed(request.method);
  }

  if (path === "/api/tasks" && request.method === "POST") {
    return routeTaskCreate(request, app, user);
  }

  const taskUpdate = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskUpdate && (request.method === "PUT" || request.method === "PATCH")) {
    const id = decodeURIComponent(taskUpdate[1]!);
    return routeTaskUpdate(request, id, app, user);
  }
  if (taskUpdate && request.method === "DELETE") {
    const id = decodeURIComponent(taskUpdate[1]!);
    return routeTaskDelete(id, app, user);
  }

  if (path === "/api/notifications/read-all" && request.method === "POST") {
    // Only the ones this developer can actually see — a notification they were
    // never shown must not be marked read on their behalf, or it would be gone
    // from the owner's bell too (the table is install-wide).
    for (const notification of visibleNotifications(app, user, { unreadOnly: true })) {
      app.notifications.markRead(notification.id);
    }
    return json({ ok: true });
  }

  /**
   * GET /api/tickets/:key — one Jira ticket in full, for the ticket panel.
   *
   * Under `/api/tickets` rather than `/api/graph`, because the ticket is not a
   * fact about the graph: the same read is what a search hit or a merge request's
   * "TP-1204" badge would want, and putting it behind the canvas that happens to be
   * its first caller would make the second one look like a special case.
   *
   * The key is validated against Jira's own key shape before it reaches the client
   * — this is a path segment interpolated into an outbound URL, and `PROJ-12/../`
   * has no business being one.
   */
  const ticketTextAttachment = path.match(
    /^\/api\/tickets\/([^/]+)\/attachments\/(\d+)\/text$/,
  );
  if (ticketTextAttachment) {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    const issueKey = jiraKeyFromPath(ticketTextAttachment[1]!);
    const attachmentId = ticketTextAttachment[2]!;
    const detail = await cachedTicketDetail(app, user, issueKey);
    const attachment = detail.ticket?.attachments.find(
      (candidate) => candidate.id === attachmentId,
    );
    if (!attachment) {
      return json({ error: `Attachment ${attachmentId} is not present on ${issueKey}.` }, 404);
    }
    if (
      !attachment.mimeType?.startsWith("text/") &&
      !/\.txt$/i.test(attachment.filename)
    ) {
      return json({ error: `Attachment ${attachmentId} is not plain text.` }, 415);
    }
    return json(
      (await app.ticketDetails.attachmentText(user, attachmentId, {
        signal: request.signal,
      })) satisfies ApiContract.TicketTextAttachmentResponse,
    );
  }

  const ticketAttachment = path.match(
    /^\/api\/tickets\/([^/]+)\/attachments\/(\d+)$/,
  );
  if (ticketAttachment) {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    const issueKey = jiraKeyFromPath(ticketAttachment[1]!);
    const attachmentId = ticketAttachment[2]!;
    const detail = await cachedTicketDetail(app, user, issueKey);
    const attachment = detail.ticket?.attachments.find(
      (candidate) => candidate.id === attachmentId,
    );
    if (!attachment) {
      return json({ error: `Attachment ${attachmentId} is not present on ${issueKey}.` }, 404);
    }
    const location = await app.ticketDetails.attachmentUrl(user, attachmentId, {
      signal: request.signal,
    });
    return new Response(null, {
      status: 302,
      headers: {
        location,
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  const ticket = path.match(/^\/api\/tickets\/([^/]+)$/);
  if (ticket) {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    return json(
      await cachedTicketDetail(app, user, jiraKeyFromPath(ticket[1]!), {
        bypass: wantsFreshData(request),
      }),
    );
  }

  /**
   * GET /api/tickets/:key/plan — the implementation plan for one ticket, in full.
   *
   * Separate from the graph payload on purpose. The canvas polls every three seconds
   * with dozens of clusters in it and carries only a plan *summary*; the document
   * itself runs to kilobytes and is wanted only when somebody opens the Plan tab.
   */
  const ticketPlan = path.match(/^\/api\/tickets\/([^/]+)\/plan$/);
  if (ticketPlan) {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    return json(
      (await planViewFor(app, user, jiraKeyFromPath(ticketPlan[1]!))) satisfies
        ApiContract.TicketPlanView,
    );
  }

  /** GET /api/plans — every plan waiting on a human, oldest first. */
  if (path === "/api/plans") {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    return json((await planInbox(app, user)) satisfies ApiContract.PlanInboxView);
  }

  /**
   * POST /api/plans/:id/decision — approve or reject one plan.
   *
   * The only route that can put a plan in front of a container, which is why the
   * checks behind it (the reviewer's own text, a ticket that has not moved, a plan
   * still awaiting a decision) live in `plan-actions.ts` and not in the console.
   */
  const planDecision = path.match(/^\/api\/plans\/([^/]+)\/decision$/);
  if (planDecision) {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    return routePlanDecision(request, app, user, decodeURIComponent(planDecision[1]!));
  }

  if (path === "/api/graph/mr-action" && request.method === "POST") {
    return routeMrAction(request, app, user);
  }

  if (path === "/api/graph/ticket-action" && request.method === "POST") {
    return routeTicketAction(request, app, user);
  }

  if (path === "/api/e2e/test-mr") {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    return routeE2eTestMr(request, app, user);
  }

  if (path === "/api/graph/ticket-status" && request.method === "POST") {
    return routeTicketStatus(request, app, user);
  }

  const e2eArtifact = path.match(/^\/api\/e2e\/jobs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (e2eArtifact) {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    return e2eArtifactResponse(
      app,
      user,
      decodeURIComponent(e2eArtifact[1]!),
      decodeURIComponent(e2eArtifact[2]!),
      request.signal,
    );
  }

  // The one action this endpoint could start when it was the only one. Kept
  // because it is a documented POST a script can already be making — see
  // `routeTicketAction` for why the body needs no action to be safe.
  if (path === "/api/graph/fix-issue" && request.method === "POST") {
    return routeTicketAction(request, app, user, "fix-issue");
  }

  if (path === "/api/settings") {
    return routeSettings(request, app);
  }

  if (path === "/api/settings/resolved-models") {
    return routeResolvedModels(request, app);
  }

  if (path === "/api/settings/integrations") {
    return routeIntegrations(request, app);
  }

  if (path === "/api/settings/e2e-tests") {
    return routeE2eTestSettings(request, app);
  }

  if (path === "/api/logrocket/issues") {
    return routeLogRocketIssues(request, url, app, user);
  }

  const logRocketAction = path.match(
    /^\/api\/logrocket\/issues\/([^/]+)\/(fix|state|regression-test)$/,
  );
  if (logRocketAction) {
    return routeLogRocketAction(
      request,
      url,
      decodeURIComponent(logRocketAction[1]!),
      logRocketAction[2] as "fix" | "state" | "regression-test",
      app,
      user,
    );
  }

  if (path === "/api/datadog/issues") {
    return routeDatadogIssues(request, url, app, user);
  }

  if (path === "/api/datadog/activity") {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    const limit = clampPageParam(url.searchParams.get("limit"), 15, 100);
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
    return json(toDatadogActivityView(app, { limit, offset }));
  }

  if (path === "/api/datadog/scan") {
    return routeDatadogScan(request, app, user);
  }

  const datadogAction = path.match(
    /^\/api\/datadog\/problems\/([^/]+)\/(fix|state|regression-test|ai-triage)$/,
  );
  if (datadogAction) {
    return routeDatadogAction(
      request,
      url,
      decodeURIComponent(datadogAction[1]!),
      datadogAction[2] as "fix" | "state" | "regression-test" | "ai-triage",
      app,
      user,
    );
  }

  if (path === "/api/datadog/routing") {
    return routeDatadogRouting(request, app);
  }

  if (path === "/api/datadog/service-targets") {
    return routeDatadogServiceTargets(request, app);
  }

  if (path === "/api/flaky-specs") {
    return routeFlakySpecs(request, url, app);
  }

  if (path === "/api/flaky-specs/state") {
    return routeFlakySpecState(request, url, app);
  }

  if (path === "/api/flaky-specs/file") {
    return routeFlakySpecFile(request, app);
  }

  if (path === "/api/feedback/pending") {
    return routePendingFeedback(request, app, user);
  }

  const feedbackPublishMatch = path.match(/^\/api\/feedback\/([^/]+)\/publish$/);
  if (feedbackPublishMatch) {
    return routeFeedbackPublish(
      request,
      app,
      user,
      decodeURIComponent(feedbackPublishMatch[1]!),
    );
  }

  if (path === "/api/feedback") {
    return routeFeedback(request, app, user);
  }

  const datadogRule = path.match(/^\/api\/datadog\/routing\/([^/]+)$/);
  if (datadogRule) {
    return routeDatadogRule(request, decodeURIComponent(datadogRule[1]!), app);
  }

  const datadogServiceTarget = path.match(/^\/api\/datadog\/service-targets\/([^/]+)$/);
  if (datadogServiceTarget) {
    return routeDatadogServiceTarget(
      request,
      decodeURIComponent(datadogServiceTarget[1]!),
      app,
    );
  }

  if (path === "/api/prompts") {
    return routePrompts(request, app);
  }

  if (path === "/api/me/credentials") {
    return routeMyCredentials(request, url, app, user);
  }

  if (path === "/api/me/slack/connection") {
    if (request.method === "GET") {
      return privateJson(
        app.slackInbox.connectionView(user.id) satisfies ApiContract.SlackConnectionView,
      );
    }
    if (request.method === "DELETE") {
      return privateJson({ removed: await app.slackInbox.disconnect(user.id, request.signal) });
    }
    return methodNotAllowed(request.method);
  }

  if (path === "/api/me/slack/oauth/start") {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    const origin = app.runtime?.publicUrl?.origin ?? url.origin;
    const started = app.slackInbox.startOAuth(user, origin);
    return privateJson(
      { authorizeUrl: started.authorizeUrl } satisfies ApiContract.SlackOAuthStartView,
      200,
      { "set-cookie": slackOAuthCookie(started.browserNonce, origin, 10 * 60) },
    );
  }

  if (path === "/api/me/slack/activity") {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    return privateJson({
      revision: app.slackInbox.activityRevision(user.id),
      unreadCount: app.slackInbox.unreadActivityCount(user.id),
    } satisfies ApiContract.SlackActivityView);
  }

  if (path === "/api/me/slack/activity/stream") {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    return app.slackActivityEvents.stream(
      user.id,
      request.signal,
      (changedConversationIds) =>
        ({
          revision: app.slackInbox.activityRevision(user.id),
          unreadCount: app.slackInbox.unreadActivityCount(user.id),
          ...(changedConversationIds.length > 0 ? { changedConversationIds } : {}),
        }) satisfies ApiContract.SlackActivityView,
    );
  }

  if (path === "/api/me/slack/resync") {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    app.slackInbox.resync(user.id);
    return privateJson({ ok: true });
  }

  if (path === "/api/me/slack/channels") {
    if (request.method === "GET") {
      const channels = await app.slackInbox.channels(user, request.signal);
      return privateJson({
        channels,
        selectedIds: channels.filter((channel) => channel.selected).map((channel) => channel.id),
      } satisfies ApiContract.SlackChannelsView);
    }
    if (request.method === "PUT") {
      const body = (await readJsonBody(request)) as { channelIds?: unknown } | null;
      if (!body || !Array.isArray(body.channelIds) || !body.channelIds.every((id) => typeof id === "string")) {
        throw new ConfigError("'channelIds' must be an array of Slack channel IDs.");
      }
      const channels = await app.slackInbox.setChannels(user, body.channelIds, request.signal);
      return privateJson({
        channels,
        selectedIds: channels.filter((channel) => channel.selected).map((channel) => channel.id),
      } satisfies ApiContract.SlackChannelsView);
    }
    return methodNotAllowed(request.method);
  }

  if (path === "/api/me/slack/read") {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    const body = (await readJsonBody(request)) as {
      conversationId?: unknown;
      timestamp?: unknown;
    } | null;
    if (
      !body ||
      typeof body.conversationId !== "string" ||
      typeof body.timestamp !== "string"
    ) {
      throw new ConfigError("'conversationId' and 'timestamp' are required.");
    }
    await app.slackInbox.markRead(
      user,
      body.conversationId,
      body.timestamp,
      request.signal,
    );
    return privateJson({ ok: true });
  }

  if (path === "/api/me/agent-accounts/login") {
    return routeAgentLogin(request, url, app, user);
  }

  if (path === "/api/me/agent-accounts/use-for-runs") {
    return routeAgentAccountUseForRuns(request, app, user);
  }

  if (path === "/api/me/agent-accounts") {
    return routeMyAgentAccounts(request, url, app, user);
  }

  if (path === "/api/me/agent-usage") {
    return routeAgentUsage(request, url, app, user.id);
  }

  if (path === "/api/me/agent-run-preferences") {
    return routeMyAgentRunPreferences(request, app, user);
  }

  if (path === "/api/me/pull-request-repos") {
    return routeMyPullRequestRepos(request, app, user);
  }

  if (path === "/api/me/fix-issue-defaults") {
    return routeMyFixIssueDefaults(request, app, user);
  }

  if (path === "/api/me/preferences") {
    return routeMyPreferences(request, app, user);
  }

  if (path === "/api/me/notification-subscriptions") {
    return routeMyNotificationSubscriptions(request, app, user);
  }

  if (path === "/api/me/profile") {
    return routeMyProfile(request, app, user);
  }

  if (path === "/api/releases/upload") {
    return routeReleaseUpload(request, app, user);
  }

  if (path === "/api/releases/revert") {
    return routeReleaseRevert(request, url, app, user);
  }

  if (path === "/api/releases/deployment-status") {
    return routeReleaseDeploymentStatus(request, app);
  }

  if (path === "/api/releases/config") {
    return routeReleaseConfig(request, app);
  }

  const slackUserProfile = path.match(/^\/api\/slack\/users\/([^/]+)\/profile$/);
  if (slackUserProfile) {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    return privateJson(
      await app.slackInbox.userProfile(
        user,
        decodeURIComponent(slackUserProfile[1]!),
        request.signal,
      ) satisfies ApiContract.SlackUserProfileView,
    );
  }

  if (path === "/api/slack/users") {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    return privateJson(
      await app.slackInbox.workspaceUsers(
        user,
        url.searchParams.get("q") ?? undefined,
        request.signal,
      ) satisfies ApiContract.SlackWorkspaceUsersView,
    );
  }

  if (path === "/api/slack/direct-messages") {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    const body = (await readJsonBody(request)) as { userId?: unknown } | null;
    if (!body || typeof body.userId !== "string") {
      throw new ConfigError("'userId' is required.");
    }
    return privateJson(
      await app.slackInbox.openDirectMessage(
        user,
        body.userId,
        request.signal,
      ) satisfies ApiContract.SlackConversationView,
    );
  }

  const slackDirectMessage = path.match(/^\/api\/slack\/direct-messages\/([^/]+)$/);
  if (slackDirectMessage) {
    if (request.method !== "DELETE") return methodNotAllowed(request.method);
    return privateJson({
      hidden: app.slackInbox.hideDirectMessage(
        user,
        decodeURIComponent(slackDirectMessage[1]!),
      ),
    });
  }

  if (path === "/api/slack/inbox") {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    return privateJson(
      await app.slackInbox.inbox(
        user,
        url.searchParams.get("cursor") ?? undefined,
        request.signal,
      ),
    );
  }

  const slackMembers = path.match(
    /^\/api\/slack\/conversations\/([^/]+)\/members$/,
  );
  if (slackMembers) {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    return privateJson(
      await app.slackInbox.conversationMembers(
        user,
        decodeURIComponent(slackMembers[1]!),
        request.signal,
      ) satisfies ApiContract.SlackConversationMembersView,
    );
  }

  const slackDetails = path.match(
    /^\/api\/slack\/conversations\/([^/]+)\/details$/,
  );
  if (slackDetails) {
    const conversationId = decodeURIComponent(slackDetails[1]!);
    if (request.method === "GET") {
      return privateJson(
        await app.slackInbox.conversationDetails(
          user,
          conversationId,
          request.signal,
        ) satisfies ApiContract.SlackConversationDetailsView,
      );
    }
    if (request.method === "PATCH") {
      const body = (await readJsonBody(request)) as {
        name?: unknown;
        topic?: unknown;
      } | null;
      if (
        !body ||
        (body.name !== undefined && typeof body.name !== "string") ||
        (body.topic !== undefined && typeof body.topic !== "string")
      ) {
        throw new ConfigError("'name' and 'topic' must be strings.");
      }
      return privateJson(
        await app.slackInbox.updateConversationDetails(
          user,
          conversationId,
          {
            ...(typeof body.name === "string" ? { name: body.name } : {}),
            ...(typeof body.topic === "string" ? { topic: body.topic } : {}),
          },
          request.signal,
        ) satisfies ApiContract.SlackConversationDetailsView,
      );
    }
    return methodNotAllowed(request.method);
  }

  const slackSearch = path.match(
    /^\/api\/slack\/conversations\/([^/]+)\/search$/,
  );
  if (slackSearch) {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    return privateJson(
      await app.slackInbox.searchConversation(
        user,
        decodeURIComponent(slackSearch[1]!),
        url.searchParams.get("q") ?? "",
        Number(url.searchParams.get("page") ?? "1"),
        {
          fromMe: url.searchParams.get("fromMe") === "true",
          includesMe: url.searchParams.get("includesMe") === "true",
          hasLink: url.searchParams.get("hasLink") === "true",
          threadsOnly: url.searchParams.get("threadsOnly") === "true",
        },
        request.signal,
      ) satisfies ApiContract.SlackConversationSearchView,
    );
  }

  const slackThread = path.match(
    /^\/api\/slack\/conversations\/([^/]+)\/threads\/([^/]+)$/,
  );
  if (slackThread) {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    return privateJson(
      await app.slackInbox.thread(
        user,
        decodeURIComponent(slackThread[1]!),
        decodeURIComponent(slackThread[2]!),
        url.searchParams.get("cursor") ?? undefined,
        url.searchParams.get("focus") ?? undefined,
        request.signal,
      ),
    );
  }

  const slackMessage = path.match(
    /^\/api\/slack\/conversations\/([^/]+)\/messages\/([^/]+)$/,
  );
  if (slackMessage) {
    const conversationId = decodeURIComponent(slackMessage[1]!);
    const timestamp = decodeURIComponent(slackMessage[2]!);
    if (request.method === "PUT") {
      const body = (await readJsonBody(request)) as { text?: unknown } | null;
      if (!body || typeof body.text !== "string") {
        throw new ConfigError("'text' is required.");
      }
      return privateJson(
        await app.slackInbox.updateMessage(
          user,
          conversationId,
          timestamp,
          body.text,
          request.signal,
        ) satisfies ApiContract.SlackMessageUpdateResult,
      );
    }
    if (request.method === "DELETE") {
      await app.slackInbox.deleteMessage(
        user,
        conversationId,
        timestamp,
        request.signal,
      );
      return privateJson({ ok: true });
    }
    return methodNotAllowed(request.method);
  }

  const slackReaction = path.match(
    /^\/api\/slack\/conversations\/([^/]+)\/messages\/([^/]+)\/reaction$/,
  );
  if (slackReaction) {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    const body = (await readJsonBody(request)) as {
      name?: unknown;
      active?: unknown;
    } | null;
    if (
      !body ||
      typeof body.name !== "string" ||
      typeof body.active !== "boolean"
    ) {
      throw new ConfigError("'name' and boolean 'active' are required.");
    }
    await app.slackInbox.setReaction(
      user,
      decodeURIComponent(slackReaction[1]!),
      decodeURIComponent(slackReaction[2]!),
      body.name,
      body.active,
      request.signal,
    );
    return privateJson({ ok: true });
  }

  const slackImage = path.match(
    /^\/api\/slack\/conversations\/([^/]+)\/files\/([^/]+)$/,
  );
  if (slackImage) {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    const image = await app.slackInbox.imageContent(
      user,
      decodeURIComponent(slackImage[1]!),
      decodeURIComponent(slackImage[2]!),
      url.searchParams.get("variant") === "thumbnail",
      request.signal,
    );
    const headers = new Headers({
      "content-type": image.contentType,
      "content-disposition": inlineContentDisposition(image.filename),
      "cache-control": "private, max-age=300",
      vary: "Cookie",
      "x-content-type-options": "nosniff",
    });
    if (image.contentLength) headers.set("content-length", image.contentLength);
    return new Response(image.body, { headers });
  }

  const slackImages = path.match(
    /^\/api\/slack\/conversations\/([^/]+)\/images$/,
  );
  if (slackImages) {
    if (request.method !== "POST") return methodNotAllowed(request.method);
    const declared = Number(request.headers.get("content-length"));
    if (!Number.isFinite(declared) || declared <= 0) {
      throw new ConfigError("Slack image uploads require a bounded request body.");
    }
    if (declared > 42 * 1024 * 1024) {
      return privateJson({ error: "Slack image upload is too large." }, 413);
    }
    const form = await request.formData().catch((cause) => {
      throw new ConfigError("Slack image upload must be multipart form data.", { cause });
    });
    const values = form.getAll("images");
    if (
      values.length < 1 ||
      values.length > 4 ||
      values.some((value) => typeof value === "string")
    ) {
      throw new ConfigError("Attach between 1 and 4 image files.");
    }
    const textValue = form.get("text");
    const threadValue = form.get("threadTs");
    if (
      (textValue != null && typeof textValue !== "string") ||
      (threadValue != null && typeof threadValue !== "string")
    ) {
      throw new ConfigError("Slack image text and thread timestamp must be strings.");
    }
    const files = await Promise.all(
      values.map(async (file, index) => {
        if (typeof file === "string") {
          throw new ConfigError("Slack image attachments must be files.");
        }
        return {
          name: file.name.trim().slice(0, 200) || `clipboard-image-${index + 1}`,
          mimeType: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        };
      }),
    );
    return privateJson(
      await app.slackInbox.sendImages(
        user,
        decodeURIComponent(slackImages[1]!),
        files,
        textValue?.toString(),
        threadValue?.toString(),
        request.signal,
      ) satisfies ApiContract.SlackMessageSendResult,
    );
  }

  const slackMessages = path.match(/^\/api\/slack\/conversations\/([^/]+)\/messages$/);
  if (slackMessages) {
    const conversationId = decodeURIComponent(slackMessages[1]!);
    if (request.method === "GET") {
      return privateJson(
        await app.slackInbox.messages(
          user,
          conversationId,
          url.searchParams.get("cursor") ?? undefined,
          url.searchParams.get("focus") ?? undefined,
          request.signal,
        ),
      );
    }
    if (request.method === "POST") {
      const body = (await readJsonBody(request)) as {
        text?: unknown;
        threadTs?: unknown;
      } | null;
      if (
        !body ||
        typeof body.text !== "string" ||
        (body.threadTs !== undefined && typeof body.threadTs !== "string")
      ) {
        throw new ConfigError("'text' is required and 'threadTs' must be a string.");
      }
      return privateJson(
        await app.slackInbox.sendMessage(
          user,
          conversationId,
          body.text,
          body.threadTs,
          request.signal,
        ) satisfies ApiContract.SlackMessageSendResult,
      );
    }
    return methodNotAllowed(request.method);
  }

  // Everything below is read-only.
  if (request.method !== "GET") return methodNotAllowed(request.method);

  if (path === "/api/system") {
    return json(toSystemView(app));
  }

  if (path === "/api/tasks") {
    // Re-read schedules per request so edits made in the web UI appear without
    // restarting the server.
    app.refresh();

    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const eligible = app
      .scheduledTasks()
      .filter((scheduled) => canAccessTask(app, scheduled.id, user))
      .filter((scheduled) => isListedTask(app.taskRegistry.require(scheduled.id)));
    const candidates = eligible
      .filter((scheduled) => {
        if (!query) return true;
        const task = app.taskRegistry.require(scheduled.id);
        const trigger = scheduled.trigger.value;
        const schedule = trigger.type === "cron" ? trigger.expression : trigger.type === "once" ? trigger.at : "";
        return [task.id, task.name, task.description ?? "", schedule]
          .join(" ")
          .toLowerCase()
          .includes(query);
      });

    const requestedLimit = url.searchParams.get("limit");
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
    const page = requestedLimit == null
      ? candidates
      : candidates.slice(offset, offset + clampPageParam(requestedLimit, 50, 100));
    // Expensive historical/live metrics are assembled only for the authorized,
    // filtered visible page, so page cost is independent of total task count.
    const summaries = toTaskSummaries(app, page);

    // `total` deliberately remains the authorized, unfiltered population: search
    // consumers use it for "N of total". With the empty query used by paginated
    // navigation it is also the exact page total.
    return jsonCached({ tasks: summaries, total: eligible.length }, request);
  }

  if (path === "/api/gitlab/merge-requests") {
    return routeGitLabMergeRequests(request, url, app, user);
  }

  if (path === "/api/gitlab/projects") {
    return routeGitLabProjects(request, url, app, user);
  }

  if (path === "/api/gitlab/branches") {
    return routeGitLabBranches(request, url, app, user);
  }

  if (path === "/api/agents") {
    return routeAgents();
  }

  if (path === "/api/jira/issues") {
    return routeJiraIssues(request, url, app, user);
  }

  if (path === "/api/jira/users") {
    return routeJiraUsers(request, url, app, user);
  }

  if (path === "/api/pull-requests") {
    return routePullRequests(request, url, app, user);
  }

  if (path === "/api/releases") {
    return routeReleases(request, app, user);
  }

  if (path === "/api/releases/confluence") {
    return routeConfluenceReleases(request, url, app, user);
  }

  if (path === "/api/releases/history") {
    return routeReleaseHistory(request, url, app, user);
  }

  if (path === "/api/releases/watches") {
    app.refresh();
    return json(toDeployWatchesView(app));
  }

  if (path === "/api/graph/tickets") {
    return json(
      // No `request.signal`: both of this graph's network reads are now shared
      // cache entries, and one client navigating away must not abort a read the
      // other pollers are awaiting. See `cachedPullRequestListing`.
      await toTicketGraph(app, user, {
        scope: url.searchParams.get("scope") === "team" ? "team" : "mine",
        bypass: wantsFreshData(request),
      }),
    );
  }

  if (path === "/api/notifications") {
    const unreadOnly = url.searchParams.get("unreadOnly") === "1";
    return json({
      notifications: visibleNotifications(app, user, { unreadOnly }).map(toNotificationView),
      // Counted over the same filters rather than from `unreadCount()`: a badge
      // that includes a private loop's notice, or a kind this developer has
      // unsubscribed from, is a badge that never clears when they open the bell.
      unreadCount: visibleNotifications(app, user, { unreadOnly: true }).length,
    } satisfies ApiContract.NotificationsView);
  }

  if (path === "/api/search") {
    const ability = createAppAbility(user.permissions);
    return json(
      (await toSearchResult(app, user, url.searchParams.get("q") ?? "", {
        tickets: ability.can("read", "Ticket"),
        pullRequests: ability.can("read", "PullRequest"),
      })) satisfies
        ApiContract.SearchResult,
    );
  }

  const taskDetail = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskDetail) {
    app.refresh();
    const id = decodeURIComponent(taskDetail[1]!);
    if (!canAccessTask(app, id, user)) return notFound(`No task '${id}'.`);
    const task = app.taskRegistry.get(id);
    const scheduled = app.scheduledTask(id);
    if (!task || !scheduled) return notFound(`No task '${id}'.`);
    return json(await toTaskDetail(app, task, scheduled));
  }

  const taskRuns = path.match(/^\/api\/tasks\/([^/]+)\/runs$/);
  if (taskRuns) {
    app.refresh();
    const id = decodeURIComponent(taskRuns[1]!);
    if (!canAccessTask(app, id, user)) return notFound(`No task '${id}'.`);
    const task = app.taskRegistry.get(id);
    const scheduled = app.scheduledTask(id);
    if (!task || !scheduled) return notFound(`No task '${id}'.`);
    const limit = clampPageParam(url.searchParams.get("limit"), 20, 100);
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    return json(toRunHistoryPage(app, id, { limit, offset }));
  }

  const taskIssues = path.match(/^\/api\/tasks\/([^/]+)\/issues$/);
  if (taskIssues) {
    app.refresh();
    const id = decodeURIComponent(taskIssues[1]!);
    if (!canAccessTask(app, id, user)) return notFound(`No task '${id}'.`);
    const task = app.taskRegistry.get(id);
    const scheduled = app.scheduledTask(id);
    if (!task || !scheduled) return notFound(`No task '${id}'.`);
    const limit = clampPageParam(url.searchParams.get("limit"), 15, 100);
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
    const page = toTaskIssuePage(app, id, { limit, offset });
    const definitionId = app.instances.get(id)?.definitionId ?? task.id;
    return json(
      definitionId === "gitlab-ci-failure" || definitionId === "datadog-scan"
        ? await enrichTrackedJiraIssues(request, app, user, page)
        : page,
    );
  }

  const runJiraOutcomes = path.match(/^\/api\/task-runs\/([^/]+)\/jira-outcomes$/);
  if (runJiraOutcomes) {
    if (request.method !== "GET") return methodNotAllowed(request.method);
    const executionId = decodeURIComponent(runJiraOutcomes[1]!);
    const run = app.sink.getRun(executionId);
    if (!run || !canAccessTask(app, run.taskId, user)) {
      return notFound(`No run '${executionId}'.`);
    }

    const outcomes = jiraOutcomesFromDetails(run.details);
    if (outcomes.length === 0) {
      return json({ outcomes: [] } satisfies ApiContract.RunJiraOutcomesView);
    }

    const jira = app.sharedJira();
    const issueKeys = [...new Set(outcomes.map((outcome) => outcome.issueKey))];
    let assignees = new Map<string, string>();
    try {
      const issues = await cached(
        app.responseCache,
        {
          resource: "run-jira-outcomes",
          scope: { userId: user.id },
          params: [executionId, ...issueKeys],
          ttlMs: CACHE_TTL.jiraIssues,
        },
        () =>
          jira.searchIssues(
            `key in (${issueKeys.map((key) => `"${key}"`).join(", ")})`,
            {
              limit: issueKeys.length,
              fields: ["assignee"],
              signal: request.signal,
            },
          ),
      );
      assignees = new Map(
        issues.flatMap((issue) => {
          const assignee = issue.fields?.assignee;
          const label =
            assignee?.displayName?.trim() ||
            assignee?.emailAddress?.trim() ||
            assignee?.accountId?.trim();
          return label ? [[issue.key, label] as const] : [];
        }),
      );
    } catch (err) {
      // The browse URL needs no Jira read. Keep links useful when assignee
      // enrichment is temporarily unavailable rather than failing the section.
      app.logger.warn(
        { executionId, err: describeError(err) },
        "could not enrich run Jira outcomes with assignees",
      );
    }

    return json({
      outcomes: outcomes.map((outcome) => ({
        ...outcome,
        issueUrl: jira.issueUrl(outcome.issueKey),
        ...(assignees.get(outcome.issueKey)
          ? { assignee: assignees.get(outcome.issueKey)! }
          : outcome.assignee
            ? { assignee: outcome.assignee }
            : {}),
      })),
    } satisfies ApiContract.RunJiraOutcomesView);
  }

  const runSteps = path.match(/^\/api\/task-runs\/([^/]+)\/steps$/);
  if (runSteps) {
    const executionId = decodeURIComponent(runSteps[1]!);
    const run = app.sink.getRun(executionId);
    if (run && !canAccessTask(app, run.taskId, user)) {
      return notFound(`No run '${executionId}'.`);
    }
    const steps: StepView[] = app.sink.steps(executionId).map(toStepView);
    // An empty array is ambiguous — unknown run, or a run that recorded no steps.
    // The UI needs to tell those apart to choose its empty state.
    if (steps.length === 0 && !run) {
      return notFound(`No run '${executionId}'.`);
    }
    // Polled once a second while a run is live, and the log grows a line at a time
    // — so most of those ticks return a body byte-identical to the last one.
    return jsonCached(
      {
        executionId,
        steps,
        // Existing clients retain the complete snapshot. New clients explicitly
        // request metadata-only and initialize from the bounded tail endpoint.
        ...(url.searchParams.get("logs") === "none"
          ? {}
          : { logs: app.sink.logs(executionId).map(toLogLineView) }),
      },
      request,
    );
  }

  // Cursor endpoint for the live activity feed. Keep `/steps` intact for
  // older clients and complete historical views; a live client starts from
  // that snapshot once, then only asks for rows it has not seen.
  const runLogs = path.match(/^\/api\/task-runs\/([^/]+)\/logs$/);
  if (runLogs) {
    const executionId = decodeURIComponent(runLogs[1]!);
    const run = app.sink.getRun(executionId);
    if (!run || !canAccessTask(app, run.taskId, user)) {
      return notFound(`No run '${executionId}'.`);
    }
    const afterLogId = Math.max(0, Math.floor(Number(url.searchParams.get("afterLogId")) || 0));
    const limit = clampPageParam(url.searchParams.get("limit"), 200, 500);
    const beforeParam = url.searchParams.get("beforeLogId");
    if (beforeParam != null || url.searchParams.get("tail") === "1") {
      const beforeLogId = beforeParam == null
        ? undefined
        : Math.max(1, Math.floor(Number(beforeParam) || 1));
      const page = app.sink.logTail(executionId, beforeLogId, limit);
      const lines = page.lines.map(toLogLineView);
      return json({
        executionId,
        logs: lines,
        previousCursor: lines.at(0)?.id ?? beforeLogId ?? 0,
        hasOlder: page.hasOlder,
        status: run.status,
      });
    }
    const page = app.sink.logPage(executionId, afterLogId, limit);
    const lines = page.lines.map(toLogLineView);
    return json({
      executionId,
      logs: lines,
      nextCursor: lines.at(-1)?.id ?? afterLogId,
      hasMore: page.hasMore,
      status: run.status,
    });
  }

  return notFound(`No API route for ${path}.`);
}

function requiresAdministrator(path: string, method: string): boolean {
  // Settings and prompt templates disclose and control instance-wide behavior,
  // so even their reads belong to administrators.
  if (
    path === "/api/settings" ||
    path === "/api/settings/resolved-models" ||
    path === "/api/settings/integrations" ||
    path === "/api/settings/e2e-tests" ||
    path === "/api/prompts" ||
    path === "/api/automation/config" ||
    path === "/api/automation/config/schedules" ||
    path === "/api/automation/sync"
  ) {
    return true;
  }

  if (method === "GET") return false;
  // QA users may use these product surfaces, but changing their shared routing
  // and repository configuration changes behavior for every account.
  return (
    path === "/api/releases/config" ||
    path === "/api/datadog/routing" ||
    path.startsWith("/api/datadog/routing/") ||
    path === "/api/datadog/service-targets" ||
    path.startsWith("/api/datadog/service-targets/")
  );
}

function moduleSubjectsForPath(path: string): readonly AppSubject[] | null {
  if (
    path === "/api/tasks" ||
    path.startsWith("/api/tasks/") ||
    path.startsWith("/api/task-runs/") ||
    path === "/api/flaky-specs" ||
    path.startsWith("/api/flaky-specs/")
  ) {
    return ["Loop"];
  }
  if (path.startsWith("/api/jobs/")) {
    return [
      "Loop",
      "PullRequest",
      "Release",
      "Automation",
      "LogRocket",
      "Datadog",
      "Ticket",
    ];
  }
  if (
    path === "/api/pull-requests" ||
    path.startsWith("/api/pull-requests/") ||
    path === "/api/me/pull-request-repos"
  ) {
    return ["PullRequest"];
  }
  if (path === "/api/releases" || path.startsWith("/api/releases/")) return ["Release"];
  if (path.startsWith("/api/automation/")) return ["Automation"];
  if (path.startsWith("/api/logrocket/")) return ["LogRocket"];
  if (path.startsWith("/api/datadog/")) return ["Datadog"];
  if (
    path.startsWith("/api/graph/") ||
    path.startsWith("/api/tickets/") ||
    path === "/api/plans" ||
    path.startsWith("/api/plans/") ||
    path.startsWith("/api/e2e/")
  ) {
    return ["Ticket"];
  }
  if (path.startsWith("/api/slack/") || path.startsWith("/api/me/slack/")) return ["Slack"];
  if (path === "/api/me/fix-issue-defaults") return ["Ticket", "LogRocket", "Datadog"];
  if (path === "/api/search") return ["Ticket", "PullRequest"];
  return null;
}

/** GET /api/automation/dashboard — compact, filterable Automation health. */
async function routeAutomationDashboard(
  request: Request,
  url: URL,
  app: App,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request.method);

  const rawDays = url.searchParams.get("days");
  const days = rawDays == null ? 30 : Number(rawDays);
  if (days !== 1 && days !== 7 && days !== 30) {
    throw new ConfigError("'days' must be 1, 7, or 30.");
  }

  const rawScheduleId = url.searchParams.get("scheduleId");
  const scheduleId = rawScheduleId == null ? undefined : Number(rawScheduleId);
  if (
    scheduleId != null &&
    (!/^[1-9]\d*$/.test(rawScheduleId!) || !Number.isSafeInteger(scheduleId))
  ) {
    throw new ConfigError("'scheduleId' must be a positive integer.");
  }

  const rawStatus = url.searchParams.get("status");
  const status = rawStatus?.trim() || undefined;
  if (
    status != null &&
    !(PIPELINE_STATUSES as readonly string[]).includes(status)
  ) {
    throw new ConfigError(
      `'status' must be one of: ${PIPELINE_STATUSES.join(", ")}.`,
    );
  }
  const recentLimit = clampPageParam(url.searchParams.get("limit"), 25, 100);
  const rawOffset = url.searchParams.get("offset");
  const recentOffset =
    rawOffset == null || rawOffset === ""
      ? 0
      : nonNegativeSafeInteger(rawOffset);
  if (recentOffset == null || recentOffset > 100_000) {
    throw new ConfigError("'offset' must be an integer from 0 through 100000.");
  }

  return json(
    toAutomationDashboard(app, {
      days,
      recentLimit,
      recentOffset,
      ...(scheduleId != null ? { scheduleId } : {}),
      ...(status != null ? { status } : {}),
    }),
  );
}

/** GET /api/automation/failure-inbox — schedule-scoped failures across pipelines. */
async function routeAutomationFailureInbox(
  request: Request,
  url: URL,
  app: App,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request.method);
  const rawDays = url.searchParams.get("days");
  const days = rawDays == null ? 30 : Number(rawDays);
  if (days !== 1 && days !== 7 && days !== 30) {
    throw new ConfigError("'days' must be 1, 7, or 30.");
  }
  const rawPresence = url.searchParams.get("presence") ?? "current";
  if (rawPresence !== "current" && rawPresence !== "recent") {
    throw new ConfigError("'presence' must be 'current' or 'recent'.");
  }
  const rawScheduleId = url.searchParams.get("scheduleId");
  const scheduleId =
    rawScheduleId == null ? undefined : positiveSafeInteger(rawScheduleId);
  if (rawScheduleId != null && scheduleId == null) {
    throw new ConfigError("'scheduleId' must be a positive integer.");
  }
  const rawPipelineId = url.searchParams.get("pipelineId");
  const pipelineId =
    rawPipelineId == null ? undefined : positiveSafeInteger(rawPipelineId);
  if (rawPipelineId != null && pipelineId == null) {
    throw new ConfigError("'pipelineId' must be a positive integer.");
  }
  const rawState = url.searchParams.get("state") ?? undefined;
  if (
    rawState != null &&
    rawState !== "untriaged" &&
    rawState !== "ticketed" &&
    rawState !== "active-mr"
  ) {
    throw new ConfigError(
      "'state' must be one of: untriaged, ticketed, active-mr.",
    );
  }
  const search =
    (url.searchParams.get("search") ?? url.searchParams.get("q"))?.trim() ||
    undefined;
  if (search && search.length > 200) {
    throw new ConfigError("'search' must not exceed 200 characters.");
  }
  const limit = clampPageParam(url.searchParams.get("limit"), 25, 100);
  const rawOffset = url.searchParams.get("offset");
  const offset =
    rawOffset == null || rawOffset === ""
      ? 0
      : nonNegativeSafeInteger(rawOffset);
  if (offset == null || offset > 100_000) {
    throw new ConfigError("'offset' must be an integer from 0 through 100000.");
  }

  const now = new Date();
  const from = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - (days - 1),
    ),
  );
  const config = app.automationConfig.get();
  let openMergeRequests: number | null = null;
  let openMergeRequestsUrl: string | null = null;
  if (config) {
    try {
      const source = await cached(
        app.responseCache,
        {
          resource: "automation-open-merge-requests",
          scope: "shared",
          params: [config.projectId],
          ttlMs: CACHE_TTL.automationOpenMergeRequests,
        },
        async () => {
          const gitlab = app.sharedGitLab();
          const [count, project] = await Promise.all([
            gitlab.countOpenMergeRequests(config.projectId),
            gitlab.project(config.projectId),
          ]);
          return {
            count,
            url:
              `${project.web_url}/-/merge_requests` +
              "?sort=updated_desc&state=opened&first_page_size=100",
          };
        },
        { bypass: wantsFreshData(request) },
      );
      openMergeRequests = source.count;
      openMergeRequestsUrl = source.url;
    } catch (err) {
      app.logger.warn(
        { projectId: config.projectId, err: describeError(err) },
        "could not count Automation project merge requests",
      );
    }
  }
  const page = app.automation.listFailureInbox({
    projectId: config?.projectId ?? "",
    scheduleIds: config?.schedules.map((schedule) => schedule.scheduleId) ?? [],
    from,
    presence: rawPresence,
    limit,
    offset,
    ...(scheduleId != null ? { scheduleId } : {}),
    ...(pipelineId != null ? { pipelineId } : {}),
    ...(search ? { search } : {}),
    ...(rawState ? { triageState: rawState } : {}),
  });
  return json(
    toAutomationFailureInbox(
      app,
      {
        days,
        presence: rawPresence,
        limit,
        offset,
        now,
        openMergeRequests,
        openMergeRequestsUrl,
      },
      page,
    ),
  );
}

/** GET /api/automation/pipelines/:id — full stored pipeline/test detail. */
async function routeAutomationPipeline(
  request: Request,
  rawPipelineId: string,
  app: App,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request.method);
  const pipelineId = Number(rawPipelineId);
  const config = app.automationConfig.get();
  if (!config || !/^[1-9]\d*$/.test(rawPipelineId) || !Number.isSafeInteger(pipelineId)) {
    return notFound(`No Automation pipeline '${rawPipelineId}'.`);
  }
  const pipeline = app.automation.getPipeline(config.projectId, pipelineId, {
    includeFailureDiagnostics: false,
  });
  const configuredIds = new Set(
    config.schedules.map((schedule) => schedule.scheduleId),
  );
  if (!pipeline || !configuredIds.has(pipeline.scheduleId)) {
    return notFound(`No Automation pipeline '${rawPipelineId}'.`);
  }
  return json(
    toAutomationPipelineDetail(
      pipeline,
      app.automation.getJobRetryWave(config.projectId, pipelineId),
    ),
  );
}

/** GET compact, server-paginated failure clusters for one stored pipeline. */
async function routeAutomationFailureClusters(
  request: Request,
  url: URL,
  rawPipelineId: string,
  app: App,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request.method);
  const context = automationPipelineContext(app, rawPipelineId);
  if (!context) {
    return notFound(`No Automation pipeline '${rawPipelineId}'.`);
  }
  const limit = clampPageParam(url.searchParams.get("limit"), 50, 100);
  const rawOffset = url.searchParams.get("offset");
  const offset =
    rawOffset == null || rawOffset === ""
      ? 0
      : nonNegativeSafeInteger(rawOffset);
  if (offset == null || offset > 100_000) {
    throw new ConfigError("'offset' must be an integer from 0 through 100000.");
  }
  const rawSearch = url.searchParams.get("search") ?? url.searchParams.get("q");
  const search = rawSearch?.trim() || undefined;
  if (search && search.length > 200) {
    throw new ConfigError("'search' must not exceed 200 characters.");
  }
  const rawJobId = url.searchParams.get("jobId");
  const jobId = rawJobId == null ? undefined : positiveSafeInteger(rawJobId);
  if (rawJobId != null && jobId == null) {
    throw new ConfigError("'jobId' must be a positive integer.");
  }
  const rawSuiteIndex = url.searchParams.get("suiteIndex");
  const suiteIndex =
    rawSuiteIndex == null ? undefined : nonNegativeSafeInteger(rawSuiteIndex);
  if (rawSuiteIndex != null && suiteIndex == null) {
    throw new ConfigError("'suiteIndex' must be a non-negative integer.");
  }
  const rawState = url.searchParams.get("state") ?? undefined;
  if (
    rawState != null &&
    rawState !== "untriaged" &&
    rawState !== "ticketed" &&
    rawState !== "active-mr"
  ) {
    throw new ConfigError(
      "'state' must be one of: untriaged, ticketed, active-mr.",
    );
  }

  const page = app.automation.listFailureClusters({
    projectId: context.config.projectId,
    pipelineId: context.pipeline.pipelineId,
    limit,
    offset,
    ...(search ? { search } : {}),
    ...(jobId != null ? { jobId } : {}),
    ...(suiteIndex != null ? { suiteIndex } : {}),
    ...(rawState ? { triageState: rawState } : {}),
  });
  return json(
    toAutomationFailureClusterList(
      app,
      context.pipeline.pipelineId,
      context.pipeline.scheduleId,
      limit,
      offset,
      page,
    ),
  );
}

/** GET one bounded cluster with lazy diagnostics, members, and attachments. */
async function routeAutomationFailureClusterDetail(
  request: Request,
  rawPipelineId: string,
  signatureKey: string,
  app: App,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request.method);
  const context = automationPipelineContext(app, rawPipelineId);
  if (!context || !validSignatureKey(signatureKey)) {
    return notFound("No Automation failure cluster for this pipeline.");
  }
  const cluster = app.automation.getFailureCluster(
    context.config.projectId,
    context.pipeline.pipelineId,
    signatureKey,
    100,
  );
  return cluster
    ? json(toAutomationFailureClusterDetail(app, cluster))
    : notFound("No Automation failure cluster for this pipeline.");
}

/** Queue one actor-attributed, read-only LLM classification. */
async function routeAutomationFailureClusterTriage(
  request: Request,
  rawPipelineId: string,
  signatureKey: string,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);
  const context = automationPipelineContext(app, rawPipelineId);
  if (!context || !validSignatureKey(signatureKey)) {
    return notFound("No Automation failure cluster for this pipeline.");
  }
  const cluster = app.automation.getFailureCluster(
    context.config.projectId,
    context.pipeline.pipelineId,
    signatureKey,
    1,
  );
  if (!cluster || cluster.scheduleId !== context.pipeline.scheduleId) {
    return notFound("No Automation failure cluster for this pipeline.");
  }
  if (!app.taskRegistry.get(TRIAGE_AUTOMATION_FAILURE_TASK_ID)) {
    return json({
      queued: false,
      message: "No Automation AI triage task is registered.",
    } satisfies ApiContract.AutomationAiTriageActionView);
  }

  const result = app.jobs.enqueue({
    kind: TRIAGE_AUTOMATION_FAILURE_TASK_ID,
    loopId: "automation-actions",
    dedupeKey:
      `manual:automation-triage:${context.config.projectId}:` +
      `${cluster.scheduleId}:${cluster.signatureKey}`,
    actorId: user.id,
    params: {
      projectId: context.config.projectId,
      pipelineId: context.pipeline.pipelineId,
      scheduleId: cluster.scheduleId,
      signatureKey: cluster.signatureKey,
      targetRef: context.pipeline.ref,
    },
  });
  if (!result.enqueued || !result.job) {
    return json({
      queued: false,
      message: "AI triage is already running for this failure cluster.",
    } satisfies ApiContract.AutomationAiTriageActionView);
  }
  return json(
    {
      queued: true,
      jobId: result.job.id,
      message: `Queued AI triage for ${cluster.title}.`,
    } satisfies ApiContract.AutomationAiTriageActionView,
    202,
  );
}

/** Set or clear the Talos owner for a durable schedule/signature failure. */
async function routeAutomationFailureClusterAssignee(
  request: Request,
  rawPipelineId: string,
  signatureKey: string,
  app: App,
  actor: AuthUser,
): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed(request.method);
  const context = automationPipelineContext(app, rawPipelineId);
  if (!context || !validSignatureKey(signatureKey)) {
    return notFound("No Automation failure cluster for this pipeline.");
  }
  const cluster = app.automation.getFailureCluster(
    context.config.projectId,
    context.pipeline.pipelineId,
    signatureKey,
    1,
  );
  if (!cluster || cluster.scheduleId !== context.pipeline.scheduleId) {
    return notFound("No Automation failure cluster for this pipeline.");
  }
  const body = await jsonBody(request);
  const userId =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { userId?: unknown }).userId
      : undefined;
  if (userId !== null && typeof userId !== "string") {
    throw new ConfigError("'userId' must be a Talos user id or null.");
  }
  if (userId === null) {
    app.automationFailureAssignees.clear(
      context.config.projectId,
      cluster.scheduleId,
      cluster.signatureKey,
    );
    return json({
      assignee: null,
    } satisfies ApiContract.AutomationFailureAssignmentView);
  }
  const normalizedUserId = userId.trim();
  const assignee = app.auth.byId(normalizedUserId);
  if (!assignee) {
    throw new ConfigError(`Talos user '${normalizedUserId}' does not exist.`);
  }
  const assignment = app.automationFailureAssignees.set({
    projectId: context.config.projectId,
    scheduleId: cluster.scheduleId,
    signatureKey: cluster.signatureKey,
    userId: assignee.id,
    assignedByUserId: actor.id,
    now: new Date(),
  });
  return json({
    assignee: {
      id: assignee.id,
      name: assignee.name,
      email: assignee.email,
      assignedAt: assignment.assignedAt.toISOString(),
    },
  } satisfies ApiContract.AutomationFailureAssignmentView);
}

/** POST one idempotent Jira action for a schedule-scoped signature cluster. */
async function routeAutomationFailureClusterTicket(
  request: Request,
  rawPipelineId: string,
  signatureKey: string,
  app: App,
): Promise<Response> {
  const context = automationPipelineContext(app, rawPipelineId);
  if (
    !context ||
    !validSignatureKey(signatureKey) ||
    !app.automation.getFailureCluster(
      context.config.projectId,
      context.pipeline.pipelineId,
      signatureKey,
      1,
    )
  ) {
    return notFound("No Automation failure cluster for this pipeline.");
  }
  const service = automationTicketService(app);
  if (request.method === "GET") {
    const draft = service.draft(context.pipeline.pipelineId, signatureKey);
    return json({
      projectKey: draft.projectKey,
      parentKey: draft.parentKey ?? null,
      summary: draft.summary,
      description: draft.description,
    } satisfies ApiContract.AutomationTicketDraftView);
  }
  if (request.method !== "POST") return methodNotAllowed(request.method);
  const input = automationTicketInput(await jsonBody(request));
  const result = await service.ticket(
    context.pipeline.pipelineId,
    signatureKey,
    input,
    request.signal,
  );
  return json(toAutomationTicketActionView(result));
}

function automationTicketInput(value: unknown): AutomationTicketInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("Ticket fields must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.summary !== "string" ||
    !validAutomationJiraText(input.summary, 255)
  ) {
    throw new ConfigError("'summary' must be between 1 and 255 characters.");
  }
  if (
    typeof input.description !== "string" ||
    !validAutomationJiraText(input.description, 4_000)
  ) {
    throw new ConfigError("'description' must be between 1 and 4000 characters.");
  }
  if (
    input.parentKey !== null &&
    input.parentKey !== undefined &&
    typeof input.parentKey !== "string"
  ) {
    throw new ConfigError("'parentKey' must be a Jira issue key or null.");
  }
  const parentKey =
    typeof input.parentKey === "string"
      ? input.parentKey.trim().toUpperCase()
      : "";
  if (parentKey && !/^[A-Z][A-Z0-9_]*-\d+$/.test(parentKey)) {
    throw new ConfigError("'parentKey' must be a Jira issue key such as TP-123.");
  }
  return {
    summary: input.summary.trim(),
    description: input.description.trim(),
    ...(parentKey ? { parentKey } : {}),
  };
}

/** POST up to 20 explicit signatures into one idempotent pipeline Jira ticket. */
async function routeAutomationFailureClusterBulkTicket(
  request: Request,
  rawPipelineId: string,
  app: App,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);
  const context = automationPipelineContext(app, rawPipelineId);
  if (!context) {
    return notFound(`No Automation pipeline '${rawPipelineId}'.`);
  }
  const body = await jsonBody(request);
  const signatureKeys =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { signatureKeys?: unknown }).signatureKeys
      : undefined;
  if (
    !Array.isArray(signatureKeys) ||
    signatureKeys.length === 0 ||
    signatureKeys.length > 20 ||
    !signatureKeys.every(
      (key): key is string => typeof key === "string" && validSignatureKey(key),
    )
  ) {
    throw new ConfigError(
      "'signatureKeys' must contain 1 through 20 explicit signature keys.",
    );
  }
  if (new Set(signatureKeys).size !== signatureKeys.length) {
    throw new ConfigError("'signatureKeys' must not contain duplicates.");
  }
  const results = await automationTicketService(app).ticketBulk(
    context.pipeline.pipelineId,
    signatureKeys,
    request.signal,
  );
  return json({
    results: results.map((outcome) =>
      outcome.ok && outcome.result
        ? {
            signatureKey: outcome.signatureKey,
            ok: true as const,
            result: toAutomationTicketActionView(outcome.result),
          }
        : {
            signatureKey: outcome.signatureKey,
            ok: false as const,
            error: outcome.error ?? "Ticket action failed.",
          },
    ),
  } satisfies ApiContract.AutomationBulkTicketActionView);
}

function automationPipelineContext(app: App, rawPipelineId: string) {
  const pipelineId = positiveSafeInteger(rawPipelineId);
  const config = app.automationConfig.get();
  if (!config || pipelineId == null) return undefined;
  const pipeline = app.automation.getPipeline(config.projectId, pipelineId, {
    includeFailureDiagnostics: false,
  });
  if (
    !pipeline ||
    !config.schedules.some((schedule) => schedule.scheduleId === pipeline.scheduleId)
  ) {
    return undefined;
  }
  return { config, pipeline };
}

function automationTicketService(app: App): AutomationTicketService {
  return new AutomationTicketService({
    config: app.automationConfig,
    automation: app.automation,
    aiTriage: app.automationAiTriage,
    jira: () => app.sharedJira(),
    gitlab: () => app.sharedGitLab(),
  });
}

function toAutomationTicketActionView(
  result: AutomationTicketResult,
): ApiContract.AutomationTicketActionView {
  return {
    signatureKey: result.signatureKey,
    action: result.action,
    triageState: result.triageState,
    jiraKey: result.jiraKey ?? null,
    jiraUrl: result.jiraUrl ?? null,
    mrIid: result.mrIid ?? null,
    mrUrl: result.mrUrl ?? null,
    sprint: {
      applied: result.sprint.applied,
      fallbackReason: result.sprint.fallbackReason ?? null,
    },
  };
}

function validSignatureKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f/]/.test(value)
  );
}

/**
 * GET one stored failed-test attachment.
 *
 * The URL names only a stored occurrence. The GitLab project, job, and artifact
 * path all come from the configured snapshot, so this cannot become a generic
 * shared-token artifact proxy.
 */
async function routeAutomationAttachment(
  request: Request,
  rawPipelineId: string,
  rawSuiteIndex: string,
  rawCaseIndex: string,
  app: App,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request.method);
  const pipelineId = positiveSafeInteger(rawPipelineId);
  const suiteIndex = nonNegativeSafeInteger(rawSuiteIndex);
  const caseIndex = nonNegativeSafeInteger(rawCaseIndex);
  const config = app.automationConfig.get();
  const missing = (): Response =>
    notFound("No Automation failed-test attachment for this occurrence.");
  if (
    !config ||
    pipelineId == null ||
    suiteIndex == null ||
    caseIndex == null
  ) {
    return missing();
  }

  const pipeline = app.automation.getPipeline(config.projectId, pipelineId);
  if (
    !pipeline ||
    !config.schedules.some((schedule) => schedule.scheduleId === pipeline.scheduleId)
  ) {
    return missing();
  }
  const occurrence = pipeline.failedTests.find(
    (test) =>
      test.suiteIndex === suiteIndex &&
      test.caseIndex === caseIndex,
  );
  if (
    !occurrence?.attachmentJobId ||
    !occurrence.attachmentPath ||
    !pipeline.jobs.some((job) => job.jobId === occurrence.attachmentJobId) ||
    !pipeline.suites.some(
      (suite) =>
        suite.index === suiteIndex &&
        suite.buildIds.includes(occurrence.attachmentJobId!),
    )
  ) {
    return missing();
  }

  const artifact = await app.sharedGitLab().jobArtifactFile(
    config.projectId,
    occurrence.attachmentJobId,
    occurrence.attachmentPath,
    request.signal,
  );
  return new Response(artifact.body, {
    headers: {
      "content-type": artifact.contentType,
      "content-length": String(artifact.body.byteLength),
      "content-disposition": inlineContentDisposition(artifact.filename),
      "cache-control": "private, max-age=300",
      vary: "Cookie",
      "x-content-type-options": "nosniff",
    },
  });
}

function positiveSafeInteger(raw: string): number | undefined {
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function nonNegativeSafeInteger(raw: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** POST /api/automation/sync — run the instance-owned importer with shared GitLab access. */
async function routeAutomationSync(request: Request, app: App): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);

  app.refresh();
  if (app.executor.isTaskActive(AUTOMATION_REPORT_SYNC_TASK_ID)) {
    return json({ error: "Automation synchronization is already running." }, 409);
  }

  // A 30-day daily backfill across the configured schedules does not fit the
  // generic ten-item task default. Persist the feature's own bounded batch so
  // one manual sync can populate every schedule and its combined charts.
  app.tasks.updateSchedule(AUTOMATION_REPORT_SYNC_TASK_ID, {
    maxItemsPerRun: AUTOMATION_REPORT_SYNC_DEFAULT_MAX_ITEMS,
  });

  const opened = Promise.withResolvers<{ executionId: string }>();
  let started = false;
  void app.tasks
    .run(AUTOMATION_REPORT_SYNC_TASK_ID, {}, {
      force: true,
      // Deliberately no actor: Automation is instance-owned and must use the
      // shared GITLAB_TOKEN, not whichever administrator clicked the button.
      onStarted: (info) => {
        started = true;
        opened.resolve(info);
      },
    })
    .then(
      () => undefined,
      (err) => {
        if (!started) {
          opened.reject(err);
          return;
        }
        app.logger.error(
          { task: AUTOMATION_REPORT_SYNC_TASK_ID, err: describeError(err) },
          "Automation synchronization failed",
        );
      },
    );

  const info = await opened.promise;
  const run = app.sink.getRun(info.executionId);
  if (!run) {
    return json({ error: `Run '${info.executionId}' was not recorded.` }, 500);
  }
  return json({ ...toRunView(run), steps: [] }, 202);
}

/** GET/PUT /api/automation/config — instance-wide reporting and ticket defaults. */
async function routeAutomationConfig(
  request: Request,
  app: App,
): Promise<Response> {
  if (request.method === "GET") {
    return json(automationConfigView(app.automationConfig.get()));
  }

  if (request.method === "PUT") {
    const body = await jsonBody(request);
    const input = body as Record<string, unknown> | null;
    const projectId = input?.projectId;
    const schedules = input?.schedules;
    if (typeof projectId !== "string" || projectId.trim() === "") {
      throw new ConfigError("'projectId' must be a non-empty GitLab project id or path.");
    }
    if (!Array.isArray(schedules)) {
      throw new ConfigError("'schedules' must be an array.");
    }

    const seen = new Set<number>();
    const normalized: NonNullable<
      ReturnType<App["automationConfig"]["get"]>
    >["schedules"] = [];
    for (const [index, value] of schedules.entries()) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ConfigError(`'schedules.${index}' must be an object.`);
      }
      const schedule = value as Record<string, unknown>;
      const scheduleId = schedule.scheduleId;
      if (
        typeof scheduleId !== "number" ||
        !Number.isInteger(scheduleId) ||
        scheduleId <= 0
      ) {
        throw new ConfigError(
          `'schedules.${index}.scheduleId' must be a positive integer.`,
        );
      }
      if (seen.has(scheduleId)) {
        throw new ConfigError(`Schedule id ${scheduleId} is selected more than once.`);
      }
      seen.add(scheduleId);
      if (
        schedule.displayName !== undefined &&
        schedule.displayName !== null &&
        typeof schedule.displayName !== "string"
      ) {
        throw new ConfigError(
          `'schedules.${index}.displayName' must be a string when provided.`,
        );
      }
      const displayName =
        typeof schedule.displayName === "string"
          ? schedule.displayName.trim()
          : "";
      const rawAutoRetry = schedule.autoRetry;
      if (
        rawAutoRetry !== undefined &&
        (typeof rawAutoRetry !== "object" ||
          rawAutoRetry === null ||
          Array.isArray(rawAutoRetry))
      ) {
        throw new ConfigError(
          `'schedules.${index}.autoRetry' must be an object when provided.`,
        );
      }
      const autoRetry = (rawAutoRetry ?? {}) as Record<string, unknown>;
      const enabled = autoRetry.enabled ?? false;
      const maxJobsPerPipeline = autoRetry.maxJobsPerPipeline ?? 3;
      if (typeof enabled !== "boolean") {
        throw new ConfigError(
          `'schedules.${index}.autoRetry.enabled' must be a boolean.`,
        );
      }
      if (
        typeof maxJobsPerPipeline !== "number" ||
        !Number.isSafeInteger(maxJobsPerPipeline) ||
        maxJobsPerPipeline < 1 ||
        maxJobsPerPipeline > 20
      ) {
        throw new ConfigError(
          `'schedules.${index}.autoRetry.maxJobsPerPipeline' must be an integer from 1 through 20.`,
        );
      }
      normalized.push({
        scheduleId,
        ...(displayName ? { displayName } : {}),
        autoRetry: { enabled, maxJobsPerPipeline },
      });
    }

    app.automationConfig.set({
      projectId: projectId.trim(),
      schedules: normalized,
      ...normalizeAutomationJiraConfig(input?.jira),
    });
    const config = app.automationConfig.get()!;
    return json(automationConfigView(config));
  }

  return methodNotAllowed(request.method);
}

async function adminFeedbackView(
  app: App,
  actor: AuthUser,
  signal?: AbortSignal,
): Promise<ApiContract.AdminFeedbackView> {
  const localRows = app.feedback.list();
  const pending = localRows
    .filter((entry) => entry.publicationStatus === "pending")
    .map((entry) => adminLocalFeedbackEntry(app, entry));

  let remoteIssues: GitLabFeedbackIssue[];
  try {
    remoteIssues = await app.feedbackIssuesFor(actor).listIssues(signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    const reason = feedbackPublicationReason(error);
    if (!reason) throw error;
    return {
      feedback: pending,
      gitlabSync: { status: "unavailable", reason },
    };
  }

  const localById = new Map(localRows.map((entry) => [entry.id, entry]));
  const localByIssueUrl = new Map(
    localRows.flatMap((entry) =>
      entry.externalIssueUrl ? [[entry.externalIssueUrl, entry] as const] : [],
    ),
  );
  const published = remoteIssues.flatMap((issue) => {
    const local =
      (issue.feedbackId ? localById.get(issue.feedbackId) : undefined) ??
      localByIssueUrl.get(issue.url);
    if (!issue.feedbackId && !local) return [];
    const user = local ? app.auth.byId(local.userId) : undefined;
    return [
      {
        id: issue.feedbackId ?? local!.id,
        ...(local ? { userId: local.userId } : {}),
        ...(user ? { userName: user.name, userEmail: user.email } : {}),
        type: local?.type ?? feedbackTypeFromLabels(issue.labels),
        title: issue.title,
        description: feedbackDescription(issue.description),
        labels: issue.labels,
        publicationStatus: "published" as const,
        issueState: issue.state,
        externalIssueUrl: issue.url,
        externalIssueNumber: issue.number,
        createdAt: issue.createdAt.toISOString(),
      },
    ];
  });

  return {
    feedback: [...pending, ...published].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ),
    gitlabSync: { status: "synced", syncedAt: new Date().toISOString() },
  };
}

function adminLocalFeedbackEntry(
  app: App,
  entry: Feedback,
): ApiContract.AdminFeedbackEntryView {
  const user = app.auth.byId(entry.userId);
  return {
    id: entry.id,
    userId: entry.userId,
    ...(user ? { userName: user.name, userEmail: user.email } : {}),
    type: entry.type,
    title: entry.title,
    description: entry.description,
    labels: entry.labels,
    publicationStatus: entry.publicationStatus,
    ...(entry.publicationReason ? { publicationReason: entry.publicationReason } : {}),
    createdAt: entry.createdAt.toISOString(),
  };
}

function feedbackTypeFromLabels(labels: readonly string[]): ApiContract.FeedbackType {
  if (labels.includes("security")) return "security";
  if (labels.includes("bug")) return "bug";
  if (labels.includes("feature")) return "feature";
  return "general";
}

function feedbackDescription(description: string): string {
  return description
    .replace(/<!--\s*automesh-feedback:[A-Za-z0-9_-]{8,128}\s*-->/g, "")
    .trim();
}

function automationConfigView(
  config: ReturnType<App["automationConfig"]["get"]>,
): ApiContract.AutomationConfigView {
  const jira = config?.jira;
  return {
    configured: config != null,
    projectId: config?.projectId ?? null,
    schedules:
      config?.schedules.map((schedule) => ({
        scheduleId: schedule.scheduleId,
        ...(schedule.displayName ? { displayName: schedule.displayName } : {}),
        autoRetry: schedule.autoRetry ?? {
          enabled: false,
          maxJobsPerPipeline: 3,
        },
      })) ?? [],
    jiraConfigured: jira != null,
    jira: jira
      ? {
          projectKey: jira.projectKey,
          parentKey: jira.parentKey ?? null,
          issueType: jira.issueType,
          boardId: jira.boardId ?? null,
          useActiveSprint: jira.useActiveSprint,
          labels: jira.labels,
          assigneeMode: jira.assigneeMode,
          fixedAssignee: jira.fixedAssignee ?? null,
        }
      : null,
  };
}

function normalizeAutomationJiraConfig(
  value: unknown,
): Pick<NonNullable<ReturnType<App["automationConfig"]["get"]>>, "jira"> | {} {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("'jira' must be an object or null.");
  }
  const jira = value as Record<string, unknown>;
  if (typeof jira.projectKey !== "string") {
    throw new ConfigError("'jira.projectKey' must be a Jira project key.");
  }
  const projectKey = jira.projectKey.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,9}$/.test(projectKey)) {
    throw new ConfigError(
      "'jira.projectKey' must be 2-10 uppercase letters, numbers, or underscores and start with a letter.",
    );
  }

  const issueTypeValue = jira.issueType ?? "Bug";
  if (
    typeof issueTypeValue !== "string" ||
    !validAutomationJiraText(issueTypeValue, 255)
  ) {
    throw new ConfigError("'jira.issueType' must be a non-empty string.");
  }
  const issueType = issueTypeValue.trim();

  const parentKeyValue = jira.parentKey;
  if (
    parentKeyValue !== undefined &&
    parentKeyValue !== null &&
    typeof parentKeyValue !== "string"
  ) {
    throw new ConfigError("'jira.parentKey' must be a Jira issue key when provided.");
  }
  const parentKey =
    typeof parentKeyValue === "string"
      ? parentKeyValue.trim().toUpperCase()
      : "";
  if (parentKey && !/^[A-Z][A-Z0-9_]*-\d+$/.test(parentKey)) {
    throw new ConfigError("'jira.parentKey' must be a Jira issue key such as TP-123.");
  }

  const boardIdValue = jira.boardId;
  if (
    boardIdValue !== undefined &&
    boardIdValue !== null &&
    (typeof boardIdValue !== "number" ||
      !Number.isSafeInteger(boardIdValue) ||
      boardIdValue <= 0)
  ) {
    throw new ConfigError("'jira.boardId' must be a positive integer when provided.");
  }

  const useActiveSprintValue = jira.useActiveSprint ?? true;
  if (typeof useActiveSprintValue !== "boolean") {
    throw new ConfigError("'jira.useActiveSprint' must be a boolean.");
  }

  const labelsValue = jira.labels ?? ["talos", "automation"];
  if (!Array.isArray(labelsValue) || labelsValue.length > 50) {
    throw new ConfigError("'jira.labels' must be an array of at most 50 labels.");
  }
  const labels: string[] = [];
  const seenLabels = new Set<string>();
  for (const [index, value] of labelsValue.entries()) {
    if (
      typeof value !== "string" ||
      !validAutomationJiraText(value, 255) ||
      /[\s,]/.test(value.trim())
    ) {
      throw new ConfigError(
        `'jira.labels.${index}' must be a non-empty Jira label without spaces or commas.`,
      );
    }
    const label = value.trim();
    if (seenLabels.has(label)) {
      throw new ConfigError(`Jira label '${label}' is selected more than once.`);
    }
    seenLabels.add(label);
    labels.push(label);
  }

  const assigneeMode = jira.assigneeMode ?? "automatic";
  if (assigneeMode !== "automatic" && assigneeMode !== "fixed") {
    throw new ConfigError(
      "'jira.assigneeMode' must be 'automatic' or 'fixed'.",
    );
  }
  const fixedAssigneeValue = jira.fixedAssignee;
  const fixedAssignee =
    typeof fixedAssigneeValue === "string" ? fixedAssigneeValue.trim() : "";
  if (
    assigneeMode === "fixed" &&
    (!fixedAssignee || !validAutomationJiraText(fixedAssignee, 255))
  ) {
    throw new ConfigError(
      "'jira.fixedAssignee' is required for fixed assignment and must be a valid account id or email.",
    );
  }
  if (
    fixedAssigneeValue !== undefined &&
    fixedAssigneeValue !== null &&
    typeof fixedAssigneeValue !== "string"
  ) {
    throw new ConfigError("'jira.fixedAssignee' must be a string when provided.");
  }

  return {
    jira: {
      projectKey,
      ...(parentKey ? { parentKey } : {}),
      issueType,
      ...(typeof boardIdValue === "number" ? { boardId: boardIdValue } : {}),
      useActiveSprint: useActiveSprintValue,
      labels,
      assigneeMode,
      ...(assigneeMode === "fixed" ? { fixedAssignee } : {}),
    },
  };
}

function validAutomationJiraText(value: string, maxLength: number): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(trimmed)
  );
}

/** GET /api/automation/config/schedules?projectId=... — live GitLab discovery. */
async function routeAutomationScheduleDiscovery(
  request: Request,
  url: URL,
  app: App,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request.method);
  const projectId = url.searchParams.get("projectId")?.trim();
  if (!projectId) {
    throw new ConfigError("'projectId' query parameter is required.");
  }
  const schedules = await app.sharedGitLab().listSchedules(
    projectId,
    request.signal,
  );
  return json({
    schedules: schedules
      .filter(
        (schedule) =>
          !excludedAutomationScheduleIds().has(schedule.id),
      )
      .map((schedule) => ({
        id: schedule.id,
        description: schedule.description,
        ref: schedule.ref,
        cron: schedule.cron ?? null,
        active: schedule.active ?? false,
      })),
  } satisfies ApiContract.AutomationScheduleDiscoveryResponse);
}

/**
 * GET /api/gitlab/merge-requests?project=<id>&search=<text> — backs the
 * "choose merge requests" autocomplete in the Add-task dialog. Exists as its
 * own route rather than hanging off a task instance because the dialog needs
 * to query it *before* an instance exists.
 */
async function routeGitLabMergeRequests(
  request: Request,
  url: URL,
  app: App,
  user: AuthUser,
): Promise<Response> {
  const project = url.searchParams.get("project")?.trim();
  if (!project) throw new ConfigError("'project' query parameter is required.");
  const search = url.searchParams.get("search")?.trim() || undefined;

  const gitlab = app.gitLabFor(user);
  const mergeRequests = await cached(
    app.responseCache,
    {
      resource: "gitlab-merge-requests",
      scope: { userId: user.id },
      params: [project, search ?? ""],
      ttlMs: CACHE_TTL.gitlabMergeRequests,
    },
    () => gitlab.listMergeRequests(project, { search, limit: 20 }),
    { bypass: wantsFreshData(request) },
  );
  return json({ mergeRequests: mergeRequests.map(toMergeRequestView) });
}

/**
 * GET /api/gitlab/projects?group=<path> — backs the repository dropdown in
 * the Add-task panel: a group like `example-org/services` holds dozens of
 * projects, and this lists them so the operator picks rather than types a
 * `group/project` path from memory.
 */
async function routeGitLabProjects(
  request: Request,
  url: URL,
  app: App,
  user: AuthUser,
): Promise<Response> {
  const group = url.searchParams.get("group")?.trim();
  if (!group) throw new ConfigError("'group' query parameter is required.");

  const gitlab = app.gitLabFor(user);
  const projects = await cached(
    app.responseCache,
    {
      resource: "gitlab-projects",
      scope: { userId: user.id },
      params: [group],
      ttlMs: CACHE_TTL.gitlabProjects,
    },
    () => gitlab.listGroupProjects(group, { limit: 100 }),
    { bypass: wantsFreshData(request) },
  );
  return json({ projects: projects.map(toGitLabProjectView) });
}

/**
 * GET /api/gitlab/branches?project=<id>&search=<text> — backs the "Branch"
 * scope's dropdown in the Add-task panel.
 */
async function routeGitLabBranches(
  request: Request,
  url: URL,
  app: App,
  user: AuthUser,
): Promise<Response> {
  const project = url.searchParams.get("project")?.trim();
  if (!project) throw new ConfigError("'project' query parameter is required.");
  const search = url.searchParams.get("search")?.trim() || undefined;

  const gitlab = app.gitLabFor(user);
  const branches = await cached(
    app.responseCache,
    {
      resource: "gitlab-branches",
      scope: { userId: user.id },
      params: [project, search ?? ""],
      ttlMs: CACHE_TTL.gitlabBranches,
    },
    () => gitlab.listBranches(project, { search, limit: 20 }),
    { bypass: wantsFreshData(request) },
  );
  return json({ branches: branches.map(toBranchView) });
}

/**
 * GET /api/agents — the coding agents this host is signed in to, which is what
 * the custom loop form's Agent dropdown offers.
 *
 * Not cached: it is four `existsSync` calls and four small file reads, and an
 * operator who has just logged into Cursor expects the dropdown to say so on the
 * next open rather than in ten minutes.
 */
async function routeAgents(): Promise<Response> {
  const agents = await detectAgents();
  return json({ agents } satisfies { agents: ApiContract.AgentConnectionView[] });
}

/**
 * GET /api/jira/issues?search=<text> — backs the "Issue" scope's autocomplete
 * in the Add-task panel. Global (not project-scoped): a single GitLab
 * repository's branches routinely carry keys from several Jira projects (TP,
 * OP, SP, ...), so narrowing to one project would hide the very issues an
 * operator is looking for.
 */
async function routeJiraIssues(
  request: Request,
  url: URL,
  app: App,
  user: AuthUser,
): Promise<Response> {
  const search = url.searchParams.get("search")?.trim();
  // The "Fix Jira issue" picker browses a fixed status queue rather than
  // searching by key/summary, so it must list something before the operator
  // has typed anything — only the plain autocomplete requires search text.
  const statuses = url.searchParams
    .get("statuses")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!search && !statuses?.length) return json({ issues: [] });

  const jira = app.jiraFor(user);
  // `text ~` matches key, summary and description; the trailing `*` makes a
  // partial key (e.g. "TP-30") match while it's still being typed.
  // Additionally, search the key field directly for partial matches (e.g. "3018" should match "TP-3018").
  const searchClauses = search
    ? [
        `text ~ "${escapeJql(search)}*"`,
        `key ~ "${escapeJql(search)}*"`,
      ]
    : [];
  const clauses = [
    searchClauses.length ? `(${searchClauses.join(" OR ")})` : undefined,
    statuses?.length
      ? `(${statuses.map((s) => `status = "${escapeJql(s)}"`).join(" OR ")})`
      : undefined,
  ].filter(Boolean);
  const jql = `${clauses.join(" AND ")} ORDER BY updated DESC`;
  // Keyed on the JQL rather than on the raw query parameters: it is what actually
  // decides the answer, and two different `statuses` orderings that build the same
  // query should not cost two searches.
  const issues = await cached(
    app.responseCache,
    {
      resource: "jira-issues",
      scope: { userId: user.id },
      params: [jql],
      ttlMs: CACHE_TTL.jiraIssues,
    },
    () => jira.searchIssues(jql, { limit: 20 }),
    { bypass: wantsFreshData(request) },
  );
  return json({ issues: issues.map(toJiraIssueView) });
}

/** GET /api/jira/users — project-scoped choices for the CI ticket assignee picker. */
async function routeJiraUsers(
  request: Request,
  url: URL,
  app: App,
  user: AuthUser,
): Promise<Response> {
  const project = url.searchParams.get("project")?.trim().toUpperCase();
  if (!project) throw new ValidationError("Jira project is required.");

  const jira = app.jiraFor(user);

  const users = await cached(
    app.responseCache,
    {
      resource: "jira-users",
      scope: { userId: user.id },
      // One assignable-user directory per identity and project. Both settings
      // forms and every picker search reuse this same value.
      params: [project],
      ttlMs: CACHE_TTL.jiraUsers,
    },
    () => jira.searchAssignableUsers(project, "", request.signal),
    { bypass: wantsFreshData(request) },
  );

  return json({ users: users.map(toJiraUserView) });
}

/**
 * GET /api/pull-requests?scope=mine|team&limit=<n> — the Pull requests page.
 *
 * Read as the session user, with their own forge tokens (see
 * `app.pullRequests`), which is the whole point: "my merge requests" has no
 * meaning under a shared bot token. A forge whose token the user has not stored
 * is reported in `unavailable` rather than as an error, so the page can explain
 * itself instead of showing a red box.
 */
async function routePullRequests(
  request: Request,
  url: URL,
  app: App,
  user: AuthUser,
): Promise<Response> {
  const raw = url.searchParams.get("scope")?.trim() || "mine";
  if (raw !== "mine" && raw !== "team") {
    throw new ConfigError("'scope' must be 'mine' or 'team'.");
  }
  // Capped at 50 rather than the usual 100: a forge's "every project I can see"
  // listing is expensive enough that gitlab.com times out on a larger page.
  const limit = clampPageParam(url.searchParams.get("limit"), 50, 50);
  const states = parsePullRequestStates(url.searchParams.get("states"));

  // The forge listing is cached, the response is not — `toPullRequestsView`
  // merges a live job-queue read over it. See `cachedPullRequestListing`.
  const listing = await cachedPullRequestListing(
    app,
    user,
    raw,
    { states, limit },
    { bypass: wantsFreshData(request) },
  );
  return jsonCached(toPullRequestsView(listing, activePullRequestActions(app)), request);
}

/**
 * GET /api/pull-requests/active-actions — a badge feed for the pull requests
 * list.
 *
 * Deliberately its own endpoint rather than folded into the listing above: the
 * listing calls out to the forge and the list page refetches it only on a
 * deliberate refresh, so it cannot be what the list polls for a running badge.
 * This reads the job queue alone — no forge call — so the client can poll it
 * every couple of seconds without the rate-limit cost `routePullRequests`
 * avoids on purpose.
 */
function routePullRequestActiveActions(app: App): Response {
  const actions = activePullRequestActions(app).map((action) => ({
    projectId: action.projectId,
    mrIid: action.mrIid,
    action: action.action,
    status: (action.job.status === "leased" ? "running" : "queued") as "queued" | "running",
  }));
  return json({ actions } satisfies ApiContract.PullRequestActiveActionsView);
}

async function routePullRequestAsset(
  request: Request,
  url: URL,
  id: string,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request.method);
  const path = url.searchParams.get("path");
  if (!path) throw new ConfigError("'path' is required.");

  const asset = await app.pullRequests.asset(user, id, path, { signal: request.signal });
  return new Response(asset.body, {
    headers: {
      "content-type": asset.contentType,
      "content-length": String(asset.body.byteLength),
      "content-disposition": inlineContentDisposition(asset.filename),
      "cache-control": "private, max-age=300",
      vary: "Cookie",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * `?states=open,draft`. Omitted means the service's default rather than
 * "everything", so a bare request stays the cheap one.
 */
function parsePullRequestStates(raw: string | null): PullRequestState[] | undefined {
  if (raw === null) return undefined;
  const names = raw
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  const unknown = names.filter((name) => !isPullRequestState(name));
  if (unknown.length > 0) {
    throw new ConfigError(
      `'states' must be a comma-separated list of ${PULL_REQUEST_STATES.join(", ")} — got ${unknown.join(", ")}.`,
    );
  }
  return names.filter(isPullRequestState);
}

/** Escapes the one character that would break out of a JQL string literal. */
function escapeJql(value: string): string {
  return value.replace(/"/g, '\\"');
}

/**
 * POST /api/tasks — create a new named instance of an instantiable
 * definition (e.g. a second "GitLab CI failures -> Jira" loop for another
 * project). The instance is registered immediately, so the response's task
 * detail and every subsequent /api/tasks list include it without a restart.
 */
async function routeTaskCreate(request: Request, app: App, user: AuthUser): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (cause) {
    throw new ConfigError("Request body is not valid JSON.", { cause });
  }
  if (typeof body !== "object" || body === null) {
    throw new ConfigError("Request body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;

  const definitionId = typeof b.definitionId === "string" ? b.definitionId : undefined;
  if (!definitionId) throw new ConfigError("'definitionId' is required.");
  const definition = app.taskRegistry.get(definitionId);
  if (!definition || !definition.instantiable) {
    throw new ConfigError(`'${definitionId}' is not an instantiable task definition.`);
  }

  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) throw new ConfigError("'name' is required.");
  const description = typeof b.description === "string" ? b.description : undefined;

  const visibility: Visibility | undefined =
    b.visibility === "public" || b.visibility === "private" ? b.visibility : undefined;
  if (b.visibility !== undefined && visibility === undefined) {
    throw new ConfigError("'visibility' must be 'public' or 'private'.");
  }

  const { task, scheduled } = app.tasks.createInstance({
    definitionId,
    name,
    description,
    visibility,
    ownerId: user.id,
    params: b.params,
    schedule: b.schedule,
    promptTemplate: typeof b.promptTemplate === "string" ? b.promptTemplate : undefined,
  });
  return json(await toTaskDetail(app, task, scheduled), 201);
}

/** `gitlab:mr:group/proj!412` and `gitlab:mr-feedback:group/proj!412` both yield the pair. */
function parseMrSubjectKey(
  subjectKey: string,
): { projectId: string; mrIid: number } | null {
  const match = subjectKey.match(/^gitlab:mr(?:-feedback)?:(.+)!(\d+)$/);
  if (!match) return null;
  const mrIid = Number(match[2]);
  if (!Number.isInteger(mrIid) || mrIid <= 0) return null;
  return { projectId: match[1]!, mrIid };
}

/**
 * POST /api/graph/mr-action — run one of the merge request toolbar's actions.
 *
 * Enqueues a job rather than calling `tasks.run` directly, which buys the whole
 * queue: retry with backoff, the dead-job brake, per-kind concurrency, and a
 * `jobs` row the graph already knows how to draw. `POST /api/tasks/:id/run`
 * would have skipped all of it, and its `isTaskActive` guard would 409 the
 * second merge request anyone asked about.
 *
 * The subject is looked up rather than trusted: the params handed to the agent
 * are derived from a `work_subjects` row this user can see, so a caller cannot
 * name an arbitrary project by editing the request.
 */
async function routeMrAction(request: Request, app: App, user: AuthUser): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (cause) {
    throw new ConfigError("Request body is not valid JSON.", { cause });
  }
  if (typeof body !== "object" || body === null) {
    throw new ConfigError("Request body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;

  const action = parseActionId(b.action);
  if (action === "revise") {
    throw new ConfigError("'revise' is available from the merge request conversation.");
  }
  const kind = handlerFor(action);

  const loopId = typeof b.loopId === "string" ? b.loopId : "";
  const subjectKey = typeof b.subjectKey === "string" ? b.subjectKey : "";
  if (!loopId || !subjectKey) {
    throw new ConfigError("'loopId' and 'subjectKey' are both required.");
  }

  app.refresh();
  // Same gate as reading the loop: acting on someone's private loop must not be
  // easier than seeing it.
  if (!canAccessTask(app, loopId, user)) return notFound(`No task '${loopId}'.`);
  if (!app.taskRegistry.get(kind)) {
    return json({ error: `No task '${kind}' is registered to handle '${action}'.` }, 501);
  }

  const subject = app.subjects.findOpen(loopId, subjectKey);
  if (!subject) return notFound(`No open work subject '${subjectKey}' on task '${loopId}'.`);

  const target = parseMrSubjectKey(subjectKey);
  if (!target) {
    throw new ConfigError(`'${subjectKey}' does not name a GitLab merge request.`);
  }

  // Shared with the pull request view's own toolbar, keyed on the merge request
  // rather than on this loop — so an action started here is the same job in
  // flight over there, and a developer cannot start two containers on one branch
  // by using both pages.
  const result = enqueuePullRequestAction(app, user, {
    action,
    projectId: target.projectId,
    mrIid: target.mrIid,
    loopId,
    subjectKey,
  });

  // 200 for an already-queued action, not 409: pressing a button twice is not an
  // error, it is an idempotent no-op the user should simply be told about. The web
  // client turns any non-2xx into a thrown Error and keeps only `error`, which
  // would throw this explanation away.
  return json(result satisfies ApiContract.MrActionResult, result.queued ? 202 : 200);
}

/**
 * `/api/pull-requests/:id`, `.../changes`, `.../actions` and `.../activity` —
 * the detail pane.
 *
 * Split from the listing route because they answer different questions from
 * different costs: the listing is one broad fetch per forge, while these are three
 * requests about one merge request, of which only `actions` touches nothing but
 * the local job queue.
 */

async function routePullRequestDetail(
  request: Request,
  url: URL,
  id: string,
  sub: string | undefined,
  app: App,
  user: AuthUser,
  /** Set only by `.../changes/:sha` — narrows the diff to one commit on the branch. */
  commitSha?: string,
): Promise<Response> {
  if (sub === "actions" && request.method === "POST") {
    return routePullRequestAction(request, id, app, user);
  }
  if (request.method !== "GET") return methodNotAllowed(request.method);

  const ref = parsePullRequestId(id);
  if (!ref) throw new ValidationError(`'${id}' is not a pull request id.`);

  if (sub === "actions") {
    return json(
      ref.provider === "gitlab"
        ? pullRequestActionStates(app, ref.repository, ref.number)
        : ({ actions: [], live: false } satisfies ApiContract.PullRequestActionsView),
    );
  }

  if (sub === "activity") {
    return json(
      ref.provider === "gitlab"
        ? pullRequestActivity(app, ref.repository, ref.number)
        : ({ entries: [] } satisfies ApiContract.PullRequestActivityView),
    );
  }

  const bypass = wantsFreshData(request);

  if (sub === "runs") {
    if (ref.provider !== "gitlab") {
      return json({ runs: [], total: 0 } satisfies ApiContract.PullRequestRunPageView);
    }
    // `canAccessTask` is deliberately not the check here: it guards a task
    // instance's visibility, and these runs belong to `kind: "job"` tasks that
    // have no instance row, so it would pass everything. The merge request is
    // the subject to authorize instead — and the only way to authorize it is to
    // fetch it with the caller's own token, as the actions route does, since the
    // id came out of a URL. Through the shared detail entry rather than straight
    // to the forge, so paging through history costs one forge call rather than one
    // per page — the same check, answered from the read the pane already made.
    await cachedPullRequestDetail(app, user, id, { bypass });
    const limit = clampPageParam(url.searchParams.get("limit"), 20, 100);
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    return json(
      toPullRequestRunPage(app, ref.repository, ref.number, { limit, offset }),
    );
  }

  if (sub === "changes") {
    /**
     * Keyed by the commit set, which turns a stale cache into an immutable one.
     *
     * This is the largest response the API produces, and a diff is not "the state
     * of the merge request a moment ago" — it is the diff *of those commits*, and
     * those commits either are what is on the branch or are not. Push, and the
     * revision changes and so does the key; don't, and ten minutes is exactly as
     * correct as ten milliseconds.
     *
     * The revision costs nothing extra: it comes from the detail entry the pane
     * fetched to render its header, one line above in the same 30s window. The
     * shas are hashed rather than joined because fifty of them is a two-kilobyte
     * cache key, and the whole set rather than the first because "newest first" is
     * GitLab's ordering convention, not a guarantee worth depending on.
     */
    const head = await cachedPullRequestDetail(app, user, id, { bypass });
    /**
     * A commit-scoped diff is keyed on the sha itself, which is a revision already:
     * a commit's diff against its parent does not change, so the entry is stale
     * only in the sense that it expires.
     *
     * The sha is checked against this merge request's own commits first. The detail
     * read above is what authorizes this request, and without this the route would
     * diff *any* commit in the project for anyone who can see one merge request in
     * it. Prefixed in the cache key so a sha can never be mistaken for the hashed
     * head revision below.
     */
    if (commitSha !== undefined && !head.commits.some((commit) => commit.sha === commitSha)) {
      return notFound(`Commit '${commitSha}' is not on this merge request.`);
    }
    const revision =
      commitSha ?? String(Bun.hash(head.commits.map((commit) => commit.sha).join(",")));
    const changes = await cached(
      app.responseCache,
      {
        resource: "pull-request-changes",
        scope: { userId: user.id },
        params: [id, commitSha === undefined ? `head:${revision}` : `commit:${revision}`],
        ttlMs: CACHE_TTL.pullRequestChanges,
      },
      () =>
        commitSha === undefined
          ? app.pullRequests.changes(user, id)
          : app.pullRequests.commitChanges(user, id, commitSha),
      { bypass },
    );
    // `revision` rather than a hash of the body: it is the head commit set, which
    // is what actually decides whether a diff has changed, and it is already
    // computed for the cache key above.
    return jsonCached(toPullRequestChangesView(changes), request, revision);
  }

  const detail = await cachedPullRequestDetail(app, user, id, { bypass });
  // Only GitLab has handler tasks behind these actions; another forge's pull
  // request renders with an empty toolbar rather than with buttons that would 400.
  const actions =
    ref.provider === "gitlab" ? pullRequestActionViews(app, ref.repository, detail) : [];
  return json(toPullRequestDetailView(detail, actions));
}

/**
 * POST `/api/pull-requests/:id/actions` — start one agent action on this merge
 * request.
 *
 * The merge request is fetched with the caller's own token before anything is
 * queued. That is the authorization check: the id came out of a URL, and without
 * this a logged-in user could name any project path on the instance and have an
 * agent rebase and force-push it. The same fetch also re-checks that the action
 * makes sense, so a greyed-out button is not the only thing preventing a rebase of
 * a merge request that had no conflicts.
 */
async function routePullRequestAction(
  request: Request,
  id: string,
  app: App,
  user: AuthUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (cause) {
    throw new ConfigError("Request body is not valid JSON.", { cause });
  }
  if (typeof body !== "object" || body === null) {
    throw new ConfigError("Request body must be a JSON object.");
  }
  const fields = body as Record<string, unknown>;
  const action = parseActionId(fields.action);
  const instruction = action === "revise" ? parseRevisionInstruction(fields.instruction) : undefined;
  const history = action === "revise" ? parseRevisionHistory(fields.history) : undefined;

  const ref = parsePullRequestId(id);
  if (!ref) throw new ValidationError(`'${id}' is not a pull request id.`);
  if (ref.provider !== "gitlab") {
    throw new ConfigError(`'${ref.provider}' pull requests have no agent actions.`);
  }

  app.refresh();
  const detail = await app.pullRequests.detail(user, id);
  const refusal = pullRequestActionRefusal(app, action, ref.repository, detail);
  if (refusal) return json({ error: refusal }, 409);

  const result = enqueuePullRequestAction(app, user, {
    action,
    projectId: ref.repository,
    mrIid: ref.number,
    ...(instruction ? { instruction } : {}),
    ...(history ? { history } : {}),
  });
  return json(result satisfies ApiContract.PullRequestActionResult, result.queued ? 202 : 200);
}

function parseActionId(raw: unknown): ApiContract.PullRequestActionId {
  const action = typeof raw === "string" ? raw : "";
  if (!isPullRequestAction(action)) {
    throw new ConfigError(`'action' must be one of ${PULL_REQUEST_ACTIONS.join(", ")}.`);
  }
  return action;
}

function parseRevisionInstruction(raw: unknown): string {
  if (typeof raw !== "string") throw new ConfigError("'instruction' is required for a revision.");
  const instruction = raw.trim();
  if (!instruction || instruction.length > 20_000) {
    throw new ConfigError("'instruction' must contain between 1 and 20000 characters.");
  }
  return instruction;
}

function parseRevisionHistory(raw: unknown): ApiContract.AssistantMessage[] {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 20) {
    throw new ConfigError("'history' must be an array of at most 20 messages.");
  }
  return raw.map((message, index) => {
    if (!message || typeof message !== "object") {
      throw new ConfigError(`history[${index}] must be an object.`);
    }
    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
      throw new ConfigError(`history[${index}] has an invalid role or content.`);
    }
    const trimmed = content.trim();
    if (!trimmed || trimmed.length > 20_000) {
      throw new ConfigError(`history[${index}] content must be 1–20000 characters.`);
    }
    return { role, content: trimmed };
  });
}

/**
 * PUT/PATCH /api/tasks/:id — update an existing task instance's metadata
 * (name, description, promptTemplate). Only the instance owner can update it.
 */
async function routeTaskUpdate(request: Request, id: string, app: App, user: AuthUser): Promise<Response> {
  const instance = app.instances.get(id);
  if (!instance) return notFound(`Task '${id}' does not exist.`);
  if (
    instance.ownerId !== user.id &&
    !createAppAbility(user.permissions).can("manage", "Task")
  ) {
    return json({ error: "You do not have permission to update this task." }, 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch (cause) {
    throw new ConfigError("Request body is not valid JSON.", { cause });
  }
  if (typeof body !== "object" || body === null) {
    throw new ConfigError("Request body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;

  const update: {
    name?: string;
    description?: string | null;
    promptTemplate?: string | null;
  } = {};

  if (b.name !== undefined) {
    if (typeof b.name !== "string") throw new ConfigError("'name' must be a string.");
    const trimmed = b.name.trim();
    if (!trimmed) throw new ConfigError("'name' cannot be empty.");
    update.name = trimmed;
  }
  if (b.description !== undefined) {
    if (b.description !== null && typeof b.description !== "string") {
      throw new ConfigError("'description' must be a string or null.");
    }
    update.description = b.description;
  }
  if (b.promptTemplate !== undefined) {
    if (b.promptTemplate !== null && typeof b.promptTemplate !== "string") {
      throw new ConfigError("'promptTemplate' must be a string or null.");
    }
    update.promptTemplate = b.promptTemplate;
  }

  app.tasks.updateInstance(id, update);

  const task = app.taskRegistry.get(id);
  if (!task) return notFound(`Task '${id}' not found after update.`);
  const scheduled = app.scheduledTask(id);
  if (!scheduled) return notFound(`Scheduled task '${id}' not found after update.`);
  return json(await toTaskDetail(app, task, scheduled));
}

/**
 * DELETE /api/tasks/:id — delete a task instance and its schedule.
 *
 * Owner-only, which is stricter than the update route on purpose: a team loop is
 * visible to everyone, but a passerby deleting it destroys work that is not
 * theirs. Rows written before ownership existed have no `ownerId` and stay
 * deletable by whoever is signed in, rather than being undeletable forever.
 *
 * Refuses while a run is in flight (409). The executor holds the `Task` object
 * for the duration, so unregistering under it would let a run finish and write
 * its result against an id that no longer exists — cancel it first, which is
 * what the message says.
 */
async function routeTaskDelete(id: string, app: App, user: AuthUser): Promise<Response> {
  const instance = app.instances.get(id);
  // Not 404-on-definition: `custom-loop` is a real, visible task id, and "cannot
  // be deleted" is the useful answer rather than "does not exist".
  if (!instance) {
    if (app.taskRegistry.has(id)) {
      return json(
        { error: `'${id}' is a built-in task definition, not a loop you created.` },
        409,
      );
    }
    return notFound(`Task '${id}' does not exist.`);
  }
  if (instance.ownerId && instance.ownerId !== user.id) {
    return json({ error: "Only the loop's owner can delete it." }, 403);
  }
  if (app.sink.lastRun(id)?.status === "running") {
    return json({ error: "This loop is running. Cancel the run before deleting it." }, 409);
  }

  await app.tasks.deleteInstance(id);
  return json({ id, deleted: true } satisfies ApiContract.TaskDeletedView);
}

/**
 * POST /api/tasks/:id/run.
 *
 * The request returns as soon as the run row is open (202) so the UI can poll
 * activity; holding the socket
 * until a code review finishes trips Bun's default 10s idle timeout and
 * leaves a phantom `running` row with no logs.
 *
 * Last-run params fill gaps, stored schedule params win over those, and the
 * request body overrides field by field.
 * `undefined` values in a layer do not clobber a previous one — a Rerun with
 * `{}` must keep the instance's gitlab/jira blocks.
 */
async function routeTaskRun(
  request: Request,
  id: string,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);
  if (!canAccessTask(app, id, user)) return notFound(`No task '${id}'.`);

  // Same as GET /api/tasks: schedule/params writes must be visible to this POST,
  // or a Rerun uses stale empty params.
  app.refresh();

  app.taskRegistry.require(id);

  if (app.executor.isTaskActive(id)) {
    return json({ error: `Task '${id}' is already running.` }, 409);
  }

  let body: unknown = {};
  const text = await request.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch (cause) {
      throw new ConfigError("Request body is not valid JSON.", { cause });
    }
  }

  const opened = Promise.withResolvers<{ executionId: string }>();
  let started = false;
  void app.tasks
    .run(id, body, {
      // A click of Run/Rerun is an explicit request — skip-if-unchanged
      // ledgers must not turn it into a no-op.
      force: true,
      // Whoever clicked Run is who the run acts as: their GitLab token, their
      // name on the comment it posts.
      actor: user,
      onStarted: (info) => {
        started = true;
        opened.resolve(info);
      },
    })
    .then(
      () => undefined,
      (err) => {
        if (!started) {
          opened.reject(err);
          return;
        }
        app.logger.error(
          { task: id, err: describeError(err) },
          `task ${id} failed`,
        );
      },
    );

  const info = await opened.promise;
  const run = app.sink.getRun(info.executionId);
  if (!run) {
    return json({ error: `Run '${info.executionId}' was not recorded.` }, 500);
  }
  return json({ ...toRunView(run), steps: [] }, 202);
}

/**
 * /api/me/credentials — the logged-in developer's own stored tokens, behind My
 * provider access.
 *
 * Scoped to the session user with no id in the path, which is the whole security
 * model: there is no way to spell "somebody else's credentials", so no way to get
 * the authorisation check wrong. The GET reports state, never a token — see
 * `toProviderAccessView`.
 *
 * PUT takes a patch of many credentials rather than one name and value, because
 * a card here is Jira's email *and* token: storing them one request at a time
 * means a failure halfway leaves an identity that is half yours, and the dialog
 * would have to explain which half. The older single-field body remains
 * accepted for API compatibility.
 */
async function routeMyCredentials(
  request: Request,
  url: URL,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method === "GET") {
    return json(await providerAccessView(app, user, request.signal));
  }

  if (request.method === "PUT" || request.method === "POST") {
    const body = (await readJsonBody(request)) as Record<string, unknown> | null;

    // `{ credentials: { NAME: value | null } }`, or the single `{ name, value }`
    // normalised into one so there is one write path below rather than two.
    const patch: Record<string, unknown> =
      body?.credentials != null &&
      typeof body.credentials === "object" &&
      !Array.isArray(body.credentials)
        ? (body.credentials as Record<string, unknown>)
        : typeof body?.name === "string"
          ? { [body.name]: body.value ?? null }
          : (() => {
              throw new ConfigError(
                "'credentials' must be an object of credential name to value.",
              );
            })();

    // Validated in full before anything is written: half an identity stored is
    // worse than none, because the run that follows fails as the wrong person.
    const entries: [string, string | null][] = [];
    for (const [rawName, rawValue] of Object.entries(patch)) {
      const name = rawName.toUpperCase();
      if (!isActorSecret(name)) {
        throw new ConfigError(
          `'${rawName}' is not a per-user credential. One of: ${ACTOR_SECRETS.join(", ")}.`,
        );
      }
      if (rawValue !== null && typeof rawValue !== "string") {
        throw new ConfigError(`'${rawName}' must be a string, or null to remove it.`);
      }
      entries.push([name, rawValue]);
    }
    if (entries.length === 0) throw new ConfigError("Nothing to store.");

    for (const [name, value] of entries) {
      // Empty means remove, as it does on the settings page. A stored empty
      // credential would look configured while making every provider call fail.
      if (value == null || value.trim() === "") {
        app.credentials.delete(user.id, name);
      } else {
        app.credentials.set(user.id, name, value);
      }
    }

    // The scrubber has never seen a token stored a moment ago, and this one
    // belongs to a person rather than to a service account — the most important
    // kind not to print in full in the next log line.
    registerSecretValues(
      entries
        .filter(([name, value]) => value != null && isRedactedSecret(name))
        .map(([, value]) => value!),
    );

    // Every cached forge read was fetched as somebody, and this request changed
    // who this user is. Keys are `resource|user:<id>|…` and the cache invalidates
    // by prefix only, so reaching one user's entries would mean a prefix that a
    // second user whose id merely starts the same would also match. Clearing the
    // lot is over-broad and correct; storing a token is a once-a-quarter write.
    app.responseCache.clear();

    // State, not values: the dialog needs to re-render, and echoing a token back
    // would put it in a response body, a browser cache, and any proxy log between.
    return json(toProviderAccessView(app, user));
  }

  if (request.method === "DELETE") {
    const name = (url.searchParams.get("name") ?? "").toUpperCase();
    if (!name) throw new ConfigError("'name' query parameter is required.");
    const removed = app.credentials.delete(user.id, name);
    if (removed) app.responseCache.clear();
    return json({ name, removed });
  }

  return methodNotAllowed(request.method);
}

/**
 * Credential state plus the identity the developer's own GitLab token resolves
 * to. An invalid or expired token leaves the identity absent without making the
 * credentials dialog itself fail to load.
 */
async function providerAccessView(app: App, user: AuthUser, signal?: AbortSignal) {
  const view = toProviderAccessView(app, user);
  const hasOwnGitLabToken = view.fields.some(
    (field) => field.name === "GITLAB_TOKEN" && field.origin === "user" && !field.unreadable,
  );
  if (!hasOwnGitLabToken) return view;

  try {
    const gitlabUser = await app.pullRequests.authenticatedUser(user, "gitlab", signal);
    return gitlabUser ? { ...view, gitlabUser } : view;
  } catch {
    return view;
  }
}

/** A JSON body, or a ConfigError naming the problem rather than a 500. */
async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (cause) {
    throw new ConfigError("Request body is not valid JSON.", { cause });
  }
}

/**
 * /api/me/agent-accounts — the AI agent accounts this developer has connected.
 *
 * Scoped to the session user with no id in the path, exactly like
 * `/api/me/credentials`: there is no way to spell "somebody else's accounts", so
 * no authorisation check to get wrong. Credentials are write-only — the GET
 * returns the catalog with each provider's accounts attached, and nothing in this
 * file can read a stored value back out.
 *
 * POST handles the paste-a-credential options only. The delegated logins run a
 * process and need to be polled, so they have their own endpoint below.
 */
async function routeMyAgentAccounts(
  request: Request,
  url: URL,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method === "GET") {
    const accounts = app.agentAccounts.list(user.id);
    // Only what was connected here, deliberately. An earlier version also probed
    // the operator's home directory for vendor logins and listed what it found,
    // which meant opening this dialog reported the emails behind their personal
    // Codex and Cursor sessions -- accounts nobody had offered talos. What is
    // on this page is what someone chose to put on it.
    // Claude only, and from the runner rather than the filesystem: this is the
    // directory `runAgentJob` puts on every `docker run`, so the card can report
    // the login work actually goes through. The `existsSync` is the one question
    // asked of the disk — does the directory the mount names exist — and no file
    // in it is opened.
    const hostClaude = hostClaudeConfigDir();
    const hostRuntime = existsSync(hostClaude) ? { path: hostClaude } : undefined;
    const catalog = agentCatalogView().map((entry) => {
      const mine = accounts.filter((account) => account.provider === entry.provider);
      // The fallback is reported only while it is this developer's fallback in
      // effect. Once they connect an account `runAgentJob` stops mounting the
      // host's config for their runs, and a card still showing it as in use would
      // be describing somebody else's situation.
      const usesHost =
        entry.provider === "claude" &&
        hostRuntime &&
        !app.agentAccounts.runtimeAccount(user.id, entry.provider);
      return {
        ...entry,
        accounts: mine.map(toAccountView),
        ...(usesHost ? { hostRuntime } : {}),
      };
    });
    return json({
      secretsEnabled: app.agentAccounts.secretsEnabled,
      catalog,
    } satisfies ApiContract.AgentAccountsView);
  }

  if (request.method === "POST" || request.method === "PUT") {
    const fields = (await readJsonBody(request)) as Record<string, unknown> | null;
    const optionId = typeof fields?.optionId === "string" ? fields.optionId : "";
    const label = typeof fields?.label === "string" ? fields.label : "";
    const submitted = (fields?.values ?? {}) as Record<string, unknown>;
    const option = agentAuthOption(optionId);
    if (!option) throw new ConfigError(`'${optionId}' is not an agent connection option.`);
    if (option.method !== "key") {
      throw new ConfigError(
        `'${option.label}' is a sign-in-on-this-host option — start it at ` +
          "/api/me/agent-accounts/login.",
      );
    }

    // Driven by the option's fields rather than by what was posted: a variable
    // the catalog does not ask for is not stored, so nothing a request invents
    // reaches an agent's environment.
    const values: Record<string, string> = {};
    const secrets: string[] = [];
    for (const field of option.fields ?? []) {
      // Fixed values (CLAUDE_CODE_USE_BEDROCK=1) come from the catalog, never
      // from the request — they are a switch this option implies, not input.
      const value = field.value ?? String(submitted[field.env] ?? "").trim();
      if (!value) {
        if (field.optional) continue;
        throw new ConfigError(`${field.label ?? field.env} is required.`);
      }
      values[field.env] = value;
      if (field.secret) secrets.push(value);
    }
    if (Object.keys(values).length === 0) {
      throw new ConfigError(`Option '${optionId}' asks for no credential.`);
    }

    const account = app.agentAccounts.save({
      userId: user.id,
      provider: optionId.split(":")[0]!,
      label,
      method: "key",
      optionId,
      values,
    });
    // So they never appear verbatim in a log line — the same treatment a token
    // saved in Settings → Integrations gets.
    registerSecretValues(secrets);
    // The row, never the value. Echoing it back would put a credential in a
    // response body, a browser cache, and any proxy log in between.
    return json(toAccountView(account), 201);
  }

  if (request.method === "DELETE") {
    const id = url.searchParams.get("id") ?? "";
    if (!id) throw new ConfigError("'id' query parameter is required.");
    // The vendor's own credential directory is deliberately left on disk: a
    // disconnect here stops talos using the account, and deleting the
    // directory would also log the operator out of a CLI they may be using
    // themselves. Reconnecting reuses it — see `AgentLoginManager`.
    return json({ id, removed: app.agentAccounts.delete(user.id, id) });
  }

  return methodNotAllowed(request.method);
}

function routeAgentUsage(
  request: Request,
  url: URL,
  app: App,
  userId?: string,
): Response {
  if (request.method !== "GET") return methodNotAllowed(request.method);
  const days = Number(url.searchParams.get("days") ?? 30);
  if (![7, 30, 90, 365].includes(days)) {
    throw new ConfigError("'days' must be 7, 30, 90, or 365.");
  }
  const source = (url.searchParams.get("source") || undefined) as AgentUsageSource | undefined;
  if (source && source !== "task" && source !== "assistant" && source !== "e2e") {
    throw new ConfigError("'source' must be task, assistant, or e2e.");
  }
  const account = url.searchParams.get("account")?.trim() || undefined;
  if (account && account.length > 200) throw new ConfigError("'account' is too long.");
  const limit = clampPageParam(url.searchParams.get("limit"), 25, 100);
  const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60_000);
  const report = app.agentUsage.report(userId, {
    from,
    to,
    ...(account ? { account } : {}),
    ...(source ? { source } : {}),
    limit,
    offset,
  });
  const users = userId == null
    ? new Map(app.auth.users().map((user) => [user.id, { id: user.id, name: user.name }]))
    : undefined;
  return privateJson({
    range: { from: from.toISOString(), to: to.toISOString() },
    totals: report.totals,
    daily: report.daily,
    accounts: report.accounts,
    models: report.models,
    sources: report.sources,
    events: report.events.map(({ userId: eventUserId, ...event }) => ({
      ...event,
      ...(users
        ? { user: users.get(eventUserId) ?? { id: eventUserId, name: "Deleted user" } }
        : {}),
      startedAt: event.startedAt.toISOString(),
      finishedAt: event.finishedAt.toISOString(),
    })),
    eventCount: report.eventCount,
  } satisfies ApiContract.AgentUsageReportView);
}

/**
 * POST /api/me/agent-accounts/use-for-runs — point your agent runs at one account.
 *
 * Yours only, in both directions: it moves a flag among the caller's own accounts,
 * and it changes what *their* runs authenticate as from the next run onwards.
 * Somebody else's loops are unaffected, which is the point — each developer's work
 * bills to their own plan.
 *
 * Only interesting once you have two accounts for one vendor. The first one
 * connected is flagged automatically.
 */
async function routeAgentAccountUseForRuns(
  request: Request,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method !== "POST" && request.method !== "PUT") {
    return methodNotAllowed(request.method);
  }
  const fields = (await readJsonBody(request)) as Record<string, unknown> | null;
  const id = typeof fields?.id === "string" ? fields.id : "";
  if (!id) throw new ConfigError("'id' is required.");
  const account = app.agentAccounts.useForRuns(user.id, id);
  if (!account) return notFound(`No agent account '${id}'.`);
  return json(toAccountView(account));
}

/**
 * /api/me/agent-accounts/login — one delegated vendor login, start to finish.
 *
 * POST starts it, GET polls it, PUT answers whatever it asked, DELETE gives up.
 * Polled rather than streamed because the payload is a whole transcript that
 * grows by a line at a time: re-sending a screenful every second is cheaper than
 * an SSE endpoint to maintain, and the modal is the only thing reading it.
 *
 * See `infrastructure/agent/login.ts` for why this shells out at all — no vendor
 * here publishes an OAuth app a third party could use instead.
 */
async function routeAgentLogin(
  request: Request,
  url: URL,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method === "POST") {
    const fields = (await readJsonBody(request)) as Record<string, unknown> | null;
    const optionId = typeof fields?.optionId === "string" ? fields.optionId : "";
    const label = typeof fields?.label === "string" ? fields.label : "";
    return json(await app.agentLogins.start({ userId: user.id, optionId, label }), 202);
  }

  const id = url.searchParams.get("id") ?? "";
  if (!id) throw new ConfigError("'id' query parameter is required.");

  if (request.method === "GET") {
    const view = app.agentLogins.view(user.id, id);
    // Sessions are forgotten a minute after they finish, and a browser left open
    // will poll one that is gone. A 404 is the honest answer and the client
    // treats it as "stopped watching", not as an error to show.
    if (!view) return json({ error: `Sign-in '${id}' is no longer running.` }, 404);
    return json(view);
  }

  if (request.method === "PUT") {
    const fields = (await readJsonBody(request)) as Record<string, unknown> | null;
    const input = typeof fields?.input === "string" ? fields.input : "";
    if (!input.trim()) throw new ConfigError("'input' is required.");
    return json(app.agentLogins.respond(user.id, id, input.trim()));
  }

  if (request.method === "DELETE") {
    app.agentLogins.cancel(user.id, id);
    return json({ id, cancelled: true });
  }

  return methodNotAllowed(request.method);
}

/**
 * GET/PUT /api/me/pull-request-repos — the signed-in developer's Team MRs
 * repository filter.
 *
 * PUT replaces the whole list rather than adding/removing one at a time: the
 * settings UI always holds and saves the full set, and a single-repo
 * add/remove endpoint would need its own conflict handling for no benefit —
 * this table is small enough that a full rewrite is not a real cost.
 */
async function routeMyPullRequestRepos(
  request: Request,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method === "GET") {
    return json(toPullRequestRepoFilterView(app.pullRequestRepoFilters.list(user.id)));
  }

  if (request.method === "PUT") {
    let body: unknown;
    try {
      body = await request.json();
    } catch (cause) {
      throw new ConfigError("Request body is not valid JSON.", { cause });
    }
    const repositories = (body as Record<string, unknown> | null)?.repositories;
    if (!Array.isArray(repositories) || repositories.some((repo) => typeof repo !== "string")) {
      throw new ConfigError("'repositories' must be an array of strings.");
    }
    app.pullRequestRepoFilters.set(user.id, repositories);
    // This filter is part of every cached listing's key rather than of its URL, so
    // changing it does not miss the old entries — it strands them, and they keep
    // being served to nobody while the page reads a fresh one. Dropping the
    // resource is cheaper than reasoning about that, and only this user's keys
    // could have been built from this user's filter.
    app.responseCache.invalidate(CACHE_PREFIX.pullRequests);
    return json(toPullRequestRepoFilterView(app.pullRequestRepoFilters.list(user.id)));
  }

  return methodNotAllowed(request.method);
}

/**
 * GET/PUT /api/me/fix-issue-defaults — where this developer's "Fix this issue"
 * clicks open their merge request.
 *
 * Per-user, like the repository filter above and for a stronger reason: a Jira
 * ticket names no repository, so without this the graph's button would have to
 * guess a project to push a branch to. Null until they set it, which is what the
 * button's disabled state explains.
 */
async function routeMyFixIssueDefaults(
  request: Request,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method === "GET") {
    return json(app.fixIssueDefaults.get(user.id));
  }

  if (request.method === "PUT") {
    let body: unknown;
    try {
      body = await request.json();
    } catch (cause) {
      throw new ConfigError("Request body is not valid JSON.", { cause });
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const projectId = typeof b.projectId === "string" ? b.projectId.trim() : "";
    const targetBranch = typeof b.targetBranch === "string" ? b.targetBranch.trim() : "";
    if (!projectId || !targetBranch) {
      throw new ConfigError("'projectId' and 'targetBranch' are both required.");
    }
    app.fixIssueDefaults.set(user.id, { projectId, targetBranch });
    return json(app.fixIssueDefaults.get(user.id));
  }

  return methodNotAllowed(request.method);
}

/**
 * GET/PUT /api/me/preferences — how this developer has set the console up.
 *
 * Always the asking user's own row, never a user id from the request: a preference
 * is not sensitive, but a route that takes an id is a route somebody eventually
 * writes somebody else's settings through.
 *
 * The value is stored as whatever JSON arrives, unvalidated on purpose — see
 * `PreferenceRepository`. What *is* checked is the key, because it is a primary key
 * component and an unbounded one lets a client fill the table with junk.
 */
async function routeMyPreferences(
  request: Request,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method === "GET") {
    return json({ values: readPreferences(app, user) } satisfies ApiContract.PreferencesView);
  }

  if (request.method === "PUT") {
    let body: unknown;
    try {
      body = await request.json();
    } catch (cause) {
      throw new ConfigError("Request body is not valid JSON.", { cause });
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const key = typeof b.key === "string" ? b.key.trim() : "";
    if (!key) throw new ConfigError("'key' is required.");
    if (key.length > 120) throw new ConfigError("'key' is too long (120 characters max).");

    // Null clears rather than stores — see `PreferencePatch`.
    if (b.value === null || b.value === undefined) app.preferences.clear(user.id, key);
    else app.preferences.set(user.id, key, JSON.stringify(b.value));

    return json({ values: readPreferences(app, user) } satisfies ApiContract.PreferencesView);
  }

  return methodNotAllowed(request.method);
}

/**
 * The stored rows as parsed JSON.
 *
 * A row that will not parse is dropped rather than failing the read: it can only
 * have come from a hand-edited database, and the page it belongs to falls back to
 * its default the same way it would for a missing row.
 */
function readPreferences(app: App, user: AuthUser): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(app.preferences.all(user.id))) {
    try {
      values[key] = JSON.parse(raw);
    } catch {
      // See the GET above.
    }
  }
  return values;
}

/**
 * GET/PUT /api/me/agent-run-preferences — model defaults for work this
 * developer starts directly. Scheduled loops continue to use instance defaults.
 */
async function routeMyAgentRunPreferences(
  request: Request,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method === "GET") {
    return json(
      app.agentRunPreferences.get(user.id) satisfies ApiContract.AgentRunPreferencesView,
    );
  }

  if (request.method === "PUT") {
    const body = (await readJsonBody(request)) as Record<string, unknown> | null;
    const model = body?.model === null ? null : body?.model;
    const effort = body?.effort === null ? null : body?.effort;
    if (model !== null && !isModel(model)) {
      throw new ConfigError("'model' must be a supported model or null.");
    }
    if (effort !== null && !isEffort(effort)) {
      throw new ConfigError("'effort' must be a supported effort or null.");
    }
    return json(
      app.agentRunPreferences.set(user.id, {
        model,
        effort,
      }) satisfies ApiContract.AgentRunPreferencesView,
    );
  }

  return methodNotAllowed(request.method);
}

async function routeAssistantChat(
  request: Request,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 256_000) {
    return json({ error: "Assistant transcript is too large." }, 413);
  }

  const messages = parseAssistantMessages(await jsonBody(request));
  const account = app.agentAccounts.runtimeCredential(user.id, "claude");
  if (!account) {
    return json(
      { error: "No Claude account is selected. Connect one under Settings → Agent connections." },
      409,
    );
  }
  const llm = app.agentRunPreferences.resolve(app.settings().llm, user, "actor");

  const turnAbort = new AbortController();
  const signal = AbortSignal.any([request.signal, turnAbort.signal]);
  const capability = app.assistantCapabilities.issue(user, signal);
  const mcpUrl = new URL(request.url);
  mcpUrl.pathname = "/internal/assistant/mcp";
  mcpUrl.search = "";
  mcpUrl.hash = "";
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: ApiContract.AssistantStreamEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
          turnAbort.abort();
        }
      };

      void app
        .runAssistantChat({
          messages,
          actor: user,
          account,
          mcpUrl: mcpUrl.toString(),
          capabilityToken: capability.token,
          model: llm.model ?? undefined,
          effort: llm.effort ?? undefined,
          signal,
          logger: app.logger,
          emit,
        })
        .catch((cause: unknown) => {
          if (signal.aborted) return;
          emit({
            type: "error",
            message:
              cause instanceof TalosError
                ? cause.message
                : "The connected Claude client failed unexpectedly.",
          });
        })
        .finally(() => {
          app.assistantCapabilities.revoke(capability.token);
          if (!closed) {
            closed = true;
            controller.close();
          }
        });
    },
    cancel() {
      closed = true;
      turnAbort.abort();
      app.assistantCapabilities.revoke(capability.token);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      vary: "Cookie",
      "x-content-type-options": "nosniff",
    },
  });
}

function parseAssistantMessages(body: unknown): ApiContract.AssistantMessage[] {
  if (!body || typeof body !== "object" || !("messages" in body)) {
    throw new ConfigError("'messages' is required.");
  }
  const raw = (body as { messages?: unknown }).messages;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 30) {
    throw new ConfigError("'messages' must contain between 1 and 30 messages.");
  }
  const messages = raw.map((message, index): ApiContract.AssistantMessage => {
    if (!message || typeof message !== "object") {
      throw new ConfigError(`messages[${index}] must be an object.`);
    }
    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
      throw new ConfigError(`messages[${index}] has an invalid role or content.`);
    }
    const trimmed = content.trim();
    if (!trimmed || trimmed.length > 20_000) {
      throw new ConfigError(`messages[${index}] content must be 1–20000 characters.`);
    }
    return { role, content: trimmed };
  });
  if (messages.at(-1)?.role !== "user") {
    throw new ConfigError("The last assistant message must have role 'user'.");
  }
  return messages;
}

/**
 * Where an unsubscribed notification kind is recorded: a preference, not a table.
 *
 * `notifications` is install-wide (see its migration), so "who wants this one" was
 * never a column on it — and a list of muted kinds is exactly the shape
 * `user_preferences` exists for. Storing the *muted* set rather than the
 * subscribed one is what makes a new kind arrive switched on: nobody has to have
 * opted into a feature that did not exist when they last opened Settings.
 */
const MUTED_KINDS_PREFERENCE = "notifications.muted";

function mutedNotificationKinds(app: App, user: AuthUser): Set<string> {
  const raw = readPreferences(app, user)[MUTED_KINDS_PREFERENCE];
  return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : []);
}

/**
 * The notifications this developer is allowed and willing to see, newest first.
 *
 * Two filters, and they are different in kind. Access is not negotiable — a
 * notification about a private loop belongs to its owner, and the table holding
 * everyone's rows is the only reason this check has to exist at all. Subscription
 * is a preference: the kinds they turned off under My notifications.
 *
 * A run that no longer exists stays visible: the notification outlives the run row
 * it points at (runs are pruned, notifications age out after a week), and hiding it
 * would mean losing the notice rather than protecting anything.
 */
function visibleNotifications(
  app: App,
  user: AuthUser,
  options: { unreadOnly?: boolean } = {},
) {
  const muted = mutedNotificationKinds(app, user);
  const ability = createAppAbility(user.permissions);
  return app.notifications.list(options).filter((notification) => {
    if (muted.has(notification.kind)) return false;
    const subjects = notificationSubjects(notification.kind);
    if (subjects && !subjects.some((subject) => ability.can("read", subject))) return false;
    if (!notification.taskRunId) return true;
    const run = app.sink.getRun(notification.taskRunId);
    if (!run) return true;
    return canAccessTask(app, run.taskId, user);
  });
}

function notificationSubjects(kind: string): readonly AppSubject[] | null {
  if (kind === "task-success") return ["Loop"];
  if (
    kind === "fix-jira-issue" ||
    kind === "jira-ticket-to-mr-one" ||
    kind === "review-ticket-description"
  ) {
    return ["Ticket"];
  }
  if (kind === "gitlab-review-requested" || kind === "gitlab-resolve-conflicts-one") {
    return ["PullRequest"];
  }
  if (kind === "write-regression-test" || kind === "deploy-watch") {
    return ["LogRocket", "Datadog"];
  }
  if (kind === "triage-datadog-error") return ["Datadog"];
  if (kind === "triage-automation-failure") return ["Automation"];
  if (kind === "release-pipeline-watch") return ["Release"];
  return null;
}

/**
 * GET/PUT /api/me/notification-subscriptions — which kinds reach this developer's
 * bell.
 *
 * The catalog is `NOTIFICATION_KINDS`, not the distinct kinds in the table: see
 * that constant for why a screen of toggles cannot be derived from a week's worth
 * of rows.
 *
 * The PUT takes a set of kinds rather than one, because the screen behind it is a
 * form with a Save button: one request for what the reader decided, rather than
 * five that can fail on the third and leave a state nobody chose. Kinds the body
 * omits keep whatever they had. It answers with the whole list so the client can
 * write it straight into the cache entry it is showing.
 */
async function routeMyNotificationSubscriptions(
  request: Request,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method === "GET") {
    return json(notificationSubscriptionsView(app, user));
  }

  if (request.method === "PUT") {
    const body = (await jsonBody(request)) as Record<string, unknown>;
    if (!Array.isArray(body.subscriptions)) {
      throw new ConfigError("'subscriptions' must be an array.");
    }

    const muted = mutedNotificationKinds(app, user);
    // Validated in full before anything is written: a body with one bad kind in it
    // should change nothing rather than apply the rows that came before it.
    const patches = body.subscriptions.map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const kind = typeof row.kind === "string" ? row.kind.trim() : "";
      if (!kind) throw new ConfigError("Every subscription needs a 'kind'.");
      if (!NOTIFICATION_KINDS.some((known) => known.id === kind)) {
        throw new ValidationError(`'${kind}' is not a notification kind.`);
      }
      if (typeof row.subscribed !== "boolean") {
        throw new ConfigError(`'subscribed' must be true or false for '${kind}'.`);
      }
      return { kind, subscribed: row.subscribed };
    });

    for (const patch of patches) {
      if (patch.subscribed) muted.delete(patch.kind);
      else muted.add(patch.kind);
    }
    // Cleared rather than stored empty, so an account that turns everything back
    // on leaves no row behind — same rule as every other preference.
    if (muted.size === 0) app.preferences.clear(user.id, MUTED_KINDS_PREFERENCE);
    else app.preferences.set(user.id, MUTED_KINDS_PREFERENCE, JSON.stringify([...muted]));

    return json(notificationSubscriptionsView(app, user));
  }

  return methodNotAllowed(request.method);
}

function notificationSubscriptionsView(
  app: App,
  user: AuthUser,
): ApiContract.NotificationSubscriptionsView {
  const muted = mutedNotificationKinds(app, user);
  return {
    subscriptions: NOTIFICATION_KINDS.map((kind) => ({
      kind: kind.id,
      label: kind.label,
      description: kind.description,
      subscribed: !muted.has(kind.id),
    })),
  };
}

/**
 * GET/PUT/DELETE /api/me/profile — the signed-in developer's own account.
 *
 * Always their own, never an id from the request, for the reason
 * `routeMyPreferences` gives — and here it matters rather more, since the DELETE
 * ends an account.
 */
async function routeMyProfile(request: Request, app: App, user: AuthUser): Promise<Response> {
  if (request.method === "GET") {
    return json(profileView(app, user.id));
  }

  if (request.method === "PUT") {
    const body = (await jsonBody(request)) as Record<string, unknown>;
    if (typeof body.name !== "string") throw new ConfigError("'name' is required.");
    try {
      app.auth.rename(user.id, body.name);
    } catch (err) {
      if (err instanceof RegistrationError) throw new ValidationError(err.message);
      throw err;
    }
    return json(profileView(app, user.id));
  }

  if (request.method === "DELETE") {
    return routeDeleteMyAccount(request, app, user);
  }

  return methodNotAllowed(request.method);
}

function profileView(app: App, userId: string): ApiContract.ProfileView {
  const profile = app.auth.profile(userId);
  // A live session whose account is gone: `userFor` resolves through the same
  // lookup, so reaching here means it vanished between the two reads.
  if (!profile) throw new ValidationError("This account no longer exists.");
  return {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    ...(profile.createdAt ? { createdAt: profile.createdAt.toISOString() } : {}),
    builtIn: profile.builtIn,
  };
}

/**
 * DELETE /api/me/profile — close your own account.
 *
 * Password re-entry first: this is the one console action with no undo, and a
 * session cookie is not enough on its own for an unattended laptop to end
 * somebody's account.
 *
 * The loops go before the account does, and through the task service rather than a
 * DELETE: an instance is registered with the scheduler as well as stored, so
 * dropping the row alone would leave a loop ticking for an owner who no longer
 * exists. Only *private* ones — a public loop is the team's, and its rows carry no
 * secret of the departing developer's (a run resolves credentials from the actor at
 * run time), so deleting it would take work away from people still here. Those are
 * left owned by the missing id, which reads as an unowned team loop.
 */
async function routeDeleteMyAccount(
  request: Request,
  app: App,
  user: AuthUser,
): Promise<Response> {
  const body = (await jsonBody(request)) as Record<string, unknown>;
  if (typeof body.password !== "string" || body.password.length === 0) {
    throw new ConfigError("'password' is required.");
  }
  if (!(await app.auth.verifyPassword(user.id, body.password))) {
    return json({ error: "That password is not correct." }, 403);
  }

  const owned = app.instances
    .all()
    .filter((instance) => instance.ownerId === user.id && instance.visibility === "private");
  // Refused rather than half-done: a loop mid-run holds a container and a lease,
  // and deleting the account under it would leave the run with no actor to resolve
  // credentials for.
  const running = owned.find((instance) => app.sink.lastRun(instance.id)?.status === "running");
  if (running) {
    return json(
      {
        error:
          `Your loop '${running.name}' is running. Cancel the run before deleting your account.`,
      },
      409,
    );
  }

  for (const instance of owned) await app.tasks.deleteInstance(instance.id);

  try {
    app.auth.deleteAccount(user.id);
  } catch (err) {
    if (err instanceof RegistrationError) throw new ValidationError(err.message);
    throw err;
  }

  return json(
    { deleted: true, deletedLoops: owned.map((instance) => instance.id) } satisfies
      ApiContract.AccountDeletedView,
    200,
    // The session rows are gone with the account; clearing the cookie is what
    // stops the browser sending a token that now resolves to nobody.
    { "set-cookie": app.auth.logout(request) },
  );
}

/**
 * POST /api/graph/ticket-action — run one of a ticket node's actions.
 *
 * The request names the issue and action, plus either a branch override for a
 * fix/plan or a linked MR for E2E. Repository targets are server-authorised:
 * fix/plan use the developer's saved project, while E2E re-reads the selected MR
 * with that developer's token and verifies its Jira link before queueing.
 */
async function routeTicketAction(
  request: Request,
  app: App,
  user: AuthUser,
  /** Fixed by the route rather than read from the body, for the older path. */
  forced?: TicketActionId,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (cause) {
    throw new ConfigError("Request body is not valid JSON.", { cause });
  }
  const fields = body as Record<string, unknown> | null;
  const issueKey = typeof fields?.issueKey === "string" ? fields.issueKey.trim() : "";
  if (!issueKey) throw new ConfigError("'issueKey' is required.");

  const action = forced ?? fields?.action;
  if (!TICKET_ACTION_IDS.includes(action as TicketActionId)) {
    throw new ConfigError(
      `'action' must be one of ${TICKET_ACTION_IDS.map((id) => `'${id}'`).join(", ")}.`,
    );
  }

  let targetBranch: string | undefined;
  if (fields?.targetBranch !== undefined) {
    if (action !== "fix-issue" && action !== "plan-issue") {
      throw new ConfigError(
        "'targetBranch' is only valid for the 'fix-issue' and 'plan-issue' actions.",
      );
    }
    targetBranch =
      typeof fields.targetBranch === "string" ? fields.targetBranch.trim() : "";
    if (!targetBranch) throw new ConfigError("'targetBranch' must be a non-empty string.");
  }

  let pullRequest: { projectId: string; mrIid: number } | undefined;
  if (fields?.pullRequest !== undefined) {
    if (action !== "e2e-test") {
      throw new ConfigError("'pullRequest' is only valid for the 'e2e-test' action.");
    }
    const selected = fields.pullRequest as Record<string, unknown> | null;
    const projectId = typeof selected?.projectId === "string"
      ? selected.projectId.trim()
      : "";
    const mrIid = selected?.mrIid;
    if (!projectId || typeof mrIid !== "number" || !Number.isInteger(mrIid) || mrIid < 1) {
      throw new ConfigError(
        "'pullRequest' must contain a non-empty projectId and a positive integer mrIid.",
      );
    }
    const detail = await app.pullRequests.detail(
      user,
      pullRequestId({ provider: "gitlab", repository: projectId, number: mrIid }),
      { signal: request.signal },
    );
    if (detail.issue?.key.toUpperCase() !== issueKey.toUpperCase()) {
      throw new ConfigError(`${projectId}!${mrIid} is not linked to ${issueKey}.`);
    }
    if (detail.state === "closed") {
      throw new ConfigError(`${projectId}!${mrIid} is closed.`);
    }
    pullRequest = { projectId, mrIid };
  } else if (action === "e2e-test") {
    throw new ConfigError("'pullRequest' is required for the 'e2e-test' action.");
  }

  app.refresh();
  const result = enqueueTicketAction(app, user, action as TicketActionId, issueKey, {
    targetBranch,
    pullRequest,
  });
  // 200 rather than 409 for a refusal, same as `routeMrAction`: "already running"
  // and "set a default project first" are things to tell somebody, not errors the
  // client should throw away in favour of a status code.
  return json(result satisfies ApiContract.MrActionResult, result.queued ? 202 : 200);
}

/** Turns one completed exploratory E2E result into a queued Playwright-test MR. */
async function routeE2eTestMr(
  request: Request,
  app: App,
  user: AuthUser,
): Promise<Response> {
  const body = await jsonBody(request) as Record<string, unknown> | null;
  const sourceJobId = typeof body?.sourceJobId === "string" ? body.sourceJobId.trim() : "";
  if (!sourceJobId) throw new ConfigError("'sourceJobId' is required.");
  const targetBranch = typeof body?.targetBranch === "string" ? body.targetBranch.trim() : "";
  if (!targetBranch) throw new ConfigError("'targetBranch' is required.");

  const sourceJob = app.jobs.get(sourceJobId);
  if (
    !sourceJob ||
    sourceJob.kind !== "e2e-test" ||
    sourceJob.status !== "done" ||
    !sourceJob.executionId
  ) {
    throw new ConfigError(`E2E source job '${sourceJobId}' is not completed.`);
  }
  const params = sourceJob.params as {
    jira?: { issueKey?: unknown };
    gitlab?: { projectId?: unknown; mrIid?: unknown };
  };
  const issueKey = typeof params.jira?.issueKey === "string"
    ? params.jira.issueKey.trim()
    : "";
  const projectId = typeof params.gitlab?.projectId === "string"
    ? params.gitlab.projectId.trim()
    : "";
  const mrIid = params.gitlab?.mrIid;
  if (!issueKey || projectId !== e2eTestProject() || typeof mrIid !== "number") {
    throw new ConfigError(`Only completed ${e2eTestProject()} E2E runs can be exported.`);
  }
  const sourceRun = app.sink.getRun(sourceJob.executionId);
  const parsed = E2eAgentResultSchema.safeParse(sourceRun?.details);
  if (
    !parsed.success ||
    !parsed.data.scenarios.some(
      (scenario) => scenario.outcome !== "blocked" && scenario.automation,
    )
  ) {
    throw new ConfigError("The E2E run has no conclusive scenarios with automation steps.");
  }

  const detail = await app.pullRequests.detail(
    user,
    pullRequestId({ provider: "gitlab", repository: projectId, number: mrIid }),
    { signal: request.signal },
  );
  if (detail.issue?.key.toUpperCase() !== issueKey.toUpperCase()) {
    throw new ConfigError(`${projectId}!${mrIid} is not linked to ${issueKey}.`);
  }
  if (targetBranch !== "develop" && targetBranch !== detail.sourceBranch) {
    throw new ConfigError(
      `'targetBranch' must be 'develop' or the tested source branch '${detail.sourceBranch}'.`,
    );
  }
  app.refresh();
  const result = enqueueE2eTestMr(app, user, issueKey, sourceJobId, targetBranch);
  return json(result satisfies ApiContract.MrActionResult, result.queued ? 202 : 200);
}

/**
 * A Jira key out of a URL path segment, validated.
 *
 * Validated against Jira's own key shape before it goes anywhere, because this is a
 * path segment interpolated into an outbound URL and `PROJ-12/../` has no business
 * being one.
 */
function jiraKeyFromPath(segment: string): string {
  const key = decodeURIComponent(segment).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
    throw new ValidationError(`'${key}' is not a Jira issue key.`);
  }
  return key;
}

async function enrichTrackedJiraIssues(
  request: Request,
  app: App,
  user: AuthUser,
  page: ApiContract.TaskIssuePage,
): Promise<ApiContract.TaskIssuePage> {
  const issueKeys = [
    ...new Set(
      page.issues
        .map((issue) => issue.issueKey)
        .filter((key) => /^[A-Z][A-Z0-9_]*-\d+$/.test(key)),
    ),
  ];
  if (issueKeys.length === 0) return page;

  try {
    const jira = app.sharedJira();
    const issues = await cached(
      app.responseCache,
      {
        resource: "tracked-jira-issues",
        scope: { userId: user.id },
        params: issueKeys,
        ttlMs: CACHE_TTL.jiraIssues,
      },
      () =>
        jira.searchIssues(
          `key in (${issueKeys.map((key) => `"${key}"`).join(", ")})`,
          {
            limit: issueKeys.length,
            fields: ["assignee"],
            signal: request.signal,
          },
        ),
    );
    const assignees = new Map(
      issues.flatMap((issue) => {
        const person = issue.fields?.assignee;
        const name =
          person?.displayName?.trim() ||
          person?.emailAddress?.trim() ||
          person?.accountId?.trim();
        if (!person || !name) return [];
        return [[
          issue.key,
          {
            name,
            ...(person.accountId ? { accountId: person.accountId } : {}),
            ...(person.emailAddress ? { email: person.emailAddress } : {}),
            ...(person.avatarUrls?.["24x24"]
              ? { avatarUrl: person.avatarUrls["24x24"] }
              : {}),
          } satisfies ApiContract.TicketPersonView,
        ] as const];
      }),
    );

    return {
      ...page,
      issues: page.issues.map((issue) => ({
        ...issue,
        issueUrl: issue.issueUrl ?? jira.issueUrl(issue.issueKey),
        ...(assignees.get(issue.issueKey)
          ? { assignee: assignees.get(issue.issueKey)! }
          : {}),
      })),
    };
  } catch (err) {
    // Tracking remains useful without a live Jira read; the next page refresh
    // retries after the short response cache window.
    app.logger.warn(
      { issueKeys, err: describeError(err) },
      "could not enrich tracked Jira issues with assignees",
    );
    return page;
  }
}

interface RecordedRunJiraOutcome {
  action: string;
  issueKey: string;
  file: string;
  assignee?: string;
}

/** Reads both current structured outcomes and the string-only format in old runs. */
function jiraOutcomesFromDetails(
  details: Record<string, unknown> | undefined,
): RecordedRunJiraOutcome[] {
  if (Array.isArray(details?.ticketOutcomes)) {
    return details.ticketOutcomes.flatMap((entry) => {
      if (entry == null || typeof entry !== "object") return [];
      const outcome = entry as Record<string, unknown>;
      if (
        typeof outcome.action !== "string" ||
        typeof outcome.issueKey !== "string" ||
        typeof outcome.file !== "string" ||
        !/^[A-Z][A-Z0-9_]*-\d+$/.test(outcome.issueKey)
      ) {
        return [];
      }
      return [{
        action: outcome.action,
        issueKey: outcome.issueKey,
        file: outcome.file,
        ...(typeof outcome.assignee === "string" ? { assignee: outcome.assignee } : {}),
      }];
    });
  }

  if (!Array.isArray(details?.issues)) return [];
  return details.issues.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const match = entry.match(/^(\S+)\s+([A-Z][A-Z0-9_]*-\d+)\s+(.*)$/);
    if (!match) return [];
    const [, action, issueKey, file] = match;
    return [{ action, issueKey, file } as RecordedRunJiraOutcome];
  });
}

/**
 * POST /api/plans/:id/decision — the human's decision on one plan.
 *
 * `202` when a fix was queued, `200` with a reason otherwise: a rejection is a
 * successful decision that queues nothing, and "somebody else already approved this"
 * is a sentence to show rather than a status code the client has to translate. Same
 * stance as `routeTicketAction`.
 */
async function routePlanDecision(
  request: Request,
  app: App,
  user: AuthUser,
  planId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (cause) {
    throw new ConfigError("Request body is not valid JSON.", { cause });
  }
  const fields = body as Record<string, unknown> | null;
  const decision = fields?.decision;
  if (decision !== "approve" && decision !== "reject") {
    throw new ConfigError("'decision' must be 'approve' or 'reject'.");
  }
  if (fields?.body !== undefined && typeof fields.body !== "string") {
    throw new ConfigError("'body' must be a string.");
  }
  if (fields?.note !== undefined && typeof fields.note !== "string") {
    throw new ConfigError("'note' must be a string.");
  }

  app.refresh();
  const result = await decidePlan(app, user, planId, {
    decision,
    ...(typeof fields?.body === "string" ? { body: fields.body } : {}),
    ...(typeof fields?.note === "string" ? { note: fields.note } : {}),
  });
  return json(result satisfies ApiContract.MrActionResult, result.queued ? 202 : 200);
}

/**
 * POST /api/graph/ticket-status — moves a ticket dragged to a new board column.
 *
 * A direct Jira transition rather than a queued job, unlike `routeTicketAction`:
 * there is no agent work here, just a write with the developer's own token, and
 * the board wants the answer before its own optimistic reorder can be trusted.
 */
async function routeTicketStatus(request: Request, app: App, user: AuthUser): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (cause) {
    throw new ConfigError("Request body is not valid JSON.", { cause });
  }
  const fields = body as Record<string, unknown> | null;
  const issueKey = typeof fields?.issueKey === "string" ? fields.issueKey.trim() : "";
  if (!issueKey) throw new ConfigError("'issueKey' is required.");
  const status = typeof fields?.status === "string" ? fields.status.trim() : "";
  if (!status) throw new ConfigError("'status' is required.");
  const statusIds = Array.isArray(fields?.statusIds)
    ? fields.statusIds.filter((value): value is string => typeof value === "string")
    : [];

  const result = await app.ticketDetails.setStatus(user, issueKey, status, statusIds);
  return json(result satisfies ApiContract.TicketStatusChangeResult, result.ok ? 200 : 409);
}

/**
 * GET /api/releases — every environment's service versions from the manifest.
 *
 * A `ConfigError` (releases unset, or the asking developer has no GitLab token)
 * comes back as a 200 with `configured:false`/`error` rather than a failure, so
 * the page can guide setup instead of showing a red box — the same stance the
 * pull requests page takes towards a missing credential.
 */
async function routeReleases(request: Request, app: App, user: AuthUser): Promise<Response> {
  // Instance-wide, so it is the same answer on every path below, including the
  // ones that could not read the manifest at all.
  const slack = toReleaseSlackState(app.secrets);
  try {
    // The manifest read, not the view: `toReleasesView` is pure, and the failure
    // paths below have to stay outside the cache — a `ConfigError` means nothing
    // was read, and caching "not configured" for two minutes would outlive the
    // save that configured it.
    //
    // Per user despite being instance-wide data, because it is read with the
    // caller's own GitLab token: two developers with different access to the
    // releases repo must not share an answer.
    const source = await cached(
      app.responseCache,
      {
        resource: "releases",
        scope: { userId: user.id },
        params: [],
        ttlMs: CACHE_TTL.releases,
      },
      () => app.releases.read(user),
      { bypass: wantsFreshData(request) },
    );
    return json(toReleasesView(source, slack));
  } catch (err) {
    if (err instanceof ConfigError) {
      return json({
        configured: false,
        setupRequired: app.releaseConfig.get() ? "gitlab-access" : "release-config",
        environments: [],
        error: err.message,
        ...slack,
      } satisfies ApiContract.ReleasesView);
    }
    // A parse or forge failure with releases configured: still not fatal to the
    // page, which shows the message and the (known) repo details.
    if (err instanceof ValidationError) {
      const config = app.releaseConfig.get();
      return json({
        configured: config != null,
        ...(config
          ? {
              projectId: config.projectId,
              manifestPath: config.manifestPath,
              targetBranch: config.targetBranch,
            }
          : {}),
        environments: [],
        error: err.message,
        ...slack,
      });
    }
    throw err;
  }
}

/** GET /api/releases/confluence — release links, or one selected page's details. */
async function routeConfluenceReleases(
  request: Request,
  url: URL,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request.method);
  const indexUrl = confluenceReleasesPage();
  if (!indexUrl) {
    throw new ConfigError(
      "Set TALOS_CONFLUENCE_RELEASES_PAGE to the Confluence page that lists releases.",
    );
  }
  const bypass = wantsFreshData(request);
  const options = await confluenceReleaseOptions(app, user, bypass);
  const pageId = url.searchParams.get("pageId")?.trim();

  if (!pageId) {
    return privateJson({
      pageUrl: indexUrl,
      releases: options,
    } satisfies ApiContract.ConfluenceReleasesView);
  }
  if (!/^\d+$/.test(pageId)) {
    throw new ConfigError("'pageId' must be a numeric Confluence page id.");
  }
  const option = options.find((release) => release.pageId === pageId);
  if (!option) {
    throw new ConfigError("That Confluence page is not listed under Confluence releases.");
  }

  const jira = app.jiraFor(user);
  const pageUrl = `${jira.siteUrl}/wiki/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
  const release = await cached(
    app.responseCache,
    {
      resource: "confluence-release-detail",
      scope: { userId: user.id },
      params: [pageId],
      ttlMs: CACHE_TTL.releases,
    },
    async () => {
      const page = await jira.confluencePage(pageUrl);
      if (!page) {
        throw new ValidationError(`The Confluence release page '${option.title}' could not be read.`);
      }
      const suggestions = parseConfluenceReleaseSuggestions(page.body);
      return { title: option.title, suggestions };
    },
    { bypass },
  );

  return privateJson({
    pageUrl,
    release,
  } satisfies ApiContract.ConfluenceReleaseDetailView);
}

async function confluenceReleaseOptions(
  app: App,
  user: AuthUser,
  bypass: boolean,
): Promise<ApiContract.ConfluenceReleaseOptionView[]> {
  return cached(
    app.responseCache,
    {
      resource: "confluence-release-options",
      scope: { userId: user.id },
      params: [confluenceReleasesPage()],
      ttlMs: CACHE_TTL.releases,
    },
    async () => {
      const jira = app.jiraFor(user);
      const [index, children] = await Promise.all([
        jira.confluencePage(confluenceReleasesPage()),
        jira.confluenceChildPages(confluenceReleasesPage()),
      ]);
      if (!index || !children) {
        throw new ValidationError("The Confluence releases Confluence page could not be read.");
      }

      const releases = new Map<string, ApiContract.ConfluenceReleaseOptionView>();
      for (const link of parseConfluenceReleaseLinks(index.body)) {
        const pageId = confluencePageId(link.url, jira.siteUrl);
        if (!pageId || pageId === index.id) continue;
        releases.set(pageId, { pageId, title: link.title });
      }
      // A Confluence child-pages macro does not expand its links into ADF. The
      // children endpoint is therefore authoritative and also supplies titles
      // for Smart Links whose ADF contains only a URL.
      for (const page of children) {
        const existing = releases.get(page.id);
        releases.set(page.id, {
          pageId: page.id,
          title: page.title || existing?.title || page.id,
        });
      }
      if (releases.size === 0) {
        throw new ValidationError(
          "The Confluence releases page has no linked or child release pages.",
        );
      }
      // Confluence lists the release pages oldest first; the picker is used for
      // the next deployment, so reverse that order to put the newest at the top.
      return [...releases.values()].reverse();
    },
    { bypass },
  );
}

/**
 * GET /api/releases/history — past deployments, read from the releases repo's
 * commit history. `?environment=` narrows the window to one environment (and
 * lets GitLab do the narrowing), `?since=` sets the oldest commit instant, and
 * `?limit=` caps how many commits to inspect.
 *
 * Same soft-failure stance as `routeReleases`: an unset config or a missing
 * GitLab token is a setup gap the page explains, not a status code.
 */
async function routeReleaseHistory(
  request: Request,
  url: URL,
  app: App,
  user: AuthUser,
): Promise<Response> {
  const environment = (url.searchParams.get("environment") ?? "").trim();
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit == null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new ConfigError("'limit' must be a positive integer.");
  }
  const rawSince = (url.searchParams.get("since") ?? "").trim();
  const since = rawSince ? new Date(rawSince) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    throw new ConfigError("'since' must be a valid ISO 8601 timestamp.");
  }

  try {
    const source = await cached(
      app.responseCache,
      {
        resource: "release-history",
        // Per user for the same reason as the manifest read: it is the caller's
        // own GitLab token that decides what this repo shows them.
        scope: { userId: user.id },
        params: [environment, limit ?? 0, since?.toISOString() ?? ""],
        ttlMs: CACHE_TTL.releaseHistory,
      },
      () =>
        app.releases.history(user, {
          ...(environment ? { environment } : {}),
          ...(since ? { since } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      { bypass: wantsFreshData(request) },
    );
    return json(toReleaseHistoryView(source));
  } catch (err) {
    if (err instanceof ConfigError || err instanceof ValidationError) {
      const config = app.releaseConfig.get();
      return json({
        configured: err instanceof ValidationError && config != null,
        ...(config ? { projectId: config.projectId, targetBranch: config.targetBranch } : {}),
        entries: [],
        environments: [],
        commitsScanned: 0,
        error: err.message,
      } satisfies ApiContract.ReleaseHistoryView);
    }
    throw err;
  }
}

/**
 * POST /api/releases/deployment-status — a read-only live Kubernetes query.
 *
 * The request repeats the manifest versions already visible to the caller so a
 * frequent status poll never re-reads GitLab and never touches release-watch
 * persistence. Changed services with an active release-MR watcher are held in
 * `pending` without querying Kubernetes; checking the target-branch version
 * before that MR merges would only prove that the previous release is live.
 */
async function routeReleaseDeploymentStatus(
  request: Request,
  app: App,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);
  const body = (await readJsonBody(request)) as Record<string, unknown> | null;
  const environments = body?.environments;
  if (!Array.isArray(environments) || environments.length > 50) {
    throw new ConfigError("'environments' must be an array with at most 50 entries.");
  }

  const parsed = environments.map((value) => {
    const environment = value as Record<string, unknown> | null;
    const name = typeof environment?.name === "string" ? environment.name.trim() : "";
    const services = environment?.services;
    if (!name || !Array.isArray(services) || services.length > 200) {
      throw new ConfigError(
        "Each environment requires a name and at most 200 services.",
      );
    }
    const targets = services.map((value) => {
      const service = value as Record<string, unknown> | null;
      const serviceName = typeof service?.name === "string" ? service.name.trim() : "";
      const version = typeof service?.version === "string" ? service.version.trim() : "";
      const image = typeof service?.image === "string" ? service.image.trim() : undefined;
      if (!serviceName || !version) {
        throw new ConfigError("Each service requires a name and version.");
      }
      return deploymentTargetFor({
        name: serviceName,
        version,
        ...(image ? { image } : {}),
        section: service?.section === "applications" ? "applications" : "services",
      });
    });
    return { name, targets };
  });

  const projectId = app.releaseConfig.get()?.projectId;
  const pendingByEnvironment = new Map<
    string,
    { allServices: boolean; services: Set<string> }
  >();
  for (const job of app.jobs.activeForKind(RELEASE_PIPELINE_WATCH_TASK_ID)) {
    const params = job.params as Record<string, unknown> | null;
    if (
      !params ||
      params.projectId !== projectId ||
      typeof params.environment !== "string"
    ) {
      continue;
    }
    const serviceNames = Array.isArray(params.services)
      ? params.services.filter((value): value is string => typeof value === "string")
      : [];
    const pending = pendingByEnvironment.get(params.environment) ?? {
      allServices: false,
      services: new Set<string>(),
    };
    // Jobs queued before service-level gating was introduced did not carry the
    // changed service names. Pausing the whole environment is safer than
    // checking the old manifest and claiming that release is already live.
    if (serviceNames.length === 0) pending.allServices = true;
    for (const service of serviceNames) pending.services.add(service);
    pendingByEnvironment.set(params.environment, pending);
  }

  const results = await Promise.all(
    parsed.map(async (environment) => {
      const pending = pendingByEnvironment.get(environment.name);
      const waitingTargets = pending
        ? environment.targets.filter(
            (target) => pending.allServices || pending.services.has(target.service),
          )
        : [];
      const waitingServices = new Set(waitingTargets.map((target) => target.service));
      const verifyTargets = environment.targets.filter(
        (target) => !waitingServices.has(target.service),
      );
      const verified =
        verifyTargets.length > 0
          ? await app.deploymentVerifier.verify(
              environment.name,
              verifyTargets,
              request.signal,
            )
          : [];
      const verifiedByService = new Map(
        verified.map((status) => [status.service, status]),
      );

      return {
        name: environment.name,
        waitingForMerge: waitingTargets.length > 0,
        services: environment.targets.flatMap((target) => {
          if (waitingServices.has(target.service)) {
            return [{
              ...target,
              state: "pending" as const,
              desiredReplicas: 0,
              updatedReplicas: 0,
              readyReplicas: 0,
              availableReplicas: 0,
              podCount: 0,
              message:
                "Waiting for the release merge request to merge before checking Kubernetes.",
            }];
          }
          const status = verifiedByService.get(target.service);
          return status ? [status] : [];
        }),
      };
    }),
  );

  return privateJson({
    checkedAt: new Date().toISOString(),
    environments: results.map((environment) => ({
      name: environment.name,
      waitingForMerge: environment.waitingForMerge,
      services: environment.services.map((service) => ({
        ...service,
        observedDigest: service.observedDigest ?? null,
        message: service.message ?? null,
      })),
    })),
  } satisfies ApiContract.ReleaseDeploymentStatusView);
}

/** GET previews, and POST opens, a revert MR for one environment's latest deploy. */
async function routeReleaseRevert(
  request: Request,
  url: URL,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method === "GET") {
    const environment = (url.searchParams.get("environment") ?? "").trim();
    if (!environment) throw new ConfigError("'environment' is required.");
    const preview = await app.releases.previewRevert(user, environment, request.signal);
    return privateJson(toReleaseRevertPreviewView(preview));
  }
  if (request.method !== "POST") return methodNotAllowed(request.method);

  const body = (await readJsonBody(request)) as Record<string, unknown> | null;
  const environment = typeof body?.environment === "string" ? body.environment.trim() : "";
  const sha = typeof body?.sha === "string" ? body.sha.trim() : "";
  const notifySlack = body?.notifySlack;
  if (!environment) throw new ConfigError("'environment' is required.");
  if (!sha) throw new ConfigError("'sha' is required.");
  if (notifySlack !== undefined && typeof notifySlack !== "boolean") {
    throw new ConfigError("'notifySlack' must be a boolean.");
  }

  const result = await app.releases.revert(user, {
    environment,
    sha,
    ...(typeof notifySlack === "boolean" ? { notifySlack } : {}),
  });
  invalidateReleaseWrites(app);
  return json(result, 202);
}

/** POST /api/releases/upload — edit one environment's versions and open an MR. */
async function routeReleaseUpload(
  request: Request,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);

  let body: unknown;
  try {
    body = await request.json();
  } catch (cause) {
    throw new ConfigError("Request body is not valid JSON.", { cause });
  }
  const input = body as Record<string, unknown> | null;
  const environment = input?.environment;
  const title = input?.title;
  const description = input?.description;
  const notifySlack = input?.notifySlack;
  const rawChanges = input?.changes;

  if (typeof environment !== "string" || environment.trim() === "") {
    throw new ConfigError("'environment' is required.");
  }
  if (title !== undefined && typeof title !== "string") {
    throw new ConfigError("'title' must be a string.");
  }
  if (description !== undefined && typeof description !== "string") {
    throw new ConfigError("'description' must be a string.");
  }
  if (notifySlack !== undefined && typeof notifySlack !== "boolean") {
    throw new ConfigError("'notifySlack' must be a boolean.");
  }
  if (
    !Array.isArray(rawChanges) ||
    rawChanges.length === 0 ||
    rawChanges.some((c) => {
      const change = c as Record<string, unknown>;
      return (
        typeof change?.service !== "string" ||
        typeof change?.version !== "string" ||
        (change?.section !== "applications" && change?.section !== "services")
      );
    })
  ) {
    throw new ConfigError(
      "'changes' must be a non-empty array of { service, version, section } where section is 'applications' or 'services'.",
    );
  }

  const changes = (
    rawChanges as { service: string; version: string; section: "applications" | "services" }[]
  ).map((c) => ({
    environment,
    service: c.service,
    version: c.version,
    section: c.section,
  }));

  const result = await app.releases.upload(user, {
    environment,
    changes,
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof notifySlack === "boolean" ? { notifySlack } : {}),
  });

  invalidateReleaseWrites(app);
  return json(result, 202);
}

function invalidateReleaseWrites(app: App): void {
  // The manifest repo is shared, so a release MR makes every user's cached view
  // potentially stale, along with history and merge-request listings.
  app.responseCache.invalidate(CACHE_PREFIX.releases);
  app.responseCache.invalidate(CACHE_PREFIX.releaseHistory);
  app.responseCache.invalidate(CACHE_PREFIX.pullRequests);
}

/**
 * GET/PUT /api/settings/integrations — the instance-wide integration settings
 * that override `config/.env`.
 *
 * The instance scope of the catalog only. A per-developer identity is refused
 * below and belongs to `/api/me/credentials`; the row already stored under such a
 * name keeps working as the shared fallback, it is simply no longer editable for
 * everybody at once.
 *
 * Instance-wide, so it sits with the other `/api/settings` routes and takes no
 * user: unlike `/api/me/credentials`, editing this changes what every loop and
 * every shared-credential run uses. The GET never returns a secret value — see
 * `toIntegrationsView` — so tokens are a write-only surface, which is what keeps
 * a browser cache or a proxy log in between from ending up with one.
 */
async function routeIntegrations(request: Request, app: App): Promise<Response> {
  if (request.method === "GET") {
    return json(toIntegrationsView(app));
  }

  if (request.method === "PUT") {
    let body: unknown;
    try {
      body = await request.json();
    } catch (cause) {
      throw new ConfigError("Request body is not valid JSON.", { cause });
    }

    const overrides = (body as { overrides?: unknown } | null)?.overrides;
    if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
      throw new ConfigError("'overrides' must be an object of field name to value.");
    }

    // Validated in full before anything is written: a patch naming one unknown
    // field should be rejected outright rather than half-applied, which would
    // leave the operator guessing which half took effect.
    const entries: [string, string][] = [];
    for (const [rawName, rawValue] of Object.entries(overrides)) {
      const name = rawName.toUpperCase();
      if (!integrationField(name)) {
        throw new ConfigError(`'${rawName}' is not an integration setting.`);
      }
      // A per-developer identity is not this page's to change. Refused rather
      // than dropped from the catalog: the row already stored under this name is
      // still the shared fallback, and it keeps working — it just stops being
      // editable for everybody at once from a settings screen.
      if (!isInstanceIntegrationField(name)) {
        throw new ConfigError(
          `'${rawName}' is a per-developer credential, not an instance setting. ` +
            "Store your own under My provider access.",
        );
      }
      if (rawValue !== null && typeof rawValue !== "string") {
        throw new ConfigError(`'${rawName}' must be a string, or null to clear it.`);
      }
      entries.push([name, rawValue ?? ""]);
    }

    // An empty value clears the override — see SqliteIntegrationConfigStore.set.
    for (const [name, value] of entries) app.integrationConfig.set(name, value);

    // The scrubber was seeded at startup and has never seen a token saved a
    // moment ago. Registering it before the next log line is what stops it
    // appearing verbatim in one. The non-secret fields are filtered out on
    // purpose: replacing the Jira site URL throughout the logs would hide
    // exactly the detail that makes a failure diagnosable.
    registerSecretValues(
      Object.entries(app.integrationConfig.all())
        .filter(([name]) => isRedactedSecret(name))
        .map(([, value]) => value),
    );

    // The shared clients hold the tokens that just changed, so they are now wrong in
    // a way no TTL expires: rebuilt lazily on the next request that needs one.
    app.resetSharedClients();

    // The whole cache, not one resource — this is the one write that deserves it.
    // Every forge-derived entry in it was fetched with the credentials that just
    // changed, so each is now attributable to the wrong ones: an old token's
    // project list served after the operator repointed the instance at a different
    // GitLab looks exactly like the new settings not having been saved.
    app.responseCache.clear();

    return json(toIntegrationsView(app));
  }

  return methodNotAllowed(request.method);
}

/**
 * GET /api/logrocket/issues — the LogRocket page's list.
 *
 * Read-only, and reads no LogRocket API: the rows are the alerts delivered to
 * `/webhooks/logrocket`, because LogRocket has no endpoint that lists issues. So
 * this is a database read, and it cannot fail on a missing LogRocket token the
 * way the pull request or Jira routes can.
 */
async function routeLogRocketIssues(
  request: Request,
  url: URL,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request.method);
  return json(toLogRocketIssuesView(app, user, logRocketFilterFrom(url)));
}

/**
 * The list filter, read from the query string.
 *
 * Shared by the GET and by the state POST for a reason the client depends on: the
 * POST answers with the list, and the client writes that answer straight into the
 * cache entry it is already showing. A response describing a *different* filter
 * than the one asked for would put dismissed rows into a list that asked not to
 * have them, so the two have to read the filter the same way.
 */
function logRocketFilterFrom(url: URL): { includeDismissed: boolean } {
  return { includeDismissed: url.searchParams.get("includeDismissed") === "1" };
}

/**
 * POST /api/logrocket/issues/:id/fix — file a Jira ticket and queue the fix.
 * POST /api/logrocket/issues/:id/state — dismiss an issue, or bring it back.
 * POST /api/logrocket/issues/:id/regression-test — queue an agent to write a test.
 *
 * Nothing in the body names a repository or a project: the repo comes from the
 * caller's own fix defaults and the Jira project from instance settings, exactly
 * as in `routeFixIssue`. A hand-written POST can therefore only ever aim at what
 * the person who sent it already configured.
 */
async function routeLogRocketAction(
  request: Request,
  url: URL,
  id: string,
  action: "fix" | "state" | "regression-test",
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);

  if (action === "regression-test") {
    app.refresh();
    const result = writeLogRocketRegressionTest(app, user, id);
    return json(result, result.queued ? 202 : 200);
  }

  if (action === "state") {
    let body: unknown;
    try {
      body = await request.json();
    } catch (cause) {
      throw new ConfigError("Request body is not valid JSON.", { cause });
    }
    const state = (body as { state?: unknown } | null)?.state;
    if (state !== "open" && state !== "dismissed") {
      throw new ConfigError("'state' must be 'open' or 'dismissed'.");
    }
    if (!app.logRocketIssues.setState(id, state)) {
      throw new ConfigError(`No LogRocket issue ${id}.`);
    }
    // Answering with the list *the caller asked for*, same query string as the
    // GET: the client writes this into the cache entry it is showing, so a view
    // of some other filter would inject rows that entry said it did not want. A
    // page showing dismissed rows passes `includeDismissed=1` and still gets the
    // row back to undo; a page hiding them wanted it gone.
    return json(toLogRocketIssuesView(app, user, logRocketFilterFrom(url)));
  }

  app.refresh();
  const outcome = await fixLogRocketIssue(app, user, id);
  // 200 for a refusal rather than a 4xx, same as the other action routes: "set a
  // default project first" is something to tell somebody, not an error the client
  // should discard in favour of a status code.
  return json(toLogRocketFixResult(outcome), outcome.queued ? 202 : 200);
}

/**
 * GET /api/datadog/issues — the Datadog page's list, worst first.
 *
 * A database read, like its LogRocket counterpart and for a different reason: the
 * rows are what the daily scan clustered, and re-deriving them here would mean a
 * page load costing twenty aggregation calls against an org that writes two million
 * error logs a day. Freshness is a "Scan now" button, not a side effect of a GET.
 */
async function routeDatadogIssues(
  request: Request,
  url: URL,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request.method);
  return json(toDatadogIssuesView(app, user, datadogFilterFrom(url)));
}

/** The Datadog list filter — see `logRocketFilterFrom` for why the POST shares it. */
function datadogFilterFrom(url: URL): {
  includeDismissed: boolean;
  team?: string;
  area?: DatadogArea;
} {
  const team = url.searchParams.get("team")?.trim();
  const area = url.searchParams.get("area")?.trim();
  return {
    includeDismissed: url.searchParams.get("includeDismissed") === "1",
    ...(team ? { team } : {}),
    ...(area ? { area: area as DatadogArea } : {}),
  };
}

/**
 * POST /api/datadog/scan — run the scan now, and answer with what it found.
 *
 * Held open for the whole run rather than returning 202 with an execution id, which
 * is the opposite of `/api/tasks/:id/run`. The difference is what the caller wants:
 * a code review is watched in the run log, whereas a person pressing "Scan now" is
 * waiting for a triage list to change on screen, and the scan is bounded to about
 * twenty requests by design. The task still records its own run row, so the history
 * is identical either way.
 */
async function routeDatadogScan(
  request: Request,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);
  app.refresh();
  // 200 either way: a refusal ("no token configured") is an answer the page shows,
  // not a status code it should discard.
  return json(await scanDatadogNow(app, user));
}

/**
 * POST /api/datadog/problems/:key/fix — file a Jira ticket and queue the fix.
 * POST /api/datadog/problems/:key/state — dismiss a problem, or bring it back.
 * POST /api/datadog/problems/:key/regression-test — queue an agent to write a test.
 *
 * The unit is a problem rather than a signature because that is what the page shows
 * and what a person decides about: one root cause logged from five frames is one
 * ticket and one dismissal, not five. Both actions fan out to every member row
 * underneath, so a rescan that regroups the signatures still finds them handled.
 *
 * The repository is resolved server-side from the service mapping, falling back
 * to the caller's Pull Request defaults. A regression-test request may override
 * only the base/MR target branch shown in its confirmation dialog.
 */
async function routeDatadogAction(
  request: Request,
  url: URL,
  key: string,
  action: "fix" | "state" | "regression-test" | "ai-triage",
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);

  if (action === "regression-test") {
    app.refresh();
    const body = (await jsonBody(request)) as ApiContract.RegressionTestRequest | null;
    const targetBranch = body?.targetBranch;
    if (targetBranch != null && (typeof targetBranch !== "string" || !targetBranch.trim())) {
      throw new ConfigError("'targetBranch' must be a non-empty string when provided.");
    }
    const result = writeDatadogRegressionTest(app, user, key, targetBranch);
    return json(result, result.queued ? 202 : 200);
  }

  if (action === "ai-triage") {
    app.refresh();
    const result = triageDatadogProblem(app, user, key);
    return json(result, result.queued ? 202 : 200);
  }

  if (action === "state") {
    const body = await jsonBody(request);
    const state = (body as { state?: unknown } | null)?.state;
    if (state !== "open" && state !== "dismissed") {
      throw new ConfigError("'state' must be 'open' or 'dismissed'.");
    }
    if (setDatadogProblemState(app, key, state) === 0) {
      throw new ConfigError(`No Datadog problem ${key}.`);
    }
    // The caller's own filter, same query string as the GET — see
    // `logRocketFilterFrom`. A page showing dismissed rows keeps the one it just
    // dismissed and can undo it; a page hiding them wanted it gone.
    return json(toDatadogIssuesView(app, user, datadogFilterFrom(url)));
  }

  app.refresh();
  const outcome = await fixDatadogProblem(app, user, key);
  // 200 for a refusal rather than a 4xx, as elsewhere: "set a default project
  // first" is something to tell somebody, not an error to discard.
  return json(toDatadogFixResult(outcome), outcome.queued ? 202 : 200);
}

/**
 * GET /api/flaky-specs — the specs the CI-failure loop is holding, and why.
 *
 * A database read of what the loop already recorded, like the Datadog page: the
 * history is written a pipeline at a time by the nightly run, and there is nothing
 * to refresh here on demand. The verdicts are recomputed on read so a threshold
 * change takes effect immediately -- see `toFlakySpecsView`.
 */
async function routeFlakySpecs(
  request: Request,
  url: URL,
  app: App,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request.method);
  return json(toFlakySpecsView(app, flakySpecsFilterFrom(url)));
}

/** The spec list filter — see `logRocketFilterFrom` for why the POST shares it. */
function flakySpecsFilterFrom(url: URL): { includeDismissed: boolean; project?: string } {
  const project = url.searchParams.get("project")?.trim();
  return {
    includeDismissed: url.searchParams.get("includeDismissed") === "1",
    ...(project ? { project } : {}),
  };
}

/**
 * POST /api/flaky-specs/state — hide a spec from the page, or bring it back.
 *
 * A dismissal is about the *page*, not about the loop: history keeps being recorded
 * and a spec that turns into a real regression still files its ticket. This only
 * says "I have seen this one, stop showing it to me".
 */
async function routeFlakySpecState(request: Request, url: URL, app: App): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);
  const body = (await jsonBody(request)) as Partial<ApiContract.FlakySpecStatePatch> | null;
  const project = body?.project?.trim();
  const specFile = body?.specFile?.trim();
  const state = body?.state;
  if (!project || !specFile) {
    throw new ConfigError("'project' and 'specFile' are both required.");
  }
  if (state !== "open" && state !== "dismissed") {
    throw new ConfigError("'state' must be 'open' or 'dismissed'.");
  }

  app.testRunHistory.setState(CI_FAILURE_SOURCE, project, specFile, state);
  // The caller's own filter, project included, same query string as the GET — see
  // `logRocketFilterFrom`. This one previously ignored `?project=` as well, so a
  // project-filtered panel was handed every project's specs.
  return json(toFlakySpecsView(app, flakySpecsFilterFrom(url)));
}

/**
 * POST /api/flaky-specs/file — file a ticket for a held spec after all.
 *
 * Records the override and returns; the next run of the loop builds the ticket. See
 * `FlakySpecFileResult` for why it is not filed from here.
 */
async function routeFlakySpecFile(request: Request, app: App): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);
  const body = (await jsonBody(request)) as
    | { project?: string; specFile?: string }
    | null;
  const project = body?.project?.trim();
  const specFile = body?.specFile?.trim();
  if (!project || !specFile) {
    throw new ConfigError("'project' and 'specFile' are both required.");
  }

  const refusal = toFlakySpecsView(app).fileRefusal;
  if (refusal) {
    const result: ApiContract.FlakySpecFileResult = { accepted: false, message: refusal };
    return json(result);
  }

  app.testRunHistory.setForceFile(CI_FAILURE_SOURCE, project, specFile, true);
  const result: ApiContract.FlakySpecFileResult = {
    accepted: true,
    message:
      `${specFile} will be filed the next time the CI failure loop sees it fail, ` +
      `whatever its flake rate.`,
  };
  return json(result);
}

/**
 * GET /api/datadog/routing — the rules.
 * POST /api/datadog/routing — add one.
 *
 * These decide which team owns an issue and which services are dropped before the
 * scan even asks about them, so editing them changes what tomorrow's list contains.
 * Kept as an ordinary authenticated route rather than admin-only, matching how the
 * rest of the console treats operational settings.
 */
async function routeDatadogRouting(request: Request, app: App): Promise<Response> {
  if (request.method === "GET") return json(toDatadogRoutingView(app));
  if (request.method !== "POST") return methodNotAllowed(request.method);

  const patch = (await jsonBody(request)) as ApiContract.DatadogRoutingRulePatch | null;
  if (!patch?.facet || !patch.pattern || !patch.action) {
    throw new ConfigError("A new rule needs 'facet', 'pattern' and 'action'.");
  }
  const rule = app.datadogRouting.create({
    facet: patch.facet,
    pattern: patch.pattern,
    action: patch.action,
    ...(patch.priority != null ? { priority: patch.priority } : {}),
    ...(patch.team ? { team: patch.team } : {}),
    ...(patch.area ? { area: patch.area } : {}),
    ...(patch.jiraProject ? { jiraProject: patch.jiraProject } : {}),
    ...(patch.note ? { note: patch.note } : {}),
  });
  return json(toDatadogRoutingRuleView(rule), 201);
}

/** GET the service catalog and its mappings. */
async function routeDatadogServiceTargets(request: Request, app: App): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request.method);
  return json(toDatadogServiceTargetsView(app));
}

/** PUT/DELETE one exact service mapping. */
async function routeDatadogServiceTarget(
  request: Request,
  service: string,
  app: App,
): Promise<Response> {
  if (request.method === "DELETE") {
    if (!app.datadogServiceTargets.delete(service)) {
      throw new ConfigError(`No repository mapping exists for Datadog service '${service}'.`);
    }
    return json(toDatadogServiceTargetsView(app));
  }
  if (request.method !== "PUT") return methodNotAllowed(request.method);
  const body = (await jsonBody(request)) as ApiContract.DatadogServiceTargetPatch | null;
  if (
    typeof body?.projectId !== "string" ||
    !body.projectId.trim() ||
    typeof body.targetBranch !== "string" ||
    !body.targetBranch.trim()
  ) {
    throw new ConfigError("'projectId' and 'targetBranch' are required.");
  }
  return json(
    toDatadogServiceTargetView(
      app.datadogServiceTargets.set(service, {
        projectId: body.projectId,
        targetBranch: body.targetBranch,
      }),
    ),
  );
}

/**
 * POST /api/feedback — the footer's feedback link.
 *
 * The type is used server-side to add the title scope and labels; clients cannot
 * forge those derived fields.
 */
async function routeFeedback(request: Request, app: App, user: AuthUser): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);

  const { body, files } = await feedbackRequestBody(request);
  if (!isFeedbackType(body?.type)) throw new ConfigError("Choose a valid feedback type.");
  if (typeof body?.title !== "string" || !body.title.trim()) {
    throw new ConfigError("Feedback needs a title.");
  }
  if (typeof body.description !== "string" || !body.description.trim()) {
    throw new ConfigError("Feedback needs a description.");
  }
  const attachments = await Promise.all(
    files.map(async (file, index) => {
      const { name, contentType } = feedbackImageDetails(file, index);
      return {
        name,
        contentType,
        bytes: new Uint8Array(await file.arrayBuffer()),
      };
    }),
  );
  const feedback = app.feedback.create(user.id, {
    type: body.type,
    title: body.title,
    description: body.description,
    ...(attachments.length > 0 ? { attachments } : {}),
  });
  const published = await publishFeedback(app, user, feedback, request.signal);
  return json(toFeedbackView(published), published.publicationStatus === "published" ? 201 : 202);
}

async function routePendingFeedback(
  request: Request,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request.method);
  return json({
    feedback: app.feedback.pendingForUser(user.id).map((entry) => ({
      ...toFeedbackView(entry),
      type: entry.type,
      title: entry.title,
      attachmentCount: app.feedback.attachments(entry.id).length,
    })),
  } satisfies ApiContract.PendingFeedbackView);
}

async function routeFeedbackPublish(
  request: Request,
  app: App,
  user: AuthUser,
  id: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);
  const feedback = app.feedback.get(id);
  if (!feedback || feedback.userId !== user.id) {
    return notFound(`No pending feedback '${id}'.`);
  }
  if (feedback.publicationStatus === "published") {
    return json(toFeedbackView(feedback));
  }
  const published = await publishFeedback(app, user, feedback, request.signal);
  return json(toFeedbackView(published), published.publicationStatus === "published" ? 200 : 202);
}

async function publishFeedback(
  app: App,
  user: AuthUser,
  feedback: Feedback,
  signal: AbortSignal,
): Promise<Feedback> {
  try {
    const attachments = app.feedback.attachments(feedback.id);
    const issue = await app.feedbackIssuesFor(user).createIssue({
      idempotencyKey: feedback.id,
      title: feedback.title,
      body: feedback.description,
      bodySuffix: `---\nSubmitted through Automesh by ${user.name}.`,
      labels: feedback.labels,
      ...(attachments.length > 0 ? { attachments } : {}),
      signal,
    });
    app.feedback.linkExternalIssue(feedback.id, issue);
  } catch (error) {
    // A caller abort means shutdown/navigation, not a publication verdict. The
    // durable row remains pending and the next explicit retry reconciles by id.
    if (signal.aborted) throw error;
    const reason = feedbackPublicationReason(error);
    if (!reason) throw error;
    app.feedback.markPublicationPending(feedback.id, reason);
  }
  return app.feedback.get(feedback.id)!;
}

function feedbackPublicationReason(error: unknown): FeedbackPublicationReason | undefined {
  if (error instanceof ConfigError) return "missing_token";
  if (error instanceof AuthenticationError) return "invalid_token";
  if (error instanceof PermissionError) return "insufficient_access";
  if (error instanceof ConnectorError) {
    // GitLab intentionally returns 404 for a private project the token cannot
    // see, so it is an access result here rather than a missing Talos route.
    if (error.status === 404) return "insufficient_access";
    return "temporary_failure";
  }
  return undefined;
}

async function feedbackRequestBody(request: Request): Promise<{
  body: ApiContract.FeedbackRequest | null;
  files: File[];
}> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
    return {
      body: (await jsonBody(request)) as ApiContract.FeedbackRequest | null,
      files: [],
    };
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_FEEDBACK_UPLOAD_BYTES + 1024 * 1024) {
    throw new ConfigError("Feedback image uploads are too large.");
  }
  const form = await request.formData().catch((cause) => {
    throw new ConfigError("Feedback with images must be multipart form data.", { cause });
  });
  const type = form.get("type");
  const title = form.get("title");
  const description = form.get("description");
  if (
    (type !== null && typeof type !== "string") ||
    (title !== null && typeof title !== "string") ||
    (description !== null && typeof description !== "string")
  ) {
    throw new ConfigError("Feedback fields must be text.");
  }
  const values = form.getAll("attachments");
  if (values.length > MAX_FEEDBACK_IMAGES) {
    throw new ConfigError(`Attach at most ${MAX_FEEDBACK_IMAGES} images.`);
  }
  if (values.some((value) => typeof value === "string")) {
    throw new ConfigError("Feedback attachments must be image files.");
  }
  const files = values as File[];
  if (files.reduce((total, file) => total + file.size, 0) > MAX_FEEDBACK_UPLOAD_BYTES) {
    throw new ConfigError("Feedback image uploads are too large.");
  }
  return {
    body: {
      type: type as ApiContract.FeedbackType,
      title: title ?? "",
      description: description ?? "",
    },
    files,
  };
}

function feedbackImageDetails(file: File, index: number): {
  name: string;
  contentType: string;
} {
  if (file.size === 0) throw new ConfigError(`Image '${file.name}' is empty.`);
  if (file.size > MAX_FEEDBACK_IMAGE_BYTES) {
    throw new ConfigError(`Image '${file.name}' must be at most 10 MB.`);
  }

  let name = file.name
    .trim()
    .replace(/[\\/\u0000-\u001f\u007f]/g, "-")
    .slice(0, 200);
  const extension = name.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  let contentType = extension ? FEEDBACK_IMAGE_TYPES.get(extension) : undefined;
  if (!contentType && !extension) {
    const fallback = [...FEEDBACK_IMAGE_TYPES.entries()].find(([, type]) => type === file.type);
    if (fallback) {
      name = `${name || `clipboard-image-${index + 1}`}${fallback[0]}`;
      contentType = fallback[1];
    }
  }
  if (!contentType) {
    throw new ConfigError(
      `Image '${file.name}' is not supported. Use PNG, JPEG, GIF, WebP, or SVG.`,
    );
  }
  return { name, contentType };
}

function isFeedbackType(value: unknown): value is ApiContract.FeedbackType {
  return value === "bug" || value === "feature" || value === "general" || value === "security";
}

/**
 * PATCH /api/datadog/routing/:id — edit a rule.
 * DELETE /api/datadog/routing/:id — remove one.
 *
 * A `null` field clears it; an absent field is left alone. The store makes that
 * distinction, and it is the only way a team can be removed from a rule once set.
 */
async function routeDatadogRule(
  request: Request,
  id: string,
  app: App,
): Promise<Response> {
  if (request.method === "DELETE") {
    if (!app.datadogRouting.delete(id)) {
      throw new ConfigError(`No Datadog routing rule ${id}.`);
    }
    return json(toDatadogRoutingView(app));
  }
  if (request.method !== "PATCH" && request.method !== "POST") {
    return methodNotAllowed(request.method);
  }

  const patch = (await jsonBody(request)) as ApiContract.DatadogRoutingRulePatch | null;
  // Passed through as-is rather than rebuilt field by field: the store tells an
  // absent key from a `null` one, and reconstructing the object here would lose it.
  const updated = app.datadogRouting.update(id, patch ?? {});
  if (!updated) throw new ConfigError(`No Datadog routing rule ${id}.`);
  return json(toDatadogRoutingRuleView(updated));
}

/** GET/PUT /api/releases/config — the instance-wide releases repo settings. */
async function routeReleaseConfig(request: Request, app: App): Promise<Response> {
  if (request.method === "GET") {
    return json(toReleaseConfigView(app.releaseConfig.get()));
  }

  if (request.method === "PUT") {
    let body: unknown;
    try {
      body = await request.json();
    } catch (cause) {
      throw new ConfigError("Request body is not valid JSON.", { cause });
    }
    const input = body as Record<string, unknown> | null;
    const projectId = input?.projectId;
    const manifestPath = input?.manifestPath;
    const targetBranch = input?.targetBranch;
    if (
      typeof projectId !== "string" ||
      projectId.trim() === "" ||
      typeof manifestPath !== "string" ||
      manifestPath.trim() === "" ||
      typeof targetBranch !== "string" ||
      targetBranch.trim() === ""
    ) {
      throw new ConfigError("'projectId', 'manifestPath' and 'targetBranch' are all required.");
    }
    app.releaseConfig.set({
      projectId: projectId.trim(),
      manifestPath: manifestPath.trim(),
      targetBranch: targetBranch.trim(),
    });
    return json(toReleaseConfigView(app.releaseConfig.get()));
  }

  return methodNotAllowed(request.method);
}

/**
 * POST /api/tasks/:id/cancel — abort the latest in-flight run of this task
 * and tear down leftover review containers.
 */
async function routeTaskCancel(
  request: Request,
  id: string,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);
  if (!canAccessTask(app, id, user)) return notFound(`No task '${id}'.`);
  app.taskRegistry.require(id);

  const runs = await app.cancellations.cancelTask(id);
  if (runs.length === 0) {
    return json({ error: `No running run for task '${id}'.` }, 409);
  }
  return json({ taskId: id, runs });
}

/** POST /api/task-runs/:executionId/cancel */
async function routeRunCancel(
  request: Request,
  executionId: string,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);

  const run = app.sink.getRun(executionId);
  if (run && !canAccessTask(app, run.taskId, user)) {
    return notFound(`No run '${executionId}'.`);
  }
  const result = await app.cancellations.cancelRun(executionId);
  if (!result) return notFound(`No run '${executionId}'.`);
  if (result.alreadyFinished) {
    return json(
      { error: `Run '${executionId}' already ${result.status}.`, ...result },
      409,
    );
  }
  return json(result);
}

/**
 * POST /api/jobs/:id/cancel — drop one queued job, or abort the run of a leased
 * one.
 *
 * Separate from `/api/task-runs/:id/cancel` because a queued job has no run to
 * cancel: aborting the run of a job that has not started is a no-op, and the job
 * would be leased seconds later. This kills the queue row too, which is the only
 * thing that makes a cancel stick (see `CancellationService.cancelJob`).
 *
 * Authorised against the loop that raised the job, the same subject
 * `routeRunCancel` uses for a run. A manual action's loop is invented
 * (`fix-issue-actions`, `pull-request-actions`) and has no instance row, so it is
 * visible to every signed-in account — the same reach those buttons already have
 * on the graph, where anyone who can see the job could re-queue it anyway.
 */
async function routeJobManagement(
  request: Request,
  jobId: string,
  action: "hold" | "resume" | "priority" | "supersede",
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);
  const job = app.jobs.get(jobId);
  if (!job || !canAccessTask(app, job.loopId, user)) {
    return notFound(`No job '${jobId}'.`);
  }
  if (!createAppAbility(user.permissions).can("manage", "Task")) {
    return json({ error: "Task-management permission is required." }, 403);
  }

  const body = request.headers.get("content-type")?.includes("json")
    ? (await jsonBody(request)) as Record<string, unknown>
    : {};
  let changed = false;
  if (action === "hold") {
    if (body.reason !== undefined && typeof body.reason !== "string") {
      throw new ConfigError("'reason' must be a string.");
    }
    changed = app.jobs.hold(jobId, body.reason as string | undefined);
  } else if (action === "resume") {
    changed = app.jobs.resume(jobId);
  } else if (action === "priority") {
    if (!Number.isSafeInteger(body.priority)) {
      throw new ConfigError("'priority' must be a safe integer.");
    }
    changed = app.jobs.setPriority(jobId, body.priority as number);
  } else {
    if (typeof body.replacementJobId !== "string") {
      throw new ConfigError("'replacementJobId' is required.");
    }
    const replacement = app.jobs.get(body.replacementJobId);
    if (
      !replacement ||
      replacement.id === job.id ||
      replacement.kind !== job.kind ||
      !job.subjectKey ||
      replacement.subjectKey !== job.subjectKey ||
      replacement.fingerprint === job.fingerprint
    ) {
      throw new ConfigError(
        "Supersession requires a different-version replacement job with the same kind and subject.",
      );
    }
    const includeRunning = body.includeRunning === true;
    changed = app.jobs.supersede(
      jobId,
      replacement.id,
      `superseded by job ${replacement.id}`,
      includeRunning,
    );
    if (changed && job.status === "leased" && job.executionId) {
      await app.cancellations.cancelRun(job.executionId);
    }
  }

  if (!changed) {
    return json({ error: `Job '${jobId}' cannot be ${action}d in its current state.` }, 409);
  }
  return json({
    jobId,
    action,
    priority: action === "priority" ? body.priority : job.priority,
    control: app.jobs.controlState(jobId),
  });
}

async function routeJobCancel(
  request: Request,
  jobId: string,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request.method);

  const job = app.jobs.get(jobId);
  if (!job) return notFound(`No job '${jobId}'.`);
  if (!canAccessTask(app, job.loopId, user)) return notFound(`No job '${jobId}'.`);

  const result = await app.cancellations.cancelJob(jobId);
  if (!result.cancelled) {
    return json({ error: `Job '${jobId}' has already finished.`, ...result }, 409);
  }
  return json(result);
}

/**
 * GET/PUT/DELETE for one task's stored schedule config. One of the two
 * mutating surfaces in this API — see the file header.
 */
async function routeTaskSchedule(
  request: Request,
  id: string,
  app: App,
  user: AuthUser,
): Promise<Response> {
  if (!canAccessTask(app, id, user)) return notFound(`No task '${id}'.`);
  app.taskRegistry.require(id); // 400s via TalosError if the id is unknown

  if (request.method === "GET") {
    app.refresh();
    const scheduled = app.scheduledTask(id)!;
    return json(toScheduleView(scheduled));
  }

  const instance = app.instances.get(id);
  if (
    instance?.ownerId !== user.id &&
    !createAppAbility(user.permissions).can("manage", "Task")
  ) {
    return json(
      { error: "Only a task manager or the loop's owner can change its schedule." },
      403,
    );
  }

  if (request.method === "DELETE") {
    return json(toScheduleView(app.tasks.clearSchedule(id)));
  }

  if (request.method === "PUT") {
    let body: unknown;
    try {
      body = await request.json();
    } catch (cause) {
      throw new ConfigError("Request body is not valid JSON.", { cause });
    }

    return json(toScheduleView(app.tasks.updateSchedule(id, body)));
  }

  return methodNotAllowed(request.method);
}

/**
 * GET/PUT /api/settings — the general (non-task) settings: log level,
 * timezone, llm defaults. Backed by `general_config`, which layers over the
 * YAML defaults rather than replacing them (see resolve-settings.ts), so
 * there is nothing to DELETE back to — a field reverts to its default by
 * being set to `null` in the PUT body.
 */
async function routeSettings(request: Request, app: App): Promise<Response> {
  if (request.method === "GET") {
    return json(toSettingsView(app));
  }

  if (request.method === "PUT") {
    let body: unknown;
    try {
      body = await request.json();
    } catch (cause) {
      throw new ConfigError("Request body is not valid JSON.", { cause });
    }

    const parsed = GeneralSettingsPatchSchema.safeParse(body);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      throw new ValidationError(`Invalid settings patch:\n${detail}`, {
        issues: parsed.error.issues,
      });
    }
    const patch = parsed.data;

    app.settingsAdmin.update(patch);
    return json(toSettingsView(app));
  }

  return methodNotAllowed(request.method);
}

/** GET/PUT the instance-wide file and instruction overrides used by E2E jobs. */
async function routeE2eTestSettings(request: Request, app: App): Promise<Response> {
  const view = (): ApiContract.E2eTestSettingsView => ({
    ...app.e2eTestConfig.inspect(),
    sources: e2eTestSettingsSources(),
  });

  if (request.method === "GET") return json(view());
  if (request.method !== "PUT") return methodNotAllowed(request.method);

  const body = await jsonBody(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ConfigError("Request body must be a JSON object.");
  }

  const allowed = new Set([
    "agentInstructionsOverride",
    "runtimeConfigOverride",
    "additionalInstructions",
  ]);
  const patch: ApiContract.E2eTestSettingsPatch = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!allowed.has(key)) throw new ValidationError(`Unknown E2E setting '${key}'.`);
    if (value !== null && typeof value !== "string") {
      throw new ValidationError(`E2E setting '${key}' must be a string or null.`);
    }
    const maxBytes = key === "additionalInstructions"
      ? MAX_E2E_ADDITIONAL_INSTRUCTIONS_BYTES
      : MAX_E2E_FILE_OVERRIDE_BYTES;
    const normalized = value == null ? null : value.trim();
    if (normalized === "") {
      throw new ValidationError(`E2E setting '${key}' cannot be empty; use null to revert it.`);
    }
    if (normalized != null && new TextEncoder().encode(normalized).byteLength > maxBytes) {
      throw new ValidationError(`E2E setting '${key}' exceeds ${maxBytes} bytes.`);
    }
    Object.assign(patch, { [key]: normalized });
  }

  if (patch.runtimeConfigOverride != null) {
    parseQaRuntime(patch.runtimeConfigOverride);
  }
  app.e2eTestConfig.set(patch);
  return json(view());
}

/**
 * GET /api/settings/resolved-models — for each LLM alias, the concrete
 * snapshot the most recent run that requested it actually reported at
 * startup. Read straight from `task_run_logs`; there is no dedicated column
 * for this, so it is a best-effort `LIKE` scan over the "claude started
 * (<model>)" line (see `RunRepository.lastResolvedModel`).
 */
async function routeResolvedModels(request: Request, app: App): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(request.method);

  const result = {} as Record<ApiContract.LlmModel, { model: string; ts: string } | null>;
  for (const alias of LLM_MODELS) {
    result[alias] = app.sink.lastResolvedModel(alias);
  }
  return json(result);
}

/**
 * GET/PUT /api/prompts — the LLM prompt templates the agent tasks build.
 * Backed by `prompt_templates`, which layers over the hardcoded default in
 * each task's own file rather than replacing it (see
 * config/resolve-prompts.ts), so there is nothing to DELETE back to — a
 * prompt reverts to its default by being set to `null` in the PUT body.
 */
async function routePrompts(request: Request, app: App): Promise<Response> {
  if (request.method === "GET") {
    return json(toPromptsView(app));
  }

  if (request.method === "PUT") {
    let body: unknown;
    try {
      body = await request.json();
    } catch (cause) {
      throw new ConfigError("Request body is not valid JSON.", { cause });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ConfigError("Request body must be a JSON object.");
    }

    const knownIds = new Set(PROMPT_TEMPLATES.map((def) => def.id));
    const patch: Record<string, string | null> = {};
    for (const [id, value] of Object.entries(body as Record<string, unknown>)) {
      if (!knownIds.has(id)) {
        throw new ValidationError(`Unknown prompt id '${id}'.`);
      }
      if (value !== null && typeof value !== "string") {
        throw new ValidationError(`Prompt '${id}' must be a string or null.`);
      }
      patch[id] = value;
    }

    app.promptsAdmin.update(patch);
    return json(toPromptsView(app));
  }

  return methodNotAllowed(request.method);
}
