/**
 * The run log, rendered as what happened rather than as what was written.
 *
 * Every row here is one event from `buildTimeline` — a step with its duration, a
 * tool call with its result, the agent's own words — so the folding rules live in
 * that module and this file is only presentation. Three things are deliberate:
 *
 * - Elapsed time is the primary column and the wall clock is a hover, because
 *   "+2:18" answers "where did the twenty minutes go" and "15:44:40" does not.
 * - There is no level column. It read `info` on ~98% of rows and cost 3.5rem of
 *   a message column that was already the first thing to be truncated; severity
 *   is now a colour and an icon, and only warn/error say so in words.
 * - Meta is never printed as JSON. It becomes a duration, a size, or a chip, and
 *   the original line is one `{}` click away for when you are debugging talos
 *   itself rather than reading a run.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Braces,
  Check,
  ChevronRight,
  CircleAlert,
  FilePen,
  FileText,
  FolderSearch,
  Globe,
  ListChecks,
  LoaderCircle,
  Search,
  Sparkles,
  Terminal,
  TriangleAlert,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

import type { LogLineView } from "../api.ts";
import { Tip } from "../Tip.tsx";
import { useFormat } from "../FormatContext.tsx";
import { cn } from "../lib/utils.ts";
import { Button } from "../components/ui/button.tsx";

const TIMELINE_ROW_CLASS =
  "run-timeline-row flex flex-wrap items-baseline gap-2 rounded-sm px-[5px] py-0.5 shadow-[inset_2px_0_0_transparent] hover:bg-[color-mix(in_srgb,var(--bg-hover)_40%,transparent)]";
const TIMELINE_BODY_CLASS =
  "flex min-w-0 flex-1 flex-wrap items-baseline gap-1.5";
const TIMELINE_CHIP_CLASS =
  "shrink-0 rounded-full border border-border bg-[var(--bg-raised)] px-1.5 text-xs text-muted-foreground";
const TIMELINE_MUTED_CLASS = "ml-auto shrink-0 text-xs text-[var(--text-faint)]";

function rowTone(tone: string): string {
  if (tone === "error") {
    return "bg-[color-mix(in_srgb,var(--status-danger)_8%,transparent)] shadow-[inset_2px_0_0_var(--status-danger)]";
  }
  if (tone === "warn") return "shadow-[inset_2px_0_0_var(--status-warning)]";
  return "";
}
import {
  bytesLabel,
  buildTimeline,
  containsFailure,
  countEvents,
  elapsedLabel,
  matchesFilter,
  shortTarget,
  type ExploreEvent,
  type LogFilter,
  type NoteEvent,
  type ProseEvent,
  type StepEvent,
  type TimelineEvent,
  type ToolEvent,
} from "./timeline.ts";

const FILTERS: { value: LogFilter; label: string; hint: string }[] = [
  { value: "quiet", label: "Quiet", hint: "The run, without debug detail" },
  { value: "all", label: "All", hint: "Every line, including debug and trace" },
  { value: "errors", label: "Errors", hint: "Only what failed, in the steps it failed in" },
];

const TOOL_ICONS: Record<string, LucideIcon> = {
  Read: FileText,
  NotebookRead: FileText,
  Write: FilePen,
  Edit: FilePen,
  MultiEdit: FilePen,
  NotebookEdit: FilePen,
  Grep: Search,
  Glob: FolderSearch,
  LS: FolderSearch,
  List: FolderSearch,
  Bash: Terminal,
  WebFetch: Globe,
  WebSearch: Globe,
  TodoWrite: ListChecks,
  Task: Sparkles,
};

/**
 * Follows the bottom while the reader is already there. Scrolling up pins the
 * view so a new line does not yank them off what they were reading; returning to
 * the bottom resumes following.
 */
