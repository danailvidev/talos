import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type LogLineView } from "./api.ts";
import { queries } from "./queries.ts";
import { keys } from "./query-keys.ts";
import { RunTimeline } from "./runs/RunTimeline.tsx";
import { useApi } from "./useApi.ts";
import { ErrorBox } from "./components/ui/query-state.tsx";

const MAX_BROWSER_LOG_LINES = 5_000;

/**
 * The run log, folded into readable events — see `runs/timeline.ts` for the
 * folding rules and `runs/RunTimeline.tsx` for the rendering. Re-exported under
 * the old name because three places already reach for `RunLog` and they all want
 * the same thing: some lines, drawn as a log.
 */
export { RunTimeline as RunLog } from "./runs/RunTimeline.tsx";

/**
 * Starts with the compatible `/steps` history snapshot, then appends only log
 * rows after its newest cursor. A response can contain a backlog page, so the
 * cursor advances immediately until it is caught up before settling into the
 * one-second live poll.
 */
export function useIncrementalRunLogs(
  executionId: string,
  initialLogs: LogLineView[] | undefined,
  live: boolean | undefined,
): {
  logs: LogLineView[];
  error?: string;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
} {
  const [logs, setLogs] = useState<LogLineView[]>(initialLogs ?? []);
  const [cursor, setCursor] = useState(0);
  const [draining, setDraining] = useState(initialLogs !== undefined);
  const [initialized, setInitialized] = useState(initialLogs !== undefined);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  useEffect(() => {
    setLogs(initialLogs ?? []);
    setCursor(initialLogs?.at(-1)?.id ?? 0);
    setDraining(initialLogs !== undefined);
    setInitialized(initialLogs !== undefined);
    setHasOlder(false);
  }, [executionId, initialLogs]);

  const tail = useQuery({
    queryKey: ["runs", "log-tail", executionId],
    queryFn: () => api.logTail(executionId),
    enabled: !initialized && executionId.length > 0,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!tail.data || initialized) return;
    setLogs(tail.data.logs);
    setCursor(tail.data.logs.at(-1)?.id ?? 0);
    setHasOlder(tail.data.hasOlder);
    setInitialized(true);
    setDraining(true);
  }, [initialized, tail.data]);

  // Starting a run reopens a feed that may previously have drained as history.
  // Once open, the cursor endpoint below decides when the run is truly terminal.
  useEffect(() => {
    if (live) setDraining(true);
  }, [live]);

  const page = useQuery({
    queryKey: keys.runLogPage(executionId, cursor),
    queryFn: () => api.logPage(executionId, cursor),
    enabled: draining && initialized && executionId.length > 0,
    staleTime: 0,
    // The log endpoint's status is authoritative for this cursor. The task-detail
    // poll can observe a terminal run before this independent poll has fetched
    // the final `step … succeeded` line; stopping from `live` at that point leaves
    // the timeline's last step looking permanently active.
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 1_000 : false,
  });

  useEffect(() => {
    const data = page.data;
    if (!data) return;
    if (data.logs.length > 0) {
      setLogs((prior) => {
        const known = new Set(prior.map((line) => line.id));
        const combined = [...prior, ...data.logs.filter((line) => !known.has(line.id))];
        if (combined.length <= MAX_BROWSER_LOG_LINES) return combined;
        setHasOlder(true);
        return combined.slice(-MAX_BROWSER_LOG_LINES);
      });
      setCursor(data.nextCursor);
    }
    if (data.status === "running") setDraining(true);
    else if (!data.hasMore) setDraining(false);
  }, [page.data]);

  const loadOlder = async () => {
    const before = logs.at(0)?.id;
    if (!before || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const older = await api.logTail(executionId, before);
      // An explicit backward navigation keeps the older side of the window.
      // Live appends keep the newer side above; either direction remains bounded.
      setLogs((prior) => [...older.logs, ...prior].slice(0, MAX_BROWSER_LOG_LINES));
      setHasOlder(older.hasOlder);
    } finally {
      setLoadingOlder(false);
    }
  };

  const error = page.error ?? tail.error;
  return {
    logs,
    hasOlder,
    loadingOlder,
    loadOlder,
    ...(error ? { error: error.message } : {}),
  };
}

/**
 * Live feed for the latest run: clone, Claude tool calls, step lines.
 * Polls while `live` so a review in flight fills in.
 *
 * The poll is the cache's, keyed on the execution — so an expanded row in
 * `RunHistory` showing the same run reads these lines rather than fetching them
 * a second time.
 */
export function ActivityLog({
  executionId,
  live,
}: {
  executionId?: string;
  live?: boolean;
}) {
  const steps = useApi(queries.runSteps(executionId ?? ""));
  const feed = useIncrementalRunLogs(executionId ?? "", steps.data?.logs, live);
  const logs = feed.logs;
  const error = steps.error ?? feed.error;

  return (
    <div>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {!executionId ? (
        <div className="run-log overflow-hidden rounded-[var(--radius)] border border-border bg-[var(--bg-deep)]">
          <div className="border-b border-border px-2.5 py-1.5 text-[0.7812rem] font-semibold tracking-[0.5px] text-[var(--text-faint)] uppercase">
            Activity
          </div>
          <div className="activity-log-body min-h-70 max-h-120 overflow-auto px-2.5 py-2 font-mono text-[0.8125rem] leading-[1.45]">
            <div className="px-1 py-3 text-[var(--text-faint)]">
              Run this task to stream each step here — clone, Claude tool calls, and comments.
            </div>
          </div>
        </div>
      ) : (
        <RunTimeline
          key={executionId}
          lines={logs}
          live={live}
          hasOlder={feed.hasOlder}
          loadingOlder={feed.loadingOlder}
          onLoadOlder={() => void feed.loadOlder()}
        />
      )}
    </div>
  );
}
