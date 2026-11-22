import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  HttpClient,
  parseRetryAfterMs,
  redactUrl,
  truncateBytes,
} from "../src/connectors/http.ts";
import {
  AuthenticationError,
  ConnectorError,
  PermissionError,
  RateLimitError,
  TransientError,
  ValidationError,
  isRetryable,
} from "../src/core/errors.ts";
import { FakeHttp, type Route } from "./fixtures/http.ts";

const BASE = "https://api.example.com/v1";
let fixtureProvider = 0;

function client(routes: Route[]) {
  const http = new FakeHttp(routes);
  return {
    http,
    // Provider budgets are deliberately process-wide. Give each fixture its
    // own provider identity so one test's Retry-After cannot sleep another.
    client: new HttpClient({
      baseUrl: BASE,
      connector: `test-${fixtureProvider++}`,
      fetch: http.fetch,
    }),
  };
}

const Body = z.object({ id: z.number(), name: z.string() });

describe("HttpClient", () => {
  test("builds URLs and omits null query parameters", () => {
    const { client: c } = client([]);
    expect(c.url("/things")).toBe(`${BASE}/things`);
    // Both forms, because half the call sites will forget the leading slash.
    expect(c.url("things")).toBe(`${BASE}/things`);
    expect(c.url("/things", { a: 1, b: undefined, c: null, d: false })).toBe(
      `${BASE}/things?a=1&d=false`,
    );
  });

  test("sends configured auth headers on every request", async () => {
    const http = new FakeHttp([{ match: "/v1/thing", respond: { json: { id: 1, name: "x" } } }]);
    const c = new HttpClient({
      baseUrl: BASE,
      connector: "test",
      fetch: http.fetch,
      headers: { "private-token": "tok" },
    });

    await c.getJson(Body, "/thing");
    expect(http.calls[0]?.headers["private-token"]).toBe("tok");
  });

  test("validates the response body against its schema", async () => {
    const { client: c } = client([
      { match: "/v1/thing", respond: { json: { id: 1, name: "widget", extra: true } } },
    ]);

    // Unknown fields pass: the API is allowed to grow.
    const { data } = await c.getJson(Body, "/thing");
    expect(data).toMatchObject({ id: 1, name: "widget" });
  });

  test("a response of the wrong shape is a non-retryable ValidationError", async () => {
    const { client: c } = client([{ match: "/v1/thing", respond: { json: { id: "one" } } }]);

    const err = await c.getJson(Body, "/thing").catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    // Retrying cannot help: the same request returns the same wrong shape.
    expect(isRetryable(err)).toBe(false);
    expect(err.message).toContain("id");
  });

  test("a non-JSON body is a connector error, not a crash", async () => {
    const { client: c } = client([
      { match: "/v1/thing", respond: { text: "<html>502 Bad Gateway</html>", status: 200 } },
    ]);

    const err = await c.getJson(Body, "/thing").catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.message).toContain("not JSON");
  });

  test("bounds schema-validated JSON before decoding it", async () => {
    const client = new HttpClient({
      baseUrl: "https://example.test",
      connector: "test",
      jsonMaxBytes: 32,
      fetch: async () => new Response(JSON.stringify({ payload: "x".repeat(100) })),
    });

    await expect(client.getJson(z.object({ payload: z.string() }), "/large")).rejects.toThrow(
      "configured JSON body limit",
    );
  });

  test("shares a provider concurrency budget across client instances", async () => {
    let active = 0;
    let peak = 0;
    let releaseFirst: (() => void) | undefined;
    const fetch = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      active -= 1;
      return new Response(JSON.stringify({ id: 1, name: "ok" }));
    };
    const options = {
      baseUrl: "https://budget.example.test",
      connector: "budget-test",
      maxConcurrency: 1,
      fetch,
    };
    const first = new HttpClient(options).getJson(Body, "/one");
    const second = new HttpClient(options).getJson(Body, "/two");
    await Bun.sleep(5);
    expect(peak).toBe(1);
    releaseFirst?.();
    await Bun.sleep(5);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(peak).toBe(1);
  });

  test("does not share a provider budget across different credentials", async () => {
    let active = 0;
    let peak = 0;
    const fetch = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(10);
      active -= 1;
      return new Response(JSON.stringify({ id: 1, name: "ok" }));
    };
    const common = {
      baseUrl: "https://credential-budget.example.test",
      connector: "credential-budget-test",
      maxConcurrency: 1,
      fetch,
    };
    await Promise.all([
      new HttpClient({ ...common, headers: { authorization: "Bearer one" } }).getJson(Body, "/one"),
      new HttpClient({ ...common, headers: { authorization: "Bearer two" } }).getJson(Body, "/two"),
    ]);
    expect(peak).toBe(2);
  });

  test("bounds provider waiters and includes queue time in the timeout", async () => {
    let releaseFirst: (() => void) | undefined;
    const fetch = async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return new Response(JSON.stringify({ id: 1, name: "ok" }));
    };
    const options = {
      baseUrl: "https://bounded-budget.example.test",
      connector: "bounded-budget-test",
      maxConcurrency: 1,
      maxPendingRequests: 1,
      timeoutMs: 15,
      fetch,
    };
    const client = new HttpClient(options);
    const first = client.getJson(Body, "/one").catch(() => undefined);
    const queued = client.getJson(Body, "/two");
    const rejected = client.getJson(Body, "/three");
    await expect(rejected).rejects.toThrow("queue is at capacity");
    await expect(queued).rejects.toThrow("failed to complete");
    releaseFirst?.();
    await first;
  });

  test("reserves provider capacity for interactive work", async () => {
    const releases: Array<() => void> = [];
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(new URL(url).pathname);
      await new Promise<void>((resolve) => releases.push(resolve));
      return new Response(JSON.stringify({ id: 1, name: "ok" }));
    };
    const common = {
      baseUrl: "https://fair-budget.example.test",
      connector: "fair-budget-test",
      maxConcurrency: 2,
      fetch,
    };
    const background = new HttpClient({ ...common, priority: "background" });
    const interactive = new HttpClient(common);
    const first = background.getJson(Body, "/background-one");
    const second = background.getJson(Body, "/background-two");
    await Bun.sleep(2);
    expect(calls).toEqual(["/background-one"]);
    const foreground = interactive.getJson(Body, "/interactive");
    await Bun.sleep(2);
    expect(calls).toEqual(["/background-one", "/interactive"]);
    releases.splice(0).forEach((release) => release());
    await Bun.sleep(2);
    releases.splice(0).forEach((release) => release());
    await Promise.all([first, second, foreground]);
  });

  describe("status mapping", () => {
    const cases: [number, unknown, boolean][] = [
      [401, AuthenticationError, false],
      [403, PermissionError, false],
      [404, ConnectorError, false],
      [429, RateLimitError, true],
      [500, TransientError, true],
      [503, TransientError, true],
    ];

    for (const [status, expected, retryable] of cases) {
      test(`${status} maps to ${(expected as { name: string }).name}`, async () => {
        const { client: c } = client([
          { match: "/v1/thing", respond: { status, json: { message: "nope" } } },
        ]);

        const err = await c.getJson(Body, "/thing").catch((e) => e);
        expect(err).toBeInstanceOf(expected as never);
        expect((err as ConnectorError).status).toBe(status);
        expect(isRetryable(err)).toBe(retryable);
        // The body is quoted, so an operator sees what the API actually said.
        expect(err.message).toContain("nope");
      });
    }
  });

  test("a 429 carries Retry-After through to the retry policy", async () => {
    const { client: c } = client([
      {
        match: "/v1/thing",
        respond: { status: 429, headers: { "retry-after": "7" }, json: {} },
      },
    ]);

    const err = await c.getJson(Body, "/thing").catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(7000);
  });

  test("a 429 pauses queued clients sharing the provider budget", async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return calls === 1
        ? new Response("{}", { status: 429, headers: { "retry-after": "0.03" } })
        : new Response(JSON.stringify({ id: 1, name: "ok" }));
    };
    const options = {
      baseUrl: "https://cooldown.example.test",
      connector: "cooldown-test",
      maxConcurrency: 1,
      fetch,
    };
    const first = new HttpClient(options).getJson(Body, "/first").catch(() => undefined);
    const second = new HttpClient(options).getJson(Body, "/second");
    await first;
    await Bun.sleep(10);
    expect(calls).toBe(1);
    await second;
    expect(calls).toBe(2);
  });

  test("a network failure becomes a retryable TransientError", async () => {
    const c = new HttpClient({
      baseUrl: BASE,
      connector: "test",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    const err = await c.getJson(Body, "/thing").catch((e) => e);
    expect(err).toBeInstanceOf(TransientError);
    expect(isRetryable(err)).toBe(true);
  });

  test("caller abort propagates rather than being reported as a connector fault", async () => {
    const controller = new AbortController();
    controller.abort();

    const c = new HttpClient({
      baseUrl: BASE,
      connector: "test",
      fetch: async () => {
        throw new DOMException("aborted", "AbortError");
      },
    });

    // A shutdown must stop the executor, not trigger a retry loop.
    const err = await c.getJson(Body, "/thing", { signal: controller.signal }).catch((e) => e);
    expect(err).not.toBeInstanceOf(TransientError);
    expect(err.name).toBe("AbortError");
  });

  test("getText applies a byte cap", async () => {
    const body = "x".repeat(10_000);
    const { client: c } = client([{ match: "/v1/log", respond: { text: body } }]);

    const result = await c.getText("/log", { maxBytes: 500 });
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(10_000);
    expect(result.text).toContain("bytes omitted");
  });

  test("getText retains only a bounded head and tail from a streamed response", async () => {
    const total = 2 * 1024 * 1024;
    let sent = 0;
    const c = new HttpClient({
      baseUrl: BASE,
      connector: "test",
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (sent >= total) return controller.close();
              const chunk = new Uint8Array(Math.min(64 * 1024, total - sent)).fill(120);
              if (sent === 0) chunk.set(new TextEncoder().encode("START"));
              if (sent + chunk.byteLength === total) {
                chunk.set(new TextEncoder().encode("END"), chunk.byteLength - 3);
              }
              sent += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }),
        ),
    });

    const result = await c.getText("/stream", { maxBytes: 1_000 });
    expect(result.bytes).toBe(total);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("START")).toBe(true);
    expect(result.text.endsWith("END")).toBe(true);
    expect(result.text.length).toBeLessThan(1_200);
  });
});

