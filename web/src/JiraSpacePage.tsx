import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence } from "motion/react";
import { AlertTriangle, RefreshCw, Settings } from "lucide-react";

import {
  api,
  type GraphNode,
  type MrActionId,
  type PullRequestScope,
  type TicketActionId,
  type TicketActionRequest,
  type TicketCluster,
} from "./api.ts";
import { FixIssueDialog } from "./graph/FixIssueDialog.tsx";
import { PlanIssueDialog } from "./graph/PlanIssueDialog.tsx";
import { ReviewDescriptionDialog } from "./graph/ReviewDescriptionDialog.tsx";
import { E2eTestDialog } from "./graph/E2eTestDialog.tsx";
import { GraphFilterBar } from "./graph/GraphFilterBar.tsx";
import {
  applyFilters,
  FILTERS_PREFERENCE_KEY,
  filtersToStore,
  isFiltered,
  NO_FILTERS,
  parseFilters,
  resolveSprint,
  sameStoredFilters,
  type GraphFilters,
} from "./graph/filters.ts";
import { usePreference } from "./PreferencesContext.tsx";
import {
  ProviderAccessNotice,
  useMissingProviderAccess,
} from "./ProviderAccessNotice.tsx";
import { TicketBoard } from "./graph/TicketBoard.tsx";
import {
  DeveloperFilter,
  developerIdOf,
  developerOptions,
  TeamTicketBoard,
} from "./graph/TeamTicketBoard.tsx";
import { TicketPanel } from "./graph/TicketPanel.tsx";
import { TitleInfo } from "./TitleInfo.tsx";
import { invalidate, queries, refresh as forgeRefresh, refreshGraphAwait } from "./queries.ts";
import { useApi } from "./useApi.ts";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import { toMessage } from "./errors.ts";
import { cn } from "./lib/utils.ts";
import { ICON_BUTTON_CLASS } from "./app-styles.ts";
import { PAGE_TITLE_CLASS } from "./typography-styles.ts";
import { EMPTY_STATE_CLASS } from "./state-styles.ts";

/** Both halves of the graph: Jira's tickets, and this developer's merge requests. */
const GRAPH_PROVIDERS = ["jira", "gitlab"] as const;
const JIRA_PROVIDER = ["jira"] as const;

/** How long a successful queue acknowledgement stays on screen. */
const NOTICE_DISMISS_MS = 8_000;

const WARNING_CLASS =
  "mb-2.5 flex items-center gap-2 rounded-[var(--radius)] border border-[color-mix(in_srgb,var(--warn)_40%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] px-[11px] py-[7px] text-sm leading-[1.4] text-[var(--text-dim)] [&_svg]:shrink-0 [&_svg]:text-[var(--warn)]";

const WARNING_BUTTON_CLASS =
  "ml-auto cursor-pointer rounded-[calc(var(--radius)*.7)] border border-[var(--border-strong)] bg-[var(--bg-raised)] px-[9px] py-[3px] font-[inherit] text-[0.7812rem] text-foreground hover:bg-[var(--bg-hover)]";

/**
 * The requested slice of a Jira space, laid out the way its board is: one
 * column per status, a card per ticket. Mine is assigned to the current user;
 * Team is every board ticket their Jira account may read.
 */
