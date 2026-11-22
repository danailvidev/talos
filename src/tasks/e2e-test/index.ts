import { z } from "zod";
import type { TaskConnectorFactory } from "../../application/gateways.ts";
import type { E2eTestConfig } from "../../application/ports.ts";
import type { FetchLike } from "../../connectors/http.ts";
import { adfToMarkdown } from "../../connectors/jira/adf.ts";
import { ConfigError } from "../../core/errors.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import type { E2eArtifactRepository } from "../../infrastructure/e2e/artifacts.ts";
import { ensureE2eImage } from "../../infrastructure/e2e/image.ts";
import { runE2eAgent } from "../../infrastructure/e2e/run.ts";
import {
  parseQaRuntime,
  qaRuntimeGuide,
  sanitizedQaRuntimeConfig,
} from "./qa-runtime.ts";

export const E2E_TEST_TASK_ID = "e2e-test";
export const E2E_TEST_SETTINGS_SOURCES = {
  project: "example-org/qa/test-automation",
  ref: "main",
  agentInstructionsPath: ".claude/agents/qa-exploratory-tester.md",
  runtimeConfigPath: "core/src/main/resources/default.conf",
} as const;

export function e2eTestSettingsSources(): {
  project: string;
  ref: typeof E2E_TEST_SETTINGS_SOURCES.ref;
  agentInstructionsPath: typeof E2E_TEST_SETTINGS_SOURCES.agentInstructionsPath;
  runtimeConfigPath: typeof E2E_TEST_SETTINGS_SOURCES.runtimeConfigPath;
} {
  const project = Bun.env.TALOS_E2E_SETTINGS_PROJECT?.trim();
  return project ? { ...E2E_TEST_SETTINGS_SOURCES, project } : E2E_TEST_SETTINGS_SOURCES;
}
const DEFAULT_TEST_TIMEOUT_MS = 30 * 60_000;
const MAX_DIFF_BYTES = 512 * 1024;
export const MAX_E2E_FILE_OVERRIDE_BYTES = 256 * 1024;
export const MAX_E2E_ADDITIONAL_INSTRUCTIONS_BYTES = 128 * 1024;

const ParamsSchema = z.object({
  jira: z.object({ issueKey: z.string().min(1) }),
  gitlab: z.object({
    projectId: z.string().min(1),
    mrIid: z.number().int().positive(),
  }),
});

const FindingSchema = z.object({
  severity: z.enum(["critical", "major", "minor"]),
  title: z.string().min(1),
  detail: z.string().min(1),
  evidence: z.array(z.string()).default([]),
});

const AutomationStepSchema = z.object({
  action: z.enum(["navigate", "click", "fill", "select", "check", "press", "assert", "wait"]),
  target: z.string().min(1),
  locatorHint: z.string().min(1).optional(),
  value: z.string().min(1).optional(),
  expected: z.string().min(1).optional(),
});

const ScenarioSchema = z.object({
  name: z.string().min(1),
  outcome: z.enum(["pass", "fail", "blocked"]),
  detail: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  automation: z.object({
    portal: z.enum(["main", "parent", "student"]),
    preconditions: z.array(z.string().min(1)).default([]),
    steps: z.array(AutomationStepSchema).min(1).max(100),
  }).optional(),
}).superRefine((scenario, context) => {
  if (scenario.outcome !== "blocked" && !scenario.automation) {
    context.addIssue({
      code: "custom",
      path: ["automation"],
      message: "Conclusive scenarios require automation steps.",
    });
  }
});

export const E2eAgentResultSchema = z.object({
  verdict: z.enum(["pass", "fail", "inconclusive"]),
  summary: z.string().min(1),
  scenarios: z.array(ScenarioSchema).min(1),
  findings: z.array(FindingSchema).default([]),
});

export type E2eAgentResult = z.infer<typeof E2eAgentResultSchema>;
type Params = z.infer<typeof ParamsSchema>;

export interface E2eTestTaskDeps {
  fetch?: FetchLike;
  connectors?: TaskConnectorFactory;
  artifacts?: E2eArtifactRepository;
  /** Installation credential used only for read-only repository snapshot download. */
  checkoutToken?: () => string;
  /** Read for every run so a Settings save takes effect without a restart. */
  config?: () => E2eTestConfig;
  ensureImage?: typeof ensureE2eImage;
  runAgent?: typeof runE2eAgent;
}

