import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, RefreshCw } from "lucide-react";

import { api } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { ErrorBox } from "./components/ui/query-state.tsx";
import { invalidate, queries } from "./queries.ts";
import { useAction } from "./useAction.ts";
import { useApi } from "./useApi.ts";

const AUTOMATION_SYNC_TASK_ID = "automation-report-sync";

export function AutomationSyncControl({
  configured,
  compact = false,
}: {
  configured: boolean;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const [settleUntil, setSettleUntil] = useState(0);
  const [requestedRunId, setRequestedRunId] = useState<string>();
  const trackedRunId = useRef<string | undefined>(undefined);
  const refreshedRunId = useRef<string | undefined>(undefined);
  const action = useAction();
  const task = useApi(
    queries.task(AUTOMATION_SYNC_TASK_ID, { settleUntil }),
  );

  const runs = task.data
    ? [
        ...(task.data.lastRun ? [task.data.lastRun] : []),
        ...task.data.runs,
      ]
    : [];
  const activeRun = runs.find((run) => run.status === "running");
  const requestedRun = requestedRunId
    ? runs.find((run) => run.executionId === requestedRunId)
    : undefined;
  const waitingForRequestedRun =
    requestedRunId != null &&
    (requestedRun == null || requestedRun.status === "running");
  const syncing = action.busy || activeRun != null || waitingForRequestedRun;

  useEffect(() => {
    if (activeRun) trackedRunId.current = activeRun.executionId;

    const trackedId = trackedRunId.current;
    if (!trackedId || refreshedRunId.current === trackedId) return;
    const trackedRun = runs.find((run) => run.executionId === trackedId);
    if (!trackedRun || trackedRun.status === "running") return;

    refreshedRunId.current = trackedId;
    invalidate.automation(queryClient);
  }, [activeRun, queryClient, runs]);

  const sync = () => {
    const keepWatching = () => setSettleUntil(Date.now() + 15_000);
    keepWatching();
    void action.run(async () => {
      const run = await api.syncAutomation();
      trackedRunId.current = run.executionId;
      setRequestedRunId(run.executionId);
      keepWatching();
      invalidate.jobQueue(queryClient);
    });
  };

  const result =
    requestedRun && requestedRun.status !== "running" ? requestedRun : undefined;
  const resultMessage =
    result?.status === "success"
      ? "Sync complete. Reports have been updated."
      : result?.status === "failure"
        ? result.error ?? "Synchronization failed."
        : result?.status === "cancelled"
          ? "Synchronization was cancelled."
          : undefined;

  return (
    <div className={compact ? "grid justify-items-end gap-1.5" : "grid w-fit gap-2"}>
      <Button
        type="button"
        variant="outline"
        size={compact ? "sm" : "default"}
        disabled={!configured || task.loading || syncing}
        onClick={sync}
        aria-live="polite"
      >
        {syncing ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <RefreshCw className="size-4" />
        )}
        {action.busy
          ? "Starting sync…"
          : syncing
            ? "Syncing projects…"
            : "Sync projects now"}
      </Button>
      {!compact && syncing ? (
        <p className="text-sm text-muted-foreground" role="status">
          Importing pipeline and JUnit results. You can leave this page while it runs.
        </p>
      ) : null}
      {!compact && resultMessage ? (
        <p
          className={
            result?.status === "success"
              ? "text-sm text-muted-foreground"
              : "text-sm text-destructive"
          }
          role="status"
        >
          {resultMessage}
        </p>
      ) : null}
      {action.error ? <ErrorBox>{action.error}</ErrorBox> : null}
    </div>
  );
}
