import { describe, expect, test } from "bun:test";
import { createAppAbility } from "../shared/authorization.ts";
import {
  canAccessPage,
  defaultRouteForAbility,
} from "../web/src/module-access.ts";
import { pathFor, routeFromLocation } from "../web/src/route-state.ts";
import { buildTrigger } from "../web/src/schedule-trigger.ts";
import { ciFailureConfig, withCiFailureConfig } from "../web/src/ci-failure-params.ts";
import { loopRowsFrom } from "../web/src/task-rows.ts";
import { replaceSlackEmojiShortcodes } from "../web/src/slack-emoji.ts";
import type { TaskSummary } from "../web/src/api.ts";

describe("frontend route contract", () => {
  test("round-trips instance ids and URL-owned filters", () => {
    const path = pathFor({
      page: "loops",
      id: "review/acme",
      add: true,
      tab: "mine",
    });
    expect(path).toBe("/loops/review%2Facme?add=1&tab=mine");
    expect(
      routeFromLocation({
        pathname: "/loops/review%2Facme",
        search: "?add=1&tab=mine",
      }),
    ).toEqual({
      page: "loops",
      id: "review/acme",
      add: true,
      tab: "mine",
    });
  });

  test("keeps the My tab when opening a loop detail", () => {
    expect(pathFor({ page: "loops", id: "private-loop", tab: "mine" })).toBe(
      "/loops/private-loop?tab=mine",
    );
  });

  test("round-trips ticket space keys and open tickets", () => {
    const route = {
      page: "space" as const,
      spaceKey: "TP",
      tab: "team" as const,
      ticket: "TP-3018",
    };
    expect(pathFor(route)).toBe("/tickets/TP?tab=team&ticket=TP-3018");
    expect(
      routeFromLocation({
        pathname: "/tickets/TP",
        search: "?tab=team&ticket=TP-3018",
      }),
    ).toEqual(route);
  });

  test("round-trips Slack conversation ids", () => {
    expect(pathFor({ page: "slack", id: "D0123/odd" })).toBe(
      "/slack/D0123%2Fodd",
    );
    expect(
      routeFromLocation({ pathname: "/slack/D0123%2Fodd", search: "" }),
    ).toEqual({ page: "slack", id: "D0123/odd" });
    expect(routeFromLocation({ pathname: "/slack", search: "" })).toEqual({
      page: "slack",
    });
  });

  test("round-trips administration routes", () => {
    expect(pathFor({ page: "admin", adminTab: "users" })).toBe("/admin/users");
    expect(pathFor({ page: "admin", adminTab: "roles" })).toBe("/admin/roles");
    expect(pathFor({ page: "admin", adminTab: "feedback" })).toBe("/admin/feedback");
    expect(pathFor({ page: "admin", adminTab: "logs" })).toBe("/admin/logs");
    expect(routeFromLocation({ pathname: "/admin", search: "" })).toEqual({
      page: "admin",
      adminTab: "users",
    });
    expect(routeFromLocation({ pathname: "/admin/logs", search: "" })).toEqual({
      page: "admin",
      adminTab: "logs",
    });
    expect(routeFromLocation({ pathname: "/admin/feedback", search: "" })).toEqual({
      page: "admin",
      adminTab: "feedback",
    });
    expect(routeFromLocation({ pathname: "/admin/roles", search: "" })).toEqual({
      page: "admin",
      adminTab: "roles",
    });
  });

  test("round-trips Automation overview and shareable pipeline routes", () => {
    expect(pathFor({ page: "automation" })).toBe("/automation");
    expect(pathFor({ page: "automation", id: "123" })).toBe("/automation/123");
    expect(routeFromLocation({ pathname: "/automation", search: "" })).toEqual({
      page: "automation",
    });
    expect(
      routeFromLocation({ pathname: "/automation/123", search: "" }),
    ).toEqual({ page: "automation", id: "123" });
  });

  test("round-trips the Automation settings tab", () => {
    const route = { page: "automation" as const, automationTab: "settings" as const };
    expect(pathFor(route)).toBe("/automation?tab=settings");
    expect(
      routeFromLocation({
        pathname: "/automation",
        search: "?tab=settings",
      }),
    ).toEqual(route);
    expect(
      routeFromLocation({
        pathname: "/settings",
        search: "?settingsTab=automation",
      }),
    ).toEqual(route);
  });

  test("round-trips the E2E test settings tab", () => {
    const route = { page: "settings" as const, settingsTab: "e2e-tests" as const };
    expect(pathFor(route)).toBe("/settings?settingsTab=e2e-tests");
    expect(
      routeFromLocation({
        pathname: "/settings",
        search: "?settingsTab=e2e-tests",
      }),
    ).toEqual(route);
  });

  test("round-trips the Automation failure inbox and shareable filters", () => {
    const route = {
      page: "automation" as const,
      automationTab: "failures" as const,
      automationFailures: {
        days: 7 as const,
        scheduleId: 22,
        pipelineId: 9001,
        presence: "recent" as const,
        state: "untriaged" as const,
        q: "checkout error",
        limit: 50 as const,
        offset: 50,
      },
    };
    expect(pathFor(route)).toBe(
      "/automation?tab=failures&days=7&scheduleId=22&pipelineId=9001&presence=recent&state=untriaged&q=checkout+error&limit=50&offset=50",
    );
    expect(
      routeFromLocation({
        pathname: "/automation",
        search:
          "?tab=failures&days=7&scheduleId=22&pipelineId=9001&presence=recent&state=untriaged&q=checkout+error&limit=50&offset=50",
      }),
    ).toEqual(route);
  });

  test("resolves legacy Jira, graph, and spaces bookmarks through the tickets index", () => {
    expect(
      routeFromLocation({
        pathname: "/jira/TP",
        search: "?ticket=TP-3018",
      }),
    ).toEqual({
      page: "space",
      spaceKey: "TP",
      tab: undefined,
      ticket: "TP-3018",
    });
    expect(
      routeFromLocation({
        pathname: "/graph",
        search: "?tab=team&ticket=TP-3018",
      }),
    ).toEqual({
      page: "space",
      tab: "team",
      ticket: "TP-3018",
    });
    expect(
      routeFromLocation({
        pathname: "/spaces/TP",
        search: "?tab=team&ticket=TP-3018",
      }),
    ).toEqual({
      page: "space",
      tab: "team",
      ticket: "TP-3018",
    });
    expect(pathFor({ page: "space", tab: "team", ticket: "TP-3018" })).toBe(
      "/tickets?tab=team&ticket=TP-3018",
    );
  });

  test("opens on the dashboard, not on the retired Tasks page", () => {
    expect(routeFromLocation({ pathname: "/", search: "" })).toEqual({
      page: "dashboard",
    });
    expect(pathFor({ page: "dashboard" })).toBe("/");
    expect(pathFor({ page: "dashboard", id: "default" })).toBe("/overview/default");
    expect(routeFromLocation({ pathname: "/overview/default", search: "" })).toEqual({
      page: "dashboard",
      id: "default",
    });
    expect(routeFromLocation({ pathname: "/dashboards/default", search: "" })).toEqual({
      page: "dashboard",
      id: "default",
    });
  });

  // The Tasks page is gone but its URLs are in people's history. An id still
  // resolves — `TaskDetail` loads any instance by id — so a bookmarked one opens
  // on Loops instead of dead-ending.
  test("redirects bookmarked /tasks URLs rather than 404ing them", () => {
    expect(routeFromLocation({ pathname: "/tasks/review%2Facme", search: "" })).toEqual({
      page: "loops",
      id: "review/acme",
      add: undefined,
      tab: undefined,
    });
    expect(routeFromLocation({ pathname: "/tasks", search: "" })).toEqual({
      page: "dashboard",
    });
  });
});

