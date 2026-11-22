/**
 * The one human decision in the gated pipeline: approve a plan, or reject it.
 *
 * A sibling of `ticket-actions.ts`, but the responsibility is different. Those
 * functions decide whether a *click* may start a container. These decide whether a
 * plan somebody read is the thing a container will be handed — so the checks here are
 * the whole of the gate, and none of them may live only in the console.
 *
 * Three things this module is careful about, each because the alternative is a
 * quietly broken gate rather than a visible error:
 *
 * 1. **The approved text comes from the request, and it is what runs.** The reviewer
 *    edits the draft, so the body they submit is not necessarily the body the agent
 *    wrote. Approving without carrying it would ship the draft while showing the
 *    reviewer their edit — the failure mode where the gate appears to work.
 * 2. **A moved ticket blocks approval.** The ticket text is the plan's premise; a
 *    conclusion drawn from a premise that has since changed is not something anybody
 *    reviewed. The panel offers Re-plan instead, and this refuses even when a
 *    hand-written POST skips the panel.
 * 3. **One approval means one container, even from two tabs.** The fix is queued before
 *    the approval is written, because the approval records the job id. Concurrency is
 *    held by the fix's dedupe key rather than by the row: the second enqueue is refused,
 *    and `plans.approve` — a conditional UPDATE on an `awaiting-review` row — settles
 *    which reviewer's edited body was the authorised one.
 */
import type * as ApiContract from "../../shared/api-contract.ts";
import type { App } from "../app.ts";
import type { Plan } from "../application/ports.ts";
import type { AuthUser } from "../auth.ts";
import { ValidationError } from "../core/errors.ts";
import { ticketFingerprint } from "../tasks/jira-ticket-to-mr/ticket.ts";
import { cachedTicketDetail } from "./cached-reads.ts";
import { enqueueTicketAction } from "./ticket-actions.ts";

/**
 * A plan document is bind-mounted into a container as a file. Generous, because a
 * plan for a real change with code excerpts in it is long, and capped at all because
 * an unbounded field on an authenticated POST is still an unbounded field.
 */
const MAX_PLAN_BODY = 128 * 1024;

/** GET `/api/plans` — every plan waiting on somebody, oldest first. */
export async function planInbox(app: App, user: AuthUser): Promise<ApiContract.PlanInboxView> {
  const waiting = app.plans.awaitingReview();
  // Staleness one ticket at a time, but every read is either a cache hit or a read
  // the panel was about to make anyway, and the inbox is short by construction — a
  // long one is the problem it exists to report.
  const plans = await Promise.all(
    waiting.map(async (plan) => ({
      id: plan.id,
      issueKey: plan.issueKey,
      status: plan.status,
      projectId: plan.projectId,
      targetBranch: plan.targetBranch,
      ...(plan.summary ? { summary: plan.summary } : {}),
      stale: await ticketMoved(app, user, plan),
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    })),
  );
  return { plans } satisfies ApiContract.PlanInboxView;
}

/** GET `/api/tickets/:key/plan` — the plan document, plus what came before it. */
export async function planViewFor(
  app: App,
  user: AuthUser,
  issueKey: string,
): Promise<ApiContract.TicketPlanView> {
  const all = app.plans.forIssue(issueKey);
  const [newest, ...older] = all;
  if (!newest) return { plan: null, history: [] } satisfies ApiContract.TicketPlanView;

  const stale = await ticketMoved(app, user, newest);
  const baseDrift = await baseBranchMoved(app, newest);

  return {
    plan: {
      id: newest.id,
      issueKey: newest.issueKey,
      status: newest.status,
      projectId: newest.projectId,
      targetBranch: newest.targetBranch,
      ...(newest.summary ? { summary: newest.summary } : {}),
      draftBody: newest.draftBody,
      ...(newest.approvedBody ? { approvedBody: newest.approvedBody } : {}),
      ...(stale || baseDrift
        ? {
            staleness: {
              ...(stale ? { ticket: true } : {}),
              ...(baseDrift ? { base: baseDrift } : {}),
            },
          }
        : {}),
      ...(newest.planRunId ? { planRunId: newest.planRunId } : {}),
      ...(newest.implementJobId ? { implementJobId: newest.implementJobId } : {}),
      ...(reviewerName(app, newest) ? { reviewer: reviewerName(app, newest)! } : {}),
      ...(newest.reviewNote ? { reviewNote: newest.reviewNote } : {}),
      createdAt: newest.createdAt.toISOString(),
      updatedAt: newest.updatedAt.toISOString(),
    },
    history: older.map((plan) => ({
      id: plan.id,
      status: plan.status,
      ...(plan.summary ? { summary: plan.summary } : {}),
      // Not computed for a resolved plan: "the ticket has moved since" is advice about
      // a decision still to be taken, and there is no decision left to take here.
      stale: false,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    })),
  } satisfies ApiContract.TicketPlanView;
}

/**
 * POST `/api/plans/:id/decision` — approve or reject, once.
 *
 * A refusal is a `200` carrying a reason, not a `409`: everything here is a state
 * somebody could reasonably arrive in by leaving a tab open, and the useful answer to
 * "another reviewer already approved this" is that sentence, not a status code the
 * client has to translate. Same stance as `routeTicketAction`.
 */
