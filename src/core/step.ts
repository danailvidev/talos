import type { Logger } from "../logging/logger.ts";
import { withRetry, type RetryPolicy } from "./retry.ts";
import { describeError } from "./errors.ts";

/**
 * Wraps a unit of work inside a task run with logging, timing, retry and
 * dry-run guarding.
 */

export type RunStatus = "success" | "failure" | "cancelled";
export type StepStatus = Exclude<RunStatus, "cancelled">;

export interface StepRecord {
  stepId: string;
  startedAt: Date;
  durationMs: number;
  status: StepStatus;
  attempts: number;
  error?: string;
}

export interface StepOptions {
  retry?: RetryPolicy;
  /** Merged into the step's log lines. Redaction still applies. */
  meta?: Record<string, unknown>;
}

export interface StepSink {
  stepFinished(executionId: string, step: StepRecord): Promise<void>;
}

/**
 * Single guard for every outward write. Without this, a run cannot be tested
 * against a real external system.
 *
 * Returns null when suppressed, so callers must handle the dry-run case rather
 * than reading through to a fabricated result.
 */
export async function mutate<T>(
  ctx: { dryRun: boolean; logger: Logger },
  description: string,
  fn: () => Promise<T>,
  details?: Record<string, unknown>,
): Promise<T | null> {
  if (ctx.dryRun) {
    // The logger's child bindings already carry dryRun, so only the action is
    // added here — repeating the flag produces a duplicate JSON key.
    ctx.logger.info(
      { action: description, ...details },
      `[dry-run] would ${description}`,
    );
    return null;
  }
  return fn();
}

/**
 * Runs one unit of work: logs start and finish, records duration and attempt
 * count, persists a step record via `sink`, and applies the retry policy.
 */
export async function runTrackedStep<T>(args: {
  stepId: string;
  fn: () => Promise<T>;
  opts?: StepOptions;
  logger: Logger;
  executionId: string;
  steps: StepRecord[];
  sink: StepSink;
  defaultRetry: RetryPolicy;
}): Promise<T> {
  const stepLogger = args.logger.child({ step: args.stepId, ...args.opts?.meta });
  const startedAt = new Date();
  const startedMs = performance.now();
  const policy = args.opts?.retry ?? args.defaultRetry;

  stepLogger.info({ status: "started" }, `step ${args.stepId} started`);

  const record = async (
    status: StepStatus,
    attempts: number,
    error?: unknown,
  ): Promise<void> => {
    const entry: StepRecord = {
      stepId: args.stepId,
      startedAt,
      durationMs: Math.round(performance.now() - startedMs),
      status,
      attempts,
      ...(error !== undefined ? { error: describeError(error) } : {}),
    };
    args.steps.push(entry);
    await args.sink.stepFinished(args.executionId, entry);

    const line = { status, durationMs: entry.durationMs, attempts };
    if (status === "success") {
      stepLogger.info(line, `step ${args.stepId} succeeded`);
    } else {
      stepLogger.error({ ...line, err: error }, `step ${args.stepId} failed`);
    }
  };

  try {
    const { result, attempts } = await withRetry(args.fn, policy, {
      onRetry: ({ attempt, delayMs, error }) =>
        stepLogger.warn(
          { attempt, delayMs, err: error },
          `step ${args.stepId} attempt ${attempt} failed, retrying in ${delayMs}ms`,
        ),
    });
    await record("success", attempts);
    return result;
  } catch (err) {
    // withRetry consumed the attempts internally; recover the count for the
    // record rather than threading it out through the throw path.
    await record("failure", attemptsFrom(err, policy), err);
    throw err;
  }
}

/**
 * A non-retryable error failed on its first attempt; a retryable one exhausted
 * the policy. Close enough for a record, and avoids widening the throw path.
 */
function attemptsFrom(err: unknown, policy: RetryPolicy): number {
  return err instanceof Error && "retryable" in err && err.retryable === true
    ? policy.attempts
    : 1;
}