describe("module access routing", () => {
  test("lands on the dashboard and still honors module access", () => {
    const releasesOnly = createAppAbility(["releases:access"]);
    expect(canAccessPage(releasesOnly, "dashboard")).toBe(true);
    expect(canAccessPage(releasesOnly, "releases")).toBe(true);
    expect(canAccessPage(releasesOnly, "pull-requests")).toBe(false);
    expect(defaultRouteForAbility(releasesOnly)).toEqual({ page: "dashboard" });
    expect(defaultRouteForAbility(createAppAbility([]))).toEqual({ page: "dashboard" });
  });

  test("keeps administration reachable independently of product modules", () => {
    const administrator = createAppAbility(["users:manage"]);
    expect(canAccessPage(administrator, "admin")).toBe(true);
    expect(defaultRouteForAbility(administrator)).toEqual({ page: "dashboard" });
  });
});

describe("Slack emoji formatting", () => {
  test("renders standard shortcodes and preserves custom workspace emoji", () => {
    expect(replaceSlackEmojiShortcodes("Looks good :smile: :+1: :party_parrot:")).toBe(
      "Looks good 😄 👍 :party_parrot:",
    );
  });
});

describe("task template visibility", () => {
  test("offers instantiable definitions for creation without listing template-only team work", () => {
    const template = {
      id: "gitlab-mr-follow-up",
      kind: "loop",
      instantiable: true,
    } as TaskSummary;
    const instance = {
      id: "instance",
      kind: "loop",
      instantiable: true,
      createdAt: "2026-08-25T10:00:00.000Z",
      visibility: "private",
    } as TaskSummary;
    const existingPublicLoop = {
      id: "future-team-loop",
      kind: "loop",
      instantiable: true,
    } as TaskSummary;
    const templateOnlyDefinitions = [
      "datadog-scan",
      "gitlab-ci-failure",
      "gitlab-code-review",
      "gitlab-review-requested",
      "jira-ticket-to-mr",
      "release-repo-poll",
    ].map((id) => ({ id, kind: "loop", instantiable: true }) as TaskSummary);
    const partitioned = loopRowsFrom([
      template,
      existingPublicLoop,
      ...templateOnlyDefinitions,
      instance,
    ]);
    expect(partitioned.definitions.map((row: TaskSummary) => row.id)).toEqual([
      "gitlab-mr-follow-up",
      "future-team-loop",
      "datadog-scan",
      "gitlab-ci-failure",
      "gitlab-code-review",
      "gitlab-review-requested",
      "jira-ticket-to-mr",
      "release-repo-poll",
    ]);
    expect(partitioned.work.map((row: TaskSummary) => row.id)).toEqual([
      "future-team-loop",
      "instance",
    ]);
  });
});

