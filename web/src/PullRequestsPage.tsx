import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Filter,
  GitBranch,
  GitPullRequest,
  Info,
  LoaderCircle,
  MessageSquareWarning,
  RefreshCw,
} from "lucide-react";
import { motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";

import { type PullRequestState, type PullRequestView, type PullRequestsView } from "./api.ts";
import { Card, CardContent, CardHeader } from "./components/ui/card.tsx";
import { abbreviateName, ago } from "./format.ts";
import { ACTION_META } from "./pr/actionMeta.ts";
import { UserAvatar } from "./pr/Avatar.tsx";
import { PullRequestDetail } from "./pr/PullRequestDetail.tsx";
import { STATE_META, stateMeta } from "./pr/state.ts";
import type { OwnerTab } from "./route-state.ts";
import { usePreference } from "./PreferencesContext.tsx";
import {
  ProviderAccessButton,
  ProviderAccessNotice,
  useProviderAccessDialog,
} from "./ProviderAccessNotice.tsx";
import { Tip } from "./Tip.tsx";
import { queries, refresh } from "./queries.ts";
import { useApi } from "./useApi.ts";
import { MasterDetail } from "./MasterDetail.tsx";
import { useMobileDetail } from "./useMobileDetail.ts";
import { useNarrowLayout } from "./useNarrowLayout.ts";
import { useResizableWidth } from "./useResizableWidth.ts";
import { useFormat } from "./FormatContext.tsx";
import { ErrorBox } from "./components/ui/query-state.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./components/ui/tabs.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover.tsx";
import { Button } from "./components/ui/button.tsx";
import { ICON_BUTTON_CLASS } from "./app-styles.ts";
import { cn } from "./lib/utils.ts";
import {
  PR_FILTER_CHECK_CLASS,
  PR_FILTER_NOTE_CLASS,
  PR_FILTER_POPOVER_CLASS,
  PR_FILTER_RESET_CLASS,
  PR_FILTER_ROW_CLASS,
  PR_FILTER_TITLE_CLASS,
  PR_STATE_CLASS,
  PR_STATE_ICON_TONE,
  PR_STATE_TONE,
} from "./pr/styles.ts";
import { EMPTY_STATE_CLASS, INFO_BOX_CLASS, INFO_ICON_CLASS } from "./state-styles.ts";

type ActiveAction = NonNullable<PullRequestView["activeAction"]>;

/** `repository!number` — the same pair the server decodes out of a job's dedupe key. */
function rowKey(pr: { repository?: string; number: number }): string {
  return `${pr.repository ?? ""}!${pr.number}`;
}

interface ActivePullRequestActionsPoll {
  byKey: Map<string, ActiveAction>;
  /** False until the first poll answers — see the comment where this is read. */
  ready: boolean;
}

/**
 * A running/queued badge for every pull request row, kept fresh independently of
 * the list itself.
 *
 * The listing's own `activeAction` field is only as fresh as the last forge
 * round trip, and that round trip is a deliberate, manual refresh — polling it
 * would hammer the rate limit `PullRequestsPage`'s comment already explains.
 * This polls a separate endpoint instead, one that answers from the job queue
 * alone, so a badge can update every few seconds without touching GitLab (the
 * interval lives with the endpoint, in `queries.prActiveActions`).
 *
 * Its errors are dropped on purpose: a missed tick just leaves badges one poll
 * stale, which is not worth a banner on a page that is otherwise working fine.
 */
function useActivePullRequestActions(): ActivePullRequestActionsPoll {
  const active = useApi(queries.prActiveActions());

  const byKey = useMemo(
    () =>
      new Map(
        (active.data?.actions ?? []).map(
          (a) => [`${a.projectId}!${a.mrIid}`, { action: a.action, status: a.status }] as const,
        ),
      ),
    [active.data],
  );

  return { byKey, ready: active.data !== undefined };
}

/**
 * Pull request management, on the two questions a developer actually asks —
 * "what am I waiting on?" and "what is everyone else doing?".
 *
 * Built as the same fixed two-pane split as Tasks and Loops (list on the left,
 * detail on the right, one draggable divider) rather than a card grid, so a
 * reviewer works down a list instead of scanning tiles.
 *
 * Forge-neutral by construction. Nothing here mentions GitLab; a row renders
 * whatever `/api/pull-requests` returned, and `provider` is a label on the row
 * rather than a branch in this file (see `application/pull-requests.ts`).
 */
export function PullRequestsPage({
  tab,
  onSetTab,
  selectedId,
  onSelect,
}: {
  tab: OwnerTab;
  onSetTab: (tab: OwnerTab) => void;
  selectedId?: string;
  onSelect: (id: string, options?: { replace?: boolean }) => void;
}) {
  const [states, setStates] = useStoredStates();
  const scope = tab === "mine" ? "mine" : "team";
  // Never polled — a timer here would hammer somebody's forge rate limit for a
  // page they are only reading — but cached for a minute, so paging back to a
  // tab you just looked at costs nothing. The refresh button is `refresh
  // .pullRequests`, which ignores both that staleness *and* the server's own TTL
  // — `refetch` alone would be answered from the server cache and look broken.
  const queryClient = useQueryClient();
  const listing = useApi(queries.pullRequests(scope, states));
  const activeActions = useActivePullRequestActions();
  const providerAccess = useProviderAccessDialog();
  // The same stored width as Tasks and Loops, so dragging the divider on one
  // page holds on all three.
  const { width, onPointerDown, onPointerMove, onPointerUp } = useResizableWidth(
    "talos-list-width",
    340,
    220,
    640,
  );
  const narrow = useNarrowLayout();
  const mobileDetail = useMobileDetail(selectedId);
  function selectPullRequest(id: string, options?: { replace?: boolean }) {
    onSelect(id, options);
    if (!options?.replace) mobileDetail.showDetail();
  }

  // No echo check any more: the scope and the state set are both in the cache
  // key, so a tab switch reads a different entry rather than re-rendering the
  // previous tab's rows while the next request is in flight. That mismatch is
  // what the check here used to exist to catch. Deliberately no
  // `keepPreviousData` on this query — it would put the bug straight back.
  const fresh = listing.data;
  const showSkeleton = listing.loading;

  const rows = fresh?.pullRequests ?? [];
  const selected = rows.find((pr) => pr.id === selectedId);
  const list = () => (
    <PullRequestList
      scope={scope}
      filtered={states.join(",") !== DEFAULT_STATES.join(",")}
      listing={fresh}
      loading={showSkeleton}
      error={listing.error}
      selectedId={selectedId}
      onSelect={selectPullRequest}
      activeActions={activeActions}
    />
  );

  // Opening the page — or switching tabs, which replaces the list wholesale —
  // picks the first row so the detail pane is never an empty "select
  // something". Unlike tasks, the list here is the whole truth for a scope, so
  // an id that is not in it is stale rather than not-yet-fetched.
  useEffect(() => {
    if (rows.length === 0 || selected) return;
    onSelect(rows[0]!.id, { replace: true });
  }, [rows, selected]);

  return (
    <>
      {providerAccess.dialog}
      <MasterDetail
        narrow={narrow}
        detailOpen={mobileDetail.open}
        onBack={mobileDetail.showList}
        backLabel="Merge requests"
        width={width}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        list={
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <span className="flex items-center gap-1.5 text-sm font-semibold tracking-[0.06em] text-[var(--text-dim)]">
            <GitPullRequest size={14} strokeWidth={2} />
            PULL REQUESTS
          </span>
          <div className="flex items-center gap-0.5">
            <StateFilter states={states} onChange={setStates} />
            <Tip label="Refresh">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={ICON_BUTTON_CLASS}
                aria-label="Refresh pull requests"
                disabled={listing.fetching}
                onClick={() => refresh.pullRequests(queryClient, scope, states)}
              >
                <RefreshCw
                  size={16}
                  strokeWidth={2}
                  className={listing.fetching ? "animate-spin" : ""}
                />
              </Button>
            </Tip>
          </div>
        </div>

        {scope === "team" && fresh && fresh.repositoryFilter.length > 0 ? (
          // Discoverability for a setting that lives on a different page: the
          // list looking thin is the only signal a filter is on, otherwise.
          <div className="border-b border-border px-3 py-1.5 text-[0.7812rem] text-[var(--text-faint)] [&_a]:text-muted-foreground [&_a:hover]:text-[var(--brand)]">
            Narrowed to {fresh.repositoryFilter.length}{" "}
            {fresh.repositoryFilter.length === 1 ? "repository" : "repositories"}.{" "}
            <a href="/settings?settingsTab=pull-requests">Manage in Settings</a>
          </div>
        ) : null}

        <Tabs
          value={tab}
          onValueChange={(value) => onSetTab(value as OwnerTab)}
          className="min-h-0 flex-1"
        >
          <TabsList variant="line">
            <TabsTrigger value="mine">
              My MRs
            </TabsTrigger>
            <TabsTrigger value="team">
              Team MRs
            </TabsTrigger>
          </TabsList>

          <TabsContent value="mine" className="min-h-0 flex-1 overflow-y-auto text-inherit">
            {list()}
          </TabsContent>
          <TabsContent value="team" className="min-h-0 flex-1 overflow-y-auto text-inherit">
            {list()}
          </TabsContent>
        </Tabs>
      </div>

        }
        detail={
      <div className="h-full min-h-0 overflow-y-auto p-4 [scrollbar-gutter:stable] min-[901px]:p-8">
        {showSkeleton ? (
          <PullRequestDetailSkeleton />
        ) : (
          <>
            {fresh?.unavailable.map((provider) => (
              <MissingTokenNotice
                key={provider.provider}
                label={provider.label}
                missing={provider.missing}
                onOpenProviderAccess={providerAccess.open}
              />
            ))}
            {/* The server accepts an instance token as available, but a list
                titled "My MRs" still needs this developer's own identity. Keep
                that fallback notice in the main pane too. */}
            {fresh?.unavailable.length === 0 ? (
              <ProviderAccessNotice
                providers={PR_PROVIDERS}
                purpose="Reading your merge requests, or acting on one"
              />
            ) : null}
            {selected ? (
              <motion.div
                key={selected.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.15 }}
              >
                <PullRequestDetail pr={selected} />
              </motion.div>
            ) : fresh?.unavailable.length ? null : (
              <div className={EMPTY_STATE_CLASS}>Select a merge request to see its details.</div>
            )}
          </>
        )}
      </div>
        }
      />
    </>
  );
}

