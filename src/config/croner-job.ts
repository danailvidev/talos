import { Cron, type CronOptions } from "croner";
import type { Trigger } from "./schema.ts";

/**
 * Turns a stored trigger into the Croner pattern + options the scheduler and
 * the "next run" display both use, so a loop cannot fire at a time the UI
 * would not have shown.
 */
export function cronerJob(
  trigger: Trigger,
): { pattern: string | Date; options: CronOptions } | null {
  if (trigger.type === "cron") {
    const options: CronOptions = {};
    if (trigger.timezone) options.timezone = trigger.timezone;
    if (trigger.startAt) options.startAt = new Date(trigger.startAt);
    return { pattern: trigger.expression, options };
  }
  if (trigger.type === "once") {
    const at = new Date(trigger.at);
    if (Number.isNaN(at.getTime())) return null;
    const options: CronOptions = { maxRuns: 1 };
    if (trigger.timezone) options.timezone = trigger.timezone;
    return { pattern: at, options };
  }
  return null;
}

export function nextRunForTrigger(
  trigger: Trigger,
): { nextRun: string | null; scheduleError?: string } {
  const job = cronerJob(trigger);
  if (!job) return { nextRun: null };

  try {
    const next = new Cron(job.pattern, job.options).nextRun();
    return { nextRun: next ? next.toISOString() : null };
  } catch (err) {
    return {
      nextRun: null,
      scheduleError: err instanceof Error ? err.message : String(err),
    };
  }
}
