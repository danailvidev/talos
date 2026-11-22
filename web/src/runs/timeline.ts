/**
 * Turns a run's log lines into something a person reads.
 *
 * The log table is an append-only stream of one row per event, which is the
 * right shape to write and the wrong shape to read: a single merge-request
 * follow-up run emits ~330 rows, and better than half of them are the second
 * half of a pair. `step X started` is followed by `step X succeeded`; every
 * `claude Read …` is followed by `tool returned 22175 chars`. Neither pair says
 * anything the first line plus a duration would not.
 *
 * So the stream is folded here, before render, into the events it describes:
 * one row per step (with its duration), one row per tool call (with its result
 * and size), the agent's own words as prose, and a run of consecutive reads as
 * a single "explored 7 files". This is deliberately a pure function over the
 * lines rather than logic inside the component — the pairing rules are the
 * interesting part, and they should be readable without a DOM.
 *
 * Nothing is discarded. Every fold keeps the lines it consumed on the event, so
 * the renderer's raw toggle can show exactly what the server sent.
 */
import type { LogLineView } from "../api.ts";

export type Tone = "muted" | "info" | "success" | "warn" | "error" | "running";

interface Common {
  /** Stable across polls: derived from the line's position and timestamp. */
  id: string;
  ts: string;
  /** Since the first line of the run — see `elapsedLabel`. */
  elapsedMs: number;
  tone: Tone;
  /** The lines this event folded, in order, for the raw toggle. */
  lines: LogLineView[];
}

/** A `step X started` … `step X succeeded` pair and everything logged between. */
export interface StepEvent extends Common {
  kind: "step";
  title: string;
  /** `running` means the run is still inside it, or died inside it. */
  status: "running" | "success" | "failed";
  durationMs?: number;
  attempts?: number;
  children: TimelineEvent[];
}

/** One tool call and its result, folded into a single row. */
export interface ToolEvent extends Common {
  kind: "tool";
  tool: string;
  /** What it was pointed at: a path, a pattern, a shell command. */
  target?: string;
  /** False once a `tool error:` result pairs with it; undefined result reads as pending. */
  ok: boolean;
  resolved: boolean;
  bytes?: number;
  error?: string;
}

/** A consecutive run of successful read-only calls, collapsed. */
export interface ExploreEvent extends Common {
  kind: "explore";
  calls: ToolEvent[];
  bytes: number;
}

/** The agent talking — the most readable content in the log, and the only prose. */
export interface ProseEvent extends Common {
  kind: "prose";
  text: string;
}

/** Anything that is not one of the above: entrypoint progress, task lifecycle. */
export interface NoteEvent extends Common {
  kind: "note";
  text: string;
  step?: string;
  level: string;
  /** Meta worth showing, already rendered as `key value` — never raw JSON. */
  chips: string[];
  /**
   * The one long meta value, if there is one, on its own wrapped line.
   *
   * Runs really do log an `err` several hundred characters wide — a rejected
   * push carries the whole pre-receive hook's output — and that is the most
   * important thing on the row, not a chip. Squeezing it into one would either
   * blow the layout out or truncate the only explanation of what went wrong.
   */
  detail?: string;
}

export type TimelineEvent = StepEvent | ToolEvent | ExploreEvent | ProseEvent | NoteEvent;

/** Which log lines the reader is asking for. */
export type LogFilter = "quiet" | "all" | "errors";

const STEP_START = /^step (.+) started$/;
const STEP_END = /^step (.+) (succeeded|failed)$/;
const TOOL_RESULT = /^tool (returned (\d+) chars|error: ([\s\S]*))$/;

/**
 * Lines the entrypoint and the runner emit, as opposed to the agent's own words.
 *
 * Only consulted for history written before the parser started tagging prose with
 * `meta.kind = "message"`; a tagged line needs no guessing. Without this, every
 * `cloning acme/web@fix/1` in the archive would render as a paragraph of agent
 * speech, because it carries the same `agent: "claude"` meta.
 */
const MACHINE_LINE =
  /^(claude (started|finished)|cloning |clone (finished|failed)|fetching target|wrote |could not fetch|installing dependencies|dependencies installed|dependency install failed|collecting CLAUDE\.md|starting claude agent|pushed |agent left no changes|building )/;

