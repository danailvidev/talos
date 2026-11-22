import { useEffect, useMemo, useState } from "react";
import { FIELD_CLASS, Field } from "./components/ui/field.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";
import { Input } from "./components/ui/input.tsx";
import { Button } from "./components/ui/button.tsx";

/**
 * A plain-language schedule picker over the cron expression the backend
 * actually stores (`ScheduledTaskRow.trigger`, a `cron` string — see
 * `config/schema.ts`). Nobody outside this file needs to know cron syntax
 * exists: pick a frequency, pick a time/day, done. The one exception is
 * "Custom", which exposes the raw expression for whoever already thinks in
 * cron and has something this picker can't build (e.g. a step function like
 * `0 9-17 * * 1-5`).
 *
 * Parsing is best-effort and one-directional in intent: an expression this
 * picker itself wrote always round-trips, but a hand-written one that
 * doesn't match a recognized shape just falls back to Custom rather than
 * guessing — silently misreading someone's cron would be worse than asking
 * them to keep editing it as text.
 */

const WEEKDAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

type Frequency = "minutes" | "hourly" | "daily" | "weekly" | "monthly" | "custom";

interface Parsed {
  frequency: Frequency;
  everyMinutes: number;
  minute: number;
  hour: number;
  weekdays: number[];
  dayOfMonth: number;
}

