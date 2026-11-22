import type { Database } from "bun:sqlite";
import type {
  AutomationFailureInboxItem,
  AutomationFailureInboxPage,
  AutomationFailureClaimResult,
  AutomationFailureClusterDetail,
  AutomationFailureClusterPage,
  AutomationFailureClusterSummary,
  AutomationFailureClusterWork,
  AutomationConfig,
  AutomationConfigRepository,
  AutomationJobRetryAttempt,
  AutomationJobRetryWave,
  AutomationFailedTestCase,
  AutomationPipelineCursor,
  AutomationPipelineJob,
  AutomationPipelineSnapshot,
  AutomationPipelineStatusRow,
  AutomationRepository,
  AutomationSchedule,
  AutomationTestReportCounts,
  AutomationTestSuite,
  ListAutomationFailureInboxOptions,
  ListAutomationFailureClustersOptions,
  ListAutomationPipelinesOptions,
} from "../application/ports.ts";
import { fromIso, fromJson, toIso, toJson } from "./database.ts";

export const AUTOMATION_FAILURE_TEXT_MAX_BYTES = 64 * 1024;

interface ConfigRow {
  project_id: string;
}

interface ConfigScheduleRow {
  schedule_id: number;
  display_name: string | null;
  auto_retry_enabled: number;
  auto_retry_max_jobs: number;
}

interface JiraConfigRow {
  project_key: string;
  parent_key: string | null;
  issue_type: string;
  board_id: number | null;
  use_active_sprint: number;
  assignee_mode: "automatic" | "fixed";
  fixed_assignee: string | null;
}

interface JiraLabelRow {
  label: string;
}

interface ScheduleRow {
  project_id: string;
  schedule_id: number;
  description: string;
  ref: string;
  cron: string | null;
  cron_timezone: string | null;
  next_run_at: string | null;
  active: number;
  synced_at: string;
}

interface ReportRow {
  total_time: number | null;
  total_count: number | null;
  success_count: number | null;
  failed_count: number | null;
  skipped_count: number | null;
  error_count: number | null;
  suite_error: string | null;
}

interface PipelineRow extends ReportRow {
  project_id: string;
  pipeline_id: number;
  schedule_id: number;
  status: string;
  ref: string;
  sha: string;
  web_url: string;
  created_at: string | null;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration: number | null;
  report_state: AutomationPipelineSnapshot["reportState"];
  report_version: number;
}

interface JobRow extends ReportRow {
  job_id: number;
  name: string;
  stage: string;
  status: string;
  failure_reason: string | null;
  allow_failure: number;
  web_url: string;
  duration: number | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

interface SuiteRow extends ReportRow {
  suite_index: number;
  name: string;
  build_ids_json: string;
}

interface FailedTestRow {
  suite_index: number;
  case_index: number;
  job_id: number | null;
  status: AutomationFailedTestCase["status"];
  name: string;
  classname: string | null;
  execution_time: number;
  system_output: string | null;
  stack_trace: string | null;
  test_file: string | null;
  attachment_job_id: number | null;
  attachment_path: string | null;
  attachment_name: string | null;
  signature_key: string;
  signature_title: string;
}

interface FailureClusterRow {
  project_id: string;
  pipeline_id: number;
  schedule_id: number;
  signature_key: string;
  signature_title: string;
  severity: "failed" | "error";
  occurrence_count: number;
  affected_test_count: number;
  sample_test_name: string;
  sample_classname: string | null;
  job_ids: string | null;
  suite_indexes: string;
  work_identity: string | null;
  work_state: "creating" | "ticketed" | "active-mr" | null;
  jira_key: string | null;
  jira_url: string | null;
  mr_iid: number | null;
  mr_url: string | null;
  claimed_at: string | null;
  work_created_at: string | null;
  work_updated_at: string | null;
}

interface FailureClusterWorkRow {
  project_id: string;
  schedule_id: number;
  signature_key: string;
  identity: string;
  state: "creating" | "ticketed" | "active-mr";
  jira_key: string | null;
  jira_url: string | null;
  mr_iid: number | null;
  mr_url: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface FailureInboxRow {
  project_id: string;
  schedule_id: number;
  signature_key: string;
  signature_title: string;
  severity: "failed" | "error";
  first_seen_at: string;
  last_seen_at: string;
  pipeline_count: number;
  latest_pipeline_id: number;
  latest_pipeline_url: string;
  latest_ref: string;
  latest_sha: string;
  latest_updated_at: string;
  occurrence_count: number;
  affected_test_count: number;
  sample_test_name: string;
  sample_classname: string | null;
  current_failure: number;
  work_identity: string | null;
  work_state: "creating" | "ticketed" | "active-mr" | null;
  jira_key: string | null;
  jira_url: string | null;
  mr_iid: number | null;
  mr_url: string | null;
  claimed_at: string | null;
  work_created_at: string | null;
  work_updated_at: string | null;
}

interface JobRetryWaveRow {
  project_id: string;
  pipeline_id: number;
  schedule_id: number;
  state: AutomationJobRetryWave["state"];
  execution_id: string;
  requested_at: string;
  completed_at: string | null;
  error: string | null;
}

interface JobRetryAttemptRow {
  project_id: string;
  pipeline_id: number;
  schedule_id: number;
  source_job_id: number;
  source_job_name: string;
  retry_job_id: number | null;
  retry_job_url: string | null;
  status: AutomationJobRetryAttempt["status"];
  error: string | null;
  requested_at: string;
  completed_at: string | null;
}

const REPORT_COLUMNS = `total_time, total_count, success_count, failed_count,
                        skipped_count, error_count, suite_error`;
const PIPELINE_COLUMNS = `project_id, pipeline_id, schedule_id, status, ref, sha,
                          web_url, created_at, updated_at, started_at, finished_at,
                          duration, report_state, report_version, ${REPORT_COLUMNS}`;
const SCHEDULE_COLUMNS = `project_id, schedule_id, description, ref, cron,
                          cron_timezone, next_run_at, active, synced_at`;

/**
 * The single instance-wide Automation source. The allowlist is stored as rows
 * so its order survives round-trips and can be replaced transactionally.
 */
export class SqliteAutomationConfigStore implements AutomationConfigRepository {
  constructor(private readonly db: Database) {}

  get(): AutomationConfig | null {
    return this.db.transaction(() => {
      const config = this.db
        .query<ConfigRow, []>("SELECT project_id FROM automation_config WHERE id = 1")
        .get();
      if (!config) return null;
      const schedules = this.db
        .query<ConfigScheduleRow, []>(
          `SELECT schedule_id, display_name, auto_retry_enabled,
                  auto_retry_max_jobs
             FROM automation_config_schedules
            WHERE config_id = 1
            ORDER BY position`,
        )
        .all()
        .map((row) => ({
          scheduleId: row.schedule_id,
          ...(row.display_name != null ? { displayName: row.display_name } : {}),
          autoRetry: {
            enabled: row.auto_retry_enabled === 1,
            maxJobsPerPipeline: row.auto_retry_max_jobs,
          },
        }));
      const jira = this.db
        .query<JiraConfigRow, []>(
          `SELECT project_key, parent_key, issue_type, board_id, use_active_sprint,
                  assignee_mode, fixed_assignee
             FROM automation_jira_config
            WHERE config_id = 1`,
        )
        .get();
      if (!jira) return { projectId: config.project_id, schedules };
      const labels = this.db
        .query<JiraLabelRow, []>(
          `SELECT label
             FROM automation_jira_labels
            WHERE config_id = 1
            ORDER BY position`,
        )
        .all()
        .map((row) => row.label);
      return {
        projectId: config.project_id,
        schedules,
        jira: {
          projectKey: jira.project_key,
          ...(jira.parent_key != null ? { parentKey: jira.parent_key } : {}),
          issueType: jira.issue_type,
          ...(jira.board_id != null ? { boardId: jira.board_id } : {}),
          useActiveSprint: jira.use_active_sprint === 1,
          labels,
          assigneeMode: jira.assignee_mode,
          ...(jira.fixed_assignee != null
            ? { fixedAssignee: jira.fixed_assignee }
            : {}),
        },
      };
    })();
  }