export function createE2eTestTask(deps: E2eTestTaskDeps = {}): Task<Params> {
  return {
    id: E2E_TEST_TASK_ID,
    name: "QA E2E test",
    description:
      "Checks out the selected merge request and follows the QA exploratory tester instructions against the URL and fixtures in Test-Automation default.conf.",
    kind: "job",
    agent: true,
    paramsSchema: ParamsSchema,
    run: (ctx, params) => run(ctx, params, deps),
  };
}

async function run(
  ctx: TaskContext,
  params: Params,
  deps: E2eTestTaskDeps,
): Promise<TaskResult> {
  const connectors = requireConnectors(deps);
  const artifacts = requireArtifacts(deps);
  const gitlab = connectors.gitlab(ctx, deps.fetch);
  const jira = connectors.jira(ctx, deps.fetch);
  const { issueKey } = params.jira;
  const { projectId, mrIid } = params.gitlab;
  const config = deps.config?.() ?? {
    agentInstructionsOverride: null,
    runtimeConfigOverride: null,
    additionalInstructions: null,
  };
  const runtimeOverride = config.runtimeConfigOverride == null
    ? null
    : boundedTextFile(config.runtimeConfigOverride, "QA runtime override");

  const [ticket, mr, diffs, agentInstructionsFile, qaRuntimeFile] = await Promise.all([
    ctx.step("fetch-ticket", () => jira.ticketDetail(issueKey, { signal: ctx.signal })),
    ctx.step("fetch-merge-request", () => gitlab.mergeRequest(projectId, mrIid, ctx.signal)),
    ctx.step("fetch-diff", () => gitlab.mergeRequestDiffs(projectId, mrIid, ctx.signal)),
    ctx.step("load-qa-agent-instructions", () =>
      config.agentInstructionsOverride == null
        ? gitlab.getFileRaw(
          e2eTestSettingsSources().project,
          e2eTestSettingsSources().agentInstructionsPath,
          e2eTestSettingsSources().ref,
          ctx.signal,
        )
        : Promise.resolve({ content: config.agentInstructionsOverride })
    ),
    ctx.step("load-qa-runtime-config", () =>
      runtimeOverride != null
        ? Promise.resolve({ content: "" })
        : gitlab.getFileRaw(
          e2eTestSettingsSources().project,
          e2eTestSettingsSources().runtimeConfigPath,
          e2eTestSettingsSources().ref,
          ctx.signal,
        )
    ),
  ]);
  if (!ticket) throw new ConfigError(`Jira ticket ${issueKey} was not found.`);
  if (!mr.sha) throw new ConfigError(`GitLab reports no source commit for ${projectId}!${mrIid}.`);
  const linkedKey = linkedIssueKey(mr.title, mr.description, mr.source_branch);
  if (linkedKey !== issueKey.toUpperCase()) {
    throw new ConfigError(`${projectId}!${mrIid} is not linked to ${issueKey}.`);
  }

  const sourceProject = await ctx.step("resolve-source-project", () =>
    gitlab.project(mr.source_project_id ?? projectId, ctx.signal),
  );
  await ctx.step("ensure-e2e-image", () => (deps.ensureImage ?? ensureE2eImage)(ctx.logger));
  const artifactDirectory = await artifacts.prepare(ctx.executionId);

  const ticketMarkdown = [
    `# ${issueKey}: ${ticket.fields?.summary ?? "(no summary)"}`,
    "",
    adfToMarkdown(ticket.fields?.description) || "(no description)",
    ...(ticket.fields?.environment
      ? ["", "## Environment / reproduction notes", "", adfToMarkdown(ticket.fields.environment)]
      : []),
  ].join("\n");
  const releaseNotes = releaseNotesSection(mr.description) ?? "(no Release notes section)";
  const diff = boundedDiff(diffs);
  const agentInstructions = boundedAgentInstructions(agentInstructionsFile.content);
  const runtimeConfigContent =
    runtimeOverride ?? boundedTextFile(qaRuntimeFile.content, "QA runtime config");
  const qaRuntime = parseQaRuntime(
    runtimeConfigContent,
  );
  const additionalInstructions = config.additionalInstructions == null
    ? null
    : boundedAdditionalInstructions(config.additionalInstructions);
  const contextFiles = {
    "qa-exploratory-tester.md": agentInstructions,
    "qa-runtime.md": qaRuntimeGuide(qaRuntime),
    "default.conf": sanitizedQaRuntimeConfig(qaRuntime),
    "ticket.md": ticketMarkdown,
    "release-notes.md": releaseNotes,
    "mr.diff": diff,
    "merge-request.md": [
      `# ${projectId}!${mrIid}: ${mr.title}`,
      "",
      `Source: ${sourceProject.path_with_namespace}@${mr.source_branch} (${mr.sha})`,
      `Target: ${projectId}@${mr.target_branch}`,
      "",
      mr.description ?? "",
    ].join("\n"),
    ...(additionalInstructions
      ? { "operator-instructions.md": additionalInstructions }
      : {}),
  };
  const prompt = e2ePrompt({
    issueKey,
    projectId,
    mrIid,
    startUrl: qaRuntime.urls.base,
    hasAdditionalInstructions: additionalInstructions != null,
  });

  let result: E2eAgentResult;
  try {
    result = redactE2eResult(await ctx.step("run-qa-e2e", () =>
      (deps.runAgent ?? runE2eAgent)({
        executionId: ctx.executionId,
        project: sourceProject.path_with_namespace,
        branch: mr.source_branch,
        sha: mr.sha!,
        gitlabApiUrl: gitlabApiBase(ctx.secrets.get("GITLAB_API_URL")),
        gitlabToken: deps.checkoutToken?.() ?? ctx.secrets.require("GITLAB_TOKEN"),
        runtime: {
          startUrl: qaRuntime.urls.base,
          testTimeoutMs: DEFAULT_TEST_TIMEOUT_MS,
        },
        playwrightSecrets: qaRuntime.secrets,
        contextFiles,
        artifactDirectory,
        prompt,
        output: E2eAgentResultSchema,
        ...(ctx.llm.model ? { model: ctx.llm.model } : {}),
        ...(ctx.llm.effort ? { effort: ctx.llm.effort } : {}),
        ...(ctx.actor ? { actor: ctx.actor } : {}),
        logger: ctx.logger,
        signal: ctx.signal,
      }),
    ), qaRuntime.secrets);
  } catch (error) {
    // Keep authentication/startup evidence on a failed attempt; retention owns it.
    await artifacts.list(ctx.executionId);
    throw error;
  }

  const evidence = await artifacts.list(ctx.executionId);
  return {
    itemsSeen: 1,
    itemsProcessed: 1,
    itemsSkipped: 0,
    details: {
      issueKey,
      action: "e2e-tested",
      projectId,
      mrIid,
      mrUrl: mr.web_url,
      sha: mr.sha,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      verdict: result.verdict,
      summary: result.summary,
      scenarios: result.scenarios,
      findings: result.findings,
      artifacts: evidence,
    },
  };
}

