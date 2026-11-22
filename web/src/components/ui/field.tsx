import * as React from "react";

import { cn } from "@/lib/utils";

const FIELD_CLASS = "flex flex-col gap-1 text-sm text-muted-foreground";

/**
 * One labelled form control: caption above, control below, optional hint under it.
 *
 * There were three spellings of this in the app and the same utility string typed out
 * twenty-five times — for a wrapper that is four declarations long and identical
 * in all three. They now share one Tailwind contract emitted by this component.
 *
 * A `<label>`, so clicking the caption focuses the control. That is also the one
 * constraint on it: a field whose control is a group of radios wants a
 * `<fieldset>`/`<legend>` instead, and a wrapper that also animates wants
 * `motion.label` — both use the same exported class by hand rather than coming
 * through here.
 *
 * Variants ride along as `className`, not as props: `<Field className="grow">`
 * for the flex sizing the create panel needs.
 */
function Field({
  label,
  hint,
  className,
  children,
  ...props
}: React.ComponentProps<"label"> & {
  /** The caption. Omit it when the caption is markup and belongs in `children`. */
  label?: React.ReactNode;
  /** Said under the control — a format, a limit, a consequence. */
  hint?: React.ReactNode;
}) {
  return (
    <label data-slot="field" className={cn(FIELD_CLASS, className)} {...props}>
      {label === undefined ? null : <span>{label}</span>}
      {children}
      {hint === undefined ? null : <small>{hint}</small>}
    </label>
  );
}

/**
 * The row of buttons that ends a form or a dialog — primary first, then the way
 * out.
 *
 * Thirteen copies of the same three utilities, which is eleven more than it takes
 * for one of them to drift. Sized to what those copies already were, so nothing
 * moves: 8px above, 8px between.
 *
 * Layout-specific sizing rides on `className` at the form that owns it.
 */
function FormActions({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mt-2 flex gap-2", className)} {...props} />;
}

export { FIELD_CLASS, Field, FormActions };
