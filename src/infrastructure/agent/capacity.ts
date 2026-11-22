/**
 * Process-wide admission for container-backed agent work on one daemon.
 *
 * Two lanes. Background work (queued jobs, loops) is bounded by the agent
 * concurrency. Interactive work (a developer waiting on a chat turn) may use
 * any idle slot plus a small reserve background work can never take, so a chat
 * never queues behind a run of multi-minute fixes. Background waiters are
 * admitted fairly: the developer with the fewest running agents goes next,
 * FIFO among equals, so one person's batch cannot hold every slot.
 */
import type {
  AgentReservationRequest,
  AgentRuntimeKind,
  AgentTerminalState,
  OrchestrationCapacity,
} from "../../core/orchestration.ts";

const DEFAULT_AGENT_CONCURRENCY = 2;
const DEFAULT_INTERACTIVE_RESERVE = 1;
let limit = DEFAULT_AGENT_CONCURRENCY;
let interactiveReserve = DEFAULT_INTERACTIVE_RESERVE;
let activeBackground = 0;
let activeInteractive = 0;
/** Running background agents per actor; "" is work with no actor. */
const backgroundByActor = new Map<string, number>();

export type AgentPriority = "interactive" | "background";

export interface AgentAdmission {
  signal?: AbortSignal;
  /** Defaults to background. */
  priority?: AgentPriority;
  /** The developer the work is for; drives fair ordering of background waiters. */
  actorId?: string;
  executionId?: string;
  jobId?: string;
  workloadKind?: string;
  runtimeKind?: AgentRuntimeKind;
  /** Stable identity selected before runtime creation. */
  runtimeId?: string;
}

interface Waiter {
  actor: string;
  grant(): void;
}

const interactiveWaiters: Waiter[] = [];
const backgroundWaiters: Waiter[] = [];
const MAX_INTERACTIVE_BURST = 3;
let interactiveGrantsSinceBackground = 0;

export interface AgentResourceLimits {
  memory: string;
  cpus: number;
  pids: number;
}

let resources: AgentResourceLimits = { memory: "2g", cpus: 1, pids: 256 };

export interface AgentCapacityLease {
  readonly attemptId?: string;
  /** Aborts when the caller cancels or durable ownership is lost. */
  readonly signal: AbortSignal;
  markRunning(runtimeId?: string): boolean;
  markStopping(reason?: string): boolean;
  retain(reason: string): boolean;
  release(state?: AgentTerminalState, reason?: string): Promise<void>;
}

export interface AgentHostCapacity {
  acquire(
    limit: number,
    request: AgentReservationRequest,
    signal?: AbortSignal,
  ): Promise<AgentCapacityLease>;
  snapshot(total: number, interactiveReservation: number): OrchestrationCapacity;
}

let hostCapacity: AgentHostCapacity | undefined;

export function configureAgentHostCapacity(
  capacity?: AgentHostCapacity,
): void {
  hostCapacity = capacity;
}

export function setAgentConcurrency(next: number): void {
  if (!Number.isInteger(next) || next < 1) throw new Error("agent concurrency must be a positive integer");
  limit = next;
  if (
    activeBackground + activeInteractive === 0 &&
    interactiveWaiters.length + backgroundWaiters.length === 0
  ) {
    interactiveGrantsSinceBackground = 0;
  }
  drain();
}

/** Slots only interactive work may use, on top of the agent concurrency. */
export function setInteractiveAgentReserve(next: number): void {
  if (!Number.isInteger(next) || next < 0) {
    throw new Error("interactive agent reserve must be a non-negative integer");
  }
  interactiveReserve = next;
  drain();
}

export function activeAgentJobs(): number {
  return activeBackground + activeInteractive;
}

/** Waiters per lane, for capacity telemetry. */
export function waitingAgentJobs(): { interactive: number; background: number } {
  return { interactive: interactiveWaiters.length, background: backgroundWaiters.length };
}

export function agentCapacitySnapshot(): OrchestrationCapacity {
  const total = limit + interactiveReserve;
  if (hostCapacity) return hostCapacity.snapshot(total, interactiveReserve);
  const occupied = activeBackground + activeInteractive;
  return {
    total,
    interactiveReservation: interactiveReserve,
    occupied,
    uncertain: 0,
    available: Math.max(0, total - occupied),
    draining: false,
  };
}

