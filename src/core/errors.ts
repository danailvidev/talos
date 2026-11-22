/**
 * Error taxonomy. The only question the executor asks of an error is whether
 * retrying it could plausibly succeed, so that answer lives on the error itself
 * rather than in a table of string matches somewhere in the retry logic.
 */

export abstract class TalosError extends Error {
  /**
   * Whether a retry with backoff could plausibly succeed. Both step retries and
   * the job queue honour it: a queued job is attempted again only when some
   * error in its chain says so. Everything else fails once, because the failures
   * seen in practice — an oversized argument, an out-of-memory kill, an agent
   * that exits non-zero — repeat identically, and for an agent job every repeat
   * is another container's worth of tokens.
   */
  abstract readonly retryable: boolean;

  /**
   * Whether the failure is certain to recur until a human changes something —
   * rejected credentials being the motivating case. Overrides `retryable`
   * anywhere in the chain, so a timeout spent in an auth loop is still not
   * retried.
   */
  readonly terminal: boolean = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Base for anything that went wrong talking to an external system. */
export class ConnectorError extends TalosError {
  readonly retryable: boolean;

  constructor(
    message: string,
    options?: { cause?: unknown; retryable?: boolean; connector?: string; status?: number },
  ) {
    super(message, options);
    this.retryable = options?.retryable ?? false;
    this.connector = options?.connector;
    this.status = options?.status;
  }

  readonly connector?: string;
  readonly status?: number;
}

/** Bad or missing credentials. Never retried — the token will not fix itself. */
export class AuthenticationError extends ConnectorError {
  override readonly retryable = false;
  // And not worth queueing for later either: the same token fails the same way
  // on every attempt, so the queue may as well say so on the first.
  override readonly terminal = true;
}

/** Authenticated but not permitted. Never retried. */
export class PermissionError extends ConnectorError {
  override readonly retryable = false;
  /** Somebody has to grant the access; no number of attempts will. */
  override readonly terminal = true;
}

/** HTTP 429. Retried, honouring `retryAfterMs` when the server supplied it. */
export class RateLimitError extends ConnectorError {
  override readonly retryable = true;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options?: { cause?: unknown; connector?: string; retryAfterMs?: number },
  ) {
    super(message, options);
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/** 5xx, socket resets, timeouts. Retried. */
export class TransientError extends ConnectorError {
  override readonly retryable = true;
}

/**
 * A payload did not match its schema: config, an HTTP response, or LLM output.
 * Never retried — the same input produces the same failure.
 */
export class ValidationError extends TalosError {
  readonly retryable = false;
  readonly issues?: unknown;

  constructor(message: string, options?: { cause?: unknown; issues?: unknown }) {
    super(message, options);
    this.issues = options?.issues;
  }
}

/** Misconfiguration: unknown task, missing secret, unparseable YAML. */
export class ConfigError extends TalosError {
  readonly retryable = false;
}

/** A task failed for a reason of its own. */
export class TaskError extends TalosError {
  readonly retryable = false;
  readonly taskId?: string;

  constructor(message: string, options?: { cause?: unknown; taskId?: string }) {
    super(message, options);
    this.taskId = options?.taskId;
  }
}

/** An LLM call failed or returned unusable output. */
export class LlmError extends TalosError {
  readonly retryable: boolean;
  /** Set when the provider rejected our credentials — see `TalosError.terminal`. */
  override readonly terminal: boolean;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      retryable?: boolean;
      terminal?: boolean;
      provider?: string;
    },
  ) {
    super(message, options);
    this.retryable = options?.retryable ?? false;
    this.terminal = options?.terminal ?? false;
    this.provider = options?.provider;
  }

  readonly provider?: string;
}

/**
 * Errors from outside our taxonomy default to non-retryable: retrying an
 * unknown failure risks repeating a side effect we cannot reason about.
 */
export function isRetryable(err: unknown): boolean {
  return err instanceof TalosError && err.retryable;
}

/**
 * Whether any error in the chain says a later attempt could succeed. The chain
 * for the same reason as `isTerminal`: the worker pool sees `TaskError →
 * ConnectorError`, and `TaskError` itself is never retryable.
 */
export function isRetryableCause(err: unknown): boolean {
  let link: unknown = err;
  for (let depth = 0; link != null && depth < 8; depth++) {
    if (link instanceof TalosError && link.retryable) return true;
    link = link instanceof Error ? link.cause : undefined;
  }
  return false;
}

/**
 * Whether any error in the chain says "stop now" — see `TalosError.terminal`.
 *
 * The chain, not just the error itself: by the time the worker pool sees a failed
 * job the real reason is wrapped, typically `TaskError → LlmError`, and a check on
 * the outermost error would never find it. Bounded depth because a `cause` cycle
 * is somebody else's bug and must not become a hang in ours.
 */
export function isTerminal(err: unknown): boolean {
  let link: unknown = err;
  for (let depth = 0; link != null && depth < 8; depth++) {
    if (link instanceof TalosError && link.terminal) return true;
    link = link instanceof Error ? link.cause : undefined;
  }
  return false;
}

/**
 * Maps an HTTP status to the right error class. Every connector routes failed
 * responses through here so retry semantics stay identical across connectors.
 */
export function errorFromHttpStatus(
  status: number,
  message: string,
  options?: { cause?: unknown; connector?: string; retryAfterMs?: number },
): ConnectorError {
  const tagged = { ...options, status };
  if (status === 401) return new AuthenticationError(message, tagged);
  if (status === 403) return new PermissionError(message, tagged);
  if (status === 429) return new RateLimitError(message, tagged);
  if (status >= 500) return new TransientError(message, tagged);
  return new ConnectorError(message, { ...tagged, retryable: false });
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause =
      err.cause instanceof Error ? ` (caused by: ${err.cause.message})` : "";
    return `${err.name}: ${err.message}${cause}`;
  }
  return String(err);
}
