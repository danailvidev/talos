import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  Search,
  Sparkles,
  Ticket,
} from "lucide-react";

import {
  api,
  type AutomationFailureClusterDetailView,
  type AutomationFailureClusterListView,
  type AutomationFailureClusterView,
  type AutomationPipelineDetailView,
} from "./api.ts";
import {
  AUTOMATION_BULK_TICKET_LIMIT,
  AUTOMATION_TRIAGE_PREFERENCE_KEY,
  automationAiTriageVerdictLabel,
  automationClusterActionState,
  automationFailureWorkStatus,
  canSelectForTicket,
  parseAutomationTriageFilters,
  selectablePageKeys,
  updateClusterSelection,
} from "./automation-triage.ts";
import { AutomationJiraTicketDialog } from "./AutomationJiraTicketDialog.tsx";
import { usePreference } from "./PreferencesContext.tsx";
import { invalidate, queries } from "./queries.ts";
import { useApi, type AsyncQuery } from "./useApi.ts";
import { useToasts } from "./Toast.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { TitleInfo } from "./TitleInfo.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card.tsx";
import { Checkbox } from "./components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.tsx";
import { Input } from "./components/ui/input.tsx";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip.tsx";
import { cn } from "./lib/utils.ts";

interface TicketOutcome {
  signatureKey: string;
  ok: boolean;
  message: string;
  jiraUrl?: string;
}

