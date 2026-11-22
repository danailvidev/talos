import {
  ConnectorError,
  TransientError,
  ValidationError,
  errorFromHttpStatus,
} from "../core/errors.ts";
import type { Logger } from "../logging/logger.ts";
import type { z } from "zod";
import { createHash } from "node:crypto";

/**
 * The one place HTTP becomes our error taxonomy.
 *
 * Every connector goes through this, so retry semantics are identical across
 * GitLab, Jira, Azure DevOps and Slack rather than re-decided in each client.
 * `fetch` is injectable because tests must serve recorded fixtures rather than
 * call live APIs (plan §4, HTTP testability).
 */
export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpClientOptions {
  /** Base API URL, e.g. https://gitlab.com/api/v4. Trailing slash optional. */
  baseUrl: string;
  /** Connector name, attached to every error for operator-facing messages. */
  connector: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  logger?: Logger;
  /** Maximum response retained before JSON decoding unless a call overrides it. */
  jsonMaxBytes?: number;
  /**
   * Process-wide in-flight request budget for this provider origin. Every
   * client with the same connector and origin shares it, including UI reads
   * and scheduled work.
   */
  maxConcurrency?: number;
  /** Maximum requests allowed to wait behind the in-flight provider budget. */
  maxPendingRequests?: number;
  /** Optional non-secret key for provider limits shared across credentials. */
  budgetKey?: string;
  /** Default scheduling class; task/loop clients use background. */
  priority?: "interactive" | "background";
  /** Auth headers. Kept here so no call site has to remember them. */
  headers?: Record<string, string>;
}

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  method?: string;
  /** Used for provider download endpoints that intentionally return a signed URL. */
  redirect?: RequestInit["redirect"];
  /** Non-2xx statuses that are the successful protocol result for this call. */
  acceptedStatuses?: readonly number[];
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  /** JSON body. Serialised and given a Content-Type. */
  body?: unknown;
  /** Caller cancellation, distinct from the timeout. */
  signal?: AbortSignal;
  accept?: string;
  /**
   * Maximum bytes retained from the response body. The response is still read
   * to completion so callers requesting trace head+tail receive both, but it
   * is never accumulated unboundedly in memory.
   */
  maxBytes?: number;
  priority?: "interactive" | "background";
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  /** Raw bytes, so a byte-accurate cap can be applied before decoding. */
  bytes: Uint8Array;
  /** Bytes received before any in-memory truncation. */
  totalBytes: number;
  /** Whether `bytes` is a bounded head+tail capture rather than the full body. */
  truncated: boolean;
}

/** How much of an error body to quote back to the operator. */
const ERROR_BODY_CHARS = 800;

const DEFAULT_TIMEOUT_MS = 30_000;
/** Enough for normal provider list/diff metadata, but never an unbounded heap claim. */
const DEFAULT_JSON_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENCY = 8;
const providerBudgets = new Map<string, ProviderBudget>();

