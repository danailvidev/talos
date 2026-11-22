/**
 * Run history, shared by the two places a run is worth reading about: a loop's
 * detail page (every run of that task) and a merge request's activity tab
 * (every run against that MR, whoever started it).
 *
 * The table takes the *query options* for a page rather than a task id because
 * those two callers page over different endpoints — `/api/tasks/:id/runs` and
 * `/api/pull-requests/:id/runs` — while rendering identical rows. Options rather
 * than a bare loader so each caller hands down a real cache key: paging back to
 * a page already seen is then free, and the poll policy lives with the endpoint
 * in `queries.ts` instead of being a timer in here.
 */
import { useQueryClient, type QueryKey, type UseQueryOptions } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AlertTriangle, ChevronRight, ExternalLink, MinusCircle, Square } from "lucide-react";

import {
  api,
  type LogLineView,
  type RunJiraOutcomeView,
  type TaskRunView,
} from "../api.ts";
import { queries } from "../queries.ts";
import type { PageParam } from "../query-keys.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.tsx";
import { Button } from "../components/ui/button.tsx";
import { cn } from "../lib/utils.ts";
import { SECTION_TITLE_CLASS } from "../typography-styles.ts";
import { ago } from "../format.ts";
import { JiraIcon } from "../JiraIcon.tsx";
import { StatusBadge } from "../StatusBadge.tsx";
import { RunLog, useIncrementalRunLogs } from "../Steps.tsx";
import { Tip } from "../Tip.tsx";
import { useFormat } from "../FormatContext.tsx";
import { useApi } from "../useApi.ts";
import { ErrorBox, Loading } from "../components/ui/query-state.tsx";
import { toMessage } from "../errors.ts";

export const RUNS_PER_PAGE = 15;

export interface RunPage {
  runs: TaskRunView[];
  total: number;
}

export function RunHistory<TKey extends QueryKey>({
  optionsFor,
  fetchKey,
  initialRuns,
  streamedExecutionId,
  currentExecutionId,
  title = "Run history",
  emptyState,
  onRunsChanged,
}: {
  /**
   * The query for one page — `queries.taskRuns(id, page)` or
   * `queries.prRuns(id, page)`. Both stop polling on their own once no row says
   * "running", so this component owns no timer.
   */
  optionsFor: (page: PageParam) => UseQueryOptions<RunPage, Error, RunPage, TKey>;
  /** Identifies what is being paged over; resets the page index when it changes. */
  fetchKey: string;
  /** Renders page 0 instantly when the caller already has the runs in hand. */
  initialRuns?: TaskRunView[];
  /**
   * A run whose log something else on this page is already streaming (the
   * activity feed above, typically). Its expanded row reads that same cache
   * entry instead of starting a second one-second poll against it.
   */
  streamedExecutionId?: string;
  /** The run displayed in the primary activity panel above this history. */
  currentExecutionId?: string;
  title?: string;
  /** Shown instead of nothing when there is no history at all. */
  emptyState?: React.ReactNode;
  /** Called after a cancel, so the caller can refresh whatever else it shows. */
  onRunsChanged?: () => void;
}) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string>();
  const options = optionsFor({ limit: RUNS_PER_PAGE, offset: page * RUNS_PER_PAGE });
  const { data, error, loading } = useApi(options);

  // Paging back to a different subject must not keep showing the old page index.
  useEffect(() => setPage(0), [fetchKey]);

  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: options.queryKey });
    onRunsChanged?.();
  };

  // Page 0 can render instantly from a payload already in hand; later pages
  // (and any run finishing since) come from the paginated fetch.
  const fallback = initialRuns ?? [];
  const runs = data?.runs ?? (page === 0 ? fallback.slice(0, RUNS_PER_PAGE) : []);
  const total = data?.total ?? fallback.length;

  // Until the first fetch lands there is no way to know whether this subject has
  // history, and guessing "none" flashes "no runs yet" every time the tab opens.
  // `loading` is specifically "nothing to show yet" (see `useApi`) rather
  // than "a request is in flight", so a poll tick keeps the current rows on
  // screen instead of dropping back to this — and a page change keeps the
  // previous page's rows, via the registry's `keepPreviousData`.
  if (loading && fallback.length === 0) {
    return (
      <section className="mb-5.5">
        <h2 className={SECTION_TITLE_CLASS}>{title}</h2>
        <Loading>Loading…</Loading>
      </section>
    );
  }

  // A failed fetch is not an empty history either — saying "no runs yet" would
  // hide the reason we cannot tell.
  if (error && !data) {
    return (
      <section className="mb-5.5">
        <h2 className={SECTION_TITLE_CLASS}>{title}</h2>
        <ErrorBox>{error}</ErrorBox>
      </section>
    );
  }

  if (total === 0) return emptyState ? <>{emptyState}</> : null;

  const lastPage = Math.max(0, Math.ceil(total / RUNS_PER_PAGE) - 1);
  const rangeStart = page * RUNS_PER_PAGE + 1;
  const rangeEnd = Math.min(total, rangeStart + runs.length - 1);

  return (
    <section className="mb-5.5">
      <h2 className={SECTION_TITLE_CLASS}>
        {title} ({total})
      </h2>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead aria-hidden="true" />
            <TableHead>Status</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Items</TableHead>
            <TableHead>Result</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <RunHistoryRow
              key={run.executionId}
              run={run}
              open={expanded === run.executionId}
              current={run.executionId === currentExecutionId}
              onToggle={() =>
                setExpanded((current) => (current === run.executionId ? undefined : run.executionId))
              }
              alreadyStreamed={run.executionId === streamedExecutionId}
              onRunsChanged={changed}
            />
          ))}
        </TableBody>
      </Table>
      <div className="flex items-center justify-between px-0.5 pt-2 text-[0.8125rem] text-[var(--text-faint)]">
        <span>{loading ? "Loading…" : `${rangeStart}–${rangeEnd} of ${total}`}</span>
        <div className="flex gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page >= lastPage}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </section>
  );
}

