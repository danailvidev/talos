import type {
  InstanceRepository,
  JobRepository,
  RunRepository,
  ScheduleRepository,
  ScheduledTaskRow,
  SubjectRepository,
  Visibility,
  UpdateTaskInstanceInput,
} from "./ports.ts";
import { TriggerSchema } from "../config/schema.ts";
import type { ScheduledTask } from "../config/resolve-schedule.ts";
import { ConfigError, ValidationError } from "../core/errors.ts";
import type {
  RunOptions,
  TaskExecutionRecord,
  TaskExecutor,
} from "../core/executor.ts";
import { loadInstances } from "../core/instantiate.ts";
import { mergeInvocationParams } from "../core/params-schema.ts";
import type { TaskRegistry } from "../core/registry.ts";
import type { Task } from "../core/task.ts";
import type { StateStore } from "../persistence/state-store.ts";

export interface TaskServiceDeps {
  registry: TaskRegistry;
  jobs?: JobRepository;
  executor: TaskExecutor;
  runs: RunRepository;
  schedules: ScheduleRepository;
  instances: InstanceRepository;
  subjects: SubjectRepository;
  state: StateStore;
  scheduledTask(id: string): ScheduledTask | undefined;
  refresh(): void;
  dryRun: boolean;
}

export class TaskApplicationService {
  constructor(private readonly deps: TaskServiceDeps) {}

  run(
    id: string,
    requestedParams: unknown,
    options: Omit<RunOptions, "params" | "maxItemsPerRun" | "dryRun"> & {
      includeLastRunParams?: boolean;
    } = {},
  ): Promise<TaskExecutionRecord> {
    const task = this.deps.registry.require(id);
    const scheduled = this.deps.scheduledTask(id);
    const params = mergeInvocationParams(
      options.includeLastRunParams === false ? undefined : this.deps.runs.lastRun(id)?.params,
      scheduled?.params,
      requestedParams,
    );
    const { includeLastRunParams: _, ...runOptions } = options;
    return this.deps.executor.run(task, {
      ...runOptions,
      params,
      maxItemsPerRun: scheduled?.maxItemsPerRun,
      dryRun: this.deps.dryRun,
    });
  }

  updateSchedule(id: string, body: unknown): ScheduledTask {
    const task = this.deps.registry.require(id);
    const patch = withDefaultTriggerOnEnable(
      task,
      parseSchedulePatch(task, body),
      this.deps.schedules.get(id),
    );
    this.deps.schedules.setConfig(id, patch);
    this.deps.refresh();
    return this.requireScheduled(id);
  }

  setEnabled(id: string, enabled: boolean): ScheduledTask {
    return this.updateSchedule(id, { enabled });
  }

  clearSchedule(id: string): ScheduledTask {
    this.deps.registry.require(id);
    this.deps.schedules.clear(id);
    this.deps.refresh();
    return this.requireScheduled(id);
  }

  createInstance(input: {
    definitionId: string;
    name: string;
    description?: string;
    visibility?: Visibility;
    ownerId?: string;
    params?: unknown;
    schedule?: unknown;
    promptTemplate?: string;
  }): { task: Task<unknown>; scheduled: ScheduledTask } {
    const definition = this.deps.registry.get(input.definitionId);
    if (!definition || !definition.instantiable) {
      throw new ConfigError(`'${input.definitionId}' is not an instantiable task definition.`);
    }
    const name = input.name.trim();
    if (!name) throw new ConfigError("'name' is required.");

    const params = parseTaskParams(definition, input.params ?? {}, "'params'");
    // Validate the entire request before inserting anything.
    const patch = parseSchedulePatch(definition, {
      ...(isRecord(input.schedule) ? input.schedule : {}),
      params,
    });
    const { id } = this.deps.instances.create({
      definitionId: definition.id,
      name,
      description: input.description,
      visibility: input.visibility,
      ownerId: input.ownerId,
      promptTemplate: input.promptTemplate,
    });
    loadInstances(this.deps.registry, this.deps.instances);
    const task = this.deps.registry.require(id);
    this.deps.schedules.setConfig(id, patch);
    this.deps.refresh();
    return { task, scheduled: this.requireScheduled(id) };
  }

