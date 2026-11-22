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
  datadogScanConfig,
  withDatadogScanConfig,
  type DatadogScanConfig,
} from "./datadog-scan-params.ts";
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
import { DATADOG_REGRESSION_POLICY } from "../../shared/datadog-policy.ts";

const GRID =
  "my-1 mb-2.5 grid max-w-180 grid-cols-3 gap-x-2.5 gap-y-2";
const FIELD =
  "flex flex-col gap-1 text-[0.7812rem] font-medium tracking-[0.04em] text-[var(--text-faint)] uppercase";
const INPUT = "h-8 w-full text-[0.9375rem] font-normal tracking-normal normal-case";
const HINT = "mt-1.5 max-w-180 text-sm text-[var(--text-faint)]";
const LABEL_SUGGESTIONS = ["talos", "datadog"];

const BADGE_TONE = {
  warning:
    "bg-[color-mix(in_srgb,var(--status-warning)_18%,var(--bg-deep))] text-[var(--status-warning)]",
  danger:
    "bg-[color-mix(in_srgb,var(--status-danger)_18%,var(--bg-deep))] text-[var(--status-danger)]",
  muted: "bg-[var(--bg-muted)] text-[var(--text-dim)]",
} as const;

function draftFrom(task: TaskDetailData) {
  const timeZone = task.timezone ?? "";
  return {
    ...datadogScanConfig(task.params),
    frequency: frequencyOf(task),
    timeZone,
    firstRun: firstRunOf(task, timeZone),
    customCron:
      task.schedule && frequencyOf(task) === "custom"
        ? task.schedule
        : "15 6 * * *",
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

function DecisionLogic({ draft }: { draft: Draft }) {
  const policy = DATADOG_REGRESSION_POLICY;
  const criticalIncrease = Math.round((policy.criticalGrowthRatio - 1) * 100);
  const highIncrease = Math.round((policy.highGrowthRatio - 1) * 100);
  const lowDecrease = Math.round((1 - policy.lowGrowthRatio) * 100);

  return (
    <section className="mt-7 border-t border-border pt-5">
      <h3 className={SECTION_TITLE_CLASS}>Current decision logic</h3>
      <p className="mb-3 max-w-240 text-sm text-muted-foreground">
        These are the rules the loop executes now. Numeric thresholds come from
        the same shared policy constants as the backend.
      </p>
      <div className="grid max-w-240 gap-3 lg:grid-cols-3">
        <article className="rounded-lg border border-border bg-card p-3.5">
          <h4 className="mb-2 text-sm font-semibold text-foreground">Scope and filtering</h4>
          <ul className="list-disc space-y-1.5 pl-4 text-sm text-muted-foreground">
            <li>
              Environment is always <code>{policy.environment}</code>; other
              environments cannot be included by the custom query.
            </li>
            <li>
              Reads the last {draft.lookbackHours || "24"} hours using{" "}
              <code>{draft.query.trim() || "status:error env:prod"}</code>.
            </li>
            <li>Enumerates every service, then samples bounded log bodies per service.</li>
            <li>
              Applies routing ignore rules before sampling where possible and
              signature ignore rules after clustering.
            </li>
            <li>
              Forgets open, unticketed signatures after {policy.staleAfterDays} complete
              daily scans without seeing them.
            </li>
          </ul>
        </article>

        <article className="rounded-lg border border-border bg-card p-3.5">
          <h4 className="mb-2 text-sm font-semibold text-foreground">Clustering and severity</h4>
          <ul className="list-disc space-y-1.5 pl-4 text-sm text-muted-foreground">
            <li>
              Normalises IDs, numbers, generated paths, and similar volatile values,
              then fingerprints <code>service + signature</code>.
            </li>
            <li>
              Groups related log shapes only inside one service when rare error codes
              or code identifiers cross-reference each other in messages or stacks.
            </li>
            <li>
              A grouping token may span at most {policy.maxGroupingTokenSpread} clusters;
              generic exceptions never merge problems.
            </li>
            <li>
              <strong>Critical:</strong> new errors, critical/fatal statuses, or at
              least {criticalIncrease}% growth ({policy.criticalGrowthRatio}×).
            </li>
            <li>
              <strong>High:</strong> at least {highIncrease}% growth (
              {policy.highGrowthRatio}×).
            </li>
            <li>
              <strong>Medium:</strong> steady/no-baseline errors. Warning-like statuses
              are capped here.
            </li>
            <li>
              <strong>Low:</strong> volume fell at least {lowDecrease}%.
            </li>
          </ul>
        </article>

        <article className="rounded-lg border border-border bg-card p-3.5">
          <h4 className="mb-2 text-sm font-semibold text-foreground">Jira decisions</h4>
          <ul className="list-disc space-y-1.5 pl-4 text-sm text-muted-foreground">
            <li>Dismissed problems and old unticketed baseline noise are skipped.</li>
            <li>Critical and high problems file immediately.</li>
            <li>
              Medium and low problems need another observation between{" "}
              {policy.confirmationMinHours} and {policy.confirmationMaxHours} hours later.
            </li>
            <li>
              An open Jira issue is adopted or re-used. A resolved issue with an open
              GitLab merge request remains suppressed.
            </li>
            <li>
              A resolved issue with no active merge request may file again as a returned
              regression.
            </li>
            <li>
              Every ticket includes the complete sampled message/stack, mandatory
              fingerprint labels, and the highest-numbered active sprint.
            </li>
          </ul>
        </article>
      </div>
      <p className={HINT}>
        Ownership, ignore patterns, and per-team Jira project overrides are managed
        on Datadog → Settings → Routing.
      </p>
    </section>
  );
}

export function DatadogScanSettings({
  task,
  onSaved,
  onToast,
}: {
  task: TaskDetailData;
  onSaved: () => void;
  onToast?: (text: string) => void;
}) {
  const [saved, setSaved] = useState(() => draftFrom(task));
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    api.task(task.id).then(
      (fresh) => {
        if (cancelled) return;
        const next = draftFrom(fresh);
        setSaved(next);
        setDraft(next);
      },
      (error) => {
        if (!cancelled) setLoadError(toMessage(error));
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
      if (!draft.jiraProject.trim() || !draft.issueType.trim()) {
        throw new Error("Jira project key and issue type are required.");
      }
      if (draft.assigneeMode === "fixed" && !draft.assignee.trim()) {
        throw new Error("Choose a Jira assignee or use Automatic.");
      }
      const config: DatadogScanConfig = {
        query: draft.query,
        lookbackHours: draft.lookbackHours,
        servicePageSize: draft.servicePageSize,
        samplesPerService: draft.samplesPerService,
        jiraProject: draft.jiraProject.trim(),
        issueType: draft.issueType.trim(),
        assigneeMode: draft.assigneeMode,
        assignee: draft.assignee.trim(),
        labels: draft.labels,
        bugFoundBy: draft.bugFoundBy,
        feBeUx: draft.feBeUx,
        useActiveSprint: draft.useActiveSprint,
        boardId: draft.boardId,
      };
      const fresh = await api.task(task.id);
      const params = withDatadogScanConfig(fresh.params, config);
      const trigger = buildTrigger(
        draft.frequency,
        draft.firstRun,
        draft.timeZone,
        draft.customCron,
      );
      await api.updateSchedule(task.id, { params, trigger });
      const next = { ...draft, ...config };
      setSaved(next);
      setDraft(next);
      onSaved();
      onToast?.("Settings saved");
    } catch (error) {
      onToast?.(toMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-5.5">
      <h2 className={SECTION_TITLE_CLASS}>Settings</h2>
      {loadError ? <ErrorBox>{loadError}</ErrorBox> : null}

      <div className={GRID}>
        <label className={cn(FIELD, "col-span-full")}>
          Datadog log query
          <Input
            className={INPUT}
            value={draft.query}
            placeholder="status:error"
            onChange={(event) => set("query", event.target.value)}
          />
        </label>
        <label className={FIELD}>
          Lookback hours
          <Input
            className={INPUT}
            type="number"
            min={1}
            max={168}
            value={draft.lookbackHours}
            placeholder="24"
            onChange={(event) => set("lookbackHours", event.target.value)}
          />
        </label>
        <label className={FIELD}>
          Service page size
          <Input
            className={INPUT}
            type="number"
            min={1}
            max={100}
            value={draft.servicePageSize}
            placeholder="20"
            onChange={(event) => set("servicePageSize", event.target.value)}
          />
        </label>
        <label className={FIELD}>
          Samples per service
          <Input
            className={INPUT}
            type="number"
            min={10}
            max={1000}
            value={draft.samplesPerService}
            placeholder="200"
            onChange={(event) => set("samplesPerService", event.target.value)}
          />
        </label>
      </div>
      <p className={HINT}>
        The loop always adds <code>env:prod</code>, even when the saved query names
        another environment. Every service page is consumed; the page size only
        controls Datadog request batching.
      </p>

      <div className={GRID}>
        <label className={FIELD}>
          Jira project key
          <Input
            className={INPUT}
            value={draft.jiraProject}
            placeholder="e.g. TP"
            onChange={(event) => set("jiraProject", event.target.value)}
          />
        </label>
        <label className={FIELD}>
          Issue type
          <Input
            className={INPUT}
            value={draft.issueType}
            placeholder="Bug"
            onChange={(event) => set("issueType", event.target.value)}
          />
        </label>
        <label className={FIELD}>
          Assignee
          <JiraAssigneeSelect
            className={INPUT}
            project={draft.jiraProject}
            value={
              draft.assigneeMode === "fixed"
                ? { mode: "fixed", accountId: draft.assignee }
                : { mode: "automatic" }
            }
            automaticHint="Jira integration account"
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                assigneeMode: value.mode,
                assignee: value.mode === "fixed" ? value.accountId : "",
              }))
            }
          />
        </label>
        <label className={FIELD}>
          Bug found by
          <Input
            className={INPUT}
            value={draft.bugFoundBy}
            placeholder="Automation (optional)"
            onChange={(event) => set("bugFoundBy", event.target.value)}
          />
        </label>
        <label className={FIELD}>
          FE/BE/UX
          <Input
            className={INPUT}
            value={draft.feBeUx}
            placeholder="BE (optional)"
            onChange={(event) => set("feBeUx", event.target.value)}
          />
        </label>
        <label className={FIELD}>
          Jira board ID
          <Input
            className={INPUT}
            type="number"
            min={1}
            value={draft.boardId}
            placeholder="Auto-discover if unique"
            onChange={(event) => set("boardId", event.target.value)}
          />
        </label>
      </div>
      <p className={HINT}>
        Per-team Datadog routing rules can override the project key. Automatic
        assignment uses the Jira integration account because a grouped log problem
        has no reliable source-file author. Tickets always go to the highest-numbered
        active sprint.
      </p>

      <label className={cn(FIELD, "mt-1 max-w-180")}>
        Labels
        <LabelCombobox
          value={draft.labels}
          onChange={(labels) => set("labels", labels)}
          suggestions={LABEL_SUGGESTIONS}
          placeholder="Add a label…"
        />
      </label>
      <p className={HINT}>
        Mandatory Datadog severity, area, and fingerprint labels are added
        automatically for routing and duplicate detection.
      </p>

      <DecisionLogic draft={draft} />

      <div className={GRID}>
        <label className={FIELD}>
          First run
          <Input
            className={INPUT}
            type="datetime-local"
            value={draft.firstRun}
            onChange={(event) => set("firstRun", event.target.value)}
          />
        </label>
        <label className={FIELD}>
          Frequency
          <Select
            value={draft.frequency}
            onValueChange={(value) => set("frequency", value as LoopFrequency)}
          >
            <SelectTrigger className={INPUT}>
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
        <label className={FIELD}>
          Timezone
          <TimezoneSelect
            value={draft.timeZone}
            onChange={(value) => set("timeZone", value)}
          />
        </label>
        {draft.frequency === "custom" ? (
          <label className={cn(FIELD, "col-span-full")}>
            Cron
            <Input
              className={cn(INPUT, "mono text-sm")}
              value={draft.customCron}
              placeholder="15 6 * * *"
              onChange={(event) => set("customCron", event.target.value)}
            />
          </label>
        ) : null}
        {(() => {
          const badge = liveBadge(
            draft.frequency,
            draft.firstRun,
            draft.customCron,
          );
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
        <Button
          type="button"
          size="sm"
          disabled={saving || !isDirty(draft, saved)}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </section>
  );
}
