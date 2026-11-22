import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  LoaderCircle,
  Search,
  Sparkles,
  Ticket,
} from "lucide-react";

import {
  api,
  type AutomationFailureInboxItemView,
} from "./api.ts";
import {
  automationFailureInboxFilter,
  updateAutomationFailureRoute,
} from "./automation-failure-inbox.ts";
import { automationFailureWorkStatus } from "./automation-triage.ts";
import { AutomationFailureClusterDialog } from "./AutomationFailureTriage.tsx";
import { AutomationJiraTicketDialog } from "./AutomationJiraTicketDialog.tsx";
import type { AutomationFailureRoute } from "./route-state.ts";
import { invalidate, queries } from "./queries.ts";
import { useApi } from "./useApi.ts";
import { useToasts } from "./Toast.tsx";
import { ago } from "./format.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import { TalosAssigneeSelect } from "./TalosAssigneeSelect.tsx";
import { TitleInfo } from "./TitleInfo.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card.tsx";
import { Input } from "./components/ui/input.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.tsx";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
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

export function AutomationFailuresInbox({
  route,
  onRouteChange,
  onSelectPipeline,
}: {
  route?: AutomationFailureRoute;
  onRouteChange: (route: AutomationFailureRoute) => void;
  onSelectPipeline: (pipelineId: number) => void;
}) {
  const filter = automationFailureInboxFilter(route);
  const [search, setSearch] = useState(route?.q ?? "");
  const [selected, setSelected] = useState<{
    pipelineId: number;
    signatureKey: string;
  }>();
  const [ticketTarget, setTicketTarget] = useState<{
    pipelineId: number;
    signatureKey: string;
  }>();
  const inbox = useApi(queries.automationFailureInbox(filter));
  const schedules = useApi(
    queries.automationDashboard({
      days: filter.days,
      limit: 1,
      offset: 0,
    }),
  );

  useEffect(() => setSearch(route?.q ?? ""), [route?.q]);
  useEffect(() => {
    const next = search.trim();
    if (next === (route?.q ?? "")) return;
    const timer = window.setTimeout(
      () =>
        onRouteChange(
          updateAutomationFailureRoute(route, {
            q: next || undefined,
            offset: undefined,
          }),
        ),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [onRouteChange, route, search]);

  const update = (patch: Partial<AutomationFailureRoute>) =>
    onRouteChange(
      updateAutomationFailureRoute(route, { ...patch, offset: undefined }),
    );

  if (!inbox.data && inbox.loading) {
    return <Loading>Loading failure inbox…</Loading>;
  }
  if (!inbox.data && inbox.error) return <ErrorBox>{inbox.error}</ErrorBox>;
  if (!inbox.data) return null;

  const data = inbox.data;
  return (
    <div className="grid gap-5">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          Failure inbox
          <TitleInfo>
            Normalized failures across configured schedules and pipeline runs.
          </TitleInfo>
        </h1>
      </header>

      <section
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Failure inbox summary"
      >
        <Summary label="Current failures" value={data.facets.current} />
        <Summary label="Recent failures" value={data.facets.recent} />
        <Summary label="Without ticket" value={data.facets.states.untriaged} />
        <Summary
          label="Active MRs"
          value={data.facets.openMergeRequests}
          href={data.facets.openMergeRequestsUrl}
        />
      </section>

      <Card>
        <CardHeader className="flex-row items-center gap-2">
          <CardTitle className="flex shrink-0 items-center gap-2">
            <AlertTriangle className="size-5 text-[var(--status-danger-strong)]" />
            Failures
          </CardTitle>
          <CardDescription className="min-w-0 truncate">
            One row per schedule and stable failure signature.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2 lg:grid-cols-[minmax(220px,1fr)_130px_180px_160px_160px_110px]">
            <label className="relative">
              <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
              <Input
                className="h-8 pl-8"
                value={search}
                maxLength={200}
                placeholder="Search signature or test"
                aria-label="Search failure inbox"
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
            </label>
            <Select
              value={String(filter.days)}
              onValueChange={(value) =>
                update({ days: Number(value) as 1 | 7 | 30 })
              }
            >
              <SelectTrigger aria-label="Failure date range">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Today</SelectItem>
                <SelectItem value="7">7 days</SelectItem>
                <SelectItem value="30">30 days</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={filter.scheduleId == null ? "all" : String(filter.scheduleId)}
              onValueChange={(value) =>
                update({
                  scheduleId: value === "all" ? undefined : Number(value),
                  pipelineId: undefined,
                })
              }
            >
              <SelectTrigger aria-label="Failure schedule">
                <SelectValue placeholder="All schedules" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All schedules</SelectItem>
                {(schedules.data?.schedules ?? []).map((schedule) => (
                  <SelectItem
                    key={schedule.scheduleId}
                    value={String(schedule.scheduleId)}
                  >
                    {schedule.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={filter.presence}
              onValueChange={(value) =>
                update({ presence: value as "current" | "recent" })
              }
            >
              <SelectTrigger aria-label="Failure presence">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">Current</SelectItem>
                <SelectItem value="recent">Current + cleared</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={filter.state ?? "all"}
              onValueChange={(value) =>
                update({
                  state:
                    value === "all"
                      ? undefined
                      : (value as AutomationFailureRoute["state"]),
                })
              }
            >
              <SelectTrigger aria-label="Failure ticket state">
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
              value={String(filter.limit)}
              onValueChange={(value) =>
                update({ limit: value === "50" ? 50 : 25 })
              }
            >
              <SelectTrigger aria-label="Failure rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">25 / page</SelectItem>
                <SelectItem value="50">50 / page</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {filter.pipelineId != null ? (
            <div className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-border bg-muted/30 px-3 py-2 text-sm">
              Showing failures from pipeline #{filter.pipelineId}.
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => update({ pipelineId: undefined })}
              >
                Clear pipeline filter
              </Button>
            </div>
          ) : null}
          {inbox.error ? (
            <ErrorBox>
              Refresh failed: {inbox.error}. Showing the last available page.
            </ErrorBox>
          ) : null}

          {data.items.length === 0 ? (
            <div className="rounded-[var(--radius)] border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
              No failures match these filters.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-[var(--radius)] border border-border">
              <Table className="min-w-[1280px] table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[39%]">Failure</TableHead>
                    <TableHead className="w-[12%]">Schedule</TableHead>
                    <TableHead className="w-[8%]">Latest pipeline</TableHead>
                    <TableHead className="w-[11%]">History</TableHead>
                    <TableHead className="w-[8%]">AI triage</TableHead>
                    <TableHead className="w-[7%]">Work</TableHead>
                    <TableHead className="w-[10%]">Assign</TableHead>
                    <TableHead className="w-[5%]">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((item) => (
                    <FailureInboxRow
                      key={`${item.scheduleId}-${item.signatureKey}`}
                      item={item}
                      onSelectPipeline={onSelectPipeline}
                      onCreateTicket={() =>
                        setTicketTarget({
                          pipelineId: item.latestPipelineId,
                          signatureKey: item.signatureKey,
                        })
                      }
                      onOpen={() =>
                        setSelected({
                          pipelineId: item.latestPipelineId,
                          signatureKey: item.signatureKey,
                        })
                      }
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              {data.total === 0 ? 0 : data.offset + 1}–
              {Math.min(data.offset + data.limit, data.total)} of {data.total}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={data.offset === 0 || inbox.fetching}
                onClick={() =>
                  onRouteChange(
                    updateAutomationFailureRoute(route, {
                      offset: Math.max(0, data.offset - data.limit) || undefined,
                    }),
                  )
                }
              >
                <ChevronLeft className="size-4" />
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  data.offset + data.limit >= data.total || inbox.fetching
                }
                onClick={() =>
                  onRouteChange(
                    updateAutomationFailureRoute(route, {
                      offset: data.offset + data.limit,
                    }),
                  )
                }
              >
                Next
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      {selected ? (
        <AutomationFailureClusterDialog
          pipelineId={selected.pipelineId}
          signatureKey={selected.signatureKey}
          open
          onOpenChange={(open) => {
            if (!open) setSelected(undefined);
          }}
        />
      ) : null}
      {ticketTarget ? (
        <AutomationJiraTicketDialog
          pipelineId={ticketTarget.pipelineId}
          signatureKey={ticketTarget.signatureKey}
          onClose={() => setTicketTarget(undefined)}
        />
      ) : null}
    </div>
  );
}

function Summary({
  label,
  value,
  href,
}: {
  label: string;
  value: number | null;
  href?: string | null;
}) {
  const displayValue = value == null ? "—" : value.toLocaleString();
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums">
          {href ? (
            <a
              className="underline decoration-muted-foreground underline-offset-4 hover:decoration-foreground"
              href={href}
              target="_blank"
              rel="noreferrer"
            >
              {displayValue}
            </a>
          ) : (
            displayValue
          )}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}

function FailureInboxRow({
  item,
  onSelectPipeline,
  onCreateTicket,
  onOpen,
}: {
  item: AutomationFailureInboxItemView;
  onSelectPipeline: (pipelineId: number) => void;
  onCreateTicket: () => void;
  onOpen: () => void;
}) {
  const queryClient = useQueryClient();
  const { push } = useToasts();
  const [busy, setBusy] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const runTriage = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.triageAutomationFailure(
        item.latestPipelineId,
        item.signatureKey,
      );
      push(result.message, { severity: result.queued ? "success" : "info" });
      invalidate.jobQueue(queryClient);
      await invalidate.automationFailureTriage(
        queryClient,
        item.latestPipelineId,
        [item.signatureKey],
      );
    } catch (error) {
      push(error instanceof Error ? error.message : String(error), {
        severity: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const assign = async (userId: string | null) => {
    if (assigning || userId === item.assignee?.id || (!userId && !item.assignee)) {
      return;
    }
    setAssigning(true);
    try {
      await api.assignAutomationFailure(
        item.latestPipelineId,
        item.signatureKey,
        { userId },
      );
      await invalidate.automationFailureTriage(
        queryClient,
        item.latestPipelineId,
        [item.signatureKey],
      );
    } catch (error) {
      push(error instanceof Error ? error.message : String(error), {
        severity: "error",
      });
    } finally {
      setAssigning(false);
    }
  };

  return (
    <TableRow
      role="button"
      tabIndex={0}
      aria-label={`Open details for ${item.title}`}
      className="cursor-pointer align-top focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      <TableCell className="max-w-0">
        <div className="flex min-w-0 items-start gap-2">
          <StatusBadge status={item.current ? "failure" : "disabled"}>
            {item.current ? item.severity : "cleared"}
          </StatusBadge>
          <div className="min-w-0">
            <p className="truncate font-medium" title={item.title}>
              {item.title}
            </p>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              {item.sampleClassname
                ? `${item.sampleClassname} · ${item.sampleTestName}`
                : item.sampleTestName}
            </p>
          </div>
        </div>
      </TableCell>
      <TableCell>{item.scheduleName}</TableCell>
      <TableCell>
        <button
          type="button"
          className="cursor-pointer text-left font-medium underline decoration-muted-foreground underline-offset-2 hover:decoration-foreground"
          onClick={(event) => {
            event.stopPropagation();
            onSelectPipeline(item.latestPipelineId);
          }}
        >
          #{item.latestPipelineId}
        </button>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {item.latestRef} · {item.latestSha.slice(0, 8)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {ago(item.latestUpdatedAt)}
        </p>
        {item.autoRetry ? (
          <StatusBadge
            status={
              item.autoRetry.state === "complete"
                ? "running"
                : item.autoRetry.state === "failed"
                  ? "failure"
                  : "warn"
            }
          >
            retry {item.autoRetry.state}
          </StatusBadge>
        ) : null}
      </TableCell>
      <TableCell className="text-sm tabular-nums">
        <p>{item.pipelineCount} pipelines</p>
        <p className="text-xs text-muted-foreground">
          {item.affectedTestCount} tests · {item.occurrenceCount} occurrences
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          First {ago(item.firstSeenAt)}
        </p>
      </TableCell>
      <TableCell className="max-w-0 overflow-hidden">
        {item.aiTriageInFlight ? (
          <StatusBadge status="running" showIcon={false}>
            <LoaderCircle className="mr-1 size-3 animate-spin" />
            triaging
          </StatusBadge>
        ) : item.aiTriage ? (
          <div className="min-w-0 text-xs">
            <p
              className="truncate font-medium"
              title={item.aiTriage.verdict.replaceAll("-", " ")}
            >
              {item.aiTriage.verdict.replaceAll("-", " ")}
            </p>
            <p className="truncate text-muted-foreground">
              {Math.round(item.aiTriage.confidence * 100)}% confidence
            </p>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Not run</span>
        )}
      </TableCell>
      <TableCell>
        {item.triageState === "ticketed" && item.work?.jiraKey ? null : (
          <StatusBadge status={automationFailureWorkStatus(item)}>
            {item.creating
              ? "creating"
              : item.triageState === "untriaged"
                ? "no ticket"
                : item.triageState.replace("-", " ")}
          </StatusBadge>
        )}
        {item.work?.jiraUrl ? (
          <a
            className="block text-xs font-medium hover:underline"
            href={item.work.jiraUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            {item.work.jiraKey}
          </a>
        ) : null}
      </TableCell>
      <TableCell onClick={(event) => event.stopPropagation()}>
        <TalosAssigneeSelect
          value={item.assignee}
          busy={assigning}
          onChange={(userId) => void assign(userId)}
        />
      </TableCell>
      <TableCell onClick={(event) => event.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${item.title}`}
            >
              <Ellipsis className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-64">
            <DropdownMenuItem
              className="cursor-pointer items-start gap-2"
              disabled={
                busy || item.aiTriageInFlight || item.aiTriageRefusal != null
              }
              onSelect={() => void runTriage()}
            >
              {busy || item.aiTriageInFlight ? (
                <LoaderCircle className="mt-0.5 size-4 animate-spin" />
              ) : (
                <Sparkles className="mt-0.5 size-4" />
              )}
              <span className="grid gap-0.5">
                <span>{item.aiTriage ? "Re-run AI triage" : "AI triage"}</span>
                {item.aiTriageRefusal ? (
                  <span className="max-w-56 text-xs text-muted-foreground">
                    {item.aiTriageRefusal}
                  </span>
                ) : null}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer items-start gap-2"
              disabled={
                item.creating ||
                item.triageState !== "untriaged" ||
                item.ticketRefusal != null
              }
              onSelect={onCreateTicket}
            >
              <Ticket className="mt-0.5 size-4" />
              <span className="grid gap-0.5">
                <span>Create Jira ticket</span>
                {item.ticketRefusal ? (
                  <span className="max-w-56 text-xs text-muted-foreground">
                    {item.ticketRefusal}
                  </span>
                ) : null}
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
