import { useEffect, useMemo, useState } from "react";
import { GitBranch, Infinity as InfinityIcon } from "lucide-react";
import { motion } from "motion/react";

import type { TaskSummary } from "./api.ts";
import { DatadogIcon } from "./DatadogIcon.tsx";
import { ago } from "./format.ts";
import { GitLabIcon } from "./GitLabIcon.tsx";
import { JiraIcon } from "./JiraIcon.tsx";
import { Tip } from "./Tip.tsx";
import { useFormat } from "./FormatContext.tsx";
import { cn } from "./lib/utils.ts";
import { Button } from "./components/ui/button.tsx";
import { PR_STATE_CLASS } from "./pr/styles.ts";

const ICON_SIZE = 13;

function runStatusTone(status: string): string {
  if (status === "success") {
    return "bg-[color-mix(in_srgb,var(--success)_18%,var(--bg-deep))] text-[var(--success)]";
  }
  if (status === "failure") {
    return "bg-[color-mix(in_srgb,var(--status-danger)_18%,var(--bg-deep))] text-[var(--status-danger)]";
  }
  if (status === "running") {
    return "bg-[color-mix(in_srgb,var(--running)_18%,var(--bg-deep))] text-[var(--running)]";
  }
  return "bg-[var(--bg-muted)] text-[var(--text-dim)]";
}

/** Newest instance first; code-registered tasks (no createdAt) sort last. */
export function sortByCreatedAtDesc(tasks: TaskSummary[]): TaskSummary[] {
  return [...tasks].sort((a, b) => {
    const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
    if (bTime !== aTime) return bTime - aTime;
    return a.id.localeCompare(b.id);
  });
}

function LoopServiceIcons({ task }: { task: TaskSummary }) {
  if (task.definitionId === "datadog-scan" || task.id === "datadog-scan") {
    return <DatadogIcon size={ICON_SIZE} />;
  }
  // GitLab in the title is the repo under review, not a "uses GitLab + Jira"
  // badge — a related ticket lives in the links row, not here.
  if (task.usesGitLab) return <GitLabIcon size={ICON_SIZE} />;
  if (task.usesJira) return <JiraIcon size={ICON_SIZE} />;
  return <InfinityIcon size={ICON_SIZE} strokeWidth={2.5} />;
}

export function TaskList({
  tasks,
  selectedId,
  onSelect,
  previewLimit,
  hasMore,
  onLoadMore,
}: {
  tasks: TaskSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
  /** When set, only this many newest rows show until the user expands. */
  previewLimit?: number;
  /** More server-side rows exist beyond the pages already loaded. */
  hasMore?: boolean;
  onLoadMore?: () => void;
}) {
  const sorted = useMemo(() => sortByCreatedAtDesc(tasks), [tasks]);
  const [expanded, setExpanded] = useState(false);
  const fmt = useFormat();

  useEffect(() => {
    if (previewLimit == null || !selectedId) return;
    const index = sorted.findIndex((task) => task.id === selectedId);
    if (index >= previewLimit) setExpanded(true);
  }, [previewLimit, selectedId, sorted]);

  if (sorted.length === 0) {
    return (
      <div className="px-5 py-7 text-center text-[0.9375rem] text-[var(--text-faint)]">
        No tasks match that search.
      </div>
    );
  }

  const visible =
    previewLimit == null || expanded ? sorted : sorted.slice(0, previewLimit);
  const remaining = sorted.length - visible.length;

  return (
    <div>
      {visible.map((task, index) => (
        <motion.div
          key={task.id}
          className={cn(
            "cursor-pointer border-b border-l-2 border-b-border border-l-transparent px-3.5 py-3 hover:bg-[var(--bg-hover)]",
            task.id === selectedId && "border-l-action bg-[var(--bg-hover)]",
          )}
          onClick={() => onSelect(task.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") onSelect(task.id);
          }}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15, delay: index * 0.02 }}
        >
          <div className="flex items-center gap-2">
            <span className="inline-flex size-5.5 shrink-0 items-center justify-center gap-[3px] rounded-md bg-[var(--bg-muted)] text-[var(--text-faint)]">
              <LoopServiceIcons task={task} />
            </span>
            <span
              className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-medium"
              title={task.name}
            >
              {task.name}
            </span>
            {task.lastRun ? (
              <span
                className={cn(
                  PR_STATE_CLASS,
                  runStatusTone(task.activeJobs > 0 ? "running" : task.lastRun.status),
                  "px-2 py-0.5 text-xs",
                )}
              >
                {task.activeJobs > 0 ? "running" : task.lastRun.status}
              </span>
            ) : null}
          </div>
          {task.gitlabMr || task.jiraIssue ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
              {task.gitlabMr ? (
                <a
                  className="mono inline-flex min-w-0 max-w-full items-center gap-[5px] text-sm text-muted-foreground no-underline [--icon-color:currentColor] [--tile-color:transparent] hover:text-[var(--brand)]"
                  href={task.gitlabMr.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => event.stopPropagation()}
                >
                  <GitBranch size={ICON_SIZE} strokeWidth={2} />
                  !{task.gitlabMr.iid}
                </a>
              ) : null}
              {task.jiraIssue?.url ? (
                <a
                  className="mono inline-flex min-w-0 max-w-full items-center gap-[5px] text-sm text-muted-foreground no-underline [--icon-color:currentColor] [--tile-color:transparent] hover:text-[var(--brand)]"
                  href={task.jiraIssue.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => event.stopPropagation()}
                >
                  <JiraIcon size={ICON_SIZE} />
                  {task.jiraIssue.key}
                </a>
              ) : task.jiraIssue ? (
                <span className="mono inline-flex min-w-0 max-w-full items-center gap-[5px] text-sm text-muted-foreground [--icon-color:currentColor] [--tile-color:transparent]">
                  <JiraIcon size={ICON_SIZE} />
                  {task.jiraIssue.key}
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="mono mt-[5px] flex gap-2.5 text-[0.7812rem] text-[var(--text-faint)]">
            <Tip label={task.lastRun ? fmt.stamp(task.lastRun.startedAt) : undefined}>
              <span>last {task.lastRun ? ago(task.lastRun.startedAt) : "never"}</span>
            </Tip>
            {task.lastRun?.durationMs != null ? (
              <span>{fmt.duration(task.lastRun.durationMs)}</span>
            ) : null}
            {task.lastRun?.itemsProcessed != null ? (
              <Tip
                label={
                  task.lastRun.itemsSkipped
                    ? `${task.lastRun.itemsSkipped} skipped`
                    : undefined
                }
              >
                <span>{task.lastRun.itemsProcessed} found</span>
              </Tip>
            ) : null}
          </div>
        </motion.div>
      ))}
      {remaining > 0 ? (
        <Button
          type="button"
          variant="link"
          className="h-auto w-full justify-start px-3.5 py-3 font-[inherit] text-sm text-muted-foreground"
          onClick={() => setExpanded(true)}
        >
          Show {remaining} more
        </Button>
      ) : null}
      {remaining === 0 && hasMore && onLoadMore ? (
        <Button
          type="button"
          variant="link"
          className="h-auto w-full justify-start px-3.5 py-3 font-[inherit] text-sm text-muted-foreground"
          onClick={onLoadMore}
        >
          Load more
        </Button>
      ) : null}
    </div>
  );
}
