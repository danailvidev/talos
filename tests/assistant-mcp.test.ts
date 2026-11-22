import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createApp, type App } from "../src/app.ts";
import { handleAssistantMcpRequest } from "../src/api/assistant-mcp.ts";

let dir: string;
let app: App;
let token: string;
const actor = { id: "admin", name: "Admin", email: "admin@talos.local" };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "talos-assistant-mcp-"));
  writeFileSync(join(dir, "talos.yaml"), "database: ./test.db\nlogLevel: fatal\n");
  app = await createApp({ config: join(dir, "talos.yaml") });
  token = app.assistantCapabilities.issue(actor, new AbortController().signal).token;
});

afterEach(() => {
  app.close();
  rmSync(dir, { recursive: true, force: true });
});

function mcp(body: unknown, bearer = token): Promise<Response | null> {
  return handleAssistantMcpRequest(
    new Request("http://localhost/internal/assistant/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify(body),
    }),
    app,
  );
}

async function mcpBody<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(text) as T;
  }
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .at(-1);
  if (!data) throw new Error(`MCP response had no data event: ${text}`);
  return JSON.parse(data) as T;
}

describe("assistant MCP", () => {
  test("requires a live assistant capability", async () => {
    const response = await mcp(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      "not-valid",
    );
    expect(response!.status).toBe(401);
    expect(response!.headers.get("www-authenticate")).toContain("Bearer");
  });

  test("advertises loop mutations with accurate tool annotations", async () => {
    const response = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    expect(response!.status).toBe(200);
    const body = await mcpBody<{
      result: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> };
    }>(response!);
    const names = body.result.tools.map((tool) => tool.name);
    expect(names).toContain("gitlab_merge_requests");
    expect(names).toContain("jira_search");
    expect(names).toContain("datadog_logs");
    expect(names).toContain("talos_tasks");
    expect(names).toContain("talos_loop_create");
    expect(names).toContain("talos_loop_update");
    expect(names).toContain("talos_loop_delete");
    expect(names).toContain("talos_dashboard_query");
    expect(names).toContain("talos_dashboard_create");
    for (const tool of body.result.tools) {
      const mutation = [
        "talos_loop_create",
        "talos_loop_update",
        "talos_loop_delete",
        "talos_loop_schedule",
        "talos_ui_action",
        "talos_dashboard_create",
        "talos_dashboard_update",
        "talos_dashboard_delete",
      ].includes(tool.name);
      expect(tool.annotations?.readOnlyHint).toBe(!mutation);
    }
  });

  test("dispatches a tool as the capability actor", async () => {
    const response = await mcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "talos_tasks", arguments: {} },
    });
    expect(response!.status).toBe(200);
    const body = await mcpBody<{
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    }>(response!);
    expect(body.result.isError).not.toBe(true);
    expect(body.result.content[0]?.type).toBe("text");
    expect(JSON.parse(body.result.content[0]!.text)).toBeArray();
  });
});

async function callTool(name: string, args: Record<string, unknown>) {
  const response = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } });
  const body = await mcpBody<{ result: { isError?: boolean; content: Array<{ text: string }> } }>(response!);
  return { ...body.result, data: JSON.parse(body.result.content[0]!.text) };
}

test("UI tools discover and perform the same loop operations as React", async () => {
  const discovery = await callTool("talos_ui_operations", { search: "createInstance" });
  expect(discovery.data.operations[0].usage).toContain('/api/tasks');
  expect(discovery.data.types.CreateTaskInstance).toContain("definitionId");
  const created = await callTool("talos_ui_action", {
    path: "/api/tasks", method: "POST", body: {
      definitionId: "custom-loop", name: "Created through UI API", visibility: "private", params: { prompt: "Audit dependencies" },
    },
  });
  expect(created.isError).not.toBe(true);
  expect(created.data.status).toBe(201);
  const id = created.data.data.id;
  expect(app.instances.get(id)?.ownerId).toBe(actor.id);
  const read = await callTool("talos_ui_read", { path: `/api/tasks/${id}` });
  expect(read.data.data.name).toBe("Created through UI API");
  const deleted = await callTool("talos_ui_action", { path: `/api/tasks/${id}`, method: "DELETE" });
  expect(deleted.data.status).toBe(200);
  expect(app.instances.get(id)).toBeNull();
});

test("UI tools enforce current role permissions and private visibility", async () => {
  const privateLoop = app.loops.create(actor, {
    version: 1, definitionId: "custom-loop", name: "Private", visibility: "private", prompt: "Read only",
    enabled: false, trigger: { type: "manual" }, maxItemsPerRun: 1, params: {},
  });
  token = app.assistantCapabilities.issue({ id: "operator", name: "Operator", email: "operator@talos.local" }, new AbortController().signal).token;
  const read = await callTool("talos_ui_read", { path: `/api/tasks/${privateLoop.id}` });
  expect(read.isError).toBe(true);
  expect(read.data.status).toBe(404);
  const admin = await callTool("talos_ui_action", { path: "/api/admin/roles", method: "POST", body: { name: "Escalate" } });
  expect(admin.isError).toBe(true);
  expect(admin.data.status).toBe(403);
});

test("UI tools reject authentication, recursive chat and external URLs", async () => {
  for (const path of ["/api/auth/login", "/api/assistant/chat", "/api/../api/auth/login"]) {
    const response = await callTool("talos_ui_action", { path, method: "POST", body: {} });
    expect(response.isError).toBe(true);
    expect(response.data.status).toBe(400);
  }
  const { handleAssistantApiRequest } = await import("../src/api/router.ts");
  expect((await handleAssistantApiRequest(app, actor, "https://example.com/api/tasks", { method: "GET" })).status).toBe(400);
  expect((await handleAssistantApiRequest(app, { id: "missing" }, "/api/tasks", { method: "GET" })).status).toBe(401);
});
