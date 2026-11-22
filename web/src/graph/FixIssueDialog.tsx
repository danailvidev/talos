/**
 * What "Fix this issue" is about to do, before it does it.
 *
 * The button starts a container that reads a ticket, writes code, pushes a
 * branch and opens a merge request in somebody's repository under the clicker's
 * own name. That is a lot to hang off one click with no intermediate screen, and
 * the two facts a developer most needs — which project, and off which branch —
 * come from their Settings rather than from the ticket, so they are exactly the
 * facts a click cannot see. Hence a confirmation that spends its space naming
 * them.
 *
 * The steps are the real pipeline in `src/tasks/fix-jira-issue/index.ts`, in
 * order, not a friendly paraphrase. If that pipeline changes, this list is wrong
 * and should be changed with it — it is documentation shown at the moment it
 * matters, and a list that drifts is worse than no list.
 */
import { GitBranch, Wrench } from "lucide-react";
import { useEffect, useState } from "react";

import type { FixIssueDefaultsView, TicketCluster } from "../api.ts";
import { Field, FormActions } from "../components/ui/field.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Modal } from "../components/ui/modal.tsx";
import {
  CONFIRM_NOTE_CLASS,
  CONFIRM_STEP_CLASS,
  CONFIRM_STEP_DETAIL_CLASS,
  CONFIRM_STEP_NUMBER_CLASS,
  CONFIRM_STEP_TITLE_CLASS,
  CONFIRM_STEPS_CLASS,
  CONFIRM_TARGET_CLASS,
} from "../confirmation-dialog-styles.ts";
import { DIALOG_BODY_CLASS } from "../typography-styles.ts";

export function FixIssueDialog({
  cluster,
  defaults,
  busy,
  onConfirm,
  onCancel,
}: {
  cluster: TicketCluster;
  /** Where the fix lands. Null is refused before this dialog ever opens. */
  defaults: FixIssueDefaultsView | null;
  busy: boolean;
  onConfirm: (targetBranch: string) => void;
  onCancel: () => void;
}) {
  const project = defaults?.projectId ?? "your default project";
  const defaultTarget = defaults?.targetBranch ?? "develop";
  const [targetBranch, setTargetBranch] = useState(defaultTarget);
  const target = targetBranch.trim() || "your chosen branch";
  const branch = cluster.actions["fix-issue"].branch;

  useEffect(() => {
    setTargetBranch(defaultTarget);
  }, [cluster.key, defaultTarget]);

  const steps: { title: string; detail: string }[] = [
    {
      title: "Read the ticket",
      detail: `${cluster.key} from Jira — summary, description and comments.`,
    },
    {
      title: "Check for work already done",
      detail:
        "An open merge request or an already-pushed branch is adopted and reported, not duplicated.",
    },
    {
      title: "Cut a branch",
      detail: branch
        ? `${branch}, off ${target} in ${project}.`
        : `Off ${target} in ${project}.`,
    },
    {
      title: "Attempt the fix",
      detail:
        "Claude works in an isolated container with no access to your machine, then commits and pushes as you.",
    },
    {
      title: "Open a draft merge request",
      detail: `Into ${target}, titled and described from what it changed, labelled from the ticket. Draft, so nobody can merge it before you have read it.`,
    },
    {
      title: "Move the ticket to CODE REVIEW",
      detail: "Best effort — a Jira workflow that refuses the transition is logged, not fatal.",
    },
  ];

  return (
    <Modal
      onClose={onCancel}
      className="sm:max-w-180"
      title={
        <>
          <Wrench size={15} strokeWidth={2} />
          Fix {cluster.key}
        </>
      }
    >
      {cluster.title ? <p className={DIALOG_BODY_CLASS}>{cluster.title}</p> : null}

      {/* The destination gets its own line above the steps, not a mention
          inside step three. It is the one thing that is not derivable from the
          ticket and the one thing that is expensive to get wrong. */}
      <p className={CONFIRM_TARGET_CLASS}>
        <GitBranch size={13} strokeWidth={2} />
        <span>
          <span className="mono">{project}</span>, off <span className="mono">{target}</span>
        </span>
      </p>

      <Field
        className="mt-3"
        label="Base and draft PR target branch"
        hint="The fix branch is cut from this branch, and the draft pull request targets it."
      >
        <Input
          className="w-full font-mono"
          value={targetBranch}
          placeholder="develop"
          disabled={busy}
          autoFocus
          onChange={(event) => setTargetBranch(event.target.value)}
        />
      </Field>

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
        You can stop it at any point from the ticket's panel on the canvas — a cancel aborts the
        container, but anything already pushed stays pushed.
      </p>

      <FormActions>
        <Button
          type="button"
          disabled={busy || targetBranch.trim() === ""}
          onClick={() => onConfirm(targetBranch.trim())}
        >
          {busy ? "Queueing…" : "Start the fix"}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </FormActions>
    </Modal>
  );
}
