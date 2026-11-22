import { z } from "zod";
import { ConfigError, ConnectorError } from "../../core/errors.ts";
import type { Logger } from "../../logging/logger.ts";
import type { SecretStore } from "../../secrets/secret-store.ts";
import { report, runCheck, type Connector, type HealthReport } from "../connector.ts";
import { HttpClient, type FetchLike } from "../http.ts";
import { fitDocument, type AdfDocument } from "./adf.ts";
import {
  ConfluenceChildPagesSchema,
  ConfluencePageSchema,
  JiraBoardConfigurationSchema,
  JiraBoardIssuePageSchema,
  JiraBoardPageSchema,
  JiraCommentPageSchema,
  JiraCreatedIssueSchema,
  JiraFieldListSchema,
  JiraIssueDetailSchema,
  JiraMyselfSchema,
  JiraProjectSchema,
  JiraSearchIssueSchema,
  JiraSearchResultSchema,
  JiraSprintPageSchema,
  JiraTicketDetailSchema,
  JiraTransitionListSchema,
  JiraUserSchema,
  JiraUserListSchema,
  SPRINT_FIELD_MARKER,
  latestNumberedSprint,
  type ConfluencePage,
  type JiraBoard,
  type JiraBoardConfiguration,
  type JiraComment,
  type JiraCreatedIssue,
  type JiraField,
  type JiraIssueDetail,
  type JiraIssueType,
  type JiraMyself,
  type JiraProject,
  type JiraSearchIssue,
  type JiraSprint,
  type JiraTicketDetail,
  type JiraTransition,
  type JiraUser,
} from "./types.ts";

/** REST v3 for issues; the Agile API is a separate base path on the same host. */
const API_V3 = "/rest/api/3";
const AGILE_V1 = "/rest/agile/1.0";

/** Agile endpoints page at 50 by default; boards and sprints are few. */
const PAGE_SIZE = 50;
/** Jira caps project-assignable user search at the thousandth user. */
const ASSIGNABLE_USER_LIMIT = 1000;

/** Bounds a runaway pagination loop the way GitLab's MAX_PAGES does. */
const MAX_PAGES = 100;

/**
 * What `ticketDetail` asks for: everything a person reads before deciding what to
 * do about a ticket.
 *
 * Named explicitly rather than left to Jira's default (`*navigable`, which returns
 * every custom field on the site) because the response is otherwise dominated by
 * fields nothing reads — a site with fifty custom fields sends fifty of them per
 * ticket, and the panel would still show these twenty.
 */
const TICKET_DETAIL_FIELDS = [
  "summary",
  "description",
  "environment",
  "status",
  "issuetype",
  "priority",
  "resolution",
  "resolutiondate",
  "labels",
  "components",
  "fixVersions",
  "created",
  "updated",
  "duedate",
  "reporter",
  "assignee",
  "parent",
  "subtasks",
  "issuelinks",
  "attachment",
];

/**
 * Comments fetched per ticket. Enough that the recent conversation is all there,
 * and the `total` alongside them says when it is not — see `comments`.
 */
const COMMENT_PAGE_SIZE = 20;

export interface JiraClientOptions {
  /** Site URL, e.g. https://your-site.atlassian.net. Path is ignored if given. */
  baseUrl: string;
  /** Atlassian account email — the username half of basic auth. */
  email: string;
  /** API token from id.atlassian.com, not the account password. */
  token: string;
  fetch?: FetchLike;
  logger?: Logger;
  timeoutMs?: number;
  priority?: "interactive" | "background";
}

export interface CreateIssueInput {
  /** Project key, e.g. `SP`. */
  projectKey: string;
  /** Jira issue key to place in the issue's parent field. */
  parentKey?: string;
  summary: string;
  description: AdfDocument;
  /** Issue type *name*, resolved to an id against the project. */
  issueType: string;
  /** Account id, already resolved. Omitted leaves the issue unassigned. */
  assigneeAccountId?: string;
  /** Sprint id for the sprint custom field. Omitted leaves it in the backlog. */
  sprintId?: number;
  labels?: string[];
  /**
   * Extra create-screen fields already keyed by Jira field id
   * (`customfield_…`). Resolved by the caller from human field names.
   */
  extraFields?: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * Jira Cloud REST v3 plus the Agile API.
 *
 * Two design points worth knowing before reading:
 *
 * **Names in, ids out.** Config names an issue type ("Bug") and a person by
 * email, because those are what a human knows. Jira's create endpoint accepts
 * only ids, and both are per-site. Resolution therefore happens once, up front,
 * and is cached — so an unknown issue type fails at `connector test` with a list
 * of the valid ones, not at 3am with a 400 that names no field.
 *
 * **The sprint field has no fixed id.** It is a custom field whose id differs per
 * site, discovered through `/field` by its `gh-sprint` marker rather than
 * hard-coded.
 */
export class JiraClient implements Connector {
  readonly name = "jira";
  private readonly http: HttpClient;
  private readonly agile: HttpClient;
  private readonly confluence: HttpClient;
  private readonly site: string;

  /** Resolved once per process. Ids are stable for a site's lifetime. */
  private readonly issueTypeCache = new Map<string, JiraIssueType[]>();
  private readonly accountIdCache = new Map<string, string>();
  private myselfRead?: Promise<JiraMyself>;
  private sprintFieldId?: string;
  private fieldsCache?: JiraField[];

