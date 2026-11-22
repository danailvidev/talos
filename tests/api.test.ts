import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createApp, type App } from "../src/app.ts";
import { handleApiRequest } from "../src/api/router.ts";
import type {
  FeedbackIssueInput,
  GitLabFeedbackIssue,
} from "../src/connectors/gitlab/issues.ts";
import { isGeneratedId } from "../src/persistence/id.ts";
import { EMPTY_RESULT, type Task } from "../src/core/task.ts";
import { isTaskRunStartedView } from "../shared/api-contract.ts";
import type { AutomationPipelineSnapshot } from "../src/application/ports.ts";
import { GitLabClient } from "../src/connectors/gitlab/client.ts";
import {
  AuthenticationError,
  ConfigError,
  ConnectorError,
  PermissionError,
  TransientError,
} from "../src/core/errors.ts";
import { FakeHttp } from "./fixtures/http.ts";

process.env.TALOS_ADMIN_PASSWORD = "talos-admin";
process.env.TALOS_OPERATOR_PASSWORD = "talos-operator";
process.env.TALOS_SECRET_KEY = "a sufficiently long api test key";

/**
 * The API over a real App: a temporary config, a real SQLite file, real views.
 *
 * `handleApiRequest` is called directly rather than over a socket — the routes
 * are the part worth testing and a port adds only flakiness.
 */

/** Just enough of `/api/notifications` to assert on; `json()` is otherwise `unknown`. */
interface NotificationsBody {
  notifications: { id: string }[];
  unreadCount: number;
}

let dir: string;
let app: App;
let sessionCookie: string;
let publishedIssues: FeedbackIssueInput[];
let listedIssues: GitLabFeedbackIssue[];

const CONFIG = `
database: ./test.db
logLevel: fatal
`;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "talos-api-"));
  writeFileSync(join(dir, "talos.yaml"), CONFIG);
  publishedIssues = [];
  listedIssues = [];
  app = await createApp({
    config: join(dir, "talos.yaml"),
    feedbackIssuePublisher: {
      createIssue: async (input) => {
        publishedIssues.push(input);
        listedIssues.push({
          number: 42,
          url: "https://gitlab.com/example-org/tools/talos/-/issues/42",
          state: "opened",
          title: input.title,
          description: input.body,
          labels: input.labels,
          createdAt: new Date(),
          updatedAt: new Date(),
          feedbackId: input.idempotencyKey,
        });
        return { number: 42, url: "https://gitlab.com/example-org/tools/talos/-/issues/42" };
      },
      listIssues: async () => listedIssues,
    },
  });
  sessionCookie = (await app.auth.login("admin@talos.local", "talos-admin"))!
    .cookie.split(";")[0]!;
  // The logger writes to stdout by default; a test suite must stay quiet.
  app.logger = app.logger.child({}, { level: "fatal" });

  // Per-task schedule config now lives in the database — seed it the way
  // `task schedule set` or the web UI would.
  app.configStore.setConfig("automation-report-sync", {
    enabled: true,
    trigger: { type: "cron", expression: "*/10 * * * *" },
  });
  app.configStore.setConfig("gitlab-ci-failure", {
    enabled: false,
    trigger: { type: "cron", expression: "0 7 * * *" },
    params: {
      gitlab: { projectId: "acme/webportal" },
      jira: { project: "TP", issueType: "Bug", boardId: 21 },
    },
  });
  app.refresh();
});

afterEach(() => {
  app.close();
  rmSync(dir, { recursive: true, force: true });
});

function get(path: string): Promise<Response | null> {
  return handleApiRequest(
    new Request(`http://localhost${path}`, { headers: { cookie: sessionCookie } }),
    app,
  );
}

function send(path: string, method: string, body?: unknown): Promise<Response | null> {
  return handleApiRequest(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        cookie: sessionCookie,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined
        ? { body: JSON.stringify(body) }
        : {}),
    }),
    app,
  );
}

async function createActiveUser(input: {
  name: string;
  email: string;
  password: string;
  roleId?: string;
}) {
  const invitation = app.auth.createInvitedUser({
    name: input.name,
    email: input.email,
    roleId: input.roleId ?? "qa",
  });
  const session = await app.auth.acceptInvitation(invitation.token, input.password);
  if (!session) throw new Error(`Failed to accept invitation for '${input.email}'.`);
  return session;
}

