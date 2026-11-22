import { useEffect, useState } from "react";

import { api, type TaskDetail as TaskDetailData } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { ErrorBox } from "./components/ui/query-state.tsx";
import { JiraAssigneeSelect } from "./JiraAssigneeSelect.tsx";
import { LabelCombobox } from "./LabelCombobox.tsx";
import { TimezoneSelect } from "./TimezoneSelect.tsx";
import {
  CI_FAILURE_DEFAULTS,
  ciFailureConfig,
  withCiFailureConfig,
  type CiFailureConfig,
} from "./ci-failure-params.ts";
import {
  buildTrigger,
  frequencyOf,
  firstRunOf,
  liveBadge,
  type LoopFrequency,
} from "./LoopScheduleControls.tsx";
import { toMessage } from "./errors.ts";
import { cn } from "./lib/utils.ts";
import { SECTION_TITLE_CLASS } from "./typography-styles.ts";

const SETTINGS_GRID_CLASS =
  "my-1 mb-2.5 grid max-w-180 grid-cols-3 gap-x-2.5 gap-y-2";
const SETTINGS_FIELD_CLASS =
  "flex flex-col gap-1 text-[0.7812rem] font-medium tracking-[0.04em] text-[var(--text-faint)] uppercase";
const SETTINGS_INPUT_CLASS =
  "h-8 w-full text-[0.9375rem] font-normal tracking-normal normal-case";
const SETTINGS_HINT_CLASS = "mt-1.5 max-w-180 text-sm text-[var(--text-faint)]";

const BADGE_TONE = {
  warning:
    "bg-[color-mix(in_srgb,var(--status-warning)_18%,var(--bg-deep))] text-[var(--status-warning)]",
  danger:
    "bg-[color-mix(in_srgb,var(--status-danger)_18%,var(--bg-deep))] text-[var(--status-danger)]",
  muted: "bg-[var(--bg-muted)] text-[var(--text-dim)]",
} as const;

/**
 * Known values for Jira's "Bug found by" select field on the TP project's Bug
 * issue type. There is no API in this app that fetches a Jira field's
 * `allowedValues` dynamically, so this list is a hardcoded snapshot — a wrong
 * or stale entry here fails the same way a typo did: Jira 400s with "Select a
 * valid option". If Jira admins add/rename/remove options, update this list.
 */
const BUG_FOUND_BY_OPTIONS = ["Tech pre Prod", "Tech on Prod", "User", "Automation", "Not a bug"];

/**
 * Starting suggestions for the labels combobox. There's no endpoint that
 * lists labels actually in use across Jira tickets, so this is just the
 * loop's own historical defaults — typing anything else still adds it as a
 * free-text label.
 */
const LABEL_SUGGESTIONS = ["talos", "ci-failure"];

function draftFrom(task: TaskDetailData) {
  const timeZone = task.timezone ?? "";
  return {
    ...ciFailureConfig(task.params),
    frequency: frequencyOf(task),
    timeZone,
    firstRun: firstRunOf(task, timeZone),
    customCron: task.schedule && frequencyOf(task) === "custom" ? task.schedule : "0 9 * * *",
  };
}

type Draft = ReturnType<typeof draftFrom>;

function isDirty(draft: Draft, saved: Draft): boolean {
  return (Object.keys(draft) as (keyof Draft)[]).some((key) => {
    if (key === "labels") {
      return (
        draft.labels.length !== saved.labels.length ||
        draft.labels.some((label, index) => label !== saved.labels[index])
      );
    }
    return draft[key] !== saved[key];
  });
}

/**
 * Dedicated settings tab for the CI-failure loop: GitLab project + pipeline
 * schedule, the Jira ticket fields it files with, and the run schedule — all
 * behind one explicit Save rather than saving on every blur/change. Reads
 * task.params fresh on mount rather than trusting whatever the parent already
 * has in state, since that can be a stale poll snapshot from before this tab
 * opened. Save/error results go to the shared toast, not inline text — this
 * tab already renders a lot of inline error state for the schedule/labels.
 */