export function JiraSpacePage({
  spaceKey,
  onSpaceResolved,
  scope,
  onScope,
  selectedTicket,
  onSelectTicket,
  onOpenTask,
  onOpenSettings,
}: {
  /** Ticket space selected by `/tickets/:spaceKey`; absent while resolving `/tickets`. */
  spaceKey?: string;
  /** Replaces an index or stale key with the configured space's canonical key. */
  onSpaceResolved: (spaceKey: string) => void;
  scope: PullRequestScope;
  onScope: (scope: PullRequestScope) => void;
  /** The ticket whose panel is open, from `?ticket=` — see `RouteState.ticket`. */
  selectedTicket?: string;
  onSelectTicket: (key?: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenSettings: () => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<Record<string, MrActionId | undefined>>({});
  const [ticketBusy, setTicketBusy] = useState<Record<string, TicketActionId | undefined>>({});
  // The ticket action being confirmed, with the ticket kept by key rather than by
  // value so a poll landing while the dialog is open refreshes what it shows — a
  // merge request that appeared in the meantime is exactly the thing that should
  // make the confirm think twice.
  const [plan, setPlan] = useState<{ key: string; action: TicketActionId }>();
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<{ ok: boolean; text: string }>();
  const [hiddenDevelopers, setHiddenDevelopers] = useState<ReadonlySet<string>>(new Set());
  /**
   * A queue acknowledgement describes what is *about* to happen ("the questions
   * will be posted as a comment on TD-1805"), so it stops being true the moment
   * the job it acknowledges finishes — and it was staying on screen until somebody
   * clicked it, telling you a comment was coming that had already been posted
   * minutes ago. Dismissed on a timer rather than when the job settles, because the
   * banner is an acknowledgement of the *click*, not a progress indicator: the
   * action node the row now shows is where the work's state lives.
   *
   * Only the successful ones. A failure is the one message that must survive until
   * it has been read.
   */
  useEffect(() => {
    if (!notice?.ok) return;
    const timer = setTimeout(() => setNotice(undefined), NOTICE_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  // Polls every 3s while the server says something is in flight, and stops when
  // it says nothing is — so an idle graph costs nothing. See `queries.graph`.
  const graph = useApi(queries.graph(scope));
  const configuredSpaceKey = graph.data?.board?.spaceKey;

  useEffect(() => {
    if (configuredSpaceKey && configuredSpaceKey !== spaceKey) {
      onSpaceResolved(configuredSpaceKey);
    }
  }, [configuredSpaceKey, onSpaceResolved, spaceKey]);
  /**
   * Every scope, not just the one on screen — which is also what makes it safe to
   * call from the `useCallback`s below without listing it as a dependency: it
   * closes over nothing that changes.
   *
   * Queueing or cancelling from here changes job state, so the job queue goes with
   * it: the footer badge and the loop's own history are stale the moment this
   * returns, and the graph only ever shows one of the two.
   */
  const refresh = () => {
    invalidate.graph(queryClient);
    invalidate.jobQueue(queryClient);
  };

  /**
   * The toolbar button, as opposed to the `refresh` above.
   *
   * The difference is which layer is stale. Queueing a job changes local job state
   * only, and `refresh` invalidating is exactly right for that — the graph's two
   * network reads are unchanged and re-fetching them would cost forge calls for
   * nothing. A person clicking refresh is instead saying the *forge* moved: a
   * ticket reassigned, a merge request opened elsewhere. Only that path pays to
   * find out. Scoped to the tab on screen, since it is the one being looked at.
   */
  const refreshFromForge = () => {
    forgeRefresh.graph(queryClient, scope);
    invalidate.jobQueue(queryClient);
  };

  const clusters = graph.data?.clusters ?? [];
  const live = graph.data?.live ?? false;
  const warnings = graph.data?.warnings ?? [];
  // Both providers, because the graph is Jira's tickets with the developer's own
  // merge requests hanging off them: either token missing leaves a hole in it.
  const { missing: missingAccess } = useMissingProviderAccess(GRAPH_PROVIDERS);
  // Jira is the page's root data source. Until it can be read, warnings about
  // GitLab enrichment and fix defaults are secondary setup work and presenting
  // all of them at once obscures the one action that can make this page useful.
  const missingJiraAccess = missingAccess.find((provider) => provider.id === "jira");

  /**
   * Which tickets are on the canvas — a preference rather than route state, stored
   * per account so the sprint switched here is the sprint waiting on the other
   * machine. `usePreference` handles the write-through; see `parseFilters` for why
   * the stored value is treated as untrusted.
   */
  const [stored, storeFilters] = usePreference(FILTERS_PREFERENCE_KEY, parseFilters);
  // The query is the one filter that stays in the component. It is not stored (see
  // `parseFilters`), and routing it through the preference would mean the search box
  // reads back the empty string it just saved — a box you cannot type in.
  const [query, setQuery] = useState("");
  const filters = useMemo<GraphFilters>(() => ({ ...stored, query }), [stored, query]);
  const changeFilters = useCallback(
    (next: GraphFilters) => {
      setQuery(next.query);
      // Only when something storable moved, or typing would be one PUT per keystroke.
      if (!sameStoredFilters(next, stored)) storeFilters(filtersToStore(next));
    },
    [stored, storeFilters],
  );

  // `active` names Jira's whole active sprint set, so it is resolved against the
  // payload on every render rather than pinned to one sprint id.
  const resolvedSprint = useMemo(
    () => resolveSprint(filters.sprint, graph.data),
    [filters.sprint, graph.data],
  );
  const visible = useMemo(
    () => applyFilters(clusters, filters, resolvedSprint),
    [clusters, filters, resolvedSprint],
  );
  const developers = useMemo(() => developerOptions(clusters), [clusters]);
  const displayed = useMemo(
    () =>
      scope === "team"
        ? visible.filter((cluster) => !hiddenDevelopers.has(developerIdOf(cluster)))
        : visible,
    [hiddenDevelopers, scope, visible],
  );

  /**
   * Runs one of the merge request toolbar's actions.
   *
   * Two routes for one button, picked by what the node knows about itself. A
   * merge request a loop is tracking goes through `/api/graph/mr-action`, which
   * authorises against the `work_subjects` row; one read from the developer's own
   * forge listing has no such row, so it goes through the pull request page's own
   * endpoint, which authorises against the forge with their token. Both enqueue
   * the same job under the same dedupe key, so it is the same run either way.
   */
  const runAction = useCallback(async (node: GraphNode, action: MrActionId) => {
    setBusy((current) => ({ ...current, [node.id]: action }));
    setNotice(undefined);
    // GitLab is the only forge that produces `mr` nodes today — both the subject
    // keys and the URLs they are recovered from are its.
    const prId = node.pullRequest
      ? `gitlab:${node.pullRequest.projectId}!${node.pullRequest.mrIid}`
      : undefined;
    try {
      const result =
        node.taskId && node.subjectKey
          ? await api.runMrAction({ loopId: node.taskId, subjectKey: node.subjectKey, action })
          : prId
            ? await api.runPullRequestAction(prId, action)
            : undefined;
      if (!result) {
        setNotice({ ok: false, text: "This merge request cannot be acted on from here." });
        return;
      }
      setNotice({ ok: result.queued, text: result.message });
      // The enqueued job is a new node, and waiting up to 3s for the next poll to
      // show it would read as the button having done nothing.
      refresh();
      // The Pull Requests page draws the same job from its own entries, so an
      // action queued here has to reach them or that page shows the merge request
      // as idle until something else refetches it.
      if (prId) invalidate.prJobs(queryClient, prId);
    } catch (err) {
      setNotice({ ok: false, text: toMessage(err) });
    } finally {
      setBusy((current) => ({ ...current, [node.id]: undefined }));
    }
  }, []);

  /**
   * Queues one of a ticket's actions, and opens its row so the job is visible.
   *
   * Only ever reached through a confirmation dialog: the menu item opens one
   * instead of calling this, because each action reaches somewhere a click cannot
   * see — a fix pushes a branch to a project the ticket does not name, a review
   * comments in the ticket's thread under the developer's own name, and a plan
   * reads a repository chosen in Settings rather than named on the ticket.
   */
  const runTicketAction = useCallback(async (
    cluster: TicketCluster,
    action: TicketActionId,
    options: Pick<TicketActionRequest, "targetBranch" | "pullRequest"> = {},
  ) => {
    const issueKey = cluster.key;
    setTicketBusy((current) => ({ ...current, [issueKey]: action }));
    setNotice(undefined);
    try {
      const result = await api.runTicketAction(issueKey, action, options);
      setNotice({ ok: result.queued, text: result.message });
      refresh();
    } catch (err) {
      setNotice({ ok: false, text: toMessage(err) });
    } finally {
      // Closed here rather than on the click, so the confirm button can say
      // "Queueing…" while the request is out — the dialog is the only thing on
      // screen at that moment, and a click with no acknowledgement invites a
      // second one.
      setPlan(undefined);
      setTicketBusy((current) => ({ ...current, [issueKey]: undefined }));
    }
  }, []);

  /**
   * Stops one job — the queue row and, if it had started, the container.
   *
   * No second confirmation. Cancelling is the recoverable direction: the worst
   * case is re-queueing work, whereas the thing it interrupts is an agent writing
   * to a repository, and making somebody confirm before stopping that is the
   * wrong friction.
   */
  const cancelJob = useCallback(async (jobId: string) => {
    setCancelling((current) => new Set(current).add(jobId));
    setNotice(undefined);
    try {
      const result = await api.cancelJob(jobId);
      setNotice({
        ok: true,
        text: result.run
          ? `Cancelled ${result.kind} and aborted its run.`
          : `Cancelled ${result.kind} before it started.`,
      });
      refresh();
    } catch (err) {
      setNotice({ ok: false, text: toMessage(err) });
    } finally {
      setCancelling((current) => {
        const next = new Set(current);
        next.delete(jobId);
        return next;
      });
    }
  }, []);

  // Kept by key rather than by value, so the selection is re-read from the
  // freshest payload every render and drops itself if the ticket disappeared.
  //
  // Over every cluster rather than the visible ones, because the selection is a
  // route destination now: the header's search opens `?ticket=TP-3018` from any
  // page, and it must not land on an empty panel because of a sprint filter left
  // on this board days ago. The filters shape the board; the panel shows the
  // ticket that was asked for.
  const selectedCluster = useMemo(
    () => (selectedTicket ? clusters.find((cluster) => cluster.key === selectedTicket) : undefined),
    [selectedTicket, clusters],
  );

  // Re-read from the payload for the same reason the selected node is: the dialog
  // stays open across polls, and it must describe the ticket as it is now. A
  // cluster that vanished closes the dialog rather than confirming against a
  // snapshot.
  const planCluster = plan ? clusters.find((cluster) => cluster.key === plan.key) : undefined;

  return (
    <div className="flex min-h-0 w-full flex-col overflow-hidden px-4 pt-5 pb-4 min-[901px]:px-[34px] min-[901px]:pt-7 min-[901px]:pb-6">
      <header className="mb-4 flex flex-wrap items-start gap-3 min-[901px]:mb-6 min-[901px]:gap-4">
        <div className="min-w-0 flex-1">
          <h1 className={PAGE_TITLE_CLASS}>
            {graph.data?.board?.spaceName ??
              graph.data?.board?.name ??
              spaceKey ??
              "Jira space"}
            {/* Says "active sprints" rather than "every ticket" because that union
                is the board's default view. */}
            <TitleInfo>
              {scope === "mine"
                ? "The tickets assigned to you and the work hanging off each one."
                : "Every ticket on this Jira board that your account can read, with the team's related work."}{" "}
              Switch sprint or widen the filters to see more.
            </TitleInfo>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {live ? (
            <span className="self-center rounded-[var(--radius-compact)] bg-[var(--live-wash)] px-2 py-[3px] font-mono text-xs tracking-[0.08em] text-live uppercase animate-[status-pulse_2s_ease-in-out_infinite]">
              live
            </span>
          ) : null}
          <div
            className="inline-flex rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] p-0.5"
            role="group"
            aria-label="Ticket scope"
          >
            {(["mine", "team"] as const).map((option) => (
              <button
                key={option}
                className={cn(
                  "cursor-pointer rounded-[calc(var(--radius)*.7)] border-0 bg-transparent px-3 py-[5px] font-[inherit] text-sm text-[var(--text-faint)] hover:text-foreground",
                  scope === option && "bg-[var(--bg-hover)] text-foreground",
                )}
                onClick={() => onScope(option)}
                aria-pressed={scope === option}
                title={
                  option === "mine"
                    ? "Your tickets, with work from loops you own"
                    : "Every ticket on this Jira board, with work from the team's visible loops"
                }
              >
                {option === "mine" ? "Mine" : "Team"}
              </button>
            ))}
          </div>
          <button
            className={ICON_BUTTON_CLASS}
            onClick={refreshFromForge}
            aria-label="Refresh Jira space"
          >
            <RefreshCw
              size={15}
              strokeWidth={2}
              className={graph.fetching ? "animate-spin" : ""}
            />
          </button>
        </div>
      </header>

      {/* Partial answers are explained rather than swallowed once Jira itself is
          available; before that, the focused setup notice below takes precedence. */}
      {missingJiraAccess
        ? null
        : warnings.map((warning) => (
            <p className={WARNING_CLASS} key={warning}>
              <AlertTriangle size={13} strokeWidth={2} />
              {warning}
            </p>
          ))}

      {/* Jira is the prerequisite for this page, so a new developer sees one
          actionable setup notice rather than every consequence of that missing
          access. Other provider gaps are shown once Jira itself is connected. */}
      {missingAccess.length > 0 ? (
        <ProviderAccessNotice
          providers={missingJiraAccess ? JIRA_PROVIDER : GRAPH_PROVIDERS}
          purpose={
            missingJiraAccess
              ? "Reading this Jira board"
              : "Showing your related merge requests"
          }
        />
      ) : null}

      {graph.data && !graph.data.fixDefaults && !missingJiraAccess ? (
        <p className={WARNING_CLASS}>
          <Settings size={13} strokeWidth={2} />
          Set a default project and branch to fix issues straight from a ticket.
          <button type="button" className={WARNING_BUTTON_CLASS} onClick={onOpenSettings}>
            Open settings
          </button>
        </p>
      ) : null}

      {/* Above the canvas rather than in the header, and drawn as soon as there is
          anything to narrow: it belongs to the tickets, and the header row is
          already carrying the scope and the refresh. */}
      {clusters.length > 0 ? (
        <GraphFilterBar
          clusters={clusters}
          view={graph.data}
          filters={filters}
          resolved={resolvedSprint}
          shown={displayed.length}
          onChange={changeFilters}
          extraFilter={
            scope === "team" ? (
              <DeveloperFilter
                developers={developers}
                hidden={hiddenDevelopers}
                onChange={setHiddenDevelopers}
              />
            ) : undefined
          }
        />
      ) : null}

      {graph.error ? (
        <ErrorBox>{graph.error}</ErrorBox>
      ) : graph.loading ? (
        <Loading>Loading Jira tickets…</Loading>
      ) : clusters.length === 0 && !missingJiraAccess ? (
        <div className={EMPTY_STATE_CLASS}>
          {scope === "mine"
            ? "Jira's board has no ticket assigned to you."
            : "Jira's board has no tickets your account can read."}
        </div>
      ) : clusters.length === 0 ? null : visible.length === 0 ? (
        // Distinct from the empty payload above, and it has to be: "you have no
        // tickets" and "none of your tickets are in this sprint" call for opposite
        // reactions, and only one of them has a way out.
        <div className={EMPTY_STATE_CLASS}>
          No ticket matches these filters.
          {isFiltered(filters) ? (
            <button
              type="button"
              className={WARNING_BUTTON_CLASS}
              onClick={() => changeFilters(NO_FILTERS)}
            >
              Show every ticket
            </button>
          ) : null}
        </div>
      ) : (
        // One column now, whatever is selected: the detail is a drawer over the
        // canvas rather than a panel beside it, so nothing here resizes.
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3">
          <div className="relative h-full min-h-0 overflow-hidden rounded-[var(--radius-panel)] border border-border bg-[var(--bg-deep)]">
            {scope === "team" ? (
              <TeamTicketBoard
                clusters={displayed}
                board={graph.data?.board}
                selectedKey={selectedTicket}
                onSelect={(cluster) => onSelectTicket(cluster.key)}
                onAction={(cluster, action) => setPlan({ key: cluster.key, action })}
                busy={ticketBusy}
                onNotice={setNotice}
                onMoved={() => refreshGraphAwait(queryClient, scope)}
              />
            ) : (
              <TicketBoard
                clusters={displayed}
                board={graph.data?.board}
                selectedKey={selectedTicket}
                onSelect={(cluster) => onSelectTicket(cluster.key)}
                onAction={(cluster, action) => setPlan({ key: cluster.key, action })}
                busy={ticketBusy}
                onNotice={setNotice}
                onMoved={() => refreshGraphAwait(queryClient, scope)}
              />
            )}
            {notice ? (
              <p
                className={`absolute bottom-3 left-3 z-5 m-0 max-w-[60%] cursor-pointer rounded-[var(--radius)] border border-l-2 border-[var(--border-strong)] bg-[var(--bg-raised)] px-2.5 py-1.5 text-[0.7812rem] text-foreground ${
                  notice.ok ? "!border-l-success" : "!border-l-[var(--warn)]"
                }`}
                role="status"
                onClick={() => setNotice(undefined)}
              >
                {notice.text}
              </p>
            ) : null}
          </div>
        </div>
      )}

      {/* Outside the `visible.length` branches and unconditional: the drawer owns
          its own open state so it can animate out, which it cannot do if the
          selection clearing unmounts it. */}
      <TicketPanel
        cluster={selectedCluster}
        scope={scope}
        onClose={() => onSelectTicket(undefined)}
        onOpenTask={onOpenTask}
        onCancelJob={cancelJob}
        cancelling={cancelling}
        onAction={runAction}
        busy={busy}
        onTicketAction={(cluster, action) => setPlan({ key: cluster.key, action })}
        busyTicketAction={selectedCluster ? ticketBusy[selectedCluster.key] : undefined}
      />

      <AnimatePresence>
        {planCluster && plan?.action === "fix-issue" ? (
          <FixIssueDialog
            cluster={planCluster}
            defaults={graph.data?.fixDefaults ?? null}
            busy={ticketBusy[planCluster.key] != null}
            onConfirm={(targetBranch) =>
              void runTicketAction(planCluster, "fix-issue", { targetBranch })
            }
            onCancel={() => setPlan(undefined)}
          />
        ) : planCluster && plan?.action === "plan-issue" ? (
          <PlanIssueDialog
            cluster={planCluster}
            defaults={graph.data?.fixDefaults ?? null}
            busy={ticketBusy[planCluster.key] != null}
            onConfirm={(targetBranch) =>
              void runTicketAction(planCluster, "plan-issue", { targetBranch })
            }
            onCancel={() => setPlan(undefined)}
          />
        ) : planCluster && plan?.action === "review-description" ? (
          <ReviewDescriptionDialog
            cluster={planCluster}
            busy={ticketBusy[planCluster.key] != null}
            onConfirm={() => void runTicketAction(planCluster, "review-description")}
            onCancel={() => setPlan(undefined)}
          />
        ) : planCluster && plan?.action === "e2e-test" ? (
          <E2eTestDialog
            cluster={planCluster}
            busy={ticketBusy[planCluster.key] != null}
            onConfirm={(pullRequest) =>
              void runTicketAction(planCluster, "e2e-test", { pullRequest })
            }
            onCancel={() => setPlan(undefined)}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
