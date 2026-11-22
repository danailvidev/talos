import type { AppAbility } from "../../shared/authorization.ts";
import type { Page, RouteState } from "./route-state.ts";

const MODULE_SUBJECTS = {
  loops: "Loop",
  "pull-requests": "PullRequest",
  releases: "Release",
  automation: "Automation",
  logrocket: "LogRocket",
  datadog: "Datadog",
  space: "Ticket",
  slack: "Slack",
} as const;

export function canAccessPage(ability: AppAbility, page: Page): boolean {
  if (page === "dashboard") return true;
  if (page === "admin") {
    return ability.can("manage", "User") || ability.can("read", "ApplicationLog");
  }
  if (page === "settings") return ability.can("manage", "InstanceSettings");
  return ability.can("read", MODULE_SUBJECTS[page]);
}

export function defaultRouteForAbility(ability: AppAbility): RouteState | null {
  if (canAccessPage(ability, "dashboard")) return { page: "dashboard" };
  const pages: Page[] = [
    "pull-requests",
    "loops",
    "releases",
    "automation",
    "space",
    "logrocket",
    "datadog",
    "slack",
    "admin",
    "settings",
  ];
  const page = pages.find((candidate) => canAccessPage(ability, candidate));
  return page ? { page } : null;
}
