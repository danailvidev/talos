import { z } from "zod";

/**
 * The dashboard spec shared by the console, the HTTP API and the Talos tools.
 *
 * Only the spec is stored. A widget's numbers are computed when the page opens,
 * as the viewer, so a later sharing feature does not need a second data model.
 * Live systems are read as they are now: a trend such as "open bugs per day"
 * needs snapshots this version does not keep. "Created per week" works, because
 * that date is on the record itself.
 */

export const FILTER_OPS = [
  "eq",
  "neq",
  "in",
  "nin",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "empty",
  "notEmpty",
] as const;

export const TIME_PRESETS = ["7d", "30d", "90d", "365d"] as const;
export const TIME_BUCKETS = ["day", "week", "month"] as const;
export const METRIC_FNS = ["count", "sum", "avg", "min", "max", "distinct"] as const;
export const VIEW_TYPES = ["kpi", "line", "area", "bar", "pie", "table", "heatmap"] as const;
export const VALUE_FORMATS = ["number", "percent", "duration", "bytes"] as const;

const KeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Use a letter followed by letters, digits or underscores.");

export const DashboardFilterSchema = z.object({
  field: KeySchema,
  op: z.enum(FILTER_OPS),
  value: z.unknown().optional(),
});

export const DashboardQuerySchema = z.object({
  dataset: z.string().min(1).max(80),
  params: z.unknown().optional(),
  filters: z.array(DashboardFilterSchema).max(20).optional(),
  timeRange: z.object({
    field: KeySchema,
    preset: z.enum(TIME_PRESETS).optional(),
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
  }).optional(),
  groupBy: z.array(z.object({
    field: KeySchema,
    bucket: z.enum(TIME_BUCKETS).optional(),
  })).max(2).optional(),
  /** Raw columns for a table. A chart query uses metrics instead. */
  columns: z.array(KeySchema).max(8).optional(),
  metrics: z.array(z.object({
    fn: z.enum(METRIC_FNS),
    field: KeySchema.optional(),
    as: KeySchema.optional(),
  })).max(8).optional(),
  sort: z.object({
    by: KeySchema,
    dir: z.enum(["asc", "desc"]),
  }).optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).superRefine((query, ctx) => {
  if ((query.metrics?.length ?? 0) === 0 && (query.columns?.length ?? 0) === 0) {
    ctx.addIssue({ code: "custom", message: "A query needs a metric or columns.", path: ["metrics"] });
  }
});

export const WidgetLayoutSchema = z.object({
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(200),
  w: z.number().int().min(2).max(12),
  h: z.number().int().min(2).max(16),
});

export const WidgetViewSchema = z.object({
  type: z.enum(VIEW_TYPES),
  x: KeySchema.optional(),
  y: z.array(KeySchema).max(6).optional(),
  series: KeySchema.optional(),
  stacked: z.boolean().optional(),
  format: z.enum(VALUE_FORMATS).optional(),
  /** Plain JSON merged into the ECharts option. For a developer tuning a chart. */
  overrides: z.record(z.string(), z.unknown()).optional(),
});

export const WidgetSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
  layout: WidgetLayoutSchema,
  query: DashboardQuerySchema,
  view: WidgetViewSchema,
});

export const DashboardSpecSchema = z.object({
  version: z.literal(1),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).optional(),
  widgets: z.array(WidgetSchema).max(24),
});

export type DashboardFilter = z.infer<typeof DashboardFilterSchema>;
export type DashboardQuery = z.infer<typeof DashboardQuerySchema>;
export type WidgetLayout = z.infer<typeof WidgetLayoutSchema>;
export type WidgetView = z.infer<typeof WidgetViewSchema>;
export type Widget = z.infer<typeof WidgetSchema>;
export type DashboardSpec = z.infer<typeof DashboardSpecSchema>;

