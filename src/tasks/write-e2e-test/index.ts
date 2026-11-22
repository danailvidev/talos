import { z } from "zod";
import type { TaskConnectorFactory } from "../../application/gateways.ts";
import type {
  JobRepository,
  NotificationRepository,
  RunRepository,
} from "../../application/ports.ts";
import type { FetchLike } from "../../connectors/http.ts";
import { adfToMarkdown } from "../../connectors/jira/adf.ts";
import { ConfigError } from "../../core/errors.ts";
import { mutate } from "../../core/step.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import { ensureAgentImage } from "../../infrastructure/agent/index.ts";
import { E2eAgentResultSchema } from "../e2e-test/index.ts";
import {
  runWriteE2eTestAgent,
  type WriteE2eTestAgentResult,
} from "./agent.ts";
import { e2eTestBranchName } from "./branch.ts";

export const WRITE_E2E_TEST_TASK_ID = "write-e2e-test";
export const E2E_TEST_PROJECT = "example-org/webapp";

export function e2eTestProject(): string {
  return Bun.env.TALOS_E2E_PROJECT?.trim() || E2E_TEST_PROJECT;
}

const ConfigSchema = z.object({
  sourceJobId: z.string().min(1),
  targetBranch: z.string().min(1),
});

const SourceParamsSchema = z.object({
  jira: z.object({ issueKey: z.string().min(1) }),
  gitlab: z.object({
    projectId: z.string().min(1),
    mrIid: z.number().int().positive(),
  }),
});

const DEFAULT_COMMIT = { name: "Talos", email: "talos@talos.local" };
const MAX_DIFF_BYTES = 512 * 1024;

export interface WriteE2eTestDeps {
  fetch?: FetchLike;
  connectors?: TaskConnectorFactory;
  jobs?: JobRepository;
  runs?: RunRepository;
  notifications?: NotificationRepository;
  ensureImage?: typeof ensureAgentImage;
  runAgent?: typeof runWriteE2eTestAgent;
}

export function createWriteE2eTestTask(
  deps: WriteE2eTestDeps = {},
): Task<z.infer<typeof ConfigSchema>> {
  return {
    id: WRITE_E2E_TEST_TASK_ID,
    name: "Write E2E test",
    description:
      "Converts a completed exploratory QA run into Playwright TypeScript coverage and opens a merge request.",
    kind: "job",
    agent: true,
    paramsSchema: ConfigSchema,
    run: (ctx, config) => run(ctx, config, deps),
  };
}

