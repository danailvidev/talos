import { ChevronDown, ChevronsDown, ChevronsUp, ChevronUp, Equal } from "lucide-react";
import type { ComponentType } from "react";

import { cn } from "../lib/utils.ts";

const PRIORITIES: ReadonlyArray<[
  RegExp,
  ComponentType<{ size?: number; strokeWidth?: number }>,
  string,
]> = [
  [/highest|blocker|critical|p1/i, ChevronsUp, "[&_svg]:text-[#e34935]"],
  [/high|major|p2/i, ChevronUp, "[&_svg]:text-[#e56b3f]"],
  [/medium|normal|moderate|p3/i, Equal, "[&_svg]:text-[#e3a13b]"],
  [/lowest|trivial|p5/i, ChevronsDown, "[&_svg]:text-[#0c66e4]"],
  [/low|minor|p4/i, ChevronDown, "[&_svg]:text-[#2684ff]"],
];

/**
 * Jira's priority arrows, matched loosely because sites often rename the
 * standard levels (for example, "P1 — Critical" or "Normal").
 */
export function PriorityMark({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const match = PRIORITIES.find(([pattern]) => pattern.test(name));
  if (!match) return <span className={className}>{name}</span>;
  const [, Icon, toneClass] = match;
  return (
    <span className={cn("inline-flex items-center gap-[5px] [&_svg]:shrink-0", toneClass, className)}>
      <Icon size={13} strokeWidth={2.75} />
      {name}
    </span>
  );
}
