import { useState } from "react";
import { Field } from "./components/ui/field.tsx";
import { Button } from "./components/ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.tsx";
import { Checkbox } from "./components/ui/checkbox.tsx";
import { CronBuilder } from "./CronBuilder.tsx";
import { TimezoneSelect } from "./TimezoneSelect.tsx";
import { api, type TaskDetail, type Trigger } from "./api.ts";
import { Input } from "./components/ui/input.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { ErrorBox } from "./components/ui/query-state.tsx";
import { useAction } from "./useAction.ts";

/**
 * CRUD form for one task's stored schedule config (`scheduled_task_config`
 * table) — the same fields `task schedule set` writes from the CLI. Scope is
 * deliberate: structured inputs for enabled/trigger/maxItemsPerRun, plus a raw
 * JSON textarea for the task's own params block, since each task's shape is
 * arbitrary and there's no dynamic-schema-form generator in this codebase. The
 * server's paramsSchema validation is authoritative — this form just surfaces
 * whatever it rejects.
 */
export function ScheduleForm({
  task,
  onSaved,
}: {
  task: TaskDetail;
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = useState(task.enabled);
  const [triggerType, setTriggerType] = useState<Trigger["type"]>(
    task.schedule ? "cron" : "manual",
  );
  const [cron, setCron] = useState(task.schedule ?? "");
  const [timezone, setTimezone] = useState(task.timezone ?? "");
  const [maxItemsPerRun, setMaxItemsPerRun] = useState(String(task.maxItemsPerRun));
  const [paramsJson, setParamsJson] = useState(JSON.stringify(task.params, null, 2));
  // One action for both buttons: they write the same record, so they share
  // "busy", share the error line, and either one succeeding is a save.
  const save = useAction();

  const handleSave = () =>
    save.run(async () => {
      // Thrown rather than returned early: a malformed params block and a
      // rejected request are the same thing to whoever is reading this form.
      let params: unknown;
      try {
        params = JSON.parse(paramsJson);
      } catch {
        throw new Error("Params is not valid JSON.");
      }

      const maxItems = Number(maxItemsPerRun);
      if (!Number.isInteger(maxItems) || maxItems < 1) {
        throw new Error("Max items per run must be a positive integer.");
      }

      const trigger: Trigger =
        triggerType === "cron"
          ? { type: "cron", expression: cron, timezone: timezone || undefined }
          : { type: "manual" };

      await api.updateSchedule(task.id, {
        enabled,
        trigger,
        maxItemsPerRun: maxItems,
        params,
      });
      onSaved();
    });

  const handleClear = () =>
    save.run(async () => {
      await api.clearSchedule(task.id);
      onSaved();
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onCheckedChange={(checked) => setEnabled(checked === true)} />
          Enabled
        </label>

        <Field label="Trigger">
          <Select
            value={triggerType}
            onValueChange={(value) => setTriggerType(value as Trigger["type"])}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">Manual only</SelectItem>
              <SelectItem value="cron">On a schedule</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {triggerType === "cron" ? (
          <Field label="Timezone">
            <TimezoneSelect className="w-48" value={timezone} onChange={setTimezone} />
          </Field>
        ) : null}

        <Field label="Max items / run">
          <Input
            className="w-24"
            type="number"
            min={1}
            value={maxItemsPerRun}
            onChange={(e) => setMaxItemsPerRun(e.target.value)}
          />
        </Field>
      </div>

      {triggerType === "cron" ? <CronBuilder expression={cron} onChange={setCron} /> : null}

      <Field label="Task-specific params (JSON)">
        <Textarea
          className="min-h-32 font-mono"
          value={paramsJson}
          onChange={(e) => setParamsJson(e.target.value)}
          spellCheck={false}
        />
      </Field>

      {save.error ? <ErrorBox>{save.error}</ErrorBox> : null}
      {save.done ? <div className="mt-1.5 text-sm text-[var(--text-faint)]">Saved.</div> : null}

      <div className="flex gap-2">
        <Button type="button" disabled={save.busy} onClick={handleSave}>
          {save.busy ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="outline" disabled={save.busy} onClick={handleClear}>
          Revert to defaults
        </Button>
      </div>
    </div>
  );
}
