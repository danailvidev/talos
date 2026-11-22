import { z } from "zod";

/**
 * Response schemas for the Jira Cloud REST v3 and Agile 1.0 endpoints we use.
 *
 * Loose objects for the same reason as GitLab's: Atlassian adds fields freely,
 * and a running install must not break because a new one appeared. What we do
 * declare is required, so a rename fails at the boundary rather than putting
 * `undefined` in a ticket summary.
 */

/** The token's own account. Jira Cloud has no `/user` — this is the equivalent. */
export const JiraMyselfSchema = z.looseObject({
  accountId: z.string(),
  displayName: z.string().optional(),
  emailAddress: z.string().optional(),
  active: z.boolean().optional(),
});

export type JiraMyself = z.infer<typeof JiraMyselfSchema>;

/**
 * A user as returned by `/user/search`.
 *
 * `emailAddress` is optional and often absent: Atlassian withholds it unless the
 * caller has the "View user email addresses" global permission or the user has
 * made it public. Any lookup by email must cope with never seeing one back.
 */
export const JiraUserSchema = z.looseObject({
  accountId: z.string(),
  displayName: z.string().optional(),
  emailAddress: z.string().optional(),
  active: z.boolean().optional(),
  accountType: z.string().optional(),
});

export type JiraUser = z.infer<typeof JiraUserSchema>;

export const JiraUserListSchema = z.array(JiraUserSchema);

export const JiraIssueTypeSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  subtask: z.boolean().optional(),
  description: z.string().optional(),
});

export type JiraIssueType = z.infer<typeof JiraIssueTypeSchema>;

export const JiraProjectSchema = z.looseObject({
  id: z.string(),
  key: z.string(),
  name: z.string().optional(),
  issueTypes: z.array(JiraIssueTypeSchema).optional(),
});

export type JiraProject = z.infer<typeof JiraProjectSchema>;

/** What POST /issue returns: identifiers only, never the issue itself. */
export const JiraCreatedIssueSchema = z.looseObject({
  id: z.string(),
  key: z.string(),
  self: z.string().optional(),
});

export type JiraCreatedIssue = z.infer<typeof JiraCreatedIssueSchema>;

/**
 * A field on the create screen.
 *
 * Read to find the sprint field. Sprint is a custom field whose id differs per
 * Jira site (`customfield_10020` on one, `customfield_10007` on another), so
 * hard-coding one would work on exactly the site it was written against. It is
 * identified by `schema.custom` ending in `gh-sprint`.
 */
export const JiraFieldSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  custom: z.boolean().optional(),
  schema: z
    .looseObject({
      type: z.string().optional(),
      custom: z.string().optional(),
      customId: z.number().optional(),
    })
    .optional(),
});

export type JiraField = z.infer<typeof JiraFieldSchema>;

export const JiraFieldListSchema = z.array(JiraFieldSchema);

/** The custom-field marker that identifies the sprint field on any Jira site. */
export const SPRINT_FIELD_MARKER = "gh-sprint";

export const JiraBoardSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  type: z.string().optional(),
});

export type JiraBoard = z.infer<typeof JiraBoardSchema>;

export const JiraBoardPageSchema = z.looseObject({
  values: z.array(JiraBoardSchema),
  isLast: z.boolean().optional(),
  startAt: z.number().optional(),
  maxResults: z.number().optional(),
  total: z.number().optional(),
});

export const JiraBoardConfigurationSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  type: z.string().optional(),
  // Jira's API still calls these projects even though the product UI calls
  // them spaces. Kept optional because user-owned boards have no project
  // location and older Jira deployments may omit it.
  location: z
    .looseObject({
      projectKey: z.string().optional(),
      projectName: z.string().optional(),
    })
    .optional(),
  columnConfig: z.looseObject({
    columns: z.array(
      z.looseObject({
        name: z.string(),
        statuses: z.array(z.looseObject({ id: z.string() })).default([]),
      }),
    ),
  }),
});

export type JiraBoardConfiguration = z.infer<typeof JiraBoardConfigurationSchema>;

