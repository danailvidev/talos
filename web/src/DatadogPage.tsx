import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  EyeOff,
  History,
  RefreshCw,
  Search,
  Settings,
  TrendingDown,
  TrendingUp,
  Wand2,
  X,
} from "lucide-react";

import {
  api,
  type DatadogAreaView,
  type DatadogIssuesView,
  type DatadogIssueView,
  type DatadogProblemView,
  type DatadogServiceView,
  type DatadogSeverityView,
} from "./api.ts";
import { ago } from "./format.ts";
import { useFormat } from "./FormatContext.tsx";
import { Button } from "./components/ui/button.tsx";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { DatadogIcon } from "./DatadogIcon.tsx";
import { DatadogRoutingPanel } from "./DatadogRoutingPanel.tsx";
import { DatadogServiceTargetsPanel } from "./DatadogServiceTargetsPanel.tsx";
import { DatadogActivity } from "./DatadogActivity.tsx";
import { WriteRegressionTestDialog } from "./WriteRegressionTestDialog.tsx";
import {
  RegressionTestBadge,
  RegressionTestButton,
  RegressionTestLink,
} from "./RegressionTest.tsx";
import { invalidate, queries } from "./queries.ts";
import { Tip } from "./Tip.tsx";
import { TitleInfo } from "./TitleInfo.tsx";
import { keys } from "./query-keys.ts";
import { useApi } from "./useApi.ts";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import { toMessage } from "./errors.ts";
import { cn } from "./lib/utils.ts";
import {
  ISSUE_ACTIONS_CLASS,
  ISSUE_DETAIL_CLASS,
  ISSUE_META_CLASS,
  ISSUE_ROW_CLASS,
  ISSUE_ROW_HEAD_CLASS,
  ISSUE_ROW_MAIN_CLASS,
  ISSUE_TITLE_CLASS,
  OBSERVABILITY_LINK_CLASS,
  SETUP_NOTICE_CLASS,
  SETUP_STEPS_CLASS,
  SETUP_TITLE_CLASS,
} from "./observability-styles.ts";
import { PAGE_META_CLASS, PAGE_TITLE_CLASS } from "./typography-styles.ts";

const SEVERITY_BADGE_CLASS =
  "whitespace-nowrap rounded-[var(--radius-compact)] border border-transparent px-1.5 py-px text-xs font-bold tracking-[0.08em] uppercase";
const FILTER_CHIP_CLASS =
  "h-auto cursor-pointer rounded-full border border-border bg-[var(--bg-raised)] px-[9px] py-0.5 text-[0.8125rem] font-medium text-muted-foreground transition-[border-color,color,background] hover:border-[var(--text-faint)] hover:bg-[var(--bg-raised)] hover:text-foreground";
const DETAIL_BLOCK_CLASS = "flex min-w-0 flex-col gap-[3px]";
const DETAIL_LABEL_CLASS =
  "text-xs font-semibold tracking-[0.04em] text-[var(--text-faint)] uppercase";
const DETAIL_VALUE_CLASS = "max-w-[78ch] text-sm text-muted-foreground";
const DETAIL_PRE_CLASS =
  "m-0 max-h-65 overflow-auto whitespace-pre-wrap text-[0.7812rem] leading-normal text-muted-foreground [overflow-wrap:anywhere]";

const SEVERITY_CLASS: Record<DatadogSeverityView, string> = {
  critical:
    "border-[color-mix(in_srgb,var(--status-danger)_45%,transparent)] bg-[var(--status-danger-wash)] text-[var(--status-danger)]",
  high: "border-[color-mix(in_srgb,var(--status-warning)_45%,transparent)] bg-[var(--status-warning-wash)] text-[var(--status-warning)]",
  medium: "border-border bg-[var(--bg-deep)] text-muted-foreground",
  low: "border-border bg-transparent text-[var(--text-faint)]",
};
const AI_TRIAGE_CLASS: Record<
  "code" | "bad-data" | "infrastructure" | "unknown",
  string
> = {
  code:
    "border-[color-mix(in_srgb,var(--success)_55%,transparent)] bg-[color-mix(in_srgb,var(--success)_18%,var(--bg-raised))] text-[var(--success)]",
  "bad-data":
    "border-[color-mix(in_srgb,var(--status-warning)_60%,transparent)] bg-[var(--status-warning-wash)] text-[var(--status-warning)]",
  infrastructure:
    "border-[color-mix(in_srgb,var(--running)_55%,transparent)] bg-[color-mix(in_srgb,var(--running)_16%,var(--bg-raised))] text-[var(--running)]",
  unknown: "border-[var(--border-strong)] bg-[var(--bg-muted)] text-foreground",
};

