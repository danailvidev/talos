import { DEFAULT_DASHBOARD_ID } from "../../../shared/dashboard.ts";

/** Preference key for the overview that was open when the user left the page. */
export const LAST_DASHBOARD_PREFERENCE = "overview.dashboard";

/** A stored id, or nothing when the value is missing or not a dashboard id. */
export function parseLastDashboard(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const id = raw.trim();
  if (!id || id.length > 80) return undefined;
  return id;
}

/**
 * Which overview to open when the route does not name one.
 *
 * The built-in TALOS dashboard is always available. A saved id is reopened only
 * while that dashboard still exists; otherwise the newest saved one is used.
 */
export function dashboardToReopen(
  remembered: string | undefined,
  saved: readonly { id: string }[],
): string | undefined {
  if (remembered === DEFAULT_DASHBOARD_ID) return DEFAULT_DASHBOARD_ID;
  if (remembered && saved.some((dashboard) => dashboard.id === remembered)) return remembered;
  return saved[0]?.id;
}
