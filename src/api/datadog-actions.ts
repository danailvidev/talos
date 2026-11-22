/**
 * What the Datadog page can do to an issue: file it and fix it, or run a scan.
 *
 * Shaped after `logrocket-actions.ts` and joined to the same machinery on
 * purpose — a Datadog issue becomes a Jira ticket, and the ticket becomes a merge
 * request through exactly the path a ticket clicked in the graph takes. There is
 * no second agent, no second queue and no Datadog-specific notion of "fixing".
 *
 * Two rules carry over from LogRocket because they were right there. The ticket is
 * only filed once the fix is known to be startable, so a refused fix cannot leave
 * an orphan ticket nobody asked for; and an issue that already carries a ticket
 * key files no second one, so clicking twice queues another attempt at the same
 * ticket instead of littering the project.
 *
 * One rule is new, and it is the reason this file is not a copy: a Datadog issue's
 * counts are estimates over a sampled window, so the ticket says so. An agent
 * handed "1,709,618 occurrences" as a fact will reason about a number we made up.
 */
import type * as ApiContract from "../../shared/api-contract.ts";
import type { App } from "../app.ts";
import type { DatadogIssue } from "../application/ports.ts";
import {
  defaultDatadogServiceTarget,
  datadogTicketDescription,
  datadogTicketLabels,
  datadogTicketSummary,
} from "../application/datadog-ticket.ts";
import {
  resolveDatadogJiraTarget,
  type DatadogJiraTicketConfig,
} from "../application/datadog-ticketing.ts";
import type { AuthUser } from "../auth.ts";
import { datadogSite, logExplorerUrl } from "../connectors/datadog/client.ts";
import { ConfigError } from "../core/errors.ts";
import {
  DATADOG_SCAN_TASK_ID,
  DatadogScanParamsSchema,
} from "../tasks/datadog-scan/index.ts";
import { WRITE_REGRESSION_TEST_TASK_ID } from "../tasks/write-regression-test/index.ts";
import { TRIAGE_DATADOG_ERROR_TASK_ID } from "../tasks/triage-datadog-error/index.ts";
import { enqueueTicketAction, ticketActionRefusal } from "./ticket-actions.ts";
import { enqueueRegressionTest } from "./regression-test-actions.ts";

export {
  DATADOG_SERVICE_PROJECT_PREFIX,
  DATADOG_SERVICE_TARGET_BRANCH,
  datadogServiceProjectPrefix,
  defaultDatadogServiceTarget,
} from "../application/datadog-ticket.ts";

export interface DatadogFixOutcome {
  queued: boolean;
  message: string;
  jobId?: string;
  jiraIssueKey?: string;
}

/**
 * Why this problem cannot be turned into a fix, or null if it can.
 *
 * Both the button's hint and the server's own check: this ends in a container
 * pushing a branch, so a disabled button must not be the only thing between a
 * hand-written POST and a commit.
 */
export function datadogFixRefusal(app: App, user: AuthUser): string | null {
  if (!jiraProject(app)) {
    return "Set a Jira project key in Settings → Integrations → Datadog first.";
  }
  return ticketActionRefusal(app, user, "fix-issue");
}

/** The default project issues are filed into. Empty until an operator sets one. */
export function jiraProject(app: App): string | undefined {
  return (
    datadogJiraConfig(app)?.project ??
    app.secrets.get("DATADOG_JIRA_PROJECT")?.trim() ??
    undefined
  );
}

function datadogJiraConfig(app: App): DatadogJiraTicketConfig | undefined {
  const params = app.scheduledTask(datadogScanTaskId(app))?.params;
  const parsed = DatadogScanParamsSchema.safeParse(params ?? {});
  return parsed.success ? parsed.data.jira : undefined;
}

/**
 * The project this particular issue is filed into.
 *
 * A routing rule may name one per team, which is the point of having teams at all:
 * a frontend crash and a payments outage do not belong in the same backlog. The
 * rule is re-matched here rather than stored on the row, so moving a team's
 * project takes effect on the next click instead of after the next scan.
 */
export function jiraProjectFor(app: App, issue: DatadogIssue): string | undefined {
  if (issue.team) {
    const rule = app.datadogRouting
      .list()
      .find((r) => r.action === "route" && r.team === issue.team && r.jiraProject);
    if (rule?.jiraProject) return rule.jiraProject;
  }
  return jiraProject(app);
}

