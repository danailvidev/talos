import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  CheckCircle2,
  History,
  Inbox,
  Info,
  ListChecks,
  Pencil,
  RotateCw,
  Square,
  Timer,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence } from "motion/react";

import {
  api,
  type TaskDetail as TaskDetailData,
  type TicketPersonView,
} from "./api.ts";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table.tsx";
import { ago } from "./format.ts";
import { LoopCharts } from "./charts/LoopCharts.tsx";
import { CiFailureSettings } from "./CiFailureSettings.tsx";
import { DatadogScanSettings } from "./DatadogScanSettings.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { FlakySpecsPanel } from "./FlakySpecsPanel.tsx";
import { ExternalReleasePollInfo } from "./ExternalReleasePollInfo.tsx";
import { JiraTicketToMrSettings } from "./JiraTicketToMrSettings.tsx";
import { LoopPromptSettings, loopHasPrompt } from "./LoopPromptSettings.tsx";
import { LoopScheduleControls } from "./LoopScheduleControls.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { ActivityLog } from "./Steps.tsx";
import { Button } from "./components/ui/button.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { ICON_BUTTON_CLASS, ICON_BUTTON_DANGER_CLASS } from "./app-styles.ts";
import { cn } from "./lib/utils.ts";
import { PAGE_TITLE_CLASS, SECTION_TITLE_CLASS } from "./typography-styles.ts";
import { Input } from "./components/ui/input.tsx";
import { Tip } from "./Tip.tsx";
import { useFormat } from "./FormatContext.tsx";
import { invalidate, queries } from "./queries.ts";
import { useApi } from "./useApi.ts";
import { ciFailureConfig } from "./ci-failure-params.ts";
import { RunHistory } from "./runs/RunHistory.tsx";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import { toMessage } from "./errors.ts";
import { useAction } from "./useAction.ts";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
} from "./components/ui/popover.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./components/ui/tabs.tsx";

type DetailTab = "overview" | "settings" | "activity" | "flaky";

/**
 * Loops whose detail page offers a Spec failures tab — the ones that write into
 * `TestRunHistoryRepository`. A closed list rather than "any loop with a
 * project configured": most loops have nothing to do with test results at all,
 * and an empty, meaningless tab on every one of them would be worse than none.
 */
const FLAKY_SPECS_DEFINITION_IDS = new Set(["gitlab-ci-failure"]);

/**
 * Loops whose Overview plots its history instead of only counting it. Same
 * closed-list reasoning as the flaky tab: the charts read a loop's items as
 * "failures seen / tickets filed / deduplicated", which is what this loop's
 * counters actually mean and not what every loop's do.
 */
const CHART_DEFINITION_IDS = new Set(["gitlab-ci-failure", "datadog-scan"]);

