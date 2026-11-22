import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { E2eArtifactStore } from "../src/infrastructure/e2e/artifacts.ts";
import { E2E_ENTRYPOINT } from "../src/infrastructure/e2e/image.ts";
import {
  e2eDockerNetworkArgs,
  isE2eAccessDenied,
} from "../src/infrastructure/e2e/run.ts";
import { e2ePrompt, linkedIssueKey } from "../src/tasks/e2e-test/index.ts";
import {
  createE2eTestTask,
  type E2eTestTaskDeps,
} from "../src/tasks/e2e-test/index.ts";
import { defaultE2eCandidate } from "../web/src/graph/e2e.ts";
import type { E2ePullRequestCandidateView } from "../shared/api-contract.ts";
import type { TaskConnectorFactory } from "../src/application/gateways.ts";
import type { TaskContext } from "../src/core/task.ts";
import { MemoryStateStore } from "../src/persistence/state-store.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import { createLogger } from "../src/logging/logger.ts";
import {
  parseQaRuntime,
  playwrightSecretsEnv,
  qaRuntimeGuide,
  sanitizedQaRuntimeConfig,
} from "../src/tasks/e2e-test/qa-runtime.ts";
import { ticketActionHistory } from "../src/api/ticket-actions.ts";
import {
  e2eTestMrDedupeKey,
  e2eTestMrJobsBySource,
} from "../src/api/e2e-test-mr-actions.ts";
import type { App } from "../src/app.ts";
import type { Job } from "../src/core/job.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "talos-e2e-test-"));
  directories.push(path);
  return path;
}

describe("E2E artifact boundaries", () => {
  test("lists supported bounded evidence and refuses path traversal", async () => {
    const directory = await temporaryDirectory();
    const store = new E2eArtifactStore(directory);
    const execution = await store.prepare("run:123");
    await writeFile(join(execution, "checkpoint.png"), new Uint8Array([1, 2, 3]));
    await writeFile(join(execution, "session-trace.jsonl"), "{}\n");
    await writeFile(join(execution, "ignored.exe"), "no");

    expect(await store.list("run:123")).toEqual([
      {
        name: "checkpoint.png",
        kind: "screenshot",
        contentType: "image/png",
        bytes: 3,
      },
      {
        name: "session-trace.jsonl",
        kind: "trace",
        contentType: "application/json",
        bytes: 3,
      },
    ]);
    await expect(store.open("run:123", "../secret")).rejects.toThrow(
      "Invalid E2E artifact name",
    );
  });

  test("purges execution directories older than retention", async () => {
    const directory = await temporaryDirectory();
    const store = new E2eArtifactStore(directory);
    await store.prepare("old-run");
    expect(await store.purge(new Date(Date.now() + 60_000))).toBe(1);
    expect(await store.list("old-run")).toEqual([]);
  });
});

