import type { AutomationFailureInboxFilter } from "./api.ts";
import type { AutomationFailureRoute } from "./route-state.ts";

export const DEFAULT_AUTOMATION_FAILURE_ROUTE: Required<
  Pick<
    AutomationFailureRoute,
    "days" | "presence" | "limit" | "offset"
  >
> = {
  days: 30,
  presence: "current",
  limit: 25,
  offset: 0,
};

export function automationFailureInboxFilter(
  route: AutomationFailureRoute | undefined,
): AutomationFailureInboxFilter {
  return {
    days: route?.days ?? DEFAULT_AUTOMATION_FAILURE_ROUTE.days,
    presence: route?.presence ?? DEFAULT_AUTOMATION_FAILURE_ROUTE.presence,
    limit: route?.limit ?? DEFAULT_AUTOMATION_FAILURE_ROUTE.limit,
    offset: route?.offset ?? DEFAULT_AUTOMATION_FAILURE_ROUTE.offset,
    ...(route?.scheduleId != null ? { scheduleId: route.scheduleId } : {}),
    ...(route?.pipelineId != null ? { pipelineId: route.pipelineId } : {}),
    ...(route?.state ? { state: route.state } : {}),
    ...(route?.q?.trim() ? { search: route.q.trim() } : {}),
  };
}

export function updateAutomationFailureRoute(
  current: AutomationFailureRoute | undefined,
  patch: Partial<AutomationFailureRoute>,
): AutomationFailureRoute {
  const next = { ...current, ...patch };
  for (const key of Object.keys(next) as Array<keyof AutomationFailureRoute>) {
    if (next[key] == null || next[key] === "") delete next[key];
  }
  return next;
}
