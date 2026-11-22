import type { ReactNode } from "react";

import type { AsyncState } from "../../useApi.ts";
import { ERROR_BOX_CLASS, LOADING_STATE_CLASS } from "../../state-styles.ts";

/**
 * The three states every read in the console has to render, in one place.
 *
 * Sixty-odd call sites were hand-writing loading and error boxes themselves,
 * which is why none of them announced
 * anything to a screen reader: the markup now carries `role="status"` and
 * `role="alert"` once, rather than at sixty sites that would each have to
 * remember.
 *
 * `Loading` and `ErrorBox` are exported for the pages whose hooks have to run
 * before the check — a `useMemo` over `query.data` cannot move inside a render
 * prop — so those keep their early returns but share this markup.
 */
export function Loading({ children = "Loading…" }: { children?: ReactNode }) {
  return (
    <div className={LOADING_STATE_CLASS} role="status">
      {children}
    </div>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className={ERROR_BOX_CLASS} role="alert">
      {children}
    </div>
  );
}

/**
 * Renders `children` with the loaded data, or the loading/failed state instead.
 *
 * The render prop is what earns this over a plain wrapper: it hands back a
 * non-optional `T`, so the `if (!query.data) return null` line that every one of
 * these call sites needed purely to satisfy the type checker goes away.
 *
 * A failure wins over stale data on purpose. A read that has started failing is
 * worth interrupting the page for — silently showing values from before the
 * error is how a stale page passes for a live one.
 */
export function QueryState<T>({
  query,
  loading,
  children,
}: {
  query: AsyncState<T>;
  /** What is being loaded, in the user's terms — "Loading prompts…". */
  loading?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.error) return <ErrorBox>{query.error}</ErrorBox>;
  // Not `query.loading`: a disabled query never loads and never has data, and
  // this should render the same nothing for it as the call sites used to.
  if (query.data === undefined) return loading ? <Loading>{loading}</Loading> : null;
  return <>{children(query.data)}</>;
}
