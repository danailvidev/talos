export type ClaimStatus = "claimed" | "completed" | "failed";

export interface ProcessedEvent {
  taskId: string;
  externalId: string;
  eventType: string;
  status: ClaimStatus;
  claimedAt: Date;
  completedAt?: Date;
  attempts: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Idempotency store.
 *
 * The check-then-act pattern (hasProcessed -> work -> markProcessed) has a crash
 * window: if the process dies after creating the Jira ticket but before marking,
 * the next poll files a second ticket. So the store hands out *claims* instead —
 * atomic against a unique (task_id, external_id) index.
 */
export interface StateStore {
  /**
   * Atomically claims an event. False means another run already holds or has
   * completed this claim. Never blocks.
   */
  claimEvent(
    taskId: string,
    externalId: string,
    eventType: string,
  ): Promise<boolean>;

  completeEvent(
    taskId: string,
    externalId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;

  /** Releases a claim so a later run may retry it. */
  failEvent(
    taskId: string,
    externalId: string,
    error: string,
  ): Promise<void>;

  /**
   * Claims still in `claimed` past a timeout — an unclean shutdown. These are
   * reconciled against the target system, never blindly retried: blind retry is
   * how duplicates get created.
   */
  findStaleClaims(
    taskId: string,
    olderThan: Date,
  ): Promise<ProcessedEvent[]>;

  getEvent(
    taskId: string,
    externalId: string,
  ): Promise<ProcessedEvent | null>;

  /**
   * High-water mark. Seeded to "now" on a task's first run so installing
   * talos does not file a ticket for every failure still in GitLab's
   * retention window.
   */
  getWatermark(taskId: string): Promise<Date | null>;
  setWatermark(taskId: string, at: Date): Promise<void>;
  countByStatus(taskId: string): Promise<Record<ClaimStatus, number>>;
  clearTaskState(taskId: string): Promise<void>;
}

/**
 * In-memory implementation. Used by tests and by `workflow run` before Phase 3
 * lands SQLite; state vanishes with the process, which is correct for tests and
 * loudly wrong for production.
 */
export class MemoryStateStore implements StateStore {
  private readonly events = new Map<string, ProcessedEvent>();
  private readonly watermarks = new Map<string, Date>();

  private key(taskId: string, externalId: string): string {
    return `${taskId}\0${externalId}`;
  }

  async claimEvent(
    taskId: string,
    externalId: string,
    eventType: string,
  ): Promise<boolean> {
    const key = this.key(taskId, externalId);
    const existing = this.events.get(key);

    // A failed claim was explicitly released, so it is re-claimable. Anything
    // else is held by someone or already done.
    if (existing && existing.status !== "failed") return false;

    this.events.set(key, {
      taskId,
      externalId,
      eventType,
      status: "claimed",
      claimedAt: new Date(),
      attempts: (existing?.attempts ?? 0) + 1,
    });
    return true;
  }

  async completeEvent(
    taskId: string,
    externalId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const event = this.events.get(this.key(taskId, externalId));
    if (!event) return;
    event.status = "completed";
    event.completedAt = new Date();
    event.metadata = metadata;
    event.error = undefined;
  }

  async failEvent(
    taskId: string,
    externalId: string,
    error: string,
  ): Promise<void> {
    const event = this.events.get(this.key(taskId, externalId));
    if (!event) return;
    event.status = "failed";
    event.error = error;
  }

  async findStaleClaims(
    taskId: string,
    olderThan: Date,
  ): Promise<ProcessedEvent[]> {
    return [...this.events.values()].filter(
      (e) =>
        e.taskId === taskId &&
        e.status === "claimed" &&
        e.claimedAt < olderThan,
    );
  }

  async getEvent(
    taskId: string,
    externalId: string,
  ): Promise<ProcessedEvent | null> {
    return this.events.get(this.key(taskId, externalId)) ?? null;
  }

  async getWatermark(taskId: string): Promise<Date | null> {
    return this.watermarks.get(taskId) ?? null;
  }

  async setWatermark(taskId: string, at: Date): Promise<void> {
    this.watermarks.set(taskId, at);
  }

  async countByStatus(taskId: string): Promise<Record<ClaimStatus, number>> {
    const counts: Record<ClaimStatus, number> = {
      claimed: 0,
      completed: 0,
      failed: 0,
    };
    for (const event of this.events.values()) {
      if (event.taskId === taskId) counts[event.status]++;
    }
    return counts;
  }

  async clearTaskState(taskId: string): Promise<void> {
    for (const [key, event] of this.events) {
      if (event.taskId === taskId) this.events.delete(key);
    }
    this.watermarks.delete(taskId);
  }
}
