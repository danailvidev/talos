import { ExternalLink, GitPullRequest, TestTube2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { E2ePullRequestCandidateView, TicketCluster } from "../api.ts";
import { Button } from "../components/ui/button.tsx";
import { Field, FormActions } from "../components/ui/field.tsx";
import { Modal } from "../components/ui/modal.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.tsx";
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
import { defaultE2eCandidate } from "./e2e.ts";

function candidateId(candidate: E2ePullRequestCandidateView): string {
  return `${candidate.projectId}!${candidate.mrIid}`;
}

export function E2eTestDialog({
  cluster,
  busy,
  onConfirm,
  onCancel,
}: {
  cluster: TicketCluster;
  busy: boolean;
  onConfirm: (pullRequest: { projectId: string; mrIid: number }) => void;
  onCancel: () => void;
}) {
  const candidates = cluster.e2ePullRequests;
  const defaultCandidate = defaultE2eCandidate(candidates);
  const [selectedId, setSelectedId] = useState(
    defaultCandidate ? candidateId(defaultCandidate) : "",
  );
  useEffect(() => {
    setSelectedId(defaultCandidate ? candidateId(defaultCandidate) : "");
  }, [cluster.key, defaultCandidate?.projectId, defaultCandidate?.mrIid]);
  const selected = useMemo(
    () => candidates.find((candidate) => candidateId(candidate) === selectedId),
    [candidates, selectedId],
  );

  return (
    <Modal
      onClose={onCancel}
      className="sm:max-w-180"
      title={
        <>
          <TestTube2 size={15} strokeWidth={2} />
          E2E test {cluster.key}
        </>
      }
    >
      {cluster.title ? <p className={DIALOG_BODY_CLASS}>{cluster.title}</p> : null}
      <p className={CONFIRM_TARGET_CLASS}>
        <GitPullRequest size={13} strokeWidth={2} />
        <span>
          QA only
          {selected ? (
            <>
              {" · "}
              <a
                href={selected.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono hover:underline"
              >
                {selected.projectId}!{selected.mrIid}
                <ExternalLink size={11} />
              </a>
            </>
          ) : null}
        </span>
      </p>

      <Field
        className="mt-3"
        label="Linked merge request"
        hint="The newest linked merge request is selected by default."
      >
        <Select value={selectedId} onValueChange={setSelectedId} disabled={busy}>
          <SelectTrigger>
            <SelectValue placeholder="Choose a merge request" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((candidate) => (
              <SelectItem
                key={candidateId(candidate)}
                value={candidateId(candidate)}
              >
                {candidate.projectId}!{candidate.mrIid}
                {candidate.draft ? " · draft" : ""}
                {" · "}
                {candidate.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <ol className={CONFIRM_STEPS_CLASS}>
        {[
          {
            title: "Read the issue and changes",
            detail: "Build focused scenarios from Jira acceptance criteria, MR release notes and the Git diff.",
          },
          {
            title: "Start the merge request",
            detail: "Clone its source commit into an isolated browser-testing container.",
          },
          {
            title: "Load the QA instructions",
            detail: "Read the exploratory tester Markdown and URL/login fixtures from Test-Automation.",
          },
          {
            title: "Explore with Playwright",
            detail: "Open the configured QA URL, use protected login placeholders, capture screenshots and record diagnostics.",
          },
          {
            title: "Publish the verdict",
            detail: "Pass, fail or inconclusive results and evidence appear in this ticket’s Runs tab.",
          },
        ].map((step, index) => (
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
        The QA account may create and clean up ordinary test data, but the agent is instructed
        to avoid admin, billing, permission and irreversible actions. Stop the job from Runs.
      </p>

      <FormActions>
        <Button
          type="button"
          disabled={busy || !selected}
          onClick={() => {
            if (selected) {
              onConfirm({ projectId: selected.projectId, mrIid: selected.mrIid });
            }
          }}
        >
          {busy ? "Queueing…" : "Start E2E test"}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </FormActions>
    </Modal>
  );
}
