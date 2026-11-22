import type {
  DashboardFilter,
  DashboardQuery,
  DatasetField,
  QueryColumn,
  QueryResult,
} from "../../../shared/dashboard.ts";
import { ValidationError } from "../../core/errors.ts";

/** How many category values a chart keeps before the rest become "Other". */
export const MAX_CATEGORIES = 24;

const DAY_MS = 24 * 60 * 60 * 1000;

interface Aggregate {
  keys: unknown[];
  /** Numeric samples per metric, already coerced. Distinct keeps raw values. */
  samples: unknown[][];
}

/**
 * Filters, buckets and aggregates rows a dataset already fetched.
 *
 * Live sources push down what they can and still finish here, so a Jira JQL
 * filter and a dashboard filter compose instead of competing.
 */
export function executeQuery(
  sourceRows: readonly Record<string, unknown>[],
  query: DashboardQuery,
  fields: readonly DatasetField[],
  options: { truncated?: boolean; now?: Date; fetchedAt?: string } = {},
): QueryResult {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const requireField = (key: string, purpose: string): DatasetField => {
    const field = byKey.get(key);
    if (!field) {
      throw new ValidationError(`Unknown ${purpose} field '${key}'.`);
    }
    return field;
  };

  for (const filter of query.filters ?? []) requireField(filter.field, "filter");
  const rangeField = query.timeRange
    ? requireField(query.timeRange.field, "time range")
    : undefined;
  if (rangeField && rangeField.type !== "date") {
    throw new ValidationError(`Time range field '${rangeField.key}' is not a date.`);
  }
  for (const group of query.groupBy ?? []) {
    const field = requireField(group.field, "group");
    if (group.bucket && field.type !== "date") {
      throw new ValidationError(`'${field.key}' cannot be bucketed by ${group.bucket}.`);
    }
  }

  const now = options.now ?? new Date();
  if ((query.metrics?.length ?? 0) === 0) {
    return listRows(sourceRows, query, byKey, requireField, options, now);
  }

  const metrics = query.metrics!.map((metric, index) => {
    const alias = metric.as ?? (metric.field ? `${metric.fn}_${metric.field}` : metric.fn);
    if (metric.fn !== "count") {
      if (!metric.field) throw new ValidationError(`'${metric.fn}' needs a field.`);
      const field = requireField(metric.field, "metric");
      if ((metric.fn === "sum" || metric.fn === "avg" || metric.fn === "min" || metric.fn === "max") && field.type !== "number") {
        throw new ValidationError(`'${metric.fn}' needs a number field.`);
      }
    }
    return { ...metric, alias, index };
  });
  const aliases = new Set<string>();
  for (const metric of metrics) {
    if (aliases.has(metric.alias) || byKey.has(metric.alias)) {
      throw new ValidationError(`Metric name '${metric.alias}' collides with another column.`);
    }
    aliases.add(metric.alias);
  }

  const range = query.timeRange ? resolveRange(query.timeRange, now) : undefined;
  const filtered = sourceRows.filter((row) => {
    if (query.filters?.some((filter) => !matches(row[filter.field], filter.op, filter.value, byKey.get(filter.field)!))) {
      return false;
    }
    if (!range || !rangeField) return true;
    const instant = asDate(row[rangeField.key]);
    return instant != null && instant.getTime() >= range.from && instant.getTime() < range.to;
  });

  const groups = new Map<string, Aggregate>();
  for (const row of filtered) {
    const keys = (query.groupBy ?? []).map((group) => groupValue(row[group.field], group.bucket));
    const id = JSON.stringify(keys);
    let aggregate = groups.get(id);
    if (!aggregate) {
      aggregate = { keys, samples: metrics.map(() => []) };
      groups.set(id, aggregate);
    }
    metrics.forEach((metric, index) => {
      aggregate!.samples[index]!.push(metric.fn === "count" ? 1 : row[metric.field!]);
    });
  }

  let records = [...groups.values()].map((aggregate) => ({
    keys: aggregate.keys,
    values: aggregate.samples.map((samples, index) => reduceMetric(metrics[index]!.fn, samples)),
  }));
  if (records.length === 0 && (query.groupBy ?? []).length === 0) {
    records = [{
      keys: [],
      values: metrics.map((metric) => metric.fn === "avg" || metric.fn === "min" || metric.fn === "max" ? null : 0),
    }];
  }

  const collapsing = (query.groupBy ?? []).findIndex((group) => !group.bucket);
  let collapsed = false;
  if (collapsing >= 0 && distinctCount(records.map((record) => record.keys[collapsing])) > MAX_CATEGORIES) {
    collapsed = true;
    const ranked = rankKeys(records, collapsing);
    const keep = new Set(ranked.slice(0, MAX_CATEGORIES));
    const merged = new Map<string, { keys: unknown[]; values: Array<number | null>; counts: number[] }>();
    for (const record of records) {
      const keys = [...record.keys];
      if (!keep.has(String(keys[collapsing]))) keys[collapsing] = "Other";
      const id = JSON.stringify(keys);
      const current = merged.get(id);
      if (!current) {
        merged.set(id, {
          keys,
          values: [...record.values],
          counts: record.values.map((value) => (value == null ? 0 : 1)),
        });
        continue;
      }
      current.values = current.values.map((value, index) => {
        const next = record.values[index];
        if (value == null) return next ?? null;
        if (next == null) return value;
        const fn = metrics[index]!.fn;
        if (fn === "min") return Math.min(value, next);
        if (fn === "max") return Math.max(value, next);
        if (fn === "avg") {
          const count = current.counts[index]! + 1;
          current.counts[index] = count;
          return value + (next - value) / count;
        }
        return value + next;
      });
    }
    records = [...merged.values()].map(({ keys, values }) => ({ keys, values }));
  }

  const columns: QueryColumn[] = [
    ...(query.groupBy ?? []).map((group) => ({
      key: group.field,
      label: byKey.get(group.field)!.label,
      type: group.bucket ? "string" as const : columnType(byKey.get(group.field)!),
    })),
    ...metrics.map((metric) => ({
      key: metric.alias,
      label: metric.alias,
      type: "number" as const,
    })),
  ];

  const sortKey = query.sort?.by;
  if (sortKey && !columns.some((column) => column.key === sortKey)) {
    throw new ValidationError(`Cannot sort by unknown column '${sortKey}'.`);
  }
  const sortIndex = sortKey ? columns.findIndex((column) => column.key === sortKey) : -1;
  const direction = query.sort?.dir === "asc" ? 1 : -1;
  records.sort((a, b) => {
    if (sortIndex >= 0) {
      return direction * compare(cell(a, sortIndex), cell(b, sortIndex));
    }
    const bucket = (query.groupBy ?? []).findIndex((group) => group.bucket);
    if (bucket >= 0) return compare(a.keys[bucket], b.keys[bucket]);
    return compare(b.values[0], a.values[0]);
  });

  const limit = query.limit ?? 100;
  const limited = records.slice(0, limit);
  return {
    columns,
    rows: limited.map((record) => [...record.keys, ...record.values]),
    truncated: options.truncated === true || collapsed || records.length > limited.length,
    fetchedAt: options.fetchedAt ?? now.toISOString(),
  };
}