describe("E2E agent safety and test brief", () => {
  test("checks out code and gives credentials only to Playwright MCP", () => {
    expect(E2E_ENTRYPOINT).toContain('logEvent("checkout", "started"');
    expect(E2E_ENTRYPOINT).toContain('"PRIVATE-TOKEN: " + gitlabToken');
    expect(E2E_ENTRYPOINT).not.toContain("process.env.GITLAB_TOKEN");
    expect(E2E_ENTRYPOINT).toContain('await takeSecret("gitlab-token")');
    expect(E2E_ENTRYPOINT).toContain('await takeSecret("agent-env.json")');
    expect(E2E_ENTRYPOINT).toContain("await rm(path, { force: true })");
    expect(E2E_ENTRYPOINT).toContain("env: { ...process.env, ...agentEnv }");
    expect(E2E_ENTRYPOINT).toContain('await run("curl"');
    expect(E2E_ENTRYPOINT).toContain('"--executable-path", bundledChromium');
    expect(E2E_ENTRYPOINT).not.toContain("--allowed-origins");
    expect(E2E_ENTRYPOINT).toContain('logEvent("vpn-preflight", "started"');
    expect(E2E_ENTRYPOINT).toContain("Connect the Talos host to the corporate VPN");
    expect(E2E_ENTRYPOINT).toContain("TALOS_E2E_NETWORK=host");
    expect(E2E_ENTRYPOINT).not.toContain("oauth2:");
    expect(E2E_ENTRYPOINT).toContain('"--secrets", "/run/talos-secret/playwright-secrets.env"');
    expect(E2E_ENTRYPOINT).toContain('"Read,Grep,Glob,mcp__playwright__*"');
    expect(E2E_ENTRYPOINT).not.toContain('"Read,Grep,Glob,Bash');
    expect(E2E_ENTRYPOINT).not.toContain('logEvent("install"');
    expect(E2E_ENTRYPOINT).not.toContain('logEvent("application"');
  });

  test("uses the bridge network unless host networking is opted into", () => {
    expect(e2eDockerNetworkArgs("")).toEqual([]);
    expect(e2eDockerNetworkArgs(undefined)).toEqual([]);
    expect(e2eDockerNetworkArgs("host")).toEqual(["--network", "host"]);
    expect(e2eDockerNetworkArgs(" host ")).toEqual(["--network", "host"]);
    expect(() => e2eDockerNetworkArgs("bridge2")).toThrow("TALOS_E2E_NETWORK");
  });

  test("builds a QA-only, bounded-mutation browser prompt", () => {
    const prompt = e2ePrompt({
      issueKey: "TP-42",
      projectId: "group/app",
      mrIid: 7,
      startUrl: "https://qa.example.com",
    });
    expect(prompt).toContain(".talos/release-notes.md");
    expect(prompt).toContain(
      "read .talos/qa-exploratory-tester.md and follow it as mandatory testing instructions",
    );
    expect(prompt).toContain("normal QA test-data create/update/delete is allowed");
    expect(prompt).toContain("Open the browser at https://qa.example.com");
    expect(prompt).toContain('"verdict":"pass|fail|inconclusive"');
  });

  test("recovers the Jira key from MR title, description or branch", () => {
    expect(linkedIssueKey("TP-42 add checkout", null, "feature/no-key")).toBe("TP-42");
    expect(linkedIssueKey("add checkout", "Relates to tp_7-19", "feature/no-key")).toBe(
      "TP_7-19",
    );
  });

  test("treats GitLab checkout authorization failures as terminal", () => {
    expect(isE2eAccessDenied("GitLab repository archive download returned HTTP 403 Forbidden"))
      .toBe(true);
    expect(isE2eAccessDenied("GitLab repository archive download returned HTTP 406 Not Acceptable"))
      .toBe(true);
    expect(isE2eAccessDenied("browser timed out")).toBe(false);
  });
});

