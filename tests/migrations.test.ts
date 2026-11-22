import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MIGRATIONS,
  migrate,
  schemaVersion,
  type Migration,
} from "../src/persistence/migrations.ts";
import { isGeneratedId } from "../src/persistence/id.ts";
import { openDatabase } from "../src/persistence/database.ts";

function memoryDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

function tables(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
}

describe("migrate", () => {
  test("creates every table on a fresh database", () => {
    const db = memoryDb();
    migrate(db);

    expect(tables(db)).toEqual([
      "agent_accounts",
      "agent_checkpoint_events",
      "agent_checkpoints",
      "agent_execution_attempts",
      "agent_host_permits",
      "agent_usage_events",
      "auth_invitation_tokens",
      "auth_reset_tokens",
      "auth_role_permissions",
      "auth_roles",
      "auth_sessions",
      "auth_user_activity",
      "auth_users",
      "automation_ai_triage",
      "automation_config",
      "automation_config_schedules",
      "automation_failure_assignees",
      "automation_failure_cluster_work",
      "automation_failure_inbox",
      "automation_jira_config",
      "automation_jira_labels",
      "automation_job_retry_attempts",
      "automation_job_retry_waves",
      "automation_pipeline_failed_tests",
      "automation_pipeline_jobs",
      "automation_pipeline_test_suites",
      "automation_pipelines",
      "automation_schedules",
      "configuration_revision",
      "daemon_lease",
      "dashboards",
      "datadog_ai_triage",
      "datadog_issues",
      "datadog_routing_rules",
      "datadog_service_targets",
      "deploy_watch_findings",
      "deploy_watches",
      "e2e_test_config",
      "execution_resources",
      "feedback",
      "feedback_attachments",
      "general_config",
      "integration_config",
      "jobs",
      "legacy_workflow_imports",
      "logrocket_issues",
      "notifications",
      "orchestration_events",
      "orchestration_settings",
      "plans",
      "processed_events",
      "prompt_templates",
      "regression_tests",
      "release_config",
      "reviewed_merge_requests",
      "scheduled_task_config",
      "schema_migrations",
      "slack_activity_revisions",
      "slack_channel_selections",
      "slack_connections",
      "slack_conversation_activity",
      "slack_conversations",
      "slack_hidden_conversations",
      "slack_oauth_states",
      "slack_read_cursors",
      "sqlite_sequence",
      "task_instances",
      "task_run_logs",
      "task_run_statistics",
      "task_runs",
      "task_state",
      "task_steps",
      "test_flake_flags",
      "test_run_failures",
      "test_runs",
      "user_credentials",
      "user_fix_issue_defaults",
      "user_preferences",
      "user_pull_request_repos",
      "webhook_deliveries",
      "webhook_endpoints",
      "webhook_triggers",
      "work_subjects",
    ]);
    db.close();
  });

  test("preserves customized user permissions as migrated roles", () => {
    const db = memoryDb();
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 73));
    const insertUser = db.query<
      unknown,
      [string, string, string, string, string, string]
    >(
      `INSERT INTO auth_users (id, email, name, password_hash, created_at, role)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertUser.run("qa-user", "qa@example.com", "QA", "hash", "2026-01-01", "qa");
    insertUser.run("custom-1", "one@example.com", "One", "hash", "2026-01-01", "qa");
    insertUser.run("custom-2", "two@example.com", "Two", "hash", "2026-01-01", "qa");
    db.run(
      `INSERT INTO auth_user_permissions (user_id, permission)
       VALUES ('custom-1', 'application-logs:read'),
              ('custom-2', 'application-logs:read')`,
    );

    migrate(db);

    expect(
      db.query<{ role_id: string }, [string]>(
        "SELECT role_id FROM auth_users WHERE id = ?",
      ).get("qa-user")?.role_id,
    ).toBe("qa");
    const customRoles = db
      .query<{ id: string; name: string }, []>(
        "SELECT id, name FROM auth_roles WHERE system = 0",
      )
      .all();
    expect(customRoles).toHaveLength(1);
    expect(customRoles[0]?.name).toBe("Migrated access 1");
    expect(
      db.query<{ role_id: string }, [string]>(
        "SELECT role_id FROM auth_users WHERE id = ?",
      ).get("custom-1")?.role_id,
    ).toBe(customRoles[0]?.id);
    expect(
      db.query<{ role_id: string }, [string]>(
        "SELECT role_id FROM auth_users WHERE id = ?",
      ).get("custom-2")?.role_id,
    ).toBe(customRoles[0]?.id);
    expect(
      db.query<{ permission: string }, [string]>(
        "SELECT permission FROM auth_role_permissions WHERE role_id = ?",
      ).all(customRoles[0]!.id),
    ).toEqual(expect.arrayContaining([
      { permission: "application-logs:read" },
      { permission: "loops:access" },
      { permission: "pull-requests:access" },
      { permission: "releases:access" },
      { permission: "automation:access" },
      { permission: "logrocket:access" },
      { permission: "datadog:access" },
      { permission: "tickets:access" },
      { permission: "slack:access" },
    ]));
    expect(tables(db)).not.toContain("auth_user_permissions");
    db.close();
  });

  test("reports what it applied and records the version", () => {
    const db = memoryDb();
    const applied = migrate(db);

    expect(applied.map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(schemaVersion(db)).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
    db.close();
  });

  test("upgrades the CI trace cap and removes legacy unattributed spec rows", () => {
    const db = memoryDb();
    migrate(db, MIGRATIONS.filter((migration) => migration.version < 78));
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO scheduled_task_config (task_id, params, updated_at)
       VALUES ('gitlab-ci-failure', ?, ?)`,
      [JSON.stringify({ gitlab: { projectId: "acme/web", maxTraceBytes: 262_144 } }), now],
    );
    db.run(
      `INSERT INTO test_run_failures
         (source, project, test_id, run_id, signature, finished_at, observed_at)
       VALUES ('gitlab-ci-failure', 'acme/web', '(unattributed)', '1', 'Mystery', ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO test_flake_flags (source, project, test_id, updated_at)
       VALUES ('gitlab-ci-failure', 'acme/web', '(unattributed)', ?)`,
      [now],
    );

    migrate(db);

    const params = db
      .query<{ params: string }, []>(
        "SELECT params FROM scheduled_task_config WHERE task_id = 'gitlab-ci-failure'",
      )
      .get()!.params;
    expect(JSON.parse(params).gitlab.maxTraceBytes).toBe(1_048_576);
    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM test_run_failures WHERE test_id = '(unattributed)'",
      ).get()!.count,
    ).toBe(0);
    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM test_flake_flags WHERE test_id = '(unattributed)'",
      ).get()!.count,
    ).toBe(0);
    db.close();
  });

  test("configuration revision ignores runtime history and changes on config writes", () => {
    const db = memoryDb();
    migrate(db);
    const revision = () => db.query<{ revision: number }, []>(
      "SELECT revision FROM configuration_revision WHERE singleton = 1",
    ).get()!.revision;
    const initial = revision();
    db.run(
      `INSERT INTO task_runs (execution_id, task_id, started_at, status, dry_run)
       VALUES ('runtime-only', 'task', ?, 'running', 0)`,
      [new Date().toISOString()],
    );
    db.run(
      `INSERT INTO jobs
         (id, kind, loop_id, dedupe_key, params, status, available_at, enqueued_at)
       VALUES ('runtime-job', 'handler', 'loop', 'runtime-job', '{}', 'queued', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()],
    );
    expect(revision()).toBe(initial);
    db.run(
      `INSERT INTO scheduled_task_config
         (task_id, enabled, max_items_per_run, updated_at)
       VALUES ('task', 1, 10, ?)`,
      [new Date().toISOString()],
    );
    expect(revision()).toBe(initial + 1);
    db.run("UPDATE scheduled_task_config SET enabled = 0 WHERE task_id = 'task'");
    expect(revision()).toBe(initial + 2);
    db.close();
  });

  test("is idempotent — a second run applies nothing", () => {
    const db = memoryDb();
    migrate(db);
    expect(migrate(db)).toEqual([]);
    db.close();
  });

  test("preserves legacy agent permits as uncertain orchestration attempts", () => {
    const db = memoryDb();
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 93));
    db.run(
      `INSERT INTO agent_host_permits (slot, owner, expires_at)
       VALUES (0, 'old-daemon', '2026-01-01T00:00:00.000Z')`,
    );

    migrate(db);

    expect(db.query<{ slot: number; state: string; reason: string }, []>(
      "SELECT slot, state, reason FROM agent_execution_attempts",
    ).get()).toEqual({
      slot: 0,
      state: "uncertain",
      reason: "legacy permit awaiting successful runtime discovery",
    });
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM agent_host_permits",
    ).get()?.count).toBe(0);
    db.close();
  });

  test("backfills Automation report version and marks existing failures as legacy", () => {
    const db = memoryDb();
    migrate(db, MIGRATIONS.filter((migration) => migration.version < 80));
    db.run(
      `INSERT INTO automation_schedules
         (project_id, schedule_id, description, ref, active, synced_at)
       VALUES ('42', 22, 'Nightly', 'main', 1, '2026-09-24T00:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO automation_pipelines
         (project_id, pipeline_id, schedule_id, status, ref, sha, web_url,
          updated_at, report_state)
       VALUES ('42', 9001, 22, 'failed', 'main', 'abc', 'https://gitlab/p/1',
               '2026-09-24T01:00:00.000Z', 'complete')`,
    );
    db.run(
      `INSERT INTO automation_pipeline_test_suites
         (project_id, pipeline_id, suite_index, name, build_ids_json, total_time,
          total_count, success_count, failed_count, skipped_count, error_count)
       VALUES ('42', 9001, 0, 'web', '[7001]', 1, 1, 0, 1, 0, 0)`,
    );
    db.run(
      `INSERT INTO automation_pipeline_failed_tests
         (project_id, pipeline_id, suite_index, case_index, job_id, status, name,
          execution_time)
       VALUES ('42', 9001, 0, 0, 7001, 'failed', 'checks out', 1)`,
    );

    migrate(db);

    expect(
      db.query<{ report_version: number }, []>(
        "SELECT report_version FROM automation_pipelines",
      ).get()?.report_version,
    ).toBe(1);
    expect(
      db.query<
        {
          test_file: string | null;
          attachment_path: string | null;
          signature_key: string;
          signature_title: string;
        },
        []
      >(
        `SELECT test_file, attachment_path, signature_key, signature_title
           FROM automation_pipeline_failed_tests`,
      ).get(),
    ).toEqual({
      test_file: null,
      attachment_path: null,
      signature_key: "legacy-v1:42:9001:0:0",
      signature_title: "checks out",
    });
    db.close();
  });

  test("adds optional Automation Jira defaults without changing source config", () => {
    const db = memoryDb();
    migrate(db, MIGRATIONS.filter((migration) => migration.version < 81));
    db.run(
      `INSERT INTO automation_config (id, project_id, updated_at)
       VALUES (1, 'group/project', '2026-09-24T00:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO automation_config_schedules
         (config_id, position, schedule_id, display_name)
       VALUES (1, 0, 22, 'Nightly web')`,
    );

    migrate(db);

    expect(
      db.query<{ project_id: string }, []>(
        "SELECT project_id FROM automation_config WHERE id = 1",
      ).get()?.project_id,
    ).toBe("group/project");
    expect(
      db.query<{ schedule_id: number; display_name: string }, []>(
        `SELECT schedule_id, display_name
           FROM automation_config_schedules
          WHERE config_id = 1`,
      ).get(),
    ).toEqual({ schedule_id: 22, display_name: "Nightly web" });
    expect(
      db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM automation_jira_config",
      ).get()?.count,
    ).toBe(0);
    db.close();
  });

  test("marks existing deploy-watch findings as Datadog when adding LogRocket support", () => {
    const db = memoryDb();
    migrate(
      db,
      MIGRATIONS.filter((migration) => migration.version < 59),
    );
    const at = "2026-09-16T10:00:00.000Z";
    db.run(
      `INSERT INTO deploy_watches
         (id, environment, project_id, mr_iid, mr_url, branch, services_json,
          state, opened_at, created_at, updated_at)
       VALUES ('watch-1', 'PROD', 'group/releases', 42, 'https://gitlab/mr/42',
               'release/prod', '[]', 'watching', ?, ?, ?)`,
      [at, at, at],
    );
    db.run(
      `INSERT INTO deploy_watch_findings
         (id, watch_id, signature, fingerprint, event_count, first_seen_at, created_at)
       VALUES ('finding-1', 'watch-1', 'Known error', 'abc', 3, ?, ?)`,
      [at, at],
    );

    migrate(db);

    expect(
      db
        .query<{ source: string; external_url: string | null; issue_type: string | null }, []>(
          `SELECT source, external_url, issue_type
             FROM deploy_watch_findings
            WHERE id = 'finding-1'`,
        )
        .get(),
    ).toEqual({ source: "datadog", external_url: null, issue_type: null });
    expect(
      db
        .query<
          { release_kind: string; mr_iid: number; mr_url: string },
          []
        >(
          `SELECT release_kind, mr_iid, mr_url
             FROM deploy_watches
            WHERE id = 'watch-1'`,
        )
        .get(),
    ).toEqual({
      release_kind: "merge-request",
      mr_iid: 42,
      mr_url: "https://gitlab/mr/42",
    });
    expect(
      db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
            WHERE type = 'index' AND name = 'idx_logrocket_issues_first_seen'`,
        )
        .get()?.name,
    ).toBe("idx_logrocket_issues_first_seen");
    db.close();
  });

  test("applies only pending migrations when a new one is appended", () => {
    const db = memoryDb();
    migrate(db);

    const added: Migration = {
      version: 999,
      name: "add-scratch",
      up: "CREATE TABLE scratch (id INTEGER PRIMARY KEY)",
    };
    const applied = migrate(db, [...MIGRATIONS, added]);

    expect(applied.map((m) => m.version)).toEqual([999]);
    expect(tables(db)).toContain("scratch");
    db.close();
  });

  test("keeps existing messages when feedback becomes structured", () => {
    const db = memoryDb();
    migrate(db, MIGRATIONS.filter((migration) => migration.version < 75));
    db.run(
      `INSERT INTO feedback (id, user_id, message, created_at)
       VALUES ('feedback-1', 'user-1', 'An older message', '2026-01-01T00:00:00.000Z')`,
    );

    migrate(db);

    expect(
      db
        .query<
          {
            type: string;
            title: string;
            message: string;
            labels_json: string;
            publication_status: string;
            publication_reason: string | null;
            external_issue_url: string | null;
            external_issue_number: number | null;
          },
          []
        >(
          `SELECT type, title, message, labels_json,
                  publication_status, publication_reason,
                  external_issue_url, external_issue_number
             FROM feedback`,
        )
        .get(),
    ).toEqual({
      type: "general",
      title: "Feedback",
      message: "An older message",
      labels_json: "[]",
      publication_status: "pending",
      publication_reason: null,
      external_issue_url: null,
      external_issue_number: null,
    });
    db.close();
  });

  test("applies in version order regardless of array order", () => {
    const db = memoryDb();
    const order: Migration[] = [
      { version: 2, name: "second", up: "CREATE TABLE b (id INTEGER PRIMARY KEY)" },
      { version: 1, name: "first", up: "CREATE TABLE a (id INTEGER PRIMARY KEY)" },
    ];

    expect(migrate(db, order).map((m) => m.version)).toEqual([1, 2]);
    db.close();
  });

  test("a failing migration rolls back, leaving the last good version", () => {
    const db = memoryDb();
    migrate(db);
    const before = schemaVersion(db);

    const broken: Migration = {
      version: 998,
      name: "broken",
      up: `
        CREATE TABLE will_not_survive (id INTEGER PRIMARY KEY);
        THIS IS NOT SQL;
      `,
    };

    expect(() => migrate(db, [...MIGRATIONS, broken])).toThrow();

    // Both halves of the transaction are gone: the version did not advance and
    // the partially created table is absent.
    expect(schemaVersion(db)).toBe(before);
    expect(tables(db)).not.toContain("will_not_survive");
    db.close();
  });

  test("schemaVersion is 0 before anything is applied", () => {
    const db = memoryDb();
    db.run(
      `CREATE TABLE schema_migrations (
         version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`,
    );
    expect(schemaVersion(db)).toBe(0);
    db.close();
  });
});

