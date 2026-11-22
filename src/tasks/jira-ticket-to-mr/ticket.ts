import { createHash } from "node:crypto";
import { branchSlug } from "../../core/git-ref.ts";

/**
 * What this loop tracks, and how a crashed attempt finds its own work again.
 *
 * The subject is the **ticket**: it outlives every branch and merge request raised
 * for it, and "one open attempt per ticket" is the rule an operator expects. The
 * fingerprint is the ticket's `updated` timestamp, which moves when someone edits
 * the description, adds a comment, or changes the acceptance criteria — all of
 * which mean "look again", and none of which we could detect by diffing anything.
 *
 * The branch name is derived from both, and that is what makes recovery work. A
 * job that pushed a branch and then died before opening the merge request must,
 * on its next attempt, arrive at the *same* branch name — otherwise it would push
 * a second branch of identical work. Deriving it from (key, fingerprint) gives
 * exactly that: deterministic within one version of the ticket, and different
 * once the ticket has been edited, so a second attempt at a rewritten ticket does
 * not collide with the abandoned first one.
 */

/** Namespaced so one subject table can hold every loop's subjects without collision. */
export function ticketSubjectKey(issueKey: string): string {
  return `jira:ticket-mr:${issueKey}`;
}

/**
 * The branch a given version of a ticket is implemented on.
 *
 * `talos/` prefixed so these are obvious in the branch list and easy to
 * protect against; the issue key kept literal so a human can read it; an
 * eight-character digest of the fingerprint appended to distinguish versions.
 * Sanitized because git refuses names containing `..`, spaces, `~`, `^`, `:`, `?`,
 * `*`, `[` or a trailing `.` — and a Jira key from a hand-made project can contain
 * more than the docs suggest.
 */
export function ticketBranchName(issueKey: string, fingerprint: string): string {
  const slug = branchSlug(issueKey);
  const digest = createHash("sha256").update(fingerprint).digest("hex").slice(0, 8);
  return `talos/${slug || "ticket"}-${digest}`;
}

/**
 * The version of a ticket last acted on.
 *
 * Falls back to the key itself when Jira reports no `updated` — every issue has
 * one in practice, but a fingerprint of `""` would compare equal across genuinely
 * different versions, and silently never re-attempting is worse than never
 * re-attempting loudly.
 */
export function ticketFingerprint(issueKey: string, updated?: string): string {
  return updated && updated.trim() !== "" ? updated : `no-updated:${issueKey}`;
}

/** Labels every merge request this loop opens carries, so they are filterable. */
export function ticketLabels(issueKey: string): string[] {
  return ["talos", `jira:${issueKey}`];
}