describe("Test-Automation default.conf", () => {
  const content = `
environment = "qa3"
webSettings {
  baseUrl = "https://app-"${"${environment}"}".example.com"
  parentPortalUrl = "https://parent-"${"${environment}"}".example.com"
  studentPortalUrl = "https://student-"${"${environment}"}".example.com"
}
qaFixtureSettings {
  studentUsername = "student-user"
  studentPassword = "student-password"
  parentEmail = "parent@example.com"
  parentPassword = "parent-password"
}
userSettings {
  principalEmail = "principal@example.com"
  principalPass = "principal-password"
}`;

  test("separates configured URLs from Playwright-only secret placeholders", () => {
    const runtime = parseQaRuntime(content);
    const guide = qaRuntimeGuide(runtime);
    expect(guide).toContain("https://student-qa3.example.com/");
    expect(guide).toContain("QA_PARENT_PASSWORD");
    expect(guide).toContain("QA_PRINCIPAL_EMAIL");
    expect(guide).not.toContain("parent-password");
    expect(guide).not.toContain("principal-password");
    const sanitized = sanitizedQaRuntimeConfig(runtime);
    expect(sanitized).toContain('studentUsername = "QA_STUDENT_USERNAME"');
    expect(sanitized).toContain('principalEmail = "QA_PRINCIPAL_EMAIL"');
    expect(sanitized).toContain('principalPass = "QA_PRINCIPAL_PASS"');
    expect(sanitized).not.toContain("student-password");
    expect(playwrightSecretsEnv(runtime)).toContain(
      'QA_STUDENT_PASSWORD="student-password"',
    );
    expect(playwrightSecretsEnv(runtime)).toContain(
      'QA_PRINCIPAL_PASS="principal-password"',
    );
    expect(runtime.origins).toEqual([
      "https://app-qa3.example.com",
      "https://parent-qa3.example.com",
      "https://student-qa3.example.com",
    ]);
  });

  test("requires principal email and password as a pair", () => {
    expect(() =>
      parseQaRuntime(content.replace('  principalPass = "principal-password"\n', ""))
    ).toThrow("requires principal credentials");
  });

  test("accepts the main portal URL and principal credentials without optional portals", () => {
    const runtime = parseQaRuntime(`
webSettings {
  baseUrl = "https://qa.example.com"
}
userSettings {
  principalEmail = "principal@example.com"
  principalPass = "principal-password"
}`);

    expect(runtime).toEqual({
      urls: { base: "https://qa.example.com/" },
      origins: ["https://qa.example.com"],
      secrets: {
        QA_PRINCIPAL_EMAIL: "principal@example.com",
        QA_PRINCIPAL_PASS: "principal-password",
      },
    });
    expect(qaRuntimeGuide(runtime)).toContain("QA_PRINCIPAL_EMAIL");
    expect(sanitizedQaRuntimeConfig(runtime)).toBe(
      'webSettings {\n  baseUrl = "https://qa.example.com/"\n}\n\n' +
        'userSettings {\n  principalEmail = "QA_PRINCIPAL_EMAIL"\n' +
        '  principalPass = "QA_PRINCIPAL_PASS"\n}',
    );
  });

  test("requires each configured credential pair to be complete", () => {
    expect(() =>
      parseQaRuntime(`
webSettings {
  baseUrl = "https://qa.example.com"
}
qaFixtureSettings {
  studentUsername = "student"
}
userSettings {
  principalEmail = "principal@example.com"
  principalPass = "principal-password"
}`)).toThrow("student credentials require both");
  });

  test("requires principal credentials for the main portal", () => {
    expect(() =>
      parseQaRuntime(`
webSettings {
  baseUrl = "https://qa.example.com"
}`)).toThrow("requires principal credentials");
  });
});

