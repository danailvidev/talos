import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";
import { AgentOrchestrationService } from "../src/application/agent-orchestration-service.ts";
import { CheckpointSuspensionService } from "../src/application/checkpoint-suspension-service.ts";
import {
  CHECKPOINT_PROTOCOL_VERSION,
  type AgentCheckpoint,
  type AgentCheckpointManifest,
  type AgentCheckpointProvider,
  type CheckpointResumeResult,
} from "../src/core/checkpoint.ts";
import type { AgentAttempt } from "../src/core/orchestration.ts";
import { createLogger } from "../src/logging/logger.ts";
import { SqliteCheckpointStore } from "../src/persistence/checkpoint-store.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteOrchestrationStore } from "../src/persistence/orchestration-store.ts";

describe("checkpoint suspension framework", () => {
  test("reports unsupported capability and mutates nothing without a provider", async () => {
    const harness = createHarness([]);
    expect(harness.service.capability()).toMatchObject({
      supported: false,
      runtimeKinds: [],
    });
    await expect(harness.service.suspend("run-1")).rejects.toThrow(
      "No runtime has a durable workspace",
    );
    expect(harness.checkpoints.recent()).toEqual([]);
    harness.db.close();
  });

  test("persists a validated checkpoint only after confirmed runtime stop", async () => {
    const provider = new FakeCheckpointProvider();
    let finalized = false;
    const harness = createHarness([provider], {
      onSuspended: async () => {
        finalized = true;
      },
    });

    const checkpoint = await harness.service.suspend("run-1");

    expect(finalized).toBe(true);
    expect(checkpoint.status).toBe("ready");
    expect(checkpoint.manifest?.boundary.replaySafe).toBe(true);
    expect(harness.db.query<{ to_status: string }, [string]>(
      `SELECT to_status FROM agent_checkpoint_events
        WHERE checkpoint_id = ? ORDER BY id`,
    ).all(checkpoint.id)).toEqual([
      { to_status: "preparing" },
      { to_status: "ready" },
    ]);
    harness.db.close();
  });

  test("rejects a checkpoint without a replay-safe side-effect boundary", async () => {
    const provider = new FakeCheckpointProvider();
    provider.replaySafe = false;
    const harness = createHarness([provider], {
      onSuspended: async () => {},
    });

    await expect(harness.service.suspend("run-1")).rejects.toThrow(
      "replay-safe external effects",
    );
    expect(harness.checkpoints.recent()[0]?.status).toBe("failed");
    harness.db.close();
  });

  test("consumes a checkpoint only after resumed runtime admission succeeds", async () => {
    const provider = new FakeCheckpointProvider();
    let resumedRuntime = "";
    const harness = createHarness([provider], {
      onSuspended: async () => {},
      onResumed: async (_checkpoint, result) => {
        resumedRuntime = result.runtimeId;
      },
    });
    const checkpoint = await harness.service.suspend("run-1");

    const result = await harness.service.resume(checkpoint.id);

    expect(result).toEqual({ runtimeKind: "docker", runtimeId: "resumed-container" });
    expect(resumedRuntime).toBe("resumed-container");
    expect(harness.checkpoints.get(checkpoint.id)?.status).toBe("consumed");
    harness.db.close();
  });
});

function createHarness(
  providers: AgentCheckpointProvider[],
  callbacks: {
    onSuspended?: (attempt: AgentAttempt, checkpoint: AgentCheckpoint) => Promise<void>;
    onResumed?: (
      checkpoint: AgentCheckpoint,
      result: CheckpointResumeResult,
    ) => Promise<void>;
  } = {},
) {
  const db = new Database(":memory:");
  migrate(db);
  const attempts = new SqliteOrchestrationStore(db);
  attempts.tryReserve(1, {
    executionId: "run-1",
    lane: "background",
    workloadKind: "agent",
    runtimeKind: "docker",
    runtimeId: "source-container",
  }, 30_000);
  const logger = createLogger({
    destination: new PassThrough(),
    pretty: false,
    level: "fatal",
  });
  const orchestration = new AgentOrchestrationService(
    attempts,
    logger,
    { runtimes: [] },
  );
  const checkpoints = new SqliteCheckpointStore(db);
  const service = new CheckpointSuspensionService(
    checkpoints,
    orchestration,
    {
      providers,
      ...(callbacks.onSuspended ? { onSuspended: callbacks.onSuspended } : {}),
      ...(callbacks.onResumed ? { onResumed: callbacks.onResumed } : {}),
    },
  );
  return { db, attempts, checkpoints, orchestration, service };
}

class FakeCheckpointProvider implements AgentCheckpointProvider {
  readonly id = "fake-checkpoint";
  replaySafe = true;

  capability() {
    return {
      supported: true,
      provider: this.id,
      protocolVersion: CHECKPOINT_PROTOCOL_VERSION,
      runtimeKinds: ["docker" as const],
      cooperativeCheckpoint: true,
      durableWorkspace: true,
      durableSession: true,
      replaySafeEffects: true,
    };
  }

  async suspend(attempt: AgentAttempt) {
    return {
      runtimeStopped: true as const,
      manifest: manifestFor(attempt, this.id, this.replaySafe),
    };
  }

  async resume() {
    return { runtimeKind: "docker" as const, runtimeId: "resumed-container" };
  }

  async discard() {}
}

function manifestFor(
  attempt: AgentAttempt,
  provider: string,
  replaySafe: boolean,
): AgentCheckpointManifest {
  return {
    protocolVersion: CHECKPOINT_PROTOCOL_VERSION,
    provider,
    sourceAttemptId: attempt.id,
    sourceExecutionId: attempt.executionId!,
    generation: 1,
    createdAt: new Date().toISOString(),
    runtime: {
      kind: "docker",
      adapterVersion: "fake-runtime-v1",
      imageDigest: `sha256:${"c".repeat(64)}`,
    },
    agent: {
      provider: "claude-code",
      cliVersion: "2.1.296",
      sessionId: "session-1",
      safeBoundaryEventSequence: 12,
    },
    workspace: {
      key: "workspace/checkpoint.tar.zst",
      sha256: "a".repeat(64),
      sizeBytes: 1024,
      format: "tar+zstd",
    },
    session: {
      key: "session/checkpoint.tar.zst",
      sha256: "b".repeat(64),
      sizeBytes: 512,
      format: "claude-session-v1",
    },
    task: {
      taskId: "fake-task",
      cursor: "agent-turn:12",
      state: { turn: 12 },
    },
    effects: {
      committedThrough: 12,
      noInFlight: true,
    },
    boundary: {
      kind: "tool-call-complete",
      sequence: 12,
      replaySafe,
      externalEffectWatermark: "tool-call:12",
    },
    supportedRuntimes: ["docker"],
    invocationFingerprint: "d".repeat(64),
  };
}
