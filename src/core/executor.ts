import { randomUUID } from "node:crypto";
import type { Actor } from "./actor.ts";
import type { LlmDefaultsScope } from "./task.ts";
import type { Logger } from "../logging/logger.ts";
import type { ExecutionLogLine } from "../logging/capture.ts";
import type { SecretStore } from "../secrets/secret-store.ts";
import type { StateStore } from "../persistence/state-store.ts";
import { TaskError, ValidationError, describeError } from "./errors.ts";
import { DEFAULT_RETRY, type RetryPolicy } from "./retry.ts";
import {
  runTrackedStep,
  type RunStatus,
  type StepRecord,
  type StepSink,
} from "./step.ts";
import type { Task, TaskContext, TaskResult } from "./task.ts";

export { describeError } from "./errors.ts";
export type { RunStatus, StepRecord } from "./step.ts";

export interface TaskExecutionRecord {
  executionId: string;
  taskId: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  status: RunStatus;
  dryRun: boolean;
  /** The validated params the run was invoked with — ad-hoc or from a stored schedule. */
  params: unknown;
  result?: TaskResult;
  error?: string;
  steps: StepRecord[];
}

/**
 * Where execution records go. Phase 3 supplies a SQLite implementation; until
 * then records are logged and returned to the caller.
 */
export interface TaskExecutionSink extends StepSink {
  runStarted(record: {
    executionId: string;
    taskId: string;
    startedAt: Date;
    dryRun: boolean;
    params: unknown;
  }): Promise<void>;
  runFinished(record: TaskExecutionRecord): Promise<void>;
  /** Optional: persist a log line without going through the pino tee. */
  appendLog?(executionId: string, line: ExecutionLogLine): void;
}

export const NULL_TASK_SINK: TaskExecutionSink = {
  async runStarted() {},
  async stepFinished() {},
  async runFinished() {},
};

export interface TaskExecutorOptions {
  logger: Logger;
  state: StateStore;
  secrets: SecretStore;
  sink?: TaskExecutionSink;
  defaultRetry?: RetryPolicy;
  /** Test seam so execution ids are deterministic. */
  generateExecutionId?: () => string;
  /**
   * Live LLM defaults for this process. A getter rather than a snapshot so a
   * settings edit is seen by the next run without reconstructing the executor.
   */
  getLlm?: (actor: Actor | undefined, scope: LlmDefaultsScope) => TaskContext["llm"];
  /**
   * Live prompt-template overrides for this process. Same rationale as
   * `getLlm`: a getter so a prompt edit is seen by the next run without
   * reconstructing the executor. Takes the taskId to allow per-loop overrides.
   */
  getPrompts?: (taskId: string) => TaskContext["prompts"];
  /**
   * Builds the secret store for a run that has an actor — their own tokens
   * layered over the shared ones. Injected rather than built here because
   * decrypting them needs the database, which `core` may not reach.
   *
   * Omitted, every run uses the shared `secrets`, which is exactly the behaviour
   * before per-developer credentials existed.
   */
  secretsFor?: (actor: Actor, logger: Logger) => SecretStore;
}

export interface RunOptions {
  dryRun?: boolean;
  /** Cap on items to act on this run. Defaults to 10 inside the executor. */
  maxItemsPerRun?: number;
  signal?: AbortSignal;
  /**
   * Raw params, validated against the task's paramsSchema. The caller decides
   * whether these came from an API body or from stored schedule config — the
   * executor treats every run the same way regardless of where its params originated.
   */
  params?: unknown;
  /**
   * Manual API runs set this so tasks that otherwise skip already-seen work
   * (code-review ledger, …) still act. Scheduled ticks leave it off.
   */
  force?: boolean;
  /**
   * The developer this run is for. The API takes it from the session, a
   * scheduled tick from the loop's owner, and a job from `job.actorId`. Their
   * stored credentials become the run's secrets.
   */
  actor?: Actor;
  /**
   * Instance defaults are reserved for loops and durable work discovered by
   * them. Everything directly started by a developer uses their own defaults.
   */
  llmScope?: LlmDefaultsScope;
  /**
   * Fires after the run row is opened (and before `task.run`). The HTTP API
   * uses this to return 202 while the work continues, instead of holding the
   * request open for the whole review.
   */
  onStarted?: (info: { executionId: string }) => void;
}

/**
 * Runs one task through the lifecycle in plan §12: create an execution id,
 * open a run record, build the context, run, persist, close the record.
 *
 * Failures are recorded and rethrown — the caller decides whether a failed run
 * is fatal (CLI: exit non-zero) or merely logged (a scheduler: carry on to the
 * next tick).
 */