  constructor(options: JiraClientOptions) {
    if (!options.email) {
      throw new ConfigError("Jira client requires an account email (JIRA_EMAIL).");
    }
    if (!options.token) {
      throw new ConfigError("Jira client requires an API token (JIRA_TOKEN).");
    }

    this.site = normaliseSite(options.baseUrl);

    // Basic auth with the token as the password. Built once here so no call site
    // handles credentials, and the header form keeps it out of URLs and access
    // logs.
    const authorization = `Basic ${Buffer.from(
      `${options.email}:${options.token}`,
    ).toString("base64")}`;

    const shared = {
      connector: "jira",
      fetch: options.fetch,
      logger: options.logger,
      timeoutMs: options.timeoutMs,
      priority: options.priority,
      headers: { authorization },
    };

    this.http = new HttpClient({ ...shared, baseUrl: `${this.site}${API_V3}` });
    this.agile = new HttpClient({ ...shared, baseUrl: `${this.site}${AGILE_V1}` });
    this.confluence = new HttpClient({
      ...shared,
      connector: "confluence",
      baseUrl: `${this.site}/wiki/api/v2`,
    });
  }

  /** Site URL without an API path, for building issue browse links. */
  get siteUrl(): string {
    return this.site;
  }

  /** Browse URL for an issue key. Jira's own response omits a human-facing link. */
  issueUrl(key: string): string {
    return `${this.site}/browse/${key}`;
  }

  /**
   * Jira's attachment endpoint redirects to a short-lived Atlassian Media URL.
   * Returning that URL lets the browser stream and seek videos directly instead
   * of buffering a potentially large file through the Talos process.
   */
  async attachmentDownloadUrl(id: string, signal?: AbortSignal): Promise<string> {
    if (!/^\d+$/.test(id)) throw new ConfigError("Invalid Jira attachment id.");
    const response = await this.http.request(
      `/attachment/content/${encodeURIComponent(id)}`,
      {
        signal,
        accept: "*/*",
        redirect: "manual",
        acceptedStatuses: [302, 303, 307, 308],
        maxBytes: 4_096,
      },
    );
    const location = response.headers.get("location");
    let url: URL;
    try {
      url = new URL(location ?? "");
    } catch {
      throw new ConnectorError(
        `jira: attachment ${id} did not return a valid media redirect`,
        { connector: "jira", retryable: false },
      );
    }
    if (url.protocol !== "https:" || url.hostname !== "api.media.atlassian.com") {
      throw new ConnectorError(
        `jira: attachment ${id} redirected to an unexpected media host`,
        { connector: "jira", retryable: false },
      );
    }
    return url.toString();
  }

  /** A bounded plain-text attachment body for an in-browser preview. */
  async attachmentText(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; truncated: boolean }> {
    if (!/^\d+$/.test(id)) throw new ConfigError("Invalid Jira attachment id.");
    const result = await this.http.getText(
      `/attachment/content/${encodeURIComponent(id)}`,
      {
        signal,
        // Jira's redirect endpoint advertises JSON and returns 406 for
        // `text/plain`, even though the signed media response is the text file.
        accept: "*/*",
        maxBytes: 256 * 1024,
      },
    );
    return { text: result.text, truncated: result.truncated };
  }

  /**
   * A same-site Confluence page linked from Jira, for an inline requirements
   * preview. External links and unsupported Confluence URL shapes are not errors:
   * they keep their ordinary Smart Link card in the client.
   */
  async confluencePage(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; title: string; body: unknown } | null> {
    const pageId = confluencePageId(url, this.site);
    if (!pageId) return null;

    const { data } = await this.confluence.getJson(
      ConfluencePageSchema,
      `/pages/${encodeURIComponent(pageId)}`,
      {
        signal,
        query: { "body-format": "atlas_doc_format" },
      },
    );
    return {
      id: data.id,
      title: data.title,
      body: parseConfluenceAdf(data),
    };
  }

  /** Direct child pages shown below a Confluence release-index page. */
  async confluenceChildPages(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; title: string }[] | null> {
    const pageId = confluencePageId(url, this.site);
    if (!pageId) return null;

    const { data } = await this.confluence.getJson(
      ConfluenceChildPagesSchema,
      `/pages/${encodeURIComponent(pageId)}/children`,
      {
        signal,
        query: { limit: 250 },
      },
    );
    return data.results.map((page) => ({ id: page.id, title: page.title }));
  }

  /** The token's own account. The cheapest proof that authentication works. */
  async myself(signal?: AbortSignal): Promise<JiraMyself> {
    this.myselfRead ??= this.http
      .getJson(JiraMyselfSchema, "/myself", { signal })
      .then(({ data }) => data);
    try {
      return await this.myselfRead;
    } catch (err) {
      this.myselfRead = undefined;
      throw err;
    }
  }

  async project(key: string, signal?: AbortSignal): Promise<JiraProject> {
    const { data } = await this.http.getJson(
      JiraProjectSchema,
      `/project/${encodeURIComponent(key)}`,
      { signal },
    );
    return data;
  }

  /**
   * Issue types available on a project.
   *
   * Read from the project rather than the global `/issuetype` list: a type can
   * exist site-wide and still be absent from a given project's scheme, and
   * creating with it returns a 400 that says only "issuetype is not valid".
   */
  async issueTypes(projectKey: string, signal?: AbortSignal): Promise<JiraIssueType[]> {
    const cached = this.issueTypeCache.get(projectKey);
    if (cached) return cached;

    const project = await this.project(projectKey, signal);
    const types = project.issueTypes ?? [];
    this.issueTypeCache.set(projectKey, types);
    return types;
  }

  /**
   * The id for an issue type name, case-insensitively.
   *
   * Fails with the valid names listed. That list is the entire value of resolving
   * up front: "Bug is not a valid issue type; project SP has Task, Story, Épica"
   * is actionable, and Jira's own error is not.
   */
  async issueTypeId(
    projectKey: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const types = await this.issueTypes(projectKey, signal);
    const wanted = name.trim().toLowerCase();
    const match = types.find((t) => t.name.trim().toLowerCase() === wanted);

    if (!match) {
      throw new ConfigError(
        `Jira project ${projectKey} has no issue type '${name}'. ` +
          `Available: ${types.map((t) => t.name).join(", ") || "(none readable)"}`,
      );
    }
    return match.id;
  }