function PullRequestList({
  scope,
  filtered,
  listing,
  loading,
  error,
  selectedId,
  onSelect,
  activeActions,
}: {
  scope: "mine" | "team";
  /** Whether the state filter has been changed off its default. */
  filtered: boolean;
  listing?: PullRequestsView;
  loading: boolean;
  error?: string;
  selectedId?: string;
  onSelect: (id: string) => void;
  activeActions: ActivePullRequestActionsPoll;
}) {
  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (loading) return <PullRequestListSkeleton />;
  if (!listing) return null;

  const rows = listing.pullRequests;

  return (
    <>
      {listing.failed.map((provider) => (
        <ErrorBox key={provider.provider}>
          {provider.label} could not be reached: {provider.message}
        </ErrorBox>
      ))}

      {rows.length === 0
        ? // Only an "it is empty" when the page could actually look: with no
          // token, the main-pane notice is the answer and "nothing open" would
          // be a claim we have no basis for.
          listing.unavailable.length === 0 && (
            <div className={EMPTY_STATE_CLASS}>
              {filtered
                ? "No merge requests match this filter."
                : scope === "mine"
                  ? "You have no open merge requests."
                  : "No open merge requests from anyone else right now."}
            </div>
          )
        : rows.map((pr, index) => (
            <PullRequestRow
              key={pr.id}
              pr={pr}
              index={index}
              selected={pr.id === selectedId}
              onSelect={onSelect}
              // Once the poll has answered at least once, it is the live truth —
              // including "nothing running here any more", which a `??` fallback
              // could not tell apart from "the poll has not run yet". Until then,
              // the listing's own baked-in `activeAction` covers the gap.
              activeAction={
                activeActions.ready ? activeActions.byKey.get(rowKey(pr)) : pr.activeAction
              }
            />
          ))}
    </>
  );
}

