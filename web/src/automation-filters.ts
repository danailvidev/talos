import type { AutomationDashboardFilter } from "./api.ts";

export const AUTOMATION_FILTERS_PREFERENCE_KEY = "automation.filters";
export const AUTOMATION_DASHBOARD_CARD_ORDER_PREFERENCE_KEY =
  "automation.dashboard-card-order";
export const AUTOMATION_DASHBOARD_HIDDEN_CARDS_PREFERENCE_KEY =
  "automation.dashboard-hidden-cards";

export const AUTOMATION_DASHBOARD_CARD_IDS = [
  "readiness",
  "quality",
  "duration",
  "suite-health",
  "outcomes",
  "attention",
] as const;
export const AUTOMATION_DASHBOARD_PLACEHOLDER_IDS = [
  "placeholder-1",
  "placeholder-2",
] as const;

export type AutomationDashboardCardId =
  (typeof AUTOMATION_DASHBOARD_CARD_IDS)[number];

export const AUTOMATION_STATUS_OPTIONS = [
  "created",
  "waiting_for_resource",
  "waiting_for_callback",
  "preparing",
  "success",
  "failed",
  "running",
  "pending",
  "canceled",
  "canceling",
  "skipped",
  "manual",
  "scheduled",
] as const;

const AUTOMATION_DAYS = new Set([1, 7, 30]);
const AUTOMATION_STATUSES = new Set<string>(AUTOMATION_STATUS_OPTIONS);

/** Safely reads this user's persisted Automation dashboard filters. */
export function parseAutomationFilters(raw: unknown): AutomationDashboardFilter {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { days: 30 };
  const value = raw as Record<string, unknown>;
  const days = AUTOMATION_DAYS.has(Number(value.days))
    ? (Number(value.days) as 1 | 7 | 30)
    : 30;
  const scheduleId =
    Number.isSafeInteger(value.scheduleId) && Number(value.scheduleId) > 0
      ? Number(value.scheduleId)
      : undefined;
  const status =
    typeof value.status === "string" && AUTOMATION_STATUSES.has(value.status)
      ? value.status
      : undefined;
  return {
    days,
    ...(scheduleId != null ? { scheduleId } : {}),
    ...(status != null ? { status } : {}),
  };
}

/** Keeps valid saved positions and appends cards introduced by newer releases. */
export function parseAutomationDashboardCardOrder(
  raw: unknown,
): AutomationDashboardCardId[] {
  if (!Array.isArray(raw)) return [...AUTOMATION_DASHBOARD_CARD_IDS];
  const order = validAutomationDashboardCardIds(raw);
  const seen = new Set(order);
  for (const id of AUTOMATION_DASHBOARD_CARD_IDS) {
    if (!seen.has(id)) order.push(id);
  }
  return order;
}

/** Ignores removed, malformed, and duplicate card ids in the visibility preference. */
export function parseAutomationDashboardHiddenCards(
  raw: unknown,
): AutomationDashboardCardId[] {
  return Array.isArray(raw) ? validAutomationDashboardCardIds(raw) : [];
}

/**
 * Reorders visible cards without moving hidden cards from their saved positions.
 * Showing a card again therefore restores it where the user last left it.
 */
export function mergeAutomationDashboardCardOrder(
  current: readonly AutomationDashboardCardId[],
  nextVisible: readonly string[],
  hidden: ReadonlySet<AutomationDashboardCardId>,
): AutomationDashboardCardId[] {
  const normalized = parseAutomationDashboardCardOrder(current);
  const visible = validAutomationDashboardCardIds(nextVisible).filter(
    (id) => !hidden.has(id),
  );
  const seen = new Set(visible);
  for (const id of normalized) {
    if (!hidden.has(id) && !seen.has(id)) {
      visible.push(id);
      seen.add(id);
    }
  }

  let visibleIndex = 0;
  return normalized.map((id) =>
    hidden.has(id) ? id : visible[visibleIndex++]!,
  );
}

function validAutomationDashboardCardIds(
  values: readonly unknown[],
): AutomationDashboardCardId[] {
  const valid = new Set<AutomationDashboardCardId>(
    AUTOMATION_DASHBOARD_CARD_IDS,
  );
  const seen = new Set<AutomationDashboardCardId>();
  const order: AutomationDashboardCardId[] = [];
  for (const value of values) {
    if (
      typeof value === "string" &&
      valid.has(value as AutomationDashboardCardId) &&
      !seen.has(value as AutomationDashboardCardId)
    ) {
      const id = value as AutomationDashboardCardId;
      seen.add(id);
      order.push(id);
    }
  }
  return order;
}
