import { z } from "zod";
import type { TaskConnectorFactory } from "../../application/gateways.ts";
import type { NotificationRepository } from "../../application/ports.ts";
import type { FetchLike } from "../../connectors/http.ts";
import {
  adfToText,
  bulletList,
  doc,
  paragraph,
  rule,
  type AdfDocument,
} from "../../connectors/jira/adf.ts";
import type { JiraComment, JiraTicketDetail } from "../../connectors/jira/types.ts";
import { ConfigError } from "../../core/errors.ts";
import { mutate } from "../../core/step.ts";
import type { Task, TaskContext, TaskResult } from "../../core/task.ts";
import { ensureAgentImage } from "../../infrastructure/agent/index.ts";
import {
  REVIEW_TICKET_PROMPT_ID,
  runReviewTicketAgent,
  type ReviewTicketContext,
} from "./agent.ts";

/**
 * Reviews one Jira ticket's requirements and asks about them in its own thread.
 *
 * The other half of what a ticket node offers: `fix-jira-issue` answers "build
 * this", and this answers "is this buildable yet". A ticket that says *Users
 * should be able to export their data* is not a ticket anybody can finish, and the
 * cheapest moment to find that out is before an agent or a developer spends an
 * afternoon guessing — so the questions go back to the reporter as a comment,
 * where the answers become part of the ticket rather than of somebody's memory.
 *
 * A queue handler with no loop in front of it, like `resolve-conflicts`: nothing
 * should comment on a backlog on a timer. One click, one ticket, one comment.
 */

const ConfigSchema = z.object({
  jira: z.object({
    issueKey: z.string().min(1),
  }),
});

type Config = z.infer<typeof ConfigSchema>;

export const REVIEW_TICKET_DESCRIPTION_TASK_ID = "review-ticket-description";

/**
 * How much of the conversation the agent is shown, newest first.
 *
 * The thread is what stops the review repeating a question somebody already
 * answered, so it cannot be dropped — but a ticket with two hundred comments is a
 * ticket whose recent comments are the ones that decided anything, and the whole
 * thread would crowd out the description it is meant to be read against.
 */
const MAX_COMMENTS = 20;

/** Per comment. A comment longer than this is a document somebody pasted. */
const MAX_COMMENT_CHARS = 1_500;

export interface ReviewTicketDeps {
  fetch?: FetchLike;
  connectors?: TaskConnectorFactory;
  notifications?: NotificationRepository;
  ensureImage?: typeof ensureAgentImage;
  runAgent?: typeof runReviewTicketAgent;
}

export function createReviewTicketTask(deps: ReviewTicketDeps = {}): Task<Config> {
  return {
    id: REVIEW_TICKET_DESCRIPTION_TASK_ID,
    name: "Review a Jira description",
    description:
      "Reads one Jira ticket and posts a comment asking about the requirements that are missing, untestable or contradictory. Writes nothing but that comment — no repository is involved. Queued from a ticket node on the graph rather than run directly.",
    kind: "job",
    agent: true,
    paramsSchema: ConfigSchema,
    run: (ctx, config) => run(ctx, config, deps),
  };
}

