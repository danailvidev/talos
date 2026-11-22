import { useCallback, useRef, useState } from "react";

import { toMessage } from "./errors.ts";

/**
 * The in-flight/failed/succeeded state of one write.
 *
 * Seventeen components were keeping this by hand — a `saving` boolean, an `error`
 * string, sometimes a `saved` flag — around a `try/catch/finally` that was the
 * same eleven lines every time. The copies had already drifted: some cleared the
 * success flag when a second attempt started and some left a stale "Saved."
 * sitting under a form that had just failed.
 *
 * Deliberately not `useMutation`, for the reason `queries.ts` gives on
 * `invalidate`: the writes here are imperative `await api.x()` calls inside event
 * handlers, and this keeps them that way. It factors out the bookkeeping, not the
 * call.
 *
 * ```tsx
 * const save = useAction();
 * // ...
 * <Button disabled={save.busy} onClick={() => save.run(async () => {
 *   if (!name.trim()) throw new Error("Name it something.");
 *   onSaved(await api.setThing({ name }));
 * })}>
 *   {save.busy ? "Saving…" : "Save"}
 * </Button>
 * {save.error ? <ErrorBox>{save.error}</ErrorBox> : null}
 * {save.done ? <div className="hint">Saved.</div> : null}
 * ```
 *
 * Validation belongs inside `work`, thrown: a bad field and a rejected request
 * are the same thing to the person reading the form, and routing both through
 * one path is what stops "the button is stuck on Saving…" from being possible.
 */
export interface Action {
  /** The write is in flight. Disable the control that started it. */
  busy: boolean;
  /** Why the last attempt failed, or `undefined` if it didn't. */
  error: string | undefined;
  /** The last attempt succeeded. Cleared the moment another one starts. */
  done: boolean;
  /** Runs `work`, recording the outcome. Resolves `true` if it succeeded. */
  run: (work: () => Promise<void>) => Promise<boolean>;
  /** Reports a failure this hook didn't run — a check made before the click. */
  fail: (message: string) => void;
  /** Back to untouched: no error, no success. */
  clear: () => void;
}

export function useAction(options?: {
  /**
   * Told about a failure as well as the returned `error`, for the components
   * whose write is a row action rather than a form: there is nowhere on a row to
   * put an error line, so those raise a toast instead.
   */
  onError?: (message: string) => void;
}): Action {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  // Through a ref so `run` keeps a stable identity — callers pass an inline
  // closure, and a `run` that changed every render would defeat every
  // `useCallback`/`useEffect` downstream of it.
  const onError = useRef(options?.onError);
  onError.current = options?.onError;

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setDone(false);
    try {
      await work();
      setDone(true);
      return true;
    } catch (cause) {
      const message = toMessage(cause);
      setError(message);
      onError.current?.(message);
      return false;
    } finally {
      // Runs even when `work` unmounted this component by closing its dialog.
      // React tolerates the set on an unmounted component (it's a no-op, not the
      // old warning), and the alternative — a mounted ref — buys nothing here.
      setBusy(false);
    }
  }, []);

  const fail = useCallback((message: string) => {
    setError(message);
    setDone(false);
    onError.current?.(message);
  }, []);

  const clear = useCallback(() => {
    setError(undefined);
    setDone(false);
  }, []);

  return { busy, error, done, run, fail, clear };
}
