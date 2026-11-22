import type { Database } from "bun:sqlite";
import type { ScheduleRepository, ScheduledTaskRow } from "../application/ports.ts";
import type { TaskRegistry } from "../core/registry.ts";
import { definedRecord } from "../core/params-schema.ts";
import type { Logger } from "../logging/logger.ts";
import { toIso } from "../persistence/database.ts";
import { TriggerSchema, type Trigger } from "./schema.ts";

const SCHEDULE_KEYS = new Set(["enabled", "schedule", "maxItemsPerRun", "trigger"]);

export interface LegacyWorkflowImportResult {
  imported: string[];
  skipped: string[];
  invalid: string[];
}

/**
 * Copies legacy `workflows.<taskId>` YAML into SQLite exactly once per
 * registered task. Existing rows always win; YAML only fills missing nested
 * params in those rows. Each row write and its marker share one transaction.
 */
export function importLegacyWorkflows(args: {
  db: Database;
  schedules: ScheduleRepository;
  registry: TaskRegistry;
  workflows?: Record<string, unknown>;
  logger: Logger;
}): LegacyWorkflowImportResult {
  const result: LegacyWorkflowImportResult = {
    imported: [],
    skipped: [],
    invalid: [],
  };

  for (const [taskId, rawBlock] of Object.entries(args.workflows ?? {})) {
    const task = args.registry.get(taskId);
    if (!task) {
      args.logger.warn(
        { task: taskId },
        `legacy workflow ${taskId} was not imported because it is not registered`,
      );
      result.skipped.push(taskId);
      continue;
    }

    if (wasImported(args.db, taskId)) {
      result.skipped.push(taskId);
      continue;
    }

    const block = definedRecord(rawBlock);
    const existing = args.schedules.get(taskId);
    const trigger = existing ? undefined : legacyTrigger(block);
    if (trigger instanceof Error) {
      args.logger.warn(
        { task: taskId, error: trigger.message },
        `legacy workflow ${taskId} has an invalid trigger and was not imported`,
      );
      result.invalid.push(taskId);
      continue;
    }

    const yamlParams = legacyParams(block);
    const patch: Partial<ScheduledTaskRow> = {
      params: deepMerge(yamlParams, existing?.params),
    };

    if (!existing) {
      if (typeof block.enabled === "boolean") patch.enabled = block.enabled;
      if (trigger) patch.trigger = trigger;
      if (
        typeof block.maxItemsPerRun === "number" &&
        Number.isInteger(block.maxItemsPerRun) &&
        block.maxItemsPerRun >= 1
      ) {
        patch.maxItemsPerRun = block.maxItemsPerRun;
      }
    }

    args.db.transaction(() => {
      // Recheck inside the transaction in case two app instances start together.
      if (wasImported(args.db, taskId)) return;
      args.schedules.setConfig(taskId, patch);
      args.db.run(
        "INSERT INTO legacy_workflow_imports (task_id, imported_at) VALUES (?, ?)",
        [taskId, toIso(new Date())],
      );
      result.imported.push(taskId);
    })();
  }

  if (result.imported.length > 0) {
    args.logger.info(
      { tasks: result.imported },
      `imported ${result.imported.length} legacy YAML workflow(s) into SQLite`,
    );
  }

  return result;
}

function wasImported(db: Database, taskId: string): boolean {
  return db
    .query<{ found: number }, [string]>(
      "SELECT 1 AS found FROM legacy_workflow_imports WHERE task_id = ?",
    )
    .get(taskId) !== null;
}

function legacyTrigger(block: Record<string, unknown>): Trigger | undefined | Error {
  if (block.trigger !== undefined) {
    const parsed = TriggerSchema.safeParse(block.trigger);
    return parsed.success
      ? parsed.data
      : new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  if (block.schedule === undefined) return undefined;
  const parsed = TriggerSchema.safeParse({
    type: "cron",
    expression: block.schedule,
  });
  return parsed.success
    ? parsed.data
    : new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
}

function legacyParams(block: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block)) {
    if (!SCHEDULE_KEYS.has(key) && value !== undefined) params[key] = value;
  }
  return params;
}

/** Recursively layers existing DB params over YAML defaults. */
function deepMerge(defaults: unknown, override: unknown): unknown {
  if (override !== undefined && !isPlainRecord(override)) return override;
  const out = { ...definedRecord(defaults) };
  for (const [key, value] of Object.entries(override ?? {})) {
    const fallback = out[key];
    out[key] =
      isPlainRecord(fallback) && isPlainRecord(value)
        ? deepMerge(fallback, value)
        : value;
  }
  return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
