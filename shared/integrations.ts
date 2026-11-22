/**
 * The integrations talos can be configured with, and the fields each one
 * needs.
 *
 * Two surfaces read this list, and which one shows a field is the field's
 * `scope`. Instance-wide settings — a Jira site URL, the Slack bot, the Datadog
 * and LogRocket keys — are the operator's, and live under Settings →
 * Integrations. Identities, meaning a token that authenticates as a *person*,
 * are each developer's own and live under My provider access; nobody should be
 * editing the whole team's GitLab identity from a settings page.
 *
 * Shared rather than server-only so the form and the store agree on one list: a
 * field the UI renders but the server rejects, or a name spelled `JIRA_URL` on
 * one side and `JIRA_BASE_URL` on the other, is the exact failure this file
 * exists to make impossible. The API returns per-field *state* (is it set, where
 * did the effective value come from) keyed by these names and nothing else, so
 * adding an integration is one entry here.
 *
 * The names are the same environment variable names `config/.env` uses, because
 * they are the same values: a stored field overrides the environment under the
 * name every connector already asks for. See `secrets/integration-secrets.ts`.
 */

export type IntegrationId = "gitlab" | "jira" | "slack" | "logrocket" | "datadog";

/**
 * Whose value a field is.
 *
 * `"instance"` is a setting for the whole install, edited under Settings →
 * Integrations. `"user"` is an identity each developer holds their own copy of,
 * edited under My provider access and stored per user — see `ACTOR_SECRETS` in
 * `src/secrets/secret-store.ts`, which is the server's whitelist for the same
 * idea and must contain every `"user"` name here.
 */
export type IntegrationScope = "instance" | "user";

export interface IntegrationField {
  /** The secret name, e.g. `GITLAB_TOKEN`. Uppercase; matches `config/.env`. */
  name: string;
  label: string;
  /**
   * Whether the value is a credential. Secret fields are encrypted at rest,
   * scrubbed from logs, and never sent back to the browser — the form shows
   * only whether one is stored. Non-secret fields (a site URL, an account
   * email) are shown and editable in place, because a URL you cannot read is a
   * URL you cannot fix.
   */
  secret: boolean;
  /**
   * Who the value belongs to. Absent means `"instance"`, because most settings
   * are.
   *
   * A `"user"` field stays in this catalog rather than leaving it, and that is
   * load-bearing: the instance-wide row behind it — from `config/.env`, or saved
   * here before the field moved — is still the shared fallback every unclaimed
   * loop authenticates with, and `SqliteIntegrationConfigStore.rows()` honours a
   * stored row only while its name is still in this list. Deleting the entry
   * would not migrate a token, it would silently retire one. So the field is
   * hidden from the settings page and refused by its PUT, and the value keeps
   * working exactly as before underneath.
   */
  scope?: IntegrationScope;
  /**
   * Not needed for the integration to work — a self-hosted API URL, a value with
   * a sensible default. Only used to decide whether a card reads as configured:
   * calling GitLab "partly configured" because the self-hosted URL is empty would
   * be a warning about nothing.
   */
  optional?: boolean;
  placeholder?: string;
  hint?: string;
}

export interface Integration {
  id: IntegrationId;
  name: string;
  description: string;
  fields: readonly IntegrationField[];
}

