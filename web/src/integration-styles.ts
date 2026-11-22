export const INTEGRATION_CARD_CLASS =
  "flex flex-col gap-1.5 rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] px-3.5 py-3";
export const INTEGRATION_CARD_HEAD_CLASS =
  "flex h-auto w-full cursor-pointer items-center justify-between gap-3 border-0 bg-transparent p-0 text-left font-[inherit] text-inherit hover:bg-transparent";
export const INTEGRATION_CARD_TITLE_CLASS =
  "overflow-hidden text-ellipsis whitespace-nowrap font-display text-base font-semibold text-foreground";
export const INTEGRATION_CARD_DESCRIPTION_CLASS =
  "m-0 max-w-[60ch] overflow-hidden text-ellipsis whitespace-nowrap text-sm text-[var(--text-faint)]";
export const INTEGRATION_CARD_ACTIONS_CLASS =
  "mt-3.5 flex items-center justify-end gap-2 border-t border-border pt-3";

export const INTEGRATION_STATUS_CLASS =
  "whitespace-nowrap rounded-full border border-transparent px-2 py-0.5 text-xs font-semibold tracking-[0.04em] uppercase";
export const INTEGRATION_STATUS_TONE: Record<"ok" | "partial" | "unset", string> = {
  ok: "border-[color-mix(in_srgb,var(--success)_40%,transparent)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]",
  partial:
    "border-[color-mix(in_srgb,var(--warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] text-[var(--warn)]",
  unset: "border-border text-[var(--text-faint)]",
};
