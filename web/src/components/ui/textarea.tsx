import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The app's multi-line input. Deliberately not the stock shadcn `Textarea`, for
 * the same reason `Input` isn't: it matches `Input` and `SelectTrigger`, so a
 * textarea under a text field agrees with it on border, radius, background and
 * focus treatment.
 *
 * The stock one was `bg-transparent dark:bg-input/30`, which on this palette is
 * the border colour at 30% rather than the app's field background — so every
 * caller was passing `bg-background` and a matching radius back in, or was quietly
 * a shade lighter than the input above it.
 *
 * `field-sizing-content` and the caller's `rows` fight over the height. Pass
 * `min-h-*` (or a class of your own) when the box should start taller.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "w-full rounded-md border border-border bg-background px-2 py-1 text-base text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