describe("E2E task verdict semantics", () => {
  test("records a discovered product failure as a completed structured result", async () => {
    const directory = await temporaryDirectory();
    const artifacts = new E2eArtifactStore(join(directory, "artifacts"));
    let agentInput: Parameters<NonNullable<E2eTestTaskDeps["runAgent"]>>[0] | undefined;
    const fetchedQaFiles: string[] = [];
    const runAgent = (async (input: typeof agentInput) => {
      agentInput = input;
      await Bun.write(join(input!.artifactDirectory, "failed-checkout.png"), "png");
      return {
        verdict: "fail",
        summary: "The new checkout button remains disabled.",
        scenarios: [{
          name: "Enable checkout",
          outcome: "fail",
          detail: "Button never enables.",
          evidence: ["failed-checkout.png"],
          automation: {
            portal: "main",
            preconditions: ["A user is signed in"],
            steps: [{
              action: "click",
              target: "Checkout",
              locatorHint: "role=button name=Checkout",
              value: "override-principal-secret",
              expected: "Checkout opens",
            }],
          },
        }],
        findings: [{
          severity: "major",
          title: "Checkout remains blocked",
          detail: "The changed form does not update its valid state.",
          evidence: ["failed-checkout.png"],
        }],
      };
    }) as NonNullable<E2eTestTaskDeps["runAgent"]>;
    const connectors = {
      gitlab: () => ({
        getFileRaw: async (_project: string, path: string) => {
          fetchedQaFiles.push(path);
          return {
            content: path.endsWith("default.conf")
              ? `
webSettings {
  baseUrl = "https://qa.example.com"
  parentPortalUrl = "https://parent.qa.example.com"
  studentPortalUrl = "https://student.qa.example.com"
}
qaFixtureSettings {
  studentUsername = "qa-student"
  studentPassword = "student-secret"
  parentEmail = "qa-parent@example.com"
  parentPassword = "parent-secret"
}`
              : "# QA exploratory tester\nAlways verify the changed user journey.",
            ref: "main",
          };
        },
        mergeRequest: async () => ({
          title: "TP-42 checkout",
          description: "## Release notes\nCheckout now enables after valid input.\n## Other\nx",
          source_branch: "TP-42-checkout",
          target_branch: "develop",
          source_project_id: 10,
          sha: "abc123",
          web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
        }),
        mergeRequestDiffs: async () => [{
          old_path: "src/checkout.ts",
          new_path: "src/checkout.ts",
          diff: "@@ -1 +1 @@\n-old\n+new",
        }],
        project: async () => ({
          id: 10,
          path_with_namespace: "acme/web",
          web_url: "https://gitlab.com/acme/web",
          default_branch: "develop",
        }),
      }),
      jira: () => ({
        ticketDetail: async () => ({
          id: "42",
          key: "TP-42",
          fields: {
            summary: "Enable checkout",
            description: "Given valid details, checkout becomes enabled.",
          },
        }),
      }),
    } as unknown as TaskConnectorFactory;
    const task = createE2eTestTask({
      connectors,
      artifacts,
      checkoutToken: () => "shared-checkout-token",
      config: () => ({
        agentInstructionsOverride: "# Replacement tester\nTest the changed checkout flow.",
        runtimeConfigOverride: `
webSettings {
  baseUrl = "https://override.qa.example.com"
  parentPortalUrl = "https://override-parent.qa.example.com"
  studentPortalUrl = "https://override-student.qa.example.com"
}
qaFixtureSettings {
  studentUsername = "override-student"
  studentPassword = "override-student-secret"
  parentEmail = "override-parent@example.com"
  parentPassword = "override-parent-secret"
}
userSettings {
  principalEmail = "override-principal@example.com"
  principalPass = "override-principal-secret"
}`,
        additionalInstructions: "Start with the parent portal scenario.",
      }),
      ensureImage: async () => undefined,
      runAgent,
    });

    const result = await task.run(taskContext(), {
      jira: { issueKey: "TP-42" },
      gitlab: { projectId: "acme/web", mrIid: 7 },
    });

    expect(result.itemsProcessed).toBe(1);
    expect(fetchedQaFiles).toEqual([]);
    expect(result.itemsFailed).toBeUndefined();
    expect(result.details).toMatchObject({
      verdict: "fail",
      summary: "The new checkout button remains disabled.",
      artifacts: [{ name: "failed-checkout.png", kind: "screenshot" }],
    });
    expect(JSON.stringify(result.details)).not.toContain("override-principal-secret");
    expect(JSON.stringify(result.details)).toContain("QA_PRINCIPAL_PASS");
    expect(agentInput?.contextFiles["release-notes.md"]).toBe(
      "Checkout now enables after valid input.",
    );
    expect(agentInput?.contextFiles["qa-exploratory-tester.md"]).toContain(
      "Test the changed checkout flow.",
    );
    expect(agentInput?.contextFiles["operator-instructions.md"]).toBe(
      "Start with the parent portal scenario.",
    );
    expect(agentInput?.prompt).toContain(".talos/operator-instructions.md");
    expect(agentInput?.contextFiles["qa-runtime.md"]).toContain(
      "Student portal username: QA_STUDENT_USERNAME",
    );
    expect(agentInput?.contextFiles["default.conf"]).toContain(
      'parentPassword = "QA_PARENT_PASSWORD"',
    );
    expect(agentInput?.playwrightSecrets).toEqual({
      QA_STUDENT_USERNAME: "override-student",
      QA_STUDENT_PASSWORD: "override-student-secret",
      QA_PARENT_EMAIL: "override-parent@example.com",
      QA_PARENT_PASSWORD: "override-parent-secret",
      QA_PRINCIPAL_EMAIL: "override-principal@example.com",
      QA_PRINCIPAL_PASS: "override-principal-secret",
    });
    expect(agentInput?.gitlabToken).toBe("shared-checkout-token");
    expect(agentInput?.runtime).toMatchObject({
      startUrl: "https://override.qa.example.com/",
    });
    expect(agentInput?.contextFiles["mr.diff"]).toContain("+new");
  });
});

