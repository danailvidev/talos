import { QueryClient } from "@tanstack/react-query";

/**
 * The console's one cache.
 *
 * A module singleton rather than a client built inside a component, because
 * three of the places that need to reach it are not React: the 401 handler
 * registered from `App`, the logout handler, and login/register success. All
 * three have to clear the cache, and none of them can read a hook.
 *
 * Every default below is a deliberate override — see the comment on each. The
 * shape of the problem is that this console talks to a rate-limited forge
 * through a local server, and every page navigation unmounts the page it left
 * (`AnimatePresence mode="wait"`), so the same handful of expensive reads were
 * being re-issued on every click.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      /**
       * The navigation-churn number, not a freshness number. A route change
       * unmounts everything and selecting a different loop unmounts
       * `TaskDetail`, so this covers the realistic "click in, read, go back,
       * click the next one" loop: browsing costs one fetch per resource per
       * half-minute instead of one per click.
       *
       * Deliberately shorter than the server-side TTLs for the same resources,
       * so a client refetch that does slip through usually lands on the server
       * cache and costs nothing at the forge. Not `Infinity`: this tool exists
       * to say what a forge and a job queue are doing right now.
       */
      staleTime: 30_000,
      /**
       * The unit of retention is a browsing session on one page. Five minutes
       * (the library default) is short enough that a coffee break wipes it.
       * Not longer, because `pullRequestChanges` can be 300 file diffs — the
       * fat entries pull their own `gcTime` down in `queries.ts`.
       */
      gcTime: 10 * 60_000,
      /**
       * No retries, matching what the UI does today. A 401 or a 400 from
       * `ConfigError` is deterministic and will never succeed on a second try,
       * and the failure that actually happens here is "gitlab.com timed out on
       * the team listing" — where a retry doubles a fan-out that is already at
       * a rate limit. One visible failure beats a hidden retry storm.
       */
      retry: 0,
      /**
       * The most important override. The workflow is alt-tabbing between this
       * console and GitLab; with focus refetching on, every return to the tab
       * re-fires the pull request fan-out and the ticket graph's Jira search.
       * Freshness for live things comes from `refetchInterval` on the endpoints
       * that are cheap enough to poll, not from window focus.
       */
      refetchOnWindowFocus: false,
      /**
       * Left at the default `true`, which means "on mount, only if stale" —
       * that pairing with `staleTime` is the actual fix for the remount storm.
       * `"always"` would reproduce the old behaviour exactly.
       */
      refetchOnMount: true,
      /** Laptop wake is the one moment where everything genuinely is stale. */
      refetchOnReconnect: true,
      /** The hand-rolled intervals this replaces polled hidden tabs forever. */
      refetchIntervalInBackground: false,
    },
    mutations: { retry: 0 },
  },
});
