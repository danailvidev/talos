import type { Database } from "bun:sqlite";
import type {
  RecordRegressionTestInput,
  RegressionTestRecord,
  RegressionTestRepository,
  RegressionTestSource,
  RegressionTestVerdict,
} from "../application/ports.ts";
import { fromIso, toIso } from "./database.ts";
import { newId } from "./id.ts";

interface Row {
  id: string;
  source: string;
  issue_id: string;
  fingerprint: string;
  verdict: string;
  summary: string | null;
  how_verified: string | null;
  test_file: string | null;
  mr_iid: number | null;
  mr_url: string | null;
  branch: string | null;
  task_run_id: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, source, issue_id, fingerprint, verdict, summary, how_verified,
                 test_file, mr_iid, mr_url, branch, task_run_id, created_at, updated_at`;

/**
 * Attempts at turning a production error into a test, one row per issue.
 *
 * `record` upserts on `(source, issue_id)` and keeps the original `created_at`:
 * "first tried on Tuesday" is a fact worth keeping across a re-run, and a
 * re-attempt after a `not-reachable` verdict is the case this feature expects
 * most.
 */
export class SqliteRegressionTestStore implements RegressionTestRepository {
  constructor(private readonly db: Database) {}

  record(input: RecordRegressionTestInput): RegressionTestRecord {
    const now = toIso(new Date());
    this.db.run(
      `INSERT INTO regression_tests
         (id, source, issue_id, fingerprint, verdict, summary, how_verified,
          test_file, mr_iid, mr_url, branch, task_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, issue_id) DO UPDATE
          SET fingerprint  = excluded.fingerprint,
              verdict      = excluded.verdict,
              summary      = excluded.summary,
              how_verified = excluded.how_verified,
              test_file    = excluded.test_file,
              -- COALESCE, not overwrite: a re-run that ends 'not-reachable' must
              -- not erase the merge request an earlier run really did open.
              mr_iid       = COALESCE(excluded.mr_iid, mr_iid),
              mr_url       = COALESCE(excluded.mr_url, mr_url),
              branch       = COALESCE(excluded.branch, branch),
              task_run_id  = excluded.task_run_id,
              updated_at   = excluded.updated_at`,
      [
        newId(),
        input.source,
        input.issueId,
        input.fingerprint,
        input.verdict,
        input.summary ?? null,
        input.howVerified ?? null,
        input.testFile ?? null,
        input.mrIid ?? null,
        input.mrUrl ?? null,
        input.branch ?? null,
        input.taskRunId ?? null,
        now,
        now,
      ],
    );
    // Read back rather than returning the input: on a conflict the row that
    // survives is the merged one, and its id and created_at are the older ones.
    return this.get(input.source, input.issueId)!;
  }

  get(source: RegressionTestSource, issueId: string): RegressionTestRecord | undefined {
    const row = this.db
      .query<Row, [string, string]>(
        `SELECT ${COLUMNS} FROM regression_tests WHERE source = ? AND issue_id = ?`,
      )
      .get(source, issueId);
    return row ? toRecord(row) : undefined;
  }

  list(): RegressionTestRecord[] {
    return this.db
      .query<Row, []>(`SELECT ${COLUMNS} FROM regression_tests ORDER BY updated_at DESC`)
      .all()
      .map(toRecord);
  }
}

function toRecord(row: Row): RegressionTestRecord {
  return {
    id: row.id,
    source: row.source as RegressionTestSource,
    issueId: row.issue_id,
    fingerprint: row.fingerprint,
    verdict: row.verdict as RegressionTestVerdict,
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.how_verified ? { howVerified: row.how_verified } : {}),
    ...(row.test_file ? { testFile: row.test_file } : {}),
    ...(row.mr_iid != null ? { mrIid: row.mr_iid } : {}),
    ...(row.mr_url ? { mrUrl: row.mr_url } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.task_run_id ? { taskRunId: row.task_run_id } : {}),
    createdAt: fromIso(row.created_at),
    updatedAt: fromIso(row.updated_at),
  };
}