/**
 * What a job actually decided, distinct from "it ran without error". A job
 * whose agent found nothing to change succeeds — that is the correct outcome,
 * not a failure — but it must not look identical to one that opened a merge
 * request, or every "no-change" run reads as "where did my MR go".
 */
export function RunOutcome({ run }: { run: TaskRunView }) {
  const errors = agentErrorCount(run.details);
  // The chip sits *beside* whatever the run decided rather than replacing it: a
  // run can legitimately open a merge request after a command failed on the way,
  // and the outcome is still the merge request. What it must not do is read as
  // clean — the run this was added for concluded "already fixed" with a git
  // command failing underneath it, and the row said only "succeeded".
  if (errors === 0) return <OutcomeLabel run={run} />;
  return (
    <span className="inline-flex items-center gap-2">
      <OutcomeLabel run={run} />
      <Tip
        label={`${errors} of the agent's tool calls failed in this run — expand the row to read them.`}
      >
        <span className="inline-flex cursor-default items-center gap-1 text-[0.8125rem] whitespace-nowrap text-[var(--failure)]">
          <AlertTriangle size={12} strokeWidth={2} />
          {errors} failed
        </span>
      </Tip>
    </span>
  );
}

function OutcomeLabel({ run }: { run: TaskRunView }) {
  const details = run.details;
  const action = typeof details?.action === "string" ? details.action : undefined;
  const mrUrl = typeof details?.mrUrl === "string" ? details.mrUrl : undefined;
  const mrIid = typeof details?.mrIid === "number" ? details.mrIid : undefined;
  const noteUrl = typeof details?.noteUrl === "string" ? details.noteUrl : undefined;
  const summary = outcomeSummary(details);

  // No named outcome — either an older run, from before the handlers recorded
  // one, or a task that never has anything interesting to say. The counters
  // still do: nothing processed and something skipped is a skip, and saying so
  // beats a blank cell that reads as a run which silently failed.
  if (!action) {
    if (!run.itemsProcessed && run.itemsSkipped) return <DidNothing label="skipped" summary={summary} />;
    return <>—</>;
  }

  if (action === "reviewed" && noteUrl) {
    return (
      <a
        className="inline-flex items-center gap-1 text-[0.8125rem] whitespace-nowrap text-[var(--success)] hover:underline"
        href={noteUrl}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
      >
        <ExternalLink size={12} strokeWidth={2} />
        review posted
      </a>
    );
  }

  if ((action === "opened" || action === "adopted") && mrUrl) {
    return (
      <a
        className="inline-flex items-center gap-1 text-[0.8125rem] whitespace-nowrap text-[var(--success)] hover:underline"
        href={mrUrl}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
      >
        <ExternalLink size={12} strokeWidth={2} />
        {mrIid != null ? `!${mrIid}` : "merge request"}
        {action === "adopted" ? " (existing)" : ""}
      </a>
    );
  }

  if (action === "triaged") {
    const verdict =
      typeof details?.verdict === "string" ? details.verdict.replaceAll("-", " ") : "complete";
    const confidence =
      typeof details?.confidence === "number"
        ? ` · ${Math.round(details.confidence * 100)}%`
        : "";
    return summary ? (
      <Tip label={summary}>
        <span className="font-medium capitalize text-foreground">
          {verdict}
          {confidence}
        </span>
      </Tip>
    ) : (
      <span className="capitalize">{verdict}</span>
    );
  }

  const label = OUTCOME_LABELS[action] ?? action;
  if (DID_NOTHING_ACTIONS.has(action)) {
    return <DidNothing label={label} summary={summary} />;
  }

  return summary ? (
    <Tip label={summary}>
      <span>{label}</span>
    </Tip>
  ) : (
    <>{label}</>
  );
}

