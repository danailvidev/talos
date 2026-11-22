import { describe, expect, test } from "bun:test";

import type { DatasetField } from "../shared/dashboard.ts";
import { executeQuery } from "../src/application/dashboards/query.ts";
import { ValidationError } from "../src/core/errors.ts";

const fields: DatasetField[] = [
  { key: "status", label: "Status", type: "string" },
  { key: "created", label: "Created", type: "date" },
  { key: "points", label: "Points", type: "number" },
];

const now = new Date("2026-11-02T12:00:00.000Z");

describe("dashboard query engine", () => {
  test("counts rows that match a filter", () => {
    const result = executeQuery(
      [
        { status: "Open", points: 2 },
        { status: "Done", points: 5 },
        { status: "Open", points: 1 },
      ],
      {
        dataset: "example",
        filters: [{ field: "status", op: "eq", value: "Open" }],
        metrics: [{ fn: "count", as: "issues" }, { fn: "sum", field: "points", as: "total" }],
      },
      fields,
      { now },
    );
    expect(result.rows).toEqual([[2, 3]]);
    expect(result.truncated).toBe(false);
    const empty = executeQuery([], {
      dataset: "example",
      metrics: [{ fn: "count", as: "issues" }],
    }, fields, { now });
    expect(empty.rows).toEqual([[0]]);
  });

  test("buckets created dates by week without stored snapshots", () => {
    const result = executeQuery(
      [
        { status: "Open", created: "2026-10-26T08:00:00.000Z", points: 1 },
        { status: "Done", created: "2026-10-28T08:00:00.000Z", points: 1 },
        { status: "Open", created: "2026-11-02T08:00:00.000Z", points: 1 },
      ],
      {
        dataset: "example",
        timeRange: { field: "created", preset: "30d" },
        groupBy: [{ field: "created", bucket: "week" }],
        metrics: [{ fn: "count", as: "createdCount" }],
        sort: { by: "created", dir: "asc" },
      },
      fields,
      { now },
    );
    expect(result.rows).toEqual([
      ["2026-10-26", 2],
      ["2026-11-02", 1],
    ]);
  });

  test("collapses long category lists into Other", () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      status: `S${String(index).padStart(2, "0")}`,
      points: index === 0 ? 1 : 10,
    }));
    const result = executeQuery(
      rows,
      {
        dataset: "example",
        groupBy: [{ field: "status" }],
        metrics: [{ fn: "count", as: "issues" }],
        sort: { by: "issues", dir: "desc" },
      },
      fields,
      { now },
    );
    expect(result.truncated).toBe(true);
    expect(result.rows.some((row) => row[0] === "Other")).toBe(true);
    expect(result.rows.length).toBeLessThanOrEqual(25);
  });

  test("lists selected columns instead of aggregating", () => {
    const result = executeQuery(
      [
        { status: "Open", points: 2, created: "2026-11-01T00:00:00.000Z" },
        { status: "Done", points: 9, created: "2026-10-01T00:00:00.000Z" },
      ],
      {
        dataset: "example",
        columns: ["status", "points"],
        sort: { by: "points", dir: "desc" },
        limit: 1,
      },
      fields,
      { now },
    );
    expect(result.rows).toEqual([["Done", 9]]);
    expect(result.truncated).toBe(true);
  });

  test("rejects a field the dataset does not have", () => {
    expect(() => executeQuery([], {
      dataset: "example",
      groupBy: [{ field: "missing" }],
      metrics: [{ fn: "count" }],
    }, fields)).toThrow(ValidationError);
  });
});
