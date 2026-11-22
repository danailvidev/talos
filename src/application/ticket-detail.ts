/**
 * One Jira ticket in full, for the panel that opens when you click it.
 *
 * The sibling of `assigned-tickets.ts` and split from it for the same reason
 * `cachedPullRequestDetail` is split from `cachedPullRequestListing`: the list is
 * one bulk search that answers "what is on my plate", and this is a per-ticket read
 * that answers "what is this ticket about". Merging them would mean either a Jira
 * call per cluster on every three-second poll, or a panel that can only ever show
 * what a search hit happens to carry — which is the situation this replaces. The
 * point of the feature is not going to Jira, so what arrives here is the whole
 * ticket: description, conversation, links, subtasks, attachments.
 *
 * Read with the asking developer's own credentials, exactly like the list — see
 * that file's header for why that is not negotiable.
 */
import type * as ApiContract from "../../shared/api-contract.ts";
import {
  adfMediaFilenames,
  adfSmartLinkUrls,
  adfToMarkdown,
} from "../connectors/jira/adf.ts";
import {
  createJiraClient,
  isJiraError,
  JiraClient,
  missingJiraSecrets,
} from "../connectors/jira/client.ts";
import type {
  JiraComment,
  JiraIssueLink,
  JiraRelatedIssue,
  JiraTicketDetail,
} from "../connectors/jira/types.ts";
import type { Actor } from "../core/actor.ts";
import { ConfigError } from "../core/errors.ts";
import type { Logger } from "../logging/logger.ts";
import type { SecretStore } from "../secrets/secret-store.ts";
import { toTicketSprint } from "./assigned-tickets.ts";

export type TicketDetail = ApiContract.TicketDetailView;
export type TicketDetailResult = ApiContract.TicketDetailResponse;

/** A ticket description should never fan out into an unbounded Confluence crawl. */
const MAX_CONFLUENCE_PREVIEWS = 3;

export interface TicketDetailServiceDeps {
  /** The asking developer's own Jira identity plus shared site configuration. */
  secretsFor(actor: Actor): SecretStore;
  logger: Logger;
}

export class TicketDetailService {
  constructor(private readonly deps: TicketDetailServiceDeps) {}

