import { useSyncExternalStore } from "react";

import horizontalBlackUrl from "../../brand/talos-logo-horizontal-black.svg";
import markBlackUrl from "../../brand/talos-mark-black.svg";
import {
  getAppliedAppearance,
  subscribeToAppliedAppearance,
} from "./theme.ts";

export function Logo({
  size = 20,
  variant = "mark",
  className,
}: {
  size?: number;
  variant?: "mark" | "horizontal";
  className?: string;
}) {
  const resolved = useSyncExternalStore(
    subscribeToAppliedAppearance,
    getAppliedAppearance,
    () => "dark" as const,
  );
  const horizontal = variant === "horizontal";
  const width = horizontal ? Math.round((size * 1800) / 520) : Math.round((size * 679) / 718);
  const bronzeSrc = horizontal
    ? "/assets/logos/talos-logo-horizontal-bronze.svg"
    : "/assets/logos/talos-mark-bronze.svg";
  const blackSrc = horizontal ? horizontalBlackUrl : markBlackUrl;

  return (
    <img
      alt=""
      aria-hidden="true"
      className={className}
      src={resolved === "light" ? blackSrc : bronzeSrc}
      width={width}
      height={size}
    />
  );
}
