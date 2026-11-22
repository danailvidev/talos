import { cn } from "./lib/utils.ts";

/** The rebranded assistant mark, inline so `currentColor` works at every size. */
export function AssistantIcon({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      width={size}
      height={size}
      className={cn("shrink-0 text-primary", className)}
    >
      <path
        d="M3 21c2-.6 2.7-2.6 2.3-5.4C4.4 9 7 4.3 11.5 2.5c3.5-1.4 7.5-.7 10 1.2l-4 4.5c-3.2-1.5-6.8-1.1-9 1.2-2.1 2.2-1.6 5.6-1.8 8C6.5 19.6 5 21.3 3 21Z"
        fill="currentColor"
      />
      <path
        d="M7.2 15.1c-.5-3.3 1-5.9 3.8-7 2.5-.9 5.2-.1 6.8 1.6l-4.5 3.2 6.2-4c.6-.4 1.2-.1 1.4.7l2.1 8.8c.2.8-.6 1.2-1.2.7l-1.7-1.4 1 4.4c.2.7-.4 1.2-1.1 1-4.1-1-7.3-3-9.3-5.1-1.5 1.4-3.5 2.2-5.4 2.1-.7 0-.9-.7-.4-1.1 1.5-1.4 2.6-2.6 2.3-3.9Zm8-1.2c1.3-.8 2.8-.6 3.5.4-1.1.4-2.4.3-3.5-.4Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}