export const INTEGRATIONS: readonly Integration[] = [
  {
    id: "gitlab",
    name: "GitLab",
    description:
      "Reads merge requests and pushes review comments, branches and releases " +
      "as you.",
    fields: [
      {
        name: "GITLAB_TOKEN",
        label: "Personal access token",
        secret: true,
        scope: "user",
        placeholder: "glpat-…",
        hint:
          "Scope: api. Used for every GitLab read and write your work does, so " +
          "comments and branches land under your name rather than a bot's.",
      },
      {
        name: "GITLAB_API_URL",
        label: "API URL",
        secret: false,
        optional: true,
        placeholder: "https://gitlab.com/api/v4",
        hint: "Only needed for a self-hosted GitLab. Empty means gitlab.com.",
      },
    ],
  },
  {
    id: "jira",
    name: "Jira",
    description:
      "Reads assigned tickets and the ticket graph, and comments back on issues " +
      "as you.",
    fields: [
      {
        name: "JIRA_BASE_URL",
        label: "Site URL",
        secret: false,
        placeholder: "https://your-team.atlassian.net",
        hint:
          "The whole team's Jira, not yours — fifteen people pointing at fifteen " +
          "sites is a misconfiguration, so this one stays instance-wide.",
      },
      {
        name: "JIRA_BOARD_ID",
        label: "Board ID",
        secret: false,
        optional: true,
        placeholder: "20",
        hint:
          "The Jira Software board shown on the Jira page. Empty discovers it from " +
          "your current sprint; set it when the site has several boards.",
      },
      {
        name: "JIRA_TEAM_EMAILS",
        label: "Team emails",
        secret: false,
        optional: true,
        placeholder: "alex@example.com, sam@example.com",
        hint:
          "Comma-separated Jira account emails. Team view asks Jira only for these " +
          "developers instead of loading the entire board.",
      },
      {
        name: "JIRA_EMAIL",
        label: "Account email",
        secret: false,
        scope: "user",
        placeholder: "you@example.com",
        hint: "The Atlassian account your API token belongs to.",
      },
      {
        name: "JIRA_TOKEN",
        label: "API token",
        secret: true,
        scope: "user",
        hint:
          "An Atlassian API token, not a password. Created under Atlassian " +
          "account settings → Security → API tokens.",
      },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    description:
      "Connects each developer's Slack inbox for messages, reactions, and image " +
      "uploads, and announces releases to a team channel. OAuth settings power " +
      "personal inboxes; the bot token remains the shared announcement identity.",
    fields: [
      {
        name: "SLACK_CLIENT_ID",
        label: "OAuth client ID",
        secret: false,
        placeholder: "123456789.123456789",
        hint:
          "From the Slack app's Basic Information page. Add this TALOS install's " +
          "/api/auth/slack/callback URL under OAuth & Permissions → Redirect URLs.",
      },
      {
        name: "SLACK_CLIENT_SECRET",
        label: "OAuth client secret",
        secret: true,
        hint:
          "From the Slack app's Basic Information page. Used only server-side to " +
          "exchange each developer's one-time OAuth code.",
      },
      {
        name: "SLACK_WORKSPACE_ID",
        label: "Workspace ID",
        secret: false,
        placeholder: "T01234567",
        hint:
          "The one Slack workspace this TALOS install accepts. OAuth connections " +
          "from any other workspace are rejected.",
      },
      {
        name: "SLACK_APP_TOKEN",
        label: "Socket Mode app token",
        secret: true,
        optional: true,
        placeholder: "xapp-…",
        hint:
          "Optional, but enables live inbox updates without a public webhook. Enable " +
          "Socket Mode, create an app-level token with connections:write and " +
          "authorizations:read, then subscribe to the message user events.",
      },
      {
        name: "SLACK_BOT_TOKEN",
        label: "Bot user OAuth token",
        secret: true,
        placeholder: "xoxb-…",
        hint:
          "Create an app at https://api.slack.com/apps, add the chat:write bot scope " +
          "under OAuth & Permissions, install it to the workspace, then copy the Bot " +
          "User OAuth Token and save it here.",
      },
      {
        name: "SLACK_RELEASE_CHANNEL",
        label: "Release channel",
        secret: false,
        placeholder: "#releases",
        hint:
          "A channel name or ID. The app must be invited to it — run `/invite @your-app` " +
          "there, which is the usual reason a working token still fails to post.",
      },
    ],
  },
  {
    id: "logrocket",
    name: "LogRocket",
    description:
      "Session replay and frontend error data. LogRocket has no API for listing " +
      "issues, so talos receives them: set the webhook secret below, then paste " +
      "the URL it gives you into LogRocket → Issues → Alerts.",
    fields: [
      {
        name: "LOGROCKET_API_KEY",
        label: "API key",
        secret: true,
        hint: "From LogRocket → Settings → API. Stored encrypted, like every token here. Setting it turns the LogRocket page on.",
      },
      {
        name: "LOGROCKET_WEBHOOK_SECRET",
        label: "Webhook secret",
        secret: true,
        hint: "Any long random string — it is the path segment of the alert URL, so it is what stops a stranger filing issues. Generate one with `openssl rand -hex 32`. Deliveries are refused while it is empty.",
      },
      {
        name: "LOGROCKET_JIRA_PROJECT",
        label: "Jira project key",
        secret: false,
        placeholder: "TP",
        hint: "Where 'Create Jira ticket' files an issue for a LogRocket alert.",
      },
      {
        name: "LOGROCKET_JIRA_ISSUE_TYPE",
        label: "Jira issue type",
        secret: false,
        optional: true,
        placeholder: "Bug",
        hint: "Empty means Bug.",
      },
    ],
  },
  {
    id: "datadog",
    name: "Datadog",
    description:
      "Reads error logs on a daily loop and clusters them into issues by service " +
      "and error signature, so the console is the triage list instead of the " +
      "Datadog UI. One personal access token is the whole credential — no " +
      "API-key/app-key pair.",
    fields: [
      {
        name: "DATADOG_TOKEN",
        label: "Personal access token",
        secret: true,
        placeholder: "ddpat_…",
        hint:
          "A ddpat_ token from Datadog → Personal Settings → Access Tokens, sent as a " +
          "Bearer token. It needs logs_read_data and logs_read_index_data. Note that " +
          "an API key will not work here: the Logs API rejects it for these reads.",
      },
      {
        name: "DATADOG_SITE",
        label: "Site",
        secret: false,
        optional: true,
        placeholder: "datadoghq.com",
        hint:
          "The Datadog region host, without the api. prefix — datadoghq.com (US1), " +
          "datadoghq.eu, us3.datadoghq.com, ddog-gov.com. Empty means datadoghq.com. " +
          "A token is only valid on the site it was created in, so the wrong one here " +
          "reads as a 401.",
      },
      {
        name: "DATADOG_LOG_QUERY",
        label: "Log query",
        secret: false,
        optional: true,
        placeholder: "status:error env:prod",
        hint:
          "The Datadog log search the loop scans. Empty means `status:error env:prod` — " +
          "dropping env:prod typically multiplies the volume without adding a bug " +
          "anybody will fix. Exclusions per service live on the Datadog page's Routing " +
          "panel, not here.",
      },
      {
        name: "DATADOG_JIRA_PROJECT",
        label: "Jira project key",
        secret: false,
        placeholder: "TP",
        hint: "Where 'Create ticket & fix' files a Datadog issue. A routing rule may override it per team.",
      },
      {
        name: "DATADOG_JIRA_ISSUE_TYPE",
        label: "Jira issue type",
        secret: false,
        optional: true,
        placeholder: "Bug",
        hint: "Empty means Bug.",
      },
    ],
  },
];

/** Every field name in the catalog, whatever its scope, flattened. */
export const INTEGRATION_FIELD_NAMES: readonly string[] = INTEGRATIONS.flatMap(
  (integration) => integration.fields.map((field) => field.name),
);

/** A field's scope, with the default spelled out so callers never repeat it. */
export function scopeOf(field: IntegrationField): IntegrationScope {
  return field.scope ?? "instance";
}

/** One integration's fields in the given scope, in catalog order. */
export function fieldsInScope(
  integration: Integration,
  scope: IntegrationScope,
): readonly IntegrationField[] {
  return integration.fields.filter((field) => scopeOf(field) === scope);
}

/**
 * The integrations a scope's surface should render — those with at least one
 * field in it.
 *
 * Derived rather than listed twice: a card with nothing to edit on it is noise,
 * and marking one more field `"user"` should move it between the two surfaces
 * without anybody having to remember a second list.
 */
export function integrationsInScope(scope: IntegrationScope): readonly Integration[] {
  return INTEGRATIONS.filter((integration) => fieldsInScope(integration, scope).length > 0);
}

/** Every field name in the given scope, flattened. */
export function fieldNamesInScope(scope: IntegrationScope): readonly string[] {
  return INTEGRATIONS.flatMap((integration) =>
    fieldsInScope(integration, scope).map((field) => field.name),
  );
}

export function integrationField(name: string): IntegrationField | undefined {
  for (const integration of INTEGRATIONS) {
    const field = integration.fields.find((f) => f.name === name);
    if (field) return field;
  }
  return undefined;
}

/**
 * Whether this name is one of the fields above. Enforced at the store as well
 * as the API edge: a store that accepted any name would let the settings page
 * write `TALOS_SECRET_KEY` — the key that decrypts the rest — into the very
 * database it protects.
 */
export function isIntegrationField(name: string): boolean {
  return INTEGRATION_FIELD_NAMES.includes(name);
}

/**
 * Whether the Integrations page may write this name.
 *
 * Narrower than `isIntegrationField` on purpose: the store still accepts a
 * user-scoped name — that is what keeps an already-stored GitLab token working
 * as the shared fallback, and what `config/.env` still sets — while
 * the instance-wide *settings page* no longer offers to change one for everybody.
 */
export function isInstanceIntegrationField(name: string): boolean {
  const field = integrationField(name);
  return field != null && scopeOf(field) === "instance";
}

/** Whether this name is a per-developer identity, edited under My provider access. */
export function isUserIntegrationField(name: string): boolean {
  const field = integrationField(name);
  return field != null && scopeOf(field) === "user";
}
