import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";

import { api, type SystemView, type TaskSummary } from "./api.ts";
import { invalidate, queries } from "./queries.ts";
import { useApi, type AsyncState } from "./useApi.ts";

interface JobQueueValue {
  system: AsyncState<SystemView>;
  tasks: AsyncState<{ tasks: TaskSummary[]; total: number }>;
  hasMoreTasks: boolean;
  loadMoreTasks: () => void;
  /** Re-fetches both `system` and `tasks` — call after any action that changes job/task state. */
  refresh: () => void;
}

const JobQueueContext = createContext<JobQueueValue | undefined>(undefined);

/**
 * Single fetch point for `/api/system`'s `runningJobs` and `/api/tasks`'
 * per-task `activeJobs`, so every indicator (footer badge, task rows, task
 * detail) reads the same numbers instead of each polling its own copy that
 * can drift out of sync mid-refresh.
 *
 * That sharing is now the cache's job rather than this provider's — anything
 * reading `queries.system()` or `queries.tasks()` directly joins the same
 * entry. What is still worth a context is the *pair*: the footer wants both
 * numbers, and `refresh` names the invalidation both need after an action.
 */
export function JobQueueProvider({
  children,
  tasksEnabled = true,
}: {
  children: ReactNode;
  tasksEnabled?: boolean;
}) {
  const queryClient = useQueryClient();

  // While anything is running — including a loop the scheduler fired on its
  // own, with nobody watching for it — `queries.tasks()` re-fetches every few
  // seconds so status pills flip from running to success/failure without a
  // page reload. The interval lives with the query because the data itself is
  // what decides whether to keep going.
  const system = useApi(queries.system());
  const taskPages = useInfiniteQuery({
    queryKey: ["tasks", "list", { query: "" }] as const,
    queryFn: ({ pageParam, signal }) => api.tasks("", { limit: 50, offset: pageParam }, { signal }),
    initialPageParam: 0,
    enabled: tasksEnabled,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((total, page) => total + page.tasks.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    staleTime: 5_000,
    refetchInterval: (query) => {
      const pages = query.state.data?.pages ?? [];
      return pages.some((page) => page.tasks.some((task) => task.lastRun?.status === "running"))
        ? 3_000
        : false;
    },
  });
  const flattened = taskPages.data?.pages.flatMap((page) => page.tasks);
  const tasks: AsyncState<{ tasks: TaskSummary[]; total: number }> = {
    ...(flattened ? {
      data: {
        tasks: flattened,
        total: taskPages.data?.pages[0]?.total ?? flattened.length,
      },
    } : {}),
    ...(taskPages.error ? { error: taskPages.error.message } : {}),
    loading: tasksEnabled && taskPages.data === undefined && !taskPages.error,
    fetching: taskPages.isFetching,
  };

  // The same group the Datadog, LogRocket and graph pages use after queueing a
  // job — see `invalidate.jobQueue`. Kept exposed here because the *pair* is what
  // a consumer wants: `refresh` names the invalidation both numbers need.
  const refresh = () => invalidate.jobQueue(queryClient);

  return (
    <JobQueueContext.Provider value={{
      system,
      tasks,
      hasMoreTasks: taskPages.hasNextPage,
      loadMoreTasks: () => void taskPages.fetchNextPage(),
      refresh,
    }}>
      {children}
    </JobQueueContext.Provider>
  );
}

export function useJobQueue(): JobQueueValue {
  const value = useContext(JobQueueContext);
  if (!value) throw new Error("useJobQueue must be used within a JobQueueProvider");
  return value;
}
