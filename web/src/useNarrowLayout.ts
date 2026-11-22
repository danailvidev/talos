import { useEffect, useState } from "react";

/**
 * Phones and narrow windows.
 *
 * 900px is the same cutoff ticket and merge-request detail already use to
 * stack their sidebars, so the shell and those panes change together.
 */
export const NARROW_LAYOUT_QUERY = "(max-width: 900px)";

export function useNarrowLayout(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW_LAYOUT_QUERY).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(NARROW_LAYOUT_QUERY);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return narrow;
}
