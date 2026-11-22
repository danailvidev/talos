import { useEffect, useState } from "react";
import { closestCorners } from "@dnd-kit/core";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  GripVertical,
  LayoutDashboard,
  TestTube2,
} from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  XAxis,
  YAxis,
} from "recharts";

import type {
  AutomationDashboardView,
  AutomationPipelineDetailView,
  AutomationPipelineOutcome,
  AutomationTestCountsView,
} from "./api.ts";
import type {
  AutomationFailureRoute,
  AutomationTab,
} from "./route-state.ts";
import { AutomationFailureTriage } from "./AutomationFailureTriage.tsx";
import { AutomationFailuresInbox } from "./AutomationFailuresInbox.tsx";
import { AutomationSettings } from "./AutomationSettings.tsx";
import { AutomationSyncControl } from "./AutomationSyncControl.tsx";
import {
  AUTOMATION_DASHBOARD_CARD_IDS,
  AUTOMATION_DASHBOARD_CARD_ORDER_PREFERENCE_KEY,
  AUTOMATION_DASHBOARD_HIDDEN_CARDS_PREFERENCE_KEY,
  AUTOMATION_DASHBOARD_PLACEHOLDER_IDS,
  AUTOMATION_FILTERS_PREFERENCE_KEY,
  AUTOMATION_STATUS_OPTIONS,
  type AutomationDashboardCardId,
  mergeAutomationDashboardCardOrder,
  parseAutomationDashboardCardOrder,
  parseAutomationDashboardHiddenCards,
  parseAutomationFilters,
} from "./automation-filters.ts";
import { usePreference } from "./PreferencesContext.tsx";
import { ago } from "./format.ts";
import { useFormat } from "./FormatContext.tsx";
import { queries } from "./queries.ts";
import { useApi } from "./useApi.ts";
import { Button } from "./components/ui/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card.tsx";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "./components/ui/chart.tsx";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.tsx";
import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnHandle,
  KanbanOverlay,
} from "./components/ui/kanban.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table.tsx";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "./components/ui/tabs.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { TitleInfo } from "./TitleInfo.tsx";
import { cn } from "./lib/utils.ts";
import { PAGE_META_CLASS, PAGE_TITLE_CLASS } from "./typography-styles.ts";

const PAGE_CLASS =
  "flex min-h-0 w-full flex-col gap-5 overflow-y-auto px-4 pt-5 pb-8 min-[901px]:px-[34px] min-[901px]:pt-8 min-[901px]:pb-12";
const RECENT_PIPELINES_PAGE_SIZE = 25;

const QUALITY_CHART_CONFIG = {
  passRatePercent: { label: "Pass rate", color: "var(--action)" },
  failed: { label: "Failed", color: "var(--status-danger)" },
  errors: { label: "Errors", color: "var(--status-warning)" },
  skipped: { label: "Skipped", color: "var(--text-muted)" },
} satisfies ChartConfig;

const OUTCOME_CHART_CONFIG = {
  passed: { label: "Passed", color: "var(--status-success)" },
  testFailed: { label: "Test failure", color: "var(--status-danger)" },
  infrastructure: { label: "Infrastructure", color: "var(--status-warning)" },
  report: { label: "Report unavailable", color: "var(--live)" },
  other: { label: "Running / canceled", color: "var(--text-muted)" },
} satisfies ChartConfig;

const SCHEDULE_CHART_COLORS = [
  "var(--action)",
  "var(--status-success)",
  "var(--status-warning)",
  "var(--live)",
  "var(--status-danger)",
  "var(--text-muted)",
] as const;

export function AutomationPage({
  pipelineId,
  tab,
  onSelectPipeline,
  onBack,
  onSetTab,
  failureRoute,
  onFailureRouteChange,
  canManageSettings,
}: {
  pipelineId?: string;
  tab?: AutomationTab;
  onSelectPipeline: (pipelineId: number) => void;
  onBack: () => void;
  onSetTab: (tab: AutomationTab) => void;
  failureRoute?: AutomationFailureRoute;
  onFailureRouteChange: (route: AutomationFailureRoute) => void;
  canManageSettings: boolean;
}) {
  if (pipelineId) {
    const parsed = Number(pipelineId);
    return (
      <AutomationDetail
        pipelineId={parsed}
        valid={/^[1-9]\d*$/.test(pipelineId) && Number.isSafeInteger(parsed)}
        onBack={onBack}
      />
    );
  }
  return (
    <AutomationHome
      tab={tab}
      onSetTab={onSetTab}
      failureRoute={failureRoute}
      onFailureRouteChange={onFailureRouteChange}
      canManageSettings={canManageSettings}
      onSelectPipeline={onSelectPipeline}
    />
  );
}

function AutomationHome({
  tab,
  onSetTab,
  canManageSettings,
  onSelectPipeline,
  failureRoute,
  onFailureRouteChange,
}: {
  tab?: AutomationTab;
  onSetTab: (tab: AutomationTab) => void;
  canManageSettings: boolean;
  onSelectPipeline: (pipelineId: number) => void;
  failureRoute?: AutomationFailureRoute;
  onFailureRouteChange: (route: AutomationFailureRoute) => void;
}) {
  const activeTab =
    tab === "settings" && canManageSettings
      ? "settings"
      : tab === "failures"
        ? "failures"
        : "reports";

  useEffect(() => {
    if (tab === "settings" && !canManageSettings) onSetTab("reports");
  }, [canManageSettings, onSetTab, tab]);

  return (
    <div className={PAGE_CLASS}>
      <Tabs
        value={activeTab}
        onValueChange={(value) => onSetTab(value as AutomationTab)}
      >
        <TabsList variant="line">
          <TabsTrigger value="reports">Reports</TabsTrigger>
          <TabsTrigger value="failures">Failures</TabsTrigger>
          {canManageSettings ? <TabsTrigger value="settings">Settings</TabsTrigger> : null}
        </TabsList>
      </Tabs>
      {activeTab === "reports" ? (
        <AutomationOverview
          onSelectPipeline={onSelectPipeline}
          onOpenFailures={(route) => {
            onFailureRouteChange(route);
            onSetTab("failures");
          }}
          onOpenSettings={
            canManageSettings ? () => onSetTab("settings") : undefined
          }
        />
      ) : activeTab === "failures" ? (
        <AutomationFailuresInbox
          route={failureRoute}
          onRouteChange={onFailureRouteChange}
          onSelectPipeline={onSelectPipeline}
        />
      ) : (
        <AutomationSettings />
      )}
    </div>
  );
}