  /**
   * Users matching a query — an email address, or a display name.
   *
   * Requires the "Browse users and groups" global permission; without it Jira
   * returns 403 rather than an empty list, which is why the caller distinguishes
   * the two.
   */
  async searchUsers(query: string, signal?: AbortSignal): Promise<JiraUser[]> {
    const { data } = await this.http.getJson(JiraUserListSchema, "/user/search", {
      signal,
      query: { query, maxResults: PAGE_SIZE },
    });
    return data;
  }

  /**
   * Active human users Jira says may be assigned issues in this project.
   *
   * This is intentionally project-scoped rather than the site-wide user search:
   * offering somebody in the settings picker who cannot receive an issue in the
   * selected project only moves the validation error from the form to 3am.
   */
  async searchAssignableUsers(
    projectKey: string,
    query = "",
    signal?: AbortSignal,
  ): Promise<JiraUser[]> {
    const { data } = await this.http.getJson(
      JiraUserListSchema,
      "/user/assignable/search",
      {
        signal,
        query: {
          project: projectKey.trim().toUpperCase(),
          ...(query.trim() ? { query: query.trim() } : {}),
          startAt: 0,
          // One request reaches Jira's documented endpoint cap. Sequential
          // pagination here made opening a picker wait for the whole directory.
          maxResults: ASSIGNABLE_USER_LIMIT,
        },
      },
    );
    return data.filter(
      (user) =>
        user.active !== false &&
        (user.accountType == null || user.accountType === "atlassian"),
    );
  }

  /** Resolve a saved opaque account id back to a label for the settings picker. */
  async userByAccountId(accountId: string, signal?: AbortSignal): Promise<JiraUser> {
    const { data } = await this.http.getJson(JiraUserSchema, "/user", {
      signal,
      query: { accountId },
    });
    return data;
  }

  /**
   * The account id for an email address.
   *
   * GDPR made this harder than it looks. Atlassian withholds `emailAddress` from
   * `/user/search` unless the caller holds "View user email addresses", so
   * matching on the returned email fails for most tokens even though the search
   * itself matched on it. So: prefer an exact email match when one is visible,
   * otherwise accept a unique hit, and refuse to guess between several.
   *
   * The common case — the token's own email — never reaches the search at all,
   * because `/myself` answers it authoritatively and needs no extra permission.
   */
  async accountIdForEmail(email: string, signal?: AbortSignal): Promise<string> {
    const wanted = email.trim().toLowerCase();
    if (wanted === "") throw new ConfigError("Jira assignee email must not be empty.");

    const cached = this.accountIdCache.get(wanted);
    if (cached) return cached;

    const me = await this.myself(signal);
    if (me.emailAddress?.trim().toLowerCase() === wanted) {
      this.accountIdCache.set(wanted, me.accountId);
      return me.accountId;
    }

    const candidates = (await this.searchUsers(email, signal)).filter(
      // An app account matching a human's email would be a strange thing to
      // assign a bug to.
      (user) => user.accountType == null || user.accountType === "atlassian",
    );

    const exact = candidates.filter(
      (user) => user.emailAddress?.trim().toLowerCase() === wanted,
    );
    const chosen =
      exact.length === 1
        ? exact[0]
        : exact.length > 1
          ? undefined
          : candidates.length === 1
            ? candidates[0]
            : undefined;

    if (!chosen) {
      if (candidates.length === 0) {
        throw new ConfigError(
          `No Jira user found for '${email}'. The token needs the 'Browse users ` +
            `and groups' global permission, and the address must match an active ` +
            `Atlassian account on ${this.site}.`,
        );
      }
      throw new ConfigError(
        `'${email}' matched ${candidates.length} Jira users ` +
          `(${candidates.map((u) => u.displayName ?? u.accountId).join(", ")}). ` +
          `Set the account id explicitly instead of an email.`,
      );
    }

    this.accountIdCache.set(wanted, chosen.accountId);
    return chosen.accountId;
  }

  /**
   * The sprint custom field's id on this site, or undefined if there is none.
   *
   * Undefined rather than an error: a Jira site without Jira Software has no
   * sprint field at all, and that is a reason to file the ticket without a sprint
   * rather than to fail.
   */
  async findSprintFieldId(signal?: AbortSignal): Promise<string | undefined> {
    if (this.sprintFieldId) return this.sprintFieldId;

    const field = (await this.fields(signal)).find((f) =>
      f.schema?.custom?.endsWith(SPRINT_FIELD_MARKER),
    );
    if (field) this.sprintFieldId = field.id;
    return this.sprintFieldId;
  }

  /**
   * Builds create-issue payloads for named select fields (e.g. "Bug found by"
   * → `{ value: "automation" }`). Names are matched case-insensitively against
   * `/field`. Unknown names fail with the custom fields that *do* exist, the
   * same way an unknown issue type lists the valid ones.
   */
  async extraSelectFields(
    selects: { name: string; value: string }[],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const wanted = selects.filter((s) => s.name.trim() && s.value.trim());
    if (wanted.length === 0) return {};

    const fields = await this.fields(signal);
    const extra: Record<string, unknown> = {};

    for (const { name, value } of wanted) {
      const field = fieldByName(fields, name);
      if (!field) {
        const custom = fields
          .filter((f) => f.custom && f.name)
          .map((f) => `'${f.name}'`)
          .slice(0, 20);
        throw new ConfigError(
          `No Jira field named '${name}'. Known custom fields: ${
            custom.join(", ") || "(none)"
          }.`,
        );
      }
      extra[field.id] = selectPayload(field, value.trim());
    }
    return extra;
  }