const SKELETON_ROWS = 6;
const SKELETON_BLOCK_CLASS =
  "inline-block h-3 rounded-sm bg-[linear-gradient(90deg,var(--bg-muted)_25%,var(--bg-hover)_50%,var(--bg-muted)_75%)] bg-[length:200%_100%] animate-[pr-shimmer_1.4s_ease-in-out_infinite]";

/**
 * Placeholder rows shaped like `PullRequestRow`, shown while a request is in
 * flight for a filter that has no matching data yet (first load, a tab
 * switch, a state toggle). Widths are varied rather than uniform bars so the
 * row still reads as "a title, a branch, a line of meta" instead of a grey
 * block — the shimmer says "loading", the shape says "this is a list".
 */
function PullRequestListSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div
          className="cursor-default border-b border-l-2 border-b-border border-l-transparent px-3.5 py-3 hover:bg-transparent"
          key={index}
        >
          <div className="flex items-center gap-1.5">
            <span
              className={cn(SKELETON_BLOCK_CLASS, "h-[13px]")}
              style={{ width: `${62 - (index % 3) * 10}%` }}
            />
            <span className={cn(SKELETON_BLOCK_CLASS, "h-4 w-11.5 shrink-0 rounded-full")} />
          </div>
          <div className="mono mt-[5px] flex items-center gap-2.5 text-[0.7812rem] text-[var(--text-faint)]">
            <span className={cn(SKELETON_BLOCK_CLASS, "w-11.5")} />
            <span className={cn(SKELETON_BLOCK_CLASS, "w-17.5")} />
            <span className={cn(SKELETON_BLOCK_CLASS, "w-11.5")} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The no-token state. Deliberately an info panel and not an error: nothing has
 * gone wrong, the platform simply cannot answer for someone yet.
 *
 * Opens the screen rather than naming the shell or the menu it lives in, and
 * still names the credential, because "store your GitLab token" and "store
 * `GITLAB_TOKEN`" are the same instruction only if you already know the mapping.
 *
 * Driven by the server's `unavailable` rather than by `useMissingProviderAccess`:
 * this page has already made the call, so it knows which forge actually went
 * unasked and under which names — including forges with no card in the dialog.
 */