describe("schema constraints", () => {
  test("keeps account status aligned with password availability", () => {
    const db = memoryDb();
    migrate(db);

    db.run(
      `INSERT INTO auth_users
         (id, email, name, password_hash, created_at, role_id, account_status)
       VALUES ('pending', 'pending@example.com', 'Pending', NULL, '2026-01-01', 'qa', 'pending')`,
    );
    expect(() =>
      db.run(
        `INSERT INTO auth_users
           (id, email, name, password_hash, created_at, role_id, account_status)
         VALUES ('broken', 'broken@example.com', 'Broken', NULL, '2026-01-01', 'qa', 'active')`,
      ),
    ).toThrow();
    db.close();
  });

  test("rejects an out-of-range event status", () => {
    const db = memoryDb();
    migrate(db);

    expect(() =>
      db.run(
        `INSERT INTO processed_events
           (task_id, external_id, event_type, status, claimed_at)
         VALUES ('t1', 'x', 't', 'bogus', '2026-01-01T00:00:00.000Z')`,
      ),
    ).toThrow();
    db.close();
  });

  test("accepts a cancelled run status", () => {
    const db = memoryDb();
    migrate(db);
    db.run(
      `INSERT INTO task_runs (execution_id, task_id, started_at, status)
       VALUES ('e-cancel', 't1', '2026-01-01T00:00:00.000Z', 'cancelled')`,
    );
    const row = db
      .query<{ status: string }, []>(
        "SELECT status FROM task_runs WHERE execution_id = 'e-cancel'",
      )
      .get();
    expect(row?.status).toBe("cancelled");
    db.close();
  });

  test("rejects an out-of-range run status", () => {
    const db = memoryDb();
    migrate(db);

    expect(() =>
      db.run(
        `INSERT INTO task_runs (execution_id, task_id, started_at, status)
         VALUES ('e1', 't1', '2026-01-01T00:00:00.000Z', 'sideways')`,
      ),
    ).toThrow();
    db.close();
  });

  test("deleting a run cascades to its steps", () => {
    const db = memoryDb();
    migrate(db);

    db.run(
      `INSERT INTO task_runs (execution_id, task_id, started_at, status)
       VALUES ('e1', 't1', '2026-01-01T00:00:00.000Z', 'success')`,
    );
    db.run(
      `INSERT INTO task_steps
         (execution_id, step_id, started_at, duration_ms, status, attempts)
       VALUES ('e1', 's1', '2026-01-01T00:00:00.000Z', 5, 'success', 1)`,
    );

    db.run("DELETE FROM task_runs WHERE execution_id = 'e1'");

    const remaining = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_steps")
      .get();
    expect(remaining?.n).toBe(0);
    db.close();
  });

  test("deleting a run cascades to its log lines", () => {
    const db = memoryDb();
    migrate(db);

    db.run(
      `INSERT INTO task_runs (execution_id, task_id, started_at, status)
       VALUES ('e1', 't1', '2026-01-01T00:00:00.000Z', 'success')`,
    );
    db.run(
      `INSERT INTO task_run_logs (execution_id, ts, level, message)
       VALUES ('e1', '2026-01-01T00:00:00.000Z', 'info', 'hello')`,
    );

    db.run("DELETE FROM task_runs WHERE execution_id = 'e1'");

    const remaining = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_run_logs")
      .get();
    expect(remaining?.n).toBe(0);
    db.close();
  });

  test("a step cannot reference a run that does not exist", () => {
    const db = memoryDb();
    migrate(db);

    expect(() =>
      db.run(
        `INSERT INTO task_steps
           (execution_id, step_id, started_at, duration_ms, status, attempts)
         VALUES ('ghost', 's1', '2026-01-01T00:00:00.000Z', 5, 'success', 1)`,
      ),
    ).toThrow();
    db.close();
  });
});

