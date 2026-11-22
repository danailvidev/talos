import type {
  AgentAttempt,
  AgentReservationRequest,
  AgentRuntimeLifecycle,
  AgentTerminalState,
  OrchestrationCapacity,
} from "../core/orchestration.ts";
import type { Logger } from "../logging/logger.ts";
import type { SqliteOrchestrationStore } from "../persistence/orchestration-store.ts";
import type {
  AgentCapacityLease,
  AgentHostCapacity,
} from "../infrastructure/agent/capacity.ts";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

export class AgentOrchestrationService implements AgentHostCapacity {
  private readonly runtimes: Map<AgentRuntimeLifecycle["kind"], AgentRuntimeLifecycle>;
  private readonly shutdown = new AbortController();

  constructor(
    private readonly store: SqliteOrchestrationStore,
    private readonly logger: Logger,
    private readonly options: {
      runtimes: AgentRuntimeLifecycle[];
      leaseMs?: number;
      heartbeatMs?: number;
      pollMs?: number;
    },
  ) {
    this.runtimes = new Map(options.runtimes.map((runtime) => [runtime.kind, runtime]));
  }

  installationId(): string {
    return this.store.installationId();
  }

  addRuntime(runtime: AgentRuntimeLifecycle): void {
    this.runtimes.set(runtime.kind, runtime);
  }

