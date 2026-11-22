export const ICON_BUTTON_CLASS =
  "relative inline-flex size-11 cursor-pointer items-center justify-center rounded-[var(--radius-control)] border border-transparent bg-transparent text-muted-foreground transition-[transform,background,color] duration-120 hover:-translate-y-px hover:bg-[var(--bg-raised)] hover:text-foreground focus-visible:border-[var(--focus)] focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_55%,transparent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0 disabled:hover:bg-transparent disabled:hover:text-muted-foreground min-[901px]:size-8.5";

export const ICON_BUTTON_DANGER_CLASS =
  "hover:bg-[var(--status-danger-wash)] hover:text-[var(--status-danger-strong)]";

export const AUTH_PAGE_CLASS =
  "grid min-h-dvh place-items-center bg-[radial-gradient(circle_at_16%_18%,color-mix(in_srgb,var(--action)_18%,transparent)_0%,transparent_34%),radial-gradient(circle_at_84%_82%,color-mix(in_srgb,var(--action-hover)_10%,transparent)_0%,transparent_30%),linear-gradient(135deg,var(--bg-deep)_0%,var(--bg-raised)_52%,var(--bg-deep)_100%)] p-4 pt-[max(1rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] min-[901px]:p-6";

export const AUTH_CARD_CLASS =
  "flex w-full max-w-95 flex-col gap-4.5 rounded-[var(--radius-panel)] border border-border bg-[var(--bg-raised)] p-8 [&_p]:mt-1 [&_p]:text-muted-foreground [&_.error-box]:m-0 [&_button[type=submit]]:w-full [&_.field_small]:text-[var(--text-faint)]";

export const AUTH_BRAND_CLASS =
  "inline-flex items-center";

export const BRAND_MARK_CLASS = "shrink-0";

/**
 * A row in one of the header's popovers — search hits and notifications.
 *
 * Shared because they are the same affordance in the same chrome: a full-width
 * two-line row that highlights on hover and on cmdk's own selection.
 */
export const SEARCH_ROW_CLASS =
  "flex w-full cursor-pointer flex-col items-stretch rounded-[calc(var(--radius)-2px)] border-0 bg-transparent px-2 py-[7px] text-left font-[inherit] text-[0.9375rem] text-foreground outline-none hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] data-[selected=true]:bg-[var(--bg-hover)] [&>svg:last-child]:hidden";

/** A labelled group of those rows, with a rule above every group but the first. */
export const SEARCH_GROUP_CLASS =
  "not-first:mt-1 not-first:border-t not-first:border-border not-first:pt-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[0.7812rem] [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-[var(--text-faint)] [&_[cmdk-group-heading]]:uppercase";
