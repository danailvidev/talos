import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  AgentAttempt,
  AgentAttemptState,
  AgentReservationRequest,
  AgentTerminalState,
} from "../core/orchestration.ts";
import { fromIso, toIso } from "./database.ts";

const ACTIVE_STATES = ["starting", "running", "stopping", "uncertain"] as const;

export class SqliteOrchestrationStore {
  constructor(private readonly db: Database) {}

  installationId(): string {
    const row = this.db.query<{ installation_id: string }, []>(
      "SELECT installation_id FROM orchestration_settings WHERE singleton = 1",
    ).get();
    if (!row) throw new Error("orchestration settings are missing");
    return row.installation_id;
  }

  draining(): boolean {
    return this.db.query<{ draining: number }, []>(
      "SELECT draining FROM orchestration_settings WHERE singleton = 1",
    ).get()?.draining === 1;
  }

  setDraining(draining: boolean): void {
    this.db.run(
      "UPDATE orchestration_settings SET draining = ?, updated_at = ? WHERE singleton = 1",
      [draining ? 1 : 0, toIso(new Date())],
    );
  }

  tryReserve(
    limit: number,
    request: AgentReservationRequest,
    leaseMs: number,
  ): AgentAttempt | undefined {
    return this.db.transaction(() => {
      if (this.draining()) return undefined;
      const occupied = new Set(
        this.db.query<{ slot: number }, []>(
          `SELECT slot FROM agent_execution_attempts
            WHERE state IN ('starting', 'running', 'stopping', 'uncertain')`,
        ).all().map((row) => row.slot),
      );
      let slot: number | undefined;
      for (let candidate = 0; candidate < limit; candidate++) {
        if (!occupied.has(candidate)) {
          slot = candidate;
          break;
        }
      }
      if (slot == null) return undefined;

      const now = new Date();
      const id = randomUUID();
      const ownerToken = randomUUID();
      const jobId = request.jobId ?? (
        request.executionId
          ? this.db.query<{ id: string }, [string]>(
              "SELECT id FROM jobs WHERE execution_id = ? AND status = 'leased' LIMIT 1",
            ).get(request.executionId)?.id
          : undefined
      );
      this.db.run(
        `INSERT INTO agent_execution_attempts (
           id, execution_id, job_id, actor_id, lane, workload_kind, slot,
           owner_token, state, runtime_kind, runtime_id, installation_id,
           lease_expires_at, last_heartbeat_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?)`,
        [
          id,
          request.executionId ?? null,
          jobId ?? null,
          request.actorId ?? null,
          request.lane,
          request.workloadKind,
          slot,
          ownerToken,
          request.runtimeKind,
          request.runtimeId ?? null,
          this.installationId(),
          toIso(new Date(now.getTime() + leaseMs)),
          toIso(now),
          toIso(now),
        ],
      );
      return this.get(id)!;
    })();
  }

  renew(id: string, ownerToken: string, leaseMs: number): boolean {
    const now = new Date();
    return this.db.run(
      `UPDATE agent_execution_attempts
          SET lease_expires_at = ?, last_heartbeat_at = ?
        WHERE id = ? AND owner_token = ?
          AND state IN ('starting', 'running', 'stopping')`,
      [toIso(new Date(now.getTime() + leaseMs)), toIso(now), id, ownerToken],
    ).changes > 0;
  }

  markRunning(id: string, ownerToken: string, runtimeId?: string): boolean {
    return this.db.run(
      `UPDATE agent_execution_attempts
          SET state = 'running', runtime_id = COALESCE(?, runtime_id),
              started_at = COALESCE(started_at, ?), reason = NULL
        WHERE id = ? AND owner_token = ? AND state = 'starting'`,
      [runtimeId ?? null, toIso(new Date()), id, ownerToken],
    ).changes > 0;
  }

  markStopping(id: string, ownerToken: string, reason?: string): boolean {
    return this.db.run(
      `UPDATE agent_execution_attempts
          SET state = 'stopping', stopping_at = COALESCE(stopping_at, ?),
              reason = COALESCE(?, reason)
        WHERE id = ? AND owner_token = ?
          AND state IN ('starting', 'running')`,
      [toIso(new Date()), reason ?? null, id, ownerToken],
    ).changes > 0;
  }

  markUncertain(id: string, ownerToken: string, reason: string): boolean {
    return this.db.run(
      `UPDATE agent_execution_attempts
          SET state = 'uncertain', reason = ?
        WHERE id = ? AND owner_token = ?
          AND state IN ('starting', 'running', 'stopping')`,
      [reason, id, ownerToken],
    ).changes > 0;
  }

