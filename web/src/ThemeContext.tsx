import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { usePreference } from "./PreferencesContext.tsx";
import {
  APPEARANCE_PREFERENCE,
  applyTheme,
  getAppliedAppearance,
  parseAppearance,
  subscribeToAppliedAppearance,
  type Appearance,
  type ResolvedAppearance,
} from "./theme.ts";

interface ThemeApi {
  /** The user's choice, including "system". */
  appearance: Appearance;
  /** The appearance currently painted on the page. */
  resolved: ResolvedAppearance;
  setAppearance(next: Appearance): void;
}

const ThemeContext = createContext<ThemeApi | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = usePreference(
    APPEARANCE_PREFERENCE,
    parseAppearance,
  );
  const resolved = useSyncExternalStore(
    subscribeToAppliedAppearance,
    getAppliedAppearance,
    () => "dark" as const,
  );

  // The bootstrap has already themed the first frame. This keeps later preference
  // changes and the server copy in sync before the browser paints another frame.
  useLayoutEffect(() => {
    applyTheme(appearance);
  }, [appearance]);

  const value = useMemo<ThemeApi>(
    () => ({
      appearance,
      resolved,
      setAppearance,
    }),
    [appearance, resolved, setAppearance],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeApi {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}