function listRows(
  sourceRows: readonly Record<string, unknown>[],
  query: DashboardQuery,
  byKey: Map<string, DatasetField>,
  requireField: (key: string, purpose: string) => DatasetField,
  options: { truncated?: boolean; fetchedAt?: string },
  now: Date,
): QueryResult {
  const selected = query.columns ?? [];
  if (selected.length === 0) throw new ValidationError("A query needs a metric or columns.");
  if ((query.groupBy?.length ?? 0) > 0) {
    throw new ValidationError("A grouped query needs a metric.");
  }
  for (const key of selected) requireField(key, "column");
  const rangeField = query.timeRange ? requireField(query.timeRange.field, "time range") : undefined;
  const range = query.timeRange ? resolveRange(query.timeRange, now) : undefined;
  const filtered = sourceRows.filter((row) => rowMatches(row, query, byKey, rangeField, range));
  const sortField = query.sort ? requireField(query.sort.by, "sort") : undefined;
  const direction = query.sort?.dir === "asc" ? 1 : -1;
  const sorted = sortField
    ? [...filtered].sort((left, right) => direction * compare(left[sortField.key], right[sortField.key]))
    : filtered;
  const limit = query.limit ?? 100;
  const page = sorted.slice(0, limit);
  return {
    columns: selected.map((key) => {
      const field = byKey.get(key)!;
      return { key, label: field.label, type: columnType(field) };
    }),
    rows: page.map((row) => selected.map((key) => row[key] ?? "")),
    truncated: options.truncated === true || sorted.length > page.length,
    fetchedAt: options.fetchedAt ?? now.toISOString(),
  };
}