/**
 * Every signature belonging to a problem, loudest first.
 *
 * Two key shapes reach here, because the page has two kinds of row. A real
 * `problemKey` written by a scan, and `issue:<id>` for a row that predates problem
 * grouping and is therefore its own problem of one — see `toDatadogServiceViews`.
 */
function membersOf(app: App, problemKey: string): DatadogIssue[] {
  if (problemKey.startsWith("issue:")) {
    const issue = app.datadogIssues.get(problemKey.slice("issue:".length));
    return issue ? [issue] : [];
  }
  return app.datadogIssues.listByProblem(problemKey);
}

/**
 * Files one ticket for a root cause and queues the fix.
 *
 * Deliberately at the problem level rather than per signature. One failure writes
 * several log lines, and filing a ticket per line would put five tickets in the
 * backlog for one bug, five agents on the same code, and five merge requests
 * conflicting with each other. So the ticket describes the whole problem — every
 * member signature is in the body, because "the exception, the frame that threw it
 * and the client that saw it" is most of the diagnosis — and the Jira key is written
 * to every member, which is what makes the link survive a rescan that regroups them.
 */
export async function fixDatadogProblem(
  app: App,
  user: AuthUser,
  problemKey: string,
): Promise<DatadogFixOutcome> {
  const members = membersOf(app, problemKey);
  if (members.length === 0) throw new ConfigError(`No Datadog problem ${problemKey}.`);

  const refusal = datadogFixRefusal(app, user);
  if (refusal) return { queued: false, message: refusal };

  const primary = members[0]!;
  const existing = members.find((issue) => issue.jiraIssueKey)?.jiraIssueKey;

  let key = existing;
  if (!key) {
    const project = jiraProjectFor(app, primary)!;
    // The shared Jira account rather than the clicking developer's, as with
    // LogRocket: the project comes from instance settings and the issue was found
    // by the install's own scan, so filing is an instance-level act. The fix that
    // follows still runs as them, so the branch and the merge request are theirs.
    const jira = app.sharedJira();
    const configured = datadogJiraConfig(app);
    const target = await resolveDatadogJiraTarget(
      { secrets: app.secrets, logger: app.logger },
      jira,
      project,
      configured,
    );
    const created = await jira.createIssue({
      projectKey: project,
      summary: datadogTicketSummary(primary),
      description: datadogTicketDescription(primary, members, explorerUrl(app, primary)),
      issueType: target.issueType,
      labels: datadogTicketLabels(
        primary,
        members.map((member) => member.fingerprint),
        target.labels,
      ),
      ...(target.assigneeAccountId
        ? { assigneeAccountId: target.assigneeAccountId }
        : {}),
      ...(target.sprintId != null ? { sprintId: target.sprintId } : {}),
      ...(Object.keys(target.extraFields).length > 0
        ? { extraFields: target.extraFields }
        : {}),
    });
    app.logger.info(
      {
        problem: problemKey,
        jira: created.key,
        service: primary.service,
        signatures: members.length,
      },
      `filed ${created.key} for Datadog problem "${primary.problemTitle ?? primary.title}"`,
    );
    key = created.key;
    // Linked across the whole problem, not just the primary: the next scan may pick
    // a different member as loudest, and the ticket has to still be found.
    for (const member of members) app.datadogIssues.link(member.id, key);
  }

  const result = enqueueTicketAction(app, user, "fix-issue", key);
  return {
    queued: result.queued,
    // The ticket exists either way, and that is the half a person most needs to
    // hear: a refused enqueue with the key unmentioned reads as "nothing
    // happened" when a ticket was in fact filed.
    message: `${key}: ${result.message}`,
    ...(result.jobId ? { jobId: result.jobId } : {}),
    jiraIssueKey: key,
  };
}

/**
 * Queues a regression test for a problem, against the member signature that
 * carries the most material.
 *
 * Resolution is the interesting part. A problem is a group of signatures, but the
 * agent works from one error — a stack trace and a message — so a member has to be
 * chosen, and the choice must be stable: `members[0]` is whichever signature was
 * loudest at the last scan, and the loudest one changes. So an existing attempt's
 * `issueId` wins whenever one exists, which keeps the dedupe key, the recorded row
 * and the merge request attached to the same error across a regroup.
 *
 * No Jira ticket is filed on this path, unlike `fixDatadogProblem`. A test is a
 * useful thing to have whether or not anybody intends to track the bug, and filing
 * a ticket as a side effect of asking for a test would put rows in the backlog
 * nobody chose to open.
 */