describe("loop schedule contract", () => {
  test("builds a daily cron and preserves its first-run instant", () => {
    expect(buildTrigger("daily", "2026-08-25T09:30", "UTC", "")).toEqual({
      type: "cron",
      expression: "30 9 * * *",
      timezone: "UTC",
      startAt: "2026-08-25T09:30:00.000Z",
    });
  });

  test("rejects an incomplete custom cron", () => {
    expect(() => buildTrigger("custom", "2026-08-25T09:30", "UTC", "* *")).toThrow(
      /at least 5 fields/,
    );
  });
});

describe("CI-failure loop config", () => {
  test("reads stored gitlab/jira/schedule fields", () => {
    expect(
      ciFailureConfig({
        gitlab: { projectId: "acme/web" },
        jira: { project: "TP", bugFoundBy: "Automation", labels: ["talos", "ci-failure"], assignee: "a@b.com" },
        pipelineSchedule: "nightly",
      }),
    ).toEqual({
      gitlabProject: "acme/web",
      jiraProject: "TP",
      bugFoundBy: "Automation",
      pipelineSchedule: "nightly",
      labels: ["talos", "ci-failure"],
      assigneeMode: "fixed",
      assignee: "a@b.com",
      failuresBeforeFiling: "",
      historyWindow: "",
    });
  });

  test("empty when the loop was never pointed at a project", () => {
    expect(ciFailureConfig({})).toEqual({
      gitlabProject: "",
      jiraProject: "",
      bugFoundBy: "",
      pipelineSchedule: "",
      labels: [],
      assigneeMode: "automatic",
      assignee: "",
      failuresBeforeFiling: "",
      historyWindow: "",
    });
  });

  test("fills gitlab/jira/pipeline without dropping other stored fields", () => {
    expect(
      withCiFailureConfig(
        { titlePrefix: "Unit test failure", gitlab: { ref: "main" } },
        {
          gitlabProject: "group/app",
          jiraProject: "sp",
          bugFoundBy: "Automation",
          pipelineSchedule: "nightly",
          labels: ["talos", "ci-failure"],
          assigneeMode: "fixed",
          assignee: "a@b.com",
          failuresBeforeFiling: "3",
          historyWindow: "",
        },
      ),
    ).toEqual({
      titlePrefix: "Unit test failure",
      gitlab: { ref: "main", projectId: "group/app" },
      jira: {
        project: "sp",
        bugFoundBy: "Automation",
        labels: ["talos", "ci-failure"],
        assigneeMode: "fixed",
        assignee: "a@b.com",
      },
      pipelineSchedule: "nightly",
      // A blank field means "leave the schema default", not "pin it to zero".
      failuresBeforeFiling: 3,
      historyWindow: undefined,
    });
  });

  test("stores Automatic explicitly and clears a stale fixed assignee", () => {
    const config = ciFailureConfig({
      jira: { project: "TP", assigneeMode: "automatic", assignee: "old-account" },
    });
    expect(config.assigneeMode).toBe("automatic");

    expect(
      withCiFailureConfig(
        { jira: { project: "TP", assignee: "old-account" } },
        {
          ...config,
          gitlabProject: "group/app",
          bugFoundBy: "Automation",
          pipelineSchedule: "",
          labels: [],
          assignee: "",
          failuresBeforeFiling: "",
          historyWindow: "",
        },
      ).jira,
    ).toMatchObject({ project: "TP", assigneeMode: "automatic", assignee: undefined });
  });
});
