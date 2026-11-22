import { useState, type ReactNode } from "react";

import { useFormat } from "../FormatContext.tsx";
import type { FiledIssueView, TaskRunView } from "../api.ts";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { Tip } from "../Tip.tsx";
import { useChartWidth } from "./useChartWidth.ts";
import { cn } from "../lib/utils.ts";

/**
 * The Overview charts for a loop — hand-written SVG rather than a charting
 * library.
 *
 * These are sparkline-scale marks (12 columns, a 12-point line, a ring) sitting
 * in a card grid that re-renders on every detail poll. Recharts — what
 * shadcn/ui's chart block wraps — measures its container, then builds a React
 * subtree per tick, label and mark; it would also add ~500KB to a bundle with no
 * charting dependency at all today. At this size a chart is a handful of paths,
 * so the marks are drawn directly in the app's semantic operational palette
 * (success, warning, and danger) rather than a second
 * palette arriving with the library.
 *
 * Geometry is in real pixels (see `useChartWidth`), so the mark specs — a 24px
 * bar cap, 2px lines, 4px data-ends, hairline axes — hold at any card width.
 */

/** How many runs a card-width chart can show without the columns going hairline. */
const WINDOW = 12;
type ChartMode = "ci" | "datadog";

interface TipRow {
  label: string;
  value: string;
  /** Series colour, keyed beside the row. Omit for a plain supporting fact. */
  color?: string;
}

/**
 * Floating readout for the hovered mark. It sits inside the plot rather than
 * above it: cards clip their content, so a tooltip escaping upwards would be cut
 * in half. Clamped horizontally so the first and last marks keep it in view.
 */