/**
 * The decoded body, deliberately loose.
 *
 * These tests assert the wire shape, so naming the view types here would only
 * mean the assertions agree with themselves — a field renamed in both places
 * would still pass. `web/src/api.ts` mirrors the same shapes by hand, and a
 * mismatch there shows up as a failed assertion on a literal field name.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bodyOf(path: string): Promise<any> {
  return (await get(path))!.json();
}

async function waitForRun(executionId: string): Promise<NonNullable<ReturnType<App["sink"]["getRun"]>>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = app.sink.getRun(executionId);
    if (run && run.status !== "running") return run;
    await Bun.sleep(5);
  }
  throw new Error(`Run '${executionId}' did not finish.`);
}

describe("routing", () => {
  test("ignores paths outside /api/, so static files fall through", async () => {
    expect(await get("/")).toBeNull();
    expect(await get("/assets/app.js")).toBeNull();
  });

  test("refuses every method but GET on read-only routes", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const response = await handleApiRequest(
        new Request("http://localhost/api/tasks", {
          method,
          headers: { cookie: sessionCookie },
        }),
        app,
      );
      expect(response!.status).toBe(405);
    }
  });

  test("serves pull request images privately through the authenticated provider", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    app.pullRequests.asset = async (_actor, id, path) => {
      expect(id).toBe("gitlab:acme/webportal!6193");
      expect(path).toBe("/uploads/0123456789abcdef0123456789abcdef/screen.png");
      return { body: bytes, contentType: "image/png", filename: "screen.png" };
    };

    const response = await get(
      "/api/pull-requests/gitlab%3Aacme%2Fwebportal!6193/assets" +
        "?path=%2Fuploads%2F0123456789abcdef0123456789abcdef%2Fscreen.png",
    );

    expect(response!.status).toBe(200);
    expect(response!.headers.get("content-type")).toBe("image/png");
    expect(response!.headers.get("cache-control")).toBe("private, max-age=300");
    expect(response!.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(bytes);
  });

  test("POST /api/tasks with a bad body is a 400, not a 405", async () => {
    const response = await handleApiRequest(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        body: "{}",
        headers: { cookie: sessionCookie },
      }),
      app,
    );
    expect(response!.status).toBe(400);
  });

  test("404s an unknown API route with a usable message", async () => {
    const response = (await get("/api/nope"))!;
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("/api/nope") });
  });

  test("directs release setup to configuration or the current user's GitLab access", async () => {
    expect(await bodyOf("/api/releases")).toMatchObject({
      configured: false,
      setupRequired: "release-config",
    });

    app.releaseConfig.set({
      projectId: "acme/releases",
      manifestPath: "cluster.yaml",
      targetBranch: "main",
    });

    expect(await bodyOf("/api/releases")).toMatchObject({
      configured: false,
      setupRequired: "gitlab-access",
      error: expect.stringContaining("GITLAB_TOKEN"),
    });
  });

  test("scopes release history to an environment and starting instant", async () => {
    let received: Parameters<App["releases"]["history"]>[1] | undefined;
    app.releases.history = async (_actor, options) => {
      received = options;
      return {
        projectId: "acme/releases",
        targetBranch: "main",
        deployments: [],
        environments: [],
        commitsScanned: 0,
      };
    };

    const response = await get(
      "/api/releases/history?environment=DEV3&limit=200&since=2026-10-01T21%3A00%3A00.000Z",
    );

    expect(response!.status).toBe(200);
    expect(received).toMatchObject({
      environment: "DEV3",
      limit: 200,
      since: new Date("2026-10-01T21:00:00.000Z"),
    });
  });

  test("rejects an invalid release history starting instant", async () => {
    const response = await get("/api/releases/history?since=not-a-date");

    expect(response!.status).toBe(400);
    expect(await response!.json()).toMatchObject({
      error: expect.stringContaining("'since'"),
    });
  });

  test("checks Kubernetes status without creating a release watch or job", async () => {
    app.deploymentVerifier = {
      verify: async (environment, targets) => {
        expect(environment).toBe("STAGE");
        expect(targets).toEqual([
          { service: "web", expectedImage: "registry/web:1.2.3" },
        ]);
        return targets.map((target) => ({
          ...target,
          state: "released" as const,
          desiredReplicas: 2,
          updatedReplicas: 2,
          readyReplicas: 2,
          availableReplicas: 2,
          podCount: 2,
          observedDigest: "sha256:aaaaaaaa",
        }));
      },
    };

    const response = await send("/api/releases/deployment-status", "POST", {
      environments: [
        {
          name: "STAGE",
          services: [
            {
              name: "web",
              image: "registry/web",
              version: "1.2.3",
              section: "applications",
            },
          ],
        },
      ],
    });

    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      environments: [
        {
          name: "STAGE",
          services: [
            {
              service: "web",
              expectedImage: "registry/web:1.2.3",
              state: "released",
              readyReplicas: 2,
              observedDigest: "sha256:aaaaaaaa",
            },
          ],
        },
      ],
    });
    expect(app.deployWatches.list()).toEqual([]);
    expect(app.jobs.recent().filter((job) => job.kind === "deploy-watch")).toEqual([]);
  });

  test("waits for the release merge before checking its changed services in Kubernetes", async () => {
    app.releaseConfig.set({
      projectId: "acme/releases",
      manifestPath: "cluster.yaml",
      targetBranch: "main",
    });
    let verifyCalls = 0;
    app.deploymentVerifier = {
      verify: async () => {
        verifyCalls += 1;
        return [];
      },
    };
    app.jobs.enqueue({
      kind: "release-pipeline-watch",
      loopId: "release-pipeline-watch",
      subjectKey: "release-mr:acme/releases!42",
      fingerprint: "opened:42",
      params: {
        projectId: "acme/releases",
        mrIid: 42,
        mrUrl: "https://gitlab.example/acme/releases/-/merge_requests/42",
        environment: "STAGE",
        services: ["web"],
        openedAt: new Date().toISOString(),
      },
    });

    const response = await send("/api/releases/deployment-status", "POST", {
      environments: [
        {
          name: "STAGE",
          services: [
            {
              name: "web",
              image: "registry/web",
              version: "1.2.3",
              section: "applications",
            },
          ],
        },
      ],
    });

    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      environments: [
        {
          name: "STAGE",
          waitingForMerge: true,
          services: [
            {
              service: "web",
              expectedImage: "registry/web:1.2.3",
              state: "pending",
              message: expect.stringContaining("merge"),
            },
          ],
        },
      ],
    });
    expect(verifyCalls).toBe(0);
  });
});

describe("admin users and logs", () => {
  test("gives the built-in admin its preset and rejects users without permission", async () => {
    expect((await bodyOf("/api/auth/session")).user.role).toEqual({
      id: "admin",
      name: "Administrator",
    });
    expect((await bodyOf("/api/auth/session")).user.permissions).toContain("users:manage");

    const operatorCookie = (await app.auth.login(
      "operator@talos.local",
      "talos-operator",
    ))!.cookie.split(";")[0]!;
    const response = await handleApiRequest(
      new Request("http://localhost/api/admin/users", {
        headers: { cookie: operatorCookie },
      }),
      app,
    );
    expect(response!.status).toBe(403);
    expect(await response!.json()).toEqual({
      error: "User-management permission is required.",
    });
  });

  test("keeps instance settings and shared configuration permission-gated", async () => {
    const operatorCookie = (await app.auth.login(
      "operator@talos.local",
      "talos-operator",
    ))!.cookie.split(";")[0]!;
    const requestAsQa = (path: string, method = "GET") =>
      handleApiRequest(
        new Request(`http://localhost${path}`, {
          method,
          headers: {
            cookie: operatorCookie,
            ...(method === "GET" ? {} : { "content-type": "application/json" }),
          },
          ...(method === "GET" ? {} : { body: "{}" }),
        }),
        app,
      );

    for (const [path, method, permission] of [
      ["/api/settings", "GET", /instance-settings/i],
      ["/api/settings/integrations", "PUT", /instance-settings/i],
      ["/api/settings/e2e-tests", "GET", /instance-settings/i],
      ["/api/prompts", "GET", /instance-settings/i],
      ["/api/releases/config", "PUT", /instance-settings/i],
      ["/api/datadog/routing", "PUT", /instance-settings/i],
      ["/api/tasks/gitlab-ci-failure/schedule", "PUT", /task manager/i],
    ] as const) {
      const response = await requestAsQa(path, method);
      expect(response!.status).toBe(403);
      expect(await response!.json()).toEqual({
        error: expect.stringMatching(permission),
      });
    }
  });

  test("applies permission changes to an existing session", async () => {
    const roleResponse = await send("/api/admin/roles", "POST", {
      name: "Log reader",
      description: "Can inspect application logs.",
      permissions: [],
    });
    const role = (await roleResponse!.json()) as { id: string };
    const createdResponse = await send("/api/admin/users", "POST", {
      name: "Log Reader",
      email: "logs@example.com",
      roleId: role.id,
    });
    const invitation = (await createdResponse!.json()) as {
      user: { id: string; permissions: string[] };
      invitationUrl: string;
    };
    expect(invitation.user.permissions).toEqual([]);
    const invitationToken = decodeURIComponent(
      invitation.invitationUrl.split("#token=")[1]!,
    );
    await app.auth.acceptInvitation(invitationToken, "strong-password");

    const login = await app.auth.login("logs@example.com", "strong-password");
    const cookie = login!.cookie.split(";")[0]!;
    const requestAsUser = (path: string) =>
      handleApiRequest(
        new Request(`http://localhost${path}`, { headers: { cookie } }),
        app,
      );
    expect((await requestAsUser("/api/admin/logs"))!.status).toBe(403);

    const updated = await send(`/api/admin/roles/${role.id}`, "PATCH", {
      name: "Log reader",
      description: "Can inspect application logs.",
      permissions: ["application-logs:read"],
    });
    expect(await updated!.json()).toMatchObject({
      permissions: ["application-logs:read"],
    });

    expect((await requestAsUser("/api/admin/logs"))!.status).toBe(200);
    expect((await requestAsUser("/api/admin/users"))!.status).toBe(403);
  });

  test("enforces module access at every primary API boundary", async () => {
    const role = app.roles.create({
      name: "No modules",
      permissions: [],
    });
    await createActiveUser({
      name: "Restricted User",
      email: "restricted@example.com",
      password: "strong-password",
      roleId: role.id,
    });
    const login = await app.auth.login("restricted@example.com", "strong-password");
    const cookie = login!.cookie.split(";")[0]!;
    const requestAsUser = (path: string) =>
      handleApiRequest(
        new Request(`http://localhost${path}`, { headers: { cookie } }),
        app,
      );

    for (const path of [
      "/api/tasks",
      "/api/pull-requests",
      "/api/releases",
      "/api/automation/dashboard",
      "/api/logrocket/issues",
      "/api/datadog/issues",
      "/api/graph/tickets",
      "/api/slack/inbox",
    ]) {
      const response = await requestAsUser(path);
      expect(response!.status).toBe(403);
      expect(await response!.json()).toEqual({
        error: "Access to this module is not permitted by your role.",
      });
    }

    app.roles.update(role.id, {
      name: role.name,
      permissions: ["releases:access"],
    });
    expect((await requestAsUser("/api/releases"))!.status).not.toBe(403);
    expect((await requestAsUser("/api/tasks"))!.status).toBe(403);
  });

  test("creates and deletes roles while protecting assigned and recovery roles", async () => {
    const createdResponse = await send("/api/admin/roles", "POST", {
      name: "Release observer",
      description: "A temporary role.",
      permissions: ["application-logs:read"],
    });
    expect(createdResponse!.status).toBe(201);
    const created = (await createdResponse!.json()) as { id: string };

    const userResponse = await send("/api/admin/users", "POST", {
      name: "Assigned User",
      email: "assigned@example.com",
      roleId: created.id,
    });
    expect(userResponse!.status).toBe(201);

    const assignedDelete = await send(`/api/admin/roles/${created.id}`, "DELETE");
    expect(assignedDelete!.status).toBe(400);
    expect(await assignedDelete!.json()).toMatchObject({
      error: expect.stringContaining("Reassign"),
    });

    const systemDelete = await send("/api/admin/roles/qa", "DELETE");
    expect(systemDelete!.status).toBe(400);
    expect(await systemDelete!.json()).toMatchObject({
      error: expect.stringContaining("Built-in"),
    });

    const lockout = await send("/api/admin/roles/admin", "PATCH", {
      name: "Administrator",
      description: "No user management.",
      permissions: ["application-logs:read"],
    });
    expect(lockout!.status).toBe(409);
    expect(await lockout!.json()).toMatchObject({
      error: expect.stringContaining("user-management"),
    });

    const disposable = await send("/api/admin/roles", "POST", {
      name: "Disposable",
      permissions: [],
    });
    const disposableRole = (await disposable!.json()) as { id: string };
    expect((await send(`/api/admin/roles/${disposableRole.id}`, "DELETE"))!.status).toBe(200);
  });

  test("shows last activity and each user's usable provider connections", async () => {
    const createdResponse = await send("/api/admin/users", "POST", {
      name: "Connected User",
      email: "connected@example.com",
      roleId: "qa",
    });
    const invitation = (await createdResponse!.json()) as {
      user: { id: string };
      invitationUrl: string;
    };
    const created = invitation.user;
    await app.auth.acceptInvitation(
      decodeURIComponent(invitation.invitationUrl.split("#token=")[1]!),
      "strong-password",
    );

    app.credentials.set(created.id, "GITLAB_TOKEN", "glpat-test");
    app.credentials.set(created.id, "JIRA_EMAIL", "connected@example.com");
    app.credentials.set(created.id, "JIRA_TOKEN", "jira-test");
    app.slackConnections.save({
      userId: created.id,
      teamId: "T1",
      teamName: "Acme",
      slackUserId: "U1",
      slackUserName: "Connected User",
      accessToken: "xoxp-test",
      scopes: [],
    });
    app.agentAccounts.save({
      userId: created.id,
      provider: "claude",
      label: "Work Claude",
      method: "cli",
      optionId: "claude:cli",
      homeDir: join(dir, "claude-home"),
      account: "connected@example.com",
    });
    app.instances.create({
      definitionId: "custom-loop",
      name: "Connected user's private loop",
      visibility: "private",
      ownerId: created.id,
    });
    app.jobs.enqueue({
      kind: "fix-jira-issue-one",
      loopId: "manual",
      actorId: created.id,
      params: {},
    });
    app.pullRequestRepoFilters.set(created.id, ["acme/webportal"]);
    app.fixIssueDefaults.set(created.id, {
      projectId: "acme/webportal",
      targetBranch: "main",
    });

    const users = (await bodyOf("/api/admin/users")).users as Array<{
      id: string;
      lastSeenAt?: string;
      connections: { gitlab: boolean; jira: boolean; slack: boolean };
      agentAccountCount: number;
      ownedLoopCount: number;
    }>;
    expect(users.find((user) => user.id === created.id)).toMatchObject({
      lastSeenAt: expect.stringMatching(/^\d{4}-/),
      connections: { gitlab: true, jira: true, slack: true },
      agentAccountCount: 1,
      ownedLoopCount: 1,
    });
    expect(users.find((user) => user.id === "operator")).toMatchObject({
      connections: { gitlab: false, jira: false, slack: false },
      agentAccountCount: 0,
      ownedLoopCount: 0,
    });

    const detailResponse = await get(`/api/admin/users/${created.id}`);
    expect(detailResponse!.status).toBe(200);
    const detail = await detailResponse!.json();
    expect(detail).toMatchObject({
      id: created.id,
      sessions: [
        {
          createdAt: expect.stringMatching(/^\d{4}-/),
          expiresAt: expect.stringMatching(/^\d{4}-/),
        },
      ],
      providerConnections: {
        gitlab: { updatedAt: expect.stringMatching(/^\d{4}-/) },
        jira: { updatedAt: expect.stringMatching(/^\d{4}-/) },
        slack: {
          workspaceName: "Acme",
          userName: "Connected User",
        },
      },
      agentAccounts: [{ label: "Work Claude", provider: "claude" }],
      ownedLoops: [{ name: "Connected user's private loop" }],
      jobs: { queued: 1, leased: 0, done: 0, dead: 0 },
      pullRequestRepositories: ["acme/webportal"],
      fixIssueDefaults: { projectId: "acme/webportal", targetBranch: "main" },
    });
    expect(JSON.stringify(detail)).not.toContain("glpat-test");
    expect(JSON.stringify(detail)).not.toContain("xoxp-test");
    expect(JSON.stringify(detail)).not.toContain("talos_session");
  });

  test("adds issue metadata when feedback is submitted", async () => {
    const response = await send("/api/feedback", "POST", {
      type: "bug",
      title: "Save button freezes",
      description: "The settings page stops responding after Save is clicked.",
    });

    expect(response!.status).toBe(201);
    expect(await response!.json()).toEqual({
      id: expect.any(String),
      createdAt: expect.stringMatching(/^\d{4}-/),
      publicationStatus: "published",
      issueUrl: "https://gitlab.com/example-org/tools/talos/-/issues/42",
      issueNumber: 42,
    });
    expect(publishedIssues).toEqual([
      {
        idempotencyKey: expect.any(String),
        title: "[Bug]: Save button freezes",
        body: "The settings page stops responding after Save is clicked.",
        bodySuffix: "---\nSubmitted through Automesh by Admin.",
        labels: ["bug"],
        signal: expect.anything(),
      },
    ]);
    expect(app.feedback.list()).toEqual([
      {
        id: expect.any(String),
        userId: "admin",
        type: "bug",
        title: "[Bug]: Save button freezes",
        description: "The settings page stops responding after Save is clicked.",
        labels: ["bug"],
        publicationStatus: "published",
        externalIssueUrl: "https://gitlab.com/example-org/tools/talos/-/issues/42",
        externalIssueNumber: 42,
        createdAt: expect.any(Date),
      },
    ]);
  });

  test("accepts pasted feedback images as multipart attachments", async () => {
    const form = new FormData();
    form.set("type", "bug");
    form.set("title", "Layout is clipped");
    form.set("description", "The panel is clipped on a narrow screen.");
    form.append(
      "attachments",
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "clipped-panel.png", {
        type: "image/png",
      }),
    );

    const response = await handleApiRequest(
      new Request("http://localhost/api/feedback", {
        method: "POST",
        headers: { cookie: sessionCookie },
        body: form,
      }),
      app,
    );

    expect(response!.status).toBe(201);
    expect(publishedIssues).toEqual([
      {
        idempotencyKey: expect.any(String),
        title: "[Bug]: Layout is clipped",
        body: "The panel is clipped on a narrow screen.",
        bodySuffix: "---\nSubmitted through Automesh by Admin.",
        labels: ["bug"],
        signal: expect.anything(),
        attachments: [
          {
            name: "clipped-panel.png",
            contentType: "image/png",
            bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          },
        ],
      },
    ]);
    const feedbackId = app.feedback.list()[0]!.id;
    expect(app.feedback.attachments(feedbackId)).toEqual([]);
  });

  test("keeps feedback and screenshots pending until the owner retries with access", async () => {
    const successfulPublisher = app.feedbackIssuesFor;
    app.feedbackIssuesFor = () => ({
      createIssue: async () => {
        throw new ConfigError("Missing user GitLab token.");
      },
      listIssues: async () => listedIssues,
    });
    const form = new FormData();
    form.set("type", "bug");
    form.set("title", "Pending screenshot");
    form.set("description", "Keep this while I connect GitLab.");
    form.append(
      "attachments",
      new File([new Uint8Array([1, 2, 3])], "pending.png", { type: "image/png" }),
    );

    const response = await handleApiRequest(
      new Request("http://localhost/api/feedback", {
        method: "POST",
        headers: { cookie: sessionCookie },
        body: form,
      }),
      app,
    );
    expect(response!.status).toBe(202);
    const pending = (await response!.json()) as {
      id: string;
      publicationStatus: string;
      publicationReason: string;
    };
    expect(pending).toMatchObject({
      publicationStatus: "pending",
      publicationReason: "missing_token",
    });
    expect(app.feedback.attachments(pending.id)).toEqual([
      {
        name: "pending.png",
        contentType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
      },
    ]);

    const pendingResponse = await get("/api/feedback/pending");
    expect(await pendingResponse!.json()).toEqual({
      feedback: [
        expect.objectContaining({
          id: pending.id,
          publicationStatus: "pending",
          attachmentCount: 1,
        }),
      ],
    });

    const operatorCookie = (await app.auth.login(
      "operator@talos.local",
      "talos-operator",
    ))!.cookie.split(";")[0]!;
    const otherUserRetry = await handleApiRequest(
      new Request(`http://localhost/api/feedback/${pending.id}/publish`, {
        method: "POST",
        headers: { cookie: operatorCookie },
      }),
      app,
    );
    expect(otherUserRetry!.status).toBe(404);

    app.feedbackIssuesFor = successfulPublisher;
    const retry = await send(`/api/feedback/${pending.id}/publish`, "POST");
    expect(retry!.status).toBe(200);
    expect(await retry!.json()).toMatchObject({
      id: pending.id,
      publicationStatus: "published",
      issueNumber: 42,
    });
    expect(app.feedback.attachments(pending.id)).toEqual([]);
  });

  test("returns safe pending reasons for user PAT failures", async () => {
    const cases = [
      {
        error: new AuthenticationError("provider body must not leak"),
        reason: "invalid_token",
      },
      {
        error: new PermissionError("provider body must not leak"),
        reason: "insufficient_access",
      },
      {
        error: new ConnectorError("private project", {
          connector: "gitlab",
          status: 404,
        }),
        reason: "insufficient_access",
      },
      {
        error: new TransientError("provider body must not leak"),
        reason: "temporary_failure",
      },
    ] as const;

    for (const [index, item] of cases.entries()) {
      app.feedbackIssuesFor = () => ({
        createIssue: async () => {
          throw item.error;
        },
        listIssues: async () => listedIssues,
      });
      const response = await send("/api/feedback", "POST", {
        type: "general",
        title: `PAT failure ${index}`,
        description: "Save this locally.",
      });
      expect(response!.status).toBe(202);
      const result = await response!.json();
      expect(result).toMatchObject({
        publicationStatus: "pending",
        publicationReason: item.reason,
      });
      expect(JSON.stringify(result)).not.toContain("provider body");
    }
  });

  test("uses GitLab issue content and hides a deleted issue without deleting its audit row", async () => {
    const submitted = await send("/api/feedback", "POST", {
      type: "bug",
      title: "Original title",
      description: "Original description",
    });
    const created = (await submitted!.json()) as { id: string };
    listedIssues[0] = {
      ...listedIssues[0]!,
      state: "closed",
      title: "[Bug]: Edited in GitLab",
      description: "GitLab is authoritative.\n\n<!-- automesh-feedback:" + created.id + " -->",
      labels: ["bug", "triaged"],
    };

    const synced = await get("/api/admin/feedback");
    expect(await synced!.json()).toEqual({
      feedback: [
        expect.objectContaining({
          id: created.id,
          title: "[Bug]: Edited in GitLab",
          description: "GitLab is authoritative.",
          labels: ["bug", "triaged"],
          issueState: "closed",
          publicationStatus: "published",
        }),
      ],
      gitlabSync: {
        status: "synced",
        syncedAt: expect.stringMatching(/^\d{4}-/),
      },
    });

    listedIssues = [];
    const afterDelete = await get("/api/admin/feedback");
    expect(await afterDelete!.json()).toEqual({
      feedback: [],
      gitlabSync: {
        status: "synced",
        syncedAt: expect.stringMatching(/^\d{4}-/),
      },
    });
    expect(app.feedback.get(created.id)).toMatchObject({
      id: created.id,
      publicationStatus: "published",
    });
  });

  test("lists marker-bearing GitLab feedback even when its local audit row is absent", async () => {
    listedIssues = [
      {
        number: 77,
        url: "https://gitlab.com/example-org/tools/talos/-/issues/77",
        state: "opened",
        title: "[Feature]: Remote only",
        description:
          "The local row was removed earlier.\n\n" +
          "<!-- automesh-feedback:removed_feedback_77 -->",
        labels: ["feature"],
        createdAt: new Date("2026-10-15T10:00:00.000Z"),
        updatedAt: new Date("2026-10-15T10:05:00.000Z"),
        feedbackId: "removed_feedback_77",
      },
    ];

    const response = await get("/api/admin/feedback");
    expect(await response!.json()).toMatchObject({
      feedback: [
        {
          id: "removed_feedback_77",
          type: "feature",
          title: "[Feature]: Remote only",
          description: "The local row was removed earlier.",
          labels: ["feature"],
          publicationStatus: "published",
          issueState: "opened",
          externalIssueNumber: 77,
        },
      ],
      gitlabSync: { status: "synced" },
    });
  });

  test("shows only pending local feedback when the administrator cannot sync GitLab", async () => {
    const pending = app.feedback.create("admin", {
      type: "general",
      title: "Still local",
      description: "Do not hide this pending submission.",
    });
    app.feedbackIssuesFor = (actor) => {
      expect(actor.id).toBe("admin");
      return {
        createIssue: async () => {
          throw new Error("not used");
        },
        listIssues: async () => {
          throw new AuthenticationError("secret provider response");
        },
      };
    };

    const response = await get("/api/admin/feedback");
    expect(response!.status).toBe(200);
    const body = await response!.json();
    expect(body).toMatchObject({
      feedback: [
        {
          id: pending.id,
          publicationStatus: "pending",
        },
      ],
      gitlabSync: {
        status: "unavailable",
        reason: "invalid_token",
      },
    });
    expect(JSON.stringify(body)).not.toContain("secret provider");
  });

  test("lists submitted feedback only for user administrators", async () => {
    const createdResponse = await send("/api/admin/users", "POST", {
      name: "Feedback Author",
      email: "feedback@example.com",
      roleId: "qa",
    });
    const created = ((await createdResponse!.json()) as { user: { id: string } }).user;
    app.feedback.create(created.id, {
      type: "feature",
      title: "Compact activity view",
      description: "Please add a compact activity view.",
    });

    const response = await get("/api/admin/feedback");
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({
      feedback: [
        {
          id: expect.any(String),
          userId: created.id,
          userName: "Feedback Author",
          userEmail: "feedback@example.com",
          type: "feature",
          title: "[Feature]: Compact activity view",
          description: "Please add a compact activity view.",
          labels: ["feature"],
          publicationStatus: "pending",
          createdAt: expect.stringMatching(/^\d{4}-/),
        },
      ],
      gitlabSync: {
        status: "synced",
        syncedAt: expect.stringMatching(/^\d{4}-/),
      },
    });

    const operatorCookie = (await app.auth.login(
      "operator@talos.local",
      "talos-operator",
    ))!.cookie.split(";")[0]!;
    const forbidden = await handleApiRequest(
      new Request("http://localhost/api/admin/feedback", {
        headers: { cookie: operatorCookie },
      }),
      app,
    );
    expect(forbidden!.status).toBe(403);
    const forbiddenDelete = await handleApiRequest(
      new Request(`http://localhost/api/admin/feedback/${created.id}`, {
        method: "DELETE",
        headers: { cookie: operatorCookie },
      }),
      app,
    );
    expect(forbiddenDelete!.status).toBe(403);
  });

  test("refuses to delete the local audit row for published GitLab feedback", async () => {
    const feedback = app.feedback.create("admin", {
      type: "bug",
      title: "Remove this row",
      description: "Already handled elsewhere.",
    });
    app.feedback.linkExternalIssue(feedback.id, {
      number: 42,
      url: "https://gitlab.com/example-org/tools/talos/-/issues/42",
    });

    const response = await send(
      `/api/admin/feedback/${encodeURIComponent(feedback.id)}`,
      "DELETE",
    );

    expect(response!.status).toBe(409);
    expect(await response!.json()).toEqual({
      error: "Published feedback is managed in GitLab and cannot be deleted locally.",
    });
    expect(app.feedback.get(feedback.id)).toMatchObject({
      publicationStatus: "published",
    });
    expect(publishedIssues).toEqual([]);
  });

  test("creates, updates, and deletes managed users without administrator-known passwords", async () => {
    const createdResponse = await send("/api/admin/users", "POST", {
      name: "QA Person",
      email: "qa@example.com",
      roleId: "qa",
    });
    expect(createdResponse!.status).toBe(201);
    const invitation = (await createdResponse!.json()) as {
      user: { id: string; role: { id: string } };
      invitationUrl: string;
    };
    const created = invitation.user;
    expect(created.role.id).toBe("qa");

    const invitationToken = decodeURIComponent(
      invitation.invitationUrl.split("#token=")[1]!,
    );
    await app.auth.acceptInvitation(invitationToken, "strong-password");
    const qaLogin = await app.auth.login("qa@example.com", "strong-password");
    expect(qaLogin?.user.role.id).toBe("qa");

    const updatedResponse = await send(`/api/admin/users/${created.id}`, "PATCH", {
      name: "QA Admin",
      email: "qa-admin@example.com",
      roleId: "admin",
    });
    expect(updatedResponse!.status).toBe(200);
    expect(await updatedResponse!.json()).toMatchObject({
      id: created.id,
      email: "qa-admin@example.com",
      role: { id: "admin", name: "Administrator" },
      permissions: expect.arrayContaining([
        "users:manage",
        "application-logs:read",
        "instance-settings:manage",
        "tasks:manage",
      ]),
    });
    const existingSession = await handleApiRequest(
      new Request("http://localhost/api/tasks", {
        headers: { cookie: qaLogin!.cookie.split(";")[0]! },
      }),
      app,
    );
    expect(existingSession!.status).toBe(200);
    expect((await app.auth.login("qa-admin@example.com", "strong-password"))?.user.role.id).toBe(
      "admin",
    );

    const deletedResponse = await send(`/api/admin/users/${created.id}`, "DELETE");
    expect(deletedResponse!.status).toBe(200);
    expect(await app.auth.login("qa-admin@example.com", "strong-password")).toBeNull();
  });

  test("does not permit changing or deleting built-in accounts", async () => {
    const update = await send("/api/admin/users/admin", "PATCH", {
      name: "Other",
      email: "other@example.com",
      roleId: "qa",
    });
    expect(update!.status).toBe(409);

    const remove = await send("/api/admin/users/operator", "DELETE");
    expect(remove!.status).toBe(409);
  });

  test("returns bounded redacted process logs only to admins", async () => {
    app.logger.fatal({ password: "do-not-print" }, "admin log test");
    app.applicationLogs.stream.write(
      `${JSON.stringify({
        level: "info",
        time: Date.now(),
        msg: "password reset link: http://localhost/reset-password?token=one-time-token",
      })}\n`,
    );
    const response = await get("/api/admin/logs?limit=10");
    expect(response!.status).toBe(200);
    const body = (await response!.json()) as {
      logs: { message: string; meta?: Record<string, unknown> }[];
    };
    const line = body.logs.find((entry) => entry.message === "admin log test");
    expect(line?.meta?.password).toBe("[redacted]");
    expect(body.logs.find((entry) => entry.message.startsWith("password reset link:"))?.message)
      .toEndWith("token=[redacted]");
  });

  test("exposes orchestration state and administrative job controls", async () => {
    const queued = app.jobs.enqueue({
      kind: "test-handler",
      loopId: "manual-actions",
      dedupeKey: `orchestration-api-${crypto.randomUUID()}`,
    }).job!;

    const held = await send(`/api/jobs/${queued.id}/hold`, "POST", {
      reason: "maintenance",
    });
    expect(held!.status).toBe(200);
    expect(app.jobs.controlState(queued.id)).toMatchObject({
      held: true,
      holdReason: "maintenance",
    });

    expect((await send(`/api/jobs/${queued.id}/priority`, "POST", {
      priority: 7,
    }))!.status).toBe(200);
    expect(app.jobs.get(queued.id)?.priority).toBe(7);
    expect((await send(`/api/jobs/${queued.id}/resume`, "POST"))!.status).toBe(200);

    const view = await get("/api/admin/orchestration");
    expect(view!.status).toBe(200);
    expect(await view!.json()).toMatchObject({
      capacity: { total: 3, interactiveReservation: 1 },
      suspension: {
        supported: false,
        reason: expect.stringContaining("durable workspace"),
      },
      checkpoints: [],
      jobs: expect.arrayContaining([
        expect.objectContaining({ id: queued.id, priority: 7 }),
      ]),
    });
    const suspension = await send(
      "/api/admin/orchestration/executions/missing-run/suspend",
      "POST",
    );
    expect(suspension!.status).toBe(409);
    expect(await suspension!.json()).toMatchObject({
      error: expect.stringContaining("no active agent attempt"),
      capability: { supported: false },
    });

    expect((await send("/api/admin/orchestration/drain", "POST"))!.status).toBe(200);
    expect(app.orchestration.attempts()).toBeArray();
    expect((await bodyOf("/api/system")).agentCapacity.draining).toBe(true);
    expect((await send("/api/admin/orchestration/resume", "POST"))!.status).toBe(200);
  });
});

describe("assistant chat", () => {
  test("requires a session and a selected Claude account", async () => {
    const unauthenticated = await handleApiRequest(
      new Request("http://localhost/api/assistant/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      }),
      app,
    );
    expect(unauthenticated!.status).toBe(401);

    const missingAccount = await send("/api/assistant/chat", "POST", {
      messages: [{ role: "user", content: "hello" }],
    });
    expect(missingAccount!.status).toBe(409);
    expect(await missingAccount!.json()).toEqual({
      error: expect.stringContaining("No Claude account"),
    });
  });

  test("validates the transcript before starting Claude", async () => {
    app.agentAccounts.runtimeCredential = () => ({
      id: "account-test",
      label: "test Claude",
      optionId: "claude:key-oauth",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "not-a-real-token" },
    });
    const response = await send("/api/assistant/chat", "POST", {
      messages: [{ role: "assistant", content: "not a user turn" }],
    });
    expect(response!.status).toBe(400);
    expect(await response!.json()).toMatchObject({
      error: expect.stringContaining("last assistant message"),
    });
  });

  test("streams sanitized assistant events from the connected account", async () => {
    app.agentAccounts.runtimeCredential = () => ({
      id: "account-work",
      label: "work Claude",
      optionId: "claude:key-oauth",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "not-a-real-token" },
    });
    app.agentRunPreferences.set("admin", { model: "opus", effort: "high" });
    app.runAssistantChat = async (options) => {
      expect(options.actor.id).toBe("admin");
      expect(options.messages).toEqual([{ role: "user", content: "What is failing?" }]);
      expect(options.model).toBe("opus");
      expect(options.effort).toBe("high");
      expect(options.capabilityToken.length).toBeGreaterThan(30);
      options.emit({ type: "start", account: options.account.label });
      options.emit({
        type: "tool",
        id: "tool-1",
        name: "datadog issues",
        status: "started",
      });
      options.emit({ type: "text", text: "Two services are failing." });
      options.emit({
        type: "tool",
        id: "tool-1",
        name: "datadog issues",
        status: "completed",
      });
      options.emit({ type: "done" });
    };

    const response = await send("/api/assistant/chat", "POST", {
      messages: [{ role: "user", content: "What is failing?" }],
    });
    expect(response!.status).toBe(200);
    expect(response!.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response!.headers.get("cache-control")).toBe("no-store");
    const events = (await response!.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      { type: "start", account: "work Claude" },
      { type: "tool", id: "tool-1", name: "datadog issues", status: "started" },
      { type: "text", text: "Two services are failing." },
      { type: "tool", id: "tool-1", name: "datadog issues", status: "completed" },
      { type: "done" },
    ]);
  });

  test("cancels the Claude turn when the browser closes the stream", async () => {
    app.agentAccounts.runtimeCredential = () => ({
      id: "account-work",
      label: "work Claude",
      optionId: "claude:key-oauth",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "not-a-real-token" },
    });
    let observedAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      observedAbort = resolve;
    });
    app.runAssistantChat = async (options) => {
      options.emit({ type: "start", account: options.account.label });
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            observedAbort();
            resolve();
          },
          { once: true },
        );
      });
    };

    const response = await send("/api/assistant/chat", "POST", {
      messages: [{ role: "user", content: "Wait for it" }],
    });
    const reader = response!.body!.getReader();
    await reader.read();
    await reader.cancel();
    await aborted;
  });
});

describe("merge request revision chat", () => {
  const prPath = "/api/pull-requests/gitlab%3Aacme%2Fwebportal!6193/actions";

  test("requires a non-empty instruction", async () => {
    const response = await send(prPath, "POST", { action: "revise", instruction: "   " });
    expect(response!.status).toBe(400);
    expect(await response!.json()).toMatchObject({
      error: expect.stringContaining("instruction"),
    });
  });

  test("queues a revision with bounded conversational history", async () => {
    app.pullRequests.detail = async () =>
      ({
        provider: "gitlab",
        id: "gitlab:acme/webportal!6193",
        number: 6193,
        state: "draft",
      }) as Awaited<ReturnType<typeof app.pullRequests.detail>>;

    const response = await send(prPath, "POST", {
      action: "revise",
      instruction: "Keep the empty value backwards compatible.",
      history: [
        { role: "user", content: "Simplify the parser." },
        { role: "assistant", content: "I simplified it." },
      ],
    });

    expect(response!.status).toBe(202);
    const job = app.jobs.byDedupeKey(
      "manual:revise:gitlab:acme/webportal!6193",
      1,
    )[0];
    expect(job).toMatchObject({
      kind: "gitlab-mr-revision-one",
      actorId: "admin",
      params: {
        gitlab: { projectId: "acme/webportal", mrIid: 6193 },
        instruction: "Keep the empty value backwards compatible.",
        history: [
          { role: "user", content: "Simplify the parser." },
          { role: "assistant", content: "I simplified it." },
        ],
      },
    });
  });
});

describe("authentication and private tasks", () => {
  test("keeps built-in recovery accounts disabled without explicit passwords", async () => {
    const adminPassword = process.env.TALOS_ADMIN_PASSWORD;
    const operatorPassword = process.env.TALOS_OPERATOR_PASSWORD;
    delete process.env.TALOS_ADMIN_PASSWORD;
    delete process.env.TALOS_OPERATOR_PASSWORD;
    try {
      expect(await app.auth.login("admin@talos.local", "talos-admin")).toBeNull();
      expect(await app.auth.login("operator@talos.local", "talos-operator")).toBeNull();
    } finally {
      if (adminPassword === undefined) delete process.env.TALOS_ADMIN_PASSWORD;
      else process.env.TALOS_ADMIN_PASSWORD = adminPassword;
      if (operatorPassword === undefined) delete process.env.TALOS_OPERATOR_PASSWORD;
      else process.env.TALOS_OPERATOR_PASSWORD = operatorPassword;
    }
  });

  test("requires a session and supports login/logout", async () => {
    const denied = await handleApiRequest(new Request("http://localhost/api/tasks"), app);
    expect(denied!.status).toBe(401);

    const login = await handleApiRequest(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "operator@talos.local",
          password: "talos-operator",
        }),
      }),
      app,
    );
    expect(login!.status).toBe(200);
    expect(login!.headers.get("set-cookie")).toContain("HttpOnly");
    expect(await login!.json()).toMatchObject({
      user: { email: "operator@talos.local" },
    });
  });

  test("stores preferences per user and clears them", async () => {
    const saved = await send("/api/me/preferences", "PUT", {
      key: "graph.filters",
      value: { sprint: 42 },
    });
    expect(saved!.status).toBe(200);
    expect(await saved!.json()).toEqual({
      values: { "graph.filters": { sprint: 42 } },
    });

    const operatorCookie = (await app.auth.login(
      "operator@talos.local",
      "talos-operator",
    ))!
      .cookie.split(";")[0]!;
    const operatorPreferences = await handleApiRequest(
      new Request("http://localhost/api/me/preferences", {
        headers: { cookie: operatorCookie },
      }),
      app,
    );
    expect(await operatorPreferences!.json()).toEqual({ values: {} });

    const cleared = await send("/api/me/preferences", "PUT", {
      key: "graph.filters",
      value: null,
    });
    expect(await cleared!.json()).toEqual({ values: {} });
  });

  test("stores validated agent run defaults per user", async () => {
    const initial = await get("/api/me/agent-run-preferences");
    expect(await initial!.json()).toEqual({ model: null, effort: null });

    const saved = await send("/api/me/agent-run-preferences", "PUT", {
      model: "opus",
      effort: "high",
    });
    expect(saved!.status).toBe(200);
    expect(await saved!.json()).toEqual({ model: "opus", effort: "high" });

    const operatorCookie = (await app.auth.login(
      "operator@talos.local",
      "talos-operator",
    ))!.cookie.split(";")[0]!;
    const operatorPreferences = await handleApiRequest(
      new Request("http://localhost/api/me/agent-run-preferences", {
        headers: { cookie: operatorCookie },
      }),
      app,
    );
    expect(await operatorPreferences!.json()).toEqual({ model: null, effort: null });

    const invalid = await send("/api/me/agent-run-preferences", "PUT", {
      model: "imaginary",
      effort: "high",
    });
    expect(invalid!.status).toBe(400);

    app.agentAccounts.save({
      userId: "admin",
      provider: "claude",
      label: "Anthropic API",
      method: "key",
      optionId: "claude:key-api",
      values: { ANTHROPIC_API_KEY: "not-a-real-token" },
    });
    const incompatible = await send("/api/me/agent-run-preferences", "PUT", {
      model: "us.anthropic.claude-opus-5",
      effort: "high",
    });
    expect(incompatible!.status).toBe(400);
    expect(await incompatible!.json()).toMatchObject({
      error: expect.stringContaining("not available for the selected agent connection"),
    });
  });

  test("reports only the signed-in user's agent usage", async () => {
    const now = new Date();
    const startedAt = new Date(now.getTime() - 2_000);
    const base = {
      accountLabel: "Host Claude runtime",
      authSource: "host" as const,
      provider: "claude",
      source: "task" as const,
      status: "success" as const,
      startedAt,
      finishedAt: now,
      tokens: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 40,
      },
    };
    app.agentUsage.record({ ...base, userId: "admin" });
    app.agentUsage.record({ ...base, userId: "operator" });

    const response = await get("/api/me/agent-usage?days=7&account=host&source=task");
    expect(response!.status).toBe(200);
    expect(response!.headers.get("cache-control")).toContain("private");
    const report = await response!.json() as {
      totals: { invocations: number; tokens: { inputTokens: number } };
      events: Array<{ accountLabel: string }>;
      eventCount: number;
    };
    expect(report.eventCount).toBe(1);
    expect(report.totals).toMatchObject({ invocations: 1, tokens: { inputTokens: 10 } });
    expect(report.events).toEqual([
      expect.objectContaining({ accountLabel: "Host Claude runtime" }),
    ]);

    const global = await get("/api/admin/agent-usage?days=7&account=host&source=task");
    expect(global!.status).toBe(200);
    const globalReport = await global!.json() as {
      eventCount: number;
      events: Array<{ user: { id: string; name: string } }>;
    };
    expect(globalReport.eventCount).toBe(2);
    expect(globalReport.events.map((event) => event.user.id).sort()).toEqual([
      "admin",
      "operator",
    ]);

    const operatorCookie = (await app.auth.login(
      "operator@talos.local",
      "talos-operator",
    ))!.cookie.split(";")[0]!;
    const denied = await handleApiRequest(
      new Request("http://localhost/api/admin/agent-usage?days=7", {
        headers: { cookie: operatorCookie },
      }),
      app,
    );
    expect(denied!.status).toBe(403);
  });

  test("disables public registration", async () => {
    const registration = await handleApiRequest(
      new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Dvi Dev",
          email: "dvi@example.com",
          password: "long-password",
        }),
      }),
      app,
    );
    expect(registration!.status).toBe(403);
    expect(await registration!.json()).toMatchObject({
      error: expect.stringContaining("administrator"),
    });
  });

  test("invites an administrator-created user to choose their own password", async () => {
    const created = await send("/api/admin/users", "POST", {
      name: "Invited User",
      email: "invited@example.com",
      roleId: "qa",
    });
    expect(created!.status).toBe(201);
    const invitation = (await created!.json()) as {
      user: { id: string; accountStatus: string };
      invitationUrl: string;
      expiresAt: string;
    };
    expect(invitation.user.accountStatus).toBe("pending");
    expect(invitation.invitationUrl).toStartWith(
      "http://localhost/accept-invite#token=",
    );
    expect(Date.parse(invitation.expiresAt)).toBeGreaterThan(Date.now());
    expect(await app.auth.login("invited@example.com", "chosen-password")).toBeNull();
    expect(
      ((await bodyOf("/api/users")) as { users: { id: string }[] }).users
        .some((user) => user.id === invitation.user.id),
    ).toBe(false);

    const token = decodeURIComponent(invitation.invitationUrl.split("#token=")[1]!);
    const inspectionDb = new Database(join(dir, "test.db"), { readonly: true });
    const storedToken = inspectionDb
      .query<{ token_hash: string }, [string]>(
        "SELECT token_hash FROM auth_invitation_tokens WHERE user_id = ?",
      )
      .get(invitation.user.id);
    inspectionDb.close();
    expect(storedToken?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedToken?.token_hash).not.toBe(token);

    const accepted = await handleApiRequest(
      new Request("http://localhost/api/auth/accept-invitation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password: "chosen-password" }),
      }),
      app,
    );
    expect(accepted!.status).toBe(200);
    expect(accepted!.headers.get("set-cookie")).toContain("talos_session=");
    expect((await accepted!.json()) as { user: { email: string } }).toMatchObject({
      user: { email: "invited@example.com" },
    });

    expect(await app.auth.login("invited@example.com", "chosen-password")).not.toBeNull();
    expect(app.auth.profile(invitation.user.id)?.accountStatus).toBe("active");
    expect(
      ((await bodyOf("/api/users")) as { users: { id: string }[] }).users
        .some((user) => user.id === invitation.user.id),
    ).toBe(true);

    const reused = await handleApiRequest(
      new Request("http://localhost/api/auth/accept-invitation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password: "different-password" }),
      }),
      app,
    );
    expect(reused!.status).toBe(400);
  });

  test("regenerating an invitation revokes the previous link", async () => {
    const first = app.auth.createInvitedUser({
      name: "Pending User",
      email: "pending@example.com",
      roleId: "qa",
    });
    const second = app.auth.createInvitation(first.user.id);

    expect(await app.auth.acceptInvitation(first.token, "chosen-password")).toBeNull();
    expect(await app.auth.acceptInvitation(second.token, "chosen-password")).not.toBeNull();
  });

  test("does not present an expired invitation as live", async () => {
    const invitation = app.auth.createInvitedUser({
      name: "Expired Invite",
      email: "expired-invite@example.com",
      roleId: "qa",
    });
    const db = new Database(join(dir, "test.db"));
    db.run(
      "UPDATE auth_invitation_tokens SET expires_at = ? WHERE user_id = ?",
      [new Date(Date.now() - 1_000).toISOString(), invitation.user.id],
    );
    db.close();

    expect(app.auth.invitationExpiresAt(invitation.user.id)).toBeNull();
    const users = (await bodyOf("/api/admin/users")).users as Array<{
      id: string;
      accountStatus: string;
      invitationExpiresAt?: string;
    }>;
    expect(users.find((user) => user.id === invitation.user.id)).toEqual(
      expect.objectContaining({ accountStatus: "pending" }),
    );
    expect(users.find((user) => user.id === invitation.user.id))
      .not.toHaveProperty("invitationExpiresAt");
  });

  test("persists invited accounts and rejects duplicates", async () => {
    const role = app.roles.create({
      name: "Persistent log reader",
      permissions: ["application-logs:read"],
    });
    await createActiveUser({
      name: "Dvi Dev",
      email: "dvi@example.com",
      password: "long-password",
      roleId: role.id,
    });

    app.close();
    app = await createApp({ config: join(dir, "talos.yaml") });
    app.logger = app.logger.child({}, { level: "fatal" });
    const login = await app.auth.login("dvi@example.com", "long-password");
    expect(login?.user.email).toBe("dvi@example.com");
    expect(login?.user.permissions).toEqual(["application-logs:read"]);

    expect(
      () => app.auth.createInvitedUser({
        name: "Other User",
        email: "dvi@example.com",
        roleId: "qa",
      }),
    ).toThrow("email address");
  });

  test("revokes every active session after password recovery", async () => {
    await createActiveUser({
      name: "Reset User",
      email: "reset@example.com",
      password: "old-password",
      roleId: "qa",
    });
    const session = await app.auth.login("reset@example.com", "old-password");
    const token = app.auth.requestPasswordReset("reset@example.com");
    expect(token).not.toBeNull();
    expect(await app.auth.resetPassword(token!, "new-password")).toBe(true);

    const oldSession = await handleApiRequest(
      new Request("http://localhost/api/tasks", {
        headers: { cookie: session!.cookie.split(";")[0]! },
      }),
      app,
    );
    expect(oldSession!.status).toBe(401);
    expect(await app.auth.login("reset@example.com", "old-password")).toBeNull();
    expect(await app.auth.login("reset@example.com", "new-password")).not.toBeNull();
  });

  test("only the creator can see or open a private loop", async () => {
    const created = await send("/api/tasks", "POST", {
      definitionId: "gitlab-ci-failure",
      name: "Admin private loop",
      visibility: "private",
      params: {
        gitlab: { projectId: "acme/private" },
        jira: { project: "SEC" },
      },
    });
    const privateTask = (await created!.json()) as { id: string };
    const operatorCookie = (await app.auth.login(
      "operator@talos.local",
      "talos-operator",
    ))!
      .cookie.split(";")[0]!;

    const operatorList = await handleApiRequest(
      new Request("http://localhost/api/tasks", { headers: { cookie: operatorCookie } }),
      app,
    );
    const listBody = (await operatorList!.json()) as { tasks: { id: string }[] };
    expect(listBody.tasks.some((task) => task.id === privateTask.id)).toBe(false);

    const operatorDetail = await handleApiRequest(
      new Request(`http://localhost/api/tasks/${privateTask.id}`, {
        headers: { cookie: operatorCookie },
      }),
      app,
    );
    expect(operatorDetail!.status).toBe(404);
    expect(app.instances.get(privateTask.id)?.ownerId).toBe("admin");
  });

  test("does not let QA users edit another user's public loop", async () => {
    const created = await send("/api/tasks", "POST", {
      definitionId: "gitlab-mr-follow-up",
      name: "Admin public loop",
      visibility: "public",
      params: {},
    });
    const task = (await created!.json()) as { id: string };
    const operatorCookie = (await app.auth.login(
      "operator@talos.local",
      "talos-operator",
    ))!.cookie.split(";")[0]!;

    const update = await handleApiRequest(
      new Request(`http://localhost/api/tasks/${task.id}`, {
        method: "PUT",
        headers: { cookie: operatorCookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Hijacked loop" }),
      }),
      app,
    );
    expect(update!.status).toBe(403);

    const schedule = await handleApiRequest(
      new Request(`http://localhost/api/tasks/${task.id}/schedule`, {
        method: "PUT",
        headers: { cookie: operatorCookie, "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      app,
    );
    expect(schedule!.status).toBe(403);
  });

  test("an invited account owns its private MR follow-up loop", async () => {
    const registered = await createActiveUser({
      name: "Example Developer",
      email: "dev@example.com",
      password: "long-test-password",
    });
    const cookie = registered.cookie.split(";")[0]!;
    const response = await handleApiRequest(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          definitionId: "gitlab-mr-follow-up",
          name: "Hourly MR follow-up",
          visibility: "private",
          params: {
            commit: {
              name: "Example Developer",
              email: "dev@example.com",
            },
          },
          schedule: {
            enabled: true,
            trigger: { type: "cron", expression: "0 * * * *" },
          },
        }),
      }),
      app,
    );
    expect(response!.status).toBe(201);
    const created = (await response!.json()) as { id: string; schedule: string };
    expect(created.schedule).toBe("0 * * * *");
    expect(app.instances.get(created.id)).toMatchObject({
      visibility: "private",
      ownerId: registered.user.id,
    });
  });

  test("notifications for private tasks are not visible to other users", async () => {
    // Admin creates a private task
    const created = await send("/api/tasks", "POST", {
      definitionId: "gitlab-ci-failure",
      name: "Admin private task",
      visibility: "private",
      params: {
        gitlab: { projectId: "acme/private" },
        jira: { project: "SEC" },
      },
    });
    const privateTask = (await created!.json()) as { id: string };

    // Run the private task (this will create a task run)
    const runResponse = await send(`/api/tasks/${privateTask.id}/run`, "POST");
    expect(runResponse!.status).toBe(202);
    const runData = (await runResponse!.json()) as { executionId: string };

    // Create a notification linked to the task run
    const notification = app.notifications.create({
      kind: "test",
      title: "Draft MR TP-3020",
      body: "Test notification for private task",
      taskRunId: runData.executionId,
    });

    // Admin can see their own notification
    const adminNotificationsResp = await get("/api/notifications");
    expect(adminNotificationsResp!.status).toBe(200);
    const adminNotifications = (await adminNotificationsResp!.json()) as NotificationsBody;
    expect(adminNotifications.notifications).toBeDefined();
    expect(adminNotifications.notifications.some((n: { id: string }) => n.id === notification.id)).toBe(true);
    expect(adminNotifications.unreadCount).toBeGreaterThan(0);

    // Operator cannot see the admin's private task notification
    const operatorCookie = (await app.auth.login(
      "operator@talos.local",
      "talos-operator",
    ))!.cookie.split(";")[0]!;

    const operatorNotificationsResp = await handleApiRequest(
      new Request("http://localhost/api/notifications", { headers: { cookie: operatorCookie } }),
      app,
    );
    const operatorNotifications =
      (await operatorNotificationsResp!.json()) as NotificationsBody;
    expect(operatorNotifications.notifications.some((n: { id: string }) => n.id === notification.id)).toBe(false);

    // Mark all as read from operator's perspective should not affect admin's notification
    const markReadResp = await handleApiRequest(
      new Request("http://localhost/api/notifications/read-all", {
        method: "POST",
        headers: { cookie: operatorCookie },
      }),
      app,
    );
    expect(markReadResp!.status).toBe(200);

    // Admin's notification should still be unread
    const adminNotificationsAfter = await bodyOf("/api/notifications");
    const adminNotif = adminNotificationsAfter.notifications.find((n: { id: string }) => n.id === notification.id);
    expect(adminNotif).toBeDefined();
    expect(adminNotif.readAt).toBeUndefined();
  });
});

describe("POST /api/graph/ticket-action", () => {
  test("uses a per-fix target branch override in the queued job", async () => {
    app.fixIssueDefaults.set("admin", {
      projectId: "acme/webportal",
      targetBranch: "develop",
    });

    const response = (await send("/api/graph/ticket-action", "POST", {
      issueKey: "TP-123",
      action: "fix-issue",
      targetBranch: "release/next",
    }))!;

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      queued: true,
      message: "Queued a fix for TP-123 in acme/webportal off release/next.",
    });
    expect(app.jobs.byDedupeKey("manual:fix-issue:jira:TP-123")[0]?.params).toMatchObject({
      jira: { issueKey: "TP-123" },
      gitlab: { projectId: "acme/webportal", targetBranch: "release/next" },
    });
  });

  test("rejects an empty target branch override", async () => {
    app.fixIssueDefaults.set("admin", {
      projectId: "acme/webportal",
      targetBranch: "develop",
    });

    const response = (await send("/api/graph/ticket-action", "POST", {
      issueKey: "TP-124",
      action: "fix-issue",
      targetBranch: " ",
    }))!;

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "'targetBranch' must be a non-empty string.",
    });
  });

  test("keeps using the saved default when older callers omit the override", async () => {
    app.fixIssueDefaults.set("admin", {
      projectId: "acme/webportal",
      targetBranch: "develop",
    });

    const response = (await send("/api/graph/ticket-action", "POST", {
      issueKey: "TP-125",
      action: "fix-issue",
    }))!;

    expect(response.status).toBe(202);
    expect(app.jobs.byDedupeKey("manual:fix-issue:jira:TP-125")[0]?.params).toMatchObject({
      gitlab: { projectId: "acme/webportal", targetBranch: "develop" },
    });
  });

  test("validates and queues an E2E run for a linked merged merge request", async () => {
    app.pullRequests.detail = async () =>
      ({
        id: "gitlab:acme/webportal!77",
        provider: "gitlab",
        number: 77,
        title: "TP-126 checkout",
        state: "merged",
        sourceBranch: "TP-126-checkout",
        targetBranch: "develop",
        webUrl: "https://gitlab.com/acme/webportal/-/merge_requests/77",
        updatedAt: new Date(),
        description: "## Release notes\nCheckout works",
        commits: [],
        threads: [],
        pipelines: [],
        labels: [],
        issue: { key: "TP-126" },
      }) as unknown as Awaited<ReturnType<App["pullRequests"]["detail"]>>;

    const response = (await send("/api/graph/ticket-action", "POST", {
      issueKey: "TP-126",
      action: "e2e-test",
      pullRequest: { projectId: "acme/webportal", mrIid: 77 },
    }))!;

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      queued: true,
      message: "Queued a QA E2E test for TP-126 against acme/webportal!77.",
    });
    expect(
      app.jobs.byDedupeKey(
        "manual:e2e-test:jira:TP-126:mr:acme%2Fwebportal!77",
      )[0]?.params,
    ).toEqual({
      jira: { issueKey: "TP-126" },
      gitlab: { projectId: "acme/webportal", mrIid: 77 },
    });
  });

  test("refuses an E2E merge request linked to a different ticket", async () => {
    app.pullRequests.detail = async () =>
      ({
        state: "open",
        issue: { key: "TP-999" },
      }) as Awaited<ReturnType<App["pullRequests"]["detail"]>>;

    const response = (await send("/api/graph/ticket-action", "POST", {
      issueKey: "TP-127",
      action: "e2e-test",
      pullRequest: { projectId: "acme/webportal", mrIid: 78 },
    }))!;

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "acme/webportal!78 is not linked to TP-127.",
    });
  });

  test("queues a Playwright MR only from a completed structured webportal E2E run", async () => {
    const queued = app.jobs.enqueue({
      kind: "e2e-test",
      loopId: "fix-issue-actions",
      dedupeKey:
        "manual:e2e-test:jira:TP-129:mr:example-org%2Fwebapp!80",
      actorId: "admin",
      params: {
        jira: { issueKey: "TP-129" },
        gitlab: { projectId: "example-org/webapp", mrIid: 80 },
      },
    }).job!;
    const leased = app.jobs.lease({
      kinds: ["e2e-test"],
      owner: "test",
      leaseMs: 60_000,
    })!;
    const executionId = "e2e-export-source-run";
    expect(app.jobs.attachExecution(leased.id, leased.leaseToken!, executionId)).toBe(true);
    const startedAt = new Date();
    const finishedAt = new Date(startedAt.getTime() + 1);
    await app.sink.runStarted({
      executionId,
      taskId: "e2e-test",
      startedAt,
      dryRun: false,
      params: queued.params,
    });
    await app.sink.runFinished({
      executionId,
      taskId: "e2e-test",
      startedAt,
      finishedAt,
      durationMs: 1,
      status: "success",
      dryRun: false,
      params: queued.params,
      steps: [],
      result: {
        itemsSeen: 1,
        itemsProcessed: 1,
        itemsSkipped: 0,
        details: {
          verdict: "pass",
          summary: "Checkout works.",
          scenarios: [{
            name: "Checkout",
            outcome: "pass",
            detail: "Completed",
            evidence: [],
            automation: {
              portal: "main",
              preconditions: [],
              steps: [{ action: "click", target: "Checkout" }],
            },
          }],
          findings: [],
        },
      },
    });
    expect(app.jobs.complete(leased.id, leased.leaseToken!, { executionId })).toBe(true);
    app.pullRequests.detail = async () =>
      ({
        issue: { key: "TP-129" },
      }) as Awaited<ReturnType<App["pullRequests"]["detail"]>>;

    const response = await send("/api/e2e/test-mr", "POST", {
      sourceJobId: queued.id,
      targetBranch: "develop",
    });
    expect(response!.status).toBe(202);
    expect(await response!.json()).toMatchObject({ queued: true });
    expect(
      app.jobs.byDedupeKey(
        `manual:write-e2e-test:jira:TP-129:e2e-job:${queued.id}`,
      )[0],
    ).toMatchObject({
      kind: "write-e2e-test",
      params: { sourceJobId: queued.id, targetBranch: "develop" },
      actorId: "admin",
    });
  });

  test("serves E2E evidence only through an authenticated MR access check", async () => {
    const queued = app.jobs.enqueue({
      kind: "e2e-test",
      loopId: "fix-issue-actions",
      dedupeKey: "manual:e2e-test:jira:TP-128:mr:acme%2Fwebportal!79",
      actorId: "admin",
      params: {
        jira: { issueKey: "TP-128" },
        gitlab: { projectId: "acme/webportal", mrIid: 79 },
      },
    }).job!;
    const leased = app.jobs.lease({
      kinds: ["e2e-test"],
      owner: "test",
      leaseMs: 60_000,
    })!;
    expect(app.jobs.attachExecution(leased.id, leased.leaseToken!, "e2e-artifact-run")).toBe(true);
    const artifactDirectory = await app.e2eArtifacts.prepare("e2e-artifact-run");
    await Bun.write(join(artifactDirectory, "checkout.png"), new Uint8Array([1, 2, 3]));
    let authorizations = 0;
    app.pullRequests.detail = async () => {
      authorizations++;
      return {} as Awaited<ReturnType<App["pullRequests"]["detail"]>>;
    };

    const response = await get(
      `/api/e2e/jobs/${encodeURIComponent(queued.id)}/artifacts/checkout.png`,
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("image/png");
    expect(response?.headers.get("cache-control")).toContain("private");
    expect(authorizations).toBe(1);

    const traversal = await get(
      `/api/e2e/jobs/${encodeURIComponent(queued.id)}/artifacts/${encodeURIComponent("../qa.json")}`,
    );
    expect(traversal?.status).toBe(400);
  });
});

describe("GET /api/system", () => {
  test("reports version, paths and connector readiness", async () => {
    const body = await bodyOf("/api/system");

    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.configPath).toContain("talos.yaml");
    expect(body.schemaVersion).toBeGreaterThan(0);
    expect(body.connectors.map((c: { name: string }) => c.name)).toContain("gitlab");
    // Presence is reported, never the value.
    expect(JSON.stringify(body)).not.toContain("glpat");
  });
});

describe("GET /api/jira/users", () => {
  test("caches one assignable-user directory per project across picker searches", async () => {
    let calls = 0;
    app.jiraFor = () =>
      ({
        searchAssignableUsers: async (project: string, search: string) => {
          calls++;
          expect(project).toBe("TP");
          expect(search).toBe("");
          return [{ accountId: "account-1", displayName: "Alice Dev", active: true }];
        },
      }) as ReturnType<App["jiraFor"]>;

    const body = await bodyOf("/api/jira/users?project=tp&search=ali&selected=account-2");
    expect(body.users).toEqual([{ accountId: "account-1", displayName: "Alice Dev" }]);
    await bodyOf("/api/jira/users?project=TP&search=bob");
    expect(calls).toBe(1);
  });

  test("requires a project", async () => {
    const response = await get("/api/jira/users?search=ali");
    expect(response!.status).toBe(400);
  });

  test("uses and caches each signed-in user's own Jira identity", async () => {
    const seen: string[] = [];
    app.jiraFor = (actor) =>
      ({
        searchAssignableUsers: async () => {
          seen.push(actor.id);
          return [{ accountId: actor.id, displayName: actor.email, active: true }];
        },
        userByAccountId: async () => undefined,
      }) as unknown as ReturnType<App["jiraFor"]>;

    await createActiveUser({
      name: "QA Person",
      email: "qa-picker@example.com",
      password: "strong-password",
      roleId: "qa",
    });
    const qa = await app.auth.login("qa-picker@example.com", "strong-password");

    expect((await bodyOf("/api/jira/users?project=TP")).users[0].displayName).toBe(
      "admin@talos.local",
    );
    const qaResponse = await handleApiRequest(
      new Request("http://localhost/api/jira/users?project=TP", {
        headers: { cookie: qa!.cookie.split(";")[0]! },
      }),
      app,
    );
    expect(((await qaResponse!.json()) as { users: { displayName: string }[] }).users[0]!
      .displayName).toBe("qa-picker@example.com");
    expect(new Set(seen).size).toBe(2);
  });
});

describe("GET /api/tasks", () => {
  test("lists every registered task, each with its schedule, next run and params schema", async () => {
    const body = await bodyOf("/api/tasks");

    const ids = body.tasks.map((t: { id: string }) => t.id);
    expect(ids).toContain("automation-report-sync");
    expect(ids).toContain("gitlab-ci-failure");
    expect(ids).toContain("example-task");
    expect(ids).toContain("automation-report-sync");
    expect(body.total).toBe(ids.length);

    const ci = body.tasks.find((t: { id: string }) => t.id === "gitlab-ci-failure");
    expect(ci.schedule).toBe("0 7 * * *");
    expect(ci.nextRun).toMatch(/^\d{4}-/);
    expect(ci.enabled).toBe(false);
    expect(ci.kind).toBe("loop");
    expect(ci.instantiable).toBe(true);
    expect(ci.usesGitLab).toBe(true);
    expect(ci.usesJira).toBe(true);

    const review = body.tasks.find((t: { id: string }) => t.id === "gitlab-code-review");
    expect(review.usesGitLab).toBe(true);
    expect(review.usesJira).toBe(false);
    expect(review.gitlabMr).toBeUndefined();
    expect(review.jiraIssue).toBeUndefined();

    const requested = body.tasks.find((t: { id: string }) => t.id === "gitlab-review-requested");
    expect(requested.kind).toBe("loop");
    expect(requested.instantiable).toBe(true);
    expect(requested.usesGitLab).toBe(true);
    expect(requested.usesJira).toBe(false);
    expect(requested.schedule).toBe("*/15 * * * *");
    expect(requested.enabled).toBe(false);

    const followUp = body.tasks.find((t: { id: string }) => t.id === "gitlab-mr-follow-up");
    expect(followUp.kind).toBe("loop");
    expect(followUp.schedule).toBe("0 * * * *");
    expect(followUp.usesGitLab).toBe(true);

    const task = body.tasks.find((t: { id: string }) => t.id === "example-task");
    const names = task.paramsSchema.map((f: { name: string }) => f.name);
    expect(names).toEqual(["message", "repeat"]);
    expect(task.kind).toBe("task");
    expect(task.instantiable).toBe(false);
    expect(task.usesGitLab).toBe(false);
    expect(task.usesJira).toBe(false);
    expect(task.createdAt).toBeUndefined();
  });

  test("filters on ?q= across id, name and description", async () => {
    const body = await bodyOf("/api/tasks?q=ci-failure");
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe("gitlab-ci-failure");
    // `total` stays the unfiltered count, so the UI can say "1 of N".
    expect(body.total).toBeGreaterThan(1);
  });

  test("returns an empty list rather than an error when nothing matches", async () => {
    const body = await bodyOf("/api/tasks?q=zzz");
    expect(body.tasks).toEqual([]);
    expect(body.total).toBeGreaterThan(0);
  });

  test("supports bounded stable pages", async () => {
    const first = await bodyOf("/api/tasks?limit=2&offset=0");
    const second = await bodyOf("/api/tasks?limit=2&offset=2");
    expect(first.tasks).toHaveLength(2);
    expect(second.tasks).toHaveLength(2);
    expect(second.tasks.map((task: { id: string }) => task.id)).not.toEqual(
      first.tasks.map((task: { id: string }) => task.id),
    );
    expect(first.total).toBe(second.total);
  });
});

