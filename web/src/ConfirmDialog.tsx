import { type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog.tsx";
import { Button } from "./components/ui/button.tsx";
import { ErrorBox } from "./components/ui/query-state.tsx";
import { useAction } from "./useAction.ts";

/**
 * "Are you sure?" for the actions that cannot be undone.
 *
 * Owns the in-flight and failed states of `onConfirm` rather than leaving them to
 * the caller, because the interesting case is the one every hand-rolled confirm
 * gets wrong: the request fails, and the dialog has already closed, so the user
 * is left looking at a row that is still there with no idea why. Here the dialog
 * stays open and shows the error, and closes only once the action succeeded.
 *
 * Built on the generated shadcn alert dialog, while deliberately keeping the
 * confirm control a regular button: an AlertDialogAction would close before an
 * async failure could be reported.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Delete",
  onConfirm,
  onClose,
}: {
  title: string;
  /** What is about to happen, in the user's terms. Name the thing being acted on. */
  body: ReactNode;
  confirmLabel?: string;
  /** Resolves on success; the dialog stays open and reports a rejection. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const action = useAction();

  const confirm = () =>
    action.run(async () => {
      await onConfirm();
      onClose();
    });

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !action.busy) onClose();
      }}
    >
      <AlertDialogContent
        className="top-[8vh] flex max-h-[calc(92vh-16px)] w-full max-w-130 translate-y-0 flex-col gap-2 overflow-y-auto rounded-[var(--radius-panel)] border border-border bg-[var(--bg-raised)] p-6 text-inherit shadow-[var(--shadow-panel)]"
        overlayProps={{
          onClick: () => {
            if (!action.busy) onClose();
          },
        }}
      >
        <AlertDialogHeader className="flex flex-row items-center justify-between gap-3">
          <AlertDialogTitle className="m-0 flex flex-wrap items-center gap-2 font-display text-[length:var(--type-h2-size)] leading-[var(--type-h2-leading)] font-semibold tracking-[0.025em] text-foreground">
            {title}
          </AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogDescription className="m-0 text-[length:var(--type-body-size)] leading-[var(--type-body-leading)] text-[var(--text-muted)]">
          {body}
        </AlertDialogDescription>
        {action.error ? <ErrorBox>{action.error}</ErrorBox> : null}
        <AlertDialogFooter className="mt-1 flex gap-2">
          <Button type="button" variant="destructive" disabled={action.busy} onClick={confirm}>
            {action.busy ? "Working…" : confirmLabel}
          </Button>
          <AlertDialogCancel type="button" disabled={action.busy}>
            Cancel
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