/**
 * The Datadog page: production error logs as a triage list, worst first.
 *
 * This replaces a specific manual routine — opening the Datadog log explorer,
 * narrowing to `status:error env:prod`, eyeballing which service is loudest, and
 * guessing whose problem it is. The daily scan does that and stores the answer, so
 * what this page shows is a database read rather than a query against an org that
 * writes two million error lines a day.
 *
 * ## Why it is a tree and not a list
 *
 * The flat version of this page had thirty-eight rows describing about six failures,
 * because one failure writes several log lines — the method that threw, the exception
 * that wrapped it, the client on the other side — and each clusters separately. And
 * volume is concentrated to the point where a flat list is one service's list: of
 * 2.08M daily production error logs, one service writes 1.71M, so the four services
 * behind it never appear above the fold. Hence three levels: service, root cause,
 * then the raw signatures the root cause merged. It opens on a handful of service
 * rows and every number below is one expansion away.
 *
 * ## Two honesty rules
 *
 * Occurrence counts are estimates — extrapolated from a sample of a few hundred log
 * bodies — so they are shown with a `≈` and the sample fraction is one hover away,
 * never dressed up as a measurement. Within a problem the count is the *largest*
 * member rather than the sum, because the members are the same occurrences seen from
 * different frames; the signature rows underneath therefore do not add up to the row
 * above them, and say so.
 *
 * And every row says how its team was decided (`routedBy`), because ownership here
 * comes from rules an operator wrote rather than from anything Datadog knows: a
 * wrongly-routed issue should point at the rule that misrouted it.
 */