async function run(
  ctx: TaskContext,
  config: z.infer<typeof ConfigSchema>,
  deps: WriteE2eTestDeps,
): Promise<TaskResult> {
  if (!deps.jobs || !deps.runs || !deps.connectors) {
    throw new ConfigError(`${WRITE_E2E_TEST_TASK_ID} is missing required dependencies.`);
  }
  const sourceJob = deps.jobs.get(config.sourceJobId);
  if (
    !sourceJob ||
    sourceJob.kind !== "e2e-test" ||
    sourceJob.status !== "done" ||
    !sourceJob.executionId
  ) {
    throw new ConfigError(`E2E source job '${config.sourceJobId}' is not completed.`);
  }
  const sourceRun = deps.runs.getRun(sourceJob.executionId);
  if (!sourceRun?.details) {
    throw new ConfigError(`E2E source job '${config.sourceJobId}' has no structured result.`);
  }
  const params = SourceParamsSchema.parse(sourceJob.params);
  if (params.gitlab.projectId !== e2eTestProject()) {
    throw new ConfigError(`Automated E2E tests can only be written to ${e2eTestProject()}.`);
  }
  const e2e = E2eAgentResultSchema.parse(sourceRun.details);
  const scenarios = e2e.scenarios.filter(
    (scenario) => scenario.outcome !== "blocked" && scenario.automation,
  );
  if (scenarios.length === 0) {
    throw new ConfigError("The E2E run has no conclusive scenarios with automation steps.");
  }

  const gitlab = deps.connectors.gitlab(ctx, deps.fetch);
  const jira = deps.connectors.jira(ctx, deps.fetch);
  const [ticket, sourceMr, diffs] = await Promise.all([
    ctx.step("fetch-ticket", () =>
      jira.ticketDetail(params.jira.issueKey, { signal: ctx.signal })
    ),
    ctx.step("fetch-source-merge-request", () =>
      gitlab.mergeRequest(e2eTestProject(), params.gitlab.mrIid, ctx.signal)
    ),
    ctx.step("fetch-source-diff", () =>
      gitlab.mergeRequestDiffs(e2eTestProject(), params.gitlab.mrIid, ctx.signal)
    ),
  ]);
  if (!ticket) throw new ConfigError(`Jira ticket ${params.jira.issueKey} was not found.`);
  if (
    config.targetBranch !== "develop" &&
    config.targetBranch !== sourceMr.source_branch
  ) {
    throw new ConfigError(
      `Test MR target must be 'develop' or the tested source branch '${sourceMr.source_branch}'.`,
    );
  }
  const targetBranch = config.targetBranch;
  const branch = e2eTestBranchName(params.jira.issueKey, config.sourceJobId);
  const sourceFailed = scenarios.some((scenario) => scenario.outcome === "fail");

  const existing = await ctx.step("existing-merge-request", () =>
    gitlab.listMergeRequests(e2eTestProject(), {
      state: "all",
      sourceBranch: branch,
      limit: 1,
      signal: ctx.signal,
    })
  );
  if (existing[0]) {
    return {
      itemsSeen: 1,
      itemsProcessed: 0,
      itemsSkipped: 1,
      details: {
        issueKey: params.jira.issueKey,
        sourceE2eJobId: config.sourceJobId,
        action: "adopted",
        mrIid: existing[0].iid,
        mrUrl: existing[0].web_url,
        branch,
        targetBranch,
      },
    };
  }
  const existingBranch = (await ctx.step("existing-branch", () =>
    gitlab.listBranches(e2eTestProject(), {
      search: branch,
      limit: 20,
      signal: ctx.signal,
    })
  )).find((candidate) => candidate.name === branch);
  if (existingBranch) {
    const recovered = await mutate(
      ctx,
      `recover a draft E2E test merge request from ${branch}`,
      () =>
        gitlab.createMergeRequest(e2eTestProject(), {
          sourceBranch: branch,
          targetBranch,
          title: `feat(e2e) ${params.jira.issueKey} add Playwright coverage`,
          description:
            `Recovered Playwright coverage generated from exploratory E2E job ${config.sourceJobId}.`,
          draft: true,
          removeSourceBranch: true,
          labels: ["e2e test"],
          signal: ctx.signal,
        }),
    );
    if (!recovered) throw new ConfigError("Merge request recovery was unexpectedly suppressed.");
    return {
      itemsSeen: 1,
      itemsProcessed: 1,
      itemsSkipped: 0,
      details: {
        issueKey: params.jira.issueKey,
        sourceE2eJobId: config.sourceJobId,
        action: "opened",
        recovered: true,
        draft: true,
        mrIid: recovered.iid,
        mrUrl: recovered.web_url,
        branch,
        targetBranch,
      },
    };
  }

  if (ctx.dryRun) {
    return {
      itemsSeen: 1,
      itemsProcessed: 0,
      itemsSkipped: 1,
      details: {
        issueKey: params.jira.issueKey,
        sourceE2eJobId: config.sourceJobId,
        branch,
        targetBranch,
      },
    };
  }

  await ctx.step("ensure-agent-image", () =>
    (deps.ensureImage ?? ensureAgentImage)(ctx.logger)
  );
  const contextResult = {
    verdict: e2e.verdict,
    summary: e2e.summary,
    scenarios,
    findings: e2e.findings,
  };
  const agent = await ctx.step("write-playwright-test", () =>
    (deps.runAgent ?? runWriteE2eTestAgent)({
      executionId: ctx.executionId,
      project: e2eTestProject(),
      baseBranch: targetBranch,
      pushBranch: branch,
      token: ctx.secrets.require("GITLAB_TOKEN"),
      issueKey: params.jira.issueKey,
      contextFiles: {
        "e2e-result.json": JSON.stringify(contextResult, null, 2),
        "ticket.md": [
          `# ${params.jira.issueKey}: ${ticket.fields?.summary ?? "(no summary)"}`,
          "",
          adfToMarkdown(ticket.fields?.description) || "(no description)",
        ].join("\n"),
        "source-merge-request.md": [
          `# ${e2eTestProject()}!${params.gitlab.mrIid}: ${sourceMr.title}`,
          "",
          `Source: ${sourceMr.source_branch}`,
          `Target: ${sourceMr.target_branch}`,
          `URL: ${sourceMr.web_url}`,
          "",
          sourceMr.description ?? "",
        ].join("\n"),
        "mr.diff": boundedDiff(diffs),
      },
      commitName: ctx.actor?.name ?? DEFAULT_COMMIT.name,
      commitEmail: ctx.actor?.email ?? DEFAULT_COMMIT.email,
      ...(ctx.actor ? { actor: ctx.actor } : {}),
      ...(ctx.llm.model ? { model: ctx.llm.model } : {}),
      ...(ctx.llm.effort ? { effort: ctx.llm.effort } : {}),
      signal: ctx.signal,
      logger: ctx.logger,
    })
  );

  if (!agent.pushedBranch) return noChange(params.jira.issueKey, config.sourceJobId, agent);

  const draft = sourceFailed || agent.verification !== "passed";
  const title = `feat(e2e) ${params.jira.issueKey} add Playwright coverage`;
  const mr = await mutate(
    ctx,
    `open a ${draft ? "draft " : ""}E2E test merge request from ${branch}`,
    () =>
      gitlab.createMergeRequest(e2eTestProject(), {
        sourceBranch: branch,
        targetBranch,
        title,
        description: [
          agent.description ?? agent.summary,
          "",
          `Source exploratory run: ${config.sourceJobId}`,
          `Source merge request: ${sourceMr.web_url}`,
          agent.howVerified ? `Verification: ${agent.howVerified}` : "Verification: not reported",
        ].join("\n"),
        draft,
        removeSourceBranch: true,
        labels: ["e2e test"],
        signal: ctx.signal,
      }),
  );
  if (!mr) throw new ConfigError("Merge request creation was unexpectedly suppressed.");

  deps.notifications?.create({
    kind: WRITE_E2E_TEST_TASK_ID,
    title: `Playwright coverage ready for ${params.jira.issueKey}`,
    body: agent.summary,
    link: mr.web_url,
    taskRunId: ctx.executionId,
  });
  return {
    itemsSeen: 1,
    itemsProcessed: 1,
    itemsSkipped: 0,
    notifiedIndividually: true,
    details: {
      issueKey: params.jira.issueKey,
      sourceE2eJobId: config.sourceJobId,
      action: "opened",
      draft,
      mrIid: mr.iid,
      mrUrl: mr.web_url,
      branch,
      targetBranch,
      testFiles: agent.testFiles,
      howVerified: agent.howVerified,
      commitSha: agent.commitSha,
    },
  };
}

function noChange(
  issueKey: string,
  sourceJobId: string,
  agent: WriteE2eTestAgentResult,
): TaskResult {
  return {
    itemsSeen: 1,
    itemsProcessed: 0,
    itemsSkipped: 1,
    details: {
      issueKey,
      sourceE2eJobId: sourceJobId,
      action: "no-change",
      summary: agent.summary,
      howVerified: agent.howVerified,
      ...(agent.toolErrors ? { agentErrors: agent.toolErrors } : {}),
    },
  };
}

function boundedDiff(
  diffs: Array<{ old_path: string; new_path: string; diff?: string }>,
): string {
  const text = diffs.map((file) =>
    `diff --git a/${file.old_path} b/${file.new_path}\n${file.diff ?? "[diff unavailable]"}`
  ).join("\n");
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= MAX_DIFF_BYTES) return text;
  return new TextDecoder().decode(bytes.slice(0, MAX_DIFF_BYTES)) +
    "\n\n[diff truncated by Talos]\n";
}
