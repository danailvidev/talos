import { useEffect, useRef, useState } from "react";

/**
 * On a phone, a selected row is not the same thing as showing its detail.
 *
 * A link that already names a record opens the detail. The list's automatic
 * first-row selection does not — that would hide the list the moment the page
 * loaded. A later change of id (search, a notification) does open it.
 */
export function useMobileDetail(selectedId: string | undefined) {
  const [open, setOpen] = useState(() => Boolean(selectedId));
  const seen = useRef(selectedId);

  useEffect(() => {
    const previous = seen.current;
    seen.current = selectedId;
    if (!selectedId || !previous || selectedId === previous) return;
    setOpen(true);
  }, [selectedId]);

  return {
    open,
    showDetail: () => setOpen(true),
    showList: () => setOpen(false),
  };
}
