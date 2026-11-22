import { branchSlug } from "../../core/git-ref.ts";

/**
 * The branch one run of this task pushes.
 *
 * `fix/` prefixed to match this team's own convention rather than the
 * `talos/` prefix the ticket-to-MR loop uses — this task is triggered by
 * hand for one issue at a time, not a retry-safe loop, so there is no
 * fingerprint suffix: running it twice on the same issue is a decision the
 * operator makes, and the container's own refusal to push over an existing
 * branch (`writePolicy: "push+mr"`) is what surfaces that as a clear error.
 *
 * Both parts go through `branchSlug`, which owns the truncation: a summary like
 * "Unit test failure: rich-text-editor.component.spec.ts" cut naively at 50
 * characters ends on a `.`, and git rejects that name at the push — after the
 * agent has already done the work.
 */
export function fixIssueBranchName(issueKey: string, summary: string): string {
  const key = branchSlug(issueKey) || "issue";
  const summarySlug = branchSlug(summary, 50);
  return summarySlug ? `fix/${key}-${summarySlug}` : `fix/${key}`;
}