/** Tools whose subject is a path, and so can be shown as a basename. */
const PATH_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookRead", "NotebookEdit"]);

/**
 * Tools that only look. A stretch of these is the agent orienting itself, which
 * is worth one line ("explored 7 files") and not fifteen — but only while they
 * succeed, because a failed read is a fact about the repository.
 */
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "List",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
]);

/** Below this, listing the calls individually is shorter than explaining them. */
const EXPLORE_MIN = 3;

/** Meta keys the timeline already renders as structure, so never as a chip. */
const STRUCTURAL_META = new Set([
  "agent",
  "tool",
  "toolUseId",
  "bytes",
  "ok",
  "kind",
  "status",
  "durationMs",
  "attempts",
  "details",
]);

export function buildTimeline(lines: readonly LogLineView[]): TimelineEvent[] {
  const rows = dedupe(lines);
  const origin = rows.length > 0 ? time(rows[0]!.ts) : 0;

  const root: TimelineEvent[] = [];
  /** Open `step … started` events, innermost last. */
  const open: StepEvent[] = [];
  const sink = () => (open.length > 0 ? open[open.length - 1]!.children : root);

  /** Tool calls waiting on a result, by `toolUseId` when the line carried one. */
  const byId = new Map<string, ToolEvent>();
  /** …and in arrival order, for history written before `toolUseId` was logged. */
  const unresolved: ToolEvent[] = [];

  rows.forEach((line, index) => {
    const base = {
      id: `${index}-${line.ts}`,
      ts: line.ts,
      elapsedMs: Math.max(0, time(line.ts) - origin),
      lines: [line],
    };
    const meta = line.meta ?? {};

    const start = line.message.match(STEP_START);
    if (start) {
      const step: StepEvent = {
        ...base,
        kind: "step",
        tone: "running",
        title: humanizeStep(start[1]!),
        status: "running",
        children: [],
      };
      sink().push(step);
      open.push(step);
      return;
    }

    const end = line.message.match(STEP_END);
    if (end) {
      const title = humanizeStep(end[1]!);
      // Searched from the innermost outwards, and everything above it closed with
      // it: a step whose own end line never arrived (the run died inside it) must
      // not swallow the rest of the log as its children.
      const at = findLast(open, (step) => step.title === title);
      if (at >= 0) {
        const step = open[at]!;
        step.status = end[2] === "failed" ? "failed" : "success";
        step.tone = step.status === "failed" ? "error" : "success";
        step.durationMs = num(meta.durationMs);
        step.attempts = num(meta.attempts);
        step.lines.push(line);
        open.length = at;
        return;
      }
      sink().push(note(base, line, "muted"));
      return;
    }

    const result = line.message.match(TOOL_RESULT);
    if (result || (meta.ok !== undefined && meta.bytes !== undefined)) {
      const id = str(meta.toolUseId);
      const call = (id ? byId.get(id) : undefined) ?? unresolved[0];
      const failed = meta.ok === false || result?.[3] !== undefined;
      const bytes = num(meta.bytes) ?? (result?.[2] ? Number(result[2]) : undefined);

      if (call) {
        call.resolved = true;
        call.ok = !failed;
        call.bytes = bytes;
        call.error = failed ? (result?.[3]?.trim() ?? line.message) : undefined;
        call.tone = failed ? "error" : "info";
        call.lines.push(line);
        if (id) byId.delete(id);
        remove(unresolved, call);
        return;
      }
      // A result with no call in hand — a truncated log, or a poll that landed
      // between the two lines. Better as its own row than dropped.
      sink().push(note(base, line, failed ? "error" : "muted"));
      return;
    }

    const tool = str(meta.tool);
    if (tool) {
      const event: ToolEvent = {
        ...base,
        kind: "tool",
        tone: "info",
        tool,
        target: toolTarget(line.message, tool),
        ok: true,
        resolved: false,
      };
      sink().push(event);
      const id = str(meta.toolUseId);
      if (id) byId.set(id, event);
      unresolved.push(event);
      return;
    }

    if (meta.kind === "message" || (meta.agent === "claude" && !MACHINE_LINE.test(line.message))) {
      sink().push({ ...base, kind: "prose", tone: "info", text: line.message });
      return;
    }

    sink().push(note(base, line, toneOf(line.level)));
  });

  return collapseExploration(root);
}