/**
 * A run that completed and chose not to act. Deliberately drawn the same way as
 * "no change" — it is a legitimate outcome, not a failure — but it must say so
 * and say why, because a one-second success with a blank Result column is
 * indistinguishable from a run that silently failed.
 */
function DidNothing({ label, summary }: { label: string; summary?: string }) {
  return (
    <Tip label={summary ?? "The run completed without needing to do anything."}>
      <span className="inline-flex cursor-default items-center gap-1 text-[0.8125rem] whitespace-nowrap text-[var(--warn)]">
        <MinusCircle size={12} strokeWidth={2} />
        {label}
      </span>
    </Tip>
  );
}

/**
 * The run's own explanation of its outcome. `note` is the older spelling, still
 * present in history written before handlers standardised on `summary`.
 */
/**
 * How many of the agent's tool calls failed, as the handlers record it. Absent on
 * every run written before `agentErrors` existed, which reads as none rather than
 * as zero-known-to-be-true; there is nothing better to say about those.
 */
function agentErrorCount(details?: Record<string, unknown>): number {
  const value = details?.agentErrors;
  return typeof value === "number" && value > 0 ? value : 0;
}

function outcomeSummary(details?: Record<string, unknown>): string | undefined {
  if (typeof details?.summary === "string") return details.summary;
  if (typeof details?.note === "string") return details.note;
  if (typeof details?.reason === "string") return details.reason;
  return undefined;
}

/** Outcomes where the run ran to completion and chose not to act. */
const DID_NOTHING_ACTIONS = new Set([
  "already-claimed",
  "already-reviewed",
  "dry-run",
  "no-change",
  "no-commit",
  "nothing-pending",
  "skipped",
]);

/** Wording for the actions jobs record, so the Result column never shows a raw slug. */
const OUTCOME_LABELS: Record<string, string> = {
  "already-claimed": "already claimed",
  "already-reviewed": "already reviewed",
  "dry-run": "dry run",
  "no-commit": "no head commit",
  "no-change": "no change",
  "nothing-pending": "nothing pending",
  "partly-resolved": "partly resolved",
  resolved: "resolved",
  replied: "replied",
  reviewed: "reviewed",
};

/**
 * Stops a run in flight. Sits beside the row's `running` badge rather than
 * inside the expanded detail, for the same reason the task header puts it beside
 * that page's badge (`TaskDetail`'s `Head`): the thing you want to stop is the
 * thing the badge is describing, and you should not have to expand a row — or
 * know that expanding it does anything — to find the stop button.
 */
