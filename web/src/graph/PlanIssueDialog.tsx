/**
 * What "Plan this issue" is about to do, before it does it.
 *
 * A quieter sibling of `FixIssueDialog`, and the difference is the whole point: no
 * branch, no commit, no merge request. The container it starts runs with the write
 * policy set to `none`, which hands the agent `Read,Grep,Glob` and nothing else — so
 * "it cannot change anything" is a property of the sandbox rather than a promise about
 * the prompt, and this dialog says so where the developer is deciding.
 *
 * It still asks for a branch, because a plan is written against one: the agent clones
 * and reads that branch, and the branch it read is the branch the approved fix is
 * later cut from.
 *
 * The steps are the real pipeline in `src/tasks/plan-jira-issue/index.ts`, in order,
 * not a friendly paraphrase. If that pipeline changes, this list is wrong and should be
 * changed with it — it is documentation shown at the moment it matters, and a list that
 * drifts is worse than no list.
 */
import { GitBranch, ListChecks } from "lucide-react";
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

export function PlanIssueDialog({
  cluster,
  defaults,
  busy,
  onConfirm,
  onCancel,
}: {
  cluster: TicketCluster;
  /** Which repository is read. Null is refused before this dialog ever opens. */
  defaults: FixIssueDefaultsView | null;
  busy: boolean;
  onConfirm: (targetBranch: string) => void;
  onCancel: () => void;
}) {
  const project = defaults?.projectId ?? "your default project";
  const defaultTarget = defaults?.targetBranch ?? "develop";
  const [targetBranch, setTargetBranch] = useState(defaultTarget);
  const target = targetBranch.trim() || "your chosen branch";

  useEffect(() => {
    setTargetBranch(defaultTarget);
  }, [cluster.key, defaultTarget]);

  const steps: { title: string; detail: string }[] = [
    {
      title: "Read the ticket",
      detail: `${cluster.key} from Jira — summary, description and comments.`,
    },
    {
      title: "Read the code",
      detail: `A read-only checkout of ${project} at ${target}. The agent can open and search files; it has no shell and no way to write one.`,
    },
    {
      title: "Write a plan",
      detail:
        "What it would change, which files it expects to touch, what it is unsure about, and how the change should be verified. If the ticket cannot be planned, it says that instead of inventing a plan.",
    },
    {
      title: "Hand it back to you",
      detail:
        "The plan is stored here, outside the container, and the container exits. The ticket turns gold and the bell rings; nothing else happens on its own.",
    },
    {
      title: "You review it",
      detail:
        "Read it in this panel's Plan tab, edit any line of it, then approve or reject. Approving is what starts the fix — with your edited text as its instructions.",
    },
  ];

  return (
    <Modal
      onClose={onCancel}
      className="sm:max-w-180"
      title={
        <>
          <ListChecks size={15} strokeWidth={2} />
          Plan {cluster.key}
        </>
      }
    >
      {cluster.title ? <p className={DIALOG_BODY_CLASS}>{cluster.title}</p> : null}

      <p className={CONFIRM_TARGET_CLASS}>
        <GitBranch size={13} strokeWidth={2} />
        <span>
          reads <span className="mono">{project}</span> at <span className="mono">{target}</span>
        </span>
      </p>

      <Field
        className="mt-3"
        label="Branch to plan against"
        hint="The agent reads this branch, and an approved plan is implemented off it."
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
        Nothing is committed, pushed or opened as a merge request by this run. Approving the plan
        afterwards is what does that.
      </p>

      <FormActions>
        <Button
          type="button"
          disabled={busy || targetBranch.trim() === ""}
          onClick={() => onConfirm(targetBranch.trim())}
        >
          {busy ? "Queueing…" : "Write the plan"}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </FormActions>
    </Modal>
  );
}
