import { type ReactNode } from "react";

import { cn } from "../../lib/utils.ts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./dialog.tsx";

/**
 * The app's compatibility shell over the generated shadcn dialog.
 *
 * Keeping this adapter means feature dialogs retain their existing API while
 * Radix now owns focus trapping/restoration, labelling, escape and outside-click
 * handling, scroll locking, portalling and the generated dialog motion.
 */
export function Modal({
  onClose,
  title,
  titleActions,
  className,
  children,
}: {
  onClose: () => void;
  /** The dialog's name. A node, not a string — several carry a leading icon. */
  title: ReactNode;
  /** Controls that belong on the title's row rather than in the body. */
  titleActions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className={cn(
          "top-[8vh] flex max-h-[calc(92vh-16px)] w-full max-w-130 translate-y-0 flex-col gap-2 overflow-y-auto rounded-[var(--radius-panel)] border border-border bg-[var(--bg-raised)] p-6 text-inherit shadow-[var(--shadow-panel)]",
          className,
        )}
        showCloseButton={false}
        aria-describedby={undefined}
      >
        <DialogHeader className="flex flex-row items-center justify-between gap-3">
          <DialogTitle className="m-0 flex flex-wrap items-center gap-2 font-display text-[length:var(--type-h2-size)] leading-[var(--type-h2-leading)] font-semibold tracking-[0.025em] text-foreground">
            {title}
          </DialogTitle>
          {titleActions}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
