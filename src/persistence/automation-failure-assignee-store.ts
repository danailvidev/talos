import type { Database } from "bun:sqlite";
import type {
  AutomationFailureAssignee,
  AutomationFailureAssigneeRepository,
} from "../application/ports.ts";
import { fromIso, toIso } from "./database.ts";

interface Row {
  project_id: string;
  schedule_id: number;
  signature_key: string;
  user_id: string;
  assigned_by_user_id: string;
  assigned_at: string;
  updated_at: string;
}

const SELECT = `SELECT project_id, schedule_id, signature_key, user_id,
                       assigned_by_user_id, assigned_at, updated_at
                  FROM automation_failure_assignees`;

export class SqliteAutomationFailureAssigneeStore
  implements AutomationFailureAssigneeRepository
{
  constructor(private readonly db: Database) {}

  get(
    projectId: string,
    scheduleId: number,
    signatureKey: string,
  ): AutomationFailureAssignee | undefined {
    const row = this.db
      .query<Row, [string, number, string]>(
        `${SELECT}
          WHERE project_id = ? AND schedule_id = ? AND signature_key = ?`,
      )
      .get(projectId, scheduleId, signatureKey);
    return row ? toAssignee(row) : undefined;
  }

  listFor(
    projectId: string,
    scheduleId: number,
    signatureKeys: readonly string[],
  ): Map<string, AutomationFailureAssignee> {
    const keys = [...new Set(signatureKeys)];
    if (keys.length === 0) return new Map();
    const rows = this.db
      .query<Row, Array<string | number>>(
        `${SELECT}
          WHERE project_id = ? AND schedule_id = ?
            AND signature_key IN (${keys.map(() => "?").join(", ")})`,
      )
      .all(projectId, scheduleId, ...keys);
    return new Map(rows.map((row) => [row.signature_key, toAssignee(row)]));
  }

  set(input: {
    projectId: string;
    scheduleId: number;
    signatureKey: string;
    userId: string;
    assignedByUserId: string;
    now: Date;
  }): AutomationFailureAssignee {
    const now = toIso(input.now);
    this.db.run(
      `INSERT INTO automation_failure_assignees
         (project_id, schedule_id, signature_key, user_id,
          assigned_by_user_id, assigned_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, schedule_id, signature_key) DO UPDATE SET
         user_id = excluded.user_id,
         assigned_by_user_id = excluded.assigned_by_user_id,
         assigned_at = excluded.assigned_at,
         updated_at = excluded.updated_at`,
      [
        input.projectId,
        input.scheduleId,
        input.signatureKey,
        input.userId,
        input.assignedByUserId,
        now,
        now,
      ],
    );
    return this.get(input.projectId, input.scheduleId, input.signatureKey)!;
  }

  clear(projectId: string, scheduleId: number, signatureKey: string): boolean {
    return (
      this.db.run(
        `DELETE FROM automation_failure_assignees
          WHERE project_id = ? AND schedule_id = ? AND signature_key = ?`,
        [projectId, scheduleId, signatureKey],
      ).changes > 0
    );
  }
}

function toAssignee(row: Row): AutomationFailureAssignee {
  return {
    projectId: row.project_id,
    scheduleId: row.schedule_id,
    signatureKey: row.signature_key,
    userId: row.user_id,
    assignedByUserId: row.assigned_by_user_id,
    assignedAt: fromIso(row.assigned_at)!,
    updatedAt: fromIso(row.updated_at)!,
  };
}