  private async fields(signal?: AbortSignal): Promise<JiraField[]> {
    if (this.fieldsCache) return this.fieldsCache;
    const { data } = await this.http.getJson(JiraFieldListSchema, "/field", { signal });
    this.fieldsCache = data;
    return data;
  }

  /** Boards visible to the token, optionally narrowed to one project. */
  async listBoards(
    options: { projectKeyOrId?: string; signal?: AbortSignal } = {},
  ): Promise<JiraBoard[]> {
    const out: JiraBoard[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const { data } = await this.agile.getJson(JiraBoardPageSchema, "/board", {
        signal: options.signal,
        query: {
          projectKeyOrId: options.projectKeyOrId,
          startAt: page * PAGE_SIZE,
          maxResults: PAGE_SIZE,
        },
      });

      out.push(...data.values);
      if (data.isLast !== false || data.values.length === 0) break;
    }

    return out;
  }

  /** The board's real columns and the workflow status ids Jira maps into each one. */
  async boardConfiguration(
    boardId: number,
    signal?: AbortSignal,
  ): Promise<JiraBoardConfiguration> {
    const { data } = await this.agile.getJson(
      JiraBoardConfigurationSchema,
      `/board/${boardId}/configuration`,
      { signal },
    );
    return data;
  }

  /**
   * Every issue from one board matching additional JQL.
   *
   * This endpoint applies the board's saved filter before the supplied JQL, which
   * is the only way a second client can promise the same cards and counts as Jira's
   * board. Unlike enhanced search it uses numeric pagination and reports a total.
   */
  async boardIssues(
    boardId: number,
    jql?: string,
    options: { fields?: string[]; signal?: AbortSignal } = {},
  ): Promise<JiraSearchIssue[]> {
    const out: JiraSearchIssue[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const { data } = await this.agile.getJson(
        JiraBoardIssuePageSchema,
        `/board/${boardId}/issue`,
        {
          signal: options.signal,
          query: {
            ...(jql ? { jql } : {}),
            fields: (options.fields ?? ["summary", "status"]).join(","),
            startAt: page * PAGE_SIZE,
            maxResults: PAGE_SIZE,
          },
        },
      );
      out.push(...data.issues);
      const total = data.total ?? out.length;
      if (out.length >= total || data.issues.length === 0) return out;
    }

    throw new ConnectorError(
      `Jira board ${boardId} returned more than ${MAX_PAGES * PAGE_SIZE} issues.`,
      { connector: "jira" },
    );
  }

  /**
   * The active sprint on a board.
   *
   * A board can have several active sprints when a team runs parallel sprints
   * (e.g. carrying an older sprint into the next one), so the most recently
   * highest release number in the sprint name is chosen. Start date is the
   * fallback for names without a useful number.
   */
  async activeSprint(
    boardId: number,
    signal?: AbortSignal,
  ): Promise<JiraSprint | undefined> {
    const { data } = await this.agile.getJson(
      JiraSprintPageSchema,
      `/board/${boardId}/sprint`,
      { signal, query: { state: "active", maxResults: PAGE_SIZE } },
    );

    return latestNumberedSprint(data.values);
  }

  /**
   * The active sprint for a project, discovering the board when none is given.
   *
   * Board discovery is a convenience, not a guess: it is used only when the
   * project has exactly one scrum board, because with two the correct sprint is
   * genuinely unknown and putting the ticket in the wrong team's sprint is worse
   * than leaving it in the backlog.
   */
  async resolveActiveSprint(options: {
    projectKey: string;
    boardId?: number;
    signal?: AbortSignal;
  }): Promise<{ sprint?: JiraSprint; reason?: string }> {
    if (options.boardId != null) {
      const sprint = await this.activeSprint(options.boardId, options.signal);
      return sprint
        ? { sprint }
        : { reason: `board ${options.boardId} has no active sprint` };
    }

    const boards = (
      await this.listBoards({
        projectKeyOrId: options.projectKey,
        signal: options.signal,
      })
    ).filter((board) => board.type == null || board.type === "scrum");

    if (boards.length === 0) {
      return { reason: `no scrum board found for project ${options.projectKey}` };
    }
    if (boards.length > 1) {
      return {
        reason:
          `project ${options.projectKey} has ${boards.length} scrum boards ` +
          `(${boards.map((b) => `${b.id}:${b.name}`).join(", ")}) — ` +
          `set jira.boardId to choose one`,
      };
    }

    const sprint = await this.activeSprint(boards[0]!.id, options.signal);
    return sprint
      ? { sprint }
      : { reason: `board ${boards[0]!.id} (${boards[0]!.name}) has no active sprint` };
  }

  /**
   * Creates an issue.
   *
   * The only mutating call in this client, and every caller reaches it through
   * `mutate()` so a dry run cannot file a ticket.
   */
  async createIssue(input: CreateIssueInput): Promise<JiraCreatedIssue> {
    const issueTypeId = await this.issueTypeId(
      input.projectKey,
      input.issueType,
      input.signal,
    );

    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      issuetype: { id: issueTypeId },
      // Jira truncates nothing and rejects an over-long summary with a 400, so
      // the cap is applied here where the limit is known.
      summary: truncateSummary(input.summary),
      description: fitDocument(input.description),
    };

    if (input.parentKey) {
      fields.parent = { key: input.parentKey };
    }
    if (input.assigneeAccountId) {
      fields.assignee = { id: input.assigneeAccountId };
    }
    if (input.labels?.length) {
      // Jira rejects a label containing whitespace with an unhelpful error.
      fields.labels = input.labels.map((label) => label.replace(/\s+/g, "-"));
    }

