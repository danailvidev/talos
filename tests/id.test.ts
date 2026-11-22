import { describe, expect, test } from "bun:test";
import { isGeneratedId, newId, reassignInstanceId } from "../src/persistence/id.ts";
import { Database } from "bun:sqlite";

describe("newId", () => {
  test("returns a UUID that isGeneratedId accepts", () => {
    const id = newId();
    expect(isGeneratedId(id)).toBe(true);
  });

  test("does not collide across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newId();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  test("isGeneratedId rejects name slugs and collision suffixes", () => {
    expect(isGeneratedId("mr-review-mrs")).toBe(false);
    expect(isGeneratedId("mr-review-mrs-2")).toBe(false);
    expect(isGeneratedId("mr-review-6194")).toBe(false);
    expect(isGeneratedId("gitlab-code-review")).toBe(false);
  });
});

describe("reassignInstanceId", () => {
  test("rewrites every table that stores the instance id", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    for (const sql of [
      "CREATE TABLE task_instances (id TEXT PRIMARY KEY)",
      "CREATE TABLE scheduled_task_config (task_id TEXT PRIMARY KEY)",
      "CREATE TABLE task_state (task_id TEXT, key TEXT, PRIMARY KEY (task_id, key))",
      "CREATE TABLE processed_events (task_id TEXT)",
      "CREATE TABLE filed_issues (task_id TEXT)",
      "CREATE TABLE task_runs (task_id TEXT)",
      "CREATE TABLE reviewed_merge_requests (task_id TEXT)",
    ]) {
      db.run(sql);
    }

    db.run("INSERT INTO task_instances (id) VALUES ('old')");
    db.run("INSERT INTO scheduled_task_config (task_id) VALUES ('old')");
    db.run("INSERT INTO task_state (task_id, key) VALUES ('old', 'watermark')");
    db.run("INSERT INTO processed_events (task_id) VALUES ('old')");
    db.run("INSERT INTO filed_issues (task_id) VALUES ('old')");
    db.run("INSERT INTO task_runs (task_id) VALUES ('old')");
    db.run("INSERT INTO reviewed_merge_requests (task_id) VALUES ('old')");

    reassignInstanceId(db, "old", "new");

    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM task_instances WHERE id = 'new'").get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM scheduled_task_config WHERE task_id = 'new'").get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM task_state WHERE task_id = 'new'").get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM processed_events WHERE task_id = 'new'").get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM filed_issues WHERE task_id = 'new'").get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM task_runs WHERE task_id = 'new'").get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM reviewed_merge_requests WHERE task_id = 'new'").get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM task_instances WHERE id = 'old'").get()?.n).toBe(0);
    db.close();
  });
});