  async get(
    actor: Actor,
    issueKey: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TicketDetailResult> {
    const secrets = this.deps.secretsFor(actor);
    const missing = missingJiraSecrets(secrets);
    if (missing.length > 0) {
      return {
        ticket: null,
        warning:
          `Jira is not configured for you (${missing.join(", ")}), so this ticket can ` +
          "only show what the graph already knew about it.",
      };
    }

    const jira = createJiraClient(secrets);
    try {
      const ticket = await this.read(jira, issueKey, options.signal);
      if (!ticket) {
        // A 404 here is nearly always permission rather than deletion: Jira answers
        // 404 for an issue that exists in a project the token cannot browse, so
        // "gone" would be the wrong word to put in front of a developer who can see
        // the ticket perfectly well in their browser.
        return {
          ticket: null,
          warning: `Jira has no ${issueKey} it will show you — it may have been moved, or be in a project your token cannot read.`,
        };
      }
      return { ticket };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(
        { actor: actor.email, issueKey, jira: isJiraError(err) ? "api" : "unknown", err: message },
        "could not read a Jira ticket for the ticket panel",
      );
      return { ticket: null, warning: `Jira did not answer: ${message}` };
    }
  }

  /** A temporary Atlassian Media URL for an attachment the route already authorized. */
  async attachmentUrl(
    actor: Actor,
    attachmentId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const secrets = this.deps.secretsFor(actor);
    const missing = missingJiraSecrets(secrets);
    if (missing.length > 0) {
      throw new ConfigError(`Jira is not configured for you (${missing.join(", ")}).`);
    }
    return createJiraClient(secrets).attachmentDownloadUrl(
      attachmentId,
      options.signal,
    );
  }

  /** A bounded text attachment body for the route that already authorized it. */
  async attachmentText(
    actor: Actor,
    attachmentId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ text: string; truncated: boolean }> {
    const secrets = this.deps.secretsFor(actor);
    const missing = missingJiraSecrets(secrets);
    if (missing.length > 0) {
      throw new ConfigError(`Jira is not configured for you (${missing.join(", ")}).`);
    }
    return createJiraClient(secrets).attachmentText(attachmentId, options.signal);
  }

  /**
   * Moves a ticket to the named status — what dragging its card to a different
   * board column does.
   *
   * Read with the asking developer's own credentials, same as `get`: a
   * transition is a write against their Jira account, not the install's.
   */
  async setStatus(
    actor: Actor,
    issueKey: string,
    status: string,
    statusIds: readonly string[] = [],
    options: { signal?: AbortSignal } = {},
  ): Promise<ApiContract.TicketStatusChangeResult> {
    const secrets = this.deps.secretsFor(actor);
    const missing = missingJiraSecrets(secrets);
    if (missing.length > 0) {
      return { ok: false, message: `Jira is not configured for you (${missing.join(", ")}).` };
    }

    const jira = createJiraClient(secrets);
    try {
      await jira.transitionIssueToColumn(
        issueKey,
        { name: status, statusIds },
        options.signal,
      );
      return { ok: true, message: `Moved ${issueKey} to ${status}.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(
        { actor: actor.email, issueKey, status, jira: isJiraError(err) ? "api" : "unknown", err: message },
        "could not move a Jira ticket to a new status",
      );
      return { ok: false, message };
    }
  }

  /**
   * The issue and its comments, in parallel, followed by its parent when needed.
   *
   * The comments are their own request (see `JiraClient.comments`) and a failing one
   * must not lose the description: a ticket whose conversation could not be read is
   * still worth showing, so that half degrades to an empty thread rather than to no
   * ticket at all. The issue read itself is allowed to throw — with no issue there
   * is nothing to render around it. A child with no description gets one small
   * follow-up read for its parent's requirements; it remains a distinct field in
   * the response so the panel can name where that text came from.
   *
   * The sprint field id has to be resolved before the issue read, because the field
   * must be *named* in it and its id differs per site. It is looked up first rather
   * than in parallel for that reason, and it is nearly free: `/field` is cached on
   * the client, and this whole read is behind a 20s response cache.
   */
  private async read(
    jira: JiraClient,
    issueKey: string,
    signal?: AbortSignal,
  ): Promise<TicketDetail | null> {
    const sprintField = await this.sprintField(jira, issueKey, signal);
    const [issue, comments] = await Promise.all([
      jira.ticketDetail(issueKey, {
        ...(signal ? { signal } : {}),
        ...(sprintField ? { extraFields: [sprintField] } : {}),
      }),
      jira.comments(issueKey, { ...(signal ? { signal } : {}) }).catch((err: unknown) => {
        this.deps.logger.debug(
          { issueKey, err: err instanceof Error ? err.message : String(err) },
          "could not read a Jira ticket's comments; the panel will show none",
        );
        return { comments: [] as JiraComment[] };
      }),
    ]);
    if (!issue) return null;
    let ticket = toTicketDetail(issue, comments, sprintField, (key) => jira.issueUrl(key));
    let descriptionAdf = issue.fields?.description;
    const parentKey = issue.fields?.parent?.key;
    if (!ticket.description && parentKey) {
      try {
        const parent = await jira.issueDetail(parentKey, signal);
        const parentDescription = text(parent?.fields?.description);
        if (parentDescription) {
          ticket = { ...ticket, parentDescription };
          descriptionAdf = parent?.fields?.description;
        }
      } catch (err) {
        this.deps.logger.debug(
          {
            issueKey,
            parentKey,
            err: err instanceof Error ? err.message : String(err),
          },
          "could not read a descriptionless Jira ticket's parent; the panel will show no inherited requirements",
        );
      }
    }

    const confluencePreviews = await this.confluencePreviews(
      jira,
      issueKey,
      descriptionAdf,
      signal,
    );
    return confluencePreviews.length > 0 ? { ...ticket, confluencePreviews } : ticket;
  }

  private async confluencePreviews(
    jira: JiraClient,
    issueKey: string,
    descriptionAdf: unknown,
    signal?: AbortSignal,
  ): Promise<ApiContract.ConfluencePreviewView[]> {
    const urls = adfSmartLinkUrls(descriptionAdf).slice(0, MAX_CONFLUENCE_PREVIEWS);
    const previews = await Promise.all(
      urls.map(async (url): Promise<ApiContract.ConfluencePreviewView | undefined> => {
        try {
          const page = await jira.confluencePage(url, signal);
          if (!page) return undefined;
          return {
            url,
            pageId: page.id,
            title: page.title,
            body: text(page.body),
          };
        } catch (err) {
          this.deps.logger.debug(
            {
              issueKey,
              url,
              err: err instanceof Error ? err.message : String(err),
            },
            "could not resolve a Confluence Smart Link; the panel will keep its external-link card",
          );
          return undefined;
        }
      }),
    );
    return previews.filter(
      (preview): preview is ApiContract.ConfluencePreviewView => preview != null,
    );
  }

  /**
   * The sprint custom field's id, or undefined when this site has no sprints.
   *
   * Swallowed rather than propagated, for the same reason as in
   * `AssignedTicketService.sprintField`: a site without Jira Software has no sprint
   * field, and a ticket shown without its sprint beats no ticket at all.
   */
  private async sprintField(
    jira: JiraClient,
    issueKey: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      return await jira.findSprintFieldId(signal);
    } catch (err) {
      this.deps.logger.debug(
        { issueKey, err: err instanceof Error ? err.message : String(err) },
        "could not resolve the Jira sprint field; the ticket panel will show no sprint",
      );
      return undefined;
    }
  }
}

function toTicketDetail(
  issue: JiraTicketDetail,
  comments: { comments: JiraComment[]; total?: number },
  sprintField: string | undefined,
  urlFor: (key: string) => string,
): TicketDetail {
  const fields = issue.fields;
  const description = text(fields?.description);
  const inlineAttachments = new Set([
    ...adfMediaFilenames(fields?.description),
    ...comments.comments.flatMap((comment) => adfMediaFilenames(comment.body)),
  ]);
  const environment = text(fields?.environment);
  // The cast is the price of a field whose key came from `/field` — see
  // `toTicketSprint`, which validates whatever is behind it.
  const sprint =
    fields && sprintField
      ? toTicketSprint((fields as Record<string, unknown>)[sprintField])
      : undefined;

  return {
    key: issue.key,
    url: urlFor(issue.key),
    ...(fields?.summary ? { summary: fields.summary } : {}),
    ...(description ? { description } : {}),
    ...(environment ? { environment } : {}),
    ...(fields?.status?.name ? { status: fields.status.name } : {}),
    ...(fields?.status?.statusCategory?.key
      ? { statusCategory: fields.status.statusCategory.key }
      : {}),
    ...(fields?.issuetype?.name ? { type: fields.issuetype.name } : {}),
    ...(fields?.priority?.name ? { priority: fields.priority.name } : {}),
    ...(fields?.resolution?.name ? { resolution: fields.resolution.name } : {}),
    labels: fields?.labels ?? [],
    components: named(fields?.components),
    fixVersions: named(fields?.fixVersions),
    ...(person(fields?.assignee) ? { assignee: person(fields?.assignee)! } : {}),
    ...(person(fields?.reporter) ? { reporter: person(fields?.reporter)! } : {}),
    ...(fields?.created ? { createdAt: fields.created } : {}),
    ...(fields?.updated ? { updatedAt: fields.updated } : {}),
    ...(fields?.duedate ? { dueAt: fields.duedate } : {}),
    ...(fields?.resolutiondate ? { resolvedAt: fields.resolutiondate } : {}),
    ...(sprint ? { sprint } : {}),
    ...(fields?.parent
      ? { parent: toRelation(fields.parent, "parent", urlFor) }
      : {}),
    subtasks: (fields?.subtasks ?? []).map((subtask) =>
      toRelation(subtask, "subtask", urlFor),
    ),
    links: toLinks(fields?.issuelinks, urlFor),
    attachments: (fields?.attachment ?? []).map((attachment) => ({
      ...(attachment.id ? { id: attachment.id } : {}),
      filename: attachment.filename ?? "attachment",
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(attachment.filename && inlineAttachments.has(attachment.filename)
        ? { inline: true }
        : {}),
      ...(attachment.size != null ? { size: attachment.size } : {}),
      ...(attachment.created ? { createdAt: attachment.created } : {}),
      ...(attachment.author?.displayName ? { author: attachment.author.displayName } : {}),
      ...(attachment.content ? { url: attachment.content } : {}),
    })),
    comments: comments.comments.map(toComment),
    ...(comments.total != null ? { commentCount: comments.total } : {}),
  };
}

/**
 * Each end of each link, phrased from this ticket's side.
 *
 * Jira reports one entry per link with exactly one of `inwardIssue`/`outwardIssue`
 * populated: the *other* end. Which one is set is also what picks the verb — the
 * same `Blocks` type reads `blocks` towards its outward issue and `is blocked by`
 * towards its inward one — so reading `type.name` here instead would label both
 * directions "Blocks" and invert half of them.
 */
function toLinks(
  links: readonly JiraIssueLink[] | undefined,
  urlFor: (key: string) => string,
): ApiContract.TicketRelationView[] {
  const out: ApiContract.TicketRelationView[] = [];
  for (const link of links ?? []) {
    const other = link.outwardIssue ?? link.inwardIssue;
    if (!other) continue;
    const relation =
      (link.outwardIssue ? link.type?.outward : link.type?.inward) ??
      link.type?.name ??
      "relates to";
    out.push(toRelation(other, relation, urlFor));
  }
  return out;
}

function toRelation(
  issue: JiraRelatedIssue,
  relation: string,
  urlFor: (key: string) => string,
): ApiContract.TicketRelationView {
  const fields = issue.fields;
  return {
    key: issue.key,
    url: urlFor(issue.key),
    ...(fields?.summary ? { summary: fields.summary } : {}),
    ...(fields?.status?.name ? { status: fields.status.name } : {}),
    ...(fields?.status?.statusCategory?.key
      ? { statusCategory: fields.status.statusCategory.key }
      : {}),
    ...(fields?.issuetype?.name ? { type: fields.issuetype.name } : {}),
    relation,
    ...(fields?.assignee?.displayName ? { assignee: fields.assignee.displayName } : {}),
  };
}

function toComment(comment: JiraComment): ApiContract.TicketCommentView {
  const author = person(comment.author);
  // Jira sets `updated` to `created` on an untouched comment, so "edited" has to be
  // a real difference rather than the field's mere presence.
  const edited =
    comment.updated != null && comment.created != null && comment.updated !== comment.created;
  return {
    id: comment.id,
    ...(author ? { author } : {}),
    body: text(comment.body),
    ...(comment.created ? { createdAt: comment.created } : {}),
    ...(edited ? { updatedAt: comment.updated! } : {}),
    ...(comment.visibility?.value
      ? { restrictedTo: comment.visibility.value }
      : comment.jsdPublic === false
        ? { restrictedTo: "internal" }
        : {}),
  };
}

function person(
  raw: { displayName?: string; emailAddress?: string; avatarUrls?: Record<string, string> } | null
    | undefined,
): ApiContract.TicketPersonView | undefined {
  if (!raw?.displayName) return undefined;
  // Jira keys avatars by pixel size. 24 is the one the panel draws; the others are
  // tried so a site that serves an unusual set still gets a face rather than initials.
  const avatarUrl =
    raw.avatarUrls?.["24x24"] ?? raw.avatarUrls?.["32x32"] ?? raw.avatarUrls?.["48x48"];
  return {
    name: raw.displayName,
    ...(raw.emailAddress ? { email: raw.emailAddress } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

function named(values: readonly { name?: string }[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.name)
    .filter((name): name is string => Boolean(name));
}

function text(value: unknown): string {
  return adfToMarkdown(value);
}
