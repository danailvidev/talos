import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { migrate } from "../src/persistence/migrations.ts";
import { SqliteDashboardStore } from "../src/persistence/dashboard-store.ts";
import type { Widget } from "../shared/dashboard.ts";

function widget(id: string): Widget {
  return {
    id,
    title: "Open",
    layout: { x: 0, y: 0, w: 3, h: 3 },
    query: { dataset: "talos.agent_usage", metrics: [{ fn: "count", as: "runs" }] },
    view: { type: "kpi", y: ["runs"] },
  };
}

describe("dashboard store", () => {
  test("keeps dashboards private to their owner", () => {
    const db = new Database(":memory:");
    migrate(db);
    const store = new SqliteDashboardStore(db);
    const created = store.insert({
      ownerUserId: "alice",
      name: "Mine",
      description: "Personal",
      widgets: [widget("open")],
    });

    expect(store.list("alice").map((dashboard) => dashboard.id)).toEqual([created.id]);
    expect(store.list("bob")).toEqual([]);
    expect(store.get("bob", created.id)).toBeNull();

    const updated = store.update("alice", created.id, { name: "Renamed" });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.widgets).toHaveLength(1);
    expect(store.update("bob", created.id, { name: "Stolen" })).toBeNull();
    expect(store.delete("bob", created.id)).toBe(false);
    expect(store.delete("alice", created.id)).toBe(true);
    expect(store.get("alice", created.id)).toBeNull();
  });
});
