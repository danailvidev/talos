export type Page =
  | "dashboard"
  | "loops"
  | "pull-requests"
  | "releases"
  | "automation"
  | "space"
  | "logrocket"
  | "datadog"
  | "slack"
  | "admin"
  | "settings";
/**
 * Whose work a page shows. Shared by loops (where "team" is the default, so only
 * "mine" needs to appear in the URL), pull requests and ticket spaces (where "mine"
 * is the default, so only "team" does) — `pathFor` writes whichever is not that
 * page's default, and all parse back the same way.
 */
export type OwnerTab = "team" | "mine";
export type ReleasesTab = "environments" | "history" | "watch";
export type AutomationTab = "reports" | "failures" | "settings";
export interface AutomationFailureRoute {
  days?: 1 | 7 | 30;
  scheduleId?: number;
  pipelineId?: number;
  presence?: "current" | "recent";
  state?: "untriaged" | "ticketed" | "active-mr";
  q?: string;
  limit?: 25 | 50;
  offset?: number;
}
export type AdminTab = "users" | "roles" | "feedback" | "logs" | "orchestration";
export type SettingsTab =
  | "general"
  | "integrations"
  | "prompts"
  | "e2e-tests"
  | "pull-requests"
  | "releases";

/**
 * Every settings tab except the default one, which is what can appear in
 * `?settingsTab`. A closed set matched by name, so an unknown value falls back
 * to General rather than rendering an empty page.
 */
const NON_DEFAULT_SETTINGS_TABS: readonly SettingsTab[] = [
  "integrations",
  "prompts",
  "e2e-tests",
  "pull-requests",
  "releases",
];

export interface RouteState {
  page: Page;
  id?: string;
  add?: boolean;
  tab?: OwnerTab;
  releasesTab?: ReleasesTab;
  automationTab?: AutomationTab;
  automationFailures?: AutomationFailureRoute;
  /** Which face of the Loops page is showing: the card dashboard (default), or the two-pane list. */
  view?: "list";
  /**
   * The ticket space selected by `/tickets/:spaceKey`. Absent only while `/tickets`
   * or a legacy route resolves the one configured space.
   */
  spaceKey?: string;
  /**
   * The ticket whose panel is open in the space, as `?ticket=TP-3018`.
   *
   * In the URL rather than in `JiraSpacePage`'s state because it is no longer only
   * something you clicked: the header's search opens a ticket from any page, so
   * "which ticket" has to be expressible as a destination. It comes back for free
   * as a shareable link to one ticket's panel.
   */
  ticket?: string;
  settingsTab?: SettingsTab;
  adminTab?: AdminTab;
}

