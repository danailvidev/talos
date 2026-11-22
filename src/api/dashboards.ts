import { DashboardQuerySchema } from "../../shared/dashboard.ts";
import type { App } from "../app.ts";
import type { AuthUser } from "../auth.ts";
import { PermissionError, ValidationError } from "../core/errors.ts";
import { CACHE_TTL, cached, wantsFreshData } from "./cached.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** `/api/dashboards` — private specs plus the query engine. */
export async function routeDashboards(
  request: Request,
  path: string,
  app: App,
  user: AuthUser,
): Promise<Response> {
  const actor = {
    id: user.id,
    name: user.name,
    email: user.email,
    permissions: user.permissions,
  };

  try {
    if (path === "/api/dashboards/datasets") {
      if (request.method !== "GET") return methodNotAllowed(request.method);
      return json({ datasets: app.dashboards.catalog(actor) });
    }

    if (path === "/api/dashboards/query") {
      if (request.method !== "POST") return methodNotAllowed(request.method);
      const parsed = DashboardQuerySchema.safeParse(await jsonBody(request));
      if (!parsed.success) throw new ValidationError("Dashboard query is invalid.");
      const bypass = wantsFreshData(request);
      const result = await cached(
        app.responseCache,
        {
          resource: "dashboard-query",
          scope: { userId: user.id },
          params: [JSON.stringify(parsed.data)],
          ttlMs: CACHE_TTL.dashboardQuery,
        },
        // No request signal. The load is shared, and React mounts each widget
        // twice in development: aborting the first caller would fail the second
        // with "Request cancelled." The service applies its own timeout.
        () => app.dashboards.query(actor, parsed.data, { bypass }),
        { bypass },
      );
      return json(result);
    }

    if (path === "/api/dashboards") {
      if (request.method === "GET") {
        return json({
          dashboards: app.dashboards.list(actor).map((dashboard) => ({
            id: dashboard.id,
            name: dashboard.name,
            ...(dashboard.description ? { description: dashboard.description } : {}),
            updatedAt: dashboard.updatedAt,
          })),
        });
      }
      if (request.method === "POST") {
        const created = app.dashboards.create(actor, await jsonBody(request));
        return json(created, 201);
      }
      return methodNotAllowed(request.method);
    }

    const match = path.match(/^\/api\/dashboards\/([^/]+)$/);
    if (!match) return json({ error: "No API route for this dashboard path." }, 404);
    const id = decodeURIComponent(match[1]!);
    if (request.method === "GET") {
      const dashboard = app.dashboards.get(actor, id);
      if (!dashboard) return json({ error: "Dashboard not found." }, 404);
      return json(dashboard);
    }
    if (request.method === "PUT") {
      const updated = app.dashboards.update(actor, id, await jsonBody(request));
      if (!updated) return json({ error: "Dashboard not found." }, 404);
      return json(updated);
    }
    if (request.method === "DELETE") {
      if (!app.dashboards.delete(actor, id)) return json({ error: "Dashboard not found." }, 404);
      return json({ ok: true });
    }
    return methodNotAllowed(request.method);
  } catch (error) {
    if (error instanceof PermissionError) return json({ error: error.message }, 403);
    throw error;
  }
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (cause) {
    throw new ValidationError("Request body is not valid JSON.", { cause });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...JSON_HEADERS,
      "cache-control": "private, no-store",
      vary: "Cookie",
    },
  });
}

function methodNotAllowed(method: string): Response {
  return json({ error: `${method} is not allowed here.` }, 405);
}
