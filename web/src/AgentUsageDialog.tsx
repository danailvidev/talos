import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import type {
  AgentUsageBreakdownView,
  AgentUsageEventView,
  AgentUsageFilter,
  AgentUsageTokensView,
} from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card.tsx";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "./components/ui/chart.tsx";
import { Modal } from "./components/ui/modal.tsx";
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
import { queries } from "./queries.ts";
import { useApi } from "./useApi.ts";

const PAGE_SIZE = 25;
const USAGE_CHART_CONFIG = {
  inputTokens: { label: "Fresh input", color: "var(--action)" },
  outputTokens: { label: "Output", color: "var(--status-success)" },
  cacheReadInputTokens: { label: "Cache read", color: "var(--live)" },
  cacheCreationInputTokens: { label: "Cache write", color: "var(--status-warning)" },
} satisfies ChartConfig;

export function AgentUsageDialog({
  onClose,
  allowGlobal,
}: {
  onClose: () => void;
  allowGlobal: boolean;
}) {
  const [days, setDays] = useState<AgentUsageFilter["days"]>(30);
  const [account, setAccount] = useState("all");
  const [source, setSource] = useState("all");
  const [offset, setOffset] = useState(0);
  const filter = useMemo<AgentUsageFilter>(
    () => ({
      days,
      ...(allowGlobal ? { scope: "all" as const } : {}),
      ...(account !== "all" ? { account } : {}),
      ...(source !== "all"
        ? { source: source as NonNullable<AgentUsageFilter["source"]> }
        : {}),
      limit: PAGE_SIZE,
      offset,
    }),
    [account, allowGlobal, days, offset, source],
  );
  const usage = useApi(queries.agentUsage(filter));
  const [knownAccounts, setKnownAccounts] = useState<AgentUsageBreakdownView[]>([]);

  useEffect(() => {
    if (!usage.data) return;
    const accounts = usage.data.accounts;
    setKnownAccounts((current) => {
      const next = new Map(current.map((entry) => [entry.key, entry]));
      for (const entry of accounts) next.set(entry.key, entry);
      return [...next.values()];
    });
  }, [usage.data]);

  const changeFilter = (change: () => void) => {
    setOffset(0);
    change();
  };

  return (
    <Modal onClose={onClose} className="sm:max-w-300" title="Agent usage">
      <div className="flex flex-wrap gap-3">
        <UsageSelect label="Range" value={String(days)} onChange={(value) =>
          changeFilter(() => setDays(Number(value) as AgentUsageFilter["days"]))}>
          <SelectItem value="7">Last 7 days</SelectItem>
          <SelectItem value="30">Last 30 days</SelectItem>
          <SelectItem value="90">Last 90 days</SelectItem>
          <SelectItem value="365">Last year</SelectItem>
        </UsageSelect>
        <UsageSelect label="Account" value={account} onChange={(value) =>
          changeFilter(() => setAccount(value))}>
          <SelectItem value="all">{allowGlobal ? "All accounts" : "My accounts"}</SelectItem>
          {knownAccounts.map((entry) => (
            <SelectItem key={entry.key} value={entry.key}>{entry.label}</SelectItem>
          ))}
        </UsageSelect>
        <UsageSelect label="Source" value={source} onChange={(value) =>
          changeFilter(() => setSource(value))}>
          <SelectItem value="all">All sources</SelectItem>
          <SelectItem value="task">Agent tasks</SelectItem>
          <SelectItem value="assistant">Assistant chat</SelectItem>
          <SelectItem value="e2e">E2E testing</SelectItem>
        </UsageSelect>
      </div>

      {usage.error ? (
        <ErrorBox>{usage.error}</ErrorBox>
      ) : usage.loading && !usage.data ? (
        <Loading>Loading agent usage…</Loading>
      ) : usage.data ? (
        <div className="mt-4 grid gap-4">
          <SummaryCards totals={usage.data.totals} />
          <p className="text-sm text-muted-foreground">
            New context combines fresh input with context written to cache. Cache reused is
            context reread across agent turns; processed tokens include those repeated reads
            and do not represent unique text or uniformly priced usage.
          </p>
          {usage.data.totals.knownUsageInvocations < usage.data.totals.invocations ? (
            <p className="text-sm text-muted-foreground">
              {formatNumber(
                usage.data.totals.invocations - usage.data.totals.knownUsageInvocations,
              )}{" "}
              invocation(s) did not include provider token telemetry and are shown as unknown,
              not zero.
            </p>
          ) : null}

          <Card>
            <CardHeader><CardTitle>Daily token usage</CardTitle></CardHeader>
            <CardContent>
              {usage.data.daily.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No agent invocations match these filters.
                </p>
              ) : (
                <ChartContainer
                  config={USAGE_CHART_CONFIG}
                  className="h-64 w-full"
                  role="img"
                  aria-label="Daily agent token usage"
                >
                  <BarChart data={usage.data.daily}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={24} />
                    <YAxis tickFormatter={formatCompact} tickLine={false} axisLine={false} width={48} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="tokens.inputTokens" name="inputTokens" stackId="tokens" fill="var(--color-inputTokens)" />
                    <Bar dataKey="tokens.outputTokens" name="outputTokens" stackId="tokens" fill="var(--color-outputTokens)" />
                    <Bar dataKey="tokens.cacheReadInputTokens" name="cacheReadInputTokens" stackId="tokens" fill="var(--color-cacheReadInputTokens)" />
                    <Bar dataKey="tokens.cacheCreationInputTokens" name="cacheCreationInputTokens" stackId="tokens" fill="var(--color-cacheCreationInputTokens)" radius={[3, 3, 0, 0]} />
                    <ChartLegend content={<ChartLegendContent />} />
                  </BarChart>
                </ChartContainer>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            <BreakdownCard title="By account" entries={usage.data.accounts} />
            <BreakdownCard title="By model" entries={usage.data.models} />
            <BreakdownCard title="By source" entries={usage.data.sources} />
          </div>
          <InvocationHistory
            events={usage.data.events}
            total={usage.data.eventCount}
            offset={offset}
            onOffset={setOffset}
            showUser={allowGlobal}
          />
        </div>
      ) : null}

      <div className="mt-4 flex justify-end">
        <Button type="button" variant="outline" onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

function UsageSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
    </label>
  );
}

function SummaryCards({ totals }: { totals: AgentUsageBreakdownView }) {
  const inputContext = newContextTokens(totals.tokens);
  const inputProcessed =
    inputContext + totals.tokens.cacheReadInputTokens;
  const cacheHit = inputProcessed > 0
    ? Math.round((totals.tokens.cacheReadInputTokens / inputProcessed) * 1_000) / 10
    : 0;
  const cards = [
    ["New context", formatCompact(inputContext), "Fresh input + cache write"],
    ["Output", formatCompact(totals.tokens.outputTokens), "Model-generated tokens"],
    ["Cache reused", formatCompact(totals.tokens.cacheReadInputTokens), "Context reread across turns"],
    ["Cache hit", `${cacheHit}%`, "Share of processed input served from cache"],
    ["Tokens processed", formatCompact(totalTokens(totals.tokens)), "Includes repeated cache reads"],
    ["Invocations", formatCompact(totals.invocations), "Agent runs in this range"],
  ] as const;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
      {cards.map(([label, value, detail], index) => (
        <Card key={label}>
          <CardContent className="pt-5">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className={`mt-1 text-2xl font-semibold ${index < 2 ? "text-foreground" : "text-muted-foreground"}`}>
              {value}
            </div>
            <div className="mt-1 text-[0.6875rem] leading-tight text-muted-foreground">{detail}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function BreakdownCard({ title, entries }: { title: string; entries: AgentUsageBreakdownView[] }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="grid gap-2">
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No usage.</p>
        ) : entries.slice(0, 8).map((entry) => (
          <div key={entry.key} className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate" title={entry.label}>{entry.label}</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {entry.knownUsageInvocations ? compactUsage(entry.tokens) : "Unknown"}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function InvocationHistory({
  events,
  total,
  offset,
  onOffset,
  showUser,
}: {
  events: AgentUsageEventView[];
  total: number;
  offset: number;
  onOffset: (offset: number) => void;
  showUser: boolean;
}) {
  return (
    <Card>
      <CardHeader><CardTitle>Invocation history</CardTitle></CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                {showUser ? <TableHead>User</TableHead> : null}
                <TableHead>Source</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">New / output</TableHead>
                <TableHead className="text-right">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.length === 0 ? (
                <TableRow><TableCell colSpan={showUser ? 8 : 7} className="h-24 text-center text-muted-foreground">No invocations.</TableCell></TableRow>
              ) : events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="whitespace-nowrap">{formatDate(event.startedAt)}</TableCell>
                  {showUser ? <TableCell>{event.user?.name ?? "Deleted user"}</TableCell> : null}
                  <TableCell>{sourceLabel(event.source)}</TableCell>
                  <TableCell>
                    {event.accountLabel}
                    {event.authSource === "host" ? <span className="ml-1 text-xs text-[var(--warn)]">host fallback</span> : null}
                  </TableCell>
                  <TableCell>{event.model ?? "Unknown"}</TableCell>
                  <TableCell className="capitalize">{event.status}</TableCell>
                  <TableCell
                    className="text-right font-mono text-xs"
                    title={event.tokens
                      ? `${formatNumber(totalTokens(event.tokens))} processed; ${formatNumber(event.tokens.cacheReadInputTokens)} cache reused`
                      : undefined}
                  >
                    {event.tokens
                      ? `${formatCompact(newContextTokens(event.tokens))} / ${formatCompact(event.tokens.outputTokens)}`
                      : "Unknown"}
                  </TableCell>
                  <TableCell className="text-right">{formatDuration(event.durationMs)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {total === 0 ? "0" : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)}`} of {total}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</Button>
            <Button type="button" variant="outline" size="sm" disabled={offset + PAGE_SIZE >= total} onClick={() => onOffset(offset + PAGE_SIZE)}>Next</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function totalTokens(tokens: AgentUsageTokensView): number {
  return tokens.inputTokens + tokens.outputTokens +
    tokens.cacheReadInputTokens + tokens.cacheCreationInputTokens;
}

function newContextTokens(tokens: AgentUsageTokensView): number {
  return tokens.inputTokens + tokens.cacheCreationInputTokens;
}

function compactUsage(tokens: AgentUsageTokensView): string {
  return `${formatCompact(newContextTokens(tokens))} new · ${formatCompact(tokens.outputTokens)} out`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatDuration(value: number | undefined): string {
  if (value == null) return "—";
  if (value < 1_000) return `${value} ms`;
  if (value < 60_000) return `${Math.round(value / 100) / 10}s`;
  return `${Math.round(value / 6_000) / 10}m`;
}

function sourceLabel(source: AgentUsageEventView["source"]): string {
  if (source === "assistant") return "Assistant chat";
  if (source === "e2e") return "E2E testing";
  return "Agent task";
}