export class TaskExecutor {
  private readonly logger: Logger;
  private readonly state: StateStore;
  private readonly secrets: SecretStore;
  private readonly sink: TaskExecutionSink;
  private readonly defaultRetry: RetryPolicy;
  private readonly generateExecutionId: () => string;
  private readonly getLlm: (
    actor: Actor | undefined,
    scope: LlmDefaultsScope,
  ) => TaskContext["llm"];
  private readonly getPrompts: (taskId: string) => TaskContext["prompts"];
  private readonly secretsFor?: (actor: Actor, logger: Logger) => SecretStore;
  private readonly active = new Map<
    string,
    { taskId: string; controller: AbortController }
  >();

  constructor(options: TaskExecutorOptions) {
    this.logger = options.logger;
    this.state = options.state;
    this.secrets = options.secrets;
    this.sink = options.sink ?? NULL_TASK_SINK;
    this.defaultRetry = options.defaultRetry ?? DEFAULT_RETRY;
    this.generateExecutionId =
      options.generateExecutionId ?? (() => `task-${randomUUID()}`);
    this.getLlm =
      options.getLlm ??
      (() => ({ provider: "anthropic", maxTokens: 2048 }));
    this.getPrompts = options.getPrompts ?? ((_taskId: string) => ({}));
    this.secretsFor = options.secretsFor;
  }

  async run<P>(
    task: Task<P>,
    options: RunOptions = {},
  ): Promise<TaskExecutionRecord> {
    const executionId = this.generateExecutionId();
    const dryRun = options.dryRun ?? false;
    const maxItemsPerRun = options.maxItemsPerRun ?? 10;
    const startedAt = new Date();
    const steps: StepRecord[] = [];

    const logger = this.logger.child({
      task: task.id,
      executionId,
      ...(dryRun ? { dryRun: true } : {}),
      // On every line of the run, not only the started one: "which developer did
      // talos act as" is the question an operator asks about a comment that
      // already happened, and the answer has to be findable from any line of it.
      ...(options.actor ? { actor: options.actor.email } : {}),
    });

    // Resolved before the run record opens, so a decryption failure (a rotated
    // TALOS_SECRET_KEY) is the caller's error rather than a task failure.
    const secrets =
      options.actor && this.secretsFor
        ? this.secretsFor(options.actor, logger)
        : this.secrets;

    // Params are validated before the run record opens: a params error is the
    // caller's mistake, not a task failure worth recording as one.
    const params = this.validateParams(task, options.params);

    await this.sink.runStarted({
      executionId,
      taskId: task.id,
      startedAt,
      dryRun,
      params,
    });
    // Persist the first line through the sink, not only pino: the UI polls
    // `task_run_logs`, and a pino tee can drop a line (SQLITE_BUSY against a
    // second process, async flush, …) which looks like a run that never started.
    this.sink.appendLog?.(executionId, {
      ts: startedAt,
      level: "info",
      message: `task ${task.id} started`,
      meta: { status: "started" },
    });
    logger.info({ status: "started" }, `task ${task.id} started`);

    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort(options.signal.reason);
      else {
        options.signal.addEventListener(
          "abort",
          () => controller.abort(options.signal?.reason),
          { once: true },
        );
      }
    }

    const ctx: TaskContext = {
      taskId: task.id,
      executionId,
      logger,
      state: this.state,
      secrets,
      ...(options.actor ? { actor: options.actor } : {}),
      dryRun,
      maxItemsPerRun,
      force: options.force === true,
      signal: controller.signal,
      llm: this.getLlm(
        options.actor,
        options.llmScope ?? (task.kind === "loop" ? "instance" : "actor"),
      ),
      prompts: this.getPrompts(task.id),
      step: (stepId, fn, opts) =>
        runTrackedStep({
          stepId,
          fn,
          opts,
          logger,
          executionId,
          steps,
          sink: this.sink,
          defaultRetry: this.defaultRetry,
        }),
    };

    this.active.set(executionId, { taskId: task.id, controller });
    options.onStarted?.({ executionId });

