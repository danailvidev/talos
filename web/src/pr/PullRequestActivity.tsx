import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Clock, LoaderCircle, Square, type LucideIcon } from "lucide-react";

import { api, type PullRequestActivityEntryView } from "../api.ts";
import { ago } from "../format.ts";
import { RunHistory } from "../runs/RunHistory.tsx";
import { ActivityLog } from "../Steps.tsx";
import { invalidate, queries } from "../queries.ts";
import { Tip } from "../Tip.tsx";
import { useApi } from "../useApi.ts";
import { useFormat } from "../FormatContext.tsx";
import { ACTION_META as META } from "./actionMeta.ts";
import { ErrorBox } from "../components/ui/query-state.tsx";
import { toMessage } from "../errors.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "../components/ui/button.tsx";

function activityTone(tone: string): string {
  if (tone === "waiting") return "text-[var(--warn)]";
  if (tone === "running") return "text-[var(--running)]";
  if (tone === "success") return "text-[var(--success)]";
  return "text-[var(--failure)]";
}

/** Same four job states the toolbar menu items know, minus `idle` — a history row always came from a real job. */
const STATUS_META: Record<
  "queued" | "running" | "done" | "failed",
  { icon: LucideIcon; tone: string; spin?: boolean }
> = {
  queued: { icon: Clock, tone: "waiting" },
  running: { icon: LoaderCircle, tone: "running", spin: true },
  done: { icon: CircleCheck, tone: "success" },
  failed: { icon: CircleAlert, tone: "failure" },
};

/**
 * What talos is doing on this merge request right now, and everything it has
 * done before — read from two sources on purpose.
 *
 * The pills on top come from the job queue and show only in-flight work, because
 * a job that is queued but not yet leased has no run row to page over yet: this
 * is the only view of "asked for, not started". Everything that actually ran is
 * owned by the run table below, which is keyed on the merge request rather than
 * on the queue and so also catches the jobs a loop queued here — work the
 * queue's own MR-keyed lookup never reported, since it matches manual clicks.
 *
 * The pills reuse the toolbar's markup and classes (`.pr-action-pill*`) rather
 * than a new list style: one action, one status, one log to expand into, same
 * as the toolbar always drew it.
 */