  async acquire(
    limit: number,
    request: AgentReservationRequest,
    signal?: AbortSignal,
  ): Promise<AgentCapacityLease> {
    const admissionSignal = signal
      ? AbortSignal.any([signal, this.shutdown.signal])
      : this.shutdown.signal;
    const leaseMs = this.options.leaseMs ?? DEFAULT_LEASE_MS;
    const heartbeatMs = this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    let attempt = this.store.tryReserve(limit, request, leaseMs);
    let announcedDrain = false;
    while (!attempt) {
      if (!announcedDrain && this.store.draining()) {
        announcedDrain = true;
        this.logger.warn(
          { executionId: request.executionId, runtimeId: request.runtimeId },
          "agent pool is draining; this run is waiting for admissions to resume",
        );
      }
      await abortableDelay(this.options.pollMs ?? 100, admissionSignal);
      attempt = this.store.tryReserve(limit, request, leaseMs);
    }

    const ownership = new AbortController();
    const combined = AbortSignal.any([admissionSignal, ownership.signal]);
    let released = false;
    const heartbeat = setInterval(() => {
      if (this.store.renew(attempt.id, attempt.ownerToken, leaseMs)) return;
      clearInterval(heartbeat);
      this.store.markUncertain(
        attempt.id,
        attempt.ownerToken,
        "durable ownership renewal failed; runtime state requires reconciliation",
      );
      ownership.abort(new Error("agent capacity ownership was lost"));
      this.logger.error(
        { attemptId: attempt.id, slot: attempt.slot, runtimeId: attempt.runtimeId },
        "lost durable ownership of an agent execution",
      );
    }, heartbeatMs);

    return {
      attemptId: attempt.id,
      signal: combined,
      markRunning: (runtimeId) =>
        this.store.markRunning(attempt.id, attempt.ownerToken, runtimeId),
      markStopping: (reason) =>
        this.store.markStopping(attempt.id, attempt.ownerToken, reason),
      retain: (reason) =>
        this.store.markUncertain(attempt.id, attempt.ownerToken, reason),
      release: async (state: AgentTerminalState = "succeeded", reason?: string) => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        if (!this.store.finish(attempt.id, attempt.ownerToken, state, reason)) {
          ownership.abort(new Error("agent capacity ownership was lost before finalization"));
          this.logger.warn(
            { attemptId: attempt.id, slot: attempt.slot, state },
            "stale agent owner could not finalize its attempt",
          );
        }
      },
    };
  }

  snapshot(total: number, interactiveReservation: number): OrchestrationCapacity {
    const counts = this.store.counts();
    return {
      total,
      interactiveReservation,
      occupied: counts.occupied,
      uncertain: counts.uncertain,
      available: Math.max(0, total - counts.occupied),
      draining: this.store.draining(),
    };
  }

  setDraining(draining: boolean): void {
    this.store.setDraining(draining);
    this.logger.info({ draining }, draining ? "agent pool is draining" : "agent pool resumed");
  }

  /**
   * Shutdown sets draining so this process admits nothing while it exits. The
   * flag is stored in the database, and the next process would otherwise sit
   * in `acquire` forever: `tryReserve` refuses every slot until somebody
   * presses resume.
   */
  resumeAfterShutdown(): boolean {
    if (!this.store.draining()) return false;
    this.setDraining(false);
    return true;
  }

  stopAdmissions(reason = "orchestrator is shutting down"): void {
    this.store.setDraining(true);
    this.shutdown.abort(new Error(reason));
  }

  attempts(limit = 100): AgentAttempt[] {
    return this.store.recent(limit);
  }

  activeAttempts(): AgentAttempt[] {
    return this.store.active();
  }

  async stopExecution(
    executionId: string,
    reason = "cancelled by operator",
  ): Promise<boolean> {
    const attempts = this.store.active().filter(
      (attempt) => attempt.executionId === executionId,
    );
    let confirmed = true;
    for (const attempt of attempts) {
      if (!attempt.runtimeId) {
        this.store.reconcileFinish(
          attempt.id,
          "cancelled",
          `${reason}; runtime creation was not recorded`,
        );
        continue;
      }
      const runtime = this.runtimes.get(attempt.runtimeKind);
      if (!runtime) {
        confirmed = false;
        this.store.reconcileUncertain(
          attempt.id,
          `${reason}; no ${attempt.runtimeKind} lifecycle adapter is configured`,
        );
        continue;
      }
      this.store.reconcileUncertain(attempt.id, `${reason}; stopping runtime`);
      if (await runtime.stop(attempt.runtimeId)) {
        this.store.reconcileFinish(
          attempt.id,
          "cancelled",
          `${reason}; runtime termination confirmed`,
        );
      } else {
        confirmed = false;
        this.store.reconcileUncertain(
          attempt.id,
          `${reason}; runtime termination is unresolved`,
        );
      }
    }
    return confirmed;
  }

  /**
   * Startup treats every active row as stale because the single-daemon lease
   * proves its former owner is gone. Periodic passes act only on expired rows.
   */
  async reconcile(startup = false): Promise<void> {
    const attempts = startup ? this.store.active() : this.store.expired();
    const installationId = this.store.installationId();
    const knownRuntimeIds = new Set(
      this.store.active().flatMap((attempt) => attempt.runtimeId ? [attempt.runtimeId] : []),
    );
    let discoveryUnresolved = false;

    for (const runtime of this.runtimes.values()) {
      if (startup && runtime.listUnscoped) {
        try {
          for (const resource of await runtime.listUnscoped()) {
            if (resource.executionId && this.store.hasExecution(resource.executionId)) {
              const stopped = await runtime.stop(resource.id);
              if (!stopped) discoveryUnresolved = true;
              this.logger.warn(
                { runtime: runtime.kind, runtimeId: resource.id, stopped },
                "reconciled a legacy unscoped runtime owned by this database",
              );
            } else {
              discoveryUnresolved = true;
              this.logger.error(
                { runtime: runtime.kind, runtimeId: resource.id },
                "found an unscoped legacy runtime without database ownership proof; left it untouched",
              );
            }
          }
        } catch (cause) {
          discoveryUnresolved = true;
          this.logger.error(
            { cause, runtime: runtime.kind },
            "could not inspect legacy unscoped runtime resources",
          );
        }
      }
      let resources;
      try {
        resources = await runtime.list(installationId);
      } catch (cause) {
        discoveryUnresolved = true;
        this.logger.error(
          { cause, runtime: runtime.kind },
          "could not list managed runtime resources; capacity remains reserved",
        );
        for (const attempt of attempts.filter((item) => item.runtimeKind === runtime.kind)) {
          this.store.reconcileUncertain(attempt.id, `${runtime.kind} resource listing failed`);
        }
        continue;
      }
      for (const resource of resources) {
        if (knownRuntimeIds.has(resource.id)) continue;
        const stopped = await runtime.stop(resource.id);
        this.logger.warn(
          { runtime: runtime.kind, runtimeId: resource.id, stopped },
          "reconciled an untracked installation-scoped runtime resource",
        );
      }
    }

    for (const attempt of attempts) {
      if (attempt.workloadKind === "legacy-agent") {
        if (discoveryUnresolved) {
          this.store.reconcileUncertain(
            attempt.id,
            "legacy permit retained because runtime discovery or cleanup is unresolved",
          );
        } else {
          this.store.reconcileFinish(
            attempt.id,
            "cancelled",
            "legacy runtime discovery completed before admissions were enabled",
          );
        }
        continue;
      }
      if (!attempt.runtimeId) {
        this.store.reconcileFinish(
          attempt.id,
          "cancelled",
          "reconciliation confirmed no runtime identity was created",
        );
        continue;
      }

      const runtime = this.runtimes.get(attempt.runtimeKind);
      if (!runtime) {
        this.store.reconcileUncertain(
          attempt.id,
          `no ${attempt.runtimeKind} lifecycle adapter is configured`,
        );
        continue;
      }

      let presence;
      try {
        presence = await runtime.inspect(attempt.runtimeId);
      } catch (cause) {
        this.store.reconcileUncertain(attempt.id, `${attempt.runtimeKind} inspection failed`);
        this.logger.error(
          { cause, attemptId: attempt.id, runtimeId: attempt.runtimeId },
          "runtime inspection failed; retaining capacity reservation",
        );
        continue;
      }
      if (presence === "unknown") {
        this.store.reconcileUncertain(attempt.id, `${attempt.runtimeKind} state is unknown`);
        continue;
      }
      if (presence === "missing") {
        this.store.reconcileFinish(
          attempt.id,
          "failed",
          "reconciliation confirmed the runtime resource is absent",
        );
        continue;
      }

      this.store.reconcileUncertain(
        attempt.id,
        `stopping ${presence} runtime left by a previous owner`,
      );
      if (await runtime.stop(attempt.runtimeId)) {
        this.store.reconcileFinish(
          attempt.id,
          "cancelled",
          "stale runtime was stopped and confirmed absent during reconciliation",
        );
      }
    }
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}