function rowMatches(
  row: Record<string, unknown>,
  query: DashboardQuery,
  byKey: Map<string, DatasetField>,
  rangeField: DatasetField | undefined,
  range: { from: number; to: number } | undefined,
): boolean {
  if (query.filters?.some((filter) => !matches(row[filter.field], filter.op, filter.value, byKey.get(filter.field)!))) {
    return false;
  }
  if (!range || !rangeField) return true;
  const instant = asDate(row[rangeField.key]);
  return instant != null && instant.getTime() >= range.from && instant.getTime() < range.to;
}

function cell(
  record: { keys: unknown[]; values: Array<number | null> },
  index: number,
): unknown {
  return index < record.keys.length ? record.keys[index] : record.values[index - record.keys.length];
}

function columnType(field: DatasetField): QueryColumn["type"] {
  if (field.type === "number") return "number";
  if (field.type === "date") return "date";
  return "string";
}

function resolveRange(
  range: NonNullable<DashboardQuery["timeRange"]>,
  now: Date,
): { from: number; to: number } {
  if (range.preset) {
    const days = range.preset === "7d" ? 7 : range.preset === "30d" ? 30 : range.preset === "90d" ? 90 : 365;
    return { from: now.getTime() - days * DAY_MS, to: now.getTime() + 1 };
  }
  const from = range.from ? asDate(range.from) : undefined;
  const to = range.to ? asDate(range.to) : undefined;
  if (range.from && !from) throw new ValidationError("Time range 'from' is not a date.");
  if (range.to && !to) throw new ValidationError("Time range 'to' is not a date.");
  return {
    from: from?.getTime() ?? 0,
    to: to ? to.getTime() + 1 : now.getTime() + 1,
  };
}

function groupValue(value: unknown, bucket: "day" | "week" | "month" | undefined): unknown {
  if (!bucket) return value == null ? "" : value;
  const date = asDate(value);
  if (!date) return "";
  if (bucket === "month") return date.toISOString().slice(0, 7);
  if (bucket === "day") return date.toISOString().slice(0, 10);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() - day + 1);
  return utc.toISOString().slice(0, 10);
}

function matches(
  value: unknown,
  op: DashboardFilter["op"],
  expected: unknown,
  field: DatasetField,
): boolean {
  if (op === "empty") return value == null || value === "";
  if (op === "notEmpty") return value != null && value !== "";
  if (op === "contains") {
    return String(value ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
  }
  if (op === "in" || op === "nin") {
    const list = Array.isArray(expected) ? expected : [expected];
    const hit = list.some((item) => same(value, item, field));
    return op === "in" ? hit : !hit;
  }
  if (op === "eq") return same(value, expected, field);
  if (op === "neq") return !same(value, expected, field);
  const left = field.type === "date" ? asDate(value)?.getTime() : asNumber(value);
  const right = field.type === "date" ? asDate(expected)?.getTime() : asNumber(expected);
  if (left == null || right == null) return false;
  if (op === "gt") return left > right;
  if (op === "gte") return left >= right;
  if (op === "lt") return left < right;
  return left <= right;
}

function same(value: unknown, expected: unknown, field: DatasetField): boolean {
  if (field.type === "number") return asNumber(value) === asNumber(expected);
  if (field.type === "date") return asDate(value)?.getTime() === asDate(expected)?.getTime();
  return String(value ?? "") === String(expected ?? "");
}

function reduceMetric(fn: NonNullable<DashboardQuery["metrics"]>[number]["fn"], samples: unknown[]): number | null {
  if (fn === "count") return samples.length;
  if (fn === "distinct") return new Set(samples.filter((value) => value != null && value !== "").map((value) => String(value))).size;
  const numbers = samples.map(asNumber).filter((value): value is number => value != null);
  if (numbers.length === 0) return fn === "sum" ? 0 : null;
  if (fn === "sum") return numbers.reduce((total, value) => total + value, 0);
  if (fn === "min") return Math.min(...numbers);
  if (fn === "max") return Math.max(...numbers);
  return numbers.reduce((total, value) => total + value, 0) / numbers.length;
}

function distinctCount(values: unknown[]): number {
  return new Set(values.map((value) => String(value))).size;
}

function rankKeys(
  records: Array<{ keys: unknown[]; values: Array<number | null> }>,
  index: number,
): string[] {
  const totals = new Map<string, number>();
  for (const record of records) {
    const key = String(record.keys[index]);
    totals.set(key, (totals.get(key) ?? 0) + (record.values[0] ?? 0));
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key]) => key);
}

function compare(left: unknown, right: unknown): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

export function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}
