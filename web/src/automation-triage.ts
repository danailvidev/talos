import type {
  AutomationAiTriageVerdict,
  AutomationClusterTriageState,
  AutomationFailureClusterView,
} from "./api.ts";

export const AUTOMATION_TRIAGE_PREFERENCE_KEY = "automation.failure-triage.filters";
export const AUTOMATION_BULK_TICKET_LIMIT = 20;

export interface AutomationTriageFilters {
  search: string;
  jobId?: number;
  suiteIndex?: number;
  state?: AutomationClusterTriageState;
  limit: 25 | 50;
}

export const DEFAULT_AUTOMATION_TRIAGE_FILTERS: AutomationTriageFilters = {
  search: "",
  limit: 25,
};

const AUTOMATION_AI_TRIAGE_VERDICT_LABELS = {
  "service-breaking-change": "Service breaking change",
  "ui-change": "UI change",
  "bad-data": "Bad data",
  "test-bug": "Test bug",
  infrastructure: "Infrastructure",
  unknown: "Unknown",
} satisfies Record<AutomationAiTriageVerdict, string>;

export function automationAiTriageVerdictLabel(
  verdict: AutomationAiTriageVerdict,
): string {
  return AUTOMATION_AI_TRIAGE_VERDICT_LABELS[verdict];
}

export function automationFailureWorkStatus(
  cluster: Pick<AutomationFailureClusterView, "triageState" | "creating">,
): "running" | "success" | "enabled" | "disabled" {
  if (cluster.creating) return "running";
  if (cluster.triageState === "active-mr") return "success";
  if (cluster.triageState === "ticketed") return "enabled";
  return "disabled";
}

export interface AutomationClusterActionState {
  ticket: {
    disabled: boolean;
    reason?: string;
  };
  triage: {
    active: boolean;
    disabled: boolean;
    label: "Triage" | "Triaging…" | "Re-run triage";
    reason?: string;
  };
}

export function automationClusterActionState(
  cluster: Pick<
    AutomationFailureClusterView,
    | "triageState"
    | "creating"
    | "work"
    | "ticketRefusal"
    | "aiTriage"
    | "aiTriageInFlight"
    | "aiTriageRefusal"
  >,
  options: {
    ticketBusy?: boolean;
    triageBusy?: boolean;
  } = {},
): AutomationClusterActionState {
  const ticketBusy = options.ticketBusy ?? false;
  const triageActive = cluster.aiTriageInFlight || (options.triageBusy ?? false);
  const ticketReason = cluster.ticketRefusal
    ? cluster.ticketRefusal
    : ticketBusy || cluster.creating
      ? "Jira ticket creation is already in progress."
      : cluster.work?.mrUrl || cluster.triageState === "active-mr"
        ? "An active merge request already covers this cluster."
        : cluster.work?.jiraUrl || cluster.triageState === "ticketed"
          ? "A Jira ticket already covers this cluster."
          : undefined;
  const triageReason = cluster.aiTriageRefusal
    ? cluster.aiTriageRefusal
    : triageActive
      ? "AI triage is already running for this cluster."
      : undefined;

  return {
    ticket: {
      disabled: ticketReason != null,
      ...(ticketReason ? { reason: ticketReason } : {}),
    },
    triage: {
      active: triageActive,
      disabled: triageReason != null,
      label: triageActive
        ? "Triaging…"
        : cluster.aiTriage
          ? "Re-run triage"
          : "Triage",
      ...(triageReason ? { reason: triageReason } : {}),
    },
  };
}

export function parseAutomationTriageFilters(raw: unknown): AutomationTriageFilters {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_AUTOMATION_TRIAGE_FILTERS;
  }
  const value = raw as Record<string, unknown>;
  const search =
    typeof value.search === "string" ? value.search.slice(0, 200) : "";
  const jobId = positiveInteger(value.jobId);
  const suiteIndex = nonNegativeInteger(value.suiteIndex);
  const state =
    value.state === "untriaged" ||
    value.state === "ticketed" ||
    value.state === "active-mr"
      ? value.state
      : undefined;
  const limit = value.limit === 50 ? 50 : 25;

  return {
    search,
    ...(jobId == null ? {} : { jobId }),
    ...(suiteIndex == null ? {} : { suiteIndex }),
    ...(state == null ? {} : { state }),
    limit,
  };
}

export function canSelectForTicket(
  cluster: Pick<AutomationFailureClusterView, "triageState" | "creating">,
): boolean {
  return cluster.triageState === "untriaged" && !cluster.creating;
}

export function updateClusterSelection(
  selected: ReadonlySet<string>,
  signatureKey: string,
  checked: boolean,
  selectable: boolean,
  max = AUTOMATION_BULK_TICKET_LIMIT,
): Set<string> {
  const next = new Set(selected);
  if (!checked) {
    next.delete(signatureKey);
    return next;
  }
  if (!selectable || next.size >= max) return next;
  next.add(signatureKey);
  return next;
}

export function selectablePageKeys(
  clusters: readonly AutomationFailureClusterView[],
): string[] {
  return clusters
    .filter(canSelectForTicket)
    .map((cluster) => cluster.signatureKey);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}
