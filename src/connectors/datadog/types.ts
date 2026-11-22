/**
 * The slices of Datadog's Logs API this connector reads, as zod schemas.
 *
 * Deliberately loose about everything we do not use. A log event's `attributes`
 * bag is whatever the emitting service decided to put there — .NET stack frames,
 * JMeter headers, Kubernetes metadata — and a strict schema over it would turn
 * one unexpected field in one service's logs into a failed daily scan for every
 * service. So the envelope is validated (that is where a wrong endpoint or an
 * error body shows up) and the payload is read defensively by the caller.
 *
 * Error Tracking is deliberately absent. It is the obvious API for "list what is
 * broken" and it returned zero issues over 30 days on the install this was built
 * for, because nothing there emits the fingerprinted error spans it indexes. The
 * feed is therefore log aggregation, and the clustering Error Tracking would have
 * done lives in `signature.ts`.
 */
import { z } from "zod";

/**
 * One group in an aggregation: the facet values that define it, and its measures.
 *
 * `by` values are strings in practice but Datadog will hand back a number for a
 * numeric facet, and a bucket keyed by the integer 8080 is still a bucket worth
 * having rather than a validation failure.
 */
export const LogsBucketSchema = z.object({
  by: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  /** Keyed `c0`, `c1`, … in the order the `compute` array asked for them. */
  computes: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
});

export type LogsBucket = z.infer<typeof LogsBucketSchema>;

/**
 * `meta.status` is `done` or `timeout`: Datadog answers a query it could not
 * finish scanning with a 200 and partial buckets. Worth reading rather than
 * assuming — a partial answer silently treated as complete is how a service's
 * errors go missing from a triage list with nothing in the logs to say why.
 */
export const LogsAggregateResponseSchema = z.object({
  data: z
    .object({ buckets: z.array(LogsBucketSchema).default([]) })
    .default({ buckets: [] }),
  meta: z
    .object({
      status: z.string().optional(),
      elapsed: z.number().optional(),
      request_id: z.string().optional(),
      warnings: z
        .array(z.object({ title: z.string().optional(), detail: z.string().optional() }))
        .optional(),
      page: z.object({ after: z.string().optional() }).optional(),
    })
    .default({}),
});

export type LogsAggregateResponse = z.infer<typeof LogsAggregateResponseSchema>;

export const LogEventSchema = z.object({
  id: z.string(),
  attributes: z
    .object({
      timestamp: z.string().optional(),
      service: z.string().optional(),
      host: z.string().optional(),
      status: z.string().optional(),
      message: z.string().optional(),
      /** `env:prod`, `kube_namespace:web`, … — the flat tag list, unparsed. */
      tags: z.array(z.string()).default([]),
      /** The service's own structured fields, including `error.*`. Untyped by design. */
      attributes: z.record(z.string(), z.unknown()).default({}),
    })
    .default({ tags: [], attributes: {} }),
});

export type LogEvent = z.infer<typeof LogEventSchema>;

export const LogsEventsResponseSchema = z.object({
  data: z.array(LogEventSchema).default([]),
  meta: z
    .object({
      status: z.string().optional(),
      page: z.object({ after: z.string().optional() }).optional(),
    })
    .default({}),
});

export type LogsEventsResponse = z.infer<typeof LogsEventsResponseSchema>;

/**
 * `GET /api/v2/permissions`, used only to prove a token authenticates.
 *
 * The obvious probe — `GET /api/v1/validate` — is wrong here: it validates *API
 * keys* and answers 403 for a personal access token that works perfectly well
 * for logs. Permissions is a read every authenticated principal can do, so a 200
 * means "the token is live on this site" and nothing more, which is exactly the
 * question the first half of the health check is asking.
 */
export const PermissionsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string() }).loose()).default([]),
});

/**
 * The interesting half of a log event, flattened out of the two nested bags it
 * arrives in.
 *
 * `error.kind`/`error.message`/`error.stack` are Datadog's standard error
 * attributes, present when the emitting library follows the convention and absent
 * for the majority of logs that just wrote a line. Both cases have to work — see
 * `signature.ts`.
 */
export interface LogSample {
  id: string;
  timestamp?: Date;
  service?: string;
  host?: string;
  status?: string;
  message?: string;
  errorKind?: string;
  errorMessage?: string;
  errorStack?: string;
  /** Parsed from `tags`, last value wins for a repeated key. */
  tags: Record<string, string>;
}

/** Reads one event into a `LogSample`, tolerating every field being absent. */
export function toLogSample(event: LogEvent): LogSample {
  const a = event.attributes;
  const nested = a.attributes;
  const error =
    nested.error && typeof nested.error === "object" && !Array.isArray(nested.error)
      ? (nested.error as Record<string, unknown>)
      : {};

  const timestamp = a.timestamp ? new Date(a.timestamp) : undefined;

  return {
    id: event.id,
    ...(timestamp && !Number.isNaN(timestamp.getTime()) ? { timestamp } : {}),
    ...pick("service", a.service),
    ...pick("host", a.host),
    ...pick("status", a.status ?? text(nested.level) ?? text(nested.log_prio)),
    ...pick("message", a.message ?? text(nested.message)),
    ...pick("errorKind", text(error.kind) ?? text(error.type) ?? text(nested["error.kind"])),
    ...pick("errorMessage", text(error.message) ?? text(nested["error.message"])),
    ...pick("errorStack", text(error.stack) ?? text(nested["error.stack"])),
    tags: parseTags(a.tags),
  };
}

/**
 * `["env:prod", "kube_namespace:web"]` → `{ env: "prod", kube_namespace: "web" }`.
 *
 * A tag with no colon is a bare label; it is kept with an empty value so a rule
 * can still match on its presence rather than being unable to see it at all.
 */
export function parseTags(tags: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of tags) {
    const at = tag.indexOf(":");
    if (at <= 0) {
      if (tag.trim() !== "") out[tag.trim()] = "";
      continue;
    }
    out[tag.slice(0, at).trim()] = tag.slice(at + 1).trim();
  }
  return out;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function pick<K extends string>(key: K, value: string | undefined): Record<K, string> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
