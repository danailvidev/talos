import { renderPromptTemplate } from "../../config/prompt-templates.ts";

/**
 * Claude inside the review container only has Read/Grep/Glob — no git — so the
 * host mounts GitLab's MR diffs at `.talos/` and the entrypoint appends its
 * collected CLAUDE.md / AGENTS.md / docs guidelines to this prompt. The prompt
 * forbids treating the checkout as a bootstrap or enforcing commit-message
 * templates as blockers.
 *
 * Note the distinction the template draws between *reviewing* the diff and
 * *reading* the repository. It used to say "open only paths listed in
 * changed-files.txt", which was aimed at stopping the agent reviewing the whole
 * tree but also stopped it reading the callers, interfaces and tests of the code
 * it was reviewing — so it could only really comment on the diff's surface.
 * Scope now bounds what may be reported, not what may be read.
 */

export const REVIEW_PROMPT_ID = "code-review";

export const DEFAULT_REVIEW_PROMPT_TEMPLATE =
  "{{scope}} {{context}}\n\n" +
  "Required reading order:\n" +
  "1. .talos/changed-files.txt and .talos/mr.diff — the change under review.\n" +
  "2. .talos/mr-commits.txt — every commit on the MR, not git log of a shallow clone.\n" +
  "3. The repository review rubric appended below — collected from CLAUDE.md, AGENTS.md and the repo's docs guidelines, with the same bundle available at .talos/guidelines.md. Apply it to the changed code. If it says no guidelines were found, review on general engineering merit and say so in your summary.\n\n" +
  "The whole checkout is on disk and Read/Grep/Glob reach all of it. Use it: to tell " +
  "whether a change is correct you normally have to read what it calls, what calls it, " +
  "the type or interface it implements, and its tests. Reading an unchanged file is " +
  "expected; *reporting on* one is not — the diff is what is under review, the rest of " +
  "the repo is the context that makes the diff judgeable.\n\n" +
  "Prioritise in this order, and say in your summary which of these you checked:\n" +
  "1. Correctness — logic errors, unhandled cases, off-by-one, broken invariants, wrong " +
  "error handling, concurrency and ordering bugs, data loss, security.\n" +
  "2. Whether the change actually does what its commits and description claim.\n" +
  "3. The repo's own guidelines from step 3 above.\n" +
  "4. Everything else. Style nobody's guidelines asked for is a nit at most.\n\n" +
  "Be specific: a finding must name what breaks and under what input or state, not that " +
  "something 'could be improved'. Prefer a few well-evidenced findings over a long list " +
  "of generic observations, and return no findings at all rather than padding with ones " +
  "you do not believe.\n\n" +
  "Do not report:\n" +
  "- anything whose only evidence is a file that is not in changed-files.txt;\n" +
  "- that this is a bootstrap, initial import, or 'no code changes' when changed-files.txt lists implementation files — pre-existing trees (for example a full app under projects/) are out of scope unless they appear on that list;\n" +
  "- commit-message wording or CLAUDE.md authoring conventions as blockers unless the guidelines (or a section explicitly titled code review) tell reviewers to reject the MR for that.\n\n" +
  "Each finding's file must be a path from changed-files.txt, and `line` must be a line " +
  "in that file's new version so the comment lands in the right place.\n\n" +
  "Reply with exactly one fenced JSON block, no other prose, matching:\n" +
  '```json\n{"summary": string, "findings": [{"severity": "blocker"|"warning"|"nit", "file": string, "line"?: number, "comment": string}]}\n```';

export function buildReviewPrompt(
  context: string,
  targetBranch?: string,
  template: string = DEFAULT_REVIEW_PROMPT_TEMPLATE,
): string {
  const scope = targetBranch
    ? `You are reviewing a GitLab merge request targeting "${targetBranch}". ` +
      `The authoritative change set is GitLab's Changes tab (every commit on ` +
      `the MR vs the target — not HEAD alone, not the whole repository).`
    : `You are reviewing the commits that belong to this branch, not the entire repository.`;

  return renderPromptTemplate(template, { scope, context });
}
