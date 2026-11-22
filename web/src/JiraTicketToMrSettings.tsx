import { useEffect, useState } from "react";

import { api, type TaskDetail } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Field } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import { ErrorBox } from "./components/ui/query-state.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { SECTION_TITLE_CLASS } from "./typography-styles.ts";
import { useAction } from "./useAction.ts";

const DEFAULT_OPT_IN_LABEL = "talos";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jiraSelector(params: unknown): Record<string, unknown> {
  return record(record(params).jira);
}

export function JiraTicketToMrSettings({
  task,
  onChanged,
  onToast,
}: {
  task: TaskDetail;
  onChanged: () => void;
  onToast?: (text: string) => void;
}) {
  const selector = jiraSelector(task.params);
  const savedLabel =
    typeof selector.label === "string" ? selector.label : DEFAULT_OPT_IN_LABEL;
  const project = typeof selector.project === "string" ? selector.project : undefined;
  const customJql = typeof selector.jql === "string" ? selector.jql : undefined;
  const savedGate = record(record(task.params).plan).required === true;
  const [label, setLabel] = useState(savedLabel);
  // Optimistic, and it has to be: `onChanged` refetches the task, so the switch would
  // otherwise sit in its old position for the length of the round trip — the one
  // control where that reads as "the click did not register".
  const [gate, setGate] = useState(savedGate);
  const save = useAction();
  const gateSave = useAction();

  useEffect(() => {
    setLabel(savedLabel);
    save.clear();
  }, [task.id, savedLabel]);

  useEffect(() => {
    setGate(savedGate);
    gateSave.clear();
  }, [task.id, savedGate]);

  const handleSave = () =>
    save.run(async () => {
      const nextLabel = label.trim();
      if (!nextLabel) throw new Error("Opt-in label cannot be empty.");

      // Read immediately before writing so a schedule edit from another tab or
      // browser is not replaced by the params snapshot this component mounted with.
      const fresh = await api.task(task.id);
      const params = record(fresh.params);
      await api.updateSchedule(task.id, {
        params: {
          ...params,
          jira: {
            ...jiraSelector(params),
            label: nextLabel,
          },
        },
      });
      onChanged();
      onToast?.("Opt-in label saved");
    });

  const handleGate = async (next: boolean) => {
    setGate(next);
    const ok = await gateSave.run(async () => {
      // Same read-then-write as the label above, and for the same reason: this writes
      // the whole params object, so a snapshot from mount would undo a JQL or label
      // edit made in another tab.
      const fresh = await api.task(task.id);
      const params = record(fresh.params);
      await api.updateSchedule(task.id, {
        params: { ...params, plan: { ...record(params.plan), required: next } },
      });
      onChanged();
      onToast?.(next ? "Plans now need approval" : "Plan approval turned off");
    });
    // A gate that looks on but is off is the worst state this switch can be in, so a
    // failed write puts it back rather than leaving the optimistic position standing.
    if (!ok) setGate(!next);
  };

  return (
    <>
      <section className="mb-5.5">
        <h2 className={SECTION_TITLE_CLASS}>Ticket selection</h2>
        <Field
          className="max-w-90"
          label="Opt-in Jira label"
          hint={
            customJql
              ? "This loop currently uses custom JQL, so the label is saved but does not select tickets."
              : `Selects tickets${project ? ` in ${project}` : ""} with this label whose status category is not Done.`
          }
        >
          <Input
            value={label}
            disabled={save.busy}
            placeholder={DEFAULT_OPT_IN_LABEL}
            onChange={(event) => {
              setLabel(event.target.value);
              save.clear();
            }}
          />
        </Field>
        {save.error ? <ErrorBox>{save.error}</ErrorBox> : null}
        <Button
          type="button"
          size="sm"
          className="mt-2"
          disabled={save.busy || label.trim() === savedLabel}
          onClick={handleSave}
        >
          {save.busy ? "Saving…" : "Save label"}
        </Button>
      </section>

      <section className="mb-5.5">
        <h2 className={SECTION_TITLE_CLASS}>Approval</h2>
        <div className="flex max-w-140 items-start justify-between gap-4">
          <label className="flex cursor-pointer flex-col gap-0.5" htmlFor={`plan-gate-${task.id}`}>
            <strong className="text-[0.9375rem] font-medium text-foreground">
              Require an approved plan
            </strong>
            <small className="text-sm text-[var(--text-faint)]">
              Each ticket gets an implementation plan first, and nothing is written until somebody
              approves it in the ticket's Plan tab. Off, the loop opens draft merge requests on its
              own, as it does today.
            </small>
          </label>
          <Switch
            id={`plan-gate-${task.id}`}
            className="mt-1 shrink-0"
            checked={gate}
            disabled={gateSave.busy}
            onCheckedChange={(checked) => void handleGate(checked)}
          />
        </div>
        {gateSave.error ? <ErrorBox>{gateSave.error}</ErrorBox> : null}
      </section>
    </>
  );
}
