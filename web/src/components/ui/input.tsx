import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The app's text input. Deliberately not the stock shadcn `Input` — it matches
 * `SelectTrigger` instead, so a text field and a picker sitting in the same row
 * agree on border, radius, background and focus treatment.
 *
 * This exists because the same twelve-class string had been retyped in thirteen
 * files and was already drifting (two text sizes, seven hardcoded widths). Width
 * is still the caller's business: pass `className="w-96"` and `cn` merges it.
 * The focus border is new — the hand-rolled inputs had none, unlike every select
 * beside them.
 */
function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn(
        "rounded-md border border-border bg-background px-2 py-1 text-base text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
