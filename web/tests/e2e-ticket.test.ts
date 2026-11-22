import { describe, expect, test } from "bun:test";
import type { E2ePullRequestCandidateView } from "../src/api.ts";
import { defaultE2eCandidate } from "../src/graph/e2e.ts";

function candidate(
  projectId: string,
  mrIid: number,
): E2ePullRequestCandidateView {
  return {
    projectId,
    mrIid,
    title: `MR ${mrIid}`,
    url: `https://gitlab.example/${projectId}/-/merge_requests/${mrIid}`,
    sourceBranch: `feature-${mrIid}`,
    targetBranch: "develop",
    draft: false,
    updatedAt: `2026-09-${mrIid}T00:00:00.000Z`,
  };
}

describe("ticket E2E merge-request selection", () => {
  test("uses the first candidate from the server's newest-first list", () => {
    const candidates = [
      candidate("group/app", 25),
      candidate("group/app", 24),
      candidate("group/app", 23),
    ];
    expect(defaultE2eCandidate(candidates)?.mrIid).toBe(25);
  });

  test("has no default when the ticket has no linked merge request", () => {
    expect(defaultE2eCandidate([])).toBeUndefined();
  });
});
