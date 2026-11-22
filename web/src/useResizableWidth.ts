import { useCallback, useRef, useState } from "react";

/**
 * A draggable width persisted to localStorage. `edge` names the side carrying
 * the handle: a right-side panel grows when its left edge moves left, while the
 * list/detail panes keep their existing left-to-right behaviour.
 */
export function useResizableWidth(
  key: string,
  defaultWidth: number,
  min: number,
  max: number,
  edge: "left" | "right" = "right",
) {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? clamp(stored, min, max) : defaultWidth;
  });
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      dragState.current = { startX: event.clientX, startWidth: width };
      const target = event.currentTarget as HTMLElement;
      target.setPointerCapture(event.pointerId);
    },
    [width],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!dragState.current) return;
      const pointerDelta = event.clientX - dragState.current.startX;
      const delta = edge === "left" ? -pointerDelta : pointerDelta;
      const next = clamp(dragState.current.startWidth + delta, min, max);
      setWidth(next);
    },
    [edge, min, max],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      if (!dragState.current) return;
      dragState.current = null;
      localStorage.setItem(key, String(width));
      const target = event.currentTarget as HTMLElement;
      target.releasePointerCapture(event.pointerId);
    },
    [key, width],
  );

  return { width, onPointerDown, onPointerMove, onPointerUp };
}

/**
 * A draggable height persisted to localStorage. The handle is the top edge:
 * moving it up makes the region taller.
 */
export function useResizableHeight(
  key: string,
  defaultHeight: number,
  min: number,
  max: number,
) {
  const [height, setHeight] = useState(() => {
    const stored = Number(localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? clamp(stored, min, max) : defaultHeight;
  });
  const dragState = useRef<{ startY: number; startHeight: number } | null>(null);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      dragState.current = { startY: event.clientY, startHeight: height };
      const target = event.currentTarget as HTMLElement;
      target.setPointerCapture(event.pointerId);
    },
    [height],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!dragState.current) return;
      const delta = dragState.current.startY - event.clientY;
      setHeight(clamp(dragState.current.startHeight + delta, min, max));
    },
    [min, max],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      if (!dragState.current) return;
      dragState.current = null;
      localStorage.setItem(key, String(height));
      const target = event.currentTarget as HTMLElement;
      target.releasePointerCapture(event.pointerId);
    },
    [key, height],
  );

  return { height, onPointerDown, onPointerMove, onPointerUp };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
