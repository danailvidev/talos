import { branchSlug } from "../../core/git-ref.ts";

export function e2eTestBranchName(issueKey: string, sourceJobId: string): string {
  const issue = branchSlug(issueKey, 32) || "ticket";
  const run = branchSlug(sourceJobId, 8) || "run";
  return `test/e2e-${issue}-${run}`;
}
