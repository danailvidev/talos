import type {
  AutomationConfigPatch,
  AutomationConfigView,
} from "./api.ts";

export const AUTOMATION_JIRA_DEFAULT_LABELS = ["talos", "automation"];

export interface AutomationJiraDraft {
  projectKey: string;
  parentKey: string;
  issueType: string;
  boardId: string;
  useActiveSprint: boolean;
  labels: string[];
  assigneeMode: "automatic" | "fixed";
  fixedAssignee: string;
}

export function automationJiraDraft(
  config: Pick<AutomationConfigView, "jira">,
): AutomationJiraDraft {
  const jira = config.jira;
  return {
    projectKey: jira?.projectKey ?? "",
    parentKey: jira?.parentKey ?? "",
    issueType: jira?.issueType ?? "Bug",
    boardId: jira?.boardId == null ? "" : String(jira.boardId),
    useActiveSprint: jira?.useActiveSprint ?? true,
    labels: jira?.labels ?? [...AUTOMATION_JIRA_DEFAULT_LABELS],
    assigneeMode: jira?.assigneeMode ?? "automatic",
    fixedAssignee: jira?.fixedAssignee ?? "",
  };
}

export function automationJiraPatch(
  draft: AutomationJiraDraft,
): AutomationConfigPatch["jira"] {
  if (!draft.projectKey.trim()) return null;
  return {
    projectKey: draft.projectKey.trim().toUpperCase(),
    ...(draft.parentKey.trim()
      ? { parentKey: draft.parentKey.trim().toUpperCase() }
      : {}),
    issueType: draft.issueType.trim(),
    ...(draft.boardId.trim() ? { boardId: Number(draft.boardId.trim()) } : {}),
    useActiveSprint: draft.useActiveSprint,
    labels: draft.labels.map((label) => label.trim()),
    assigneeMode: draft.assigneeMode,
    ...(draft.assigneeMode === "fixed"
      ? { fixedAssignee: draft.fixedAssignee.trim() }
      : {}),
  };
}

export function automationJiraValidationError(
  draft: AutomationJiraDraft,
): string | undefined {
  if (!draft.projectKey.trim()) return undefined;
  if (!/^[A-Z][A-Z0-9_]{1,9}$/.test(draft.projectKey.trim().toUpperCase())) {
    return "Jira project key must be 2-10 letters, numbers, or underscores and start with a letter.";
  }
  if (!draft.issueType.trim()) return "Jira issue type is required.";
  if (
    draft.parentKey.trim() &&
    !/^[A-Z][A-Z0-9_]*-\d+$/.test(draft.parentKey.trim().toUpperCase())
  ) {
    return "Default parent ticket must be a Jira issue key such as TP-123.";
  }
  const boardId = draft.boardId.trim();
  if (
    boardId &&
    (!/^[1-9]\d*$/.test(boardId) || !Number.isSafeInteger(Number(boardId)))
  ) {
    return "Jira board ID must be a positive integer.";
  }
  const seen = new Set<string>();
  for (const labelValue of draft.labels) {
    const label = labelValue.trim();
    if (!label || label.length > 255 || /[\s,\u0000-\u001f\u007f]/.test(label)) {
      return "Jira labels must be non-empty, at most 255 characters, and contain no spaces or commas.";
    }
    if (seen.has(label)) return `Jira label '${label}' is duplicated.`;
    seen.add(label);
  }
  if (draft.assigneeMode === "fixed" && !draft.fixedAssignee.trim()) {
    return "Choose a fixed Jira assignee or use Automatic.";
  }
  return undefined;
}