export function AutomationFailureTriage({
  pipeline,
}: {
  pipeline: AutomationPipelineDetailView;
}) {
  const queryClient = useQueryClient();
  const { push } = useToasts();
  const [filters, setFilters] = usePreference(
    AUTOMATION_TRIAGE_PREFERENCE_KEY,
    parseAutomationTriageFilters,
  );
  const [search, setSearch] = useState(filters.search);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [detailKey, setDetailKey] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [ticketKey, setTicketKey] = useState("");
  const [triageBusyKeys, setTriageBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const [triageErrors, setTriageErrors] = useState<Record<string, string>>({});
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<TicketOutcome[]>([]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(filters.search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [filters.search]);

  useEffect(() => {
    setOffset(0);
    setSelected(new Set());
  }, [search, filters.jobId, filters.suiteIndex, filters.state, filters.limit]);

  const pageFilter = {
    limit: filters.limit,
    offset,
    ...(search ? { search } : {}),
    ...(filters.jobId == null ? {} : { jobId: filters.jobId }),
    ...(filters.suiteIndex == null ? {} : { suiteIndex: filters.suiteIndex }),
    ...(filters.state == null ? {} : { state: filters.state }),
  } as const;
  const clusters = useApi(
    queries.automationFailureClusters(pipeline.pipelineId, pageFilter),
  );
  const summary = useApi(
    queries.automationFailureClusters(pipeline.pipelineId, {
      limit: 25,
      offset: 0,
    }),
  );
  const detail = useApi(
    queries.automationFailureCluster(
      pipeline.pipelineId,
      detailKey,
      detailOpen,
    ),
  );

  useEffect(() => {
    if (!clusters.data || clusters.data.total === 0 || offset < clusters.data.total) {
      return;
    }
    setOffset(
      Math.max(0, Math.floor((clusters.data.total - 1) / filters.limit) * filters.limit),
    );
  }, [clusters.data, filters.limit, offset]);

  const jobNames = useMemo(
    () =>
      new Map(
        (summary.data?.facets.jobs ?? []).map((job) => [job.jobId, job.name]),
      ),
    [summary.data],
  );
  const suiteNames = useMemo(
    () =>
      new Map(
        (summary.data?.facets.suites ?? []).map((suite) => [
          suite.suiteIndex,
          suite.name,
        ]),
      ),
    [summary.data],
  );
  const selectable = selectablePageKeys(clusters.data?.items ?? []);
  const selectedVisible = selectable.filter((key) => selected.has(key));
  const allVisibleSelected =
    selectable.length > 0 && selectedVisible.length === selectable.length;

  function updateFilters(next: Partial<typeof filters>) {
    setFilters({ ...filters, ...next });
  }

  function openDetail(signatureKey: string) {
    setDetailKey(signatureKey);
    setDetailOpen(true);
  }

  function togglePage(checked: boolean) {
    if (!checked) {
      setSelected(new Set());
      return;
    }
    setSelected(
      new Set(selectable.slice(0, AUTOMATION_BULK_TICKET_LIMIT)),
    );
  }

  function createTicket(cluster: AutomationFailureClusterView) {
    if (!canSelectForTicket(cluster) || cluster.ticketRefusal) return;
    setTicketKey(cluster.signatureKey);
  }

  async function triageCluster(cluster: AutomationFailureClusterView) {
    if (
      cluster.aiTriageInFlight ||
      cluster.aiTriageRefusal ||
      triageBusyKeys.has(cluster.signatureKey)
    ) {
      return;
    }
    setTriageBusyKeys((current) => new Set(current).add(cluster.signatureKey));
    setTriageErrors((current) => {
      const next = { ...current };
      delete next[cluster.signatureKey];
      return next;
    });
    try {
      const result = await api.triageAutomationFailure(
        pipeline.pipelineId,
        cluster.signatureKey,
      );
      push(result.message, {
        severity: result.queued ? "success" : "info",
      });
      await invalidate.automationFailureTriage(
        queryClient,
        pipeline.pipelineId,
        [cluster.signatureKey],
      );
      invalidate.jobQueue(queryClient);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTriageErrors((current) => ({
        ...current,
        [cluster.signatureKey]: message,
      }));
      push(message, { severity: "error" });
    } finally {
      setTriageBusyKeys((current) => {
        const next = new Set(current);
        next.delete(cluster.signatureKey);
        return next;
      });
    }
  }

  async function createSingleTicket() {
    const signatureKeys = [...selected].slice(0, AUTOMATION_BULK_TICKET_LIMIT);
    if (signatureKeys.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    setBulkOpen(false);
    setOutcomes([]);
    try {
      const response = await api.createAutomationFailureTickets(
        pipeline.pipelineId,
        { signatureKeys },
      );
      const failed = response.results.find((entry) => !entry.ok);
      const succeeded = response.results.find((entry) => entry.ok);
      if (failed || !succeeded) {
        const message = failed?.error ?? "The pipeline ticket was not created.";
        setOutcomes([
          {
            signatureKey: `${signatureKeys.length} selected failure clusters`,
            ok: false,
            message,
          },
        ]);
        push(message, { severity: "warning" });
      } else {
        const message = succeeded.result.jiraKey
          ? `${succeeded.result.jiraKey} · ${succeeded.result.action}`
          : succeeded.result.action;
        setOutcomes([
          {
            signatureKey: `${signatureKeys.length} selected failure clusters`,
            ok: true,
            message,
            ...(succeeded.result.jiraUrl
              ? { jiraUrl: succeeded.result.jiraUrl }
              : {}),
          },
        ]);
        setSelected((current) => {
          const next = new Set(current);
          for (const key of signatureKeys) next.delete(key);
          return next;
        });
        push(
          succeeded.result.jiraKey
            ? `${succeeded.result.jiraKey} covers ${signatureKeys.length} selected failure clusters.`
            : `Pipeline ticket action completed: ${succeeded.result.action}.`,
          { severity: "success" },
        );
      }
      invalidate.automationFailureTriage(
        queryClient,
        pipeline.pipelineId,
        signatureKeys,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOutcomes(
        signatureKeys.map((signatureKey) => ({
          signatureKey,
          ok: false,
          message,
        })),
      );
      push(message, { severity: "error" });
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <>
      <TriageKpis summary={summary} />

      <Card className="shrink-0 border-[var(--status-danger)]/25">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-[var(--status-danger-strong)]" />
            Failure clusters
            <TitleInfo>
              Failures are grouped by normalized root cause. Open a row to load
              diagnostics, affected tests, and screenshots.
            </TitleInfo>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2 lg:grid-cols-[minmax(240px,1fr)_180px_180px_170px_110px]">
            <label className="relative">
              <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
              <Input
                value={filters.search}
                maxLength={200}
                className="h-8 w-full pl-8"
                placeholder="Search signature, test, class, or job"
                aria-label="Search failure clusters"
                onChange={(event) =>
                  updateFilters({ search: event.currentTarget.value })
                }
              />
            </label>
            <Select
              value={filters.jobId == null ? "all" : String(filters.jobId)}
              onValueChange={(value) =>
                updateFilters({
                  jobId: value === "all" ? undefined : Number(value),
                })
              }
            >
              <SelectTrigger className="cursor-pointer" aria-label="Filter by job">
                <SelectValue placeholder="All jobs" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All jobs</SelectItem>
                {(summary.data?.facets.jobs ?? []).map((job) => (
                  <SelectItem key={job.jobId} value={String(job.jobId)}>
                    {job.name} ({job.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={
                filters.suiteIndex == null ? "all" : String(filters.suiteIndex)
              }
              onValueChange={(value) =>
                updateFilters({
                  suiteIndex: value === "all" ? undefined : Number(value),
                })
              }
            >
              <SelectTrigger className="cursor-pointer" aria-label="Filter by suite">
                <SelectValue placeholder="All suites" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All suites</SelectItem>
                {(summary.data?.facets.suites ?? []).map((suite) => (
                  <SelectItem
                    key={suite.suiteIndex}
                    value={String(suite.suiteIndex)}
                  >
                    {suite.name || `Suite ${suite.suiteIndex + 1}`} ({suite.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={filters.state ?? "all"}
              onValueChange={(value) =>
                updateFilters({
                  state:
                    value === "all"
                      ? undefined
                      : (value as "untriaged" | "ticketed" | "active-mr"),
                })
              }
            >
              <SelectTrigger className="cursor-pointer" aria-label="Filter by ticket state">
                <SelectValue placeholder="All ticket states" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All ticket states</SelectItem>
                <SelectItem value="untriaged">No ticket</SelectItem>
                <SelectItem value="ticketed">Ticketed</SelectItem>
                <SelectItem value="active-mr">Active MR</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(filters.limit)}
              onValueChange={(value) =>
                updateFilters({ limit: value === "50" ? 50 : 25 })
              }
            >
              <SelectTrigger className="cursor-pointer" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">25 / page</SelectItem>
                <SelectItem value="50">50 / page</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border border-border bg-muted/25 px-3 py-2">
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              {selected.size} selected
              <TitleInfo>
                One pipeline ticket can include up to {AUTOMATION_BULK_TICKET_LIMIT} selected
                failure clusters.
              </TitleInfo>
            </span>
            <Button
              type="button"
              disabled={selected.size === 0 || bulkBusy}
              onClick={() => setBulkOpen(true)}
            >
              {bulkBusy ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Ticket className="size-4" />
              )}
              Create single ticket
            </Button>
          </div>

          {outcomes.length > 0 ? (
            <div
              className="grid gap-1 rounded-[var(--radius)] border border-border p-3 text-sm"
              aria-live="polite"
            >
              <p className="mb-1 font-medium">Pipeline ticket outcome</p>
              {outcomes.map((outcome) => (
                <div
                  key={outcome.signatureKey}
                  className="flex min-w-0 items-center gap-2"
                >
                  {outcome.ok ? (
                    <CheckCircle2 className="size-4 shrink-0 text-success" />
                  ) : (
                    <AlertTriangle className="size-4 shrink-0 text-destructive" />
                  )}
                  <span className="min-w-0 truncate font-mono text-xs">
                    {outcome.signatureKey}
                  </span>
                  {outcome.jiraUrl ? (
                    <a
                      href={outcome.jiraUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="cursor-pointer font-medium hover:underline"
                    >
                      {outcome.message}
                    </a>
                  ) : (
                    <span className={cn(!outcome.ok && "text-destructive")}>
                      {outcome.message}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          {!clusters.data && clusters.loading ? (
            <div className="flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              Loading failure clusters…
            </div>
          ) : !clusters.data && clusters.error ? (
            <div
              className="rounded-[var(--radius)] border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
              role="alert"
            >
              Could not load failure clusters: {clusters.error}
            </div>
          ) : clusters.data ? (
            <>
              {clusters.error ? (
                <div
                  className="rounded-[var(--radius)] border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                  role="alert"
                >
                  Refresh failed: {clusters.error}. Showing the last available page.
                </div>
              ) : null}
              {clusters.data.items.length === 0 ? (
                <div className="rounded-[var(--radius)] border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                  {summary.data?.total === 0
                    ? "No failed or errored tests were clustered for this pipeline."
                    : "No failure clusters match these filters."}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-[var(--radius)] border border-border">
                  <Table className="table-fixed min-w-[960px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <Checkbox
                            className="cursor-pointer"
                            checked={
                              allVisibleSelected
                                ? true
                                : selectedVisible.length > 0
                                  ? "indeterminate"
                                  : false
                            }
                            disabled={selectable.length === 0}
                            aria-label="Select visible clusters without tickets"
                            onCheckedChange={(checked) => togglePage(checked === true)}
                          />
                        </TableHead>
                        <TableHead>Failure signature</TableHead>
                        <TableHead className="w-16 text-right">Tests</TableHead>
                        <TableHead className="w-24 text-right">Occurrences</TableHead>
                        <TableHead className="w-[22%]">Jobs / suites</TableHead>
                        <TableHead className="w-24">AI triage</TableHead>
                        <TableHead className="w-28">Ticket state</TableHead>
                        <TableHead className="w-32">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {clusters.data.items.map((cluster) => (
                        <ClusterRow
                          key={cluster.signatureKey}
                          cluster={cluster}
                          checked={selected.has(cluster.signatureKey)}
                          selectionFull={
                            selected.size >= AUTOMATION_BULK_TICKET_LIMIT &&
                            !selected.has(cluster.signatureKey)
                          }
                          ticketBusy={false}
                          triageBusy={triageBusyKeys.has(cluster.signatureKey)}
                          ticketError={undefined}
                          triageError={triageErrors[cluster.signatureKey]}
                          jobNames={jobNames}
                          suiteNames={suiteNames}
                          onOpen={() => openDetail(cluster.signatureKey)}
                          onCheckedChange={(checked) =>
                            setSelected((current) =>
                              updateClusterSelection(
                                current,
                                cluster.signatureKey,
                                checked,
                                canSelectForTicket(cluster),
                              ),
                            )
                          }
                          onCreate={() => void createTicket(cluster)}
                          onTriage={() => void triageCluster(cluster)}
                        />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              <Pagination
                offset={offset}
                limit={filters.limit}
                total={clusters.data.total}
                fetching={clusters.fetching}
                onOffsetChange={setOffset}
              />
            </>
          ) : null}
        </CardContent>
      </Card>

      <AlertDialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create one Jira ticket?</AlertDialogTitle>
            <AlertDialogDescription>
              TALOS will create or adopt one ticket for pipeline #{pipeline.pipelineId}.
              Its description will list the failed tests from all {selected.size} selected
              failure clusters.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="cursor-pointer"
              onClick={() => void createSingleTicket()}
            >
              Create single ticket
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ClusterDetailDialog
        pipelineId={pipeline.pipelineId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        detail={detail}
        ticketBusy={false}
        triageBusy={detailKey ? triageBusyKeys.has(detailKey) : false}
        ticketError={undefined}
        triageError={detailKey ? triageErrors[detailKey] : undefined}
        onCreate={(cluster) => void createTicket(cluster)}
        onTriage={(cluster) => void triageCluster(cluster)}
      />
      {ticketKey ? (
        <AutomationJiraTicketDialog
          pipelineId={pipeline.pipelineId}
          signatureKey={ticketKey}
          onClose={() => setTicketKey("")}
          onCreated={() =>
            setSelected((current) => {
              const next = new Set(current);
              next.delete(ticketKey);
              return next;
            })
          }
        />
      ) : null}
    </>
  );
}

/** Shared lazy detail used by both pipeline triage and the cross-pipeline inbox. */
export function AutomationFailureClusterDialog({
  pipelineId,
  signatureKey,
  open,
  onOpenChange,
}: {
  pipelineId: number;
  signatureKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { push } = useToasts();
  const detail = useApi(
    queries.automationFailureCluster(pipelineId, signatureKey, open),
  );
  const [ticketOpen, setTicketOpen] = useState(false);
  const [triageBusy, setTriageBusy] = useState(false);
  const [triageError, setTriageError] = useState<string>();

  const createTicket = async (cluster: AutomationFailureClusterView) => {
    if (cluster.ticketRefusal) return;
    setTicketOpen(true);
  };

  const triage = async (cluster: AutomationFailureClusterView) => {
    if (triageBusy || cluster.aiTriageInFlight || cluster.aiTriageRefusal) return;
    setTriageBusy(true);
    setTriageError(undefined);
    try {
      const result = await api.triageAutomationFailure(
        pipelineId,
        cluster.signatureKey,
      );
      push(result.message, { severity: result.queued ? "success" : "info" });
      await invalidate.automationFailureTriage(queryClient, pipelineId, [
        cluster.signatureKey,
      ]);
      invalidate.jobQueue(queryClient);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTriageError(message);
      push(message, { severity: "error" });
    } finally {
      setTriageBusy(false);
    }
  };

  return (
    <>
      <ClusterDetailDialog
        pipelineId={pipelineId}
        open={open}
        onOpenChange={onOpenChange}
        detail={detail}
        ticketBusy={false}
        triageBusy={triageBusy}
        triageError={triageError}
        onCreate={(cluster) => void createTicket(cluster)}
        onTriage={(cluster) => void triage(cluster)}
      />
      {ticketOpen ? (
        <AutomationJiraTicketDialog
          pipelineId={pipelineId}
          signatureKey={signatureKey}
          onClose={() => setTicketOpen(false)}
        />
      ) : null}
    </>
  );
}

function TriageKpis({
  summary,
}: {
  summary: AsyncQuery<AutomationFailureClusterListView>;
}) {
  const data = summary.data;
  const values = [
    ["Total clusters", data?.total],
    ["No ticket", data?.facets.states.untriaged],
    ["Ticketed", data?.facets.states.ticketed],
    ["Active MR", data?.facets.states["active-mr"]],
  ] as const;
  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Failure triage summary">
      {values.map(([label, value]) => (
        <Card key={label} size="sm">
          <CardHeader>
            <CardDescription>{label}</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums">
              {value == null ? "—" : value.toLocaleString()}
            </CardTitle>
          </CardHeader>
        </Card>
      ))}
      {summary.error ? (
        <p className="text-sm text-destructive sm:col-span-2 xl:col-span-4" role="alert">
          Could not refresh triage totals: {summary.error}
        </p>
      ) : null}
    </section>
  );
}

function ClusterRow({
  cluster,
  checked,
  selectionFull,
  ticketBusy,
  triageBusy,
  ticketError,
  triageError,
  jobNames,
  suiteNames,
  onOpen,
  onCheckedChange,
  onCreate,
  onTriage,
}: {
  cluster: AutomationFailureClusterView;
  checked: boolean;
  selectionFull: boolean;
  ticketBusy: boolean;
  triageBusy: boolean;
  ticketError?: string;
  triageError?: string;
  jobNames: ReadonlyMap<number, string>;
  suiteNames: ReadonlyMap<number, string>;
  onOpen: () => void;
  onCheckedChange: (checked: boolean) => void;
  onCreate: () => void;
  onTriage: () => void;
}) {
  const selectable = canSelectForTicket(cluster);
  const jobLabels = [
    ...new Set(cluster.jobIds.map((id) => jobNames.get(id) ?? `Job #${id}`)),
  ];
  const jobLabelSet = new Set(jobLabels);
  const suiteLabels = [
    ...new Set(
      cluster.suiteIndexes.map(
        (index) => suiteNames.get(index) || `Suite ${index + 1}`,
      ),
    ),
  ].filter((name) => !jobLabelSet.has(name));
  const jobs = jobLabels.join(", ");
  const suites = suiteLabels.join(", ");
  const primaryJobOrSuite = jobs || suites || "No job or suite";
  const secondarySuites = jobs ? suites : "";
  const sample = cluster.sampleClassname
    ? `${cluster.sampleClassname} · ${cluster.sampleTestName}`
    : cluster.sampleTestName;
  return (
    <TableRow
      role="button"
      tabIndex={0}
      aria-label={`Open details for ${cluster.title}`}
      className="cursor-pointer align-top hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (
          event.target === event.currentTarget &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <TableCell onClick={(event) => event.stopPropagation()}>
        <Checkbox
          className="cursor-pointer"
          checked={checked}
          disabled={!selectable || (selectionFull && !checked)}
          aria-label={`Select ${cluster.title}`}
          onCheckedChange={(value) => onCheckedChange(value === true)}
        />
      </TableCell>
      <TableCell className="min-w-0">
        <div className="flex items-start gap-2">
          <StatusBadge status={cluster.severity === "error" ? "warn" : "failure"}>
            {cluster.severity}
          </StatusBadge>
          <div className="min-w-0 flex-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="truncate font-medium">{cluster.title}</p>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="max-w-lg whitespace-normal break-words"
              >
                {cluster.title}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {sample}
                </p>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="max-w-lg whitespace-normal break-words font-mono"
              >
                {sample}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {cluster.affectedTestCount.toLocaleString()}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {cluster.occurrenceCount.toLocaleString()}
      </TableCell>
      <TableCell className="max-w-64 text-xs">
        <p className="truncate" title={primaryJobOrSuite}>
          {primaryJobOrSuite}
        </p>
        {secondarySuites ? (
          <p
            className="mt-1 truncate text-muted-foreground"
            title={secondarySuites}
          >
            {secondarySuites}
          </p>
        ) : null}
      </TableCell>
      <TableCell>
        {triageBusy || cluster.aiTriageInFlight ? (
          <StatusBadge status="running" showIcon={false}>
            <LoaderCircle className="mr-1 size-3 animate-spin" />
            triaging
          </StatusBadge>
        ) : cluster.aiTriage ? (
          <AiTriageCompact result={cluster.aiTriage} />
        ) : (
          <span className="text-xs text-muted-foreground">Not run</span>
        )}
      </TableCell>
      <TableCell>
        <ClusterState cluster={cluster} />
      </TableCell>
      <TableCell onClick={(event) => event.stopPropagation()}>
        <ClusterActions
          cluster={cluster}
          ticketBusy={ticketBusy}
          triageBusy={triageBusy}
          ticketError={ticketError}
          triageError={triageError}
          onCreate={onCreate}
          onTriage={onTriage}
          compact
        />
      </TableCell>
    </TableRow>
  );
}

function ClusterState({ cluster }: { cluster: AutomationFailureClusterView }) {
  if (
    !cluster.creating &&
    cluster.triageState === "ticketed" &&
    cluster.work?.jiraKey
  ) {
    return null;
  }
  return (
    <StatusBadge status={automationFailureWorkStatus(cluster)}>
      {cluster.creating ? (
        <>
          <LoaderCircle className="mr-1 size-3 animate-spin" />
          creating
        </>
      ) : cluster.triageState === "untriaged" ? (
        "no ticket"
      ) : (
        cluster.triageState.replace("-", " ")
      )}
    </StatusBadge>
  );
}

function ClusterActions({
  cluster,
  ticketBusy,
  triageBusy,
  ticketError,
  triageError,
  onCreate,
  onTriage,
  align = "start",
  compact = false,
}: {
  cluster: AutomationFailureClusterView;
  ticketBusy: boolean;
  triageBusy: boolean;
  ticketError?: string;
  triageError?: string;
  onCreate: () => void;
  onTriage: () => void;
  align?: "start" | "end";
  compact?: boolean;
}) {
  const state = automationClusterActionState(cluster, {
    ticketBusy,
    triageBusy,
  });
  const actionBusy = ticketBusy || state.triage.active;
  return (
    <div
      className={cn(
        "grid gap-1.5",
        compact ? "min-w-0" : "min-w-44",
        align === "end" ? "justify-items-end text-right" : "justify-items-start",
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="h-auto w-fit gap-1.5 rounded-md border-[color-mix(in_srgb,var(--action)_45%,var(--border))] bg-[color-mix(in_srgb,var(--action)_10%,transparent)] px-[13px] py-[7px] text-sm font-medium text-foreground hover:border-action hover:bg-action/20 data-[state=open]:border-action data-[state=open]:bg-action/20"
          >
            {actionBusy ? (
              <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />
            ) : null}
            Actions
            <ChevronDown size={13} strokeWidth={2} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={align}
          sideOffset={6}
          className="z-50 min-w-65 rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] p-1.5 shadow-[var(--shadow-panel)]"
        >
          <DropdownMenuItem
            className="cursor-pointer items-start gap-2 px-2 py-2 data-disabled:cursor-not-allowed"
            disabled={state.ticket.disabled}
            onSelect={onCreate}
          >
            {ticketBusy ? (
              <LoaderCircle className="mt-0.5 size-4 animate-spin" />
            ) : (
              <Ticket className="mt-0.5 size-4" />
            )}
            <span className="grid gap-0.5">
              <span>Create Jira ticket</span>
              {state.ticket.reason ? (
                <span className="max-w-60 text-xs leading-snug text-muted-foreground">
                  {state.ticket.reason}
                </span>
              ) : null}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer items-start gap-2 px-2 py-2 data-disabled:cursor-not-allowed"
            disabled={state.triage.disabled}
            onSelect={onTriage}
          >
            {state.triage.active ? (
              <LoaderCircle className="mt-0.5 size-4 animate-spin" />
            ) : (
              <Sparkles className="mt-0.5 size-4" />
            )}
            <span className="grid gap-0.5">
              <span>{state.triage.label}</span>
              {state.triage.reason ? (
                <span className="max-w-60 text-xs leading-snug text-muted-foreground">
                  {state.triage.reason}
                </span>
              ) : null}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ClusterWorkLinks cluster={cluster} />
      {ticketError ? (
        <p className="max-w-64 break-words text-xs text-destructive" role="alert">
          {ticketError}
        </p>
      ) : null}
      {triageError ? (
        <p className="max-w-64 break-words text-xs text-destructive" role="alert">
          {triageError}
        </p>
      ) : null}
    </div>
  );
}

function ClusterWorkLinks({
  cluster,
}: {
  cluster: Pick<AutomationFailureClusterView, "work">;
}) {
  const work = cluster.work;
  if (!work?.jiraUrl && !work?.mrUrl) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {work.mrUrl ? (
        <a
          href={work.mrUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex cursor-pointer items-center gap-1 font-medium hover:underline"
        >
          <GitPullRequest className="size-3.5" />
          MR !{work.mrIid}
        </a>
      ) : null}
      {work.jiraUrl ? (
        <a
          href={work.jiraUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex cursor-pointer items-center gap-1 font-medium hover:underline"
        >
          <Ticket className="size-3.5" />
          {work.jiraKey}
        </a>
      ) : null}
    </div>
  );
}

function AiTriageCompact({
  result,
}: {
  result: NonNullable<AutomationFailureClusterView["aiTriage"]>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex rounded-[var(--radius-compact)] border border-border bg-muted/50 px-1.5 py-0.5 text-xs font-medium">
        {automationAiTriageVerdictLabel(result.verdict)}
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">
        {Math.round(result.confidence * 100)}%
      </span>
    </div>
  );
}

function Pagination({
  offset,
  limit,
  total,
  fetching,
  onOffsetChange,
}: {
  offset: number;
  limit: number;
  total: number;
  fetching: boolean;
  onOffsetChange: (offset: number) => void;
}) {
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
      <span>
        {start.toLocaleString()}–{end.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={offset === 0 || fetching}
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
        >
          <ChevronLeft className="size-4" />
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={offset + limit >= total || fetching}
          onClick={() => onOffsetChange(offset + limit)}
        >
          Next
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function ClusterDetailDialog({
  pipelineId,
  open,
  onOpenChange,
  detail,
  ticketBusy,
  triageBusy,
  ticketError,
  triageError,
  onCreate,
  onTriage,
}: {
  pipelineId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: AsyncQuery<AutomationFailureClusterDetailView>;
  ticketBusy: boolean;
  triageBusy: boolean;
  ticketError?: string;
  triageError?: string;
  onCreate: (cluster: AutomationFailureClusterView) => void;
  onTriage: (cluster: AutomationFailureClusterView) => void;
}) {
  const data = detail.data;
  const dialogRef = useRef<HTMLDivElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [imageFailed, setImageFailed] = useState(false);
  const attachment = data?.members.find(
    (member) => member.attachmentProxyUrl && member.attachmentUrl,
  );

  useEffect(() => {
    setPreviewUrl(undefined);
    setImageFailed(false);
  }, [attachment?.attachmentProxyUrl, pipelineId]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          ref={dialogRef}
          className="max-h-[90vh] w-[calc(100vw-2rem)] overflow-x-hidden overflow-y-auto sm:max-w-4xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            dialogRef.current?.focus();
          }}
        >
          <DialogHeader>
            <div className="flex items-start gap-3 pr-8">
              <DialogTitle className="flex min-w-0 items-center gap-2">
                {data?.title ?? "Failure cluster details"}
                <TitleInfo>
                  Diagnostics and attachments are loaded only while this cluster is open.
                </TitleInfo>
              </DialogTitle>
              {data ? (
                <ClusterActions
                  cluster={data}
                  ticketBusy={ticketBusy}
                  triageBusy={triageBusy}
                  ticketError={ticketError}
                  triageError={triageError}
                  onCreate={() => onCreate(data)}
                  onTriage={() => onTriage(data)}
                />
              ) : null}
            </div>
            <DialogDescription className="sr-only">
              Failure cluster diagnostics, affected tests, attachments, and Jira actions.
            </DialogDescription>
          </DialogHeader>
          {!data && detail.loading ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              Loading cluster details…
            </div>
          ) : !data && detail.error ? (
            <div className="rounded-[var(--radius)] border border-destructive/40 bg-destructive/10 p-4 text-destructive" role="alert">
              {detail.error}
            </div>
          ) : data ? (
            <div className="grid min-w-0 gap-5">
              <div className="flex flex-wrap items-center gap-2">
                <ClusterState cluster={data} />
                <StatusBadge status={data.severity === "error" ? "warn" : "failure"}>
                  {data.severity}
                </StatusBadge>
                <span className="text-sm text-muted-foreground">
                  {data.affectedTestCount} affected tests · {data.occurrenceCount} occurrences
                </span>
                <a
                  href={data.pipelineUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto inline-flex cursor-pointer items-center gap-1 font-medium hover:underline"
                >
                  Pipeline #{data.pipelineId}
                  <ExternalLink className="size-4" />
                </a>
              </div>

              {data.aiTriage ? (
                <AiTriageDetail result={data.aiTriage} />
              ) : null}

              {detail.error ? (
                <p className="text-sm text-destructive" role="alert">
                  Refresh failed: {detail.error}. Showing cached details.
                </p>
              ) : null}

              <section>
                <h3 className="mb-2 flex items-center gap-2 font-semibold">
                  Affected tests
                  {data.membersTruncated ? (
                    <TitleInfo>
                      Showing the first 100 occurrences. Use the filters or GitLab pipeline for the
                      complete report.
                    </TitleInfo>
                  ) : null}
                </h3>
                <div className="max-h-64 overflow-y-auto rounded-[var(--radius)] border border-border">
                  {data.members.map((member) => (
                    <div
                      key={`${member.suiteIndex}-${member.caseIndex}`}
                      role={member.jobUrl ? "link" : undefined}
                      tabIndex={member.jobUrl ? 0 : undefined}
                      aria-label={
                        member.jobUrl
                          ? `Open ${member.jobName ?? `job ${member.jobId}`} in GitLab`
                          : undefined
                      }
                      className={cn(
                        "flex flex-wrap items-start justify-between gap-2 border-b border-border px-3 py-2 last:border-b-0",
                        member.jobUrl &&
                          "cursor-pointer transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                      )}
                      onClick={() => {
                        if (member.jobUrl) {
                          window.open(
                            member.jobUrl,
                            "_blank",
                            "noopener,noreferrer",
                          );
                        }
                      }}
                      onKeyDown={(event) => {
                        if (
                          !member.jobUrl ||
                          (event.key !== "Enter" && event.key !== " ")
                        ) {
                          return;
                        }
                        event.preventDefault();
                        window.open(
                          member.jobUrl,
                          "_blank",
                          "noopener,noreferrer",
                        );
                      }}
                    >
                      <div className="min-w-0">
                        <p className="break-words font-medium">{member.name}</p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {member.classname ?? "Unknown class"} · {member.suiteName}
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {member.jobName ??
                          (member.jobId != null
                            ? `Job #${member.jobId}`
                            : "Job unavailable")}
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              {data.representative.stackTrace ? (
                <Diagnostic label="Representative stack trace" value={data.representative.stackTrace} />
              ) : null}
              {data.representative.systemOutput ? (
                <Diagnostic label="Representative output" value={data.representative.systemOutput} />
              ) : null}

              {attachment ? (
                <section>
                  <h3 className="mb-2 font-semibold">Attachment</h3>
                  {imageFailed ? (
                    <div className="rounded-[var(--radius)] border border-dashed border-border p-6 text-sm text-muted-foreground">
                      The attachment preview could not be loaded.
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="block cursor-pointer overflow-hidden rounded-[var(--radius)] border border-border bg-muted/30"
                      onClick={() => setPreviewUrl(attachment.attachmentProxyUrl ?? undefined)}
                    >
                      <img
                        src={attachment.attachmentProxyUrl ?? undefined}
                        alt={attachment.attachmentName ?? "Failure attachment"}
                        className="max-h-64 max-w-full object-contain"
                        onError={() => setImageFailed(true)}
                      />
                    </button>
                  )}
                  <a
                    href={attachment.attachmentUrl ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex cursor-pointer items-center gap-1 text-sm font-medium hover:underline"
                  >
                    Open in GitLab artifact
                    <ExternalLink className="size-4" />
                  </a>
                </section>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={previewUrl != null} onOpenChange={(next) => !next && setPreviewUrl(undefined)}>
        <DialogContent className="max-h-[94vh] overflow-auto sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>{attachment?.attachmentName ?? "Attachment preview"}</DialogTitle>
            <DialogDescription className="sr-only">
              Full-size failure attachment preview.
            </DialogDescription>
          </DialogHeader>
          {previewUrl ? (
            <img
              src={previewUrl}
              alt={attachment?.attachmentName ?? "Failure attachment preview"}
              className="max-h-[80vh] w-full object-contain"
              onError={() => {
                setPreviewUrl(undefined);
                setImageFailed(true);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function AiTriageDetail({
  result,
}: {
  result: NonNullable<AutomationFailureClusterView["aiTriage"]>;
}) {
  return (
    <section className="grid min-w-0 gap-3 rounded-[var(--radius)] border border-border bg-muted/20 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">AI triage</h3>
        <span className="inline-flex rounded-[var(--radius-compact)] border border-border bg-background px-2 py-0.5 text-sm font-medium">
          {automationAiTriageVerdictLabel(result.verdict)}
        </span>
        <span className="text-sm tabular-nums text-muted-foreground">
          {Math.round(result.confidence * 100)}% confidence
        </span>
      </div>
      <div className="grid min-w-0 gap-1">
        <h4 className="text-sm font-medium">Rationale</h4>
        <p className="break-words text-sm leading-relaxed">{result.rationale}</p>
      </div>
      <div className="grid min-w-0 gap-1">
        <h4 className="text-sm font-medium">Recommendation</h4>
        <p className="break-words text-sm leading-relaxed">{result.recommendation}</p>
      </div>
    </section>
  );
}

function Diagnostic({ label, value }: { label: string; value: string }) {
  return (
    <section className="min-w-0 max-w-full">
      <h3 className="mb-2 font-semibold">{label}</h3>
      <pre className="block max-h-80 w-full min-w-0 max-w-full overflow-x-hidden overflow-y-auto rounded-[var(--radius)] border border-border bg-muted/40 p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words">
        {value}
      </pre>
    </section>
  );
}
