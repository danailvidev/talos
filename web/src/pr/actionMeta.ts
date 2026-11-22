import { GitMerge, MessagesSquare, Pencil, ScanSearch, type LucideIcon } from "lucide-react";

import type { PullRequestActionId } from "../api.ts";

/**
 * Label, icon and one-line explanation for each agent action —
 * shared by the detail pane's dropdown and the list row's running badge, so a
 * developer sees the same name and icon for "code review" wherever it shows up.
 */
export const ACTION_META: Record<
  PullRequestActionId,
  { label: string; icon: LucideIcon; blurb: string }
> = {
  "resolve-conflicts": {
    label: "Resolve conflicts",
    icon: GitMerge,
    blurb: "Rebase onto the target branch, resolve each conflict, and force-push with a lease.",
  },
  "address-comments": {
    label: "Address comments",
    icon: MessagesSquare,
    blurb: "Work through the open review threads and push the changes they asked for.",
  },
  "code-review": {
    label: "Code review",
    icon: ScanSearch,
    blurb: "Review the diff against the repository's own guidelines and post the findings.",
  },
  revise: {
    label: "Revise with AI",
    icon: Pencil,
    blurb: "Ask for another change on the existing merge request branch.",
  },
};

/** One-click menu actions; revision needs text and has its own conversation tab. */
export const ACTION_ORDER: readonly PullRequestActionId[] = [
  "resolve-conflicts",
  "address-comments",
  "code-review",
];