  updateInstance(id: string, metadata: UpdateTaskInstanceInput, schedule?: unknown): ScheduledTask {
    if (!this.deps.instances.get(id)) throw new ConfigError(`No task instance '${id}'.`);
    const task = this.deps.registry.require(id);
    const patch = schedule === undefined ? undefined : parseSchedulePatch(task, schedule);
    if (metadata.name !== undefined && !metadata.name.trim()) throw new ConfigError("'name' cannot be empty.");
    this.deps.instances.update(id, metadata);
    if (patch) this.deps.schedules.setConfig(id, patch);
    this.deps.refresh();
    return this.requireScheduled(id);
  }

  /**
   * Deletes an instance and everything that only existed because of it.
   *
   * Four stores, in an order that matters: unregister first so nothing new can
   * be scheduled or run against the id while the rest is torn down, then drop
   * the schedule (a config row for an unregistered task would be resolved into
   * nothing forever), then the loop's own bookkeeping, and the row itself last —
   * a failure part-way leaves an instance that can be deleted again rather than
   * a registered task with no row behind it.
   *
   * Run history is deliberately kept. It records what an agent actually did to
   * repositories that still exist, so it outlives the loop that ordered it; the
   * rows are simply no longer reachable from a task page.
   *
   * Refuses code-registered definitions: `custom-loop` and friends live in
   * TypeScript, and there is no row to delete.
   */
  async deleteInstance(id: string): Promise<void> {
    const instance = this.deps.instances.get(id);
    if (!instance) throw new ConfigError(`No task instance '${id}'.`);

    if (this.deps.executor.isTaskActive(id) || this.deps.runs.lastRun(id)?.status === "running") {
      throw new ConfigError("This loop is running. Cancel the run before deleting it.");
    }
    if ((this.deps.jobs?.activeCounts([id]).get(id) ?? 0) > 0) {
      throw new ConfigError("This loop has queued or running jobs. Cancel them before deleting it.");
    }
    this.deps.registry.unregister(id);
    this.deps.schedules.clear(id);
    this.deps.subjects.clearLoop(id);
    await this.deps.state.clearTaskState(id);
    this.deps.instances.delete(id);
    this.deps.refresh();
  }

  private requireScheduled(id: string): ScheduledTask {
    const scheduled = this.deps.scheduledTask(id);
    if (!scheduled) throw new ConfigError(`No task '${id}'.`);
    return scheduled;
  }
}

export function parseSchedulePatch(task: Task<unknown>, body: unknown): Partial<ScheduledTaskRow> {
  if (!isRecord(body)) throw new ConfigError("Request body must be a JSON object.");

  const patch: Partial<ScheduledTaskRow> = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

  if (body.trigger != null) {
    const parsed = TriggerSchema.safeParse(body.trigger);
    if (!parsed.success) throw validationError("Invalid trigger", parsed.error.issues);
    patch.trigger = parsed.data;
  }

  if (body.maxItemsPerRun !== undefined) {
    if (
      typeof body.maxItemsPerRun !== "number" ||
      !Number.isInteger(body.maxItemsPerRun) ||
      body.maxItemsPerRun < 1
    ) {
      throw new ConfigError("'maxItemsPerRun' must be a positive integer.");
    }
    patch.maxItemsPerRun = body.maxItemsPerRun;
  }

  if (body.params !== undefined) {
    patch.params = parseTaskParams(task, body.params, "'params'");
  }
  return patch;
}

/**
 * Turning a loop on with no cron stored used to persist `enabled` + `manual`,
 * which the scheduler never fires. If the task declared a default cadence,
 * write that instead so activate actually schedules work.
 */
function withDefaultTriggerOnEnable(
  task: Task<unknown>,
  patch: Partial<ScheduledTaskRow>,
  current: ScheduledTaskRow | null,
): Partial<ScheduledTaskRow> {
  const enabling = patch.enabled === true;
  if (!enabling || !task.defaultTrigger) return patch;
  const trigger = patch.trigger ?? current?.trigger ?? { type: "manual" as const };
  if (trigger.type !== "manual") return patch;
  return { ...patch, trigger: task.defaultTrigger };
}

function parseTaskParams(task: Task<unknown>, raw: unknown, label: string): unknown {
  const parsed = task.paramsSchema.safeParse(raw);
  if (!parsed.success) {
    throw validationError(`Invalid ${label} for task '${task.id}'`, parsed.error.issues);
  }
  return parsed.data;
}

function validationError(prefix: string, issues: readonly { path: PropertyKey[]; message: string }[]) {
  const detail = issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  return new ValidationError(`${prefix}:\n${detail}`, { issues });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
