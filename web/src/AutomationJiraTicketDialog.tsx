import { type FormEvent, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, LoaderCircle, X } from "lucide-react";

import {
  api,
  type AutomationTicketActionView,
  type AutomationTicketDraftView,
} from "./api.ts";
import { invalidate, queries } from "./queries.ts";
import { useAction } from "./useAction.ts";
import { useApi } from "./useApi.ts";
import { JiraIcon } from "./JiraIcon.tsx";
import { Button } from "./components/ui/button.tsx";
import { Field, FormActions } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import { Modal } from "./components/ui/modal.tsx";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import { Textarea } from "./components/ui/textarea.tsx";

export function AutomationJiraTicketDialog({
  pipelineId,
  signatureKey,
  onClose,
  onCreated,
}: {
  pipelineId: number;
  signatureKey: string;
  onClose: () => void;
  onCreated?: (result: AutomationTicketActionView) => void;
}) {
  const draft = useApi(
    queries.automationFailureTicketDraft(pipelineId, signatureKey),
  );

  return (
    <Modal
      onClose={onClose}
      title={
        <>
          <JiraIcon size={18} />
          Create Jira ticket
        </>
      }
      className="max-w-2xl"
      titleActions={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close Jira ticket dialog"
        >
          <X />
        </Button>
      }
    >
      {!draft.data && draft.loading ? (
        <Loading>Preparing Jira ticket…</Loading>
      ) : !draft.data && draft.error ? (
        <ErrorBox>{draft.error}</ErrorBox>
      ) : draft.data ? (
        <TicketForm
          key={`${pipelineId}:${signatureKey}`}
          pipelineId={pipelineId}
          signatureKey={signatureKey}
          draft={draft.data}
          onClose={onClose}
          onCreated={onCreated}
        />
      ) : null}
    </Modal>
  );
}

function TicketForm({
  pipelineId,
  signatureKey,
  draft,
  onClose,
  onCreated,
}: {
  pipelineId: number;
  signatureKey: string;
  draft: AutomationTicketDraftView;
  onClose: () => void;
  onCreated?: (result: AutomationTicketActionView) => void;
}) {
  const queryClient = useQueryClient();
  const create = useAction();
  const [summary, setSummary] = useState(draft.summary);
  const [description, setDescription] = useState(draft.description);
  const [parentKey, setParentKey] = useState(draft.parentKey ?? "");
  const [result, setResult] = useState<AutomationTicketActionView>();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    create.run(async () => {
      const normalizedSummary = summary.trim();
      const normalizedDescription = description.trim();
      const normalizedParent = parentKey.trim().toUpperCase();
      if (!normalizedSummary) throw new Error("Title is required.");
      if (!normalizedDescription) throw new Error("Description is required.");
      if (
        normalizedParent &&
        !/^[A-Z][A-Z0-9_]*-\d+$/.test(normalizedParent)
      ) {
        throw new Error("Parent ticket must be a Jira issue key such as TP-123.");
      }
      const created = await api.createAutomationFailureTicket(
        pipelineId,
        signatureKey,
        {
          summary: normalizedSummary,
          description: normalizedDescription,
          parentKey: normalizedParent || null,
        },
      );
      await invalidate.automationFailureTriage(queryClient, pipelineId, [
        signatureKey,
      ]);
      setResult(created);
      onCreated?.(created);
    });
  };

  if (result) {
    return (
      <div className="grid gap-4 pt-2">
        <p className="text-sm text-muted-foreground">
          {result.jiraKey
            ? `${result.jiraKey} is ready for this failure.`
            : `Ticket action completed: ${result.action}.`}
        </p>
        {result.jiraUrl ? (
          <a
            className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            href={result.jiraUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open {result.jiraKey ?? "ticket"} in Jira
            <ExternalLink className="size-4" />
          </a>
        ) : null}
        <FormActions>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </FormActions>
      </div>
    );
  }

  return (
    <form className="grid gap-4 pt-2" onSubmit={handleSubmit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Project">
          <Input value={draft.projectKey} readOnly aria-readonly="true" />
        </Field>
        <Field label="Parent ticket" hint="Optional">
          <Input
            value={parentKey}
            maxLength={64}
            placeholder="e.g. TP-123"
            onChange={(event) => setParentKey(event.currentTarget.value)}
          />
        </Field>
      </div>
      <Field label="Title">
        <Input
          value={summary}
          maxLength={255}
          autoFocus
          onChange={(event) => setSummary(event.currentTarget.value)}
        />
      </Field>
      <Field
        label="Description"
        hint="Failure diagnostics, links, and tracking metadata are appended automatically."
      >
        <Textarea
          className="min-h-36"
          value={description}
          maxLength={4000}
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
      </Field>
      {create.error ? <ErrorBox>{create.error}</ErrorBox> : null}
      <FormActions>
        <Button type="submit" disabled={create.busy}>
          {create.busy ? (
            <>
              <LoaderCircle className="animate-spin" />
              Creating…
            </>
          ) : (
            "Create Jira ticket"
          )}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={create.busy}
          onClick={onClose}
        >
          Cancel
        </Button>
      </FormActions>
    </form>
  );
}