describe("E2E merge-request selection", () => {
  test("selects the newest linked merge request", () => {
    const candidate = (input: Partial<E2ePullRequestCandidateView> & {
      projectId: string;
      mrIid: number;
    }): E2ePullRequestCandidateView => ({
      title: "MR",
      url: "https://gitlab.example/mr",
      sourceBranch: "feature",
      targetBranch: "develop",
      draft: false,
      updatedAt: "2026-09-25T00:00:00.000Z",
      ...input,
    });
    const candidates = [
      candidate({ projectId: "group/app", mrIid: 9 }),
      candidate({ projectId: "group/app", mrIid: 8 }),
      candidate({ projectId: "group/app", mrIid: 7 }),
    ];
    expect(defaultE2eCandidate(candidates)?.mrIid).toBe(9);
  });
});

test("E2E jobs with a digit in the action id remain visible in ticket Activity", () => {
  const job: Job = {
    id: "job-1",
    kind: "e2e-test",
    loopId: "fix-issue-actions",
    dedupeKey: "manual:e2e-test:jira:TP-3043:mr:example-org%2Fwebapp!6299",
    params: {},
    priority: 0,
    status: "queued",
    attempts: 1,
    maxAttempts: 3,
    availableAt: new Date(),
    enqueuedAt: new Date(),
    error: "checkout failed",
  };
  const app = {
    jobs: { manualTicketActionHistory: () => [job] },
  } as unknown as App;
  expect(ticketActionHistory(app).get("TP-3043")?.[0]).toMatchObject({
    action: "e2e-test",
    issueKey: "TP-3043",
  });
});

test("E2E test-MR attempts stay associated with their source exploratory run", () => {
  const exportJob = {
    id: "export-1",
    kind: "write-e2e-test",
    loopId: "e2e-test-mr-actions",
    dedupeKey: e2eTestMrDedupeKey("TP-3043", "source-e2e-1"),
    params: { sourceJobId: "source-e2e-1" },
    priority: 0,
    status: "queued",
    attempts: 1,
    maxAttempts: 3,
    availableAt: new Date(),
    enqueuedAt: new Date(),
  } as Job;
  const app = {
    jobs: { manualTicketActionHistory: () => [exportJob] },
  } as unknown as App;
  expect(e2eTestMrJobsBySource(app).get("source-e2e-1")?.id).toBe("export-1");
});

function taskContext(): TaskContext {
  return {
    taskId: "e2e-test",
    executionId: "e2e-run-1",
    logger: createLogger({
      destination: new PassThrough(),
      pretty: false,
      level: "fatal",
    }),
    state: new MemoryStateStore(),
    secrets: new EnvSecretStore({
      GITLAB_TOKEN: "glpat-test-token",
      GITLAB_API_URL: "https://gitlab.com/api/v4",
    }),
    dryRun: false,
    maxItemsPerRun: 1,
    force: true,
    signal: new AbortController().signal,
    actor: { id: "admin", email: "admin@example.com", name: "Admin" },
    llm: { provider: "anthropic", model: "sonnet", maxTokens: 2048 },
    prompts: {},
    step: async (_id, fn) => fn(),
  };
}
