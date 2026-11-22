/**
 * What "Review the requirements" is about to do, before it does it.
 *
 * The sibling of `FixIssueDialog`, and confirmed for the same reason even though
 * it writes no code: it posts a comment, under the clicker's own Jira account, in
 * a thread the reporter and everyone watching the ticket will read. That is a
 * message sent to colleagues — cheaper to undo than a merge request, but not
 * something to discover having happened.
 *
 * The steps are the real pipeline in `src/tasks/review-ticket/index.ts`, in order,
 * not a friendly paraphrase. If that pipeline changes, this list is wrong and
 * should be changed with it — it is documentation shown at the moment it matters,
 * and a list that drifts is worse than no list.
 */
import { MessageCircleQuestionMark } from "lucide-react";

import type { TicketCluster } from "../api.ts";
import { FormActions } from "../components/ui/field.tsx";
import { Button } from "../components/ui/button.tsx";
import { Modal } from "../components/ui/modal.tsx";
import {
  CONFIRM_DIALOG_CLASS,
  CONFIRM_NOTE_CLASS,
  CONFIRM_STEP_CLASS,
  CONFIRM_STEP_DETAIL_CLASS,
  CONFIRM_STEP_NUMBER_CLASS,
  CONFIRM_STEP_TITLE_CLASS,
  CONFIRM_STEPS_CLASS,
} from "../confirmation-dialog-styles.ts";
import { DIALOG_BODY_CLASS } from "../typography-styles.ts";

export function ReviewDescriptionDialog({
  cluster,
  busy,
  onConfirm,
  onCancel,
}: {
  cluster: TicketCluster;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const steps: { title: string; detail: string }[] = [
    {
      title: "Read the ticket",
      detail: `${cluster.key} from Jira — summary, description, type, labels and its twenty most recent comments.`,
    },
    {
      title: "Look for what a developer could not answer",
      detail:
        "Acceptance criteria nobody can test, a behaviour specified for the happy path only, a rule with no stated exception, terms the ticket never defines, sentences that contradict each other.",
    },
    {
      title: "Skip what is already answered",
      detail:
        "The existing comments go in with the description, so a question somebody settled in the thread is not asked again.",
    },
    {
      title: "Post the questions as one comment",
      detail:
        "At most six, as a bullet list, signed as a TALOS review requested by you. A ticket that already says enough gets no comment at all.",
    },
  ];

  return (
    <Modal
      onClose={onCancel}
      className={CONFIRM_DIALOG_CLASS}
      title={
        <>
          <MessageCircleQuestionMark size={15} strokeWidth={2} />
          Review {cluster.key}
        </>
      }
    >
      {cluster.title ? <p className={DIALOG_BODY_CLASS}>{cluster.title}</p> : null}

      <ol className={CONFIRM_STEPS_CLASS}>
        {steps.map((step, index) => (
          <li className={CONFIRM_STEP_CLASS} key={step.title}>
            <span className={CONFIRM_STEP_NUMBER_CLASS}>{index + 1}</span>
            <span>
              <strong className={CONFIRM_STEP_TITLE_CLASS}>{step.title}</strong>
              <span className={CONFIRM_STEP_DETAIL_CLASS}>{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>

      <p className={CONFIRM_NOTE_CLASS}>
        No repository is involved and nothing is edited — the only thing this writes is a Jira
        comment, posted with your credentials, so it appears under your name. You can stop it
        before it comments from the ticket's panel on the canvas.
      </p>

      <FormActions>
        <Button type="button" disabled={busy} onClick={onConfirm}>
          {busy ? "Queueing…" : "Start the review"}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </FormActions>
    </Modal>
  );
}
