# TALOS custom dashboards plan

Status: proposed on October 26, 2026.

## Objective

Let every user build their own dashboards from any data they can access, both TALOS's own records and live data from connected systems. Dashboards must be:

- buildable by developers and by less technical users such as QA engineers;
- creatable and editable by Talos from natural language;
- private to their owner in phase 1;
- loaded when the page opens, with a manual refresh button.

## Scope

### Included

- A dataset registry: named, typed, permission-checked data sources (SQLite and live connectors).
- A server-side query engine (filter, time bucket, group, aggregate).
- A versioned widget/dashboard spec shared by web, server and Talos.
- Dashboards page with a drag-and-resize grid, widget renderer and builder dialog.
- Talos MCP tools to discover datasets, preview queries and create/update/delete dashboards.

### Not included (phase 1)

- Sharing dashboards with other users or teams.
- Auto-refresh or streaming widgets.
- Historical snapshots of live-system state (see open questions).
- Raw SQL or raw ECharts options as the primary authoring format.

## Libraries

| Layer | Library | License | Notes |
|---|---|---|---|
| Chart rendering | Apache ECharts (`echarts`) | Apache 2.0 | Broad chart coverage (line/bar/area, pie, scatter, heatmap, treemap, sankey, funnel, gauge, calendar, boxplot, radar). Canvas renderer handles large series. Import modularly, per chart type, and lazy-load with the route, so the main bundle doesn't grow. |
| Dashboard layout | `react-grid-layout` | MIT | Drag/resize grid; layout is plain JSON stored with the widget. |

Rejected:

- **Recharts** (already used for the agent usage and automation charts): JSX-composed, so not serializable; fewer chart types. Keep it for the existing hand-built charts.
- **Vega-Lite**: strong grammar, but harder for non-technical users, weaker dashboard interactivity and theming.
- **Embedded Superset / Metabase / Grafana**: a second service with its own auth; CASL permissions and per-user connector tokens don't carry over; limited theming. Metabase and Grafana are AGPL, and Metabase's interactive embedding is paid.
- **Highcharts / AG Charts Enterprise / amCharts**: not free.
- **react-querybuilder**: unnecessary while dataset fields are typed; shadcn filter rows are enough.

## Design

### 1. Dataset registry (`src/application/dashboards/datasets/`)

A dataset is a named data source with a fixed field schema:

```ts
interface Dataset {
  id: string;                              // "jira.issues", "gitlab.merge_requests", "talos.task_runs", ...
  label: string;
  requires: AppPermission | null;          // e.g. "tickets:access"
  fields: FieldDef[];                      // { key, label, type: "string"|"number"|"date"|"enum", enumValues? }
  params?: z.ZodType;                      // source-specific pushdown, e.g. { jql }, { projectPath }
  fetch(user: AuthUser, params: unknown, opts: { bypass: boolean; signal: AbortSignal }): Promise<Row[]>;
}
```

Rules:

- **Build on existing application services and `cached()` reads, not raw tables or connector clients.** For example, `cachedPullRequestListing`, `cachedBoardTickets` and Jira `searchIssues` already run with the user's own token and apply repo filters and visibility. Dashboards must not reimplement that logic.
- **Permissions:** both the dataset list and every query are checked against `requires` using the actor's CASL ability (`createAppAbility`). Record-level visibility comes from the underlying services, so users only see what their own token or loop visibility allows.
- **Cache scoping:** live reads stay scoped per user through `CacheScope`, the same as today.
- **Refresh:** the client sends the fresh flag; the route uses `wantsFreshData(request)` and passes the result to `fetch` as `bypass`.
- **Limits:** a cap on rows fetched per source (e.g. 5,000, with bounded pagination), a cap on categories (top N plus "Other"), and a request timeout.

Phase-1 datasets:

| Dataset | Source | Permission |
|---|---|---|
| `jira.issues` (optional user JQL) | live, user's Jira token | `tickets:access` |
| `gitlab.merge_requests` | live, user's GitLab token | `pull-requests:access` |
| `gitlab.pipelines` / jobs | live | `automation:access` |
| `talos.task_runs` | SQLite | `loops:access` + loop visibility |
| `talos.agent_usage` (own usage only) | SQLite | none |
| `talos.automation_results` / flaky specs | SQLite | `automation:access` |
| `talos.datadog_issues` | SQLite | `datadog:access` |
| `talos.logrocket_issues` | SQLite | `logrocket:access` |

### 2. Query engine

`POST /api/dashboards/query`

