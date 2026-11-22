import { ConfigError } from "../core/errors.ts";

export interface SecretStore {
  /** Returns undefined when unset. */
  get(name: string): string | undefined;
  /** Throws ConfigError when unset, naming the missing variable. */
  require(name: string): string;
  /** Every known secret value, for the log scrubber. */
  values(): readonly string[];
}

/**
 * A store that can also say which known secrets are set, without handing out
 * values. The console's system view needs that; connectors and tasks only ever
 * need `SecretStore`.
 */
export interface PresenceSecretStore extends SecretStore {
  presence(): Record<KnownSecret, boolean>;
}

/** Secret names whose presence the platform reports. */
export const KNOWN_SECRETS = [
  /** Optional recovery-account passwords. No source-code defaults in production. */
  "TALOS_ADMIN_PASSWORD",
  "TALOS_OPERATOR_PASSWORD",
  /** Shared GitLab token. Interactive feedback deliberately uses only the actor's PAT. */
  "GITLAB_TOKEN",
  /** Self-hosted GitLab. Unset means gitlab.com — see `GITLAB_API_URL` in the client. */
  "GITLAB_API_URL",
  "AZURE_DEVOPS_TOKEN",
  "JIRA_BASE_URL",
  /** Jira Software board whose columns and saved filter define the current space. */
  "JIRA_BOARD_ID",
  /** Comma-separated developers included by the Jira Team view. */
  "JIRA_TEAM_EMAILS",
  "JIRA_EMAIL",
  "JIRA_TOKEN",
  /** Slack OAuth app used to connect each developer's own inbox. */
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_WORKSPACE_ID",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  /** Where release announcements are posted, e.g. `#releases`. Not a credential. */
  "SLACK_RELEASE_CHANNEL",
  "LOGROCKET_API_KEY",
  /** Authenticates inbound LogRocket issue alerts — see `api/webhooks.ts`. */
  "LOGROCKET_WEBHOOK_SECRET",
  /** Where a LogRocket alert is filed as a ticket. Not a credential. */
  "LOGROCKET_JIRA_PROJECT",
  "LOGROCKET_JIRA_ISSUE_TYPE",
  /** Datadog personal access token (`ddpat_…`), sent as a Bearer token. */
  "DATADOG_TOKEN",
  /** Datadog region host, e.g. `datadoghq.eu`. Unset means `datadoghq.com`. */
  "DATADOG_SITE",
  /** The log search the Datadog loop scans. Unset means `status:error env:prod`. */
  "DATADOG_LOG_QUERY",
  "DATADOG_JIRA_PROJECT",
  "DATADOG_JIRA_ISSUE_TYPE",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  /**
   * Encrypts per-developer credentials at rest. Not a credential for anything
   * itself, and listed here anyway: it is the one value whose absence silently
   * disables a whole feature, so the system view must report whether it is set.
   */
  "TALOS_SECRET_KEY",
] as const;

export type KnownSecret = (typeof KNOWN_SECRETS)[number];

/**
 * Secrets a developer may hold their own copy of.
 *
 * The rest are deliberately excluded. `JIRA_BASE_URL` is the site, not an
 * identity — fifteen people pointing at fifteen Jiras is a misconfiguration, not
 * a feature. The LLM keys are the operator's spend, and `TALOS_SECRET_KEY` is
 * what would decrypt these, so storing it among them would be circular.
 *
 * This is the server's whitelist for the same idea the catalog spells
 * `scope: "user"` (see `shared/integrations.ts`), and it is the wider of the two:
 * `AZURE_DEVOPS_TOKEN` has no card yet, and every field the UI marks `"user"`
 * must appear here or storing it would be refused.
 */
export const ACTOR_SECRETS = [
  "GITLAB_TOKEN",
  "AZURE_DEVOPS_TOKEN",
  "JIRA_EMAIL",
  "JIRA_TOKEN",
  "SLACK_BOT_TOKEN",
] as const;

export type ActorSecret = (typeof ACTOR_SECRETS)[number];

export function isActorSecret(name: string): name is ActorSecret {
  return (ACTOR_SECRETS as readonly string[]).includes(name);
}

/**
 * Values that live alongside the credentials but are not themselves secret.
 *
 * Both are needed for authentication, so they belong in the env file — but
 * scrubbing them would replace the Jira site URL and the account email
 * throughout the logs, hiding exactly the detail that makes a failure
 * diagnosable.
 */
const NOT_REDACTED: ReadonlySet<string> = new Set([
  "JIRA_EMAIL",
  "JIRA_BASE_URL",
  "JIRA_BOARD_ID",
  "JIRA_TEAM_EMAILS",
  "GITLAB_API_URL",
  "SLACK_CLIENT_ID",
  "SLACK_WORKSPACE_ID",
  // A project key and an issue type: `TP` scrubbed out of every log line would
  // be an unreadable log, not a protected secret.
  "LOGROCKET_JIRA_PROJECT",
  "LOGROCKET_JIRA_ISSUE_TYPE",
  // A channel name. `#releases` redacted out of every log line would hide the
  // one detail that explains where an announcement went.
  "SLACK_RELEASE_CHANNEL",
  "DATADOG_SITE",
  "DATADOG_JIRA_PROJECT",
  "DATADOG_JIRA_ISSUE_TYPE",
  // The log query is operator-authored search syntax and the single most useful
  // thing to see in a log line when a scan comes back with nothing.
  "DATADOG_LOG_QUERY",
]);

/** Whether a value under this name should be scrubbed out of the logs. */
export function isRedactedSecret(name: string): boolean {
  return !NOT_REDACTED.has(name);
}

/**
 * Environment-backed store. Bun loads .env automatically, so no dotenv.
 *
 * The environment is snapshotted at construction rather than read per call, so
 * `values()` cannot drift from what was handed out and later scrubbed.
 */
export class EnvSecretStore implements SecretStore {
  private readonly snapshot: Map<string, string>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.snapshot = new Map();
    for (const [key, value] of Object.entries(env)) {
      if (value != null && value !== "") this.snapshot.set(key, value);
    }
  }

  get(name: string): string | undefined {
    return this.snapshot.get(name);
  }

  require(name: string): string {
    const value = this.snapshot.get(name);
    if (value == null) {
      throw new ConfigError(
        `Missing required secret '${name}'. Set it in the environment or .env.`,
      );
    }
    return value;
  }

  /**
   * Only the secrets we know are credentials. Scrubbing every environment
   * variable would replace innocuous values like PATH throughout the logs.
   */
  values(): readonly string[] {
    const out: string[] = [];
    for (const name of KNOWN_SECRETS) {
      const value = this.snapshot.get(name);
      if (value != null && !NOT_REDACTED.has(name)) out.push(value);
    }
    return out;
  }

  /** Which known secrets are present, for the system view. */
  presence(): Record<KnownSecret, boolean> {
    const out = {} as Record<KnownSecret, boolean>;
    for (const name of KNOWN_SECRETS) out[name] = this.snapshot.has(name);
    return out;
  }
}
