import type { FetchLike } from "../../src/connectors/http.ts";

/**
 * A fetch double backed by recorded responses.
 *
 * Connector tests must not reach the network: a suite that depends on GitLab.com
 * being up and on a token being present is a suite nobody runs. Routes are
 * matched in registration order, so a specific route can shadow a general one.
 */
export interface RecordedResponse {
  status?: number;
  headers?: Record<string, string>;
  /** JSON body. Serialised for you. Mutually exclusive with `text`. */
  json?: unknown;
  text?: string;
  /** Raw bytes, for byte-accurate truncation tests. */
  bytes?: Uint8Array;
}

export interface Route {
  /** Matched against `pathname + search`, or a predicate for finer control. */
  match: string | RegExp | ((url: URL, init?: RequestInit) => boolean);
  method?: string;
  /** A function lets one route answer differently per call, e.g. for paging. */
  respond: RecordedResponse | ((call: RecordedCall) => RecordedResponse);
}

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** 1-based index of this call among all calls to the same route. */
  routeCallCount: number;
}

export class FakeHttp {
  readonly calls: RecordedCall[] = [];
  private readonly routes: Route[];
  private readonly perRoute = new Map<Route, number>();

  constructor(routes: Route[]) {
    this.routes = routes;
  }

  /** The injectable `fetch`. */
  get fetch(): FetchLike {
    return async (rawUrl, init) => {
      const url = new URL(rawUrl);
      const method = (init?.method ?? "GET").toUpperCase();

      const route = this.routes.find((candidate) => {
        if (candidate.method && candidate.method.toUpperCase() !== method) return false;
        return matches(candidate.match, url, init);
      });

      const call: RecordedCall = {
        url,
        method,
        headers: normaliseHeaders(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
        routeCallCount: 0,
      };

      if (!route) {
        this.calls.push(call);
        // Failing loudly beats a 404, which a client may treat as "not found"
        // and carry on — hiding the fact that the test never stubbed the call.
        throw new Error(
          `FakeHttp: no route for ${method} ${url.pathname}${url.search}\n` +
            `registered: ${this.routes.map((r) => String(r.match)).join(", ")}`,
        );
      }

      const count = (this.perRoute.get(route) ?? 0) + 1;
      this.perRoute.set(route, count);
      call.routeCallCount = count;
      this.calls.push(call);

      const recorded =
        typeof route.respond === "function" ? route.respond(call) : route.respond;

      return toResponse(recorded);
    };
  }

  /** Calls whose path contains `fragment`, for asserting on query parameters. */
  callsTo(fragment: string): RecordedCall[] {
    return this.calls.filter((call) => call.url.pathname.includes(fragment));
  }
}

function matches(
  match: Route["match"],
  url: URL,
  init: RequestInit | undefined,
): boolean {
  const target = `${url.pathname}${url.search}`;
  if (typeof match === "function") return match(url, init);
  // Tried against the path alone as well as path+query, so a route regex about
  // an endpoint can anchor with `$` without knowing which query parameters the
  // client happens to send.
  if (match instanceof RegExp) return match.test(url.pathname) || match.test(target);
  return url.pathname === match || target === match;
}

function toResponse(recorded: RecordedResponse): Response {
  const headers = new Headers(recorded.headers ?? {});
  const status = recorded.status ?? 200;

  let body: string | Uint8Array | null = null;
  if (recorded.bytes) {
    body = recorded.bytes;
  } else if (recorded.text != null) {
    body = recorded.text;
    if (!headers.has("content-type")) headers.set("content-type", "text/plain");
  } else if (recorded.json !== undefined) {
    body = JSON.stringify(recorded.json);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }

  // 204 and 304 must not carry a body, and Response enforces that.
  return new Response(status === 204 || status === 304 ? null : body, {
    status,
    headers,
  });
}

function normaliseHeaders(input: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  new Headers(input as Record<string, string>).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}
