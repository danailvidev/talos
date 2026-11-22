import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from "lucide-react";

import type { PullRequestState } from "../api.ts";

/**
 * The states a filter offers, in the order they are offered: still-active work
 * first. Mirrors `PULL_REQUEST_STATES` on the server — the wire format is the
 * shared contract, so this is a rendering list, not a second definition.
 *
 * In its own module so the list rows, the filter and the detail pane all label a
 * state the same way, without the detail having to import the page that renders it.
 */
export const STATE_META: { state: PullRequestState; label: string; icon: LucideIcon }[] = [
  { state: "open", label: "Open", icon: GitPullRequest },
  { state: "draft", label: "Draft", icon: GitPullRequestDraft },
  { state: "merged", label: "Merged", icon: GitMerge },
  { state: "closed", label: "Closed", icon: GitPullRequestClosed },
];

export function stateMeta(state: PullRequestState) {
  return STATE_META.find((meta) => meta.state === state) ?? STATE_META[0]!;
}
