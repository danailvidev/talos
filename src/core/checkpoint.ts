import type { AgentAttempt, AgentRuntimeKind } from "./orchestration.ts";

export const CHECKPOINT_PROTOCOL_VERSION = 1;

export type CheckpointStatus =
  | "preparing"
  | "ready"
  | "resuming"
  | "consumed"
  | "failed"
  | "invalid";

export interface CheckpointArtifact {
  /** Provider-owned opaque storage key; never a credential-bearing URL. */
  key: string;
  sha256: string;
  sizeBytes: number;
  format: string;
}

export interface CheckpointBoundary {
  kind: "agent-turn-complete" | "tool-call-complete" | "task-step-complete";
  sequence: number;
  /**
   * A provider may resume only when work after this boundary can be replayed
   * without duplicating external effects.
   */
  replaySafe: boolean;
  externalEffectWatermark: string;
}

/**
 * Everything required to resume without treating a fresh run as continuation.
 * Memory/container state alone is deliberately not a valid checkpoint.
 */
export interface AgentCheckpointManifest {
  protocolVersion: typeof CHECKPOINT_PROTOCOL_VERSION;
  provider: string;
  sourceAttemptId: string;
  sourceExecutionId: string;
  generation: number;
  createdAt: string;
  runtime: {
    kind: AgentRuntimeKind;
    adapterVersion: string;
    imageDigest?: string;
  };
  agent: {
    provider: string;
    cliVersion: string;
    sessionId: string;
    safeBoundaryEventSequence: number;
  };
  workspace: CheckpointArtifact & {
    baseRevision?: string;
  };
  session: CheckpointArtifact;
  task: {
    taskId: string;
    cursor: string;
    state: unknown;
  };
  effects: {
    committedThrough: number;
    noInFlight: true;
  };
  boundary: CheckpointBoundary;
  supportedRuntimes: AgentRuntimeKind[];
  /** Hash of immutable invocation inputs used to reject resume drift. */
  invocationFingerprint: string;
}

export interface AgentCheckpoint {
  id: string;
  attemptId: string;
  executionId: string;
  jobId?: string;
  provider: string;
  protocolVersion: number;
  ownerToken: string;
  status: CheckpointStatus;
  manifest?: AgentCheckpointManifest;
  reason?: string;
  createdAt: Date;
  readyAt?: Date;
  resumeStartedAt?: Date;
  consumedAt?: Date;
}

export interface CheckpointCapability {
  supported: boolean;
  provider?: string;
  protocolVersion?: number;
  runtimeKinds: AgentRuntimeKind[];
  cooperativeCheckpoint: boolean;
  durableWorkspace: boolean;
  durableSession: boolean;
  replaySafeEffects: boolean;
  reason?: string;
}

export interface CheckpointSuspendResult {
  manifest: AgentCheckpointManifest;
  /** Capacity cannot be released unless this is true. */
  runtimeStopped: true;
}

export interface CheckpointResumeResult {
  runtimeKind: AgentRuntimeKind;
  runtimeId: string;
}

/**
 * A provider owns the atomic runtime-specific checkpoint boundary. Returning
 * from suspend means both durable artifacts are complete and the source runtime
 * is confirmed stopped.
 */
export interface AgentCheckpointProvider {
  readonly id: string;
  capability(attempt?: AgentAttempt): CheckpointCapability;
  suspend(attempt: AgentAttempt, signal?: AbortSignal): Promise<CheckpointSuspendResult>;
  resume(
    checkpoint: AgentCheckpoint,
    signal?: AbortSignal,
  ): Promise<CheckpointResumeResult>;
  discard(checkpoint: AgentCheckpoint): Promise<void>;
}

export class SuspensionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuspensionUnavailableError";
  }
}

export function validateCheckpointManifest(
  manifest: AgentCheckpointManifest,
  attempt: AgentAttempt,
  provider: AgentCheckpointProvider,
): void {
  if (manifest.protocolVersion !== CHECKPOINT_PROTOCOL_VERSION) {
    throw new Error(`unsupported checkpoint protocol ${manifest.protocolVersion}`);
  }
  if (manifest.provider !== provider.id) {
    throw new Error("checkpoint provider identity does not match");
  }
  if (
    manifest.sourceAttemptId !== attempt.id ||
    manifest.sourceExecutionId !== attempt.executionId
  ) {
    throw new Error("checkpoint source identity does not match the execution attempt");
  }
  if (!Number.isSafeInteger(manifest.generation) || manifest.generation < 1) {
    throw new Error("checkpoint generation is invalid");
  }
  if (
    manifest.runtime.kind !== attempt.runtimeKind ||
    !manifest.runtime.adapterVersion
  ) {
    throw new Error("checkpoint runtime compatibility metadata is invalid");
  }
  if (
    !manifest.agent.provider ||
    !manifest.agent.cliVersion ||
    !manifest.agent.sessionId ||
    !Number.isSafeInteger(manifest.agent.safeBoundaryEventSequence) ||
    manifest.agent.safeBoundaryEventSequence < 0
  ) {
    throw new Error("checkpoint agent session metadata is incomplete");
  }
  if (!manifest.boundary.replaySafe || !manifest.boundary.externalEffectWatermark) {
    throw new Error("checkpoint boundary does not prove replay-safe external effects");
  }
  validateArtifact(manifest.workspace, "workspace");
  validateArtifact(manifest.session, "session");
  if (
    !manifest.task.taskId ||
    !manifest.task.cursor ||
    !isJsonSerializable(manifest.task.state)
  ) {
    throw new Error("checkpoint task cursor is incomplete or not serializable");
  }
  if (
    manifest.effects.noInFlight !== true ||
    !Number.isSafeInteger(manifest.effects.committedThrough) ||
    manifest.effects.committedThrough < 0
  ) {
    throw new Error("checkpoint does not prove that external effects are quiescent");
  }
  if (!/^[a-f0-9]{64}$/i.test(manifest.invocationFingerprint)) {
    throw new Error("checkpoint invocation fingerprint is invalid");
  }
  if (!manifest.supportedRuntimes.includes(attempt.runtimeKind)) {
    throw new Error("checkpoint cannot resume on the source runtime kind");
  }
  if (Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new Error("checkpoint creation time is invalid");
  }
}

function validateArtifact(artifact: CheckpointArtifact, label: string): void {
  if (!artifact.key || !artifact.format || artifact.sizeBytes < 0) {
    throw new Error(`${label} checkpoint artifact is incomplete`);
  }
  if (!/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
    throw new Error(`${label} checkpoint artifact has no valid SHA-256 digest`);
  }
}

function isJsonSerializable(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}
