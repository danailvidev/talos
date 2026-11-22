/**
 * How dates and numbers are written, as a choice rather than an assumption.
 *
 * The console used to hand every timestamp to `toLocaleString(undefined)` and every
 * count to a bare template string, which means the browser's locale decided whether
 * `08/09` is September or August and nothing decided the thousands separator at all.
 * For a European reading a US-locale machine — or the other way round — that is not
 * a cosmetic problem: `09/08/2026` is a different day depending on where you learned
 * to read it, and a deploy watch is exactly the sort of thing you read a date on to
 * decide something.
 *
 * So both are preferences, and both default to `"system"` — the browser's own
 * locale, which is what the console did before and is right often enough to be the
 * default. Choosing anything else pins the format explicitly, and a pinned format
 * follows you to your other machines because it is stored with the rest of your
 * preferences.
 *
 * Two independent settings, because they are two independent mistakes. Somebody on
 * a US laptop working with a German team may want ISO dates and dot decimals, and a
 * single "region" dropdown could not express that.
 *
 * Deliberately React-free: `format.ts` and the `FormatContext` provider both build
 * on it, and the choices need to be describable (labels, examples) by the dialog
 * that offers them without mounting anything.
 */

/* ------------------------------------------------------------------- dates */

export const DATE_FORMATS = ["system", "iso", "dmy", "mdy"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export interface DateFormatOption {
  id: DateFormat;
  label: string;
  /** What it reads as, said in one clause. */
  description: string;
}

export const DATE_FORMAT_OPTIONS: readonly DateFormatOption[] = [
  {
    id: "system",
    label: "System",
    description: "Whatever this browser's locale asks for.",
  },
  {
    id: "iso",
    label: "ISO 8601",
    description: "Year first, 24-hour. Sorts correctly and cannot be misread.",
  },
  {
    id: "dmy",
    label: "Day first",
    description: "European: day/month/year, 24-hour.",
  },
  {
    id: "mdy",
    label: "Month first",
    description: "US: month/day/year, 12-hour.",
  },
];

/**
 * The locale each format is spelled in.
 *
 * A locale rather than a hand-rolled pattern, so month names, weekday names and the
 * AM/PM marker come from the platform's own data instead of a table in this file
 * that would only ever be right for English. ISO is the exception and is assembled
 * from parts below: no locale is guaranteed to produce it, and the ones that
 * happen to (`sv-SE`, `en-CA`) do so as a CLDR accident that could change.
 */
const DATE_LOCALES: Record<Exclude<DateFormat, "system" | "iso">, string> = {
  dmy: "en-GB",
  mdy: "en-US",
};

/** `undefined` means "the browser's own", which is what `Intl` does with it. */
function dateLocale(format: DateFormat): string | undefined {
  return format === "system" || format === "iso" ? undefined : DATE_LOCALES[format];
}

interface DateOptions {
  timeZone?: string;
  format?: DateFormat;
}

/**
 * A date and a time together — the workhorse, behind `stamp`.
 *
 * `2-digit` day and month rather than `numeric` for the pinned formats: a column of
 * timestamps that shifts left on the 9th of the month is harder to scan than one
 * that does not, and `08/09` is the form people who chose "day first" recognise.
 * `"system"` keeps `numeric`, since that is what the browser would have done.
 */
export function formatDateTime(date: Date, options: DateOptions = {}): string {
  const format = options.format ?? "system";
  if (format === "iso") return isoStamp(date, options.timeZone);

  return date.toLocaleString(dateLocale(format), {
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    ...(format === "system"
      ? {}
      : {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
  });
}

/** The date alone, for a column that has no room for a clock. */
export function formatDate(date: Date, options: DateOptions = {}): string {
  const format = options.format ?? "system";
  if (format === "iso") return isoStamp(date, options.timeZone).slice(0, 10);

  return date.toLocaleDateString(dateLocale(format), {
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    ...(format === "system" ? {} : { year: "numeric", month: "2-digit", day: "2-digit" }),
  });
}

/** The time alone. 24-hour under every pinned format except month-first. */
export function formatTime(date: Date, options: DateOptions = {}): string {
  const format = options.format ?? "system";
  return date.toLocaleTimeString(format === "iso" ? "en-GB" : dateLocale(format), {
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    hour: "2-digit",
    minute: "2-digit",
    ...(format === "iso" ? { hourCycle: "h23" as const } : {}),
  });
}

/**
 * `YYYY-MM-DD HH:mm`, in the given zone.
 *
 * Assembled from `formatToParts` rather than from `toISOString`, because that method
 * is always UTC and this has to honour the instance's configured timezone like every
 * other timestamp on the page. A space rather than the `T`: this is for reading, and
 * ISO 8601 permits it.
 */
function isoStamp(date: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const at = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${at("year")}-${at("month")}-${at("day")} ${at("hour")}:${at("minute")}`;
}

/* ------------------------------------------------------------------ numbers */

export const NUMBER_FORMATS = ["system", "point", "comma", "space"] as const;
export type NumberFormat = (typeof NUMBER_FORMATS)[number];

export interface NumberFormatOption {
  id: NumberFormat;
  label: string;
  description: string;
}

export const NUMBER_FORMAT_OPTIONS: readonly NumberFormatOption[] = [
  {
    id: "system",
    label: "System",
    description: "Whatever this browser's locale asks for.",
  },
  { id: "point", label: "Decimal point", description: "Comma groups: US, UK, most of Asia." },
  { id: "comma", label: "Decimal comma", description: "Point groups: most of Europe." },
  { id: "space", label: "Space groups", description: "Decimal comma, no-break space groups." },
];

/**
 * Locales chosen for their separators alone.
 *
 * `fr-FR` groups with a narrow no-break space, which is the point of that option;
 * it is a space that will not let a number wrap in half.
 */
const NUMBER_LOCALES: Record<Exclude<NumberFormat, "system">, string> = {
  point: "en-US",
  comma: "de-DE",
  space: "fr-FR",
};

function numberLocale(format: NumberFormat): string | undefined {
  return format === "system" ? undefined : NUMBER_LOCALES[format];
}

export function formatNumber(
  value: number,
  format: NumberFormat = "system",
  options: Intl.NumberFormatOptions = {},
): string {
  if (!Number.isFinite(value)) return String(value);
  return value.toLocaleString(numberLocale(format), options);
}

/** The decimal separator this format uses, for the few places that build a number by hand. */
export function decimalSeparator(format: NumberFormat = "system"): string {
  return (1.1).toLocaleString(numberLocale(format)).replace(/\d/g, "");
}

/* ---------------------------------------------------------------- storage */

/** The preference keys. Read by `FormatContext`, written by the profile dialog. */
export const DATE_FORMAT_PREFERENCE = "format.date";
export const NUMBER_FORMAT_PREFERENCE = "format.number";

export const DEFAULT_DATE_FORMAT: DateFormat = "system";
export const DEFAULT_NUMBER_FORMAT: NumberFormat = "system";

export function parseDateFormat(raw: unknown): DateFormat {
  return DATE_FORMATS.find((value) => value === raw) ?? DEFAULT_DATE_FORMAT;
}

export function parseNumberFormat(raw: unknown): NumberFormat {
  return NUMBER_FORMATS.find((value) => value === raw) ?? DEFAULT_NUMBER_FORMAT;
}

/**
 * The sample every option is previewed with: a day and month that cannot be
 * confused for each other, and a number with both a group and a decimal.
 *
 * A fixed instant rather than `new Date()`, so the four captions differ only in the
 * thing being chosen — and so the 8th never falls on a month where `08/09` reads the
 * same either way.
 */
export const FORMAT_SAMPLE_DATE = new Date("2026-09-08T14:30:00Z");
export const FORMAT_SAMPLE_NUMBER = 1234.56;
