import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, LoaderCircle, Send } from "lucide-react";

import {
  api,
  type AssistantMessage,
  type PullRequestActionView,
  type TaskRunView,
} from "../api.ts";
import { Button } from "../components/ui/button.tsx";
import { ErrorBox, Loading } from "../components/ui/query-state.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { toMessage } from "../errors.ts";
import { invalidate, queries } from "../queries.ts";
import { useApi } from "../useApi.ts";
import { Markdown } from "./Markdown.tsx";

const REVISION_TASK_ID = "gitlab-mr-revision-one";
const HISTORY_LIMIT = 20;

interface RevisionTurn {
  id: string;
  instruction: string;
  response?: string;
  error?: string;
  status: TaskRunView["status"];
}

export function PullRequestRevisionChat({
  prId,
  action,
}: {
  prId: string;
  action?: PullRequestActionView;
}) {
  const queryClient = useQueryClient();
  const activity = useApi(queries.prActivity(prId));
  const live =
    activity.data?.entries.some(
      (entry) => entry.status === "queued" || entry.status === "running",
    ) ?? false;
  const runOptions = queries.prRuns(prId, { limit: 100, offset: 0 }, { live });
  // A transcript must never briefly show the previous MR while this one loads.
  const runs = useApi({ ...runOptions, placeholderData: undefined });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [optimistic, setOptimistic] = useState<string>();

  const turns = useMemo(
    () =>
      (runs.data?.runs ?? [])
        .filter((run) => run.taskId === REVISION_TASK_ID)
        .map(toRevisionTurn)
        .filter((turn): turn is RevisionTurn => turn != null)
        .reverse(),
    [runs.data?.runs],
  );

  useEffect(() => {
    if (optimistic && turns.some((turn) => turn.instruction === optimistic)) {
      setOptimistic(undefined);
    }
  }, [optimistic, turns]);

  const revisionInFlight =
    activity.data?.entries.some(
      (entry) =>
        entry.action === "revise" &&
        (entry.status === "queued" || entry.status === "running"),
    ) ?? false;
  const unavailableReason =
    action && !action.available ? action.unavailableReason : undefined;
  const blocked = sending || revisionInFlight || Boolean(unavailableReason);

  const send = async () => {
    const instruction = draft.trim();
    if (!instruction || blocked) return;
    setSending(true);
    setError(undefined);
    try {
      await api.runPullRequestRevision(prId, instruction, conversationHistory(turns));
      setDraft("");
      setOptimistic(instruction);
      invalidate.prJobs(queryClient, prId);
      invalidate.jobQueue(queryClient);
    } catch (cause) {
      setError(toMessage(cause));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  if (runs.loading && turns.length === 0) {
    return <Loading>Loading revision conversation…</Loading>;
  }

  return (
    <div className="flex min-h-[420px] flex-col">
      <div className="flex flex-1 flex-col gap-4 py-4">
        {turns.length === 0 && !optimistic ? (
          <div className="my-auto px-5 py-8 text-center text-sm text-muted-foreground">
            Ask the agent to adjust this merge request. Each turn starts a fresh isolated
            container on the latest source-branch head.
          </div>
        ) : null}

        {turns.map((turn) => (
          <RevisionTurnView key={turn.id} turn={turn} />
        ))}

        {optimistic ? (
          <RevisionTurnView
            turn={{
              id: "optimistic",
              instruction: optimistic,
              status: revisionInFlight ? "running" : "running",
            }}
          />
        ) : null}
      </div>

      {runs.error ? <ErrorBox>{runs.error}</ErrorBox> : null}
      {activity.error ? <ErrorBox>{activity.error}</ErrorBox> : null}
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <div className="sticky bottom-0 border-t border-border bg-background py-3">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="What should change in this merge request?"
          aria-label="Merge request revision instruction"
          rows={4}
          maxLength={20_000}
          disabled={blocked}
          className="min-h-24 resize-y"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {unavailableReason ??
              (revisionInFlight
                ? "A revision is running. Its live log is available under Runs."
                : "Enter to send · Shift+Enter for a new line")}
          </span>
          <Button
            type="button"
            onClick={() => void send()}
            disabled={blocked || !draft.trim()}
          >
            {sending || revisionInFlight ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : (
              <Send data-icon="inline-start" />
            )}
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

function RevisionTurnView({ turn }: { turn: RevisionTurn }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="ml-12 self-end rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
        <p className="whitespace-pre-wrap">{turn.instruction}</p>
      </div>
      <div className="mr-8 text-sm text-foreground">
        {turn.status === "running" ? (
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <LoaderCircle className="animate-spin" size={14} />
            Working in a container…
          </span>
        ) : turn.status === "failure" || turn.status === "cancelled" ? (
          <span className="inline-flex items-start gap-2 text-destructive">
            <AlertTriangle className="mt-0.5 shrink-0" size={14} />
            {turn.error ?? `Revision ${turn.status}.`}
          </span>
        ) : turn.response ? (
          <Markdown text={turn.response} className="text-sm" />
        ) : (
          <span className="text-muted-foreground">Finished without a response.</span>
        )}
      </div>
    </div>
  );
}

function toRevisionTurn(run: TaskRunView): RevisionTurn | undefined {
  const instruction = stringField(run.params, "instruction");
  if (!instruction) return undefined;
  return {
    id: run.executionId,
    instruction,
    status: run.status,
    ...(stringField(run.details, "response")
      ? { response: stringField(run.details, "response") }
      : {}),
    ...(run.error ? { error: run.error } : {}),
  };
}

function conversationHistory(turns: RevisionTurn[]): AssistantMessage[] {
  return turns
    .filter((turn) => turn.status === "success" && turn.response)
    .flatMap((turn) => [
      { role: "user" as const, content: turn.instruction },
      { role: "assistant" as const, content: turn.response! },
    ])
    .slice(-HISTORY_LIMIT);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}
