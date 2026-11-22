import type { MergeRequestCommit, MergeRequestDiff } from "../../connectors/gitlab/types.ts";

/** Bound the mounted diff so a giant MR cannot blow the prompt/container. */
export const MAX_REVIEW_DIFF_BYTES = 1_500_000;

/** Extends Record so it drops straight into `runAgentJob`'s `contextFiles`. */
export interface ReviewContextFiles extends Record<string, string> {
  "mr.diff": string;
  "mr-commits.txt": string;
  "changed-files.txt": string;
  "mr-diff-stat.txt": string;
}

/**
 * Turns GitLab's MR diffs/commits payloads into the files the agent container
 * mounts at `/mr-input`. The GitLab Changes tab is the source of truth — not
 * `git log -1` of a checkout.
 *
 * Returned as content rather than written to disk: `runAgentJob` owns the temp
 * directory, so a caller cannot leak one by throwing between mkdtemp and rm.
 */
export function reviewContextFiles(input: {
  diffs: MergeRequestDiff[];
  commits: MergeRequestCommit[];
}): ReviewContextFiles {
  const files = changedPaths(input.diffs);
  const bodies: string[] = [];
  let bytes = 0;
  let omitted = 0;

  for (const diff of input.diffs) {
    const chunk = formatOneDiff(diff);
    const encoded = new TextEncoder().encode(chunk);
    if (bytes + encoded.byteLength > MAX_REVIEW_DIFF_BYTES) {
      omitted++;
      continue;
    }
    bodies.push(chunk);
    bytes += encoded.byteLength;
  }

  if (omitted > 0) {
    bodies.push(
      `\n# … ${omitted} further file diff(s) omitted after ${MAX_REVIEW_DIFF_BYTES} bytes; see changed-files.txt for the full path list.\n`,
    );
  }

  const diffText =
    bodies.length > 0
      ? bodies.join("\n")
      : "# GitLab reported no file diffs on this merge request.\n";

  return {
    "mr.diff": diffText,
    "mr-commits.txt": formatCommits(input.commits),
    "changed-files.txt": files.length > 0 ? `${files.join("\n")}\n` : "",
    "mr-diff-stat.txt": `${files.length} file(s) changed across ${input.commits.length} commit(s) on the merge request.\n`,
  };
}

export function changedPaths(diffs: MergeRequestDiff[]): string[] {
  const paths = new Set<string>();
  for (const diff of diffs) {
    if (diff.new_path) paths.add(diff.new_path);
    if (diff.old_path && diff.old_path !== diff.new_path) paths.add(diff.old_path);
  }
  return [...paths].sort();
}

function formatCommits(commits: MergeRequestCommit[]): string {
  if (commits.length === 0) return "(GitLab listed no commits on this merge request)\n";
  return (
    commits
      .map((c) => {
        const sha = c.short_id ?? c.id.slice(0, 8);
        return `${sha} ${c.title}`;
      })
      .join("\n") + "\n"
  );
}

function formatOneDiff(diff: MergeRequestDiff): string {
  const header = `diff --git a/${diff.old_path} b/${diff.new_path}`;
  const flags = [
    diff.new_file ? "new file" : "",
    diff.deleted_file ? "deleted file" : "",
    diff.renamed_file ? "renamed" : "",
    diff.too_large ? "too_large (hunk omitted by GitLab)" : "",
  ]
    .filter(Boolean)
    .join(", ");
  const body =
    diff.diff && diff.diff.length > 0
      ? diff.diff.endsWith("\n")
        ? diff.diff
        : `${diff.diff}\n`
      : "(no hunk)\n";
  return flags ? `${header}\n# ${flags}\n${body}` : `${header}\n${body}`;
}
