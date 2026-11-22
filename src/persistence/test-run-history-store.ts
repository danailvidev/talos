import type { Database } from "bun:sqlite";
import type {
  FlakyTestRow,
  ListFlakyTestsOptions,
  RecordTestFailureInput,
  RecordTestRunInput,
  TestObservation,
  TestRunHistoryRepository,
  TestRunSource,
} from "../application/ports.ts";
import { fromIso, fromJson, toIso, toJson } from "./database.ts";

/** A joined history row: one observed run, plus this test's failure in it if any. */
interface ObservationRow {
  run_id: string;
  sha: string | null;
  ref: string | null;
  finished_at: string;
  failure_id: number | null;
  signature: string | null;
  suite_failed_to_run: number | null;
  tests_json: string | null;
}

interface RunRow {
  run_id: string;
  finished_at: string;
}

interface FailureRow {
  test_id: string;
  run_id: string;
  signature: string;
  suite_failed_to_run: number;
  finished_at: string;
}

interface FlagRow {
  test_id: string;
  state: string;
  quarantine_suggested_at: string | null;
  force_file: number;
}

/** Conclusive runs only — see `TestRunOutcome`. */
const CONCLUSIVE = "outcome IN ('green', 'failures')";

/** Enough tests for a page; a project with more than this has a bigger problem. */
const DEFAULT_LIMIT = 200;

/**
 * Per-test pass/fail history, shared by every producer that reports test
 * results — the thing that lets `gitlab-ci-failure` (and, eventually, another
 * producer) tell a flake from a regression.
 *
 * The one idea worth holding on to: a **pass is not stored**. A producer names
 * the tests that failed and nothing else, so there is no way to enumerate the
 * tests that passed — but a run that was observed and carries no failure row for
 * a test is a run that test passed in. Every read here is therefore a LEFT JOIN
 * from runs to failures, and the absence of the right-hand side is the signal.
 *
 * Both writes are idempotent, because a producer typically re-scans a window of
 * runs on every pass and must not turn one run into several observations.
 */
export class SqliteTestRunHistoryStore implements TestRunHistoryRepository {
  constructor(private readonly db: Database) {}

  recordTestRun(input: RecordTestRunInput): void {
    // The outcome can change between scans -- a run seen mid-flight as
    // inconclusive becomes `failures` once its traces parse -- so the upsert
    // updates rather than ignoring the conflict.
    this.db.run(
      `INSERT INTO test_runs
         (source, project, run_id, sha, ref, status, outcome, tests_failed,
          finished_at, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, project, run_id) DO UPDATE
          SET sha = COALESCE(excluded.sha, sha),
              ref = COALESCE(excluded.ref, ref),
              status = COALESCE(excluded.status, status),
              outcome = excluded.outcome,
              tests_failed = excluded.tests_failed,
              finished_at = excluded.finished_at`,
      [
        input.source,
        input.project,
        input.runId,
        input.sha ?? null,
        input.ref ?? null,
        input.status ?? null,
        input.outcome,
        input.testsFailed,
        toIso(input.finishedAt),
        toIso(new Date()),
      ],
    );
  }

  recordTestFailure(input: RecordTestFailureInput): void {
    this.db.run(
      `INSERT INTO test_run_failures
         (source, project, test_id, run_id, signature, suite_failed_to_run,
          tests_json, finished_at, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, project, test_id, run_id) DO UPDATE
          SET signature = excluded.signature,
              suite_failed_to_run = excluded.suite_failed_to_run,
              tests_json = excluded.tests_json,
              finished_at = excluded.finished_at`,
      [
        input.source,
        input.project,
        input.testId,
        input.runId,
        input.signature,
        input.suiteFailedToRun ? 1 : 0,
        toJson(input.tests),
        toIso(input.finishedAt),
        toIso(new Date()),
      ],
    );
  }

