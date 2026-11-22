import { useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
  X,
} from "lucide-react";

import type { TicketCluster, TicketGraphView } from "../api.ts";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover.tsx";
import {
  DEFAULT_FILTERS,
  facetOptions,
  isFiltered,
  isSelectedSprint,
  NO_FILTERS,
  sprintOptions,
  sprintTiming,
  type FacetKey,
  type GraphFilters,
  type ResolvedSprint,
  type SprintOption,
  type WorkFacet,
} from "./filters.ts";
import { cn } from "../lib/utils.ts";
import {
  PR_FILTER_CHECK_CLASS,
  PR_FILTER_POPOVER_CLASS,
  PR_FILTER_RESET_CLASS,
  PR_FILTER_ROW_CLASS,
  PR_FILTER_TITLE_CLASS,
} from "../pr/styles.ts";

const SPRINT_STATE_CLASS =
  "rounded-full bg-[color-mix(in_srgb,var(--text-faint)_18%,transparent)] px-[5px] py-px text-xs tracking-[0.06em] uppercase";

function sprintStateTone(state: string | undefined): string {
  if (state === "active") return "bg-success/20 text-success";
  if (state === "future") return "bg-warning/20 text-warning";
  return "";
}

/**
 * The graph's filter bar: which sprint, and then what within it.
 *
 * Two halves, and the split is the design. On the left the sprint, given a control
 * of its own with arrows and dates, because it is the question the page is opened
 * with — "what am I meant to be doing this fortnight" — and switching it should feel
 * like turning a page rather than editing a query. On the right the ordinary
 * narrowing: text, and one menu per dimension, every value carrying the count it
 * would leave behind.
 *
 * Counts everywhere on purpose. A filter menu without them makes you click to find
 * out, and clicking to find out is the thing that makes filtering feel like work.
 */
