import type {
  ScheduleRepository,
  ScheduledTaskRow,
} from "../application/ports.ts";
import type { TaskRegistry } from "../core/registry.ts";
import type { Task } from "../core/task.ts";
import { applyParamsDefaults } from "../core/params-schema.ts";
import type { Trigger } from "./schema.ts";

export type ConfigOrigin = "db" | "default";

export interface ResolvedField<T> {
  value: T;
  origin: ConfigOrigin;
}

/**
 * A task plus its resolved schedule — the effective view of "would this run
 * on its own, and with what". Not a separate entity: "scheduling" is just an
 * optional, stored configuration (enabled/trigger/maxItemsPerRun/params) that
 * can be attached to any task by id. A task with no stored row is still a
 * ScheduledTask, just one that defaults to disabled and manual-only.
 */
export interface ScheduledTask {
  id: string;
  enabled: ResolvedField<boolean>;
  trigger: ResolvedField<Trigger>;
  maxItemsPerRun: number;
  /** Stored params with task-schema defaults applied. */
  params: unknown;
}

/**
 * Resolves one task's schedule from its stored row, or the built-in defaults
 * when no row exists — a newly-registered task starts disabled and
 * manual-only until an operator schedules it through the web UI.
 *
 * Legacy YAML workflow blocks are imported once before resolution. Runtime
 * reads use only the database, so a later file edit cannot shadow a live edit.
 */
export function resolveScheduledTask(
  task: Task<any>,
  row: ScheduledTaskRow | null,
): ScheduledTask {
  const enabled: ResolvedField<boolean> = row
    ? { value: row.enabled, origin: "db" }
    : { value: false, origin: "default" };

  const trigger: ResolvedField<Trigger> = resolveTrigger(task, row);

  return {
    id: task.id,
    enabled,
    trigger,
    maxItemsPerRun: row?.maxItemsPerRun ?? 10,
    params: applyParamsDefaults(task.paramsSchema, row?.params),
  };
}

export function resolveAllScheduledTasks(
  registry: TaskRegistry,
  configStore: ScheduleRepository,
): ScheduledTask[] {
  const rows = configStore.all();
  return registry.all().map((task) =>
    resolveScheduledTask(task, rows.get(task.id) ?? null),
  );
}

/**
 * A loop that declares `defaultTrigger` must actually fire when turned on.
 * Toggling enabled on the dashboard used to persist `manual`, which the
 * scheduler ignores — so "activated" meant nothing ran. An explicit cron/once
 * stored on the row still wins.
 */
function resolveTrigger(task: Task<any>, row: ScheduledTaskRow | null): ResolvedField<Trigger> {
  if (row && row.trigger.type !== "manual") {
    return { value: row.trigger, origin: "db" };
  }
  if (task.defaultTrigger) {
    // Enabled + leftover manual (the dashboard-toggle bug) uses the default
    // so a restart starts the loop without another click. Disabled keeps the
    // default visible as the cadence that will apply on activate.
    return { value: task.defaultTrigger, origin: "default" };
  }
  if (row) return { value: row.trigger, origin: "db" };
  return { value: { type: "manual" }, origin: "default" };
}