const DEFAULTS: Parsed = {
  frequency: "daily",
  everyMinutes: 5,
  minute: 0,
  hour: 9,
  weekdays: [1, 2, 3, 4, 5],
  dayOfMonth: 1,
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Reads a cron expression this picker could have written; anything else is Custom. */
function parseCron(expression: string): Parsed {
  // No schedule configured yet: start from a sensible default (daily) rather
  // than dropping a first-time user straight into the raw cron field.
  if (expression.trim() === "") return { ...DEFAULTS };

  const everyN = expression.match(/^\*\/(\d{1,2}) \* \* \* \*$/);
  if (everyN) {
    const n = Number(everyN[1]);
    if (n >= 1 && n <= 59) return { ...DEFAULTS, frequency: "minutes", everyMinutes: n };
  }

  const hourly = expression.match(/^(\d{1,2}) \* \* \* \*$/);
  if (hourly) {
    const minute = Number(hourly[1]);
    if (minute <= 59) return { ...DEFAULTS, frequency: "hourly", minute };
  }

  const daily = expression.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (daily) {
    const [minute, hour] = [Number(daily[1]), Number(daily[2])];
    if (minute <= 59 && hour <= 23) return { ...DEFAULTS, frequency: "daily", minute, hour };
  }

  const weekly = expression.match(/^(\d{1,2}) (\d{1,2}) \* \* ([\d,]+)$/);
  if (weekly) {
    const [minute, hour] = [Number(weekly[1]), Number(weekly[2])];
    const weekdays = weekly[3]!.split(",").map(Number).filter((d) => d >= 0 && d <= 6);
    if (minute <= 59 && hour <= 23 && weekdays.length > 0) {
      return { ...DEFAULTS, frequency: "weekly", minute, hour, weekdays };
    }
  }

  const monthly = expression.match(/^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/);
  if (monthly) {
    const [minute, hour, dayOfMonth] = [Number(monthly[1]), Number(monthly[2]), Number(monthly[3])];
    if (minute <= 59 && hour <= 23 && dayOfMonth >= 1 && dayOfMonth <= 31) {
      return { ...DEFAULTS, frequency: "monthly", minute, hour, dayOfMonth };
    }
  }

  return { ...DEFAULTS, frequency: "custom" };
}

function buildCron(state: Parsed): string {
  switch (state.frequency) {
    case "minutes":
      return `*/${state.everyMinutes} * * * *`;
    case "hourly":
      return `${state.minute} * * * *`;
    case "daily":
      return `${state.minute} ${state.hour} * * *`;
    case "weekly":
      return `${state.minute} ${state.hour} * * ${[...state.weekdays].sort().join(",")}`;
    case "monthly":
      return `${state.minute} ${state.hour} ${state.dayOfMonth} * *`;
    case "custom":
      return "";
  }
}

function summarize(state: Parsed): string {
  const at = `${pad(state.hour)}:${pad(state.minute)}`;
  switch (state.frequency) {
    case "minutes":
      return `Runs every ${state.everyMinutes} minute${state.everyMinutes === 1 ? "" : "s"}.`;
    case "hourly":
      return `Runs every hour, at ${pad(state.minute)} minutes past.`;
    case "daily":
      return `Runs every day at ${at}.`;
    case "weekly": {
      if (state.weekdays.length === 0) return "Pick at least one day.";
      const names = WEEKDAYS.filter((d) => state.weekdays.includes(d.value)).map((d) => d.label);
      return `Runs at ${at} on ${names.join(", ")}.`;
    }
    case "monthly":
      return `Runs on day ${state.dayOfMonth} of every month at ${at}. Skips shorter months.`;
    case "custom":
      return "";
  }
}

export function CronBuilder({
  expression,
  onChange,
}: {
  expression: string;
  onChange: (expression: string) => void;
}) {
  // Re-parsed only when the *incoming* expression changes (e.g. loading a
  // different task, or "Revert to defaults"), not on every keystroke this
  // component itself produces — otherwise typing in the day-of-month field
  // would fight with the parser reinterpreting its own half-typed output.
  const [state, setState] = useState<Parsed>(() => parseCron(expression));
  const [customText, setCustomText] = useState(expression);

  useEffect(() => {
    const parsed = parseCron(expression);
    setState(parsed);
    setCustomText(expression);
    // An empty incoming expression parses to a concrete default (daily at
    // 09:00) for display; the parent's stored value must match what's on
    // screen, or "Save" would silently write "" instead of that default.
    if (expression.trim() === "") onChange(buildCron(parsed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expression]);

  const update = (patch: Partial<Parsed>) => {
    const next = { ...state, ...patch };
    setState(next);
    if (next.frequency !== "custom") onChange(buildCron(next));
  };

  const summary = useMemo(() => summarize(state), [state]);

  return (
    <div className="flex flex-wrap items-end gap-4 rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] p-3">
      <Field label="Frequency">
        <Select
          value={state.frequency}
          onValueChange={(value) => {
            const frequency = value as Frequency;
            if (frequency === "custom") {
              setState({ ...state, frequency });
              onChange(customText);
            } else {
              update({ frequency });
            }
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="minutes">Every few minutes</SelectItem>
            <SelectItem value="hourly">Hourly</SelectItem>
            <SelectItem value="daily">Daily</SelectItem>
            <SelectItem value="weekly">Weekly</SelectItem>
            <SelectItem value="monthly">Monthly</SelectItem>
            <SelectItem value="custom">Custom (cron)</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      {state.frequency === "minutes" ? (
        <Field label="Every">
          <div className="flex items-center gap-1">
            <Input
              className="w-16"
              type="number"
              min={1}
              max={59}
              value={state.everyMinutes}
              onChange={(e) => update({ everyMinutes: clamp(Number(e.target.value), 1, 59) })}
            />
            <span className="text-sm text-muted-foreground">minutes</span>
          </div>
        </Field>
      ) : null}

      {state.frequency === "hourly" ? (
        <Field label="At minute">
          <Input
            className="w-16"
            type="number"
            min={0}
            max={59}
            value={state.minute}
            onChange={(e) => update({ minute: clamp(Number(e.target.value), 0, 59) })}
          />
        </Field>
      ) : null}

      {state.frequency === "daily" || state.frequency === "weekly" || state.frequency === "monthly" ? (
        <Field label="At">
          <Input
            className=""
            type="time"
            value={`${pad(state.hour)}:${pad(state.minute)}`}
            onChange={(e) => {
              const [hour, minute] = e.target.value.split(":").map(Number);
              update({ hour: hour ?? state.hour, minute: minute ?? state.minute });
            }}
          />
        </Field>
      ) : null}

      {state.frequency === "weekly" ? (
        <div className={FIELD_CLASS}>
          On
          <div className="flex gap-1">
            {WEEKDAYS.map((day) => {
              const active = state.weekdays.includes(day.value);
              return (
                <Button
                  key={day.value}
                  type="button"
                  variant={active ? "default" : "outline"}
                  size="sm"
                  className="min-w-8.5 px-2"
                  onClick={() =>
                    update({
                      weekdays: active
                        ? state.weekdays.filter((d) => d !== day.value)
                        : [...state.weekdays, day.value],
                    })
                  }
                  aria-pressed={active}
                >
                  {day.label}
                </Button>
              );
            })}
          </div>
        </div>
      ) : null}

      {state.frequency === "monthly" ? (
        <Field label="On day">
          <Input
            className="w-16"
            type="number"
            min={1}
            max={31}
            value={state.dayOfMonth}
            onChange={(e) => update({ dayOfMonth: clamp(Number(e.target.value), 1, 31) })}
          />
        </Field>
      ) : null}

      {state.frequency === "custom" ? (
        <Field label="Cron expression">
          <Input
            className="font-mono"
            value={customText}
            onChange={(e) => {
              setCustomText(e.target.value);
              onChange(e.target.value);
            }}
            placeholder="*/10 * * * *"
          />
        </Field>
      ) : null}

      {summary ? (
        <div className="basis-full text-sm text-[var(--text-faint)]">{summary}</div>
      ) : null}
    </div>
  );
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}
