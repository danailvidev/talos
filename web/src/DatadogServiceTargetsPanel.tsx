import { useQueryClient } from "@tanstack/react-query";
import { GitBranch, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  api,
  type DatadogServiceTargetView,
} from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { ErrorBox, Loading } from "./components/ui/query-state.tsx";
import { toMessage } from "./errors.ts";
import { keys } from "./query-keys.ts";
import { queries } from "./queries.ts";
import { useApi } from "./useApi.ts";

export function DatadogServiceTargetsPanel({
  onToast,
  onChanged,
}: {
  onToast: (message: string) => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const result = useApi(queries.datadogServiceTargets());
  const targets = useMemo(
    () => new Map((result.data?.targets ?? []).map((target) => [target.service, target])),
    [result.data],
  );
  const services = useMemo(
    () =>
      [...new Set([...(result.data?.services ?? []), ...targets.keys()])].sort((a, b) =>
        a.localeCompare(b),
      ),
    [result.data, targets],
  );

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.datadogServiceTargets() });
    onChanged();
  };

  return (
    <section className="flex flex-col gap-3 rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] px-4 py-3.5">
      <header>
        <h2 className="m-0 text-[0.9375rem] font-semibold text-foreground">
          Service repositories
        </h2>
        <p className="mt-0.5 max-w-[78ch] text-sm text-muted-foreground">
          Exact Datadog service names mapped to the GitLab repository an agent may
          inspect and the base branch its merge request targets. Unmapped services
          default to{" "}
          <span className="mono">
            {result.data?.defaultProjectPrefix ?? "example-org/services"}/&lt;service&gt;
          </span>{" "}
          on <span className="mono">master</span>.
        </p>
      </header>

      {result.error ? <ErrorBox>{result.error}</ErrorBox> : null}
      {result.loading && !result.data ? <Loading>Loading repositories…</Loading> : null}
      {services.length === 0 && result.data ? (
        <p className="m-0 text-sm text-muted-foreground">
          No services have been discovered yet. Run a Datadog scan first.
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        {services.map((service) => (
          <ServiceTargetRow
            key={service}
            service={service}
            target={targets.get(service)}
            defaultProjectPrefix={result.data?.defaultProjectPrefix ?? "example-org/services"}
            defaultTargetBranch={result.data?.defaultTargetBranch ?? "master"}
            onSaved={refresh}
            onToast={onToast}
          />
        ))}
      </div>
    </section>
  );
}

function ServiceTargetRow({
  service,
  target,
  defaultProjectPrefix,
  defaultTargetBranch,
  onSaved,
  onToast,
}: {
  service: string;
  target?: DatadogServiceTargetView;
  defaultProjectPrefix: string;
  defaultTargetBranch: string;
  onSaved: () => void;
  onToast: (message: string) => void;
}) {
  const inferredProject = `${defaultProjectPrefix}/${service}`;
  const defaultProject = target?.projectId ?? inferredProject;
  const defaultBranch = target?.targetBranch ?? defaultTargetBranch;
  const [projectId, setProjectId] = useState(defaultProject);
  const [targetBranch, setTargetBranch] = useState(defaultBranch);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setProjectId(defaultProject);
    setTargetBranch(defaultBranch);
  }, [defaultProject, defaultBranch]);

  const save = async () => {
    setBusy(true);
    try {
      await api.setDatadogServiceTarget(service, {
        projectId: projectId.trim(),
        targetBranch: targetBranch.trim(),
      });
      onToast(`Repository saved for ${service}.`);
      onSaved();
    } catch (error) {
      onToast(toMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteDatadogServiceTarget(service);
      onToast(`${service} now uses ${inferredProject} on ${defaultTargetBranch}.`);
      onSaved();
    } catch (error) {
      onToast(toMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const changed =
    projectId.trim() !== defaultProject ||
    targetBranch.trim() !== defaultBranch;

  return (
    <div className="grid grid-cols-1 items-center gap-2 min-[901px]:grid-cols-[minmax(140px,0.8fr)_minmax(220px,1.4fr)_minmax(140px,0.8fr)_auto]">
      <span className="mono min-w-0 overflow-hidden text-ellipsis text-sm" title={service}>
        {service}
      </span>
      <Input
        value={projectId}
        placeholder="group/project"
        aria-label={`${service} GitLab project`}
        disabled={busy}
        onChange={(event) => setProjectId(event.target.value)}
      />
      <div className="relative">
        <GitBranch
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
          size={13}
        />
        <Input
          className="pl-8 font-mono"
          value={targetBranch}
          placeholder="main"
          aria-label={`${service} base branch`}
          disabled={busy}
          onChange={(event) => setTargetBranch(event.target.value)}
        />
      </div>
      <div className="flex gap-1">
        <Button
          type="button"
          size="icon-sm"
          disabled={busy || !changed || !projectId.trim() || !targetBranch.trim()}
          aria-label={`Save ${service} repository`}
          onClick={() => void save()}
        >
          <Save size={13} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={busy || !target}
          aria-label={`Remove ${service} repository`}
          onClick={() => void remove()}
        >
          <Trash2 size={13} />
        </Button>
      </div>
    </div>
  );
}