function MissingTokenNotice({
  label,
  missing,
  onOpenProviderAccess,
}: {
  label: string;
  missing: string[];
  onOpenProviderAccess: () => void;
}) {
  return (
    <div className={INFO_BOX_CLASS}>
      <Info size={16} strokeWidth={2} className={INFO_ICON_CLASS} />
      <div>
        <strong>No {label} personal access token stored.</strong> Merge requests cannot be
        shown until TALOS can talk to {label} as you —{" "}
        {missing.map((name, index) => (
          <span key={name}>
            {index > 0 ? ", " : null}
            <code className="mono">{name}</code>
          </span>
        ))}
        .
        <div className="mt-2.5">
          <ProviderAccessButton onOpen={onOpenProviderAccess} />
        </div>
      </div>
    </div>
  );
}

/** The forge behind every merge request the console can show today. */
const PR_PROVIDERS = ["gitlab"] as const;

/** What the page opens on: the work still in flight. Matches the server's default. */
const DEFAULT_STATES: PullRequestState[] = ["open", "draft"];

const STATES_PREFERENCE_KEY = "pull-requests.states";

/**
 * The filter, remembered across visits and across machines.
 *
 * A preference rather than a route: somebody who works from "everything merged
 * this week" wants that list when they come back, and it is theirs rather than
 * something to put in a shareable URL — the tab and the selected merge request
 * are what a link is for. Stored server-side for the same reason, so the list is
 * the one they left open on the other machine.
 */
function useStoredStates(): [PullRequestState[], (next: PullRequestState[]) => void] {
  const [states, store] = usePreference(STATES_PREFERENCE_KEY, parseStates);

  return [
    states,
    (next: PullRequestState[]) => {
      const normalized = normalizeStates(next);
      // Every state off would be a list that can only be empty, and the toggles
      // give no way back from it.
      if (normalized.length === 0) return;
      store(normalized);
    },
  ];
}

