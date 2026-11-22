/**
 * The actions a ticket node offers, and the queue rows behind them.
 *
 * A sibling of `pull-request-actions.ts` and deliberately shaped like it: every
 * action is a queued job rather than a direct `tasks.run`, so a click inherits
 * retry with backoff, the dead-job brake, per-kind concurrency and a row the
 * graph already knows how to draw as a node.
 *
 * Four actions today, and they need different things from the developer:
 *
 * - `fix-issue` writes code, so it needs somewhere to write it. The repository
 *   comes from the developer's own `FixIssueDefaults` rather than from the ticket,
 *   because a Jira ticket names no repository and there is nothing to guess from.
 *   No defaults means the action is refused with a reason that says where to set
 *   them — never a branch pushed to a repository somebody did not choose.
 * - `plan-issue` needs the same destination for a different reason: it clones the
 *   repository to read it, and the plan it writes is a plan *about* that repository
 *   off that branch. It writes nothing anywhere — the container is read-only — so
 *   the only thing it commits the developer to is a container run.
 * - `review-description` touches no repository at all: it reads the ticket and
 *   posts questions back into its own thread, so Jira access is the whole
 *   requirement. Hence per-action refusals rather than one gate for the menu.
 * - `e2e-test` starts from a linked MR chosen in the confirmation dialog and
 *   reads its QA URL and fixtures from the mandatory Test-Automation config.
 */
import type * as ApiContract from "../../shared/api-contract.ts";
import type { App } from "../app.ts";
import type { AuthUser } from "../auth.ts";
import type { Job } from "../core/job.ts";
import { FIX_JIRA_ISSUE_ONE_TASK_ID } from "../tasks/fix-jira-issue/index.ts";
import { PLAN_JIRA_ISSUE_TASK_ID } from "../tasks/plan-jira-issue/index.ts";
import { REVIEW_TICKET_DESCRIPTION_TASK_ID } from "../tasks/review-ticket/index.ts";
import { E2E_TEST_TASK_ID } from "../tasks/e2e-test/index.ts";

export type TicketActionId = ApiContract.TicketActionId;

/** Every action, in the order the menu lists them. */
export const TICKET_ACTION_IDS: readonly TicketActionId[] = [
  "fix-issue",
  "plan-issue",
  "review-description",
  "e2e-test",
];

/** The queue handler each action enqueues. */
const HANDLER: Record<TicketActionId, string> = {
  "fix-issue": FIX_JIRA_ISSUE_ONE_TASK_ID,
  "plan-issue": PLAN_JIRA_ISSUE_TASK_ID,
  "review-description": REVIEW_TICKET_DESCRIPTION_TASK_ID,
  "e2e-test": E2E_TEST_TASK_ID,
};

/** The actions that clone a repository, and so need a destination configured. */
function needsRepository(action: TicketActionId): boolean {
  return action === "fix-issue" || action === "plan-issue";
}

/**
 * `jobs.loop_id` is `NOT NULL` and a ticket node's click has no loop behind it —
 * the ticket was read straight from Jira. Safe to invent for the same reason
 * `PULL_REQUEST_ACTION_LOOP_ID` is: the pool only uses the loop id for
 * `subjects.markActedOn`, which it skips for a job carrying no fingerprint.
 */
export const FIX_ISSUE_ACTION_LOOP_ID = "fix-issue-actions";

/**
 * Identifies "this action is in flight for this ticket", whoever asked. The
 * dedupe index covers `queued` and `leased` only, so a second click while one is
 * running is refused and a re-run after it finishes is allowed.
 *
 * Per action, not per ticket: a requirements review and a fix are different work
 * and one must not block the other.
 */
export function ticketActionDedupeKey(action: TicketActionId, issueKey: string): string {
  return `manual:${action}:jira:${issueKey}`;
}

function e2eDedupeKey(
  issueKey: string,
  pullRequest: { projectId: string; mrIid: number },
): string {
  return `${ticketActionDedupeKey("e2e-test", issueKey)}:mr:` +
    `${encodeURIComponent(pullRequest.projectId)}!${pullRequest.mrIid}`;
}

const DEDUPE_KEY_PATTERN = /^manual:([a-z0-9-]+):jira:(.+)$/;

export interface TicketActionJob {
  action: TicketActionId;
  issueKey: string;
  job: Job;
}

/** What the in-flight reads have always returned; kept as the name call sites use. */
export type ActiveTicketAction = TicketActionJob;

/**
 * The ticket action one queue row stands for, or undefined if it stands for
 * something else.
 *
 * The same `manual:` key space holds the pull request actions, whose ids are not
 * ticket actions — decoding by pattern alone would claim them.
 */