export class HttpClient {
  private readonly baseUrl: string;
  private readonly connector: string;
  private readonly doFetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly logger?: Logger;
  private readonly headers: Record<string, string>;
  private readonly jsonMaxBytes: number;
  private readonly budget: ProviderBudget;
  private readonly priority: "interactive" | "background";

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.connector = options.connector;
    this.doFetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger;
    this.headers = options.headers ?? {};
    this.jsonMaxBytes = options.jsonMaxBytes ?? DEFAULT_JSON_MAX_BYTES;
    this.priority = options.priority ?? "interactive";
    this.budget = budgetFor(
      this.connector,
      this.baseUrl,
      this.headers,
      options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      options.maxPendingRequests ?? 100,
      options.budgetKey,
    );
  }

  url(path: string, query?: Record<string, QueryValue>): string {
    const base = path.startsWith("/") ? `${this.baseUrl}${path}` : `${this.baseUrl}/${path}`;
    if (!query) return base;

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      // Skipping null/undefined keeps optional filters out of the URL entirely,
      // rather than sending `ref=undefined`.
      if (value == null) continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  async request(path: string, options: RequestOptions = {}): Promise<HttpResponse> {
    const method = options.method ?? "GET";
    const url = this.url(path, options.query);
    const startedAt = performance.now();
    // The deadline includes limiter/cooldown time, not only the network call.
    const requestSignal = this.combineSignals(options.signal);

    const headers: Record<string, string> = {
      accept: options.accept ?? "application/json",
      ...this.headers,
      ...options.headers,
    };

    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["content-type"] = "application/json";
    }

    let release: (() => void) | undefined;
    let response: Response;
    let providerWaitMs = 0;
    try {
      const waitStarted = performance.now();
      release = await this.budget.acquire(requestSignal, options.priority ?? this.priority);
      providerWaitMs = Math.round((performance.now() - waitStarted) * 100) / 100;
      response = await this.doFetch(url, {
        method,
        headers,
        body,
        signal: requestSignal,
        redirect: options.redirect,
      });
    } catch (cause) {
      // Fetch failed before body consumption reached the `finally` below.
      release?.();
      release = undefined;
      // A caller-initiated abort is a shutdown, not a connector fault: let it
      // propagate so the executor stops instead of retrying.
      if (options.signal?.aborted) throw cause;
      throw new TransientError(
        `${this.connector}: ${method} ${redactUrl(url)} failed to complete (${describe(cause)})`,
        { cause, connector: this.connector },
      );
    }
    let captured: Awaited<ReturnType<typeof readResponseBytes>>;
    try {
      captured = await readResponseBytes(response, options.maxBytes);
      // Set the shared cooldown before releasing this request's permit. That
      // ordering stops another queued client from slipping through between a
      // provider's 429 and our observation of its Retry-After instruction.
      if (response.status === 429) this.budget.defer(parseRetryAfterMs(response.headers));
    } finally {
      release?.();
    }
    const bytes = captured.bytes;
    const durationMs = Math.round(performance.now() - startedAt);

    this.logger?.debug(
      {
        connector: this.connector,
        method,
        url: redactUrl(url),
        status: response.status,
        bytes: captured.totalBytes,
        truncated: captured.truncated,
        durationMs,
        providerWaitMs,
        providerRequestMs: Math.max(0, Math.round((durationMs - providerWaitMs) * 100) / 100),
      },
      `${method} ${redactUrl(url)} -> ${response.status}`,
    );

    if (!response.ok && !options.acceptedStatuses?.includes(response.status)) {
      throw errorFromHttpStatus(
        response.status,
        `${this.connector}: ${method} ${redactUrl(url)} returned ${response.status} ${
          response.statusText
        }${bodySuffix(bytes)}`,
        {
          connector: this.connector,
          retryAfterMs: parseRetryAfterMs(response.headers),
        },
      );
    }

    return { status: response.status, headers: response.headers, ...captured };
  }

  /** GET returning a schema-validated body. */
  async getJson<T>(
    schema: z.ZodType<T>,
    path: string,
    options: RequestOptions = {},
  ): Promise<{ data: T; headers: Headers }> {
    const response = await this.request(path, {
      ...options,
      maxBytes: options.maxBytes ?? this.jsonMaxBytes,
    });
    return { data: this.parse(schema, response, path), headers: response.headers };
  }

  async postJson<T>(
    schema: z.ZodType<T>,
    path: string,
    body: unknown,
    options: RequestOptions = {},
  ): Promise<{ data: T; headers: Headers }> {
    const response = await this.request(path, {
      ...options,
      method: "POST",
      body,
      maxBytes: options.maxBytes ?? this.jsonMaxBytes,
    });
    return { data: this.parse(schema, response, path), headers: response.headers };
  }

  async putJson<T>(
    schema: z.ZodType<T>,
    path: string,
    body: unknown,
    options: RequestOptions = {},
  ): Promise<{ data: T; headers: Headers }> {
    const response = await this.request(path, {
      ...options,
      method: "PUT",
      body,
      maxBytes: options.maxBytes ?? this.jsonMaxBytes,
    });
    return { data: this.parse(schema, response, path), headers: response.headers };
  }

  /** DELETE with no body — GitLab note removal returns 204. */
  async delete(path: string, options: RequestOptions = {}): Promise<void> {
    await this.request(path, { ...options, method: "DELETE" });
  }

  /**
   * Raw text, capped at `maxBytes` before decoding.
   *
   * The cap is applied to bytes rather than characters because it exists to
   * protect memory, SQLite rows and token budgets, and a job trace is measured
   * in bytes. Truncation keeps the head and the tail: the head carries the
   * command that ran, the tail carries the error that ended it.
   */
  async getText(
    path: string,
    options: RequestOptions & { maxBytes?: number } = {},
  ): Promise<{ text: string; bytes: number; truncated: boolean }> {
    const response = await this.request(path, { accept: "text/plain", ...options });
    if (!response.truncated) return truncateBytes(response.bytes, options.maxBytes);
    return truncatedCapture(response.bytes, response.totalBytes);
  }

  private parse<T>(schema: z.ZodType<T>, response: HttpResponse, path: string): T {
    if (response.truncated) {
      throw new ConnectorError(
        `${this.connector}: ${path} response exceeded the configured JSON body limit`,
        { connector: this.connector, retryable: false },
      );
    }
    const text = new TextDecoder().decode(response.bytes);

    let raw: unknown;
    try {
      raw = text.length === 0 ? null : JSON.parse(text);
    } catch (cause) {
      throw new ConnectorError(
        `${this.connector}: ${path} returned a body that is not JSON`,
        { cause, connector: this.connector, retryable: false },
      );
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      // Non-retryable: the same response will fail the same way. Either the API
      // changed or we asked for the wrong thing.
      throw new ValidationError(
        `${this.connector}: unexpected response shape from ${path}:\n${parsed.error.issues
          .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n")}`,
        { issues: parsed.error.issues },
      );
    }
    return parsed.data;
  }

  /**
   * Timeout and caller cancellation are separate concerns: a timeout is a
   * transient connector fault worth retrying, an abort is a shutdown.
   */
  private combineSignals(callerSignal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  }
}

