import type { TaskSummary } from "./api.ts";

const INTERNAL_DEFINITIONS = new Set(["gitlab-mr-follow-up-one"]);
const HIDDEN_WORK_DEFINITIONS = new Set([
  "datadog-scan",
  "gitlab-ci-failure",
  "gitlab-code-review",
  "gitlab-review-requested",
  "gitlab-mr-follow-up",
  "gitlab-mr-follow-up-one",
  "jira-ticket-to-mr",
  "release-repo-poll",
  // The custom loop's template, unlike the others, cannot run as itself: every
  // field that decides what it does is typed on the create form, so the bare
  // definition has no prompt and a Run on it can only fail. It belongs in the
  // Automation dropdown, not in the list of loops.
  "custom-loop",
]);

/**
 * Separates creatable loop templates from the loops users should see in lists.
 *
 * Only loops, since the ad-hoc Tasks page is retired — `/api/tasks` still
 * returns `kind: "task"` rows (the CLI and schedules use them), and this is
 * where they are dropped rather than at the API, which stays honest about what
 * is registered.
 */
export function loopRowsFrom(rows: TaskSummary[]): {
  work: TaskSummary[];
  definitions: TaskSummary[];
} {
  const matching = rows.filter((row) => row.kind === "loop");
  return {
    definitions: matching.filter(
      (row) => row.instantiable && !row.createdAt && !INTERNAL_DEFINITIONS.has(row.id),
    ),
    work: matching.filter((row) => row.createdAt || !HIDDEN_WORK_DEFINITIONS.has(row.id)),
  };
}
