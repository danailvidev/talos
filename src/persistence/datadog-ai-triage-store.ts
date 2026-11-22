import type { Database } from "bun:sqlite";
import type {
  DatadogAiTriageRecord,
  DatadogAiTriageRepository,
  DatadogAiTriageVerdict,
} from "../application/ports.ts";
import { fromIso, toIso } from "./database.ts";
import { newId } from "./id.ts";

interface Row {
  id: string;
  issue_id: string;
  fingerprint: string;
  verdict: string;
  confidence: number;
  rationale: string;
  recommendation: string;
  task_run_id: string;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT id, issue_id, fingerprint, verdict, confidence, rationale,
                       recommendation, task_run_id, created_at, updated_at
                  FROM datadog_ai_triage`;

export class SqliteDatadogAiTriageStore implements DatadogAiTriageRepository {
  constructor(private readonly db: Database) {}

  get(issueId: string): DatadogAiTriageRecord | undefined {
    const row = this.db.query<Row, [string]>(`${SELECT} WHERE issue_id = ?`).get(issueId);
    return row ? toRecord(row) : undefined;
  }

  list(): DatadogAiTriageRecord[] {
    return this.db
      .query<Row, []>(`${SELECT} ORDER BY updated_at DESC`)
      .all()
      .map(toRecord);
  }

  record(
    input: Omit<DatadogAiTriageRecord, "id" | "createdAt" | "updatedAt">,
  ): DatadogAiTriageRecord {
    const now = toIso(new Date());
    this.db.run(
      `INSERT INTO datadog_ai_triage
         (id, issue_id, fingerprint, verdict, confidence, rationale,
          recommendation, task_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (issue_id) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         verdict = excluded.verdict,
         confidence = excluded.confidence,
         rationale = excluded.rationale,
         recommendation = excluded.recommendation,
         task_run_id = excluded.task_run_id,
         updated_at = excluded.updated_at`,
      [
        newId(),
        input.issueId,
        input.fingerprint,
        input.verdict,
        input.confidence,
        input.rationale,
        input.recommendation,
        input.taskRunId,
        now,
        now,
      ],
    );
    return this.get(input.issueId)!;
  }
}

function toRecord(row: Row): DatadogAiTriageRecord {
  return {
    id: row.id,
    issueId: row.issue_id,
    fingerprint: row.fingerprint,
    verdict: row.verdict as DatadogAiTriageVerdict,
    confidence: row.confidence,
    rationale: row.rationale,
    recommendation: row.recommendation,
    taskRunId: row.task_run_id,
    createdAt: fromIso(row.created_at)!,
    updatedAt: fromIso(row.updated_at)!,
  };
}