export function DatadogPage({
  onToast,
  onOpenSettings,
}: {
  onToast: (text: string) => void;
  onOpenSettings: () => void;
}) {
  const queryClient = useQueryClient();
  const [busyKey, setBusyKey] = useState<string>();
  const [tab, setTab] = useState<"errors" | "activity" | "settings">(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return requested === "activity" || requested === "settings" ? requested : "errors";
  });
  const [testPlan, setTestPlan] = useState<DatadogProblemView>();
  const [scanning, setScanning] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [team, setTeam] = useState<string>();
  const [area, setArea] = useState<DatadogAreaView>();
  const [severity, setSeverity] = useState<DatadogSeverityView>();

  useEffect(() => {
    const url = new URL(window.location.href);
    if (tab === "errors") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, [tab]);

  // One filter object for the read, for the dismissal POST and for the cache key
  // the POST's answer is written into. Rebuilt every render, which the cache does
  // not mind — keys are hashed by value, not by identity.
  const filter = {
    includeDismissed: showDismissed,
    ...(team ? { team } : {}),
    ...(area ? { area } : {}),
  };
  const issues = useApi(queries.datadogIssues(filter));
  const activitySummary = useApi(queries.datadogActivity({ limit: 1, offset: 0 }));
  const refresh = () => invalidate.datadogIssues(queryClient);

  const data = issues.data;

  // The flat list is sent alongside the tree precisely so it is not sent twice; this
  // is the index the tree's `issueIds` are resolved through.
  const byId = useMemo(() => {
    const map = new Map<string, DatadogIssueView>();
    for (const issue of data?.issues ?? []) map.set(issue.id, issue);
    return map;
  }, [data]);

  // Severity is filtered client-side, unlike team and area: it is what the tree is
  // already sorted by, so the whole set is on screen anyway and a round trip to hide
  // three rows would only add latency. Filtering at the problem level and dropping
  // emptied services keeps a service's badge honest — it is the worst severity of
  // what is *shown*, not of what was scanned.
  const services = useMemo(() => {
    const all = data?.services ?? [];
    if (!severity) return all;
    return all
      .map((service) => ({
        ...service,
        problems: service.problems.filter((problem) => problem.severity === severity),
      }))
      .filter((service) => service.problems.length > 0);
  }, [data, severity]);

  const problemCount = services.reduce((total, service) => total + service.problems.length, 0);

  const fix = async (problem: DatadogProblemView) => {
    setBusyKey(problem.key);
    try {
      const result = await api.fixDatadogProblem(problem.key);
      onToast(result.message);
      // The list, because the row now shows a ticket and a run in flight, and the
      // job queue, because filing one queued an agent.
      refresh();
      void queryClient.invalidateQueries({ queryKey: keys.allDatadog() });
      invalidate.jobQueue(queryClient);
    } catch (err) {
      onToast(toMessage(err));
    } finally {
      setBusyKey(undefined);
    }
  };

  const writeTest = async (problem: DatadogProblemView, targetBranch: string) => {
    setBusyKey(problem.key);
    try {
      const result = await api.writeDatadogRegressionTest(problem.key, { targetBranch });
      onToast(result.message);
      // Refreshed even on a refusal: the message is the answer, and the row's
      // in-flight badge is what shows the queued job actually exists.
      refresh();
      void queryClient.invalidateQueries({ queryKey: keys.allDatadog() });
      invalidate.jobQueue(queryClient);
    } catch (err) {
      onToast(toMessage(err));
    } finally {
      setBusyKey(undefined);
      setTestPlan(undefined);
    }
  };

  const triage = async (problem: DatadogProblemView) => {
    setBusyKey(problem.key);
    try {
      const result = await api.triageDatadogProblem(problem.key);
      onToast(result.message);
      refresh();
      void queryClient.invalidateQueries({ queryKey: keys.allDatadog() });
      invalidate.jobQueue(queryClient);
    } catch (err) {
      onToast(toMessage(err));
    } finally {
      setBusyKey(undefined);
    }
  };

  const setState = async (problem: DatadogProblemView, state: "open" | "dismissed") => {
    setBusyKey(problem.key);
    try {
      // The response is the new list for exactly this filter, so it goes straight
      // into the cache: dismissing a problem costs no GET. The other filter
      // combinations are marked stale without being refetched — they are off
      // screen, and a team filter nobody is looking at should not cost a request.
      const view = await api.setDatadogProblemState(problem.key, state, filter);
      invalidate.datadogIssues(queryClient, "none");
      queryClient.setQueryData(keys.datadogIssues(filter), view);
    } catch (err) {
      onToast(toMessage(err));
    } finally {
      setBusyKey(undefined);
    }
  };

  const scan = async () => {
    setScanning(true);
    try {
      const result = await api.scanDatadog();
      onToast(result.message);
      refresh();
      // A scan records its own run row, so the loop's history and its "last run"
      // pill are out of date the moment this returns.
      invalidate.jobQueue(queryClient);
    } catch (err) {
      onToast(toMessage(err));
    } finally {
      setScanning(false);
    }
  };

  if (issues.loading && !data) {
    return <Loading>Loading Datadog issues…</Loading>;
  }
  if (issues.error) {
    return <ErrorBox>{issues.error}</ErrorBox>;
  }
  if (!data) return null;

  return (
    <div className="flex min-h-0 w-full flex-col gap-5 overflow-y-auto px-4 pt-5 pb-8 min-[901px]:px-[34px] min-[901px]:pt-8 min-[901px]:pb-12">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className={PAGE_TITLE_CLASS}>
            <DatadogIcon size={18} />
            Datadog
            <TitleInfo>Production error logs, grouped into root causes by service.</TitleInfo>
          </h1>
          {/* Counts stay on the page: unlike the description they change per scan,
              so they are status rather than noise. */}
          <p className={PAGE_META_CLASS}>
            {problemCount} {problemCount === 1 ? "problem" : "problems"} across{" "}
            {services.length} {services.length === 1 ? "service" : "services"}
            {data.lastScanAt ? ` · last scan ${ago(data.lastScanAt)}` : ""}
          </p>
        </div>
        {tab === "errors" ? (
          <div className="flex items-center gap-2">
          <Button
            type="button"
            variant={showDismissed ? "secondary" : "outline"}
            size="sm"
            aria-pressed={showDismissed}
            onClick={() => setShowDismissed((v) => !v)}
          >
            <EyeOff size={14} strokeWidth={2} /> Dismissed
          </Button>
          <Tip
            label={
              data.scanRefusal ??
              "Scan the last 24 hours of production errors, rebuild this list, and file confirmed regressions to Jira."
            }
          >
            <span className="inline-flex">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={scanning || data.scanRefusal != null}
                onClick={() => void scan()}
              >
                <Search size={14} strokeWidth={2} className={scanning ? "animate-pulse" : ""} />{" "}
                {scanning ? "Scanning…" : "Scan now"}
              </Button>
            </span>
          </Tip>
          <Tip label="Reload the last scan from Talos. Does not query Datadog.">
            <span className="inline-flex">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={refresh}
                disabled={issues.fetching}
              >
                <RefreshCw
                  size={14}
                  strokeWidth={2}
                  className={issues.fetching ? "animate-spin" : ""}
                />{" "}
                Refresh
              </Button>
            </span>
          </Tip>
          </div>
        ) : null}
      </header>

      <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
        <TabsList variant="line">
          <TabsTrigger value="errors">
            <DatadogIcon size={13} /> Errors
          </TabsTrigger>
          <TabsTrigger value="activity">
            <History size={13} /> Activity
            {(activitySummary.data?.activeJobs.length ?? 0) > 0 ? (
              <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--running)_16%,transparent)] px-1.5 py-0.5 text-xs font-semibold text-[var(--running)]">
                <span className="size-1.5 animate-pulse rounded-full bg-current" />
                {activitySummary.data!.activeJobs.length}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="settings">
            <Settings size={13} /> Settings
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "activity" ? <DatadogActivity /> : null}

      {tab === "settings" ? (
        <div className="flex flex-col gap-4">
          <section className="flex items-center justify-between gap-4 rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] px-4 py-3.5">
            <div>
              <h2 className="m-0 text-[0.9375rem] font-semibold text-foreground">
                Datadog connection and scan
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Token, site, log query, Jira project and issue type.
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={onOpenSettings}>
              <Settings size={14} /> Integration settings
            </Button>
          </section>
          <DatadogServiceTargetsPanel onToast={onToast} onChanged={refresh} />
          <DatadogRoutingPanel onToast={onToast} onChanged={refresh} />
        </div>
      ) : null}

      {tab === "errors" ? (
        <>
          <SetupNotice data={data} onOpenSettings={onOpenSettings} />

          {data.services.length > 0 ? (
        <Filters
          data={data}
          severity={severity}
          team={team}
          area={area}
          onSeverity={setSeverity}
          onTeam={setTeam}
          onArea={setArea}
        />
      ) : null}

          {data.fixRefusal && problemCount > 0 ? (
        <div className="mt-1.5 max-w-180 text-sm text-[var(--text-faint)]">
          {data.fixRefusal}
        </div>
      ) : null}

      {/* Only when it says something the fix refusal did not: both usually end in
          "set a default project", and printing that twice reads as a bug. */}
          {data.regressionTestRefusal &&
      data.regressionTestRefusal !== data.fixRefusal &&
      problemCount > 0 ? (
        <div className="mt-1.5 max-w-180 text-sm text-[var(--text-faint)]">
          {data.regressionTestRefusal}
        </div>
      ) : null}

          {services.length === 0 ? (
        <div className="mt-1.5 max-w-180 text-sm text-[var(--text-faint)]">
          {data.services.length > 0
            ? "Nothing matches these filters."
            : data.lastScanAt
              ? `Nothing matched ${data.query} on the last scan.`
              : "No scan has run yet. The loop runs daily at 06:15; “Scan now” does it immediately."}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {services.map((service) => (
            <ServiceRow
              key={service.service ?? "(unknown)"}
              service={service}
              byId={byId}
              busyKey={busyKey}
              fixDisabled={data.fixRefusal != null}
              // Expanded when there is only one service to look at, which is the
              // common shape of a filtered view — collapsing it would hide the
              // answer behind a click that has only one destination.
              defaultOpen={services.length === 1}
              onFix={(problem) => void fix(problem)}
              onTriage={(problem) => void triage(problem)}
              onWriteTest={(problem) => setTestPlan(problem)}
              onOpenActivity={() => setTab("activity")}
              onSetState={(problem, state) => void setState(problem, state)}
            />
          ))}
        </div>
          )}
        </>
      ) : null}

      {testPlan ? (
        <WriteRegressionTestDialog
          problem={testPlan}
          busy={busyKey === testPlan.key}
          onConfirm={(targetBranch) => void writeTest(testPlan, targetBranch)}
          onCancel={() => setTestPlan(undefined)}
        />
      ) : null}
    </div>
  );
}

