import { branchSlug } from "../../core/git-ref.ts";

/**
 * The branch one attempt pushes.
 *
 * `test/` prefixed rather than `fix/`, because the change is a test and nothing
 * else — a reviewer sorting branches should be able to tell those apart without
 * opening either. The issue id is in the name rather than a slug alone: two
 * production errors routinely share a title ("TypeError: undefined is not a
 * function") and would otherwise collide on a branch the container refuses to
 * overwrite, which reads as a mysterious failure rather than as two errors.
 *
 * `branchSlug` owns the truncation of every part, so no cut can land on a `.` and
 * produce a name git only rejects once the push is attempted.
 */
export function regressionTestBranchName(
  source: string,
  issueId: string,
  title: string,
): string {
  // The store's ids are UUIDs; the leading block is plenty to disambiguate and
  // keeps the branch readable.
  const id = branchSlug(issueId, 8) || "error";
  const titleSlug = branchSlug(title, 40);
  const stem = `test/${branchSlug(source)}-${id}`;
  return titleSlug ? `${stem}-${titleSlug}` : stem;
}