describe("truncateBytes", () => {
  const encode = (s: string) => new TextEncoder().encode(s);

  test("leaves text under the cap untouched", () => {
    const result = truncateBytes(encode("short"), 100);
    expect(result).toEqual({ text: "short", bytes: 5, truncated: false });
  });

  test("no cap means no truncation", () => {
    const result = truncateBytes(encode("anything"), undefined);
    expect(result.truncated).toBe(false);
  });

  test("keeps the head and the tail", () => {
    // The head carries the command that ran, the tail the error that ended it.
    const body = `START${"-".repeat(5_000)}END`;
    const result = truncateBytes(encode(body), 1_000);

    expect(result.text.startsWith("START")).toBe(true);
    expect(result.text.endsWith("END")).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(body.length);
  });

  test("reports how much was dropped", () => {
    const result = truncateBytes(encode("y".repeat(3_000)), 1_000);
    expect(result.text).toContain("of 3000 total");
  });

  test("a cut mid-codepoint does not throw", () => {
    // A cap that lands inside a multi-byte character must degrade, not crash.
    const body = "é".repeat(2_000);
    const result = truncateBytes(encode(body), 101);
    expect(result.truncated).toBe(true);
    expect(typeof result.text).toBe("string");
  });
});

describe("parseRetryAfterMs", () => {
  test("reads delta-seconds", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "3" }))).toBe(3000);
  });

  test("reads an HTTP date", () => {
    const when = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfterMs(new Headers({ "retry-after": when }))!;
    expect(ms).toBeGreaterThan(8_000);
    expect(ms).toBeLessThanOrEqual(11_000);
  });

  test("falls back to GitLab's RateLimit-Reset", () => {
    const epoch = Math.floor(Date.now() / 1000) + 5;
    const ms = parseRetryAfterMs(new Headers({ "ratelimit-reset": String(epoch) }))!;
    expect(ms).toBeGreaterThan(3_000);
    expect(ms).toBeLessThanOrEqual(6_000);
  });

  test("a past date clamps to zero rather than going negative", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterMs(new Headers({ "retry-after": past }))).toBe(0);
  });

  test("no header means no opinion, so the backoff formula applies", () => {
    expect(parseRetryAfterMs(new Headers())).toBeUndefined();
  });
});

describe("redactUrl", () => {
  test("strips basic-auth credentials", () => {
    expect(redactUrl("https://user:pass@example.com/x")).not.toContain("pass");
  });

  test("redacts token query parameters", () => {
    // Tokens travel in headers here; this guards a hand-built URL.
    expect(redactUrl("https://example.com/x?private_token=glpat-secret")).toBe(
      "https://example.com/x?private_token=%5Bredacted%5D",
    );
  });

  test("leaves an unparseable string alone", () => {
    expect(redactUrl("not a url")).toBe("not a url");
  });
});
