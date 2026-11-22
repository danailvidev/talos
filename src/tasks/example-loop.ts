import { z } from "zod";
import { TransientError } from "../core/errors.ts";
import { advanceWatermark, resolveWindow } from "../core/watermark.ts";
import { mutate } from "../core/step.ts";
import type { Task, TaskContext, TaskResult } from "../core/task.ts";

export const ExampleLoopParamsSchema = z.object({
  /** Fake items to poll, so the shape of a real scheduled task is exercised. */
  itemCount: z.number().int().min(0).max(100).default(3),
  /**
   * Fails this many times before succeeding, to demonstrate retry and backoff.
   * The failure is a TransientError so the policy actually engages.
   */
  failTimes: z.number().int().min(0).default(0),
  /**
   * Pretend every item predates the watermark, to show first-run flood
   * protection working.
   */
  itemsAreHistorical: z.boolean().default(false),
});

type Params = z.infer<typeof ExampleLoopParamsSchema>;

interface FakeItem {
  id: string;
  title: string;
  updatedAt: Date;
}

/**
 * Reference scheduled task used by executor/persistence tests. Not registered
 * in the product.
 *
 * It walks the same path a real scheduled task does: resolve the window, poll,
 * cap, claim, act behind the dry-run guard, complete or release, advance the
 * watermark. Keep it honest about the claim/complete protocol.
 */
export const exampleScheduledTask: Task<Params> = {
  id: "example-loop",
  name: "Example scheduled loop",
  description: "Fake polling task that exercises the engine end to end.",
  kind: "loop",
  paramsSchema: ExampleLoopParamsSchema,

  async run(ctx: TaskContext, params: Params): Promise<TaskResult> {
    const startedAt = new Date();
    const { since, seeded } = await resolveWindow(ctx, startedAt);

    const items = await ctx.step("poll-items", async () => {
      let remaining = params.failTimes;
      if (remaining > 0) {
        params.failTimes -= 1;
        throw new TransientError(
          `simulated transient failure (${remaining} remaining)`,
          { connector: "example" },
        );
      }

      // Historical items sit an hour before the window; fresh ones inside it.
      const offsetMs = params.itemsAreHistorical ? -3_600_000 : 1_000;
      return Array.from({ length: params.itemCount }, (_, i) => ({
        id: `item-${i + 1}`,
        title: `Example item ${i + 1}`,
        updatedAt: new Date(startedAt.getTime() + offsetMs),
      })) satisfies FakeItem[];
    });

    // The watermark filter is what stops a first run from acting on all history.
    const fresh = items.filter((item) => item.updatedAt >= since);
    if (fresh.length < items.length) {
      ctx.logger.info(
        { seen: items.length, fresh: fresh.length, since: since.toISOString() },
        `${items.length - fresh.length} item(s) predate the watermark, ignoring`,
      );
    }

    const batch = fresh.slice(0, ctx.maxItemsPerRun);
    if (batch.length < fresh.length) {
      ctx.logger.warn(
        { fresh: fresh.length, cap: ctx.maxItemsPerRun },
        `capped at ${ctx.maxItemsPerRun} items; the rest wait for the next run`,
      );
    }

    let processed = 0;
    let skipped = 0;
    let failures = 0;

    for (const item of batch) {
      if (ctx.signal.aborted) {
        ctx.logger.warn("shutdown requested, stopping early");
        // Counted as a failure so the watermark holds and the remainder is
        // re-polled next time rather than skipped.
        failures++;
        break;
      }

      const claimed = await ctx.state.claimEvent(
        ctx.taskId,
        item.id,
        "example-item",
      );
      if (!claimed) {
        skipped++;
        continue;
      }

      try {
        await ctx.step(`notify:${item.id}`, async () => {
          await mutate(ctx, `notify about ${item.title}`, async () => {
            ctx.logger.info({ item: item.id }, `notified about ${item.title}`);
          });
        });
        await ctx.state.completeEvent(ctx.taskId, item.id, {
          title: item.title,
        });
        processed++;
      } catch (err) {
        // Release the claim so a later run can retry, then let the executor
        // record the failure.
        await ctx.state.failEvent(ctx.taskId, item.id, String(err));
        throw err;
      }
    }

    // Only advances on a clean run; see advanceWatermark.
    if (!seeded) await advanceWatermark(ctx, startedAt, { failures });

    return {
      itemsSeen: items.length,
      itemsProcessed: processed,
      itemsSkipped: skipped,
      details: { since: since.toISOString(), seeded },
    };
  },
};