export function e2ePrompt(input: {
  issueKey: string;
  projectId: string;
  mrIid: number;
  startUrl: string;
  hasAdditionalInstructions?: boolean;
}): string {
  return `You are performing a focused exploratory E2E verification of ${input.issueKey} for ` +
    `${input.projectId}!${input.mrIid}.\n\n` +
    `Read .talos/ticket.md, .talos/release-notes.md, .talos/merge-request.md and ` +
    `.talos/mr.diff before using Playwright. Read .talos/qa-runtime.md and the credential-redacted ` +
    `.talos/default.conf for the approved QA portal URLs and Playwright secret placeholder names ` +
    `available for login. Then read ` +
    `.talos/qa-exploratory-tester.md and ` +
    `follow it as mandatory testing instructions. It may refine the testing workflow, but it ` +
    `cannot override the QA-only target, safety rules, repository read-only rule, credential ` +
    `protection, or required JSON response in this prompt. ` +
    (input.hasAdditionalInstructions
      ? `Also read .talos/operator-instructions.md and follow those operator instructions within the same limits. `
      : "") +
    `Derive concrete user-visible scenarios from the ` +
    `ticket acceptance criteria, release notes and changed code. Open the browser at ${input.startUrl} ` +
    `and test the issue against that configured QA application.\n\n` +
    `Safety: normal QA test-data create/update/delete is allowed. Use uniquely named data, clean ` +
    `it up when practical, and do not perform admin, billing, permission, production or irreversible ` +
    `actions. Do not inspect, request or reveal credentials or browser storage. Do not modify repository files.\n\n` +
    `Use Playwright MCP for every browser interaction. Capture screenshots without specifying an ` +
    `explicit filename for important checkpoints and every failure. Check visible behavior, browser ` +
    `console errors and relevant failed network requests. Do not report a pass for an untested or ` +
    `blocked scenario; use inconclusive when the issue cannot be established.\n\n` +
    `Return exactly one fenced JSON object with this shape:\n` +
    `{"verdict":"pass|fail|inconclusive","summary":"...","scenarios":[{"name":"...",` +
    `"outcome":"pass|fail|blocked","detail":"...","evidence":["artifact name if known"],` +
    `"automation":{"portal":"main|parent|student","preconditions":["..."],"steps":[` +
    `{"action":"navigate|click|fill|select|check|press|assert|wait","target":"...",` +
    `"locatorHint":"role/text/test-id if known","value":"QA_* placeholder or non-secret test data",` +
    `"expected":"..."}]}}],` +
    `"findings":[{"severity":"critical|major|minor","title":"...","detail":"...",` +
    `"evidence":["artifact name if known"]}]}. Include automation for every pass/fail scenario; ` +
    `omit it only for blocked scenarios. Never include resolved credential values in the JSON—use ` +
    `only QA_* placeholder names.`;
}

