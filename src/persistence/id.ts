import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

/**
 * Opaque unique id for a persisted row. Not derived from a name or other
 * user-facing field, so two rows can share a label without colliding in the
 * URL or in any table that keys by this value.
 */
export function newId(): string {
  return randomUUID();
}

export function isGeneratedId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id,
  );
}

/**
 * Every table that stores an instance id. There are no FKs onto
 * `task_instances`, so a rename has to touch each of these explicitly.
 */
const INSTANCE_ID_REFS: { table: string; column: string }[] = [
  { table: "task_instances", column: "id" },
  { table: "scheduled_task_config", column: "task_id" },
  { table: "task_state", column: "task_id" },
  { table: "processed_events", column: "task_id" },
  // Dropped by migration 20, and still listed: this runs from migration 10, long
  // before the table is gone, and absent tables are skipped below.
  { table: "filed_issues", column: "task_id" },
  { table: "task_runs", column: "task_id" },
  // Added long after the id migration; absent-table skipping keeps old upgrades safe.
  { table: "task_run_statistics", column: "task_id" },
  { table: "reviewed_merge_requests", column: "task_id" },
  { table: "work_subjects", column: "loop_id" },
  // Both, and for different reasons: `loop_id` is the discoverer that enqueued
  // the job, `kind` is the handler task that runs it. A renamed instance can be
  // either, and missing one would leave jobs no worker will ever lease.
  { table: "jobs", column: "loop_id" },
  { table: "jobs", column: "kind" },
];

export function reassignInstanceId(db: Database, from: string, to: string): void {
  if (from === to) return;
  for (const { table, column } of INSTANCE_ID_REFS) {
    // Absent tables are skipped rather than assumed. This function runs from a
    // migration, so it can execute against a database older than some of the
    // tables listed above — an install upgrading from v9 reaches migration 10
    // (unique-instance-ids) long before migration 18 has created `jobs` and
    // `work_subjects`. Failing there would block the upgrade entirely.
    if (!tableExists(db, table)) continue;
    db.run(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, [to, from]);
  }
}

function tableExists(db: Database, table: string): boolean {
  return (
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) != null
  );
}
