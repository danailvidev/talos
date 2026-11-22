/**
 * The quality gate, as a screen.
 *
 * This is the only place a human stands between an agent's idea and a container
 * writing code, so the tab is built around one decision rather than around the
 * document: read the plan, change what is wrong with it, then approve or reject.
 *
 * Three things here are load-bearing rather than cosmetic:
 *
 * - **The editor's text is what runs.** Approve sends the buffer, edits included, and
 *   the server mounts exactly that into the container as `.talos/plan.md`. There is
 *   no "save the edit" step to forget: an unsaved edit that got dropped on approve
 *   would be the gate appearing to work while shipping the draft.
 * - **A moved ticket removes Approve.** The plan was reasoned from the ticket's text;
 *   if that text has changed, nothing anybody read still applies. The button becomes
 *   "Write a new plan". The server refuses this case too — the missing button is the
 *   courtesy, not the control.
 * - **A moved base branch does not.** `develop` moves hourly, and the fix clones its
 *   head regardless. It is reported because "is this plan reasoning about code that has
 *   since changed" is a judgement, and it is the reviewer's.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ListChecks, Pencil, RefreshCw, X } from "lucide-react";

import type { PlanStatusView, PlanView, TicketPlanSummaryView } from "../api.ts";
import { api } from "../api.ts";
import { Markdown } from "../components/Markdown.tsx";
import { Button } from "../components/ui/button.tsx";
import { ErrorBox, Loading } from "../components/ui/query-state.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { ago } from "../format.ts";
import { invalidate, queries } from "../queries.ts";
import {
  EMPTY_STATE_CLASS,
  ERROR_BOX_CLASS,
  SUCCESS_BOX_CLASS,
  WARN_BOX_CLASS,
} from "../state-styles.ts";
import { useApi } from "../useApi.ts";

const STATUS_WORD: Record<PlanStatusView, string> = {
  "awaiting-review": "waiting for your review",
  approved: "approved — the fix is queued",
  rejected: "rejected",
  superseded: "superseded by a newer plan",
  implemented: "implemented — a merge request exists",
};

export function PlanTab({
  issueKey,
  onPlanIssue,
  planning,
}: {
  issueKey: string;
  /** Opens the same confirmation the menu's "Plan this issue" opens. */
  onPlanIssue: () => void;
  /** A planning job is being queued right now. */
  planning: boolean;
}) {
  const query = useApi(queries.ticketPlan(issueKey));

  if (query.error) return <ErrorBox>{query.error}</ErrorBox>;
  if (query.data === undefined) return <Loading>Loading the plan…</Loading>;

  const { plan, history } = query.data;
  if (!plan) {
    return (
      <div className={EMPTY_STATE_CLASS}>
        <p className="m-0">No plan has been written for {issueKey}.</p>
        <Button type="button" className="mt-3" disabled={planning} onClick={onPlanIssue}>
          <ListChecks size={14} strokeWidth={2} />
          {planning ? "Queueing…" : "Write a plan"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PlanBody
        plan={plan}
        issueKey={issueKey}
        onPlanIssue={onPlanIssue}
        planning={planning}
      />
      {history.length > 0 ? <PlanHistory history={history} /> : null}
    </div>
  );
}

function PlanBody({
  plan,
  issueKey,
  onPlanIssue,
  planning,
}: {
  plan: PlanView;
  issueKey: string;
  onPlanIssue: () => void;
  planning: boolean;
}) {
  const client = useQueryClient();
  const decided = plan.status !== "awaiting-review";
  // The approved text once there is one: what a decided plan should show is what was
  // authorised, not the draft it started as.
  const authoritative = plan.approvedBody ?? plan.draftBody;
  const [body, setBody] = useState(authoritative);
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string }>();

  // A new plan for this ticket — a re-plan landing while the tab is open — replaces the
  // buffer. Keyed on the plan id and its timestamp so an edit in progress survives the
  // five-second poll, which returns the same plan and must not overwrite it.
  useEffect(() => {
    setBody(authoritative);
    setEditing(false);
    setRejecting(false);
    setNote("");
    setNotice(undefined);
  }, [plan.id, authoritative]);

  const edited = body !== plan.draftBody;
  const staleTicket = plan.staleness?.ticket === true;

  async function decide(decision: "approve" | "reject"): Promise<void> {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await api.decidePlan(plan.id, {
        decision,
        ...(decision === "approve" ? { body } : {}),
        ...(decision === "reject" && note.trim() ? { note: note.trim() } : {}),
      });
      setNotice({ ok: result.queued || decision === "reject", text: result.message });
      invalidate.plan(client, issueKey);
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="m-0 text-[0.8125rem] text-[var(--text-faint)]">
          Written {ago(plan.createdAt)} against{" "}
          <span className="font-mono">{plan.projectId}</span> at{" "}
          <span className="font-mono">{plan.targetBranch}</span> — {STATUS_WORD[plan.status]}
          {plan.reviewer ? ` by ${plan.reviewer}` : ""}.
        </p>
        {!decided ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setEditing((current) => !current)}
          >
            <Pencil size={13} strokeWidth={2} />
            {editing ? "Preview" : "Edit"}
          </Button>
        ) : null}
      </div>

      {plan.summary ? (
        <p className="m-0 text-[0.9375rem] text-foreground">{plan.summary}</p>
      ) : null}

      {plan.reviewNote ? (
        <p className="m-0 text-[0.875rem] text-[var(--text-dim)]">
          Reviewer's note: {plan.reviewNote}
        </p>
      ) : null}

      {staleTicket ? (
        <div className={WARN_BOX_CLASS}>
          {issueKey} has been edited since this plan was written, so the plan may describe the
          wrong change. Approving is refused; write a new plan instead.
        </div>
      ) : null}

      {plan.staleness?.base ? (
        <div className={WARN_BOX_CLASS}>
          <span className="font-mono">{plan.targetBranch}</span> has moved since this plan was
          written (
          <span className="font-mono">{plan.staleness.base.plannedSha.slice(0, 8)}</span>
          {plan.staleness.base.currentSha ? (
            <>
              {" → "}
              <span className="font-mono">{plan.staleness.base.currentSha.slice(0, 8)}</span>
            </>
          ) : null}
          ). The fix will be cut from the current head, so check that the plan is not reasoning
          about code that has since changed.
        </div>
      ) : null}

      {editing ? (
        <Textarea
          className="min-h-100 font-mono text-[0.8125rem] leading-relaxed"
          value={body}
          disabled={busy}
          spellCheck={false}
          aria-label={`Implementation plan for ${issueKey}`}
          onChange={(event) => setBody(event.target.value)}
        />
      ) : (
        <Markdown text={body} />
      )}

      {edited && !decided ? (
        <p className="m-0 text-[0.8125rem] text-[var(--warn)]">
          You have edited this plan. Approving sends your version, not the agent's.
        </p>
      ) : null}

      {notice ? (
        <div className={notice.ok ? SUCCESS_BOX_CLASS : ERROR_BOX_CLASS}>{notice.text}</div>
      ) : null}

      {decided ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={planning} onClick={onPlanIssue}>
            <RefreshCw size={14} strokeWidth={2} />
            {planning ? "Queueing…" : "Write a new plan"}
          </Button>
        </div>
      ) : rejecting ? (
        <div className="flex flex-col gap-2">
          <Textarea
            className="min-h-20"
            value={note}
            disabled={busy}
            autoFocus
            placeholder="What is wrong with it? Optional, and kept with the plan."
            aria-label="Why this plan is being rejected"
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void decide("reject")}>
              {busy ? "Rejecting…" : "Reject the plan"}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setRejecting(false)}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {staleTicket ? null : (
            <Button type="button" disabled={busy || body.trim() === ""} onClick={() => void decide("approve")}>
              <Check size={14} strokeWidth={2} />
              {busy ? "Queueing the fix…" : "Approve and start the fix"}
            </Button>
          )}
          <Button type="button" variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
            <X size={14} strokeWidth={2} />
            Reject
          </Button>
          <Button type="button" variant="ghost" disabled={busy || planning} onClick={onPlanIssue}>
            <RefreshCw size={14} strokeWidth={2} />
            {planning ? "Queueing…" : "Re-plan"}
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * The plans that came before this one, as one line each.
 *
 * Kept rather than overwritten, and shown rather than hidden, because "we tried this
 * and it was rejected for that reason" is the context somebody re-planning the same
 * ticket a third time most needs.
 */
function PlanHistory({ history }: { history: readonly TicketPlanSummaryView[] }) {
  return (
    <section className="mt-2 border-t border-border pt-3">
      <h4 className="m-0 mb-2 text-[0.8125rem] font-medium text-[var(--text-dim)]">
        Earlier plans
      </h4>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {history.map((plan) => (
          <li key={plan.id} className="text-[0.8125rem] text-[var(--text-faint)]">
            <span className="text-[var(--text-dim)]">{STATUS_WORD[plan.status]}</span>
            {" · "}
            {ago(plan.createdAt)}
            {plan.summary ? ` · ${plan.summary}` : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
