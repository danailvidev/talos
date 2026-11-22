import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bug,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  GitPullRequest,
  ListChecks,
  ListTodo,
  Sparkles,
  TestTube2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { api } from "../api.ts";
import type {
  GraphNode,
  GraphStatus,
  TicketActionId,
  TicketBoardView,
  TicketCluster,
} from "../api.ts";
import { cn } from "../lib/utils.ts";
import {
  boardColumns,
  columnOf,
  OTHER_COLUMN,
  type BoardColumn,
} from "./columns.ts";
import { ticketNodeOf } from "./ticket.ts";
import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanItem,
  KanbanItemHandle,
  KanbanOverlay,
  type KanbanCommitMeta,
} from "../components/ui/kanban.tsx";
import { Button } from "../components/ui/button.tsx";
import { TicketActionsMenu } from "./nodes.tsx";
import { PriorityMark } from "./PriorityMark.tsx";

type BoardValue = Record<string, TicketCluster[]>;

function cardBorder(status: GraphStatus, inReview: boolean, selected: boolean): string {
  if (status === "running") return "border-[var(--running)]";
  if (status === "failure" || status === "dead") return "border-[var(--failure)]";
  if (inReview) return "border-[color-mix(in_srgb,var(--success)_45%,var(--border))]";
  if (selected) return "border-action";
  if (status === "success") {
    return "border-[color-mix(in_srgb,var(--success)_55%,var(--border))]";
  }
  if (status === "waiting") {
    return "border-[color-mix(in_srgb,var(--warn)_45%,var(--border))]";
  }
  return "border-border";
}

function groupByColumn(
  clusters: readonly TicketCluster[],
  columns: readonly BoardColumn[],
): BoardValue {
  const grouped = Object.fromEntries(
    columns.map((column) => [column.id, [] as TicketCluster[]]),
  ) as BoardValue;
  for (const cluster of clusters) grouped[columnOf(cluster, columns)]?.push(cluster);
  return grouped;
}

/**
 * Which icon a Jira issue type reads as, matched loosely rather than by exact
 * name — "Sub-task", "Subtask" and "Technical Debt" all name the same thing
 * differently depending on the site, and an exact list would miss half of
 * them. Order matters: "Sub-task" must beat the plain "task" match below it.
 */
const TYPE_ICONS: ReadonlyArray<{ test: RegExp; icon: LucideIcon; color: string }> = [
  { test: /sub-?task/i, icon: GitBranch, color: "var(--text-faint)" },
  { test: /bug/i, icon: Bug, color: "var(--failure)" },
  { test: /tech(nical)?[\s-]*debt/i, icon: Wrench, color: "var(--warn)" },
  { test: /(feature|story|epic)/i, icon: Sparkles, color: "var(--success)" },
  { test: /task/i, icon: ListTodo, color: "var(--status-success)" },
];

function typeIconOf(type: string | undefined): { icon: LucideIcon; color: string } | undefined {
  if (!type) return undefined;
  const entry = TYPE_ICONS.find(({ test }) => test.test(type));
  return entry && { icon: entry.icon, color: entry.color };
}

/**
 * "3 merge requests (2 open, 1 merged)" — the breakdown behind
 * `cluster.counts.mrs`, read off the cluster's own `mr` nodes rather than a
 * second fetch: the graph already carries each one's status.
 */
function prTooltip(cluster: TicketCluster): string {
  const mrs = cluster.nodes.filter((node) => node.kind === "mr");
  if (mrs.length === 0) return "";
  const merged = mrs.filter((node) => node.status === "success").length;
  const open = mrs.length - merged;
  const breakdown = [
    open > 0 ? `${open} open` : null,
    merged > 0 ? `${merged} merged` : null,
  ].filter((part): part is string => part != null);
  const count = `${mrs.length} merge request${mrs.length === 1 ? "" : "s"}`;
  return breakdown.length > 0 ? `${count} (${breakdown.join(", ")})` : count;
}

function coverageTone(status: NonNullable<TicketCluster["e2eCoverage"]>["status"]): string {
  if (status === "passed" || status === "mr-ready") return "text-[var(--success)]";
  if (status === "failed") return "text-[var(--failure)]";
  if (status === "writing") return "text-[var(--running)]";
  return "text-[var(--warn)]";
}