function CancelRunButton({
  run,
  onRunsChanged,
}: {
  run: TaskRunView;
  onRunsChanged?: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [failed, setFailed] = useState<string>();

  if (run.status !== "running") return null;

  const cancel = async (event: React.MouseEvent) => {
    // The whole row is a toggle; cancelling must not also expand it.
    event.stopPropagation();
    setCancelling(true);
    setFailed(undefined);
    try {
      await api.cancelRun(run.executionId);
      onRunsChanged?.();
    } catch (cause) {
      setFailed(toMessage(cause));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <Tip label={failed ?? (cancelling ? "Cancelling…" : "Cancel run and stop its containers")}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className={cn(
          "size-5 rounded-[5px] text-[var(--text-faint)] hover:translate-y-0 hover:bg-[var(--status-danger-wash)] hover:text-[var(--status-danger-strong)]",
          failed && "bg-[var(--status-danger-wash)] text-[var(--status-danger-strong)]",
        )}
        aria-label="Cancel run"
        disabled={cancelling}
        onClick={cancel}
      >
        <Square size={11} strokeWidth={2.5} />
      </Button>
    </Tip>
  );
}

export function RunHistoryRow({
  run,
  open,
  current = false,
  onToggle,
  alreadyStreamed,
  onRunsChanged,
}: {
  run: TaskRunView;
  open: boolean;
  current?: boolean;
  onToggle: () => void;
  /** See `RunHistory`'s `streamedExecutionId`. */
  alreadyStreamed?: boolean;
  onRunsChanged?: () => void;
}) {
  const fmt = useFormat();

  return (
    <>
      <TableRow
        className={cn(
          "cursor-pointer",
          current && "bg-muted shadow-[inset_2px_0_0_var(--action)] hover:bg-muted",
        )}
        aria-current={current ? "true" : undefined}
        aria-expanded={open}
        onClick={onToggle}
      >
        <TableCell>
          <ChevronRight
            className={cn(
              "text-[var(--text-faint)] transition-transform",
              open && "rotate-90",
            )}
            size={14}
            strokeWidth={2}
          />
        </TableCell>
        <TableCell>
          <span className="inline-flex items-center gap-1">
            <StatusBadge status={run.status}>{run.status}</StatusBadge>
            <CancelRunButton run={run} onRunsChanged={onRunsChanged} />
          </span>
        </TableCell>
        <TableCell className="mono">
          <Tip label={fmt.stamp(run.startedAt)}>
            <span>{ago(run.startedAt)}</span>
          </Tip>
        </TableCell>
        <TableCell>{fmt.duration(run.durationMs)}</TableCell>
        <TableCell>{run.itemsProcessed ?? run.itemsSeen ?? "—"}</TableCell>
        <TableCell className="whitespace-normal">
          {run.error ? (
            <Tip label={run.error}>
              <div className="mono max-w-95 overflow-hidden text-left text-ellipsis whitespace-nowrap [direction:rtl]">
                {run.error}
              </div>
            </Tip>
          ) : (
            <RunOutcome run={run} />
          )}
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6}>
            <RunDetail run={run} alreadyStreamed={alreadyStreamed} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

/** One `filed TP-3023 spec/foo.spec.ts` outcome from a ci-failure run's result summary. */
interface RunJiraTicket {
  action: string;
  issueKey: string;
  issueUrl?: string;
  assignee?: string;
  file: string;
}

/**
 * Pulls the per-run Jira ticket outcomes out of the run's own log lines.
 *
 * There is no `executionId` column on `work_subjects` (tickets are tracked per
 * loop, not per run), so the only durable per-run record is the
 * result details the ci-failure task logs on its final "task … succeeded" line.
 * New runs carry structured links and assignees; `details.issues` remains the
 * string-only fallback for old history. Both include `unchanged` outcomes, which
 * identify an existing ticket without mutating Jira.
 */
export function jiraTicketOutcomesFromLogs(logs: LogLineView[]): RunJiraTicket[] {
  const finalLine = [...logs].reverse().find((line) => {
    const details = line.meta?.details as
      | { ticketOutcomes?: unknown; issues?: unknown }
      | undefined;
    return Array.isArray(details?.ticketOutcomes) || Array.isArray(details?.issues);
  });
  const details = finalLine?.meta?.details as
    | { ticketOutcomes?: unknown[]; issues?: string[] }
    | undefined;

  if (Array.isArray(details?.ticketOutcomes)) {
    return details.ticketOutcomes.flatMap((entry) => {
      if (entry == null || typeof entry !== "object") return [];
      const outcome = entry as Record<string, unknown>;
      if (
        typeof outcome.action !== "string" ||
        typeof outcome.issueKey !== "string" ||
        typeof outcome.file !== "string"
      ) {
        return [];
      }
      return [{
        action: outcome.action,
        issueKey: outcome.issueKey,
        file: outcome.file,
        ...(typeof outcome.issueUrl === "string" ? { issueUrl: outcome.issueUrl } : {}),
        ...(typeof outcome.assignee === "string" ? { assignee: outcome.assignee } : {}),
      }];
    });
  }

  return (details?.issues ?? []).flatMap((entry) => {
    const match = entry.match(/^(\S+)\s+(\S+)\s+(.*)$/);
    if (!match) return [];
    const [, action, issueKey, file] = match;
    return [{ action, issueKey, file } as RunJiraTicket];
  });
}

export function mergeJiraOutcomeDetails(
  recorded: RunJiraTicket[],
  enriched: RunJiraOutcomeView[],
): RunJiraTicket[] {
  const byKey = new Map(enriched.map((outcome) => [outcome.issueKey, outcome]));
  return recorded.map((outcome) => ({
    ...outcome,
    ...(byKey.get(outcome.issueKey) ?? {}),
  }));
}

/**
 * Expanded run detail: the params it ran with, any Jira ticket outcomes, and
 * its full activity log. Cancelling lives on the row itself — see
 * `CancelRunButton` — so it is reachable without expanding anything.
 */
export function RunDetail({
  run,
  alreadyStreamed,
}: {
  run: TaskRunView;
  /** See `RunHistory`'s `streamedExecutionId`. */
  alreadyStreamed?: boolean;
}) {
  const fmt = useFormat();
  const params = run.params as { jira?: { project?: string }; gitlab?: { projectId?: string } } | undefined;
  const live = run.status === "running";
  // A feed elsewhere on the page already owns this run's cursor poll.
  const { data, error } = useApi(queries.runSteps(run.executionId));
  const feed = useIncrementalRunLogs(run.executionId, data?.logs, live && !alreadyStreamed);
  const logs = feed.logs;
  const ticketOutcomes = jiraTicketOutcomesFromLogs(logs);
  const needsJiraEnrichment = ticketOutcomes.some(
    (outcome) => !outcome.issueUrl || !outcome.assignee,
  );
  const jiraOutcomes = useApi(
    queries.runJiraOutcomes(run.executionId, needsJiraEnrichment),
  );
  const resolvedTicketOutcomes = mergeJiraOutcomeDetails(
    ticketOutcomes,
    jiraOutcomes.data?.outcomes ?? [],
  );
  const action = typeof run.details?.action === "string" ? run.details.action : undefined;
  const summary = outcomeSummary(run.details);
  const mrUrl = typeof run.details?.mrUrl === "string" ? run.details.mrUrl : undefined;
  const mrIid = typeof run.details?.mrIid === "number" ? run.details.mrIid : undefined;
  const noteUrl = typeof run.details?.noteUrl === "string" ? run.details.noteUrl : undefined;
  const triageVerdict =
    action === "triaged" && typeof run.details?.verdict === "string"
      ? run.details.verdict
      : undefined;
  const triageConfidence =
    action === "triaged" && typeof run.details?.confidence === "number"
      ? run.details.confidence
      : undefined;
  const recommendation =
    action === "triaged" && typeof run.details?.recommendation === "string"
      ? run.details.recommendation
      : undefined;
  // A run that chose not to act explains itself here too, so the reason a
  // one-second run did nothing is readable without hovering the row. Mirrors the
  // counter fallback in `RunOutcome` for history written before `action` existed.
  const explained = action != null
    ? DID_NOTHING_ACTIONS.has(action)
    : !run.itemsProcessed && !!run.itemsSkipped;
  const errors = agentErrorCount(run.details);

  return (
    <div className="flex flex-col gap-2.5 py-1 pb-2.5 [&_.activity-log-body]:min-h-30 [&_.activity-log-body]:max-h-80">
      {triageVerdict ? (
        <div className="rounded-[var(--radius)] border border-border bg-[var(--bg-deep)] px-3 py-2.5 text-sm">
          <div className="font-semibold capitalize text-foreground">
            AI triage: {triageVerdict.replaceAll("-", " ")}
            {triageConfidence != null
              ? ` · ${Math.round(triageConfidence * 100)}% confidence`
              : ""}
          </div>
          {summary ? <p className="mt-1 mb-0 text-muted-foreground">{summary}</p> : null}
          {recommendation ? (
            <p className="mt-1.5 mb-0 text-muted-foreground">
              <strong className="text-foreground">Recommended next step:</strong>{" "}
              {recommendation}
            </p>
          ) : null}
        </div>
      ) : null}
      {explained && summary ? (
        <div className="flex items-center gap-1.5 py-1.5 pb-2.5 text-sm text-[var(--warn)]">
          <MinusCircle size={14} strokeWidth={2} />
          <span>
            {action === "no-change" ? `No change was needed — ${summary}` : summary}
          </span>
        </div>
      ) : null}
      {errors > 0 ? (
        <div className="flex items-center gap-1.5 text-sm text-[var(--failure)]">
          <AlertTriangle size={14} strokeWidth={2} />
          <span>
            {errors} of the agent's tool calls failed in this run
            {explained ? " — read them below before trusting the verdict above" : ""}
          </span>
        </div>
      ) : null}
      {action === "reviewed" && noteUrl ? (
        <div className="flex items-center gap-1.5 py-1.5 pb-2.5 text-sm">
          <a
            className="inline-flex items-center gap-1.5 text-[var(--success)] hover:underline"
            href={noteUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={14} strokeWidth={2} />
            Review comment{mrIid != null ? ` on !${mrIid}` : ""}
          </a>
        </div>
      ) : null}
      {(action === "opened" || action === "adopted") && mrUrl ? (
        <div className="flex items-center gap-1.5 py-1.5 pb-2.5 text-sm">
          <a
            className="inline-flex items-center gap-1.5 text-[var(--success)] hover:underline"
            href={mrUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={14} strokeWidth={2} />
            {mrIid != null ? `!${mrIid}` : "Merge request"}
            {action === "adopted" ? " (already open)" : ""}
          </a>
        </div>
      ) : null}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-[3px] text-[0.8125rem] [&_dd]:m-0 [&_dd]:text-[var(--text-dim)] [&_dt]:text-[var(--text-faint)]">
        <dt>Execution</dt>
        <dd className="mono">{run.executionId}</dd>
        <dt>Started</dt>
        <dd className="mono">{fmt.stamp(run.startedAt)}</dd>
        {run.finishedAt ? (
          <>
            <dt>Finished</dt>
            <dd className="mono">{fmt.stamp(run.finishedAt)}</dd>
          </>
        ) : null}
        <dt>Mode</dt>
        <dd>{run.dryRun ? "dry run" : "live"}</dd>
        {params?.gitlab?.projectId ? (
          <>
            <dt>GitLab project</dt>
            <dd className="mono">{params.gitlab.projectId}</dd>
          </>
        ) : null}
        {params?.jira?.project ? (
          <>
            <dt>Jira project</dt>
            <dd className="mono">{params.jira.project}</dd>
          </>
        ) : null}
      </dl>

      {resolvedTicketOutcomes.length > 0 ? (
        <div>
          <h3 className="mb-1.5 text-[0.7812rem] font-semibold tracking-[0.5px] text-[var(--text-faint)] uppercase">
            Jira ticket outcomes
          </h3>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {resolvedTicketOutcomes.map((ticket, index) => (
              <li
                className="flex items-center gap-1.5 text-[0.8125rem] text-[var(--text-dim)]"
                key={`${ticket.issueKey}-${index}`}
              >
                <span className="text-[var(--text-faint)] capitalize">{ticket.action}</span>
                <JiraIcon size={12} />
                {ticket.issueUrl ? (
                  <a
                    className="mono inline-flex items-center gap-1 text-foreground hover:underline"
                    href={ticket.issueUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {ticket.issueKey}
                    <ExternalLink size={10} strokeWidth={2} />
                  </a>
                ) : (
                  <span className="mono">{ticket.issueKey}</span>
                )}
                {ticket.assignee ? (
                  <span className="text-[var(--text-faint)]">Assignee: {ticket.assignee}</span>
                ) : null}
                <span className="mono max-w-80 overflow-hidden text-left text-ellipsis whitespace-nowrap text-[var(--text-faint)] [direction:rtl]">
                  {ticket.file}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <RunLog
        lines={logs}
        live={live}
        hasOlder={feed.hasOlder}
        loadingOlder={feed.loadingOlder}
        onLoadOlder={() => void feed.loadOlder()}
      />
    </div>
  );
}
