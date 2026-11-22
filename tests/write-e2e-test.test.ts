import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { TaskConnectorFactory } from "../src/application/gateways.ts";
import type { JobRepository, RunRepository } from "../src/application/ports.ts";
import type { TaskContext } from "../src/core/task.ts";
import { createLogger } from "../src/logging/logger.ts";
import { MemoryStateStore } from "../src/persistence/state-store.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import {
  createWriteE2eTestTask,
  E2E_TEST_PROJECT,
  type WriteE2eTestDeps,
} from "../src/tasks/write-e2e-test/index.ts";
import { e2eTestBranchName } from "../src/tasks/write-e2e-test/branch.ts";

describe("write-e2e-test task", () => {
  test("writes Playwright coverage against the source MR target branch", async () => {
    let agentInput: Parameters<NonNullable<WriteE2eTestDeps["runAgent"]>>[0] | undefined;
    let mergeRequest:
      | { project: string; sourceBranch: string; targetBranch: string; draft: boolean; title: string }
      | undefined;
    const sourceJob = {
      id: "source-job-12345678",
      kind: "e2e-test",
      loopId: "fix-issue-actions",
      dedupeKey: "manual:e2e-test:jira:TP-42:mr:example-org%2Fwebapp!7",
      params: {
        jira: { issueKey: "TP-42" },
        gitlab: { projectId: E2E_TEST_PROJECT, mrIid: 7 },
      },
      priority: 0,
      status: "done",
      attempts: 1,
      maxAttempts: 3,
      availableAt: new Date(),
      enqueuedAt: new Date(),
      executionId: "e2e-run-1",
    };
    const details = {
      verdict: "pass",
      summary: "Checkout works.",
      scenarios: [{
        name: "Checkout",
        outcome: "pass",
        detail: "Order completed.",
        evidence: [],
        automation: {
          portal: "main",
          preconditions: ["Signed in"],
          steps: [{
            action: "click",
            target: "Checkout",
            locatorHint: "role=button name=Checkout",
            expected: "Confirmation is visible",
          }],
        },
      }],
      findings: [],
    };
    const connectors = {
      gitlab: () => ({
        mergeRequest: async () => ({
          title: "TP-42 checkout",
          description: "Adds checkout.",
          source_branch: "feature/TP-42",
          target_branch: "develop",
          sha: "abc",
          web_url: "https://gitlab.example/example-org/webapp/-/merge_requests/7",
        }),
        mergeRequestDiffs: async () => [{
          old_path: "src/checkout.ts",
          new_path: "src/checkout.ts",
          diff: "@@ -1 +1 @@\n-old\n+new",
        }],
        listMergeRequests: async () => [],
        listBranches: async () => [],
        createMergeRequest: async (project: string, input: {
          sourceBranch: string;
          targetBranch: string;
          draft: boolean;
          title: string;
        }) => {
          mergeRequest = { project, ...input };
          return {
            iid: 99,
            web_url: "https://gitlab.example/example-org/webapp/-/merge_requests/99",
          };
        },
      }),
      jira: () => ({
        ticketDetail: async () => ({
          key: "TP-42",
          fields: { summary: "Checkout", description: "Cover checkout." },
        }),
      }),
    } as unknown as TaskConnectorFactory;
    const task = createWriteE2eTestTask({
      connectors,
      jobs: { get: () => sourceJob } as unknown as JobRepository,
      runs: { getRun: () => ({ details }) } as unknown as RunRepository,
      ensureImage: async () => undefined,
      runAgent: async (input) => {
        agentInput = input;
        return {
          status: "changed",
          summary: "Added checkout coverage.",
          testFiles: ["tests/checkout.spec.ts"],
          howVerified: "bunx playwright test tests/checkout.spec.ts (passed)",
          verification: "passed",
          description: undefined,
          pushedBranch: input.pushBranch,
          commitSha: "def",
        };
      },
    });

    const result = await task.run(context(), {
      sourceJobId: sourceJob.id,
      targetBranch: "develop",
    });

    expect(agentInput).toMatchObject({
      project: E2E_TEST_PROJECT,
      baseBranch: "develop",
      pushBranch: e2eTestBranchName("TP-42", sourceJob.id),
    });
    expect(agentInput?.contextFiles["e2e-result.json"]).toContain("role=button");
    expect(mergeRequest).toMatchObject({
      project: E2E_TEST_PROJECT,
      sourceBranch: e2eTestBranchName("TP-42", sourceJob.id),
      targetBranch: "develop",
      draft: false,
      title: "feat(e2e) TP-42 add Playwright coverage",
    });
    expect(result.details).toMatchObject({
      action: "opened",
      draft: false,
      mrIid: 99,
      targetBranch: "develop",
    });
  });

  test("keeps the generated MR draft when the exploratory scenario failed", async () => {
    let draft: boolean | undefined;
    let agentBaseBranch: string | undefined;
    let mrTargetBranch: string | undefined;
    const task = createWriteE2eTestTask({
      jobs: {
        get: () => ({
          id: "job-failed",
          kind: "e2e-test",
          status: "done",
          executionId: "run-failed",
          params: {
            jira: { issueKey: "TP-7" },
            gitlab: { projectId: E2E_TEST_PROJECT, mrIid: 8 },
          },
        }),
      } as unknown as JobRepository,
      runs: {
        getRun: () => ({
          details: {
            verdict: "fail",
            summary: "Broken",
            scenarios: [{
              name: "Broken journey",
              outcome: "fail",
              detail: "Expected behavior missing",
              evidence: [],
              automation: {
                portal: "main",
                preconditions: [],
                steps: [{ action: "assert", target: "Expected heading" }],
              },
            }],
            findings: [],
          },
        }),
      } as unknown as RunRepository,
      connectors: {
        gitlab: () => ({
          mergeRequest: async () => ({
            title: "TP-7 feature",
            source_branch: "feature/TP-7",
            target_branch: "develop",
            web_url: "https://gitlab.example/mr/8",
          }),
          mergeRequestDiffs: async () => [],
          listMergeRequests: async () => [],
          listBranches: async () => [],
          createMergeRequest: async (
            _project: string,
            input: { draft: boolean; targetBranch: string },
          ) => {
            draft = input.draft;
            mrTargetBranch = input.targetBranch;
            return { iid: 100, web_url: "https://gitlab.example/mr/100" };
          },
        }),
        jira: () => ({
          ticketDetail: async () => ({ key: "TP-7", fields: { summary: "Feature" } }),
        }),
      } as unknown as TaskConnectorFactory,
      ensureImage: async () => undefined,
      runAgent: async (input) => {
        agentBaseBranch = input.baseBranch;
        return {
          status: "changed" as const,
          summary: "Added expected behavior.",
          testFiles: ["tests/feature.spec.ts"],
          howVerified: undefined,
          verification: "failed" as const,
          description: undefined,
          pushedBranch: input.pushBranch,
        };
      },
    });

    await task.run(context(), {
      sourceJobId: "job-failed",
      targetBranch: "feature/TP-7",
    });
    expect(draft).toBe(true);
    expect(agentBaseBranch).toBe("feature/TP-7");
    expect(mrTargetBranch).toBe("feature/TP-7");
  });
});

function context(): TaskContext {
  return {
    taskId: "write-e2e-test",
    executionId: "write-e2e-run",
    logger: createLogger({
      destination: new PassThrough(),
      pretty: false,
      level: "fatal",
    }),
    state: new MemoryStateStore(),
    secrets: new EnvSecretStore({ GITLAB_TOKEN: "glpat-test" }),
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
