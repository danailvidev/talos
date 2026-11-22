import { useEffect, useRef, useState, type Ref } from "react";
import { GripHorizontal, GripVertical, X } from "lucide-react";
import {
  ReactGridLayout,
  useContainerWidth,
  verticalCompactor,
  type Layout,
  type ResizeHandleAxis,
} from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import type { Widget } from "../../../shared/dashboard.ts";
import { WidgetView } from "./WidgetView.tsx";
import { ICON_BUTTON_CLASS } from "../app-styles.ts";
import { Button } from "../components/ui/button.tsx";
import { cn } from "../lib/utils.ts";
import { Tip } from "../Tip.tsx";

/**
 * Edit mode lets every edge resize. The library's handles are a rotated corner
 * glyph; these overrides turn them into edge strips. Color and the grip icon
 * appear only while the pointer is on a handle.
 */
const EDITING_GRID_CLASS = [
  "[&_.react-grid-placeholder]:!bg-action",
  "[&_.react-resizable-handle]:!z-20 [&_.react-resizable-handle]:!flex [&_.react-resizable-handle]:!items-center [&_.react-resizable-handle]:!justify-center [&_.react-resizable-handle]:!bg-none [&_.react-resizable-handle]:!p-0 [&_.react-resizable-handle]:!opacity-100",
  "[&_.react-resizable-handle::after]:!hidden",
  "[&_.react-resizable-handle-e]:!inset-y-0 [&_.react-resizable-handle-e]:!right-0 [&_.react-resizable-handle-e]:!mt-0 [&_.react-resizable-handle-e]:!h-auto [&_.react-resizable-handle-e]:!w-3 [&_.react-resizable-handle-e]:!transform-none [&_.react-resizable-handle-e]:!cursor-ew-resize",
  "[&_.react-resizable-handle-w]:!inset-y-0 [&_.react-resizable-handle-w]:!left-0 [&_.react-resizable-handle-w]:!mt-0 [&_.react-resizable-handle-w]:!h-auto [&_.react-resizable-handle-w]:!w-3 [&_.react-resizable-handle-w]:!transform-none [&_.react-resizable-handle-w]:!cursor-ew-resize",
  "[&_.react-resizable-handle-s]:!inset-x-0 [&_.react-resizable-handle-s]:!bottom-0 [&_.react-resizable-handle-s]:!ml-0 [&_.react-resizable-handle-s]:!h-3 [&_.react-resizable-handle-s]:!w-auto [&_.react-resizable-handle-s]:!transform-none [&_.react-resizable-handle-s]:!cursor-ns-resize",
  "[&_.react-resizable-handle-n]:!inset-x-0 [&_.react-resizable-handle-n]:!top-0 [&_.react-resizable-handle-n]:!h-3 [&_.react-resizable-handle-n]:!w-auto [&_.react-resizable-handle-n]:!transform-none [&_.react-resizable-handle-n]:!cursor-ns-resize",
  "[&_.react-resizable-handle-se]:!right-0 [&_.react-resizable-handle-se]:!bottom-0 [&_.react-resizable-handle-se]:!z-30 [&_.react-resizable-handle-se]:!size-4 [&_.react-resizable-handle-se]:!transform-none [&_.react-resizable-handle-se]:!cursor-nwse-resize",
  "[&_.react-resizable-handle-sw]:!left-0 [&_.react-resizable-handle-sw]:!bottom-0 [&_.react-resizable-handle-sw]:!z-30 [&_.react-resizable-handle-sw]:!size-4 [&_.react-resizable-handle-sw]:!transform-none [&_.react-resizable-handle-sw]:!cursor-nesw-resize",
  "[&_.react-resizable-handle-ne]:!right-0 [&_.react-resizable-handle-ne]:!top-0 [&_.react-resizable-handle-ne]:!z-30 [&_.react-resizable-handle-ne]:!size-4 [&_.react-resizable-handle-ne]:!transform-none [&_.react-resizable-handle-ne]:!cursor-nesw-resize",
  "[&_.react-resizable-handle-nw]:!left-0 [&_.react-resizable-handle-nw]:!top-0 [&_.react-resizable-handle-nw]:!z-30 [&_.react-resizable-handle-nw]:!size-4 [&_.react-resizable-handle-nw]:!transform-none [&_.react-resizable-handle-nw]:!cursor-nwse-resize",
].join(" ");

