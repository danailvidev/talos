import type { PointerEvent, ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

import { Button } from "./components/ui/button.tsx";
import { SplitHandle } from "./SplitHandle.tsx";

/**
 * List beside detail on a wide window, and one of them at a time on a phone.
 *
 * The divider is the same drag handle the desktop split already uses. On a
 * narrow window it is omitted and a back control returns from the detail.
 */
export function MasterDetail({
  narrow,
  detailOpen,
  onBack,
  backLabel = "Back",
  width,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  list,
  detail,
}: {
  narrow: boolean;
  detailOpen: boolean;
  onBack: () => void;
  backLabel?: string;
  width: number;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  list: ReactNode;
  detail: ReactNode;
}) {
  if (narrow && detailOpen) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center border-b border-border bg-background px-1">
          <Button
            type="button"
            variant="ghost"
            className="h-11 gap-0.5 px-2 text-base"
            onClick={onBack}
          >
            <ChevronLeft size={18} strokeWidth={2} />
            {backLabel}
          </Button>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{detail}</div>
      </div>
    );
  }

  if (narrow) {
    return <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">{list}</div>;
  }

  return (
    <div
      className="grid h-full min-h-0 min-w-0"
      style={{ gridTemplateColumns: `${width}px 0px minmax(0,1fr)` }}
    >
      {list}
      <SplitHandle
        label="Resize panels"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      {detail}
    </div>
  );
}
