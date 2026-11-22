import { useEffect, useRef, useState } from "react";

/**
 * The plot's own width in CSS pixels.
 *
 * The charts draw in real pixels rather than in a fixed viewBox scaled to fit:
 * a scaled viewBox multiplies every spec by the scale factor, so a 24px bar cap
 * and a 9px label become 60px and 22px on a wide card, and hairlines thicken.
 * Measuring costs one `ResizeObserver` per chart and keeps the mark specs true at
 * any card width — including while the list pane divider is being dragged.
 *
 * `fallback` is used for the first paint, before the observer has reported.
 */
export function useChartWidth(fallback = 320): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      // Rounded to whole pixels, so sub-pixel resize noise does not re-render.
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
