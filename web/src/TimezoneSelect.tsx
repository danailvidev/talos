import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

import { Button } from "./components/ui/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "./components/ui/command.tsx";
import { Input } from "./components/ui/input.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover.tsx";
import { cn } from "./lib/utils.ts";
import { matchesTimezoneQuery, supportedTimezones } from "./timezones.ts";
import { browserTimeZone } from "./zoned-time.ts";

/**
 * Searchable IANA timezone picker. Empty `value` means "use the browser's
 * zone" (the same as leaving timezone unset on a cron trigger).
 */
export function TimezoneSelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const zones = useMemo(supportedTimezones, []);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const systemZone = browserTimeZone();
  const systemLabel = `System default (${systemZone})`;
  const selectedLabel = value || systemLabel;

  const options = useMemo(() => {
    const rows = [
      { value: "", label: systemLabel },
      ...zones.map((tz) => ({ value: tz, label: tz })),
    ];
    return rows.filter((row) => matchesTimezoneQuery(row.label, query));
  }, [query, systemLabel, zones]);

  if (zones.length === 0) {
    return (
      <Input
        className={cn(
          "h-8 w-full rounded-md border border-border bg-background px-2.5 text-left text-sm text-foreground",
          className,
        )}
        value={value}
        disabled={disabled}
        placeholder={systemZone}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  function select(next: string) {
    onChange(next);
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          data-slot="timezone-select"
          className={cn(
            "flex h-8 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-1 text-left text-sm font-normal tracking-normal text-foreground normal-case outline-none transition-[border-color,background-color,box-shadow]",
            "hover:border-[var(--text-faint)] hover:bg-[var(--bg-hover)]",
            "data-[state=open]:border-action focus-visible:border-[var(--focus)] focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_55%,transparent)]",
            "disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">{selectedLabel}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[var(--radix-popover-trigger-width)] min-w-56 gap-0 overflow-hidden rounded-md p-0 shadow-lg ring-1 ring-border"
      >
        <Command shouldFilter={false} className="rounded-none p-0">
          <CommandInput
            autoFocus
            placeholder="Search timezones…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-64 p-1">
            <CommandEmpty className="px-2 py-3 text-left text-muted-foreground">
              No matching timezones
            </CommandEmpty>
            {options.map((row) => (
              <CommandItem
                key={row.value || "system"}
                value={row.value || "__system__"}
                data-checked={row.value === value}
                onSelect={() => select(row.value)}
              >
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
