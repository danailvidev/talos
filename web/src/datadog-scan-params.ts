function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export interface DatadogScanConfig {
  query: string;
  lookbackHours: string;
  servicePageSize: string;
  samplesPerService: string;
  jiraProject: string;
  issueType: string;
  assigneeMode: "automatic" | "fixed";
  assignee: string;
  labels: string[];
  bugFoundBy: string;
  feBeUx: string;
  useActiveSprint: boolean;
  boardId: string;
}

function numberField(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

export function datadogScanConfig(params: unknown): DatadogScanConfig {
  const root = asRecord(params);
  const jira = asRecord(root.jira);
  return {
    query: typeof root.query === "string" ? root.query : "",
    lookbackHours: numberField(root.lookbackHours),
    servicePageSize: numberField(root.maxServices),
    samplesPerService: numberField(root.samplesPerService),
    jiraProject: typeof jira.project === "string" ? jira.project : "",
    issueType: typeof jira.issueType === "string" ? jira.issueType : "Bug",
    assigneeMode: jira.assigneeMode === "fixed" ? "fixed" : "automatic",
    assignee: typeof jira.assignee === "string" ? jira.assignee : "",
    labels: Array.isArray(jira.labels)
      ? jira.labels.filter((label): label is string => typeof label === "string")
      : ["talos", "datadog"],
    bugFoundBy: typeof jira.bugFoundBy === "string" ? jira.bugFoundBy : "",
    feBeUx: typeof jira.feBeUx === "string" ? jira.feBeUx : "",
    useActiveSprint: true,
    boardId: numberField(jira.boardId),
  };
}

export function withDatadogScanConfig(
  params: unknown,
  config: DatadogScanConfig,
): Record<string, unknown> {
  const root = asRecord(params);
  return {
    ...root,
    query: config.query.trim() || undefined,
    lookbackHours: toNumber(config.lookbackHours),
    maxServices: toNumber(config.servicePageSize),
    samplesPerService: toNumber(config.samplesPerService),
    jira: {
      ...asRecord(root.jira),
      project: config.jiraProject.trim().toUpperCase(),
      issueType: config.issueType.trim(),
      assigneeMode: config.assigneeMode,
      assignee:
        config.assigneeMode === "fixed"
          ? config.assignee.trim() || undefined
          : undefined,
      labels: config.labels,
      bugFoundBy: config.bugFoundBy.trim() || undefined,
      feBeUx: config.feBeUx.trim() || undefined,
      useActiveSprint: true,
      boardId: toNumber(config.boardId),
    },
  };
}

function toNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}