export function setAgentResourceLimits(next: AgentResourceLimits): void {
  if (!/^\d+(?:\.\d+)?[bkmg]$/i.test(next.memory)) {
    throw new Error("agent memory must be a Docker size such as 2g or 768m");
  }
  if (!Number.isFinite(next.cpus) || next.cpus <= 0) {
    throw new Error("agent CPUs must be a positive number");
  }
  if (!Number.isInteger(next.pids) || next.pids < 16) {
    throw new Error("agent PID limit must be an integer of at least 16");
  }
  resources = { ...next };
}

export function agentResourceLimits(): Readonly<AgentResourceLimits> {
  return resources;
}

export function acquireAgentCapacity(admission: AgentAdmission = {}): Promise<AgentCapacityLease> {
  const { signal } = admission;
  const priority = admission.priority ?? "background";
  const actor = admission.actorId ?? "";
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const queue = priority === "interactive" ? interactiveWaiters : backgroundWaiters;
    const waiter: Waiter = {
      actor,
      grant: () => {
        signal?.removeEventListener("abort", cancel);
        occupy(priority, actor);
        let released = false;
        const localController = new AbortController();
        const combinedSignal = signal
          ? AbortSignal.any([signal, localController.signal])
          : localController.signal;
        const localRelease = () => {
          if (released) return;
          released = true;
          vacate(priority, actor);
        };
        if (!hostCapacity) {
          resolve({
            signal: combinedSignal,
            markRunning: () => !released,
            markStopping: () => !released,
            retain: () => !released,
            release: async () => localRelease(),
          });
          return;
        }
        const request: AgentReservationRequest = {
          lane: priority,
          actorId: admission.actorId,
          executionId: admission.executionId,
          jobId: admission.jobId,
          workloadKind: admission.workloadKind ?? "agent",
          runtimeKind: admission.runtimeKind ?? "docker",
          runtimeId: admission.runtimeId,
        };
        void hostCapacity.acquire(limit + interactiveReserve, request, combinedSignal).then(
          (hostLease) => resolve({
            attemptId: hostLease.attemptId,
            signal: AbortSignal.any([combinedSignal, hostLease.signal]),
            markRunning: (runtimeId) => hostLease.markRunning(runtimeId),
            markStopping: (reason) => hostLease.markStopping(reason),
            retain: (reason) => hostLease.retain(reason),
            release: async (state, reason) => {
              try {
                await hostLease.release(state, reason);
              } finally {
                localRelease();
              }
            },
          }),
          (error) => {
            localController.abort(error);
            localRelease();
            reject(error);
          },
        );
      },
    };
    const cancel = () => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    queue.push(waiter);
    drain();
  });
}

function occupy(priority: AgentPriority, actor: string): void {
  if (priority === "interactive") {
    activeInteractive += 1;
    return;
  }
  activeBackground += 1;
  backgroundByActor.set(actor, (backgroundByActor.get(actor) ?? 0) + 1);
}

function vacate(priority: AgentPriority, actor: string): void {
  if (priority === "interactive") {
    activeInteractive -= 1;
  } else {
    activeBackground -= 1;
    const remaining = (backgroundByActor.get(actor) ?? 1) - 1;
    if (remaining > 0) backgroundByActor.set(actor, remaining);
    else backgroundByActor.delete(actor);
  }
  drain();
}

function canGrant(priority: AgentPriority): boolean {
  if (activeBackground + activeInteractive >= limit + interactiveReserve) return false;
  return priority === "interactive" || activeBackground < limit;
}

/** The waiting actor with the fewest running agents; the earliest waiter among ties. */
function fairestBackgroundWaiter(): number {
  let best = 0;
  let bestRunning = Number.POSITIVE_INFINITY;
  for (const [index, waiter] of backgroundWaiters.entries()) {
    const running = backgroundByActor.get(waiter.actor) ?? 0;
    if (running < bestRunning) {
      best = index;
      bestRunning = running;
    }
  }
  return best;
}

function drain(): void {
  for (;;) {
    const backgroundReady = backgroundWaiters.length > 0 && canGrant("background");
    const interactiveReady = interactiveWaiters.length > 0 && canGrant("interactive");
    if (
      backgroundReady &&
      (!interactiveReady || interactiveGrantsSinceBackground >= MAX_INTERACTIVE_BURST)
    ) {
      backgroundWaiters.splice(fairestBackgroundWaiter(), 1)[0]?.grant();
      interactiveGrantsSinceBackground = 0;
      continue;
    }
    if (interactiveReady) {
      interactiveWaiters.shift()?.grant();
      interactiveGrantsSinceBackground += 1;
      continue;
    }
    if (backgroundReady) {
      backgroundWaiters.splice(fairestBackgroundWaiter(), 1)[0]?.grant();
      interactiveGrantsSinceBackground = 0;
      continue;
    }
    return;
  }
}
