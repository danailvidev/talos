import { PREFERENCES_CACHE_KEY } from "./PreferencesContext.tsx";

/**
 * Theme state is deliberately independent of React so it can be applied before
 * the application mounts. CSS receives only the resolved appearance; components
 * consume semantic tokens and never need to understand the "system" choice.
 */
export const APPEARANCES = ["system", "light", "dark"] as const;
export type Appearance = (typeof APPEARANCES)[number];
export type ResolvedAppearance = Exclude<Appearance, "system">;

export const APPEARANCE_LABELS: Record<Appearance, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

export const DEFAULT_APPEARANCE: Appearance = "dark";
export const APPEARANCE_PREFERENCE = "theme.appearance";

const appliedListeners = new Set<() => void>();
let systemMedia: MediaQueryList | undefined;

function onSystemAppearanceChange(): void {
  applyTheme("system");
}

function trackSystemAppearance(enabled: boolean): void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  if (enabled && !systemMedia) {
    systemMedia = window.matchMedia("(prefers-color-scheme: light)");
    systemMedia.addEventListener("change", onSystemAppearanceChange);
  } else if (!enabled && systemMedia) {
    systemMedia.removeEventListener("change", onSystemAppearanceChange);
    systemMedia = undefined;
  }
}

export function getAppliedAppearance(): ResolvedAppearance {
  if (
    typeof document !== "undefined" &&
    document.documentElement.dataset.appearance === "light"
  ) {
    return "light";
  }
  return "dark";
}

export function subscribeToAppliedAppearance(listener: () => void): () => void {
  appliedListeners.add(listener);
  return () => appliedListeners.delete(listener);
}

export function parseAppearance(raw: unknown): Appearance {
  return APPEARANCES.find((appearance) => appearance === raw) ?? DEFAULT_APPEARANCE;
}

export function prefersLight(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  );
}

export function resolveAppearance(
  appearance: Appearance,
  systemPrefersLight = prefersLight(),
): ResolvedAppearance {
  if (appearance === "system") return systemPrefersLight ? "light" : "dark";
  return appearance;
}

export function applyTheme(appearance: Appearance): ResolvedAppearance {
  const resolved = resolveAppearance(appearance);
  const root = document.documentElement;
  const previous = getAppliedAppearance();
  trackSystemAppearance(appearance === "system");
  root.dataset.appearance = resolved;

  // Keep mobile browser chrome in step with the resolved page surface. Reading
  // the semantic token avoids duplicating brand colors in TypeScript.
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const background = getComputedStyle(root).getPropertyValue("--bg").trim();
  if (themeColor && background) themeColor.content = background;
  if (previous !== resolved) {
    for (const listener of appliedListeners) listener();
  }
  return resolved;
}

export function appearanceFromCache(stored: string | null): Appearance {
  try {
    const parsed = stored ? (JSON.parse(stored) as unknown) : undefined;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parseAppearance(
        (parsed as Record<string, unknown>)[APPEARANCE_PREFERENCE],
      );
    }
  } catch {
    // A malformed cache or unavailable storage should fall back to dark.
  }
  return DEFAULT_APPEARANCE;
}

/** Apply the browser's local preference mirror before React's first paint. */
export function bootstrapTheme(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(PREFERENCES_CACHE_KEY);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
  applyTheme(appearanceFromCache(stored));
}
