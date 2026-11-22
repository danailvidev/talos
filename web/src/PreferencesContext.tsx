import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";

import { api, type PreferencesView } from "./api.ts";
import { keys } from "./query-keys.ts";
import { queries } from "./queries.ts";
import { useApi } from "./useApi.ts";

/**
 * How this developer has set the console up, stored server-side and cached in the
 * browser.
 *
 * Both, and the order matters. The server row is what makes the console the same on
 * your laptop and your desktop; the localStorage copy is what makes the first paint
 * right rather than showing defaults for one frame and then rearranging. So a read
 * answers from localStorage immediately, the fetch overwrites it when it lands, and
 * a write updates all three — state, cache, server — at once.
 *
 * A failed write is deliberately quiet. The preference still applies for this
 * session and is still in localStorage; all that was lost is the sync to your other
 * machine, and a toast complaining that a filter did not save is worse than the
 * problem it reports.
 */

interface PreferencesApi {
  /** Raw values by key, the local cache until the fetch lands. */
  values: Record<string, unknown>;
  /** False until the server's copy has arrived — see `usePreference`. */
  loaded: boolean;
  set(key: string, value: unknown): void;
  clear(key: string): void;
}

const PreferencesContext = createContext<PreferencesApi | undefined>(undefined);

/**
 * Mirrors the whole set under one key: it is written and read as a unit.
 *
 * Exported because `theme.ts` reads it before React mounts — the theme is a
 * preference like any other, but applying it one frame late is a visible flash.
 */
export const PREFERENCES_CACHE_KEY = "talos-preferences";
const CACHE_KEY = PREFERENCES_CACHE_KEY;

function readCache(): Record<string, unknown> {
  try {
    const stored = localStorage.getItem(CACHE_KEY);
    const parsed = stored ? (JSON.parse(stored) as unknown) : undefined;
    // Objects only: an array or a string here means something else wrote the key.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeCache(values: Record<string, unknown>): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(values));
  } catch {
    // Private browsing or a full quota. The preferences still work; the next boot
    // waits for the fetch instead of painting from cache.
  }
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const stored = useApi(queries.preferences());

  // The server's copy once it lands, the browser's until then. `stored.data` also
  // *becomes* the local cache below, so this is a fallback for the first paint
  // rather than a merge — a key deleted on another machine must not be resurrected
  // by a stale local copy.
  const values = useMemo(
    () => stored.data?.values ?? readCache(),
    [stored.data],
  );

  // Written on the way past rather than in an effect: the mirror exists to be read
  // before React runs anything on the next boot, and an effect is one render later
  // than the value it is copying.
  if (stored.data) writeCache(stored.data.values);

  const write = useCallback(
    (key: string, value: unknown) => {
      // Optimistic, and not undone on failure: a preference that reverts under your
      // cursor because a PUT lost a race is worse than one that is briefly out of
      // step with a machine you are not looking at.
      const next: PreferencesView = {
        values: (() => {
          const current = {
            ...(queryClient.getQueryData<PreferencesView>(keys.me.preferences())?.values ??
              values),
          };
          if (value === null || value === undefined) delete current[key];
          else current[key] = value;
          return current;
        })(),
      };
      queryClient.setQueryData(keys.me.preferences(), next);
      writeCache(next.values);
      // `void`: the local state is already right, and the only thing the response
      // could tell us is what we just sent.
      void api.setPreference(key, value ?? null).catch(() => {
        // Deliberately silent — see this module's header.
      });
    },
    [queryClient, values],
  );

  const value = useMemo<PreferencesApi>(
    () => ({
      values,
      loaded: stored.data != null,
      set: write,
      clear: (key: string) => write(key, null),
    }),
    [values, stored.data, write],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

/**
 * One preference, parsed by the page that owns it.
 *
 * `parse` rather than a plain default, because a stored value outlives the code that
 * wrote it: a filter shape that gained a field, a sprint id from a release ago, a row
 * somebody hand-edited. The owning page is the only thing that can say what is still
 * valid, so it says it here and gets its default back when the answer is "not this".
 *
 * Returns `loaded` so a caller that must not act on a default can wait — most should
 * not bother, since painting the default and then the stored value is exactly what
 * the localStorage mirror is there to prevent.
 */
export function usePreference<T>(
  key: string,
  parse: (raw: unknown) => T,
): [T, (next: T) => void, { loaded: boolean }] {
  const context = useContext(PreferencesContext);
  const raw = context?.values[key];
  // Parsed on every render rather than memoised: `parse` is a page-local function
  // that would be a new reference each render anyway, so a memo here would only
  // ever be a cache with a 100% miss rate.
  const value = parse(raw);

  const set = useCallback(
    (next: T) => context?.set(key, next),
    [context, key],
  );

  return [value, set, { loaded: context?.loaded ?? false }];
}