function AutomationOverview({
  onSelectPipeline,
  onOpenSettings,
  onOpenFailures,
}: {
  onSelectPipeline: (pipelineId: number) => void;
  onOpenSettings?: () => void;
  onOpenFailures: (route: AutomationFailureRoute) => void;
}) {
  const [filters, setFilters] = usePreference(
    AUTOMATION_FILTERS_PREFERENCE_KEY,
    parseAutomationFilters,
  );
  const [hiddenCards, setHiddenCards] = usePreference(
    AUTOMATION_DASHBOARD_HIDDEN_CARDS_PREFERENCE_KEY,
    parseAutomationDashboardHiddenCards,
  );
  const hiddenCardSet = new Set(hiddenCards);
  const [recentOffset, setRecentOffset] = useState(0);
  const { days, scheduleId, status } = filters;
  const dashboard = useApi(
    queries.automationDashboard({
      ...filters,
      limit: RECENT_PIPELINES_PAGE_SIZE,
      offset: recentOffset,
    }),
  );

  useEffect(() => {
    setRecentOffset(0);
  }, [days, scheduleId, status]);

  useEffect(() => {
    const total = dashboard.data?.recentPipelines.total;
    if (total == null || total === 0 || recentOffset < total) return;
    setRecentOffset(
      Math.max(
        0,
        Math.floor((total - 1) / RECENT_PIPELINES_PAGE_SIZE) *
          RECENT_PIPELINES_PAGE_SIZE,
      ),
    );
  }, [dashboard.data?.recentPipelines.total, recentOffset]);

  if (!dashboard.data && dashboard.loading) {
    return <Loading>Loading Automation health…</Loading>;
  }
  if (!dashboard.data && dashboard.error) return <ErrorBox>{dashboard.error}</ErrorBox>;
  if (!dashboard.data) return null;

  const data = dashboard.data;
  return (
    <>
        <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div>
            <div className="flex items-center gap-2">
              <h1 className={PAGE_TITLE_CLASS}>
                Automation
                <TitleInfo>
                  Pipeline and test health across configured GitLab schedules.
                </TitleInfo>
              </h1>
              {dashboard.fetching ? (
                <span className="text-xs text-muted-foreground" role="status">
                  Updating…
                </span>
              ) : null}
            </div>
            <p className={PAGE_META_CLASS}>
              {data.lastSyncedAt ? `Last synced ${ago(data.lastSyncedAt)}.` : "Not synced yet."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onOpenSettings ? (
              <AutomationSyncControl configured={data.configured} compact />
            ) : null}
            <Select
              value={String(days)}
              onValueChange={(value) =>
                setFilters({ ...filters, days: Number(value) as 1 | 7 | 30 })
              }
            >
              <SelectTrigger className="w-32" aria-label="Date range">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Today</SelectItem>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={scheduleId == null ? "all" : String(scheduleId)}
              onValueChange={(value) =>
                setFilters({
                  ...filters,
                  scheduleId: value === "all" ? undefined : Number(value),
                })
              }
            >
              <SelectTrigger className="w-48" aria-label="Schedule">
                <SelectValue placeholder="All schedules" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All schedules</SelectItem>
                {data.schedules.map((schedule) => (
                  <SelectItem key={schedule.scheduleId} value={String(schedule.scheduleId)}>
                    {schedule.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={status ?? "all"}
              onValueChange={(value) =>
                setFilters({
                  ...filters,
                  status: value === "all" ? undefined : value,
                })
              }
            >
              <SelectTrigger className="w-40" aria-label="Pipeline status">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {AUTOMATION_STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {titleCase(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DashboardWidgetMenu
              hidden={hiddenCardSet}
              onChange={(next) => setHiddenCards([...next])}
            />
          </div>
        </header>

        {dashboard.error ? (
          <div className="rounded-[var(--radius)] border border-[var(--status-danger)]/40 bg-[var(--status-danger-wash)] p-3 text-sm text-[var(--status-danger-strong)]" role="alert">
            Update failed: {dashboard.error}. Showing the last available data.
          </div>
        ) : null}

        {!data.configured ? (
          <UnconfiguredState onOpenSettings={onOpenSettings} />
        ) : (
          <>
            {data.schedules.some((schedule) => schedule.stale) ? (
              <div className="flex items-start gap-2 rounded-[var(--radius)] border border-[var(--status-warning)]/40 bg-[var(--status-warning-wash)] p-3 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--status-warning-strong)]" />
                <span>
                  One or more active schedules are overdue past their expected next run.
                </span>
              </div>
            ) : null}

            <KpiGrid data={data} />

            <AutomationDashboardCards
              data={data}
              hidden={hiddenCardSet}
              onSelectPipeline={onSelectPipeline}
            />

            <section>
              <div className="mb-3 flex items-end justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-lg font-semibold">
                    Configured schedules
                    <TitleInfo>
                      Latest outcome and statistics for this range.
                    </TitleInfo>
                  </h2>
                </div>
              </div>
              {data.schedules.length === 0 ? (
                <EmptyPanel>No schedules are selected in Automation settings.</EmptyPanel>
              ) : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {data.schedules.map((schedule) => (
                    <ScheduleCard
                      key={schedule.scheduleId}
                      schedule={schedule}
                      onSelectPipeline={onSelectPipeline}
                    />
                  ))}
                </div>
              )}
            </section>

            <RecentPipelines
              page={data.recentPipelines}
              fetching={dashboard.fetching}
              onSelectPipeline={onSelectPipeline}
              onOpenFailures={onOpenFailures}
              onOffsetChange={setRecentOffset}
            />
          </>
        )}
    </>
  );
}

function UnconfiguredState({ onOpenSettings }: { onOpenSettings?: () => void }) {
  return (
    <Card className="border-dashed py-12">
      <CardContent className="mx-auto flex max-w-xl flex-col items-center text-center">
        <TestTube2 className="mb-4 size-10 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Configure Automation reporting</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Select a GitLab project and its test schedules, then enable report synchronization to
          build this dashboard from local pipeline and JUnit data.
        </p>
        {onOpenSettings ? (
          <Button type="button" className="mt-5" onClick={onOpenSettings}>
            Open Automation settings
          </Button>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            Ask an administrator to configure Automation.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function DashboardWidgetMenu({
  hidden,
  onChange,
}: {
  hidden: ReadonlySet<AutomationDashboardCardId>;
  onChange: (hidden: ReadonlySet<AutomationDashboardCardId>) => void;
}) {
  const shown = AUTOMATION_DASHBOARD_CARD_IDS.length - hidden.size;
  const toggle = (id: AutomationDashboardCardId, visible: boolean) => {
    const next = new Set(hidden);
    if (visible) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <LayoutDashboard className="size-4" />
          {shown === AUTOMATION_DASHBOARD_CARD_IDS.length
            ? "Widgets"
            : `${shown} of ${AUTOMATION_DASHBOARD_CARD_IDS.length} widgets`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Dashboard widgets</DropdownMenuLabel>
        <DropdownMenuItem
          disabled={hidden.size === 0}
          onSelect={() => onChange(new Set())}
        >
          Show all widgets
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {AUTOMATION_DASHBOARD_CARD_IDS.map((id) => (
          <DropdownMenuCheckboxItem
            key={id}
            checked={!hidden.has(id)}
            onCheckedChange={(checked) => toggle(id, checked === true)}
            onSelect={(event) => event.preventDefault()}
          >
            {dashboardCardLabel(id)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function KpiGrid({ data }: { data: AutomationDashboardView }) {
  const rows = dailyChartRows(data);
  const current = rows.at(-1);
  const previous = rows.at(-2);
  const expected = data.scheduleTrends.length;
  const passed = current?.passedSchedules ?? 0;
  const missing = Math.max(0, expected - (current?.runSchedules ?? 0));
  const blocked = current?.blockedSchedules ?? 0;
  const unstable = current?.unstableSchedules ?? 0;
  const ready = expected > 0 && passed === expected;
  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard
        icon={<CheckCircle2 className="size-4" />}
        label="Today's readiness"
        value={`${passed}/${expected}`}
        detail={
          ready
            ? unstable > 0
              ? `${unstable} suite${unstable === 1 ? "" : "s"} passed after a rerun`
              : "All expected suites passed"
            : `${blocked} blocked · ${missing} not run`
        }
      />
      <KpiCard
        icon={<TestTube2 className="size-4" />}
        label="Today's tests"
        value={(current?.total ?? 0).toLocaleString()}
        detail={changeDetail(current?.total, previous?.total, "from previous day")}
      />
      <KpiCard
        icon={<Activity className="size-4" />}
        label="Today's pass rate"
        value={percent(current?.passRate ?? null)}
        detail={`${(current?.failed ?? 0).toLocaleString()} failed · ${(current?.errors ?? 0).toLocaleString()} errors · ${(current?.skipped ?? 0).toLocaleString()} skipped`}
      />
      <KpiCard
        icon={<Clock3 className="size-4" />}
        label="Today's average duration"
        value={formatSeconds(current?.averageDurationSeconds)}
        detail={changeDetail(
          current?.averageDurationSeconds,
          previous?.averageDurationSeconds,
          "from previous day",
          formatSignedSeconds,
        )}
      />
    </section>
  );
}

function KpiCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          {icon}
          {label}
        </CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{detail}</CardContent>
    </Card>
  );
}

interface DashboardCardSlot {
  id: string;
}

function AutomationDashboardCards({
  data,
  hidden,
  onSelectPipeline,
}: {
  data: AutomationDashboardView;
  hidden: ReadonlySet<AutomationDashboardCardId>;
  onSelectPipeline: (pipelineId: number) => void;
}) {
  const [order, setOrder] = usePreference(
    AUTOMATION_DASHBOARD_CARD_ORDER_PREFERENCE_KEY,
    parseAutomationDashboardCardOrder,
  );
  const visibleOrder = order.filter((id) => !hidden.has(id));
  const layoutOrder = [...visibleOrder, ...AUTOMATION_DASHBOARD_PLACEHOLDER_IDS];
  const value = Object.fromEntries(
    layoutOrder.map((id) => [id, [] as DashboardCardSlot[]]),
  );

  if (visibleOrder.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          All dashboard widgets are hidden. Use the Widgets menu above to show the ones you need.
        </CardContent>
      </Card>
    );
  }

  return (
    <Kanban
      className="group/dashboard-layout"
      value={value}
      collisionDetection={closestCorners}
      onValueChange={(next) =>
        setOrder(
          mergeAutomationDashboardCardOrder(
            order,
            Object.keys(next),
            hidden,
          ),
        )
      }
      getItemValue={(item) => item.id}
      accessibility={{
        announcements: {
          onDragStart({ active }) {
            return `Picked up ${dashboardCardLabel(String(active.id))}.`;
          },
          onDragOver({ active, over }) {
            return over
              ? `${dashboardCardLabel(String(active.id))} is over ${dashboardCardLabel(String(over.id))}.`
              : `${dashboardCardLabel(String(active.id))} is no longer over a dashboard card.`;
          },
          onDragEnd({ active, over }) {
            return over
              ? `Moved ${dashboardCardLabel(String(active.id))} before ${dashboardCardLabel(String(over.id))}.`
              : `Dropped ${dashboardCardLabel(String(active.id))}.`;
          },
          onDragCancel({ active }) {
            return `Moving ${dashboardCardLabel(String(active.id))} was cancelled.`;
          },
        },
      }}
    >
      <KanbanBoard className="grid auto-rows-auto grid-flow-row-dense gap-5 sm:grid-cols-1 xl:grid-cols-4">
        {layoutOrder.map((id) =>
          id.startsWith("placeholder-") ? (
            <KanbanColumn
              key={id}
              value={id}
              className="hidden min-h-36 min-w-0 rounded-[var(--radius-panel)] border border-dashed border-border bg-muted/10 opacity-0 transition-[border-color,background-color,transform,opacity] data-[over=true]:scale-[1.02] data-[over=true]:border-action data-[over=true]:bg-action/10 xl:group-data-[dragging=true]/dashboard-layout:flex xl:group-data-[dragging=true]/dashboard-layout:opacity-100"
            >
              <div className="flex h-full min-h-36 items-center justify-center px-3 text-center text-xs text-muted-foreground">
                Drop a 25% card here
              </div>
            </KanbanColumn>
          ) : (
            <KanbanColumn
              key={id}
              value={id}
              className={cn(
                "min-w-0",
                id === "readiness"
                  ? "xl:col-span-4"
                  : (id === "quality" ||
                        id === "duration" ||
                        id === "suite-health") &&
                      "xl:col-span-2",
              )}
            >
              <KanbanColumnHandle
                className="block h-full rounded-[var(--radius-panel)] opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&>[data-slot=card]]:h-full"
                aria-label={`Move ${dashboardCardLabel(id)}`}
              >
                {dashboardCard(
                  id as AutomationDashboardCardId,
                  data,
                  onSelectPipeline,
                )}
              </KanbanColumnHandle>
            </KanbanColumn>
          ),
        )}
      </KanbanBoard>
      <KanbanOverlay>
        {({ value: activeId }) =>
          String(activeId).startsWith("placeholder-") ? null : (
            <Card
              size="sm"
              className="w-72 border-action/60 bg-card/95 shadow-[var(--shadow-panel)]"
            >
              <CardContent className="flex items-center gap-2 py-2 font-medium">
                <GripVertical className="size-4 text-muted-foreground" />
                Moving {dashboardCardLabel(String(activeId))}
              </CardContent>
            </Card>
          )
        }
      </KanbanOverlay>
    </Kanban>
  );
}

function dashboardCard(
  id: AutomationDashboardCardId,
  data: AutomationDashboardView,
  onSelectPipeline: (pipelineId: number) => void,
): React.ReactNode {
  if (id === "readiness") {
    return (
      <ReadinessHeatmap
        data={data}
        onSelectPipeline={onSelectPipeline}
      />
    );
  }
  if (id === "quality") return <QualityTrendCard data={data} />;
  if (id === "duration") return <DurationTrendCard data={data} />;
  if (id === "suite-health") return <SuiteReliabilityCard data={data} />;
  if (id === "outcomes") return <OutcomeDonutCard data={data} />;
  return <AttentionCard data={data} onSelectPipeline={onSelectPipeline} />;
}

function dashboardCardLabel(id: string): string {
  if (id === "readiness") return "Daily release readiness";
  if (id === "quality") return "Daily quality";
  if (id === "duration") return "Execution time";
  if (id === "suite-health") return "Suite reliability profile";
  if (id === "outcomes") return "Daily outcomes";
  if (id === "attention") return "Needs attention";
  if (id.startsWith("placeholder-")) return "empty 25% slot";
  return "dashboard card";
}

function ReadinessHeatmap({
  data,
  onSelectPipeline,
}: {
  data: AutomationDashboardView;
  onSelectPipeline: (pipelineId: number) => void;
}) {
  const dates = data.scheduleTrends[0]?.days.map((day) => day.date) ?? [];
  return (
    <Card className="min-h-[420px] min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarDays className="size-5" />
          Daily release readiness
          <TitleInfo>
            Latest completed run per suite and UTC day. A warning outline means the suite failed
            before passing on a rerun.
          </TitleInfo>
        </CardTitle>
        <CardDescription>
          Every configured schedule should finish green before release.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid min-h-[300px] min-w-0 gap-4">
        {dates.length === 0 || data.scheduleTrends.length === 0 ? (
          <EmptyPanel>No schedule history matches these filters.</EmptyPanel>
        ) : (
          <div className="min-h-[260px] min-w-0 overflow-x-auto rounded-[var(--radius)] border border-border p-2">
            <table className="w-max min-w-full border-separate border-spacing-1">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 min-w-40 bg-card pr-3 text-left text-xs font-medium text-muted-foreground">
                    Suite
                  </th>
                  {dates.map((date) => (
                    <th
                      key={date}
                      className="w-8 min-w-8 text-center text-[10px] font-normal tabular-nums text-muted-foreground"
                      title={date}
                    >
                      {date.slice(5)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.scheduleTrends.map((schedule) => (
                  <tr key={schedule.scheduleId}>
                    <th
                      className="sticky left-0 z-10 max-w-52 bg-card pr-3 text-left text-sm font-medium"
                      title={schedule.displayName}
                    >
                      <span className="block truncate">{schedule.displayName}</span>
                    </th>
                    {schedule.days.map((day) => (
                      <td key={day.date} className="size-8 p-0 text-center">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={day.pipelineId == null}
                          aria-label={readinessCellLabel(schedule.displayName, day)}
                          title={readinessCellLabel(schedule.displayName, day)}
                          onClick={() =>
                            day.pipelineId != null && onSelectPipeline(day.pipelineId)
                          }
                          className={cn(
                            "size-7 rounded-sm border p-0 transition-transform enabled:hover:scale-110 enabled:hover:bg-inherit",
                            readinessCellClass(day.outcome, day.unstable),
                          )}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <HeatmapLegend className="bg-[var(--status-success-wash)] border-[var(--status-success)]/50" label="Passed" />
          <HeatmapLegend className="bg-[var(--status-danger-wash)] border-[var(--status-danger)]/60" label="Test failure" />
          <HeatmapLegend className="bg-[var(--status-warning-wash)] border-[var(--status-warning)]/60" label="CI / report issue" />
          <HeatmapLegend className="bg-muted border-border border-dashed" label="No run" />
        </div>
      </CardContent>
    </Card>
  );
}

function HeatmapLegend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-3 rounded-sm border", className)} />
      {label}
    </span>
  );
}

function OutcomeDonutCard({ data }: { data: AutomationDashboardView }) {
  const counts = dailyOutcomeCounts(data);
  const chartData = [
    { outcome: "passed", value: counts.passed, fill: "var(--color-passed)" },
    { outcome: "testFailed", value: counts.testFailed, fill: "var(--color-testFailed)" },
    {
      outcome: "infrastructure",
      value: counts.infrastructure,
      fill: "var(--color-infrastructure)",
    },
    { outcome: "report", value: counts.report, fill: "var(--color-report)" },
    { outcome: "other", value: counts.other, fill: "var(--color-other)" },
  ];
  const total = chartData.reduce((sum, item) => sum + item.value, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily outcomes</CardTitle>
        <CardDescription>{total.toLocaleString()} representative suite runs</CardDescription>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <EmptyPanel>No completed outcomes match these filters.</EmptyPanel>
        ) : (
          <div className="grid gap-4">
            <ChartContainer
              config={OUTCOME_CHART_CONFIG}
              className="mx-auto h-56 w-full max-w-sm"
              role="img"
              aria-label="Pipeline outcome distribution"
            >
              <PieChart accessibilityLayer>
                <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                <Pie
                  data={chartData}
                  dataKey="value"
                  nameKey="outcome"
                  innerRadius={52}
                  outerRadius={82}
                  paddingAngle={2}
                />
              </PieChart>
            </ChartContainer>
            <div
              className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-muted-foreground"
              aria-label="Pipeline outcome legend"
            >
              {Object.entries(OUTCOME_CHART_CONFIG).map(([key, item]) => (
                <span key={key} className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="size-2 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: item.color }}
                    aria-hidden="true"
                  />
                  <span className="leading-tight">{item.label}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QualityTrendCard({ data }: { data: AutomationDashboardView }) {
  const chartData = dailyChartRows(data);
  const hasResults = chartData.some(
    (day) => day.passed + day.failed + day.errors + day.skipped > 0,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily quality</CardTitle>
        <CardDescription>
          Pass rate against failed, errored, and skipped tests.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!hasResults ? (
          <EmptyPanel>No test results match these filters.</EmptyPanel>
        ) : (
          <ChartContainer
            config={QUALITY_CHART_CONFIG}
            className="h-72 w-full"
            role="img"
            aria-label={`Daily test quality for the last ${data.days} days`}
          >
            <ComposedChart data={chartData} accessibilityLayer>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis
                yAxisId="count"
                tickLine={false}
                axisLine={false}
                width={34}
                allowDecimals={false}
              />
              <YAxis
                yAxisId="rate"
                orientation="right"
                domain={[0, 100]}
                tickLine={false}
                axisLine={false}
                width={42}
                tickFormatter={(value) => `${value}%`}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar
                yAxisId="count"
                dataKey="failed"
                fill="var(--color-failed)"
                stackId="quality"
                radius={[0, 0, 2, 2]}
              />
              <Bar
                yAxisId="count"
                dataKey="errors"
                fill="var(--color-errors)"
                stackId="quality"
              />
              <Bar
                yAxisId="count"
                dataKey="skipped"
                fill="var(--color-skipped)"
                stackId="quality"
                radius={[2, 2, 0, 0]}
              />
              <Line
                yAxisId="rate"
                dataKey="passRatePercent"
                type="monotone"
                stroke="var(--color-passRatePercent)"
                strokeWidth={2.5}
                dot={data.days <= 7}
                connectNulls
              />
            </ComposedChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function DurationTrendCard({ data }: { data: AutomationDashboardView }) {
  const chartData = dailyChartRows(data);
  const config = scheduleChartConfig(data);
  const hasResults = chartData.some((day) =>
    data.scheduleTrends.some(
      (schedule) => day[durationDataKey(schedule.scheduleId)] != null,
    ),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Execution time</CardTitle>
        <CardDescription>Pipeline duration by suite, in minutes.</CardDescription>
      </CardHeader>
      <CardContent>
        {!hasResults ? (
          <EmptyPanel>No duration data matches these filters.</EmptyPanel>
        ) : (
          <ChartContainer
            config={config}
            className="h-72 w-full"
            role="img"
            aria-label={`Suite execution time for the last ${data.days} days`}
          >
            <LineChart data={chartData} accessibilityLayer>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={42}
                tickFormatter={(value) => `${value}m`}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              {data.scheduleTrends.map((schedule) => {
                const key = scheduleDataKey(schedule.scheduleId);
                return (
                  <Line
                    key={key}
                    dataKey={durationDataKey(schedule.scheduleId)}
                    name={key}
                    type="monotone"
                    stroke={`var(--color-${key})`}
                    strokeWidth={2}
                    dot={data.days <= 7}
                    connectNulls
                  />
                );
              })}
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

const SUITE_RELIABILITY_CHART_CONFIG = {
  testPassRate: {
    label: "Test pass rate",
    color: "var(--status-success)",
  },
  pipelineHealth: {
    label: "Pipeline health",
    color: "var(--status-warning)",
  },
} satisfies ChartConfig;

function SuiteReliabilityCard({ data }: { data: AutomationDashboardView }) {
  const chartData = data.schedules.map((schedule) => ({
    suite: compactScheduleLabel(schedule.displayName),
    testPassRate:
      schedule.rangeStats.testPassRate == null
        ? null
        : Math.round(schedule.rangeStats.testPassRate * 1000) / 10,
    pipelineHealth:
      schedule.rangeStats.pipelineSuccessRate == null
        ? null
        : Math.round(schedule.rangeStats.pipelineSuccessRate * 1000) / 10,
  }));
  const hasResults = chartData.some(
    (schedule) =>
      schedule.testPassRate != null || schedule.pipelineHealth != null,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Suite reliability profile</CardTitle>
        <CardDescription>
          Pipeline and test health across the selected period.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!hasResults ? (
          <EmptyPanel>No suite statistics match these filters.</EmptyPanel>
        ) : (
          <ChartContainer
            config={SUITE_RELIABILITY_CHART_CONFIG}
            className="h-80 w-full"
            role="img"
            aria-label="Radar chart comparing pipeline and test health by suite"
          >
            <RadarChart data={chartData} outerRadius="70%" accessibilityLayer>
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <PolarGrid gridType="circle" />
              <PolarAngleAxis
                dataKey="suite"
                tickLine={false}
                tick={{ fontSize: 10 }}
              />
              <PolarRadiusAxis
                angle={90}
                domain={[0, 100]}
                tick={false}
                axisLine={false}
              />
              <Radar
                dataKey="testPassRate"
                fill="var(--color-testPassRate)"
                fillOpacity={0.18}
                stroke="var(--color-testPassRate)"
                strokeWidth={2}
              />
              <Radar
                dataKey="pipelineHealth"
                fill="var(--color-pipelineHealth)"
                fillOpacity={0.14}
                stroke="var(--color-pipelineHealth)"
                strokeWidth={2}
              />
            </RadarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function AttentionCard({
  data,
  onSelectPipeline,
}: {
  data: AutomationDashboardView;
  onSelectPipeline: (pipelineId: number) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Needs attention
          <TitleInfo>Stale schedules and recent unhealthy outcomes.</TitleInfo>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.attentionItems.length === 0 ? (
          <div className="flex min-h-44 flex-col items-center justify-center text-center">
            <CheckCircle2 className="mb-2 size-7 text-success" />
            <p className="font-medium">Nothing needs attention</p>
            <p className="mt-1 text-sm text-muted-foreground">
              All configured schedules are current.
            </p>
          </div>
        ) : (
          <div className="grid max-h-90 gap-2 overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable]">
            {data.attentionItems.map((item, index) => (
              <button
                key={`${item.code}-${item.scheduleId}-${item.pipelineId}-${index}`}
                type="button"
                disabled={item.pipelineId == null}
                onClick={() => item.pipelineId != null && onSelectPipeline(item.pipelineId)}
                className="flex w-full items-start gap-2 rounded-[var(--radius)] border border-border p-3 text-left text-sm transition-colors hover:bg-muted/50 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <AlertTriangle
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    item.severity === "error"
                      ? "text-[var(--status-danger-strong)]"
                      : item.severity === "warning"
                        ? "text-[var(--status-warning-strong)]"
                        : "text-muted-foreground",
                  )}
                />
                <span className="min-w-0 flex-1">{item.message}</span>
                {item.pipelineId != null ? <ArrowUpRight className="size-4 shrink-0" /> : null}
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ScheduleCard({
  schedule,
  onSelectPipeline,
}: {
  schedule: AutomationDashboardView["schedules"][number];
  onSelectPipeline: (pipelineId: number) => void;
}) {
  const latest = schedule.latestPipeline;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="truncate">{schedule.displayName}</CardTitle>
        <CardDescription className="truncate">
          #{schedule.scheduleId} · {schedule.metadata?.ref ?? "Not synchronized"}
        </CardDescription>
        <CardAction>
          {latest ? <OutcomeBadge outcome={latest.outcome} /> : <StatusBadge status="disabled">No data</StatusBadge>}
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-2">
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
          <Metric label="Latest" value={latest ? ago(latest.updatedAt) : "Never"} />
          <Metric
            label="Next run"
            value={
              schedule.metadata?.active
                ? ago(schedule.metadata.nextRunAt)
                : schedule.metadata
                  ? "Inactive"
                  : "Unknown"
            }
          />
          <Metric
            label="Pipeline health"
            value={percent(schedule.rangeStats.pipelineSuccessRate)}
          />
          <Metric label="Test pass rate" value={percent(schedule.rangeStats.testPassRate)} />
        </div>
        <p className="text-[11px] text-muted-foreground">
          {schedule.rangeStats.pipelines.toLocaleString()} pipelines ·{" "}
          {schedule.rangeStats.tests.total.toLocaleString()} tests in range
        </p>
        {schedule.stale ? (
          <p className="flex items-center gap-1.5 text-xs text-[var(--status-warning-strong)]">
            <AlertTriangle className="size-3.5" /> Expected scheduled run is overdue
          </p>
        ) : null}
        {latest ? (
          <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
            <a
              href={latest.webUrl}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 truncate text-xs font-medium text-foreground hover:underline"
            >
              Pipeline #{latest.pipelineId}
            </a>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 px-2"
              onClick={() => onSelectPipeline(latest.pipelineId)}
            >
              Details
              <ArrowUpRight className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RecentPipelines({
  page,
  fetching,
  onSelectPipeline,
  onOpenFailures,
  onOffsetChange,
}: {
  page: AutomationDashboardView["recentPipelines"];
  fetching: boolean;
  onSelectPipeline: (pipelineId: number) => void;
  onOpenFailures: (route: AutomationFailureRoute) => void;
  onOffsetChange: (offset: number) => void;
}) {
  const format = useFormat();
  const start = page.total === 0 ? 0 : page.offset + 1;
  const end = Math.min(page.offset + page.limit, page.total);
  const today = format.date(new Date().toISOString());
  const pipelineGroups = [
    {
      key: "today",
      label: "Today",
      items: page.items.filter((pipeline) => format.date(pipeline.updatedAt) === today),
    },
    {
      key: "earlier",
      label: "Earlier",
      items: page.items.filter((pipeline) => format.date(pipeline.updatedAt) !== today),
    },
  ].filter((group) => group.items.length > 0);

  return (
    <Card className="shrink-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Recent pipelines
          <TitleInfo>Most recently updated pipelines matching the filters.</TitleInfo>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {page.items.length === 0 ? (
          <EmptyPanel>No pipelines match this range and filter combination.</EmptyPanel>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pipeline</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="text-right">Pass rate</TableHead>
                <TableHead className="text-right">Tests</TableHead>
                <TableHead className="text-right">Duration</TableHead>
              </TableRow>
            </TableHeader>
            {pipelineGroups.map((group) => (
              <TableBody key={group.key}>
                <TableRow
                  className={cn(
                    "hover:bg-muted/40",
                    group.key === "today" ? "bg-primary/5" : "bg-muted/40",
                  )}
                >
                  <TableHead
                    colSpan={7}
                    scope="rowgroup"
                    className={cn(
                      "h-8 py-1.5 text-xs font-semibold tracking-wide uppercase",
                      group.key === "today" ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    <span>{group.label}</span>
                    <span className="ml-2 font-normal tracking-normal normal-case text-muted-foreground">
                      {group.items.length.toLocaleString()}{" "}
                      {group.items.length === 1 ? "pipeline" : "pipelines"}
                    </span>
                  </TableHead>
                </TableRow>
                {group.items.map((pipeline) => (
                <TableRow
                  key={pipeline.pipelineId}
                  role="link"
                  tabIndex={0}
                  aria-label={`View pipeline ${pipeline.pipelineId} details`}
                  className="cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                  onClick={() => onSelectPipeline(pipeline.pipelineId)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onSelectPipeline(pipeline.pipelineId);
                  }}
                >
                  <TableCell>
                    <p className="font-medium text-foreground">
                      #{pipeline.pipelineId}
                    </p>
                    <p className="mt-0.5 max-w-44 truncate font-mono text-[11px] text-muted-foreground">
                      {pipeline.ref} · {pipeline.sha.slice(0, 8)}
                    </p>
                  </TableCell>
                  <TableCell className="max-w-56">
                    <div
                      className="max-w-56 truncate"
                      title={pipeline.scheduleName}
                    >
                      {pipeline.scheduleName}
                    </div>
                  </TableCell>
                  <TableCell title={format.stamp(pipeline.updatedAt)}>
                    {ago(pipeline.updatedAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-40 flex-wrap gap-1.5">
                      <OutcomeBadge outcome={pipeline.outcome} />
                      <PipelineStatusBadge status={pipeline.status} />
                      {pipeline.outcome === "test-failed" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-xs"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenFailures({
                              days: 30,
                              scheduleId: pipeline.scheduleId,
                              pipelineId: pipeline.pipelineId,
                              presence: "recent",
                            });
                          }}
                        >
                          Failures
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <PipelinePassRate tests={pipeline.tests} />
                  </TableCell>
                  <TableCell className="min-w-52 text-right tabular-nums">
                    {pipeline.tests ? (
                      <>
                        <p className="font-medium text-foreground">
                          {pipeline.tests.total.toLocaleString()}
                        </p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          <span className="text-[var(--status-danger-strong)]">
                            {pipeline.tests.failed.toLocaleString()} failed
                          </span>
                          {" · "}
                          <span className="text-[var(--status-warning-strong)]">
                            {pipeline.tests.errors.toLocaleString()} errors
                          </span>
                          {" · "}
                          {pipeline.tests.skipped.toLocaleString()} skipped
                        </p>
                      </>
                    ) : (
                      <span className="text-muted-foreground">No report</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatRecentPipelineDuration(pipeline.durationSeconds)}
                  </TableCell>
                </TableRow>
                ))}
              </TableBody>
            ))}
          </Table>
        )}
        {page.total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              {start.toLocaleString()}–{end.toLocaleString()} of{" "}
              {page.total.toLocaleString()}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page.offset === 0 || fetching}
                onClick={() =>
                  onOffsetChange(Math.max(0, page.offset - page.limit))
                }
              >
                <ChevronLeft className="size-4" />
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page.offset + page.limit >= page.total || fetching}
                onClick={() => onOffsetChange(page.offset + page.limit)}
              >
                Next
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PipelinePassRate({
  tests,
}: {
  tests: AutomationTestCountsView | null;
}) {
  if (!tests) return <span className="text-muted-foreground">—</span>;
  const attempts = tests.passed + tests.failed + tests.errors;
  if (attempts === 0) return <span className="text-muted-foreground">—</span>;
  const value = Math.round((tests.passed / attempts) * 1000) / 10;
  const tone =
    value >= 99
      ? "bg-[var(--status-success)]"
      : value >= 95
        ? "bg-[var(--status-warning)]"
        : "bg-[var(--status-danger)]";
  return (
    <div className="ml-auto grid w-20 gap-1">
      <span className="font-medium tabular-nums">{value.toFixed(1)}%</span>
      <div
        role="progressbar"
        aria-label="Test pass rate"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full", tone)}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

function AutomationDetail({
  pipelineId,
  valid,
  onBack,
}: {
  pipelineId: number;
  valid: boolean;
  onBack: () => void;
}) {
  const detail = useApi(queries.automationPipeline(pipelineId));

  return (
    <div className={PAGE_CLASS}>
        <Button type="button" variant="ghost" className="w-fit" onClick={onBack}>
          <ArrowLeft className="size-4" />
          Automation
        </Button>
        {!valid ? (
          <ErrorBox>Pipeline id must be a positive integer.</ErrorBox>
        ) : !detail.data && detail.loading ? (
          <Loading>Loading pipeline #{pipelineId}…</Loading>
        ) : !detail.data && detail.error ? (
          <ErrorBox>{detail.error}</ErrorBox>
        ) : detail.data ? (
          <PipelineDetailContent
            pipeline={detail.data}
            staleError={detail.error}
          />
        ) : null}
    </div>
  );
}

function PipelineDetailContent({
  pipeline,
  staleError,
}: {
  pipeline: AutomationPipelineDetailView;
  staleError?: string;
}) {
  const format = useFormat();
  return (
    <>
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className={PAGE_TITLE_CLASS}>
              Pipeline #{pipeline.pipelineId}
            </h1>
            <OutcomeBadge outcome={pipeline.outcome} />
            <PipelineStatusBadge status={pipeline.status} />
          </div>
          <p className={cn(PAGE_META_CLASS, "font-mono")}>
            {pipeline.projectId} · {pipeline.ref} · {pipeline.sha.slice(0, 8)}
          </p>
        </div>
        <div>
          <Button asChild>
            <a href={pipeline.webUrl} target="_blank" rel="noreferrer">
              Open in GitLab <ExternalLink className="size-4" />
            </a>
          </Button>
        </div>
      </header>

      {staleError ? (
        <div className="rounded-[var(--radius)] border border-[var(--status-danger)]/40 bg-[var(--status-danger-wash)] p-3 text-sm text-[var(--status-danger-strong)]" role="alert">
          Update failed: {staleError}. Showing the last available detail.
        </div>
      ) : null}

      <AutomationFailureTriage pipeline={pipeline} />

      <PipelineExplanation pipeline={pipeline} />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          icon={<TestTube2 className="size-4" />}
          label="Pipeline tests"
          value={(pipeline.tests?.total ?? pipeline.report?.totalCount ?? 0).toLocaleString()}
          detail={`${countsDetail(pipeline.tests)} · ${pipeline.jobs.filter((job) => job.report).length} reported jobs`}
        />
        <KpiCard
          icon={<CheckCircle2 className="size-4" />}
          label="Passed"
          value={(pipeline.tests?.passed ?? pipeline.report?.successCount ?? 0).toLocaleString()}
          detail={`${pipeline.tests?.skipped ?? pipeline.report?.skippedCount ?? 0} skipped`}
        />
        <KpiCard
          icon={<AlertTriangle className="size-4" />}
          label="Failed / errors"
          value={`${pipeline.tests?.failed ?? pipeline.report?.failedCount ?? 0} / ${
            pipeline.tests?.errors ?? pipeline.report?.errorCount ?? 0
          }`}
          detail="Normalized clusters are triaged above"
        />
        <KpiCard
          icon={<Clock3 className="size-4" />}
          label="Duration"
          value={formatSeconds(pipeline.durationSeconds)}
          detail={
            pipeline.startedAt
              ? `${format.stamp(pipeline.startedAt)} → ${pipeline.finishedAt ? format.time(pipeline.finishedAt) : "running"}`
              : "Timing unavailable"
          }
        />
      </section>

      <JobsTable jobs={pipeline.jobs} />
      <SuitesTable suites={pipeline.suites} />
    </>
  );
}

function PipelineExplanation({ pipeline }: { pipeline: AutomationPipelineDetailView }) {
  let title: string | null = null;
  let detail: string | null = null;
  if (pipeline.outcome === "infrastructure-failed") {
    title = "Pipeline infrastructure failed";
    detail =
      "GitLab did not complete the pipeline successfully. Review the failed jobs before treating this as a product test failure.";
  } else if (pipeline.outcome === "report-missing") {
    title = "No test report was published";
    detail =
      "The pipeline completed, but no supported JUnit report was available. Check the job artifact configuration.";
  } else if (pipeline.outcome === "report-error") {
    title = "Report synchronization failed";
    detail =
      "TALOS found the pipeline but could not collect or parse its report. Pipeline status and report health are tracked separately.";
  }
  if (!title) return null;
  return (
    <div className="rounded-[var(--radius)] border border-[var(--status-warning)]/40 bg-[var(--status-warning-wash)] p-4">
      <h2 className="font-medium">{title}</h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{detail}</p>
    </div>
  );
}

function JobsTable({ jobs }: { jobs: AutomationPipelineDetailView["jobs"] }) {
  return (
    <Card className="shrink-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Jobs
          <TitleInfo>
            Job-specific totals. The pipeline total combines every JUnit-producing job.
          </TitleInfo>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {jobs.length === 0 ? (
          <EmptyPanel>No jobs were stored for this pipeline.</EmptyPanel>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Failure reason</TableHead>
                <TableHead className="text-right">Tests</TableHead>
                <TableHead className="text-right">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job) => (
                <TableRow
                  key={job.jobId}
                  role="link"
                  tabIndex={0}
                  aria-label={`Open ${job.name} in GitLab`}
                  className="cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                  onClick={() =>
                    window.open(job.webUrl, "_blank", "noopener,noreferrer")
                  }
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    window.open(job.webUrl, "_blank", "noopener,noreferrer");
                  }}
                >
                  <TableCell className="font-medium">
                    {job.name}
                    {job.allowFailure ? (
                      <span className="ml-2 text-xs text-muted-foreground">allowed to fail</span>
                    ) : null}
                  </TableCell>
                  <TableCell>{job.stage}</TableCell>
                  <TableCell>
                    <PipelineStatusBadge status={job.status} />
                  </TableCell>
                  <TableCell className="max-w-xs truncate" title={job.failureReason ?? undefined}>
                    {job.failureReason ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {job.report?.totalCount ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatSeconds(job.durationSeconds)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function SuitesTable({ suites }: { suites: AutomationPipelineDetailView["suites"] }) {
  return (
    <Card className="shrink-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Test suites
          <TitleInfo>Counts and runtime reported by each suite.</TitleInfo>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {suites.length === 0 ? (
          <EmptyPanel>No test suites were available.</EmptyPanel>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Suite</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Passed</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">Errors</TableHead>
                <TableHead className="text-right">Skipped</TableHead>
                <TableHead className="text-right">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {suites.map((suite) => (
                <TableRow key={suite.index}>
                  <TableCell>
                    <span className="font-medium">{suite.name || `Suite ${suite.index + 1}`}</span>
                    {suite.suiteError ? (
                      <p className="mt-1 max-w-xl whitespace-normal text-xs text-[var(--status-danger-strong)]">
                        {suite.suiteError}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">{suite.totalCount}</TableCell>
                  <TableCell className="text-right">{suite.successCount}</TableCell>
                  <TableCell className="text-right">{suite.failedCount}</TableCell>
                  <TableCell className="text-right">{suite.errorCount}</TableCell>
                  <TableCell className="text-right">{suite.skippedCount}</TableCell>
                  <TableCell className="text-right">
                    {formatSeconds(suite.totalTimeSeconds)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function OutcomeBadge({ outcome }: { outcome: AutomationPipelineOutcome }) {
  const tone =
    outcome === "passed"
      ? "success"
      : outcome === "running"
        ? "running"
        : outcome === "canceled-skipped"
          ? "cancelled"
          : outcome === "report-missing"
            ? "warn"
            : "failure";
  return <StatusBadge status={tone}>{outcome.replaceAll("-", " ")}</StatusBadge>;
}

function PipelineStatusBadge({ status }: { status: string }) {
  const tone =
    status === "success"
      ? "success"
      : status === "running" || status === "pending"
        ? "running"
        : status === "failed"
          ? "failure"
          : status === "canceled" || status === "skipped"
            ? "cancelled"
            : "disabled";
  return <StatusBadge status={tone}>{status}</StatusBadge>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-medium tabular-nums">{value}</div>
    </div>
  );
}

function EmptyPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius)] border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

type ScheduleTrendDay =
  AutomationDashboardView["scheduleTrends"][number]["days"][number];

interface DailyChartRow extends Record<string, string | number | null> {
  date: string;
  label: string;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  passRate: number | null;
  passRatePercent: number | null;
  averageDurationSeconds: number | null;
  passedSchedules: number;
  blockedSchedules: number;
  unstableSchedules: number;
  runSchedules: number;
}

function dailyChartRows(data: AutomationDashboardView): DailyChartRow[] {
  const dates =
    data.scheduleTrends[0]?.days.map((day) => day.date) ??
    data.trend.map((day) => day.date);
  return dates.map((date, index) => {
    const row: DailyChartRow = {
      date,
      label: chartDateLabel(date, data.days),
      total: 0,
      passed: 0,
      failed: 0,
      errors: 0,
      skipped: 0,
      passRate: null,
      passRatePercent: null,
      averageDurationSeconds: null,
      passedSchedules: 0,
      blockedSchedules: 0,
      unstableSchedules: 0,
      runSchedules: 0,
    };
    let durationTotal = 0;
    let durationCount = 0;
    for (const schedule of data.scheduleTrends) {
      const day = schedule.days[index];
      row[durationDataKey(schedule.scheduleId)] =
        day?.durationSeconds == null
          ? null
          : Math.round((day.durationSeconds / 60) * 10) / 10;
      if (!day) continue;
      if (day.pipelineId != null) row.runSchedules += 1;
      if (day.outcome === "passed") row.passedSchedules += 1;
      if (day.outcome && isBlockedOutcome(day.outcome)) {
        row.blockedSchedules += 1;
      }
      if (day.unstable) row.unstableSchedules += 1;
      if (day.tests) {
        row.total += day.tests.total;
        row.passed += day.tests.passed;
        row.failed += day.tests.failed;
        row.errors += day.tests.errors;
        row.skipped += day.tests.skipped;
      }
      if (day.durationSeconds != null) {
        durationTotal += day.durationSeconds;
        durationCount += 1;
      }
    }
    const attempts = row.passed + row.failed + row.errors;
    row.passRate = attempts > 0 ? row.passed / attempts : null;
    row.passRatePercent =
      row.passRate == null ? null : Math.round(row.passRate * 1000) / 10;
    row.averageDurationSeconds =
      durationCount > 0 ? durationTotal / durationCount : null;
    return row;
  });
}

function dailyOutcomeCounts(data: AutomationDashboardView) {
  const counts = {
    passed: 0,
    testFailed: 0,
    infrastructure: 0,
    report: 0,
    other: 0,
  };
  for (const schedule of data.scheduleTrends) {
    for (const day of schedule.days) {
      if (day.outcome === "passed") counts.passed += 1;
      else if (day.outcome === "test-failed") counts.testFailed += 1;
      else if (day.outcome === "infrastructure-failed") counts.infrastructure += 1;
      else if (day.outcome === "report-missing" || day.outcome === "report-error") {
        counts.report += 1;
      } else if (day.outcome != null) counts.other += 1;
    }
  }
  return counts;
}

function scheduleChartConfig(data: AutomationDashboardView): ChartConfig {
  const config: ChartConfig = {};
  data.scheduleTrends.forEach((schedule, index) => {
    const item = {
      label: schedule.displayName,
      color: SCHEDULE_CHART_COLORS[index % SCHEDULE_CHART_COLORS.length],
    };
    config[scheduleDataKey(schedule.scheduleId)] = item;
    config[durationDataKey(schedule.scheduleId)] = item;
  });
  return config;
}

function scheduleDataKey(scheduleId: number): string {
  return `schedule_${scheduleId}`;
}

function durationDataKey(scheduleId: number): string {
  return `duration_${scheduleId}`;
}

function chartDateLabel(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  return value.toLocaleDateString(undefined, {
    timeZone: "UTC",
    ...(days <= 7
      ? { weekday: "short" as const }
      : { month: "short" as const, day: "numeric" as const }),
  });
}

function compactScheduleLabel(value: string): string {
  const compact = value.replace(/\s+scheduled$/i, "").trim();
  return compact.length > 18 ? `${compact.slice(0, 17)}…` : compact;
}

function readinessCellLabel(
  scheduleName: string,
  day: ScheduleTrendDay,
): string {
  if (!day.outcome) return `${scheduleName}, ${day.date}: no matching run`;
  const instability = day.unstable ? ", passed after an earlier unhealthy run" : "";
  const reruns = day.runCount > 1 ? `, ${day.runCount} runs` : "";
  return `${scheduleName}, ${day.date}: ${day.outcome.replaceAll("-", " ")}${instability}${reruns}`;
}

function readinessCellClass(
  outcome: AutomationPipelineOutcome | null,
  unstable: boolean,
): string {
  if (outcome === "passed") {
    return cn(
      "border-[var(--status-success)]/50 bg-[var(--status-success-wash)]",
      unstable && "ring-1 ring-inset ring-[var(--status-warning)]",
    );
  }
  if (outcome === "test-failed") {
    return "border-[var(--status-danger)]/60 bg-[var(--status-danger-wash)]";
  }
  if (
    outcome === "infrastructure-failed" ||
    outcome === "report-missing" ||
    outcome === "report-error"
  ) {
    return "border-[var(--status-warning)]/60 bg-[var(--status-warning-wash)]";
  }
  if (outcome === "running") {
    return "border-live/60 bg-live/15";
  }
  return "border-dashed border-border bg-muted";
}

function isBlockedOutcome(outcome: AutomationPipelineOutcome): boolean {
  return (
    outcome === "test-failed" ||
    outcome === "infrastructure-failed" ||
    outcome === "report-missing" ||
    outcome === "report-error"
  );
}

function changeDetail(
  current: number | null | undefined,
  previous: number | null | undefined,
  suffix: string,
  formatter: (delta: number) => string = formatSignedNumber,
): string {
  if (current == null) return "No data today";
  if (previous == null) return "No previous-day comparison";
  const delta = current - previous;
  if (Math.abs(delta) < 0.05) return `No change ${suffix}`;
  return `${formatter(delta)} ${suffix}`;
}

function formatSignedNumber(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString()}`;
}

function formatSignedSeconds(value: number): string {
  const sign = value > 0 ? "+" : "−";
  return `${sign}${formatSeconds(Math.abs(value))}`;
}

function percent(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function formatSeconds(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 60) return `${value.toFixed(value < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60);
  return `${minutes}m ${Math.round(value % 60)}s`;
}

function formatRecentPipelineDuration(
  value: number | null | undefined,
): string {
  if (value == null) return "—";
  if (value < 60) return `${Math.round(value)}s`;
  const totalMinutes = Math.floor(value / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${totalMinutes % 60}m`;
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function countsDetail(counts: AutomationTestCountsView | null): string {
  if (!counts) return "No test report";
  return `${counts.failed} failed · ${counts.errors} errors · ${counts.skipped} skipped`;
}
