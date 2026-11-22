import { GitCommitHorizontal, Layers } from "lucide-react";

import { type PullRequestDetailView } from "../api.ts";
import { ago } from "../format.ts";
import { Tip } from "../Tip.tsx";
import { useFormat } from "../FormatContext.tsx";
import { Button } from "../components/ui/button.tsx";
import { cn } from "../lib/utils.ts";

type Commit = PullRequestDetailView["commits"][number];

/**
 * The branch's commits, as the picker for the diff below them.
 *
 * One list rather than a tab of its own: a commit is only interesting for what it
 * changed, so reading the two side by side is the whole point, and a separate tab
 * made the reader hold a sha in their head while they navigated to the diff.
 *
 * Fed from the detail response the pane already has rather than a request of its
 * own, because the detail fetch reads the commits regardless — the diff is cached
 * against their shas, so asking again would pay a round trip to re-learn something
 * already on screen.
 *
 * Ordering is left exactly as the forge returned it. GitLab lists an MR's commits
 * newest first, and sorting by date here would quietly disagree with the forge's
 * own page on a rebased branch, where every commit shares a timestamp.
 */
export function PullRequestCommits({
  commits,
  selected,
  onSelect,
}: {
  commits: Commit[];
  /** The sha whose diff is showing, or undefined for the whole branch. */
  selected?: string;
  onSelect: (sha?: string) => void;
}) {
  const fmt = useFormat();

  return (
    // Capped and scrollable rather than as long as the branch: a merge request
    // rebased a dozen times would otherwise push the diff it is a picker for off
    // the bottom of the screen, which is the wrong way round.
    <section className="max-h-60 overflow-y-auto rounded-[var(--radius)] border border-border bg-[var(--bg-raised)]">
      <Row
        icon={<Layers size={13} strokeWidth={2} />}
        active={selected === undefined}
        onClick={() => onSelect(undefined)}
      >
        <span className="font-medium">All commits</span>
        <span className="text-[0.8125rem] text-[var(--text-faint)]">
          {commits.length === 1 ? "1 commit" : `${commits.length} commits`} on this branch
        </span>
      </Row>

      {commits.map((commit) => {
        const active = selected === commit.sha;
        return (
          <Row
            key={commit.sha}
            icon={<GitCommitHorizontal size={13} strokeWidth={2} />}
            active={active}
            onClick={() => onSelect(active ? undefined : commit.sha)}
          >
            <span className="mono shrink-0 text-[0.8125rem] text-success">
              {commit.sha.slice(0, 8)}
            </span>
            <span
              className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              title={commit.title}
            >
              {commit.title}
            </span>
            {/* Both trailing facts are optional on the wire, so each is drawn only
                when the forge reported it — an em dash and an empty cell would read
                as a commit nobody wrote. The link to the forge is deliberately not
                here: the row's job is to select, and a nested anchor inside a
                button is neither valid nor clickable. */}
            {commit.author ? (
              <span className="ml-auto shrink-0 text-[0.8125rem] text-[var(--text-dim)]">
                {commit.author}
              </span>
            ) : null}
            {commit.committedAt ? (
              <Tip label={fmt.stamp(commit.committedAt)}>
                <span
                  className={cn(
                    "shrink-0 text-[0.8125rem] text-[var(--text-faint)]",
                    !commit.author && "ml-auto",
                  )}
                >
                  {ago(commit.committedAt)}
                </span>
              </Tip>
            ) : null}
          </Row>
        );
      })}
    </section>
  );
}

/**
 * One selectable line. A button rather than a link, because this changes what the
 * page below shows rather than where the page is — and the selected one keeps its
 * left rail so the diff underneath is visibly *of* something.
 */
function Row({
  icon,
  active,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-pressed={active}
      className={cn(
        "h-auto w-full justify-start gap-2 rounded-none border-0 border-b border-[color-mix(in_srgb,var(--border)_55%,transparent)] bg-transparent px-[11px] py-[7px] text-left font-[inherit] text-[0.9062rem] text-[var(--text-dim)] last:border-b-0 hover:bg-[var(--bg-hover)] [&_svg]:shrink-0 [&_svg]:text-[var(--text-faint)]",
        active &&
          "border-l-2 border-l-action bg-[color-mix(in_srgb,var(--action)_10%,transparent)] pl-[9px] text-foreground [&_svg]:text-action",
      )}
      onClick={onClick}
    >
      {icon}
      {children}
    </Button>
  );
}
