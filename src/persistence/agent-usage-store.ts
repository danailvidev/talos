import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type {
  AgentUsageBreakdown,
  AgentUsageEvent,
  AgentUsageReport,
  AgentUsageRepository,
  AgentUsageSource,
  AgentUsageTokens,
} from "../application/ports.ts";

interface Row {
  id: string;
  user_id: string;
  account_id: string | null;
  account_label: string;
  option_id: string | null;
  auth_source: "connected" | "host";
  provider: string;
  model: string | null;
  source: AgentUsageSource;
  execution_id: string | null;
  invocation_label: string | null;
  status: "success" | "failed" | "cancelled";
  started_at: string;
  finished_at: string;
  duration_ms: number | null;
  turns: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
}

const ZERO_TOKENS: AgentUsageTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

export class SqliteAgentUsageStore implements AgentUsageRepository {
  constructor(private readonly db: Database) {}

  record(event: Omit<AgentUsageEvent, "id">): AgentUsageEvent {
    const id = randomUUID();
    const tokens = event.tokens;
    this.db.run(
      `INSERT INTO agent_usage_events (
         id, user_id, account_id, account_label, option_id, auth_source,
         provider, model, source, execution_id, invocation_label, status,
         started_at, finished_at, duration_ms, turns,
         input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        event.userId,
        event.accountId ?? null,
        event.accountLabel,
        event.optionId ?? null,
        event.authSource,
        event.provider,
        event.model ?? null,
        event.source,
        event.executionId ?? null,
        event.invocationLabel ?? null,
        event.status,
        event.startedAt.toISOString(),
        event.finishedAt.toISOString(),
        event.durationMs ?? Math.max(0, event.finishedAt.getTime() - event.startedAt.getTime()),
        event.turns ?? null,
        tokens?.inputTokens ?? null,
        tokens?.outputTokens ?? null,
        tokens?.cacheReadInputTokens ?? null,
        tokens?.cacheCreationInputTokens ?? null,
      ],
    );
    return { id, ...event };
  }

  report(
    userId: string | undefined,
    filter: {
      from: Date;
      to: Date;
      account?: string;
      source?: AgentUsageSource;
      limit: number;
      offset: number;
    },
  ): AgentUsageReport {
    const where = ["started_at >= ?", "started_at < ?"];
    const params: Array<string | number> = [
      filter.from.toISOString(),
      filter.to.toISOString(),
    ];
    if (userId) {
      where.unshift("user_id = ?");
      params.unshift(userId);
    }
    if (filter.account === "host") {
      where.push("auth_source = 'host'");
    } else if (filter.account) {
      where.push("account_id = ?");
      params.push(filter.account);
    }
    if (filter.source) {
      where.push("source = ?");
      params.push(filter.source);
    }
    const rows = this.db
      .query<Row, Array<string | number>>(
        `SELECT * FROM agent_usage_events
          WHERE ${where.join(" AND ")}
          ORDER BY started_at DESC, id DESC`,
      )
      .all(...params);

    const totals = aggregate("total", "All usage", rows);
    const accounts = breakdown(rows, (row) => [
      row.auth_source === "host" ? "host" : row.account_id ?? "unknown",
      row.account_label,
    ]);
    const models = breakdown(rows, (row) => [row.model ?? "unknown", row.model ?? "Unknown model"]);
    const sources = breakdown(rows, (row) => [row.source, sourceLabel(row.source)]);
    const daily = [...groupRows(rows, (row) => row.started_at.slice(0, 10)).entries()]
      .map(([date, dayRows]) => ({
        date,
        tokens: sumTokens(dayRows),
        invocations: dayRows.length,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      totals,
      daily,
      accounts,
      models,
      sources,
      events: rows.slice(filter.offset, filter.offset + filter.limit).map(toEvent),
      eventCount: rows.length,
    };
  }
}

function breakdown(
  rows: Row[],
  identify: (row: Row) => readonly [string, string],
): AgentUsageBreakdown[] {
  return [...groupRows(rows, (row) => identify(row)[0]).entries()]
    .map(([key, grouped]) => aggregate(key, identify(grouped[0]!)[1], grouped))
    .sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens) || b.invocations - a.invocations);
}

function aggregate(key: string, label: string, rows: Row[]): AgentUsageBreakdown {
  return {
    key,
    label,
    invocations: rows.length,
    knownUsageInvocations: rows.filter((row) => row.input_tokens != null).length,
    tokens: sumTokens(rows),
  };
}

function groupRows(rows: Row[], key: (row: Row) => string): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const value = key(row);
    const group = grouped.get(value) ?? [];
    group.push(row);
    grouped.set(value, group);
  }
  return grouped;
}

function sumTokens(rows: Row[]): AgentUsageTokens {
  const tokens = { ...ZERO_TOKENS };
  for (const row of rows) {
    tokens.inputTokens += row.input_tokens ?? 0;
    tokens.outputTokens += row.output_tokens ?? 0;
    tokens.cacheReadInputTokens += row.cache_read_input_tokens ?? 0;
    tokens.cacheCreationInputTokens += row.cache_creation_input_tokens ?? 0;
  }
  return tokens;
}

function totalTokens(tokens: AgentUsageTokens): number {
  return tokens.inputTokens + tokens.outputTokens +
    tokens.cacheReadInputTokens + tokens.cacheCreationInputTokens;
}

function toEvent(row: Row): AgentUsageEvent {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.account_id ? { accountId: row.account_id } : {}),
    accountLabel: row.account_label,
    ...(row.option_id ? { optionId: row.option_id } : {}),
    authSource: row.auth_source,
    provider: row.provider,
    ...(row.model ? { model: row.model } : {}),
    source: row.source,
    ...(row.execution_id ? { executionId: row.execution_id } : {}),
    ...(row.invocation_label ? { invocationLabel: row.invocation_label } : {}),
    status: row.status,
    startedAt: new Date(row.started_at),
    finishedAt: new Date(row.finished_at),
    ...(row.duration_ms != null ? { durationMs: row.duration_ms } : {}),
    ...(row.turns != null ? { turns: row.turns } : {}),
    ...(row.input_tokens != null
      ? {
          tokens: {
            inputTokens: row.input_tokens,
            outputTokens: row.output_tokens ?? 0,
            cacheReadInputTokens: row.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: row.cache_creation_input_tokens ?? 0,
          },
        }
      : {}),
  };
}

function sourceLabel(source: AgentUsageSource): string {
  if (source === "assistant") return "Assistant chat";
  if (source === "e2e") return "E2E testing";
  return "Agent tasks";
}
