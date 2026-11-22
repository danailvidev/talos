import type { E2ePullRequestCandidateView } from "../api.ts";

export function defaultE2eCandidate(
  candidates: readonly E2ePullRequestCandidateView[],
): E2ePullRequestCandidateView | undefined {
  return candidates[0];
}
