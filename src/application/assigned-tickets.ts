/**
 * Tickets from one Jira board, read live with one developer's credentials.
 *
 * The ticket graph used to be able to draw only tickets some loop happened to be
 * tracking, which omitted tickets no automation had touched. The roots now come
 * from Jira itself: either those assigned to the current user or, for Team, every
 * ticket permitted by the board's saved filter.
 *
 * Read with the asking developer's own credentials, exactly like the pull
 * request service — `assignee = currentUser()` is meaningless under a shared bot
 * token, and resolving the token any other way than a run would means "it works
 * on the graph but the loop 403s" has two places to go wrong instead of one.
 */
import {
  createJiraClient,
  isJiraError,
  JiraClient,
  missingJiraSecrets,
} from "../connectors/jira/client.ts";
import {
  currentSprintOf,
  parseIssueSprints,
  sprintState,
  type JiraSearchIssue,
  type JiraSprint,
  type SprintState,
} from "../connectors/jira/types.ts";
import type { Actor } from "../core/actor.ts";
import type { Logger } from "../logging/logger.ts";
import type { SecretStore } from "../secrets/secret-store.ts";

/**
 * The sprint a ticket is in, as far as the graph is concerned.
 *
 * Carried per ticket rather than fetched per board: the sprint field comes back on
 * the same search that returns the tickets, so the whole sprint dimension of the
 * page costs one extra field on a call already being made.
 */
export interface TicketSprint {
  id: number;
  name: string;
  state: SprintState;
  startDate?: string;
  endDate?: string;
  boardId?: number;
}

export interface TicketAssignee {
  accountId?: string;
  name: string;
  avatarUrl?: string;
}

/** What the graph's ticket node and its detail panel show. */
export interface AssignedTicket {
  key: string;
  summary?: string;
  url: string;
  /** Stable Jira workflow status id, used to place the card in its board column. */
  statusId?: string;
  status?: string;
  /** `new`, `indeterminate` or `done` — portable, unlike a translated status name. */
  statusCategory?: string;
  type?: string;
  priority?: string;
  labels: string[];
  assignee?: TicketAssignee;
  reporter?: string;
  createdAt?: string;
  updatedAt?: string;
  /**
   * The sprint this ticket is in now — see `currentSprintOf` for which one that is
   * when a ticket has been carried across several. Absent for a backlog ticket, and
   * for every ticket on a site with no sprint field at all.
   */
  sprint?: TicketSprint;
  /** Every sprint Jira lists on the issue, used by the active-sprints union filter. */
  sprints: TicketSprint[];
  /**
   * The key of this ticket's parent — set on a subtask, or on a story split
   * under an epic. Lets the board draw a subtask beside its siblings when
   * they land in the same column, without a second fetch per ticket.
   */
  parentKey?: string;
  /** The id of the Jira board column containing `statusId`. */
  columnId?: string;
}

export interface TicketBoardColumn {
  id: string;
  name: string;
  statusIds: string[];
}

export interface TicketBoard {
  id: number;
  name: string;
  /** Jira calls this a project key in its API and a space key in the product UI. */
  spaceKey?: string;
  spaceName?: string;
  columns: TicketBoardColumn[];
}

export interface AssignedTicketResult {
  tickets: AssignedTicket[];
  board?: TicketBoard;
  currentSprintId?: number;
  /**
   * Why the list is empty or short, in plain language — a missing token, a JQL
   * Jira rejected. Reported rather than thrown so the graph still draws the loop
   * work it assembled locally instead of collapsing into a red box.
   */
  warning?: string;
}

/** Everything an `AssignedTicket` needs, and nothing Jira has to compute. */
const FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "labels",
  "assignee",
  "reporter",
  "created",
  "updated",
  "parent",
];

/**
 * Jira's board filter decides which projects and issue types belong. This JQL is
 * only the per-developer part layered over it; done issues remain available so a
 * closed sprint selected in the switcher matches Jira rather than disappearing.
 */
const ASSIGNED_JQL = "assignee = currentUser() ORDER BY updated DESC";

