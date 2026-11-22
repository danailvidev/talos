import type { MergeRequest } from "../../connectors/gitlab/types.ts";
import type { ReviewFinding } from "./review-result.ts";

/** Fixed prefix every posted review comment starts with; see `isReviewNoteFor`. */
const AI_REVIEW_PREFIX = "**AI review**";

/**
 * Whether an existing note is one of ours, for this exact head commit — the
 * short sha `formatReviewNote` embeds in its header line is the only marker
 * available, so matching it is how a repeat run recognizes "already done."
 */
export function isReviewNoteFor(body: string, sha: string): boolean {
  return body.startsWith(AI_REVIEW_PREFIX) && body.includes(sha.slice(0, 8));
}

/**
 * Same shape as GitLab Duo's activity row: a single timeline note that the
 * review is underway, later replaced in place with the finished comment.
 */
export function formatProgressNote(sessionId: string): string {
  return `Talos started review session ${sessionId} and will let you know when it's finished.`;
}

export function formatFailedNote(sessionId: string, error: string): string {
  return (
    `Talos started review session ${sessionId} but the review failed.\n\n` +
    `\`\`\`\n${error}\n\`\`\``
  );
}

export function formatReviewNote(
  mr: MergeRequest,
  summary: string,
  findings: ReviewFinding[],
): string {
  const lines = [`${AI_REVIEW_PREFIX} (${mr.source_branch} @ ${mr.sha?.slice(0, 8)})`, "", summary];

  if (findings.length > 0) {
    lines.push("", "| Severity | File | Comment |", "| --- | --- | --- |");
    for (const f of findings) {
      const location = f.line != null ? `${f.file}:${f.line}` : f.file;
      lines.push(`| ${f.severity} | ${location} | ${f.comment.replace(/\|/g, "\\|")} |`);
    }
  }

  return lines.join("\n");
}