export function TaskDetail({
  id,
  onChanged,
  onDeleted,
  onToast,
}: {
  id: string;
  onChanged?: () => void;
  /** Called after the loop is gone, so the page can drop its selection. */
  onDeleted?: () => void;
  onToast?: (text: string) => void;
}) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [rerunning, setRerunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [runError, setRunError] = useState<string>();
  const queryClient = useQueryClient();
  const toggling = useAction({ onError: (message) => onToast?.(message) });

  /**
   * How long to keep watching after something was asked for.
   *
   * A run that was just queued has no `running` status to poll on yet, so the
   * poll needs a reason to exist for a few seconds regardless — this is that
   * reason, and it replaces the self-clearing interval that used to guess at it.
   */
  const [settleUntil, setSettleUntil] = useState(0);
  const settle = () => setSettleUntil(Date.now() + 15_000);

  const { data, error, loading } = useApi(queries.task(id, { settleUntil }));

  /**
   * Everything about this task — its detail, its page of runs, its row in the
   * list — and the footer's job counts, since running or cancelling from here is
   * what changed them.
   */
  const refresh = () => invalidate.jobQueue(queryClient);

  const activeRun =
    data?.lastRun?.status === "running"
      ? data.lastRun
      : data?.runs.find((run) => run.status === "running");
  const running = activeRun != null || rerunning;
  /** The active run the Runs tab follows live; completed runs stay in history. */
  const streamedExecutionId = activeRun?.executionId;
  const needsTargets = data?.kind === "loop" && data.usesGitLab && data.usesJira;
  const hasCiFailureSettings = data?.definitionId === "gitlab-ci-failure";
  const hasDatadogSettings = data?.definitionId === "datadog-scan";
  const hasSettings = data?.kind === "loop";
  const hasFlakySpecs = data != null && FLAKY_SPECS_DEFINITION_IDS.has(data.definitionId);

  useEffect(() => {
    if (tab === "settings" && !hasSettings) setTab("overview");
    if (tab === "flaky" && !hasFlakySpecs) setTab("overview");
  }, [hasSettings, hasFlakySpecs, tab]);

  async function rerun() {
    setRerunning(true);
    setRunError(undefined);
    settle();
    try {
      if (needsTargets) {
        const fresh = await api.task(id);
        const targets = ciFailureConfig(fresh.params);
        if (!targets.gitlabProject || !targets.jiraProject || !targets.bugFoundBy) {
          setRunError(
            "Set a GitLab project, Jira project key, and Bug found by in the Settings tab, then rerun.",
          );
          return;
        }
      }
      await api.runTask(id);
      onChanged?.();
      refresh();
      settle();
    } catch (err) {
      setRunError(toMessage(err));
    } finally {
      setRerunning(false);
    }
  }

  function toggle(enabled: boolean) {
    if (toggling.busy || !data) return;
    void toggling.run(async () => {
      await api.updateSchedule(id, { enabled });
      refresh();
      onChanged?.();
      onToast?.(`${data.name} ${enabled ? "activated" : "paused"}`);
    });
  }

  async function cancel() {
    setCancelling(true);
    setRunError(undefined);
    try {
      await api.cancelTask(id);
      refresh();
      settle();
    } catch (err) {
      setRunError(toMessage(err));
    } finally {
      setCancelling(false);
    }
  }

  /**
   * Rejects on failure rather than reporting it here: `ConfirmDialog` keeps
   * itself open and shows the message, which is the only place the user is still
   * looking when a delete is refused (a running loop, or someone else's).
   */
  async function remove() {
    await api.deleteInstance(id);
    refresh();
    onToast?.(`${data?.name ?? "Loop"} deleted`);
    onDeleted?.();
  }

  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (loading || !data) return <Loading>Loading…</Loading>;

  return (
    <div>
      <Head
        task={data}
        rerunning={rerunning}
        cancelling={cancelling}
        onRerun={rerun}
        onCancel={cancel}
        toggling={toggling.busy}
        onToggle={toggle}
        onRenamed={() => refresh()}
      />

      <AnimatePresence>
        {confirmDelete ? (
          <ConfirmDialog
            title={`Delete ${data.name}?`}
            body={
              "This removes the loop, its schedule and everything it was tracking. " +
              "Its run history is kept. This cannot be undone."
            }
            confirmLabel="Delete loop"
            onConfirm={remove}
            onClose={() => setConfirmDelete(false)}
          />
        ) : null}
      </AnimatePresence>
      {runError ? <ErrorBox>{runError}</ErrorBox> : null}

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as DetailTab)}
      >
        <TabsList variant="line">
          <TabsTrigger value="overview">
            Overview
          </TabsTrigger>
          {hasFlakySpecs ? (
            <TabsTrigger value="flaky">
              Spec failures
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="activity">
            Runs
          </TabsTrigger>
          {hasSettings ? (
            <TabsTrigger value="settings">
              Settings
            </TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="overview" className="tab-panel flex-none text-inherit">
          <>
            <Overview task={data} />

            <Issues task={data} />
          </>
        </TabsContent>
        {hasSettings ? (
          <TabsContent value="settings" className="tab-panel flex-none text-inherit">
            <>
              {data.definitionId === "jira-ticket-to-mr" ? (
                <JiraTicketToMrSettings
                  task={data}
                  onChanged={() => refresh()}
                  onToast={onToast}
                />
              ) : null}
              {hasCiFailureSettings ? (
                <CiFailureSettings
                  task={data}
                  onSaved={() => refresh()}
                  onToast={onToast}
                />
              ) : hasDatadogSettings ? (
                <DatadogScanSettings
                  task={data}
                  onSaved={() => refresh()}
                  onToast={onToast}
                />
              ) : (
                <section className="mb-5.5">
                  <h2 className={SECTION_TITLE_CLASS}>Schedule</h2>
                  <LoopScheduleControls
                    task={data}
                    onChanged={() => refresh()}
                    onToast={onToast}
                  />
                </section>
              )}
              {loopHasPrompt(data.definitionId) ? (
                <LoopPromptSettings
                  task={data}
                  onChanged={() => refresh()}
                  onToast={onToast}
                />
              ) : null}
              {data.visibility !== undefined ? (
                <section className="mt-7 border-t border-border pt-5">
                  <h2 className={SECTION_TITLE_CLASS}>Delete loop</h2>
                  <p className="mb-2 max-w-180 text-sm text-muted-foreground">
                    Removes this loop, its schedule, and everything it tracks. Run history is kept.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={running}
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 size={14} strokeWidth={2} />
                    Delete loop
                  </Button>
                  {running ? (
                    <p className="mt-1.5 text-sm text-[var(--text-faint)]">
                      Cancel the active run before deleting this loop.
                    </p>
                  ) : null}
                </section>
              ) : null}
            </>
          </TabsContent>
        ) : null}
        {hasFlakySpecs ? (
          <TabsContent value="flaky" className="tab-panel flex-none text-inherit">
            <FlakySpecsPanel project={ciFailureConfig(data.params).gitlabProject} onToast={onToast} />
          </TabsContent>
        ) : null}
        <TabsContent value="activity" className="tab-panel flex-none text-inherit">
          <>
            {streamedExecutionId ? (
              <section className="mb-5.5">
                <ActivityLog executionId={streamedExecutionId} live />
              </section>
            ) : null}

            <RunHistory
              optionsFor={(page) => queries.taskRuns(id, page)}
              fetchKey={id}
              initialRuns={data.runs}
              // The feed above is already following this run at 1 Hz; expanding
              // its row should join that poll, not start a second one.
              streamedExecutionId={streamedExecutionId}
              currentExecutionId={streamedExecutionId}
              onRunsChanged={refresh}
            />
          </>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * What a loop is actually doing, at a glance: its track record, when it next
 * fires, and its tracked items. Configuration — including an agent-backed
 * loop's prompt — lives on the Settings tab.
 */
interface StatCardData {
  label: string;
  value: string;
  icon: LucideIcon;
  tone: "brand" | "success" | "warning" | "neutral";
  compact?: boolean;
}

const STAT_CARD_TONES: Record<
  StatCardData["tone"],
  { card: string; glow: string; icon: string }
> = {
  brand: {
    card:
      "border-[color-mix(in_srgb,var(--action)_28%,var(--border))] bg-[linear-gradient(145deg,var(--action-wash),var(--bg-raised)_62%)]",
    glow: "bg-[var(--action)]",
    icon:
      "bg-[color-mix(in_srgb,var(--action)_18%,transparent)] text-[var(--action-hover)] ring-[color-mix(in_srgb,var(--action)_24%,transparent)]",
  },
  success: {
    card:
      "border-[color-mix(in_srgb,var(--status-success)_28%,var(--border))] bg-[linear-gradient(145deg,var(--status-success-wash),var(--bg-raised)_62%)]",
    glow: "bg-[var(--status-success)]",
    icon:
      "bg-[color-mix(in_srgb,var(--status-success)_18%,transparent)] text-[var(--status-success)] ring-[color-mix(in_srgb,var(--status-success)_24%,transparent)]",
  },
  warning: {
    card:
      "border-[color-mix(in_srgb,var(--status-warning)_28%,var(--border))] bg-[linear-gradient(145deg,var(--status-warning-wash),var(--bg-raised)_62%)]",
    glow: "bg-[var(--status-warning)]",
    icon:
      "bg-[color-mix(in_srgb,var(--status-warning)_18%,transparent)] text-[var(--status-warning)] ring-[color-mix(in_srgb,var(--status-warning)_24%,transparent)]",
  },
  neutral: {
    card:
      "border-[color-mix(in_srgb,var(--text-muted)_24%,var(--border))] bg-[linear-gradient(145deg,var(--bg-hover),var(--bg-raised)_62%)]",
    glow: "bg-[var(--text-muted)]",
    icon:
      "bg-[color-mix(in_srgb,var(--text-muted)_16%,transparent)] text-[var(--text-dim)] ring-[color-mix(in_srgb,var(--text-muted)_20%,transparent)]",
  },
};

const STAT_GRID_COLUMNS = [
  "",
  "lg:grid-cols-1",
  "lg:grid-cols-2",
  "lg:grid-cols-3",
  "lg:grid-cols-4",
  "lg:grid-cols-5",
  "lg:grid-cols-6",
] as const;

function Overview({ task }: { task: TaskDetailData }) {
  const fmt = useFormat();

  // Success rate and duration become the ring and the trend below, so they are
  // not also spelled out as tiles — one number, one place.
  const charts = CHART_DEFINITION_IDS.has(task.definitionId);

  const stats: StatCardData[] = [
    { label: "Runs", value: String(task.stats.total), icon: ListChecks, tone: "brand" },
  ];
  if (!charts && task.stats.total > 0) {
    stats.push({
      label: "Success rate",
      value: `${Math.round((task.stats.successes / task.stats.total) * 100)}%`,
      icon: CheckCircle2,
      tone: "success",
    });
  }
  if (!charts && task.stats.avgDurationMs != null) {
    stats.push({
      label: "Avg duration",
      value: fmt.duration(task.stats.avgDurationMs),
      icon: Timer,
      tone: "neutral",
    });
  }
  if (task.kind === "loop" && task.nextRun) {
    stats.push({
      label: "Next run",
      value: fmt.stamp(task.nextRun),
      icon: CalendarClock,
      tone: "brand",
      compact: true,
    });
  }
  if (task.openIssues > 0) {
    stats.push({
      label: "Open items",
      value: String(task.openIssues),
      icon: Inbox,
      tone: "warning",
    });
  }
  if (task.watermark) {
    stats.push({
      label: "Watermark",
      value: fmt.stamp(task.watermark),
      icon: History,
      tone: "neutral",
      compact: true,
    });
  }

  return (
    <>
      {task.definitionId === "release-repo-poll" ? <ExternalReleasePollInfo /> : null}
      <section className="mb-5.5">
        <h2 className={SECTION_TITLE_CLASS}>Overview</h2>
        <div
          className={cn(
            "grid grid-cols-2 gap-2 sm:grid-cols-3",
            STAT_GRID_COLUMNS[Math.min(stats.length, 6)],
          )}
        >
          {stats.map((stat) => {
            const tone = STAT_CARD_TONES[stat.tone];
            return (
              <Card
                key={stat.label}
                size="sm"
                className={cn(
                  "relative min-h-24 justify-between shadow-[var(--inset-highlight)]",
                  tone.card,
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute -top-8 -right-7 size-24 rounded-full opacity-12 blur-2xl",
                    tone.glow,
                  )}
                />
                <CardHeader className="relative flex items-start justify-between gap-2">
                  <CardTitle className="pt-0.5 text-[0.6875rem] font-medium tracking-[0.04em] text-muted-foreground uppercase">
                    {stat.label}
                  </CardTitle>
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] ring-1",
                      tone.icon,
                    )}
                  >
                    <stat.icon size={16} strokeWidth={2} aria-hidden="true" />
                  </span>
                </CardHeader>
                <CardContent
                  className={cn(
                    "relative font-semibold leading-tight tracking-[-0.02em] text-foreground",
                    stat.compact ? "text-sm" : "text-xl tabular-nums",
                  )}
                >
                  {stat.value}
                </CardContent>
              </Card>
            );
          })}
        </div>
        {charts ? (
          <div className="mt-3">
            <LoopCharts
              runs={task.runs}
              issues={task.issues}
              stats={task.stats}
              mode={task.definitionId === "datadog-scan" ? "datadog" : "ci"}
            />
          </div>
        ) : null}
      </section>
    </>
  );
}

function LoopTitleInfo({ task }: { task: TaskDetailData }) {
  const fmt = useFormat();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openPopover = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
  };
  const closePopover = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  if (task.kind !== "loop") return null;

  const isCodeReview = task.definitionId === "gitlab-code-review";
  const isJiraTicketToMr = task.definitionId === "jira-ticket-to-mr";
  const params =
    task.params && typeof task.params === "object"
      ? (task.params as Record<string, unknown>)
      : {};
  const gitlab =
    params.gitlab && typeof params.gitlab === "object"
      ? (params.gitlab as Record<string, unknown>)
      : {};
  const jira =
    params.jira && typeof params.jira === "object"
      ? (params.jira as Record<string, unknown>)
      : {};
  const project =
    typeof gitlab.projectId === "string" || typeof gitlab.projectId === "number"
      ? String(gitlab.projectId)
      : "the configured GitLab project";
  const mrIid = typeof gitlab.mrIid === "number" ? gitlab.mrIid : undefined;
  const branch = typeof gitlab.branch === "string" ? gitlab.branch : undefined;
  const jiraIssueKey =
    typeof gitlab.jiraIssueKey === "string" ? gitlab.jiraIssueKey : undefined;
  const jiraProject = typeof jira.project === "string" ? jira.project : "the configured project";
  const jiraLabel = typeof jira.label === "string" ? jira.label : "talos";
  const jiraJql = typeof jira.jql === "string" ? jira.jql : undefined;
  const plan =
    params.plan && typeof params.plan === "object"
      ? (params.plan as Record<string, unknown>)
      : {};
  const planGated = plan.required === true;

  const codeReviewScope = isCodeReview
    ? mrIid
      ? `merge request !${mrIid} in ${project}`
      : branch
        ? `branch ${branch} in ${project}`
        : jiraIssueKey
          ? `open merge requests whose branch or title mentions ${jiraIssueKey} in ${project}`
          : `open merge requests in ${project}`
    : undefined;
  const trigger = !task.enabled
    ? "Automatic runs are paused. Activating the loop resumes its configured schedule; Rerun starts one immediately"
    : task.nextRun
      ? `Its configured schedule; the next run is ${fmt.stamp(task.nextRun)}. Rerun starts an additional run immediately`
      : "No automatic run is currently scheduled. Clicking Rerun starts one immediately";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-auto shrink-0 rounded-full border-0 bg-transparent p-0 text-[0.7em] text-[var(--text-faint)] transition-colors hover:bg-transparent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] [&_svg]:size-[1em]"
          aria-label="How this loop works"
          onPointerEnter={openPopover}
          onPointerLeave={closePopover}
          onFocus={(event) => {
            if (event.currentTarget.matches(":focus-visible")) openPopover();
          }}
          onBlur={closePopover}
        >
          <Info size={15} strokeWidth={2} aria-hidden="true" />
        </Button>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side="bottom"
        className="w-110 max-w-[calc(100vw-2rem)] gap-3 p-4 text-left leading-relaxed"
        onPointerEnter={openPopover}
        onPointerLeave={closePopover}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <PopoverHeader>
          <PopoverTitle>How this loop works</PopoverTitle>
        </PopoverHeader>
        <p>
          <strong>What it does:</strong> {task.description ?? "Runs the configured automation."}
        </p>
        <p>
          <strong>Trigger:</strong> {trigger}.
        </p>
        {isCodeReview ? (
          <>
            <p>
              <strong>{branch ? "Which code:" : "Which PRs:"}</strong> {codeReviewScope}.
            </p>
            {branch ? (
              <ul className="list-disc space-y-1 pl-4">
                <li>Checks out the branch and reviews its commits on every run.</li>
                <li>
                  Claude can read the repository and its guidelines for context, but cannot change
                  it.
                </li>
                <li>
                  A branch has no merge request to comment on, so findings appear only in the Runs
                  tab and the run result.
                </li>
              </ul>
            ) : (
              <ul className="list-disc space-y-1 pl-4">
                <li>
                  Reviews up to {task.maxItemsPerRun} matching merge request
                  {task.maxItemsPerRun === 1 ? "" : "s"} per run using the GitLab Changes diff
                  (with a git comparison fallback), commit list, repository context, and repository
                  guidelines.
                </li>
                <li>
                  Scheduled runs skip a merge request when its current head commit was already
                  reviewed; an explicit Rerun reviews it again.
                </li>
                <li>
                  Claude has read-only repository access. The loop posts one GitLab summary comment,
                  updating its temporary progress note when one was created.
                </li>
              </ul>
            )}
            <p>
              The <strong>Code review</strong> action on a pull request starts a separate one-off
              review of that pull request; it does not trigger this loop.
            </p>
          </>
        ) : (
          <>
            {isJiraTicketToMr ? (
              <>
                <p>
                  <strong>Which tickets:</strong>{" "}
                  {jiraJql ? (
                    <>Tickets matching the custom JQL configured for this loop.</>
                  ) : (
                    <>
                      Tickets in {jiraProject} labeled <code>{jiraLabel}</code> whose status
                      category is not Done.
                    </>
                  )}
                </p>
                {/* The one setting that changes what the loop *does* rather than which
                    tickets it picks up, so it belongs in the same breath as the scope. */}
                <p>
                  <strong>What it produces:</strong>{" "}
                  {planGated ? (
                    <>
                      An implementation plan per ticket, and nothing else until somebody approves
                      it on the ticket's Plan tab. Approving is what opens the draft merge
                      request.
                    </>
                  ) : (
                    <>A draft merge request per ticket, with no approval step in between.</>
                  )}
                </p>
              </>
            ) : null}
            <p>Use the Settings tab to view or change this loop’s schedule and configuration.</p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Inline rename control for a task instance's name — pencil toggles an input, Enter/blur saves. */
function RenameableTitle({
  taskId,
  name,
  onRenamed,
}: {
  taskId: string;
  name: string;
  onRenamed: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const write = useAction();

  useEffect(() => {
    setDraft(name);
  }, [name]);

  async function save() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === name) {
      setEditing(false);
      setDraft(name);
      return;
    }
    await write.run(async () => {
      await api.updateInstance(taskId, { name: trimmed });
      setEditing(false);
      onRenamed();
    });
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <Input
          className="min-w-55 bg-[var(--bg-deep)] px-2 py-0.5 font-[inherit] font-semibold tracking-[-0.2px]"
          value={draft}
          autoFocus
          disabled={write.busy}
          onChange={(event) => setDraft(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
            if (event.key === "Escape") {
              setEditing(false);
              setDraft(name);
            }
          }}
          onBlur={() => void save()}
        />
        {write.error ? (
          <span className="text-[0.8125rem] font-normal text-[var(--failure)]">
            {write.error}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span className="group/rename inline-flex items-center gap-1">
      {name}
      <Tip label="Rename">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            ICON_BUTTON_CLASS,
            "size-7 opacity-60 hover:!opacity-100",
          )}
          aria-label="Rename"
          onClick={(event) => {
            event.stopPropagation();
            setEditing(true);
          }}
        >
          <Pencil size={14} strokeWidth={2} />
        </Button>
      </Tip>
    </span>
  );
}

/** Inline rename control for a task instance's description — same pattern as `RenameableTitle`. */
function RenameableSubtitle({
  taskId,
  description,
  onRenamed,
}: {
  taskId: string;
  description?: string;
  onRenamed: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(description ?? "");
  const write = useAction();

  useEffect(() => {
    setDraft(description ?? "");
  }, [description]);

  async function save() {
    const trimmed = draft.trim();
    if (trimmed === (description ?? "")) {
      setEditing(false);
      setDraft(description ?? "");
      return;
    }
    await write.run(async () => {
      await api.updateInstance(taskId, { description: trimmed || null });
      setEditing(false);
      onRenamed();
    });
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1 text-[0.9375rem] align-middle">
        <Input
          className="min-w-65 bg-[var(--bg-deep)] px-2 py-0.5 text-[0.9375rem] font-normal tracking-[-0.2px]"
          value={draft}
          placeholder="Add a description"
          autoFocus
          disabled={write.busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
            if (event.key === "Escape") {
              setEditing(false);
              setDraft(description ?? "");
            }
          }}
          onBlur={() => void save()}
        />
        {write.error ? (
          <span className="text-[0.8125rem] font-normal text-[var(--failure)]">
            {write.error}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span className="group/rename inline-flex items-center gap-1 text-[0.9375rem] align-middle">
      {description ?? (
        <span className="text-[var(--text-faint)] italic">Add a description</span>
      )}
      <Tip label="Edit description">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            ICON_BUTTON_CLASS,
            "size-4.5 opacity-50 hover:!opacity-100",
          )}
          aria-label="Edit description"
          onClick={() => setEditing(true)}
        >
          <Pencil size={12} strokeWidth={2} />
        </Button>
      </Tip>
    </span>
  );
}

function Head({
  task,
  rerunning,
  cancelling,
  onRerun,
  onCancel,
  toggling,
  onToggle,
  onRenamed,
}: {
  task: TaskDetailData;
  rerunning: boolean;
  cancelling: boolean;
  onRerun: () => void;
  onCancel: () => void;
  toggling: boolean;
  onToggle: (enabled: boolean) => void;
  onRenamed: () => void;
}) {
  const running = task.lastRun?.status === "running" || rerunning;
  // Only a user-created instance has a stored name to edit; a code-registered
  // task's name lives in its definition and `PUT /api/tasks/:id` 404s for it.
  // `visibility` is set only on instances (see TaskSummaryView), so it doubles
  // as the signal for whether renaming is possible here.
  const renamable = task.visibility !== undefined;
  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <h1 className={cn(PAGE_TITLE_CLASS, "min-w-0")}>
          {renamable ? (
            <RenameableTitle taskId={task.id} name={task.name} onRenamed={onRenamed} />
          ) : (
            task.name
          )}
          <LoopTitleInfo task={task} />
          <Tip label="Rerun">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(ICON_BUTTON_CLASS, "size-7")}
              aria-label="Rerun"
              disabled={running}
              onClick={onRerun}
            >
              <RotateCw size={16} strokeWidth={2} />
            </Button>
          </Tip>
          {running ? (
            <Tip label="Cancel and stop containers">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(ICON_BUTTON_CLASS, ICON_BUTTON_DANGER_CLASS, "size-7")}
                aria-label="Cancel"
                disabled={cancelling}
                onClick={onCancel}
              >
                <Square size={14} strokeWidth={2.5} />
              </Button>
            </Tip>
          ) : null}
          {running ? (
            <StatusBadge status="running">
              {cancelling ? "cancelling" : "running"}
              {task.lastRun ? ` · ${ago(task.lastRun.startedAt)}` : ""}
            </StatusBadge>
          ) : task.lastRun?.status === "cancelled" ? (
            <StatusBadge status="cancelled">cancelled</StatusBadge>
          ) : null}
        </h1>
        {task.kind === "loop" ? (
          <label className="mt-1 flex shrink-0 items-center gap-2 text-sm font-medium text-muted-foreground">
            {task.enabled ? "Active" : "Paused"}
            <Switch
              checked={task.enabled}
              aria-label={task.enabled ? `Pause ${task.name}` : `Activate ${task.name}`}
              disabled={toggling}
              onCheckedChange={onToggle}
            />
          </label>
        ) : null}
      </div>
      <div className="mb-3.5 text-[0.9375rem] text-[var(--text-dim)]">
        {renamable ? (
          <RenameableSubtitle
            taskId={task.id}
            description={task.description}
            onRenamed={onRenamed}
          />
        ) : (
          task.description ?? task.id
        )}
      </div>
      {task.lastRun?.error ? (
        <ErrorBox>{task.lastRun.error}</ErrorBox>
      ) : null}
    </div>
  );
}

