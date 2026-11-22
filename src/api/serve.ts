/**
 * The HTTP server: API routes plus the built web UI.
 *
 * Binds to loopback by default. API authentication and private-task
 * authorization live in `router.ts`; this module only owns the network and
 * static-file boundary.
 */
import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { App } from "../app.ts";
import { handleAssistantMcpRequest } from "./assistant-mcp.ts";
import { handleApiRequest } from "./router.ts";
import { handleWebhookRequest } from "./webhooks.ts";

export interface ServeOptions {
  app: App;
  port: number;
  /** Loopback by default. */
  host: string;
  /** Directory of the built UI. Skipped when it does not exist. */
  uiDir?: string;
  /** Concurrent provider-heavy API reads before new work receives 429. */
  maxExpensiveRequests?: number;
  /** Process lifecycle state exposed to Kubernetes probes without authentication. */
  health?: {
    live(): boolean;
    ready(): boolean;
  };
}

export interface RunningServer {
  url: string;
  stop(): Promise<void>;
}

/**
 * Serves a file from the UI build, or the SPA's index.html for unknown paths so
 * client-side routes survive a refresh.
 */
async function serveStatic(uiDir: string, pathname: string): Promise<Response> {
  // Resolve and confirm containment: `/../../etc/passwd` must not escape the UI
  // directory. normalize() alone is not enough, since it happily produces a path
  // outside the root.
  const root = resolve(uiDir);
  const candidate = resolve(join(root, normalize(pathname)));

  if (candidate.startsWith(root)) {
    const file = Bun.file(candidate);
    if (await file.exists()) {
      const stat = await file.stat();
      if (!stat.isDirectory()) return new Response(file);
    }
  }

  const index = Bun.file(join(root, "index.html"));
  if (await index.exists()) {
    // 200, not 404: this is the SPA answering its own route, not a missing file.
    return new Response(index, { headers: { "content-type": "text/html" } });
  }

  return new Response("Not found", { status: 404 });
}

export function serve(options: ServeOptions): RunningServer {
  const { app, port, host, uiDir } = options;
  const hasUi = uiDir != null && existsSync(uiDir);
  const expensiveAdmission = new RequestAdmission(options.maxExpensiveRequests ?? 8);

  const server = Bun.serve({
    port,
    hostname: host,
    // POST /run used to hold the socket until the task finished. Bun's default
    // is 10s of inactivity — a code review sends no bytes for minutes, the
    // connection is killed, and the run is left `running` with an empty log.
    // Runs now return 202 immediately; this is belt-and-suspenders for any
    // other slow route (GitLab autocomplete, docker, …).
    idleTimeout: 60,
    fetch: async (request) => {
      const started = performance.now();
      const release = isExpensiveRequest(request) ? expensiveAdmission.acquire() : undefined;
      const response = release === null
        ? new Response("Too many expensive requests are already running.", {
            status: 429,
            headers: { "content-type": "text/plain", "retry-after": "1" },
          })
        : await dispatch(request).finally(() => release?.());
      const durationMs = Math.round((performance.now() - started) * 100) / 100;
      const route = requestRouteTemplate(request);
      app.logger.debug(
        {
          route,
          method: request.method,
          status: response.status,
          durationMs,
          requestBytes: numericHeader(request.headers, "content-length"),
          responseBytes: numericHeader(response.headers, "content-length"),
        },
        `${request.method} ${route} -> ${response.status}`,
      );
      response.headers.set("server-timing", `talos;dur=${durationMs}`);
      return response;
    },
  });

  async function dispatch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      if ((path === "/healthz" || path === "/readyz") && request.method === "GET") {
        const healthy = path === "/healthz"
          ? (options.health?.live() ?? true)
          : (options.health?.ready() ?? true);
        return new Response(
          JSON.stringify({ status: healthy ? "ok" : "unavailable" }),
          {
            status: healthy ? 200 : 503,
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
            },
          },
        );
      }

      const assistantMcpResponse = await handleAssistantMcpRequest(request, app);
      if (assistantMcpResponse) return assistantMcpResponse;

      // Before the API: a webhook carries no session cookie and must not be sent
      // through a gate that would reject it. It authenticates on its endpoint
      // secret instead — see `webhooks.ts`.
      const hookResponse = await handleWebhookRequest(request, app);
      if (hookResponse) return hookResponse;

      const apiResponse = await handleApiRequest(request, app);
      if (apiResponse) return apiResponse;

      if (hasUi) return serveStatic(uiDir, new URL(request.url).pathname);

      // No UI built. Say so, rather than returning a bare 404 that reads as a
      // broken server.
      return new Response(
        "The web UI is not built. Run `bun run ui:build`, or `bun run dev` " +
          "and open http://127.0.0.1:4317\nThe API is available under /api/.",
        { status: 503, headers: { "content-type": "text/plain" } },
      );
  }

  return {
    url: `http://${host}:${server.port}`,
    stop: async () => {
      await server.stop();
    },
  };
}

