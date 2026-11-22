import {
  CHECKPOINT_PROTOCOL_VERSION,
  SuspensionUnavailableError,
  validateCheckpointManifest,
  type AgentCheckpoint,
  type AgentCheckpointProvider,
  type CheckpointCapability,
  type CheckpointResumeResult,
} from "../core/checkpoint.ts";
import type { AgentAttempt } from "../core/orchestration.ts";
import type { SqliteCheckpointStore } from "../persistence/checkpoint-store.ts";
import type { AgentOrchestrationService } from "./agent-orchestration-service.ts";

const UNAVAILABLE_REASON =
  "No runtime has a durable workspace, agent-session, replay-safe boundary, and confirmed-stop checkpoint provider.";

export class CheckpointSuspensionService {
  private readonly providers: Map<string, AgentCheckpointProvider>;

  constructor(
    private readonly store: SqliteCheckpointStore,
    private readonly orchestration: AgentOrchestrationService,
    private readonly options: {
      providers: AgentCheckpointProvider[];
      /**
       * Future runtime integration finalizes the source attempt only after a
       * provider has persisted both artifacts and confirmed runtime termination.
       */
      onSuspended?: (attempt: AgentAttempt, checkpoint: AgentCheckpoint) => Promise<void>;
      onResumed?: (
        checkpoint: AgentCheckpoint,
        result: CheckpointResumeResult,
      ) => Promise<void>;
    },
  ) {
    this.providers = new Map(options.providers.map((provider) => [provider.id, provider]));
  }

  capability(executionId?: string): CheckpointCapability {
    const attempt = executionId
      ? this.orchestration.activeAttempts().find((item) => item.executionId === executionId)
      : undefined;
    for (const provider of this.providers.values()) {
      const capability = provider.capability(attempt);
      if (isUsable(capability, attempt)) return capability;
    }
    return {
      supported: false,
      runtimeKinds: [],
      cooperativeCheckpoint: false,
      durableWorkspace: false,
      durableSession: false,
      replaySafeEffects: false,
      reason: UNAVAILABLE_REASON,
    };
  }

  checkpoints(limit = 100): AgentCheckpoint[] {
    return this.store.recent(limit);
  }

  async suspend(executionId: string, signal?: AbortSignal): Promise<AgentCheckpoint> {
    const attempt = this.orchestration.activeAttempts().find(
      (item) => item.executionId === executionId,
    );
    if (!attempt) {
      throw new SuspensionUnavailableError(
        `Execution '${executionId}' has no active agent attempt to suspend.`,
      );
    }
    const provider = this.providerFor(attempt);
    const checkpoint = this.store.create(
      attempt,
      provider.id,
      CHECKPOINT_PROTOCOL_VERSION,
    );
    try {
      const result = await provider.suspend(attempt, signal);
      if ((result as { runtimeStopped?: boolean }).runtimeStopped !== true) {
        throw new Error("checkpoint provider did not confirm source runtime termination");
      }
      validateCheckpointManifest(result.manifest, attempt, provider);
      if (!this.store.ready(checkpoint.id, checkpoint.ownerToken, result.manifest)) {
        throw new Error("checkpoint ownership was lost before it became ready");
      }
      const ready = this.store.get(checkpoint.id)!;
      if (!this.options.onSuspended) {
        this.store.invalidate(
          ready.id,
          ready.ownerToken,
          "checkpoint provider is not connected to orchestration finalization",
        );
        throw new SuspensionUnavailableError(
          "Checkpoint creation is not connected to safe slot finalization.",
        );
      }
      await this.options.onSuspended(attempt, ready);
      return ready;
    } catch (cause) {
      this.store.fail(
        checkpoint.id,
        checkpoint.ownerToken,
        cause instanceof Error ? cause.message : String(cause),
      );
      throw cause;
    }
  }

  async resume(checkpointId: string, signal?: AbortSignal): Promise<CheckpointResumeResult> {
    const checkpoint = this.store.get(checkpointId);
    if (!checkpoint || checkpoint.status !== "ready" || !checkpoint.manifest) {
      throw new SuspensionUnavailableError(
        `Checkpoint '${checkpointId}' is not ready for resume.`,
      );
    }
    const provider = this.providers.get(checkpoint.provider);
    if (!provider || !isUsable(provider.capability())) {
      throw new SuspensionUnavailableError(
        `Checkpoint provider '${checkpoint.provider}' is unavailable.`,
      );
    }
    if (!this.options.onResumed) {
      throw new SuspensionUnavailableError(
        "Checkpoint resume is not connected to durable capacity admission.",
      );
    }
    if (!this.store.beginResume(checkpoint.id, checkpoint.ownerToken)) {
      throw new Error("checkpoint ownership was lost before resume");
    }
    try {
      const result = await provider.resume(checkpoint, signal);
      await this.options.onResumed(checkpoint, result);
      if (!this.store.consumed(checkpoint.id, checkpoint.ownerToken)) {
        throw new Error("checkpoint ownership was lost before resume finalization");
      }
      return result;
    } catch (cause) {
      this.store.fail(
        checkpoint.id,
        checkpoint.ownerToken,
        cause instanceof Error ? cause.message : String(cause),
      );
      throw cause;
    }
  }

  private providerFor(attempt: AgentAttempt): AgentCheckpointProvider {
    for (const provider of this.providers.values()) {
      if (isUsable(provider.capability(attempt), attempt)) return provider;
    }
    throw new SuspensionUnavailableError(
      this.capability(attempt.executionId).reason ?? UNAVAILABLE_REASON,
    );
  }
}

function isUsable(
  capability: CheckpointCapability,
  attempt?: AgentAttempt,
): boolean {
  return capability.supported &&
    capability.cooperativeCheckpoint &&
    capability.durableWorkspace &&
    capability.durableSession &&
    capability.replaySafeEffects &&
    (!attempt || capability.runtimeKinds.includes(attempt.runtimeKind));
}
