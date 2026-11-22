import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { SqliteAutomationFailureAssigneeStore } from "../src/persistence/automation-failure-assignee-store.ts";
import { migrate } from "../src/persistence/migrations.ts";

describe("Automation failure assignees", () => {
  test("persists, reassigns, lists, isolates schedules, and clears ownership", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    migrate(db);
    const store = new SqliteAutomationFailureAssigneeStore(db);
    const first = new Date("2026-10-06T10:00:00.000Z");
    const second = new Date("2026-10-06T11:00:00.000Z");

    store.set({
      projectId: "42",
      scheduleId: 10,
      signatureKey: "signature",
      userId: "alice",
      assignedByUserId: "operator",
      now: first,
    });
    store.set({
      projectId: "42",
      scheduleId: 11,
      signatureKey: "signature",
      userId: "bob",
      assignedByUserId: "operator",
      now: first,
    });

    expect(
      store.listFor("42", 10, ["signature", "missing"]).get("signature"),
    ).toMatchObject({
      userId: "alice",
      assignedByUserId: "operator",
      assignedAt: first,
    });

    store.set({
      projectId: "42",
      scheduleId: 10,
      signatureKey: "signature",
      userId: "carol",
      assignedByUserId: "alice",
      now: second,
    });
    expect(store.get("42", 10, "signature")).toMatchObject({
      userId: "carol",
      assignedByUserId: "alice",
      assignedAt: second,
      updatedAt: second,
    });
    expect(store.get("42", 11, "signature")?.userId).toBe("bob");
    expect(store.clear("42", 10, "signature")).toBe(true);
    expect(store.get("42", 10, "signature")).toBeUndefined();
    expect(store.clear("42", 10, "signature")).toBe(false);
    db.close();
  });
});