/** A FIFO semaphore. Waiting requests remain abortable so navigation never queues stale work. */
class ProviderBudget {
  private active = 0;
  private activeBackground = 0;
  private readonly interactiveWaiters: Array<() => void> = [];
  private readonly backgroundWaiters: Array<() => void> = [];
  private blockedUntil = 0;

  constructor(
    private readonly limit: number,
    private readonly maxPending: number,
  ) {}

  acquire(
    signal?: AbortSignal,
    priority: "interactive" | "background" = "interactive",
  ): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.active += 1;
        if (priority === "background") this.activeBackground += 1;
        signal?.removeEventListener("abort", cancel);
        resolve(() => this.release(priority));
      };
      const cancel = () => {
        const queue = priority === "interactive" ? this.interactiveWaiters : this.backgroundWaiters;
        const index = queue.indexOf(grant);
        if (index >= 0) queue.splice(index, 1);
        reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
      };
      if (this.canGrant(priority)) grant();
      else {
        if (this.interactiveWaiters.length + this.backgroundWaiters.length >= this.maxPending) {
          reject(new Error("provider request queue is at capacity"));
          return;
        }
        (priority === "interactive" ? this.interactiveWaiters : this.backgroundWaiters).push(grant);
        signal?.addEventListener("abort", cancel, { once: true });
      }
    });
  }

  private release(priority: "interactive" | "background"): void {
    this.active -= 1;
    if (priority === "background") this.activeBackground -= 1;
    this.drain();
  }

  /** Coordinates a provider's Retry-After across all clients sharing this budget. */
  defer(delayMs?: number): void {
    if (delayMs == null || delayMs <= 0) return;
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + delayMs);
    setTimeout(() => this.drain(), delayMs);
  }

  private canGrant(priority: "interactive" | "background"): boolean {
    if (this.active >= this.limit || Date.now() < this.blockedUntil) return false;
    return priority === "interactive"
      || this.activeBackground < Math.max(1, this.limit - 1);
  }

  private drain(): void {
    while (this.interactiveWaiters.length > 0 && this.canGrant("interactive")) {
      this.interactiveWaiters.shift()?.();
    }
    while (this.backgroundWaiters.length > 0 && this.canGrant("background")) {
      this.backgroundWaiters.shift()?.();
    }
  }
}

function budgetFor(
  connector: string,
  baseUrl: string,
  headers: Record<string, string>,
  limit: number,
  maxPending: number,
  scopeKey?: string,
): ProviderBudget {
  const origin = new URL(baseUrl).origin;
  // The digest coordinates clients using the same effective credential without
  // retaining or exposing credential material as a map key or metric label.
  const credential = createHash("sha256")
    .update(
      scopeKey ??
        Object.entries(headers)
          .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
          .map(([name, value]) => `${name.toLowerCase()}:${value}`)
          .join("\n"),
    )
    .digest("hex");
  const key = `${connector}:${origin}:${credential}`;
  let budget = providerBudgets.get(key);
  if (!budget) {
    budget = new ProviderBudget(limit, maxPending);
    providerBudgets.set(key, budget);
  }
  return budget;
}

export interface TruncatedText {
  text: string;
  /** Original byte length, before truncation. */
  bytes: number;
  truncated: boolean;
}

/** Fraction of the budget spent on the head; the rest goes to the tail. */
const HEAD_SHARE = 0.6;