export function writeDatadogRegressionTest(
  app: App,
  user: AuthUser,
  problemKey: string,
  targetBranch?: string,
): ApiContract.RegressionTestResult {
  const members = membersOf(app, problemKey);
  if (members.length === 0) throw new ConfigError(`No Datadog problem ${problemKey}.`);

  const recorded = members.find((issue) => app.regressionTests.get("datadog", issue.id));
  // A stack is what the agent actually needs; a member that has one beats a louder
  // member that does not.
  const target =
    recorded ?? members.find((issue) => issue.sampleStack?.trim()) ?? members[0]!;
  const destination = datadogRegressionTestTarget(app, user, target.service);
  if (!destination) {
    return {
      queued: false,
      message:
        `Configure a repository for ${target.service ?? "this service"} in ` +
        "Datadog → Settings, or set a fallback in Settings → Pull requests.",
    };
  }
  const override = targetBranch?.trim();

  return enqueueRegressionTest(
    app,
    user,
    "datadog",
    target.id,
    target.problemTitle ?? target.title,
    {
      projectId: destination.projectId,
      targetBranch: override || destination.targetBranch,
    },
  );
}

/** The service mapping wins; a developer's old global default is the fallback. */
export function datadogRegressionTestTarget(
  app: App,
  user: AuthUser,
  service?: string,
): ApiContract.DatadogResolvedTargetView | null {
  const mapped = service ? app.datadogServiceTargets.get(service) : undefined;
  if (mapped) {
    return {
      projectId: mapped.projectId,
      targetBranch: mapped.targetBranch,
      source: "service",
    };
  }
  if (service?.trim()) {
    return {
      ...defaultDatadogServiceTarget(service),
      source: "service-default",
    };
  }
  const fallback = app.fixIssueDefaults.get(user.id);
  return fallback
    ? {
        projectId: fallback.projectId,
        targetBranch: fallback.targetBranch,
        source: "user-default",
      }
    : null;
}

export function datadogRegressionTestRefusal(
  app: App,
  user: AuthUser,
  service?: string,
): string | null {
  if (!app.taskRegistry.get(WRITE_REGRESSION_TEST_TASK_ID)) {
    return "No task is registered to write regression tests on this server.";
  }
  return datadogRegressionTestTarget(app, user, service)
    ? null
    : `Configure a repository for ${service ?? "this service"} in Datadog → Settings, ` +
        "or set a fallback in Settings → Pull requests.";
}

export function triageDatadogProblem(
  app: App,
  user: AuthUser,
  problemKey: string,
): ApiContract.DatadogAiTriageResult {
  const members = membersOf(app, problemKey);
  if (members.length === 0) throw new ConfigError(`No Datadog problem ${problemKey}.`);
  if (!app.taskRegistry.get(TRIAGE_DATADOG_ERROR_TASK_ID)) {
    return { queued: false, message: "No Datadog AI triage task is registered." };
  }
  const issue = members.find((member) => member.sampleStack?.trim()) ?? members[0]!;
  const destination = datadogRegressionTestTarget(app, user, issue.service);
  if (!destination) {
    return {
      queued: false,
      message:
        `Configure a repository for ${issue.service ?? "this service"} in ` +
        "Datadog → Settings before asking AI to inspect it.",
    };
  }
  const result = app.jobs.enqueue({
    kind: TRIAGE_DATADOG_ERROR_TASK_ID,
    loopId: "datadog-actions",
    dedupeKey: `manual:datadog-triage:${issue.id}`,
    actorId: user.id,
    params: {
      source: "datadog",
      issueId: issue.id,
      gitlab: {
        projectId: destination.projectId,
        targetBranch: destination.targetBranch,
      },
    },
  });
  if (!result.enqueued || !result.job) {
    return { queued: false, message: "AI triage is already running for this error." };
  }
  return {
    queued: true,
    jobId: result.job.id,
    message: `Queued AI triage for ${issue.problemTitle ?? issue.title}.`,
  };
}

