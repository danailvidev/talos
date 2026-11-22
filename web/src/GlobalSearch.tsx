import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { PullRequestView, SearchTicket } from "./api.ts";
import { queries } from "./queries.ts";
import { useApi } from "./useApi.ts";
import { useDebounced } from "./useDebounced.ts";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./components/ui/command.tsx";
import { Popover, PopoverAnchor, PopoverContent } from "./components/ui/popover.tsx";
import { SEARCH_GROUP_CLASS, SEARCH_ROW_CLASS } from "./app-styles.ts";

/** Long enough that a burst of typing is one request, short enough to feel immediate. */
const DEBOUNCE_MS = 180;

const INPUT_WRAPPER_CLASS =
  "[&_[data-slot=command-input-wrapper]]:p-0 [&_[data-slot=input-group]]:h-8 [&_[data-slot=input-group]]:rounded-[var(--radius)] [&_[data-slot=input-group]]:border-border [&_[data-slot=input-group]]:bg-[var(--bg-raised)] [&_[data-slot=input-group-addon]]:text-[var(--text-faint)] [&_input]:w-full [&_input]:border-0 [&_input]:bg-transparent [&_input]:py-[5px] [&_input]:pr-2.5 [&_input]:pl-1 [&_input]:font-[inherit] [&_input]:text-[0.9375rem] [&_input]:text-foreground [&_input]:placeholder:text-[var(--text-faint)]";

const MESSAGE_CLASS = "px-2.5 py-3.5 text-center text-[0.9375rem] text-[var(--text-faint)]";

/**
 * The header's search box: your tickets and your merge requests.
 *
 * Two things, because those are the two things people look for by name — see
 * `src/api/search-view.ts` for why loops and filed issues are no longer in here.
 * Every hit lands somewhere real: a ticket opens its panel on the board, a merge
 * request opens its detail pane.
 *
 * Both are searched server-side over reads the console already caches, so the box
 * does not depend on any page having been visited first. What that leaves is a
 * cold start — the very first search of a session may pay for one Jira and one
 * GitLab read — so focusing the box warms those caches before there is anything
 * to search for. See `queries.searchWarmup`.
 */
export function GlobalSearch({
  onOpenTicket,
  onOpenPullRequest,
}: {
  onOpenTicket: (key: string) => void;
  onOpenPullRequest: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const query = useDebounced(term.trim(), DEBOUNCE_MS);
  const search = useApi(queries.search(query));
  const warmed = useRef(false);

  function warm() {
    if (warmed.current) return;
    warmed.current = true;
    void queryClient.prefetchQuery(queries.searchWarmup());
  }

  function close() {
    setOpen(false);
    setTerm("");
  }

  return (
    // `open` is gated on there being something typed rather than tracked
    // separately: an empty box has nothing to show, and a popover that opens on
    // focus would cover the page every time the header is clicked.
    <Popover open={open && term.trim().length > 0} onOpenChange={setOpen}>
      <Command
        shouldFilter={false}
        className="h-auto overflow-visible rounded-none bg-transparent p-0"
      >
        <PopoverAnchor asChild>
          <div className={INPUT_WRAPPER_CLASS}>
            <CommandInput
              placeholder="Search tickets and merge requests…"
              value={term}
              onValueChange={(value) => {
                setTerm(value);
                if (value) setOpen(true);
              }}
              onFocus={() => {
                warm();
                setOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") close();
              }}
              autoFocus
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="center"
          sideOffset={6}
          className="max-h-90 w-[min(460px,calc(100vw-24px))] gap-0 overflow-y-auto rounded-[var(--radius)] border border-border bg-[var(--bg-raised)] p-1.5 shadow-[var(--shadow-panel)] [&_[data-slot=command-list]]:max-h-87"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <SearchResults
            query={query}
            // `placeholderData` keeps the previous term's hits on screen while the
            // next one is in flight, so this only ever shows on the first search.
            loading={search.loading && !search.data}
            error={search.error}
            tickets={search.data?.tickets ?? []}
            pullRequests={search.data?.pullRequests ?? []}
            onOpenTicket={(key) => {
              onOpenTicket(key);
              close();
            }}
            onOpenPullRequest={(id) => {
              onOpenPullRequest(id);
              close();
            }}
          />
        </PopoverContent>
      </Command>
    </Popover>
  );
}

function SearchResults({
  query,
  loading,
  error,
  tickets,
  pullRequests,
  onOpenTicket,
  onOpenPullRequest,
}: {
  query: string;
  loading: boolean;
  error?: string;
  tickets: SearchTicket[];
  pullRequests: PullRequestView[];
  onOpenTicket: (key: string) => void;
  onOpenPullRequest: (id: string) => void;
}) {
  if (loading || error) {
    return (
      <CommandList>
        <div className={MESSAGE_CLASS}>{error ?? "Searching…"}</div>
      </CommandList>
    );
  }

  if (tickets.length === 0 && pullRequests.length === 0) {
    return (
      <CommandList>
        <CommandEmpty className={MESSAGE_CLASS}>
          No tickets or merge requests match "{query}"
        </CommandEmpty>
      </CommandList>
    );
  }

  return (
    <CommandList>
      {tickets.length > 0 ? (
        <CommandGroup heading="Tickets" className={SEARCH_GROUP_CLASS}>
          {tickets.map((ticket) => (
            <CommandItem
              key={ticket.key}
              value={`ticket:${ticket.key}`}
              className={SEARCH_ROW_CLASS}
              onSelect={() => onOpenTicket(ticket.key)}
            >
              <span className="flex items-baseline gap-1.5">
                <span className="mono text-sm text-[var(--text-faint)]">
                  <Highlight text={ticket.key} query={query} />
                </span>
                <Highlight text={ticket.summary ?? ticket.key} query={query} />
              </span>
              {ticket.status || ticket.type ? (
                <span className="mt-0.5 text-sm text-muted-foreground">
                  {[ticket.type, ticket.status].filter(Boolean).join(" · ")}
                </span>
              ) : null}
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
      {pullRequests.length > 0 ? (
        <CommandGroup heading="Merge requests" className={SEARCH_GROUP_CLASS}>
          {pullRequests.map((pr) => (
            <CommandItem
              key={pr.id}
              value={`pull-request:${pr.id}`}
              className={SEARCH_ROW_CLASS}
              onSelect={() => onOpenPullRequest(pr.id)}
            >
              <span className="flex items-baseline gap-1.5">
                <Highlight text={pr.title} query={query} />
                <span className="mono text-sm text-[var(--text-faint)]">!{pr.number}</span>
              </span>
              <span className="mt-0.5 text-sm text-muted-foreground">
                {pr.repository ? <Highlight text={pr.repository} query={query} /> : null}
                {pr.repository ? " · " : ""}
                {pr.state}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
    </CommandList>
  );
}

/** Wraps the substring of `text` matching `query` (case-insensitive) in a `<mark>`. */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-[var(--radius-compact)] bg-[var(--status-warning)] px-px text-[var(--bg)]">
        {text.slice(index, index + query.length)}
      </mark>
      {text.slice(index + query.length)}
    </>
  );
}