```ts
DashboardQuery = {
  dataset: string;
  params?: unknown;                        // validated by the dataset's params schema
  filters?: { field: string; op: "eq"|"neq"|"in"|"nin"|"gt"|"gte"|"lt"|"lte"|"contains"|"empty"|"notEmpty"; value?: unknown }[];
  timeRange?: { field: string; preset?: "7d"|"30d"|"90d"|"365d"; from?: string; to?: string };
  groupBy?: { field: string; bucket?: "day"|"week"|"month" }[];   // max 2
  metrics: { fn: "count"|"sum"|"avg"|"min"|"max"|"distinct"; field?: string; as?: string }[];
  sort?: { by: string; dir: "asc"|"desc" };
  limit?: number;
}
// returns { columns: { key, label, type }[], rows: unknown[][], truncated: boolean, fetchedAt }
```

- SQLite datasets may compile the query to SQL. Live datasets push down what they can (JQL, MR state, date ranges) and aggregate the rest in memory.
- Each widget is queried separately, so widgets load progressively and one widget's failure doesn't break the dashboard.
- Field names are validated against the dataset schema; anything unknown is rejected.

### 3. Spec and storage (`shared/dashboard.ts`)

A single zod schema, shared by the web client, the server routes and the Talos tools:

```ts
Dashboard = {
  id: string; ownerUserId: string; name: string; description?: string;
  version: 1;
  widgets: Widget[];
}
Widget = {
  id: string; title: string;
  layout: { x: number; y: number; w: number; h: number };
  query: DashboardQuery;
  view: {
    type: "kpi"|"line"|"area"|"bar"|"pie"|"table"|"heatmap";
    x?: string; y?: string[]; series?: string;
    stacked?: boolean; format?: "number"|"percent"|"duration"|"bytes";
    overrides?: Record<string, unknown>;  // JSON-only ECharts option deep-merge, for developers
  };
}
```

- New `dashboards` table: `id`, `owner_user_id`, `name`, `spec` (JSON), `created_at`, `updated_at`, plus an owner index. Added through `migrations.ts`.
- Only specs are stored, never query results. Sharing later then means "run every query as the viewer" with no data-leak redesign.
- REST: `GET/POST /api/dashboards`, `GET/PUT/DELETE /api/dashboards/:id`, `GET /api/dashboards/datasets`, `POST /api/dashboards/query`. Add these to `web/src/api.ts` and regenerate `assistant-api-catalog.json`.

### 4. Talos tools (`src/api/assistant-mcp.ts`, same pattern as `talos_loop_*`)

- `talos_dashboard_datasets`: datasets and fields the actor can access.
- `talos_dashboard_query`: runs a `DashboardQuery` and returns sample rows, so Talos can check a widget returns real data before saving it.
- `talos_dashboard_list` / `talos_dashboard_get`
- `talos_dashboard_create` / `talos_dashboard_update` / `talos_dashboard_delete`: full-spec writes validated by the shared schema. Descriptions should say: read before update, preserve unrelated widgets, only delete on explicit request.

### 5. UI

- `DashboardsPage`, lazy-loaded in `App.tsx`: dashboard list → dashboard view with a grid, an edit mode (drag/resize/remove) and a refresh button.
- `WidgetRenderer`: turns the spec into an ECharts option. KPI and table widgets use shadcn `card` / `table` instead.
- ECharts theme generated at runtime from CSS variables (`getComputedStyle`) and re-registered when `ThemeContext` changes, so charts follow all CSS themes and light/dark.
- Builder dialog (shadcn `dialog`, `select`, `field`, `popover`): dataset → chart type → x/y/series fields → filters/time range, with a live preview.
- "Ask Talos" button: opens `AssistantDrawer` with the current dashboard as context.
- Per-widget React Query keys; refresh invalidates all widgets with the fresh flag.

## Delivery order

1. Shared spec, migration, dataset registry and query engine with `talos.task_runs`, `talos.agent_usage`, `jira.issues` and `gitlab.merge_requests`.
2. Dashboards page, grid, renderer and builder dialog.
3. Talos dashboard tools.
4. Remaining datasets.
5. Later phases: sharing (run as viewer), snapshots for historical trends, more chart types.

## Open questions

1. **History on live data:** Jira and GitLab return current state. Trends like "open bugs per day over the last 3 months" need daily snapshots stored by a system loop. Questions like "created/resolved per week" work without them. Is phase 1 OK without snapshots?
2. **Live dataset priority:** are Jira issues, GitLab MRs and GitLab pipelines the right first three, or are Datadog, Kubernetes or Slack more important?
3. **Jira ticket number** for the branch and MR.
