/**
 * "Create a Jira ticket for this LogRocket issue, then fix it."
 *
 * The one action the LogRocket page offers, and the reason the page exists: a
 * frontend error LogRocket noticed becomes a ticket, and the ticket becomes a
 * merge request through the same path a ticket clicked in the graph takes — see
 * `ticket-actions.ts`. Nothing here is new machinery; it is the two halves
 * joined by a description built from the alert.
 *
 * Order matters. The ticket is only filed once the fix is known to be startable,
 * because a refused fix after a successful create would leave a Jira ticket
 * nobody asked for and no way to tell it apart from a real one. And an issue that
 * already carries a ticket key files no second ticket — a re-alerting issue
 * clicked twice should queue another attempt at the same ticket, not litter the
 * project.
 */
import type * as ApiContract from "../../shared/api-contract.ts";
import type { App } from "../app.ts";
import type { LogRocketIssue } from "../application/ports.ts";
import type { AuthUser } from "../auth.ts";
import {
  bulletList,
  doc,
  heading,
  linkParagraph,
  paragraph,
  rule,
} from "../connectors/jira/adf.ts";
import { ConfigError } from "../core/errors.ts";
import { enqueueTicketAction, ticketActionRefusal } from "./ticket-actions.ts";
import { enqueueRegressionTest } from "./regression-test-actions.ts";

/** What a ticket filed from an alert is typed as when nothing else is configured. */
const DEFAULT_ISSUE_TYPE = "Bug";

/** Marks tickets this path filed, so they are findable as a set in Jira. */
const LABEL = "logrocket";

export interface LogRocketFixOutcome {
  queued: boolean;
  message: string;
  jobId?: string;
  jiraIssueKey?: string;
  /** The row as it now stands, so the page can update without a refetch. */
  issue: LogRocketIssue;
}

/**
 * Why this issue cannot be turned into a fix, or null if it can.
 *
 * Both the button's hint and the server's own check: this ends in a container
 * pushing a branch, so a disabled button must not be the only thing between a
 * hand-written POST and a commit.
 */
export function logRocketFixRefusal(app: App, user: AuthUser): string | null {
  if (!jiraProject(app)) {
    return "Set a Jira project key in Settings → Integrations → LogRocket first.";
  }
  return ticketActionRefusal(app, user, "fix-issue");
}

/** The project alerts are filed into. Empty until an operator sets it. */
export function jiraProject(app: App): string | undefined {
  return app.secrets.get("LOGROCKET_JIRA_PROJECT")?.trim() || undefined;
}

export async function fixLogRocketIssue(
  app: App,
  user: AuthUser,
  issueId: string,
): Promise<LogRocketFixOutcome> {
  const issue = app.logRocketIssues.get(issueId);
  if (!issue) throw new ConfigError(`No LogRocket issue ${issueId}.`);

  const refusal = logRocketFixRefusal(app, user);
  if (refusal) return { queued: false, message: refusal, issue };

  let filed = issue;
  if (!filed.jiraIssueKey) {
    const project = jiraProject(app)!;
    const issueType =
      app.secrets.get("LOGROCKET_JIRA_ISSUE_TYPE")?.trim() || DEFAULT_ISSUE_TYPE;
    // The shared Jira account, not the clicking developer's: filing is an
    // instance-level act here (the project comes from instance settings, and the
    // alert was addressed to the install rather than to a person). The fix that
    // follows still runs as them, so the branch and the merge request are theirs.
    const jira = app.sharedJira();
    const created = await jira.createIssue({
      projectKey: project,
      summary: summaryFor(issue),
      description: descriptionFor(issue),
      issueType,
      labels: [LABEL],
    });
    app.logger.info(
      { issue: issue.id, jira: created.key },
      `filed ${created.key} for LogRocket issue "${issue.title}"`,
    );
    filed = app.logRocketIssues.link(issue.id, created.key) ?? filed;
  }

  const key = filed.jiraIssueKey!;
  const result = enqueueTicketAction(app, user, "fix-issue", key);
  return {
    queued: result.queued,
    // The ticket exists either way, and that is the half a person most needs to
    // hear about — a refused enqueue with the key unmentioned reads as "nothing
    // happened" when in fact a ticket was filed.
    message: `${key}: ${result.message}`,
    ...(result.jobId ? { jobId: result.jobId } : {}),
    jiraIssueKey: key,
    issue: filed,
  };
}