/**
 * Everything standing between this page and its first row.
 *
 * Only shown while something is missing. The distinction that matters is "no token"
 * versus "no scan yet": both give an empty table, and only the server knows which.
 */
function SetupNotice({
  data,
  onOpenSettings,
}: {
  data: DatadogIssuesView;
  onOpenSettings: () => void;
}) {
  if (data.enabled) return null;

  return (
    <div className={SETUP_NOTICE_CLASS}>
      <p className={SETUP_TITLE_CLASS}>Datadog is not configured yet.</p>
      <ol className={SETUP_STEPS_CLASS}>
        <li>
          Add a Datadog personal access token under Settings → Integrations → Datadog.
          It needs the <span className="mono">logs_read_data</span> and{" "}
          <span className="mono">logs_read_index_data</span> scopes; an API key will
          not work.
        </li>
        <li>
          Configure the Jira project, assignee, and ticket fields in the Datadog
          loop's Settings tab.
        </li>
        <li>
          Run the scan — the loop fires daily, and “Scan now” does it on demand.
        </li>
      </ol>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={onOpenSettings}>
          <Settings size={14} strokeWidth={2} /> Open Integrations settings
        </Button>
      </div>
    </div>
  );
}

/**
 * Severity, area and team chips.
 *
 * The severity counts are problems rather than signatures, matching what the page
 * shows: a chip reading "critical 12" against six visible rows would be counting log
 * lines nobody asked about. Team and area come from the data rather than from the
 * rule list, so a chip never filters to an empty page — a team named in a rule that
 * has matched nothing is not a filter worth offering.
 */
