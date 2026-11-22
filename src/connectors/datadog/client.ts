/**
 * Datadog Logs API client.
 *
 * Two things about this connector are unlike the others, and both are worth
 * knowing before reading:
 *
 * **The credential is a personal access token, not an API key.** Datadog's usual
 * story is a pair — `DD-API-KEY` plus `DD-APPLICATION-KEY` — and the token this
 * was built for is neither: a `ddpat_…` token sent as `Authorization: Bearer`.
 * It authenticates the v2 API fine while `GET /api/v1/validate` answers 403 for
 * it, so the health check probes permissions and a real log read instead of the
 * endpoint named "validate". Sending it as `DD-API-KEY` fails with a bare
 * `{"errors":["Forbidden"]}`, which is why `check()` says so explicitly rather
 * than leaving an operator to guess whether the token or the scope is wrong.
 *
 * **A token is bound to one site.** `datadoghq.com`, `datadoghq.eu` and the rest
 * are separate deployments, and a token from one is simply unauthorised on
 * another — a 401 that looks exactly like a revoked token. `DATADOG_SITE` is
 * therefore part of the credential in practice, and the check reports which host
 * it authenticated against.
 *
 * Everything here is read-only. There is no write path to Datadog at all: the
 * loop reads logs and the actions it enables happen in Jira and GitLab.
 */
import { z } from "zod";
import { ConfigError } from "../../core/errors.ts";
import type { Logger } from "../../logging/logger.ts";
import type { SecretStore } from "../../secrets/secret-store.ts";
import { report, runCheck, type Connector, type HealthReport } from "../connector.ts";
import { HttpClient, type FetchLike } from "../http.ts";
import {
  LogsAggregateResponseSchema,
  LogsEventsResponseSchema,
  PermissionsResponseSchema,
  toLogSample,
  type LogSample,
  type LogsBucket,
} from "./types.ts";

/** US1. Every other region is an explicit `DATADOG_SITE`. */
export const DEFAULT_SITE = "datadoghq.com";

/** What the loop scans when no query is configured — see `DATADOG_LOG_QUERY`. */
export const DEFAULT_LOG_QUERY = "status:error env:prod";

/**
 * Log queries scan a lot: a 24h `status:error` aggregation over this install
 * takes ~1.5s, but a wide group-by on a slow index can sit for much longer, and
 * the default 30s is not generous enough to be worth a retry storm over.
 */
const TIMEOUT_MS = 60_000;

/**
 * Bounds a broken cursor without turning service discovery back into top-N.
 * At the scan's smallest allowed page size this still covers 2,000 services.
 */
const MAX_PAGES = 100;

export interface DatadogClientOptions {
  /** `ddpat_…` personal access token. */
  token: string;
  /** Region host without the `api.` prefix. Defaults to `datadoghq.com`. */
  site?: string;
  fetch?: FetchLike;
  logger?: Logger;
  timeoutMs?: number;
}

export interface LogWindow {
  /** Datadog log search syntax, e.g. `status:error env:prod`. */
  query: string;
  from: Date;
  to: Date;
  signal?: AbortSignal;
}

export interface GroupBySpec {
  /** Facet path, e.g. `service` or `@error.kind`. `@` marks a log attribute. */
  facet: string;
  limit?: number;
  /** Descending by count. Omitted, Datadog orders alphabetically — rarely useful. */
  sortByCount?: boolean;
}

/** One aggregation group, decoded into the two things callers ever want. */
export interface FacetCount {
  value: string;
  count: number;
  /** Every facet value of the group, for a multi-facet group-by. */
  by: Record<string, string>;
}

export class DatadogClient implements Connector {
  readonly name = "datadog";
  readonly site: string;
  private readonly http: HttpClient;

