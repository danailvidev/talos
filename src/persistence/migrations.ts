import type { Database } from "bun:sqlite";
import { isGeneratedId, newId, reassignInstanceId } from "./id.ts";

export interface Migration {
  version: number;
  name: string;
  /** SQL, or a function when the change cannot be expressed as SQL alone. */
  up: string | ((db: Database) => void);
}

/**
 * Replaces name-derived instance ids (`mr-review-mrs`, `mr-review-mrs-2`) with
 * generated unique ids, and rewrites every table that keyed off the old value.
 * Code-registered tasks are not in `task_instances` and are left alone.
 */
function remapSlugInstanceIds(db: Database): void {
  const rows = db.query<{ id: string }, []>("SELECT id FROM task_instances").all();
  for (const row of rows) {
    if (isGeneratedId(row.id)) continue;
    reassignInstanceId(db, row.id, newId());
  }
}

/**
 * Migrations live in code rather than in .sql files on disk: `bun build --compile`
 * produces a single binary with no filesystem alongside it, and a migration that
 * cannot be found at runtime is a worse failure than a slightly longer module.
 *
 * Never edit an applied migration — append a new one.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial-schema",
    up: `
      -- Idempotency ledger. The unique index below is the whole mechanism: it is
      -- what makes a claim atomic, and therefore what stops a second Jira ticket
      -- from being filed for the same pipeline.
      CREATE TABLE processed_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id  TEXT NOT NULL,
        external_id  TEXT NOT NULL,
        event_type   TEXT NOT NULL,
        status       TEXT NOT NULL
                     CHECK (status IN ('claimed', 'completed', 'failed')),
        claimed_at   TEXT NOT NULL,
        completed_at TEXT,
        attempts     INTEGER NOT NULL DEFAULT 1,
        error        TEXT,
        metadata     TEXT
      );

      CREATE UNIQUE INDEX idx_processed_events_key
        ON processed_events (workflow_id, external_id);

      -- Supports findStaleClaims without scanning the table.
      CREATE INDEX idx_processed_events_stale
        ON processed_events (workflow_id, status, claimed_at);

      -- One row per execution, opened before the workflow runs so a process that
      -- dies mid-run leaves evidence rather than nothing.
      CREATE TABLE workflow_runs (
        execution_id    TEXT PRIMARY KEY,
        workflow_id     TEXT NOT NULL,
        started_at      TEXT NOT NULL,
        finished_at     TEXT,
        duration_ms     INTEGER,
        status          TEXT NOT NULL
                        CHECK (status IN ('running', 'success', 'failure')),
        dry_run         INTEGER NOT NULL DEFAULT 0,
        items_seen      INTEGER,
        items_processed INTEGER,
        items_skipped   INTEGER,
        error           TEXT
      );

      CREATE INDEX idx_workflow_runs_history
        ON workflow_runs (workflow_id, started_at DESC);

      CREATE TABLE workflow_steps (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL
                     REFERENCES workflow_runs (execution_id) ON DELETE CASCADE,
        step_id      TEXT NOT NULL,
        started_at   TEXT NOT NULL,
        duration_ms  INTEGER NOT NULL,
        status       TEXT NOT NULL CHECK (status IN ('success', 'failure')),
        attempts     INTEGER NOT NULL,
        error        TEXT
      );

      CREATE INDEX idx_workflow_steps_execution
        ON workflow_steps (execution_id, id);

      -- Per-workflow scalars. Watermarks live here under key 'watermark'.
      CREATE TABLE workflow_state (
        workflow_id TEXT NOT NULL,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (workflow_id, key)
      );

      -- Runtime overrides only. NULL means "defer to YAML" — see config/load.ts.
      CREATE TABLE workflow_config (
        workflow_id TEXT PRIMARY KEY,
        enabled     INTEGER,
        schedule    TEXT,
        updated_at  TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "filed-issues",
    up: `
      -- What was filed where, keyed by the thing a human tracks: one open ticket
      -- per failing spec file.
      --
      -- processed_events cannot express this. Its key is an event — a pipeline, a
      -- work item — and each night's pipeline is a new event, so keying tickets
      -- there would refile every ticket daily. The subject here is the *file*,
      -- whose identity outlives any pipeline, and which must become fileable
      -- again once its ticket is closed. That is a lifecycle, not a claim.
      CREATE TABLE filed_issues (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id   TEXT NOT NULL,
        -- Stable identity of the thing a ticket is about: for workflow 1,
        -- '<gitlab project>:<spec file path>'. Deliberately carries no pipeline
        -- id, which is what makes tomorrow's run recognise yesterday's failure.
        subject_key   TEXT NOT NULL,
        issue_key     TEXT NOT NULL,
        issue_url     TEXT,
        -- Fingerprint of the failure the ticket was filed for. A change means the
        -- same file is now failing differently, which earns a comment rather than
        -- a second ticket.
        signature     TEXT NOT NULL,
        -- 'open'   -> this ticket is the live one for the subject
        -- 'closed' -> observed resolved in Jira; the subject is fileable again
        state         TEXT NOT NULL DEFAULT 'open'
                      CHECK (state IN ('open', 'closed')),
        filed_at      TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        -- When the failure was last seen still failing, so a stale ticket for a
        -- test nobody has run in months is visible as such.
        last_seen_at  TEXT NOT NULL,
        -- How many runs observed this failure. Distinguishes a one-off from a
        -- fortnight of red.
        seen_count    INTEGER NOT NULL DEFAULT 1,
        -- Audit trail the plan requires (§14): the pipeline and job that produced
        -- the ticket, plus the failing test names, as JSON.
        metadata      TEXT
      );

      -- The guard against double-filing. Partial, so only one *open* ticket may
      -- exist per subject while any number of closed ones accumulate as history —
      -- which is exactly the "refile once closed" rule, enforced by the schema
      -- rather than by a read-then-write in application code.
      CREATE UNIQUE INDEX idx_filed_issues_open
        ON filed_issues (workflow_id, subject_key)
        WHERE state = 'open';

      CREATE INDEX idx_filed_issues_subject
        ON filed_issues (workflow_id, subject_key, filed_at DESC);

      CREATE INDEX idx_filed_issues_key
        ON filed_issues (workflow_id, issue_key);
    `,
  },
  {
    version: 3,
    name: "workflow-config-full",
    up: `
      -- workflow_config grows from "enabled/schedule overrides on top of YAML"
      -- into the sole source of a workflow's configuration: YAML is gone, so
      -- every field that used to live there now lives here instead.
      ALTER TABLE workflow_config ADD COLUMN trigger_type TEXT;
      ALTER TABLE workflow_config ADD COLUMN timezone TEXT;
      ALTER TABLE workflow_config ADD COLUMN max_items_per_run INTEGER;
      -- Workflow-specific fields (gitlab.*, jira.*, ...), as JSON. Validated
      -- against the workflow's own configSchema when read, same as a YAML
      -- block used to be.
      ALTER TABLE workflow_config ADD COLUMN config TEXT;
    `,
  },
  {
    version: 4,
    name: "task-runs",
    up: `
      -- One row per task execution. Tasks have no schedule and no stored
      -- config — 'params' is the only record of what a run was asked to do,
      -- since there is no config file or table backing it.
      CREATE TABLE task_runs (
        execution_id     TEXT PRIMARY KEY,
        task_id          TEXT NOT NULL,
        started_at       TEXT NOT NULL,
        finished_at      TEXT,
        duration_ms      INTEGER,
        status           TEXT NOT NULL
                         CHECK (status IN ('running', 'success', 'failure')),
        dry_run          INTEGER NOT NULL DEFAULT 0,
        params           TEXT,
        items_seen       INTEGER,
        items_processed  INTEGER,
        items_skipped    INTEGER,
        error            TEXT
      );

      CREATE INDEX idx_task_runs_history
        ON task_runs (task_id, started_at DESC);

      CREATE TABLE task_steps (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL
                     REFERENCES task_runs (execution_id) ON DELETE CASCADE,
        step_id      TEXT NOT NULL,
        started_at   TEXT NOT NULL,
        duration_ms  INTEGER NOT NULL,
        status       TEXT NOT NULL CHECK (status IN ('success', 'failure')),
        attempts     INTEGER NOT NULL,
        error        TEXT
      );

      CREATE INDEX idx_task_steps_execution
        ON task_steps (execution_id, id);
    `,
  },
  {
    version: 5,
    name: "unify-task-schema",
    up: `
      -- Task is the one entity now: workflow_runs/workflow_steps are
      -- superseded by task_runs/task_steps (migration 4), which already have
      -- everything they had plus 'params'. Nothing to migrate data-wise —
      -- this is pre-launch.
      DROP TABLE workflow_steps;
      DROP TABLE workflow_runs;

      -- Per-task scalars, renamed from the per-workflow table of the same
      -- shape. Watermarks still live here under key 'watermark'.
      ALTER TABLE workflow_state RENAME TO task_state;
      ALTER TABLE task_state RENAME COLUMN workflow_id TO task_id;

      -- The sole source of a task's schedule configuration.
      ALTER TABLE workflow_config RENAME TO scheduled_task_config;
      ALTER TABLE scheduled_task_config RENAME COLUMN workflow_id TO task_id;
      ALTER TABLE scheduled_task_config RENAME COLUMN config TO params;

      ALTER TABLE processed_events RENAME COLUMN workflow_id TO task_id;
      ALTER TABLE filed_issues RENAME COLUMN workflow_id TO task_id;
    `,
  },
  {
    version: 6,
    name: "task-instances",
    up: `
      -- A user-created, named instance of an "instantiable" task definition
      -- (e.g. a second "GitLab CI failures -> Jira" loop for another project).
      -- The instance itself carries no behaviour: 'definition_id' points at the
      -- code-registered Task whose paramsSchema/run it borrows. Its schedule
      -- (enabled/trigger/params) lives in scheduled_task_config, keyed by this
      -- row's id like any other task.
      CREATE TABLE task_instances (
        id            TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL,
        name          TEXT NOT NULL,
        description   TEXT,
        created_at    TEXT NOT NULL
      );

      CREATE INDEX idx_task_instances_definition
        ON task_instances (definition_id);
    `,
  },
  {
    version: 7,
    name: "general-config",
    up: `
      -- General, non-task settings (log level, timezone, llm defaults) that
      -- used to be bootstrap-only YAML values. A single row, id fixed to 1.
      -- NULL in any column means "defer to the YAML default" — see
      -- config/resolve-settings.ts.
      CREATE TABLE general_config (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        log_level      TEXT,
        timezone       TEXT,
        llm_provider   TEXT,
        llm_model      TEXT,
        llm_max_tokens INTEGER,
        updated_at     TEXT NOT NULL
      );
    `,
  },
  {
    version: 8,
    name: "code-review",
    up: `
      -- What has already been reviewed, keyed by the MR itself rather than by
      -- run: a new commit on an open MR earns a fresh review, but re-running
      -- against an unchanged head must not repost the same comment.
      CREATE TABLE reviewed_merge_requests (
        task_id     TEXT NOT NULL,
        project_id  TEXT NOT NULL,
        mr_iid      INTEGER NOT NULL,
        sha         TEXT NOT NULL,
        note_url    TEXT,
        reviewed_at TEXT NOT NULL,
        PRIMARY KEY (task_id, project_id, mr_iid)
      );

      -- Whether a task instance appears for every viewer or only its creator.
      -- Not enforced anywhere yet — there is no login system to enforce it
      -- against — so this only affects what the UI displays.
      ALTER TABLE task_instances ADD COLUMN visibility TEXT NOT NULL
        DEFAULT 'public' CHECK (visibility IN ('public', 'private'));
    `,
  },
  {
    version: 9,
    name: "task-run-logs",
    up: `
      -- Lines emitted by a run's logger (executionId on every child log).
      -- The UI polls these while a run is in flight so the operator sees the
      -- same detail as stdout, with autoscroll, rather than only finished steps.
      CREATE TABLE task_run_logs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL
                     REFERENCES task_runs (execution_id) ON DELETE CASCADE,
        ts           TEXT NOT NULL,
        level        TEXT NOT NULL,
        step         TEXT,
        message      TEXT NOT NULL,
        meta         TEXT
      );

      CREATE INDEX idx_task_run_logs_execution
        ON task_run_logs (execution_id, id);
    `,
  },
  {
    version: 10,
    name: "unique-instance-ids",
    up: remapSlugInstanceIds,
  },
  {
    version: 11,
    name: "llm-effort",
    up: `
      -- Claude Code --effort for gitlab-code-review. NULL defers to the YAML
      -- default, same as the other llm_* columns.
      ALTER TABLE general_config ADD COLUMN llm_effort TEXT;
    `,
  },
  {
    version: 12,
    name: "schedule-start-at",
    up: `
      -- First allowed run for a cron trigger, so "daily from next Monday"
      -- is stored rather than implied. Once-triggers keep their instant in
      -- the existing schedule column (trigger_type = 'once').
      ALTER TABLE scheduled_task_config ADD COLUMN start_at TEXT;
    `,
  },
  {
    version: 13,
    name: "cancelled-run-status",
    up: allowCancelledRunStatus,
  },
  {
    version: 14,
    name: "legacy-workflow-imports",
    up: `
      -- A legacy workflows.<task-id> YAML block is copied into
      -- scheduled_task_config once. Keeping the marker separate means the
      -- runtime row remains purely operator-editable after migration.
      CREATE TABLE legacy_workflow_imports (
        task_id     TEXT PRIMARY KEY,
        imported_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 15,
    name: "task-instance-owners",
    up: `
      -- Private instances are visible only to their creator. Existing private
      -- rows predate authentication, so assign them to the built-in admin.
      ALTER TABLE task_instances ADD COLUMN owner_id TEXT;
      UPDATE task_instances
        SET owner_id = 'admin'
        WHERE visibility = 'private' AND owner_id IS NULL;
      CREATE INDEX idx_task_instances_owner
        ON task_instances (owner_id, visibility);
    `,
  },
  {
    version: 16,
    name: "registered-users",
    up: `
      CREATE TABLE auth_users (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
        email         TEXT NOT NULL COLLATE NOCASE UNIQUE,
        name          TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
    `,
  },
  {
    version: 17,
    name: "email-only-accounts",
    up: `
      CREATE TABLE auth_users_new (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL COLLATE NOCASE UNIQUE,
        name          TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
      INSERT INTO auth_users_new (id, email, name, password_hash, created_at)
        SELECT id, email, name, password_hash, created_at FROM auth_users;
      DROP TABLE auth_users;
      ALTER TABLE auth_users_new RENAME TO auth_users;
    `,
  },
  {
    version: 18,
    name: "jobs-and-work-subjects",
    up: `
      -- The durable identity of a thing talos tracks, independent of the runs
      -- that acted on it. Generalises 'filed_issues' (one ticket per spec file)
      -- and 'reviewed_merge_requests' (last reviewed sha per MR) into one shape:
      -- a subject_key that survives every poll, plus the fingerprint of the
      -- version last acted on.
      --
      -- Subject keys are namespaced strings, e.g.
      --   'spec:src/foo.spec.ts'  'gitlab:mr:group/proj!412'  'jira:TP-1234'
      CREATE TABLE work_subjects (
        id            INTEGER PRIMARY KEY,
        loop_id       TEXT NOT NULL,
        subject_key   TEXT NOT NULL,
        -- What version of the subject was last acted on: an MR head sha, a
        -- failure signature, a Jira 'updated' timestamp. NULL means "seen but
        -- not yet acted on".
        fingerprint   TEXT,
        state         TEXT NOT NULL DEFAULT 'open'
                      CHECK (state IN ('open', 'closed')),
        -- What was produced for this subject: a Jira key, an MR iid, a note id.
        external_ref  TEXT,
        external_url  TEXT,
        metadata      TEXT,
        first_seen_at TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL,
        seen_count    INTEGER NOT NULL DEFAULT 1,
        closed_at     TEXT
      );

      -- At most one open subject per (loop, key) — enforced by the database, not
      -- by a check in TypeScript, so two concurrent runs cannot both pass a
      -- check and both act. This is the guarantee 'filed_issues' already relies
      -- on, lifted to every loop. History is retained: closing a row frees the
      -- key without deleting what happened.
      CREATE UNIQUE INDEX idx_work_subjects_open
        ON work_subjects (loop_id, subject_key) WHERE state = 'open';

      CREATE INDEX idx_work_subjects_lookup
        ON work_subjects (loop_id, subject_key, state);

      -- One unit of work. Ephemeral, unlike 'task_instances' — which is
      -- configuration a human created and expects to see in the UI forever.
      -- Conflating the two is what made every discovered merge request leave a
      -- permanent row on the Tasks page.
      CREATE TABLE jobs (
        id            TEXT PRIMARY KEY,
        -- The registered task id that handles this job (a task with kind 'job').
        kind          TEXT NOT NULL,
        -- The discoverer that enqueued it, for attribution and per-loop stats.
        loop_id       TEXT NOT NULL,
        subject_key   TEXT,
        fingerprint   TEXT,
        -- What makes enqueue idempotent; see the partial unique index below.
        dedupe_key    TEXT NOT NULL,
        -- Validated against the handler task's own paramsSchema when it runs,
        -- exactly like ad-hoc CLI params, so a malformed job fails loudly.
        params        TEXT,
        priority      INTEGER NOT NULL DEFAULT 0,
        -- 'queued' covers both fresh and awaiting-retry work; 'available_at' is
        -- what distinguishes them, so backoff needs no extra state. 'dead' means
        -- attempts are exhausted and no worker will pick it up again.
        status        TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'leased', 'done', 'dead')),
        attempts      INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 3,
        -- Gates eligibility. Set to the future to defer or to back off.
        available_at  TEXT NOT NULL,
        -- A lease, not a lock: it expires, so a crashed worker's job is
        -- reclaimed by the next sweep instead of being stuck forever.
        lease_until   TEXT,
        lease_owner   TEXT,
        execution_id  TEXT,
        error         TEXT,
        enqueued_at   TEXT NOT NULL,
        started_at    TEXT,
        finished_at   TEXT
      );

      -- Enqueue idempotency. Scoped to in-flight rows only, so the same subject
      -- can be worked again after it completes (a new comment on an MR already
      -- handled) while a webhook racing the reconciliation poll cannot queue the
      -- same work twice.
      CREATE UNIQUE INDEX idx_jobs_dedupe
        ON jobs (dedupe_key) WHERE status IN ('queued', 'leased');

      -- The lease query's index: ready work, best-first.
      CREATE INDEX idx_jobs_ready
        ON jobs (status, available_at, priority DESC, enqueued_at);

      -- Expired-lease sweep.
      CREATE INDEX idx_jobs_leases
        ON jobs (status, lease_until);

      CREATE INDEX idx_jobs_kind ON jobs (kind, status);
      CREATE INDEX idx_jobs_subject ON jobs (loop_id, subject_key, enqueued_at DESC);
      CREATE INDEX idx_jobs_history ON jobs (enqueued_at DESC);
    `,
  },
  {
    version: 19,
    name: "follow-up-claims-to-handler",
    up: `
      -- 'gitlab-mr-follow-up-one' stopped being an instantiable task the loop
      -- created one of per merge request and became a single queue handler. Its
      -- discussion claims in 'processed_events' were namespaced by whichever
      -- task_id happened to answer the thread; they now have to live under the
      -- handler's own id, or every already-answered thread looks unanswered and
      -- gets a second reply.
      --
      -- Deliberately every row of this event type rather than the spawned
      -- instances only: earlier versions of the feature claimed threads under the
      -- *loop* instance's id, and a real database has claims under both. The
      -- 'gitlab-mr-discussion' namespace belongs solely to this feature, so
      -- sweeping it whole is both safe and the only way to catch them all.
      --
      -- 'external_id' is already globally unique (project!iid:discussion:note),
      -- so re-pointing cannot merge two different threads. OR IGNORE handles the
      -- one case that can collide: two task_ids having each claimed the same
      -- thread.
      UPDATE OR IGNORE processed_events
         SET task_id = 'gitlab-mr-follow-up-one'
       WHERE event_type = 'gitlab-mr-discussion'
         AND task_id <> 'gitlab-mr-follow-up-one';

      -- Whatever OR IGNORE refused is a duplicate of a row that did move; the
      -- surviving row carries the same claim, so dropping these loses nothing.
      DELETE FROM processed_events
       WHERE event_type = 'gitlab-mr-discussion'
         AND task_id <> 'gitlab-mr-follow-up-one';
    `,
  },
  {
    version: 20,
    name: "filed-issues-to-work-subjects",
    up: `
      -- 'filed_issues' was 'work_subjects' for one feature: one open row per spec
      -- file, a signature for the version last acted on, the Jira key of what was
      -- produced. Every column has a home in the general table, so the rows move
      -- and the table goes — one substrate, one set of semantics, one place a bug
      -- in "have I already handled this" can live.
      --
      -- The keys are re-namespaced on the way. 'filed_issues' keys read
      -- '<project>:<file>' because the table only ever held spec files; a shared
      -- table needs the namespace every other loop already uses ('gitlab:mr:…',
      -- 'gitlab:mr-feedback:…'), so 'spec:' is prefixed here to match what
      -- 'subjectKeyOf' now produces. Without this the first post-migration poll
      -- would find no open subject for a file that has one and file a second
      -- ticket for every currently-broken test.
      --
      -- Closed rows come too. They are the audit trail, and they are also what
      -- 'history' reads; dropping them would make a refiled ticket look like the
      -- first one ever filed.
      INSERT INTO work_subjects
        (loop_id, subject_key, fingerprint, state, external_ref, external_url,
         metadata, first_seen_at, updated_at, last_seen_at, seen_count, closed_at)
      SELECT task_id,
             'spec:' || subject_key,
             signature,
             state,
             issue_key,
             issue_url,
             metadata,
             filed_at,
             updated_at,
             last_seen_at,
             seen_count,
             CASE WHEN state = 'closed' THEN updated_at ELSE NULL END
        FROM filed_issues
       ORDER BY id;

      DROP TABLE filed_issues;
    `,
  },
  {
    version: 21,
    name: "per-user-credentials",
    up: `
      -- Fifteen developers, one shared bot token: every MR comment and every
      -- filed ticket carried the same name, and the token needed write access to
      -- everything anyone might automate. A developer's own token is what a run
      -- for that developer should use, so tokens have to be storable per person —
      -- which means the database, because there are fifteen of them and they
      -- change independently.
      --
      -- The value is AES-256-GCM ciphertext (see secrets/crypto.ts), keyed from
      -- TALOS_SECRET_KEY, which lives only in the environment. A copied
      -- database file is then not a set of credentials.
      --
      -- No foreign key to auth_users: the two hardcoded accounts have no row
      -- there, and a constraint that rejects the admin account's own token would
      -- be enforcing a fiction.
      CREATE TABLE user_credentials (
        user_id    TEXT NOT NULL,
        -- One of ACTOR_SECRETS — GITLAB_TOKEN, JIRA_TOKEN, … — matching the name
        -- a task already asks ctx.secrets for, so nothing downstream changes.
        name       TEXT NOT NULL,
        value      TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, name)
      );

      -- Which developer a job was raised for, carried from the loop that
      -- discovered the work to the handler that does it. Without it, a review
      -- queued by Ana's loop would post its comment as whoever the worker pool
      -- happened to authenticate as — the shared bot — and the identity would be
      -- lost at exactly the point it becomes visible to the team.
      ALTER TABLE jobs ADD COLUMN actor_id TEXT;
    `,
  },
  {
    version: 22,
    name: "webhook-ingress",
    up: `
      -- Polling was the only clock: a comment asking the bot a question waited up
      -- to two minutes to be seen, and the sweep ran 720 times a day whether
      -- anything had happened or not. GitLab knows the moment it happens, so it
      -- can say so.
      --
      -- One endpoint per loop, with its own secret, rather than one global URL:
      -- revoking a project's access is then deleting a row, and a leaked secret
      -- can only trigger the loop it was issued for.
      CREATE TABLE webhook_endpoints (
        id               TEXT PRIMARY KEY,
        task_id          TEXT NOT NULL,
        -- SHA-256 of the token GitLab sends in X-Gitlab-Token. Hashed, not
        -- encrypted: nothing here ever needs the plaintext back, so there is no
        -- reason to keep something that could be stolen.
        secret_hash      TEXT NOT NULL,
        description      TEXT,
        enabled          INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL,
        created_by       TEXT,
        last_delivery_at TEXT,
        deliveries       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_webhook_endpoints_task ON webhook_endpoints (task_id);

      -- GitLab retries any delivery it did not get a 2xx for, so the same event
      -- arrives more than once. The event id as the primary key makes the second
      -- arrival a no-op that two processes cannot both win.
      CREATE TABLE webhook_deliveries (
        event_uuid  TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL,
        event_kind  TEXT NOT NULL,
        subject     TEXT,
        received_at TEXT NOT NULL,
        outcome     TEXT NOT NULL CHECK (outcome IN ('queued', 'ignored', 'duplicate'))
      );
      CREATE INDEX idx_webhook_deliveries_received ON webhook_deliveries (received_at);

      -- One row per loop, not per event. A single push produces a push hook, a
      -- pipeline hook and often a note hook; running the loop three times would
      -- find the same work twice. Collapsing them means a burst is one run, and a
      -- delivery that lands while the loop is already running stays here until it
      -- finishes rather than being dropped.
      CREATE TABLE webhook_triggers (
        task_id      TEXT PRIMARY KEY,
        requested_at TEXT NOT NULL,
        source       TEXT NOT NULL,
        events       INTEGER NOT NULL DEFAULT 1
      );
    `,
  },
  {
    version: 23,
    name: "drop-spawned-task-instances",
    up: `
      -- The rows the old design left behind. A loop used to create a *task
      -- instance* per merge request, so work that was over the moment it ran left
      -- a permanent row on the Tasks page — 23 of them in the database this was
      -- written against, one per MR ever polled. The queue holds that work now
      -- (see core/job.ts), and nothing will ever create another; these are the
      -- last of them.
      --
      -- Two shapes, two predicates, both narrow enough to be safe on a database
      -- where somebody also created instances by hand:
      --
      --   1. An instance of a *job handler*. A handler is not 'instantiable', so
      --      loadInstances already skips these rows — they are invisible dead
      --      weight, and no UI path can produce one.
      --   2. An unowned 'gitlab-code-review' instance whose stored schedule is
      --      present, disabled and manual — exactly what the spawner wrote. Every
      --      instance created through the API carries its creator's id, so a NULL
      --      owner means the spawner made it; requiring the row to be inert as
      --      well spares anything a human made before ownership existed and still
      --      uses. A *missing* schedule row is not evidence either way — an
      --      instance created without one has none — so it is left alone.
      --
      -- Runs go too. They are only ever listed per task (recentRuns(task.id)), so
      -- once the instance is gone nothing can reach them; steps and logs cascade.
      CREATE TEMP TABLE spawned_instances AS
        SELECT i.id
          FROM task_instances i
          LEFT JOIN scheduled_task_config c ON c.task_id = i.id
         WHERE i.definition_id IN (
                 'gitlab-review-one',
                 'gitlab-mr-follow-up-one',
                 'jira-ticket-to-mr-one'
               )
            OR (
                 i.definition_id = 'gitlab-code-review'
                 AND i.owner_id IS NULL
                 AND c.task_id IS NOT NULL
                 AND c.enabled = 0
                 AND c.trigger_type = 'manual'
               );

      DELETE FROM task_runs
       WHERE task_id IN (SELECT id FROM spawned_instances);

      -- The per-MR review ledger these instances kept. Keyed by task_id, so the
      -- rows are unreachable the moment the instance is; the surviving loop keeps
      -- its own under 'gitlab-review-requested'/'gitlab-review-one'.
      DELETE FROM reviewed_merge_requests
       WHERE task_id IN (SELECT id FROM spawned_instances);

      DELETE FROM scheduled_task_config
       WHERE task_id IN (SELECT id FROM spawned_instances);

      DELETE FROM task_instances
       WHERE id IN (SELECT id FROM spawned_instances);

      DROP TABLE spawned_instances;
    `,
  },
  {
    version: 24,
    name: "prompt-templates",
    up: `
      -- Operator overrides for the LLM prompts the agent tasks build
      -- (code-review, mr-follow-up, jira-ticket-to-mr). One row per prompt id;
      -- a missing row means "use the hardcoded default" — see
      -- config/resolve-prompts.ts. Deleting the row is how a prompt reverts.
      CREATE TABLE prompt_templates (
        id         TEXT PRIMARY KEY,
        template   TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 25,
    name: "notifications",
    up: `
      -- The Bell icon's backing store. Stored globally but filtered by user
      -- access at query time: users only see notifications for tasks they can
      -- access (public tasks or private tasks they own). The task_run_id links
      -- to task_runs.execution_id to determine access via the task's visibility.
      CREATE TABLE notifications (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        title       TEXT NOT NULL,
        body        TEXT,
        link        TEXT,
        task_run_id TEXT,
        created_at  TEXT NOT NULL,
        read_at     TEXT
      );
      CREATE INDEX idx_notifications_unread ON notifications (read_at, created_at DESC);
    `,
  },
  {
    version: 26,
    name: "per-loop-prompt-overrides",
    up: `
      -- Per-loop prompt template overrides. NULL means "use the global template
      -- for this definition_id" (from prompt_templates or the hardcoded default).
      -- Non-null means this specific loop instance has a custom prompt.
      ALTER TABLE task_instances ADD COLUMN prompt_template TEXT;
    `,
  },
  {
    version: 27,
    name: "task-run-details",
    up: `
      -- TaskResult.details (e.g. { action: 'no-change', mrUrl, summary } from
      -- jira-ticket-to-mr) used to be dropped on the floor — only reachable, if
      -- at all, by scraping a log line's own 'meta' blob. Without it, a run that
      -- decided nothing needed doing renders identically to one that opened a
      -- merge request, which is exactly the "where's my MR" confusion this
      -- column exists to end. JSON, like 'params'.
      ALTER TABLE task_runs ADD COLUMN details TEXT;
    `,
  },
  {
    version: 28,
    name: "notification-job-id",
    up: `
      -- Correlates a notification with the job it was raised for (e.g.
      -- "Review queued: !123"), so the worker pool can remove it once that job
      -- finishes instead of leaving a stale "queued" notice sitting in the Bell
      -- forever.
      ALTER TABLE notifications ADD COLUMN job_id TEXT;
      CREATE INDEX idx_notifications_job ON notifications (job_id);
    `,
  },
  {
    version: 29,
    name: "pull-request-repo-filter",
    up: `
      -- Which repositories a developer's Team MRs tab shows. Stored per-user
      -- rather than as one shared config: a person's team on GitLab is a
      -- superset of what any one of them reviews day to day, and the whole
      -- point is that each developer narrows it themselves. No rows for a
      -- user means "no filter" — everything their groups turn up — not
      -- "nothing", so a fresh account is not stuck reviewing zero MRs.
      CREATE TABLE user_pull_request_repos (
        user_id     TEXT NOT NULL,
        repository  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (user_id, repository)
      );
    `,
  },
  {
    version: 30,
    name: "auth-sessions",
    up: `
      -- Sessions used to live in a Map on the AuthService, which meant every
      -- server restart logged everyone out. In development the API runs under
      -- 'bun --watch', so saving any file bounced the developer back to the
      -- login screen mid-task; in production a deploy did the same to everyone.
      -- A session is cheap to store and the cookie already outlives the process,
      -- so the row should too.
      --
      -- Only the token is here, not a hash: it is a random UUID with no meaning
      -- outside this table, and the database is already the place where password
      -- hashes and encrypted tokens live.
      CREATE TABLE auth_sessions (
        token      TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX idx_auth_sessions_expires ON auth_sessions (expires_at);

      -- Password reset tokens, for the same reason: a restart between "email me
      -- a link" and clicking it made the link silently invalid.
      CREATE TABLE auth_reset_tokens (
        token      TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 31,
    name: "jobs-dedupe-key-history",
    up: `
      -- 'idx_jobs_dedupe' covers only queued and leased rows, because its job is
      -- enqueue idempotency. Two reads want the whole history of a key instead:
      -- 'deadFor' (the brake on a job that failed every attempt) and
      -- 'byDedupeKey', which backs the action pills on the pull request view. Both
      -- were full table scans over a table that grows with every job ever run.
      CREATE INDEX idx_jobs_dedupe_history
        ON jobs (dedupe_key, enqueued_at DESC);
    `,
  },
  {
    version: 32,
    name: "release-config",
    up: `
      -- Which repo/manifest/branch the Releases page reads and edits. One row
      -- for the whole instance (there is one 'example-org/releases' for the
      -- team), enforced by the CHECK — see application/ports.ts.
      CREATE TABLE release_config (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        project_id    TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
    `,
  },
  {
    version: 33,
    name: "fix-issue-defaults",
    up: `
      -- Where a "Fix this issue" click from the ticket graph opens its merge
      -- request. Per-user rather than instance-wide: a Jira ticket names no
      -- repository, and which repo a person's tickets land in is a fact about
      -- them, not about the team. No row means the button is disabled with a
      -- reason instead of guessing a repository to push a branch to.
      CREATE TABLE user_fix_issue_defaults (
        user_id       TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
    `,
  },
  {
    version: 34,
    name: "integration-config",
    up: `
      -- Instance-wide overrides for what used to be config/.env only: the GitLab
      -- token and API URL, the Jira site/account/token, the LogRocket API key.
      -- Editable from Settings -> Integrations, which is the whole point — until
      -- now changing a shared token meant a shell on the host and a restart.
      --
      -- Key/value rather than a column per setting, unlike general_config: the
      -- set of integrations grows, and 'add LogRocket' should not be a migration.
      -- Rows are keyed by the same environment variable name every connector
      -- already asks for, so nothing downstream has to know this table exists.
      --
      -- 'encrypted' rather than assuming: tokens are AES-GCM ciphertext under
      -- TALOS_SECRET_KEY, but a Jira site URL is not a secret and is stored
      -- plaintext, so it stays readable (and fixable) with no key configured.
      CREATE TABLE integration_config (
        name       TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        encrypted  INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 35,
    name: "logrocket-issues",
    up: `
      -- Frontend issues LogRocket told us about. LogRocket exposes no endpoint
      -- for listing issues or sessions, so this table is the list: every row is
      -- an Issue Alert delivered to /webhooks/logrocket/<secret>.
      --
      -- 'fingerprint' is what makes a re-alert on the same issue an update rather
      -- than a duplicate row -- LogRocket sends no id, so it is derived from the
      -- app, the issue type and the issue URL (see the store). session_count and
      -- last_seen_at then track the newest alert while first_seen_at keeps what
      -- the first one said.
      --
      -- 'payload' keeps the raw delivery: the alert shape is LogRocket's to
      -- change, and a field we do not model yet is still worth having when
      -- somebody asks why a ticket said what it said.
      CREATE TABLE logrocket_issues (
        id              TEXT PRIMARY KEY,
        fingerprint     TEXT NOT NULL UNIQUE,
        app_id          TEXT,
        issue_type      TEXT,
        title           TEXT NOT NULL,
        label           TEXT,
        description     TEXT,
        summary         TEXT,
        user_impact     TEXT,
        url             TEXT,
        screenshot_url  TEXT,
        session_count   INTEGER,
        session_rate    REAL,
        first_seen_at   TEXT,
        last_alert_at   TEXT NOT NULL,
        alert_count     INTEGER NOT NULL,
        payload         TEXT NOT NULL,
        -- 'open' until somebody files it; 'linked' once a Jira ticket exists;
        -- 'dismissed' when it is not worth one. No delete: an issue that alerts
        -- again after being dismissed would otherwise come back as new.
        state           TEXT NOT NULL DEFAULT 'open'
                          CHECK (state IN ('open', 'linked', 'dismissed')),
        jira_issue_key  TEXT,
        jira_filed_at   TEXT
      );

      CREATE INDEX idx_logrocket_issues_last_alert
        ON logrocket_issues (last_alert_at DESC);
    `,
  },
  {
    version: 36,
    name: "datadog-issues",
    up: `
      -- Problems found in Datadog logs, one row per (service, error shape).
      --
      -- Datadog has no id for these, which is the whole reason the table looks
      -- like this. Error Tracking would have supplied fingerprinted issues and
      -- indexes nothing for this org, so the daily scan aggregates error counts
      -- per service, samples log bodies, and clusters them by a normalised
      -- message signature (connectors/datadog/signature.ts). 'fingerprint' is
      -- sha256(service + signature): stable across scans, which is what turns
      -- tonight's re-sighting into an update instead of a duplicate.
      --
      -- 'event_count' is an estimate and named plainly rather than dressed up:
      -- the per-service total is exact, the split across shapes is extrapolated
      -- from 'sample_count' of 'sample_size' bodies. 'previous_event_count' is
      -- kept so the page can show a trend without a second table.
      --
      -- 'severity', 'area' and 'team' are ours, not Datadog's. There is no
      -- severity field on a log beyond its status and no team tag at all in this
      -- org, so both are computed at scan time from status, volume and the
      -- routing rules below -- and 'routed_by' records which rule decided, so a
      -- wrong owner is a rule to fix rather than an argument to have.
      CREATE TABLE datadog_issues (
        id                   TEXT PRIMARY KEY,
        fingerprint          TEXT NOT NULL UNIQUE,
        service              TEXT,
        signature            TEXT NOT NULL,
        title                TEXT NOT NULL,
        severity             TEXT NOT NULL
                               CHECK (severity IN ('critical', 'high', 'medium', 'low')),
        area                 TEXT NOT NULL
                               CHECK (area IN ('frontend', 'backend', 'infrastructure',
                                               'data', 'unknown')),
        team                 TEXT,
        routed_by            TEXT,
        event_count          INTEGER NOT NULL,
        previous_event_count INTEGER,
        sample_count         INTEGER NOT NULL,
        sample_size          INTEGER NOT NULL,
        status               TEXT,
        env                  TEXT,
        source               TEXT,
        host                 TEXT,
        kube_namespace       TEXT,
        sample_log_id        TEXT,
        sample_message       TEXT,
        sample_stack         TEXT,
        -- The log search that isolates this issue: the deep link on the page and
        -- in the ticket, and the one thing that lets somebody check our work.
        query                TEXT NOT NULL,
        first_seen_at        TEXT NOT NULL,
        last_seen_at         TEXT NOT NULL,
        last_scan_at         TEXT NOT NULL,
        scan_count           INTEGER NOT NULL DEFAULT 1,
        -- 'open' until a ticket exists, then 'linked'; 'dismissed' for something
        -- not worth one. A dismissed issue that recurs stays dismissed -- see the
        -- store -- or dismissal would mean nothing after one night.
        state                TEXT NOT NULL DEFAULT 'open'
                               CHECK (state IN ('open', 'linked', 'dismissed')),
        jira_issue_key       TEXT,
        jira_filed_at        TEXT
      );

      -- The page's default read: worst first, then loudest.
      CREATE INDEX idx_datadog_issues_triage
        ON datadog_issues (severity, event_count DESC);
      CREATE INDEX idx_datadog_issues_last_scan
        ON datadog_issues (last_scan_at DESC);

      -- How an issue gets an owner, and how noise gets dropped.
      --
      -- A table because neither can be derived: this org's logs carry no team
      -- tag, and which services are infrastructure churn rather than product
      -- bugs is a judgement that changes as the estate does. Constants in code
      -- would make both a deploy.
      CREATE TABLE datadog_routing_rules (
        id           TEXT PRIMARY KEY,
        priority     INTEGER NOT NULL,
        facet        TEXT NOT NULL
                       CHECK (facet IN ('service', 'source', 'kube_namespace',
                                        'env', 'host', 'signature')),
        pattern      TEXT NOT NULL,
        action       TEXT NOT NULL CHECK (action IN ('route', 'ignore')),
        team         TEXT,
        area         TEXT CHECK (area IS NULL OR area IN ('frontend', 'backend',
                                  'infrastructure', 'data', 'unknown')),
        jira_project TEXT,
        note         TEXT,
        updated_at   TEXT NOT NULL
      );

      CREATE INDEX idx_datadog_routing_priority
        ON datadog_routing_rules (priority);

      -- Seeded rather than hardcoded, so every one of these is visible in the UI
      -- and can be edited or deleted. They encode what the first scan of this
      -- estate showed: the loudest sources by a wide margin are the Kubernetes
      -- and CI platform, not anybody's product code.
      INSERT INTO datadog_routing_rules
        (id, priority, facet, pattern, action, team, area, note, updated_at)
      VALUES
        ('seed-ignore-agent', 10, 'service', 'agent', 'ignore', NULL, NULL,
         'The Datadog agent complaining about itself.', datetime('now')),
        ('seed-ignore-csi', 11, 'service', 'csi-*', 'ignore', NULL, NULL,
         'CSI driver churn: ~250k lines a day, no bug behind it.', datetime('now')),
        ('seed-ignore-kube-system', 12, 'kube_namespace', 'kube-system', 'ignore', NULL, NULL,
         'Cluster internals. Route it to a team if you own the cluster.', datetime('now')),
        ('seed-route-argocd', 20, 'service', 'argocd*', 'route', NULL, 'infrastructure',
         NULL, datetime('now')),
        ('seed-route-awx', 21, 'service', 'awx*', 'route', NULL, 'infrastructure',
         NULL, datetime('now')),
        ('seed-route-aws', 22, 'service', 'aws-*', 'route', NULL, 'infrastructure',
         NULL, datetime('now')),
        ('seed-route-k8s-cni', 23, 'service', 'amazon-k8s-*', 'route', NULL, 'infrastructure',
         NULL, datetime('now')),
        ('seed-route-browser', 30, 'source', 'browser', 'route', NULL, 'frontend',
         'Real-user browser logs.', datetime('now')),
        ('seed-route-nodejs', 31, 'source', 'nodejs', 'route', NULL, 'backend',
         NULL, datetime('now')),
        ('seed-route-tomcat', 32, 'source', 'tomcat', 'route', NULL, 'backend',
         NULL, datetime('now'));
    `,
  },
  {
    version: 37,
    name: "datadog-problems",
    up: `
      -- A second level of grouping above the signature: the root cause.
      --
      -- Signature clustering alone is not enough at this estate's scale, and the
      -- first real scan showed why. One failure emits several log lines from
      -- different frames of the same stack -- 'PublishAssetPreview._fo2png' and
      -- the 'java.lang.Error' that wraps it, or one FILE_READ fault reported by
      -- three classes across two services -- and each line clustered into its own
      -- row. Thirty-eight rows described about six problems.
      --
      -- So the scan now cross-references clusters (application/datadog-problems.ts)
      -- and stamps the ones that are one root cause with a shared 'problem_key'.
      -- The key is recomputed every scan and is not stable across them; it groups
      -- a scan's output, it does not identify anything. What survives a rescan is
      -- the Jira link, which is written to every member of a problem.
      --
      -- 'problem_event_count' is the problem's own estimate, and it is the MAX of
      -- its members rather than their sum: three log lines from one failure are
      -- one occurrence counted three times, and adding them would inflate the
      -- number by exactly the amount this grouping exists to remove.
      ALTER TABLE datadog_issues ADD COLUMN problem_key TEXT;
      ALTER TABLE datadog_issues ADD COLUMN problem_title TEXT;
      ALTER TABLE datadog_issues ADD COLUMN problem_event_count INTEGER;

      CREATE INDEX idx_datadog_issues_problem
        ON datadog_issues (problem_key);

      -- Signature normalisation was tightened in the same change (generated
      -- filenames, short hex ids, nested-exception tails), so every stored
      -- fingerprint computed under the old rules now describes a cluster the scan
      -- will never produce again: the row would sit on the page forever, never
      -- re-sighted and never updated. Rows a person has acted on are kept anyway
      -- -- a stale row is a smaller loss than a dropped ticket or an undone
      -- dismissal -- and everything else is re-derived by the next scan.
      DELETE FROM datadog_issues
        WHERE jira_issue_key IS NULL AND state = 'open';
    `,
  },
  {
    version: 38,
    name: "feedback",
    up: `
      -- Free-form feedback submitted from the footer link. No status/response
      -- workflow yet -- this is a mailbox, not a ticket system -- so it's just an
      -- append-only log of who said what and when.
      CREATE TABLE feedback (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        message    TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 39,
    name: "task-run-mr-keys",
    up: `
      -- Which merge request a run was about, so a pull request page can ask
      -- "everything that ran against this MR". Previously impossible: runs are
      -- queryable only by task_id/execution_id, and the job queue's MR-keyed
      -- lookup (manualActionHistory) matches the 'manual:' dedupe key only, so
      -- a job the follow-up or review-requested loop queued for the same MR was
      -- invisible to it.
      --
      -- NULL for a loop's discoverer run, which scans many MRs or none. Only a
      -- run whose params name a single MR gets these filled in.
      --
      -- Existing rows are filled in by the next migration, not here, because
      -- this one had already shipped by the time that was worth doing.
      --
      -- NB: allowCancelledRunStatus() rebuilds task_runs with INSERT..SELECT.
      -- It has already run everywhere, so it is not updated -- but any future
      -- rebuild of this table has to carry these two columns across.
      ALTER TABLE task_runs ADD COLUMN project_id TEXT;
      ALTER TABLE task_runs ADD COLUMN mr_iid INTEGER;

      CREATE INDEX idx_task_runs_mr
        ON task_runs (project_id, mr_iid, started_at DESC);
    `,
  },
  {
    version: 40,
    name: "task-run-mr-keys-backfill",
    up: `
      -- Fills in the columns the previous migration added, so a merge request's
      -- run history starts populated rather than from the next click onwards.
      --
      -- Read out of 'params', not 'details': params is written when the run
      -- opens and carries the whole { projectId, mrIid } block, so this is an
      -- exact copy of what the task was told to work on. ('details' was the
      -- obvious candidate and is the wrong one -- it has mrIid but no project,
      -- which would have meant guessing.)
      --
      -- A run whose params name no merge request -- every loop discoverer --
      -- keeps both columns NULL, which is what the WHERE clause preserves.
      UPDATE task_runs
         SET project_id = json_extract(params, '$.gitlab.projectId'),
             mr_iid     = json_extract(params, '$.gitlab.mrIid')
       WHERE project_id IS NULL
         AND params IS NOT NULL
         AND json_valid(params)
         AND json_extract(params, '$.gitlab.projectId') IS NOT NULL
         AND json_extract(params, '$.gitlab.mrIid') IS NOT NULL;
    `,
  },
  {
    version: 41,
    name: "spec-history",
    up: `
      -- Per-spec-file pass/fail history, so gitlab-ci-failure can tell a flake
      -- from a regression instead of filing a ticket the first time anything
      -- goes red. On a nightly suite the flakes outnumber the regressions, and a
      -- board full of them is a board nobody reads.
      --
      -- Two tables rather than one, because of what the trace can and cannot
      -- say. A job log names the specs that FAILED and nothing else -- there are
      -- no per-test pass records anywhere (see connectors/gitlab/trace-format.ts,
      -- and GitLab's test_report endpoint is not wrapped). But a *green*
      -- pipeline proves every spec passed, and in a failed one the specs absent
      -- from the FAIL lines passed. So a pass is stored as the ABSENCE of a
      -- failure row against an observed pipeline. A single table would instead
      -- need one row per (spec x pipeline) and therefore an inventory of every
      -- spec in the repo, which we have no way to obtain.
      --
      -- 'outcome' is what makes that inference safe. A pipeline that died for a
      -- non-test reason -- runner failure, a job that never started, a trace no
      -- runner was recognised in -- proves nothing about any spec, and counting
      -- it as "everything passed" would reset a regression's streak and silently
      -- downgrade it to a flake. Those are recorded 'inconclusive' and every
      -- history window skips them.
      CREATE TABLE ci_pipeline_runs (
        id           INTEGER PRIMARY KEY,
        project      TEXT NOT NULL,
        pipeline_id  INTEGER NOT NULL,
        sha          TEXT,
        ref          TEXT,
        -- GitLab's own status, kept verbatim for the page; 'outcome' is ours.
        status       TEXT,
        outcome      TEXT NOT NULL
                       CHECK (outcome IN ('green', 'failures', 'inconclusive')),
        specs_failed INTEGER NOT NULL DEFAULT 0,
        finished_at  TEXT NOT NULL,
        observed_at  TEXT NOT NULL,
        UNIQUE (project, pipeline_id)
      );

      -- The window read: newest conclusive pipelines for a project.
      CREATE INDEX idx_ci_pipeline_runs_window
        ON ci_pipeline_runs (project, finished_at DESC);

      CREATE TABLE ci_spec_failures (
        id                  INTEGER PRIMARY KEY,
        project             TEXT NOT NULL,
        spec_file           TEXT NOT NULL,
        pipeline_id         INTEGER NOT NULL,
        -- The same sorted-test-name signature the ticket's fingerprint uses
        -- (tasks/ci-failure/group.ts), so a history row can be compared with
        -- what the open ticket records without re-parsing anything.
        signature           TEXT NOT NULL,
        suite_failed_to_run INTEGER NOT NULL DEFAULT 0,
        tests_json          TEXT,
        -- Denormalised from the pipeline so the flaky-spec list can order and
        -- window without a join, and so a pruned pipeline row cannot silently
        -- change a spec's history.
        finished_at         TEXT NOT NULL,
        observed_at         TEXT NOT NULL,
        UNIQUE (project, spec_file, pipeline_id)
      );

      CREATE INDEX idx_ci_spec_failures_history
        ON ci_spec_failures (project, spec_file, finished_at DESC);

      -- A person's decisions about a spec, kept out of the append-only history
      -- above so that replaying or pruning observations cannot undo them.
      CREATE TABLE ci_spec_flags (
        project                 TEXT NOT NULL,
        spec_file               TEXT NOT NULL,
        state                   TEXT NOT NULL DEFAULT 'open'
                                  CHECK (state IN ('open', 'dismissed')),
        dismissed_at            TEXT,
        -- When the flake rate first crossed the quarantine threshold, so the
        -- suggestion can say how long this has been true rather than implying it
        -- started today.
        quarantine_suggested_at TEXT,
        updated_at              TEXT NOT NULL,
        PRIMARY KEY (project, spec_file)
      );
    `,
  },
  {
    version: 42,
    name: "spec-force-file",
    up: `
      -- "File a ticket anyway", from the Flaky specs page: an operator
      -- overriding the verdict for one spec. Recorded rather than acted on
      -- immediately, because the ticket worth having is the one the loop builds
      -- -- with the trace excerpt and the label the duplicate check needs -- so
      -- the flag is a request the loop honours on its next pass and then clears.
      --
      -- Its own version rather than a column on 41: 41 had already been applied
      -- to a running database by the time this was needed, and an applied
      -- migration is never edited.
      ALTER TABLE ci_spec_flags
        ADD COLUMN force_file INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 43,
    name: "regression-tests",
    up: `
      -- Production error -> the test that covers it. The one link nothing else
      -- records: an error row can name the Jira ticket it was filed as, and the
      -- ticket's merge request is findable by a person reading Jira, but the chain
      -- from "this error" to "the branch that covers it" existed nowhere.
      --
      -- Keyed on issue_id, and fingerprint kept alongside it, deliberately not on
      -- problem_key: a problem key is recomputed from member signatures on every
      -- scan (see application/datadog-problems.ts), so a row keyed on it would
      -- lose its link the first time the grouping shifted.
      --
      -- 'verdict' is the reason the table is worth having rather than a boolean.
      -- 'reproduced' is a test that fails against current head -- a live bug, and
      -- a draft merge request, because merging a red test stops everybody's
      -- pipeline. 'already-fixed' is a test that passes -- a guard against
      -- regression, mergeable as normal. 'not-reachable' is the agent saying it
      -- could not tie the error to a code path, which opens nothing at all: a test
      -- written to pass against code nobody identified is worse than no test, and
      -- recording the attempt is what stops the button being clicked forever.
      CREATE TABLE regression_tests (
        id          TEXT PRIMARY KEY,
        source      TEXT NOT NULL CHECK (source IN ('datadog', 'logrocket')),
        issue_id    TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        verdict     TEXT NOT NULL
                      CHECK (verdict IN ('reproduced', 'already-fixed', 'not-reachable')),
        summary     TEXT,
        how_verified TEXT,
        test_file   TEXT,
        mr_iid      INTEGER,
        mr_url      TEXT,
        branch      TEXT,
        task_run_id TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        -- One attempt per issue: the row answers "has anybody already tried this?",
        -- and a re-run overwrites, which is what makes clicking again after a
        -- 'not-reachable' verdict useful rather than additive.
        UNIQUE (source, issue_id)
      );

      -- The fingerprint outlives the issue row: datadog_issues prunes after seven
      -- unseen days, and a re-sighting arrives as a new id with the same
      -- fingerprint, which is how an old attempt is still found.
      CREATE INDEX idx_regression_tests_fingerprint
        ON regression_tests (fingerprint);
    `,
  },
  {
    version: 44,
    name: "deploy-watches",
    up: `
      -- Answers "did last night's prod release break something" without a human
      -- noticing days later. One row per production release merge request,
      -- opened the moment the upload happens and progressed by the deploy-watch
      -- job as the MR merges and the watch window runs.
      --
      -- baseline_fingerprints_json holds the signature set sampled from *before*
      -- the merge, deliberately not datadog_issues: that table folds on
      -- resighting, keeps only one previous_event_count, and prunes after seven
      -- unseen days -- none of which is what a point-in-time snapshot needs.
      CREATE TABLE deploy_watches (
        id            TEXT PRIMARY KEY,
        environment   TEXT NOT NULL,
        project_id    TEXT NOT NULL,
        mr_iid        INTEGER NOT NULL,
        mr_url        TEXT NOT NULL,
        branch        TEXT NOT NULL,
        actor_id      TEXT,
        services_json TEXT NOT NULL,
        state         TEXT NOT NULL DEFAULT 'pending-merge'
                        CHECK (state IN ('pending-merge', 'watching', 'done', 'abandoned')),
        opened_at     TEXT NOT NULL,
        merged_at     TEXT,
        baseline_at   TEXT,
        baseline_fingerprints_json TEXT,
        watch_until   TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_deploy_watches_project_mr ON deploy_watches (project_id, mr_iid);
      CREATE INDEX idx_deploy_watches_state ON deploy_watches (state);

      -- One row per signature the watcher saw after the merge that was not in the
      -- baseline. Unique on (watch_id, fingerprint) so a re-check within the same
      -- watch window records a signature once and Slack hears about it once.
      CREATE TABLE deploy_watch_findings (
        id             TEXT PRIMARY KEY,
        watch_id       TEXT NOT NULL REFERENCES deploy_watches (id),
        service        TEXT,
        signature      TEXT NOT NULL,
        fingerprint    TEXT NOT NULL,
        event_count    INTEGER NOT NULL,
        sample_message TEXT,
        sample_stack   TEXT,
        first_seen_at  TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        UNIQUE (watch_id, fingerprint)
      );
      CREATE INDEX idx_deploy_watch_findings_watch ON deploy_watch_findings (watch_id);
    `,
  },
  {
    version: 45,
    name: "test-run-history",
    up: `
      -- Generalises the per-spec-file pass/fail history from 'spec-history'
      -- (migration 41) so it is no longer GitLab-CI-shaped. 'gitlab-ci-failure'
      -- was the only thing that could ever write here -- 'pipeline_id' as a
      -- column name, an INTEGER type that assumes a GitLab pipeline number -- so
      -- a second producer (a backend unit test runner, say) had nowhere to put
      -- its results without either lying about what a 'pipeline' is or forking
      -- the schema. 'source' plus a free-form 'run_id' (TEXT: a pipeline number,
      -- a build id, a commit sha -- whatever the producer's own system uses) is
      -- what makes this a shared table rather than a GitLab-CI table two
      -- producers happen to share.
      --
      -- Same pass-by-absence design as before, unchanged: a producer reports
      -- the tests that FAILED in a run, and a pass is inferred from a run
      -- observed with no failure row for that test. See migration 41 for why.
      CREATE TABLE test_runs (
        id          INTEGER PRIMARY KEY,
        -- Which producer wrote this row, e.g. 'gitlab-ci-failure'. Free-form
        -- rather than a CHECK enum on purpose: a new producer must not need a
        -- migration just to name itself.
        source      TEXT NOT NULL,
        project     TEXT NOT NULL,
        run_id      TEXT NOT NULL,
        sha         TEXT,
        ref         TEXT,
        -- The producer's own status string, kept verbatim; 'outcome' is ours.
        status      TEXT,
        outcome     TEXT NOT NULL
                      CHECK (outcome IN ('green', 'failures', 'inconclusive')),
        tests_failed INTEGER NOT NULL DEFAULT 0,
        finished_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        UNIQUE (source, project, run_id)
      );
      CREATE INDEX idx_test_runs_window
        ON test_runs (source, project, finished_at DESC);

      CREATE TABLE test_run_failures (
        id                  INTEGER PRIMARY KEY,
        source              TEXT NOT NULL,
        project             TEXT NOT NULL,
        -- A spec file path for gitlab-ci-failure; a test class or method name is
        -- just as valid for a future producer. The generic identity is "whatever
        -- this producer calls one test", not "a file".
        test_id             TEXT NOT NULL,
        run_id              TEXT NOT NULL,
        signature           TEXT NOT NULL,
        suite_failed_to_run INTEGER NOT NULL DEFAULT 0,
        tests_json          TEXT,
        finished_at         TEXT NOT NULL,
        observed_at         TEXT NOT NULL,
        UNIQUE (source, project, test_id, run_id)
      );
      CREATE INDEX idx_test_run_failures_window
        ON test_run_failures (source, project, test_id, finished_at DESC);

      CREATE TABLE test_flake_flags (
        source                  TEXT NOT NULL,
        project                 TEXT NOT NULL,
        test_id                 TEXT NOT NULL,
        state                   TEXT NOT NULL DEFAULT 'open'
                                  CHECK (state IN ('open', 'dismissed')),
        dismissed_at            TEXT,
        quarantine_suggested_at TEXT,
        force_file              INTEGER NOT NULL DEFAULT 0,
        updated_at              TEXT NOT NULL,
        PRIMARY KEY (source, project, test_id)
      );

      -- Carried over rather than dropped: this is real flake history a running
      -- install has already collected, and losing it would cost the classifier
      -- several nights of judgement it already had. Every row is attributed to
      -- 'gitlab-ci-failure', the only producer that has ever existed.
      INSERT INTO test_runs
        (source, project, run_id, sha, ref, status, outcome, tests_failed, finished_at, observed_at)
      SELECT 'gitlab-ci-failure', project, CAST(pipeline_id AS TEXT), sha, ref, status,
             outcome, specs_failed, finished_at, observed_at
        FROM ci_pipeline_runs;

      INSERT INTO test_run_failures
        (source, project, test_id, run_id, signature, suite_failed_to_run, tests_json, finished_at, observed_at)
      SELECT 'gitlab-ci-failure', project, spec_file, CAST(pipeline_id AS TEXT), signature,
             suite_failed_to_run, tests_json, finished_at, observed_at
        FROM ci_spec_failures;

      INSERT INTO test_flake_flags
        (source, project, test_id, state, dismissed_at, quarantine_suggested_at, force_file, updated_at)
      SELECT 'gitlab-ci-failure', project, spec_file, state, dismissed_at,
             quarantine_suggested_at, force_file, updated_at
        FROM ci_spec_flags;

      DROP TABLE ci_spec_failures;
      DROP TABLE ci_pipeline_runs;
      DROP TABLE ci_spec_flags;
    `,
  },
  {
    version: 46,
    name: "user-preferences",
    up: `
      -- How one developer has set the console up for themselves: which sprint the
      -- ticket graph opens on, which merge request states the list shows, which
      -- release environments they pinned.
      --
      -- These lived in localStorage, which was right until it wasn't: a preference
      -- kept in the browser does not follow you from the laptop to the desktop, and
      -- clearing site data resets how you work. The browser is still the fast path
      -- (see the client's preference cache) -- this table is what makes it the same
      -- console on the second machine.
      --
      -- Key/value rather than a column per setting, for the reason migration 34
      -- gives for integration_config: the set of preferences grows with every page,
      -- and 'the graph remembers its label filter' should not be a migration.
      --
      -- The value is JSON and this table does not care what shape: the client that
      -- owns a key is the only thing that can validate it, and it already has to --
      -- a row written by last month's release outlives the code that wrote it.
      -- Unparseable or unknown values fall back to that page's defaults rather than
      -- failing, exactly as the localStorage versions did.
      --
      -- Deliberately NOT everything the browser remembers. Sidebar state and pane
      -- widths stay in localStorage: a 340px pane is right on a laptop and wrong on
      -- a 27-inch monitor, so syncing those across devices is worse than not.
      CREATE TABLE user_preferences (
        user_id    TEXT NOT NULL,
        -- Namespaced by page, e.g. 'graph.filters', 'pull-requests.states'.
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      );
    `,
  },
  {
    version: 47,
    name: "agent-accounts",
    up: `
      -- The AI agent accounts one developer has connected: their ChatGPT plan,
      -- their Claude subscription, an OpenAI API key they pay for themselves.
      --
      -- Separate from user_credentials, which is name/value keyed by name and so
      -- can hold exactly one OPENAI_API_KEY per person with nothing to say about
      -- it. An agent account needs a label ("work ChatGPT"), a method, and the
      -- ability to exist twice for one provider -- somebody with a personal and a
      -- work plan is the normal case, not an edge one.
      --
      -- Two shapes share the table, told apart by 'method':
      --   'key' rows hold the values the option asked for, encrypted together in
      --         'secret' as a JSON name/value map, and injected into a run as
      --         environment variables. A map rather than one value because an
      --         option can need several -- Claude through Bedrock wants a region
      --         and a key, not just a token.
      --   'cli' rows hold no credential at all. The vendor's own CLI minted one
      --         during login and keeps it under 'home_dir' -- talos points the
      --         run at that directory rather than handling the token, which is the
      --         same trade run.ts already makes with the operator's ~/.claude.
      --
      -- No foreign key to users: the auth tables predate this one and the rest of
      -- the per-user tables (user_preferences, user_credentials) don't declare one
      -- either. Deleting a user is not a thing the product does.
      CREATE TABLE agent_accounts (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        -- 'claude' | 'cursor' | 'codex' | 'copilot'. Not a CHECK constraint: the
        -- catalog gains vendors faster than the schema should, and an unknown
        -- provider read back is dropped by the API rather than crashing it.
        provider   TEXT NOT NULL,
        label      TEXT NOT NULL,
        method     TEXT NOT NULL CHECK (method IN ('key', 'cli')),
        -- Which catalog option produced the row, e.g. 'claude:key-oauth'. Kept
        -- because a provider has several 'key' options that are not
        -- interchangeable: an API key bills a different account than a
        -- subscription token, and the card has to say which one this is.
        option_id  TEXT NOT NULL,
        -- The variable names 'secret' holds, comma-separated and in the clear, so
        -- showing which values an account was given never needs the encryption
        -- key. NULL for 'cli' rows, which set none.
        env_name   TEXT,
        secret     TEXT,
        home_dir   TEXT,
        -- The identity the vendor reported, when it reported one. A label, not an
        -- authorisation input.
        account    TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        -- One name per person per provider, so the picker can never show two
        -- identical rows and 'reconnect' overwrites rather than duplicates.
        UNIQUE (user_id, provider, label)
      );

      CREATE INDEX idx_agent_accounts_user ON agent_accounts (user_id, provider);
    `,
  },
  {
    version: 48,
    name: "agent-account-runtime",
    up: `
      -- Which of one developer's connected accounts their agent runs use, per
      -- provider.
      --
      -- Without this the table was a list of credentials nobody consumed: every
      -- Claude container got the operator's own ~/.claude mounted read-only and
      -- an account pasted in the console changed nothing. This is the flag
      -- runAgentJob resolves (see setAgentRuntimeAuth), and the reason a team
      -- running Claude through Bedrock can point talos at their own AWS
      -- account by typing a key into a dialog instead of editing files on the
      -- host.
      --
      -- Scoped to (user_id, provider), not install-wide. A run always has an
      -- actor -- whoever clicked Run, or the owner of the loop that ticked -- so
      -- there is always somebody to bill, and each developer's work goes through
      -- the agent they connected. It is the same resolution ctx.secrets already
      -- does for GITLAB_TOKEN (see actorIdentitySecretStore), applied to the thing that
      -- costs money. Loops that belong to the install rather than to a person are
      -- expressed by owning them with a dedicated system user and connecting an
      -- account for it, which is a row here like any other -- not by a global
      -- setting that would quietly bill one person for everyone's runs.
      --
      -- Not a UNIQUE index on (user_id, provider) WHERE use_for_runs: enforced
      -- in the store instead, because promoting a different account has to clear
      -- the old flag and set the new one, and a partial unique index only turns
      -- that ordering bug into a constraint error at 3am.
      ALTER TABLE agent_accounts ADD COLUMN use_for_runs INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 49,
    name: "email-verification",
    up: `
      -- When this address was confirmed, or NULL for "not yet". Settings ->
      -- Profile is what shows it, and what asks for a link.
      --
      -- There is no SMTP in a self-hosted talos, so verification works the way
      -- password reset already does: the link goes to the server log for whoever
      -- runs 'serve'. That makes the flag mean something narrower than it does on
      -- a hosted product -- "somebody with access to the server log opened this
      -- link" rather than "this mailbox answered" -- which is the honest ceiling
      -- for an install with no way to send mail. Nothing gates on it; it is a fact
      -- about the account, not a permission.
      ALTER TABLE auth_users ADD COLUMN email_verified_at TEXT;

      -- Single-use, one hour, deleted on consumption -- the same shape as
      -- auth_reset_tokens, and separate from it so a leaked verification link
      -- cannot be redeemed for a password change.
      CREATE TABLE auth_verification_tokens (
        token      TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 50,
    name: "job-lease-fencing",
    up: `
      -- A fresh token is written whenever a worker leases a job. It fences late
      -- callbacks from a lease that has expired and been reassigned: checking
      -- status alone cannot distinguish the old worker from the new one.
      ALTER TABLE jobs ADD COLUMN lease_token TEXT;
    `,
  },
  {
    version: 51,
    name: "daemon-ownership",
    up: `
      CREATE TABLE daemon_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        owner TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 52,
    name: "configuration-revision",
    up: `
      CREATE TABLE configuration_revision (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO configuration_revision (singleton, revision) VALUES (1, 0);

      CREATE TRIGGER task_instances_revision_insert AFTER INSERT ON task_instances
        BEGIN UPDATE configuration_revision SET revision = revision + 1 WHERE singleton = 1; END;
      CREATE TRIGGER task_instances_revision_update AFTER UPDATE ON task_instances
        BEGIN UPDATE configuration_revision SET revision = revision + 1 WHERE singleton = 1; END;
      CREATE TRIGGER task_instances_revision_delete AFTER DELETE ON task_instances
        BEGIN UPDATE configuration_revision SET revision = revision + 1 WHERE singleton = 1; END;
      CREATE TRIGGER schedule_revision_insert AFTER INSERT ON scheduled_task_config
        BEGIN UPDATE configuration_revision SET revision = revision + 1 WHERE singleton = 1; END;
      CREATE TRIGGER schedule_revision_update AFTER UPDATE ON scheduled_task_config
        BEGIN UPDATE configuration_revision SET revision = revision + 1 WHERE singleton = 1; END;
      CREATE TRIGGER schedule_revision_delete AFTER DELETE ON scheduled_task_config
        BEGIN UPDATE configuration_revision SET revision = revision + 1 WHERE singleton = 1; END;
      CREATE TRIGGER general_config_revision_insert AFTER INSERT ON general_config
        BEGIN UPDATE configuration_revision SET revision = revision + 1 WHERE singleton = 1; END;
      CREATE TRIGGER general_config_revision_update AFTER UPDATE ON general_config
        BEGIN UPDATE configuration_revision SET revision = revision + 1 WHERE singleton = 1; END;
      CREATE TRIGGER general_config_revision_delete AFTER DELETE ON general_config
        BEGIN UPDATE configuration_revision SET revision = revision + 1 WHERE singleton = 1; END;
      CREATE TRIGGER prompts_revision_insert AFTER INSERT ON prompt_templates
        BEGIN UPDATE configuration_revision SET revision = revision + 1 WHERE singleton = 1; END;
      CREATE TRIGGER prompts_revision_update AFTER UPDATE ON prompt_templates
        BEGIN UPDATE configuration_revision SET revision = revision + 1 WHERE singleton = 1; END;
      CREATE TRIGGER prompts_revision_delete AFTER DELETE ON prompt_templates
        BEGIN UPDATE configuration_revision SET revision = revision + 1 WHERE singleton = 1; END;
    `,
  },
  {
    version: 53,
    name: "job-lease-order-index",
    up: `
      -- Matches the lease query's global priority/ready/FIFO ordering. The
      -- previous status+available index filtered well but required a temporary
      -- B-tree because priority was ordered after the availability range.
      CREATE INDEX idx_jobs_lease_order
        ON jobs (priority DESC, available_at ASC, enqueued_at ASC)
        WHERE status = 'queued';
    `,
  },
  {
    version: 54,
    name: "lifetime-run-statistics",
    up: `
      CREATE TABLE task_run_statistics (
        task_id TEXT PRIMARY KEY,
        total INTEGER NOT NULL DEFAULT 0,
        successes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        duration_total INTEGER NOT NULL DEFAULT 0,
        duration_count INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO task_run_statistics
        (task_id, total, successes, failures, duration_total, duration_count)
      SELECT task_id, COUNT(*),
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END),
             SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END),
             COALESCE(SUM(duration_ms), 0),
             SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END)
        FROM task_runs GROUP BY task_id;

      CREATE TRIGGER task_run_statistics_insert AFTER INSERT ON task_runs
      BEGIN
        INSERT INTO task_run_statistics
          (task_id, total, successes, failures, duration_total, duration_count)
        VALUES (
          NEW.task_id, 1,
          CASE WHEN NEW.status = 'success' THEN 1 ELSE 0 END,
          CASE WHEN NEW.status = 'failure' THEN 1 ELSE 0 END,
          COALESCE(NEW.duration_ms, 0), CASE WHEN NEW.duration_ms IS NULL THEN 0 ELSE 1 END
        ) ON CONFLICT(task_id) DO UPDATE SET
          total = total + 1,
          successes = successes + excluded.successes,
          failures = failures + excluded.failures,
          duration_total = duration_total + excluded.duration_total,
          duration_count = duration_count + excluded.duration_count;
      END;

      CREATE TRIGGER task_run_statistics_finish
      AFTER UPDATE OF status ON task_runs
      WHEN OLD.status = 'running' AND NEW.status <> 'running'
      BEGIN
        UPDATE task_run_statistics SET
          successes = successes + CASE WHEN NEW.status = 'success' THEN 1 ELSE 0 END,
          failures = failures + CASE WHEN NEW.status = 'failure' THEN 1 ELSE 0 END,
          duration_total = duration_total + COALESCE(NEW.duration_ms, 0),
          duration_count = duration_count + CASE WHEN NEW.duration_ms IS NULL THEN 0 ELSE 1 END
        WHERE task_id = NEW.task_id;
      END;
    `,
  },
  {
    version: 55,
    name: "execution-resources",
    up: `
      CREATE TABLE execution_resources (
        execution_id TEXT NOT NULL REFERENCES task_runs(execution_id) ON DELETE CASCADE,
        resource_kind TEXT NOT NULL CHECK (resource_kind IN ('ticket', 'merge-request')),
        resource_key TEXT NOT NULL,
        provenance TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (execution_id, resource_kind, resource_key)
      );
      CREATE INDEX idx_execution_resources_lookup
        ON execution_resources (resource_kind, resource_key, execution_id);

      -- Existing handler details are already structured evidence. Preserve their
      -- origin as backfill so later explicit writes remain distinguishable.
      INSERT OR IGNORE INTO execution_resources
        (execution_id, resource_kind, resource_key, provenance, created_at)
      SELECT execution_id, 'ticket', json_extract(details, '$.issueKey'),
             'backfill-details', started_at
        FROM task_runs
       WHERE json_valid(details)
         AND typeof(json_extract(details, '$.issueKey')) = 'text'
         AND json_extract(details, '$.issueKey') <> '';
      INSERT OR IGNORE INTO execution_resources
        (execution_id, resource_kind, resource_key, provenance, created_at)
      SELECT execution_id, 'merge-request', json_extract(details, '$.mrUrl'),
             'backfill-details', started_at
        FROM task_runs
       WHERE json_valid(details)
         AND typeof(json_extract(details, '$.mrUrl')) = 'text'
         AND json_extract(details, '$.mrUrl') <> '';
    `,
  },
  {
    version: 56,
    name: "agent-host-permits",
    up: `
      CREATE TABLE agent_host_permits (
        slot INTEGER PRIMARY KEY,
        owner TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX idx_agent_host_permits_expiry ON agent_host_permits (expires_at);
    `,
  },
  {
    version: 57,
    name: "job-parent-invocation",
    up: `
      ALTER TABLE jobs ADD COLUMN parent_execution_id TEXT
        REFERENCES task_runs(execution_id) ON DELETE SET NULL;
      CREATE INDEX idx_jobs_parent ON jobs (parent_execution_id, status, enqueued_at);
    `,
  },
  {
    version: 58,
    name: "plans",
    /*
     * An implementation plan a human approves before an agent writes any code.
     *
     * The whole lifecycle lives in `status` here rather than in `jobs.status` or
     * `task_runs.status`: both of those are CHECK-constrained, SQLite cannot ALTER
     * a CHECK, and adding one value to either means rebuilding the table with
     * foreign keys off (see `allowCancelledRunStatus` below for what that costs)
     * plus a ripple through the worker pool and every view that switches on them.
     * A plan awaiting a human is not a job state anyway — the job that produced it
     * finished cleanly, and its container is long gone.
     *
     * `draft_body` and `approved_body` are separate columns on purpose. The draft
     * is what the agent wrote and is never mutated; the approved body is what the
     * human signed off, and is the only text ever mounted into the implementing
     * container. Keeping both is what makes "did somebody edit this plan, and how"
     * answerable after the merge request exists.
     */
    up: `
      CREATE TABLE plans (
        id                 TEXT PRIMARY KEY,
        issue_key          TEXT NOT NULL,
        project_id         TEXT NOT NULL,
        target_branch      TEXT NOT NULL,
        status             TEXT NOT NULL
                           CHECK (status IN ('awaiting-review', 'approved', 'rejected',
                                             'superseded', 'implemented')),
        draft_body         TEXT NOT NULL,
        approved_body      TEXT,
        summary            TEXT,
        -- Jira's own \`updated\` for the issue this was planned from, via
        -- \`ticketFingerprint\`. A plan whose ticket has since been rewritten is
        -- reasoning about text that no longer exists, so approval is refused.
        ticket_fingerprint TEXT,
        -- The base branch head when the plan was written. Absent when GitLab did
        -- not report it (\`BranchSchema.commit\` is optional), which only costs the
        -- advisory drift warning.
        base_sha           TEXT,
        plan_run_id        TEXT REFERENCES task_runs(execution_id) ON DELETE SET NULL,
        implement_job_id   TEXT,
        requested_by       TEXT,
        reviewer_id        TEXT,
        review_note        TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      -- One open plan per ticket, scoped to the reviewable state the same way the
      -- job queue scopes its dedupe index to in-flight rows: a second plan while
      -- one awaits review is refused, but planning again after the last one was
      -- approved or rejected is genuinely new work.
      CREATE UNIQUE INDEX idx_plans_open_per_issue
        ON plans (issue_key) WHERE status = 'awaiting-review';
      CREATE INDEX idx_plans_review_queue ON plans (status, created_at DESC);
      CREATE INDEX idx_plans_issue ON plans (issue_key, created_at DESC);
    `,
  },
  {
    version: 59,
    name: "deploy-watch-logrocket",
    up: `
      -- Findings from both observability sources share the release timeline,
      -- while source-specific metadata keeps each one actionable.
      ALTER TABLE deploy_watch_findings ADD COLUMN source TEXT NOT NULL DEFAULT 'datadog'
        CHECK (source IN ('datadog', 'logrocket'));
      ALTER TABLE deploy_watch_findings ADD COLUMN external_url TEXT;
      ALTER TABLE deploy_watch_findings ADD COLUMN issue_type TEXT;

      -- The LogRocket watcher asks for issues first seen inside a release's
      -- six-hour window. Triage state and later re-alerts do not affect this.
      CREATE INDEX idx_logrocket_issues_first_seen
        ON logrocket_issues (first_seen_at);
    `,
  },
  {
    version: 60,
    name: "deploy-watch-release-references",
    up: `
      -- A release discovered on the target branch may have an associated MR or
      -- may be a direct push. Rebuild both parent and child so the old MR-only
      -- NOT NULL columns can become an honest tagged union.
      ALTER TABLE deploy_watches RENAME TO deploy_watches_old;

      CREATE TABLE deploy_watches (
        id            TEXT PRIMARY KEY,
        environment   TEXT NOT NULL,
        project_id    TEXT NOT NULL,
        release_kind  TEXT NOT NULL DEFAULT 'merge-request'
                        CHECK (release_kind IN ('merge-request', 'commit')),
        mr_iid        INTEGER,
        mr_url        TEXT,
        commit_sha    TEXT,
        commit_url    TEXT,
        branch        TEXT NOT NULL,
        actor_id      TEXT,
        services_json TEXT NOT NULL,
        state         TEXT NOT NULL DEFAULT 'pending-merge'
                        CHECK (state IN ('pending-merge', 'watching', 'done', 'abandoned')),
        opened_at     TEXT NOT NULL,
        merged_at     TEXT,
        baseline_at   TEXT,
        baseline_fingerprints_json TEXT,
        watch_until   TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        CHECK (
          (release_kind = 'merge-request' AND mr_iid IS NOT NULL AND mr_url IS NOT NULL)
          OR
          (release_kind = 'commit' AND commit_sha IS NOT NULL AND commit_url IS NOT NULL)
        )
      );

      INSERT INTO deploy_watches
        (id, environment, project_id, release_kind, mr_iid, mr_url, branch,
         actor_id, services_json, state, opened_at, merged_at, baseline_at,
         baseline_fingerprints_json, watch_until, created_at, updated_at)
      SELECT id, environment, project_id, 'merge-request', mr_iid, mr_url, branch,
             actor_id, services_json, state, opened_at, merged_at, baseline_at,
             baseline_fingerprints_json, watch_until, created_at, updated_at
        FROM deploy_watches_old;

      CREATE TABLE deploy_watch_findings_new (
        id             TEXT PRIMARY KEY,
        watch_id       TEXT NOT NULL REFERENCES deploy_watches (id),
        service        TEXT,
        signature      TEXT NOT NULL,
        fingerprint    TEXT NOT NULL,
        event_count    INTEGER NOT NULL,
        sample_message TEXT,
        sample_stack   TEXT,
        first_seen_at  TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        source         TEXT NOT NULL DEFAULT 'datadog'
                         CHECK (source IN ('datadog', 'logrocket')),
        external_url   TEXT,
        issue_type     TEXT,
        UNIQUE (watch_id, fingerprint)
      );
      INSERT INTO deploy_watch_findings_new
        (id, watch_id, service, signature, fingerprint, event_count,
         sample_message, sample_stack, first_seen_at, created_at, source,
         external_url, issue_type)
      SELECT id, watch_id, service, signature, fingerprint, event_count,
             sample_message, sample_stack, first_seen_at, created_at, source,
             external_url, issue_type
        FROM deploy_watch_findings;

      DROP TABLE deploy_watch_findings;
      DROP TABLE deploy_watches_old;
      ALTER TABLE deploy_watch_findings_new RENAME TO deploy_watch_findings;

      CREATE UNIQUE INDEX idx_deploy_watches_project_mr
        ON deploy_watches (project_id, mr_iid)
        WHERE release_kind = 'merge-request';
      CREATE UNIQUE INDEX idx_deploy_watches_project_commit_env
        ON deploy_watches (project_id, commit_sha, environment)
        WHERE release_kind = 'commit';
      CREATE INDEX idx_deploy_watches_state ON deploy_watches (state);
      CREATE INDEX idx_deploy_watch_findings_watch ON deploy_watch_findings (watch_id);
    `,
  },
  {
    version: 61,
    name: "slack-user-inbox",
    up: `
      -- One Slack user OAuth connection per TALOS account. Access and refresh
      -- tokens are AES-GCM ciphertext; message bodies remain in Slack.
      CREATE TABLE slack_connections (
        user_id          TEXT PRIMARY KEY,
        team_id          TEXT NOT NULL,
        team_name        TEXT,
        slack_user_id    TEXT NOT NULL,
        slack_user_name  TEXT,
        access_token     TEXT NOT NULL,
        refresh_token    TEXT,
        expires_at       TEXT,
        scopes_json      TEXT NOT NULL,
        connected_at     TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );

      CREATE TABLE slack_channel_selections (
        user_id     TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        selected_at TEXT NOT NULL,
        PRIMARY KEY (user_id, channel_id)
      );

      -- TALOS read state is intentionally independent of Slack's read cursor.
      CREATE TABLE slack_read_cursors (
        user_id         TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        last_read_ts    TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        PRIMARY KEY (user_id, conversation_id)
      );

      -- The plaintext OAuth state is handed to the browser; only its hash is
      -- retained. DELETE ... RETURNING makes callback consumption single-use.
      CREATE TABLE slack_oauth_states (
        state_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX idx_slack_oauth_states_expiry ON slack_oauth_states (expires_at);
    `,
  },
  {
    version: 62,
    name: "secure-slack-oauth-lifecycle",
    up: `
      -- Invalidate states issued before callbacks were bound to their initiating
      -- browser, then require that binding on every new row.
      DELETE FROM slack_oauth_states;
      ALTER TABLE slack_oauth_states
        ADD COLUMN browser_hash TEXT NOT NULL DEFAULT '';

      -- Reject a token refresh that raced a reconnect or disconnect.
      ALTER TABLE slack_connections
        ADD COLUMN connection_version INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 63,
    name: "slack-live-activity",
    up: `
      -- Metadata only: Socket Mode records that a conversation changed, never
      -- the message text delivered in the event.
      CREATE TABLE slack_conversation_activity (
        user_id         TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        latest_ts       TEXT NOT NULL,
        thread_ts       TEXT,
        updated_at      TEXT NOT NULL,
        PRIMARY KEY (user_id, conversation_id)
      );

      CREATE TABLE slack_activity_revisions (
        user_id  TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    version: 64,
    name: "baseline-slack-unread-state",
    up: `
      -- Activity imported by the first full inbox scan is historical, not a
      -- flood of new messages. Existing explicit read cursors win; only
      -- conversations that never had a local baseline receive one.
      INSERT INTO slack_read_cursors
        (user_id, conversation_id, last_read_ts, updated_at)
      SELECT user_id, conversation_id, latest_ts, updated_at
        FROM slack_conversation_activity
       WHERE 1
      ON CONFLICT (user_id, conversation_id) DO NOTHING;
    `,
  },
  {
    version: 65,
    name: "slack-conversation-metadata",
    up: `
      -- Names, avatars and kinds are safe local index data. Message text stays
      -- in Slack and is fetched only for the open conversation.
      CREATE TABLE slack_conversations (
        user_id         TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        kind            TEXT NOT NULL CHECK (kind IN ('dm', 'group-dm', 'channel')),
        name            TEXT NOT NULL,
        avatar_url      TEXT,
        is_private      INTEGER NOT NULL DEFAULT 0,
        updated_at      TEXT NOT NULL,
        PRIMARY KEY (user_id, conversation_id)
      );
    `,
  },
  {
    version: 66,
    name: "rebuild-slack-conversation-catalog",
    up: `
      -- Early catalog bootstrap could persist only the handful of conversations
      -- whose per-conversation history/profile fan-out completed. Force one
      -- rebuild through the bulk discovery path without touching read cursors.
      DELETE FROM slack_conversations;
    `,
  },
  {
    version: 67,
    name: "slack-dm-peer-presence",
    up: `
      -- Keep the peer identity needed for bounded users.getPresence lookups.
      -- Existing metadata has no reliable way to recover it, so rebuild the
      -- catalog from Slack on the next inbox read.
      ALTER TABLE slack_conversations ADD COLUMN peer_user_id TEXT;
      DELETE FROM slack_conversations;
    `,
  },
  {
    version: 68,
    name: "hidden-slack-conversations",
    up: `
      -- A hidden DM stays out of catalog rebuilds until the user explicitly
      -- opens it again or requests a full resync.
      CREATE TABLE slack_hidden_conversations (
        user_id         TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        hidden_at       TEXT NOT NULL,
        PRIMARY KEY (user_id, conversation_id)
      );
    `,
  },
  {
    version: 69,
    name: "slack-app-conversations",
    up: `
      ALTER TABLE slack_conversations
        ADD COLUMN is_app INTEGER NOT NULL DEFAULT 0;
      -- Rebuild once so app DMs can be classified from Slack user profiles.
      DELETE FROM slack_conversations;
    `,
  },
  {
    version: 70,
    name: "datadog-service-targets",
    up: `
      -- A Datadog service is the boundary for code-writing actions. Keeping this
      -- team-wide prevents two developers from sending the same service to
      -- different repositories through their personal defaults.
      CREATE TABLE datadog_service_targets (
        service       TEXT PRIMARY KEY COLLATE NOCASE,
        project_id    TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
    `,
  },
  {
    version: 71,
    name: "datadog-ai-triage",
    up: `
      CREATE TABLE datadog_ai_triage (
        id             TEXT PRIMARY KEY,
        issue_id       TEXT NOT NULL UNIQUE,
        fingerprint    TEXT NOT NULL,
        verdict        TEXT NOT NULL
                         CHECK (verdict IN ('code', 'bad-data', 'infrastructure', 'unknown')),
        confidence     REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        rationale      TEXT NOT NULL,
        recommendation TEXT NOT NULL,
        task_run_id    TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE INDEX idx_datadog_ai_triage_fingerprint
        ON datadog_ai_triage (fingerprint);
    `,
  },
  {
    version: 72,
    name: "user-roles",
    up: `
      ALTER TABLE auth_users
        ADD COLUMN role TEXT NOT NULL DEFAULT 'qa'
          CHECK (role IN ('admin', 'qa'));
    `,
  },
  {
    version: 73,
    name: "user-permissions",
    up: `
      CREATE TABLE auth_user_permissions (
        user_id    TEXT NOT NULL,
        permission TEXT NOT NULL
          CHECK (permission IN (
            'users:manage',
            'application-logs:read',
            'instance-settings:manage',
            'tasks:manage'
          )),
        PRIMARY KEY (user_id, permission),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
      );

      -- Preserve the access of managed administrators that predate permissions.
      INSERT INTO auth_user_permissions (user_id, permission)
        SELECT id, 'users:manage' FROM auth_users WHERE role = 'admin';
      INSERT INTO auth_user_permissions (user_id, permission)
        SELECT id, 'application-logs:read' FROM auth_users WHERE role = 'admin';
      INSERT INTO auth_user_permissions (user_id, permission)
        SELECT id, 'instance-settings:manage' FROM auth_users WHERE role = 'admin';
      INSERT INTO auth_user_permissions (user_id, permission)
        SELECT id, 'tasks:manage' FROM auth_users WHERE role = 'admin';
    `,
  },
  {
    version: 74,
    name: "user-activity",
    up: `
      -- Durable activity rather than a timestamp on auth_sessions: signing out
      -- must not erase "last seen", and the built-in accounts have no auth_users
      -- row to carry it.
      CREATE TABLE auth_user_activity (
        user_id      TEXT PRIMARY KEY,
        last_seen_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 75,
    name: "structured-feedback",
    up: `
      -- Feedback now starts as an issue type and has a title. Keep the original
      -- message column as the description so existing submissions survive.
      ALTER TABLE feedback ADD COLUMN type TEXT NOT NULL DEFAULT 'general'
        CHECK (type IN ('bug', 'feature', 'general', 'security'));
      ALTER TABLE feedback ADD COLUMN title TEXT NOT NULL DEFAULT 'Feedback';
      ALTER TABLE feedback ADD COLUMN labels_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 77,
    name: "feedback-external-issue",
    up: `
      -- The local mailbox remains the audit record while the source forge
      -- becomes the actionable issue tracker.
      ALTER TABLE feedback ADD COLUMN external_issue_url TEXT;
      ALTER TABLE feedback ADD COLUMN external_issue_number INTEGER;
    `,
  },
  {
    version: 78,
    name: "ci-failure-attribution-recovery",
    up: `
      -- 256 KiB was the old CI-loop default. Preserve deliberate custom values,
      -- but move instances pinned to that default to the larger capture.
      UPDATE scheduled_task_config
         SET params = json_set(params, '$.gitlab.maxTraceBytes', 1048576)
       WHERE json_valid(params)
         AND json_extract(params, '$.gitlab.maxTraceBytes') = 262144
         AND (
           task_id = 'gitlab-ci-failure'
           OR task_id IN (
             SELECT id FROM task_instances
              WHERE definition_id = 'gitlab-ci-failure'
           )
         );

      -- These synthetic rows combine unrelated specs and produce meaningless
      -- flake rates. New unresolved failures are emitted as parser diagnostics.
      DELETE FROM test_run_failures
       WHERE source = 'gitlab-ci-failure' AND test_id = '(unattributed)';
      DELETE FROM test_flake_flags
       WHERE source = 'gitlab-ci-failure' AND test_id = '(unattributed)';
    `,
  },
  {
    version: 79,
    name: "automation-storage",
    up: `
      -- One instance-wide source. The child table keeps allowlist order
      -- relationally instead of relying on JSON array mutation.
      CREATE TABLE automation_config (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        project_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE automation_config_schedules (
        config_id    INTEGER NOT NULL DEFAULT 1,
        position     INTEGER NOT NULL CHECK (position >= 0),
        schedule_id  INTEGER NOT NULL CHECK (schedule_id >= 0),
        display_name TEXT,
        PRIMARY KEY (config_id, schedule_id),
        UNIQUE (config_id, position),
        FOREIGN KEY (config_id) REFERENCES automation_config(id) ON DELETE CASCADE
      );

      CREATE TABLE automation_schedules (
        project_id   TEXT NOT NULL,
        schedule_id  INTEGER NOT NULL CHECK (schedule_id >= 0),
        description  TEXT NOT NULL,
        ref           TEXT NOT NULL,
        cron          TEXT,
        cron_timezone TEXT,
        next_run_at   TEXT,
        active        INTEGER NOT NULL CHECK (active IN (0, 1)),
        synced_at     TEXT NOT NULL,
        PRIMARY KEY (project_id, schedule_id)
      );
      CREATE INDEX idx_automation_schedules_sync
        ON automation_schedules (synced_at);

      CREATE TABLE automation_pipelines (
        project_id    TEXT NOT NULL,
        pipeline_id   INTEGER NOT NULL CHECK (pipeline_id >= 0),
        schedule_id   INTEGER NOT NULL CHECK (schedule_id >= 0),
        status        TEXT NOT NULL,
        ref           TEXT NOT NULL,
        sha           TEXT NOT NULL,
        web_url       TEXT NOT NULL,
        created_at    TEXT,
        updated_at    TEXT NOT NULL,
        started_at    TEXT,
        finished_at   TEXT,
        duration      REAL,
        report_state  TEXT CHECK (
          report_state IS NULL OR report_state IN ('pending', 'complete', 'missing', 'error')
        ),
        total_time    REAL,
        total_count   INTEGER,
        success_count INTEGER,
        failed_count  INTEGER,
        skipped_count INTEGER,
        error_count   INTEGER,
        suite_error   TEXT,
        PRIMARY KEY (project_id, pipeline_id),
        FOREIGN KEY (project_id, schedule_id)
          REFERENCES automation_schedules(project_id, schedule_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_automation_pipelines_schedule_cursor
        ON automation_pipelines (project_id, schedule_id, updated_at DESC, pipeline_id DESC);
      CREATE INDEX idx_automation_pipelines_filters
        ON automation_pipelines (project_id, status, updated_at DESC, pipeline_id DESC);

      CREATE TABLE automation_pipeline_jobs (
        project_id    TEXT NOT NULL,
        pipeline_id   INTEGER NOT NULL,
        job_id        INTEGER NOT NULL CHECK (job_id >= 0),
        name          TEXT NOT NULL,
        stage         TEXT NOT NULL,
        status        TEXT NOT NULL,
        failure_reason TEXT,
        allow_failure INTEGER NOT NULL CHECK (allow_failure IN (0, 1)),
        web_url       TEXT NOT NULL,
        duration      REAL,
        created_at    TEXT,
        started_at    TEXT,
        finished_at   TEXT,
        total_time    REAL,
        total_count   INTEGER,
        success_count INTEGER,
        failed_count  INTEGER,
        skipped_count INTEGER,
        error_count   INTEGER,
        suite_error   TEXT,
        PRIMARY KEY (project_id, pipeline_id, job_id),
        FOREIGN KEY (project_id, pipeline_id)
          REFERENCES automation_pipelines(project_id, pipeline_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_automation_pipeline_jobs_stage
        ON automation_pipeline_jobs (project_id, pipeline_id, stage, job_id);

      CREATE TABLE automation_pipeline_test_suites (
        project_id    TEXT NOT NULL,
        pipeline_id   INTEGER NOT NULL,
        suite_index   INTEGER NOT NULL CHECK (suite_index >= 0),
        name          TEXT NOT NULL,
        build_ids_json TEXT NOT NULL,
        total_time    REAL NOT NULL,
        total_count   INTEGER NOT NULL,
        success_count INTEGER NOT NULL,
        failed_count  INTEGER NOT NULL,
        skipped_count INTEGER NOT NULL,
        error_count   INTEGER NOT NULL,
        suite_error   TEXT,
        PRIMARY KEY (project_id, pipeline_id, suite_index),
        FOREIGN KEY (project_id, pipeline_id)
          REFERENCES automation_pipelines(project_id, pipeline_id) ON DELETE CASCADE
      );

      CREATE TABLE automation_pipeline_failed_tests (
        project_id     TEXT NOT NULL,
        pipeline_id    INTEGER NOT NULL,
        suite_index    INTEGER NOT NULL CHECK (suite_index >= 0),
        case_index     INTEGER NOT NULL CHECK (case_index >= 0),
        job_id         INTEGER,
        status         TEXT NOT NULL CHECK (status IN ('failed', 'error')),
        name           TEXT NOT NULL,
        classname      TEXT,
        execution_time REAL NOT NULL,
        system_output  TEXT,
        stack_trace    TEXT,
        PRIMARY KEY (project_id, pipeline_id, suite_index, case_index),
        FOREIGN KEY (project_id, pipeline_id)
          REFERENCES automation_pipelines(project_id, pipeline_id) ON DELETE CASCADE,
        FOREIGN KEY (project_id, pipeline_id, suite_index)
          REFERENCES automation_pipeline_test_suites(project_id, pipeline_id, suite_index)
          ON DELETE CASCADE
      );
      CREATE INDEX idx_automation_failed_tests_identity
        ON automation_pipeline_failed_tests
          (project_id, classname, name, pipeline_id DESC);
    `,
  },
  {
    version: 80,
    name: "automation-failure-attachments",
    up: `
      -- Version 1 is the report shape written before failure attachments and
      -- normalized signatures. The sync explicitly refreshes complete v1 rows
      -- and writes v2, without re-fetching unchanged complete v2 pipelines.
      ALTER TABLE automation_pipelines
        ADD COLUMN report_version INTEGER NOT NULL DEFAULT 1
        CHECK (report_version >= 1);

      ALTER TABLE automation_pipeline_failed_tests ADD COLUMN test_file TEXT;
      ALTER TABLE automation_pipeline_failed_tests ADD COLUMN attachment_job_id INTEGER;
      ALTER TABLE automation_pipeline_failed_tests ADD COLUMN attachment_path TEXT;
      ALTER TABLE automation_pipeline_failed_tests ADD COLUMN attachment_name TEXT;
      ALTER TABLE automation_pipeline_failed_tests
        ADD COLUMN signature_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE automation_pipeline_failed_tests
        ADD COLUMN signature_title TEXT NOT NULL DEFAULT '';

      -- Keep pre-v2 rows distinguishable and non-clustering until their owning
      -- pipeline is refreshed. They cannot be assigned a real normalized key
      -- from SQL alone.
      UPDATE automation_pipeline_failed_tests
         SET signature_key = 'legacy-v1:' || project_id || ':' || pipeline_id ||
                             ':' || suite_index || ':' || case_index,
             signature_title = name
       WHERE signature_key = '';

      CREATE INDEX idx_automation_failed_tests_signature
        ON automation_pipeline_failed_tests
          (project_id, signature_key, pipeline_id DESC);
      CREATE INDEX idx_automation_pipelines_report_refresh
        ON automation_pipelines
          (project_id, schedule_id, report_version, report_state, updated_at DESC);
    `,
  },
  {
    version: 81,
    name: "automation-jira-config",
    up: `
      -- Optional Jira defaults belong to the same singleton aggregate as the
      -- Automation GitLab source. Existing installs receive no row, preserving
      -- their project/schedule configuration and leaving ticketing unconfigured.
      CREATE TABLE automation_jira_config (
        config_id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (config_id = 1),
        project_key       TEXT NOT NULL,
        issue_type        TEXT NOT NULL DEFAULT 'Bug',
        board_id          INTEGER CHECK (board_id IS NULL OR board_id > 0),
        use_active_sprint INTEGER NOT NULL DEFAULT 1
                          CHECK (use_active_sprint IN (0, 1)),
        assignee_mode     TEXT NOT NULL DEFAULT 'automatic'
                          CHECK (assignee_mode IN ('automatic', 'fixed')),
        fixed_assignee    TEXT,
        CHECK (
          (assignee_mode = 'automatic' AND fixed_assignee IS NULL) OR
          (assignee_mode = 'fixed' AND length(fixed_assignee) > 0)
        ),
        FOREIGN KEY (config_id) REFERENCES automation_config(id) ON DELETE CASCADE
      );

      -- Labels are ordered rows rather than JSON so the whole Automation config
      -- can be replaced in one transaction without hidden array mutation.
      CREATE TABLE automation_jira_labels (
        config_id INTEGER NOT NULL DEFAULT 1,
        position  INTEGER NOT NULL CHECK (position >= 0),
        label     TEXT NOT NULL CHECK (length(label) > 0),
        PRIMARY KEY (config_id, position),
        UNIQUE (config_id, label),
        FOREIGN KEY (config_id)
          REFERENCES automation_jira_config(config_id) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 82,
    name: "automation-failure-cluster-work",
    up: `
      -- One durable claim/link per normalized failure signature. The schedule is
      -- part of the identity because the same failure in two independently owned
      -- suites may need different work and different Jira lifecycle.
      --
      -- Rows deliberately do not reference pipeline snapshots: retention may
      -- prune an old run, but a later run of the same configured schedule must
      -- still adopt the existing ticket instead of filing another one.
      CREATE TABLE automation_failure_cluster_work (
        project_id   TEXT NOT NULL,
        schedule_id  INTEGER NOT NULL CHECK (schedule_id >= 0),
        signature_key TEXT NOT NULL CHECK (length(signature_key) > 0),
        identity     TEXT NOT NULL CHECK (length(identity) > 0),
        state        TEXT NOT NULL
                       CHECK (state IN ('creating', 'ticketed', 'active-mr')),
        jira_key     TEXT,
        jira_url     TEXT,
        mr_iid       INTEGER CHECK (mr_iid IS NULL OR mr_iid > 0),
        mr_url       TEXT,
        claimed_at   TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (project_id, schedule_id, signature_key),
        UNIQUE (identity),
        CHECK (
          (state = 'creating' AND claimed_at IS NOT NULL) OR
          (state = 'ticketed' AND jira_key IS NOT NULL AND jira_url IS NOT NULL) OR
          (state = 'active-mr' AND mr_iid IS NOT NULL AND mr_url IS NOT NULL)
        )
      );

      CREATE INDEX idx_automation_cluster_work_state
        ON automation_failure_cluster_work
          (project_id, schedule_id, state, updated_at DESC);
      CREATE INDEX idx_automation_cluster_work_jira
        ON automation_failure_cluster_work (jira_key)
        WHERE jira_key IS NOT NULL;
    `,
  },
  {
    version: 83,
    name: "automation-ai-triage",
    up: `
      -- One latest verdict per configured schedule and normalized signature.
      -- It deliberately has no pipeline FK: the verdict survives snapshot
      -- retention and is replaced when a later run of the cluster is triaged.
      CREATE TABLE automation_ai_triage (
        id             TEXT NOT NULL,
        project_id     TEXT NOT NULL,
        schedule_id    INTEGER NOT NULL CHECK (schedule_id >= 0),
        signature_key  TEXT NOT NULL CHECK (length(signature_key) > 0),
        signature      TEXT NOT NULL CHECK (length(signature) > 0),
        verdict        TEXT NOT NULL CHECK (verdict IN (
                           'bad-data',
                           'service-breaking-change',
                           'ui-change',
                           'test-bug',
                           'infrastructure',
                           'unknown'
                         )),
        confidence     REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        rationale      TEXT NOT NULL CHECK (length(rationale) > 0),
        recommendation TEXT NOT NULL CHECK (length(recommendation) > 0),
        task_run_id    TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (project_id, schedule_id, signature_key),
        UNIQUE (id)
      );

      CREATE INDEX idx_automation_ai_triage_updated
        ON automation_ai_triage
          (project_id, schedule_id, updated_at DESC);
    `,
  },
  {
    version: 84,
    name: "automation-failure-inbox",
    up: `
      -- Durable cross-pipeline history for one normalized failure in one
      -- configured schedule. It deliberately has no pipeline FK: pipeline
      -- retention must not reset first-seen time or recurrence counts.
      CREATE TABLE automation_failure_inbox (
        project_id          TEXT NOT NULL,
        schedule_id         INTEGER NOT NULL CHECK (schedule_id >= 0),
        signature_key       TEXT NOT NULL CHECK (length(signature_key) > 0),
        signature_title     TEXT NOT NULL CHECK (length(signature_title) > 0),
        severity            TEXT NOT NULL CHECK (severity IN ('failed', 'error')),
        first_seen_at       TEXT NOT NULL,
        last_seen_at        TEXT NOT NULL,
        pipeline_count      INTEGER NOT NULL CHECK (pipeline_count > 0),
        latest_pipeline_id  INTEGER NOT NULL CHECK (latest_pipeline_id >= 0),
        latest_pipeline_url TEXT NOT NULL,
        latest_ref          TEXT NOT NULL,
        latest_sha          TEXT NOT NULL,
        latest_updated_at   TEXT NOT NULL,
        occurrence_count    INTEGER NOT NULL CHECK (occurrence_count > 0),
        affected_test_count INTEGER NOT NULL CHECK (affected_test_count > 0),
        sample_test_name    TEXT NOT NULL,
        sample_classname    TEXT,
        PRIMARY KEY (project_id, schedule_id, signature_key)
      );

      CREATE INDEX idx_automation_failure_inbox_recent
        ON automation_failure_inbox
          (project_id, last_seen_at DESC, schedule_id, signature_key);
      CREATE INDEX idx_automation_failure_inbox_schedule
        ON automation_failure_inbox
          (project_id, schedule_id, last_seen_at DESC, signature_key);

      -- Existing retained v2 snapshots seed the durable rollup. Window
      -- functions select the newest per-pipeline aggregate while retaining
      -- lifetime first/last timestamps and distinct pipeline counts.
      WITH per_pipeline AS (
        SELECT p.project_id, p.schedule_id, f.signature_key,
               MIN(f.signature_title) AS signature_title,
               CASE WHEN MAX(CASE WHEN f.status = 'error' THEN 1 ELSE 0 END) = 1
                    THEN 'error' ELSE 'failed' END AS severity,
               p.updated_at AS seen_at,
               p.pipeline_id, p.web_url, p.ref, p.sha,
               COUNT(*) AS occurrence_count,
               COUNT(DISTINCT COALESCE(f.classname, '') || char(31) || f.name)
                 AS affected_test_count,
               MIN(f.name) AS sample_test_name,
               MIN(f.classname) AS sample_classname
          FROM automation_pipelines p
          JOIN automation_pipeline_failed_tests f
            ON f.project_id = p.project_id AND f.pipeline_id = p.pipeline_id
         WHERE p.report_version >= 2
           AND f.signature_key NOT LIKE 'legacy-v1:%'
         GROUP BY p.project_id, p.schedule_id, f.signature_key,
                  p.pipeline_id, p.web_url, p.ref, p.sha, p.updated_at
      ),
      ranked AS (
        SELECT per_pipeline.*,
               MIN(seen_at) OVER identity AS first_seen_at,
               MAX(seen_at) OVER identity AS last_seen_at,
               COUNT(*) OVER identity AS pipeline_count,
               ROW_NUMBER() OVER (
                 PARTITION BY project_id, schedule_id, signature_key
                 ORDER BY seen_at DESC, pipeline_id DESC
               ) AS newest
          FROM per_pipeline
        WINDOW identity AS (
          PARTITION BY project_id, schedule_id, signature_key
        )
      )
      INSERT INTO automation_failure_inbox (
        project_id, schedule_id, signature_key, signature_title, severity,
        first_seen_at, last_seen_at, pipeline_count, latest_pipeline_id,
        latest_pipeline_url, latest_ref, latest_sha, latest_updated_at,
        occurrence_count, affected_test_count, sample_test_name,
        sample_classname
      )
      SELECT project_id, schedule_id, signature_key, signature_title, severity,
             first_seen_at, last_seen_at, pipeline_count, pipeline_id,
             web_url, ref, sha, seen_at, occurrence_count,
             affected_test_count, sample_test_name, sample_classname
        FROM ranked
       WHERE newest = 1;
    `,
  },
  {
    version: 85,
    name: "automation-job-auto-retry",
    up: `
      ALTER TABLE automation_config_schedules
        ADD COLUMN auto_retry_enabled INTEGER NOT NULL DEFAULT 0
        CHECK (auto_retry_enabled IN (0, 1));
      ALTER TABLE automation_config_schedules
        ADD COLUMN auto_retry_max_jobs INTEGER NOT NULL DEFAULT 3
        CHECK (auto_retry_max_jobs BETWEEN 1 AND 20);

      -- The wave is the at-most-once boundary. It intentionally survives
      -- pipeline retention so a forced backfill cannot repeat an external write.
      CREATE TABLE automation_job_retry_waves (
        project_id   TEXT NOT NULL,
        pipeline_id  INTEGER NOT NULL CHECK (pipeline_id >= 0),
        schedule_id  INTEGER NOT NULL CHECK (schedule_id >= 0),
        state        TEXT NOT NULL
                       CHECK (state IN ('claimed', 'complete', 'partial', 'failed')),
        execution_id TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        completed_at TEXT,
        error        TEXT,
        PRIMARY KEY (project_id, pipeline_id)
      );
      CREATE INDEX idx_automation_retry_waves_schedule
        ON automation_job_retry_waves
          (project_id, schedule_id, requested_at DESC);

      CREATE TABLE automation_job_retry_attempts (
        project_id       TEXT NOT NULL,
        pipeline_id      INTEGER NOT NULL CHECK (pipeline_id >= 0),
        schedule_id      INTEGER NOT NULL CHECK (schedule_id >= 0),
        source_job_id    INTEGER NOT NULL CHECK (source_job_id >= 0),
        source_job_name  TEXT NOT NULL,
        retry_job_id     INTEGER CHECK (retry_job_id IS NULL OR retry_job_id >= 0),
        retry_job_url    TEXT,
        status           TEXT NOT NULL
                           CHECK (status IN ('requested', 'accepted', 'failed')),
        error            TEXT,
        requested_at     TEXT NOT NULL,
        completed_at     TEXT,
        PRIMARY KEY (project_id, pipeline_id, source_job_id),
        FOREIGN KEY (project_id, pipeline_id)
          REFERENCES automation_job_retry_waves(project_id, pipeline_id)
          ON DELETE CASCADE
      );
    `,
  },
  {
    version: 86,
    name: "e2e-test-config",
    up: `
      -- Optional replacements for the two Test-Automation files consumed by
      -- ticket E2E runs, plus operator-authored instructions mounted separately.
      -- NULL preserves the existing behavior: fetch the repository file for
      -- this run (or send no additional instructions).
      CREATE TABLE e2e_test_config (
        id                          INTEGER PRIMARY KEY CHECK (id = 1),
        agent_instructions_override TEXT,
        -- Contains fixture passwords, so this value is always ciphertext
        -- protected by TALOS_SECRET_KEY when present.
        runtime_config_override     TEXT,
        additional_instructions     TEXT,
        updated_at                  TEXT NOT NULL
      );
    `,
  },
  {
    version: 87,
    name: "automation-jira-parent",
    up: `
      ALTER TABLE automation_jira_config
        ADD COLUMN parent_key TEXT
        CHECK (parent_key IS NULL OR length(parent_key) > 0);
    `,
  },
  {
    version: 88,
    name: "automation-failure-assignee",
    up: `
      -- Talos ownership follows the durable schedule/signature identity, not a
      -- retained pipeline snapshot. User ids deliberately have no auth_users
      -- foreign key because built-in accounts are source-controlled identities.
      CREATE TABLE automation_failure_assignees (
        project_id         TEXT NOT NULL,
        schedule_id        INTEGER NOT NULL CHECK (schedule_id >= 0),
        signature_key      TEXT NOT NULL CHECK (length(signature_key) > 0),
        user_id            TEXT NOT NULL CHECK (length(user_id) > 0),
        assigned_by_user_id TEXT NOT NULL CHECK (length(assigned_by_user_id) > 0),
        assigned_at        TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        PRIMARY KEY (project_id, schedule_id, signature_key)
      );

      CREATE INDEX idx_automation_failure_assignees_user
        ON automation_failure_assignees (user_id, updated_at DESC);
    `,
  },
  {
    version: 89,
    name: "database-backed-roles",
    up: migrateDatabaseBackedRoles,
  },
  {
    version: 90,
    name: "module-access-permissions",
    up: `
      CREATE TABLE auth_role_permissions_new (
        role_id    TEXT NOT NULL,
        permission TEXT NOT NULL
          CHECK (permission IN (
            'loops:access',
            'pull-requests:access',
            'releases:access',
            'automation:access',
            'logrocket:access',
            'datadog:access',
            'tickets:access',
            'slack:access',
            'users:manage',
            'application-logs:read',
            'instance-settings:manage',
            'tasks:manage'
          )),
        PRIMARY KEY (role_id, permission),
        FOREIGN KEY (role_id) REFERENCES auth_roles(id) ON DELETE CASCADE
      );

      INSERT INTO auth_role_permissions_new (role_id, permission)
        SELECT role_id, permission FROM auth_role_permissions;

      -- Before module permissions existed, every authenticated user could open
      -- every product module. Preserve that access for every existing role;
      -- administrators can then narrow roles explicitly in the role editor.
      INSERT INTO auth_role_permissions_new (role_id, permission)
        SELECT id, 'loops:access' FROM auth_roles;
      INSERT INTO auth_role_permissions_new (role_id, permission)
        SELECT id, 'pull-requests:access' FROM auth_roles;
      INSERT INTO auth_role_permissions_new (role_id, permission)
        SELECT id, 'releases:access' FROM auth_roles;
      INSERT INTO auth_role_permissions_new (role_id, permission)
        SELECT id, 'automation:access' FROM auth_roles;
      INSERT INTO auth_role_permissions_new (role_id, permission)
        SELECT id, 'logrocket:access' FROM auth_roles;
      INSERT INTO auth_role_permissions_new (role_id, permission)
        SELECT id, 'datadog:access' FROM auth_roles;
      INSERT INTO auth_role_permissions_new (role_id, permission)
        SELECT id, 'tickets:access' FROM auth_roles;
      INSERT INTO auth_role_permissions_new (role_id, permission)
        SELECT id, 'slack:access' FROM auth_roles;

      DROP TABLE auth_role_permissions;
      ALTER TABLE auth_role_permissions_new RENAME TO auth_role_permissions;
    `,
  },
  {
    version: 91,
    name: "pending-feedback-publication",
    up: `
      ALTER TABLE feedback ADD COLUMN publication_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (publication_status IN ('pending', 'published'));
      ALTER TABLE feedback ADD COLUMN publication_reason TEXT
        CHECK (
          publication_reason IS NULL OR publication_reason IN (
            'missing_token',
            'invalid_token',
            'insufficient_access',
            'temporary_failure'
          )
        );

      UPDATE feedback
         SET publication_status = 'published'
       WHERE external_issue_url IS NOT NULL;

      CREATE TABLE feedback_attachments (
        id           TEXT PRIMARY KEY,
        feedback_id  TEXT NOT NULL,
        name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
        content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 100),
        bytes        BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 10485760),
        created_at   TEXT NOT NULL,
        FOREIGN KEY (feedback_id) REFERENCES feedback(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_feedback_attachments_feedback
        ON feedback_attachments (feedback_id, created_at);
      CREATE INDEX idx_feedback_pending_user
        ON feedback (user_id, publication_status, created_at DESC);
    `,
  },
  {
    version: 92,
    name: "user-invitations",
    up: `
      -- Invited accounts exist in the user directory before their owner chooses
      -- a password. The status is explicit rather than inferred throughout the
      -- application, while the CHECK keeps status and credential state aligned.
      CREATE TABLE auth_users_new (
        id                TEXT PRIMARY KEY,
        email             TEXT NOT NULL COLLATE NOCASE UNIQUE,
        name              TEXT NOT NULL,
        password_hash     TEXT,
        created_at        TEXT NOT NULL,
        role_id           TEXT NOT NULL,
        account_status    TEXT NOT NULL DEFAULT 'active'
                          CHECK (account_status IN ('pending', 'active')),
        CHECK (
          (account_status = 'pending' AND password_hash IS NULL) OR
          (account_status = 'active' AND password_hash IS NOT NULL)
        ),
        FOREIGN KEY (role_id) REFERENCES auth_roles(id)
      );

      INSERT INTO auth_users_new (
        id, email, name, password_hash, created_at, role_id, account_status
      )
        SELECT id, email, name, password_hash, created_at, role_id, 'active'
          FROM auth_users;

      DROP TABLE auth_users;
      ALTER TABLE auth_users_new RENAME TO auth_users;
      CREATE INDEX idx_auth_users_role ON auth_users(role_id);
      DROP TABLE auth_verification_tokens;

      -- The URL carries the random token, while the database keeps only its
      -- SHA-256 digest. A copied database therefore cannot be used to redeem an
      -- outstanding invitation. One row per user makes reissuing revoke the old
      -- link atomically.
      CREATE TABLE auth_invitation_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_auth_invitation_tokens_expires
        ON auth_invitation_tokens (expires_at);
    `,
  },
  {
    version: 93,
    name: "agent-usage-events",
    up: `
      -- Immutable provider telemetry. Account and user IDs are intentionally
      -- snapshots without foreign keys: disconnecting an account or removing a
      -- user must not rewrite historical usage.
      CREATE TABLE agent_usage_events (
        id                          TEXT PRIMARY KEY,
        user_id                     TEXT NOT NULL,
        account_id                  TEXT,
        account_label               TEXT NOT NULL,
        option_id                   TEXT,
        auth_source                 TEXT NOT NULL CHECK (auth_source IN ('connected', 'host')),
        provider                    TEXT NOT NULL,
        model                       TEXT,
        source                      TEXT NOT NULL CHECK (source IN ('task', 'assistant', 'e2e')),
        execution_id                TEXT,
        invocation_label            TEXT,
        status                      TEXT NOT NULL CHECK (status IN ('success', 'failed', 'cancelled')),
        started_at                  TEXT NOT NULL,
        finished_at                 TEXT NOT NULL,
        duration_ms                 INTEGER,
        turns                       INTEGER,
        input_tokens                INTEGER,
        output_tokens               INTEGER,
        cache_read_input_tokens     INTEGER,
        cache_creation_input_tokens INTEGER,
        CHECK (
          (input_tokens IS NULL AND output_tokens IS NULL
            AND cache_read_input_tokens IS NULL AND cache_creation_input_tokens IS NULL)
          OR
          (input_tokens >= 0 AND output_tokens >= 0
            AND cache_read_input_tokens >= 0 AND cache_creation_input_tokens >= 0)
        )
      );
      CREATE INDEX idx_agent_usage_user_started
        ON agent_usage_events (user_id, started_at DESC);
      CREATE INDEX idx_agent_usage_account_started
        ON agent_usage_events (account_id, started_at DESC);
      CREATE INDEX idx_agent_usage_execution
        ON agent_usage_events (execution_id);
    `,
  },
  {
    version: 94,
    name: "worker-orchestration-foundation",
    up: `
      -- Stable installation identity used on every managed runtime resource.
      -- Resource discovery must never treat another Talos installation's
      -- containers as its own.
      CREATE TABLE orchestration_settings (
        singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
        installation_id TEXT NOT NULL UNIQUE,
        draining        INTEGER NOT NULL DEFAULT 0 CHECK (draining IN (0, 1)),
        updated_at      TEXT NOT NULL
      );
      INSERT INTO orchestration_settings (singleton, installation_id, draining, updated_at)
      VALUES (
        1,
        lower(hex(randomblob(16))),
        0,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );

      -- A job remains queue-compatible while administrative intent is recorded
      -- separately. This avoids collapsing hold, cancellation, supersession,
      -- and execution failure into the legacy 'dead' state.
      ALTER TABLE jobs ADD COLUMN held_at TEXT;
      ALTER TABLE jobs ADD COLUMN hold_reason TEXT;
      ALTER TABLE jobs ADD COLUMN terminal_outcome TEXT
        CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('failed', 'cancelled', 'superseded'));
      ALTER TABLE jobs ADD COLUMN superseded_by_job_id TEXT
        REFERENCES jobs(id) ON DELETE SET NULL;
      CREATE INDEX idx_jobs_eligibility
        ON jobs (status, held_at, available_at, priority DESC, enqueued_at);

      -- One immutable logical attempt may own one capacity slot and one runtime
      -- identity. Active rows are fenced by owner_token. Expired ownership is
      -- intentionally retained: expiry means the daemon lost authority, not
      -- that the physical runtime stopped.
      CREATE TABLE agent_execution_attempts (
        id                 TEXT PRIMARY KEY,
        execution_id       TEXT,
        job_id             TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        actor_id           TEXT,
        lane               TEXT NOT NULL CHECK (lane IN ('background', 'interactive')),
        workload_kind      TEXT NOT NULL,
        slot               INTEGER NOT NULL,
        owner_token        TEXT NOT NULL UNIQUE,
        state              TEXT NOT NULL CHECK (
          state IN (
            'starting', 'running', 'stopping', 'succeeded', 'failed',
            'cancelled', 'superseded', 'uncertain'
          )
        ),
        runtime_kind       TEXT NOT NULL CHECK (runtime_kind IN ('docker', 'kubernetes', 'host')),
        runtime_id         TEXT,
        installation_id    TEXT NOT NULL,
        lease_expires_at   TEXT NOT NULL,
        last_heartbeat_at  TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        started_at         TEXT,
        stopping_at        TEXT,
        finished_at        TEXT,
        reason             TEXT
      );
      CREATE UNIQUE INDEX idx_agent_attempts_active_slot
        ON agent_execution_attempts (slot)
        WHERE state IN ('starting', 'running', 'stopping', 'uncertain');
      CREATE UNIQUE INDEX idx_agent_attempts_active_runtime
        ON agent_execution_attempts (runtime_kind, runtime_id)
        WHERE runtime_id IS NOT NULL
          AND state IN ('starting', 'running', 'stopping', 'uncertain');
      CREATE INDEX idx_agent_attempts_execution
        ON agent_execution_attempts (execution_id, created_at DESC);
      CREATE INDEX idx_agent_attempts_reconcile
        ON agent_execution_attempts (state, lease_expires_at);

      -- Legacy permits have no execution identity. Preserve each one as
      -- uncertain until startup successfully lists legacy managed resources;
      -- deleting an expired lease here would incorrectly declare its physical
      -- capacity free.
      INSERT INTO agent_execution_attempts (
        id, lane, workload_kind, slot, owner_token, state, runtime_kind,
        installation_id, lease_expires_at, last_heartbeat_at, created_at, reason
      )
      SELECT
        'legacy-' || slot || '-' || lower(hex(randomblob(8))),
        'background',
        'legacy-agent',
        slot,
        'legacy-' || owner || '-' || lower(hex(randomblob(8))),
        'uncertain',
        'docker',
        (SELECT installation_id FROM orchestration_settings WHERE singleton = 1),
        expires_at,
        expires_at,
        expires_at,
        'legacy permit awaiting successful runtime discovery'
      FROM agent_host_permits;
      DELETE FROM agent_host_permits;
    `,
  },
  {
    version: 95,
    name: "orchestration-transition-history",
    up: `
      CREATE TABLE orchestration_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id  TEXT NOT NULL
                    REFERENCES agent_execution_attempts(id) ON DELETE CASCADE,
        event_type  TEXT NOT NULL,
        from_state  TEXT,
        to_state    TEXT NOT NULL,
        reason      TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_orchestration_events_attempt
        ON orchestration_events (attempt_id, id);
      INSERT INTO orchestration_events (
        attempt_id, event_type, from_state, to_state, reason, created_at
      )
      SELECT id, 'migrated', NULL, state, reason, created_at
        FROM agent_execution_attempts;

      CREATE TRIGGER orchestration_attempt_created
      AFTER INSERT ON agent_execution_attempts
      BEGIN
        INSERT INTO orchestration_events (
          attempt_id, event_type, from_state, to_state, reason, created_at
        ) VALUES (
          NEW.id, 'reserved', NULL, NEW.state, NEW.reason,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        );
      END;

      CREATE TRIGGER orchestration_attempt_transition
      AFTER UPDATE OF state ON agent_execution_attempts
      WHEN OLD.state <> NEW.state
      BEGIN
        INSERT INTO orchestration_events (
          attempt_id, event_type, from_state, to_state, reason, created_at
        ) VALUES (
          NEW.id, 'transition', OLD.state, NEW.state, NEW.reason,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        );
      END;

      CREATE TRIGGER orchestration_attempt_note
      AFTER UPDATE OF reason ON agent_execution_attempts
      WHEN OLD.state = NEW.state AND COALESCE(OLD.reason, '') <> COALESCE(NEW.reason, '')
      BEGIN
        INSERT INTO orchestration_events (
          attempt_id, event_type, from_state, to_state, reason, created_at
        ) VALUES (
          NEW.id, 'note', OLD.state, NEW.state, NEW.reason,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        );
      END;
    `,
  },
  {
    version: 96,
    name: "agent-checkpoint-contract",
    up: `
      CREATE TABLE agent_checkpoints (
        id                TEXT PRIMARY KEY,
        attempt_id        TEXT NOT NULL
                          REFERENCES agent_execution_attempts(id) ON DELETE CASCADE,
        execution_id      TEXT NOT NULL,
        job_id            TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        provider          TEXT NOT NULL,
        protocol_version  INTEGER NOT NULL,
        owner_token       TEXT NOT NULL UNIQUE,
        status            TEXT NOT NULL CHECK (
          status IN ('preparing', 'ready', 'resuming', 'consumed', 'failed', 'invalid')
        ),
        manifest          TEXT,
        reason            TEXT,
        created_at        TEXT NOT NULL,
        ready_at          TEXT,
        resume_started_at TEXT,
        consumed_at       TEXT
      );
      CREATE UNIQUE INDEX idx_agent_checkpoints_active_attempt
        ON agent_checkpoints (attempt_id)
        WHERE status IN ('preparing', 'ready', 'resuming');
      CREATE INDEX idx_agent_checkpoints_execution
        ON agent_checkpoints (execution_id, created_at DESC);
      CREATE INDEX idx_agent_checkpoints_status
        ON agent_checkpoints (status, created_at);

      CREATE TABLE agent_checkpoint_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        checkpoint_id TEXT NOT NULL
                      REFERENCES agent_checkpoints(id) ON DELETE CASCADE,
        event_type  TEXT NOT NULL,
        from_status TEXT,
        to_status   TEXT NOT NULL,
        reason      TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_agent_checkpoint_events_checkpoint
        ON agent_checkpoint_events (checkpoint_id, id);

      CREATE TRIGGER agent_checkpoint_created
      AFTER INSERT ON agent_checkpoints
      BEGIN
        INSERT INTO agent_checkpoint_events (
          checkpoint_id, event_type, from_status, to_status, reason, created_at
        ) VALUES (
          NEW.id, 'created', NULL, NEW.status, NEW.reason,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        );
      END;

      CREATE TRIGGER agent_checkpoint_transition
      AFTER UPDATE OF status ON agent_checkpoints
      WHEN OLD.status <> NEW.status
      BEGIN
        INSERT INTO agent_checkpoint_events (
          checkpoint_id, event_type, from_status, to_status, reason, created_at
        ) VALUES (
          NEW.id, 'transition', OLD.status, NEW.status, NEW.reason,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        );
      END;
    `,
  },
  {
    version: 98,
    name: "dashboards",
    up: `
      -- A user's dashboard is a spec, never a copy of the rows it charts.
      -- Queries run as the viewer, so the table has nothing to leak later
      -- when a dashboard can be shared.
      CREATE TABLE dashboards (
        id            TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        name          TEXT NOT NULL,
        spec          TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_dashboards_owner ON dashboards (owner_user_id, updated_at DESC);
    `,
  },
];

const APP_PERMISSIONS = [
  "users:manage",
  "application-logs:read",
  "instance-settings:manage",
  "tasks:manage",
] as const;

/**
 * Promotes roles from a checked string/preset into first-class records. Existing
 * per-user overrides become shared migrated roles so an upgrade never broadens
 * or removes anybody's access.
 */
function migrateDatabaseBackedRoles(db: Database): void {
  const now = new Date().toISOString();
  db.run(`
    CREATE TABLE auth_roles (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL COLLATE NOCASE UNIQUE
                  CHECK (length(trim(name)) BETWEEN 2 AND 60),
      description TEXT NOT NULL DEFAULT ''
                  CHECK (length(description) <= 240),
      system      INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1)),
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE auth_role_permissions (
      role_id    TEXT NOT NULL,
      permission TEXT NOT NULL
        CHECK (permission IN (
          'users:manage',
          'application-logs:read',
          'instance-settings:manage',
          'tasks:manage'
        )),
      PRIMARY KEY (role_id, permission),
      FOREIGN KEY (role_id) REFERENCES auth_roles(id) ON DELETE CASCADE
    );
  `);
  db.run(
    `INSERT INTO auth_roles (id, name, description, system, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?), (?, ?, ?, 1, ?, ?)`,
    [
      "admin",
      "Administrator",
      "Full access to users, settings, logs, and all tasks.",
      now,
      now,
      "qa",
      "QA",
      "Standard access without administrative privileges.",
      now,
      now,
    ],
  );
  for (const permission of APP_PERMISSIONS) {
    db.run(
      "INSERT INTO auth_role_permissions (role_id, permission) VALUES ('admin', ?)",
      [permission],
    );
  }

  const users = db
    .query<{ id: string; role: "admin" | "qa" }, []>(
      "SELECT id, role FROM auth_users ORDER BY id",
    )
    .all();
  const permissionRows = db
    .query<{ user_id: string; permission: string }, []>(
      "SELECT user_id, permission FROM auth_user_permissions ORDER BY user_id, permission",
    )
    .all();
  const permissionsByUser = new Map<string, string[]>();
  for (const row of permissionRows) {
    const values = permissionsByUser.get(row.user_id) ?? [];
    values.push(row.permission);
    permissionsByUser.set(row.user_id, values);
  }

  db.run("CREATE TEMP TABLE auth_user_role_migration (user_id TEXT PRIMARY KEY, role_id TEXT NOT NULL)");
  const roleBySignature = new Map<string, string>();
  let migratedRoleNumber = 0;
  const adminSignature = [...APP_PERMISSIONS].sort().join("\u0000");
  for (const user of users) {
    const permissions = [...(permissionsByUser.get(user.id) ?? [])].sort();
    const signature = permissions.join("\u0000");
    let roleId: string;
    if (signature === adminSignature) {
      roleId = "admin";
    } else if (permissions.length === 0) {
      roleId = "qa";
    } else {
      roleId = roleBySignature.get(signature) ?? "";
      if (!roleId) {
        migratedRoleNumber += 1;
        roleId = `migrated-${migratedRoleNumber}`;
        roleBySignature.set(signature, roleId);
        db.run(
          `INSERT INTO auth_roles (id, name, description, system, created_at, updated_at)
           VALUES (?, ?, ?, 0, ?, ?)`,
          [
            roleId,
            `Migrated access ${migratedRoleNumber}`,
            "Created during the roles migration to preserve customized user permissions.",
            now,
            now,
          ],
        );
        for (const permission of permissions) {
          db.run(
            "INSERT INTO auth_role_permissions (role_id, permission) VALUES (?, ?)",
            [roleId, permission],
          );
        }
      }
    }
    db.run(
      "INSERT INTO auth_user_role_migration (user_id, role_id) VALUES (?, ?)",
      [user.id, roleId],
    );
  }

  db.run(`
    CREATE TABLE auth_users_new (
      id                TEXT PRIMARY KEY,
      email             TEXT NOT NULL COLLATE NOCASE UNIQUE,
      name              TEXT NOT NULL,
      password_hash     TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      email_verified_at TEXT,
      role_id           TEXT NOT NULL,
      FOREIGN KEY (role_id) REFERENCES auth_roles(id)
    );
    INSERT INTO auth_users_new (
      id, email, name, password_hash, created_at, email_verified_at, role_id
    )
      SELECT u.id, u.email, u.name, u.password_hash, u.created_at,
             u.email_verified_at, m.role_id
        FROM auth_users u
        JOIN auth_user_role_migration m ON m.user_id = u.id;
    DROP TABLE auth_user_permissions;
    DROP TABLE auth_users;
    ALTER TABLE auth_users_new RENAME TO auth_users;
    CREATE INDEX idx_auth_users_role ON auth_users(role_id);
    DROP TABLE auth_user_role_migration;
  `);
}

/**
 * SQLite cannot ALTER a CHECK constraint, so the table is rebuilt. Child
 * tables (steps, logs) keep their rows — foreign keys are off for the swap.
 */
function allowCancelledRunStatus(db: Database): void {
  db.run("PRAGMA foreign_keys = OFF");
  db.run(`
    CREATE TABLE task_runs_new (
      execution_id     TEXT PRIMARY KEY,
      task_id          TEXT NOT NULL,
      started_at       TEXT NOT NULL,
      finished_at      TEXT,
      duration_ms      INTEGER,
      status           TEXT NOT NULL
                       CHECK (status IN ('running', 'success', 'failure', 'cancelled')),
      dry_run          INTEGER NOT NULL DEFAULT 0,
      params           TEXT,
      items_seen       INTEGER,
      items_processed  INTEGER,
      items_skipped    INTEGER,
      error            TEXT
    )
  `);
  db.run("INSERT INTO task_runs_new SELECT * FROM task_runs");
  db.run("DROP TABLE task_runs");
  db.run("ALTER TABLE task_runs_new RENAME TO task_runs");
  db.run(`
    CREATE INDEX idx_task_runs_history
      ON task_runs (task_id, started_at DESC)
  `);
  db.run("PRAGMA foreign_keys = ON");
}

export interface AppliedMigration {
  version: number;
  name: string;
  appliedAt: string;
}

/**
 * Applies pending migrations in version order, each in its own transaction so a
 * failure leaves the database at the last complete version rather than halfway
 * through one.
 */
export function migrate(
  db: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): AppliedMigration[] {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db
      .query<{ version: number }, []>("SELECT version FROM schema_migrations")
      .all()
      .map((row) => row.version),
  );

  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((m) => !applied.has(m.version));

  const results: AppliedMigration[] = [];

  for (const migration of pending) {
    const appliedAt = new Date().toISOString();
    // db.transaction gives us the rollback; run() handles multi-statement SQL.
    db.transaction(() => {
      if (typeof migration.up === "function") {
        migration.up(db);
      } else {
        db.run(migration.up);
      }
      db.run(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        [migration.version, migration.name, appliedAt],
      );
    })();
    results.push({
      version: migration.version,
      name: migration.name,
      appliedAt,
    });
  }

  return results;
}

export function schemaVersion(db: Database): number {
  const row = db
    .query<{ version: number | null }, []>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    )
    .get();
  return row?.version ?? 0;
}
