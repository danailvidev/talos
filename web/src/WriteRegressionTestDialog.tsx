import { FlaskConical, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";

import type { DatadogProblemView } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Field, FormActions } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import { Modal } from "./components/ui/modal.tsx";
import {
  CONFIRM_NOTE_CLASS,
  CONFIRM_STEP_CLASS,
  CONFIRM_STEP_DETAIL_CLASS,
  CONFIRM_STEP_NUMBER_CLASS,
  CONFIRM_STEP_TITLE_CLASS,
  CONFIRM_STEPS_CLASS,
  CONFIRM_TARGET_CLASS,
} from "./confirmation-dialog-styles.ts";
import { DIALOG_BODY_CLASS } from "./typography-styles.ts";

export function WriteRegressionTestDialog({
  problem,
  busy,
  onConfirm,
  onCancel,
}: {
  problem: DatadogProblemView;
  busy: boolean;
  onConfirm: (targetBranch: string) => void;
  onCancel: () => void;
}) {
  const target = problem.regressionTestTarget;
  const [targetBranch, setTargetBranch] = useState(target?.targetBranch ?? "");

  useEffect(() => {
    setTargetBranch(target?.targetBranch ?? "");
  }, [problem.key, target?.targetBranch]);

  const branch = targetBranch.trim() || "your chosen branch";
  const project = target?.projectId ?? "an unconfigured repository";
  const steps = [
    {
      title: "Read the production error",
      detail: "Use its signature, sample message, stack trace, service and environment.",
    },
    {
      title: "Check for existing work",
      detail: "Adopt an existing test branch or merge request instead of duplicating it.",
    },
    {
      title: "Inspect the repository",
      detail: `Clone ${project} from ${branch} and locate the code path that emits this error.`,
    },
    {
      title: "Write only the missing test",
      detail: "Add the smallest matching test. The agent is explicitly told not to fix production code.",
    },
    {
      title: "Run the test and report the verdict",
      detail:
        "A failing reproduction opens a draft merge request; a passing regression guard opens a normal one. If the code path cannot be identified, no change is invented.",
    },
  ];

  return (
    <Modal
      onClose={onCancel}
      className="sm:max-w-180"
      title={
        <>
          <FlaskConical size={15} strokeWidth={2} />
          Write a regression test
        </>
      }
    >
      <p className={DIALOG_BODY_CLASS}>{problem.title}</p>
      <p className={CONFIRM_TARGET_CLASS}>
        <GitBranch size={13} strokeWidth={2} />
        <span>
          <span className="mono">{project}</span>, off{" "}
          <span className="mono">{branch}</span>
        </span>
      </p>
      {target?.source === "user-default" ? (
        <p className="mt-2 text-sm text-[var(--warn)]">
          No repository is mapped for {problem.service ?? "this service"}; this uses
          your Pull Request defaults.
        </p>
      ) : null}
      {problem.aiTriage ? (
        <div className="mt-3 rounded-[var(--radius)] border border-border bg-[var(--bg-deep)] px-3 py-2.5 text-sm">
          <div className="font-semibold">
            AI triage: {problem.aiTriage.verdict} (
            {Math.round(problem.aiTriage.confidence * 100)}% confidence)
          </div>
          <p className="mt-1 mb-0 text-muted-foreground">{problem.aiTriage.rationale}</p>
          {problem.aiTriage.verdict !== "code" ? (
            <p className="mt-1.5 mb-0 text-[var(--warn)]">
              This does not look primarily code-related. You can continue explicitly;
              the agent will still decline rather than inventing an unrelated test.
            </p>
          ) : null}
        </div>
      ) : null}

      <Field
        className="mt-3"
        label="Base and merge request target branch"
        hint="This overrides the service default for this run only. The generated source branch still starts with test/."
      >
        <Input
          className="w-full font-mono"
          value={targetBranch}
          placeholder="main"
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
        The run and its live logs remain visible in Datadog → Activity. Every generated
        change still requires human review.
      </p>

      <FormActions>
        <Button
          type="button"
          disabled={busy || !target || !targetBranch.trim()}
          onClick={() => onConfirm(targetBranch.trim())}
        >
          {busy ? "Queueing…" : "Start writing the test"}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </FormActions>
    </Modal>
  );
}
