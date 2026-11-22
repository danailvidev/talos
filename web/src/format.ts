/**
 * Display helpers shared by the list and detail panes.
 *
 * Timestamps are *not* here: they depend on both the instance's timezone and this
 * developer's chosen notation, and a helper that takes those as arguments is a
 * helper somebody eventually calls without them (which is how a handful of dates
 * came to ignore the configured zone). They live on `useFormat()` instead —
 * see `FormatContext.tsx`. What is left here is either notation-free or takes the
 * number format explicitly.
 */

import { formatNumber, type NumberFormat } from "./formats.ts";

export function duration(ms: number | null | undefined, format?: NumberFormat): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  // The one decimal here is the only place a duration has a separator, and on a
  // comma-decimal setting "1.5s" is as wrong as "08/09" is on a day-first one.
  if (ms < 60_000) {
    return `${formatNumber(ms / 1000, format, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Relative time, because "3m ago" answers "did the last run just happen?" at a
 * glance where a timestamp does not. The absolute value goes in a `title`.
 */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;

  const seconds = Math.round((Date.now() - then) / 1000);
  const future = seconds < 0;
  const n = Math.abs(seconds);

  const [value, unit] =
    n < 60
      ? [n, "s"]
      : n < 3600
        ? [Math.round(n / 60), "m"]
        : n < 86_400
          ? [Math.round(n / 3600), "h"]
          : [Math.round(n / 86_400), "d"];

  return future ? `in ${value}${unit}` : `${value}${unit} ago`;
}

/**
 * "Ada Lovelace" -> "A.Lovelace". PR cards are tight on horizontal space, so the
 * full name only shows up in the title/tooltip; single-word names (usernames,
 * bots) pass through unchanged since there's nothing to abbreviate.
 */
export function abbreviateName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  return `${first[0]}.${last}`;
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function clock12(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return minute === 0 ? `${h}${period}` : `${h}:${String(minute).padStart(2, "0")}${period}`;
}

/**
 * Compact schedule/trigger line for loop cards. Cron shapes the picker can
 * write become "Daily @ 2AM" / "Weekly (Sunday)"; anything else stays the
 * raw expression. Manual (no cron) is a trigger, not a schedule.
 */
export function scheduleBadge(schedule: string | null): {
  tone: "warning" | "danger" | "muted";
  label: string;
} {
  if (!schedule) return { tone: "muted", label: "Trigger: Manual" };

  const everyN = schedule.match(/^\*\/(\d{1,2}) \* \* \* \*$/);
  if (everyN) return { tone: "warning", label: `Schedule: Every ${Number(everyN[1])}m` };

  const hourly = schedule.match(/^(\d{1,2}) \* \* \* \*$/);
  if (hourly) {
    return { tone: "warning", label: `Schedule: Hourly @ :${String(Number(hourly[1])).padStart(2, "0")}` };
  }

  const daily = schedule.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (daily) {
    return {
      tone: "warning",
      label: `Schedule: Daily @ ${clock12(Number(daily[2]), Number(daily[1]))}`,
    };
  }

  const weekly = schedule.match(/^(\d{1,2}) (\d{1,2}) \* \* ([\d,]+)$/);
  if (weekly) {
    const days = weekly[3]!.split(",").map(Number).filter((d) => d >= 0 && d <= 6);
    const names = days.map((d) => WEEKDAY_NAMES[d]);
    const dayText =
      names.length === 1 ? names[0] : names.map((n) => n?.slice(0, 3)).join(", ");
    return { tone: "danger", label: `Schedule: Weekly (${dayText})` };
  }

  const monthly = schedule.match(/^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/);
  if (monthly) {
    return { tone: "danger", label: `Schedule: Monthly (day ${Number(monthly[3])})` };
  }

  return { tone: "warning", label: `Schedule: ${schedule}` };
}