  finish(
    id: string,
    ownerToken: string,
    state: AgentTerminalState,
    reason?: string,
  ): boolean {
    return this.db.run(
      `UPDATE agent_execution_attempts
          SET state = ?, finished_at = ?, reason = COALESCE(?, reason)
        WHERE id = ? AND owner_token = ?
          AND state IN ('starting', 'running', 'stopping')`,
      [state, toIso(new Date()), reason ?? null, id, ownerToken],
    ).changes > 0;
  }

  /** Reconciliation owns uncertain/expired rows, so it does not use a stale token. */
  reconcileFinish(id: string, state: AgentTerminalState, reason: string): boolean {
    return this.db.run(
      `UPDATE agent_execution_attempts
          SET state = ?, finished_at = ?, reason = ?
        WHERE id = ? AND state IN ('starting', 'running', 'stopping', 'uncertain')`,
      [state, toIso(new Date()), reason, id],
    ).changes > 0;
  }

  reconcileUncertain(id: string, reason: string): boolean {
    return this.db.run(
      `UPDATE agent_execution_attempts SET state = 'uncertain', reason = ?
        WHERE id = ? AND state IN ('starting', 'running', 'stopping', 'uncertain')`,
      [reason, id],
    ).changes > 0;
  }

  get(id: string): AgentAttempt | null {
    const row = this.db.query<Row, [string]>(
      "SELECT * FROM agent_execution_attempts WHERE id = ?",
    ).get(id);
    return row ? toAttempt(row) : null;
  }

  active(): AgentAttempt[] {
    return this.db.query<Row, []>(
      `SELECT * FROM agent_execution_attempts
        WHERE state IN ('starting', 'running', 'stopping', 'uncertain')
        ORDER BY slot`,
    ).all().map(toAttempt);
  }

  expired(now = new Date()): AgentAttempt[] {
    return this.db.query<Row, [string]>(
      `SELECT * FROM agent_execution_attempts
        WHERE state IN ('starting', 'running', 'stopping', 'uncertain')
          AND lease_expires_at <= ?
        ORDER BY created_at`,
    ).all(toIso(now)).map(toAttempt);
  }

  recent(limit = 100): AgentAttempt[] {
    return this.db.query<Row, [number]>(
      "SELECT * FROM agent_execution_attempts ORDER BY created_at DESC LIMIT ?",
    ).all(limit).map(toAttempt);
  }

  counts(): { occupied: number; uncertain: number } {
    const row = this.db.query<{ occupied: number; uncertain: number }, []>(
      `SELECT
         COUNT(*) AS occupied,
         SUM(CASE WHEN state = 'uncertain' THEN 1 ELSE 0 END) AS uncertain
       FROM agent_execution_attempts
       WHERE state IN ('starting', 'running', 'stopping', 'uncertain')`,
    ).get();
    return { occupied: row?.occupied ?? 0, uncertain: row?.uncertain ?? 0 };
  }

  hasExecution(executionId: string): boolean {
    return this.db.query<{ present: number }, [string]>(
      "SELECT 1 AS present FROM task_runs WHERE execution_id = ? LIMIT 1",
    ).get(executionId) != null;
  }
}

interface Row {
  id: string;
  execution_id: string | null;
  job_id: string | null;
  actor_id: string | null;
  lane: AgentAttempt["lane"];
  workload_kind: string;
  slot: number;
  owner_token: string;
  state: AgentAttemptState;
  runtime_kind: AgentAttempt["runtimeKind"];
  runtime_id: string | null;
  installation_id: string;
  lease_expires_at: string;
  last_heartbeat_at: string;
  created_at: string;
  started_at: string | null;
  stopping_at: string | null;
  finished_at: string | null;
  reason: string | null;
}

function toAttempt(row: Row): AgentAttempt {
  return {
    id: row.id,
    executionId: row.execution_id ?? undefined,
    jobId: row.job_id ?? undefined,
    actorId: row.actor_id ?? undefined,
    lane: row.lane,
    workloadKind: row.workload_kind,
    slot: row.slot,
    ownerToken: row.owner_token,
    state: row.state,
    runtimeKind: row.runtime_kind,
    runtimeId: row.runtime_id ?? undefined,
    installationId: row.installation_id,
    leaseExpiresAt: fromIso(row.lease_expires_at)!,
    lastHeartbeatAt: fromIso(row.last_heartbeat_at)!,
    createdAt: fromIso(row.created_at)!,
    startedAt: fromIso(row.started_at),
    stoppingAt: fromIso(row.stopping_at),
    finishedAt: fromIso(row.finished_at),
    reason: row.reason ?? undefined,
  };
}

export const activeAgentAttemptStates = ACTIVE_STATES;