async function run(ctx: TaskContext, config: Config, deps: ReviewTicketDeps): Promise<TaskResult> {
  const jira = requireConnectorFactory(deps).jira(ctx, deps.fetch);
  const issueKey = config.jira.issueKey;

  // `ticketDetail` rather than `issueDetail`: the panel's fuller read, because who
  // reported it, who it is assigned to and which components it names are all things
  // a question is addressed to — the agent's usual view has none of them.
  const issue = await ctx.step("issue", () =>
    jira.ticketDetail(issueKey, { ...(ctx.signal ? { signal: ctx.signal } : {}) }),
  );
  if (!issue) {
    throw new ConfigError(`${issueKey} does not exist, or is not visible to this Jira token.`);
  }

  // Allowed to fail: a thread that could not be read makes the review worse — it
  // may ask something a comment already settled — but a ticket with a readable
  // description is still worth reviewing, and failing the run would report "the
  // review broke" for what is really a partial answer.
  const comments = await ctx.step("comments", async () => {
    try {
      const page = await jira.comments(issueKey, {
        limit: MAX_COMMENTS,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return page.comments;
    } catch (err) {
      ctx.logger.warn(
        { issue: issueKey, err },
        `could not read ${issueKey}'s comments; reviewing the description alone`,
      );
      return [] as JiraComment[];
    }
  });

  const ticket = ticketContext(issue, comments, jira.issueUrl(issueKey));

  if (ctx.dryRun) {
    ctx.logger.info(
      { issue: issueKey, comments: ticket.comments.length },
      `[dry-run] would review ${issueKey}'s requirements and comment with any questions`,
    );
    return { itemsSeen: 1, itemsProcessed: 0, itemsSkipped: 1, details: { issueKey } };
  }

  await ctx.step("ensure-agent-image", () => (deps.ensureImage ?? ensureAgentImage)(ctx.logger));

  const review = await ctx.step("review-description", () =>
    (deps.runAgent ?? runReviewTicketAgent)({
      executionId: ctx.executionId,
      ticket,
      ...(ctx.llm.model ? { model: ctx.llm.model } : {}),
      ...(ctx.llm.effort ? { effort: ctx.llm.effort } : {}),
      promptTemplate: ctx.prompts[REVIEW_TICKET_PROMPT_ID],
      signal: ctx.signal,
      logger: ctx.logger,
      ...(ctx.actor ? { actor: ctx.actor } : {}),
    }),
  );

  // `verdict` is advisory; the questions decide. An agent that answers
  // "questions" and lists none has nothing to post, and a comment saying so
  // would be noise in somebody's ticket.
  if (review.questions.length === 0) {
    ctx.logger.info(
      { issue: issueKey, verdict: review.verdict, summary: review.summary },
      `${issueKey}: nothing to ask — ${review.summary}`,
    );
    return {
      itemsSeen: 1,
      itemsProcessed: 1,
      itemsSkipped: 0,
      details: {
        issueKey,
        action: "no-questions",
        verdict: review.verdict,
        summary: review.summary,
      },
    };
  }

  const posted = await mutate(
    ctx,
    `comment on ${issueKey} with ${review.questions.length} question(s) about its requirements`,
    async () => {
      await jira.addComment(
        issueKey,
        buildReviewComment(review.summary, review.questions, ctx.actor?.name),
        ctx.signal,
      );
      return true;
    },
    { issue: issueKey, questions: review.questions.length },
  );
  if (!posted) throw new ConfigError("the review comment was unexpectedly suppressed");

  ctx.logger.info(
    { issue: issueKey, questions: review.questions.length },
    `asked ${review.questions.length} question(s) on ${issueKey}`,
  );

  deps.notifications?.create({
    kind: REVIEW_TICKET_DESCRIPTION_TASK_ID,
    title: `${review.questions.length} question(s) on ${issueKey}`,
    body: review.summary,
    link: ticket.url,
    taskRunId: ctx.executionId,
  });

  return {
    itemsSeen: 1,
    itemsProcessed: 1,
    itemsSkipped: 0,
    details: {
      issueKey,
      action: "commented",
      verdict: review.verdict,
      summary: review.summary,
      questions: review.questions,
    },
  };
}

/**
 * The comment itself.
 *
 * Signed, and signed with the developer who asked rather than only with talos:
 * it is posted under their Jira credentials, so the reporter sees their name on it
 * either way and hiding whose click it was would be the dishonest option. The
 * questions are a bullet list because that is what gets answered — a paragraph of
 * prose containing six questions gets one reply about the first.
 */
function buildReviewComment(
  summary: string,
  questions: readonly string[],
  requestedBy?: string,
): AdfDocument {
  return doc(
    paragraph(summary.trim()),
    paragraph(
      questions.length === 1
        ? "One thing needs deciding before this can be built:"
        : "These need deciding before this can be built:",
    ),
    bulletList(questions.map((question) => question.trim())),
    rule(),
    paragraph(
      `Requirements review by Talos${requestedBy ? `, requested by ${requestedBy}` : ""}. ` +
        "It read this ticket and its comments only — no code — so treat the questions as a " +
        "reader's, and correct it where it has misread you.",
    ),
  );
}

/** What the agent is shown about the ticket. */
function ticketContext(
  issue: JiraTicketDetail,
  comments: readonly JiraComment[],
  url: string,
): ReviewTicketContext {
  const fields = issue.fields;
  return {
    key: issue.key,
    summary: fields?.summary ?? issue.key,
    description: adfToText(fields?.description),
    ...(fields?.issuetype?.name ? { issueType: fields.issuetype.name } : {}),
    ...(fields?.priority?.name ? { priority: fields.priority.name } : {}),
    ...(fields?.status?.name ? { status: fields.status.name } : {}),
    labels: fields?.labels ?? [],
    components: (fields?.components ?? [])
      .map((component) => component.name)
      .filter((name): name is string => Boolean(name)),
    ...(fields?.reporter?.displayName ? { reporter: fields.reporter.displayName } : {}),
    ...(fields?.assignee?.displayName ? { assignee: fields.assignee.displayName } : {}),
    comments: comments.slice(0, MAX_COMMENTS).map((comment) => ({
      ...(comment.author?.displayName ? { author: comment.author.displayName } : {}),
      ...(comment.created ? { createdAt: comment.created } : {}),
      body: cap(adfToText(comment.body), MAX_COMMENT_CHARS),
    })),
    url,
  };
}

function cap(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n… truncated.`;
}

function requireConnectorFactory(deps: ReviewTicketDeps): TaskConnectorFactory {
  if (!deps.connectors) {
    throw new ConfigError(
      `${REVIEW_TICKET_DESCRIPTION_TASK_ID} requires connector gateways; the composition root must provide them.`,
    );
  }
  return deps.connectors;
}