export function CiFailureSettings({
  task,
  onSaved,
  onToast,
}: {
  task: TaskDetailData;
  onSaved: () => void;
  onToast?: (text: string) => void;
}) {
  const [saved, setSavedDraft] = useState(() => draftFrom(task));
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    api.task(task.id).then(
      (fresh) => {
        if (cancelled) return;
        const next = draftFrom(fresh);
        setSavedDraft(next);
        setDraft(next);
      },
      (err) => {
        if (cancelled) return;
        setLoadError(toMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [task.id]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    setSaving(true);
    try {
      const gitlabProject = draft.gitlabProject.trim();
      const jiraProject = draft.jiraProject.trim();
      if (!gitlabProject || !jiraProject || !draft.bugFoundBy) {
        throw new Error("GitLab project, Jira project key, and Bug found by are all required.");
      }
      if (draft.assigneeMode === "fixed" && !draft.assignee.trim()) {
        throw new Error("Choose a Jira assignee or use Automatic.");
      }
      const config: CiFailureConfig = {
        gitlabProject,
        jiraProject,
        bugFoundBy: draft.bugFoundBy,
        pipelineSchedule: draft.pipelineSchedule.trim(),
        labels: draft.labels,
        assigneeMode: draft.assigneeMode,
        assignee: draft.assignee.trim(),
        failuresBeforeFiling: draft.failuresBeforeFiling.trim(),
        historyWindow: draft.historyWindow.trim(),
      };
      const fresh = await api.task(task.id);
      const params = withCiFailureConfig(fresh.params, config);
      const trigger = buildTrigger(draft.frequency, draft.firstRun, draft.timeZone, draft.customCron);
      await api.updateSchedule(task.id, { params, trigger });
      const savedDraft = { ...draft, ...config };
      setSavedDraft(savedDraft);
      setDraft(savedDraft);
      onSaved();
      onToast?.("Settings saved");
    } catch (err) {
      onToast?.(toMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const dirty = isDirty(draft, saved);

  return (
    <section className="mb-[22px]">
      <h2 className={SECTION_TITLE_CLASS}>Settings</h2>
      {loadError ? <ErrorBox>{loadError}</ErrorBox> : null}

      <div className={SETTINGS_GRID_CLASS}>
        <label className={SETTINGS_FIELD_CLASS}>
          GitLab project
          <Input
            className={SETTINGS_INPUT_CLASS}
            value={draft.gitlabProject}
            placeholder="group/project or numeric id"
            onChange={(event) => set("gitlabProject", event.target.value)}
          />
        </label>
        <label className={cn(SETTINGS_FIELD_CLASS, "col-span-2")}>
          Pipeline schedule
          <Input
            className={SETTINGS_INPUT_CLASS}
            value={draft.pipelineSchedule}
            placeholder="e.g. Scheduled pipeline for webportal tests"
            onChange={(event) => set("pipelineSchedule", event.target.value)}
          />
        </label>
      </div>
      <p className={SETTINGS_HINT_CLASS}>
        Must exactly match the <strong>description</strong> of a GitLab pipeline schedule
        (Settings → CI/CD → Pipeline schedules) — not the pipeline's own name, which is usually
        blank. Leave blank to consider any pipeline on the project instead of one schedule's runs.
      </p>

      <div className={SETTINGS_GRID_CLASS}>
        <label className={SETTINGS_FIELD_CLASS}>
          Jira project key
          <Input
            className={SETTINGS_INPUT_CLASS}
            value={draft.jiraProject}
            placeholder="e.g. SP"
            onChange={(event) => set("jiraProject", event.target.value)}
          />
        </label>
        <label className={SETTINGS_FIELD_CLASS}>
          Bug found by
          <Select value={draft.bugFoundBy} onValueChange={(value) => set("bugFoundBy", value)}>
            <SelectTrigger className={SETTINGS_INPUT_CLASS}>
              <SelectValue placeholder="Select a value" />
            </SelectTrigger>
            <SelectContent>
              {BUG_FOUND_BY_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className={SETTINGS_FIELD_CLASS}>
          Assignee
          <JiraAssigneeSelect
            className={SETTINGS_INPUT_CLASS}
            project={draft.jiraProject}
            value={
              draft.assigneeMode === "fixed"
                ? { mode: "fixed", accountId: draft.assignee }
                : { mode: "automatic" }
            }
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                assigneeMode: value.mode,
                assignee: value.mode === "fixed" ? value.accountId : "",
              }))
            }
          />
        </label>
      </div>
      <p className={SETTINGS_HINT_CLASS}>
        Automatic assigns the last person who changed the matching implementation file (for
        example, <code>component.spec.ts</code> uses <code>component.ts</code>). If that person
        cannot be resolved in Jira, the integration account is used.
      </p>

      <label className={cn(SETTINGS_FIELD_CLASS, "mt-1 max-w-180")}>
        Labels
        <LabelCombobox
          value={draft.labels}
          onChange={(labels) => set("labels", labels)}
          suggestions={LABEL_SUGGESTIONS}
          placeholder="Add a label…"
        />
      </label>
      <p className={SETTINGS_HINT_CLASS}>
        Every filed ticket also gets an automatic <code>spec:&lt;file&gt;</code> label used to find
        and reopen its own ticket — that one can't be removed here.
      </p>

      <div className={SETTINGS_GRID_CLASS}>
        <label className={SETTINGS_FIELD_CLASS}>
          File after
          <Input
            className={SETTINGS_INPUT_CLASS}
            type="number"
            min={1}
            value={draft.failuresBeforeFiling}
            placeholder={String(CI_FAILURE_DEFAULTS.failuresBeforeFiling)}
            onChange={(event) => set("failuresBeforeFiling", event.target.value)}
          />
        </label>
        <label className={SETTINGS_FIELD_CLASS}>
          History window
          <Input
            className={SETTINGS_INPUT_CLASS}
            type="number"
            min={2}
            value={draft.historyWindow}
            placeholder={String(CI_FAILURE_DEFAULTS.historyWindow)}
            onChange={(event) => set("historyWindow", event.target.value)}
          />
        </label>
      </div>
      <p className={SETTINGS_HINT_CLASS}>
        A spec has to fail this many runs <strong>in a row</strong> before it earns a
        ticket, judged over the last N pipelines that produced test results. Anything
        held back appears on the Spec failures tab. Set it to 1 to file on the first
        failure, flakes included — which is what this loop did before. A suite that
        fails to <em>run</em> at all (an import or syntax error) is deterministic and
        files immediately whatever this says.
      </p>

      <div className={SETTINGS_GRID_CLASS}>
        <label className={SETTINGS_FIELD_CLASS}>
          First run
          <Input
            className={SETTINGS_INPUT_CLASS}
            type="datetime-local"
            value={draft.firstRun}
            onChange={(event) => set("firstRun", event.target.value)}
          />
        </label>

        <label className={SETTINGS_FIELD_CLASS}>
          Frequency
          <Select
            value={draft.frequency}
            onValueChange={(value) => set("frequency", value as LoopFrequency)}
          >
            <SelectTrigger className={SETTINGS_INPUT_CLASS}>
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

        <label className={SETTINGS_FIELD_CLASS}>
          Timezone
          <TimezoneSelect value={draft.timeZone} onChange={(value) => set("timeZone", value)} />
        </label>

        {draft.frequency === "custom" ? (
          <label className={cn(SETTINGS_FIELD_CLASS, "col-span-full")}>
            Cron
            <Input
              className={cn(SETTINGS_INPUT_CLASS, "mono text-sm")}
              value={draft.customCron}
              placeholder="0 9 * * 1-5"
              onChange={(event) => set("customCron", event.target.value)}
            />
          </label>
        ) : null}

        {(() => {
          const badge = liveBadge(draft.frequency, draft.firstRun, draft.customCron);
          return (
            <span
              className={cn(
                "col-span-full mt-0.5 inline-flex justify-self-start rounded-lg px-2.5 py-1 text-sm leading-[1.4] font-semibold",
                BADGE_TONE[badge.tone],
              )}
            >
              {badge.label}
            </span>
          );
        })()}
      </div>

      <div className="mt-1 flex items-center gap-2.5">
        <Button type="button" size="sm" disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </section>
  );
}
