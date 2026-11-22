/**
 * Wraps the operator's own instructions in the little that the container needs
 * them to know, and nothing more.
 *
 * Every other prompt in this codebase is a rubric we wrote and the operator may
 * override (see `tasks/prompt-registry.ts`). This one inverts that: the prompt
 * *is* the operator's, and everything here is an envelope around it. So the
 * envelope stays as small as it can be — where the checkout is, and how to
 * report back — because each extra sentence is one more instruction competing
 * with the one the user actually wrote.
 */
export function buildCustomLoopPrompt(
  prompt: string,
  target: { projectId: string; branch: string } | undefined,
): string {
  const where = target
    ? `You are in a checkout of ${target.projectId} on branch ${target.branch}, at /workspace. ` +
      `The repository's own CLAUDE.md / AGENTS.md, if it has one, is collected at ` +
      `.talos/guidelines.md — follow it.`
    : `You have an empty working directory at /workspace and no repository checked out. ` +
      `Work from your instructions alone; do not go looking for code that is not there.`;

  return [
    where,
    "",
    "Your instructions:",
    "",
    prompt.trim(),
    "",
    "When you are done, end your reply with a single fenced JSON block:",
    "",
    "```json",
    '{ "summary": "one or two sentences on what you did or found",',
    '  "actions": ["one line per concrete thing you did or found"] }',
    "```",
    "",
    "If you have nothing to report, say so in the summary rather than inventing work.",
  ].join("\n");
}