/** One `note` from a line the folds did not claim. */
function note(base: Omit<Common, "tone">, line: LogLineView, tone: Tone): NoteEvent {
  const text = runLifecycle(line.message) ?? line.message;
  return {
    ...base,
    kind: "note",
    tone,
    text,
    step: line.step ? humanizeStep(line.step) : undefined,
    level: line.level,
    ...metaFrom(line.meta, text),
  };
}

/**
 * `task 7579cab0-75ea-43da-964b-09431dfd461b started` → `Run started`.
 *
 * The execution id is on the run's own detail panel two inches above this log,
 * and repeating it inside the log's narrowest column only ever pushed the one
 * readable word off the end of the line.
 */
function runLifecycle(message: string): string | undefined {
  const match = message.match(/^task \S+ (started|succeeded|failed)$/);
  return match ? `Run ${match[1]}` : undefined;
}

/**
 * Drops the second copy of a line the runner logged twice.
 *
 * `task … started` genuinely appears twice within a millisecond on every run
 * (two sinks, one event). Matched on same message *and* near-identical
 * timestamp so a step that legitimately repeats later in the run still shows
 * both times.
 *
 * Tool lines are never collapsed, however near-identical they look. Two
 * consecutive shell calls in one turn log the same text — before `command` was
 * summarized they both read exactly `claude Bash` — and folding those two calls
 * into one left their two results with only one call to pair with, so a real
 * failure surfaced as an orphaned `tool error:` row instead of on the call that
 * failed.
 */
