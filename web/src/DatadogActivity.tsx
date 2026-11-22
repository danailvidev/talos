import { useQueryClient } from "@tanstack/react-query";
import { Bot, ChevronDown, ChevronRight, FlaskConical, Square } from "lucide-react";
import { useState } from "react";

import { api, type DatadogActiveJobView } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { ErrorBox } from "./components/ui/query-state.tsx";
import { ago } from "./format.ts";
import { invalidate, queries } from "./queries.ts";
import { keys } from "./query-keys.ts";
import { RunHistory, RUNS_PER_PAGE } from "./runs/RunHistory.tsx";
import { ActivityLog } from "./Steps.tsx";
import { toMessage } from "./errors.ts";
import { useApi } from "./useApi.ts";
import { cn } from "./lib/utils.ts";

export function DatadogActivity() {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string>();
  const [stopping, setStopping] = useState<string>();
  const [error, setError] = useState<string>();
  const firstPage = useApi(
    queries.datadogActivity({ limit: RUNS_PER_PAGE, offset: 0 }),
  );

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.allDatadog() });
    invalidate.jobQueue(queryClient);
  };

  const stop = async (jobId: string) => {
    setStopping(jobId);
    setError(undefined);
    try {
      await api.cancelJob(jobId);
      refresh();
    } catch (cause) {
      setError(toMessage(cause));
    } finally {
      setStopping(undefined);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h2 className="m-0 text-lg font-semibold text-foreground">Datadog activity</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Queued work, live agent logs, scan history, regression tests and AI triage.
        </p>
      </header>
      {firstPage.error ? <ErrorBox>{firstPage.error}</ErrorBox> : null}
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {(firstPage.data?.activeJobs ?? []).length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            In progress
          </h3>
          {firstPage.data!.activeJobs.map((job) => (
            <ActiveJob
              key={job.jobId}
              job={job}
              open={expanded === job.jobId}
              stopping={stopping === job.jobId}
              onToggle={() =>
                setExpanded((current) => (current === job.jobId ? undefined : job.jobId))
              }
              onStop={() => void stop(job.jobId)}
            />
          ))}
        </section>
      ) : null}

      <RunHistory
        optionsFor={(page) => queries.datadogRuns(page)}
        fetchKey="datadog"
        initialRuns={firstPage.data?.runs}
        title="Run history"
        onRunsChanged={refresh}
        emptyState={
          <p className="text-sm text-muted-foreground">No Datadog runs have been recorded yet.</p>
        }
      />
    </div>
  );
}

function ActiveJob({
  job,
  open,
  stopping,
  onToggle,
  onStop,
}: {
  job: DatadogActiveJobView;
  open: boolean;
  stopping: boolean;
  onToggle: () => void;
  onStop: () => void;
}) {
  const Icon = job.action === "write-regression-test" ? FlaskConical : Bot;
  const label =
    job.action === "write-regression-test" ? "Write a regression test" : "AI triage";

  return (
    <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-[var(--bg-raised)]">
      <div className="flex items-stretch">
        <Button
          type="button"
          variant="ghost"
          className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-none px-3 py-2 text-left"
          disabled={!job.runId}
          onClick={onToggle}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Icon size={13} />
          <span className="font-semibold">{label}</span>
          {job.service ? <span className="mono text-muted-foreground">{job.service}</span> : null}
          <span className="text-muted-foreground">{job.message}</span>
          <span
            className={cn(
              "ml-auto text-xs font-semibold uppercase",
              job.status === "running" ? "text-[var(--running)]" : "text-[var(--warn)]",
            )}
          >
            {job.status} · {ago(job.enqueuedAt)}
          </span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="w-9 rounded-none border-l border-border text-muted-foreground hover:text-[var(--failure)]"
          disabled={stopping}
          aria-label={`Stop ${label}`}
          onClick={onStop}
        >
          <Square size={12} />
        </Button>
      </div>
      {open && job.runId ? <ActivityLog executionId={job.runId} live /> : null}
    </div>
  );
}
