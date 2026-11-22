import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip.tsx";

/**
 * Drop-in replacement for a native `title=` tooltip. Renders `children`
 * unwrapped when there is nothing to show, so callers can pass an optional
 * label straight through without an extra conditional at the call site.
 */
export function Tip({
  label,
  side,
  children,
}: {
  label?: string;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactNode;
}) {
  if (!label) return <>{children}</>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
