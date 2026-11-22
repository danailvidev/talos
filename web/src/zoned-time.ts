/**
 * Convert a datetime-local wall clock (YYYY-MM-DDTHH:MM) in an IANA zone
 * to a UTC Date, and back. The browser's datetime-local value is timezone-
 * naive; the zone dropdown is what gives it meaning.
 */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function partsInZone(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const num = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    hour: num("hour"),
    minute: num("minute"),
  };
}

/** Browser zone when the schedule does not pin one. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function effectiveTimeZone(timezone: string | undefined): string {
  return timezone && timezone.length > 0 ? timezone : browserTimeZone();
}

export function utcToWallClock(iso: string, timeZone: string | undefined): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const zone = effectiveTimeZone(timeZone);
  const p = partsInZone(date, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Stable YYYY-MM-DD key for one instant in the instance's calendar. */
export function calendarDateInTimeZone(
  value: Date | string,
  timeZone: string | undefined,
): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  return utcToWallClock(date.toISOString(), timeZone).slice(0, 10);
}

/** UTC instant at which the instance's current calendar day began. */
export function startOfCalendarDay(
  value: Date,
  timeZone: string | undefined,
): Date {
  const day = calendarDateInTimeZone(value, timeZone);
  return wallClockToUtc(`${day}T00:00`, timeZone);
}

export function wallClockToUtc(local: string, timeZone: string | undefined): Date {
  const match = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return new Date(Number.NaN);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const zone = effectiveTimeZone(timeZone);

  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 3; i++) {
    const wall = partsInZone(new Date(utc), zone);
    const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
    const wantedAsUtc = Date.UTC(year, month - 1, day, hour, minute);
    utc += wantedAsUtc - wallAsUtc;
  }
  return new Date(utc);
}

export function weekdayOfWallClock(local: string): number {
  const match = local.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return 0;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
}

export function hourMinuteOfWallClock(local: string): { hour: number; minute: number } {
  const match = local.match(/T(\d{2}):(\d{2})/);
  if (!match) return { hour: 9, minute: 0 };
  return { hour: Number(match[1]), minute: Number(match[2]) };
}
