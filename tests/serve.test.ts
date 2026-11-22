import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type App } from "../src/app.ts";
import { requestRouteTemplate, serve, type RunningServer } from "../src/api/serve.ts";
import { loadRuntimeConfig } from "../src/config/runtime.ts";

process.env.TALOS_ADMIN_PASSWORD = "talos-admin";

let app: App | undefined;
let server: RunningServer | undefined;
let dir: string | undefined;

afterEach(async () => {
  await server?.stop();
  app?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = undefined;
  server = undefined;
  dir = undefined;
});

describe("HTTP serving boundary", () => {
  test("normalizes IDs and secrets out of request metric labels", () => {
    expect(requestRouteTemplate(new Request("http://local/api/task-runs/run-secret/logs"))).toBe(
      "/api/task-runs/:id/logs",
    );
    expect(requestRouteTemplate(new Request("http://local/hooks/webhook-secret"))).toBe("/hooks/:id");
    expect(
      requestRouteTemplate(
        new Request("http://local/api/slack/conversations/D-secret/threads/1710000000.1"),
      ),
    ).toBe("/api/slack/conversations/:id/threads/:ts");
    expect(
      requestRouteTemplate(
        new Request(
          "http://local/api/slack/conversations/D-secret/messages/1710000000.1/reaction",
        ),
      ),
    ).toBe("/api/slack/conversations/:id/messages/:ts/reaction");
    expect(
      requestRouteTemplate(
        new Request("http://local/api/slack/conversations/D-secret/messages/1710000000.1"),
      ),
    ).toBe("/api/slack/conversations/:id/messages/:ts");
    expect(
      requestRouteTemplate(
        new Request("http://local/api/slack/conversations/D-secret/images"),
      ),
    ).toBe("/api/slack/conversations/:id/images");
    expect(requestRouteTemplate(new Request("http://local/assets/app.js"))).toBe("static");
  });
  test("serves the API, static assets, and SPA fallback on loopback", async () => {
    dir = mkdtempSync(join(tmpdir(), "talos-serve-"));
    const ui = join(dir, "ui");
    mkdirSync(ui);
    writeFileSync(join(ui, "index.html"), "<main>talos</main>");
    writeFileSync(join(ui, "asset.txt"), "asset");
    writeFileSync(join(dir, "talos.yaml"), "database: ./test.db\nlogLevel: fatal\n");
    app = await createApp({ config: join(dir, "talos.yaml") });
    server = serve({ app, host: "127.0.0.1", port: 0, uiDir: ui });

    const login = await fetch(`${server.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@talos.local",
        password: "talos-admin",
      }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect(
      await (await fetch(`${server.url}/api/system`, { headers: { cookie } })).json(),
    ).toHaveProperty("version");
    expect(await (await fetch(`${server.url}/asset.txt`)).text()).toBe("asset");
    expect(await (await fetch(`${server.url}/tasks/example-task`)).text()).toContain("talos");
  });

  test("serves unauthenticated lifecycle probes", async () => {
    dir = mkdtempSync(join(tmpdir(), "talos-serve-health-"));
    writeFileSync(join(dir, "talos.yaml"), "database: ./test.db\nlogLevel: fatal\n");
    app = await createApp({ config: join(dir, "talos.yaml") });
    let ready = false;
    server = serve({
      app,
      host: "127.0.0.1",
      port: 0,
      health: { live: () => true, ready: () => ready },
    });

    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${server.url}/readyz`)).status).toBe(503);
    ready = true;
    expect((await fetch(`${server.url}/readyz`)).status).toBe(200);
  });

  test("marks sessions Secure when the configured public URL uses HTTPS", async () => {
    dir = mkdtempSync(join(tmpdir(), "talos-serve-secure-cookie-"));
    writeFileSync(join(dir, "talos.yaml"), "database: ./test.db\nlogLevel: fatal\n");
    app = await createApp({
      config: join(dir, "talos.yaml"),
      runtime: loadRuntimeConfig({ TALOS_PUBLIC_URL: "https://talos.example.com" }),
    });
    server = serve({ app, host: "127.0.0.1", port: 0 });
    const login = await fetch(`${server.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@talos.local", password: "talos-admin" }),
    });
    expect(login.headers.get("set-cookie")).toContain("Secure");
  });

  /**
   * A standing assertion about the whole `/api/` surface, not about one route.
   *
   * Every API body here is session-scoped. `public` or `s-maxage` on one of them is
   * a cross-user leak with a reverse proxy as the amplifier: the proxy would answer
   * the next person's request for `/api/pull-requests` with this person's merge
   * requests, and nothing in the app would ever see it happen. `jsonCached()` in
   * `router.ts` is the only thing in the codebase that sets a `Cache-Control` on an
   * API response, and this is the test that keeps the second one honest.
   */
  test("no /api/ response is publicly cacheable", async () => {
    dir = mkdtempSync(join(tmpdir(), "talos-serve-headers-"));
    writeFileSync(join(dir, "talos.yaml"), "database: ./test.db\nlogLevel: fatal\n");
    app = await createApp({ config: join(dir, "talos.yaml") });
    server = serve({ app, host: "127.0.0.1", port: 0 });

    const login = await fetch(`${server.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@talos.local", password: "talos-admin" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    // The routes that answer without reaching a forge, so this needs no network:
    // the two that set an ETag deliberately, and three that set no header at all.
    const paths = [
      "/api/tasks",
      "/api/system",
      "/api/settings",
      "/api/prompts",
      "/api/notifications",
    ];
    for (const path of paths) {
      const response = await fetch(`${server.url}${path}`, { headers: { cookie } });
      expect(response.status).toBe(200);
      const cacheControl = response.headers.get("cache-control") ?? "";
      expect(cacheControl, `${path} must not be publicly cacheable`).not.toContain("public");
      expect(cacheControl, `${path} must not be proxy-cacheable`).not.toContain("s-maxage");
      // Where a `Cache-Control` is set at all it has to name the session as the
      // thing that varies, or a shared cache is entitled to ignore the cookie.
      if (cacheControl) {
        expect(cacheControl, `${path} must be private`).toContain("private");
        expect(response.headers.get("vary"), `${path} must vary on the cookie`).toBe("Cookie");
      }
    }
  });
});