  history(
    source: TestRunSource,
    project: string,
    testId: string,
    limit: number,
  ): TestObservation[] {
    return this.db
      .query<ObservationRow, [string, string, string, number]>(
        `SELECT r.run_id, r.sha, r.ref, r.finished_at,
                f.id AS failure_id, f.signature, f.suite_failed_to_run, f.tests_json
           FROM test_runs r
           LEFT JOIN test_run_failures f
             ON f.source = r.source
            AND f.project = r.project
            AND f.run_id = r.run_id
            AND f.test_id = ?
          WHERE r.source = ? AND r.project = ? AND ${CONCLUSIVE}
          ORDER BY r.finished_at DESC, r.run_id DESC
          LIMIT ?`,
      )
      .all(testId, source, project, Math.max(1, limit))
      .map(toObservation);
  }

  /**
   * The Flaky specs page, in three queries per (source, project) rather than
   * three per test.
   *
   * The aggregation is done here in TypeScript on purpose. Expressing "failures
   * in a row, newest-first, within the last N conclusive runs" as SQL means
   * window functions over a LEFT JOIN against a per-project LIMIT, which is both
   * unreadable and, at these row counts, no faster than a loop.
   */
  listFlaky(options?: ListFlakyTestsOptions): FlakyTestRow[] {
    const window = Math.max(1, options?.window ?? 10);
    const groups =
      options?.source && options?.project
        ? [{ source: options.source, project: options.project }]
        : this.sourcesAndProjects(options?.source, options?.project);
    const rows: FlakyTestRow[] = [];

    for (const { source, project } of groups) {
      const runs = this.db
        .query<RunRow, [string, string, number]>(
          `SELECT run_id, finished_at FROM test_runs
            WHERE source = ? AND project = ? AND ${CONCLUSIVE}
            ORDER BY finished_at DESC, run_id DESC
            LIMIT ?`,
        )
        .all(source, project, window);
      if (runs.length === 0) continue;

      // Ordering, not just membership: `consecutiveFailures` is a property of the
      // sequence, so each run's position in the window has to be recoverable.
      const rank = new Map(runs.map((r, index) => [r.run_id, index]));
      const placeholders = runs.map(() => "?").join(", ");
      const failures = this.db
        .query<FailureRow, string[]>(
          `SELECT test_id, run_id, signature, suite_failed_to_run, finished_at
             FROM test_run_failures
            WHERE source = ? AND project = ? AND run_id IN (${placeholders})`,
        )
        .all(source, project, ...runs.map((r) => r.run_id));
      if (failures.length === 0) continue;

      const flags = new Map(
        this.db
          .query<FlagRow, [string, string]>(
            `SELECT test_id, state, quarantine_suggested_at, force_file
               FROM test_flake_flags WHERE source = ? AND project = ?`,
          )
          .all(source, project)
          .map((flag) => [flag.test_id, flag]),
      );

      const byTest = new Map<string, FailureRow[]>();
      for (const failure of failures) {
        const list = byTest.get(failure.test_id);
        if (list) list.push(failure);
        else byTest.set(failure.test_id, [failure]);
      }

      for (const [testId, testFailures] of byTest) {
        // Newest-first, to match the ordering `application/flake.ts` assumes
        // throughout.
        testFailures.sort(
          (a, b) => (rank.get(a.run_id) ?? 0) - (rank.get(b.run_id) ?? 0),
        );
        const failedRanks = new Set(testFailures.map((failure) => rank.get(failure.run_id)));

        let consecutiveFailures = 0;
        while (failedRanks.has(consecutiveFailures)) consecutiveFailures++;

        const lastPassed = runs.find((_, index) => !failedRanks.has(index))?.run_id;

        const newest = testFailures[0]!;
        const oldest = testFailures[testFailures.length - 1]!;
        const flag = flags.get(testId);
        const state = (flag?.state ?? "open") as FlakyTestRow["state"];
        if (state === "dismissed" && !options?.includeDismissed) continue;

        rows.push({
          source,
          project,
          testId,
          observed: runs.length,
          failed: testFailures.length,
          consecutiveFailures,
          firstFailedAt: fromIso(oldest.finished_at),
          lastFailedAt: fromIso(newest.finished_at),
          lastFailedRunId: newest.run_id,
          ...(lastPassed != null ? { lastPassedRunId: lastPassed } : {}),
          ...(newest.signature ? { lastSignature: newest.signature } : {}),
          lastSuiteFailedToRun: newest.suite_failed_to_run === 1,
          state,
          forceFile: flag?.force_file === 1,
          ...(flag?.quarantine_suggested_at
            ? { quarantineSuggestedAt: fromIso(flag.quarantine_suggested_at) }
            : {}),
        });
      }
    }

    // Worst first: most failures, then most recent. A test that broke last
    // night matters more than one that broke a week ago at the same rate.
    rows.sort(
      (a, b) =>
        b.failed - a.failed || b.lastFailedAt.getTime() - a.lastFailedAt.getTime(),
    );
    return rows.slice(0, options?.limit ?? DEFAULT_LIMIT);
  }

