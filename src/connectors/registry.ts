import { ConfigError } from "../core/errors.ts";
import type { Logger } from "../logging/logger.ts";
import type { SecretStore } from "../secrets/secret-store.ts";
import type { ScheduledTask } from "../config/resolve-schedule.ts";
import { createGitLabClient, GitLabClient, GitLabConfigSchema } from "./gitlab/client.ts";
import {
  JiraClient,
  JiraConfigSchema,
  looksLikeEmail,
  type JiraConfig,
} from "./jira/client.ts";
import { createSlackClient, SlackClient } from "./slack/client.ts";
import type { Connector, HealthReport } from "./connector.ts";

export interface ConnectorContext {
  secrets: SecretStore;
  logger: Logger;
  /** Every task's resolved schedule, for checks that scan for gitlab/jira param blocks. */
  scheduledTasks: ScheduledTask[];
  /**
   * Overrides the identifiers a check would otherwise read from a task's stored
   * params, so a project can be verified before any task is configured for it.
   */
  project?: string | number;
  /** Same, for Jira: a project key to check instead of the configured one. */
  jiraProject?: string;
  signal?: AbortSignal;
}

export interface ConnectorDefinition {
  name: string;
  /** Secrets that must be present before the connector can be built at all. */
  requires: readonly string[];
  build(ctx: ConnectorContext): Connector;
  /**
   * Health check. Separate from `build` so a definition can feed it identifiers
   * discovered in a task's stored params — a token alone proves nothing about
   * whether the configured project id is right.
   */
  check(connector: Connector, ctx: ConnectorContext): Promise<HealthReport>;
}

/** Connectors are lazy so the app can start with only some integrations configured. */
export const CONNECTORS: readonly ConnectorDefinition[] = [
  {
    name: "gitlab",
    requires: ["GITLAB_TOKEN"],
    build: (ctx) => createGitLabClient(ctx.secrets, { logger: ctx.logger }),
    check: (connector, ctx) => {
      const client = connector as GitLabClient;
      const projects = ctx.project != null ? [ctx.project] : gitlabProjects(ctx.scheduledTasks);
      // With several tasks configured against different projects, checking only
      // the first would leave the others unverified until they failed at 3am.
      return projects.length <= 1
        ? client.check({ project: projects[0], signal: ctx.signal })
        : checkEachProject(client, projects, ctx.signal);
    },
  },
  {
    name: "jira",
    // The site URL is required alongside the credentials: it is per-install and
    // cannot be defaulted, and without it the client has nowhere to connect.
    requires: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_TOKEN"],
    build: (ctx) =>
      new JiraClient({
        baseUrl: ctx.secrets.require("JIRA_BASE_URL"),
        email: ctx.secrets.require("JIRA_EMAIL"),
        token: ctx.secrets.require("JIRA_TOKEN"),
        logger: ctx.logger,
      }),
    check: (connector, ctx) => {
      const client = connector as JiraClient;
      const configured = jiraTargets(ctx.scheduledTasks);
      // A requested key names the project but nothing else, so a configured
      // block for that same key still supplies the issue type, board, and assignee.
      const target: Partial<JiraConfig> | undefined = ctx.jiraProject
        ? (configured.find((t) => t.project === ctx.jiraProject!.toUpperCase()) ?? {
            project: ctx.jiraProject.toUpperCase(),
          })
        : configured[0];

      return client.check({
        projectKey: target?.project,
        issueType: target?.issueType,
        // Defaults to the token's own account, which is what "assign it to me"
        // means for a tool one person runs.
        assigneeEmail: resolveAssigneeEmail(
          target?.assigneeMode === "automatic" ? undefined : target?.assignee,
          ctx.secrets.get("JIRA_EMAIL"),
        ),
        boardId: target?.boardId,
        signal: ctx.signal,
      });
    },
  },
  {
    name: "slack",
    // The channel is not required to build a client: a bad channel is a failure
    // of one announcement, while a missing token means there is nothing to test.
    requires: ["SLACK_BOT_TOKEN"],
    build: (ctx) => createSlackClient(ctx.secrets, { logger: ctx.logger }),
    check: (connector, ctx) =>
      (connector as SlackClient).check({ ...(ctx.signal ? { signal: ctx.signal } : {}) }),
  },
];

/**
 * An email to resolve, or undefined when the assignee is already an account id.
 *
 * An account id needs no lookup, so passing it here would send an opaque string
 * to `/user/search` and fail for the wrong reason.
 */
function resolveAssigneeEmail(
  assignee: string | undefined,
  fallback: string | undefined,
): string | undefined {
  if (assignee == null) return fallback;
  return looksLikeEmail(assignee) ? assignee : undefined;
}

export function connectorNames(): string[] {
  return CONNECTORS.map((c) => c.name);
}

export function findConnector(name: string): ConnectorDefinition {
  const found = CONNECTORS.find((c) => c.name === name);
  if (!found) {
    throw new ConfigError(
      `Unknown connector '${name}'. Known connectors: ${connectorNames().join(", ")}.`,
    );
  }
  return found;
}

/** Which required secrets are missing for a connector. */
export function missingSecrets(
  definition: ConnectorDefinition,
  secrets: SecretStore,
): string[] {
  return definition.requires.filter((name) => secrets.get(name) == null);
}

/**
 * Every distinct GitLab project mentioned by a task's stored params block.
 *
 * Read from the resolved schedule rather than a connector-level setting
 * because the project is a per-task concern: one token serves several
 * projects.
 */
export function gitlabProjects(scheduledTasks: ScheduledTask[]): (string | number)[] {
  const seen = new Set<string | number>();

  for (const task of scheduledTasks) {
    const block = (task.params as Record<string, unknown>).gitlab;
    if (block == null) continue;

    // A malformed block is the task's problem to report when it runs; the
    // health check just skips what it cannot read.
    const parsed = GitLabConfigSchema.safeParse(block);
    if (parsed.success) seen.add(parsed.data.projectId);
  }

  return [...seen];
}

/**
 * Every Jira target a task configures.
 *
 * Unlike GitLab's, this keeps the whole block rather than just the key: the issue
 * type, assignee and board are all per-site ids the health check exists to
 * resolve, and checking a project without them would verify the least
 * interesting half.
 */
export function jiraTargets(scheduledTasks: ScheduledTask[]): JiraConfig[] {
  const out: JiraConfig[] = [];
  const seen = new Set<string>();

  for (const task of scheduledTasks) {
    const block = (task.params as Record<string, unknown>).jira;
    if (block == null) continue;

    // A malformed block is the task's problem to report when it runs; the
    // health check just skips what it cannot read.
    const parsed = JiraConfigSchema.safeParse(block);
    if (!parsed.success) continue;

    const key = JSON.stringify(parsed.data);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed.data);
  }

  return out;
}

async function checkEachProject(
  client: GitLabClient,
  projects: (string | number)[],
  signal?: AbortSignal,
): Promise<HealthReport> {
  const checks = [];

  for (const [index, project] of projects.entries()) {
    const next = await client.check({ project, signal });
    for (const check of next.checks) {
      // Authentication uses the same token every time, so report it once.
      if (check.name === "authentication") {
        if (index === 0) checks.push(check);
        continue;
      }
      checks.push({ ...check, name: `${check.name} [${project}]` });
    }
  }

  return { connector: client.name, ok: checks.every((c) => c.ok), checks };
}
