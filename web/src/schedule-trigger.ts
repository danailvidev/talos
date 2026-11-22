import type { Trigger } from "./api.ts";
import {
  hourMinuteOfWallClock,
  wallClockToUtc,
  weekdayOfWallClock,
} from "./zoned-time.ts";

export type LoopFrequency = "once" | "daily" | "weekly" | "custom";

export function buildTrigger(
  frequency: LoopFrequency,
  firstRun: string,
  timeZone: string,
  customCron: string,
): Trigger {
  const tz = timeZone || undefined;
  const at = wallClockToUtc(firstRun, tz);
  if (Number.isNaN(at.getTime())) {
    throw new Error("First run is not a valid date and time.");
  }
  const startAt = at.toISOString();
  const { hour, minute } = hourMinuteOfWallClock(firstRun);

  if (frequency === "once") {
    return { type: "once", at: startAt, timezone: tz };
  }
  if (frequency === "daily") {
    return {
      type: "cron",
      expression: `${minute} ${hour} * * *`,
      timezone: tz,
      startAt,
    };
  }
  if (frequency === "weekly") {
    const weekday = weekdayOfWallClock(firstRun);
    return {
      type: "cron",
      expression: `${minute} ${hour} * * ${weekday}`,
      timezone: tz,
      startAt,
    };
  }
  const expression = customCron.trim();
  if (expression.split(/\s+/).length < 5) {
    throw new Error("Custom cron needs at least 5 fields, e.g. 0 9 * * 1-5.");
  }
  return { type: "cron", expression, timezone: tz, startAt };
}