/**
 * A stored value back into states.
 *
 * Anything unrecognised drops out rather than reaching the query: this row was last
 * written by another machine, possibly on a release that knew a state this one does
 * not, and `normalizeStates` is already the filter for that.
 */
function parseStates(raw: unknown): PullRequestState[] {
  if (!Array.isArray(raw)) return DEFAULT_STATES;
  const parsed = normalizeStates(raw.filter((entry): entry is PullRequestState =>
    typeof entry === "string",
  ));
  return parsed.length > 0 ? parsed : DEFAULT_STATES;
}

/** Canonical order and no unknowns, so a stored value and a fresh one compare equal. */
function normalizeStates(states: PullRequestState[]): PullRequestState[] {
  return STATE_META.map((meta) => meta.state).filter((state) => states.includes(state));
}

/**
 * The state filter: an icon that opens a list of toggles.
 *
 * A popover rather than four always-visible chips, because the list panel is
 * 340px wide by default and the tabs already live there — and because this is a
 * setting somebody changes occasionally, not a control they read constantly.
 */
function StateFilter({
  states,
  onChange,
}: {
  states: PullRequestState[];
  onChange: (next: PullRequestState[]) => void;
}) {
  const [open, setOpen] = useState(false);

  const changed = states.join(",") !== DEFAULT_STATES.join(",");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="relative">
        <Tip label="Filter by state">
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                ICON_BUTTON_CLASS,
                open && "bg-[var(--bg-raised)] text-foreground",
              )}
              aria-label="Filter by state"
            >
              <Filter size={16} strokeWidth={2} />
              {changed ? (
                <span className="absolute top-[3px] right-[3px] size-1.5 rounded-full bg-action" />
              ) : null}
            </Button>
          </PopoverTrigger>
        </Tip>
        <PopoverContent
          align="end"
          sideOffset={6}
          className={cn(PR_FILTER_POPOVER_CLASS, "w-auto gap-0 ring-0")}
        >
          <div className={PR_FILTER_TITLE_CLASS}>Show</div>
          {STATE_META.map(({ state, label, icon: Icon }) => {
            const checked = states.includes(state);
            // The last remaining state cannot be unticked: an empty filter
            // would be a page that shows nothing, and the server reads an empty
            // set as "the default" anyway — the two would disagree.
            const locked = checked && states.length === 1;
            return (
              <Button
                key={state}
                type="button"
                variant="ghost"
                className={cn(PR_FILTER_ROW_CLASS, checked && "text-foreground")}
                disabled={locked}
                title={locked ? "At least one state has to stay selected" : undefined}
                onClick={() =>
                  onChange(
                    checked ? states.filter((s) => s !== state) : [...states, state],
                  )
                }
              >
                <span
                  className={cn(
                    PR_FILTER_CHECK_CLASS,
                    checked && "border-action bg-action",
                  )}
                >
                  {checked ? <Check size={12} strokeWidth={3} /> : null}
                </span>
                <Icon
                  size={13}
                  strokeWidth={2}
                  className={PR_STATE_ICON_TONE[state]}
                />
                {label}
              </Button>
            );
          })}
          {states.includes("merged") || states.includes("closed") ? (
            // Said out loud rather than left to be discovered: a forge cannot
            // list years of finished work without timing out, so the finished
            // states are a recent window. The number of days is the provider's
            // to choose, which is why it is not quoted here.
            <div className={PR_FILTER_NOTE_CLASS}>
              Merged and closed cover recent history only.
            </div>
          ) : null}
          {changed ? (
            <Button
              type="button"
              variant="ghost"
              className={cn(
                PR_FILTER_RESET_CLASS,
                (states.includes("merged") || states.includes("closed")) &&
                  "mt-0 border-t-0",
              )}
              onClick={() => onChange(DEFAULT_STATES)}
            >
              Reset to open &amp; draft
            </Button>
          ) : null}
        </PopoverContent>
      </div>
    </Popover>
  );
}

const ICON_SIZE = 13;