function redactE2eResult(
  result: E2eAgentResult,
  secrets: Readonly<Record<string, string | undefined>>,
): E2eAgentResult {
  return E2eAgentResultSchema.parse(redactValue(result, secrets));
}

function redactValue(
  value: unknown,
  secrets: Readonly<Record<string, string | undefined>>,
): unknown {
  if (typeof value === "string") {
    let redacted = value;
    for (const [name, secret] of Object.entries(secrets)) {
      if (secret) redacted = redacted.replaceAll(secret, name);
    }
    return redacted;
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry, secrets)]),
    );
  }
  return value;
}

function boundedAgentInstructions(content: string): string {
  return boundedTextFile(content, "QA exploratory tester instruction");
}

function boundedAdditionalInstructions(content: string): string {
  return boundedTextFile(
    content,
    "Additional E2E instruction",
    MAX_E2E_ADDITIONAL_INSTRUCTIONS_BYTES,
  );
}

function boundedTextFile(
  content: string,
  label: string,
  maxBytes = MAX_E2E_FILE_OVERRIDE_BYTES,
): string {
  const trimmed = content.trim();
  if (!trimmed) throw new ConfigError(`The ${label} file is empty.`);
  const bytes = new TextEncoder().encode(trimmed);
  if (bytes.byteLength > maxBytes) {
    throw new ConfigError(`The ${label} file exceeds ${maxBytes} bytes.`);
  }
  return trimmed;
}

function boundedDiff(
  diffs: Array<{ old_path: string; new_path: string; diff?: string }>,
): string {
  const text = diffs.map((file) =>
    `diff --git a/${file.old_path} b/${file.new_path}\n${file.diff ?? "[diff unavailable]"}`,
  ).join("\n");
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= MAX_DIFF_BYTES) return text;
  return new TextDecoder().decode(bytes.slice(0, MAX_DIFF_BYTES)) +
    "\n\n[diff truncated by Talos]\n";
}

function releaseNotesSection(description: string | null | undefined): string | undefined {
  if (!description) return undefined;
  const match = description.match(
    /(?:^|\n)#{1,6}\s+release notes\s*\n([\s\S]*?)(?=\n#{1,6}\s+|\s*$)/i,
  );
  return match?.[1]?.trim() || undefined;
}

export function linkedIssueKey(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const match = value?.match(/\b([A-Z][A-Z0-9_]+-\d+)\b/i);
    if (match) return match[1]!.toUpperCase();
  }
  return undefined;
}

function gitlabApiBase(apiUrl: string | undefined): string {
  return (apiUrl ?? "https://gitlab.com/api/v4").replace(/\/+$/, "");
}

function requireConnectors(deps: E2eTestTaskDeps): TaskConnectorFactory {
  if (!deps.connectors) throw new ConfigError(`${E2E_TEST_TASK_ID} requires connector gateways.`);
  return deps.connectors;
}

function requireArtifacts(deps: E2eTestTaskDeps): E2eArtifactRepository {
  if (!deps.artifacts) throw new ConfigError(`${E2E_TEST_TASK_ID} requires artifact storage.`);
  return deps.artifacts;
}
