/**
 * Skills tasks can grant their agent (see `AgentJobOptions.skills` in `run.ts`),
 * embedded as string constants for the same reason the Dockerfile and entrypoint
 * in `image.ts` are: `bun build --compile` produces a single binary with no
 * filesystem alongside it, so there is nothing on disk at `name/SKILL.md` to
 * mount. Each requested skill is written to a temp dir at run time and mounted
 * over the container's `~/.claude/skills`, so a task's skills come from talos
 * itself — reusable by any task, on any machine talos runs on — rather than
 * whichever operator happens to be running it.
 */
export const AGENT_SKILLS: Record<string, string> = {
  "talos-release-notes": `---
name: talos-release-notes
description: Use when a Talos agent task changed code in a repository and the task's output schema has an optional releaseNotes field. Checks the repository's own docs/RELEASE_NOTES_GUIDELINES.md and writes release notes in the format that file requires, without creating any files.
---

Only run this after you have made and verified a code change — never for a "no-change" result.

1. Check whether the repository has a \`docs/RELEASE_NOTES_GUIDELINES.md\` file.
2. If it does not exist, or it exists but says this kind of change needs no entry, leave the
   \`releaseNotes\` field out of your reply entirely. Do not invent a format.
3. If it exists and applies, read it and write the release notes exactly as it instructs, then
   return that text in the \`releaseNotes\` field of your reply.
4. Never create or edit a release-notes file in the repository yourself — the caller appends
   your \`releaseNotes\` text to the merge request description automatically. Creating one
   yourself would duplicate it.
`,
};