function Filters({
  data,
  severity,
  team,
  area,
  onSeverity,
  onTeam,
  onArea,
}: {
  data: DatadogIssuesView;
  severity?: DatadogSeverityView;
  team?: string;
  area?: DatadogAreaView;
  onSeverity: (value?: DatadogSeverityView) => void;
  onTeam: (value?: string) => void;
  onArea: (value?: DatadogAreaView) => void;
}) {
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const service of data.services) {
      for (const problem of service.problems) {
        out[problem.severity] = (out[problem.severity] ?? 0) + 1;
      }
    }
    return out;
  }, [data.services]);

  const severities: DatadogSeverityView[] = ["critical", "high", "medium", "low"];

  return (
    <div className="mb-1 flex flex-wrap items-center gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {severities.map((value) =>
          counts[value] ? (
            <Button
              key={value}
              type="button"
              variant="outline"
              size="xs"
              className={cn(
                FILTER_CHIP_CLASS,
                SEVERITY_CLASS[value],
                severity === value &&
                  "border-primary bg-primary/12 text-foreground",
              )}
              aria-pressed={severity === value}
              onClick={() => onSeverity(severity === value ? undefined : value)}
            >
              {value}{" "}
              <span className="text-xs text-[var(--text-faint)]">{counts[value]}</span>
            </Button>
          ) : null,
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {data.areas.map((value) => (
          <Button
            key={value}
            type="button"
            variant="outline"
            size="xs"
            className={cn(
              FILTER_CHIP_CLASS,
              area === value && "border-primary bg-primary/12 text-foreground",
            )}
            aria-pressed={area === value}
            onClick={() => onArea(area === value ? undefined : value)}
          >
            {value}
          </Button>
        ))}
        {data.teams.map((value) => (
          <Button
            key={value}
            type="button"
            variant="outline"
            size="xs"
            className={cn(
              FILTER_CHIP_CLASS,
              team === value && "border-primary bg-primary/12 text-foreground",
            )}
            aria-pressed={team === value}
            onClick={() => onTeam(team === value ? undefined : value)}
          >
            {value}
          </Button>
        ))}
      </div>
      <Tip label="The log search every row on this page came from">
        <div className="mono ml-auto text-[0.7812rem] text-[var(--text-faint)] [overflow-wrap:anywhere]">
          {data.query}
        </div>
      </Tip>
    </div>
  );
}

/**
 * Level one: a service, collapsed to one line.
 *
 * Its count is the sum of its problems, which is sound in a way that summing within a
 * problem is not — two root causes are two separate sets of failures.
 */
