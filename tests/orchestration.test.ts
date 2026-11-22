import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";
import { AgentOrchestrationService } from "../src/application/agent-orchestration-service.ts";
import type {
  AgentRuntimeLifecycle,
  ManagedRuntimeResource,
  RuntimePresence,
} from "../src/core/orchestration.ts";
import { createLogger } from "../src/logging/logger.ts";
import {
  HostProcessRuntime,
  hostProcessMarker,
  hostProcessRuntimeId,
} from "../src/infrastructure/agent/host-runtime.ts";
import { migrate } from "../src/persistence/migrations.ts";
import { SqliteOrchestrationStore } from "../src/persistence/orchestration-store.ts";

const request = {
  lane: "background" as const,
  workloadKind: "test-agent",
  runtimeKind: "docker" as const,
  executionId: "run-1",
  runtimeId: "container-1",
};

describe("durable agent orchestration", () => {
  test("does not reuse an expired slot before runtime reconciliation", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const store = new SqliteOrchestrationStore(db);
    const first = store.tryReserve(1, request, 1)!;
    await Bun.sleep(2);

    expect(store.tryReserve(1, { ...request, executionId: "run-2", runtimeId: "container-2" }, 30_000))
      .toBeUndefined();
    expect(store.get(first.id)?.state).toBe("starting");
    db.close();
  });

  test("fences stale renewal and finalization by owner token", () => {
    const db = new Database(":memory:");
    migrate(db);
    const store = new SqliteOrchestrationStore(db);
    const attempt = store.tryReserve(1, request, 30_000)!;

    expect(store.renew(attempt.id, "stale-owner", 30_000)).toBe(false);
    expect(store.finish(attempt.id, "stale-owner", "succeeded")).toBe(false);
    expect(store.get(attempt.id)?.state).toBe("starting");
    expect(store.finish(attempt.id, attempt.ownerToken, "succeeded")).toBe(true);
    expect(db.query<{ event_type: string; to_state: string }, [string]>(
      `SELECT event_type, to_state FROM orchestration_events
        WHERE attempt_id = ? ORDER BY id`,
    ).all(attempt.id)).toEqual([
      { event_type: "reserved", to_state: "starting" },
      { event_type: "transition", to_state: "succeeded" },
    ]);
    db.close();
  });

  test("a new process resumes admissions a shutdown left draining", () => {
    const db = new Database(":memory:");
    migrate(db);
    const store = new SqliteOrchestrationStore(db);
    store.setDraining(true);
    const service = orchestration(store, new FakeRuntime("missing"));

    expect(service.resumeAfterShutdown()).toBe(true);
    expect(service.snapshot(1, 0).draining).toBe(false);
    expect(store.tryReserve(1, request, 30_000)?.state).toBe("starting");

    expect(service.resumeAfterShutdown()).toBe(false);
    db.close();
  });

  test("startup stops a surviving resource before releasing its slot", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const store = new SqliteOrchestrationStore(db);
    const attempt = store.tryReserve(1, request, 30_000)!;
    const runtime = new FakeRuntime("running");
    const service = orchestration(store, runtime);

    await service.reconcile(true);

    expect(runtime.stopped).toEqual(["container-1"]);
    expect(store.get(attempt.id)?.state).toBe("cancelled");
    expect(store.counts().occupied).toBe(0);
    db.close();
  });

  test("inspection failure remains visible and keeps capacity occupied", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const store = new SqliteOrchestrationStore(db);
    const attempt = store.tryReserve(1, request, 30_000)!;
    const service = orchestration(store, new FakeRuntime("unknown"));

    await service.reconcile(true);

    expect(store.get(attempt.id)?.state).toBe("uncertain");
    expect(store.counts()).toEqual({ occupied: 1, uncertain: 1 });
    expect(service.snapshot(1, 0).available).toBe(0);
    db.close();
  });

  test("operator cancellation stops a persisted runtime by execution identity", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const store = new SqliteOrchestrationStore(db);
    const attempt = store.tryReserve(1, request, 30_000)!;
    store.markRunning(attempt.id, attempt.ownerToken, "container-1");
    const runtime = new FakeRuntime("running");
    const service = orchestration(store, runtime);

    expect(await service.stopExecution("run-1")).toBe(true);
    expect(runtime.stopped).toEqual(["container-1"]);
    expect(store.get(attempt.id)?.state).toBe("cancelled");
    expect(store.counts().occupied).toBe(0);
    db.close();
  });

  test("host process reconciliation verifies the attempt marker before stopping", async () => {
    const runtime = new HostProcessRuntime();
    const attemptId = crypto.randomUUID();
    const proc = Bun.spawn(["bash", "-c", "sleep 30"], {
      env: { ...process.env, ...hostProcessMarker(attemptId) },
      stdout: "ignore",
      stderr: "ignore",
    });
    const id = hostProcessRuntimeId(proc.pid, attemptId);

    let presence = await runtime.inspect(id);
    for (let attempt = 0; attempt < 20 && presence !== "running"; attempt++) {
      await Bun.sleep(10);
      presence = await runtime.inspect(id);
    }
    expect(presence).toBe("running");
    expect(await runtime.inspect(hostProcessRuntimeId(proc.pid, "wrong-attempt"))).toBe("missing");
    expect(await runtime.stop(id)).toBe(true);
    await proc.exited;
    expect(await runtime.inspect(id)).toBe("missing");
  });
});

function orchestration(
  store: SqliteOrchestrationStore,
  runtime: AgentRuntimeLifecycle,
): AgentOrchestrationService {
  return new AgentOrchestrationService(
    store,
    createLogger({ destination: new PassThrough(), pretty: false, level: "fatal" }),
    { runtimes: [runtime] },
  );
}

class FakeRuntime implements AgentRuntimeLifecycle {
  readonly kind = "docker" as const;
  readonly stopped: string[] = [];

  constructor(private presence: RuntimePresence) {}

  async inspect(): Promise<RuntimePresence> {
    return this.presence;
  }

  async list(): Promise<ManagedRuntimeResource[]> {
    return [];
  }

  async stop(id: string): Promise<boolean> {
    this.stopped.push(id);
    this.presence = "missing";
    return true;
  }
}