export function GraphFilterBar({
  clusters,
  view,
  filters,
  resolved,
  shown,
  onChange,
  extraFilter,
}: {
  /** Every cluster the payload holds — the counts are computed against all of them. */
  clusters: readonly TicketCluster[];
  view: TicketGraphView | undefined;
  filters: GraphFilters;
  resolved: ResolvedSprint;
  /** How many survived, for the "12 of 37" summary. */
  shown: number;
  onChange: (next: GraphFilters) => void;
  /** Page-specific narrowing that belongs beside the shared facets. */
  extraFilter?: ReactNode;
}) {
  const sprints = sprintOptions(clusters, filters, view);
  const hasSprints = view?.sprints.some((sprint) => sprint.state !== "closed") ?? false;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {/* Hidden rather than shown empty on a Jira site with no sprint field: an
          "All tickets" switcher with nothing to switch to is furniture. */}
      {hasSprints ? (
        <SprintSwitcher
          options={sprints}
          filters={filters}
          resolved={resolved}
          onChange={onChange}
        />
      ) : null}

      <div className="graph-filter-search inline-flex min-w-0 items-center gap-1.5 rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] px-2 text-[var(--text-faint)] focus-within:border-[var(--border-strong)] max-[900px]:w-full">
        <Search size={13} strokeWidth={2} />
        <input
          className="w-42 min-w-0 border-0 bg-transparent py-[7px] font-[inherit] text-[0.9375rem] text-foreground outline-none max-[900px]:w-full"
          type="search"
          value={filters.query}
          placeholder="Ticket, summary, label, MR…"
          aria-label="Filter tickets"
          onChange={(event) => onChange({ ...filters, query: event.target.value })}
        />
        {filters.query ? (
          <button
            type="button"
            className="inline-flex cursor-pointer rounded-full border-0 bg-transparent p-0.5 text-[var(--text-faint)] hover:text-foreground"
            aria-label="Clear the search"
            onClick={() => onChange({ ...filters, query: "" })}
          >
            <X size={12} strokeWidth={2.5} />
          </button>
        ) : null}
      </div>

      {(
        [
          ["work", "Work"],
          ["status", "Status"],
          ["type", "Type"],
          ["priority", "Priority"],
          ["label", "Label"],
        ] as const
      ).map(([key, label]) => (
        <FacetMenu
          key={key}
          facet={key}
          label={label}
          clusters={clusters}
          filters={filters}
          resolved={resolved}
          onChange={onChange}
        />
      ))}

      {extraFilter}

      <div className="ml-auto inline-flex items-center gap-2.5 text-sm text-[var(--text-faint)]">
        {/* Only when it is actually a subset: "37 of 37" is noise, and the count is
            there to explain a short canvas. */}
        {shown === clusters.length ? (
          <span>{clusters.length === 1 ? "1 ticket" : `${clusters.length} tickets`}</span>
        ) : (
          <span className="font-mono text-[0.7812rem] text-action">
            {shown} of {clusters.length}
          </span>
        )}
        {isFiltered(filters) ? (
          <button
            type="button"
            className="cursor-pointer rounded-[calc(var(--radius)*.7)] border border-border bg-[var(--bg-raised)] px-[9px] py-1 font-[inherit] text-[0.7812rem] text-muted-foreground hover:bg-[var(--bg-hover)] hover:text-foreground"
            onClick={() => onChange(hasSprints ? DEFAULT_FILTERS : NO_FILTERS)}
            title={
              hasSprints
                ? "Clear everything and go back to the current sprint"
                : "Clear every filter"
            }
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The sprint control: what you are in, with the neighbours a click away.
 *
 * Arrows as well as a menu because sprints have an order and "the one before this"
 * is a real thing to want — reviewing what slipped out of the sprint that just
 * ended is the most common reason to leave the current one at all. The arrows walk
 * the same list the menu shows, so the end of it is the end of both.
 */
function SprintSwitcher({
  options,
  filters,
  resolved,
  onChange,
}: {
  options: readonly SprintOption[];
  filters: GraphFilters;
  resolved: ResolvedSprint;
  onChange: (next: GraphFilters) => void;
}) {
  const [open, setOpen] = useState(false);

  const index = options.findIndex((option) => isSelectedSprint(option, resolved));
  const selected = options[index];
  const timing = selected?.sprint ? sprintTiming(selected.sprint) : undefined;
  const step = (delta: number) => {
    const next = options[index + delta];
    if (next) onChange({ ...filters, sprint: next.selection });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative inline-flex max-w-full min-w-0 items-stretch rounded-[var(--radius)] border border-border bg-[var(--bg-raised)]">
          <button
            type="button"
            className="inline-flex cursor-pointer items-center border-0 bg-transparent px-1.5 text-[var(--text-faint)] enabled:hover:text-foreground disabled:cursor-default disabled:opacity-35"
            aria-label="Previous sprint"
            disabled={index <= 0}
            onClick={() => step(-1)}
          >
            <ChevronLeft size={14} strokeWidth={2.5} />
          </button>

          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex min-w-0 cursor-pointer items-center gap-2 border-0 border-x border-border bg-transparent px-2.5 py-1.5 font-[inherit] text-[0.9375rem] text-foreground hover:bg-[var(--bg-hover)]"
              aria-label="Choose a sprint"
            >
              <span className="max-w-36 overflow-hidden text-ellipsis whitespace-nowrap font-semibold min-[901px]:max-w-55">
                {selected?.label ?? "All tickets"}
              </span>
              <span className="inline-flex items-center gap-1.5 font-mono text-xs text-[var(--text-faint)] max-[900px]:hidden">
                {/* The state word earns its space on everything but the active sprint,
                    where "active" would just restate where you already are. */}
                {selected?.state && selected.state !== "active" ? (
                  <span
                    className={cn(SPRINT_STATE_CLASS, sprintStateTone(selected.state))}
                  >
                    {selected.state}
                  </span>
                ) : null}
                {timing ? <span>{timing}</span> : null}
                {selected ? <span>{selected.count}</span> : null}
              </span>
              <ChevronDown size={13} strokeWidth={2.5} />
            </button>
          </PopoverTrigger>

          <button
            type="button"
            className="inline-flex cursor-pointer items-center border-0 bg-transparent px-1.5 text-[var(--text-faint)] enabled:hover:text-foreground disabled:cursor-default disabled:opacity-35"
            aria-label="Next sprint"
            disabled={index < 0 || index >= options.length - 1}
            onClick={() => step(1)}
          >
            <ChevronRight size={14} strokeWidth={2.5} />
          </button>
        </div>
      </PopoverAnchor>

      <PopoverContent
        align="start"
        sideOffset={6}
        className="min-w-67 rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] p-1.5 shadow-[var(--shadow-panel)] w-auto gap-0 ring-0"
      >
        <div className={PR_FILTER_TITLE_CLASS}>Sprint</div>
        {options.map((option) => {
          const chosen = isSelectedSprint(option, resolved);
          const optionTiming = option.sprint ? sprintTiming(option.sprint) : undefined;
          return (
            <button
              key={String(option.selection)}
              type="button"
              className={cn(
                "flex w-full cursor-pointer items-center justify-between gap-2.5 rounded-md border-0 bg-transparent px-2 py-1.5 text-left font-[inherit] text-[0.9375rem] text-muted-foreground hover:bg-[var(--bg-hover)] hover:text-foreground",
                chosen && "text-foreground",
              )}
              onClick={() => {
                onChange({ ...filters, sprint: option.selection });
                setOpen(false);
              }}
            >
              <span className="inline-flex min-w-0 items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap">
                {option.label}
                {option.sprint?.state === "active" ? (
                  <span className={cn(SPRINT_STATE_CLASS, sprintStateTone("active"))}>
                    active
                  </span>
                ) : null}
              </span>
              <span className="inline-flex shrink-0 items-center gap-2 font-mono text-xs text-[var(--text-faint)]">
                {optionTiming ? <span>{optionTiming}</span> : null}
                <span>{option.count}</span>
                {chosen ? <Check size={12} strokeWidth={3} /> : null}
              </span>
            </button>
          );
        })}
        {resolved.fellBack ? (
          <div className="mt-1 border-t border-border px-2 pt-1.5 pb-0.5 text-[0.7812rem] leading-[1.4] text-[var(--text-faint)]">
            The sprint you had chosen has no tickets here any more, so this is showing
            everything.
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * One dimension's menu.
 *
 * A dimension whose values are all the same is not offered: a menu with one option
 * cannot narrow anything, and five such menus is how a filter bar becomes wallpaper.
 * It stays visible while it holds a selection, so a filter is never on with no way
 * to reach it.
 */
function FacetMenu({
  facet,
  label,
  clusters,
  filters,
  resolved,
  onChange,
}: {
  facet: FacetKey;
  label: string;
  clusters: readonly TicketCluster[];
  filters: GraphFilters;
  resolved: ResolvedSprint;
  onChange: (next: GraphFilters) => void;
}) {
  const [open, setOpen] = useState(false);

  const options = facetOptions(clusters, filters, resolved, facet);
  const selected = filters[facet] as readonly string[];
  if (options.length < 2 && selected.length === 0) return null;

  const toggle = (value: string) => {
    const next = selected.includes(value)
      ? selected.filter((entry) => entry !== value)
      : [...selected, value];
    onChange({ ...filters, [facet]: next } as GraphFilters);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="relative">
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] px-2.5 py-[7px] font-[inherit] text-sm text-muted-foreground hover:text-foreground",
              selected.length > 0 &&
                "border-[color-mix(in_srgb,var(--action)_55%,var(--border))] text-foreground",
            )}
          >
            {label}
            {/* The chosen value rather than a count, when there is exactly one: "Type:
                Bug" is readable at a glance and is by far the common case. */}
            {selected.length === 1 ? (
              <span className="max-w-27 overflow-hidden text-ellipsis whitespace-nowrap rounded-full bg-action/20 px-1.5 py-px text-xs text-action">
                {options.find((option) => option.value === selected[0])?.label ??
                  selected[0]}
              </span>
            ) : selected.length > 1 ? (
              <span className="max-w-27 overflow-hidden text-ellipsis whitespace-nowrap rounded-full bg-action/20 px-1.5 py-px text-xs text-action">
                {selected.length}
              </span>
            ) : null}
            <ChevronDown size={12} strokeWidth={2.5} />
          </button>
        </PopoverTrigger>

        <PopoverContent
          align="start"
          sideOffset={6}
          className={cn(
            PR_FILTER_POPOVER_CLASS,
            "max-h-85 min-w-54 w-auto gap-0 overflow-y-auto ring-0",
          )}
        >
          <div className={PR_FILTER_TITLE_CLASS}>{label}</div>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={cn(PR_FILTER_ROW_CLASS, option.selected && "text-foreground")}
              title={option.hint}
              onClick={() => toggle(option.value)}
            >
              <span
                className={cn(
                  PR_FILTER_CHECK_CLASS,
                  option.selected && "border-action bg-action",
                )}
              >
                {option.selected ? <Check size={12} strokeWidth={3} /> : null}
              </span>
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {option.label}
              </span>
              <span className="shrink-0 font-mono text-xs text-[var(--text-faint)]">
                {option.count}
              </span>
            </button>
          ))}
          {selected.length > 0 ? (
            <button
              type="button"
              className={PR_FILTER_RESET_CLASS}
              onClick={() =>
                onChange({
                  ...filters,
                  [facet]: facet === "work" ? ([] as WorkFacet[]) : [],
                } as GraphFilters)
              }
            >
              Clear {label.toLowerCase()}
            </button>
          ) : null}
        </PopoverContent>
      </div>
    </Popover>
  );
}
