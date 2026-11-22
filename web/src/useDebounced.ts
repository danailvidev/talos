import { useEffect, useState } from "react";

/**
 * Keeps a keystroke from becoming a request.
 *
 * With the query cache in front of it this does something slightly different
 * from what it used to: the debounced value is what goes into the cache *key*,
 * so it decides which requests are ever made rather than merely how often one
 * fires. Typing back over a term already typed then answers from cache with no
 * request at all — which no amount of debouncing achieves on its own.
 */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);

  return settled;
}