export function truncateBytes(bytes: Uint8Array, maxBytes?: number): TruncatedText {
  const decoder = new TextDecoder();
  const total = bytes.byteLength;

  if (maxBytes == null || total <= maxBytes) {
    return { text: decoder.decode(bytes), bytes: total, truncated: false };
  }

  const headBytes = Math.max(1, Math.floor(maxBytes * HEAD_SHARE));
  const tailBytes = Math.max(0, maxBytes - headBytes);
  const omitted = total - headBytes - tailBytes;

  // A cut can land mid-codepoint; the decoder emits U+FFFD rather than throwing,
  // which is the right trade for log text.
  const head = decoder.decode(bytes.subarray(0, headBytes));
  const tail = tailBytes > 0 ? decoder.decode(bytes.subarray(total - tailBytes)) : "";

  return {
    text: `${head}\n\n... [${omitted} bytes omitted of ${total} total] ...\n\n${tail}`,
    bytes: total,
    truncated: true,
  };
}

/**
 * Retry-After is either delta-seconds or an HTTP date. GitLab and Jira both
 * send it; honouring it is what keeps a 429 from becoming a retry storm.
 */
export function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }

  // GitLab sends this on rate limits instead of Retry-After.
  const reset = headers.get("ratelimit-reset");
  if (reset) {
    const epochSeconds = Number(reset.trim());
    if (Number.isFinite(epochSeconds)) {
      return Math.max(0, epochSeconds * 1000 - Date.now());
    }
  }

  return undefined;
}

/**
 * Strips credentials that may appear in a URL. Tokens travel in headers here, so
 * this guards against a caller building a URL by hand.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    for (const key of ["private_token", "access_token", "token"]) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, "[redacted]");
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function bodySuffix(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes).trim();
  if (text.length === 0) return "";
  const quoted =
    text.length > ERROR_BODY_CHARS ? `${text.slice(0, ERROR_BODY_CHARS)}…` : text;
  return `: ${quoted}`;
}

/**
 * Reads a body without first materialising it as one ArrayBuffer. A capped read
 * retains the same 60/40 head/tail shape `truncateBytes` exposes to callers.
 */
async function readResponseBytes(
  response: Response,
  maxBytes?: number,
): Promise<{ bytes: Uint8Array; totalBytes: number; truncated: boolean }> {
  if (maxBytes == null || !response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, totalBytes: bytes.byteLength, truncated: false };
  }

  const reader = response.body.getReader();
  const headLimit = Math.max(1, Math.floor(maxBytes * HEAD_SHARE));
  const tailLimit = Math.max(0, maxBytes - headLimit);
  const head: Uint8Array[] = [];
  let headBytes = 0;
  // Enough to reconstruct a body that turns out to be within the cap. Once the
  // cap is exceeded, retaining any additional whole chunks would defeat it.
  const whole: Uint8Array[] = [];
  let wholeBytes = 0;
  let tail = new Uint8Array(0);
  let totalBytes = 0;

  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      totalBytes += chunk.byteLength;

      if (wholeBytes < maxBytes) {
        const take = Math.min(maxBytes - wholeBytes, chunk.byteLength);
        if (take > 0) {
          whole.push(chunk.slice(0, take));
          wholeBytes += take;
        }
      }

      if (headBytes < headLimit) {
        const take = Math.min(headLimit - headBytes, chunk.byteLength);
        if (take > 0) {
          head.push(chunk.slice(0, take));
          headBytes += take;
        }
      }

      if (tailLimit > 0) {
        if (chunk.byteLength >= tailLimit) {
          tail = chunk.slice(chunk.byteLength - tailLimit);
        } else {
          const fromTail = Math.min(tail.byteLength, tailLimit - chunk.byteLength);
          const joined = new Uint8Array(fromTail + chunk.byteLength);
          if (fromTail > 0) joined.set(tail.subarray(tail.byteLength - fromTail), 0);
          joined.set(chunk, fromTail);
          tail = joined;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes <= maxBytes) {
    // A short body is uncommon on this path, but return an exact reconstruction
    // rather than a duplicate head/tail capture.
    const exact = concatBytes(whole, totalBytes);
    return { bytes: exact, totalBytes, truncated: false };
  }
  return { bytes: concatBytes([...head, tail], headBytes + tail.byteLength), totalBytes, truncated: true };
}

function concatBytes(parts: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Formats a head+tail capture whose original body length is known separately. */
function truncatedCapture(bytes: Uint8Array, totalBytes: number): TruncatedText {
  const headBytes = Math.max(1, Math.floor(bytes.byteLength * HEAD_SHARE));
  const head = new TextDecoder().decode(bytes.subarray(0, headBytes));
  const tail = new TextDecoder().decode(bytes.subarray(headBytes));
  const omitted = totalBytes - bytes.byteLength;
  return {
    text: `${head}\n\n... [${omitted} bytes omitted of ${totalBytes} total] ...\n\n${tail}`,
    bytes: totalBytes,
    truncated: true,
  };
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.name === "TimeoutError" || cause.name === "AbortError"
      ? "timed out"
      : cause.message;
  }
  return String(cause);
}
