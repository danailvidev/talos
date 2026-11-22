import type { TaskContext } from "./task.ts";

export interface WatermarkWindow {
  /** Poll for items changed at or after this instant. */
  since: Date;
  /** True on the very first run, when the watermark was just seeded. */
  seeded: boolean;
}

/**
 * Resolves the polling window for a run.
 *
 * On a task's first run there is no watermark, and polling without one means
 * GitLab reports every failure still in its retention window and Azure DevOps
 * every already-assigned work item — dozens of tickets and DMs on install. So the
 * first run seeds the watermark to now and processes nothing historical.
 *
 * `--since` overrides this by writing the watermark before the run, which is the
 * deliberate backfill path.
 */
export async function resolveWindow(
  ctx: TaskContext,
  now: Date = new Date(),
): Promise<WatermarkWindow> {
  const existing = await ctx.state.getWatermark(ctx.taskId);

  if (existing) return { since: existing, seeded: false };

  await ctx.state.setWatermark(ctx.taskId, now);
  ctx.logger.info(
    { watermark: now.toISOString() },
    "first run: watermark seeded to now, skipping all history. " +
      "Use --since to backfill deliberately.",
  );
  return { since: now, seeded: true };
}

/**
 * Advances the watermark, but only on a fully successful run.
 *
 * Advancing after a partial failure would skip whatever was missed: the failed
 * item falls behind the new watermark and is never polled again. Leaving it
 * behind costs a re-poll; moving it loses work silently.
 */
export async function advanceWatermark(
  ctx: TaskContext,
  to: Date,
  outcome: { failures: number },
): Promise<boolean> {
  if (outcome.failures > 0) {
    ctx.logger.warn(
      { failures: outcome.failures },
      "watermark not advanced: the run had failures, so the window stays open",
    );
    return false;
  }

  // Never move backwards. A concurrent run that polled a later window may have
  // already advanced past this one; regressing would re-poll ground already
  // covered. (A --since backfill still advances normally on success, since `to`
  // is newer than the watermark it set.)
  const current = await ctx.state.getWatermark(ctx.taskId);
  if (current && current > to) return false;

  await ctx.state.setWatermark(ctx.taskId, to);
  return true;
}