    let closed = false;
    try {
      const result = await task.run(ctx, params);
      if (controller.signal.aborted) {
        return await this.finish({
          executionId,
          taskId: task.id,
          startedAt,
          status: "cancelled",
          dryRun,
          params,
          result,
          error: cancelReason(controller.signal),
          steps,
          logger,
        });
      }
      if ((result.itemsFailed ?? 0) > 0) {
        const err = new TaskError(failedItemsMessage(result), { taskId: task.id });
        await this.finish({
          executionId,
          taskId: task.id,
          startedAt,
          status: "failure",
          dryRun,
          params,
          result,
          error: err,
          steps,
          logger,
        });
        closed = true;
        throw new TaskError(`Task '${task.id}' failed: ${describeError(err)}`, {
          cause: err,
          taskId: task.id,
        });
      }
      return await this.finish({
        executionId,
        taskId: task.id,
        startedAt,
        status: "success",
        dryRun,
        params,
        result,
        steps,
        logger,
      });
    } catch (err) {
      if (closed) throw err;
      if (controller.signal.aborted || isAbortError(err)) {
        return await this.finish({
          executionId,
          taskId: task.id,
          startedAt,
          status: "cancelled",
          dryRun,
          params,
          error: cancelReason(controller.signal, err),
          steps,
          logger,
        });
      }
      await this.finish({
        executionId,
        taskId: task.id,
        startedAt,
        status: "failure",
        dryRun,
        params,
        error: err,
        steps,
        logger,
      });
      throw new TaskError(`Task '${task.id}' failed: ${describeError(err)}`, {
        cause: err,
        taskId: task.id,
      });
    } finally {
      this.active.delete(executionId);
    }
  }

  /**
   * Aborts an in-flight run in this process. Returns false when this process
   * is not the one running it (orphaned row, another CLI).
   */
  cancel(executionId: string): boolean {
    const run = this.active.get(executionId);
    if (!run) return false;
    run.controller.abort("cancelled by operator");
    return true;
  }

  /** Aborts every in-flight run of `taskId`. */
  cancelTask(taskId: string): string[] {
    const ids: string[] = [];
    for (const [executionId, run] of this.active) {
      if (run.taskId !== taskId) continue;
      run.controller.abort("cancelled by operator");
      ids.push(executionId);
    }
    return ids;
  }

  cancelAll(): string[] {
    const ids = [...this.active.keys()];
    for (const run of this.active.values()) {
      run.controller.abort("cancelled by operator");
    }
    return ids;
  }

  isActive(executionId: string): boolean {
    return this.active.has(executionId);
  }

  isTaskActive(taskId: string): boolean {
    for (const run of this.active.values()) {
      if (run.taskId === taskId) return true;
    }
    return false;
  }

  private validateParams<P>(task: Task<P>, raw: unknown): P {
    const parsed = task.paramsSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      throw new ValidationError(
        `Invalid params for task '${task.id}':\n${detail}`,
        { issues: parsed.error.issues },
      );
    }
    return parsed.data;
  }

  private async finish(args: {
    executionId: string;
    taskId: string;
    startedAt: Date;
    status: RunStatus;
    dryRun: boolean;
    params: unknown;
    steps: StepRecord[];
    logger: Logger;
    result?: TaskResult;
    error?: unknown;
  }): Promise<TaskExecutionRecord> {
    const finishedAt = new Date();
    const record: TaskExecutionRecord = {
      executionId: args.executionId,
      taskId: args.taskId,
      startedAt: args.startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - args.startedAt.getTime(),
      status: args.status,
      dryRun: args.dryRun,
      params: args.params,
      steps: args.steps,
      ...(args.result ? { result: args.result } : {}),
      ...(args.error !== undefined
        ? { error: describeError(args.error) }
        : {}),
    };

    await this.sink.runFinished(record);

    const line = {
      status: record.status,
      durationMs: record.durationMs,
      ...(record.result ?? {}),
    };
    if (record.status === "success") {
      args.logger.info(line, `task ${args.taskId} succeeded`);
    } else if (record.status === "cancelled") {
      args.logger.warn(line, `task ${args.taskId} cancelled`);
    } else {
      args.logger.error(
        { ...line, err: args.error },
        `task ${args.taskId} failed`,
      );
    }

    return record;
  }
}

/**
 * Prefers the per-item "failed …" notes a batching task already collected,
 * so the run error is the same sentence the activity log already showed.
 */
function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

function cancelReason(signal: AbortSignal, err?: unknown): string {
  if (typeof signal.reason === "string" && signal.reason.length > 0) {
    return signal.reason;
  }
  if (isAbortError(err)) return "cancelled by operator";
  if (err !== undefined) return describeError(err);
  return "cancelled by operator";
}

function failedItemsMessage(result: TaskResult): string {
  const notes = result.details?.notes;
  if (Array.isArray(notes)) {
    const failed = notes.filter(
      (note): note is string => typeof note === "string" && note.startsWith("failed "),
    );
    if (failed.length > 0) return failed.join("; ");
  }
  return `${result.itemsFailed} item(s) failed`;
}
