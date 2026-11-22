import { z } from "zod";
import type { Actor } from "../../core/actor.ts";
import { runAgentJob } from "../../infrastructure/agent/index.ts";
import type { Logger } from "../../logging/logger.ts";

const optionalText = z.string().optional().transform((value) => value || undefined);

export const WriteE2eTestOutputSchema = z.object({
  status: z.enum(["changed", "no-change"]),
  summary: z.string().min(1),
  testFiles: z.array(z.string().min(1)).default([]),
  howVerified: optionalText,
  verification: z.enum(["passed", "failed", "not-run"]),
  description: optionalText,
});

export type WriteE2eTestOutput = z.infer<typeof WriteE2eTestOutputSchema>;

export interface WriteE2eTestAgentResult extends WriteE2eTestOutput {
  commitSha?: string;
  pushedBranch?: string;
  toolErrors?: number;
}

export interface WriteE2eTestAgentOptions {
  executionId: string;
  project: string;
  baseBranch: string;
  pushBranch: string;
  token: string;
  issueKey: string;
  contextFiles: Record<string, string>;
  commitName: string;
  commitEmail: string;
  actor?: Actor;
  model?: string;
  effort?: string;
  signal?: AbortSignal;
  logger?: Logger;
}

export async function runWriteE2eTestAgent(
  options: WriteE2eTestAgentOptions,
): Promise<WriteE2eTestAgentResult> {
  const { output, commitSha, pushedBranch, toolErrors } = await runAgentJob({
    executionId: options.executionId,
    label: `e2e-test:${options.issueKey}`,
    workspace: {
      project: options.project,
      branch: options.baseBranch,
      token: options.token,
    },
    contextFiles: options.contextFiles,
    prompt: writeE2eTestPrompt(options.issueKey, options.project, options.baseBranch),
    output: WriteE2eTestOutputSchema,
    writePolicy: "push+mr",
    commit: {
      name: options.commitName,
      email: options.commitEmail,
      message: `feat(e2e) ${options.issueKey} add Playwright coverage`.slice(0, 200),
      branch: options.pushBranch,
    },
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return {
    ...output,
    ...(commitSha ? { commitSha } : {}),
    ...(pushedBranch ? { pushedBranch } : {}),
    ...(toolErrors ? { toolErrors } : {}),
  };
}

export function writeE2eTestPrompt(
  issueKey: string,
  project: string,
  baseBranch: string,
): string {
  return `Add maintainable Playwright TypeScript coverage for ${issueKey} in ${project}, based on ` +
    `branch ${baseBranch}. Read CLAUDE.md and AGENTS.md, then read every file under .talos. ` +
    `.talos/e2e-result.json contains conclusive exploratory scenarios and safe structured steps; ` +
    `.talos/ticket.md, .talos/source-merge-request.md and .talos/mr.diff provide product intent.\n` +
    `Use the repository's existing fixtures, page objects, authentication helpers, naming, and test ` +
    `commands. Convert every pass/fail scenario that has automation steps. A failed exploratory ` +
    `scenario describes the expected behavior to assert and may intentionally produce a red test. ` +
    `Do not copy screenshots or browser traces into the repository. Never hardcode credentials, ` +
    `resolved usernames, passwords, QA_* placeholder values, or environment-specific secrets. Use ` +
    `the repository's existing environment/config helpers.\n` +
    `Run the narrowest relevant Playwright command. Do not alter product code merely to make the ` +
    `test pass. Leave edits in the working tree; do not commit, push, create branches, or call GitLab.\n` +
    `Reply with exactly one fenced JSON object and no other prose:\n` +
    `{"status":"changed|no-change","summary":"...","testFiles":["..."],` +
    `"howVerified":"command and result","verification":"passed|failed|not-run",` +
    `"description":"short MR description"}`;
}
