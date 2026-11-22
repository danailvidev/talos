function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export interface CiFailureConfig {
  gitlabProject: string;
  jiraProject: string;
  bugFoundBy: string;
  pipelineSchedule: string;
  labels: string[];
  assigneeMode: "automatic" | "fixed";
  assignee: string;
  /**
   * Consecutive failures before a ticket is filed. Kept as a string because it is
   * bound to a text input, and an empty field has to mean "leave the default" —
   * which `0` and `NaN` both fail to express.
   */
  failuresBeforeFiling: string;
  /** Recent conclusive pipelines a verdict is judged over. Same string reasoning. */
  historyWindow: string;
}

/** The server's own defaults, shown as placeholders so the form can stay empty. */
export const CI_FAILURE_DEFAULTS = { failuresBeforeFiling: 2, historyWindow: 10 } as const;

function numberField(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/** Everything the CI-failure Settings tab edits, read out of the stored params (empty if unset). */
export function ciFailureConfig(params: unknown): CiFailureConfig {
  const root = asRecord(params);
  const gitlab = asRecord(root.gitlab);
  const jira = asRecord(root.jira);
  const labels = Array.isArray(jira.labels)
    ? jira.labels.filter((label): label is string => typeof label === "string")
    : [];
  return {
    gitlabProject: gitlab.projectId != null ? String(gitlab.projectId) : "",
    jiraProject: typeof jira.project === "string" ? jira.project : "",
    bugFoundBy: typeof jira.bugFoundBy === "string" ? jira.bugFoundBy : "",
    pipelineSchedule: typeof root.pipelineSchedule === "string" ? root.pipelineSchedule : "",
    labels,
    assignee: typeof jira.assignee === "string" ? jira.assignee : "",
    assigneeMode:
      jira.assigneeMode === "automatic"
        ? "automatic"
        : typeof jira.assignee === "string"
          ? "fixed"
          : "automatic",
    failuresBeforeFiling: numberField(root.failuresBeforeFiling),
    historyWindow: numberField(root.historyWindow),
  };
}

export function withCiFailureConfig(params: unknown, config: CiFailureConfig): Record<string, unknown> {
  const root = asRecord(params);
  return {
    ...root,
    gitlab: { ...asRecord(root.gitlab), projectId: config.gitlabProject },
    jira: {
      ...asRecord(root.jira),
      project: config.jiraProject,
      bugFoundBy: config.bugFoundBy,
      labels: config.labels,
      assigneeMode: config.assigneeMode,
      assignee: config.assigneeMode === "fixed" ? config.assignee || undefined : undefined,
    },
    pipelineSchedule: config.pipelineSchedule || undefined,
    // Undefined rather than a number when blank, so the schema default applies and
    // the stored params do not pin a threshold the operator never chose.
    failuresBeforeFiling: toNumber(config.failuresBeforeFiling),
    historyWindow: toNumber(config.historyWindow),
  };
}

function toNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}
