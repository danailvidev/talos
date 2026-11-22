import { useEffect, useState, type MouseEvent } from "react";

import { api, type TaskSummary } from "./api.ts";
import { scheduleBadge } from "./format.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { TimezoneSelect } from "./TimezoneSelect.tsx";
import {
  hourMinuteOfWallClock,
  utcToWallClock,
  weekdayOfWallClock,
} from "./zoned-time.ts";
import {
  buildTrigger,
  type LoopFrequency,
} from "./schedule-trigger.ts";
import { Button } from "./components/ui/button.tsx";
import { ErrorBox } from "./components/ui/query-state.tsx";
import { useAction } from "./useAction.ts";
import { Input } from "./components/ui/input.tsx";
import { cn } from "./lib/utils.ts";

export { buildTrigger, type LoopFrequency } from "./schedule-trigger.ts";

const SCHEDULE_FIELD_CLASS =
  "flex flex-col gap-1 text-[0.7812rem] font-medium tracking-[0.04em] text-[var(--text-faint)] uppercase";

const BADGE_TONE = {
  warning:
    "bg-[color-mix(in_srgb,var(--status-warning)_18%,var(--bg-deep))] text-[var(--status-warning)]",
  danger:
    "bg-[color-mix(in_srgb,var(--status-danger)_18%,var(--bg-deep))] text-[var(--status-danger)]",
  muted: "bg-[var(--bg-muted)] text-[var(--text-dim)]",
} as const;

function defaultWallClock(timeZone: string | undefined): string {
  return utcToWallClock(new Date().toISOString(), timeZone);
}

export function frequencyOf(task: TaskSummary): LoopFrequency {
  if (task.onceAt) return "once";
  if (!task.schedule) return "daily";
  if (/^\d{1,2} \d{1,2} \* \* \*$/.test(task.schedule)) return "daily";
  if (/^\d{1,2} \d{1,2} \* \* [\d,]+$/.test(task.schedule)) return "weekly";
  return "custom";
}

export function firstRunOf(task: TaskSummary, timeZone: string | undefined): string {
  const iso = task.onceAt ?? task.startAt ?? task.nextRun;
  return iso ? utcToWallClock(iso, timeZone) : defaultWallClock(timeZone);
}

export function liveBadge(frequency: LoopFrequency, firstRun: string, customCron: string) {
  if (frequency === "once") return { tone: "warning" as const, label: "Once" };
  if (frequency === "daily") return scheduleBadge(`${hourMinuteOfWallClock(firstRun).minute} ${hourMinuteOfWallClock(firstRun).hour} * * *`);
  if (frequency === "weekly") {
    const { minute, hour } = hourMinuteOfWallClock(firstRun);
    return scheduleBadge(`${minute} ${hour} * * ${weekdayOfWallClock(firstRun)}`);
  }
  return scheduleBadge(customCron || null);
}

/**
 * First run + frequency + timezone. Lives on the loop detail page — the
 * dashboard only shows last-run, not these controls.
 */
