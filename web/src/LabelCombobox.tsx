import { useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import { Button } from "./components/ui/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "./components/ui/command.tsx";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "./components/ui/popover.tsx";
import { cn } from "./lib/utils.ts";

/**
 * Multi-select combobox for a `string[]` of labels: selected values render as
 * removable chips, typing filters `suggestions`, and anything typed that
 * isn't in the suggestion list can still be added as a free-text label —
 * there is no backend endpoint that lists real Jira labels in use, so
 * `suggestions` is just a starting point, not an exhaustive source of truth.
 */
export function LabelCombobox({
  value,
  onChange,
  suggestions,
  placeholder,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeValue, setActiveValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rest: ({ label: string } | { create: string })[] = suggestions
      .filter((label) => !value.includes(label) && (!q || label.toLowerCase().includes(q)))
      .map((label) => ({ label }));
    const trimmed = query.trim();
    const isNew =
      trimmed.length > 0 &&
      !value.some((label) => label.toLowerCase() === trimmed.toLowerCase()) &&
      !suggestions.some((label) => label.toLowerCase() === trimmed.toLowerCase());
    return isNew ? [...rest, { create: trimmed }] : rest;
  }, [query, suggestions, value]);

  function add(label: string) {
    const trimmed = label.trim();
    if (!trimmed || value.includes(trimmed)) return;
    onChange([...value, trimmed]);
    setQuery("");
  }

  function remove(label: string) {
    onChange(value.filter((l) => l !== label));
  }

  function pick(option: { label: string } | { create: string }) {
    add("label" in option ? option.label : option.create);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Command
        shouldFilter={false}
        onValueChange={setActiveValue}
        className="h-auto overflow-visible rounded-none bg-transparent p-0 text-foreground"
      >
        <PopoverAnchor asChild>
          <div
            className={cn(
              "flex min-h-8 w-full flex-wrap items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-sm",
              "focus-within:border-[var(--focus)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_55%,transparent)]",
              "[&_[data-slot=command-input-wrapper]]:min-w-24 [&_[data-slot=command-input-wrapper]]:flex-1 [&_[data-slot=command-input-wrapper]]:p-0",
              "[&_[data-slot=input-group]]:h-auto! [&_[data-slot=input-group]]:rounded-none! [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent! [&_[data-slot=input-group]]:shadow-none!",
              "[&_[data-slot=input-group-addon]]:hidden",
            )}
            onClick={(event) => {
              if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
            }}
          >
            {value.map((label) => (
              <span
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-[var(--bg-raised)] pr-1 pl-2.5 text-sm leading-none"
                key={label}
              >
                {label}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-5 rounded-full p-0"
                  aria-label={`Remove ${label}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => remove(label)}
                >
                  <X size={12} strokeWidth={2.5} />
                </Button>
              </span>
            ))}
            <CommandInput
              ref={inputRef}
              className="h-auto min-w-24 p-0"
              value={query}
              placeholder={value.length === 0 ? placeholder : undefined}
              onFocus={() => setOpen(true)}
              onValueChange={(next) => {
                setQuery(next);
                setOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key === ",") {
                  event.preventDefault();
                  const active = options.find((option) => {
                    const optionValue =
                      "label" in option ? option.label : `create:${option.create}`;
                    return optionValue === activeValue;
                  });
                  if (active) pick(active);
                  else if (options[0]) pick(options[0]);
                  else add(query);
                } else if (event.key === "Backspace" && query === "" && value.length > 0) {
                  remove(value[value.length - 1]!);
                }
              }}
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-[var(--radix-popover-trigger-width)] min-w-56 gap-0 overflow-hidden rounded-md p-0 shadow-lg ring-1 ring-border"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <CommandList className="max-h-56 p-1">
            <CommandEmpty className="px-2 py-3 text-left text-muted-foreground">
              Type to add a label
            </CommandEmpty>
            {options.map((option) => {
              return (
                <CommandItem
                  key={"label" in option ? option.label : `create:${option.create}`}
                  value={"label" in option ? option.label : `create:${option.create}`}
                  onSelect={() => pick(option)}
                >
                  {"label" in option ? option.label : <>Add "{option.create}"</>}
                </CommandItem>
              );
            })}
          </CommandList>
        </PopoverContent>
      </Command>
    </Popover>
  );
}