/** Two or more subtasks of the same parent, sharing one column. */
interface CardFamily {
  parentKey: string;
  parentTitle?: string;
  members: TicketCluster[];
}

type ColumnEntry = { kind: "single"; cluster: TicketCluster } | { kind: "family"; family: CardFamily };

/**
 * One column's cards, with any subtasks of the same parent collapsed into a
 * single family entry — a subtask sitting alone in a column still renders as
 * a plain card, since there is nothing to show it beside.
 *
 * Order otherwise follows the column's own (a drag reorder within a column
 * has no meaning to Jira, so nothing depends on the original positions —
 * see `commit` below).
 */
function groupFamilies(
  clusters: readonly TicketCluster[],
  titleOf: (key: string) => string | undefined,
): ColumnEntry[] {
  const parentKeyOf = new Map<string, string>();
  for (const cluster of clusters) {
    const parentKey = ticketNodeOf(cluster)?.ticket?.parentKey;
    if (parentKey) parentKeyOf.set(cluster.key, parentKey);
  }

  const membersByParent = new Map<string, TicketCluster[]>();
  for (const cluster of clusters) {
    const parentKey = parentKeyOf.get(cluster.key);
    if (!parentKey) continue;
    const members = membersByParent.get(parentKey);
    if (members) members.push(cluster);
    else membersByParent.set(parentKey, [cluster]);
  }

  const placed = new Set<string>();
  const entries: ColumnEntry[] = [];
  for (const cluster of clusters) {
    if (placed.has(cluster.key)) continue;
    const parentKey = parentKeyOf.get(cluster.key);
    const members = parentKey ? membersByParent.get(parentKey) : undefined;
    if (parentKey && members && members.length >= 2) {
      for (const member of members) placed.add(member.key);
      entries.push({
        kind: "family",
        family: { parentKey, parentTitle: titleOf(parentKey), members },
      });
    } else {
      entries.push({ kind: "single", cluster });
    }
  }
  return entries;
}

/**
 * Jira's own board columns, in Jira's order, with cards placed through the
 * board's status-id mapping. Dragging a card to another column moves the ticket
 * there in Jira; clicking the rest of the card opens its detail panel.
 */
export interface TicketBoardProps {
  clusters: readonly TicketCluster[];
  board?: TicketBoardView;
  selectedKey?: string;
  onSelect: (cluster: TicketCluster) => void;
  onAction: (cluster: TicketCluster, action: TicketActionId) => void;
  busy: Record<string, TicketActionId | undefined>;
  /** Where a drag's outcome is shown — the same banner every other action uses. */
  onNotice: (notice: { ok: boolean; text: string }) => void;
  /**
   * A successful status change just wrote straight to Jira, but the routine
   * poll behind `clusters` reads a cache that does not know that yet.
   */
  onMoved: () => Promise<unknown>;
}

