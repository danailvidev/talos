import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * An on/off toggle, for a setting that reads as a state rather than a selection.
 *
 * The difference against `Checkbox` is what the control is *about*. A checkbox
 * picks members of a set — the repo filter, a list of specs to dismiss — and a row
 * of them is one answer. A switch is one independent thing being on or off, which
 * is what each notification kind is, and it says so at a glance across a long list
 * without the reader having to count ticks.
 *
 * Bronze when on, so it agrees with every other selected control in the app; the knob
 * slides on `translate-x` so the movement is the affordance.
 */
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-transparent bg-[var(--bg-hover)] outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_55%,transparent)]",
        "data-[state=checked]:bg-action",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-3.5 rounded-full bg-[var(--bg-raised)] shadow-sm ring-1 ring-black/10 transition-transform",
          "translate-x-[2px] data-[state=checked]:translate-x-[16px]"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
