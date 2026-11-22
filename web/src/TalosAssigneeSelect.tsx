import { useState } from "react";
import { ChevronDown, LoaderCircle, UserRound } from "lucide-react";

import type {
  AutomationFailureAssigneeView,
  TalosUserView,
} from "./api.ts";
import { queries } from "./queries.ts";
import { useApi } from "./useApi.ts";
import { Button } from "./components/ui/button.tsx";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "./components/ui/command.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover.tsx";

export function TalosAssigneeSelect({
  value,
  busy = false,
  onChange,
}: {
  value: AutomationFailureAssigneeView | null;
  busy?: boolean;
  onChange: (userId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const users = useApi(queries.talosUsers());
  const allUsers = users.data?.users ?? [];
  const filtered = filterTalosUsers(allUsers, search);

  function choose(userId: string | null) {
    onChange(userId);
    setOpen(false);
    setSearch("");
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 w-full min-w-0 justify-between gap-1.5 px-2 font-normal"
          disabled={busy}
          aria-label={`Assign failure${value ? `, currently ${value.name}` : ""}`}
        >
          <span className="min-w-0 truncate">
            {busy ? "Assigning…" : value?.name ?? "Unassigned"}
          </span>
          {busy ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[var(--radix-popover-trigger-width)] min-w-64 gap-0 overflow-hidden rounded-md p-0 shadow-lg ring-1 ring-border"
      >
        <Command shouldFilter={false} className="rounded-none p-0">
          <CommandInput
            autoFocus
            placeholder="Search Talos users…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-64 p-1">
            <CommandItem
              value="unassigned"
              data-checked={value == null}
              onSelect={() => choose(null)}
            >
              <UserRound className="size-4 text-muted-foreground" />
              <span>Unassigned</span>
            </CommandItem>
            {users.loading ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">
                Loading Talos users…
              </div>
            ) : users.error ? (
              <div className="px-2 py-3 text-sm text-destructive">
                {users.error}
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">
                No Talos users found
              </div>
            ) : null}
            {filtered.map((user) => (
              <CommandItem
                key={user.id}
                value={`${user.name} ${user.email} ${user.id}`}
                data-checked={value?.id === user.id}
                onSelect={() => choose(user.id)}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold uppercase">
                  {initials(user.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{user.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {user.email}
                  </span>
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("");
}

export function filterTalosUsers(
  users: readonly TalosUserView[],
  search: string,
): TalosUserView[] {
  const needle = search.trim().toLowerCase();
  return needle
    ? users.filter((user) =>
        [user.name, user.email, user.id].some((field) =>
          field.toLowerCase().includes(needle),
        ),
      )
    : [...users];
}
