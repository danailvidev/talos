import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  api,
  type AutomationConfigView,
  type AutomationScheduleDiscoveryView,
  type TaskDetail,
} from "./api.ts";
import {
  automationJiraDraft,
  automationJiraPatch,
  automationJiraValidationError,
} from "./automation-jira-config.ts";
import { Button } from "./components/ui/button.tsx";
import { Checkbox } from "./components/ui/checkbox.tsx";
import { ErrorBox, QueryState } from "./components/ui/query-state.tsx";
import { Field } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { AutomationSyncControl } from "./AutomationSyncControl.tsx";
import { JiraAssigneeSelect } from "./JiraAssigneeSelect.tsx";
import { LabelCombobox } from "./LabelCombobox.tsx";
import { keys } from "./query-keys.ts";
import { invalidate, queries } from "./queries.ts";
import { SETTINGS_SECTION_CLASS } from "./settings-layout.ts";
import { TitleInfo } from "./TitleInfo.tsx";
import { PAGE_TITLE_CLASS, SECTION_TITLE_CLASS } from "./typography-styles.ts";
import { useAction } from "./useAction.ts";
import { useApi } from "./useApi.ts";

const AUTOMATION_SYNC_TASK_ID = "automation-report-sync";
const AUTOMATION_SYNC_MAX_ITEMS = 100;
const POLL_INTERVALS = ["5", "10", "15", "30"] as const;

export function AutomationSettings() {
  const queryClient = useQueryClient();
  const config = useApi(queries.automationConfig());
  const polling = useApi(queries.task(AUTOMATION_SYNC_TASK_ID));

  return (
    <QueryState query={config} loading="Loading Automation settings…">
      {(configuration) => (
        <QueryState query={polling} loading="Loading Automation polling…">
          {(pollingTask) => (
            <AutomationSettingsForm
              initial={configuration}
              pollingTask={pollingTask}
              onSaved={(saved) => {
                queryClient.setQueryData(keys.automationConfig(), saved);
                invalidate.automation(queryClient);
              }}
              onPollingChanged={() => {
                void queryClient.invalidateQueries({ queryKey: keys.allTasks() });
              }}
            />
          )}
        </QueryState>
      )}
    </QueryState>
  );
}