  setState(
    source: TestRunSource,
    project: string,
    testId: string,
    state: "open" | "dismissed",
  ): void {
    const now = toIso(new Date());
    this.db.run(
      `INSERT INTO test_flake_flags (source, project, test_id, state, dismissed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, project, test_id) DO UPDATE
          SET state = excluded.state,
              dismissed_at = excluded.dismissed_at,
              updated_at = excluded.updated_at`,
      [source, project, testId, state, state === "dismissed" ? now : null, now],
    );
  }

  suggestQuarantine(source: TestRunSource, project: string, testId: string): void {
    const now = toIso(new Date());
    // First date wins: "flaky since Tuesday" is the useful fact, and re-running
    // the classifier must not reset it to today every night.
    this.db.run(
      `INSERT INTO test_flake_flags
         (source, project, test_id, quarantine_suggested_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (source, project, test_id) DO UPDATE
          SET quarantine_suggested_at = COALESCE(quarantine_suggested_at, excluded.quarantine_suggested_at),
              updated_at = excluded.updated_at`,
      [source, project, testId, now, now],
    );
  }

  setForceFile(source: TestRunSource, project: string, testId: string, force: boolean): void {
    const now = toIso(new Date());
    this.db.run(
      `INSERT INTO test_flake_flags (source, project, test_id, force_file, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (source, project, test_id) DO UPDATE
          SET force_file = excluded.force_file, updated_at = excluded.updated_at`,
      [source, project, testId, force ? 1 : 0, now],
    );
  }

  forceFilePending(source: TestRunSource, project: string, testId: string): boolean {
    const row = this.db
      .query<{ force_file: number }, [string, string, string]>(
        "SELECT force_file FROM test_flake_flags WHERE source = ? AND project = ? AND test_id = ?",
      )
      .get(source, project, testId);
    return row?.force_file === 1;
  }

  prune(before: Date): number {
    const cutoff = toIso(before);
    // Failures first: a failure row without its run row would read as a test
    // that failed in a run nobody observed, and drop out of every window.
    const failures = this.db.run(
      "DELETE FROM test_run_failures WHERE finished_at < ?",
      [cutoff],
    );
    const runs = this.db.run("DELETE FROM test_runs WHERE finished_at < ?", [cutoff]);
    return failures.changes + runs.changes;
  }

  private sourcesAndProjects(
    source?: string,
    project?: string,
  ): { source: string; project: string }[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (source) {
      clauses.push("source = ?");
      params.push(source);
    }
    if (project) {
      clauses.push("project = ?");
      params.push(project);
    }
    return this.db
      .query<{ source: string; project: string }, string[]>(
        `SELECT DISTINCT source, project FROM test_run_failures` +
          (clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""),
      )
      .all(...params);
  }
}

function toObservation(row: ObservationRow): TestObservation {
  const failed = row.failure_id != null;
  return {
    runId: row.run_id,
    ...(row.sha ? { sha: row.sha } : {}),
    ...(row.ref ? { ref: row.ref } : {}),
    finishedAt: fromIso(row.finished_at),
    failed,
    ...(failed
      ? {
          ...(row.signature ? { signature: row.signature } : {}),
          suiteFailedToRun: row.suite_failed_to_run === 1,
          tests: fromJson<string[]>(row.tests_json) ?? [],
        }
      : {}),
  };
}