export function PullRequestActivity({ prId }: { prId: string }) {
  const fmt = useFormat();
  const queryClient = useQueryClient();
  // Polls itself at 1.5s while any entry is queued or running, and stops when
  // none is — see `queries.prActivity`. Cheap enough to poll because it reads
  // the job queue and never the forge.
  const activity = useApi(queries.prActivity(prId));
  /**
   * The whole job-queue half of this merge request, not just the feed above.
   *
   * Cancelling from here empties the toolbar's "already running" state and the
   * badge the listing draws from `active-actions`, and it closes a run the loop's
   * own history counts — so all four have to be told, or the merge request looks
   * busy everywhere except on this tab.
   */
  const refresh = () => {
    invalidate.prJobs(queryClient, prId);
    invalidate.jobQueue(queryClient);
  };
  const [expanded, setExpanded] = useState<string>();
  const [stopping, setStopping] = useState<string>();
  const [stopError, setStopError] = useState<string>();
  // Which run this tab has already auto-opened, so a poll tick that confirms
  // the same run is still going does not re-open a row the developer just
  // collapsed by hand.
  const autoExpandedRef = useRef<string | undefined>(undefined);

  // Only in-flight work: a finished attempt is a row in the run table below, and
  // drawing it in both places would report every run twice.
  const entries = (activity.data?.entries ?? []).filter(
    (entry) => entry.status === "running" || entry.status === "queued",
  );
  /** Which run, if any, the expanded pill's feed is following at 1 Hz. */
  const streamedExecutionId = entries.find(
    (entry, index) => (entry.jobId ?? `${entry.action}-${index}`) === expanded,
  )?.runId;

  /**
   * Stops one in-flight action.
   *
   * `cancelJob` rather than `cancelRun`, because a queued entry has no run yet
   * and cancelling only the run of a leased one lets the queue hand the work
   * straight to the next worker. The refetch that follows is what redraws the
   * pill away — the entry drops out of the list once the job is no longer queued
   * or leased.
   */
  async function stop(jobId: string) {
    setStopping(jobId);
    setStopError(undefined);
    try {
      await api.cancelJob(jobId);
      refresh();
    } catch (err) {
      setStopError(toMessage(err));
    } finally {
      setStopping(undefined);
    }
  }

  useEffect(() => {
    const latest = entries[0];
    if (!latest) return;
    const key = latest.jobId ?? `${latest.action}-0`;
    if (autoExpandedRef.current !== key) {
      autoExpandedRef.current = key;
      setExpanded(key);
    }
  }, [entries]);

  // Deliberately not gated on `activity.loading`: holding the whole tab back
  // until the queue answers would delay mounting the run table, and its fetch is
  // the slow one (it authorizes by reading the merge request from the forge). Both
  // requests start on mount instead, and each renders its own pending state — the
  // pills simply have nothing to draw until they do.
  return (
    <>
      {activity.error ? <ErrorBox>{activity.error}</ErrorBox> : null}
      {stopError ? <ErrorBox>{stopError}</ErrorBox> : null}
      {entries.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          {entries.map((entry: PullRequestActivityEntryView, index) => {
            const key = entry.jobId ?? `${entry.action}-${index}`;
            const open = expanded === key;
            const { icon: Icon, tone, spin } = STATUS_META[entry.status as keyof typeof STATUS_META];

            return (
              <div
                key={key}
                className="pr-action-pill-wrap overflow-hidden rounded-[var(--radius)] border border-border bg-[var(--bg-raised)]"
              >
                <div className="flex items-stretch">
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(
                      `pr-action-pill ${tone}`,
                      "h-auto min-w-0 flex-1 justify-start gap-2 rounded-none border-0 bg-transparent px-[11px] py-1.5 text-left font-[inherit] text-[0.8125rem] hover:bg-transparent disabled:cursor-default",
                      activityTone(tone),
                      open && "border-b border-border",
                    )}
                    disabled={!entry.runId}
                    onClick={() => setExpanded(open ? undefined : key)}
                  >
                    <Icon size={12} strokeWidth={2} className={spin ? "animate-spin" : ""} />
                    <span className="shrink-0 font-semibold">{META[entry.action].label}</span>
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground">
                      {entry.message ?? entry.status}
                    </span>
                    <Tip label={fmt.stamp(entry.startedAt)}>
                      <span className="ml-auto shrink-0 text-[var(--text-faint)]">
                        {ago(entry.startedAt)}
                      </span>
                    </Tip>
                  </Button>
                  {/* A sibling of the pill rather than a control inside it: the
                      pill is itself a button (it expands the log), and nesting
                      one in another is invalid and unclickable. Only in-flight
                      entries are listed here, so `jobId` present means there is
                      genuinely something to stop. */}
                  {entry.jobId ? (
                    <Tip label={entry.status === "queued" ? "Drop from the queue" : "Stop this run"}>
                      <Button
                        type="button"
                        variant="ghost"
                        className="w-7.5 shrink-0 rounded-none border-0 border-l border-border bg-transparent p-0 text-[var(--text-faint)] hover:bg-[color-mix(in_srgb,var(--failure)_14%,transparent)] hover:text-[var(--failure)] disabled:cursor-progress disabled:opacity-50"
                        disabled={stopping === entry.jobId}
                        aria-label={`Stop ${META[entry.action].label}`}
                        onClick={() => void stop(entry.jobId!)}
                      >
                        <Square size={11} strokeWidth={2.5} />
                      </Button>
                    </Tip>
                  ) : null}
                </div>
                {open && entry.runId ? <ActivityLog executionId={entry.runId} live /> : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <RunHistory
        // `entries` is already filtered to queued and running, so its being
        // non-empty *is* "there is work in flight" — which is what keeps the run
        // table ticking over long enough for a just-started run to appear in it.
        optionsFor={(page) => queries.prRuns(prId, page, { live: entries.length > 0 })}
        fetchKey={prId}
        title="Runs"
        streamedExecutionId={streamedExecutionId}
        onRunsChanged={refresh}
        emptyState={
          entries.length === 0 ? (
            <div className="px-5 py-7 text-center text-[0.9375rem] text-[var(--text-faint)]">
              No agent runs yet — start one from the Actions menu above.
            </div>
          ) : null
        }
      />
    </>
  );
}