  constructor(options: DatadogClientOptions) {
    const token = options.token.trim();
    if (!token) {
      throw new ConfigError("DATADOG_TOKEN is empty. Set it under Settings → Integrations.");
    }
    // A pasted API key is the one wrong-credential case worth naming up front:
    // it authenticates nothing here, and the API's own answer is "Forbidden"
    // with no hint that the *kind* of key is the problem.
    if (/^[0-9a-f]{32}$/i.test(token)) {
      throw new ConfigError(
        "DATADOG_TOKEN looks like a Datadog API key (32 hex characters). The Logs API " +
          "reads here need a personal access token instead — create one under Datadog → " +
          "Personal Settings → Access Tokens; it starts with `ddpat_`.",
      );
    }

    this.site = normaliseSite(options.site);
    this.http = new HttpClient({
      baseUrl: `https://api.${this.site}`,
      connector: "datadog",
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    });
  }

  /** Deep link to the log explorer for one search, for a ticket or a table row. */
  explorerUrl(query: string, window?: { from: Date; to: Date }): string {
    return logExplorerUrl(this.site, query, window);
  }

  /**
   * Counts matching logs grouped by one or more facets.
   *
   * The workhorse of the scan: this is how 2M lines a day become a list of
   * services worth looking at without transferring a single log body. Datadog
   * answers a query it could not finish with a 200 and partial buckets, so
   * `partial` is reported rather than swallowed.
   */
  async countBy(
    window: LogWindow,
    groupBy: readonly GroupBySpec[],
  ): Promise<{ groups: FacetCount[]; partial: boolean }> {
    const { data } = await this.http.postJson(
      LogsAggregateResponseSchema,
      "/api/v2/logs/analytics/aggregate",
      {
        filter: {
          query: window.query,
          from: window.from.toISOString(),
          to: window.to.toISOString(),
        },
        compute: [{ aggregation: "count", type: "total" }],
        group_by: groupBy.map((spec) => ({
          facet: spec.facet,
          limit: spec.limit ?? 20,
          ...(spec.sortByCount
            ? { sort: { type: "measure", aggregation: "count", order: "desc" } }
            : {}),
        })),
      },
      { ...(window.signal ? { signal: window.signal } : {}) },
    );

    const primary = groupBy[0]?.facet;
    return {
      groups: data.data.buckets.map((bucket) => toFacetCount(bucket, primary)),
      partial: data.meta.status === "timeout",
    };
  }

  /**
   * Counts every facet bucket, following Datadog's aggregate cursor.
   *
   * `countBy` deliberately remains the one-page primitive used by callers that
   * want only the loudest N buckets. The production error scan has a different
   * requirement: a quiet service can contain the only new regression of the
   * day, so stopping at the first page would silently hide it.
   */
  async countAllBy(
    window: LogWindow,
    groupBy: readonly GroupBySpec[],
  ): Promise<{ groups: FacetCount[]; partial: boolean }> {
    const groups: FacetCount[] = [];
    const seen = new Set<string>();
    const primary = groupBy[0]?.facet;
    let cursor: string | undefined;
    let partial = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      const { data } = await this.http.postJson(
        LogsAggregateResponseSchema,
        "/api/v2/logs/analytics/aggregate",
        {
          filter: {
            query: window.query,
            from: window.from.toISOString(),
            to: window.to.toISOString(),
          },
          compute: [{ aggregation: "count", type: "total" }],
          group_by: groupBy.map((spec, index) => ({
            facet: spec.facet,
            limit: spec.limit ?? 100,
            // Aggregate cursors require an alphabetical facet. Count-descending
            // buckets are useful for a top-N view, but are not pageable.
            ...(index === 0
              ? { sort: { type: "alphabetical", order: "asc" } }
              : spec.sortByCount
                ? { sort: { type: "measure", aggregation: "count", order: "desc" } }
                : {}),
          })),
          ...(cursor ? { page: { cursor } } : {}),
        },
        { ...(window.signal ? { signal: window.signal } : {}) },
      );

      partial ||= data.meta.status === "timeout";
      for (const bucket of data.data.buckets) {
        const group = toFacetCount(bucket, primary);
        const key = JSON.stringify(group.by);
        if (seen.has(key)) continue;
        seen.add(key);
        groups.push(group);
      }

      const next = data.meta.page?.after;
      if (!next || next === cursor || data.data.buckets.length === 0) {
        cursor = undefined;
        break;
      }
      cursor = next;
    }