function AutomationSettingsForm({
  initial,
  pollingTask,
  onSaved,
  onPollingChanged,
}: {
  initial: AutomationConfigView;
  pollingTask: TaskDetail;
  onSaved: (saved: AutomationConfigView) => void;
  onPollingChanged: () => void;
}) {
  const [projectId, setProjectId] = useState(initial.projectId ?? "");
  const [selected, setSelected] = useState(
    () => new Map(initial.schedules.map((item) => [item.scheduleId, item.displayName ?? ""])),
  );
  const [autoRetry, setAutoRetry] = useState(
    () =>
      new Map(
        initial.schedules.map((item) => [
          item.scheduleId,
          item.autoRetry ?? { enabled: false, maxJobsPerPipeline: 3 },
        ]),
      ),
  );
  const [jira, setJira] = useState(() => automationJiraDraft(initial));
  const [loadedProject, setLoadedProject] = useState("");
  const discovery = useApi(
    queries.automationSchedules(loadedProject, loadedProject.length > 0),
  );
  const save = useAction();

  useEffect(() => {
    setProjectId(initial.projectId ?? "");
    setSelected(
      new Map(initial.schedules.map((item) => [item.scheduleId, item.displayName ?? ""])),
    );
    setAutoRetry(
      new Map(
        initial.schedules.map((item) => [
          item.scheduleId,
          item.autoRetry ?? { enabled: false, maxJobsPerPipeline: 3 },
        ]),
      ),
    );
    setJira(automationJiraDraft(initial));
  }, [initial]);

  const schedules = discovery.data?.schedules ?? [];
  const knownSchedules = useMemo(() => {
    const byId = new Map(schedules.map((schedule) => [schedule.id, schedule]));
    for (const schedule of initial.schedules) {
      if (!byId.has(schedule.scheduleId)) {
        byId.set(schedule.scheduleId, {
          id: schedule.scheduleId,
          description: schedule.displayName || `Schedule ${schedule.scheduleId}`,
          ref: "Not returned by GitLab",
          cron: null,
          active: false,
        });
      }
    }
    return [...byId.values()];
  }, [schedules, initial.schedules]);

  const loadSchedules = () => {
    const next = projectId.trim();
    if (!next) return;
    if (next !== (initial.projectId ?? "") && next !== loadedProject) {
      setSelected(new Map());
      setAutoRetry(new Map());
    }
    if (loadedProject === next) discovery.refetch();
    else setLoadedProject(next);
  };

  const toggle = (schedule: AutomationScheduleDiscoveryView, checked: boolean) => {
    setSelected((current) => {
      const next = new Map(current);
      if (checked) next.set(schedule.id, next.get(schedule.id) ?? "");
      else next.delete(schedule.id);
      return next;
    });
    setAutoRetry((policies) => {
      const next = new Map(policies);
      if (checked && !next.has(schedule.id)) {
        next.set(schedule.id, {
          enabled: false,
          maxJobsPerPipeline: 3,
        });
      } else if (!checked) {
        next.delete(schedule.id);
      }
      return next;
    });
  };

  const dirty =
    projectId.trim() !== (initial.projectId ?? "") ||
    JSON.stringify([...selected.entries()]) !==
      JSON.stringify(
        initial.schedules.map((item) => [item.scheduleId, item.displayName ?? ""]),
      ) ||
    JSON.stringify([...autoRetry.entries()]) !==
      JSON.stringify(
        initial.schedules.map((item) => [
          item.scheduleId,
          item.autoRetry ?? { enabled: false, maxJobsPerPipeline: 3 },
        ]),
      ) ||
    JSON.stringify(jira) !== JSON.stringify(automationJiraDraft(initial));
  const complete = projectId.trim().length > 0;
  const jiraError = automationJiraValidationError(jira);

  const handleSave = () =>
    save.run(async () => {
      const saved = await api.setAutomationConfig({
        projectId: projectId.trim(),
        schedules: [...selected.entries()].map(([scheduleId, displayName]) => ({
          scheduleId,
          displayName: displayName.trim() || null,
          autoRetry: autoRetry.get(scheduleId) ?? {
            enabled: false,
            maxJobsPerPipeline: 3,
          },
        })),
        jira: automationJiraPatch(jira),
      });
      onSaved(saved);
    });

  return (
    <div className="flex flex-col gap-4">
      <h1 className={PAGE_TITLE_CLASS}>
        Automation
        <TitleInfo>
          Instance-wide test reporting from selected GitLab pipeline schedules. Requires the shared{" "}
          <span className="mono">GITLAB_TOKEN</span> with{" "}
          <span className="mono">read_api</span> for reporting, or{" "}
          <span className="mono">api</span> when automatic job retry is enabled.
        </TitleInfo>
      </h1>

      <section className={SETTINGS_SECTION_CLASS}>
        <h2 className={SECTION_TITLE_CLASS}>GitLab schedules</h2>
        <Field label="Project">
          <div className="flex max-w-2xl flex-col gap-2 sm:flex-row">
            <Input
              className="min-w-0 flex-1 font-mono"
              value={projectId}
              placeholder="group/project"
              onChange={(event) => setProjectId(event.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!projectId.trim() || discovery.fetching}
              onClick={loadSchedules}
            >
              {discovery.fetching ? "Loading…" : "Load schedules"}
            </Button>
          </div>
        </Field>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          Loading is explicit because discovery calls GitLab. Select only schedules whose pipelines
          publish JUnit reports.
        </p>

        {discovery.error ? <ErrorBox>{discovery.error}</ErrorBox> : null}
        {loadedProject && discovery.loading ? (
          <div className="mt-4 text-sm text-muted-foreground" role="status">
            Loading schedules from GitLab…
          </div>
        ) : null}
        {discovery.data && knownSchedules.length === 0 ? (
          <div className="mt-4 rounded-[var(--radius)] border border-dashed border-border p-5 text-sm text-muted-foreground">
            No pipeline schedules were found for this project.
          </div>
        ) : null}
        {!loadedProject && knownSchedules.length === 0 ? (
          <div className="mt-4 rounded-[var(--radius)] border border-dashed border-border p-5 text-sm text-muted-foreground">
            Enter a GitLab project and choose Load schedules to discover its pipeline schedules.
          </div>
        ) : null}
        {knownSchedules.length > 0 ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {knownSchedules.map((schedule) => {
              const checked = selected.has(schedule.id);
              return (
                <div
                  key={schedule.id}
                  className="rounded-[var(--radius)] border border-border bg-card p-2.5"
                >
                  <div className="flex items-start gap-2.5">
                    <Checkbox
                      id={`automation-schedule-${schedule.id}`}
                      className="mt-0.5"
                      checked={checked}
                      onCheckedChange={(value) => toggle(schedule, value === true)}
                    />
                    <div className="min-w-0 flex-1">
                      <label
                        htmlFor={`automation-schedule-${schedule.id}`}
                        className="block truncate text-sm font-medium text-foreground"
                        title={schedule.description || `Schedule ${schedule.id}`}
                      >
                        {schedule.description || `Schedule ${schedule.id}`}
                      </label>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        #{schedule.id} · {schedule.ref} · {schedule.cron ?? "manual"}
                        {!schedule.active ? " · inactive" : ""}
                      </p>
                      {checked ? (
                        <div className="mt-2.5 grid gap-2.5">
                          <Field label="Dashboard label">
                            <Input
                              value={selected.get(schedule.id) ?? ""}
                              placeholder={schedule.description}
                              onChange={(event) =>
                                setSelected((current) => {
                                  const next = new Map(current);
                                  next.set(schedule.id, event.target.value);
                                  return next;
                                })
                              }
                            />
                          </Field>
                          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-[var(--radius)] border border-border bg-muted/20 p-2.5">
                            <div className="min-w-0">
                              <label
                                htmlFor={`automation-auto-retry-${schedule.id}`}
                                className="text-sm font-medium"
                              >
                                Retry failed test jobs once
                              </label>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                Starts one guarded GitLab retry wave per failed
                                pipeline. Runner-system failures are excluded.
                              </p>
                            </div>
                            <Switch
                              id={`automation-auto-retry-${schedule.id}`}
                              className="shrink-0"
                              checked={
                                autoRetry.get(schedule.id)?.enabled ?? false
                              }
                              onCheckedChange={(enabled) =>
                                setAutoRetry((current) => {
                                  const next = new Map(current);
                                  next.set(schedule.id, {
                                    enabled,
                                    maxJobsPerPipeline:
                                      current.get(schedule.id)
                                        ?.maxJobsPerPipeline ?? 3,
                                  });
                                  return next;
                                })
                              }
                            />
                          </div>
                          {autoRetry.get(schedule.id)?.enabled ? (
                            <Field
                              label="Maximum jobs per pipeline"
                              className="max-w-xs"
                            >
                              <Input
                                type="number"
                                min={1}
                                max={20}
                                value={
                                  autoRetry.get(schedule.id)
                                    ?.maxJobsPerPipeline ?? 3
                                }
                                onChange={(event) => {
                                  const value = Math.min(
                                    20,
                                    Math.max(
                                      1,
                                      Number(event.currentTarget.value) || 1,
                                    ),
                                  );
                                  setAutoRetry((current) => {
                                    const next = new Map(current);
                                    next.set(schedule.id, {
                                      enabled: true,
                                      maxJobsPerPipeline: value,
                                    });
                                    return next;
                                  });
                                }}
                              />
                            </Field>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <section className={SETTINGS_SECTION_CLASS}>
        <h2 className={SECTION_TITLE_CLASS}>Jira ticketing</h2>
        <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
          Optional instance-wide defaults for future Automation failure tickets. The shared Jira
          site, account, and API token must be configured under Settings → Integrations before
          ticketing can run. Leave the project key empty to keep Jira ticketing disabled.
        </p>

        <div className="grid max-w-3xl gap-3 md:grid-cols-3">
          <Field label="Jira project key">
            <Input
              value={jira.projectKey}
              placeholder="e.g. TP"
              onChange={(event) =>
                setJira((current) => ({ ...current, projectKey: event.target.value }))
              }
            />
          </Field>
          <Field label="Default parent ticket">
            <Input
              value={jira.parentKey}
              placeholder="Optional, e.g. TP-123"
              onChange={(event) =>
                setJira((current) => ({ ...current, parentKey: event.target.value }))
              }
            />
          </Field>
          <Field label="Issue type">
            <Input
              value={jira.issueType}
              placeholder="Bug"
              onChange={(event) =>
                setJira((current) => ({ ...current, issueType: event.target.value }))
              }
            />
          </Field>
          <Field label="Assignee">
            <JiraAssigneeSelect
              project={jira.projectKey}
              value={
                jira.assigneeMode === "fixed"
                  ? { mode: "fixed", accountId: jira.fixedAssignee }
                  : { mode: "automatic" }
              }
              automaticHint="Resolved by the Automation ticket service"
              onChange={(value) =>
                setJira((current) => ({
                  ...current,
                  assigneeMode: value.mode,
                  fixedAssignee: value.mode === "fixed" ? value.accountId : "",
                }))
              }
            />
          </Field>
          <Field label="Jira board ID">
            <Input
              type="number"
              min={1}
              value={jira.boardId}
              placeholder="Optional"
              onChange={(event) =>
                setJira((current) => ({ ...current, boardId: event.target.value }))
              }
            />
          </Field>
          <div className="flex items-center justify-between gap-4 rounded-[var(--radius)] border border-border bg-card px-3 py-2 md:col-span-2">
            <div>
              <label htmlFor="automation-active-sprint" className="text-sm font-medium">
                Use active sprint
              </label>
              <p className="text-sm text-muted-foreground">
                Add new tickets to the active sprint for the selected board.
              </p>
            </div>
            <Switch
              id="automation-active-sprint"
              checked={jira.useActiveSprint}
              onCheckedChange={(checked) =>
                setJira((current) => ({ ...current, useActiveSprint: checked }))
              }
            />
          </div>
        </div>

        <Field className="mt-3 max-w-3xl" label="Labels">
          <LabelCombobox
            value={jira.labels}
            onChange={(labels) => setJira((current) => ({ ...current, labels }))}
            suggestions={["talos", "automation"]}
            placeholder="Add a label…"
          />
        </Field>
        {jiraError ? (
          <p className="mt-2 text-sm text-destructive">{jiraError}</p>
        ) : null}
      </section>

      <AutomationPollingSettings
        configured={initial.configured && initial.schedules.length > 0}
        task={pollingTask}
        onChanged={onPollingChanged}
      />
      <AutomationManualSync
        configured={initial.configured && initial.schedules.length > 0}
      />

      {save.error ? <ErrorBox>{save.error}</ErrorBox> : null}
      {save.done ? <p className="text-sm text-muted-foreground">Saved.</p> : null}
      <Button
        type="button"
        className="w-fit"
        disabled={save.busy || !dirty || !complete || jiraError != null}
        onClick={handleSave}
      >
        {save.busy ? "Saving…" : "Save"}
      </Button>
      {!complete ? (
        <p className="text-sm text-muted-foreground">
          Enter a project to save. Synchronization requires at least one selected schedule.
        </p>
      ) : null}
    </div>
  );
}

function AutomationPollingSettings({
  configured,
  task,
  onChanged,
}: {
  configured: boolean;
  task: TaskDetail;
  onChanged: () => void;
}) {
  const action = useAction();
  const interval = intervalOf(task.schedule);

  const update = (enabled: boolean, minutes = interval === "custom" ? "10" : interval) =>
    action.run(async () => {
      await api.updateSchedule(AUTOMATION_SYNC_TASK_ID, {
        enabled,
        maxItemsPerRun: AUTOMATION_SYNC_MAX_ITEMS,
        trigger: { type: "cron", expression: `*/${minutes} * * * *` },
      });
      onChanged();
    });

  return (
    <section className={SETTINGS_SECTION_CLASS}>
      <h2 className={SECTION_TITLE_CLASS}>Report synchronization</h2>
      <div className="flex max-w-2xl items-center justify-between gap-5 rounded-[var(--radius)] border border-border bg-card p-3.5">
        <div>
          <label htmlFor="automation-polling" className="text-sm font-medium">
            Poll configured schedules
          </label>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Store pipeline and JUnit results locally for the Automation dashboard.
          </p>
        </div>
        <Switch
          id="automation-polling"
          checked={task.enabled}
          disabled={action.busy || !configured}
          onCheckedChange={(checked) => update(checked)}
        />
      </div>
      <Field className="mt-3" label="Polling interval">
        <Select
          value={interval}
          disabled={action.busy || !task.enabled}
          onValueChange={(minutes) => update(true, minutes)}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {POLL_INTERVALS.map((minutes) => (
              <SelectItem key={minutes} value={minutes}>
                Every {minutes} minutes
              </SelectItem>
            ))}
            {interval === "custom" ? (
              <SelectItem value="custom" disabled>
                Custom schedule
              </SelectItem>
            ) : null}
          </SelectContent>
        </Select>
      </Field>
      {!configured ? (
        <p className="mt-1.5 text-sm text-muted-foreground">
          Save the project and schedule allowlist before enabling synchronization.
        </p>
      ) : null}
      {action.error ? <ErrorBox>{action.error}</ErrorBox> : null}
    </section>
  );
}

function AutomationManualSync({ configured }: { configured: boolean }) {
  return (
    <section className={SETTINGS_SECTION_CLASS}>
      <h2 className={SECTION_TITLE_CLASS}>Sync now</h2>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Start an immediate import for every selected schedule. The first sync
        backfills 30 days; later syncs update new and unfinished pipelines.
      </p>
      <AutomationSyncControl configured={configured} />
    </section>
  );
}

export function intervalOf(schedule: string | null): string {
  return /^\*\/(5|10|15|30) \* \* \* \*$/.exec(schedule ?? "")?.[1] ?? "custom";
}