    if (input.sprintId != null) {
      const fieldId = await this.findSprintFieldId(input.signal);
      if (!fieldId) {
        throw new ConfigError(
          `A sprint was requested but ${this.site} has no sprint field — the site ` +
            `may not have Jira Software enabled.`,
        );
      }
      // The sprint field takes a bare id, not an object, unlike every other
      // reference field on the create screen.
      fields[fieldId] = input.sprintId;
    }

    if (input.extraFields) {
      Object.assign(fields, input.extraFields);
    }

    const { data } = await this.http.postJson(
      JiraCreatedIssueSchema,
      "/issue",
      { fields },
      { signal: input.signal },
    );
    return data;
  }

  /**
   * Adds a comment to an issue.
   *
   * The update path for a failure that changed shape: a spec file already has a
   * ticket, but a different set of tests is failing now. Commenting keeps one
   * ticket per file — the thing a human tracks — while still recording that the
   * failure moved.
   */
  async addComment(
    issueKey: string,
    body: AdfDocument,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.postJson(
      // The response carries the created comment; nothing here needs it.
      z.looseObject({ id: z.string().optional() }),
      `/issue/${encodeURIComponent(issueKey)}/comment`,
      { body: fitDocument(body) },
      { signal },
    );
  }

  /**
   * One issue by key, or null when it no longer exists.
   *
   * Null rather than a thrown 404: an issue deleted or moved out of the project
   * is a normal thing to discover while reconciling a ledger row, and it means
   * "file a new one", not "the run failed".
   */
  async issue(
    issueKey: string,
    signal?: AbortSignal,
  ): Promise<JiraSearchIssue | null> {
    try {
      const { data } = await this.http.getJson(
        JiraSearchIssueSchema,
        `/issue/${encodeURIComponent(issueKey)}`,
        { signal, query: { fields: "summary,status,assignee" } },
      );
      return data;
    } catch (err) {
      // 404 is the answer, not a failure. Anything else — auth, permission, a
      // 500 — must still propagate, or a broken token would silently look like
      // "every ticket was deleted" and refile all of them.
      if (err instanceof ConnectorError && /returned 404/.test(err.message)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * One issue with the fields an agent needs to attempt it: description, type,
   * priority, labels, reporter.
   *
   * Separate from `issue()` rather than an option on it, because the two answer
   * different questions. `issue()` reconciles a ledger row and asks only "does
   * this still exist and is it open"; this one is the input to a code change, and
   * asking for description on every reconciliation would fetch a lot of ADF that
   * nothing reads. Null on 404, for the same reason as `issue()`.
   */
  async issueDetail(
    issueKey: string,
    signal?: AbortSignal,
  ): Promise<JiraIssueDetail | null> {
    try {
      const { data } = await this.http.getJson(
        JiraIssueDetailSchema,
        `/issue/${encodeURIComponent(issueKey)}`,
        {
          signal,
          query: {
            fields: "summary,description,status,issuetype,priority,labels,updated,reporter",
          },
        },
      );
      return data;
    } catch (err) {
      if (err instanceof ConnectorError && /returned 404/.test(err.message)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * One issue with everything a human reads before deciding what to do about it:
   * the description, who is on it, what it links to, what hangs off it.
   *
   * A third issue read rather than an option on the other two, for the reason
   * spelled out on `JiraTicketDetailSchema`: `issue()` reconciles a ledger row and
   * `issueDetail()` feeds an agent, and both are called on a loop. This one is
   * called when a person clicks a ticket, so it can afford to ask for everything.
   * Null on 404, like its siblings.
   *
   * `extraFields` exists for the fields whose ids are only known at runtime — the
   * sprint one above all, which is a custom field with a different id on every site
   * (see `findSprintFieldId`) and so cannot be a name in `TICKET_DETAIL_FIELDS`.
   */
  async ticketDetail(
    issueKey: string,
    options: { extraFields?: readonly string[]; signal?: AbortSignal } = {},
  ): Promise<JiraTicketDetail | null> {
    try {
      const { data } = await this.http.getJson(
        JiraTicketDetailSchema,
        `/issue/${encodeURIComponent(issueKey)}`,
        {
          ...(options.signal ? { signal: options.signal } : {}),
          query: {
            fields: [...TICKET_DETAIL_FIELDS, ...(options.extraFields ?? [])].join(","),
          },
        },
      );
      return data;
    } catch (err) {
      if (err instanceof ConnectorError && /returned 404/.test(err.message)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * An issue's comments, newest first.
   *
   * Its own call rather than the `comment` field on `ticketDetail` above, which
   * would have come back on the same request for free. Two reasons, and both are
   * about a ticket with a hundred comments: the inline field pages from the
   * *oldest* with no way to say otherwise, so it hands back the opening
   * description-by-committee and hides the reply that changed the plan yesterday;
   * and it reports no total, so a panel showing a truncated thread cannot say that
   * it is truncated.
   */
  async comments(
    issueKey: string,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<{ comments: JiraComment[]; total?: number }> {
    const { data } = await this.http.getJson(
      JiraCommentPageSchema,
      `/issue/${encodeURIComponent(issueKey)}/comment`,
      {
        ...(options.signal ? { signal: options.signal } : {}),
        query: {
          orderBy: "-created",
          maxResults: String(options.limit ?? COMMENT_PAGE_SIZE),
        },
      },
    );
    return {
      comments: data.comments,
      ...(data.total != null ? { total: data.total } : {}),
    };
  }

  /** Workflow transitions available on this issue right now, for this user. */
  async transitions(
    issueKey: string,
    signal?: AbortSignal,
  ): Promise<JiraTransition[]> {
    const { data } = await this.http.getJson(
      JiraTransitionListSchema,
      `/issue/${encodeURIComponent(issueKey)}/transitions`,
      { signal },
    );
    return data.transitions;
  }

  /**
   * Applies one transition by id. Requires a write-capable token.
   *
   * `request` rather than `postJson`: Jira answers a successful transition with
   * `204 No Content`, and every schema — including an empty loose object —
   * rejects the `null` an empty body parses to. There is nothing to validate here
   * anyway; the status is the whole answer.
   */
  async transitionIssue(
    issueKey: string,
    transitionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.request(`/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      body: { transition: { id: transitionId } },
      signal,
    });
  }

  /**
   * Moves an issue to a named state — "In Review", "In Progress".
   *
   * By name and not by id because an id is per project and meaningless in
   * config; matched against both the transition's own name and its destination
   * status, since Jira UIs show one or the other and operators reasonably type
   * either. Case- and space-insensitive.
   *
   * Throws a `ConfigError` listing what *is* available when nothing matches. That
   * message is the whole point of the method: "transition failed" tells an
   * operator nothing, while "no 'In Review'; this issue offers Start Progress,
   * Done" tells them exactly what to put in the config.
   */
  async transitionIssueTo(
    issueKey: string,
    target: string,
    signal?: AbortSignal,
  ): Promise<JiraTransition> {
    const available = await this.transitions(issueKey, signal);
    const wanted = normaliseState(target);
    const match = available.find(
      (transition) =>
        normaliseState(transition.name ?? "") === wanted ||
        normaliseState(transition.to?.name ?? "") === wanted,
    );
    if (!match) {
      const names = available
        .map((transition) => transition.to?.name ?? transition.name)
        .filter((name): name is string => Boolean(name));
      throw new ConfigError(
        `${issueKey} has no transition to '${target}'. Available from its current ` +
          `state: ${names.length > 0 ? names.join(", ") : "none"}.`,
      );
    }
    await this.transitionIssue(issueKey, match.id, signal);
    return match;
  }

  /**
   * Moves an issue into a board column.
   *
   * A Jira column is not a status: it can contain several status ids, and its
   * display name need not be any transition's name. Prefer any reachable status
   * Jira configured in that column, retaining the name fallback for old clients.
   */
  async transitionIssueToColumn(
    issueKey: string,
    column: { name: string; statusIds: readonly string[] },
    signal?: AbortSignal,
  ): Promise<JiraTransition> {
    const available = await this.transitions(issueKey, signal);
    const match =
      available.find((transition) =>
        transition.to?.id ? column.statusIds.includes(transition.to.id) : false,
      ) ??
      available.find(
        (transition) =>
          normaliseState(transition.name ?? "") === normaliseState(column.name) ||
          normaliseState(transition.to?.name ?? "") === normaliseState(column.name),
      );
    if (!match) {
      const names = available
        .map((transition) => transition.to?.name ?? transition.name)
        .filter((name): name is string => Boolean(name));
      throw new ConfigError(
        `${issueKey} has no transition into '${column.name}'. Available from its current ` +
          `state: ${names.length > 0 ? names.join(", ") : "none"}.`,
      );
    }
    await this.transitionIssue(issueKey, match.id, signal);
    return match;
  }

  /**
   * Issues matching a JQL query.
   *
   * Used to reconcile: before filing, ask Jira whether a ticket for this spec file
   * already exists. Our own ledger is the primary guard, but it cannot know about
   * a ticket someone filed by hand, nor about one we created in the instant before
   * a crash.
   */
  async searchIssues(
    jql: string,
    options: {
      limit?: number;
      /**
       * Fields to fetch, replacing the default. A loop that fingerprints tickets
       * asks for `updated`; asking for it always would cost nothing but would
       * imply every caller can rely on it, and `JiraSearchIssueSchema` marks it
       * optional precisely because most cannot.
       */
      fields?: string[];
      signal?: AbortSignal;
    } = {},
  ): Promise<JiraSearchIssue[]> {
    const limit = options.limit ?? PAGE_SIZE;
    const out: JiraSearchIssue[] = [];
    let nextPageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES && out.length < limit; page++) {
      const { data } = await this.http.postJson(
        JiraSearchResultSchema,
        "/search/jql",
        {
          jql,
          maxResults: Math.min(PAGE_SIZE, limit - out.length),
          fields: options.fields ?? ["summary", "status"],
          ...(nextPageToken ? { nextPageToken } : {}),
        },
        { signal: options.signal },
      );
      out.push(...data.issues);
      nextPageToken = data.nextPageToken;
      if (!nextPageToken || data.issues.length === 0) return out.slice(0, limit);
    }

    if (out.length >= limit) return out.slice(0, limit);
    if (nextPageToken) {
      throw new ConnectorError(
        `Jira search returned more than ${MAX_PAGES * PAGE_SIZE} issues.`,
        { connector: "jira" },
      );
    }
    return out.slice(0, limit);
  }

  /**
   * Health check for `talos connector test jira`.
   *
   * Read-only, and it prints the ids an operator has to put in config — issue
   * types, the resolved account id, the board and its active sprint. Those values
   * are the reason this command exists: every one of them is a per-site id that
   * cannot be guessed from documentation.
   */
  async check(
    options: {
      projectKey?: string;
      issueType?: string;
      assigneeEmail?: string;
      boardId?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<HealthReport> {
    const checks = [
      await runCheck("authentication", async () => {
        const me = await this.myself(options.signal);
        return {
          detail: `authenticated as ${me.displayName ?? me.accountId}${
            me.emailAddress ? ` <${me.emailAddress}>` : ""
          }`,
          values: [`accountId: ${me.accountId}`, `site: ${this.site}`],
        };
      }),
    ];

    // Every later check uses the same credentials, so they could only repeat the
    // same 401.
    if (!checks[0]!.ok) {
      checks.push({
        name: "project access",
        ok: false,
        detail: "not attempted — fix authentication first",
      });
      return report(this.name, checks);
    }

    if (!options.projectKey) {
      checks.push({
        name: "project access",
        ok: true,
        detail: "skipped — no Jira project configured for any task",
      });
      return report(this.name, checks);
    }

    const projectKey = options.projectKey;

    checks.push(
      await runCheck("project access", async () => {
        const project = await this.project(projectKey, options.signal);
        return {
          detail: `${project.key} — ${project.name ?? "(unnamed)"} (id ${project.id})`,
        };
      }),
    );

    checks.push(
      await runCheck("issue types", async () => {
        const types = await this.issueTypes(projectKey, options.signal);
        // Resolving the configured name here is the point: it turns a 3am 400
        // into a deploy-time failure.
        const detail = options.issueType
          ? `'${options.issueType}' resolves to id ${await this.issueTypeId(
              projectKey,
              options.issueType,
              options.signal,
            )}`
          : `${types.length} type(s) available`;
        return { detail, values: types.map((t) => `${t.name} → ${t.id}`) };
      }),
    );

    if (options.assigneeEmail) {
      checks.push(
        await runCheck("assignee", async () => {
          const accountId = await this.accountIdForEmail(
            options.assigneeEmail!,
            options.signal,
          );
          return { detail: `${options.assigneeEmail} → ${accountId}` };
        }),
      );
    }

    checks.push(
      await runCheck("active sprint", async () => {
        const fieldId = await this.findSprintFieldId(options.signal);
        if (!fieldId) {
          // Not a failure: a site without Jira Software has no sprints, and
          // tickets can still be filed.
          return {
            detail: "no sprint field on this site — issues will go to the backlog",
          };
        }

        const { sprint, reason } = await this.resolveActiveSprint({
          projectKey,
          boardId: options.boardId,
          signal: options.signal,
        });

        return sprint
          ? {
              detail: `${sprint.name} (id ${sprint.id})`,
              values: [`sprint field: ${fieldId}`],
            }
          : {
              // Also not a failure — see the fallback in the task.
              detail: `${reason} — issues will go to the backlog`,
              values: [`sprint field: ${fieldId}`],
            };
      }),
    );

    // Create permission cannot be proven without creating something, so this
    // reads the create metadata instead: the same permission gates both, and a
    // health check must never leave a ticket behind.
    checks.push(
      await runCheck("create permission", async () => {
        const issues = await this.searchIssues(`project = "${projectKey}"`, {
          limit: 1,
          signal: options.signal,
        });
        return {
          detail: `searchable; ${
            issues.length > 0 ? `newest visible issue ${issues[0]!.key}` : "no issues yet"
          }`,
        };
      }),
    );

    return report(this.name, checks);
  }
}

/** Jira's summary limit. Exceeding it is a 400 that names the field unhelpfully. */
export const MAX_SUMMARY_CHARS = 255;

export function truncateSummary(summary: string): string {
  const flat = summary.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_SUMMARY_CHARS
    ? flat
    : `${flat.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

/** Jira issue keys as they appear in branch names (`fix/TP-3012`) and MR titles. */
const JIRA_ISSUE_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;

/**
 * The first Jira issue key in any of `parts`, uppercased.
 *
 * Lives with the connector rather than with whichever caller wants it, because
 * "what does a Jira key look like" is Jira's business — and both the API's task
 * views and the pull request detail need the same answer for a branch name.
 */
export function extractJiraIssueKey(...parts: (string | undefined)[]): string | undefined {
  for (const part of parts) {
    if (!part) continue;
    const match = part.toUpperCase().match(JIRA_ISSUE_KEY);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * The browse URL for an issue key, or undefined when no site is configured.
 *
 * Deliberately does not throw on a malformed `JIRA_BASE_URL`: a link is a
 * nice-to-have on a view that has plenty else to show, and taking the whole
 * response down because somebody pasted a bad site URL would be the wrong trade.
 */
export function jiraBrowseUrl(secrets: SecretStore, key: string): string | undefined {
  const raw = secrets.get("JIRA_BASE_URL");
  if (raw == null) return undefined;
  try {
    return `${normaliseSite(raw)}/browse/${key}`;
  } catch {
    return undefined;
  }
}

/**
 * Strips any API path from a configured site URL.
 *
 * People paste `https://site.atlassian.net/rest/api/3` or a trailing slash from
 * the browser bar, and both would produce `/rest/api/3/rest/api/3/myself` — a 404
 * that reads like a missing endpoint.
 */
export function normaliseSite(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed === "") {
    throw new ConfigError(
      "Jira site URL must not be empty. Set JIRA_BASE_URL, e.g. " +
        "https://your-site.atlassian.net",
    );
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError(
      `Invalid Jira site URL '${baseUrl}'. Expected something like ` +
        `https://your-site.atlassian.net`,
    );
  }

  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    // Basic auth over http would put the token on the wire in plain text.
    throw new ConfigError(
      `Jira site URL must use https, got '${url.protocol}//' in '${baseUrl}'.`,
    );
  }

  return `${url.protocol}//${url.host}`;
}

/**
 * Extracts a page id only from Confluence URLs on the configured Jira origin.
 *
 * Tiny links encode the low four bytes of the numeric page id in URL-safe Base64,
 * little-endian — Atlassian's documented tiny-link algorithm. Keeping the origin
 * check here prevents a ticket-authored URL from turning the server into an SSRF
 * client carrying Jira credentials to another host.
 */
export function confluencePageId(rawUrl: string, site: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.origin !== site) return undefined;

  const direct = url.pathname.match(/^\/wiki\/spaces\/[^/]+\/pages\/(\d+)(?:\/|$)/);
  if (direct) return direct[1];

  if (url.pathname === "/wiki/pages/viewpage.action") {
    const pageId = url.searchParams.get("pageId");
    return pageId && /^\d+$/.test(pageId) ? pageId : undefined;
  }

  const tiny = url.pathname.match(/^\/wiki\/x\/([-_A-Za-z0-9]+)\/?$/);
  if (!tiny) return undefined;
  try {
    const bytes = Buffer.from(tiny[1]!, "base64url");
    if (bytes.length === 0) return undefined;
    const littleEndian = Buffer.alloc(4);
    bytes.copy(littleEndian, 0, 0, Math.min(bytes.length, 4));
    const pageId = littleEndian.readUInt32LE(0);
    return pageId > 0 ? String(pageId) : undefined;
  } catch {
    return undefined;
  }
}

function parseConfluenceAdf(page: ConfluencePage): unknown {
  try {
    return JSON.parse(page.body.atlas_doc_format.value);
  } catch (cause) {
    throw new ConnectorError(
      `confluence: page ${page.id} returned an invalid atlas_doc_format body`,
      { cause, connector: "confluence", retryable: false },
    );
  }
}

/** Shared config block for any task that files Jira issues. */
export const JiraConfigSchema = z.object({
  /** Project key, e.g. `SP`. Upper-cased, as Jira keys always are. */
  project: z
    .string()
    .min(1)
    .transform((value) => value.trim().toUpperCase()),
  /** Issue type *name*; resolved to an id at startup. */
  issueType: z.string().min(1).default("Bug"),
  /**
   * Fixed assignee. An email is resolved to an account id; an account id is used
   * as given. A legacy config with this value and no `assigneeMode` remains
   * fixed.
   */
  assignee: z.string().min(1).optional(),
  /**
   * How ticket ownership is chosen. Optional for backward compatibility:
   * a legacy config carrying `assignee` is fixed, while one without it uses
   * automatic attribution and falls back to JIRA_EMAIL.
   */
  assigneeMode: z.enum(["automatic", "fixed"]).optional(),
  /**
   * Board whose active sprint receives the issue. Optional: with exactly one
   * scrum board on the project it is discovered, and with several it must be set
   * because the right one is otherwise unknowable.
   */
  boardId: z.number().int().positive().optional(),
  /** Put issues in the active sprint. Off means the backlog, deliberately. */
  useActiveSprint: z.boolean().default(true),
  /**
   * Labels stamped on every ticket filed, on top of whatever else the task adds
   * (e.g. `ci-failure`'s per-file label). The default matches this schema's only
   * current caller, the CI-failure loop, which needs `talos`/`ci-failure`
   * on every ticket it files for cross-task label matching (see
   * `fix-jira-issue`'s `mrLabelsFor`) — fully user-editable from here on.
   */
  labels: z.array(z.string().min(1)).default(["talos", "ci-failure"]),
  /**
   * Value for the "Bug found by" select field. Matched by field *name* on the
   * site, so the custom field id can differ between Jira instances.
   */
  bugFoundBy: z.string().min(1).default("automation"),
  /**
   * Value for the "FE/BE/UX" select field. Same name-based lookup as
   * `bugFoundBy`.
   */
  feBeUx: z.string().min(1).default("FE"),
});

export type JiraConfig = z.infer<typeof JiraConfigSchema>;

/**
 * An account id rather than an email: Jira account ids are opaque strings, so
 * the discriminator is the `@`.
 */
export function looksLikeEmail(value: string): boolean {
  return value.includes("@");
}

function fieldByName(fields: JiraField[], name: string): JiraField | undefined {
  const wanted = name.trim().toLowerCase();
  return fields.find((f) => f.name?.trim().toLowerCase() === wanted);
}

/**
 * Compares workflow state names the way an operator writes them.
 *
 * "In Review", "in review" and "In  Review" are the same state to a human, and a
 * config file is written by a human reading a Jira board. Non-alphanumerics
 * collapse to a single space so "In-Progress" matches "In Progress" too.
 */
function normaliseState(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Select-list fields take `{ value }`; multi-selects take an array of those. */
export function selectPayload(field: JiraField, value: string): unknown {
  if (field.schema?.type === "array") return [{ value }];
  if (field.schema?.type === "string") return value;
  return { value };
}

/** Builds a client from the secret store, so no call site reads env directly. */
export function createJiraClient(
  secrets: SecretStore,
  options: Omit<JiraClientOptions, "baseUrl" | "email" | "token"> & {
    baseUrl?: string;
  } = {},
): JiraClient {
  return new JiraClient({
    ...options,
    baseUrl: options.baseUrl ?? secrets.require("JIRA_BASE_URL"),
    email: secrets.require("JIRA_EMAIL"),
    token: secrets.require("JIRA_TOKEN"),
  });
}

/** The three secrets `createJiraClient` cannot do without. */
export const JIRA_SECRETS = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_TOKEN"] as const;

/**
 * Which of them this store has no value for.
 *
 * Checked rather than caught, because `require` throws the same shape for a
 * missing base URL as for a Jira outage and the two need different words to the
 * developer reading them: one is "connect your account", the other is "try again".
 */
export function missingJiraSecrets(secrets: SecretStore): string[] {
  return JIRA_SECRETS.filter((name) => !secrets.get(name));
}

/** Narrow guard used when reporting which connector produced a failure. */
export function isJiraError(err: unknown): err is ConnectorError {
  return err instanceof ConnectorError && err.connector === "jira";
}