/** The public configured loop behind the global Datadog page. */
export function datadogScanTaskId(app: App): string {
  const instances = app.instances
    .all()
    .filter(
      (instance) =>
        instance.definitionId === DATADOG_SCAN_TASK_ID &&
        instance.visibility === "public",
    )
    .sort(
      (a, b) =>
        Number(b.name === "Datadog error scan") - Number(a.name === "Datadog error scan") ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
  return instances[0]?.id ?? DATADOG_SCAN_TASK_ID;
}

export function activeDatadogAiTriage(app: App): Set<string> {
  return new Set(
    app.jobs
      .activeForKind(TRIAGE_DATADOG_ERROR_TASK_ID)
      .flatMap((job) => {
        const params = job.params as { issueId?: unknown } | undefined;
        return typeof params?.issueId === "string" ? [params.issueId] : [];
      }),
  );
}

/**
 * Dismisses or restores every signature in a problem.
 *
 * All of it or none: dismissing four of the five log lines one failure emits would
 * leave the fifth on the page, which reads as the dismissal having failed.
 */
export function setDatadogProblemState(
  app: App,
  problemKey: string,
  state: "open" | "dismissed",
): number {
  const members = membersOf(app, problemKey);
  if (members.length === 0) throw new ConfigError(`No Datadog problem ${problemKey}.`);
  for (const member of members) app.datadogIssues.setState(member.id, state);
  return members.length;
}

/**
 * Runs the scan now, on top of whatever the loop's stored params are.
 *
 * Goes through the task service rather than calling `scanDatadog` directly, so a
 * manual scan lands in the run history with its steps and its logs like any other
 * run. "It found nothing" is then answerable without a shell on the host.
 */
export async function scanDatadogNow(
  app: App,
  user: AuthUser,
): Promise<ApiContract.DatadogScanResult> {
  const refusal = datadogScanRefusal(app);
  if (refusal) return { started: false, message: refusal };

  const actor = app.actorFor(user.id);
  const taskId = datadogScanTaskId(app);
  const record = await app.tasks.run(
    taskId,
    {},
    // `force`, because a manual scan that quietly reused the loop's idea of "already
    // seen" would look broken to whoever pressed the button.
    { force: true, ...(actor ? { actor } : {}) },
  );

  const result = record.result;
  const details = (result?.details ?? {}) as Record<string, unknown>;
  const recorded = result?.itemsProcessed ?? 0;
  return {
    started: true,
    executionId: record.executionId,
    status: record.status,
    issuesFound: result?.itemsSeen ?? 0,
    issuesRecorded: recorded,
    issuesNew: typeof details.issuesNew === "number" ? details.issuesNew : 0,
    ...(typeof details.problemsFound === "number"
      ? { problemsFound: details.problemsFound }
      : {}),
    message:
      record.status === "success"
        ? `Scanned ${countOf(details.totalEvents)} error log(s): ` +
          `${countOf(details.problemsFound)} problem(s) across ${recorded} log ` +
          `line(s), ${countOf(details.issuesNew)} new.`
        : // Mostly unreachable — the executor rethrows a failed run, and the route
          // turns that into an error response. Reached by a cancelled run.
          `Scan ${record.status}: ${record.error ?? "see the run log"}.`,
  };
}

/** Why a scan cannot run, or null. Read by the page to disable its button. */
export function datadogScanRefusal(app: App): string | null {
  if (!app.secrets.get("DATADOG_TOKEN")) {
    return "Set a Datadog token in Settings → Integrations → Datadog first.";
  }
  if (!app.taskRegistry.get(datadogScanTaskId(app))) {
    return "No Datadog scan task is registered on this server.";
  }
  return null;
}

/**
 * Deep link into the log explorer for this issue's own query.
 *
 * Built here rather than stored: the site can change in settings, and a link that
 * still points at the old region after a migration is worse than no link. Null
 * when there is no token configured, since the site is then a guess.
 */
export function explorerUrl(app: App, issue: DatadogIssue): string | null {
  if (!app.secrets.get("DATADOG_TOKEN")) return null;
  return logExplorerUrl(datadogSite(app.secrets), issue.query, {
    from: issue.firstSeenAt,
    to: issue.lastSeenAt,
  });
}

function countOf(value: unknown): string {
  return typeof value === "number" ? value.toLocaleString() : "0";
}

/** The API shape, so the router does no mapping of its own. */
export function toDatadogFixResult(
  outcome: DatadogFixOutcome,
): ApiContract.DatadogFixResult {
  return {
    queued: outcome.queued,
    message: outcome.message,
    ...(outcome.jobId ? { jobId: outcome.jobId } : {}),
    ...(outcome.jiraIssueKey ? { jiraIssueKey: outcome.jiraIssueKey } : {}),
  };
}
