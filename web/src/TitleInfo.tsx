import { Info } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip.tsx";
import { Button } from "./components/ui/button.tsx";

/**
 * The explanatory blurb a page used to print under its title, folded into an
 * icon beside it. Same words, none of the standing noise — the page opens on
 * its content and the description is one hover (or one tab stop) away.
 *
 * Render it inside the `<h1>` so it rides the title rather than needing its own
 * row; the heading's own `gap` spaces it.
 */
export function TitleInfo({
  side = "bottom",
  children,
}: {
  side?: "top" | "right" | "bottom" | "left";
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-auto shrink-0 cursor-help rounded-full border-0 bg-transparent p-0 text-[0.7em] text-[var(--text-faint)] transition-colors hover:bg-transparent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] [&_svg]:size-[1em]"
          aria-label="About this page"
        >
          <Info size={15} strokeWidth={2} aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      {/* Wider and looser than a label tooltip: this holds a sentence or two,
          not two words. */}
      <TooltipContent side={side} className="max-w-sm text-left leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
