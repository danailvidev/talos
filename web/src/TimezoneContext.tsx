import { createContext, useContext, type ReactNode } from "react";

import { queries } from "./queries.ts";
import { effectiveTimeZone } from "./zoned-time.ts";
import { useApi } from "./useApi.ts";

const TimezoneContext = createContext<string | undefined>(undefined);

/**
 * Fetches the instance-wide default timezone once and exposes it to every
 * descendant. Falls back to the browser's zone until the settings load (and
 * whenever no default is configured), so display never blocks on the fetch.
 *
 * Shares `queries.settings()` with `SettingsPage`, so the two of them are one
 * request rather than two — and a save on that page updates this immediately.
 */
export function TimezoneProvider({ children }: { children: ReactNode }) {
  const settings = useApi(queries.settings());
  const timezone = effectiveTimeZone(settings.data?.timezone ?? undefined);
  return <TimezoneContext.Provider value={timezone}>{children}</TimezoneContext.Provider>;
}

export function useTimezone(): string {
  const timezone = useContext(TimezoneContext);
  return timezone ?? effectiveTimeZone(undefined);
}