  set(config: AutomationConfig): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO automation_config (id, project_id, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           project_id = excluded.project_id,
           updated_at = excluded.updated_at`,
        [config.projectId, toIso(new Date())],
      );
      this.db.run("DELETE FROM automation_config_schedules WHERE config_id = 1");
      for (const [position, schedule] of config.schedules.entries()) {
        this.db.run(
          `INSERT INTO automation_config_schedules
             (config_id, position, schedule_id, display_name,
              auto_retry_enabled, auto_retry_max_jobs)
           VALUES (1, ?, ?, ?, ?, ?)`,
          [
            position,
            schedule.scheduleId,
            schedule.displayName ?? null,
            schedule.autoRetry?.enabled ? 1 : 0,
            schedule.autoRetry?.maxJobsPerPipeline ?? 3,
          ],
        );
      }

      this.db.run("DELETE FROM automation_jira_config WHERE config_id = 1");
      if (config.jira) {
        this.db.run(
          `INSERT INTO automation_jira_config
             (config_id, project_key, parent_key, issue_type, board_id,
              use_active_sprint, assignee_mode, fixed_assignee)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
          [
            config.jira.projectKey,
            config.jira.parentKey ?? null,
            config.jira.issueType,
            config.jira.boardId ?? null,
            config.jira.useActiveSprint ? 1 : 0,
            config.jira.assigneeMode,
            config.jira.fixedAssignee ?? null,
          ],
        );
        for (const [position, label] of config.jira.labels.entries()) {
          this.db.run(
            `INSERT INTO automation_jira_labels (config_id, position, label)
             VALUES (1, ?, ?)`,
            [position, label],
          );
        }
      }
    })();
  }
}

/**
 * Durable scheduled-pipeline snapshots. A pipeline and every child row form one
 * replaceable aggregate; callers never observe half of a re-scan.
 */
export class SqliteAutomationStore implements AutomationRepository {
  constructor(private readonly db: Database) {}

  upsertSchedule(schedule: AutomationSchedule): void {
    this.db.run(
      `INSERT INTO automation_schedules
         (project_id, schedule_id, description, ref, cron, cron_timezone,
          next_run_at, active, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, schedule_id) DO UPDATE SET
         description = excluded.description,
         ref = excluded.ref,
         cron = excluded.cron,
         cron_timezone = excluded.cron_timezone,
         next_run_at = excluded.next_run_at,
         active = excluded.active,
         synced_at = excluded.synced_at`,
      [
        schedule.projectId,
        schedule.scheduleId,
        schedule.description,
        schedule.ref,
        schedule.cron ?? null,
        schedule.cronTimezone ?? null,
        schedule.nextRunAt ? toIso(schedule.nextRunAt) : null,
        schedule.active ? 1 : 0,
        toIso(schedule.syncedAt),
      ],
    );
  }

