import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  AgentCheckpoint,
  AgentCheckpointManifest,
} from "../core/checkpoint.ts";
import type { AgentAttempt } from "../core/orchestration.ts";
import { fromIso, fromJson, toIso, toJson } from "./database.ts";

export class SqliteCheckpointStore {
  constructor(private readonly db: Database) {}

  create(attempt: AgentAttempt, provider: string, protocolVersion: number): AgentCheckpoint {
    if (!attempt.executionId) {
      throw new Error("checkpoint source has no execution identity");
    }
    const id = randomUUID();
    const ownerToken = randomUUID();
    this.db.run(
      `INSERT INTO agent_checkpoints (
         id, attempt_id, execution_id, job_id, provider, protocol_version,
         owner_token, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', ?)`,
      [
        id,
        attempt.id,
        attempt.executionId,
        attempt.jobId ?? null,
        provider,
        protocolVersion,
        ownerToken,
        toIso(new Date()),
      ],
    );
    return this.get(id)!;
  }

  ready(
    id: string,
    ownerToken: string,
    manifest: AgentCheckpointManifest,
  ): boolean {
    return this.db.run(
      `UPDATE agent_checkpoints
          SET status = 'ready', manifest = ?, ready_at = ?, reason = NULL
        WHERE id = ? AND owner_token = ? AND status = 'preparing'`,
      [toJson(manifest), toIso(new Date()), id, ownerToken],
    ).changes > 0;
  }

  fail(id: string, ownerToken: string, reason: string): boolean {
    return this.db.run(
      `UPDATE agent_checkpoints SET status = 'failed', reason = ?
        WHERE id = ? AND owner_token = ? AND status IN ('preparing', 'resuming')`,
      [reason, id, ownerToken],
    ).changes > 0;
  }

  invalidate(id: string, ownerToken: string, reason: string): boolean {
    return this.db.run(
      `UPDATE agent_checkpoints SET status = 'invalid', reason = ?
        WHERE id = ? AND owner_token = ? AND status IN ('preparing', 'ready')`,
      [reason, id, ownerToken],
    ).changes > 0;
  }

  beginResume(id: string, ownerToken: string): boolean {
    return this.db.run(
      `UPDATE agent_checkpoints
          SET status = 'resuming', resume_started_at = ?, reason = NULL
        WHERE id = ? AND owner_token = ? AND status = 'ready'`,
      [toIso(new Date()), id, ownerToken],
    ).changes > 0;
  }

  consumed(id: string, ownerToken: string): boolean {
    return this.db.run(
      `UPDATE agent_checkpoints SET status = 'consumed', consumed_at = ?
        WHERE id = ? AND owner_token = ? AND status = 'resuming'`,
      [toIso(new Date()), id, ownerToken],
    ).changes > 0;
  }

  get(id: string): AgentCheckpoint | null {
    const row = this.db.query<Row, [string]>(
      "SELECT * FROM agent_checkpoints WHERE id = ?",
    ).get(id);
    return row ? toCheckpoint(row) : null;
  }

  byExecution(executionId: string): AgentCheckpoint[] {
    return this.db.query<Row, [string]>(
      `SELECT * FROM agent_checkpoints
        WHERE execution_id = ? ORDER BY created_at DESC`,
    ).all(executionId).map(toCheckpoint);
  }

  recent(limit = 100): AgentCheckpoint[] {
    return this.db.query<Row, [number]>(
      "SELECT * FROM agent_checkpoints ORDER BY created_at DESC LIMIT ?",
    ).all(limit).map(toCheckpoint);
  }
}

interface Row {
  id: string;
  attempt_id: string;
  execution_id: string;
  job_id: string | null;
  provider: string;
  protocol_version: number;
  owner_token: string;
  status: AgentCheckpoint["status"];
  manifest: string | null;
  reason: string | null;
  created_at: string;
  ready_at: string | null;
  resume_started_at: string | null;
  consumed_at: string | null;
}

function toCheckpoint(row: Row): AgentCheckpoint {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    executionId: row.execution_id,
    jobId: row.job_id ?? undefined,
    provider: row.provider,
    protocolVersion: row.protocol_version,
    ownerToken: row.owner_token,
    status: row.status,
    manifest: fromJson<AgentCheckpointManifest>(row.manifest),
    reason: row.reason ?? undefined,
    createdAt: fromIso(row.created_at)!,
    readyAt: fromIso(row.ready_at),
    resumeStartedAt: fromIso(row.resume_started_at),
    consumedAt: fromIso(row.consumed_at),
  };
}