export function routeFromLocation(location: {
  pathname: string;
  search: string;
}): RouteState {
  const { pathname, search } = location;
  const params = new URLSearchParams(search);
  const tabParam = params.get("tab");
  const tab: OwnerTab | undefined =
    tabParam === "mine" ? "mine" : tabParam === "team" ? "team" : undefined;
  const add = params.get("add") === "1" ? true : undefined;
  const view = params.get("view") === "list" ? "list" : undefined;
  const settingsTabParam = params.get("settingsTab");
  const settingsTab = NON_DEFAULT_SETTINGS_TABS.find((t) => t === settingsTabParam);

  // Automation used to live under the global Settings page. Keep old bookmarks
  // useful while generating only the new feature-local URL.
  if (pathname === "/settings" && settingsTabParam === "automation") {
    return { page: "automation", automationTab: "settings" };
  }
  if (pathname === "/settings") return { page: "settings", settingsTab };
  if (pathname === "/admin/logs") return { page: "admin", adminTab: "logs" };
  if (pathname === "/admin/orchestration") return { page: "admin", adminTab: "orchestration" };
  if (pathname === "/admin/feedback") return { page: "admin", adminTab: "feedback" };
  if (pathname === "/admin/roles") return { page: "admin", adminTab: "roles" };
  if (pathname === "/admin" || pathname === "/admin/users") {
    return { page: "admin", adminTab: "users" };
  }
  // `?ticket=` rather than a second path segment: the page is the whole space and the
  // ticket is a panel over it, not a different page — and a query parameter drops
  // cleanly when the panel closes.
  // `/jira` remains readable for existing bookmarks, but every generated URL is
  // provider-neutral under `/tickets`.
  const ticketsMatch = pathname.match(/^\/(?:tickets|jira)\/([^/]+)$/);
  if (ticketsMatch) {
    return {
      page: "space",
      spaceKey: decodeURIComponent(ticketsMatch[1]!),
      tab,
      ...(params.get("ticket") ? { ticket: params.get("ticket")! } : {}),
    };
  }
  if (pathname === "/tickets" || pathname === "/jira") {
    return { page: "space", tab, ...(params.get("ticket") ? { ticket: params.get("ticket")! } : {}) };
  }
  // Old bookmarks resolve through the index form. `JiraSpacePage` replaces them
  // with the configured `/tickets/:spaceKey` URL after its board metadata arrives.
  if (
    pathname === "/graph" ||
    pathname === "/spaces" ||
    /^\/spaces\/[^/]+$/.test(pathname)
  ) {
    return { page: "space", tab, ...(params.get("ticket") ? { ticket: params.get("ticket")! } : {}) };
  }
  const pullRequestsMatch = pathname.match(/^\/pull-requests\/(.+)$/);
  if (pullRequestsMatch) {
    return { page: "pull-requests", id: decodeURIComponent(pullRequestsMatch[1]!), tab };
  }
  if (pathname === "/pull-requests") return { page: "pull-requests", tab };
  if (pathname === "/releases") {
    const releasesTab =
      tabParam === "history" || tabParam === "watch" ? tabParam : undefined;
    return { page: "releases", releasesTab };
  }
  const automationMatch = pathname.match(/^\/automation\/([^/]+)$/);
  if (automationMatch) {
    return { page: "automation", id: decodeURIComponent(automationMatch[1]!) };
  }
  if (pathname === "/automation") {
    const automationTab =
      tabParam === "settings"
        ? "settings"
        : tabParam === "failures"
          ? "failures"
          : undefined;
    return {
      page: "automation",
      ...(automationTab ? { automationTab } : {}),
      ...(automationTab === "failures"
        ? { automationFailures: automationFailureRouteFrom(params) }
        : {}),
    };
  }
  // No `/logrocket/:id`: the page is one list and expanding a row is transient
  // UI state, so there is nothing about one issue to put in the URL.
  if (pathname === "/logrocket") return { page: "logrocket" };
  // Same reasoning as LogRocket: one list, and an expanded row is transient state.
  if (pathname === "/datadog") return { page: "datadog" };
  const slackMatch = pathname.match(/^\/slack\/([^/]+)$/);
  if (slackMatch) {
    return { page: "slack", id: decodeURIComponent(slackMatch[1]!) };
  }
  if (pathname === "/slack") return { page: "slack" };
  // Flaky specs used to be its own page; it is a tab on each CI-failure loop's
  // own detail page now, and there is no single instance to land a bookmark on
  // (the loop is instantiable), so the old URL falls back to the Loops dashboard.
  if (pathname === "/flaky-specs") return { page: "loops" };
  const loopsMatch = pathname.match(/^\/loops\/(.+)$/);
  if (loopsMatch) {
    return { page: "loops", id: decodeURIComponent(loopsMatch[1]!), add, tab };
  }
  if (pathname === "/loops") return { page: "loops", add, tab, view };
  // `/tasks*` is retired, not forgotten: the page it addressed is gone, but the
  // URLs are in people's history and bars. An id still resolves — `TaskDetail`
  // loads any instance by id, list membership or not — so a bookmarked instance
  // opens on Loops rather than dying, and a bare `/tasks` falls through to the
  // new default below.
  const tasksMatch = pathname.match(/^\/tasks\/(.+)$/);
  if (tasksMatch) {
    return { page: "loops", id: decodeURIComponent(tasksMatch[1]!), add, tab };
  }
  if (pathname === "/" || pathname === "/overview" || pathname === "/dashboards") {
    return { page: "dashboard" };
  }
  const dashboardMatch = pathname.match(/^\/(?:overview|dashboards)\/(.+)$/);
  if (dashboardMatch) {
    return { page: "dashboard", id: decodeURIComponent(dashboardMatch[1]!) };
  }
  // The dashboard is the signed-in home. `/` and anything unrecognised land here.
  return { page: "dashboard" };
}

// The root tsconfig has no DOM lib on purpose, and the route tests import this
// module into that program, so the two browser globals used below are declared
// narrowly here rather than pulling `lib.dom` into every server-side file.
const browser = globalThis as unknown as {
  window: {
    location: { pathname: string; search: string };
    history: { replaceState(state: null, title: string, url: string): void };
  };
};

/**
 * After a login triggered by a 401, sends the user back to `?returnTo`.
 * A normal sign-in has nowhere to restore, so it opens the dashboard at `/`.
 */
export function restoreReturnTo(): void {
  const returnTo = new URLSearchParams(browser.window.location.search).get("returnTo");
  if (returnTo) {
    browser.window.history.replaceState(null, "", returnTo);
    return;
  }
  const path = browser.window.location.pathname;
  if (path === "/login" || path === "/forgot-password" || path === "/reset-password") {
    browser.window.history.replaceState(null, "", "/");
  }
}