  recordPipeline(snapshot: AutomationPipelineSnapshot): void {
    this.db.transaction(() => {
      const previousSignatures = new Set(
        this.db
          .query<{ signature_key: string }, [string, number]>(
            `SELECT DISTINCT signature_key
               FROM automation_pipeline_failed_tests
              WHERE project_id = ? AND pipeline_id = ?`,
          )
          .all(snapshot.projectId, snapshot.pipelineId)
          .map((row) => row.signature_key),
      );
      const report = reportParams(snapshot.report);
      this.db.run(
        `INSERT INTO automation_pipelines
           (project_id, pipeline_id, schedule_id, status, ref, sha, web_url,
            created_at, updated_at, started_at, finished_at, duration, report_state,
            report_version, total_time, total_count, success_count, failed_count,
            skipped_count, error_count, suite_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, pipeline_id) DO UPDATE SET
           schedule_id = excluded.schedule_id,
           status = excluded.status,
           ref = excluded.ref,
           sha = excluded.sha,
           web_url = excluded.web_url,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at,
           duration = excluded.duration,
           report_state = excluded.report_state,
           report_version = excluded.report_version,
           total_time = excluded.total_time,
           total_count = excluded.total_count,
           success_count = excluded.success_count,
           failed_count = excluded.failed_count,
           skipped_count = excluded.skipped_count,
           error_count = excluded.error_count,
           suite_error = excluded.suite_error`,
        [
          snapshot.projectId,
          snapshot.pipelineId,
          snapshot.scheduleId,
          snapshot.status,
          snapshot.ref,
          snapshot.sha,
          snapshot.webUrl,
          snapshot.createdAt ? toIso(snapshot.createdAt) : null,
          toIso(snapshot.updatedAt),
          snapshot.startedAt ? toIso(snapshot.startedAt) : null,
          snapshot.finishedAt ? toIso(snapshot.finishedAt) : null,
          snapshot.duration ?? null,
          snapshot.reportState,
          snapshot.reportVersion,
          ...report,
        ],
      );

      // Delete explicitly even though the FK cascades: the parent was updated,
      // not deleted, and a re-scan is a complete replacement of all children.
      this.db.run(
        "DELETE FROM automation_pipeline_failed_tests WHERE project_id = ? AND pipeline_id = ?",
        [snapshot.projectId, snapshot.pipelineId],
      );
      this.db.run(
        "DELETE FROM automation_pipeline_test_suites WHERE project_id = ? AND pipeline_id = ?",
        [snapshot.projectId, snapshot.pipelineId],
      );
      this.db.run(
        "DELETE FROM automation_pipeline_jobs WHERE project_id = ? AND pipeline_id = ?",
        [snapshot.projectId, snapshot.pipelineId],
      );

      for (const job of snapshot.jobs) this.insertJob(snapshot, job);
      for (const suite of snapshot.suites) this.insertSuite(snapshot, suite);

      const nextCaseIndex = new Map<number, number>();
      for (const test of snapshot.failedTests) {
        // The domain only retains actionable cases. Keep the runtime guard even
        // though the TypeScript union also prevents success/skipped callers.
        if (test.status !== "failed" && test.status !== "error") continue;
        const derived = nextCaseIndex.get(test.suiteIndex) ?? 0;
        const caseIndex = test.caseIndex ?? derived;
        nextCaseIndex.set(test.suiteIndex, Math.max(derived, caseIndex + 1));
        this.db.run(
          `INSERT INTO automation_pipeline_failed_tests
             (project_id, pipeline_id, suite_index, case_index, job_id, status,
              name, classname, execution_time, system_output, stack_trace,
              test_file, attachment_job_id, attachment_path, attachment_name,
              signature_key, signature_title)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            snapshot.projectId,
            snapshot.pipelineId,
            test.suiteIndex,
            caseIndex,
            test.jobId ?? null,
            test.status,
            test.name,
            test.classname ?? null,
            test.executionTime,
            boundFailureText(test.systemOutput),
            boundFailureText(test.stackTrace),
            test.testFile ?? null,
            test.attachmentJobId ?? null,
            test.attachmentPath ?? null,
            test.attachmentName ?? null,
            test.signatureKey,
            test.signatureTitle,
          ],
        );
      }
      this.recordFailureInboxSightings(snapshot, previousSignatures);
    })();
  }

  private recordFailureInboxSightings(
    snapshot: AutomationPipelineSnapshot,
    previousSignatures: ReadonlySet<string>,
  ): void {
    const groups = new Map<
      string,
      {
        title: string;
        severity: "failed" | "error";
        occurrences: number;
        tests: Set<string>;
        sampleName: string;
        sampleClassname?: string;
      }
    >();
    for (const test of snapshot.failedTests) {
      if (test.signatureKey.startsWith("legacy-v1:")) continue;
      const current = groups.get(test.signatureKey);
      const identity = `${test.classname ?? ""}\u001f${test.name}`;
      if (current) {
        current.occurrences += 1;
        current.tests.add(identity);
        if (test.status === "error") current.severity = "error";
        if (test.signatureTitle.localeCompare(current.title) < 0) {
          current.title = test.signatureTitle;
        }
        if (test.name.localeCompare(current.sampleName) < 0) {
          current.sampleName = test.name;
          current.sampleClassname = test.classname;
        }
      } else {
        groups.set(test.signatureKey, {
          title: test.signatureTitle,
          severity: test.status,
          occurrences: 1,
          tests: new Set([identity]),
          sampleName: test.name,
          ...(test.classname ? { sampleClassname: test.classname } : {}),
        });
      }
    }

    const seenAt = toIso(snapshot.updatedAt);
    for (const [signatureKey, group] of groups) {
      const pipelineIncrement = previousSignatures.has(signatureKey) ? 0 : 1;
      this.db.run(
        `INSERT INTO automation_failure_inbox (
           project_id, schedule_id, signature_key, signature_title, severity,
           first_seen_at, last_seen_at, pipeline_count, latest_pipeline_id,
           latest_pipeline_url, latest_ref, latest_sha, latest_updated_at,
           occurrence_count, affected_test_count, sample_test_name,
           sample_classname
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, schedule_id, signature_key) DO UPDATE SET
           first_seen_at = MIN(automation_failure_inbox.first_seen_at, excluded.first_seen_at),
           last_seen_at = MAX(automation_failure_inbox.last_seen_at, excluded.last_seen_at),
           pipeline_count = automation_failure_inbox.pipeline_count + ?,
           signature_title = CASE
             WHEN excluded.latest_updated_at >= automation_failure_inbox.latest_updated_at
             THEN excluded.signature_title ELSE automation_failure_inbox.signature_title END,
           severity = CASE
             WHEN excluded.latest_updated_at >= automation_failure_inbox.latest_updated_at
             THEN excluded.severity ELSE automation_failure_inbox.severity END,
           latest_pipeline_id = CASE
             WHEN excluded.latest_updated_at >= automation_failure_inbox.latest_updated_at
             THEN excluded.latest_pipeline_id ELSE automation_failure_inbox.latest_pipeline_id END,
           latest_pipeline_url = CASE
             WHEN excluded.latest_updated_at >= automation_failure_inbox.latest_updated_at
             THEN excluded.latest_pipeline_url ELSE automation_failure_inbox.latest_pipeline_url END,
           latest_ref = CASE
             WHEN excluded.latest_updated_at >= automation_failure_inbox.latest_updated_at
             THEN excluded.latest_ref ELSE automation_failure_inbox.latest_ref END,
           latest_sha = CASE
             WHEN excluded.latest_updated_at >= automation_failure_inbox.latest_updated_at
             THEN excluded.latest_sha ELSE automation_failure_inbox.latest_sha END,
           latest_updated_at = MAX(
             automation_failure_inbox.latest_updated_at,
             excluded.latest_updated_at
           ),
           occurrence_count = CASE
             WHEN excluded.latest_updated_at >= automation_failure_inbox.latest_updated_at
             THEN excluded.occurrence_count ELSE automation_failure_inbox.occurrence_count END,
           affected_test_count = CASE
             WHEN excluded.latest_updated_at >= automation_failure_inbox.latest_updated_at
             THEN excluded.affected_test_count ELSE automation_failure_inbox.affected_test_count END,
           sample_test_name = CASE
             WHEN excluded.latest_updated_at >= automation_failure_inbox.latest_updated_at
             THEN excluded.sample_test_name ELSE automation_failure_inbox.sample_test_name END,
           sample_classname = CASE
             WHEN excluded.latest_updated_at >= automation_failure_inbox.latest_updated_at
             THEN excluded.sample_classname ELSE automation_failure_inbox.sample_classname END`,
        [
          snapshot.projectId,
          snapshot.scheduleId,
          signatureKey,
          group.title,
          group.severity,
          seenAt,
          seenAt,
          snapshot.pipelineId,
          snapshot.webUrl,
          snapshot.ref,
          snapshot.sha,
          seenAt,
          group.occurrences,
          group.tests.size,
          group.sampleName,
          group.sampleClassname ?? null,
          pipelineIncrement,
        ],
      );
    }
  }

  latestUpdatedCursor(
    projectId: string,
    scheduleId: number,
  ): AutomationPipelineCursor | null {
    const row = this.db
      .query<{ updated_at: string; pipeline_id: number }, [string, number]>(
        `SELECT updated_at, pipeline_id
           FROM automation_pipelines
          WHERE project_id = ? AND schedule_id = ?
          ORDER BY updated_at DESC, pipeline_id DESC
          LIMIT 1`,
      )
      .get(projectId, scheduleId);
    return row ? { updatedAt: fromIso(row.updated_at), pipelineId: row.pipeline_id } : null;
  }

  listSchedules(projectId?: string): AutomationSchedule[] {
    const rows = projectId
      ? this.db
          .query<ScheduleRow, [string]>(
            `SELECT ${SCHEDULE_COLUMNS} FROM automation_schedules
              WHERE project_id = ?
              ORDER BY schedule_id`,
          )
          .all(projectId)
      : this.db
          .query<ScheduleRow, []>(
            `SELECT ${SCHEDULE_COLUMNS} FROM automation_schedules
              ORDER BY project_id, schedule_id`,
          )
          .all();
    return rows.map(toSchedule);
  }

  listPipelines(options: ListAutomationPipelinesOptions): AutomationPipelineSnapshot[] {
    const clauses = ["project_id = ?"];
    const params: Array<string | number> = [options.projectId];
    if (options.scheduleId != null) {
      clauses.push("schedule_id = ?");
      params.push(options.scheduleId);
    }
    if (options.status != null) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.reportStates?.length) {
      clauses.push(
        `report_state IN (${options.reportStates.map(() => "?").join(", ")})`,
      );
      params.push(...options.reportStates);
    }
    if (options.reportVersionBelow != null) {
      clauses.push("report_version < ?");
      params.push(options.reportVersionBelow);
    }
    if (options.from) {
      clauses.push("updated_at >= ?");
      params.push(toIso(options.from));
    }
    if (options.to) {
      clauses.push("updated_at <= ?");
      params.push(toIso(options.to));
    }
    const limit = options.limit == null ? "" : " LIMIT ?";
    if (options.limit != null) params.push(Math.max(0, options.limit));

    const rows = this.db
      .query<PipelineRow, Array<string | number>>(
        `SELECT ${PIPELINE_COLUMNS}
           FROM automation_pipelines
          WHERE ${clauses.join(" AND ")}
          ORDER BY updated_at DESC, pipeline_id DESC${limit}`,
      )
      .all(...params);
    return rows.map((row) => this.toPipeline(row));
  }

  listPipelineStatuses(options: {
    projectId: string;
    from?: Date;
    limit: number;
  }): AutomationPipelineStatusRow[] {
    const clauses = ["project_id = ?"];
    const params: Array<string | number> = [options.projectId];
    if (options.from) {
      clauses.push("updated_at >= ?");
      params.push(toIso(options.from));
    }
    params.push(Math.max(0, options.limit));
    const rows = this.db
      .query<
        {
          project_id: string;
          pipeline_id: number;
          status: string;
          ref: string;
          web_url: string;
          created_at: string | null;
          updated_at: string;
        },
        Array<string | number>
      >(
        `SELECT project_id, pipeline_id, status, ref, web_url, created_at, updated_at
           FROM automation_pipelines
          WHERE ${clauses.join(" AND ")}
          ORDER BY updated_at DESC, pipeline_id DESC
          LIMIT ?`,
      )
      .all(...params);
    return rows.map((row) => ({
      projectId: row.project_id,
      pipelineId: row.pipeline_id,
      status: row.status,
      ref: row.ref,
      webUrl: row.web_url,
      ...(row.created_at ? { createdAt: fromIso(row.created_at) } : {}),
      updatedAt: fromIso(row.updated_at),
    }));
  }

  getPipeline(
    projectId: string,
    pipelineId: number,
    options: { includeFailureDiagnostics?: boolean } = {},
  ): AutomationPipelineSnapshot | undefined {
    const row = this.db
      .query<PipelineRow, [string, number]>(
        `SELECT ${PIPELINE_COLUMNS}
           FROM automation_pipelines
          WHERE project_id = ? AND pipeline_id = ?`,
      )
      .get(projectId, pipelineId);
    return row
      ? this.toPipeline(row, options.includeFailureDiagnostics !== false)
      : undefined;
  }

  listFailureClusters(
    options: ListAutomationFailureClustersOptions,
  ): AutomationFailureClusterPage {
    const filters: string[] = [];
    const filterParams: Array<string | number> = [];
    const occurrenceFilter = (condition: string, params: Array<string | number>): void => {
      filters.push(
        `EXISTS (
           SELECT 1
             FROM automation_pipeline_failed_tests f2
             LEFT JOIN automation_pipeline_jobs j2
               ON j2.project_id = f2.project_id
              AND j2.pipeline_id = f2.pipeline_id
              AND j2.job_id = f2.job_id
            WHERE f2.project_id = c.project_id
              AND f2.pipeline_id = c.pipeline_id
              AND f2.signature_key = c.signature_key
              AND ${condition}
         )`,
      );
      filterParams.push(...params);
    };

    if (options.search) {
      const search = `%${escapeLike(options.search.toLocaleLowerCase())}%`;
      occurrenceFilter(
        `(lower(f2.signature_title) LIKE ? ESCAPE '\\'
          OR lower(f2.name) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(f2.classname, '')) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(j2.name, '')) LIKE ? ESCAPE '\\')`,
        [search, search, search, search],
      );
    }
    if (options.jobId != null) {
      occurrenceFilter("f2.job_id = ?", [options.jobId]);
    }
    if (options.suiteIndex != null) {
      occurrenceFilter("f2.suite_index = ?", [options.suiteIndex]);
    }
    if (options.triageState) {
      const state =
        options.triageState === "untriaged"
          ? "(w.state IS NULL OR w.state = 'creating')"
          : options.triageState === "ticketed"
            ? "w.state = 'ticketed'"
            : "w.state = 'active-mr'";
      filters.push(state);
    }

    const cte = `
      WITH clusters AS (
        SELECT p.project_id, p.pipeline_id, p.schedule_id, f.signature_key,
               MIN(f.signature_title) AS signature_title,
               CASE WHEN MAX(CASE WHEN f.status = 'error' THEN 1 ELSE 0 END) = 1
                    THEN 'error' ELSE 'failed' END AS severity,
               COUNT(*) AS occurrence_count,
               COUNT(DISTINCT COALESCE(f.classname, '') || char(31) || f.name)
                 AS affected_test_count,
               MIN(f.name) AS sample_test_name,
               MIN(f.classname) AS sample_classname,
               GROUP_CONCAT(DISTINCT f.job_id) AS job_ids,
               GROUP_CONCAT(DISTINCT f.suite_index) AS suite_indexes
          FROM automation_pipelines p
          JOIN automation_pipeline_failed_tests f
            ON f.project_id = p.project_id AND f.pipeline_id = p.pipeline_id
         WHERE p.project_id = ? AND p.pipeline_id = ?
         GROUP BY p.project_id, p.pipeline_id, p.schedule_id, f.signature_key
      ),
      visible AS (
        SELECT c.*,
               w.identity AS work_identity, w.state AS work_state,
               w.jira_key, w.jira_url, w.mr_iid, w.mr_url,
               w.claimed_at, w.created_at AS work_created_at,
               w.updated_at AS work_updated_at
          FROM clusters c
          LEFT JOIN automation_failure_cluster_work w
            ON w.project_id = c.project_id
           AND w.schedule_id = c.schedule_id
           AND w.signature_key = c.signature_key
          ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
      )`;
    const params: Array<string | number> = [
      options.projectId,
      options.pipelineId,
      ...filterParams,
    ];
    const total =
      this.db
        .query<{ count: number }, Array<string | number>>(
          `${cte} SELECT COUNT(*) AS count FROM visible`,
        )
        .get(...params)?.count ?? 0;
    const rows = this.db
      .query<FailureClusterRow, Array<string | number>>(
        `${cte}
         SELECT * FROM visible
          ORDER BY CASE severity WHEN 'error' THEN 1 ELSE 0 END DESC,
                   occurrence_count DESC, signature_key ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, options.limit, options.offset);

    const stateRows = this.db
      .query<{ state: string; count: number }, Array<string | number>>(
        `${cte}
         SELECT CASE
                  WHEN work_state = 'active-mr' THEN 'active-mr'
                  WHEN work_state = 'ticketed' THEN 'ticketed'
                  ELSE 'untriaged'
                END AS state,
                COUNT(*) AS count
           FROM visible
          GROUP BY state`,
      )
      .all(...params);
    const states = { untriaged: 0, ticketed: 0, "active-mr": 0 };
    for (const row of stateRows) {
      if (row.state in states) {
        states[row.state as keyof typeof states] = row.count;
      }
    }
    const jobs = this.db
      .query<{ job_id: number; name: string; count: number }, [string, number]>(
        `SELECT f.job_id, COALESCE(j.name, 'Job ' || f.job_id) AS name,
                COUNT(DISTINCT f.signature_key) AS count
           FROM automation_pipeline_failed_tests f
           LEFT JOIN automation_pipeline_jobs j
             ON j.project_id = f.project_id
            AND j.pipeline_id = f.pipeline_id
            AND j.job_id = f.job_id
          WHERE f.project_id = ? AND f.pipeline_id = ? AND f.job_id IS NOT NULL
          GROUP BY f.job_id, j.name
          ORDER BY j.name, f.job_id`,
      )
      .all(options.projectId, options.pipelineId)
      .map((row) => ({ jobId: row.job_id, name: row.name, count: row.count }));
    const suites = this.db
      .query<
        { suite_index: number; name: string; count: number },
        [string, number]
      >(
        `SELECT f.suite_index, COALESCE(s.name, 'Suite ' || f.suite_index) AS name,
                COUNT(DISTINCT f.signature_key) AS count
           FROM automation_pipeline_failed_tests f
           LEFT JOIN automation_pipeline_test_suites s
             ON s.project_id = f.project_id
            AND s.pipeline_id = f.pipeline_id
            AND s.suite_index = f.suite_index
          WHERE f.project_id = ? AND f.pipeline_id = ?
          GROUP BY f.suite_index, s.name
          ORDER BY f.suite_index`,
      )
      .all(options.projectId, options.pipelineId)
      .map((row) => ({
        suiteIndex: row.suite_index,
        name: row.name,
        count: row.count,
      }));

    return {
      items: rows.map(toFailureClusterSummary),
      total,
      facets: { states, jobs, suites },
    };
  }

  listFailureInbox(
    options: ListAutomationFailureInboxOptions,
  ): AutomationFailureInboxPage {
    if (options.scheduleIds.length === 0) {
      return {
        items: [],
        total: 0,
        facets: {
          states: { untriaged: 0, ticketed: 0, "active-mr": 0 },
          schedules: [],
          current: 0,
          recent: 0,
        },
      };
    }

    const conditions = [
      "i.project_id = ?",
      `i.schedule_id IN (${options.scheduleIds.map(() => "?").join(", ")})`,
      "i.last_seen_at >= ?",
    ];
    const filterParams: Array<string | number> = [
      options.projectId,
      ...options.scheduleIds,
      toIso(options.from),
    ];
    if (options.scheduleId != null) {
      conditions.push("i.schedule_id = ?");
      filterParams.push(options.scheduleId);
    }
    if (options.pipelineId != null) {
      conditions.push(
        `EXISTS (
           SELECT 1
             FROM automation_pipelines fp
             JOIN automation_pipeline_failed_tests ff
               ON ff.project_id = fp.project_id
              AND ff.pipeline_id = fp.pipeline_id
            WHERE fp.project_id = i.project_id
              AND fp.schedule_id = i.schedule_id
              AND fp.pipeline_id = ?
              AND ff.signature_key = i.signature_key
         )`,
      );
      filterParams.push(options.pipelineId);
    }
    if (options.search) {
      const search = `%${escapeLike(options.search.toLocaleLowerCase())}%`;
      conditions.push(
        `(lower(i.signature_title) LIKE ? ESCAPE '\\'
          OR lower(i.sample_test_name) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(i.sample_classname, '')) LIKE ? ESCAPE '\\')`,
      );
      filterParams.push(search, search, search);
    }
    if (options.triageState) {
      conditions.push(
        options.triageState === "untriaged"
          ? "(w.state IS NULL OR w.state = 'creating')"
          : options.triageState === "ticketed"
            ? "w.state = 'ticketed'"
            : "w.state = 'active-mr'",
      );
    }

    const currentExpression = `EXISTS (
      SELECT 1
        FROM automation_pipeline_failed_tests cf
       WHERE cf.project_id = i.project_id
         AND cf.signature_key = i.signature_key
         AND cf.pipeline_id = (
           SELECT cp.pipeline_id
             FROM automation_pipelines cp
            WHERE cp.project_id = i.project_id
              AND cp.schedule_id = i.schedule_id
              AND cp.report_state = 'complete'
            ORDER BY cp.updated_at DESC, cp.pipeline_id DESC
            LIMIT 1
         )
    )`;
    const cte = `
      WITH filtered AS (
        SELECT i.*,
               CASE WHEN ${currentExpression} THEN 1 ELSE 0 END AS current_failure,
               w.identity AS work_identity, w.state AS work_state,
               w.jira_key, w.jira_url, w.mr_iid, w.mr_url,
               w.claimed_at, w.created_at AS work_created_at,
               w.updated_at AS work_updated_at
          FROM automation_failure_inbox i
          LEFT JOIN automation_failure_cluster_work w
            ON w.project_id = i.project_id
           AND w.schedule_id = i.schedule_id
           AND w.signature_key = i.signature_key
         WHERE ${conditions.join(" AND ")}
      ),
      visible AS (
        SELECT * FROM filtered
        ${options.presence === "current" ? "WHERE current_failure = 1" : ""}
      )`;
    const total =
      this.db
        .query<{ count: number }, Array<string | number>>(
          `${cte} SELECT COUNT(*) AS count FROM visible`,
        )
        .get(...filterParams)?.count ?? 0;
    const rows = this.db
      .query<FailureInboxRow, Array<string | number>>(
        `${cte}
         SELECT * FROM visible
          ORDER BY current_failure DESC, last_seen_at DESC,
                   CASE severity WHEN 'error' THEN 1 ELSE 0 END DESC,
                   signature_key ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...filterParams, options.limit, options.offset);
    const stateRows = this.db
      .query<{ state: string; count: number }, Array<string | number>>(
        `${cte}
         SELECT CASE
                  WHEN work_state = 'active-mr' THEN 'active-mr'
                  WHEN work_state = 'ticketed' THEN 'ticketed'
                  ELSE 'untriaged'
                END AS state,
                COUNT(*) AS count
           FROM visible
          GROUP BY state`,
      )
      .all(...filterParams);
    const states = { untriaged: 0, ticketed: 0, "active-mr": 0 };
    for (const row of stateRows) {
      if (row.state in states) {
        states[row.state as keyof typeof states] = row.count;
      }
    }
    const schedules = this.db
      .query<{ schedule_id: number; count: number }, Array<string | number>>(
        `${cte}
         SELECT schedule_id, COUNT(*) AS count
           FROM visible
          GROUP BY schedule_id
          ORDER BY schedule_id`,
      )
      .all(...filterParams)
      .map((row) => ({ scheduleId: row.schedule_id, count: row.count }));
    const presence = this.db
      .query<{ current_count: number; recent_count: number }, Array<string | number>>(
        `${cte}
         SELECT SUM(current_failure) AS current_count, COUNT(*) AS recent_count
           FROM filtered`,
      )
      .get(...filterParams);

    return {
      items: rows.map(toFailureInboxItem),
      total,
      facets: {
        states,
        schedules,
        current: presence?.current_count ?? 0,
        recent: presence?.recent_count ?? 0,
      },
    };
  }

  claimJobRetryWave(input: {
    projectId: string;
    pipelineId: number;
    scheduleId: number;
    executionId: string;
    jobs: ReadonlyArray<{ jobId: number; name: string }>;
    now: Date;
  }): boolean {
    return this.db.transaction(() => {
      const requestedAt = toIso(input.now);
      const claimed =
        this.db.run(
          `INSERT INTO automation_job_retry_waves
             (project_id, pipeline_id, schedule_id, state, execution_id,
              requested_at)
           VALUES (?, ?, ?, 'claimed', ?, ?)
           ON CONFLICT (project_id, pipeline_id) DO NOTHING`,
          [
            input.projectId,
            input.pipelineId,
            input.scheduleId,
            input.executionId,
            requestedAt,
          ],
        ).changes > 0;
      if (!claimed) return false;
      for (const job of input.jobs) {
        this.db.run(
          `INSERT INTO automation_job_retry_attempts
             (project_id, pipeline_id, schedule_id, source_job_id,
              source_job_name, status, requested_at)
           VALUES (?, ?, ?, ?, ?, 'requested', ?)`,
          [
            input.projectId,
            input.pipelineId,
            input.scheduleId,
            job.jobId,
            job.name,
            requestedAt,
          ],
        );
      }
      return true;
    })();
  }

  recordJobRetryAttemptResult(input: {
    projectId: string;
    pipelineId: number;
    sourceJobId: number;
    retryJobId?: number;
    retryJobUrl?: string;
    error?: string;
    now: Date;
  }): void {
    const failed = input.error != null;
    this.db.run(
      `UPDATE automation_job_retry_attempts
          SET status = ?, retry_job_id = ?, retry_job_url = ?, error = ?,
              completed_at = ?
        WHERE project_id = ? AND pipeline_id = ? AND source_job_id = ?
          AND status = 'requested'`,
      [
        failed ? "failed" : "accepted",
        input.retryJobId ?? null,
        input.retryJobUrl ?? null,
        input.error ?? null,
        toIso(input.now),
        input.projectId,
        input.pipelineId,
        input.sourceJobId,
      ],
    );
  }

  completeJobRetryWave(input: {
    projectId: string;
    pipelineId: number;
    state: "complete" | "partial" | "failed";
    error?: string;
    now: Date;
  }): void {
    this.db.run(
      `UPDATE automation_job_retry_waves
          SET state = ?, completed_at = ?, error = ?
        WHERE project_id = ? AND pipeline_id = ? AND state = 'claimed'`,
      [
        input.state,
        toIso(input.now),
        input.error ?? null,
        input.projectId,
        input.pipelineId,
      ],
    );
  }

  getJobRetryWave(
    projectId: string,
    pipelineId: number,
  ): AutomationJobRetryWave | undefined {
    const wave = this.db
      .query<JobRetryWaveRow, [string, number]>(
        `SELECT project_id, pipeline_id, schedule_id, state, execution_id,
                requested_at, completed_at, error
           FROM automation_job_retry_waves
          WHERE project_id = ? AND pipeline_id = ?`,
      )
      .get(projectId, pipelineId);
    if (!wave) return undefined;
    const attempts = this.db
      .query<JobRetryAttemptRow, [string, number]>(
        `SELECT project_id, pipeline_id, schedule_id, source_job_id,
                source_job_name, retry_job_id, retry_job_url, status, error,
                requested_at, completed_at
           FROM automation_job_retry_attempts
          WHERE project_id = ? AND pipeline_id = ?
          ORDER BY source_job_id`,
      )
      .all(projectId, pipelineId)
      .map(toJobRetryAttempt);
    return {
      projectId: wave.project_id,
      pipelineId: wave.pipeline_id,
      scheduleId: wave.schedule_id,
      state: wave.state,
      executionId: wave.execution_id,
      requestedAt: fromIso(wave.requested_at),
      ...(wave.completed_at != null
        ? { completedAt: fromIso(wave.completed_at) }
        : {}),
      ...(wave.error != null ? { error: wave.error } : {}),
      attempts,
    };
  }

  getFailureCluster(
    projectId: string,
    pipelineId: number,
    signatureKey: string,
    memberLimit: number,
  ): AutomationFailureClusterDetail | undefined {
    const row = this.db
      .query<FailureClusterRow & { web_url: string }, [string, number, string]>(
        `SELECT p.project_id, p.pipeline_id, p.schedule_id, p.web_url,
                f.signature_key, MIN(f.signature_title) AS signature_title,
                CASE WHEN MAX(CASE WHEN f.status = 'error' THEN 1 ELSE 0 END) = 1
                     THEN 'error' ELSE 'failed' END AS severity,
                COUNT(*) AS occurrence_count,
                COUNT(DISTINCT COALESCE(f.classname, '') || char(31) || f.name)
                  AS affected_test_count,
                MIN(f.name) AS sample_test_name,
                MIN(f.classname) AS sample_classname,
                GROUP_CONCAT(DISTINCT f.job_id) AS job_ids,
                GROUP_CONCAT(DISTINCT f.suite_index) AS suite_indexes,
                w.identity AS work_identity, w.state AS work_state,
                w.jira_key, w.jira_url, w.mr_iid, w.mr_url,
                w.claimed_at, w.created_at AS work_created_at,
                w.updated_at AS work_updated_at
           FROM automation_pipelines p
           JOIN automation_pipeline_failed_tests f
             ON f.project_id = p.project_id AND f.pipeline_id = p.pipeline_id
           LEFT JOIN automation_failure_cluster_work w
             ON w.project_id = p.project_id
            AND w.schedule_id = p.schedule_id
            AND w.signature_key = f.signature_key
          WHERE p.project_id = ? AND p.pipeline_id = ? AND f.signature_key = ?
          GROUP BY p.project_id, p.pipeline_id, p.schedule_id, p.web_url,
                   f.signature_key`,
      )
      .get(projectId, pipelineId, signatureKey);
    if (!row) return undefined;

    const memberRows = this.db
      .query<
        {
          suite_index: number;
          suite_name: string;
          case_index: number;
          job_id: number | null;
          job_name: string | null;
          job_url: string | null;
          status: "failed" | "error";
          name: string;
          classname: string | null;
          execution_time: number;
          test_file: string | null;
          attachment_job_id: number | null;
          attachment_path: string | null;
          attachment_name: string | null;
        },
        [string, number, string, number]
      >(
        `SELECT f.suite_index, COALESCE(s.name, 'Suite ' || f.suite_index) AS suite_name,
                f.case_index, f.job_id, j.name AS job_name, j.web_url AS job_url,
                f.status, f.name, f.classname, f.execution_time, f.test_file,
                f.attachment_job_id, f.attachment_path, f.attachment_name
           FROM automation_pipeline_failed_tests f
           LEFT JOIN automation_pipeline_jobs j
             ON j.project_id = f.project_id
            AND j.pipeline_id = f.pipeline_id
            AND j.job_id = f.job_id
           LEFT JOIN automation_pipeline_test_suites s
             ON s.project_id = f.project_id
            AND s.pipeline_id = f.pipeline_id
            AND s.suite_index = f.suite_index
          WHERE f.project_id = ? AND f.pipeline_id = ? AND f.signature_key = ?
          ORDER BY CASE f.status WHEN 'error' THEN 1 ELSE 0 END DESC,
                   f.suite_index, f.case_index
          LIMIT ?`,
      )
      .all(projectId, pipelineId, signatureKey, memberLimit + 1);
    const representative = this.db
      .query<
        {
          suite_index: number;
          case_index: number;
          system_output: string | null;
          stack_trace: string | null;
        },
        [string, number, string]
      >(
        `SELECT suite_index, case_index, system_output, stack_trace
           FROM automation_pipeline_failed_tests
          WHERE project_id = ? AND pipeline_id = ? AND signature_key = ?
          ORDER BY CASE WHEN system_output IS NOT NULL OR stack_trace IS NOT NULL
                        THEN 1 ELSE 0 END DESC,
                   CASE status WHEN 'error' THEN 1 ELSE 0 END DESC,
                   suite_index, case_index
          LIMIT 1`,
      )
      .get(projectId, pipelineId, signatureKey);
    if (!representative || memberRows.length === 0) return undefined;

    return {
      ...toFailureClusterSummary(row),
      pipelineUrl: row.web_url,
      members: memberRows.slice(0, memberLimit).map((member) => ({
        suiteIndex: member.suite_index,
        suiteName: member.suite_name,
        caseIndex: member.case_index,
        ...(member.job_id != null ? { jobId: member.job_id } : {}),
        ...(member.job_name != null ? { jobName: member.job_name } : {}),
        ...(member.job_url != null ? { jobUrl: member.job_url } : {}),
        status: member.status,
        name: member.name,
        ...(member.classname != null ? { classname: member.classname } : {}),
        executionTime: member.execution_time,
        ...(member.test_file != null ? { testFile: member.test_file } : {}),
        ...(member.attachment_job_id != null
          ? { attachmentJobId: member.attachment_job_id }
          : {}),
        ...(member.attachment_path != null
          ? { attachmentPath: member.attachment_path }
          : {}),
        ...(member.attachment_name != null
          ? { attachmentName: member.attachment_name }
          : {}),
      })),
      membersTruncated: memberRows.length > memberLimit,
      representative: {
        suiteIndex: representative.suite_index,
        caseIndex: representative.case_index,
        ...(representative.system_output != null
          ? { systemOutput: representative.system_output }
          : {}),
        ...(representative.stack_trace != null
          ? { stackTrace: representative.stack_trace }
          : {}),
      },
    };
  }

  getFailureClusterWork(
    projectId: string,
    scheduleId: number,
    signatureKey: string,
  ): AutomationFailureClusterWork | undefined {
    const row = this.db
      .query<FailureClusterWorkRow, [string, number, string]>(
        `SELECT project_id, schedule_id, signature_key, identity, state,
                jira_key, jira_url, mr_iid, mr_url, claimed_at, created_at, updated_at
           FROM automation_failure_cluster_work
          WHERE project_id = ? AND schedule_id = ? AND signature_key = ?`,
      )
      .get(projectId, scheduleId, signatureKey);
    return row ? toFailureClusterWork(row) : undefined;
  }

  claimFailureCluster(
    projectId: string,
    scheduleId: number,
    signatureKey: string,
    identity: string,
    now: Date,
    staleBefore: Date,
  ): AutomationFailureClaimResult {
    return this.db.transaction(() => {
      const timestamp = toIso(now);
      const inserted = this.db.run(
        `INSERT OR IGNORE INTO automation_failure_cluster_work
           (project_id, schedule_id, signature_key, identity, state,
            claimed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'creating', ?, ?, ?)`,
        [projectId, scheduleId, signatureKey, identity, timestamp, timestamp, timestamp],
      ).changes > 0;
      if (inserted) {
        return {
          claimed: true,
          recovered: false,
          work: this.getFailureClusterWork(projectId, scheduleId, signatureKey)!,
        };
      }

      const current = this.getFailureClusterWork(projectId, scheduleId, signatureKey);
      if (!current) {
        throw new Error(
          `Automation failure identity collision for '${identity}'.`,
        );
      }
      const recovered =
        current.state === "creating" &&
        current.claimedAt != null &&
        current.claimedAt <= staleBefore &&
        this.db.run(
          `UPDATE automation_failure_cluster_work
              SET claimed_at = ?, updated_at = ?
            WHERE project_id = ? AND schedule_id = ? AND signature_key = ?
              AND state = 'creating' AND claimed_at <= ?`,
          [
            timestamp,
            timestamp,
            projectId,
            scheduleId,
            signatureKey,
            toIso(staleBefore),
          ],
        ).changes > 0;
      return {
        claimed: recovered,
        recovered,
        work: this.getFailureClusterWork(projectId, scheduleId, signatureKey)!,
      };
    })();
  }

  releaseFailureClusterClaim(
    projectId: string,
    scheduleId: number,
    signatureKey: string,
  ): boolean {
    return (
      this.db.run(
        `DELETE FROM automation_failure_cluster_work
          WHERE project_id = ? AND schedule_id = ? AND signature_key = ?
            AND state = 'creating'`,
        [projectId, scheduleId, signatureKey],
      ).changes > 0
    );
  }

  recordFailureClusterTicket(input: {
    projectId: string;
    scheduleId: number;
    signatureKey: string;
    identity: string;
    jiraKey: string;
    jiraUrl: string;
    now: Date;
  }): AutomationFailureClusterWork {
    const now = toIso(input.now);
    this.db.run(
      `INSERT INTO automation_failure_cluster_work
         (project_id, schedule_id, signature_key, identity, state,
          jira_key, jira_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ticketed', ?, ?, ?, ?)
       ON CONFLICT (project_id, schedule_id, signature_key) DO UPDATE SET
         state = CASE WHEN state = 'active-mr' THEN state ELSE 'ticketed' END,
         jira_key = excluded.jira_key,
         jira_url = excluded.jira_url,
         claimed_at = NULL,
         updated_at = excluded.updated_at`,
      [
        input.projectId,
        input.scheduleId,
        input.signatureKey,
        input.identity,
        input.jiraKey,
        input.jiraUrl,
        now,
        now,
      ],
    );
    return this.getFailureClusterWork(
      input.projectId,
      input.scheduleId,
      input.signatureKey,
    )!;
  }

  recordFailureClusterMr(input: {
    projectId: string;
    scheduleId: number;
    signatureKey: string;
    identity: string;
    jiraKey?: string;
    jiraUrl?: string;
    mrIid: number;
    mrUrl: string;
    now: Date;
  }): AutomationFailureClusterWork {
    const now = toIso(input.now);
    this.db.run(
      `INSERT INTO automation_failure_cluster_work
         (project_id, schedule_id, signature_key, identity, state,
          jira_key, jira_url, mr_iid, mr_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active-mr', ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, schedule_id, signature_key) DO UPDATE SET
         state = 'active-mr',
         jira_key = COALESCE(excluded.jira_key, jira_key),
         jira_url = COALESCE(excluded.jira_url, jira_url),
         mr_iid = excluded.mr_iid,
         mr_url = excluded.mr_url,
         claimed_at = NULL,
         updated_at = excluded.updated_at`,
      [
        input.projectId,
        input.scheduleId,
        input.signatureKey,
        input.identity,
        input.jiraKey ?? null,
        input.jiraUrl ?? null,
        input.mrIid,
        input.mrUrl,
        now,
        now,
      ],
    );
    return this.getFailureClusterWork(
      input.projectId,
      input.scheduleId,
      input.signatureKey,
    )!;
  }

  clearFailureClusterMr(
    projectId: string,
    scheduleId: number,
    signatureKey: string,
    now: Date,
  ): AutomationFailureClusterWork | undefined {
    return this.db.transaction(() => {
      const current = this.getFailureClusterWork(
        projectId,
        scheduleId,
        signatureKey,
      );
      if (current?.state !== "active-mr") return current;
      if (current.jiraKey && current.jiraUrl) {
        this.db.run(
          `UPDATE automation_failure_cluster_work
              SET state = 'ticketed', mr_iid = NULL, mr_url = NULL,
                  claimed_at = NULL, updated_at = ?
            WHERE project_id = ? AND schedule_id = ? AND signature_key = ?
              AND state = 'active-mr'`,
          [toIso(now), projectId, scheduleId, signatureKey],
        );
        return this.getFailureClusterWork(projectId, scheduleId, signatureKey);
      }
      this.db.run(
        `DELETE FROM automation_failure_cluster_work
          WHERE project_id = ? AND schedule_id = ? AND signature_key = ?
            AND state = 'active-mr'`,
        [projectId, scheduleId, signatureKey],
      );
      return undefined;
    })();
  }

  markScheduleSynced(projectId: string, scheduleId: number, syncedAt: Date): void {
    this.db.run(
      `UPDATE automation_schedules SET synced_at = ?
        WHERE project_id = ? AND schedule_id = ?`,
      [toIso(syncedAt), projectId, scheduleId],
    );
  }

  prune(before: Date): number {
    const cutoff = toIso(before);
    // Bun/SQLite reports FK-cascaded child deletes in `changes` here. The
    // repository contract counts pipeline snapshots, so count parents first.
    const count = this.db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM automation_pipelines WHERE updated_at < ?",
      )
      .get(cutoff)?.count ?? 0;
    this.db.run("DELETE FROM automation_pipelines WHERE updated_at < ?", [cutoff]);
    return count;
  }

  private insertJob(
    snapshot: AutomationPipelineSnapshot,
    job: AutomationPipelineJob,
  ): void {
    this.db.run(
      `INSERT INTO automation_pipeline_jobs
         (project_id, pipeline_id, job_id, name, stage, status, failure_reason,
          allow_failure, web_url, duration, created_at, started_at, finished_at,
          total_time, total_count, success_count, failed_count, skipped_count,
          error_count, suite_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.projectId,
        snapshot.pipelineId,
        job.jobId,
        job.name,
        job.stage,
        job.status,
        job.failureReason ?? null,
        job.allowFailure ? 1 : 0,
        job.webUrl,
        job.duration ?? null,
        job.createdAt ? toIso(job.createdAt) : null,
        job.startedAt ? toIso(job.startedAt) : null,
        job.finishedAt ? toIso(job.finishedAt) : null,
        ...reportParams(job.report),
      ],
    );
  }

  private insertSuite(
    snapshot: AutomationPipelineSnapshot,
    suite: AutomationTestSuite,
  ): void {
    this.db.run(
      `INSERT INTO automation_pipeline_test_suites
         (project_id, pipeline_id, suite_index, name, build_ids_json, total_time,
          total_count, success_count, failed_count, skipped_count, error_count,
          suite_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.projectId,
        snapshot.pipelineId,
        suite.index,
        suite.name,
        toJson(suite.buildIds) ?? "[]",
        suite.totalTime,
        suite.totalCount,
        suite.successCount,
        suite.failedCount,
        suite.skippedCount,
        suite.errorCount,
        suite.suiteError ?? null,
      ],
    );
  }

  private toPipeline(
    row: PipelineRow,
    includeFailureDiagnostics = true,
  ): AutomationPipelineSnapshot {
    const projectAndPipeline: [string, number] = [row.project_id, row.pipeline_id];
    const jobs = this.db
      .query<JobRow, [string, number]>(
        `SELECT job_id, name, stage, status, failure_reason, allow_failure,
                web_url, duration, created_at, started_at, finished_at,
                ${REPORT_COLUMNS}
           FROM automation_pipeline_jobs
          WHERE project_id = ? AND pipeline_id = ?
          ORDER BY job_id`,
      )
      .all(...projectAndPipeline)
      .map(toJob);
    const suites = this.db
      .query<SuiteRow, [string, number]>(
        `SELECT suite_index, name, build_ids_json, ${REPORT_COLUMNS}
           FROM automation_pipeline_test_suites
          WHERE project_id = ? AND pipeline_id = ?
          ORDER BY suite_index`,
      )
      .all(...projectAndPipeline)
      .map(toSuite);
    const failedTests = this.db
      .query<FailedTestRow, [string, number]>(
        `SELECT suite_index, case_index, job_id, status, name, classname,
                execution_time,
                ${includeFailureDiagnostics ? "system_output, stack_trace" : "NULL AS system_output, NULL AS stack_trace"},
                test_file,
                attachment_job_id, attachment_path, attachment_name,
                signature_key, signature_title
           FROM automation_pipeline_failed_tests
          WHERE project_id = ? AND pipeline_id = ?
          ORDER BY suite_index, case_index`,
      )
      .all(...projectAndPipeline)
      .map(toFailedTest);

    return {
      projectId: row.project_id,
      pipelineId: row.pipeline_id,
      scheduleId: row.schedule_id,
      status: row.status,
      ref: row.ref,
      sha: row.sha,
      webUrl: row.web_url,
      ...(row.created_at ? { createdAt: fromIso(row.created_at) } : {}),
      updatedAt: fromIso(row.updated_at),
      ...(row.started_at ? { startedAt: fromIso(row.started_at) } : {}),
      ...(row.finished_at ? { finishedAt: fromIso(row.finished_at) } : {}),
      ...(row.duration != null ? { duration: row.duration } : {}),
      reportState: row.report_state,
      reportVersion: row.report_version,
      ...(toReport(row) ? { report: toReport(row)! } : {}),
      jobs,
      suites,
      failedTests,
    };
  }
}

function toSchedule(row: ScheduleRow): AutomationSchedule {
  return {
    projectId: row.project_id,
    scheduleId: row.schedule_id,
    description: row.description,
    ref: row.ref,
    ...(row.cron != null ? { cron: row.cron } : {}),
    ...(row.cron_timezone != null ? { cronTimezone: row.cron_timezone } : {}),
    ...(row.next_run_at ? { nextRunAt: fromIso(row.next_run_at) } : {}),
    active: row.active === 1,
    syncedAt: fromIso(row.synced_at),
  };
}

function reportParams(
  report: AutomationTestReportCounts | undefined,
): Array<number | string | null> {
  return report
    ? [
        report.totalTime,
        report.totalCount,
        report.successCount,
        report.failedCount,
        report.skippedCount,
        report.errorCount,
        report.suiteError ?? null,
      ]
    : [null, null, null, null, null, null, null];
}

function toReport(row: ReportRow): AutomationTestReportCounts | undefined {
  if (
    row.total_time == null ||
    row.total_count == null ||
    row.success_count == null ||
    row.failed_count == null ||
    row.skipped_count == null ||
    row.error_count == null
  ) {
    return undefined;
  }
  return {
    totalTime: row.total_time,
    totalCount: row.total_count,
    successCount: row.success_count,
    failedCount: row.failed_count,
    skippedCount: row.skipped_count,
    errorCount: row.error_count,
    ...(row.suite_error != null ? { suiteError: row.suite_error } : {}),
  };
}

function toJob(row: JobRow): AutomationPipelineJob {
  const report = toReport(row);
  return {
    jobId: row.job_id,
    name: row.name,
    stage: row.stage,
    status: row.status,
    ...(row.failure_reason != null ? { failureReason: row.failure_reason } : {}),
    allowFailure: row.allow_failure === 1,
    webUrl: row.web_url,
    ...(row.duration != null ? { duration: row.duration } : {}),
    ...(row.created_at ? { createdAt: fromIso(row.created_at) } : {}),
    ...(row.started_at ? { startedAt: fromIso(row.started_at) } : {}),
    ...(row.finished_at ? { finishedAt: fromIso(row.finished_at) } : {}),
    ...(report ? { report } : {}),
  };
}

function toSuite(row: SuiteRow): AutomationTestSuite {
  return {
    index: row.suite_index,
    name: row.name,
    buildIds: fromJson<number[]>(row.build_ids_json) ?? [],
    // Suite rows require counts; these fallbacks only protect reads from manual
    // database damage without weakening the migration's NOT NULL constraints.
    totalTime: row.total_time ?? 0,
    totalCount: row.total_count ?? 0,
    successCount: row.success_count ?? 0,
    failedCount: row.failed_count ?? 0,
    skippedCount: row.skipped_count ?? 0,
    errorCount: row.error_count ?? 0,
    ...(row.suite_error != null ? { suiteError: row.suite_error } : {}),
  };
}

function toFailedTest(row: FailedTestRow): AutomationFailedTestCase {
  return {
    suiteIndex: row.suite_index,
    caseIndex: row.case_index,
    ...(row.job_id != null ? { jobId: row.job_id } : {}),
    status: row.status,
    name: row.name,
    ...(row.classname != null ? { classname: row.classname } : {}),
    executionTime: row.execution_time,
    ...(row.system_output != null ? { systemOutput: row.system_output } : {}),
    ...(row.stack_trace != null ? { stackTrace: row.stack_trace } : {}),
    ...(row.test_file != null ? { testFile: row.test_file } : {}),
    ...(row.attachment_job_id != null
      ? { attachmentJobId: row.attachment_job_id }
      : {}),
    ...(row.attachment_path != null ? { attachmentPath: row.attachment_path } : {}),
    ...(row.attachment_name != null ? { attachmentName: row.attachment_name } : {}),
    signatureKey: row.signature_key,
    signatureTitle: row.signature_title,
  };
}

function toFailureClusterSummary(
  row: FailureClusterRow,
): AutomationFailureClusterSummary {
  const work =
    row.work_identity &&
    row.work_state &&
    row.work_created_at &&
    row.work_updated_at
      ? toFailureClusterWork({
          project_id: row.project_id,
          schedule_id: row.schedule_id,
          signature_key: row.signature_key,
          identity: row.work_identity,
          state: row.work_state,
          jira_key: row.jira_key,
          jira_url: row.jira_url,
          mr_iid: row.mr_iid,
          mr_url: row.mr_url,
          claimed_at: row.claimed_at,
          created_at: row.work_created_at,
          updated_at: row.work_updated_at,
        })
      : undefined;
  return {
    projectId: row.project_id,
    pipelineId: row.pipeline_id,
    scheduleId: row.schedule_id,
    signatureKey: row.signature_key,
    title: row.signature_title,
    severity: row.severity,
    occurrenceCount: row.occurrence_count,
    affectedTestCount: row.affected_test_count,
    sampleTestName: row.sample_test_name,
    ...(row.sample_classname != null
      ? { sampleClassname: row.sample_classname }
      : {}),
    jobIds: commaSeparatedNumbers(row.job_ids),
    suiteIndexes: commaSeparatedNumbers(row.suite_indexes),
    triageState:
      work?.state === "active-mr"
        ? "active-mr"
        : work?.state === "ticketed"
          ? "ticketed"
          : "untriaged",
    creating: work?.state === "creating",
    ...(work ? { work } : {}),
  };
}

function toFailureInboxItem(row: FailureInboxRow): AutomationFailureInboxItem {
  const work =
    row.work_identity &&
    row.work_state &&
    row.work_created_at &&
    row.work_updated_at
      ? toFailureClusterWork({
          project_id: row.project_id,
          schedule_id: row.schedule_id,
          signature_key: row.signature_key,
          identity: row.work_identity,
          state: row.work_state,
          jira_key: row.jira_key,
          jira_url: row.jira_url,
          mr_iid: row.mr_iid,
          mr_url: row.mr_url,
          claimed_at: row.claimed_at,
          created_at: row.work_created_at,
          updated_at: row.work_updated_at,
        })
      : undefined;
  return {
    projectId: row.project_id,
    scheduleId: row.schedule_id,
    signatureKey: row.signature_key,
    title: row.signature_title,
    severity: row.severity,
    firstSeenAt: fromIso(row.first_seen_at),
    lastSeenAt: fromIso(row.last_seen_at),
    pipelineCount: row.pipeline_count,
    latestPipelineId: row.latest_pipeline_id,
    latestPipelineUrl: row.latest_pipeline_url,
    latestRef: row.latest_ref,
    latestSha: row.latest_sha,
    latestUpdatedAt: fromIso(row.latest_updated_at),
    occurrenceCount: row.occurrence_count,
    affectedTestCount: row.affected_test_count,
    sampleTestName: row.sample_test_name,
    ...(row.sample_classname != null
      ? { sampleClassname: row.sample_classname }
      : {}),
    current: row.current_failure === 1,
    triageState:
      work?.state === "active-mr"
        ? "active-mr"
        : work?.state === "ticketed"
          ? "ticketed"
          : "untriaged",
    creating: work?.state === "creating",
    ...(work ? { work } : {}),
  };
}

function toFailureClusterWork(
  row: FailureClusterWorkRow,
): AutomationFailureClusterWork {
  return {
    projectId: row.project_id,
    scheduleId: row.schedule_id,
    signatureKey: row.signature_key,
    identity: row.identity,
    state: row.state,
    ...(row.jira_key != null ? { jiraKey: row.jira_key } : {}),
    ...(row.jira_url != null ? { jiraUrl: row.jira_url } : {}),
    ...(row.mr_iid != null ? { mrIid: row.mr_iid } : {}),
    ...(row.mr_url != null ? { mrUrl: row.mr_url } : {}),
    ...(row.claimed_at != null ? { claimedAt: fromIso(row.claimed_at) } : {}),
    createdAt: fromIso(row.created_at),
    updatedAt: fromIso(row.updated_at),
  };
}

function toJobRetryAttempt(row: JobRetryAttemptRow): AutomationJobRetryAttempt {
  return {
    projectId: row.project_id,
    pipelineId: row.pipeline_id,
    scheduleId: row.schedule_id,
    sourceJobId: row.source_job_id,
    sourceJobName: row.source_job_name,
    ...(row.retry_job_id != null ? { retryJobId: row.retry_job_id } : {}),
    ...(row.retry_job_url != null ? { retryJobUrl: row.retry_job_url } : {}),
    status: row.status,
    ...(row.error != null ? { error: row.error } : {}),
    requestedAt: fromIso(row.requested_at),
    ...(row.completed_at != null
      ? { completedAt: fromIso(row.completed_at) }
      : {}),
  };
}

function commaSeparatedNumbers(value: string | null): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map(Number)
    .filter((item) => Number.isSafeInteger(item));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function boundFailureText(value: string | undefined): string | null {
  if (value == null) return null;
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= AUTOMATION_FAILURE_TEXT_MAX_BYTES) return value;

  // Back up until the prefix is valid UTF-8, so bounding cannot persist a
  // replacement character or exceed the byte cap for a split multibyte codepoint.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = AUTOMATION_FAILURE_TEXT_MAX_BYTES; end >= 0; end--) {
    try {
      return decoder.decode(encoded.subarray(0, end));
    } catch {
      // At most three continuation bytes are retried for valid JavaScript text.
    }
  }
  return "";
}