describe("POST /api/tasks", () => {
  test("creates a named instance of an instantiable definition, registered immediately", async () => {
    const response = await send("/api/tasks", "POST", {
      definitionId: "gitlab-ci-failure",
      name: "CI failures",
      params: {
        gitlab: { projectId: "acme/webportal-2" },
        jira: { project: "WP2" },
      },
      schedule: { enabled: true, trigger: { type: "cron", expression: "0 8 * * *" } },
    });
    expect(response!.status).toBe(201);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await response!.json();
    expect(isGeneratedId(body.id)).toBe(true);
    expect(body.kind).toBe("loop");
    expect(body.schedule).toBe("0 8 * * *");
    expect(body.params.gitlab.projectId).toBe("acme/webportal-2");
    expect(body.createdAt).toMatch(/^\d{4}-/);

    // Registered immediately — no restart needed to see it in the list.
    const list = await bodyOf("/api/tasks");
    const ids = list.tasks.map((t: { id: string }) => t.id);
    expect(ids).toContain(body.id);
  });

  test("two instances with the same name get distinct ids", async () => {
    const first = await send("/api/tasks", "POST", {
      definitionId: "gitlab-ci-failure",
      name: "Nightly loop",
      params: { gitlab: { projectId: "a" }, jira: { project: "A" } },
    });
    expect(first!.status).toBe(201);

    const second = await send("/api/tasks", "POST", {
      definitionId: "gitlab-ci-failure",
      name: "Nightly loop",
      params: { gitlab: { projectId: "b" }, jira: { project: "B" } },
    });
    expect(second!.status).toBe(201);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a: any = await first!.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = await second!.json();
    expect(isGeneratedId(a.id)).toBe(true);
    expect(isGeneratedId(b.id)).toBe(true);
    expect(a.id).not.toBe(b.id);
  });

  test("creates a gitlab-review-requested loop with optional filters", async () => {
    const response = await send("/api/tasks", "POST", {
      definitionId: "gitlab-review-requested",
      name: "Review requests (acme)",
      params: { gitlab: { group: "acme" } },
      schedule: { enabled: true, trigger: { type: "cron", expression: "*/2 * * * *" } },
    });
    expect(response!.status).toBe(201);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await response!.json();
    expect(body.kind).toBe("loop");
    expect(body.schedule).toBe("*/2 * * * *");
    expect(body.params.gitlab.group).toBe("acme");
    expect(body.usesGitLab).toBe(true);
    expect(body.usesJira).toBe(false);
  });

  test("exposes GitLab MR and Jira links on a scoped code-review instance", async () => {
    const response = await send("/api/tasks", "POST", {
      definitionId: "gitlab-code-review",
      name: "MR review (!42)",
      params: {
        gitlab: { projectId: "acme/web", mrIid: 42, jiraIssueKey: "TP-9" },
      },
    });
    expect(response!.status).toBe(201);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created: any = await response!.json();
    expect(created.gitlabMr).toEqual({
      iid: 42,
      url: "https://gitlab.com/acme/web/-/merge_requests/42",
    });
    expect(created.jiraIssue.key).toBe("TP-9");
    if (created.jiraIssue.url != null) {
      expect(created.jiraIssue.url).toMatch(/\/browse\/TP-9$/);
    }
    expect(created.usesJira).toBe(true);

    const list = await bodyOf("/api/tasks");
    const row = list.tasks.find((t: { id: string }) => t.id === created.id);
    expect(row.gitlabMr).toEqual(created.gitlabMr);
    expect(row.jiraIssue).toEqual(created.jiraIssue);
  });

  test("updates and clears a code-review loop's prompt override", async () => {
    const response = await send("/api/tasks", "POST", {
      definitionId: "gitlab-code-review",
      name: "Custom review",
      params: { gitlab: { projectId: "acme/web", mrIid: 42 } },
    });
    expect(response!.status).toBe(201);
    const created = (await response!.json()) as { id: string; promptTemplate?: string };
    expect(created.promptTemplate).toBeUndefined();

    const updated = await send(`/api/tasks/${created.id}`, "PUT", {
      promptTemplate: "Review {{scope}} using {{context}}.",
    });
    expect(updated!.status).toBe(200);
    const updatedBody = (await updated!.json()) as { promptTemplate?: string };
    expect(updatedBody.promptTemplate).toBe(
      "Review {{scope}} using {{context}}.",
    );
    expect(app.instances.get(created.id)?.promptTemplate).toBe(
      "Review {{scope}} using {{context}}.",
    );

    const reset = await send(`/api/tasks/${created.id}`, "PUT", {
      promptTemplate: null,
    });
    expect(reset!.status).toBe(200);
    const resetBody = (await reset!.json()) as { promptTemplate?: string };
    expect(resetBody.promptTemplate).toBeUndefined();
    expect(app.instances.get(created.id)?.promptTemplate).toBeUndefined();
  });

  test("rejects a definitionId that isn't instantiable", async () => {
    const response = await send("/api/tasks", "POST", {
      definitionId: "example-task",
      name: "Not allowed",
    });
    expect(response!.status).toBe(400);
  });

  test("rejects an unknown definitionId", async () => {
    const response = await send("/api/tasks", "POST", {
      definitionId: "nope",
      name: "Not allowed",
    });
    expect(response!.status).toBe(400);
  });

  test("rejects a missing name", async () => {
    const response = await send("/api/tasks", "POST", {
      definitionId: "gitlab-ci-failure",
      params: { gitlab: { projectId: "a" }, jira: { project: "A" } },
    });
    expect(response!.status).toBe(400);
  });

  test("rejects params that fail the definition's own schema", async () => {
    const response = await send("/api/tasks", "POST", {
      definitionId: "gitlab-ci-failure",
      name: "Bad params",
      params: { gitlab: { projectId: "" } }, // empty project id is invalid
    });
    expect(response!.status).toBe(400);
  });
});