export function TicketBoard({
  clusters,
  board,
  selectedKey,
  onSelect,
  onAction,
  busy,
  onNotice,
  onMoved,
}: TicketBoardProps) {
  const columns = useMemo(() => boardColumns(board, clusters), [board, clusters]);
  const collapsibleColumnIds = useMemo(
    () =>
      new Set(
        (board?.columns ?? columns.filter((column) => column.id !== OTHER_COLUMN.id))
          .slice(-2)
          .map((column) => column.id),
      ),
    [board, columns],
  );
  // Terminal workflow columns are compact by default but remain one click away
  // for the occasional release check or historical lookup.
  const [expandedTerminalColumns, setExpandedTerminalColumns] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const grouped = useMemo(() => groupByColumn(clusters, columns), [clusters, columns]);
  // The board's own copy. Live mode: the library itself reshuffles this as you
  // drag over a column — the "make room" preview and the placeholder gap are
  // both its default behaviour, not something built here.
  const [value, setValue] = useState(grouped);
  // Blocks the resync effect below for two separate windows that must never
  // overlap with a poll landing: the drag gesture itself (`dragging`, set for
  // its whole span by the unconditional onDragStart/onDragEnd/onDragCancel
  // callbacks — a poll reshaping the columns out from under an in-progress
  // drag is what was corrupting it) and the async tail after a drop while the
  // Jira call is in flight (`committing`, owned entirely by `commit`'s own
  // try/finally, since `onValueCommit` doesn't fire on a plain cancel or a
  // drop back where a card started).
  const dragging = useRef(false);
  const committing = useRef(false);

  useEffect(() => {
    if (!dragging.current && !committing.current) setValue(grouped);
  }, [grouped]);

  const clusterByKey = useMemo(() => new Map(clusters.map((c) => [c.key, c] as const)), [clusters]);

  /**
   * The drop already happened — the library reshuffled `value` live as the
   * card was dragged over each column, so by the time this fires the board
   * already looks right. What is left is telling Jira, and rolling the board
   * back to `meta.previousValue` (not `grouped`, which the poll may not have
   * caught up to yet) if Jira refuses.
   */
  const commit = async (_next: BoardValue, meta: KanbanCommitMeta<TicketCluster>) => {
    committing.current = true;
    try {
      const from = meta.activeContainer;
      const to = meta.overContainer;
      if (from === to) return; // A reorder within one column — Jira has no card order to tell.

      const previous = meta.previousValue as BoardValue;
      const cluster = previous[from]?.[meta.activeIndex];
      if (!cluster) return;

      // Nothing in Jira is named "Other" — it is this board's catch-all, not a
      // status a transition could ever target.
      const target = columns.find((column) => column.id === to);
      if (!target || target.id === OTHER_COLUMN.id) {
        setValue(previous);
        onNotice({ ok: false, text: `Jira has no status named "Other" to move ${cluster.key} to.` });
        return;
      }

      const result = await api.setTicketStatus(cluster.key, target.name, target.statusIds);
      if (!result.ok) {
        setValue(previous);
      } else {
        // Jira already has it right; the query cache — server and client —
        // does not yet. Wait for that before letting a poll speak again, or
        // the very next one can still read the stale entry and revert a move
        // that already succeeded.
        await onMoved().catch(() => {});
      }
      onNotice({ ok: result.ok, text: result.message });
    } finally {
      committing.current = false;
    }
  };

  return (
    <div className="relative h-full overflow-hidden">
      <Kanban
        className="h-full"
        value={value}
        onValueChange={(next) => setValue(next as BoardValue)}
        getItemValue={(cluster) => cluster.key}
        restoreOnCancel
        onValueCommit={(next, meta) => void commit(next as BoardValue, meta)}
        onDragStart={() => {
          dragging.current = true;
        }}
        onDragEnd={() => {
          dragging.current = false;
        }}
        onDragCancel={() => {
          dragging.current = false;
        }}
      >
        <KanbanBoard className="flex h-full items-start gap-3 overflow-x-auto overflow-y-hidden p-3 max-[900px]:snap-x max-[900px]:snap-mandatory">
          {columns.map((column) => {
            const collapsible = collapsibleColumnIds.has(column.id);
            const collapsed = collapsible && !expandedTerminalColumns.has(column.id);
            return (
              // No `disabled` here: it isn't needed to stop a column being
              // dragged (nothing renders `KanbanColumnHandle`, so no listeners
              // are ever attached for that), and the library also reads it as
              // "fade this to half opacity".
              <KanbanColumn
                key={column.id}
                value={column.id}
                className={cn(
                  "h-full shrink-0 rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] transition-[width] duration-150",
                  collapsed ? "w-12" : "w-72 max-[900px]:w-[min(18rem,calc(100vw-3.25rem))] max-[900px]:snap-start",
                  column.id === OTHER_COLUMN.id && "border-dashed bg-transparent",
                )}
              >
                {collapsed ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="flex h-full w-full cursor-pointer flex-col justify-start gap-3 rounded-[var(--radius)] px-1 py-2 text-[var(--text-dim)]"
                    aria-label={`Expand ${column.name}`}
                    aria-expanded={false}
                    onClick={() =>
                      setExpandedTerminalColumns((current) =>
                        new Set(current).add(column.id),
                      )
                    }
                  >
                    <ChevronRight size={14} />
                    <span className="rounded-full bg-[var(--bg-muted)] px-1.5 py-px font-mono text-xs text-[var(--text-faint)]">
                      {value[column.id]?.length ?? 0}
                    </span>
                    <span className="font-mono text-xs tracking-[0.04em] uppercase [writing-mode:vertical-rl]">
                      {column.name}
                    </span>
                  </Button>
                ) : (
                  <>
                    <div className="flex shrink-0 items-center justify-between border-b border-border px-[11px] py-[9px]">
                      <span className="font-mono text-xs tracking-[0.04em] text-[var(--text-dim)] uppercase">
                        {column.name}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="rounded-full bg-[var(--bg-muted)] px-1.5 py-px font-mono text-xs text-[var(--text-faint)]">
                          {value[column.id]?.length ?? 0}
                        </span>
                        {collapsible ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            className="-my-1 cursor-pointer text-[var(--text-faint)]"
                            aria-label={`Collapse ${column.name}`}
                            aria-expanded={true}
                            onClick={() =>
                              setExpandedTerminalColumns((current) => {
                                const next = new Set(current);
                                next.delete(column.id);
                                return next;
                              })
                            }
                          >
                            <ChevronLeft size={13} />
                          </Button>
                        ) : null}
                      </span>
                    </div>
                    <KanbanColumnContent value={column.id} className="min-h-0 flex-1 overflow-y-auto p-2">
                {value[column.id]?.length === 0 ? (
                  <div className="px-1 py-2 text-center text-[0.7812rem] text-[var(--text-faint)]">
                    Nothing here
                  </div>
                ) : (
                  groupFamilies(value[column.id] ?? [], (key) => clusterByKey.get(key)?.title).map(
                    (entry) => {
                      if (entry.kind === "single") {
                        const root = ticketNodeOf(entry.cluster);
                        if (!root) return null;
                        return (
                          <KanbanItem
                            key={entry.cluster.key}
                            value={entry.cluster.key}
                            className="board-card-item relative w-full"
                          >
                            <DraggableTicketCard
                              cluster={entry.cluster}
                              root={root}
                              selected={entry.cluster.key === selectedKey}
                              onSelect={onSelect}
                              onAction={onAction}
                              busy={busy[entry.cluster.key]}
                            />
                          </KanbanItem>
                        );
                      }

                      const { family } = entry;
                      // Only clickable when the parent's own cluster is actually on the
                      // board (any column) — otherwise there is no detail panel to open.
                      const parentCluster = clusterByKey.get(family.parentKey);
                      return (
                        <div
                          key={`family:${family.parentKey}`}
                          className="flex flex-col gap-2 rounded-[var(--radius)] border border-border bg-[var(--bg-hover)] px-[11px] pt-[9px] pb-[11px]"
                        >
                          <div className="flex items-baseline gap-1.5 overflow-hidden">
                            <span
                              className={cn(
                                "shrink-0 font-mono text-[0.7812rem] font-semibold text-foreground",
                                parentCluster &&
                                  "cursor-pointer hover:text-success hover:underline",
                              )}
                              onClick={parentCluster ? () => onSelect(parentCluster) : undefined}
                            >
                              {family.parentKey}
                            </span>
                            {family.parentTitle ? (
                              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[0.7812rem] text-muted-foreground">
                                {family.parentTitle}
                              </span>
                            ) : null}
                          </div>
                          <div className="flex flex-col gap-2">
                            {family.members.map((cluster) => {
                              const root = ticketNodeOf(cluster);
                              if (!root) return null;
                              return (
                                <KanbanItem
                                  key={cluster.key}
                                  value={cluster.key}
                                  className="board-card-item relative w-full"
                                >
                                  <DraggableTicketCard
                                    cluster={cluster}
                                    root={root}
                                    selected={cluster.key === selectedKey}
                                    onSelect={onSelect}
                                    onAction={onAction}
                                    busy={busy[cluster.key]}
                                  />
                                </KanbanItem>
                              );
                            })}
                          </div>
                        </div>
                      );
                    },
                  )
                )}
                    </KanbanColumnContent>
                  </>
                )}
              </KanbanColumn>
            );
          })}
        </KanbanBoard>

        <KanbanOverlay>
          {({ value: activeKey }) => {
            const cluster = clusterByKey.get(String(activeKey));
            const root = cluster && ticketNodeOf(cluster);
            return cluster && root ? (
              <TicketCard
                cluster={cluster}
                root={root}
                selected={false}
                onSelect={() => {}}
                onAction={onAction}
                {...(busy[cluster.key] ? { busy: busy[cluster.key] } : {})}
              />
            ) : null;
          }}
        </KanbanOverlay>
      </Kanban>
    </div>
  );
}