export async function decidePlan(
  app: App,
  user: AuthUser,
  planId: string,
  body: ApiContract.PlanDecisionRequest,
): Promise<ApiContract.MrActionResult> {
  const plan = app.plans.get(planId);
  if (!plan) return { queued: false, message: "That plan no longer exists." };
  if (plan.status !== "awaiting-review") {
    return { queued: false, message: alreadyDecided(plan) };
  }

  if (body.decision === "reject") {
    const note = body.note?.trim();
    if (!app.plans.reject(planId, { reviewerId: user.id, ...(note ? { note } : {}) })) {
      return { queued: false, message: alreadyDecided(app.plans.get(planId) ?? plan) };
    }
    return {
      queued: false,
      message: `Rejected the plan for ${plan.issueKey}. Nothing was changed, and no fix was queued.`,
    };
  }

  const approved = body.body?.trim();
  if (!approved) {
    throw new ValidationError("'body' is required to approve a plan: it is the text that will run.");
  }
  if (approved.length > MAX_PLAN_BODY) {
    throw new ValidationError(
      `A plan may be at most ${MAX_PLAN_BODY} characters; this one is ${approved.length}.`,
    );
  }

  // Blocked, not warned. See the note at the top of this file — and refused here
  // rather than only in the panel, because the panel is not what stands between a
  // hand-written POST and a container implementing a plan for a rewritten ticket.
  if (await ticketMoved(app, user, plan)) {
    return {
      queued: false,
      message: `${plan.issueKey} has been edited since this plan was written, so the plan may no longer describe the right change. Write a new plan instead.`,
    };
  }

  // The fix is queued first because `plans.approve` records the job id, and there is no
  // job id until the queue has one. Two tabs approving at once therefore both reach the
  // enqueue — which is safe, because `enqueueTicketAction` dedupes on
  // `manual:fix-issue:jira:KEY`: the second gets a refusal and returns below, so there
  // is one container either way. What `approve` still decides is *which* body was
  // authorised, since it only matches an `awaiting-review` row.
  const result = enqueueFix(app, user, plan, approved);
  if (!result.queued || !result.jobId) return result;

  if (!app.plans.approve(planId, {
    reviewerId: user.id,
    body: approved,
    implementJobId: result.jobId,
  })) {
    // Somebody else decided in the window between the read above and here. The fix is
    // already queued and the dedupe key means there is exactly one of it, which is the
    // outcome they were asking for too — so say what happened rather than pretending
    // this call did it.
    return { queued: false, message: alreadyDecided(app.plans.get(planId) ?? plan) };
  }
  return result;
}

/**
 * Queues the fix that carries the approved text.
 *
 * Through `enqueueTicketAction` rather than `app.jobs.enqueue` directly, so an approved
 * plan produces exactly the queue row a click on "Fix this issue" would: the same
 * handler, the same dedupe key, the same actor. That is what makes the graph draw it,
 * the panel cancel it, and "it worked from the button" a fact rather than a hint.
 *
 * The plan's own project and branch, not the reviewer's current defaults: the plan was
 * written about one repository off one branch, and approving it authorises that.
 */
function enqueueFix(
  app: App,
  user: AuthUser,
  plan: Plan,
  body: string,
): ApiContract.MrActionResult {
  return enqueueTicketAction(app, user, "fix-issue", plan.issueKey, {
    targetBranch: plan.targetBranch,
    projectId: plan.projectId,
    plan: { id: plan.id, body },
  });
}

/**
 * Has the ticket been edited since the plan was written?
 *
 * The same `ticketFingerprint` the loop uses — Jira's `updated` — so "look again"
 * means the same thing here as it does there. Unknowable answers are `false`: a plan
 * written before this field was recorded, or a Jira read that failed, must not become
 * a permanent refusal to approve anything.
 */
async function ticketMoved(app: App, user: AuthUser, plan: Plan): Promise<boolean> {
  if (!plan.ticketFingerprint) return false;
  try {
    const detail = await cachedTicketDetail(app, user, plan.issueKey);
    if (!detail.ticket?.updatedAt) return false;
    return ticketFingerprint(plan.issueKey, detail.ticket.updatedAt) !== plan.ticketFingerprint;
  } catch {
    return false;
  }
}

/**
 * Has the base branch moved? A warning only, and never a refusal.
 *
 * A busy `develop` moves hourly, so refusing would refuse every plan on a real
 * repository. It buys nothing either: the fix clones the current head regardless, and
 * a plan is prose about intent rather than a patch against a commit. What the reviewer
 * gets out of it is the judgement call "is this plan reasoning about code that has
 * since changed", which is theirs to make.
 */
async function baseBranchMoved(
  app: App,
  plan: Plan,
): Promise<{ plannedSha: string; currentSha?: string } | undefined> {
  if (!plan.baseSha) return undefined;
  try {
    const branches = await app
      .sharedGitLab()
      .listBranches(plan.projectId, { search: plan.targetBranch, limit: 20 });
    const head = branches.find((branch) => branch.name === plan.targetBranch)?.commit?.id;
    if (!head || head === plan.baseSha) return undefined;
    return { plannedSha: plan.baseSha, currentSha: head };
  } catch {
    return undefined;
  }
}

function reviewerName(app: App, plan: Plan): string | undefined {
  if (!plan.reviewerId) return undefined;
  // An account that has since been removed still decided this, so the id is reported
  // as itself rather than the row silently losing its reviewer.
  return app.auth.byId(plan.reviewerId)?.name ?? plan.reviewerId;
}

function alreadyDecided(plan: Plan): string {
  switch (plan.status) {
    case "approved":
      return `This plan has already been approved, and a fix for ${plan.issueKey} is queued.`;
    case "rejected":
      return "This plan has already been rejected.";
    case "implemented":
      return `This plan has already been implemented; ${plan.issueKey} has a merge request.`;
    case "superseded":
      return "A newer plan has been written for this ticket; decide on that one instead.";
    default:
      return "This plan is no longer waiting for a decision.";
  }
}