    // A cursor after the safety bound means the answer is real but incomplete,
    // the same operational condition as Datadog's own timeout status.
    if (cursor) partial = true;
    return { groups, partial };
  }

  /** Total matching logs, with no grouping. */
  async count(window: LogWindow): Promise<number> {
    const { data } = await this.http.postJson(
      LogsAggregateResponseSchema,
      "/api/v2/logs/analytics/aggregate",
      {
        filter: {
          query: window.query,
          from: window.from.toISOString(),
          to: window.to.toISOString(),
        },
        compute: [{ aggregation: "count", type: "total" }],
      },
      { ...(window.signal ? { signal: window.signal } : {}) },
    );
    return numberOf(data.data.buckets[0]?.computes.c0) ?? 0;
  }

  /**
   * A page of actual log events, newest first, capped at `limit`.
   *
   * Newest first on purpose: a sample is used to describe a cluster and to quote
   * in a ticket, and the freshest occurrence is the one whose stack trace still
   * matches the deployed code.
   */
  async sampleLogs(window: LogWindow, limit: number): Promise<LogSample[]> {
    const out: LogSample[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES && out.length < limit; page++) {
      const { data } = await this.http.postJson(
        LogsEventsResponseSchema,
        "/api/v2/logs/events/search",
        {
          filter: {
            query: window.query,
            from: window.from.toISOString(),
            to: window.to.toISOString(),
          },
          sort: "-timestamp",
          page: {
            limit: Math.min(1000, limit - out.length),
            ...(cursor ? { cursor } : {}),
          },
        },
        { ...(window.signal ? { signal: window.signal } : {}) },
      );

      for (const event of data.data) out.push(toLogSample(event));

      cursor = data.meta.page?.after;
      // No cursor, or a page that came back empty: there is nothing further to
      // read, and following an unchanged cursor is how a paginator loops forever.
      if (!cursor || data.data.length === 0) break;
    }

    return out.slice(0, limit);
  }

  /**
   * Does this token work, on this site, for reading logs?
   *
   * Three checks because there are three distinct failures with the same symptom.
   * Authentication is the token being live on this site at all; the log read is
   * the `logs_read_data` scope, which a token can lack while authenticating
   * perfectly; and the query check is the operator's own search syntax, which is
   * the one of the three they are most likely to have got wrong.
   */
  async check(
    options: { query?: string; signal?: AbortSignal } = {},
  ): Promise<HealthReport> {
    const query = options.query?.trim() || DEFAULT_LOG_QUERY;
    const to = new Date();
    const from = new Date(to.getTime() - 60 * 60_000);

    const authentication = await runCheck("authentication", async () => {
      const { data } = await this.http.getJson(
        PermissionsResponseSchema,
        "/api/v2/permissions",
        { ...(options.signal ? { signal: options.signal } : {}) },
      );
      return {
        detail: `token accepted by api.${this.site}`,
        values: [`site: ${this.site}`, `permissions visible: ${data.data.length}`],
      };
    });

    if (!authentication.ok) {
      // Every later check reuses the same credential and could only repeat the
      // same failure. The hint is the whole value of failing here: a 401 on a
      // Datadog token means "wrong site" at least as often as "wrong token", and
      // nothing in the response says so.
      return report(this.name, [
        authentication,
        {
          name: "log read",
          ok: false,
          detail:
            "not attempted — fix authentication first. A 401 here usually means the " +
            `token belongs to a different Datadog site than ${this.site} (check ` +
            "DATADOG_SITE), or is an API key rather than a ddpat_ personal access token.",
        },
      ]);
    }

    const logRead = await runCheck("log read", async () => {
      const total = await this.count({ query: "*", from, to, ...(options.signal ? { signal: options.signal } : {}) });
      return {
        detail:
          total > 0
            ? `read ${total.toLocaleString()} log(s) from the last hour`
            : "authorised to read logs, but no logs at all in the last hour — " +
              "either this org is not ingesting, or the token's indexes are restricted",
        ok: true,
      };
    });

    const queryCheck = await runCheck("scan query", async () => {
      const total = await this.count({ query, from, to, ...(options.signal ? { signal: options.signal } : {}) });
      return {
        detail: `${query} → ${total.toLocaleString()} log(s) in the last hour`,
        // Zero is not a failure: a quiet hour is the outcome everyone wants.
        // It is worth a value line so a scan that finds nothing is explicable.
        values: total === 0 ? ["nothing matched — the daily scan would find no issues"] : undefined,
      };
    });

    return report(this.name, [authentication, logRead, queryCheck]);
  }
}

