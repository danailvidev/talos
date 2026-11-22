import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";

import type { QueryResult, Widget } from "../../../shared/dashboard.ts";
import { api } from "../api.ts";
import { keys } from "../query-keys.ts";
import { useQuery } from "@tanstack/react-query";
import { providerForDataset } from "./access.ts";
import { useMissingProviderAccess } from "../ProviderAccessNotice.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { cn } from "../lib/utils.ts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "../components/ui/chart.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.tsx";

/** The same series colors Automation uses for its shadcn charts. */
const SERIES_COLORS = [
  "var(--action)",
  "var(--status-success)",
  "var(--status-warning)",
  "var(--live)",
  "var(--status-danger)",
  "var(--text-muted)",
] as const;

export function WidgetView({
  widget,
  refreshToken,
  editing = false,
}: {
  widget: Widget;
  refreshToken: number;
  /** Leaves room for the move and remove icons over the title. */
  editing?: boolean;
}) {
  const provider = providerForDataset(widget.query.dataset);
  const access = useMissingProviderAccess(provider ? [provider] : []);
  const blocked = provider ? access.missing.find((item) => item.id === provider) : undefined;
  // Hold the request until we know a token is stored. Asking early turns a
  // setup step into a red "missing secret" error in every GitLab and Jira card.
  const waitingOnAccess = provider != null && !access.ready;

  const query = useQuery({
    queryKey: keys.dashboardQuery(widget.query, refreshToken),
    queryFn: ({ signal }) =>
      api.dashboardQuery(widget.query, { signal, bypassCache: refreshToken > 0 }),
    enabled: !waitingOnAccess && !blocked,
    retry: (failureCount, error) =>
      failureCount < 1 && error instanceof Error && error.message === "Request cancelled.",
  });

  return (
    <Card className="h-full gap-2 py-3">
      <CardHeader className={cn("px-3", editing && "pr-16")}>
        <CardTitle className="truncate text-sm">{widget.title}</CardTitle>
        {timeframeLabel(widget) ? (
          <CardDescription>{timeframeLabel(widget)}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col px-3">
        {blocked ? (
          <p className="text-sm text-muted-foreground">Needs your {blocked.name} access.</p>
        ) : waitingOnAccess || query.isPending || (query.isFetching && query.error?.message === "Request cancelled.") ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : query.error ? (
          <p className="text-sm text-destructive">{query.error.message}</p>
        ) : query.data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No data in this range.</p>
        ) : widget.view.type === "kpi" ? (
          <Kpi widget={widget} result={query.data} />
        ) : widget.view.type === "table" ? (
          <ResultTable result={query.data} format={widget.view.format} />
        ) : (
          <div className="min-h-0 flex-1">
            <WidgetChart widget={widget} result={query.data} />
          </div>
        )}
        {!blocked && query.data?.truncated ? (
          <p className="mt-1 text-xs text-muted-foreground">Showing a capped result.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function timeframeLabel(widget: Widget): string | undefined {
  const preset = widget.query.timeRange?.preset;
  if (preset === "7d") return "Last 7 days";
  if (preset === "30d") return "Last 30 days";
  if (preset === "90d") return "Last 90 days";
  if (preset === "365d") return "Last 12 months";
  if (widget.query.timeRange?.from || widget.query.timeRange?.to) return "Custom range";
  return undefined;
}

function isLinkColumn(key: string): boolean {
  return key === "webUrl" || key === "url";
}

function linkFor(result: QueryResult, row: unknown[]): string | undefined {
  const index = result.columns.findIndex((column) => column.key === "webUrl" || column.key === "url");
  const value = index >= 0 ? row[index] : undefined;
  return typeof value === "string" && /^https?:\/\//.test(value) ? value : undefined;
}

function TableValue({
  columnKey,
  type,
  value,
  link,
  format,
}: {
  columnKey: string;
  type?: "string" | "number" | "date";
  value: unknown;
  link?: string;
  format?: Widget["view"]["format"];
}) {
  const text = type === "number" ? formatValue(value, format) : String(value ?? "");
  const href = typeof value === "string" && /^https?:\/\//.test(value)
    ? value
    : columnKey === "title" || columnKey === "key" ? link : undefined;
  if (!href) return text;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-action underline-offset-2 hover:underline">
      {columnKey === "webUrl" || columnKey === "url" ? "Open" : text}
    </a>
  );
}

function Kpi({ widget, result }: { widget: Widget; result: QueryResult }) {
  const key = widget.view.y?.[0];
  const index = key
    ? result.columns.findIndex((column) => column.key === key)
    : result.columns.findIndex((column) => column.type === "number");
  const value = index >= 0 ? result.rows[0]?.[index] : result.rows[0]?.[0];
  return (
    <p className="text-3xl font-semibold tracking-tight text-foreground">
      {formatValue(value, widget.view.format)}
    </p>
  );
}

function ResultTable({
  result,
  format,
}: {
  result: QueryResult;
  format?: Widget["view"]["format"];
}) {
  return (
    <div className="max-h-full overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {result.columns.map((column) =>
              isLinkColumn(column.key) ? null : (
                <TableHead key={column.key}>{column.label}</TableHead>
              ),
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.rows.map((row, index) => (
            <TableRow key={index}>
              {row.map((value, cell) => {
                const column = result.columns[cell];
                if (column && isLinkColumn(column.key)) return null;
                return (
                  <TableCell key={column?.key ?? cell}>
                    <TableValue
                      columnKey={column?.key ?? ""}
                      type={column?.type}
                      value={value}
                      link={linkFor(result, row)}
                      format={format}
                    />
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function WidgetChart({ widget, result }: { widget: Widget; result: QueryResult }) {
  const chart = toChart(widget, result);
  if (chart.kind === "heatmap") {
    return <Heatmap chart={chart} format={widget.view.format} />;
  }

  return (
    <ChartContainer
      config={chart.config}
      className="aspect-auto h-full min-h-40 w-full"
      role="img"
      aria-label={widget.title}
    >
      {chart.kind === "pie" ? (
        <PieChart accessibilityLayer>
          <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="slice" />} />
          <Pie
            data={chart.slices}
            dataKey="value"
            nameKey="slice"
            innerRadius="52%"
            outerRadius="78%"
            paddingAngle={2}
          />
        </PieChart>
      ) : (
        <CartesianChart chart={chart} format={widget.view.format} stacked={widget.view.stacked} />
      )}
    </ChartContainer>
  );
}

function CartesianChart({
  chart,
  format,
  stacked,
}: {
  chart: Extract<ChartModel, { kind: "bar" | "line" | "area" }>;
  format?: Widget["view"]["format"];
  stacked?: boolean;
}) {
  const axes = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis
        dataKey="label"
        tickLine={false}
        axisLine={false}
        minTickGap={24}
        tickFormatter={shortLabel}
      />
      <YAxis
        tickLine={false}
        axisLine={false}
        width={44}
        allowDecimals={chart.kind !== "bar"}
        tickFormatter={(value) => formatValue(value, format)}
      />
      <ChartTooltip content={<ChartTooltipContent />} />
      {chart.series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
    </>
  );

  if (chart.kind === "line") {
    return (
      <LineChart data={chart.rows} accessibilityLayer>
        {axes}
        {chart.series.map((series) => (
          <Line
            key={series.key}
            dataKey={series.key}
            type="monotone"
            stroke={`var(--color-${series.key})`}
            strokeWidth={2}
            dot={chart.rows.length <= 14}
            connectNulls
          />
        ))}
      </LineChart>
    );
  }
  if (chart.kind === "area") {
    return (
      <AreaChart data={chart.rows} accessibilityLayer>
        {axes}
        {chart.series.map((series) => (
          <Area
            key={series.key}
            dataKey={series.key}
            type="monotone"
            stroke={`var(--color-${series.key})`}
            fill={`var(--color-${series.key})`}
            fillOpacity={0.18}
            strokeWidth={2}
            stackId={stacked ? "stack" : undefined}
          />
        ))}
      </AreaChart>
    );
  }
  return (
    <BarChart data={chart.rows} accessibilityLayer>
      {axes}
      {chart.series.map((series, index) => (
        <Bar
          key={series.key}
          dataKey={series.key}
          fill={`var(--color-${series.key})`}
          stackId={stacked ? "stack" : undefined}
          radius={index === chart.series.length - 1 ? [3, 3, 0, 0] : undefined}
        />
      ))}
    </BarChart>
  );
}

function Heatmap({
  chart,
  format,
}: {
  chart: Extract<ChartModel, { kind: "heatmap" }>;
  format?: Widget["view"]["format"];
}) {
  const max = Math.max(...chart.cells.map((cell) => cell.value), 1);
  return (
    <div className="h-full overflow-auto">
      <table className="w-max min-w-full border-separate border-spacing-1">
        <thead>
          <tr>
            <th className="sticky left-0 bg-card pr-2 text-left text-xs font-medium text-muted-foreground" />
            {chart.xLabels.map((label) => (
              <th key={label} className="px-1 text-center text-[10px] font-normal text-muted-foreground">
                {shortLabel(label)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {chart.yLabels.map((yLabel) => (
            <tr key={yLabel}>
              <th className="sticky left-0 bg-card pr-2 text-left text-xs font-medium text-muted-foreground">
                {shortLabel(yLabel)}
              </th>
              {chart.xLabels.map((xLabel) => {
                const value = chart.cells.find((cell) => cell.x === xLabel && cell.y === yLabel)?.value ?? 0;
                const amount = Math.round((value / max) * 72);
                return (
                  <td key={xLabel} className="p-0 text-center">
                    <div
                      className="mx-auto size-7 rounded-sm border border-border"
                      style={{
                        backgroundColor: `color-mix(in srgb, var(--action) ${amount}%, transparent)`,
                      }}
                      title={`${xLabel} · ${yLabel}: ${formatValue(value, format)}`}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface Series {
  key: string;
  label: string;
}

interface ChartRow {
  label: string;
  [series: string]: string | number;
}

type ChartModel =
  | { kind: "bar" | "line" | "area"; config: ChartConfig; rows: ChartRow[]; series: Series[] }
  | { kind: "pie"; config: ChartConfig; slices: Array<{ slice: string; value: number; fill: string }> }
  | { kind: "heatmap"; xLabels: string[]; yLabels: string[]; cells: Array<{ x: string; y: string; value: number }> };

function toChart(widget: Widget, result: QueryResult): ChartModel {
  const records = result.rows.map((row) =>
    Object.fromEntries(result.columns.map((column, index) => [column.key, row[index]])),
  );
  const xKey = widget.view.x ?? result.columns[0]?.key ?? "";
  const yKeys = widget.view.y?.length
    ? widget.view.y
    : result.columns.filter((column) => column.type === "number").map((column) => column.key);
  const valueKey = yKeys[0] ?? "";

  if (widget.view.type === "heatmap") {
    const yKey = widget.view.series ?? result.columns.find((column) => column.key !== xKey && column.type !== "number")?.key ?? "";
    const cells = records.map((row) => ({
      x: String(row[xKey] ?? ""),
      y: String(row[yKey] ?? ""),
      value: numberValue(row[valueKey]),
    }));
    return {
      kind: "heatmap",
      xLabels: unique(cells.map((cell) => cell.x)),
      yLabels: unique(cells.map((cell) => cell.y)),
      cells,
    };
  }

  if (widget.view.type === "pie") {
    const slices = records.map((row, index) => {
      const label = String(row[xKey] ?? "Value");
      const key = seriesId(label, index);
      return { slice: key, label, value: numberValue(row[valueKey]) };
    });
    return {
      kind: "pie",
      config: Object.fromEntries(slices.map((slice, index) => [
        slice.slice,
        { label: slice.label, color: SERIES_COLORS[index % SERIES_COLORS.length] },
      ])),
      slices: slices.map((slice) => ({
        slice: slice.slice,
        value: slice.value,
        fill: `var(--color-${slice.slice})`,
      })),
    };
  }

  const seriesLabels = widget.view.series
    ? unique(records.map((row) => String(row[widget.view.series!] ?? "")))
    : yKeys;
  const series = seriesLabels.map((label, index) => ({
    key: seriesId(columnLabel(result, label), index),
    label: columnLabel(result, label),
    source: label,
  }));
  const categories = unique(records.map((row) => String(row[xKey] ?? "")));
  const rows = categories.map((label) => {
    const row: ChartRow = { label };
    for (const item of series) {
      const match = widget.view.series
        ? records.find((candidate) => String(candidate[xKey] ?? "") === label && String(candidate[widget.view.series!] ?? "") === item.source)
        : records.find((candidate) => String(candidate[xKey] ?? "") === label);
      row[item.key] = match ? numberValue(match[widget.view.series ? valueKey : item.source]) : 0;
    }
    return row;
  });

  return {
    kind: widget.view.type === "line" || widget.view.type === "area" ? widget.view.type : "bar",
    config: Object.fromEntries(series.map((item, index) => [
      item.key,
      { label: item.label, color: SERIES_COLORS[index % SERIES_COLORS.length] },
    ])),
    rows,
    series,
  };
}

function columnLabel(result: QueryResult, key: string): string {
  return result.columns.find((column) => column.key === key)?.label ?? key;
}

function seriesId(label: string, index: number): string {
  const slug = label.replace(/[^A-Za-z0-9_]/g, "").replace(/^(\d)/, "s$1");
  return `${slug || "series"}${index}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shortLabel(value: unknown): string {
  const text = String(value ?? "");
  return text.length > 14 ? `${text.slice(0, 13)}…` : text;
}

export function formatValue(value: unknown, format?: Widget["view"]["format"]): string {
  if (value == null || value === "") return "—";
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return String(value);
  if (format === "percent") {
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(parsed)}%`;
  }
  if (format === "duration") {
    if (parsed < 1000) return `${Math.round(parsed)} ms`;
    if (parsed < 60_000) return `${(parsed / 1000).toFixed(1)} s`;
    return `${Math.round(parsed / 60_000)} m`;
  }
  if (format === "bytes") {
    if (parsed < 1024) return `${Math.round(parsed)} B`;
    if (parsed < 1024 * 1024) return `${(parsed / 1024).toFixed(1)} KB`;
    return `${(parsed / (1024 * 1024)).toFixed(1)} MB`;
  }
  return new Intl.NumberFormat(undefined, {
    notation: parsed >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(parsed);
}
