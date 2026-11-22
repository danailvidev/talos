import { useState } from "react";
import { Clock, Infinity as InfinityIcon, LayoutGrid, LayoutList, Lock, MoreVertical, Plus, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { api, type TaskSummary } from "./api.ts";
import { Card, CardContent } from "./components/ui/card.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { CreateTaskPanel } from "./CreateTaskPanel.tsx";
import { DatadogIcon } from "./DatadogIcon.tsx";
import { ago } from "./format.ts";
import { GitLabIcon } from "./GitLabIcon.tsx";
import { JiraIcon } from "./JiraIcon.tsx";
import { Tip } from "./Tip.tsx";
import { TitleInfo } from "./TitleInfo.tsx";
import { useFormat, type Formatters } from "./FormatContext.tsx";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { useAction } from "./useAction.ts";
import { Button } from "./components/ui/button.tsx";
import { ICON_BUTTON_CLASS, ICON_BUTTON_DANGER_CLASS } from "./app-styles.ts";
import { cn } from "./lib/utils.ts";
import { PAGE_TITLE_CLASS } from "./typography-styles.ts";
import { EMPTY_STATE_CLASS } from "./state-styles.ts";

const ICON_SIZE = 16;

const DEMO_ORDER = ["demo-nightly-audit", "demo-pr-feedback", "demo-weekly-security"];

/** Static last-run copy for the three showcase loops until they actually run. */
const DEMO_LAST_RUN: Record<string, string> = {
  "demo-nightly-audit": "4h ago",
  "demo-pr-feedback": "12m ago",
  "demo-weekly-security": "3d ago",
};

function LoopCardIcon({ task }: { task: TaskSummary }) {
  if (task.definitionId === "datadog-scan" || task.id === "datadog-scan") {
    return <DatadogIcon size={ICON_SIZE} />;
  }
  if (task.usesGitLab && task.usesJira) {
    return (
      <>
        <GitLabIcon size={ICON_SIZE} />
        <JiraIcon size={ICON_SIZE} />
      </>
    );
  }
  if (task.usesGitLab) return <GitLabIcon size={ICON_SIZE} />;
  if (task.usesJira) return <JiraIcon size={ICON_SIZE} />;
  return <InfinityIcon size={ICON_SIZE} strokeWidth={2.5} />;
}

function sortLoops(rows: TaskSummary[]): TaskSummary[] {
  return [...rows].sort((a, b) => {
    const ai = DEMO_ORDER.indexOf(a.id);
    const bi = DEMO_ORDER.indexOf(b.id);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return a.name.localeCompare(b.name);
  });
}

function lastRunLabel(task: TaskSummary): string {
  if (task.lastRun) return ago(task.lastRun.startedAt);
  return DEMO_LAST_RUN[task.id] ?? "never";
}

/** "3 found · 12s" — what the last run actually did, at a glance. */
function statsLabel(task: TaskSummary, fmt: Formatters): string | null {
  const { lastRun } = task;
  if (!lastRun) return null;
  const parts: string[] = [];
  if (lastRun.itemsProcessed != null) {
    parts.push(`${lastRun.itemsProcessed} found`);
  }
  if (lastRun.durationMs != null) parts.push(fmt.duration(lastRun.durationMs));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Card grid over scheduled loops. Schedule editing lives on the detail page;
 * here the operator only needs identity, on/off, and when it last ran.
 */
export function LoopsDashboard({
  rows,
  definitions,
  loading,
  error,
  addOpen,
  onSetAdd,
  onOpenLoop,
  onListView,
  onCreated,
  onChanged,
  hasMore,
  onLoadMore,
  onToast,
}: {
  rows: TaskSummary[];
  definitions: TaskSummary[];
  loading: boolean;
  error?: string;
  addOpen: boolean;
  onSetAdd: (open: boolean) => void;
  onOpenLoop: (id: string) => void;
  onListView: () => void;
  onCreated: (id: string) => void;
  onChanged: () => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onToast: (text: string) => void;
}) {
  if (addOpen) {
    return (
      <div className="min-h-0 w-full overflow-y-auto px-4 pt-5 pb-8 min-[901px]:px-[34px] min-[901px]:pt-8 min-[901px]:pb-12">
        <CreateTaskPanel
          definitions={definitions}
          onCancel={() => onSetAdd(false)}
          onCreated={onCreated}
        />
      </div>
    );
  }

  const ordered = sortLoops(rows);

  return (
    <div className="min-h-0 w-full overflow-y-auto px-4 pt-5 pb-8 min-[901px]:px-[34px] min-[901px]:pt-8 min-[901px]:pb-12">
      <header className="mb-7 flex items-start justify-between gap-6 max-[720px]:flex-col">
        <div>
          <h1 className={PAGE_TITLE_CLASS}>
            Automated Loops
            <TitleInfo>
              Manage repetitive AI-driven workflows. Loops run autonomously on triggers or
              schedules to maintain repository health.
            </TitleInfo>
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Tip label="List view">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={ICON_BUTTON_CLASS}
              aria-label="List view"
              onClick={onListView}
            >
              <LayoutList size={16} strokeWidth={2} />
            </Button>
          </Tip>
          <span
            className={cn(
              ICON_BUTTON_CLASS,
              "cursor-default bg-[var(--bg-raised)] text-foreground hover:translate-y-0",
            )}
            aria-hidden="true"
          >
            <LayoutGrid size={16} strokeWidth={2} />
          </span>
          {definitions.length > 0 ? (
            <Button
              type="button"
              className="h-9 rounded-[var(--radius-control)] py-0 pr-3.5 pl-2 text-[0.9375rem] font-semibold transition-[background,transform] hover:-translate-y-px hover:bg-[var(--action-hover)]"
              onClick={() => onSetAdd(true)}
            >
              <span className="inline-flex size-5.5 items-center justify-center rounded-[var(--radius-compact)] bg-[color-mix(in_srgb,var(--bg-deep)_18%,transparent)]">
                <Plus size={14} strokeWidth={2.5} />
              </span>
              Create Loop
            </Button>
          ) : (
            <Tip label="No creatable loop templates yet">
              <Button
                type="button"
                className="h-9 rounded-[var(--radius-control)] py-0 pr-3.5 pl-2 text-[0.9375rem] font-semibold"
                disabled
              >
                <span className="inline-flex size-5.5 items-center justify-center rounded-[var(--radius-compact)] bg-[color-mix(in_srgb,var(--bg-deep)_18%,transparent)]">
                  <Plus size={14} strokeWidth={2.5} />
                </span>
                Create Loop
              </Button>
            </Tip>
          )}
        </div>
      </header>

      {error ? (
        <ErrorBox>{error}</ErrorBox>
      ) : loading && rows.length === 0 ? (
        <Loading>Loading loops…</Loading>
      ) : rows.length === 0 ? (
        <div className={EMPTY_STATE_CLASS}>No loops yet. Create one to put work on a schedule.</div>
      ) : (
        <div className="grid grid-cols-3 gap-4 max-[1100px]:grid-cols-2 max-[720px]:grid-cols-1">
          {ordered.map((task, index) => (
            <LoopCard
              key={task.id}
              task={task}
              index={index}
              onOpen={() => onOpenLoop(task.id)}
              onChanged={onChanged}
              onToast={onToast}
            />
          ))}
        </div>
      )}
      {hasMore && onLoadMore ? (
        <Button
          type="button"
          variant="link"
          className="h-auto w-full justify-start px-3.5 py-3 font-[inherit] text-sm text-muted-foreground"
          onClick={onLoadMore}
        >
          Load more loops
        </Button>
      ) : null}
    </div>
  );
}

function LoopCard({
  task,
  index,
  onOpen,
  onChanged,
  onToast,
}: {
  task: TaskSummary;
  index: number;
  onOpen: () => void;
  onChanged: () => void;
  onToast: (text: string) => void;
}) {
  // A card control: the failure has to reach the user as a toast, since the only
  // thing on screen is the switch they just flipped.
  const toggling = useAction({ onError: onToast });
  const [confirming, setConfirming] = useState(false);
  const fmt = useFormat();
  const stats = statsLabel(task, fmt);

  /** Rejects on failure so `ConfirmDialog` can hold itself open and explain. */
  async function remove() {
    await api.deleteInstance(task.id);
    onChanged();
    onToast(`${task.name} deleted`);
  }

  function toggle(next: boolean) {
    if (toggling.busy) return;
    void toggling.run(async () => {
      await api.updateSchedule(task.id, { enabled: next });
      onChanged();
      onToast(`${task.name} ${next ? "activated" : "paused"}`);
    });
  }

  return (
    <motion.div
      className="h-full"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, delay: index * 0.03 }}
    >
      <Card
        className={cn(
          "group/loop-card h-full cursor-pointer text-inherit transition-[transform,box-shadow] hover:-translate-y-px hover:ring-foreground/20",
          !task.enabled && "opacity-85",
        )}
        onClick={onOpen}
      >
        <CardContent className="flex h-full min-h-[184px] flex-1 flex-col text-left">
          <div className="mb-4 flex items-center justify-between gap-2">
            <span
              className={cn(
                "inline-flex size-9 shrink-0 items-center justify-center gap-[3px] rounded-md bg-[var(--bg-muted)] text-[var(--text-faint)]",
                task.usesGitLab && task.usesJira && "w-auto px-1.5",
              )}
            >
              <LoopCardIcon task={task} />
            </span>
            {/* Sits in the top row rather than under the title so a private loop
                does not grow a card taller than its neighbours. */}
            {task.visibility === "private" ? (
              <span className="ml-auto inline-flex w-fit shrink-0 items-center gap-1 rounded-full border border-border px-[7px] py-0.5 text-[0.7812rem] text-muted-foreground">
                <Lock size={11} strokeWidth={2.2} />
                Private
              </span>
            ) : null}
            <Switch
              checked={task.enabled}
              className={`loop-switch ${task.enabled ? "on" : ""}`}
              aria-label={task.enabled ? `Pause ${task.name}` : `Activate ${task.name}`}
              disabled={toggling.busy}
              onClick={(event) => event.stopPropagation()}
              onCheckedChange={toggle}
            />
          </div>

          <h2 className="m-0 font-display text-[length:var(--type-h2-size)] leading-[var(--type-h2-leading)] font-semibold tracking-[0.025em] text-foreground">
            {task.name}
          </h2>
          <p className="my-2 line-clamp-2 overflow-hidden text-[0.9375rem] leading-[1.4] text-muted-foreground">
            {task.description || "No description."}
          </p>

          {stats || task.openIssues > 0 ? (
            <div className="mb-1.5 flex items-center gap-2.5 text-[0.7812rem] text-[var(--text-faint)]">
              {stats ? <span>{stats}</span> : null}
              {task.openIssues > 0 ? (
                <span>{task.openIssues} open</span>
              ) : null}
            </div>
          ) : null}

          <div className="mt-auto flex items-center justify-between pt-3">
            <Tip label={task.lastRun ? fmt.stamp(task.lastRun.startedAt) : undefined}>
              <span className="mr-auto inline-flex items-center gap-1.5 text-sm text-[var(--text-faint)]">
                <Clock size={13} strokeWidth={2} />
                Last run: {lastRunLabel(task)}
              </span>
            </Tip>
            {/* Instances only — `visibility` is set on stored rows and absent on
                code-registered definitions, which have nothing to delete. */}
            {task.visibility !== undefined ? (
              <Tip label="Delete loop">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(
                    ICON_BUTTON_CLASS,
                    ICON_BUTTON_DANGER_CLASS,
                    "size-7 opacity-35 transition-opacity group-hover/loop-card:opacity-100 focus-visible:opacity-100",
                  )}
                  aria-label={`Delete ${task.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setConfirming(true);
                  }}
                >
                  <Trash2 size={15} strokeWidth={2} />
                </Button>
              </Tip>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(ICON_BUTTON_CLASS, "size-7")}
              aria-label={`Open ${task.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpen();
              }}
            >
              <MoreVertical size={16} strokeWidth={2} />
            </Button>
          </div>
        </CardContent>
      </Card>

      <AnimatePresence>
        {confirming ? (
          <ConfirmDialog
            title={`Delete ${task.name}?`}
            body={
              "This removes the loop, its schedule and everything it was tracking. " +
              "Its run history is kept. This cannot be undone."
            }
            confirmLabel="Delete loop"
            onConfirm={remove}
            onClose={() => setConfirming(false)}
          />
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}