export function LoopScheduleControls({
  task,
  onChanged,
  onToast,
}: {
  task: TaskSummary;
  onChanged: () => void;
  onToast?: (text: string) => void;
}) {
  const [frequency, setFrequency] = useState<LoopFrequency>(() => frequencyOf(task));
  const [timeZone, setTimeZone] = useState(task.timezone ?? "");
  const [firstRun, setFirstRun] = useState(() => firstRunOf(task, task.timezone));
  const [customCron, setCustomCron] = useState(task.schedule && frequencyOf(task) === "custom" ? task.schedule : "0 9 * * *");
  const [cronDirty, setCronDirty] = useState(false);
  const [cronSaved, setCronSaved] = useState(false);
  // A row control, not a form: a failure has to reach the user as a toast, since
  // the only thing on screen is the picker they just used.
  const save = useAction({ onError: (message) => onToast?.(message) });

  useEffect(() => {
    setFrequency(frequencyOf(task));
    setTimeZone(task.timezone ?? "");
    setFirstRun(firstRunOf(task, task.timezone));
  }, [task.id, task.schedule, task.onceAt, task.startAt, task.timezone, task.nextRun]);

  // Polling updates nextRun frequently. Only a changed server schedule (or a
  // different task) may replace the custom-cron draft.
  useEffect(() => {
    setCustomCron(
      task.schedule && frequencyOf(task) === "custom"
        ? task.schedule
        : "0 9 * * *",
    );
    setCronDirty(false);
    setCronSaved(false);
  }, [task.id, task.schedule]);

  async function commit(next: {
    frequency?: LoopFrequency;
    firstRun?: string;
    timeZone?: string;
    customCron?: string;
  }): Promise<boolean> {
    const freq = next.frequency ?? frequency;
    const run = next.firstRun ?? firstRun;
    const zone = next.timeZone ?? timeZone;
    const cron = next.customCron ?? customCron;
    return save.run(async () => {
      const trigger = buildTrigger(freq, run, zone, cron);
      await api.updateSchedule(task.id, { trigger });
      onChanged();
    });
  }

  async function saveCustomCron() {
    const value = customCron;
    if (!(await commit({ customCron: value }))) return;
    setCronDirty(false);
    setCronSaved(true);
    onToast?.("Schedule saved");
  }

  function stop(event: MouseEvent) {
    event.stopPropagation();
  }

  const badge = liveBadge(frequency, firstRun, customCron);

  return (
    <div
      className="my-1 grid max-w-180 grid-cols-3 gap-x-2.5 gap-y-2"
      onClick={stop}
      onMouseDown={stop}
    >
      <label className={SCHEDULE_FIELD_CLASS}>
        First run
        <Input
          className="h-8 w-full text-[0.9375rem] font-normal tracking-normal normal-case"
          type="datetime-local"
          value={firstRun}
          disabled={save.busy}
          onChange={(event) => {
            const value = event.target.value;
            setFirstRun(value);
            if (value) void commit({ firstRun: value });
          }}
        />
      </label>

      <label className={SCHEDULE_FIELD_CLASS}>
        Frequency
        <Select
          value={frequency}
          onValueChange={(value) => {
            const next = value as LoopFrequency;
            setFrequency(next);
            void commit({ frequency: next });
          }}
        >
          <SelectTrigger className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="once">Once</SelectItem>
            <SelectItem value="daily">Daily</SelectItem>
            <SelectItem value="weekly">Weekly</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
          </SelectContent>
        </Select>
      </label>

      <label className={SCHEDULE_FIELD_CLASS}>
        Timezone
        <TimezoneSelect
          value={timeZone}
          disabled={save.busy}
          onChange={(next) => {
            setTimeZone(next);
            void commit({ timeZone: next });
          }}
        />
      </label>

      {frequency === "custom" ? (
        <label className={cn(SCHEDULE_FIELD_CLASS, "col-span-full")}>
          Cron
          <span className="flex items-center gap-2">
            <Input
              className="mono h-8 min-w-0 flex-1 text-sm font-normal tracking-normal normal-case"
              value={customCron}
              disabled={save.busy}
              placeholder="0 9 * * 1-5"
              onChange={(event) => {
                setCustomCron(event.target.value);
                setCronDirty(true);
                setCronSaved(false);
                save.clear();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && cronDirty) void saveCustomCron();
              }}
            />
            <Button
              type="button"
              size="sm"
              disabled={save.busy || !cronDirty}
              onClick={() => void saveCustomCron()}
            >
              {save.busy ? "Saving…" : "Save"}
            </Button>
          </span>
        </label>
      ) : null}

      <span
        className={cn(
          "col-span-full mt-0.5 inline-flex justify-self-start rounded-lg px-2.5 py-1 text-sm leading-[1.4] font-semibold",
          BADGE_TONE[badge.tone],
        )}
      >
        {badge.label}
      </span>
      {cronSaved ? (
        <span className="self-center text-sm text-[var(--success)]">Saved</span>
      ) : null}
      {save.error ? (
        <div className="col-span-full">
          <ErrorBox>{save.error}</ErrorBox>
        </div>
      ) : null}
    </div>
  );
}