describe("GET /api/search", () => {
  /**
   * Both halves of a search read a forge as the asking developer, so both
   * services are stubbed: the assertions are about matching and ranking, and live
   * reads would make this a test of whichever tokens are in the environment.
   */
  beforeEach(() => {
    app.assignedTickets = {
      list: async () => ({
        tickets: [
          {
            key: "TP-3018",
            summary: "Checkout total is wrong for a discounted cart",
            url: "https://jira.example.com/browse/TP-3018",
            status: "In progress",
            statusCategory: "indeterminate",
            type: "Bug",
            labels: [],
            sprints: [],
          },
          {
            key: "TP-77",
            summary: "Add a checkout smoke test",
            url: "https://jira.example.com/browse/TP-77",
            status: "To do",
            statusCategory: "new",
            type: "Task",
            labels: [],
            sprints: [],
          },
        ],
      }),
    } as unknown as App["assignedTickets"];

    app.pullRequests = {
      list: async (_actor: unknown, scope: string) => ({
        scope,
        states: ["opened"],
        repositoryFilter: [],
        pullRequests:
          scope === "mine"
            ? [
                {
                  provider: "gitlab",
                  id: "gitlab:acme/webportal!6193",
                  number: 6193,
                  title: "Fix the discounted cart total",
                  state: "opened",
                  sourceBranch: "fix/cart",
                  targetBranch: "main",
                  webUrl: "https://gitlab.example.com/acme/webportal/-/merge_requests/6193",
                  repository: "acme/webportal",
                  updatedAt: new Date(),
                },
              ]
            : [],
        unavailable: [],
        failed: [],
      }),
    } as unknown as App["pullRequests"];
  });

  test("returns nothing for an empty query rather than the whole world", async () => {
    const body = await bodyOf("/api/search");
    expect(body).toEqual({ tickets: [], pullRequests: [] });
  });

  test("matches tickets by summary", async () => {
    const body = await bodyOf("/api/search?q=discounted");
    expect(body.tickets.map((t: { key: string }) => t.key)).toEqual(["TP-3018"]);
    expect(body.tickets[0]).toMatchObject({
      key: "TP-3018",
      type: "Bug",
      status: "In progress",
      url: "https://jira.example.com/browse/TP-3018",
    });
  });

  test("matches merge requests by title, repository and number", async () => {
    const byTitle = await bodyOf("/api/search?q=discounted cart");
    expect(byTitle.pullRequests.map((pr: { number: number }) => pr.number)).toEqual([6193]);

    const byRepo = await bodyOf("/api/search?q=webportal");
    expect(byRepo.pullRequests).toHaveLength(1);

    const byNumber = await bodyOf("/api/search?q=6193");
    expect(byNumber.pullRequests).toHaveLength(1);
  });

  test("ranks a key match above a summary match, punctuation and all", async () => {
    const body = await bodyOf("/api/search?q=tp30");
    expect(body.tickets.map((t: { key: string }) => t.key)).toEqual(["TP-3018"]);

    // Both summaries say "checkout"; only the key match is allowed to jump the queue.
    const both = await bodyOf("/api/search?q=checkout");
    expect(both.tickets.map((t: { key: string }) => t.key)).toEqual(["TP-3018", "TP-77"]);
  });

  test("returns an empty result rather than an error when nothing matches", async () => {
    const body = await bodyOf("/api/search?q=zzz");
    expect(body).toEqual({ tickets: [], pullRequests: [] });
  });
});

