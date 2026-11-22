import { useCallback, useEffect, useState } from "react";
import {
  pathFor,
  routeFromLocation,
  type RouteState,
} from "./route-state.ts";

export type {
  AdminTab,
  AutomationTab,
  OwnerTab,
  Page,
  ReleasesTab,
  RouteState,
  SettingsTab,
} from "./route-state.ts";

/**
 * History-based routing (not hash-based): `serve.ts` already answers every
 * unknown path with the SPA's index.html specifically so a client-side route
 * survives a refresh or a bookmark — see the comment there.
 */
export function useRoute(): [
  RouteState,
  (next: RouteState, opts?: { replace?: boolean }) => void,
] {
  const [route, setRoute] = useState<RouteState>(() => routeFromLocation(window.location));

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation(window.location));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: RouteState, opts?: { replace?: boolean }) => {
    const path = pathFor(next);
    const current = window.location.pathname + window.location.search;
    if (current !== path) {
      if (opts?.replace) {
        window.history.replaceState(null, "", path);
      } else {
        window.history.pushState(null, "", path);
      }
    }
    setRoute(next);
  }, []);

  return [route, navigate];
}
