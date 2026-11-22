import {
  ChevronDown,
  CircleCheck,
  CircleX,
  Clock,
  GitMerge,
  GitPullRequest,
  Infinity as InfinityIcon,
  ListChecks,
  LoaderCircle,
  Menu,
  MessageCircleQuestionMark,
  MessageSquareReply,
  PlayCircle,
  ScanSearch,
  Skull,
  Ticket,
  Terminal,
  TestTube2,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { GraphNodeKind, GraphStatus, MrActionId, TicketActionId, TicketCluster } from "../api.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Button } from "../components/ui/button.tsx";

/**
 * Shared vocabulary for a node's kind and status — used by the board's ticket
 * cards and by the detail drawer, so a job looks like the same job wherever
 * it is drawn.
 *
 * Status is never colour-only (design.md): every node carries a status icon
 * and the status word alongside the tint, so a missed hue never drops
 * information.
 */

export const KIND_ICONS: Record<GraphNodeKind, LucideIcon> = {
  ticket: Ticket,
  loop: InfinityIcon,
  job: Terminal,
  run: PlayCircle,
  mr: GitPullRequest,
  // The same bolt the Actions menu is behind, because that is where the node came
  // from: one of these is a row in the ticket's history of "somebody pressed this".
  action: Zap,
};

export const STATUS_ICONS: Record<GraphStatus, LucideIcon> = {
  running: PlayCircle,
  success: CircleCheck,
  failure: CircleX,
  waiting: Clock,
  dead: Skull,
  idle: Clock,
};

export const STATUS_WORDS: Record<GraphStatus, string> = {
  running: "running",
  success: "passed",
  failure: "failed",
  waiting: "waiting",
  dead: "gave up",
  idle: "idle",
};

/**
 * What hangs off a ticket, as one line — "1 MR · 2 action", empty when nothing
 * does. Singular/plural is left alone on purpose: these are labels for counts, not
 * prose, and "1 MRs" reads worse than the column of aligned units reads well.
 */
export function countsSummary(counts: TicketCluster["counts"]): string {
  return (
    [
      [counts.mrs, "MR"],
      [counts.actions, "action"],
      [counts.jobs, "job"],
      [counts.runs, "run"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, unit]) => `${n} ${unit}`)
    .join(" · ");
}

/** The merge request toolbar. Every action needs a container, so none is instant. */
export interface MrActionSpec {
  id: MrActionId;
  label: string;
  Icon: LucideIcon;
}

export const MR_ACTIONS: readonly MrActionSpec[] = [
  { id: "address-comments", label: "Address comments", Icon: MessageSquareReply },
  { id: "code-review", label: "Code review", Icon: ScanSearch },
  { id: "resolve-conflicts", label: "Resolve merge conflicts", Icon: GitMerge },
];

/**
 * The ticket's own actions, in menu order.
 *
 * Ordered by how much each one commits you to: the review only asks questions in a
 * thread, the plan writes a document nobody has to act on, the fix writes code and
 * opens a merge request. All three are behind the same button because they answer the
 * same question at different points in a ticket's life — "is this ready to build",
 * "how would you build it", "build it", and "does the linked change work in QA" —
 * and a developer looking at a thin ticket wants the first exactly where they
 * expected the last.
 */
export interface TicketActionSpec {
  id: TicketActionId;
  label: string;
  Icon: LucideIcon;
  /** Shown when the action is available; a refusal reason replaces it when not. */
  hint: string;
}

export const TICKET_ACTIONS: readonly TicketActionSpec[] = [
  {
    id: "review-description",
    label: "Review the requirements",
    Icon: MessageCircleQuestionMark,
    hint: "Read the ticket and comment with the questions its requirements leave open",
  },
  {
    id: "plan-issue",
    label: "Plan this issue",
    Icon: ListChecks,
    hint: "Write an implementation plan for you to review before any code is written",
  },
  {
    id: "fix-issue",
    label: "Fix this issue",
    Icon: Wrench,
    hint: "Attempt this ticket and open a draft merge request",
  },
  {
    id: "e2e-test",
    label: "E2E test",
    Icon: TestTube2,
    hint: "Run an AI-driven Playwright verification of a linked merge request against QA",
  },
];

/**
 * The ticket's actions, behind one button.
 *
 * A menu rather than a row of buttons: the card is narrow and holds the
 * ticket's own facts, which are what you read it for. Two actions would
 * already crowd that, and the list is expected to grow.
 *
 * Every action is listed whether or not it can run, disabled with its reason as
 * the tooltip. "This ticket already has a merge request" is the answer to the
 * question the item raises, and an item that vanishes leaves the developer
 * wondering whether the feature exists at all.
 */
export function TicketActionsMenu({
  cluster,
  onAction,
  busy,
  iconOnly = false,
}: {
  cluster: TicketCluster;
  onAction?: (cluster: TicketCluster, action: TicketActionId) => void;
  busy?: TicketActionId;
  /** Uses the compact menu trigger shown in a board card's top-right corner. */
  iconOnly?: boolean;
}) {
  // While something is being queued the trigger says which one, because the menu
  // has closed by then and a bare spinner on a button labelled "Actions" says only
  // that *something* is happening.
  const running = busy ? TICKET_ACTIONS.find((action) => action.id === busy) : undefined;

  return (
    <div
      onPointerDown={iconOnly ? (event) => event.stopPropagation() : undefined}
      onClick={iconOnly ? (event) => event.stopPropagation() : undefined}
    >
      {/* The ticket panel is itself a modal drawer. Keeping this menu non-modal
          avoids a second focus layer swallowing the trigger or the selected item. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant={iconOnly ? "ghost" : "outline"}
            size={iconOnly ? "icon-xs" : "default"}
            className={
              iconOnly
                ? "size-5 cursor-pointer text-[var(--text-faint)] hover:bg-[var(--bg-muted)] hover:text-success data-[state=open]:bg-[var(--bg-muted)] data-[state=open]:text-success"
                : "h-auto gap-1.5 rounded-md border-[color-mix(in_srgb,var(--action)_45%,var(--border))] bg-[color-mix(in_srgb,var(--action)_10%,transparent)] px-[13px] py-[7px] text-sm font-medium text-foreground hover:border-action hover:bg-action/20 data-[state=open]:border-action data-[state=open]:bg-action/20"
            }
            disabled={busy != null}
            title={`What TALOS can do with ${cluster.key}`}
            aria-label={iconOnly ? `Actions for ${cluster.key}` : undefined}
          >
            {running ? (
              <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />
            ) : iconOnly ? (
              <Menu size={13} strokeWidth={2} />
            ) : (
              <Zap size={13} strokeWidth={2} />
            )}
            {iconOnly ? null : running ? `${running.label}…` : "Actions"}
            {iconOnly || running ? null : <ChevronDown size={13} strokeWidth={2} />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="z-[60] flex w-auto min-w-max flex-col gap-0.5 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-raised)] p-1 shadow-[var(--shadow-panel)]"
          align={iconOnly ? "end" : "start"}
          side="bottom"
          sideOffset={4}
          avoidCollisions={false}
          onClick={(event) => event.stopPropagation()}
        >
          {TICKET_ACTIONS.map(({ id, label, Icon, hint }) => {
            const state = cluster.actions[id];
            return (
              <DropdownMenuItem
                key={id}
                className="flex cursor-pointer items-center gap-1.5 rounded-[calc(var(--radius)-2px)] border border-transparent bg-transparent px-[7px] py-[5px] text-left font-[inherit] text-xs text-[var(--text-dim)] hover:border-action hover:bg-[var(--bg-hover)] hover:text-foreground data-disabled:pointer-events-auto data-disabled:cursor-not-allowed data-disabled:opacity-40 data-disabled:hover:border-transparent data-disabled:hover:bg-transparent data-disabled:hover:text-[var(--text-dim)]"
                disabled={!state.available}
                title={state.reason ?? hint}
                onSelect={() => onAction?.(cluster, id)}
              >
                <Icon size={12} strokeWidth={2} />
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
