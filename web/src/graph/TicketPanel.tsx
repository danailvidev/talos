import { useState } from "react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  RefreshCw,
  Square,
  X,
} from "lucide-react";
import type {
  GraphNode,
  MrActionId,
  PullRequestScope,
  TicketActionId,
  TicketCluster,
} from "../api.ts";
import type { E2eTestResultView } from "../api.ts";
import { api } from "../api.ts";
import { ActivityLog } from "../Steps.tsx";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "../components/ui/drawer.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs.tsx";
import { ErrorBox } from "../components/ui/query-state.tsx";
import { cn } from "../lib/utils.ts";
import { ICON_BUTTON_CLASS } from "../app-styles.ts";
import { Button } from "../components/ui/button.tsx";
import { Tip } from "../Tip.tsx";
import { keys } from "../query-keys.ts";
import { invalidate, refresh } from "../queries.ts";
import { useAction } from "../useAction.ts";
import { PlanTab } from "./PlanTab.tsx";
import { TicketDetail } from "./TicketDetail.tsx";
import { KIND_ICONS, MR_ACTIONS, STATUS_ICONS, STATUS_WORDS, TicketActionsMenu } from "./nodes.tsx";
import { ticketNodeOf } from "./ticket.ts";
import { E2eTestMrDialog } from "./E2eTestMrDialog.tsx";

type Tab = "overview" | "plan" | "activity";

function activityBorder(status: GraphNode["status"]): string {
  if (status === "running") return "border-[var(--running)]";
  if (status === "failure" || status === "dead") return "border-[var(--failure)]";
  if (status === "success") {
    return "border-[color-mix(in_srgb,var(--success)_45%,var(--border))]";
  }
  if (status === "waiting") {
    return "border-[color-mix(in_srgb,var(--warn)_40%,var(--border))]";
  }
  return "border-border";
}

function statusColor(status: GraphNode["status"]): string {
  if (status === "running") return "text-[var(--running)]";
  if (status === "failure" || status === "dead") return "text-[var(--failure)]";
  if (status === "success") return "text-[var(--success)]";
  if (status === "waiting") return "text-[var(--warn)]";
  return "text-[var(--text-faint)]";
}

function kindColor(kind: GraphNode["kind"]): string {
  if (kind === "ticket" || kind === "action") return "text-[var(--warn)]";
  if (kind === "mr") return "text-[var(--success)]";
  if (kind === "loop") return "text-action";
  return "text-[var(--text-dim)]";
}

/**
 * Once a job starts, the graph carries both a `job` node (the queue row) and a
 * `run` node (the execution) for it, at the same timestamp — two canvas nodes
 * for one pipeline step. The Runs tab wants one row per execution, so the
 * `job` node is dropped in favour of its `run` node, after moving over the
 * things only the `job` node carries (the cancel button's `jobId`, the
 * "attempt N/M" sublabel) so a still-queued cancel action and that label
 * survive the merge.
 */
function dedupeJobRunPairs(nodes: GraphNode[]): GraphNode[] {
  const jobsByExecutionId = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node.kind === "job" && node.executionId) jobsByExecutionId.set(node.executionId, node);
  }
  return nodes
    .filter((node) => node.kind !== "job" || !node.executionId)
    .map((node) => {
      const job = node.kind === "run" && node.executionId
        ? jobsByExecutionId.get(node.executionId)
        : undefined;
      return job ? { ...node, sublabel: node.sublabel ?? job.sublabel, jobId: job.jobId } : node;
    });
}

/**
 * A ticket's detail, one click away from its board card.
 *
 * Tabs rather than the single scroll the graph canvas used to fan sideways:
 * Overview is the ticket itself — description, Jira's own fields, the
 * conversation — Plan is the one decision a human owes this ticket before an
 * agent writes code, and Runs is everything talos knows happened around
 * it — jobs, runs, merge requests — which the board no longer draws on the
 * canvas at all. `TicketDetail` and `PlanTab` own the first two; this owns the
 * last and the chrome around all three.
 */
