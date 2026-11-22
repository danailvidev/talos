import { useState } from "react";
import { ChevronDown } from "lucide-react";

import type { JiraUserView } from "./api.ts";
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
import { cn } from "./lib/utils.ts";
import { queries } from "./queries.ts";
import { useApi } from "./useApi.ts";

export type JiraAssigneeSelection =
  | { mode: "automatic" }
  | { mode: "fixed"; accountId: string };

export function JiraAssigneeSelect({
  project,
  value,
  onChange,
  className,
  automaticHint = "Last author of the matching .ts file",
}: {
  project: string;
  value: JiraAssigneeSelection;
  onChange: (value: JiraAssigneeSelection) => void;
  className?: string;
  automaticHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const normalisedProject = project.trim();
  const hasProject = normalisedProject.length > 0;
  const users = useApi(queries.jiraUsers(normalisedProject));
  const allUsers = users.data?.users ?? [];
  const needle = search.trim().toLowerCase();
  const filteredUsers = needle
    ? allUsers.filter((user) =>
        [user.displayName, user.email, user.accountId].some((field) =>
          field?.toLowerCase().includes(needle),
        ),
      )
    : allUsers;
  const selected =
    value.mode === "fixed"
      ? allUsers.find((user) => user.accountId === value.accountId)
      : undefined;

  const label =
    value.mode === "automatic"
      ? "Automatic"
      : selected?.displayName || value.accountId;

  function choose(next: JiraAssigneeSelection) {
    onChange(next);
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
          data-slot="jira-assignee-select"
          className={cn(
            "flex h-8 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-1 text-left text-sm font-normal tracking-normal text-foreground normal-case outline-none",
            "hover:border-[var(--text-faint)] hover:bg-[var(--bg-hover)]",
            "data-[state=open]:border-action focus-visible:border-[var(--focus)] focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_55%,transparent)]",
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
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
            placeholder="Search Jira users…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-64 p-1">
            <CommandItem
              value="automatic"
              data-checked={value.mode === "automatic"}
              onSelect={() => choose({ mode: "automatic" })}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">Automatic</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {automaticHint}
                </span>
              </span>
            </CommandItem>

            {!hasProject ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">
                Enter a Jira project key first
              </div>
            ) : users.loading ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">Loading Jira users…</div>
            ) : users.error ? (
              <div className="px-2 py-3 text-sm text-destructive">{users.error}</div>
            ) : null}

            {hasProject && !users.loading && !users.error && filteredUsers.length === 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">
                No assignable Jira users found
              </div>
            ) : null}
            {filteredUsers.map((user) => (
              <UserOption
                key={user.accountId}
                user={user}
                checked={value.mode === "fixed" && value.accountId === user.accountId}
                onSelect={() => choose({ mode: "fixed", accountId: user.accountId })}
              />
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function UserOption({
  user,
  checked,
  onSelect,
}: {
  user: JiraUserView;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={`${user.displayName} ${user.email ?? ""} ${user.accountId}`}
      data-checked={checked}
      onSelect={onSelect}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate">{user.displayName}</span>
        {user.email ? (
          <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
        ) : null}
      </span>
    </CommandItem>
  );
}
