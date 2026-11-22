import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";

import { api, type PullRequestActionId, type PullRequestActionView } from "../api.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { invalidate, queries, refresh } from "../queries.ts";
import { keys } from "../query-keys.ts";
import { useApi } from "../useApi.ts";
import { ACTION_META as META, ACTION_ORDER as ORDER } from "./actionMeta.ts";
import { ErrorBox } from "../components/ui/query-state.tsx";
import { toMessage } from "../errors.ts";
import { Button } from "../components/ui/button.tsx";

/**
 * The three things a developer can hand to an agent, in the order they unblock a
 * merge request: get it merging, answer what reviewers asked, then have it read.
 *
 * Each button only queues a job — the work happens in a container, minutes
 * later — and keeps polling long enough to know whether a run is already in
 * flight (so a menu item can grey itself out), but the run's own state lives
 * entirely on the Activity tab now; a click sends the developer there rather
 * than drawing a second status line here.
 */

export function PullRequestActions({
  prId,
  actions,
  onAction,
}: {
  prId: string;
  /** From the detail response: live state *and* whether each button applies. */
  actions: PullRequestActionView[];
  /**
   * Fired once a click resolved either way (queued, or refused as already
   * running) — never on a request error. The Activity tab is the only place
   * a run's state shows now, so a click has to send the developer there
   * rather than leave them looking at the toolbar for a status that no
   * longer appears next to it.
   */
  onAction?: () => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<PullRequestActionId>();
  const [error, setError] = useState<string>();

  // The job-queue half, keyed on the merge request — so switching to another one
  // never shows its neighbour's run, and this stops polling itself once nothing
  // is queued or running (see `queries.prActions`). Its errors are deliberately
  // ignored: a failed tick is not worth a banner over a run that is still going.
  const queue = useApi(queries.prActions(prId));

  /**
   * The one thing the polling above cannot tell this menu: an action that just
   * finished may no longer *apply*.
   *
   * Availability comes only from the detail request, which is never polled — so a
   * resolve-conflicts run that succeeded left the merge request mergeable on the
   * forge while this menu still offered to rebase it, until somebody pressed
   * refresh. Hooked to the falling edge of `live` rather than to a run's status
   * because that is the moment the forge's answer changed, and it fires once:
   * `live` is false from then on. `refresh.pullRequest` rather than an invalidate,
   * since the server holds its own 30s entry for this merge request and a plain
   * refetch would be served the very state this is correcting.
   *
   * The run history goes with it: a job that finished in less time than that
   * table's own tick would otherwise never have appeared in it.
   */
  const live = queue.data?.live ?? false;
  const watched = useRef({ prId, live });
  useEffect(() => {
    const previous = watched.current;
    watched.current = { prId, live };
    // Scoped to the same merge request: selecting another row swaps this
    // component's props while its refs persist, and "the last one was busy" says
    // nothing about the new one.
    if (previous.prId !== prId || !previous.live || live) return;
    refresh.pullRequest(queryClient, prId);
    void queryClient.invalidateQueries({ queryKey: keys.allPrRuns(prId) });
  }, [live, prId, queryClient]);

  const state = (action: PullRequestActionId): PullRequestActionView => {
    const base = actions.find((candidate) => candidate.action === action);
    const fresh = queue.data?.actions.find((candidate) => candidate.action === action);
    // Availability is only ever answered by the detail request (it needs the merge
    // request itself), so the queue contributes job state and nothing else.
    return { available: false, ...base, ...(fresh ?? {}) } as PullRequestActionView;
  };

  const run = async (action: PullRequestActionId) => {
    // Close before the request: the click's result lives on the Activity tab,
    // and a menu left open paints over the tab switch this is about to make.
    setOpen(false);
    setBusy(action);
    setError(undefined);
    try {
      await api.runPullRequestAction(prId, action);
      // Read the queue straight back rather than guessing a state: this is also
      // what turns the poll on, since `live` comes from what it returns. Awaited
      // so the Activity tab this click switches to is already showing the run.
      await queryClient.invalidateQueries({ queryKey: keys.prActions(prId) });
      // The rest of the merge request's job state — the activity feed the click is
      // about to land on, the listing's badge — plus the job queue itself, since
      // this queued work the footer counts.
      invalidate.prJobs(queryClient, prId);
      invalidate.jobQueue(queryClient);
      // Whether this click queued a fresh job or found one already running (the
      // loop got there first), the Activity tab is where that now shows up.
      onAction?.();
    } catch (failure: unknown) {
      setError(toMessage(failure));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="flex flex-col items-end">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="h-auto gap-1.5 rounded-md border-[color-mix(in_srgb,var(--action)_45%,var(--border))] bg-[color-mix(in_srgb,var(--action)_10%,transparent)] px-[13px] py-[7px] text-sm font-medium text-foreground hover:border-action hover:bg-action/20 data-[state=open]:border-action data-[state=open]:bg-action/20"
          >
            {busy ? <LoaderCircle size={13} strokeWidth={2} className="animate-spin" /> : null}
            Actions
            <ChevronDown size={13} strokeWidth={2} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="z-50 min-w-65 rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] p-1.5 shadow-[var(--shadow-panel)]"
          align="start"
          sideOffset={6}
        >
          {ORDER.map((action) => {
            const current = state(action);
            const { label, icon: Icon, blurb } = META[action];
            const inFlight =
              busy === action || current.status === "queued" || current.status === "running";
            // In flight stays clickable: the row is the way to the Activity tab,
            // and a disabled item swallows the click so the menu never closes.
            const disabled = !current.available;
            const reason = !current.available ? (
              current.unavailableReason
            ) : inFlight ? (
              <>
                Already running — see the{" "}
                <span className="text-action underline">Activity tab</span>.
              </>
            ) : (
              blurb
            );

            return (
              <DropdownMenuItem
                key={action}
                data-in-flight={inFlight ? "" : undefined}
                className="flex cursor-pointer items-start gap-2 rounded-md px-[9px] py-2 text-[0.9062rem] text-foreground outline-none data-disabled:cursor-not-allowed data-disabled:text-[var(--text-faint)] data-in-flight:text-[var(--text-faint)] data-highlighted:bg-[var(--bg-hover)] [&_svg]:mt-px [&_svg]:shrink-0 [&_svg]:text-action data-disabled:[&_svg]:text-[var(--text-faint)] data-in-flight:[&_svg]:text-[var(--text-faint)]"
                disabled={disabled}
                onSelect={() => {
                  if (inFlight) {
                    setOpen(false);
                    onAction?.();
                    return;
                  }
                  void run(action);
                }}
              >
                {busy === action ? (
                  <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />
                ) : (
                  <Icon size={13} strokeWidth={2} />
                )}
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium">{label}</span>
                  <span className="text-[0.7812rem] leading-[1.4] text-[var(--text-faint)]">
                    {reason}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {error ? (
        <div className="w-[max(260px,40vw)] max-w-120 self-stretch">
          <ErrorBox>{error}</ErrorBox>
        </div>
      ) : null}
    </div>
  );
}