/** Comma-separated Jira account emails from Settings. Empty means Team view has nobody to ask for. */
function teamEmails(secrets: SecretStore): string[] {
  const configured = secrets.get("JIRA_TEAM_EMAILS") ?? "";
  return [
    ...new Set(
      configured
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function jqlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export interface AssignedTicketServiceDeps {
  /** The asking developer's own Jira identity plus shared site/board configuration. */
  secretsFor(actor: Actor): SecretStore;
  logger: Logger;
}

export class AssignedTicketService {
  /** Account ids are stable; resolving the configured emails on every poll wastes Jira calls. */
  private readonly teamJqlCache = new Map<string, Promise<string>>();

  constructor(private readonly deps: AssignedTicketServiceDeps) {}

  async list(
    actor: Actor,
    options: { scope?: "mine" | "team"; signal?: AbortSignal } = {},
  ): Promise<AssignedTicketResult> {
    const secrets = this.deps.secretsFor(actor);
    const missing = missingJiraSecrets(secrets);
    if (missing.length > 0) {
      return {
        tickets: [],
        warning:
          `Jira is not configured for you (${missing.join(", ")}), so the graph shows ` +
          "only tickets a loop is already tracking.",
      };
    }

    const jira = createJiraClient(secrets);
    try {
      // Resolved before the search because the field has to be *named* in it, and
      // its id differs per site — see `findSprintFieldId`.
      const sprintField = await this.sprintField(jira, actor, options.signal);
      const boardId = await this.boardId(jira, secrets, sprintField, options.signal);
      if (boardId == null) {
        // Without a board, dropping the assignee clause would search the caller's
        // entire Jira site rather than this page's space. Keep the safe personal
        // fallback until an administrator chooses a board.
        const issues = await jira.searchIssues(ASSIGNED_JQL, {
          limit: 5_000,
          fields: sprintField ? [...FIELDS, sprintField] : FIELDS,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        return {
          tickets: issues.map((issue) =>
            toAssignedTicket(issue, jira.issueUrl(issue.key), sprintField),
          ),
          warning:
            "Could not determine which Jira board to mirror. Set JIRA_BOARD_ID in " +
            "Settings → Integrations to use Jira's exact columns and saved filter." +
            (options.scope === "team" ? " Showing only tickets assigned to you." : ""),
        };
      }

      // The board endpoint applies Jira's saved board filter first. Team therefore
      // means tickets assigned to the configured roster; Mine layers the
      // current-user assignee constraint over the same board. Filtering remotely
      // keeps a large board from being downloaded and expanded on every refresh.
      const emails = options.scope === "team" ? teamEmails(secrets) : [];
      if (options.scope === "team" && emails.length === 0) {
        return {
          tickets: [],
          warning:
            "Set JIRA_TEAM_EMAILS in Settings → Integrations to choose who Team view includes.",
        };
      }
      const jql =
        options.scope === "team"
          ? await this.teamJql(jira, secrets, options.signal)
          : ASSIGNED_JQL;
      const [configuration, issues, currentSprint] = await Promise.all([
        jira.boardConfiguration(boardId, options.signal),
        jira.boardIssues(boardId, jql, {
          fields: sprintField ? [...FIELDS, sprintField] : FIELDS,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
        jira.activeSprint(boardId, options.signal),
      ]);
      const board: TicketBoard = {
        id: configuration.id,
        name: configuration.name,
        ...(configuration.location?.projectKey
          ? { spaceKey: configuration.location.projectKey }
          : {}),
        ...(configuration.location?.projectName
          ? { spaceName: configuration.location.projectName }
          : {}),
        columns: configuration.columnConfig.columns.map((column, index) => ({
          id: `jira:${configuration.id}:column:${index}`,
          name: column.name,
          statusIds: column.statuses.map((status) => status.id),
        })),
      };
      return {
        tickets: issues.map((issue) =>
          toAssignedTicket(issue, jira.issueUrl(issue.key), sprintField, board),
        ),
        board,
        ...(currentSprint ? { currentSprintId: currentSprint.id } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(
        { actor: actor.email, jira: isJiraError(err) ? "api" : "unknown", err: message },
        "could not read assigned Jira tickets for the ticket graph",
      );
      return { tickets: [], warning: `Jira did not answer: ${message}` };
    }
  }

  private async teamJql(
    jira: JiraClient,
    secrets: SecretStore,
    signal?: AbortSignal,
  ): Promise<string> {
    const emails = teamEmails(secrets);
    const key = emails.join(",");
    let pending = this.teamJqlCache.get(key);
    if (!pending) {
      pending = Promise.all(
        emails.map((email) => jira.accountIdForEmail(email, signal)),
      ).then(
        (accountIds) =>
          `assignee in (${accountIds.map(jqlString).join(", ")}) ORDER BY updated DESC`,
      );
      this.teamJqlCache.set(key, pending);
    }
    try {
      return await pending;
    } catch (err) {
      this.teamJqlCache.delete(key);
      throw err;
    }
  }

  /**
   * The board to mirror, explicit when configured and otherwise inferred from the
   * newest active sprint among this developer's assigned tickets.
   */
  private async boardId(
    jira: JiraClient,
    secrets: SecretStore,
    sprintField: string | undefined,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    const configured = secrets.get("JIRA_BOARD_ID")?.trim();
    if (configured) {
      const id = Number(configured);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`JIRA_BOARD_ID must be a positive integer, got '${configured}'.`);
      }
      return id;
    }
    if (!sprintField) return undefined;

    const issues = await jira.searchIssues(ASSIGNED_JQL, {
      limit: 100,
      fields: [sprintField],
      ...(signal ? { signal } : {}),
    });
    return currentSprintOf(
      issues.flatMap((issue) =>
        parseIssueSprints((issue.fields as Record<string, unknown> | undefined)?.[sprintField]),
      ),
    )?.boardId;
  }

  /**
   * The sprint custom field's id, or undefined when this site has no sprints to
   * speak of.
   *
   * Swallowed rather than propagated, and deliberately not turned into a warning:
   * `/field` needs no permission the search does not already have, so the realistic
   * failures here are a site without Jira Software and a transient blip. Neither is
   * worth losing the ticket list over, and both mean the same thing to the page —
   * no sprint filter. A ticket list with no sprints beats a red box.
   */
  private async sprintField(
    jira: JiraClient,
    actor: Actor,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      return await jira.findSprintFieldId(signal);
    } catch (err) {
      this.deps.logger.debug(
        { actor: actor.email, err: err instanceof Error ? err.message : String(err) },
        "could not resolve the Jira sprint field; the ticket graph will show no sprints",
      );
      return undefined;
    }
  }
}

function toAssignedTicket(
  issue: JiraSearchIssue,
  url: string,
  sprintField: string | undefined,
  board?: TicketBoard,
): AssignedTicket {
  const fields = issue.fields;
  const sprints = sprintsOf(fields, sprintField);
  const sprint = sprintOf(fields, sprintField);
  const statusId = fields?.status?.id;
  const columnId = statusId
    ? board?.columns.find((column) => column.statusIds.includes(statusId))?.id
    : undefined;
  const assignee = fields?.assignee?.displayName
    ? {
        ...(fields.assignee.accountId ? { accountId: fields.assignee.accountId } : {}),
        name: fields.assignee.displayName,
        ...(fields.assignee.avatarUrls?.["24x24"]
          ? { avatarUrl: fields.assignee.avatarUrls["24x24"] }
          : {}),
      }
    : undefined;
  return {
    key: issue.key,
    ...(fields?.summary ? { summary: fields.summary } : {}),
    url,
    ...(statusId ? { statusId } : {}),
    ...(fields?.status?.name ? { status: fields.status.name } : {}),
    ...(fields?.status?.statusCategory?.key
      ? { statusCategory: fields.status.statusCategory.key }
      : {}),
    ...(fields?.issuetype?.name ? { type: fields.issuetype.name } : {}),
    ...(fields?.priority?.name ? { priority: fields.priority.name } : {}),
    labels: fields?.labels ?? [],
    ...(assignee ? { assignee } : {}),
    sprints,
    ...(fields?.reporter?.displayName ? { reporter: fields.reporter.displayName } : {}),
    ...(fields?.created ? { createdAt: fields.created } : {}),
    ...(fields?.updated ? { updatedAt: fields.updated } : {}),
    ...(sprint ? { sprint } : {}),
    ...(fields?.parent?.key ? { parentKey: fields.parent.key } : {}),
    ...(columnId ? { columnId } : {}),
  };
}

/**
 * The ticket's sprint, read from a field whose name is only known at runtime.
 *
 * The cast is the price of that: `JiraSearchIssueSchema` is a loose object so the
 * value is carried through untouched, but nothing can type an index whose key came
 * from `/field`. `parseIssueSprints` treats it as `unknown` anyway, which is where
 * the actual validation happens.
 */
function sprintsOf(
  fields: JiraSearchIssue["fields"],
  sprintField: string | undefined,
): TicketSprint[] {
  if (!fields || !sprintField) return [];
  return toTicketSprints((fields as Record<string, unknown>)[sprintField]);
}

function sprintOf(
  fields: JiraSearchIssue["fields"],
  sprintField: string | undefined,
): TicketSprint | undefined {
  if (!fields || !sprintField) return undefined;
  return toTicketSprint((fields as Record<string, unknown>)[sprintField]);
}

/**
 * One raw sprint field value to the sprint a ticket is in.
 *
 * Exported because the ticket panel reads the same field off a single-issue fetch
 * (`ticket-detail.ts`) and has to arrive at the same answer: two places deciding
 * independently which of a carried-over ticket's three sprints is "its" sprint is
 * two places to disagree in front of the same developer.
 */
export function toTicketSprint(value: unknown): TicketSprint | undefined {
  const sprint = currentSprintOf(parseIssueSprints(value));
  return sprint ? toTicketSprintValue(sprint) : undefined;
}

/** Every valid Jira sprint value, without collapsing carried-over memberships. */
export function toTicketSprints(value: unknown): TicketSprint[] {
  return parseIssueSprints(value).map(toTicketSprintValue);
}

function toTicketSprintValue(sprint: JiraSprint): TicketSprint {
  return {
    id: sprint.id,
    name: sprint.name,
    state: sprintState(sprint),
    ...(sprint.startDate ? { startDate: sprint.startDate } : {}),
    ...(sprint.endDate ? { endDate: sprint.endDate } : {}),
    ...(sprint.boardId != null ? { boardId: sprint.boardId } : {}),
  };
}