/**
 * Queues a regression test for one LogRocket issue.
 *
 * A thin wrapper, unlike the Datadog one, because a LogRocket row *is* the unit —
 * there is no problem grouping to resolve a member out of. What it does buy is the
 * 404: an id that names nothing is a client bug, and should say so rather than
 * queueing a job that will find nothing when it runs.
 *
 * Expect `not-reachable` more often here than from Datadog. A LogRocket row has no
 * stack trace and no file path, so the agent is working from a title and a
 * description. That is a reason to let it answer honestly, not a reason to hide
 * the button.
 */
export function writeLogRocketRegressionTest(
  app: App,
  user: AuthUser,
  issueId: string,
): ApiContract.RegressionTestResult {
  const issue = app.logRocketIssues.get(issueId);
  if (!issue) throw new ConfigError(`No LogRocket issue ${issueId}.`);
  return enqueueRegressionTest(app, user, "logrocket", issue.id, issue.label ?? issue.title);
}

/** `[LogRocket] TypeError: …` — the prefix is what makes the queue scannable. */
function summaryFor(issue: LogRocketIssue): string {
  const what = issue.label ?? issue.title;
  return `[LogRocket] ${issue.issueType ? `${issue.issueType}: ` : ""}${what}`;
}

/**
 * The ticket body: what LogRocket said, and a link back to the recording.
 *
 * Written for the agent as much as for a person — this description is the entire
 * brief `fix-jira-issue` works from, so the error text and LogRocket's own
 * summary belong in it verbatim rather than paraphrased into a sentence.
 */
function descriptionFor(issue: LogRocketIssue): ReturnType<typeof doc> {
  const facts: string[] = [];
  if (issue.issueType) facts.push(`Type: ${issue.issueType}`);
  if (issue.sessionCount != null) facts.push(`Affected sessions: ${issue.sessionCount}`);
  if (issue.sessionRate != null) facts.push(`Rate: ${issue.sessionRate}/min`);
  if (issue.firstSeenAt) facts.push(`First seen: ${issue.firstSeenAt.toISOString()}`);
  facts.push(`Alerts received: ${issue.alertCount}`);

  return doc(
    paragraph("Filed automatically from a LogRocket issue alert."),
    issue.label ? heading("Error", 3) : null,
    issue.label ? paragraph(issue.label) : null,
    issue.description ? heading("Details", 3) : null,
    issue.description ? paragraph(issue.description) : null,
    issue.summary ? heading("LogRocket summary", 3) : null,
    issue.summary ? paragraph(issue.summary) : null,
    issue.userImpact ? heading("User impact", 3) : null,
    issue.userImpact ? paragraph(issue.userImpact) : null,
    heading("Signal", 3),
    bulletList(facts),
    issue.url ? linkParagraph("Open in LogRocket", issue.url) : null,
    issue.screenshotUrl ? linkParagraph("Screenshot", issue.screenshotUrl) : null,
    rule(),
    paragraph(`talos LogRocket issue ${issue.id}`),
  );
}

/** The API shape, so the router does no mapping of its own. */
export function toLogRocketFixResult(
  outcome: LogRocketFixOutcome,
): ApiContract.LogRocketFixResult {
  return {
    queued: outcome.queued,
    message: outcome.message,
    ...(outcome.jobId ? { jobId: outcome.jobId } : {}),
    ...(outcome.jiraIssueKey ? { jiraIssueKey: outcome.jiraIssueKey } : {}),
  };
}
