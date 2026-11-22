import { useCallback } from "react";
import { toast } from "sonner";

import { Toaster } from "./components/ui/sonner.tsx";

export type ToastSeverity = "success" | "info" | "warning" | "error";

export interface ToastOptions {
  severity?: ToastSeverity;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

/**
 * Keeps the app-facing callback small while Sonner owns queueing, dismissal,
 * accessibility, and the viewport.
 */
export function useToasts() {
  const push = useCallback((text: string, options?: ToastOptions) => {
    const severity = options?.severity;
    const toastOptions =
      options?.duration || options?.action
        ? {
            ...(options.duration ? { duration: options.duration } : {}),
            ...(options.action ? { action: options.action } : {}),
          }
        : undefined;
    if (severity) {
      toast[severity](text, toastOptions);
      return;
    }
    toast(text, toastOptions);
  }, []);

  return { push };
}

export function ToastViewport() {
  return <Toaster position="bottom-right" duration={2600} closeButton visibleToasts={5} />;
}
