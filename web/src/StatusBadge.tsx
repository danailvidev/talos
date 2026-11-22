import { AlertTriangle, Ban, CircleCheck, CircleX, MinusCircle, PlayCircle } from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "./lib/utils.ts";

/**
 * Status is never color-only (design.md): every pill pairs an icon with its
 * label, so colour blindness or a missed tint doesn't drop information.
 */
const ICONS: Record<string, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  success: CircleCheck,
  enabled: CircleCheck,
  failure: CircleX,
  running: PlayCircle,
  cancelled: Ban,
  warn: AlertTriangle,
  disabled: MinusCircle,
};

const TONE: Record<string, string> = {
  success:
    "border-[color-mix(in_srgb,var(--status-success)_40%,transparent)] bg-[var(--status-success-wash)] text-success",
  failure:
    "border-[color-mix(in_srgb,var(--status-danger)_45%,transparent)] bg-[var(--status-danger-wash)] text-[var(--status-danger-strong)]",
  running:
    "border-[color-mix(in_srgb,var(--live)_45%,transparent)] bg-[var(--live-wash)] text-[var(--live)] animate-[status-pulse_1.6s_ease-in-out_infinite]",
  cancelled:
    "border-[color-mix(in_srgb,var(--text-muted)_40%,transparent)] bg-[var(--bg-raised)] text-muted-foreground",
  enabled: "border-[color-mix(in_srgb,var(--status-success)_35%,transparent)] text-success",
  disabled: "border-[var(--border-strong)] text-[var(--text-faint)]",
  warn: "border-[color-mix(in_srgb,var(--status-warning)_45%,transparent)] bg-[var(--status-warning-wash)] text-[var(--status-warning-strong)]",
};

export function StatusBadge({
  status,
  children,
  showIcon = true,
}: {
  status: string;
  children: React.ReactNode;
  showIcon?: boolean;
}) {
  const Icon = ICONS[status];
  return (
    <span
      className={cn(
        `badge ${status}`,
        "inline-flex items-center gap-1 rounded-[var(--radius-compact)] border border-transparent px-1.5 py-px text-[length:var(--type-label-size)] leading-[var(--type-label-leading)] font-semibold tracking-[0.08em] uppercase [&_svg]:shrink-0",
        TONE[status],
      )}
    >
      {showIcon && Icon ? <Icon size={10} strokeWidth={2.5} /> : null}
      {children}
    </span>
  );
}
