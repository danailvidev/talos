/**
 * Webhooks: the other end of the same discovery.
 *
 * A loop polls because nothing tells it when something happened. GitLab *can*
 * tell it — a merge request assigned, a comment left, a pipeline failed — and
 * the difference between a two-minute sweep and a webhook is the difference
 * between "the bot noticed eventually" and "the bot answered". Fifteen
 * developers notice that difference all day.
 *
 * What a delivery does *not* do is act. It requests a trigger: the loop runs its
 * normal discovery, observes subjects, enqueues jobs, and dedupes against
 * everything it already knew. So a webhook and the reconciliation poll racing on
 * the same merge request still produce one job, and a delivery lost to a network
 * blip is picked up by the next sweep. That is why the polls stay on — slower,
 * as the safety net they now are, rather than the primary clock.
 *
 * The request is coalesced per loop rather than queued per event: GitLab sends a
 * burst (push, then pipeline, then note) for one human action, and running the
 * loop three times would find the same work twice and waste two API budgets.
 */

/** A loop with at least one delivery waiting to be turned into a run. */
export interface PendingTrigger {
  taskId: string;
  /** When the *first* uncollapsed delivery arrived — the age of the oldest news. */
  requestedAt: Date;
  /** How many deliveries collapsed into this one request. */
  events: number;
  /** Where it came from, for the log line: `gitlab:merge_request`. */
  source: string;
}

/**
 * The scheduler's view: read what is waiting, take it, run it. Writing is the
 * ingress side (`api/webhooks.ts`); both halves are one table so a delivery
 * arriving mid-run is not lost — it simply stays pending until the run ends.
 */
export interface TriggerQueue {
  /**
   * Everything waiting, oldest first. Cheap enough to poll every few seconds:
   * one row per loop, and only while there is news.
   */
  pending(): PendingTrigger[];
  /**
   * Takes the request off the queue, returning what was taken. Undefined when
   * another poll got there first, which makes this the claim — nothing runs
   * twice off one request.
   */
  claim(taskId: string): PendingTrigger | undefined;
  /**
   * Records that this loop has news. Collapses into an existing request rather
   * than adding a second one.
   */
  request(taskId: string, source: string): void;
}