function PullRequestRow({
  pr,
  index,
  selected,
  onSelect,
  activeAction,
}: {
  pr: PullRequestView;
  index: number;
  selected: boolean;
  onSelect: (id: string) => void;
  activeAction?: ActiveAction;
}) {
  const fmt = useFormat();
  const { label } = stateMeta(pr.state);
  const opened = pr.createdAt ?? pr.updatedAt;

  return (
    <motion.div
      className={cn(
        "cursor-pointer border-b border-l-2 border-b-border border-l-transparent px-3.5 py-3 hover:bg-[var(--bg-hover)]",
        selected && "border-l-action bg-[var(--bg-hover)]",
      )}
      onClick={() => onSelect(pr.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect(pr.id);
      }}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, delay: index * 0.02 }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-medium"
          title={pr.title}
        >
          {pr.title}
        </span>
        {pr.hasUnresolvedThreads ? (
          <Tip label="Unresolved comments">
            <span className="inline-flex shrink-0 text-[var(--warn)]">
              <MessageSquareWarning size={13} strokeWidth={2} />
            </span>
          </Tip>
        ) : null}
        <span className={cn(PR_STATE_CLASS, PR_STATE_TONE[pr.state], "px-2 py-0.5 text-xs")}>
          {label}
        </span>
        {activeAction ? (
          <Tip
            label={`${ACTION_META[activeAction.action].label} — ${
              activeAction.status === "running" ? "running in a container" : "queued"
            }`}
          >
            <span
              className={cn(
                "inline-flex max-w-[40%] shrink-0 items-center gap-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold tracking-[0.02em]",
                activeAction.status === "running"
                  ? "bg-[color-mix(in_srgb,var(--running)_18%,var(--bg-deep))] text-[var(--running)]"
                  : "bg-[color-mix(in_srgb,var(--warn)_18%,var(--bg-deep))] text-[var(--warn)]",
              )}
            >
              <LoaderCircle size={11} strokeWidth={2} className="animate-spin" />
              {ACTION_META[activeAction.action].label}
            </span>
          </Tip>
        ) : null}
      </div>

      {/* One line: the id anchors it, the branch is the one thing worth
          most of the width (feature branch names run long), author and time
          are fixed-width so they never get pushed off — repository lives in
          the detail pane rather than crowding this row further. */}
      <div className="mono mt-[5px] flex items-center gap-2.5 text-[0.7812rem] text-[var(--text-faint)]">
        <a
          className="shrink-0 text-muted-foreground no-underline hover:text-[var(--brand)]"
          href={pr.webUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
        >
          !{pr.number}
        </a>
        <span
          className="inline-flex min-w-0 flex-auto items-center gap-1 overflow-hidden text-muted-foreground [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap"
          title={pr.targetBranch}
        >
          <GitBranch size={ICON_SIZE} strokeWidth={2} />
          <span>{pr.targetBranch}</span>
        </span>
        {pr.author ? (
          <span
            className="inline-flex max-w-27.5 shrink-0 items-center gap-[5px] overflow-hidden text-ellipsis whitespace-nowrap"
            title={pr.author.name ?? pr.author.username}
          >
            <UserAvatar user={pr.author} size={16} />
            {pr.author.name ? abbreviateName(pr.author.name) : pr.author.username}
          </span>
        ) : null}
        <Tip label={fmt.stamp(opened)}>
          <span className="shrink-0">{ago(opened)}</span>
        </Tip>
      </div>
    </motion.div>
  );
}

/** The detail pane's shape while its list is still loading, so the pane does not idle on "Select a merge request" between tabs. */
function PullRequestDetailSkeleton() {
  return (
    <div aria-hidden="true">
      <div>
        <div className={cn(SKELETON_BLOCK_CLASS, "mb-2 h-5 w-[55%]")} />
        <div className={cn(SKELETON_BLOCK_CLASS, "mb-3.5 w-[30%]")} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Card key={index} size="sm">
            <CardHeader className="flex items-center justify-between gap-2">
              <span className={cn(SKELETON_BLOCK_CLASS, "w-[60%]")} />
            </CardHeader>
            <CardContent>
              <span className={cn(SKELETON_BLOCK_CLASS, "h-3.5 w-[80%]")} />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