export interface Dashboard extends DashboardSpec {
  id: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface QueryColumn {
  key: string;
  label: string;
  type: "string" | "number" | "date";
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: unknown[][];
  truncated: boolean;
  fetchedAt: string;
}

export interface DatasetField {
  key: string;
  label: string;
  type: "string" | "number" | "date" | "enum";
  enumValues?: string[];
}

export interface DatasetCatalogEntry {
  id: string;
  label: string;
  description: string;
  /** Null when every signed-in user may query it. */
  requires: string | null;
  fields: DatasetField[];
  paramsHint?: string;
}

export const DEFAULT_DASHBOARD_ID = "default";

/** The built-in dashboard. It is not stored until someone saves a copy. */
export const DEFAULT_TALOS_DASHBOARD: DashboardSpec = {
  version: 1,
  name: "TALOS",
  description: "Merge requests, tickets, pipelines, loop runs and your own agent usage.",
  widgets: [
    {
      id: "open-merge-requests",
      title: "Open merge requests",
      layout: { x: 0, y: 0, w: 3, h: 3 },
      query: {
        dataset: "gitlab.merge_requests",
        params: { scope: "mine", states: ["open"] },
        metrics: [{ fn: "count", as: "open" }],
      },
      view: { type: "kpi", y: ["open"], format: "number" },
    },
    {
      id: "my-agent-tokens",
      title: "My agent tokens",
      layout: { x: 3, y: 0, w: 3, h: 3 },
      query: {
        dataset: "talos.agent_usage",
        timeRange: { field: "startedAt", preset: "30d" },
        metrics: [{ fn: "sum", field: "totalTokens", as: "tokens" }],
      },
      view: { type: "kpi", y: ["tokens"], format: "number" },
    },
    {
      id: "my-jira-issues",
      title: "My open Jira issues",
      layout: { x: 6, y: 0, w: 6, h: 11 },
      query: {
        dataset: "jira.issues",
        params: {
          jql: "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
        },
        columns: ["key", "summary", "status", "url"],
        sort: { by: "updated", dir: "desc" },
        limit: 15,
      },
      view: { type: "table" },
    },
    {
      id: "pipelines-by-status",
      title: "Pipelines by status",
      layout: { x: 0, y: 3, w: 6, h: 8 },
      query: {
        dataset: "gitlab.pipelines",
        timeRange: { field: "updatedAt", preset: "30d" },
        groupBy: [{ field: "status" }],
        metrics: [{ fn: "count", as: "pipelines" }],
      },
      view: { type: "pie", x: "status", y: ["pipelines"] },
    },
    {
      id: "runs-by-week",
      title: "Loop runs",
      layout: { x: 0, y: 11, w: 8, h: 7 },
      query: {
        dataset: "talos.task_runs",
        timeRange: { field: "startedAt", preset: "90d" },
        groupBy: [{ field: "startedAt", bucket: "week" }],
        metrics: [{ fn: "count", as: "runs" }],
        sort: { by: "startedAt", dir: "asc" },
      },
      view: { type: "line", x: "startedAt", y: ["runs"] },
    },
    {
      id: "active-merge-requests",
      title: "Active merge requests",
      layout: { x: 0, y: 18, w: 6, h: 8 },
      query: {
        dataset: "gitlab.merge_requests",
        params: { scope: "mine", states: ["open"] },
        columns: ["title", "repository", "webUrl"],
        sort: { by: "updatedAt", dir: "desc" },
        limit: 15,
      },
      view: { type: "table" },
    },
    {
      id: "merge-requests-needing-attention",
      title: "Merge requests needing attention",
      layout: { x: 6, y: 18, w: 6, h: 8 },
      query: {
        dataset: "gitlab.merge_requests",
        params: { attention: "needs-attention" },
        columns: ["title", "reason", "repository", "webUrl"],
        sort: { by: "updatedAt", dir: "desc" },
        limit: 15,
      },
      view: { type: "table" },
    },
    {
      id: "usage-by-day",
      title: "Agent usage",
      layout: { x: 8, y: 11, w: 4, h: 7 },
      query: {
        dataset: "talos.agent_usage",
        timeRange: { field: "startedAt", preset: "30d" },
        groupBy: [{ field: "startedAt", bucket: "day" }],
        metrics: [{ fn: "sum", field: "totalTokens", as: "tokens" }],
        sort: { by: "startedAt", dir: "asc" },
      },
      view: { type: "area", x: "startedAt", y: ["tokens"] },
    },
  ],
};
