export const EMPTY_STATE_CLASS =
  "px-5 py-7 text-center text-[0.9375rem] text-[var(--text-faint)]";
export const LOADING_STATE_CLASS = EMPTY_STATE_CLASS;
export const ERROR_BOX_CLASS =
  "my-4 rounded-[var(--radius)] border border-[color-mix(in_srgb,var(--failure)_40%,transparent)] bg-[color-mix(in_srgb,var(--failure)_8%,transparent)] px-3.5 py-3 text-[0.9375rem] text-[var(--failure)]";
export const SUCCESS_BOX_CLASS =
  "my-4 rounded-[var(--radius)] border border-[color-mix(in_srgb,var(--success)_40%,transparent)] bg-[color-mix(in_srgb,var(--success)_8%,transparent)] px-3.5 py-3 text-[0.9375rem] text-[var(--success)]";
/** Not an error and not an outcome — something true that changes what you should do next. */
export const WARN_BOX_CLASS =
  "my-4 rounded-[var(--radius)] border border-[color-mix(in_srgb,var(--warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] px-3.5 py-3 text-[0.9375rem] leading-normal text-[var(--warn)]";
export const HINT_CLASS = "mt-1.5 text-sm text-[var(--text-faint)]";
export const INFO_BOX_CLASS =
  "my-4 flex items-start gap-2.5 rounded-[var(--radius)] border border-[color-mix(in_srgb,var(--status-success)_40%,transparent)] bg-[color-mix(in_srgb,var(--status-success)_8%,transparent)] px-3.5 py-3 text-[0.9375rem] leading-normal text-muted-foreground [&_code]:rounded-sm [&_code]:bg-[var(--bg-muted)] [&_code]:px-[5px] [&_code]:py-px [&_code]:text-sm [&_code]:text-foreground [&_strong]:font-semibold [&_strong]:text-foreground";
export const INFO_ICON_CLASS = "mt-0.5 shrink-0 text-success";