export function RunTimeline({
  lines,
  live,
  hasOlder,
  loadingOlder,
  onLoadOlder,
}: {
  lines: LogLineView[];
  live?: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinToBottom = useRef(true);
  const [filter, setFilter] = useState<LogFilter>("quiet");

  // Folding ~330 lines is cheap, but it runs on every one-second poll tick of a
  // live run and on every unrelated re-render of the page around it.
  const events = useMemo(() => buildTimeline(lines), [lines]);
  const visible = useMemo(
    () => events.filter((event) => matchesFilter(event, filter)),
    [events, filter],
  );

  useEffect(() => {
    const el = scroller.current;
    if (!el || !pinToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [visible]);

  return (
    <div className="run-log overflow-hidden rounded-[var(--radius)] border border-border bg-[var(--bg-deep)]">
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 text-[0.7812rem] font-semibold tracking-[0.5px] text-[var(--text-faint)] uppercase">
        <span>Activity</span>
        {live ? (
          <span className="font-medium tracking-normal text-live normal-case">live</span>
        ) : null}
        {events.length > 0 ? (
          <div
            className="ml-auto flex gap-0.5 rounded-full border border-border p-px"
            role="group"
            aria-label="Log detail"
          >
            {FILTERS.map((option) => (
              <Tip key={option.value} label={option.hint}>
                <Button
                  type="button"
                  variant="ghost"
                  className={cn(
                    "h-auto rounded-full border-0 bg-transparent px-2 py-px font-[inherit] text-xs tracking-[0.4px] text-[var(--text-faint)] hover:bg-transparent hover:text-[var(--text-dim)]",
                    filter === option.value && "bg-[var(--bg-raised)] text-foreground",
                  )}
                  aria-pressed={filter === option.value}
                  onClick={() => setFilter(option.value)}
                >
                  {option.label}
                </Button>
              </Tip>
            ))}
          </div>
        ) : null}
      </div>
      <div
        ref={scroller}
        className="activity-log-body min-h-70 max-h-120 overflow-auto px-2.5 py-2 font-mono text-[0.8125rem] leading-[1.45]"
        onScroll={(event) => {
          const el = event.currentTarget;
          pinToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {hasOlder ? (
          <Button
            type="button"
            variant="outline"
            className="mx-auto mt-1.5 mb-2 h-auto self-center rounded-full bg-[var(--bg-raised)] px-3 py-[3px] font-[inherit] text-[var(--text-dim)] disabled:cursor-wait disabled:opacity-65"
            disabled={loadingOlder}
            onClick={onLoadOlder}
          >
            {loadingOlder ? "Loading…" : "Load older activity"}
          </Button>
        ) : null}
        {events.length === 0 ? (
          <div className="px-1 py-3 text-[var(--text-faint)]">
            {live ? "Waiting for log lines…" : "No log lines recorded for this run."}
          </div>
        ) : visible.length === 0 ? (
          <div className="px-1 py-3 text-[var(--text-faint)]">
            {filter === "errors"
              ? `Nothing failed in these ${countEvents(events)} events.`
              : "Nothing to show at this detail level."}
          </div>
        ) : (
          <div className="run-timeline flex flex-col gap-px">
            {visible.map((event) => (
              <EventRow key={event.id} event={event} filter={filter} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EventRow({ event, filter }: { event: TimelineEvent; filter: LogFilter }) {
  switch (event.kind) {
    case "step":
      return <StepRow event={event} filter={filter} />;
    case "tool":
      return <ToolRow event={event} />;
    case "explore":
      return <ExploreRow event={event} />;
    case "prose":
      return <ProseRow event={event} />;
    default:
      return <NoteRow event={event} />;
  }
}

/**
 * One step, with its children nested under it. Open by default: a collapsed
 * tree hides the run, and the reason to group at all is the duration and the
 * outcome on the header, not the folding. A failed step stays open even under
 * the `errors` filter, which is the one case where you asked to be shown less
 * and still need the context.
 */
function StepRow({ event, filter }: { event: StepEvent; filter: LogFilter }) {
  const fmt = useFormat();
  const [open, setOpen] = useState(true);
  const children = event.children.filter((child) => matchesFilter(child, filter));
  const failed = containsFailure(event);
  const Icon = event.status === "failed" ? X : event.status === "running" ? LoaderCircle : Check;

  return (
    <div className="run-timeline-step">
      <div
        className={cn(
          TIMELINE_ROW_CLASS,
          rowTone(event.tone),
          failed && "shadow-[inset_2px_0_0_var(--status-danger)]",
        )}
      >
        <Elapsed event={event} />
        <Button
          type="button"
          variant="ghost"
          className="h-auto min-w-0 flex-1 justify-start gap-1.5 rounded-none border-0 bg-transparent p-0 text-left font-[inherit] font-semibold text-foreground hover:bg-transparent disabled:cursor-default"
          aria-expanded={children.length > 0 ? open : undefined}
          // A step that logged nothing of its own has nothing to expand into —
          // most of them, on a short run — so it reads as a row, not a control.
          disabled={children.length === 0}
          onClick={() => setOpen(!open)}
        >
          {children.length > 0 ? (
            <ChevronRight
              className={cn(
                "shrink-0 text-[var(--text-faint)] transition-transform duration-120",
                open && "rotate-90",
              )}
              size={12}
            />
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <Icon
            size={12}
            strokeWidth={2.5}
            className={cn(
              event.status === "success" && "text-[var(--success)]",
              event.status === "failed" && "text-[var(--status-danger)]",
              event.status === "running" && "animate-spin text-[var(--running)]",
            )}
          />
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{event.title}</span>
          {event.durationMs != null ? (
            <span className={TIMELINE_CHIP_CLASS}>{fmt.duration(event.durationMs)}</span>
          ) : null}
          {event.attempts != null && event.attempts > 1 ? (
            <span
              className={cn(
                TIMELINE_CHIP_CLASS,
                "border-[color-mix(in_srgb,var(--status-warning)_45%,transparent)] text-warning",
              )}
            >
              {event.attempts} attempts
            </span>
          ) : null}
          {!open ? (
            <span className={TIMELINE_MUTED_CLASS}>{children.length} events</span>
          ) : null}
        </Button>
        <Raw event={event} />
      </div>
      {open && children.length > 0 ? (
        <div className="mt-px mr-0 mb-[3px] ml-2.5 flex flex-col gap-px border-l border-border pl-2.5">
          {children.map((child) => (
            <EventRow key={child.id} event={child} filter={filter} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A tool call and its result on one line. The size is the whole of what the old
 * `tool returned 22175 chars` row said, and an error is shown inline because a
 * failed tool call is usually the reason the run you are reading exists.
 */
function ToolRow({ event }: { event: ToolEvent }) {
  const fmt = useFormat();
  const Icon = TOOL_ICONS[event.tool] ?? Wrench;
  const target = shortTarget(event);
  const truncated = target !== event.target;

  return (
    <div className={cn(TIMELINE_ROW_CLASS, rowTone(event.tone))}>
      <Elapsed event={event} />
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-[5px] text-success",
          event.tone === "error" && "text-[var(--status-danger)]",
        )}
      >
        {event.ok ? (
          <Icon size={12} strokeWidth={2} />
        ) : (
          <CircleAlert size={12} strokeWidth={2.5} />
        )}
        <span className="text-xs font-bold tracking-[0.3px]">{event.tool}</span>
      </span>
      <span className={TIMELINE_BODY_CLASS}>
        {target ? (
          <Tip label={truncated ? event.target : undefined}>
            <span className="text-[var(--text-dim)] [overflow-wrap:anywhere]">{target}</span>
          </Tip>
        ) : null}
        {event.error ? (
          <span className="basis-full whitespace-pre-wrap text-[var(--status-danger)] [overflow-wrap:anywhere]">
            {event.error}
          </span>
        ) : null}
      </span>
      {!event.resolved ? (
        <span className={TIMELINE_MUTED_CLASS}>running…</span>
      ) : event.bytes != null && event.ok ? (
        <Tip label={`${fmt.number(event.bytes)} characters returned`}>
          <span className={TIMELINE_MUTED_CLASS}>{bytesLabel(event.bytes)}</span>
        </Tip>
      ) : null}
      <Raw event={event} />
    </div>
  );
}

/**
 * A stretch of reads and greps as one row. The agent orients itself before it
 * changes anything, and on a long run that is most of the log — worth a line
 * that says how much it looked at, and an expand for when you care what it read.
 */
function ExploreRow({ event }: { event: ExploreEvent }) {
  const [open, setOpen] = useState(false);
  const files = event.calls.length;

  return (
    <div>
      <div className={TIMELINE_ROW_CLASS}>
        <Elapsed event={event} />
        <Button
          type="button"
          variant="ghost"
          className="h-auto min-w-0 flex-1 justify-start gap-1.5 rounded-none border-0 bg-transparent p-0 text-left font-[inherit] text-[var(--text-dim)] hover:bg-transparent"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight
            className={cn(
              "shrink-0 text-[var(--text-faint)] transition-transform duration-120",
              open && "rotate-90",
            )}
            size={12}
          />
          <FolderSearch size={12} strokeWidth={2} />
          <span>
            Explored {files} {files === 1 ? "file" : "files"}
          </span>
          {event.bytes > 0 ? (
            <span className={TIMELINE_CHIP_CLASS}>{bytesLabel(event.bytes)} read</span>
          ) : null}
        </Button>
      </div>
      {open ? (
        <div className="mt-px mr-0 mb-[3px] ml-2.5 flex flex-col gap-px border-l border-border pl-2.5">
          {event.calls.map((call) => (
            <ToolRow key={call.id} event={call} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The agent talking. Sans-serif, full width, its own indent: this is the most
 * human-readable content in the log and it used to be typeset as 11.5px mono in
 * whatever was left of a four-column grid.
 */
function ProseRow({ event }: { event: ProseEvent }) {
  return (
    <div className={cn(TIMELINE_ROW_CLASS, "items-start py-1")}>
      <Elapsed event={event} />
      <Sparkles className="mt-[3px] shrink-0 text-warning" size={12} strokeWidth={2} />
      <p className="m-0 min-w-0 flex-1 font-sans text-[0.9062rem] leading-normal text-foreground">
        {event.text}
      </p>
      <Raw event={event} />
    </div>
  );
}

/** Everything the folds did not claim: entrypoint progress, task lifecycle. */
function NoteRow({ event }: { event: NoteEvent }) {
  const loud = event.tone === "error" || event.tone === "warn";

  return (
    <div className={cn(TIMELINE_ROW_CLASS, rowTone(event.tone))}>
      <Elapsed event={event} />
      {loud ? (
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 text-xs font-bold tracking-[0.5px] uppercase",
            event.tone === "error" ? "text-[var(--status-danger)]" : "text-warning",
          )}
        >
          {event.tone === "error" ? <CircleAlert size={12} /> : <TriangleAlert size={12} />}
          {event.level}
        </span>
      ) : null}
      <span className={TIMELINE_BODY_CLASS}>
        {event.step ? <span className="shrink-0 text-xs text-success">{event.step}</span> : null}
        <span className="text-[var(--text-dim)] [overflow-wrap:anywhere]">{event.text}</span>
        {event.chips.map((chip) => (
          <span key={chip} className={TIMELINE_CHIP_CLASS}>
            {chip}
          </span>
        ))}
        {event.detail ? (
          <span
            className={cn(
              "basis-full whitespace-pre-wrap [overflow-wrap:anywhere]",
              loud ? "text-[var(--status-danger)]" : "text-muted-foreground",
            )}
          >
            {event.detail}
          </span>
        ) : null}
      </span>
      <Raw event={event} />
    </div>
  );
}

/** Elapsed since the run's first line; the wall clock is the tooltip. */
function Elapsed({ event }: { event: TimelineEvent }) {
  const fmt = useFormat();
  return (
    <Tip label={fmt.stamp(event.ts)}>
      <span className="run-timeline-elapsed w-13.5 shrink-0 text-[var(--text-faint)] tabular-nums">
        {elapsedLabel(event.elapsedMs)}
      </span>
    </Tip>
  );
}

/**
 * The lines behind a row, verbatim.
 *
 * Folding is a reading aid and not a guarantee: when a row looks wrong, or the
 * question is about talos rather than about the run, the original JSON has to
 * be reachable without opening a database. Hidden until the row is hovered so it
 * costs nothing to have.
 */
function Raw({ event }: { event: TimelineEvent }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tip label={open ? "Hide the raw log lines" : "Show the raw log lines"}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(
            "run-timeline-raw-toggle shrink-0 rounded-[3px] p-px text-[var(--text-faint)] opacity-0 hover:bg-[var(--bg-hover)] hover:text-success focus-visible:opacity-100",
            open && "opacity-100",
          )}
          aria-label="Toggle raw log lines"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Braces size={11} strokeWidth={2} />
        </Button>
      </Tip>
      {open ? (
        <pre className="basis-full my-1 max-h-60 overflow-auto rounded-md border border-border bg-background px-2.5 py-2 text-xs leading-[1.4] whitespace-pre-wrap text-muted-foreground">
          {JSON.stringify(event.lines, null, 2)}
        </pre>
      ) : null}
    </>
  );
}
