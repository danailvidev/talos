import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import type {
  PullRequestDetailView,
  PullRequestsView,
} from "../../shared/api-contract.ts";
import { keys } from "../src/query-keys.ts";
import { reconcilePullRequestThreadState } from "../src/queries.ts";

function detail(openThreadCount: number): PullRequestDetailView {
  return {
    provider: "gitlab",
    id: "gitlab:group/project!7",
    number: 7,
    title: "A merge request",
    state: "open",
    sourceBranch: "feature",
    targetBranch: "main",
    webUrl: "https://gitlab.example/group/project/-/merge_requests/7",
    updatedAt: "2026-10-27T12:00:00.000Z",
    reviewers: [],
    assignees: [],
    mergeability: "clean",
    threads: [],
    openThreadCount,
    commits: [],
    pipelines: [],
    labels: [],
    actions: [],
  };
}

function listing(hasUnresolvedThreads: boolean): PullRequestsView {
  return {
    scope: "mine",
    states: ["open", "draft"],
    repositoryFilter: [],
    unavailable: [],
    failed: [],
    pullRequests: [
      {
        provider: "gitlab",
        id: "gitlab:group/project!7",
        number: 7,
        title: "A merge request",
        state: "open",
        sourceBranch: "feature",
        targetBranch: "main",
        webUrl: "https://gitlab.example/group/project/-/merge_requests/7",
        updatedAt: "2026-10-27T12:00:00.000Z",
        ...(hasUnresolvedThreads ? { hasUnresolvedThreads: true } : {}),
      },
    ],
  };
}

describe("pull request query state", () => {
  test("clears a stale unresolved-thread indicator after a fresh detail fetch", () => {
    const client = new QueryClient();
    const key = keys.prs("mine", ["open", "draft"]);
    client.setQueryData(key, listing(true));

    reconcilePullRequestThreadState(client, detail(0));

    expect(client.getQueryData<PullRequestsView>(key)?.pullRequests[0]).not.toHaveProperty(
      "hasUnresolvedThreads",
    );
  });

  test("sets the indicator when the fresh detail has an open thread", () => {
    const client = new QueryClient();
    const key = keys.prs("mine", ["open", "draft"]);
    client.setQueryData(key, listing(false));

    reconcilePullRequestThreadState(client, detail(1));

    expect(client.getQueryData<PullRequestsView>(key)?.pullRequests[0]?.hasUnresolvedThreads).toBe(
      true,
    );
  });
});
