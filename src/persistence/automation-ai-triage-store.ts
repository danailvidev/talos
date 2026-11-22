import type { Database } from "bun:sqlite";
import type {
  AutomationAiTriageRecord,
  AutomationAiTriageRepository,
  AutomationAiTriageVerdict,
} from "../application/ports.ts";
import { fromIso, toIso } from "./database.ts";
import { newId } from "./id.ts";

interface Row {
  id: string;
  project_id: string;
  schedule_id: number;
  signature_key: string;
  signature: string;
  verdict: string;
  confidence: number;
  rationale: string;
  recommendation: string;
  task_run_id: string;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT id, project_id, schedule_id, signature_key, signature,
                       verdict, confidence, rationale, recommendation,
                       task_run_id, created_at, updated_at
                  FROM automation_ai_triage`;

export class SqliteAutomationAiTriageStore
  implements AutomationAiTriageRepository
{
  constructor(private readonly db: Database) {}

  get(
    projectId: string,
    scheduleId: number,
    signatureKey: string,
  ): AutomationAiTriageRecord | undefined {
    const row = this.db
      .query<Row, [string, number, string]>(
        `${SELECT}
          WHERE project_id = ? AND schedule_id = ? AND signature_key = ?`,
      )
      .get(projectId, scheduleId, signatureKey);
    return row ? toRecord(row) : undefined;
  }

  listFor(
    projectId: string,
    scheduleId: number,
    signatureKeys: readonly string[],
  ): Map<string, AutomationAiTriageRecord> {
    const keys = [...new Set(signatureKeys)];
    if (keys.length === 0) return new Map();
    const rows = this.db
      .query<Row, Array<string | number>>(
        `${SELECT}
          WHERE project_id = ? AND schedule_id = ?
            AND signature_key IN (${keys.map(() => "?").join(", ")})`,
      )
      .all(projectId, scheduleId, ...keys);
    return new Map(rows.map((row) => [row.signature_key, toRecord(row)]));
  }

  record(
    input: Omit<AutomationAiTriageRecord, "id" | "createdAt" | "updatedAt">,
  ): AutomationAiTriageRecord {
    const now = toIso(new Date());
    this.db.run(
      `INSERT INTO automation_ai_triage
         (id, project_id, schedule_id, signature_key, signature, verdict,
          confidence, rationale, recommendation, task_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, schedule_id, signature_key) DO UPDATE SET
         signature = excluded.signature,
         verdict = excluded.verdict,
         confidence = excluded.confidence,
         rationale = excluded.rationale,
         recommendation = excluded.recommendation,
         task_run_id = excluded.task_run_id,
         updated_at = excluded.updated_at`,
      [
        newId(),
        input.projectId,
        input.scheduleId,
        input.signatureKey,
        input.signature,
        input.verdict,
        input.confidence,
        input.rationale,
        input.recommendation,
        input.taskRunId,
        now,
        now,
      ],
    );
    return this.get(input.projectId, input.scheduleId, input.signatureKey)!;
  }
}

function toRecord(row: Row): AutomationAiTriageRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    scheduleId: row.schedule_id,
    signatureKey: row.signature_key,
    signature: row.signature,
    verdict: row.verdict as AutomationAiTriageVerdict,
    confidence: row.confidence,
    rationale: row.rationale,
    recommendation: row.recommendation,
    taskRunId: row.task_run_id,
    createdAt: fromIso(row.created_at)!,
    updatedAt: fromIso(row.updated_at)!,
  };
}
