import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { X } from "lucide-react";

import { api, type PullRequestRepoFilterView } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { invalidate, queries } from "./queries.ts";
import { keys } from "./query-keys.ts";
import { useApi } from "./useApi.ts";
import { useAction } from "./useAction.ts";
import { ErrorBox, QueryState } from "./components/ui/query-state.tsx";
import { TitleInfo } from "./TitleInfo.tsx";
import { Input } from "./components/ui/input.tsx";
import { SETTINGS_FORM_CLASS, SETTINGS_SECTION_CLASS } from "./settings-layout.ts";
import { PAGE_TITLE_CLASS, SECTION_TITLE_CLASS } from "./typography-styles.ts";

/**
 * Which repositories a developer's Team MRs tab shows.
 *
 * A GitLab token's groups can span an entire org, and the Team MRs tab lists
 * every open merge request across all of them — for someone on a handful of
 * teams that is other people's projects they have never touched. This is the
 * one control over that: a per-developer allow-list, empty by default (no
 * filter, exactly today's behaviour) so nobody has to configure anything
 * before Team MRs works at all.
 */
export function PullRequestRepoSettings() {
  const queryClient = useQueryClient();
  const filter = useApi(queries.pullRequestRepoFilter());

  return (
    <QueryState query={filter} loading="Loading…">
      {(data) => (
        <RepoFilterForm
          initial={data.repositories}
          onSaved={(saved) => {
            queryClient.setQueryData(keys.me.pullRequestRepoFilter(), saved);
            // This list *is* the Team MRs query — the server filters by it — so
            // every cached listing was answering a question that no longer applies.
            void queryClient.invalidateQueries({ queryKey: keys.allPrs() });
            // And the graph, which draws the same merge requests through the same
            // filter (`myPullRequests` in `src/api/graph-view.ts`).
            invalidate.graph(queryClient);
          }}
        />
      )}
    </QueryState>
  );
}

/** A loose `group/project` shape — a slash and no whitespace — not a strict validator against real GitLab paths. */
function looksLikeRepoPath(value: string): boolean {
  return /^[^\s/]+\/[^\s]+$/.test(value);
}

function RepoFilterForm({
  initial,
  onSaved,
}: {
  initial: string[];
  onSaved: (saved: PullRequestRepoFilterView) => void;
}) {
  const [repos, setRepos] = useState(initial);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string>();
  const save = useAction();

  // A save elsewhere (or opening this tab again) should show what's actually
  // stored, not whatever was left half-typed on a previous visit.
  useEffect(() => {
    setRepos(initial);
  }, [initial]);

  function addDraft() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (!looksLikeRepoPath(trimmed)) {
      setDraftError("Expected a GitLab path like group/project — see repo!id on any MR row.");
      return;
    }
    if (repos.some((repo) => repo.toLowerCase() === trimmed.toLowerCase())) {
      setDraft("");
      setDraftError(undefined);
      return;
    }
    setRepos([...repos, trimmed]);
    setDraft("");
    setDraftError(undefined);
  }

  function removeRepo(repo: string) {
    setRepos(repos.filter((r) => r !== repo));
  }

  const handleSave = () =>
    save.run(async () => {
      const result = await api.setPullRequestRepoFilter(repos);
      setRepos(result.repositories);
      onSaved(result);
    });

  const dirty = repos.join(",") !== initial.join(",");

  return (
    <div className={SETTINGS_FORM_CLASS}>
      <h1 className={PAGE_TITLE_CLASS}>
        Pull requests
        <TitleInfo>Yours alone — nobody else's Team MRs tab is affected by this.</TitleInfo>
      </h1>

      <section className={SETTINGS_SECTION_CLASS}>
        <h2 className={SECTION_TITLE_CLASS}>Team MRs repositories</h2>
        <div className="flex min-h-7 flex-wrap gap-1.5">
          {repos.length === 0 ? (
            <span className="self-center text-sm text-[var(--text-faint)]">
              No filter — every repository your groups turn up.
            </span>
          ) : (
            repos.map((repo) => (
              <span
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-[var(--bg-raised)] py-1 pr-1.5 pl-2.5 text-sm"
                key={repo}
              >
                <span className="mono">{repo}</span>
                <button
                  type="button"
                  className="inline-flex size-4 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-foreground"
                  aria-label={`Remove ${repo}`}
                  onClick={() => removeRepo(repo)}
                >
                  <X size={12} strokeWidth={2.5} />
                </button>
              </span>
            ))
          )}
        </div>

        <div className="mt-1 flex gap-2">
          <Input
            className="mono w-72"
            value={draft}
            placeholder="group/project"
            onChange={(event) => {
              setDraft(event.target.value);
              setDraftError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addDraft();
              }
            }}
          />
          <Button type="button" variant="outline" onClick={addDraft}>
            Add
          </Button>
        </div>
        {draftError ? (
          <div className="mt-1.5 text-sm text-[var(--status-danger)]">{draftError}</div>
        ) : null}

        <div className="mt-1.5 text-sm text-[var(--text-faint)]">
          Narrows Team MRs to just these repositories. Leave the list empty to see every open
          merge request across your groups, same as today. Never affects My MRs — your own work
          stays visible regardless.
        </div>
      </section>

      {save.error ? <ErrorBox>{save.error}</ErrorBox> : null}
      {save.done ? <div className="mt-1.5 text-sm text-[var(--text-faint)]">Saved.</div> : null}

      <div className="flex gap-2">
        <Button type="button" disabled={save.busy || !dirty} onClick={handleSave}>
          {save.busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
