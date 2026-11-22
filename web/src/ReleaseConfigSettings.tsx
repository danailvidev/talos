import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api, type ReleaseConfigView, type TaskDetail } from "./api.ts";
import { Field } from "./components/ui/field.tsx";
import { Button } from "./components/ui/button.tsx";
import { queries } from "./queries.ts";
import { keys } from "./query-keys.ts";
import { useApi } from "./useApi.ts";
import { useAction } from "./useAction.ts";
import { ErrorBox, QueryState } from "./components/ui/query-state.tsx";
import { TitleInfo } from "./TitleInfo.tsx";
import { Input } from "./components/ui/input.tsx";
import { Switch } from "./components/ui/switch.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { SETTINGS_FORM_CLASS, SETTINGS_SECTION_CLASS } from "./settings-layout.ts";
import { PAGE_TITLE_CLASS, SECTION_TITLE_CLASS } from "./typography-styles.ts";

const RELEASE_REPO_POLL_TASK_ID = "release-repo-poll";
const POLL_INTERVALS = ["5", "10", "15", "30"] as const;

/**
 * Which repo/manifest/branch the Releases page reads and edits.
 *
 * Instance-wide, not per-user: there is one releases repo for the team. Editing
 * it here rather than in bootstrap YAML is what lets an operator point talos
 * at the manifest without a restart.
 */
export function ReleaseConfigSettings() {
  const queryClient = useQueryClient();
  const config = useApi(queries.releaseConfig());
  const polling = useApi(queries.task(RELEASE_REPO_POLL_TASK_ID));

  return (
    <QueryState query={config} loading="Loading…">
      {(data) => (
        <QueryState query={polling} loading="Loading…">
          {(pollingTask) => (
            <ReleaseConfigForm
              initial={data}
              pollingTask={pollingTask}
              onPollingChanged={() => {
                void queryClient.invalidateQueries({ queryKey: keys.allTasks() });
              }}
              onSaved={(saved) => {
                queryClient.setQueryData(keys.releaseConfig(), saved);
                // Pointing at a different repo or branch invalidates every version the
                // Releases page is showing. Named individually rather than as the
                // `["releases"]` prefix, which would also throw away the config we
                // just wrote from the response.
                void queryClient.invalidateQueries({ queryKey: keys.releases() });
                void queryClient.invalidateQueries({ queryKey: keys.releaseWatches() });
              }}
            />
          )}
        </QueryState>
      )}
    </QueryState>
  );
}

function ReleaseConfigForm({
  initial,
  pollingTask,
  onPollingChanged,
  onSaved,
}: {
  initial: ReleaseConfigView;
  pollingTask: TaskDetail;
  onPollingChanged: () => void;
  onSaved: (saved: ReleaseConfigView) => void;
}) {
  const [projectId, setProjectId] = useState(initial.projectId);
  const [manifestPath, setManifestPath] = useState(initial.manifestPath);
  const [targetBranch, setTargetBranch] = useState(initial.targetBranch);
  const save = useAction();

  useEffect(() => {
    setProjectId(initial.projectId);
    setManifestPath(initial.manifestPath);
    setTargetBranch(initial.targetBranch);
  }, [initial]);

  const handleSave = () =>
    save.run(async () => {
      onSaved(
        await api.setReleaseConfig({
          projectId: projectId.trim(),
          manifestPath: manifestPath.trim(),
          targetBranch: targetBranch.trim(),
        }),
      );
    });

  const dirty =
    projectId !== initial.projectId ||
    manifestPath !== initial.manifestPath ||
    targetBranch !== initial.targetBranch;
  const complete =
    projectId.trim() !== "" && manifestPath.trim() !== "" && targetBranch.trim() !== "";

  const inputClass =
    "w-96";

  return (
    <div className={SETTINGS_FORM_CLASS}>
      <h1 className={PAGE_TITLE_CLASS}>
        Releases
        <TitleInfo>
          Instance-wide — the repository the Releases page reads versions from and opens merge
          requests against. Requires a GITLAB_TOKEN with the <span className="mono">api</span>{" "}
          scope.
        </TitleInfo>
      </h1>

      <section className={SETTINGS_SECTION_CLASS}>
        <h2 className={SECTION_TITLE_CLASS}>Manifest repository</h2>
        <Field label="Project">
          <Input
            className={`${inputClass} mono`}
            value={projectId}
            placeholder="group/project — e.g. example-org/releases"
            onChange={(e) => setProjectId(e.target.value)}
          />
        </Field>
        <Field className="mt-3" label="Manifest filename">
          <Input
            className={`${inputClass} mono`}
            value={manifestPath}
            placeholder="e.g. cluster.yaml"
            onChange={(e) => setManifestPath(e.target.value)}
          />
        </Field>
        <Field className="mt-3" label="Target branch">
          <Input
            className={`${inputClass} mono`}
            value={targetBranch}
            placeholder="e.g. main"
            onChange={(e) => setTargetBranch(e.target.value)}
          />
        </Field>
        <div className="mt-1.5 text-sm text-[var(--text-faint)]">
          Each top-level folder in the repo is an environment; its versions live in a file of
          this name (e.g. <span className="mono">cluster.yaml</span>) holding{" "}
          <span className="mono">applications</span> and <span className="mono">services</span>{" "}
          lists. Files are read from the target branch, and every upload opens a merge request
          against it.
        </div>
      </section>

      <ReleasePollingSettings
        configured={initial.configured}
        task={pollingTask}
        onChanged={onPollingChanged}
      />

      {save.error ? <ErrorBox>{save.error}</ErrorBox> : null}
      {save.done ? <div className="mt-1.5 text-sm text-[var(--text-faint)]">Saved.</div> : null}

      <div className="flex gap-2">
        <Button type="button" disabled={save.busy || !dirty || !complete} onClick={handleSave}>
          {save.busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function ReleasePollingSettings({
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
      await api.updateSchedule(RELEASE_REPO_POLL_TASK_ID, {
        enabled,
        trigger: {
          type: "cron",
          expression: `*/${minutes} * * * *`,
        },
      });
      onChanged();
    });

  return (
    <section className={SETTINGS_SECTION_CLASS}>
      <h2 className={SECTION_TITLE_CLASS}>Automatic release detection</h2>
      <div className="flex max-w-145 items-center justify-between gap-5 rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] px-3.5 py-3">
        <div>
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="release-repo-polling"
          >
            Watch releases made directly in GitLab
          </label>
          <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
            Poll the target branch for version changes in <span className="mono">prod*</span>{" "}
            manifests and automatically start the post-deploy watch.
          </p>
        </div>
        <Switch
          id="release-repo-polling"
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
        <div className="mt-1.5 text-sm text-[var(--text-faint)]">
          Save the manifest repository before enabling automatic detection.
        </div>
      ) : null}
      {action.error ? <ErrorBox>{action.error}</ErrorBox> : null}
    </section>
  );
}

function intervalOf(schedule: string | null): string {
  const match = /^\*\/(5|10|15|30) \* \* \* \*$/.exec(schedule ?? "");
  return match?.[1] ?? "custom";
}
