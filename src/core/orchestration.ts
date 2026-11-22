/**
 * Durable agent orchestration vocabulary.
 *
 * Jobs describe requested work. Attempts describe one admission of that work.
 * Slots describe finite host capacity. Runtime resources are the Docker
 * containers or Kubernetes Jobs created by an admitted attempt.
 */
export type AgentLane = "background" | "interactive";
export type AgentRuntimeKind = "docker" | "kubernetes" | "host";
export type AgentAttemptState =
  | "starting"
  | "running"
  | "stopping"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "superseded"
  | "uncertain";
export type AgentTerminalState = Extract<
  AgentAttemptState,
  "succeeded" | "failed" | "cancelled" | "superseded"
>;

export interface AgentAttempt {
  id: string;
  executionId?: string;
  jobId?: string;
  actorId?: string;
  lane: AgentLane;
  workloadKind: string;
  slot: number;
  ownerToken: string;
  state: AgentAttemptState;
  runtimeKind: AgentRuntimeKind;
  runtimeId?: string;
  installationId: string;
  leaseExpiresAt: Date;
  lastHeartbeatAt: Date;
  createdAt: Date;
  startedAt?: Date;
  stoppingAt?: Date;
  finishedAt?: Date;
  reason?: string;
}

export interface AgentReservationRequest {
  executionId?: string;
  jobId?: string;
  actorId?: string;
  lane: AgentLane;
  workloadKind: string;
  runtimeKind: AgentRuntimeKind;
  /** Stable identity chosen before runtime creation. */
  runtimeId?: string;
}

export interface OrchestrationCapacity {
  total: number;
  interactiveReservation: number;
  occupied: number;
  uncertain: number;
  available: number;
  draining: boolean;
}

export interface JobControlState {
  jobId: string;
  held: boolean;
  heldAt?: Date;
  holdReason?: string;
  terminalOutcome?: "failed" | "cancelled" | "superseded";
  supersededByJobId?: string;
}

export type RuntimePresence = "running" | "stopped" | "missing" | "unknown";

export interface ManagedRuntimeResource {
  kind: AgentRuntimeKind;
  id: string;
  attemptId?: string;
  executionId?: string;
  presence: Exclude<RuntimePresence, "missing">;
}

/**
 * Lifecycle-only runtime adapter. Preparation, credentials, stream parsing and
 * output interpretation remain in the agent execution layer.
 */
export interface AgentRuntimeLifecycle {
  readonly kind: AgentRuntimeKind;
  inspect(id: string): Promise<RuntimePresence>;
  list(installationId: string): Promise<ManagedRuntimeResource[]>;
  /** Pre-installation-label resources; callers must prove database ownership. */
  listUnscoped?(): Promise<ManagedRuntimeResource[]>;
  /** Idempotent. True only when absence has been confirmed. */
  stop(id: string): Promise<boolean>;
}

export class UnresolvedRuntimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnresolvedRuntimeError";
  }
}