/**
 * Builds a client from the secret store, defaulting the site.
 *
 * Same shape as `createJiraClient`: the caller says which secrets matter by
 * asking for the client, and nothing else in the codebase has to know the names.
 */
export function createDatadogClient(
  secrets: SecretStore,
  options: Omit<DatadogClientOptions, "token" | "site"> & { site?: string } = {},
): DatadogClient {
  const site = options.site ?? secrets.get("DATADOG_SITE");
  return new DatadogClient({
    ...options,
    token: secrets.require("DATADOG_TOKEN"),
    ...(site ? { site } : {}),
  });
}

/** The configured scan query, or the default. */
export function datadogLogQuery(secrets: SecretStore): string {
  return secrets.get("DATADOG_LOG_QUERY")?.trim() || DEFAULT_LOG_QUERY;
}

/** The configured site, normalised the same way the client does it. */
export function datadogSite(secrets: SecretStore): string {
  return normaliseSite(secrets.get("DATADOG_SITE"));
}

/**
 * A log explorer link without a client behind it.
 *
 * The API layer builds links for rows it is only reading from our own tables, and
 * making it construct a client — which requires a token it does not otherwise
 * need — to format a URL would be the wrong shape. The client's own
 * `explorerUrl` delegates here so there is one definition of the link.
 */
export function logExplorerUrl(
  site: string,
  query: string,
  window?: { from: Date; to: Date },
): string {
  const params = new URLSearchParams({ query });
  if (window) {
    params.set("from_ts", String(window.from.getTime()));
    params.set("to_ts", String(window.to.getTime()));
    params.set("live", "false");
  }
  return `https://app.${normaliseSite(site)}/logs?${params.toString()}`;
}

/**
 * Accepts what an operator is likely to paste.
 *
 * `https://app.datadoghq.eu/`, `api.datadoghq.eu` and `datadoghq.eu` are all the
 * same intent, and refusing two of the three would be a 401 with no explanation
 * for anyone who copied the URL out of their browser.
 */
export function normaliseSite(site: string | undefined): string {
  const trimmed = site?.trim();
  if (!trimmed) return DEFAULT_SITE;
  return (
    trimmed
      .replace(/^https?:\/\//, "")
      .replace(/^(?:api|app)\./, "")
      .replace(/\/.*$/, "")
      .trim() || DEFAULT_SITE
  );
}

export const DatadogConfigSchema = z.object({
  /** Log search the scan runs. Defaults to `status:error env:prod`. */
  query: z.string().min(1).default(DEFAULT_LOG_QUERY),
  /** Service buckets requested per aggregate page; scans consume every page. */
  maxServices: z.number().int().min(1).max(100).default(20),
  /** Log bodies fetched per service to cluster. The scan's whole cost driver. */
  samplesPerService: z.number().int().min(10).max(1000).default(200),
});

export type DatadogConfig = z.infer<typeof DatadogConfigSchema>;

function toFacetCount(bucket: LogsBucket, primaryFacet: string | undefined): FacetCount {
  const by: Record<string, string> = {};
  for (const [key, value] of Object.entries(bucket.by)) by[key] = String(value);
  const value = primaryFacet ? by[primaryFacet] : undefined;
  return {
    value: value ?? Object.values(by)[0] ?? "",
    count: numberOf(bucket.computes.c0) ?? 0,
    by,
  };
}

/** Datadog returns counts as numbers, but a large one can arrive as a string. */
function numberOf(value: number | string | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
