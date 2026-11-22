import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteAutomationAiTriageStore } from "../src/persistence/automation-ai-triage-store.ts";
import { migrate } from "../src/persistence/migrations.ts";

describe("Automation AI triage persistence", () => {
  test("upserts the latest result by project, schedule, and signature key", () => {
    const db = new Database(":memory:");
    migrate(db);
    const store = new SqliteAutomationAiTriageStore(db);
    const first = store.record({
      projectId: "42",
      scheduleId: 22,
      signatureKey: "root-cause",
      signature: "AssertionError: old",
      verdict: "test-bug",
      confidence: 0.7,
      rationale: "The assertion does not match the fixture.",
      recommendation: "Update the fixture and rerun.",
      taskRunId: "run-1",
    });
    const second = store.record({
      projectId: "42",
      scheduleId: 22,
      signatureKey: "root-cause",
      signature: "AssertionError: current",
      verdict: "service-breaking-change",
      confidence: 0.92,
      rationale: "The checked response shape was removed from the API contract.",
      recommendation: "Confirm the service contract before updating the test.",
      taskRunId: "run-2",
    });

    expect(second).toMatchObject({
      id: first.id,
      signature: "AssertionError: current",
      verdict: "service-breaking-change",
      taskRunId: "run-2",
      createdAt: first.createdAt,
    });
    expect(
      store.listFor("42", 22, ["root-cause", "missing"]).get("root-cause"),
    ).toEqual(second);
    expect(store.listFor("42", 23, ["root-cause"]).size).toBe(0);
    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM automation_ai_triage",
      ).get()?.count,
    ).toBe(1);
    db.close();
  });

  test("database constraints reject unsupported verdicts and confidence", () => {
    const db = new Database(":memory:");
    migrate(db);
    const store = new SqliteAutomationAiTriageStore(db);
    expect(() =>
      store.record({
        projectId: "42",
        scheduleId: 22,
        signatureKey: "root",
        signature: "Failure",
        verdict: "unknown",
        confidence: 1.1,
        rationale: "No evidence.",
        recommendation: "Inspect manually.",
        taskRunId: "run",
      }),
    ).toThrow();
    db.close();
  });
});
