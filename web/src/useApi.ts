import { useQuery, type QueryKey, type UseQueryOptions } from "@tanstack/react-query";

export interface AsyncState<T> {
  data?: T;
  error?: string;
  /** No data to show yet — the state a caller shows an empty/skeleton state for. */
  loading: boolean;
  /**
   * A request is in flight right now, including a background refetch that
   * `loading` hides to avoid flicker. What a spinner on a refresh button
   * should watch — it means "something is happening" even when the page
   * itself has nothing new to show for it yet.
   */
  fetching: boolean;
}

export interface AsyncQuery<T> extends AsyncState<T> {
  /**
   * Re-reads from the server whatever the entry's staleness says. This is what a
   * refresh button calls, and the reason it exists as its own thing: on a
   * forge-backed read the cache is deliberately long-lived, so "go and look
   * again" has to be able to say so explicitly.
   */
  refetch: () => void;
}

/**
 * Every read in the console goes through here: `useQuery` in the shape this
 * console's skeletons and refresh spinners speak.
 *
 * The `loading` / `fetching` split above is a real UI contract — `loading` means
 * "show a skeleton", `fetching` means "spin the refresh button" — and it is worth
 * one adapter to state the mapping once here rather than re-deriving it from
 * React Query's five overlapping booleans at every call site.
 *
 * Options come from `queries.ts` rather than being written at the call site, so
 * that a read's cache key, its staleness and its polling policy are one
 * reviewable decision per endpoint instead of twenty-six scattered ones.
 *
 * Take `useQuery` directly instead wherever a call site needs something this
 * shape cannot carry: `initialData`, a `select`, or the query object itself.
 *
 * Generic in the key as well as the data, because `queryOptions()` narrows its
 * `queryKey` to a tuple of literals and a `readonly unknown[]` parameter would
 * reject every entry in `queries.ts`.
 */
export function useApi<T, TKey extends QueryKey>(
  options: UseQueryOptions<T, Error, T, TKey>,
): AsyncQuery<T> {
  const query = useQuery(options);

  return {
    ...(query.data !== undefined ? { data: query.data } : {}),
    ...(query.error ? { error: query.error.message } : {}),
    // Not `isPending`: with `enabled: false` that stays true forever, which
    // would wedge the search popover and the pickers on a permanent skeleton.
    // "Nothing to show yet" is literally no data and no error, which is what
    // this hook has always meant by it.
    loading: query.data === undefined && !query.error,
    fetching: query.isFetching,
    refetch: () => void query.refetch(),
  };
}
