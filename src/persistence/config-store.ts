import type { Database } from "bun:sqlite";
import type {
  ScheduleRepository,
  ScheduledTaskRow,
} from "../application/ports.ts";
import type { Trigger } from "../config/schema.ts";
import { fromJson, toIso, toJson } from "./database.ts";

interface ConfigRow {
  task_id: string;
  enabled: number;
  schedule: string | null;
  trigger_type: "cron" | "once" | "manual" | null;
  timezone: string | null;
  start_at: string | null;
  max_items_per_run: number | null;
  params: string | null;
}

export type { ScheduledTaskRow } from "../application/ports.ts";

const DEFAULTS: ScheduledTaskRow = {
  enabled: false,
  trigger: { type: "manual" },
  maxItemsPerRun: 10,
  params: {},
};

/**
 * The sole source of a task's schedule configuration. A missing row simply
 * means "use the built-in defaults" — a task with no row is a plain ad-hoc
 * task, disabled and manual-only until an operator schedules it.
 */
export class SqliteConfigStore implements ScheduleRepository {
  constructor(private readonly db: Database) {}

  all(): Map<string, ScheduledTaskRow> {
    const rows = this.db
      .query<ConfigRow, []>(
        `SELECT task_id, enabled, schedule, trigger_type, timezone, start_at, max_items_per_run, params
           FROM scheduled_task_config`,
      )
      .all();

    return new Map(rows.map((row) => [row.task_id, rowToConfig(row)]));
  }

  get(taskId: string): ScheduledTaskRow | null {
    const row = this.db
      .query<ConfigRow, [string]>(
        `SELECT task_id, enabled, schedule, trigger_type, timezone, start_at, max_items_per_run, params
           FROM scheduled_task_config WHERE task_id = ?`,
      )
      .get(taskId);

    return row ? rowToConfig(row) : null;
  }

  /**
   * Merges `patch` over the stored row (or the defaults, if there is none yet)
   * and writes the full row back. Every field always has a concrete value —
   * there is no "leave it deferred" state to preserve.
   */
  setConfig(taskId: string, patch: Partial<ScheduledTaskRow>): void {
    const current = this.get(taskId) ?? DEFAULTS;
    const next: ScheduledTaskRow = {
      enabled: patch.enabled ?? current.enabled,
      trigger: patch.trigger ?? current.trigger,
      maxItemsPerRun: patch.maxItemsPerRun ?? current.maxItemsPerRun,
      params: patch.params ?? current.params,
    };

    const { scheduleExpr, timezone, startAt } = persistTrigger(next.trigger);

    this.db.run(
      `INSERT INTO scheduled_task_config
         (task_id, enabled, schedule, trigger_type, timezone, start_at, max_items_per_run, params, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (task_id) DO UPDATE SET
         enabled = excluded.enabled,
         schedule = excluded.schedule,
         trigger_type = excluded.trigger_type,
         timezone = excluded.timezone,
         start_at = excluded.start_at,
         max_items_per_run = excluded.max_items_per_run,
         params = excluded.params,
         updated_at = excluded.updated_at`,
      [
        taskId,
        next.enabled ? 1 : 0,
        scheduleExpr,
        next.trigger.type,
        timezone,
        startAt,
        next.maxItemsPerRun,
        toJson(next.params),
        toIso(new Date()),
      ],
    );
  }

  /** Deletes the row so the task reverts to the built-in defaults. */
  clear(taskId: string): void {
    this.db.run("DELETE FROM scheduled_task_config WHERE task_id = ?", [taskId]);
  }
}

function persistTrigger(trigger: Trigger): {
  scheduleExpr: string | null;
  timezone: string | null;
  startAt: string | null;
} {
  if (trigger.type === "cron") {
    return {
      scheduleExpr: trigger.expression,
      timezone: trigger.timezone ?? null,
      startAt: trigger.startAt ?? null,
    };
  }
  if (trigger.type === "once") {
    return {
      scheduleExpr: trigger.at,
      timezone: trigger.timezone ?? null,
      startAt: null,
    };
  }
  return { scheduleExpr: null, timezone: null, startAt: null };
}

function rowToConfig(row: ConfigRow): ScheduledTaskRow {
  const trigger: Trigger =
    row.trigger_type === "cron"
      ? {
          type: "cron",
          expression: row.schedule ?? "",
          timezone: row.timezone ?? undefined,
          startAt: row.start_at ?? undefined,
        }
      : row.trigger_type === "once"
        ? {
            type: "once",
            at: row.schedule ?? "",
            timezone: row.timezone ?? undefined,
          }
        : { type: "manual" };

  return {
    enabled: row.enabled === 1,
    trigger,
    maxItemsPerRun: row.max_items_per_run ?? DEFAULTS.maxItemsPerRun,
    params: fromJson(row.params) ?? {},
  };
}