export function TicketPanel({
  cluster,
  scope,
  onClose,
  onOpenTask,
  onCancelJob,
  cancelling,
  onAction,
  busy,
  onTicketAction,
  busyTicketAction,
}: {
  /** The selected ticket's cluster, or nothing — this component stays mounted either way. */
  cluster?: TicketCluster;
  /** The graph scope whose Jira and Development data the refresh button re-reads. */
  scope: PullRequestScope;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
  onCancelJob: (jobId: string) => void;
  /** Job ids currently being cancelled, so only that row's button says so. */
  cancelling: ReadonlySet<string>;
  /** Runs one of an `mr` node's own actions. */
  onAction: (node: GraphNode, action: MrActionId) => void;
  /** Node id → the MR action currently in flight on it, if any. */
  busy: Record<string, MrActionId | undefined>;
  /** Runs one of the ticket's own actions — fix issue, review requirements, etc. */
  onTicketAction: (cluster: TicketCluster, action: TicketActionId) => void;
  /** The ticket action being queued right now, if any, so the menu says which. */
  busyTicketAction?: TicketActionId;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  /**
   * The cluster kept alive for the length of the closing animation — same
   * reason `NodePanel` kept one: `cluster` goes undefined the moment the
   * selection clears, and the drawer spends the next few hundred milliseconds
   * sliding out.
   */
  const [last, setLast] = useState(cluster);
  if (cluster && cluster !== last) setLast(cluster);
  const shown = cluster ?? last;

  // A new ticket opens on its Overview, whatever tab the last one was left on —
  // Runs are something you go looking for, not the first thing you'd expect to
  // see about a ticket you have not read yet.
  //
  // Unless a plan is waiting on it, in which case that *is* what you came for: the
  // card is gold, the bell said so, and one click should land on the decision rather
  // than on a description you have already read.
  //
  // Decided on the ticket changing and only then, the same render-time pattern as
  // `last` above rather than an effect on the plan's status: approving a plan clears
  // `awaiting-review` seconds later, and an effect watching that would yank the
  // reviewer off the tab they are still reading the outcome on.
  const [tabbedFor, setTabbedFor] = useState<string>();
  if (shown && shown.key !== tabbedFor) {
    setTabbedFor(shown.key);
    setTab(shown.plan?.status === "awaiting-review" ? "plan" : "overview");
  }

  const root = shown ? ticketNodeOf(shown) : undefined;
  const pullRequests = shown ? shown.nodes.filter((node) => node.kind === "mr") : [];
  // `shown.nodes` is sorted by id (random per node), not time — that ordering
  // exists so the graph canvas lays out identically between polls, and reusing
  // it here put runs in an arbitrary UUID-lottery order instead of newest
  // first. Re-sorted by `at` for the Runs tab specifically; nodes with no
  // timestamp (loop/mr/action) keep falling to the end.
  const work = shown
    ? dedupeJobRunPairs(shown.nodes.filter((node) => node.kind !== "ticket" && node.kind !== "mr"))
        .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    : [];

  return (
    <Drawer
      open={cluster != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      swipeDirection="right"
    >
      <DrawerContent
        keepMounted
        className="ticket-panel max-[900px]:rounded-none data-[swipe-axis=x]:sm:[--drawer-content-width:66.6667vw] [&[data-open]:not([data-starting-style]):not([data-swiping])]:transform-none [&[data-open]:not([data-starting-style]):not([data-swiping])]:will-change-auto"
      >
        {shown ? (
          <>
            <header className="flex shrink-0 items-start justify-between gap-3 px-4 pt-4">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <DrawerTitle className="flex min-w-0 items-baseline gap-2 text-foreground">
                  <span className="shrink-0 font-mono text-[1.0625rem] font-medium [&_a]:inline-flex [&_a]:items-center [&_a]:gap-[5px] [&_a]:text-inherit [&_a]:no-underline [&_a:hover]:underline [&_a:hover]:underline-offset-3 [&_a_svg]:text-[var(--text-faint)] [&_a_svg]:transition-colors [&_a:hover_svg]:text-[var(--brand)]">
                    {shown.url ? (
                      <a
                        href={shown.url}
                        target="_blank"
                        rel="noreferrer"
                        title={`Open ${shown.key}`}
                      >
                        {shown.key}
                      </a>
                    ) : (
                      shown.key
                    )}
                  </span>
                  {shown.title ? (
                    <span className="truncate text-base font-medium">{shown.title}</span>
                  ) : null}
                </DrawerTitle>
                <TicketRefreshButton issueKey={shown.key} scope={scope} />
                <TicketActionsMenu
                  cluster={shown}
                  onAction={onTicketAction}
                  {...(busyTicketAction ? { busy: busyTicketAction } : {})}
                />
              </div>
              <DrawerClose className={ICON_BUTTON_CLASS} aria-label="Close detail panel">
                <X size={14} strokeWidth={2} />
              </DrawerClose>
            </header>

            <Tabs
              value={tab}
              onValueChange={(value) => setTab(value as Tab)}
              className="min-h-0 flex-1"
            >
              <TabsList variant="line">
                <TabsTrigger value="overview">
                  Overview
                </TabsTrigger>
                <TabsTrigger value="plan">
                  Plan
                  {/* A dot rather than a count: there is at most one plan in play per
                      ticket, and what the tab has to say is "somebody has to read
                      this", which the gold matches on the card. */}
                  {shown.plan?.status === "awaiting-review" ? (
                    <span
                      className="size-1.5 rounded-full bg-[var(--warn)]"
                      aria-label="waiting for review"
                    />
                  ) : null}
                </TabsTrigger>
                <TabsTrigger value="activity">
                  Runs
                  {work.length > 0 ? (
                    <span className="rounded-full bg-[var(--bg-muted)] px-1.5 py-px font-mono text-xs text-[var(--text-faint)]">
                      {work.length}
                    </span>
                  ) : null}
                </TabsTrigger>
              </TabsList>

              <TabsContent
                value="overview"
                className="tab-panel flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4 text-inherit"
              >
                <TicketDetail
                  issueKey={shown.key}
                  facts={root?.ticket}
                  pullRequests={pullRequests}
                />
              </TabsContent>
              {/* Mounted only while it is the open tab, which is also what gates its
                  poll: `queries.ticketPlan` refetches every five seconds so a plan
                  appears the moment its container exits, and there is no reason to run
                  that for a ticket whose Plan tab nobody has opened. */}
              <TabsContent
                value="plan"
                className="tab-panel flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4 text-inherit"
              >
                {tab === "plan" ? (
                  <PlanTab
                    issueKey={shown.key}
                    onPlanIssue={() => onTicketAction(shown, "plan-issue")}
                    planning={busyTicketAction === "plan-issue"}
                  />
                ) : null}
              </TabsContent>
              <TabsContent
                value="activity"
                className="tab-panel flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4 text-inherit"
              >
                <ActivityTab
                  work={work}
                  onOpenTask={onOpenTask}
                  onCancelJob={onCancelJob}
                  cancelling={cancelling}
                  onAction={onAction}
                  busy={busy}
                />
              </TabsContent>
            </Tabs>
          </>
        ) : (
          <DrawerTitle className="sr-only">Ticket detail</DrawerTitle>
        )}
      </DrawerContent>
    </Drawer>
  );
}

function TicketRefreshButton({
  issueKey,
  scope,
}: {
  issueKey: string;
  scope: PullRequestScope;
}) {
  const queryClient = useQueryClient();
  const fetching =
    useIsFetching({ queryKey: keys.ticket(issueKey), exact: true }) +
      useIsFetching({ queryKey: keys.graph(scope), exact: true }) +
      useIsFetching({ queryKey: keys.allPrs() }) >
    0;

  return (
    <Tip label="Re-read from Jira">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={ICON_BUTTON_CLASS}
        aria-label={`Re-read ${issueKey} from Jira`}
        disabled={fetching}
        onClick={() => refresh.ticket(queryClient, issueKey, scope)}
      >
        <RefreshCw size={14} strokeWidth={2} className={fetching ? "animate-spin" : ""} />
      </Button>
    </Tip>
  );
}

/** Every MR, job and run around this ticket, newest concerns first — the order the graph already emits them in. */
function ActivityTab({
  work,
  onOpenTask,
  onCancelJob,
  cancelling,
  onAction,
  busy,
}: {
  work: GraphNode[];
  onOpenTask: (taskId: string) => void;
  onCancelJob: (jobId: string) => void;
  cancelling: ReadonlySet<string>;
  onAction: (node: GraphNode, action: MrActionId) => void;
  busy: Record<string, MrActionId | undefined>;
}) {
  if (work.length === 0) {
    return (
      <p className="m-0 text-[0.7812rem] text-[var(--text-faint)] italic">
        Nothing has run for this ticket yet.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {work.map((node) => (
        <ActivityRow
          key={node.id}
          node={node}
          onOpenTask={onOpenTask}
          onCancelJob={onCancelJob}
          cancelling={node.jobId ? cancelling.has(node.jobId) : false}
          onAction={onAction}
          busyAction={busy[node.id]}
        />
      ))}
    </div>
  );
}

function ActivityRow({
  node,
  onOpenTask,
  onCancelJob,
  cancelling,
  onAction,
  busyAction,
}: {
  node: GraphNode;
  onOpenTask: (taskId: string) => void;
  onCancelJob: (jobId: string) => void;
  cancelling: boolean;
  onAction: (node: GraphNode, action: MrActionId) => void;
  busyAction?: MrActionId;
}) {
  const [open, setOpen] = useState(false);
  const KindIcon = KIND_ICONS[node.kind];
  const StatusIcon = STATUS_ICONS[node.status];
  const hasLog = node.executionId != null;
  const expandable = hasLog || node.e2e != null || node.job?.error != null;
  const Chevron = open ? ChevronUp : ChevronDown;

  return (
    <div
      className={cn(
        "rounded-[var(--radius)] border bg-[var(--bg-raised)]",
        activityBorder(node.status),
      )}
    >
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-2.5 py-2 text-left font-[inherit] text-foreground disabled:cursor-default"
        aria-expanded={open}
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className={cn(
            "grid size-4.5 shrink-0 place-items-center rounded-[5px] bg-[var(--bg-muted)]",
            kindColor(node.kind),
          )}
        >
          <KindIcon size={12} strokeWidth={2} />
        </span>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[0.7812rem] text-foreground">
          {node.label}
        </span>
        {node.sublabel ? (
          <span className="line-clamp-3 overflow-hidden text-sm leading-[1.35] text-muted-foreground">
            {node.sublabel}
          </span>
        ) : null}
        <span
          className={cn(
            "inline-flex items-center gap-[3px] font-mono text-xs tracking-[0.05em] uppercase",
            statusColor(node.status),
          )}
        >
          <StatusIcon size={9} strokeWidth={2.5} />
          {STATUS_WORDS[node.status]}
        </span>
        {node.url ? (
          <a
            className="shrink-0 leading-none text-[var(--text-faint)] hover:text-success"
            href={node.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${node.label} externally`}
            onClick={(event) => event.stopPropagation()}
          >
            <ExternalLink size={11} strokeWidth={2} />
          </a>
        ) : null}
        {expandable ? <Chevron size={13} strokeWidth={2.5} /> : null}
      </button>

      <div className="flex flex-wrap gap-2 px-2.5 pb-2 empty:hidden">
        {node.kind === "mr"
          ? MR_ACTIONS.map(({ id, label, Icon }) => {
              const actionable = node.pullRequest != null || (node.subjectKey && node.taskId);
              const reason = actionable
                ? undefined
                : "This merge request could not be identified well enough to act on";
              const running = busyAction === id;
              return (
                <button
                  key={id}
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-[5px] rounded-[var(--radius)] border border-[var(--border-strong)] bg-transparent px-2.5 py-[5px] font-[inherit] text-[0.7812rem] text-[var(--text-dim)] hover:bg-[var(--bg-hover)] hover:text-foreground disabled:cursor-progress disabled:opacity-55"
                  disabled={reason != null || running}
                  title={reason ?? label}
                  onClick={() => onAction(node, id)}
                >
                  {running ? (
                    <LoaderCircle size={11} strokeWidth={2.5} className="animate-spin" />
                  ) : (
                    <Icon size={11} strokeWidth={2.5} />
                  )}
                  {label}
                </button>
              );
            })
          : null}
        {node.taskId ? (
          <button
            className="inline-flex cursor-pointer items-center gap-[5px] rounded-[var(--radius)] border border-[var(--border-strong)] bg-transparent px-2.5 py-[5px] font-[inherit] text-[0.7812rem] text-[var(--text-dim)] hover:bg-[var(--bg-hover)] hover:text-foreground"
            onClick={() => onOpenTask(node.taskId!)}
          >
            Open task
          </button>
        ) : null}
        {node.jobId ? (
          <button
            className="inline-flex cursor-pointer items-center gap-[5px] rounded-[var(--radius)] border border-[color-mix(in_srgb,var(--failure)_45%,var(--border-strong))] bg-transparent px-2.5 py-[5px] font-[inherit] text-[0.7812rem] text-[var(--failure)] hover:bg-[color-mix(in_srgb,var(--failure)_14%,transparent)] disabled:cursor-progress disabled:opacity-55"
            disabled={cancelling}
            onClick={() => onCancelJob(node.jobId!)}
          >
            <Square size={11} strokeWidth={2.5} />
            {cancelling ? "Stopping…" : node.status === "running" ? "Stop" : "Drop from queue"}
          </button>
        ) : null}
      </div>

      {open && node.job?.error ? <ErrorBox>{node.job.error}</ErrorBox> : null}
      {open && node.e2e ? <E2eResult result={node.e2e} /> : null}

      {open && hasLog ? (
        <ActivityLog executionId={node.executionId} live={node.status === "running"} />
      ) : null}
    </div>
  );
}

function E2eResult({ result }: { result: E2eTestResultView }) {
  const queryClient = useQueryClient();
  const writeTest = useAction();
  const [testMrDialogOpen, setTestMrDialogOpen] = useState(false);
  const screenshots = result.artifacts.filter((artifact) => artifact.kind === "screenshot");
  const diagnostics = result.artifacts.filter((artifact) => artifact.kind !== "screenshot");
  const tone =
    result.verdict === "pass"
      ? "border-[color-mix(in_srgb,var(--success)_45%,var(--border))] text-[var(--success)]"
      : result.verdict === "fail"
        ? "border-[color-mix(in_srgb,var(--failure)_45%,var(--border))] text-[var(--failure)]"
        : "border-[color-mix(in_srgb,var(--warn)_45%,var(--border))] text-[var(--warn)]";
  const eligible = result.exportable;
  const testMr = result.testMr;
  const writing = testMr?.status === "queued" || testMr?.status === "running";
  const createTestMr = async (targetBranch: string) => {
    const queued = await writeTest.run(async () => {
      await api.writeE2eTestMr({ sourceJobId: result.jobId, targetBranch });
      invalidate.graph(queryClient);
    });
    if (queued) setTestMrDialogOpen(false);
  };
  return (
    <div className="mx-2.5 mb-2.5 flex flex-col gap-3 rounded-md border border-border bg-[var(--bg-deep)] p-3">
      <div className="flex items-start gap-2">
        <span className={cn("rounded border px-1.5 py-0.5 font-mono text-xs uppercase", tone)}>
          {result.verdict}
        </span>
        <p className="m-0 text-sm leading-5 text-foreground">{result.summary}</p>
      </div>

      <div>
        <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Scenarios
        </h4>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {result.scenarios.map((scenario) => (
            <li key={`${scenario.name}:${scenario.outcome}`} className="text-sm text-foreground">
              <span
                className={cn(
                  "mr-1.5 font-mono text-xs uppercase",
                  scenario.outcome === "pass"
                    ? "text-[var(--success)]"
                    : scenario.outcome === "fail"
                      ? "text-[var(--failure)]"
                      : "text-[var(--warn)]",
                )}
              >
                {scenario.outcome}
              </span>
              <strong>{scenario.name}</strong>
              <span className="text-muted-foreground"> — {scenario.detail}</span>
            </li>
          ))}
        </ul>
      </div>

      {result.findings.length > 0 ? (
        <div>
          <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Findings
          </h4>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {result.findings.map((finding) => (
              <li key={`${finding.severity}:${finding.title}`} className="text-sm">
                <span className="mr-1.5 font-mono text-xs text-[var(--failure)] uppercase">
                  {finding.severity}
                </span>
                <strong>{finding.title}</strong>
                <p className="m-0 mt-0.5 text-muted-foreground">{finding.detail}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {screenshots.length > 0 ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {screenshots.map((artifact) => (
            <a
              key={artifact.url}
              href={artifact.url}
              target="_blank"
              rel="noreferrer"
              className="overflow-hidden rounded-md border border-border bg-background"
              title={`Open ${artifact.name}`}
            >
              <img
                src={artifact.url}
                alt={artifact.name}
                className="max-h-56 w-full object-contain"
                loading="lazy"
              />
              <span className="block truncate border-t border-border px-2 py-1 font-mono text-xs text-muted-foreground">
                {artifact.name}
              </span>
            </a>
          ))}
        </div>
      ) : null}

      {diagnostics.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {diagnostics.map((artifact) => (
            <Button key={artifact.url} variant="outline" size="sm" asChild>
              <a href={artifact.url} target="_blank" rel="noreferrer">
                {artifact.kind === "trace" ? "Trace" : "Log"}: {artifact.name}
              </a>
            </Button>
          ))}
        </div>
      ) : null}

      {eligible ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {testMr?.status === "opened" && testMr.mrUrl ? (
            <Button variant="outline" size="sm" asChild>
              <a href={testMr.mrUrl} target="_blank" rel="noreferrer">
                <GitPullRequest size={12} />
                View Playwright coverage MR
              </a>
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={writeTest.busy || writing}
              onClick={() => setTestMrDialogOpen(true)}
            >
              {writeTest.busy || writing
                ? <LoaderCircle size={12} className="animate-spin" />
                : <GitPullRequest size={12} />}
              {writing
                ? "Writing Playwright test…"
                : testMr?.status === "dead" || testMr?.status === "no-change"
                  ? "Retry Playwright coverage"
                  : "Add Playwright coverage"}
            </Button>
          )}
          {testMr?.error ? <span className="text-xs text-[var(--failure)]">{testMr.error}</span> : null}
          {writeTest.error ? <ErrorBox>{writeTest.error}</ErrorBox> : null}
          {writeTest.done ? (
            <span className="text-xs text-muted-foreground">Queued.</span>
          ) : null}
        </div>
      ) : null}
      {testMrDialogOpen ? (
        <E2eTestMrDialog
          result={result}
          busy={writeTest.busy}
          onConfirm={createTestMr}
          onCancel={() => setTestMrDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}