export function pathFor(route: RouteState): string {
  let path = "/";
  if (route.page === "dashboard") {
    path = route.id ? `/overview/${encodeURIComponent(route.id)}` : "/";
  }
  else if (route.page === "settings") path = "/settings";
  else if (route.page === "admin") {
    path =
      route.adminTab === "logs"
        ? "/admin/logs"
        : route.adminTab === "orchestration"
          ? "/admin/orchestration"
        : route.adminTab === "feedback"
          ? "/admin/feedback"
          : route.adminTab === "roles"
            ? "/admin/roles"
          : "/admin/users";
  }
  else if (route.page === "pull-requests") {
    // A provider-qualified id (`gitlab:group/project!12`) carries slashes, so it
    // is encoded whole rather than left to look like extra path segments.
    path = route.id ? `/pull-requests/${encodeURIComponent(route.id)}` : "/pull-requests";
  }
  else if (route.page === "releases") path = "/releases";
  else if (route.page === "automation") {
    path = route.id ? `/automation/${encodeURIComponent(route.id)}` : "/automation";
  }
  else if (route.page === "logrocket") path = "/logrocket";
  else if (route.page === "datadog") path = "/datadog";
  else if (route.page === "slack") {
    path = route.id ? `/slack/${encodeURIComponent(route.id)}` : "/slack";
  }
  else if (route.page === "space") {
    path = route.spaceKey ? `/tickets/${encodeURIComponent(route.spaceKey)}` : "/tickets";
  }
  else if (route.page === "loops") {
    path = route.id ? `/loops/${encodeURIComponent(route.id)}` : "/loops";
  }

  const params = new URLSearchParams();
  if (route.add) params.set("add", "1");
  // Only the non-default tab reaches the URL, so a bare `/loops` and a bare
  // `/pull-requests` each mean what that page opens on. A ticket space opens on your
  // own work too, so it sides with pull requests here.
  if (route.page === "pull-requests" || route.page === "space") {
    if (route.tab === "team") params.set("tab", "team");
  } else if (route.tab === "mine") params.set("tab", "mine");
  if (route.page === "releases" && route.releasesTab && route.releasesTab !== "environments") {
    params.set("tab", route.releasesTab);
  }
  if (route.page === "automation" && !route.id) {
    if (route.automationTab === "settings") params.set("tab", "settings");
    if (route.automationTab === "failures") {
      params.set("tab", "failures");
      const filter = route.automationFailures;
      if (filter?.days) params.set("days", String(filter.days));
      if (filter?.scheduleId) params.set("scheduleId", String(filter.scheduleId));
      if (filter?.pipelineId) params.set("pipelineId", String(filter.pipelineId));
      if (filter?.presence) params.set("presence", filter.presence);
      if (filter?.state) params.set("state", filter.state);
      if (filter?.q) params.set("q", filter.q);
      if (filter?.limit) params.set("limit", String(filter.limit));
      if (filter?.offset != null && filter.offset > 0) {
        params.set("offset", String(filter.offset));
      }
    }
  }
  if (route.page === "loops" && !route.id && route.view === "list") {
    params.set("view", "list");
  }
  if (route.page === "space" && route.ticket) params.set("ticket", route.ticket);
  if (route.page === "settings" && route.settingsTab && route.settingsTab !== "general") {
    params.set("settingsTab", route.settingsTab);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function automationFailureRouteFrom(
  params: URLSearchParams,
): AutomationFailureRoute {
  const daysValue = Number(params.get("days"));
  const days =
    daysValue === 1 || daysValue === 7 || daysValue === 30
      ? daysValue
      : undefined;
  const scheduleId = positiveRouteInteger(params.get("scheduleId"));
  const pipelineId = positiveRouteInteger(params.get("pipelineId"));
  const presenceValue = params.get("presence");
  const presence =
    presenceValue === "current" || presenceValue === "recent"
      ? presenceValue
      : undefined;
  const stateValue = params.get("state");
  const state =
    stateValue === "untriaged" ||
    stateValue === "ticketed" ||
    stateValue === "active-mr"
      ? stateValue
      : undefined;
  const q = params.get("q")?.trim().slice(0, 200) || undefined;
  const limitValue = Number(params.get("limit"));
  const limit = limitValue === 50 ? 50 : limitValue === 25 ? 25 : undefined;
  const offsetValue = Number(params.get("offset"));
  const offset =
    Number.isSafeInteger(offsetValue) && offsetValue > 0
      ? offsetValue
      : undefined;
  return {
    ...(days ? { days } : {}),
    ...(scheduleId ? { scheduleId } : {}),
    ...(pipelineId ? { pipelineId } : {}),
    ...(presence ? { presence } : {}),
    ...(state ? { state } : {}),
    ...(q ? { q } : {}),
    ...(limit ? { limit } : {}),
    ...(offset ? { offset } : {}),
  };
}

function positiveRouteInteger(value: string | null): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
