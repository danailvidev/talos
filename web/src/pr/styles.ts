import type { PullRequestState } from "../api.ts";

/**
 * `leading-none` and an explicit height rather than padding alone: this badge sits
 * inside the `h1`, so without them its line box inherits the title's leading and
 * the pill grows to the height of a heading line — a slim label turning into the
 * tallest thing in the header.
 */
export const PR_STATE_CLASS =
  "inline-flex h-[1.125rem] shrink-0 items-center rounded-full px-2 text-[0.7188rem] leading-none font-semibold tracking-[0.02em]";

export const PR_STATE_TONE: Record<PullRequestState, string> = {
  open: "bg-[color-mix(in_srgb,var(--success)_18%,var(--bg-deep))] text-[var(--success)]",
  draft: "bg-[var(--bg-muted)] text-[var(--text-dim)]",
  merged: "bg-[var(--status-success-wash)] text-success",
  closed: "bg-[color-mix(in_srgb,var(--status-danger)_18%,var(--bg-deep))] text-[var(--status-danger)]",
};

export const PR_STATE_ICON_TONE: Record<PullRequestState, string> = {
  open: "text-[var(--success)]",
  draft: "text-[var(--text-dim)]",
  merged: "text-success",
  closed: "text-[var(--status-danger)]",
};

export const PR_FILTER_POPOVER_CLASS =
  "min-w-43 rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] p-1.5 shadow-[var(--shadow-panel)]";
export const PR_FILTER_TITLE_CLASS =
  "px-2 pt-1 pb-1.5 text-[0.7812rem] font-semibold tracking-[0.06em] text-[var(--text-faint)] uppercase";
export const PR_FILTER_ROW_CLASS =
  "flex w-full cursor-pointer items-center justify-start gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left font-[inherit] text-[0.9375rem] text-muted-foreground enabled:hover:bg-[var(--bg-hover)] enabled:hover:text-foreground disabled:cursor-default";
export const PR_FILTER_CHECK_CLASS =
  "inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm border border-[var(--border-strong)] text-[var(--bg-deep)]";
export const PR_FILTER_NOTE_CLASS =
  "mt-1 border-t border-border px-2 pt-1.5 pb-0.5 text-[0.7812rem] leading-[1.4] text-[var(--text-faint)]";
export const PR_FILTER_RESET_CLASS =
  "mt-1 block w-full cursor-pointer border-0 border-t border-border bg-transparent px-2 py-1.5 text-left font-[inherit] text-sm text-[var(--text-faint)] hover:text-foreground";
