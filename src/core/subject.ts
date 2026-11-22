/**
 * What a loop tracks across polls, and the narrow slice of it that `core` needs.
 *
 * A **subject** is a thing that persists between ticks: a merge request, a spec
 * file, a Jira ticket. A **fingerprint** is the version of it last acted on: an
 * MR head sha, a failure signature, a ticket's `updated` timestamp. Together
 * they answer the one question every loop here asks — *have I already handled
 * this thing, at this version?*
 *
 * The full read surface (history, counts, close) lives on `SubjectRepository` in
 * `application/ports.ts`; see `persistence/subject-store.ts` for the reasoning
 * behind the key/fingerprint split.
 */

export type WorkSubjectState = "open" | "closed";

export interface WorkSubject {
  id: number;
  loopId: string;
  subjectKey: string;
  /** The version last acted on. Undefined means seen but never handled. */
  fingerprint?: string;
  state: WorkSubjectState;
  externalRef?: string;
  externalUrl?: string;
  metadata?: Record<string, unknown>;
  firstSeenAt: Date;
  updatedAt: Date;
  lastSeenAt: Date;
  seenCount: number;
  closedAt?: Date;
}

export interface ObserveSubjectInput {
  loopId: string;
  subjectKey: string;
  /** The version just observed, compared against what was last acted on. */
  fingerprint?: string;
  externalRef?: string;
  externalUrl?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Opening a subject *because* something was just created for it.
 *
 * Distinct from `observe`, which records a sighting and leaves the fingerprint
 * NULL so a crashed handler retries. This is the other order — the external
 * thing (a Jira ticket) exists already, and the row is the guard that stops a
 * second one being created — so the fingerprint and the external ref are written
 * in the same insert as the row itself.
 */
export interface OpenSubjectInput {
  loopId: string;
  subjectKey: string;
  fingerprint: string;
  externalRef?: string;
  externalUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface MarkActedOnArgs {
  externalRef?: string;
  externalUrl?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The two calls that make a loop idempotent: a discoverer observes, and whatever
 * completed the work marks it. Deliberately narrow — neither a discoverer nor
 * the worker pool has any business closing a subject or reading its history.
 */
export interface SubjectTracker {
  observe(input: ObserveSubjectInput): { subject: WorkSubject; changed: boolean };
  markActedOn(
    loopId: string,
    subjectKey: string,
    fingerprint: string,
    args?: MarkActedOnArgs,
  ): void;
}