function DraggableTicketCard(props: {
  cluster: TicketCluster;
  root: GraphNode;
  selected: boolean;
  onSelect: (cluster: TicketCluster) => void;
  onAction: (cluster: TicketCluster, action: TicketActionId) => void;
  busy?: TicketActionId;
}) {
  return (
    <KanbanItemHandle
      className="block"
      aria-label={`Move ${props.root.label}`}
      tabIndex={0}
    >
      <TicketCard {...props} />
    </KanbanItemHandle>
  );
}

function TicketCard({
  cluster,
  root,
  selected,
  onSelect,
  onAction,
  busy,
}: {
  cluster: TicketCluster;
  root: GraphNode;
  selected: boolean;
  onSelect: (cluster: TicketCluster) => void;
  onAction?: (cluster: TicketCluster, action: TicketActionId) => void;
  busy?: TicketActionId;
}) {
  const facts = root.ticket;
  const type = typeIconOf(facts?.type);

  return (
    // `in-review` overrides the amber rail every unfinished ticket otherwise gets:
    // with an MR open, the ticket is waiting on a person rather than on us. See
    // `TicketCluster.inReview` for what counts.
    <div
      className={cn(
        "board-card mb-2 flex w-full flex-col gap-[5px] rounded-[var(--radius)] border bg-[var(--bg-hover)] px-[11px] pt-[9px] pb-2.5 last:mb-0",
        cardBorder(root.status, cluster.inReview, selected),
        root.status === "running" && "animate-[status-pulse_2s_ease-in-out_infinite]",
        selected && "shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_55%,transparent)]",
      )}
      onClick={() => onSelect(cluster)}
    >
      <div className="flex items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="shrink-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm font-semibold text-foreground">
            {root.label}
          </span>
          {type ? (
            <span
              className="inline-flex shrink-0 items-center"
              title={facts?.type}
              style={{ color: type.color }}
            >
              <type.icon size={14} strokeWidth={2} />
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {cluster.source === "loops" ? (
            <span
              className="shrink-0 rounded-full bg-action/20 px-[5px] py-px font-mono text-xs tracking-[0.04em] text-action uppercase"
              title="Not assigned to you — a loop reported this one"
            >
              loop
            </span>
          ) : null}
          {onAction ? (
            <TicketActionsMenu
              cluster={cluster}
              onAction={onAction}
              {...(busy ? { busy } : {})}
              iconOnly
            />
          ) : null}
        </div>
      </div>

      <span
        className="line-clamp-3 h-[3.55rem] overflow-hidden text-sm leading-[1.35] text-muted-foreground"
        title={root.sublabel}
      >
        {root.sublabel}
      </span>

      <div className="flex items-center gap-1.5 overflow-hidden">
        {facts?.priority ? (
          <PriorityMark
            name={facts.priority}
            className="shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-[var(--text-faint)]"
          />
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {cluster.e2eCoverage ? (
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-0.5 font-mono text-xs leading-none",
                coverageTone(cluster.e2eCoverage.status),
              )}
              title={
                `E2E coverage: ${cluster.e2eCoverage.status.replace("-", " ")} · ` +
                `${cluster.e2eCoverage.scenarios} conclusive scenario(s)`
              }
            >
              <TestTube2 size={12} strokeWidth={2} />
              {cluster.e2eCoverage.scenarios}
            </span>
          ) : null}
          {cluster.plan?.status === "awaiting-review" ? (
            <span
              className="inline-flex shrink-0 items-center leading-none text-[var(--warn)]"
              title="Implementation plan awaiting review"
            >
              <ListChecks size={12} strokeWidth={2} />
            </span>
          ) : null}
          {cluster.counts.mrs > 0 ? (
            <span
              className="inline-flex shrink-0 items-center leading-none text-[var(--success)]"
              title={prTooltip(cluster)}
            >
              <GitPullRequest size={12} strokeWidth={2} />
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