describe("GET /api/tasks/:id", () => {
  test("carries history, watermark, ledger and params for a scheduled task", async () => {
    const body = await bodyOf("/api/tasks/gitlab-ci-failure");

    expect(body.id).toBe("gitlab-ci-failure");
    expect(body.watermark).toBeNull();
    expect(body.runs).toEqual([]);
    expect(body.issues).toEqual([]);
    expect(body.events).toMatchObject({ completed: 0, claimed: 0, failed: 0 });
    expect(body.params).toMatchObject({ gitlab: { projectId: "acme/webportal" } });
  });

  test("carries run history, empty for a never-run ad-hoc task", async () => {
    const body = await bodyOf("/api/tasks/example-task");
    expect(body.id).toBe("example-task");
    expect(body.runs).toEqual([]);
    expect(body.graph).toEqual({ nodes: [], edges: [] });
  });

  test("404s an unknown id", async () => {
    const response = (await get("/api/tasks/nope"))!;
    expect(response.status).toBe(404);
  });
});

describe("task schedule CRUD", () => {
  test("GET returns the effective schedule", async () => {
    const body = await bodyOf("/api/tasks/automation-report-sync/schedule");
    expect(body).toMatchObject({
      id: "automation-report-sync",
      enabled: true,
      trigger: { type: "cron", expression: "*/10 * * * *" },
    });
  });

  test("PUT merges a patch and persists it", async () => {
    const response = await send("/api/tasks/automation-report-sync/schedule", "PUT", {
      enabled: false,
      maxItemsPerRun: 42,
    });
    expect(response!.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await response!.json();
    expect(body.enabled).toBe(false);
    expect(body.maxItemsPerRun).toBe(42);
    // The trigger set in beforeEach survives an unrelated patch.
    expect(body.trigger).toMatchObject({ type: "cron", expression: "*/10 * * * *" });

    const persisted = await bodyOf("/api/tasks/automation-report-sync/schedule");
    expect(persisted.enabled).toBe(false);
  });

  test("PUT enabled on gitlab-review-requested stores its default cron, not manual", async () => {
    const response = await send("/api/tasks/gitlab-review-requested/schedule", "PUT", {
      enabled: true,
    });
    expect(response!.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await response!.json();
    expect(body.enabled).toBe(true);
    expect(body.trigger).toEqual({ type: "cron", expression: "*/15 * * * *" });
  });

  test("PUT rejects a params block that fails the task's own schema", async () => {
    const response = await send("/api/tasks/automation-report-sync/schedule", "PUT", {
      params: { itemCount: "not-a-number" },
    });
    expect(response!.status).toBe(400);
  });

  test("PUT on an unknown task 400s rather than silently creating a row", async () => {
    const response = await send("/api/tasks/nope/schedule", "PUT", { enabled: true });
    expect(response!.status).toBe(400);
  });

  test("DELETE clears the row, reverting to defaults", async () => {
    const response = await send("/api/tasks/automation-report-sync/schedule", "DELETE");
    expect(response!.status).toBe(200);

    const body = await bodyOf("/api/tasks/automation-report-sync/schedule");
    expect(body.enabled).toBe(false);
    expect(body.trigger).toEqual({ type: "cron", expression: "*/10 * * * *" });
  });

  test("PUT accepts a one-shot trigger and a cron with a first run", async () => {
    const once = await send("/api/tasks/automation-report-sync/schedule", "PUT", {
      trigger: { type: "once", at: "2026-12-01T08:00:00.000Z", timezone: "UTC" },
    });
    expect(once!.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onceBody: any = await once!.json();
    expect(onceBody.trigger).toEqual({
      type: "once",
      at: "2026-12-01T08:00:00.000Z",
      timezone: "UTC",
    });

    const listed = await bodyOf("/api/tasks");
    const loop = listed.tasks.find((t: { id: string }) => t.id === "automation-report-sync");
    expect(loop.onceAt).toBe("2026-12-01T08:00:00.000Z");
    expect(loop.timezone).toBe("UTC");

    const cron = await send("/api/tasks/automation-report-sync/schedule", "PUT", {
      trigger: {
        type: "cron",
        expression: "0 9 * * *",
        timezone: "Europe/Sofia",
        startAt: "2026-12-02T07:00:00.000Z",
      },
    });
    expect(cron!.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cronBody: any = await cron!.json();
    expect(cronBody.trigger).toMatchObject({
      type: "cron",
      expression: "0 9 * * *",
      startAt: "2026-12-02T07:00:00.000Z",
    });
  });

  test("PUT rejects an unknown trigger type", async () => {
    const response = await send("/api/tasks/automation-report-sync/schedule", "PUT", {
      trigger: { type: "webhook" },
    });
    expect(response!.status).toBe(400);
  });

  test("unsupported methods on the schedule route are refused", async () => {
    const response = await send("/api/tasks/automation-report-sync/schedule", "PATCH");
    expect(response!.status).toBe(405);
  });
});

describe("general settings CRUD", () => {
  test("GET returns the YAML defaults before anything is overridden", async () => {
    const body = await bodyOf("/api/settings");
    expect(body).toMatchObject({
      logLevel: "fatal",
      logLevelOrigin: "default",
      llmOrigin: "default",
    });
  });

  test("PUT merges a patch and persists it", async () => {
    const response = await send("/api/settings", "PUT", {
      logLevel: "debug",
      llm: { provider: "openai" },
    });
    expect(response!.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await response!.json();
    expect(body.logLevel).toBe("debug");
    expect(body.logLevelOrigin).toBe("db");
    expect(body.llm.provider).toBe("openai");

    const persisted = await bodyOf("/api/settings");
    expect(persisted.logLevel).toBe("debug");
    expect(persisted.llm.provider).toBe("openai");
  });

  test("setting a field to null reverts it to the YAML default", async () => {
    await send("/api/settings", "PUT", { logLevel: "debug" });
    await send("/api/settings", "PUT", { logLevel: null });

    const body = await bodyOf("/api/settings");
    expect(body.logLevel).toBe("fatal");
    expect(body.logLevelOrigin).toBe("default");
  });

  test("PUT persists the code-review model and effort", async () => {
    const response = await send("/api/settings", "PUT", {
      llm: { model: "opus", effort: "high" },
    });
    expect(response!.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await response!.json();
    expect(body.llm.model).toBe("opus");
    expect(body.llm.effort).toBe("high");
    expect(body.llmOrigin).toBe("db");

    const persisted = await bodyOf("/api/settings");
    expect(persisted.llm.model).toBe("opus");
    expect(persisted.llm.effort).toBe("high");
  });

  test("PUT rejects an unknown model or effort", async () => {
    expect((await send("/api/settings", "PUT", { llm: { model: "gpt-4" } }))!.status).toBe(400);
    expect((await send("/api/settings", "PUT", { llm: { effort: "ultra" } }))!.status).toBe(400);
  });

  test("PUT rejects an invalid log level", async () => {
    const response = await send("/api/settings", "PUT", { logLevel: "verbose" });
    expect(response!.status).toBe(400);
  });

  test("unsupported methods on the settings route are refused", async () => {
    const response = await send("/api/settings", "PATCH");
    expect(response!.status).toBe(405);
  });
});

describe("E2E test settings CRUD", () => {
  const runtimeConfig = `
webSettings {
  baseUrl = "https://qa.example.com"
  parentPortalUrl = "https://parent.qa.example.com"
  studentPortalUrl = "https://student.qa.example.com"
}
qaFixtureSettings {
  studentUsername = "student"
  studentPassword = "student-secret"
  parentEmail = "parent@example.com"
  parentPassword = "parent-secret"
}
userSettings {
  principalEmail = "principal@example.com"
  principalPass = "principal-secret"
}`;

  test("stores replacements and reverts each input independently", async () => {
    expect(await bodyOf("/api/settings/e2e-tests")).toMatchObject({
      agentInstructionsOverride: null,
      runtimeConfigOverride: null,
      additionalInstructions: null,
      secretsEnabled: true,
      runtimeConfigUnreadable: false,
      sources: {
        project: "example-org/qa/test-automation",
        ref: "main",
        agentInstructionsPath: ".claude/agents/qa-exploratory-tester.md",
        runtimeConfigPath: "core/src/main/resources/default.conf",
      },
    });

    const saved = await send("/api/settings/e2e-tests", "PUT", {
      agentInstructionsOverride: "# Replacement\nTest checkout.",
      runtimeConfigOverride: runtimeConfig,
      additionalInstructions: "Run the parent portal scenario first.",
    });
    expect(saved!.status).toBe(200);
    expect(await saved!.json()).toMatchObject({
      agentInstructionsOverride: "# Replacement\nTest checkout.",
      runtimeConfigOverride: runtimeConfig.trim(),
      additionalInstructions: "Run the parent portal scenario first.",
    });
    expect(app.e2eTestConfig.get()).toMatchObject({
      runtimeConfigOverride: runtimeConfig.trim(),
    });
    const inspectionDb = new Database(join(dir, "test.db"), { readonly: true });
    const stored = inspectionDb.query<{ runtime_config_override: string }, []>(
      "SELECT runtime_config_override FROM e2e_test_config WHERE id = 1",
    ).get();
    inspectionDb.close();
    expect(stored?.runtime_config_override).not.toContain("student-secret");
    expect(stored?.runtime_config_override).toStartWith("v2:");

    const reverted = await send("/api/settings/e2e-tests", "PUT", {
      runtimeConfigOverride: null,
    });
    expect(await reverted!.json()).toMatchObject({
      agentInstructionsOverride: "# Replacement\nTest checkout.",
      runtimeConfigOverride: null,
      additionalInstructions: "Run the parent portal scenario first.",
    });
  });

  test("rejects invalid runtime replacements before a job can use them", async () => {
    const response = await send("/api/settings/e2e-tests", "PUT", {
      runtimeConfigOverride: `
webSettings {
  baseUrl = "not a URL"
}`,
    });
    expect(response!.status).toBe(400);
    expect(await response!.json()).toMatchObject({
      error: expect.stringContaining("not a valid URL"),
    });
  });

  test("accepts the minimal runtime config with main portal credentials", async () => {
    const replacement = `
webSettings {
  baseUrl = "https://qa4.example.com"
}
userSettings {
  principalEmail = "principal@example.com"
  principalPass = "principal-password"
}`;
    const response = await send("/api/settings/e2e-tests", "PUT", {
      runtimeConfigOverride: replacement,
    });
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      runtimeConfigOverride: replacement.trim(),
    });
  });
});

describe("GET /api/tasks/:id/issues", () => {
  test("paginates tracked tickets while keeping task detail bounded", async () => {
    for (let index = 1; index <= 22; index++) {
      app.subjects.open({
        loopId: "gitlab-ci-failure",
        subjectKey: `spec:webportal:src/spec-${index}.ts`,
        fingerprint: `sig-${index}`,
        externalRef: `TP-${index}`,
        metadata: { title: `Spec ${index}` },
      });
    }

    const detail = await bodyOf("/api/tasks/gitlab-ci-failure");
    expect(detail.openIssues).toBe(22);
    expect(detail.issues).toHaveLength(15);

    const first = await bodyOf("/api/tasks/gitlab-ci-failure/issues?limit=10&offset=0");
    const second = await bodyOf("/api/tasks/gitlab-ci-failure/issues?limit=10&offset=10");
    const last = await bodyOf("/api/tasks/gitlab-ci-failure/issues?limit=10&offset=20");

    expect(first.total).toBe(22);
    expect(second.total).toBe(22);
    expect(last.total).toBe(22);
    expect(first.issues).toHaveLength(10);
    expect(second.issues).toHaveLength(10);
    expect(last.issues).toHaveLength(2);

    const firstKeys = new Set(first.issues.map((issue: { issueKey: string }) => issue.issueKey));
    expect(
      second.issues.every((issue: { issueKey: string }) => !firstKeys.has(issue.issueKey)),
    ).toBe(true);
  });

  test("adds Jira links and assignee avatars to CI-failure rows", async () => {
    app.subjects.open({
      loopId: "gitlab-ci-failure",
      subjectKey: "spec:webportal:src/example.spec.ts",
      fingerprint: "sig",
      externalRef: "TP-1842",
      metadata: { title: "Example spec failure" },
    });
    app.sharedJira = () =>
      ({
        issueUrl: (key: string) => `https://jira.example.com/browse/${key}`,
        searchIssues: async () => [
          {
            id: "1842",
            key: "TP-1842",
            fields: {
              assignee: {
                accountId: "alice",
                displayName: "Alice Example",
                emailAddress: "alice@example.com",
                avatarUrls: { "24x24": "https://jira.example.com/avatar/alice.png" },
              },
            },
          },
        ],
      }) as unknown as ReturnType<App["sharedJira"]>;

    const body = await bodyOf("/api/tasks/gitlab-ci-failure/issues?limit=15&offset=0");
    expect(body.issues[0]).toMatchObject({
      issueKey: "TP-1842",
      issueUrl: "https://jira.example.com/browse/TP-1842",
      assignee: {
        accountId: "alice",
        name: "Alice Example",
        email: "alice@example.com",
        avatarUrl: "https://jira.example.com/avatar/alice.png",
      },
    });
  });

  test("adds Jira links and assignee avatars to Datadog tracked rows", async () => {
    app.subjects.open({
      loopId: "datadog-scan",
      subjectKey: "datadog:jira:TP-2001",
      fingerprint: "fingerprint",
      externalRef: "TP-2001",
      metadata: { title: "checkout: payment capture failed" },
    });
    app.sharedJira = () =>
      ({
        issueUrl: (key: string) => `https://jira.example.com/browse/${key}`,
        searchIssues: async () => [
          {
            id: "2001",
            key: "TP-2001",
            fields: {
              assignee: {
                accountId: "bob",
                displayName: "Bob Example",
              },
            },
          },
        ],
      }) as unknown as ReturnType<App["sharedJira"]>;

    const body = await bodyOf("/api/tasks/datadog-scan/issues?limit=15&offset=0");
    expect(body.issues[0]).toMatchObject({
      issueKey: "TP-2001",
      issueUrl: "https://jira.example.com/browse/TP-2001",
      subject: "checkout: payment capture failed",
      assignee: { accountId: "bob", name: "Bob Example" },
    });
  });

  test("404s an unknown task", async () => {
    const response = (await get("/api/tasks/nope/issues?limit=15&offset=0"))!;
    expect(response.status).toBe(404);
  });
});

describe("POST /api/tasks/:id/run", () => {
  test("accepts the task with the given params and persists its completed record", async () => {
    const response = await send("/api/tasks/example-task/run", "POST", {
      message: "hi",
      repeat: 2,
    });
    expect(response!.status).toBe(202);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await response!.json();
    expect(isTaskRunStartedView(body)).toBe(true);
    expect(body.status).toBe("running");
    expect(body.steps).toEqual([]);
    await waitForRun(body.executionId);

    const detail = await bodyOf("/api/tasks/example-task");
    expect(detail.runs).toHaveLength(1);
    expect(detail.lastRun.status).toBe("success");
    expect(detail.graph.executionId).toBe(detail.lastRun.executionId);
  });

  test("invalid params 400 rather than running the task", async () => {
    const response = await send("/api/tasks/example-task/run", "POST", { repeat: "not-a-number" });
    expect(response!.status).toBe(400);

    const detail = await bodyOf("/api/tasks/example-task");
    expect(detail.runs).toEqual([]);
  });

  test("404s an unknown task", async () => {
    const response = await send("/api/tasks/nope/run", "POST", {});
    expect(response!.status).toBe(400);
  });

  test("unsupported methods on the run route are refused", async () => {
    const response = await send("/api/tasks/example-task/run", "PATCH");
    expect(response!.status).toBe(405);
  });

  test("an empty body reuses stored gitlab/jira params (UI Rerun)", async () => {
    const response = await send("/api/tasks/gitlab-ci-failure/run", "POST", {});
    expect(response!.status).not.toBe(400);
    const body = (await response!.json()) as { error?: string };
    expect(body.error ?? "").not.toMatch(/Invalid params/);
    await send("/api/tasks/gitlab-ci-failure/cancel", "POST");
  });

  test("an empty body on an instance reuses the params stored at create", async () => {
    const created = await send("/api/tasks", "POST", {
      definitionId: "gitlab-ci-failure",
      name: "CI failures",
      params: {
        gitlab: { projectId: "acme/webportal-2" },
        jira: { project: "WP2" },
      },
    });
    expect(created!.status).toBe(201);
    const { id } = (await created!.json()) as { id: string };

    const response = await send(`/api/tasks/${id}/run`, "POST", {});
    expect(response!.status).not.toBe(400);
    const body = (await response!.json()) as { error?: string };
    expect(body.error ?? "").not.toMatch(/Invalid params/);
    await send(`/api/tasks/${id}/cancel`, "POST");
  });
});

describe("GET /api/task-runs/:id/steps", () => {
  test("404s an unknown execution id", async () => {
    const response = (await get("/api/task-runs/task-nope/steps"))!;
    expect(response.status).toBe(404);
  });

  test("returns the steps of a real run", async () => {
    const run = await send("/api/tasks/example-task/run", "POST", { message: "hi" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executionId } = (await run!.json()) as any;

    await waitForRun(executionId);
    const body = await bodyOf(`/api/task-runs/${executionId}/steps`);
    expect(body.steps).toHaveLength(1);
    expect(Array.isArray(body.logs)).toBe(true);
  });

  test("returns persisted log lines for the run", async () => {
    const run = await send("/api/tasks/example-task/run", "POST", { message: "hi" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executionId } = (await run!.json()) as any;
    app.sink.appendLog(executionId, {
      ts: new Date("2026-08-21T00:00:00Z"),
      level: "info",
      step: "echo:1",
      message: "hello from the run",
    });

    const body = await bodyOf(`/api/task-runs/${executionId}/steps`);
    expect(body.logs).toContainEqual({
      id: expect.any(Number),
      ts: "2026-08-21T00:00:00.000Z",
      level: "info",
      step: "echo:1",
      message: "hello from the run",
    });
  });
});

describe("GET /api/task-runs/:id/jira-outcomes", () => {
  test("enriches string-only historical outcomes with links and current assignees", async () => {
    const startedAt = new Date("2026-09-21T08:35:37.000Z");
    const finishedAt = new Date("2026-09-21T08:35:48.000Z");
    await app.sink.runStarted({
      executionId: "historical-ci-run",
      taskId: "gitlab-ci-failure",
      startedAt,
      dryRun: false,
      params: {},
    });
    await app.sink.runFinished({
      executionId: "historical-ci-run",
      taskId: "gitlab-ci-failure",
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      status: "success",
      dryRun: false,
      params: {},
      steps: [],
      result: {
        itemsSeen: 1,
        itemsProcessed: 1,
        itemsSkipped: 0,
        details: {
          issues: ["filed TP-1842 src/all-practice-list.component.spec.ts"],
        },
      },
    });

    app.sharedJira = () =>
      ({
        issueUrl: (key: string) => `https://jira.example.com/browse/${key}`,
        searchIssues: async () => [
          {
            id: "1842",
            key: "TP-1842",
            fields: {
              assignee: { accountId: "alice", displayName: "Alice Example" },
            },
          },
        ],
      }) as unknown as ReturnType<App["sharedJira"]>;

    expect(await bodyOf("/api/task-runs/historical-ci-run/jira-outcomes")).toEqual({
      outcomes: [
        {
          action: "filed",
          issueKey: "TP-1842",
          issueUrl: "https://jira.example.com/browse/TP-1842",
          assignee: "Alice Example",
          file: "src/all-practice-list.component.spec.ts",
        },
      ],
    });
  });
});

describe("GET /api/task-runs/:id/logs", () => {
  test("returns only log rows after the supplied cursor", async () => {
    const run = await send("/api/tasks/example-task/run", "POST", { message: "hi" });
    const { executionId } = (await run!.json()) as { executionId: string };
    await waitForRun(executionId);
    app.sink.appendLog(executionId, {
      ts: new Date("2026-08-21T00:00:00Z"), level: "info", message: "first",
    });
    app.sink.appendLog(executionId, {
      ts: new Date("2026-08-21T00:00:01Z"), level: "info", message: "second",
    });

    const firstPage = await bodyOf(`/api/task-runs/${executionId}/logs?limit=1`);
    expect(firstPage.logs).toHaveLength(1);
    expect(firstPage.logs[0]?.id).toBeNumber();
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await bodyOf(
      `/api/task-runs/${executionId}/logs?afterLogId=${firstPage.nextCursor}&limit=100`,
    );
    expect(secondPage.logs).not.toContainEqual(firstPage.logs[0]);
    expect(secondPage.logs.every((line: { id: number }) => line.id > firstPage.nextCursor)).toBe(true);
    expect(secondPage.hasMore).toBe(false);
  });

  test("returns a bounded latest tail and pages backward", async () => {
    const run = await send("/api/tasks/example-task/run", "POST", { message: "hi" });
    const { executionId } = (await run!.json()) as { executionId: string };
    await waitForRun(executionId);
    for (const message of ["tail-a", "tail-b", "tail-c"]) {
      app.sink.appendLog(executionId, { ts: new Date(), level: "info", message });
    }

    const tail = await bodyOf(`/api/task-runs/${executionId}/logs?tail=1&limit=2`);
    expect(tail.logs.map((line: { message: string }) => line.message)).toEqual(["tail-b", "tail-c"]);
    expect(tail.hasOlder).toBe(true);

    const older = await bodyOf(
      `/api/task-runs/${executionId}/logs?beforeLogId=${tail.previousCursor}&limit=10`,
    );
    expect(older.logs.at(-1)?.message).toBe("tail-a");
    expect(older.logs.every((line: { id: number }) => line.id < tail.previousCursor)).toBe(true);
  });

  test("supports a metadata-only steps response for incremental clients", async () => {
    const run = await send("/api/tasks/example-task/run", "POST", { message: "hi" });
    const { executionId } = (await run!.json()) as { executionId: string };
    await waitForRun(executionId);
    const body = await bodyOf(`/api/task-runs/${executionId}/steps?logs=none`);
    expect(body.logs).toBeUndefined();
    expect(body.steps).toBeArray();
  });
});

describe("POST cancel", () => {
  test("cancels a live run started through the API", async () => {
    const hang: Task<Record<string, never>> = {
      id: "hang-task",
      kind: "task",
      name: "hang",
      paramsSchema: z.object({}),
      async run(ctx) {
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
        return EMPTY_RESULT;
      },
    };
    app.taskRegistry.register(hang);
    app.refresh();

    const running = send("/api/tasks/hang-task/run", "POST", {});
    for (let i = 0; i < 50 && !app.executor.isActive(app.sink.lastRun("hang-task")?.executionId ?? ""); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const cancel = await send("/api/tasks/hang-task/cancel", "POST");
    expect(cancel!.status).toBe(200);

    const run = await running;
    expect(run!.status).toBe(202);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await run!.json();
    expect(body.status).toBe("running");
    expect((await waitForRun(body.executionId)).status).toBe("cancelled");
  });

  test("closes an orphaned running row and refuses a finished one", async () => {
    await app.sink.runStarted({
      executionId: "orphan-1",
      taskId: "example-task",
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      dryRun: false,
      params: {},
    });

    const cancel = await send("/api/task-runs/orphan-1/cancel", "POST");
    expect(cancel!.status).toBe(200);
    expect(app.sink.getRun("orphan-1")?.status).toBe("cancelled");

    const missing = await send("/api/task-runs/nope/cancel", "POST");
    expect(missing!.status).toBe(404);

    const finished = await send("/api/tasks/example-task/run", "POST", { message: "hi" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executionId } = (await finished!.json()) as any;
    await waitForRun(executionId);
    const again = await send(`/api/task-runs/${executionId}/cancel`, "POST");
    expect(again!.status).toBe(409);
  });
});

describe("Automation API", () => {
  const report = {
    totalTime: 12,
    totalCount: 4,
    successCount: 3,
    failedCount: 1,
    skippedCount: 0,
    errorCount: 0,
  };

  function seedSchedule(scheduleId = 22): void {
    app.automation.upsertSchedule({
      projectId: "42",
      scheduleId,
      description: scheduleId === 22 ? "Nightly web" : "API smoke",
      ref: "main",
      cron: "0 2 * * *",
      cronTimezone: "UTC",
      nextRunAt: new Date(Date.now() + 86_400_000),
      active: true,
      syncedAt: new Date(),
    });
  }

  function seedPipeline(
    pipelineId: number,
    overrides: Partial<AutomationPipelineSnapshot> = {},
  ): void {
    const updatedAt = new Date(Date.now() - pipelineId * 1_000);
    app.automation.recordPipeline({
      projectId: "42",
      pipelineId,
      scheduleId: 22,
      status: "success",
      ref: "main",
      sha: `sha-${pipelineId}`,
      webUrl: `https://gitlab.example/acme/web/-/pipelines/${pipelineId}`,
      createdAt: new Date(updatedAt.getTime() - 20_000),
      updatedAt,
      startedAt: new Date(updatedAt.getTime() - 15_000),
      finishedAt: updatedAt,
      duration: 15,
      reportState: "complete",
      reportVersion: 2,
      report: {
        totalTime: 4,
        totalCount: 1,
        successCount: 1,
        failedCount: 0,
        skippedCount: 0,
        errorCount: 0,
      },
      jobs: [],
      suites: [],
      failedTests: [],
      ...overrides,
    });
  }

  async function requestAsQa(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Response | null> {
    const qaCookie = (await app.auth.login(
      "operator@talos.local",
      "talos-operator",
    ))!.cookie.split(";")[0]!;
    return handleApiRequest(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          cookie: qaCookie,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      app,
    );
  }

  test("allows QA dashboard/detail reads but protects every config read and write", async () => {
    app.automationConfig.set({
      projectId: "42",
      schedules: [{ scheduleId: 22 }],
    });
    seedSchedule();
    seedPipeline(9001);

    expect((await requestAsQa("/api/automation/dashboard"))!.status).toBe(200);
    const detail = await requestAsQa("/api/automation/pipelines/9001");
    expect(detail!.status).toBe(200);
    expect(await detail!.json()).toMatchObject({ pipelineId: 9001 });

    for (const [path, method, body] of [
      ["/api/automation/config", "GET", undefined],
      ["/api/automation/config", "PUT", { projectId: "42", schedules: [] }],
      ["/api/automation/config/schedules?projectId=42", "GET", undefined],
      ["/api/automation/sync", "POST", {}],
    ] as const) {
      const response = await requestAsQa(path, method, body);
      expect(response!.status).toBe(403);
      expect(await response!.json()).toEqual({
        error: expect.stringMatching(/instance-settings/i),
      });
    }

    app.automationConfig.set({ projectId: "other/project", schedules: [] });
    expect((await requestAsQa("/api/automation/pipelines/9001"))!.status).toBe(404);
  });

  test("round-trips normalized admin config and validates the complete replacement", async () => {
    expect(await bodyOf("/api/automation/config")).toEqual({
      configured: false,
      projectId: null,
      schedules: [],
      jiraConfigured: false,
      jira: null,
    });

    const saved = await send("/api/automation/config", "PUT", {
      projectId: "  group/project  ",
      schedules: [
        {
          scheduleId: 90,
          displayName: "  Nightly browser  ",
          autoRetry: { enabled: true, maxJobsPerPipeline: 5 },
        },
        { scheduleId: 12, displayName: "   " },
      ],
    });
    expect(saved!.status).toBe(200);
    expect(await saved!.json()).toEqual({
      configured: true,
      projectId: "group/project",
      schedules: [
        {
          scheduleId: 90,
          displayName: "Nightly browser",
          autoRetry: { enabled: true, maxJobsPerPipeline: 5 },
        },
        {
          scheduleId: 12,
          autoRetry: { enabled: false, maxJobsPerPipeline: 3 },
        },
      ],
      jiraConfigured: false,
      jira: null,
    });
    expect(await bodyOf("/api/automation/config")).toEqual({
      configured: true,
      projectId: "group/project",
      schedules: [
        {
          scheduleId: 90,
          displayName: "Nightly browser",
          autoRetry: { enabled: true, maxJobsPerPipeline: 5 },
        },
        {
          scheduleId: 12,
          autoRetry: { enabled: false, maxJobsPerPipeline: 3 },
        },
      ],
      jiraConfigured: false,
      jira: null,
    });

    const withJira = await send("/api/automation/config", "PUT", {
      projectId: "42",
      schedules: [],
      jira: {
        projectKey: " tp ",
        parentKey: " tp-100 ",
        boardId: 21,
        labels: ["talos", "automation"],
        assigneeMode: "fixed",
        fixedAssignee: " alice@example.com ",
      },
    });
    expect(withJira!.status).toBe(200);
    expect(await withJira!.json()).toEqual({
      configured: true,
      projectId: "42",
      schedules: [],
      jiraConfigured: true,
      jira: {
        projectKey: "TP",
        parentKey: "TP-100",
        issueType: "Bug",
        boardId: 21,
        useActiveSprint: true,
        labels: ["talos", "automation"],
        assigneeMode: "fixed",
        fixedAssignee: "alice@example.com",
      },
    });

    const cleared = await send("/api/automation/config", "PUT", {
      projectId: "42",
      schedules: [],
      jira: null,
    });
    expect(cleared!.status).toBe(200);
    expect(await cleared!.json()).toMatchObject({
      configured: true,
      jiraConfigured: false,
      jira: null,
    });

    for (const input of [
      { projectId: " ", schedules: [] },
      { projectId: "42", schedules: [{ scheduleId: 0 }] },
      {
        projectId: "42",
        schedules: [{ scheduleId: 22 }, { scheduleId: 22 }],
      },
      {
        projectId: "42",
        schedules: [
          {
            scheduleId: 22,
            autoRetry: { enabled: true, maxJobsPerPipeline: 21 },
          },
        ],
      },
      { projectId: "42", schedules: [], jira: { projectKey: "bad key" } },
      { projectId: "42", schedules: [], jira: { projectKey: "TP", boardId: 0 } },
      {
        projectId: "42",
        schedules: [],
        jira: { projectKey: "TP", labels: ["valid", "not valid"] },
      },
      {
        projectId: "42",
        schedules: [],
        jira: { projectKey: "TP", assigneeMode: "fixed" },
      },
    ]) {
      expect((await send("/api/automation/config", "PUT", input))!.status).toBe(400);
    }
  });

  test("discovers test schedules while excluding non-reporting maintenance", async () => {
    const previousExcluded = Bun.env.TALOS_AUTOMATION_EXCLUDED_SCHEDULE_IDS;
    Bun.env.TALOS_AUTOMATION_EXCLUDED_SCHEDULE_IDS = "99";
    try {
    const http = new FakeHttp([
      {
        match: "/api/v4/projects/group%2Fproject/pipeline_schedules",
        respond: {
          json: [
            {
              id: 22,
              description: "Nightly web",
              ref: "main",
              cron: "0 2 * * *",
              active: true,
            },
            {
              id: 23,
              description: "Manual smoke",
              ref: "release",
            },
            {
              id: 99,
              description: "Maintenance",
              ref: "main",
              cron: "0 1 * * *",
              active: true,
            },
          ],
        },
      },
    ]);
    app.sharedGitLab = () =>
      new GitLabClient({
        token: "shared-token",
        baseUrl: "https://gitlab.test/api/v4",
        fetch: http.fetch,
      });

    expect(
      await bodyOf(
        "/api/automation/config/schedules?projectId=group%2Fproject",
      ),
    ).toEqual({
      schedules: [
        {
          id: 22,
          description: "Nightly web",
          ref: "main",
          cron: "0 2 * * *",
          active: true,
        },
        {
          id: 23,
          description: "Manual smoke",
          ref: "release",
          cron: null,
          active: false,
        },
      ],
    });
    expect(http.calls[0]?.headers["private-token"]).toBe("shared-token");
    } finally {
      if (previousExcluded == null) delete Bun.env.TALOS_AUTOMATION_EXCLUDED_SCHEDULE_IDS;
      else Bun.env.TALOS_AUTOMATION_EXCLUDED_SCHEDULE_IDS = previousExcluded;
    }
  });

  test("aggregates explicit outcomes and filters while keeping full detail separate", async () => {
    app.automationConfig.set({
      projectId: "42",
      schedules: [
        { scheduleId: 22, displayName: "Web E2E" },
        { scheduleId: 23 },
      ],
    });
    seedSchedule(22);
    seedSchedule(23);
    seedPipeline(1);
    seedPipeline(2, {
      status: "failed",
      report,
      jobs: [
        {
          jobId: 501,
          name: "unit",
          stage: "test",
          status: "failed",
          failureReason: "script_failure",
          allowFailure: false,
          webUrl: "https://gitlab.example/jobs/501",
          duration: 12,
          report,
        },
      ],
      suites: [{ index: 0, name: "unit", buildIds: [501], ...report }],
      failedTests: [
        {
          suiteIndex: 0,
          caseIndex: 3,
          jobId: 501,
          status: "failed",
          name: "rejects an invalid card",
          classname: "checkout/payment.test.ts",
          executionTime: 0.25,
          systemOutput: "expected 400, got 500",
          stackTrace: "at checkout/payment.test.ts:42",
          attachmentJobId: 501,
          attachmentPath: "screenshots/failure shot.png",
          attachmentName: "failure shot.png",
          signatureKey: "0123456789abcdef0123456789abcdef",
          signatureTitle: "AssertionFailure: expected 400, got 500",
        },
      ],
    });
    seedPipeline(3, {
      status: "failed",
      report: {
        totalTime: 0,
        totalCount: 0,
        successCount: 0,
        failedCount: 0,
        skippedCount: 0,
        errorCount: 0,
      },
    });
    seedPipeline(4, { status: "running", reportState: "pending", report: undefined });
    seedPipeline(5, { status: "canceled", reportState: "pending", report: undefined });
    seedPipeline(6, { reportState: "missing", report: undefined });
    seedPipeline(7, { reportState: "error", report: undefined });
    seedPipeline(8, {
      scheduleId: 23,
      report: {
        ...report,
        successCount: 4,
        failedCount: 0,
      },
    });
    seedPipeline(8000, {
      scheduleId: 23,
      updatedAt: new Date(Date.now() - 40 * 86_400_000),
    });

    const dashboard = await bodyOf("/api/automation/dashboard?days=7");
    expect(dashboard.totals).toMatchObject({
      pipelines: 8,
      outcomes: {
        passed: 2,
        "test-failed": 1,
        "infrastructure-failed": 1,
        running: 1,
        "canceled-skipped": 1,
        "report-missing": 1,
        "report-error": 1,
      },
      pipelineSuccessRate: 4 / 6,
      tests: { total: 9, passed: 8, failed: 1, skipped: 0, errors: 0 },
    });
    expect(dashboard.trend).toHaveLength(7);
    expect(
      dashboard.trend.reduce(
        (total: number, day: { tests: { total: number } }) => total + day.tests.total,
        0,
      ),
    ).toBe(9);
    expect(dashboard.scheduleTrends).toHaveLength(2);
    expect(
      dashboard.scheduleTrends.map(
        (schedule: {
          days: Array<{
            pipelineId: number | null;
            runCount: number;
            unstable: boolean;
            tests: { total: number } | null;
          }>;
        }) => schedule.days.at(-1),
      ),
    ).toEqual([
      expect.objectContaining({
        pipelineId: 1,
        runCount: 7,
        unstable: true,
        tests: { total: 1, passed: 1, failed: 0, skipped: 0, errors: 0 },
      }),
      expect.objectContaining({
        pipelineId: 8,
        runCount: 1,
        unstable: false,
        tests: { total: 4, passed: 4, failed: 0, skipped: 0, errors: 0 },
      }),
    ]);
    expect(dashboard.schedules.map((item: { scheduleId: number }) => item.scheduleId))
      .toEqual([22, 23]);
    expect(dashboard.schedules[1].latestPipeline.pipelineId).toBe(8);
    expect(dashboard.schedules[1].rangeStats).toMatchObject({
      pipelines: 1,
      tests: { total: 4, passed: 4 },
    });
    expect(dashboard.recentPipelines).toMatchObject({
      limit: 25,
      offset: 0,
      total: 8,
    });
    expect(dashboard.recentPipelines.items).toHaveLength(8);
    expect(JSON.stringify(dashboard)).not.toContain("expected 400, got 500");

    const filtered = await bodyOf(
      "/api/automation/dashboard?days=30&scheduleId=22&status=failed",
    );
    expect(filtered.totals.pipelines).toBe(2);
    expect(filtered.schedules).toHaveLength(1);
    expect(
      filtered.recentPipelines.items.map(
        (pipeline: { pipelineId: number }) => pipeline.pipelineId,
      ),
    ).toEqual([2, 3]);
    expect(
      filtered.recentPipelines.items.map(
        (pipeline: { scheduleName: string }) => pipeline.scheduleName,
      ),
    ).toEqual(["Web E2E", "Web E2E"]);

    const paged = await bodyOf(
      "/api/automation/dashboard?days=7&limit=2&offset=1",
    );
    expect(paged.recentPipelines).toMatchObject({
      limit: 2,
      offset: 1,
      total: 8,
    });
    expect(
      paged.recentPipelines.items.map(
        (pipeline: { pipelineId: number }) => pipeline.pipelineId,
      ),
    ).toEqual(
      dashboard.recentPipelines.items
        .slice(1, 3)
        .map((pipeline: { pipelineId: number }) => pipeline.pipelineId),
    );
    expect(
      (await get("/api/automation/dashboard?offset=not-a-number"))!.status,
    ).toBe(400);

    const detail = await bodyOf("/api/automation/pipelines/2");
    expect(detail).toMatchObject({
      pipelineId: 2,
      outcome: "test-failed",
      jobs: [{ jobId: 501, failureReason: "script_failure" }],
      suites: [{ index: 0, buildIds: [501] }],
      failedTests: [
        {
          caseIndex: 3,
          jobId: 501,
          systemOutput: null,
          stackTrace: null,
          attachmentName: "failure shot.png",
          attachmentUrl:
            "https://gitlab.example/acme/web/-/jobs/501/artifacts/file/" +
            "screenshots/failure%20shot.png",
          attachmentProxyUrl:
            "/api/automation/pipelines/2/failed-tests/0/3/attachment",
        },
      ],
    });
    expect((await get("/api/automation/pipelines/999999"))!.status).toBe(404);
  });

  test("lists compact clusters and lazily returns bounded diagnostics and members", async () => {
    app.automationConfig.set({
      projectId: "42",
      schedules: [{ scheduleId: 22, displayName: "Nightly web" }],
    });
    seedSchedule();
    seedPipeline(9200, {
      status: "failed",
      jobs: [
        {
          jobId: 501,
          name: "browser chrome",
          stage: "test",
          status: "failed",
          allowFailure: false,
          webUrl: "https://gitlab.example/acme/web/-/jobs/501",
        },
        {
          jobId: 502,
          name: "api integration",
          stage: "test",
          status: "failed",
          allowFailure: false,
          webUrl: "https://gitlab.example/acme/web/-/jobs/502",
        },
      ],
      suites: [
        { index: 0, name: "browser", buildIds: [501], ...report },
        { index: 1, name: "api", buildIds: [502], ...report },
      ],
      failedTests: [
        {
          suiteIndex: 0,
          caseIndex: 0,
          jobId: 501,
          status: "failed",
          name: "checkout rejects card",
          classname: "CheckoutSpec",
          executionTime: 1,
          systemOutput: "diagnostic must stay lazy",
          stackTrace: "at checkout.ts:42",
          attachmentJobId: 501,
          attachmentPath: "screenshots/failure.png",
          attachmentName: "failure.png",
          signatureKey: "root-cause-a",
          signatureTitle: "TypeError: unavailable",
        },
        {
          suiteIndex: 1,
          caseIndex: 0,
          jobId: 502,
          status: "error",
          name: "invoice reports failure",
          classname: "InvoiceSpec",
          executionTime: 1,
          signatureKey: "root-cause-a",
          signatureTitle: "TypeError: unavailable",
        },
        {
          suiteIndex: 0,
          caseIndex: 1,
          jobId: 501,
          status: "failed",
          name: "login works",
          classname: "LoginSpec",
          executionTime: 1,
          signatureKey: "root-cause-b",
          signatureTitle: "AssertionError: login",
        },
      ],
    });

    const directory = await requestAsQa("/api/users");
    expect(directory!.status).toBe(200);
    expect(await directory!.json()).toMatchObject({
      users: expect.arrayContaining([
        { id: "admin", name: "Admin", email: "admin@talos.local" },
        { id: "operator", name: "Operator", email: "operator@talos.local" },
      ]),
    });

    const assigned = await requestAsQa(
      "/api/automation/pipelines/9200/failure-clusters/root-cause-a/assignee",
      "PUT",
      { userId: "operator" },
    );
    expect(assigned!.status).toBe(200);
    expect(await assigned!.json()).toMatchObject({
      assignee: { id: "operator", name: "Operator" },
    });

    app.sharedGitLab = () =>
      ({
        countOpenMergeRequests: async (projectId: string) => {
          expect(projectId).toBe("42");
          return 4;
        },
        project: async () => ({
          web_url: "https://gitlab.example/acme/web",
        }),
      }) as unknown as ReturnType<App["sharedGitLab"]>;
    const inbox = await bodyOf(
      "/api/automation/failure-inbox?days=30&presence=current&limit=25",
    );
    expect(inbox).toMatchObject({
      days: 30,
      presence: "current",
      total: 2,
      facets: {
        current: 2,
        recent: 2,
        openMergeRequests: 4,
        openMergeRequestsUrl:
          "https://gitlab.example/acme/web/-/merge_requests" +
          "?sort=updated_desc&state=opened&first_page_size=100",
      },
    });
    expect(inbox.items[0]).toMatchObject({
      scheduleId: 22,
      scheduleName: "Nightly web",
      latestPipelineId: 9200,
      current: true,
      assignee: { id: "operator", name: "Operator" },
      triageState: "untriaged",
    });
    expect(JSON.stringify(inbox)).not.toContain("diagnostic must stay lazy");

    const first = await bodyOf(
      "/api/automation/pipelines/9200/failure-clusters?limit=1&offset=0",
    );
    expect(first).toMatchObject({
      pipelineId: 9200,
      limit: 1,
      offset: 0,
      total: 2,
      items: [
        {
          signatureKey: "root-cause-a",
          severity: "error",
          occurrenceCount: 2,
          triageState: "untriaged",
          ticketRefusal: "Automation Jira ticketing is not configured.",
        },
      ],
    });
    expect(JSON.stringify(first)).not.toContain("diagnostic must stay lazy");

    const searched = await bodyOf(
      "/api/automation/pipelines/9200/failure-clusters" +
        "?search=api%20integration&jobId=502&suiteIndex=1",
    );
    expect(searched.items.map((item: { signatureKey: string }) => item.signatureKey))
      .toEqual(["root-cause-a"]);

    const detail = await bodyOf(
      "/api/automation/pipelines/9200/failure-clusters/root-cause-a",
    );
    expect(detail).toMatchObject({
      signatureKey: "root-cause-a",
      members: [
        {
          status: "error",
          name: "invoice reports failure",
        },
        {
          name: "checkout rejects card",
          attachmentProxyUrl:
            "/api/automation/pipelines/9200/failed-tests/0/0/attachment",
        },
      ],
      representative: {
        suiteIndex: 0,
        caseIndex: 0,
        systemOutput: "diagnostic must stay lazy",
        stackTrace: "at checkout.ts:42",
      },
    });
    expect(
      (await get(
        "/api/automation/pipelines/9200/failure-clusters/missing",
      ))!.status,
    ).toBe(404);
    expect(
      (await get(
        "/api/automation/pipelines/9200/failure-clusters?offset=100001",
      ))!.status,
    ).toBe(400);

    const cleared = await requestAsQa(
      "/api/automation/pipelines/9200/failure-clusters/root-cause-a/assignee",
      "PUT",
      { userId: null },
    );
    expect(await cleared!.json()).toEqual({ assignee: null });
    const unknown = await requestAsQa(
      "/api/automation/pipelines/9200/failure-clusters/root-cause-a/assignee",
      "PUT",
      { userId: "missing-user" },
    );
    expect(unknown!.status).toBe(400);
  });

  test("allows QA ticket actions, persists the result, and enforces the bulk cap", async () => {
    app.automationConfig.set({
      projectId: "42",
      schedules: [{ scheduleId: 22, displayName: "Nightly web" }],
      jira: {
        projectKey: "QA",
        issueType: "Bug",
        useActiveSprint: true,
        labels: ["talos", "automation"],
        assigneeMode: "automatic",
      },
    });
    seedSchedule();
    seedPipeline(9300, {
      status: "failed",
      jobs: [
        {
          jobId: 501,
          name: "browser",
          stage: "test",
          status: "failed",
          allowFailure: false,
          webUrl: "https://gitlab.example/acme/web/-/jobs/501",
        },
      ],
      suites: [{ index: 0, name: "browser", buildIds: [501], ...report }],
      failedTests: [
        {
          suiteIndex: 0,
          caseIndex: 0,
          jobId: 501,
          status: "failed",
          name: "checkout rejects card",
          executionTime: 1,
          signatureKey: "ticket-signature",
          signatureTitle: "AssertionError: checkout",
        },
        {
          suiteIndex: 0,
          caseIndex: 1,
          jobId: 501,
          status: "failed",
          name: "checkout displays service error",
          executionTime: 1,
          signatureKey: "second-ticket-signature",
          signatureTitle: "TimeoutError: checkout service",
        },
      ],
    });
    let writes = 0;
    app.sharedGitLab = () =>
      ({
        listMergeRequests: async () => [],
      }) as unknown as ReturnType<App["sharedGitLab"]>;
    app.sharedJira = () =>
      ({
        myself: async () => ({ accountId: "integration-account" }),
        accountIdForEmail: async (value: string) => value,
        resolveActiveSprint: async () => ({ reason: "no active sprint" }),
        searchIssues: async () => [],
        createIssue: async () => {
          writes += 1;
          return { id: "100", key: "QA-100", self: "jira" };
        },
        issueUrl: (key: string) => `https://jira.test/browse/${key}`,
      }) as unknown as ReturnType<App["sharedJira"]>;

    const draft = await bodyOf(
      "/api/automation/pipelines/9300/failure-clusters/" +
        "ticket-signature/ticket",
    );
    expect(draft).toMatchObject({
      projectKey: "QA",
      parentKey: null,
      summary: "[Automation · Nightly web] AssertionError: checkout",
      description: expect.stringContaining("1 distinct test(s)"),
    });

    const response = await requestAsQa(
      "/api/automation/pipelines/9300/failure-clusters/bulk-ticket",
      "POST",
      {
        signatureKeys: ["ticket-signature", "second-ticket-signature"],
      },
    );
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      results: [
        {
          signatureKey: "ticket-signature",
          ok: true,
          result: {
            action: "created",
            triageState: "ticketed",
            jiraKey: "QA-100",
          },
        },
        {
          signatureKey: "second-ticket-signature",
          ok: true,
          result: {
            action: "created",
            triageState: "ticketed",
            jiraKey: "QA-100",
          },
        },
      ],
    });
    expect(writes).toBe(1);

    const existing = await requestAsQa(
      "/api/automation/pipelines/9300/failure-clusters/" +
        "ticket-signature/ticket",
      "POST",
      {
        summary: "Reviewed existing ticket",
        description: "Reviewed automation failure.",
        parentKey: null,
      },
    );
    expect(await existing!.json()).toMatchObject({
      action: "existing-ticket",
      jiraKey: "QA-100",
    });
    expect(writes).toBe(1);

    const capped = await requestAsQa(
      "/api/automation/pipelines/9300/failure-clusters/ticket",
      "POST",
      {
        signatureKeys: Array.from({ length: 21 }, (_, index) => `key-${index}`),
      },
    );
    expect(capped!.status).toBe(400);
    expect(writes).toBe(1);
  });

  test("allows QA AI triage, deduplicates active work, and joins current results", async () => {
    app.automationConfig.set({
      projectId: "42",
      schedules: [{ scheduleId: 22 }],
    });
    seedSchedule();
    seedPipeline(9400, {
      status: "failed",
      jobs: [
        {
          jobId: 501,
          name: "browser",
          stage: "test",
          status: "failed",
          allowFailure: false,
          webUrl: "https://gitlab.example/acme/web/-/jobs/501",
        },
      ],
      suites: [{ index: 0, name: "browser", buildIds: [501], ...report }],
      failedTests: [
        {
          suiteIndex: 0,
          caseIndex: 0,
          jobId: 501,
          status: "failed",
          name: "checkout button",
          executionTime: 1,
          signatureKey: "triage-signature",
          signatureTitle: "AssertionError: expected Buy now",
        },
      ],
    });
    app.automationAiTriage.record({
      projectId: "42",
      scheduleId: 22,
      signatureKey: "triage-signature",
      signature: "AssertionError: expected Buy now",
      verdict: "ui-change",
      confidence: 0.86,
      rationale: "The stored selector expects the previous button copy.",
      recommendation: "Confirm the copy change and update the page object.",
      taskRunId: "triage-run",
    });

    const path =
      "/api/automation/pipelines/9400/failure-clusters/" +
      "triage-signature/triage";
    const queued = await requestAsQa(path, "POST");
    expect(queued!.status).toBe(202);
    expect(await queued!.json()).toMatchObject({
      queued: true,
      message: expect.stringContaining("Queued AI triage"),
    });
    const active = app.jobs.activeForKind("triage-automation-failure");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      actorId: "operator",
      params: {
        projectId: "42",
        pipelineId: 9400,
        scheduleId: 22,
        signatureKey: "triage-signature",
        targetRef: "main",
      },
    });

    const duplicate = await requestAsQa(path, "POST");
    expect(duplicate!.status).toBe(200);
    expect(await duplicate!.json()).toEqual({
      queued: false,
      message: "AI triage is already running for this failure cluster.",
    });

    const list = await bodyOf(
      "/api/automation/pipelines/9400/failure-clusters",
    );
    expect(list.items[0]).toMatchObject({
      aiTriage: {
        verdict: "ui-change",
        confidence: 0.86,
        taskRunId: "triage-run",
      },
      aiTriageInFlight: true,
      aiTriageRefusal: null,
    });
    const detail = await bodyOf(
      "/api/automation/pipelines/9400/failure-clusters/triage-signature",
    );
    expect(detail.aiTriage).toMatchObject({ verdict: "ui-change" });
    expect(detail.aiTriageInFlight).toBe(true);

    app.automationAiTriage.record({
      projectId: "42",
      scheduleId: 22,
      signatureKey: "triage-signature",
      signature: "AssertionError: stale other signature",
      verdict: "test-bug",
      confidence: 0.6,
      rationale: "This belongs to an older normalized failure.",
      recommendation: "Do not show this result.",
      taskRunId: "stale-run",
    });
    const stale = await bodyOf(
      "/api/automation/pipelines/9400/failure-clusters/triage-signature",
    );
    expect(stale.aiTriage).toBeNull();
    expect(stale.aiTriageInFlight).toBe(true);
  });

  test("serves a stored occurrence artifact with shared-token auth and private image headers", async () => {
    app.automationConfig.set({
      projectId: "42",
      schedules: [{ scheduleId: 22 }],
    });
    seedSchedule();
    seedPipeline(9100, {
      status: "failed",
      jobs: [
        {
          jobId: 501,
          name: "browser",
          stage: "test",
          status: "failed",
          allowFailure: false,
          webUrl: "https://gitlab.example/acme/web/-/jobs/501",
        },
      ],
      suites: [{ index: 0, name: "browser", buildIds: [501], ...report }],
      failedTests: [
        {
          suiteIndex: 0,
          caseIndex: 3,
          jobId: 501,
          status: "failed",
          name: "captures checkout",
          executionTime: 0.25,
          attachmentJobId: 501,
          attachmentPath: "screenshots/failure shot.png",
          attachmentName: "failure shot.png",
          signatureKey: "0123456789abcdef0123456789abcdef",
          signatureTitle: "AssertionFailure: checkout",
        },
      ],
    });
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const http = new FakeHttp([
      {
        match:
          "/api/v4/projects/42/jobs/501/artifacts/" +
          "screenshots/failure%20shot.png",
        respond: { bytes, headers: { "content-type": "image/png" } },
      },
    ]);
    app.sharedGitLab = () =>
      new GitLabClient({
        token: "shared-artifact-token",
        baseUrl: "https://gitlab.test/api/v4",
        fetch: http.fetch,
      });

    const response = await get(
      "/api/automation/pipelines/9100/failed-tests/0/3/attachment",
    );

    expect(response!.status).toBe(200);
    expect(response!.headers.get("content-type")).toBe("image/png");
    expect(response!.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(response!.headers.get("content-disposition")).toContain(
      'filename="failure shot.png"',
    );
    expect(response!.headers.get("cache-control")).toBe("private, max-age=300");
    expect(response!.headers.get("vary")).toBe("Cookie");
    expect(response!.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(bytes);
    expect(http.calls[0]?.headers["private-token"]).toBe(
      "shared-artifact-token",
    );
    expect(http.calls[0]?.url.search).toBe("");
  });

  test("requires auth and rejects unconfigured, unlisted, absent, or unbound occurrences", async () => {
    const path =
      "/api/automation/pipelines/9101/failed-tests/0/3/attachment";
    expect(
      (
        await handleApiRequest(
          new Request(`http://localhost${path}`),
          app,
        )
      )!.status,
    ).toBe(401);
    expect((await get(path))!.status).toBe(404);

    app.automationConfig.set({
      projectId: "42",
      schedules: [{ scheduleId: 23 }],
    });
    seedSchedule();
    seedPipeline(9101, {
      status: "failed",
      jobs: [
        {
          jobId: 501,
          name: "browser",
          stage: "test",
          status: "failed",
          allowFailure: false,
          webUrl: "https://gitlab.example/acme/web/-/jobs/501",
        },
      ],
      suites: [{ index: 0, name: "browser", buildIds: [501], ...report }],
      failedTests: [
        {
          suiteIndex: 0,
          caseIndex: 3,
          status: "failed",
          name: "captures checkout",
          executionTime: 0.25,
          attachmentJobId: 999,
          attachmentPath: "screenshots/failure.png",
          attachmentName: "failure.png",
          signatureKey: "0123456789abcdef0123456789abcdef",
          signatureTitle: "AssertionFailure: checkout",
        },
        {
          suiteIndex: 0,
          caseIndex: 4,
          status: "failed",
          name: "has no screenshot",
          executionTime: 0.1,
          signatureKey: "fedcba9876543210fedcba9876543210",
          signatureTitle: "AssertionFailure: no screenshot",
        },
      ],
    });

    // Schedule 22 is not in the current allowlist.
    expect((await get(path))!.status).toBe(404);
    app.automationConfig.set({
      projectId: "42",
      schedules: [{ scheduleId: 22 }],
    });
    // The stored attachment job is not one of this pipeline's jobs/suite builds.
    expect((await get(path))!.status).toBe(404);
    expect(
      (
        await get(
          "/api/automation/pipelines/9101/failed-tests/0/4/attachment",
        )
      )!.status,
    ).toBe(404);
    expect(
      (
        await get(
          "/api/automation/pipelines/9101/failed-tests/0/999/attachment",
        )
      )!.status,
    ).toBe(404);
  });
});
