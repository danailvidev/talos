import { RateLimitError, isRetryable } from "./errors.ts";

export interface RetryPolicy {
  /** Total attempts including the first. 1 disables retrying. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Jitter fraction of the computed delay, 0..1. Spreads retry storms. */
  jitter: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitter: 0.2,
};

export const NO_RETRY: RetryPolicy = {
  attempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  jitter: 0,
};

export interface RetryHooks {
  /** Called before each wait, for logging. `attempt` is the one that failed. */
  onRetry?(info: { attempt: number; delayMs: number; error: unknown }): void;
  /** Test seam, so tests need not wait in real time. */
  sleep?(ms: number): Promise<void>;
  /** Test seam for jitter. Returns 0..1. */
  random?(): number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((res) => setTimeout(res, ms));

/**
 * Exponential backoff with jitter, retrying only errors that declare themselves
 * retryable. A 429 carrying Retry-After takes that value over the computed
 * delay: the server knows better than the formula.
 */
export function computeDelayMs(
  attempt: number,
  policy: RetryPolicy,
  error: unknown,
  random: () => number,
): number {
  if (error instanceof RateLimitError && error.retryAfterMs != null) {
    return Math.min(error.retryAfterMs, policy.maxDelayMs);
  }

  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const jitter = capped * policy.jitter * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
  hooks: RetryHooks = {},
): Promise<{ result: T; attempts: number }> {
  const sleep = hooks.sleep ?? defaultSleep;
  const random = hooks.random ?? Math.random;

  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    try {
      return { result: await fn(attempt), attempts: attempt };
    } catch (err) {
      lastError = err;

      const isLast = attempt === policy.attempts;
      if (isLast || !isRetryable(err)) throw err;

      const delayMs = computeDelayMs(attempt, policy, err, random);
      hooks.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws.
  throw lastError;
}