class RequestAdmission {
  private active = 0;
  constructor(private readonly limit: number) {}

  acquire(): (() => void) | null {
    if (this.active >= this.limit) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

function isExpensiveRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  const path = new URL(request.url).pathname;
  return path === "/api/graph/tickets"
    || path === "/api/pull-requests"
    || path.startsWith("/api/pull-requests/")
    || path === "/api/releases"
    || path === "/api/releases/history"
    || path.startsWith("/api/slack/")
    || path === "/api/me/slack/channels"
    || path === "/api/search";
}

/** Low-cardinality route labels: never put task IDs, run IDs, or webhook secrets in metrics. */
export function requestRouteTemplate(request: Request): string {
  const path = new URL(request.url).pathname;
  if (path === "/healthz" || path === "/readyz") return path;
  if (path === "/internal/assistant/mcp") return path;
  const patterns: Array<[RegExp, string]> = [
    [/^\/api\/task-runs\/[^/]+\/(steps|logs|cancel)$/, "/api/task-runs/:id/$1"],
    [/^\/api\/tasks\/[^/]+\/(runs|run|cancel|schedule|reset)$/, "/api/tasks/:id/$1"],
    [/^\/api\/tasks\/[^/]+$/, "/api/tasks/:id"],
    [/^\/api\/jobs\/[^/]+\/cancel$/, "/api/jobs/:id/cancel"],
    [/^\/api\/pull-requests\/[^/]+\/changes\/[^/]+$/, "/api/pull-requests/:id/changes/:sha"],
    [/^\/api\/pull-requests\/[^/]+\/(changes|actions|activity|runs|cancel)$/, "/api/pull-requests/:id/$1"],
    [/^\/api\/pull-requests\/[^/]+$/, "/api/pull-requests/:id"],
    [/^\/api\/slack\/users$/, "/api/slack/users"],
    [/^\/api\/slack\/direct-messages$/, "/api/slack/direct-messages"],
    [/^\/api\/slack\/direct-messages\/[^/]+$/, "/api/slack/direct-messages/:id"],
    [/^\/api\/slack\/conversations\/[^/]+\/messages\/[^/]+\/reaction$/, "/api/slack/conversations/:id/messages/:ts/reaction"],
    [/^\/api\/slack\/conversations\/[^/]+\/messages\/[^/]+$/, "/api/slack/conversations/:id/messages/:ts"],
    [/^\/api\/slack\/conversations\/[^/]+\/messages$/, "/api/slack/conversations/:id/messages"],
    [/^\/api\/slack\/conversations\/[^/]+\/images$/, "/api/slack/conversations/:id/images"],
    [/^\/api\/slack\/conversations\/[^/]+\/threads\/[^/]+$/, "/api/slack/conversations/:id/threads/:ts"],
    [/^\/api\/tickets\/[^/]+\/(actions|status)$/, "/api/tickets/:id/$1"],
    [/^\/api\/tickets\/[^/]+$/, "/api/tickets/:id"],
    [/^\/hooks\/[^/]+$/, "/hooks/:id"],
  ];
  for (const [pattern, replacement] of patterns) {
    if (pattern.test(path)) return path.replace(pattern, replacement);
  }
  return path.startsWith("/api/") ? path : "static";
}

function numericHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw == null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
