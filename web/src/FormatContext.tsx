import { createContext, useContext, useMemo, type ReactNode } from "react";

import { duration } from "./format.ts";
import {
  DATE_FORMAT_PREFERENCE,
  NUMBER_FORMAT_PREFERENCE,
  formatDate,
  formatDateTime,
  formatNumber,
  formatTime,
  parseDateFormat,
  parseNumberFormat,
  type DateFormat,
  type NumberFormat,
} from "./formats.ts";
import { usePreference } from "./PreferencesContext.tsx";
import { useTimezone } from "./TimezoneContext.tsx";

/**
 * The formatters, already carrying this developer's choices and the instance's
 * timezone.
 *
 * A bound set rather than the raw preference values, because every call site would
 * otherwise have to pass three arguments and any one of them could be forgotten —
 * which is exactly how `stamp(iso)` calls that ignored the configured timezone crept
 * in before. `useFormat().stamp(iso)` cannot be got wrong.
 *
 * The timezone and the format are two different decisions and stay that way: the
 * zone is instance-wide (the whole team should read one run's start time as the same
 * moment), the notation is personal. See `formats.ts` for why the notation is a
 * preference at all.
 */
export interface Formatters {
  /** Date and time together — the default for a timestamp. */
  stamp(iso: string | null | undefined): string;
  /** The date alone. */
  date(iso: string | null | undefined): string;
  /** The clock time alone. */
  time(iso: string | null | undefined): string;
  /** A count or a measurement, grouped and pointed the way this developer reads them. */
  number(value: number | null | undefined, options?: Intl.NumberFormatOptions): string;
  /** An elapsed time — `840ms`, `1,5s`, `2m 3s`. Only the seconds decimal varies. */
  duration(ms: number | null | undefined): string;
  /** The chosen notations, for the dialog that sets them and for previews. */
  dateFormat: DateFormat;
  numberFormat: NumberFormat;
  /** The zone every date above is rendered in. Instance-wide. */
  timeZone: string;
}

const FormatContext = createContext<Formatters | undefined>(undefined);

export function FormatProvider({ children }: { children: ReactNode }) {
  const timeZone = useTimezone();
  const [dateFormat] = usePreference(DATE_FORMAT_PREFERENCE, parseDateFormat);
  const [numberFormat] = usePreference(NUMBER_FORMAT_PREFERENCE, parseNumberFormat);

  const value = useMemo<Formatters>(() => {
    const parse = (iso: string | null | undefined): Date | null => {
      if (!iso) return null;
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? null : date;
    };

    return {
      // An unparseable timestamp comes back as itself rather than as "—": if the
      // server is sending something this cannot read, hiding it makes the bug
      // invisible. `format.ts` has always behaved this way.
      stamp: (iso) => {
        const date = parse(iso);
        return date ? formatDateTime(date, { timeZone, format: dateFormat }) : (iso ?? "—");
      },
      date: (iso) => {
        const date = parse(iso);
        return date ? formatDate(date, { timeZone, format: dateFormat }) : (iso ?? "—");
      },
      time: (iso) => {
        const date = parse(iso);
        return date ? formatTime(date, { timeZone, format: dateFormat }) : (iso ?? "—");
      },
      number: (value, options) =>
        value == null ? "—" : formatNumber(value, numberFormat, options),
      duration: (ms) => duration(ms, numberFormat),
      dateFormat,
      numberFormat,
      timeZone,
    };
  }, [timeZone, dateFormat, numberFormat]);

  return <FormatContext.Provider value={value}>{children}</FormatContext.Provider>;
}

/**
 * Falls back to the system notation outside the provider rather than throwing.
 *
 * The login screen sits above it — nobody is signed in, so there
 * are no preferences to read — and a date on one of them should still render.
 */
export function useFormat(): Formatters {
  const context = useContext(FormatContext);
  const fallbackTimeZone = useTimezone();
  return (
    context ?? {
      stamp: (iso) => (iso ? formatDateTime(new Date(iso)) : "—"),
      date: (iso) => (iso ? formatDate(new Date(iso)) : "—"),
      time: (iso) => (iso ? formatTime(new Date(iso)) : "—"),
      number: (value, options) => (value == null ? "—" : formatNumber(value, "system", options)),
      duration: (ms) => duration(ms),
      dateFormat: "system",
      numberFormat: "system",
      timeZone: fallbackTimeZone,
    }
  );
}
