import pino, { type Logger, type LoggerOptions } from "pino";
import pinoPretty from "pino-pretty";

export type { Logger };

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export const LOG_LEVELS: readonly LogLevel[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
];

/**
 * Key paths Pino blanks out before serialization. Retrofitting this after
 * connectors exist would mean auditing every log call, so it is installed
 * before the first connector is written.
 */
const REDACT_PATHS = [
  "token",
  "apiKey",
  "apiToken",
  "password",
  "secret",
  "authorization",
  "privateKey",
  "*.token",
  "*.apiKey",
  "*.apiToken",
  "*.password",
  "*.secret",
  "*.authorization",
  "headers.authorization",
  "headers.Authorization",
  "*.headers.authorization",
  "*.headers.Authorization",
  "req.headers.authorization",
  "res.headers.authorization",
];

const REDACTED = "[redacted]";

/** Below this length a "secret" is more likely a placeholder than a credential. */
const MIN_SECRET_LENGTH = 8;

/**
 * Secret values discovered after the logger was built.
 *
 * Per-developer credentials are decrypted when a run starts, long after
 * `createLogger` ran, and a scrubber frozen at construction would print them in
 * full — exactly the tokens that belong to a person rather than a service
 * account. So the target set is live, and the generation counter is what lets a
 * scrubber notice it grew without re-sorting on every log call.
 */
const registered = new Set<string>();
let generation = 0;

/**
 * Adds values to be scrubbed from every subsequent line, on every logger in the
 * process. Deliberately global: pino children share their parent's hooks, so
 * there is no per-run logger to attach this to, and a token leaked through the
 * wrong child is leaked all the same.
 */
export function registerSecretValues(values: readonly string[]): void {
  for (const value of values) {
    if (value.length < MIN_SECRET_LENGTH || registered.has(value)) continue;
    registered.add(value);
    generation++;
  }
}

/**
 * Path-based redaction only catches secrets logged under a predictable key. A
 * token interpolated into a message or a URL slips straight through, so known
 * secret values are also substituted by literal match.
 */
function buildValueScrubber(secrets: readonly string[]) {
  const base = new Set(secrets);
  let targets: string[] = [];
  let built = -1;

  const rebuild = (): void => {
    targets = [...new Set([...base, ...registered])]
      .filter((s) => s.length >= MIN_SECRET_LENGTH)
      // Longest first, so a secret that contains another is replaced whole.
      .sort((a, b) => b.length - a.length);
    built = generation;
  };

  return function scrub(value: unknown, depth = 0): unknown {
    if (depth === 0 && built !== generation) rebuild();
    // The common case for a logger with no secrets at all: walking the object
    // graph to replace nothing is pure cost.
    if (targets.length === 0) return value;
    if (depth > 8) return value;

    if (typeof value === "string") {
      let out = value;
      for (const secret of targets) out = out.replaceAll(secret, REDACTED);
      return out;
    }

    if (Array.isArray(value)) {
      return value.map((item) => scrub(item, depth + 1));
    }

    if (value !== null && typeof value === "object") {
      // Errors do not survive a spread; carry the useful fields across by hand.
      if (value instanceof Error) {
        const clone: Record<string, unknown> = {
          name: value.name,
          message: scrub(value.message, depth + 1),
        };
        if (value.stack) clone.stack = scrub(value.stack, depth + 1);
        return clone;
      }

      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = scrub(item, depth + 1);
      }
      return out;
    }

    return value;
  };
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  /** Human-readable output. Defaults to on when stdout is a TTY. */
  pretty?: boolean;
  /** Secret values to scrub from messages and nested strings. */
  secretValues?: readonly string[];
  /** Fields attached to every line. */
  base?: Record<string, unknown>;
  /** Test seam: send output somewhere other than stdout. */
  destination?: NodeJS.WritableStream;
  /**
   * Extra NDJSON destinations, teed alongside stdout/pretty. Used to persist
   * per-run log lines for the web UI without changing what the operator sees.
   */
  tee?: NodeJS.WritableStream[];
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const {
    level = "info",
    pretty = Boolean(process.stdout.isTTY),
    secretValues = [],
    base,
    destination,
    tee = [],
  } = options;

  const scrub = buildValueScrubber(secretValues);

  const config: LoggerOptions = {
    level,
    base: base ?? {},
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  // Runs after path redaction, catching secrets embedded in strings. Always
  // installed, even with no secrets known yet: `registerSecretValues` can add
  // them at any point, and a logger built before the first run must honour them.
  config.hooks = {
    logMethod(args, method) {
      method.apply(this, scrub(args) as typeof args);
    },
  };

  if (tee.length === 0) {
    if (destination) return pino(config, destination);
    if (pretty) return pino(config, prettyStdout());
    return pino(config);
  }

  // Each stream gets the same NDJSON. Pretty formats one copy for the
  // terminal; the tee (typically the execution-log capture) sees the raw line
  // with executionId already bound, which a logMethod hook would not.
  const primary = destination ?? (pretty ? prettyStdout() : process.stdout);
  return pino(
    config,
    pino.multistream([
      { stream: primary },
      ...tee.map((stream) => ({ stream, sync: true as const })),
    ]),
  );
}

/**
 * Pretty is in-process rather than `pino.transport()`: a worker thread resolves
 * thread-stream's loader from node_modules at runtime, and inside a
 * `bun build --compile` binary those files are not on disk — the worker dies
 * and the exit-time flush blocks for 10s.
 */
function prettyStdout(): NodeJS.WritableStream {
  return pinoPretty({
    colorize: true,
    translateTime: "HH:MM:ss.l",
    ignore: "pid,hostname",
    destination: process.stdout,
  });
}