describe("openDatabase", () => {
  test("creates missing directories and applies migrations", async () => {
    const dir = join(tmpdir(), `talos-open-${crypto.randomUUID()}`);
    const path = join(dir, "nested", "deeper", "talos.db");

    try {
      const { db, applied, version } = openDatabase(path);
      expect(applied.length).toBeGreaterThan(0);
      expect(version).toBeGreaterThan(0);
      expect(tables(db)).toContain("processed_events");
      db.close();

      expect(await Bun.file(path).exists()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sets the pragmas the design depends on", () => {
    const { db } = openDatabase(":memory:");

    // foreign_keys is off by default in SQLite, and the steps cascade needs it.
    expect(
      db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys,
    ).toBe(1);
    db.close();
  });

  test("reopening an existing database applies nothing new", async () => {
    const dir = join(tmpdir(), `talos-reopen-${crypto.randomUUID()}`);
    const path = join(dir, "talos.db");

    try {
      const first = openDatabase(path);
      first.db.close();

      const second = openDatabase(path);
      expect(second.applied).toEqual([]);
      expect(second.version).toBe(first.version);
      second.db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("unique-instance-ids", () => {
  test("remaps slug instance ids across related tables", () => {
    const db = memoryDb();
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 10),
    );

    db.run(
      `INSERT INTO task_instances (id, definition_id, name, created_at, visibility)
       VALUES ('mr-review-mrs', 'gitlab-code-review', 'MR review (MRs)', '2026-01-01T00:00:00.000Z', 'public')`,
    );
    db.run(
      `INSERT INTO task_instances (id, definition_id, name, created_at, visibility)
       VALUES ('mr-review-mrs-2', 'gitlab-code-review', 'MR review (MRs)', '2026-01-01T00:00:01.000Z', 'public')`,
    );
    // Cron rather than manual: migration 23 removes unowned code-review
    // instances whose schedule is disabled *and* manual, which is what the old
    // per-MR spawner wrote. The trigger type is immaterial to the remapping
    // under test, and this keeps the fixture out of that sweep.
    db.run(
      `INSERT INTO scheduled_task_config (task_id, enabled, updated_at, trigger_type)
       VALUES ('mr-review-mrs', 0, '2026-01-01T00:00:00.000Z', 'cron')`,
    );
    db.run(
      `INSERT INTO task_runs (execution_id, task_id, started_at, status)
       VALUES ('e1', 'mr-review-mrs', '2026-01-01T00:00:00.000Z', 'success')`,
    );
    db.run(
      `INSERT INTO reviewed_merge_requests (task_id, project_id, mr_iid, sha, reviewed_at)
       VALUES ('mr-review-mrs', 'acme/web', 1, 'abc', '2026-01-01T00:00:00.000Z')`,
    );

    const applied = migrate(db);
    expect(applied.map((m) => m.version)).toEqual(
      MIGRATIONS.filter((m) => m.version >= 10).map((m) => m.version),
    );

    const instances = db
      .query<{ id: string }, []>("SELECT id FROM task_instances ORDER BY created_at")
      .all();
    expect(instances).toHaveLength(2);
    expect(instances.every((row) => isGeneratedId(row.id))).toBe(true);
    expect(instances[0]!.id).not.toBe(instances[1]!.id);

    expect(
      db
        .query<{ n: number }, [string]>("SELECT count(*) n FROM scheduled_task_config WHERE task_id = ?")
        .get(instances[0]!.id)?.n,
    ).toBe(1);
    expect(
      db.query<{ n: number }, []>("SELECT count(*) n FROM scheduled_task_config WHERE task_id = 'mr-review-mrs'").get()
        ?.n,
    ).toBe(0);
    expect(
      db.query<{ n: number }, [string]>("SELECT count(*) n FROM task_runs WHERE task_id = ?").get(instances[0]!.id)?.n,
    ).toBe(1);
    expect(
      db
        .query<{ n: number }, [string]>("SELECT count(*) n FROM reviewed_merge_requests WHERE task_id = ?")
        .get(instances[0]!.id)?.n,
    ).toBe(1);
    db.close();
  });

  test("leaves already-generated ids alone", () => {
    const db = memoryDb();
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 10),
    );
    const existing = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    db.run(
      `INSERT INTO task_instances (id, definition_id, name, created_at, visibility)
       VALUES (?, 'gitlab-code-review', 'Kept', '2026-01-01T00:00:00.000Z', 'public')`,
      [existing],
    );
    migrate(db);
    expect(db.query<{ id: string }, []>("SELECT id FROM task_instances").get()?.id).toBe(existing);
    db.close();
  });
});
