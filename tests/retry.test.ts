import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  RateLimitError,
  TransientError,
  ValidationError,
  errorFromHttpStatus,
  isRetryable,
} from "../src/core/errors.ts";
import { DEFAULT_RETRY, computeDelayMs, withRetry } from "../src/core/retry.ts";

/** Records waits instead of performing them, so tests run instantly. */
function fakeClock() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    // Midpoint of the jitter range, making delays deterministic.
    random: () => 0.5,
  };
}

describe("error classification", () => {
  test("maps HTTP statuses to the right retry semantics", () => {
    expect(errorFromHttpStatus(401, "x")).toBeInstanceOf(AuthenticationError);
    expect(isRetryable(errorFromHttpStatus(401, "x"))).toBe(false);
    expect(isRetryable(errorFromHttpStatus(403, "x"))).toBe(false);
    expect(isRetryable(errorFromHttpStatus(404, "x"))).toBe(false);
    expect(isRetryable(errorFromHttpStatus(429, "x"))).toBe(true);
    expect(isRetryable(errorFromHttpStatus(502, "x"))).toBe(true);
    expect(isRetryable(errorFromHttpStatus(503, "x"))).toBe(true);
  });

  test("validation failures are never retryable — same input, same failure", () => {
    expect(isRetryable(new ValidationError("bad shape"))).toBe(false);
  });

  test("errors outside the taxonomy default to non-retryable", () => {
    expect(isRetryable(new Error("who knows"))).toBe(false);
    expect(isRetryable("a string")).toBe(false);
  });
});

describe("withRetry", () => {
  test("returns immediately on success without sleeping", async () => {
    const clock = fakeClock();
    const { result, attempts } = await withRetry(async () => 42, DEFAULT_RETRY, clock);
    expect(result).toBe(42);
    expect(attempts).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  test("retries a transient failure and reports the attempt count", async () => {
    const clock = fakeClock();
    let calls = 0;

    const { result, attempts } = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new TransientError("gateway hiccup");
        return "ok";
      },
      DEFAULT_RETRY,
      clock,
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(clock.waits).toHaveLength(2);
  });

  test("does not retry a non-retryable error", async () => {
    const clock = fakeClock();
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls++;
          throw new AuthenticationError("bad token");
        },
        DEFAULT_RETRY,
        clock,
      ),
    ).rejects.toThrow(AuthenticationError);

    expect(calls).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  test("gives up after the configured attempts and rethrows the last error", async () => {
    const clock = fakeClock();
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls++;
          throw new TransientError(`attempt ${calls}`);
        },
        { attempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: 0 },
        clock,
      ),
    ).rejects.toThrow("attempt 3");

    expect(calls).toBe(3);
    // Two waits for three attempts: no sleep after the final failure.
    expect(clock.waits).toHaveLength(2);
  });

  test("attempts: 1 disables retrying", async () => {
    const clock = fakeClock();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new TransientError("nope");
        },
        { attempts: 1, baseDelayMs: 10, maxDelayMs: 10, jitter: 0 },
        clock,
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("computeDelayMs", () => {
  const policy = { attempts: 5, baseDelayMs: 1000, maxDelayMs: 30_000, jitter: 0 };
  const err = new TransientError("x");

  test("grows exponentially", () => {
    expect(computeDelayMs(1, policy, err, () => 0.5)).toBe(1000);
    expect(computeDelayMs(2, policy, err, () => 0.5)).toBe(2000);
    expect(computeDelayMs(3, policy, err, () => 0.5)).toBe(4000);
  });

  test("caps at maxDelayMs", () => {
    expect(computeDelayMs(20, policy, err, () => 0.5)).toBe(30_000);
  });

  test("honours Retry-After over the computed delay — the server knows better", () => {
    const rateLimited = new RateLimitError("slow down", { retryAfterMs: 7_500 });
    expect(computeDelayMs(1, policy, rateLimited, () => 0.5)).toBe(7_500);
  });

  test("clamps Retry-After to maxDelayMs so a hostile header cannot stall a run", () => {
    const rateLimited = new RateLimitError("slow down", { retryAfterMs: 999_999 });
    expect(computeDelayMs(1, policy, rateLimited, () => 0.5)).toBe(30_000);
  });

  test("jitter stays within bounds and never goes negative", () => {
    const jittered = { ...policy, jitter: 0.5 };
    expect(computeDelayMs(1, jittered, err, () => 0)).toBe(500);
    expect(computeDelayMs(1, jittered, err, () => 1)).toBe(1500);
    expect(computeDelayMs(1, { ...policy, jitter: 2 }, err, () => 0)).toBe(0);
  });
});
