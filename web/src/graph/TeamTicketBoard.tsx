import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, UsersRound } from "lucide-react";

import type { TicketCluster } from "../api.ts";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { TicketBoard, type TicketBoardProps } from "./TicketBoard.tsx";
import { ticketNodeOf } from "./ticket.ts";

const UNASSIGNED = "jira:unassigned";

export interface DeveloperOption {
  id: string;
  name: string;
  avatarUrl?: string;
  count: number;
}

interface AssigneeGroup extends Omit<DeveloperOption, "count"> {
  clusters: TicketCluster[];
}

export function developerIdOf(cluster: TicketCluster): string {
  const assignee = ticketNodeOf(cluster)?.ticket?.assignee;
  return assignee?.accountId ?? (assignee?.name ? `jira:name:${assignee.name}` : UNASSIGNED);
}

function groupByAssignee(clusters: readonly TicketCluster[]): AssigneeGroup[] {
  const groups = new Map<string, AssigneeGroup>();
  for (const cluster of clusters) {
    const assignee = ticketNodeOf(cluster)?.ticket?.assignee;
    const id = developerIdOf(cluster);
    const group = groups.get(id);
    if (group) {
      group.clusters.push(cluster);
    } else {
      groups.set(id, {
        id,
        name: assignee?.name ?? "Unassigned",
        ...(assignee?.avatarUrl ? { avatarUrl: assignee.avatarUrl } : {}),
        clusters: [cluster],
      });
    }
  }
  return [...groups.values()].sort((a, b) => {
    if (a.id === UNASSIGNED) return 1;
    if (b.id === UNASSIGNED) return -1;
    return a.name.localeCompare(b.name);
  });
}

export function developerOptions(clusters: readonly TicketCluster[]): DeveloperOption[] {
  return groupByAssignee(clusters).map(({ clusters: tickets, ...group }) => ({
    ...group,
    count: tickets.length,
  }));
}

export function DeveloperFilter({
  developers,
  hidden,
  onChange,
}: {
  developers: readonly DeveloperOption[];
  hidden: ReadonlySet<string>;
  onChange: (hidden: ReadonlySet<string>) => void;
}) {
  const shown = developers.filter((developer) => !hidden.has(developer.id)).length;
  const label =
    shown === developers.length ? "All developers" : `${shown} of ${developers.length} developers`;

  const toggle = (id: string, visible: boolean) => {
    const next = new Set(hidden);
    if (visible) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <UsersRound size={14} />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Developers</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onChange(new Set())}>
          Show all developers
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {developers.map((developer) => (
          <DropdownMenuCheckboxItem
            key={developer.id}
            checked={!hidden.has(developer.id)}
            onCheckedChange={(checked) => toggle(developer.id, checked === true)}
            onSelect={(event) => event.preventDefault()}
          >
            {developer.avatarUrl ? (
              <img
                src={developer.avatarUrl}
                alt=""
                className="size-5 shrink-0 rounded-full object-cover"
              />
            ) : (
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--bg-muted)] text-xs text-[var(--text-faint)]">
                {developer.name.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{developer.name}</span>
            <span className="text-xs text-[var(--text-faint)]">{developer.count}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type TeamTicketBoardProps = Omit<TicketBoardProps, "clusters"> & {
  clusters: readonly TicketCluster[];
};

/**
 * Jira's assignee swimlanes over the existing status board. Each developer has
 * an independent board row, so moving a card changes status without implying an
 * assignee change.
 */
export function TeamTicketBoard({ clusters, ...boardProps }: TeamTicketBoardProps) {
  const groups = useMemo(() => groupByAssignee(clusters), [clusters]);
  const [expanded, setExpanded] = useState<string>();
  const scroller = useRef<HTMLDivElement>(null);
  const panels = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    if (!expanded) return;
    const container = scroller.current;
    const panel = panels.current.get(expanded);
    if (!container || !panel) return;
    const containerRect = container.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    container.scrollTo({
      top: container.scrollTop + panelRect.top - containerRect.top,
      behavior: "smooth",
    });
  }, [expanded]);

  return (
    <div ref={scroller} className="h-full min-h-0 space-y-2 overflow-y-auto p-3">
        {groups.map((group) => {
          const isExpanded = expanded === group.id;
          return (
            <section
              key={group.id}
              ref={(node) => {
                if (node) panels.current.set(group.id, node);
                else panels.current.delete(group.id);
              }}
              className={
                isExpanded
                  ? "flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--radius)] border border-border bg-[var(--bg-raised)]"
                  : "overflow-hidden rounded-[var(--radius)] border border-border bg-[var(--bg-raised)]"
              }
            >
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start rounded-none px-3 py-2 text-left hover:bg-[var(--bg-hover)]"
                aria-expanded={isExpanded}
                onClick={() => setExpanded((current) => (current === group.id ? undefined : group.id))}
              >
                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {group.avatarUrl ? (
                  <img
                    src={group.avatarUrl}
                    alt=""
                    className="size-6 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--bg-muted)] text-xs text-[var(--text-faint)]">
                    {group.name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{group.name}</span>
                <span className="rounded-full bg-[var(--bg-muted)] px-2 py-px font-mono text-xs text-[var(--text-faint)]">
                  {group.clusters.length}
                </span>
              </Button>
              {isExpanded ? (
                <div className="min-h-0 flex-1 border-t border-border">
                  <TicketBoard clusters={group.clusters} {...boardProps} />
                </div>
              ) : null}
            </section>
          );
        })}
        {groups.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            No developers selected.
          </div>
        ) : null}
    </div>
  );
}