/**
 * Loops whose Tracked rows have no meaningful author: a ci-failure ticket has
 * no per-file author, and every MR follow-up action is taken as the current
 * user, not the MR's author.
 */
const NO_AUTHOR_DEFINITION_IDS = new Set([
  "gitlab-ci-failure",
  "gitlab-mr-follow-up",
  "datadog-scan",
]);
const ISSUES_PER_PAGE = 15;

function JiraAssigneeAvatar({ assignee }: { assignee: TicketPersonView }) {
  const [brokenUrl, setBrokenUrl] = useState<string>();
  const showImage = assignee.avatarUrl && assignee.avatarUrl !== brokenUrl;

  return (
    <Tip label={assignee.name}>
      <span
        className="inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--bg-muted)] text-xs font-bold text-[var(--text-faint)]"
        aria-label={assignee.name}
      >
        {showImage ? (
          <img
            className="size-full object-cover"
            src={assignee.avatarUrl}
            alt=""
            loading="lazy"
            onError={() => setBrokenUrl(assignee.avatarUrl)}
          />
        ) : (
          assignee.name.trim().charAt(0).toUpperCase()
        )}
      </span>
    </Tip>
  );
}

function Issues({ task }: { task: TaskDetailData }) {
  const fmt = useFormat();
  const [page, setPage] = useState(0);
  const options = queries.taskIssues(task.id, {
    limit: ISSUES_PER_PAGE,
    offset: page * ISSUES_PER_PAGE,
  });
  const { data, error, loading } = useApi(options);

  useEffect(() => setPage(0), [task.id]);

  const fallback = page === 0 ? task.issues : [];
  const issues = data?.issues ?? fallback;
  const total = data?.total ?? task.openIssues;

  if (loading && fallback.length === 0) {
    return total > 0 ? (
      <section className="mb-5.5">
        <h2 className={SECTION_TITLE_CLASS}>Tracked ({total})</h2>
        <Loading>Loading tracked items…</Loading>
      </section>
    ) : null;
  }

  if (error && !data && fallback.length === 0) {
    return (
      <section className="mb-5.5">
        <h2 className={SECTION_TITLE_CLASS}>Tracked</h2>
        <ErrorBox>{error}</ErrorBox>
      </section>
    );
  }

  if (total === 0) return null;

  const showAuthor = !NO_AUTHOR_DEFINITION_IDS.has(task.definitionId);
  const showAssignee =
    task.definitionId === "gitlab-ci-failure" || task.definitionId === "datadog-scan";
  const lastPage = Math.max(0, Math.ceil(total / ISSUES_PER_PAGE) - 1);
  const rangeStart = page * ISSUES_PER_PAGE + 1;
  const rangeEnd = Math.min(total, page * ISSUES_PER_PAGE + issues.length);

  return (
    <section className="mb-5.5">
      <h2 className={SECTION_TITLE_CLASS}>Tracked ({total})</h2>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <Table className="min-w-192 table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-24">Ref</TableHead>
            <TableHead>Title</TableHead>
            {showAuthor ? <TableHead className="w-40">Author</TableHead> : null}
            {showAssignee ? <TableHead className="w-18 text-center">Assignee</TableHead> : null}
            <TableHead className="w-20">State</TableHead>
            <TableHead className="w-14 text-center">Seen</TableHead>
            <TableHead className="w-24">First seen</TableHead>
            <TableHead className="w-24">Last seen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {issues.map((issue) => (
            <TableRow key={issue.issueKey}>
              <TableCell className="mono">
                {issue.issueUrl ? (
                  <a href={issue.issueUrl} target="_blank" rel="noreferrer">
                    {issue.issueKey}
                  </a>
                ) : (
                  issue.issueKey
                )}
              </TableCell>
              <TableCell className="min-w-0 whitespace-normal">
                <Tip label={issue.subject}>
                  <div className="block w-full overflow-hidden text-ellipsis whitespace-nowrap text-[0.9375rem] font-medium">
                    {issue.subject}
                  </div>
                </Tip>
              </TableCell>
              {showAuthor ? <TableCell>{issue.author ?? "—"}</TableCell> : null}
              {showAssignee ? (
                <TableCell className="text-center">
                  {issue.assignee ? (
                    <span className="inline-flex">
                      <JiraAssigneeAvatar assignee={issue.assignee} />
                    </span>
                  ) : (
                    <span className="text-[var(--text-faint)]">—</span>
                  )}
                </TableCell>
              ) : null}
              <TableCell>
                <StatusBadge status={issue.state === "open" ? "warn" : "disabled"}>
                  {issue.state}
                </StatusBadge>
              </TableCell>
              <TableCell className="text-center">{issue.seenCount}</TableCell>
              <TableCell className="mono">
                <Tip label={fmt.stamp(issue.filedAt)}>
                  <span>{ago(issue.filedAt)}</span>
                </Tip>
              </TableCell>
              <TableCell className="mono">
                <Tip label={fmt.stamp(issue.lastSeenAt)}>
                  <span>{ago(issue.lastSeenAt)}</span>
                </Tip>
              </TableCell>
            </TableRow>
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
            onClick={() => setPage((current) => current - 1)}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page >= lastPage}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </section>
  );
}