function decodeTicketAction(job: Job): TicketActionJob | undefined {
  const match = DEDUPE_KEY_PATTERN.exec(job.dedupeKey);
  if (!match) return undefined;
  const action = match[1] as TicketActionId;
  if (!TICKET_ACTION_IDS.includes(action)) return undefined;
  const issueKey = action === "e2e-test" ? match[2]!.split(":mr:", 1)[0]! : match[2]!;
  return { action, issueKey, job };
}

/**
 * Every ticket action in flight right now, decoded from the queue.
 *
 * The graph needs it to draw a ticket as `running` while an agent is on it: these
 * jobs touch no work subject, so nothing else in the payload would ever mention
 * them and the node would sit there looking untouched for the whole run.
 */
export function activeTicketActions(app: App): ActiveTicketAction[] {
  const out: ActiveTicketAction[] = [];
  for (const job of app.jobs.activeManualActions()) {
    const entry = decodeTicketAction(job);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * How many past actions one ticket shows. A ticket somebody has retried a fix on
 * all afternoon has a dozen rows in the queue, and the newest few are the only
 * ones that answer "what has been tried here" — the same reason
 * `JOBS_PER_SUBJECT` exists in `graph-view.ts`.
 */
export const TICKET_ACTIONS_PER_TICKET = 5;

/**
 * Every action ever triggered against each ticket, newest first, capped per
 * ticket — the ticket graph's action history.
 *
 * The queue row is the durable record of a click: it outlives the run, and it
 * carries who asked, which handler, how many attempts, the error and the run id.
 * Nothing was ever missing; the graph simply only read the in-flight slice, so a
 * fix that finished vanished off the page along with the way back to its log.
 */
export function ticketActionHistory(app: App): Map<string, TicketActionJob[]> {
  const byTicket = new Map<string, TicketActionJob[]>();
  for (const job of app.jobs.manualTicketActionHistory()) {
    const entry = decodeTicketAction(job);
    if (!entry) continue;
    const bucket = byTicket.get(entry.issueKey);
    if (!bucket) {
      byTicket.set(entry.issueKey, [entry]);
      continue;
    }
    // Newest first out of the query, so the first `TICKET_ACTIONS_PER_TICKET` a
    // bucket sees are already the newest ones and the rest can simply be dropped.
    if (bucket.length < TICKET_ACTIONS_PER_TICKET) bucket.push(entry);
  }
  return byTicket;
}

/**
 * Just the fixes in flight.
 *
 * What the LogRocket and Datadog pages want: they draw "a fix is running for this
 * ticket" and a description review of the same ticket is not that. Filtered here
 * rather than at each call site so no page has to remember which action ids count
 * as fixing something.
 */
export function activeFixIssueActions(app: App): ActiveTicketAction[] {
  return activeTicketActions(app).filter((action) => action.action === "fix-issue");
}

/**
 * Why an action cannot run from here at all, or null if it can.
 *
 * Both the client's hint and the server's own check, on purpose: these start
 * containers that push branches and comment on tickets other people read, so a
 * greyed-out menu item cannot be the only thing standing between a hand-written
 * POST and a commit in somebody's repo.
 */
export function ticketActionRefusal(
  app: App,
  user: AuthUser,
  action: TicketActionId,
): string | null {
  if (!app.taskRegistry.get(HANDLER[action])) {
    return MISSING_HANDLER[action];
  }
  // Only the actions that clone need a destination; a review writes to the ticket
  // it read, and has no repository in the picture at all.
  if (needsRepository(action) && !app.fixIssueDefaults.get(user.id)) {
    return "Set a default project and branch in Settings → Pull requests first.";
  }
  return null;
}

const MISSING_HANDLER: Record<TicketActionId, string> = {
  "fix-issue": "No task is registered to fix Jira issues on this server.",
  "plan-issue": "No task is registered to plan Jira issues on this server.",
  "review-description": "No task is registered to review Jira descriptions on this server.",
  "e2e-test": "No task is registered to run QA E2E tests on this server.",
};

/** Enqueues one action against one ticket, or reports why it did not. */
export function enqueueTicketAction(
  app: App,
  user: AuthUser,
  action: TicketActionId,
  issueKey: string,
  options: {
    targetBranch?: string;
    /**
     * The approved plan a fix is carrying out. Set only by `plan-actions.ts` on
     * approval — never from a request body, because the plan text is the whole of
     * what a human authorised and a client that could supply it could authorise
     * itself.
     */
    plan?: { id: string; body: string };
    /**
     * The project a plan was written against, so its fix runs against the same one
     * even if the developer has since changed their default. Approving a plan about
     * one repository must not queue a fix in another.
     */
    projectId?: string;
    /** The linked merge request selected in the E2E confirmation dialog. */
    pullRequest?: { projectId: string; mrIid: number };
  } = {},
): ApiContract.MrActionResult {
  const refusal = ticketActionRefusal(app, user, action);
  if (refusal) return { queued: false, message: refusal };

  // A second plan for a ticket that already has one awaiting a decision would leave
  // two drafts and one reviewer, and the store's partial unique index would refuse
  // the insert *after* a container had already run. Refused here so the wasted run
  // never starts — and refused on the server, not just greyed in the menu, for the
  // reason at the top of `ticketActionRefusal`.
  if (action === "plan-issue") {
    const open = app.plans.openForIssue(issueKey);
    if (open) {
      return {
        queued: false,
        message: `${issueKey} already has a plan waiting for review; decide on that one first.`,
      };
    }
  }

  if (action === "e2e-test") {
    if (!options.pullRequest) {
      return { queued: false, message: "Choose a linked merge request to test." };
    }
  }

  const targetBranch = needsRepository(action)
    ? fixIssueTargetBranch(app, user, options.targetBranch)
    : undefined;
  const params = action === "e2e-test"
    ? {
        jira: { issueKey },
        gitlab: {
          projectId: options.pullRequest!.projectId,
          mrIid: options.pullRequest!.mrIid,
        },
      }
    : needsRepository(action)
    ? repositoryParams(app, user, issueKey, targetBranch!, options)
    : { jira: { issueKey } };

  const result = app.jobs.enqueue({
    kind: HANDLER[action],
    loopId: FIX_ISSUE_ACTION_LOOP_ID,
    dedupeKey: action === "e2e-test"
      ? e2eDedupeKey(issueKey, options.pullRequest!)
      : ticketActionDedupeKey(action, issueKey),
    // The person who pressed the button: the agent branches, pushes, opens the
    // merge request and comments as them.
    actorId: user.id,
    params,
  });

  if (!result.enqueued || !result.job) {
    return { queued: false, message: IN_FLIGHT[action](issueKey) };
  }
  return {
    queued: true,
    jobId: result.job.id,
    message: queuedMessage(app, user, action, issueKey, targetBranch, options),
  };
}

const IN_FLIGHT: Record<TicketActionId, (issueKey: string) => string> = {
  "fix-issue": (key) => `Already working on ${key}; waiting on the run in flight.`,
  "plan-issue": (key) => `Already planning ${key}; waiting on the run in flight.`,
  "review-description": (key) => `Already reviewing ${key}; waiting on the run in flight.`,
  "e2e-test": (key) => `Already testing this merge request for ${key}; waiting on the run in flight.`,
};

/**
 * Where the work lands. The project is the developer's saved project, except when an
 * approved plan names one — a plan is written about a specific repository, and running
 * its fix somewhere else would implement a plan against code it never read. Only the
 * base/target branch can be overridden by the confirmation dialog.
 */
function repositoryParams(
  app: App,
  user: AuthUser,
  issueKey: string,
  targetBranch: string,
  options: { plan?: { id: string; body: string }; projectId?: string },
) {
  const defaults = app.fixIssueDefaults.get(user.id)!;
  return {
    jira: { issueKey },
    gitlab: { projectId: options.projectId ?? defaults.projectId, targetBranch },
    ...(options.plan ? { plan: options.plan } : {}),
  };
}

function fixIssueTargetBranch(
  app: App,
  user: AuthUser,
  override: string | undefined,
): string {
  return override?.trim() || app.fixIssueDefaults.get(user.id)!.targetBranch;
}

function queuedMessage(
  app: App,
  user: AuthUser,
  action: TicketActionId,
  issueKey: string,
  targetBranch?: string,
  options: {
    projectId?: string;
    pullRequest?: { projectId: string; mrIid: number };
  } = {},
): string {
  if (action === "review-description") {
    return `Queued a requirements review of ${issueKey}; questions will be posted as a Jira comment.`;
  }
  if (action === "e2e-test") {
    const target = optionsProject(options);
    return `Queued a QA E2E test for ${issueKey} against ${target}.`;
  }
  const project = options.projectId ?? app.fixIssueDefaults.get(user.id)!.projectId;
  if (action === "plan-issue") {
    return `Queued a plan for ${issueKey} against ${project} off ${targetBranch}. Nothing will be changed until you approve it.`;
  }
  return `Queued a fix for ${issueKey} in ${project} off ${targetBranch}.`;
}

function optionsProject(
  options: { pullRequest?: { projectId: string; mrIid: number } },
): string {
  const selected = options.pullRequest;
  return selected ? `${selected.projectId}!${selected.mrIid}` : "the selected merge request";
}