export function DashboardGrid({
  widgets,
  editing,
  refreshToken,
  onLayout,
  onRemove,
}: {
  widgets: Widget[];
  editing: boolean;
  refreshToken: number;
  onLayout: (layout: Widget["layout"][], ids: string[]) => void;
  onRemove: (id: string) => void;
}) {
  const { width, containerRef, mounted } = useContainerWidth();
  const interacting = useRef(false);
  const [layout, setLayout] = useState<Layout>(() => layoutFrom(widgets, editing));

  useEffect(() => {
    if (interacting.current) return;
    setLayout(layoutFrom(widgets, editing));
  }, [widgets, editing]);

  const commit = (next: Layout) => {
    interacting.current = false;
    setLayout(next);
    onLayout(
      next.map((item) => ({
        x: item.x,
        y: item.y,
        w: Math.min(12, Math.max(2, item.w)),
        h: Math.min(16, Math.max(2, item.h)),
      })),
      next.map((item) => item.i),
    );
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        "min-h-0",
        editing && EDITING_GRID_CLASS,
      )}
    >
      {mounted ? (
        <ReactGridLayout
          layout={layout}
          width={width}
          compactor={verticalCompactor}
          gridConfig={{ cols: 12, rowHeight: 28, margin: [12, 12] }}
          dragConfig={{
            enabled: editing,
            handle: ".dashboard-drag-handle",
            cancel: "button, a, input",
            threshold: 3,
            bounded: false,
          }}
          resizeConfig={{
            enabled: editing,
            handles: ["n", "e", "s", "w", "ne", "se", "sw", "nw"],
            handleComponent: resizeHandle,
          }}
          onDragStart={() => {
            interacting.current = true;
          }}
          onResizeStart={() => {
            interacting.current = true;
          }}
          onLayoutChange={(next) => {
            if (!editing) return;
            setLayout(next);
          }}
          onDragStop={commit}
          onResizeStop={commit}
        >
          {widgets.map((widget) => (
            <div key={widget.id} className="h-full">
              <div className="relative h-full">
                {editing ? (
                  <div className="absolute top-1.5 right-1.5 z-40 flex items-center">
                    <Tip label="Move">
                      <span
                        className={cn(
                          ICON_BUTTON_CLASS,
                          "dashboard-drag-handle size-7 cursor-grab opacity-60 hover:opacity-100 active:cursor-grabbing",
                        )}
                        aria-label="Move"
                      >
                        <GripVertical size={14} strokeWidth={2} />
                      </span>
                    </Tip>
                    <Tip label="Remove">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(ICON_BUTTON_CLASS, "size-7 opacity-60 hover:!opacity-100")}
                        aria-label="Remove"
                        onClick={() => onRemove(widget.id)}
                      >
                        <X size={14} strokeWidth={2} />
                      </Button>
                    </Tip>
                  </div>
                ) : null}
                <WidgetView widget={widget} refreshToken={refreshToken} editing={editing} />
              </div>
            </div>
          ))}
        </ReactGridLayout>
      ) : null}
    </div>
  );
}

function layoutFrom(widgets: Widget[], editing: boolean): Layout {
  return widgets.map((widget) => ({
    i: widget.id,
    ...widget.layout,
    minW: 2,
    minH: 2,
    maxW: 12,
    maxH: 16,
    static: !editing,
  }));
}

function resizeHandle(axis: ResizeHandleAxis, ref: Ref<HTMLElement>) {
  const vertical = axis === "e" || axis === "w";
  const horizontal = axis === "n" || axis === "s";
  const Icon = vertical ? GripVertical : horizontal ? GripHorizontal : null;

  return (
    <span
      ref={ref as Ref<HTMLSpanElement>}
      className={cn(
        "react-resizable-handle group !bg-none !p-0 after:!hidden",
        `react-resizable-handle-${axis}`,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute opacity-0 group-hover:opacity-100 group-active:opacity-100",
          vertical && "inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-action",
          horizontal && "inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-action",
          !vertical && !horizontal && "inset-0 rounded-sm border-2 border-action",
        )}
      />
      {Icon ? (
        <Icon
          size={14}
          strokeWidth={2}
          aria-hidden
          className="pointer-events-none relative z-10 text-action opacity-0 group-hover:opacity-100 group-active:opacity-100"
        />
      ) : null}
    </span>
  );
}
