import type { PointerEvent } from "react";
import { GripHorizontal, GripVertical } from "lucide-react";

import { cn } from "./lib/utils.ts";

/**
 * The divider between resizable panes. At rest it is only the hairline border.
 * Hover and drag reveal a thicker action-colored line and a grip icon.
 */
export function SplitHandle({
  orientation = "vertical",
  label,
  value,
  className,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  orientation?: "vertical" | "horizontal";
  label: string;
  value?: number;
  className?: string;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  const vertical = orientation === "vertical";
  const Icon = vertical ? GripVertical : GripHorizontal;

  return (
    <div
      className={cn(
        "relative z-20",
        vertical ? "h-full w-0 min-w-0" : "h-0 w-full min-h-0 shrink-0",
        className,
      )}
    >
      <div
        role="separator"
        aria-orientation={orientation}
        aria-label={label}
        aria-valuenow={value}
        className={cn(
          "group absolute z-20 flex touch-none items-center justify-center",
          vertical
            ? "inset-y-0 left-1/2 w-3 -translate-x-1/2 cursor-col-resize"
            : "inset-x-0 top-1/2 h-3 -translate-y-1/2 cursor-row-resize",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute bg-border group-hover:bg-action group-active:bg-action",
            vertical
              ? "inset-y-0 left-1/2 w-px -translate-x-1/2 group-hover:w-0.5 group-active:w-0.5"
              : "inset-x-0 top-1/2 h-px -translate-y-1/2 group-hover:h-0.5 group-active:h-0.5",
          )}
        />
        <Icon
          size={14}
          strokeWidth={2}
          aria-hidden
          className="relative z-10 text-action opacity-0 group-hover:opacity-100 group-active:opacity-100"
        />
      </div>
    </div>
  );
}
