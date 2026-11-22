import { z } from "zod";
import { renderPromptTemplate } from "../../config/prompt-templates.ts";
import { runAgentJob } from "../../infrastructure/agent/index.ts";
import type { Actor } from "../../core/actor.ts";
import type { Logger } from "../../logging/logger.ts";

/**
 * The conflict-resolution agent: the prompt, the answer shape, and the write
 * policy that turns a stopped rebase into a force-pushed branch.
 *
 * The mechanics are not here and deliberately not the agent's either. The
 * container starts `git rebase origin/<target>` before Claude is invoked and
 * force-pushes with a lease afterwards (see `AGENT_ENTRYPOINT_SH` and the
 * `rebase` write policy), so the sequence is identical every run and cannot be
 * improvised. What is left for the agent is the only part that needs judgement:
 * deciding what each conflicted file should actually say.
 */

const FileResolutionSchema = z.object({
  path: z.string().min(1),
  /** One line on what was kept and what was dropped, for the notification body. */
  reasoning: z.string().min(1),
});

export const ResolveConflictsOutputSchema = z.object({
  summary: z.string(),
  resolved: z.array(FileResolutionSchema).default([]),
  /**
   * Files the agent judged it could not resolve safely. Reported rather than
   * guessed at: a conflict between two deliberate changes sometimes has no
   * correct merge, and inventing one is worse than handing it back.
   */
  unresolved: z.array(FileResolutionSchema).default([]),
});

export type ResolveConflictsOutput = z.infer<typeof ResolveConflictsOutputSchema>;

export interface ResolveConflictsAgentResult extends ResolveConflictsOutput {
  /** Set when the rebased branch was force-pushed. Absent when nothing changed. */
  commitSha?: string;
}

export interface ResolveConflictsAgentOptions {
  executionId: string;
  mrIid: number;
  /** `group/project` of the *source* project — a fork's branch lives on the fork. */
  project: string;
  branch: string;
  targetBranch: string;
  /** The head the job was raised for; the force-push is leased against it. */
  startSha: string;
  token: string;
  context: ResolveConflictsContext;
  commitName: string;
  commitEmail: string;
  model?: string;
  effort?: string;
  promptTemplate?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  logger?: Logger;
  /**
   * The developer this run is for. Decides which connected agent account the
   * container authenticates as, so the work bills to their own plan.
   */
  actor?: Actor;
}

export interface ResolveConflictsContext {
  mergeRequest: {
    iid: number;
    title: string;
    description?: string;
    sourceBranch: string;
    targetBranch: string;
    webUrl: string;
  };
}

export async function runResolveConflictsAgent(
  options: ResolveConflictsAgentOptions,
): Promise<ResolveConflictsAgentResult> {
  const { output, commitSha } = await runAgentJob({
    executionId: options.executionId,
    label: options.mrIid,
    workspace: {
      project: options.project,
      branch: options.branch,
      targetBranch: options.targetBranch,
      startSha: options.startSha,
      token: options.token,
    },
    contextFiles: {
      "merge-request.json": JSON.stringify(options.context, null, 2),
    },
    prompt: buildResolveConflictsPrompt(
      options.mrIid,
      options.project,
      options.branch,
      options.targetBranch,
      options.promptTemplate,
    ),
    output: ResolveConflictsOutputSchema,
    // No `onUnstructured`: the branch has already been force-pushed by the time
    // the answer is parsed, so a malformed reply is a reporting problem, not a
    // reason to guess at which files were resolved.
    writePolicy: "rebase",
    commit: {
      name: options.commitName,
      email: options.commitEmail,
      // Only ever used for edits the agent made *after* finishing the rebase; the
      // replayed commits keep their own messages.
      message: "Resolve rebase conflicts",
    },
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.actor ? { actor: options.actor } : {}),
  });

  return { ...output, ...(commitSha ? { commitSha } : {}) };
}

export const RESOLVE_CONFLICTS_PROMPT_ID = "mr-resolve-conflicts";

export const DEFAULT_RESOLVE_CONFLICTS_PROMPT_TEMPLATE =
  "You are resolving rebase conflicts on GitLab merge request !{{mrIid}} in {{project}}. " +
  "Branch {{branch}} is being rebased onto {{targetBranch}}. Read .talos/rebase-state.txt first: " +
  "it says whether a rebase is in progress and which files conflict. Also read " +
  ".talos/merge-request.json for what this merge request is trying to do, and CLAUDE.md and " +
  "AGENTS.md for repository conventions. If the file says the rebase completed with no conflicts, " +
  "change nothing and report an empty resolved list.\n" +
  "Otherwise, for each conflicted file: run `git log` and `git show` on both sides to understand " +
  "the two intents, then edit the file so that BOTH are preserved. Keep the target branch's " +
  "changes and reapply this merge request's changes on top of them — the point of the rebase is " +
  "that neither side's work is lost. Never resolve by taking one side wholesale unless the two " +
  "changes are genuinely the same edit. Remove every conflict marker (<<<<<<<, =======, >>>>>>>). " +
  "Do not change behaviour that neither side changed, and do not fix unrelated problems you notice.\n" +
  "Then `git add` the resolved files and run `git rebase --continue`. Repeat for every commit the " +
  "rebase stops on until no rebase is in progress (`git status` confirms it). Run relevant tests or " +
  "a typecheck if the repository makes that cheap. If a file cannot be resolved safely, do NOT " +
  "guess: stop, run `git rebase --abort`, and report it under unresolved. Never run `git push`, " +
  "`git reset --hard` on the branch, or change remotes; Talos force-pushes with a lease after " +
  "you finish. Your job is only to resolve the conflicted files in this rebase — never call the " +
  "GitLab API, and never edit, resolve, or reply to merge request comments or discussion threads.\n" +
  "Reply with exactly one fenced JSON block and no other prose:\n" +
  '```json\n{"summary": string, "resolved": [{"path": string, "reasoning": string}], "unresolved": [{"path": string, "reasoning": string}]}\n```';

export function buildResolveConflictsPrompt(
  mrIid: number,
  project: string,
  branch: string,
  targetBranch: string,
  template: string = DEFAULT_RESOLVE_CONFLICTS_PROMPT_TEMPLATE,
): string {
  return renderPromptTemplate(template, {
    mrIid: String(mrIid),
    project,
    branch,
    targetBranch,
  });
}