function dedupe(lines: readonly LogLineView[]): LogLineView[] {
  const out: LogLineView[] = [];
  for (const line of lines) {
    const previous = out[out.length - 1];
    if (
      line.meta?.tool != null ||
      line.meta?.toolUseId != null ||
      TOOL_RESULT.test(line.message)
    ) {
      out.push(line);
      continue;
    }
    if (
      previous &&
      previous.message === line.message &&
      previous.level === line.level &&
      (previous.step ?? "") === (line.step ?? "") &&
      Math.abs(time(line.ts) - time(previous.ts)) < 50
    ) {
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * Replaces each run of `EXPLORE_MIN`+ successful read-only calls with one
 * summary row, at every level of the tree. This is the single biggest reduction
 * on a long run: the agent reads a dozen files before it changes one, and those
 * dozen rows are noise until you want them, which is what expanding is for.
 */
function collapseExploration(events: TimelineEvent[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  let run: ToolEvent[] = [];

  const flush = () => {
    if (run.length >= EXPLORE_MIN) {
      const first = run[0]!;
      out.push({
        id: `explore-${first.id}`,
        ts: first.ts,
        elapsedMs: first.elapsedMs,
        tone: "muted",
        kind: "explore",
        calls: run,
        bytes: run.reduce((total, call) => total + (call.bytes ?? 0), 0),
        lines: run.flatMap((call) => call.lines),
      });
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const event of events) {
    if (event.kind === "step") {
      flush();
      out.push({ ...event, children: collapseExploration(event.children) });
      continue;
    }
    if (event.kind === "tool" && event.ok && READ_ONLY_TOOLS.has(event.tool)) {
      run.push(event);
      continue;
    }
    flush();
    out.push(event);
  }
  flush();
  return out;
}

/**
 * Whether an event survives the current filter, and whether it has to be shown
 * because something inside it did. `errors` keeps a step whose child failed —
 * a bare failed row with no idea which step it happened in is not a diagnosis.
 */
export function matchesFilter(event: TimelineEvent, filter: LogFilter): boolean {
  if (filter === "all") return true;
  // Quiet drops debug and trace and nothing else. Steps are kept even when empty:
  // `Current user · 296ms` has no children and is still a fact about the run, and
  // hiding childless steps would silently delete most of a short run's log.
  if (filter === "quiet") {
    return !(event.kind === "note" && (event.level === "debug" || event.level === "trace"));
  }
  if (event.tone === "error" || event.tone === "warn") return true;
  if (event.kind === "step") return event.children.some((child) => matchesFilter(child, filter));
  if (event.kind === "explore") return event.calls.some((call) => !call.ok);
  return false;
}

/** Whether anything under here failed — decides which steps open on their own. */
export function containsFailure(event: TimelineEvent): boolean {
  if (event.tone === "error") return true;
  if (event.kind === "step") return event.children.some(containsFailure);
  if (event.kind === "explore") return event.calls.some((call) => !call.ok);
  return false;
}

export function countEvents(events: readonly TimelineEvent[]): number {
  return events.reduce(
    (total, event) => total + 1 + (event.kind === "step" ? countEvents(event.children) : 0),
    0,
  );
}

/* ------------------------------------------------------------------ labels */

/**
 * Time since the run's first line, which is the question a log actually
 * answers: "where did the twenty minutes go?" The wall clock cannot answer it
 * without subtracting two timestamps by hand, and it was the only time this
 * view offered. The absolute stamp is still one hover away.
 */
export function elapsedLabel(ms: number): string {
  const total = Math.floor(ms / 1000);
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? `+${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `+${minutes}:${seconds}`;
}

/** How much a tool handed back, in the units a person reads sizes in. */
export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * `list-authored-merge-requests` → `List authored merge requests`, and
 * `discussions:6193` → `Discussions 6193`. Steps are named as identifiers
 * because code refers to them; nothing about that is for reading.
 */
export function humanizeStep(slug: string): string {
  const text = slug.replace(/[:_]/g, " ").replace(/-/g, " ").replace(/\s+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The tool's subject, shortened for the row; the full value goes in a tooltip. */
export function shortTarget(event: ToolEvent): string | undefined {
  if (!event.target) return undefined;
  if (!PATH_TOOLS.has(event.tool)) return event.target;
  const parts = event.target.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(-1).join("/") : event.target;
}

/** What `logsFromAssistant` wrote after `claude <Tool> `, if anything. */
function toolTarget(message: string, tool: string): string | undefined {
  const prefix = `claude ${tool} `;
  const target = message.startsWith(prefix) ? message.slice(prefix.length).trim() : "";
  return target || undefined;
}

/** Above this a meta value is a paragraph, not a label — see `NoteEvent.detail`. */
const CHIP_MAX = 60;

/**
 * Meta as readable pairs rather than the JSON blob this view used to append to
 * every line. Structural keys are already drawn as durations, sizes and status,
 * so repeating them here would just be the old noise in a nicer font — and so is
 * a value the message it sits on already quotes, which is most of them
 * (`building talos-mr-follow-up:1` carrying `tag: talos-mr-follow-up:1`).
 */
function metaFrom(
  meta: Record<string, unknown> | undefined,
  message: string,
): { chips: string[]; detail?: string } {
  if (!meta) return { chips: [] };
  const chips: string[] = [];
  let detail: string | undefined;

  for (const [key, value] of Object.entries(meta)) {
    if (STRUCTURAL_META.has(key)) continue;
    if (value == null || typeof value === "object") continue;
    const text = String(value);
    if (!text || message.includes(text)) continue;
    if (text.length > CHIP_MAX) {
      // Only the first long value; a line with two of them is a line that should
      // be read through the raw toggle anyway.
      detail ??= `${humanizeKey(key)}: ${text}`;
      continue;
    }
    chips.push(`${humanizeKey(key)} ${text}`);
    if (chips.length === 4) break;
  }
  return detail ? { chips, detail } : { chips };
}

/** Meta keys as words, with the initialisms that would otherwise read as names. */
const KEY_WORDS: Record<string, string> = {
  err: "Error",
  mrIid: "MR",
  iid: "MR",
  sha: "SHA",
  url: "URL",
  id: "ID",
};

function humanizeKey(key: string): string {
  if (KEY_WORDS[key]) return KEY_WORDS[key]!;
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* ------------------------------------------------------------------- utils */

function toneOf(level: string): Tone {
  if (level === "error" || level === "fatal") return "error";
  if (level === "warn") return "warn";
  if (level === "debug" || level === "trace") return "muted";
  return "info";
}

function time(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function findLast<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i]!)) return i;
  return -1;
}

function remove<T>(items: T[], item: T): void {
  const at = items.indexOf(item);
  if (at >= 0) items.splice(at, 1);
}