function ServiceRow({
  service,
  byId,
  busyKey,
  fixDisabled,
  defaultOpen,
  onFix,
  onTriage,
  onWriteTest,
  onOpenActivity,
  onSetState,
}: {
  service: DatadogServiceView;
  byId: ReadonlyMap<string, DatadogIssueView>;
  busyKey?: string;
  fixDisabled: boolean;
  defaultOpen: boolean;
  onFix: (problem: DatadogProblemView) => void;
  onTriage: (problem: DatadogProblemView) => void;
  onWriteTest: (problem: DatadogProblemView) => void;
  onOpenActivity: () => void;
  onSetState: (problem: DatadogProblemView, state: "open" | "dismissed") => void;
}) {
  const fmt = useFormat();
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="overflow-hidden rounded-[var(--radius)] border border-border bg-[var(--bg-raised)]">
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full cursor-pointer justify-start gap-2 rounded-none px-3 py-2.5 text-left text-sm whitespace-normal text-[var(--text-faint)] hover:bg-[var(--bg-deep)]"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown size={14} strokeWidth={2} />
        ) : (
          <ChevronRight size={14} strokeWidth={2} />
        )}
        <span className={cn(SEVERITY_BADGE_CLASS, SEVERITY_CLASS[service.severity])}>
          {service.severity}
        </span>
        <span className="mono text-[0.9375rem] font-semibold text-foreground [overflow-wrap:anywhere]">
          {service.service ?? "(no service tag)"}
        </span>
        <span className="ml-auto whitespace-nowrap">
          {service.problemCount} {service.problemCount === 1 ? "problem" : "problems"} ·{" "}
          <span className="text-muted-foreground tabular-nums">
            ≈{fmt.number(service.eventCount)}
          </span>{" "}
          occurrences
        </span>
        <Tip label="From this service's loudest problem">
          <span className="border-l border-border pl-2 text-[0.7812rem] text-[var(--text-faint)]">
            {service.team ?? service.area}
          </span>
        </Tip>
      </Button>

      {open ? (
        <div className="flex flex-col gap-2 px-2.5 pb-2.5">
          {service.problems.map((problem) => (
            <ProblemRow
              key={problem.key}
              problem={problem}
              byId={byId}
              busy={busyKey === problem.key}
              fixDisabled={fixDisabled}
              testRefusal={problem.regressionTestRefusal}
              onFix={() => onFix(problem)}
              onTriage={() => onTriage(problem)}
              onWriteTest={() => onWriteTest(problem)}
              onOpenActivity={onOpenActivity}
              onSetState={(state) => onSetState(problem, state)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Level two: one root cause, and the level every action works at.
 *
 * Fix and Dismiss live here rather than on a signature because this is the unit a
 * person decides about — one failure logged from five frames is one ticket, and
 * dismissing four of its five log lines would leave the fifth on the page.
 */
function ProblemRow({
  problem,
  byId,
  busy,
  fixDisabled,
  testRefusal,
  onFix,
  onTriage,
  onWriteTest,
  onOpenActivity,
  onSetState,
}: {
  problem: DatadogProblemView;
  byId: ReadonlyMap<string, DatadogIssueView>;
  busy: boolean;
  fixDisabled: boolean;
  testRefusal: string | null;
  onFix: () => void;
  onTriage: () => void;
  onWriteTest: () => void;
  onOpenActivity: () => void;
  onSetState: (state: "open" | "dismissed") => void;
}) {
  const [open, setOpen] = useState(false);

  const members = problem.issueIds
    .map((id) => byId.get(id))
    .filter((issue): issue is DatadogIssueView => issue != null);
  const primary = members[0];

  const facts = [
    problem.scanCount === 1 ? "new" : `seen on ${problem.scanCount} scans`,
    `first seen ${ago(problem.firstSeenAt)}`,
    `last seen ${ago(problem.lastSeenAt)}`,
    problem.alsoIn.length > 0 ? `also in ${problem.alsoIn.join(", ")}` : null,
  ].filter(Boolean);

  return (
    <div className={cn(ISSUE_ROW_CLASS, problem.state === "dismissed" && "opacity-55")}>
      <div className={ISSUE_ROW_MAIN_CLASS}>
        <div className={ISSUE_ROW_HEAD_CLASS}>
          <span className={cn(SEVERITY_BADGE_CLASS, SEVERITY_CLASS[problem.severity])}>
            {problem.severity}
          </span>
          <span className={ISSUE_TITLE_CLASS}>{problem.title}</span>
          <Owner problem={problem} routedBy={primary?.routedBy ?? null} />
        </div>
        {primary?.sampleMessage ? (
          <div className={cn(ISSUE_DETAIL_CLASS, "mono")}>{primary.sampleMessage}</div>
        ) : null}
        <div className={ISSUE_META_CLASS}>
          <Count problem={problem} />
          {facts.length > 0 ? ` · ${facts.join(" · ")}` : ""}
          {problem.regressionTest ? (
            <>
              {" · "}
              <RegressionTestBadge test={problem.regressionTest} />
            </>
          ) : null}
          {problem.aiTriage ? (
            <>
              {" · "}
              <span
                className={cn(
                  "inline-flex cursor-help items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-bold tracking-[0.06em] uppercase shadow-sm",
                  AI_TRIAGE_CLASS[problem.aiTriage.verdict],
                )}
                title={`${problem.aiTriage.rationale}\n\nNext: ${problem.aiTriage.recommendation}`}
              >
                <Bot size={11} strokeWidth={2.5} />
                AI: {problem.aiTriage.verdict}
              </span>
            </>
          ) : null}
        </div>
        {problem.aiTriage ? (
          <div className="mt-1.5 max-w-[88ch] rounded-[var(--radius-compact)] border border-border bg-[var(--bg-deep)] px-2.5 py-2 text-sm text-muted-foreground">
            <div className="flex items-center gap-2 text-foreground">
              <Bot size={13} />
              <strong className="capitalize">{problem.aiTriage.verdict}</strong>
              <span>{Math.round(problem.aiTriage.confidence * 100)}% confidence</span>
            </div>
            <p className="mt-1 mb-0">{problem.aiTriage.rationale}</p>
            <p className="mt-1 mb-0">
              <strong className="text-foreground">Next:</strong>{" "}
              {problem.aiTriage.recommendation}
            </p>
          </div>
        ) : null}
        <Button
          type="button"
          variant="link"
          size="xs"
          className="mt-0.5 h-auto self-start p-0 text-[0.7812rem] text-[var(--text-faint)] no-underline hover:text-primary"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? (
            <ChevronDown size={12} strokeWidth={2} />
          ) : (
            <ChevronRight size={12} strokeWidth={2} />
          )}
          {open
            ? "Hide log lines"
            : members.length > 1
              ? `${members.length} log lines`
              : "Details"}
        </Button>
        {open ? (
          <div className="mt-1.5 flex flex-col gap-1 border-l-2 border-border pl-2.5">
            {members.length > 1 ? (
              <p className="mb-0.5 max-w-[78ch] text-[0.7812rem] leading-normal text-[var(--text-faint)]">
                One failure writes several log lines, and these are the shapes it
                wrote. Their counts overlap — the same occurrences seen from different
                frames — so they describe the problem above rather than adding up to
                it.
              </p>
            ) : null}
            {members.map((issue) => (
              <SignatureRow key={issue.id} issue={issue} />
            ))}
          </div>
        ) : null}
      </div>

      <div className={ISSUE_ACTIONS_CLASS}>
        {problem.jiraIssueKey ? (
          <a
            className={cn(OBSERVABILITY_LINK_CLASS, "mono")}
            href={problem.jiraIssueUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
          >
            {problem.jiraIssueKey}
            <ExternalLink size={12} strokeWidth={2} />
          </a>
        ) : null}
        {problem.regressionTest ? (
          <RegressionTestLink test={problem.regressionTest} />
        ) : null}
        {problem.regressionTest?.taskRunId || problem.aiTriage?.taskRunId ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto p-0 text-muted-foreground"
            onClick={onOpenActivity}
          >
            <History size={12} /> Run
          </Button>
        ) : null}
        {problem.explorerUrl ? (
          <Tip label="Open the loudest log line's search in the Datadog log explorer">
            <a
              className={OBSERVABILITY_LINK_CLASS}
              href={problem.explorerUrl}
              target="_blank"
              rel="noreferrer"
            >
              Datadog
              <ExternalLink size={12} strokeWidth={2} />
            </a>
          </Tip>
        ) : null}
        <Tip
          label={problem.fixInFlight ? "A fix is already running for this ticket" : undefined}
        >
          <span className="inline-flex">
            <Button
              type="button"
              variant="outline"
              size="sm"
              // In-flight rather than "already filed": a problem still logging after its
              // fix merged is worth another attempt on the same ticket.
              disabled={busy || fixDisabled || problem.fixInFlight}
              onClick={onFix}
            >
              <Wand2 size={13} strokeWidth={2} />
              {problem.fixInFlight
                ? "Fixing…"
                : problem.jiraIssueKey
                  ? "Fix again"
                  : "Create ticket & fix"}
            </Button>
          </span>
        </Tip>
        <RegressionTestButton
          test={problem.regressionTest}
          inFlight={problem.regressionTestInFlight}
          disabled={testRefusal != null}
          disabledReason={testRefusal}
          busy={busy}
          onClick={onWriteTest}
        />
        <Tip
          label={
            problem.aiTriageInFlight
              ? "AI triage is already running"
              : problem.aiTriageRefusal ?? problem.aiTriage?.recommendation
          }
        >
          <span className="inline-flex">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || problem.aiTriageInFlight || problem.aiTriageRefusal != null}
              onClick={onTriage}
            >
              <Bot size={13} strokeWidth={2} />
              {problem.aiTriageInFlight
                ? "Triaging…"
                : problem.aiTriage
                  ? "Triage again"
                  : "AI triage"}
            </Button>
          </span>
        </Tip>
        <Tip label={problem.state === "dismissed" ? "Bring back" : "Dismiss"}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            onClick={() => onSetState(problem.state === "dismissed" ? "open" : "dismissed")}
          >
            <X size={14} strokeWidth={2} />
          </Button>
        </Tip>
      </div>
    </div>
  );
}

/**
 * Level three: one clustered signature, as evidence.
 *
 * No actions and no severity of its own — it exists so the problem above it can show
 * its workings, which matters because the grouping is a heuristic. A merge that looks
 * wrong should be visibly wrong, with the sampling fraction and the stack that linked
 * it right there.
 */
function SignatureRow({ issue }: { issue: DatadogIssueView }) {
  const fmt = useFormat();
  const [open, setOpen] = useState(false);

  return (
    <div>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="group h-auto w-full cursor-pointer items-baseline justify-start gap-1.5 rounded-none px-0 py-[3px] text-left font-[inherit] text-[0.7812rem] whitespace-normal text-[var(--text-faint)]"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown size={12} strokeWidth={2} />
        ) : (
          <ChevronRight size={12} strokeWidth={2} />
        )}
        <span className="mono min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground group-hover:text-primary">
          {issue.signature}
        </span>
        <Tip
          label={`Estimated from ${issue.sampleCount} of ${issue.sampleSize} sampled log bodies`}
        >
          <span className="whitespace-nowrap tabular-nums">
            {issue.service ? `${issue.service} · ` : ""}≈{fmt.number(issue.eventCount)}
          </span>
        </Tip>
      </Button>

      {open ? (
        <div className="mt-1.5 flex flex-col gap-2 rounded-[var(--radius)] border border-border bg-[var(--bg-deep)] px-3 py-2.5">
          {issue.sampleMessage ? (
            <div className={DETAIL_BLOCK_CLASS}>
              <span className={DETAIL_LABEL_CLASS}>Sample message</span>
              <pre className={cn(DETAIL_PRE_CLASS, "mono")}>{issue.sampleMessage}</pre>
            </div>
          ) : null}
          {issue.sampleStack ? (
            <div className={DETAIL_BLOCK_CLASS}>
              <span className={DETAIL_LABEL_CLASS}>Sample stack</span>
              <pre className={cn(DETAIL_PRE_CLASS, "mono")}>{issue.sampleStack}</pre>
            </div>
          ) : null}
          <div className={DETAIL_BLOCK_CLASS}>
            <span className={DETAIL_LABEL_CLASS}>Age</span>
            <span className={DETAIL_VALUE_CLASS}>
              first seen {ago(issue.firstSeenAt)} · last seen {ago(issue.lastSeenAt)}
            </span>
          </div>
          <div className={DETAIL_BLOCK_CLASS}>
            <span className={DETAIL_LABEL_CLASS}>Routing</span>
            <span className={cn(DETAIL_VALUE_CLASS, "mono")}>
              {issue.routedBy ?? "unrouted"}
            </span>
          </div>
          <div className={DETAIL_BLOCK_CLASS}>
            <span className={DETAIL_LABEL_CLASS}>Sampling</span>
            <span className={DETAIL_VALUE_CLASS}>
              {issue.sampleCount} of {issue.sampleSize} sampled log bodies fell in this
              cluster, and the occurrence count is that fraction of the service's exact
              error total — an estimate, not a measurement.
            </span>
          </div>
          {issue.status && issue.status !== "error" ? (
            <div className={DETAIL_BLOCK_CLASS}>
              <span className={DETAIL_LABEL_CLASS}>Status</span>
              <span className={cn(DETAIL_VALUE_CLASS, "mono")}>{issue.status}</span>
            </div>
          ) : null}
          {issue.kubeNamespace || issue.source ? (
            <div className={DETAIL_BLOCK_CLASS}>
              <span className={DETAIL_LABEL_CLASS}>Source</span>
              <span className={cn(DETAIL_VALUE_CLASS, "mono")}>
                {[issue.source, issue.kubeNamespace].filter(Boolean).join(" · ")}
              </span>
            </div>
          ) : null}
          {issue.host ? (
            <div className={DETAIL_BLOCK_CLASS}>
              <span className={DETAIL_LABEL_CLASS}>Sample host</span>
              <span className={cn(DETAIL_VALUE_CLASS, "mono")}>{issue.host}</span>
            </div>
          ) : null}
          {issue.explorerUrl ? (
            <div className={DETAIL_BLOCK_CLASS}>
              <a
                className={OBSERVABILITY_LINK_CLASS}
                href={issue.explorerUrl}
                target="_blank"
                rel="noreferrer"
              >
                This log line in Datadog
                <ExternalLink size={12} strokeWidth={2} />
              </a>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Who owns it, and a hint at why.
 *
 * The area is always known — everything falls through to `backend` at worst — but
 * the team is only known when a rule matched, and an unowned problem is worth showing
 * as unowned rather than quietly attributing to the area.
 */
function Owner({
  problem,
  routedBy,
}: {
  problem: DatadogProblemView;
  routedBy: string | null;
}) {
  const label = problem.team ?? problem.area;
  return (
    <Tip label={routedBy ? `Routed by ${routedBy}` : "No routing rule matched"}>
      <span className="border-l border-border pl-2 text-[0.7812rem] text-[var(--text-faint)]">
        {label}
        {problem.team && problem.team !== problem.area ? ` · ${problem.area}` : ""}
      </span>
    </Tip>
  );
}

/**
 * `≈1,709,600 · ↑3.2×` — the estimate and, when there is one, the trend.
 *
 * The trend is load-bearing here in a way it is not elsewhere: severity is decided
 * from it, so this is the working shown for a row marked critical.
 */
function Count({ problem }: { problem: DatadogProblemView }) {
  const fmt = useFormat();
  const previous = problem.previousEventCount;
  // A ratio rather than a delta: going from 400 to 1,200 matters and from 400,000
  // to 400,800 does not, and only the ratio distinguishes the two.
  const ratio = previous != null && previous > 0 ? problem.eventCount / previous : null;
  const changed = ratio != null && (ratio >= 1.25 || ratio <= 0.8);

  return (
    <Tip label="The largest log line's estimate, not the sum — the members are the same occurrences">
      <span>
        <span className="text-muted-foreground tabular-nums">
          ≈{fmt.number(problem.eventCount)}
        </span>{" "}
        occurrences
        {changed ? (
          <span
            className={cn(
              "ml-1.5 inline-flex items-center gap-0.5 text-[0.7812rem] font-semibold",
              ratio! >= 1 ? "text-[var(--status-danger)]" : "text-[var(--status-success)]",
            )}
          >
            {ratio! >= 1 ? (
              <TrendingUp size={11} strokeWidth={2} />
            ) : (
              <TrendingDown size={11} strokeWidth={2} />
            )}
            {ratio! >= 1 ? `${ratio!.toFixed(1)}×` : `${(1 / ratio!).toFixed(1)}× fewer`}
          </span>
        ) : null}
      </span>
    </Tip>
  );
}