export const JiraSprintSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  state: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  boardId: z.number().optional(),
});

export type JiraSprint = z.infer<typeof JiraSprintSchema>;

export const JiraSprintPageSchema = z.looseObject({
  values: z.array(JiraSprintSchema),
  isLast: z.boolean().optional(),
});

/**
 * `active`, `future` or `closed` — the three states Jira gives a sprint, plus
 * `unknown` for the site that omits the field.
 *
 * Lower-cased on the way in because the two places a sprint arrives from disagree
 * on case: the Agile API says `active`, the issue custom field's legacy string
 * says `ACTIVE`, and a filter comparing them raw silently matches neither.
 */
export type SprintState = "active" | "future" | "closed" | "unknown";

export function sprintState(sprint: JiraSprint): SprintState {
  const state = sprint.state?.toLowerCase();
  return state === "active" || state === "future" || state === "closed" ? state : "unknown";
}

/**
 * The sprint custom field's value on one issue, whichever shape it arrived in.
 *
 * Two shapes, because Atlassian changed it and did not finish: a modern Jira Cloud
 * search returns an array of objects, while older sites — and some field
 * configurations on current ones — return the Java `toString()` of the sprint
 * object, `com.atlassian...Sprint@1a2b[id=42,state=ACTIVE,name=Sprint 5,...]`.
 * Both are parsed rather than one being declared correct: a console that shows no
 * sprints on half its installs is not worth the tidier code.
 *
 * An array because an issue carried over from a finished sprint belongs to both,
 * and which one is "its" sprint is `currentSprintOf`'s decision, not this
 * function's.
 */
export function parseIssueSprints(value: unknown): JiraSprint[] {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  const sprints: JiraSprint[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      const parsed = parseLegacySprint(entry);
      if (parsed) sprints.push(parsed);
      continue;
    }
    const parsed = JiraSprintSchema.safeParse(entry);
    if (parsed.success) sprints.push(parsed.data);
  }
  return sprints;
}

/**
 * `...Sprint@1a2b[id=42,rapidViewId=7,state=ACTIVE,name=Sprint 5,startDate=...]`.
 *
 * Fields are read by name rather than by position, and a value runs to the next
 * `key=` pair so a sprint named "Sprint 5, week 2" survives the comma. `<null>`
 * is Jira's way of writing an absent value in this format.
 */
function parseLegacySprint(text: string): JiraSprint | undefined {
  const body = text.slice(text.indexOf("[") + 1, text.lastIndexOf("]"));
  if (!body) return undefined;

  const read = (key: string): string | undefined => {
    const match = body.match(new RegExp(`(?:^|,)${key}=(.*?)(?=,[a-zA-Z]+=|$)`));
    const value = match?.[1];
    return value == null || value === "" || value === "<null>" ? undefined : value;
  };

  const id = Number(read("id"));
  const name = read("name");
  if (!Number.isFinite(id) || !name) return undefined;
  const boardId = Number(read("rapidViewId"));

  return {
    id,
    name,
    ...(read("state") ? { state: read("state") } : {}),
    ...(read("startDate") ? { startDate: read("startDate") } : {}),
    ...(read("endDate") ? { endDate: read("endDate") } : {}),
    ...(Number.isFinite(boardId) ? { boardId } : {}),
  };
}

/**
 * Which of an issue's sprints it is *in* right now.
 *
 * A ticket dragged forward twice lists three sprints, only one of which answers
 * "is this in the sprint I am working": the active one. Failing that the nearest
 * future sprint, because a ticket already planned into next sprint is planned,
 * not backlog; and failing that the most recently closed one, which is how a
 * ticket left behind by a finished sprint still says where it came from.
 */
export function currentSprintOf(sprints: readonly JiraSprint[]): JiraSprint | undefined {
  const byStart = (a: JiraSprint, b: JiraSprint) =>
    (a.startDate ?? "").localeCompare(b.startDate ?? "");
  const inState = (state: SprintState) => sprints.filter((s) => sprintState(s) === state);

  return (
    latestNumberedSprint(inState("active")) ??
    [...inState("future")].sort(byStart)[0] ??
    [...inState("closed")].sort(byStart).at(-1) ??
    sprints[0]
  );
}