function ChartTip({
  index,
  count,
  title,
  rows,
}: {
  index: number;
  count: number;
  title: string;
  rows: TipRow[];
}) {
  const x = ((index + 0.5) / count) * 100;
  return (
    <div
      className="pointer-events-none absolute -top-0.5 z-5 min-w-33 -translate-x-1/2 rounded-[var(--radius-sm)] border border-border bg-[var(--bg-deep)] px-2 py-1.5 shadow-[var(--shadow-panel)]"
      style={{ left: `${Math.min(86, Math.max(14, x))}%` }}
      role="tooltip"
    >
      <div className="mb-[3px] text-xs whitespace-nowrap text-[var(--text-faint)]">{title}</div>
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid grid-cols-[8px_1fr_auto] items-center gap-1.5 text-[0.7812rem] whitespace-nowrap"
        >
          <span
            className="h-0.5 rounded-px"
            style={{ background: row.color ?? "transparent" }}
          />
          <span className="text-muted-foreground">{row.label}</span>
          <span className="ml-auto font-semibold text-foreground tabular-nums">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

function ChartCard({
  title,
  value,
  hint,
  className,
  children,
}: {
  title: string;
  /** The headline number the chart is context for. */
  value?: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card size="sm" className={cn("overflow-visible", className)}>
      <CardHeader className="flex items-baseline justify-between gap-2">
        <CardTitle className="text-xs font-normal text-muted-foreground">{title}</CardTitle>
        {value ? <span className="text-[1.0625rem] font-semibold text-foreground">{value}</span> : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-center gap-1.5">
        {children}
        {hint ? <div className="text-[0.7812rem] text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

/** A rect with only its top corners rounded — the data end, square at the baseline. */
function columnPath(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.max(0, Math.min(r, h, w / 2));
  return [
    `M${x},${y + h}`,
    `V${y + radius}`,
    radius > 0 ? `A${radius},${radius} 0 0 1 ${x + radius},${y}` : "",
    `H${x + w - radius}`,
    radius > 0 ? `A${radius},${radius} 0 0 1 ${x + w},${y + radius}` : "",
    `V${y + h}`,
    "Z",
  ].join(" ");
}

function statusColor(status: TaskRunView["status"]): string {
  if (status === "success") return "var(--status-success)";
  if (status === "failure") return "var(--status-danger)";
  return "var(--text-faint)";
}

/** Chronological window of the most recent runs — the API returns newest first. */
function recent(runs: TaskRunView[]): TaskRunView[] {
  return runs.slice(0, WINDOW).reverse();
}

/** A numeric field out of a run's free-form `details`, when it is really there. */
function detailCount(details: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = details?.[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * What each run actually did with the failures it saw: how many reached Jira —
 * as a new ticket or a comment on the one already open for that failure — and how
 * many it deliberately left alone. Stacked because the two add up to failures
 * seen, which is the number an operator checks against their pipeline.
 */
function TicketsPerRun({ runs, mode }: { runs: TaskRunView[]; mode: ChartMode }) {
  const fmt = useFormat();
  const [active, setActive] = useState<number | null>(null);
  const [ref, width] = useChartWidth();
  const shown = recent(runs);

  const points = shown.map((run) => {
    if (mode === "datadog") {
      const filed = detailCount(run.details, "filed") ?? 0;
      const held = ["held", "dismissed", "deferred", "suppressed", "jiraFailed"].reduce(
        (sum, key) => sum + (detailCount(run.details, key) ?? 0),
        0,
      );
      const tracked = ["adopted", "existing", "activePr"].reduce(
        (sum, key) => sum + (detailCount(run.details, key) ?? 0),
        0,
      );
      return { run, filed, held, tracked, total: filed + held + tracked };
    }
    const filed = run.itemsProcessed ?? 0;
    const seen = run.itemsSeen ?? filed + (run.itemsSkipped ?? 0);
    const held = run.itemsSkipped ?? Math.max(0, seen - filed);
    return { run, filed, held, tracked: 0, total: filed + held };
  });

  const peak = Math.max(1, ...points.map((point) => point.total));
  const plotH = 92;
  const railY = plotH + 7;
  const height = railY + 3;
  const band = width / points.length;
  const barW = Math.min(24, Math.max(4, band - 8));
  const scale = (n: number) => (n / peak) * (plotH - 14);
  // Label only the busiest run: a number over every column is noise, and every
  // other value is one hover away.
  const peakIndex = points.findIndex((point) => point.total === peak);
  const hovered = active != null ? points[active] : undefined;

  return (
    <div className="relative" ref={ref}>
      {hovered ? (
        <ChartTip
          index={active!}
          count={points.length}
          title={fmt.stamp(hovered.run.startedAt)}
          rows={[
            // The run knows whether it opened a ticket or commented on an open
            // one; the column cannot show that, so the readout does.
            ...(mode === "datadog"
              ? [
                  {
                    label: "New tickets",
                    value: String(hovered.filed),
                    color: "var(--status-success)",
                  },
                ]
              : detailCount(hovered.run.details, "filed") != null ||
            detailCount(hovered.run.details, "commented") != null
              ? [
                  {
                    label: "New tickets",
                    value: String(detailCount(hovered.run.details, "filed") ?? 0),
                    color: "var(--status-success)",
                  },
                  {
                    label: "Commented",
                    value: String(detailCount(hovered.run.details, "commented") ?? 0),
                    color: "var(--status-success)",
                  },
                ]
              : [
                  {
                    label: "Ticketed",
                    value: String(hovered.filed),
                    color: "var(--status-success)",
                  },
                ]),
            {
              label: mode === "datadog" ? "Held / skipped" : "Left alone",
              value: String(hovered.held),
              color: "var(--status-warning)",
            },
            ...(mode === "datadog"
              ? [
                  {
                    label: "Already tracked",
                    value: String(hovered.tracked),
                    color: "var(--action)",
                  },
                ]
              : []),
            { label: "Run", value: hovered.run.status },
          ]}
        />
      ) : null}
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block h-auto w-full overflow-visible"
        role="img"
        aria-label={`${mode === "datadog" ? "Production regressions" : "Failures"} ticketed per run over the last ${points.length} runs`}
      >
        <line x1={0} x2={width} y1={plotH} y2={plotH} stroke="var(--border)" strokeWidth={1} />
        {points.map((point, index) => {
          const x = index * band + (band - barW) / 2;
          const filedH = scale(point.filed);
          const heldH = scale(point.held);
          const trackedH = scale(point.tracked);
          // 2px of surface between the segments does the separating; no stroke.
          const trackedY = plotH - trackedH;
          const heldY = trackedY - (trackedH > 0 ? 2 : 0) - heldH;
          const filedY = heldY - (heldH > 0 ? 2 : 0) - filedH;

          return (
            <g
              key={point.run.executionId}
              tabIndex={0}
              role="img"
              aria-label={`${fmt.stamp(point.run.startedAt)}: ${point.filed} ticketed, ${point.held} held, ${point.tracked} already tracked, run ${point.run.status}`}
              className="mini-chart-mark"
              onPointerEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onPointerLeave={() => setActive(null)}
              onBlur={() => setActive(null)}
            >
              {/* Hit target spans the whole band, not just the painted column. */}
              <rect x={index * band} y={0} width={band} height={height} fill="transparent" />
              {point.filed > 0 ? (
                <path d={columnPath(x, filedY, barW, filedH, 4)} fill="var(--status-success)" />
              ) : null}
              {point.held > 0 ? (
                <path
                  d={columnPath(x, heldY, barW, heldH, point.filed > 0 ? 0 : 4)}
                  fill="var(--status-warning)"
                />
              ) : null}
              {point.tracked > 0 ? (
                <path
                  d={columnPath(
                    x,
                    trackedY,
                    barW,
                    trackedH,
                    point.filed > 0 || point.held > 0 ? 0 : 4,
                  )}
                  fill="var(--action)"
                  opacity={0.72}
                />
              ) : null}
              {index === peakIndex && point.total > 0 ? (
                <text x={x + barW / 2} y={filedY - 4} textAnchor="middle" className="mini-chart-label">
                  {point.total}
                </text>
              ) : null}
              {/* Outcome rail: a run that failed before filing anything has no
                  column, and would otherwise vanish from the chart entirely. */}
              <rect
                x={x}
                y={railY}
                width={barW}
                height={3}
                rx={1.5}
                fill={statusColor(point.run.status)}
                opacity={point.run.status === "success" ? 0.5 : 1}
              />
            </g>
          );
        })}
      </svg>
      <div className="flex items-center gap-3 text-[0.7812rem] text-muted-foreground [&>span]:inline-flex [&>span]:items-center [&>span]:gap-[5px]">
        <span>
          <span className="size-2 rounded-sm" style={{ background: "var(--status-success)" }} />
          Ticketed
        </span>
        <span>
          <span className="size-2 rounded-sm" style={{ background: "var(--status-warning)" }} />
          {mode === "datadog" ? "Held / skipped" : "Left alone"}
        </span>
        {mode === "datadog" ? (
          <span>
            <span className="size-2 rounded-sm" style={{ background: "var(--action)" }} />
            Already tracked
          </span>
        ) : null}
      </div>
      <div className="flex justify-between gap-2 text-xs text-[var(--text-faint)] tabular-nums">
        <span>{fmt.date(shown[0]!.startedAt)}</span>
        <span>{fmt.date(shown[shown.length - 1]!.startedAt)}</span>
      </div>
    </div>
  );
}

/** Production log volume and the number of grouped root causes found in it. */
function ProductionVolume({ runs }: { runs: TaskRunView[] }) {
  const fmt = useFormat();
  const [active, setActive] = useState<number | null>(null);
  const [ref, width] = useChartWidth();
  const shown = recent(runs).filter(
    (run) => detailCount(run.details, "totalEvents") != null,
  );
  const points = shown.map((run) => ({
    run,
    events: detailCount(run.details, "totalEvents") ?? 0,
    problems: detailCount(run.details, "problemsFound") ?? 0,
  }));
  const peak = Math.max(1, ...points.map((point) => point.events));
  const plotH = 86;
  const band = width / points.length;
  const barW = Math.min(24, Math.max(4, band - 8));
  const activePoint = active != null ? points[active] : undefined;

  return (
    <div className="relative" ref={ref}>
      {activePoint ? (
        <ChartTip
          index={active!}
          count={points.length}
          title={fmt.stamp(activePoint.run.startedAt)}
          rows={[
            {
              label: "Error logs",
              value: fmt.number(activePoint.events),
              color: "var(--status-danger)",
            },
            { label: "Problems", value: fmt.number(activePoint.problems) },
          ]}
        />
      ) : null}
      <svg
        width={width}
        height={plotH + 2}
        viewBox={`0 0 ${width} ${plotH + 2}`}
        className="block h-auto w-full overflow-visible"
        role="img"
        aria-label={`Production error-log volume over the last ${points.length} runs`}
      >
        <line x1={0} x2={width} y1={plotH} y2={plotH} stroke="var(--border)" strokeWidth={1} />
        {points.map((point, index) => {
          const height = Math.max(point.events > 0 ? 2 : 0, (point.events / peak) * (plotH - 10));
          const x = index * band + (band - barW) / 2;
          const y = plotH - height;
          return (
            <g
              key={point.run.executionId}
              tabIndex={0}
              role="img"
              aria-label={`${fmt.stamp(point.run.startedAt)}: ${fmt.number(point.events)} production error logs, ${fmt.number(point.problems)} problems`}
              className="mini-chart-mark"
              onPointerEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onPointerLeave={() => setActive(null)}
              onBlur={() => setActive(null)}
            >
              <rect x={index * band} y={0} width={band} height={plotH + 2} fill="transparent" />
              <path
                d={columnPath(x, y, barW, height, 4)}
                fill="var(--status-danger)"
                opacity={0.68}
              />
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between gap-2 text-xs text-[var(--text-faint)] tabular-nums">
        <span>{fmt.date(shown[0]!.startedAt)}</span>
        <span>{fmt.date(shown[shown.length - 1]!.startedAt)}</span>
      </div>
    </div>
  );
}

/** Duration over the same window, so a loop that is slowing down shows it. */
function DurationTrend({
  runs,
  avgMs,
}: {
  runs: TaskRunView[];
  avgMs: number | null;
}) {
  const fmt = useFormat();
  const [active, setActive] = useState<number | null>(null);
  const [ref, width] = useChartWidth();
  const shown = recent(runs).filter((run) => run.durationMs != null);

  const values = shown.map((run) => run.durationMs!);
  const peak = Math.max(...values);
  const plotH = 88;
  // 7px of inset each side so the 4px end dot and its ring are not clipped.
  const step = (width - 14) / (shown.length - 1);
  const x = (index: number) => 7 + index * step;
  const y = (ms: number) => plotH - 6 - (peak > 0 ? (ms / peak) * (plotH - 20) : 0);

  const line = values.map((ms, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(ms)}`).join(" ");
  const area = `${line} L${x(values.length - 1)},${plotH} L${x(0)},${plotH} Z`;
  const last = values[values.length - 1]!;
  const hovered = active != null ? shown[active] : undefined;

  return (
    <div className="relative" ref={ref}>
      {hovered ? (
        <ChartTip
          index={active!}
          count={shown.length}
          title={fmt.stamp(hovered.startedAt)}
          rows={[
            { label: "Duration", value: fmt.duration(hovered.durationMs), color: "var(--action)" },
            { label: "Run", value: hovered.status },
          ]}
        />
      ) : null}
      <svg
        width={width}
        height={plotH + 2}
        viewBox={`0 0 ${width} ${plotH + 2}`}
        className="block h-auto w-full overflow-visible"
        role="img"
        aria-label="Run duration over recent runs"
      >
        {/* Average as a reference hairline — the value is spelled out below. */}
        {avgMs != null ? (
          <line
            x1={0}
            x2={width}
            y1={y(avgMs)}
            y2={y(avgMs)}
            stroke="var(--border-strong)"
            strokeWidth={1}
          />
        ) : null}
        <path d={area} fill="var(--action)" opacity={0.09} />
        <path
          d={line}
          fill="none"
          stroke="var(--action)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {active != null ? (
          <>
            <line
              x1={x(active)}
              x2={x(active)}
              y1={0}
              y2={plotH}
              stroke="var(--border-strong)"
              strokeWidth={1}
            />
            <circle
              cx={x(active)}
              cy={y(values[active]!)}
              r={4}
              fill="var(--action)"
              stroke="var(--bg-raised)"
              strokeWidth={2}
            />
          </>
        ) : null}
        <circle
          cx={x(values.length - 1)}
          cy={y(last)}
          r={4}
          fill="var(--action)"
          stroke="var(--bg-raised)"
          strokeWidth={2}
        />
        {/* Crosshair band per point, drawn last so it takes the pointer. Not a
            tab stop: every duration is also a column in the run table below, and
            a dozen extra stops per chart would swamp the detail pane. */}
        {shown.map((run, index) => (
          <rect
            key={run.executionId}
            x={index * (width / shown.length)}
            y={0}
            width={width / shown.length}
            height={plotH + 2}
            fill="transparent"
            className="mini-chart-mark"
            onPointerEnter={() => setActive(index)}
            onPointerLeave={() => setActive(null)}
          />
        ))}
      </svg>
      <div className="flex justify-between gap-2 text-xs text-[var(--text-faint)] tabular-nums">
        <span>{avgMs != null ? `Average ${fmt.duration(avgMs)}` : ""}</span>
        <span>Last {fmt.duration(last)}</span>
      </div>
    </div>
  );
}

/**
 * All-time success rate as a ring. A percentage is a single number, so the ring
 * frames the figure rather than being the chart — the counts below carry the
 * value for anyone who cannot read the arc.
 */
function SuccessRing({
  successes,
  failures,
  total,
}: {
  successes: number;
  failures: number;
  total: number;
}) {
  const percent = total > 0 ? Math.round((successes / total) * 100) : 0;
  const radius = 40;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className="relative flex items-center justify-center">
      <svg
        viewBox="0 0 100 100"
        className="h-auto w-full max-w-29"
        role="img"
        aria-label={`${percent}% of runs succeeded: ${successes} succeeded, ${failures} failed`}
      >
        <circle cx={50} cy={50} r={radius} fill="none" stroke="var(--border)" strokeWidth={9} />
        <circle
          cx={50}
          cy={50}
          r={radius}
          fill="none"
          stroke="var(--status-success)"
          strokeWidth={9}
          strokeLinecap="round"
          strokeDasharray={`${(percent / 100) * circumference} ${circumference}`}
          transform="rotate(-90 50 50)"
        />
        <text x={50} y={50} textAnchor="middle" dominantBaseline="central" className="ring-value">
          {percent}%
        </text>
      </svg>
    </div>
  );
}

/** Severity by how often the same failure keeps coming back. */
function recurrenceColor(seen: number): string {
  if (seen >= 5) return "var(--status-danger)";
  if (seen >= 3) return "var(--status-warning)";
  return "var(--status-success)";
}

/**
 * The open tickets that keep being re-seen. On this loop a high count means one
 * failure is recurring run after run — the thing worth looking at first, and
 * invisible in a flat "12 open" count.
 */
function Recurrence({ issues }: { issues: FiledIssueView[] }) {
  const fmt = useFormat();
  const top = [...issues].sort((a, b) => b.seenCount - a.seenCount).slice(0, 5);
  const peak = Math.max(1, ...top.map((issue) => issue.seenCount));

  return (
    <div className="flex flex-col gap-[7px]">
      {top.map((issue) => {
        const color = recurrenceColor(issue.seenCount);
        return (
          <Tip
            key={issue.issueKey}
            label={`${issue.subject} · filed ${fmt.stamp(issue.filedAt)}`}
          >
            <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
              <span className="font-mono text-xs text-[var(--text-dim)] [&_a]:text-inherit [&_a]:no-underline [&_a:hover]:text-foreground [&_a:hover]:underline">
                {issue.issueUrl ? (
                  <a href={issue.issueUrl} target="_blank" rel="noreferrer">
                    {issue.issueKey}
                  </a>
                ) : (
                  issue.issueKey
                )}
              </span>
              <span
                className="h-1.5 overflow-hidden rounded-[3px]"
                style={{ background: `color-mix(in srgb, ${color} 20%, transparent)` }}
              >
                <span
                  className="block h-full min-w-1 rounded-[3px]"
                  style={{ width: `${(issue.seenCount / peak) * 100}%`, background: color }}
                />
              </span>
              <span className="text-[0.7812rem] text-muted-foreground tabular-nums">
                {issue.seenCount}×
              </span>
            </div>
          </Tip>
        );
      })}
    </div>
  );
}

/**
 * The chart row that stands in for the plain stat tiles on loops with enough
 * history to plot. Each card drops out on its own when its data is too thin, and
 * the row disappears entirely when nothing is left — a two-run loop should not
 * be shown a trend.
 */
export function LoopCharts({
  runs,
  issues,
  stats,
  mode = "ci",
}: {
  runs: TaskRunView[];
  issues: FiledIssueView[];
  stats: { total: number; successes: number; failures: number; avgDurationMs: number | null };
  mode?: ChartMode;
}) {
  const fmt = useFormat();
  // A run still in flight has no duration and no final counts; it would read as
  // a zero-height column beside real ones.
  const finished = runs.filter((run) => run.status !== "running");
  const window = recent(finished);
  const cards: ReactNode[] = [];

  if (window.length >= 2) {
    const filed = window.reduce(
      (sum, run) =>
        sum +
        (mode === "datadog"
          ? detailCount(run.details, "filed") ?? 0
          : run.itemsProcessed ?? 0),
      0,
    );
    cards.push(
      <ChartCard
        key="tickets"
        title={`${mode === "datadog" ? "Production regressions" : "Failures ticketed"} · last ${window.length} runs`}
        value={String(filed)}
        className="lg:col-span-2"
      >
        <TicketsPerRun runs={finished} mode={mode} />
      </ChartCard>,
    );
  }

  if (
    mode === "datadog" &&
    window.filter((run) => detailCount(run.details, "totalEvents") != null).length >= 2
  ) {
    const latest = [...window]
      .reverse()
      .find((run) => detailCount(run.details, "totalEvents") != null);
    cards.push(
      <ChartCard
        key="production-volume"
        title="Production error logs"
        value={
          latest ? fmt.number(detailCount(latest.details, "totalEvents") ?? 0) : undefined
        }
        hint="Grouped into root-cause problems before ticketing"
        className="lg:col-span-2"
      >
        <ProductionVolume runs={finished} />
      </ChartCard>,
    );
  }

  if (stats.total > 0) {
    cards.push(
      <ChartCard key="rate" title="Success rate" hint={`${stats.successes} of ${stats.total} runs succeeded`}>
        <SuccessRing successes={stats.successes} failures={stats.failures} total={stats.total} />
      </ChartCard>,
    );
  }

  if (window.filter((run) => run.durationMs != null).length >= 2) {
    cards.push(
      <ChartCard
        key="duration"
        title="Run duration"
        value={stats.avgDurationMs != null ? fmt.duration(stats.avgDurationMs) : undefined}
        className="lg:col-span-2"
      >
        <DurationTrend runs={finished} avgMs={stats.avgDurationMs} />
      </ChartCard>,
    );
  }

  if (issues.length > 0) {
    cards.push(
      <ChartCard
        key="recurrence"
        title="Recurring open tickets"
        value={String(issues.length)}
        hint="Times each ticket has been seen again"
      >
        <Recurrence issues={issues} />
      </ChartCard>,
    );
  }

  if (cards.length === 0) return null;
  return <div className="grid gap-3 lg:grid-cols-3">{cards}</div>;
}
