import { createMongoAbility, type MongoAbility } from "@casl/ability";

export const PERMISSION_DEFINITIONS = [
  {
    id: "loops:access",
    action: "read",
    subject: "Loop",
    group: "Loops",
    label: "Access Loops",
    description: "Open Loops and view or run accessible task workflows.",
  },
  {
    id: "pull-requests:access",
    action: "read",
    subject: "PullRequest",
    group: "Pull requests",
    label: "Access pull requests",
    description: "Open Pull requests and inspect repository merge requests.",
  },
  {
    id: "releases:access",
    action: "read",
    subject: "Release",
    group: "Releases",
    label: "Access releases",
    description: "Open Releases and inspect deployment state and history.",
  },
  {
    id: "automation:access",
    action: "read",
    subject: "Automation",
    group: "Automation",
    label: "Access automation",
    description: "Open Automation reports, pipelines, and failure triage.",
  },
  {
    id: "logrocket:access",
    action: "read",
    subject: "LogRocket",
    group: "LogRocket",
    label: "Access LogRocket",
    description: "Open LogRocket issues and related remediation actions.",
  },
  {
    id: "datadog:access",
    action: "read",
    subject: "Datadog",
    group: "Datadog",
    label: "Access Datadog",
    description: "Open Datadog issues, activity, and remediation actions.",
  },
  {
    id: "tickets:access",
    action: "read",
    subject: "Ticket",
    group: "Tickets",
    label: "Access tickets",
    description: "Open Tickets and inspect or act on Jira work.",
  },
  {
    id: "slack:access",
    action: "read",
    subject: "Slack",
    group: "Slack",
    label: "Access Slack",
    description: "Open Team chat and use the connected Slack workspace.",
  },
  {
    id: "users:manage",
    action: "manage",
    subject: "User",
    group: "Administrative access",
    label: "Manage users",
    description: "Create, edit, and delete accounts and assign access.",
  },
  {
    id: "application-logs:read",
    action: "read",
    subject: "ApplicationLog",
    group: "Administrative access",
    label: "View application logs",
    description: "Read recent redacted server logs.",
  },
  {
    id: "instance-settings:manage",
    action: "manage",
    subject: "InstanceSettings",
    group: "Administrative access",
    label: "Manage instance settings",
    description: "View and change shared settings, integrations, prompts, and routing.",
  },
  {
    id: "tasks:manage",
    action: "manage",
    subject: "Task",
    group: "Loops",
    label: "Manage all tasks",
    description: "Update and schedule tasks owned by other users.",
  },
] as const;

export type AppPermission = (typeof PERMISSION_DEFINITIONS)[number]["id"];
export type AppAction = (typeof PERMISSION_DEFINITIONS)[number]["action"];
export type AppSubject = (typeof PERMISSION_DEFINITIONS)[number]["subject"];
export type AppAbility = MongoAbility<[AppAction, AppSubject]>;

const DEFINITION_BY_PERMISSION = new Map(
  PERMISSION_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function isAppPermission(value: unknown): value is AppPermission {
  return typeof value === "string" && DEFINITION_BY_PERMISSION.has(value as AppPermission);
}

export function normalizePermissions(values: readonly unknown[]): AppPermission[] {
  const permissions = new Set<AppPermission>();
  for (const value of values) {
    if (!isAppPermission(value)) throw new Error(`Unknown permission '${String(value)}'.`);
    permissions.add(value);
  }
  return PERMISSION_DEFINITIONS
    .map(({ id }) => id)
    .filter((permission) => permissions.has(permission));
}

export function createAppAbility(permissions: readonly AppPermission[]): AppAbility {
  const granted = new Set(permissions);
  return createMongoAbility<[AppAction, AppSubject]>(
    PERMISSION_DEFINITIONS
      .filter(({ id }) => granted.has(id))
      .map(({ action, subject }) => ({ action, subject })),
  );
}
