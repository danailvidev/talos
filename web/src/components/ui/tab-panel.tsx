import type { ReactNode } from "react";

/**
 * Wrap a tab's content so switching tabs replays the app's standard
 * fade/slide-in (`.tab-panel` in index.css) instead of swapping instantly.
 * `activeKey` must change when the active tab changes — that's what remounts
 * the div and restarts the animation.
 */
export function TabPanel({ activeKey, children }: { activeKey: string; children: ReactNode }) {
  return <div className="tab-panel" key={activeKey}>{children}</div>;
}