/**
 * The highest release-like number in an active sprint name.
 *
 * Names in this Jira are release sequences (`TP 4.2.144 October 23`). Parallel
 * sprints can have misleading start dates, so 4.2.144 outranks 4.2.143. Names
 * without a number retain the previous start-date ordering.
 */
export function latestNumberedSprint(
  sprints: readonly JiraSprint[],
): JiraSprint | undefined {
  return [...sprints].sort((a, b) => {
    const numberOrder = compareNumberSequences(
      sprintNumber(b.name),
      sprintNumber(a.name),
    );
    if (numberOrder !== 0) return numberOrder;
    return (b.startDate ?? "").localeCompare(a.startDate ?? "");
  })[0];
}

function sprintNumber(name: string): number[] {
  const match = name.match(/\d+(?:\.\d+)*/);
  return match ? match[0].split(".").map(Number) : [];
}

function compareNumberSequences(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0) return a.length - b.length;
  const width = Math.max(a.length, b.length);
  for (let index = 0; index < width; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * A search hit. Only the fields needed to reconcile a stale claim: which issue
 * exists, and whether it is still open.
 */
export const JiraSearchIssueSchema = z.looseObject({
  id: z.string(),
  key: z.string(),
  fields: z
    .looseObject({
      summary: z.string().optional(),
      /**
       * Requested only by the loops that fingerprint a ticket. It is the whole
       * fingerprint: an edited description or a new comment moves it, which is how
       * "this ticket changed, look again" is expressed without diffing anything.
       */
      updated: z.string().optional(),
      status: z
        .looseObject({
          id: z.string().optional(),
          name: z.string().optional(),
          statusCategory: z
            .looseObject({ key: z.string().optional(), name: z.string().optional() })
            .optional(),
        })
        .optional(),
      /**
       * The rest are the ticket graph's doing: a root node stands in for the
       * ticket itself, so it shows what a person actually triages on — type,
       * priority, when it was raised. All optional for the same reason `updated`
       * is: a caller gets them only if it asked for them in `fields`.
       */
      created: z.string().optional(),
      labels: z.array(z.string()).optional(),
      issuetype: z.looseObject({ name: z.string().optional() }).optional(),
      priority: z.looseObject({ name: z.string().optional() }).nullable().optional(),
      assignee: z
        .looseObject({
          accountId: z.string().optional(),
          displayName: z.string().optional(),
          emailAddress: z.string().optional(),
          avatarUrls: z.record(z.string(), z.string()).optional(),
        })
        .nullable()
        .optional(),
      reporter: z
        .looseObject({
          accountId: z.string().optional(),
          displayName: z.string().optional(),
          emailAddress: z.string().optional(),
        })
        .nullable()
        .optional(),
      /**
       * Present when this issue is a subtask (or otherwise has a parent) —
       * lets the board draw the relationship between siblings without a
       * second fetch. Reduced shape, same as everywhere else Jira nests an
       * issue inside another.
       */
      parent: z.looseObject({ key: z.string() }).nullable().optional(),
    })
    .optional(),
});

export type JiraSearchIssue = z.infer<typeof JiraSearchIssueSchema>;

/**
 * One issue with everything an agent needs to attempt it.
 *
 * `description` is left as `unknown` on purpose: it is an ADF document whose node
 * vocabulary Atlassian extends freely, and validating it would fail a ticket for
 * containing a panel or a media node. `adfToText` walks whatever arrives.
 */
export const JiraIssueDetailSchema = z.looseObject({
  id: z.string(),
  key: z.string(),
  fields: z
    .looseObject({
      summary: z.string().optional(),
      description: z.unknown().optional(),
      updated: z.string().optional(),
      labels: z.array(z.string()).optional(),
      issuetype: z.looseObject({ name: z.string().optional() }).optional(),
      priority: z.looseObject({ name: z.string().optional() }).nullable().optional(),
      status: z
        .looseObject({
          name: z.string().optional(),
          statusCategory: z
            .looseObject({ key: z.string().optional(), name: z.string().optional() })
            .optional(),
        })
        .optional(),
      reporter: z
        .looseObject({
          accountId: z.string().optional(),
          displayName: z.string().optional(),
          emailAddress: z.string().optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
});

export type JiraIssueDetail = z.infer<typeof JiraIssueDetailSchema>;

/** A person on an issue, comment or attachment. The three shapes are identical. */
const JiraPersonSchema = z.looseObject({
  accountId: z.string().optional(),
  displayName: z.string().optional(),
  emailAddress: z.string().optional(),
  avatarUrls: z.record(z.string(), z.string()).optional(),
});

/** A named thing with a name — status categories, components, versions, resolutions. */
const JiraNamedSchema = z.looseObject({ id: z.string().optional(), name: z.string().optional() });

const JiraStatusSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
  statusCategory: z
    .looseObject({ key: z.string().optional(), name: z.string().optional() })
    .optional(),
});

/**
 * An issue as it appears *inside* another issue — a parent, a subtask, either end
 * of a link.
 *
 * Jira returns a genuinely reduced object here (no description, no comments,
 * whatever `fields` the caller asked for on the outer issue notwithstanding), so
 * this is its own schema rather than a recursive reference to the full one.
 */
export const JiraRelatedIssueSchema = z.looseObject({
  key: z.string(),
  fields: z
    .looseObject({
      summary: z.string().optional(),
      status: JiraStatusSchema.optional(),
      issuetype: z.looseObject({ name: z.string().optional() }).optional(),
      priority: z.looseObject({ name: z.string().optional() }).nullable().optional(),
      assignee: JiraPersonSchema.nullable().optional(),
    })
    .optional(),
});

export type JiraRelatedIssue = z.infer<typeof JiraRelatedIssueSchema>;

/**
 * One entry in `issuelinks`.
 *
 * Exactly one of `inwardIssue`/`outwardIssue` is set, and which one decides the
 * verb: the same `Blocks` link type reads "blocks" from one end and "is blocked
 * by" from the other, which is why both phrasings travel on `type`.
 */
export const JiraIssueLinkSchema = z.looseObject({
  id: z.string().optional(),
  type: z
    .looseObject({
      name: z.string().optional(),
      inward: z.string().optional(),
      outward: z.string().optional(),
    })
    .optional(),
  inwardIssue: JiraRelatedIssueSchema.optional(),
  outwardIssue: JiraRelatedIssueSchema.optional(),
});

export type JiraIssueLink = z.infer<typeof JiraIssueLinkSchema>;

/**
 * One comment. `body` is ADF and stays `unknown` for the same reason a
 * description does — see `JiraIssueDetailSchema`.
 */
export const JiraCommentSchema = z.looseObject({
  id: z.string(),
  author: JiraPersonSchema.optional(),
  updateAuthor: JiraPersonSchema.optional(),
  body: z.unknown().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  /**
   * Present when the comment is restricted to a role or group. Worth carrying:
   * an internal comment shown without saying so is a way to quote something to
   * the wrong audience.
   */
  jsdPublic: z.boolean().optional(),
  visibility: z
    .looseObject({ type: z.string().optional(), value: z.string().optional() })
    .optional(),
});

export type JiraComment = z.infer<typeof JiraCommentSchema>;

/** `GET /issue/{key}/comment` — a page, because a long-running ticket has hundreds. */
export const JiraCommentPageSchema = z.looseObject({
  comments: z.array(JiraCommentSchema).default([]),
  startAt: z.number().optional(),
  maxResults: z.number().optional(),
  total: z.number().optional(),
});

export const JiraAttachmentSchema = z.looseObject({
  id: z.string().optional(),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  created: z.string().optional(),
  author: JiraPersonSchema.optional(),
  /** The authenticated download URL. Only useful to a browser signed in to Jira. */
  content: z.string().optional(),
});

/**
 * One issue with everything the ticket panel shows: the description, who is on
 * it, its links, its subtasks and its attachments.
 *
 * Distinct from `JiraIssueDetailSchema`, which is the *agent's* view of a ticket
 * and deliberately asks for less. Keeping them apart is what stops a field added
 * for a side panel from being fetched on every reconciliation loop.
 */
export const JiraTicketDetailSchema = z.looseObject({
  id: z.string(),
  key: z.string(),
  fields: z
    .looseObject({
      summary: z.string().optional(),
      description: z.unknown().optional(),
      environment: z.unknown().optional(),
      status: JiraStatusSchema.optional(),
      issuetype: z.looseObject({ name: z.string().optional() }).optional(),
      priority: z.looseObject({ name: z.string().optional() }).nullable().optional(),
      resolution: JiraNamedSchema.nullable().optional(),
      resolutiondate: z.string().nullable().optional(),
      labels: z.array(z.string()).optional(),
      components: z.array(JiraNamedSchema).optional(),
      fixVersions: z.array(JiraNamedSchema).optional(),
      created: z.string().optional(),
      updated: z.string().optional(),
      duedate: z.string().nullable().optional(),
      reporter: JiraPersonSchema.nullable().optional(),
      assignee: JiraPersonSchema.nullable().optional(),
      parent: JiraRelatedIssueSchema.nullable().optional(),
      subtasks: z.array(JiraRelatedIssueSchema).optional(),
      issuelinks: z.array(JiraIssueLinkSchema).optional(),
      attachment: z.array(JiraAttachmentSchema).optional(),
    })
    .optional(),
});

export type JiraTicketDetail = z.infer<typeof JiraTicketDetailSchema>;

/** A Confluence page body fetched for an inline ticket-requirements preview. */
export const ConfluencePageSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  body: z.looseObject({
    atlas_doc_format: z.looseObject({
      representation: z.string().optional(),
      /** Confluence v2 returns the ADF document as a JSON string. */
      value: z.string(),
    }),
  }),
});

export type ConfluencePage = z.infer<typeof ConfluencePageSchema>;

/** Direct child pages listed below a Confluence parent page. */
export const ConfluenceChildPagesSchema = z.looseObject({
  results: z.array(
    z.looseObject({
      id: z.string(),
      title: z.string(),
    }),
  ),
});

/**
 * A workflow transition available *right now* on one issue.
 *
 * Transitions are per-project workflow edges, not global states: the same "start
 * work" step has a different id in every project, and a name someone renamed in
 * the UI stops matching. So they are always looked up per issue rather than
 * configured as an id.
 */
export const JiraTransitionSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  to: z
    .looseObject({
      id: z.string().optional(),
      name: z.string().optional(),
      statusCategory: z
        .looseObject({ key: z.string().optional(), name: z.string().optional() })
        .optional(),
    })
    .optional(),
});

export type JiraTransition = z.infer<typeof JiraTransitionSchema>;

export const JiraTransitionListSchema = z.looseObject({
  transitions: z.array(JiraTransitionSchema).default([]),
});

/**
 * `/search/jql` response.
 *
 * `total` is absent by design on the v3 endpoint — Atlassian removed the count
 * for performance — so nothing may depend on it.
 */
export const JiraSearchResultSchema = z.looseObject({
  issues: z.array(JiraSearchIssueSchema).default([]),
  nextPageToken: z.string().optional(),
});

export type JiraSearchResult = z.infer<typeof JiraSearchResultSchema>;

export const JiraBoardIssuePageSchema = z.looseObject({
  issues: z.array(JiraSearchIssueSchema).default([]),
  startAt: z.number().optional(),
  maxResults: z.number().optional(),
  total: z.number().optional(),
});

/**
 * The statusCategory key meaning "closed". Status *names* are per-task and
 * translated, so "Done" is not portable; the category key is.
 */
export const DONE_CATEGORY = "done";

/** True when a search hit is in a closed state. */
export function isResolved(issue: JiraSearchIssue): boolean {
  return issue.fields?.status?.statusCategory?.key === DONE_CATEGORY;
}
