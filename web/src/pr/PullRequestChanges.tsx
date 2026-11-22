import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, Info } from "lucide-react";

import {
  type PullRequestDetailView,
  type PullRequestFileChangeView,
  type PullRequestThreadView,
} from "../api.ts";
import { queries } from "../queries.ts";
import { useApi } from "../useApi.ts";
import { QueryState } from "../components/ui/query-state.tsx";
import { PullRequestCommits } from "./PullRequestCommits.tsx";
import { PullRequestThread } from "./PullRequestConversation.tsx";
import { parseSideBySide } from "./diff.ts";
import type { DiffRow } from "./diff.ts";
import { EMPTY_STATE_CLASS, INFO_BOX_CLASS, INFO_ICON_CLASS } from "../state-styles.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "../components/ui/button.tsx";

/** How many files open expanded on arrival — enough to read a small change without clicking. */
const AUTO_OPEN = 3;

function fileStatusTone(status: PullRequestFileChangeView["status"]): string {
  if (status === "added") {
    return "bg-[color-mix(in_srgb,var(--success)_18%,var(--bg-deep))] text-[var(--success)]";
  }
  if (status === "removed") {
    return "bg-[color-mix(in_srgb,var(--failure)_18%,var(--bg-deep))] text-[var(--failure)]";
  }
  return "bg-[var(--bg-muted)] text-muted-foreground";
}

function diffCellTone(kind: DiffRow["left"]["kind"]): string {
  if (kind === "add") {
    return "bg-[color-mix(in_srgb,var(--success)_13%,transparent)] text-foreground";
  }
  if (kind === "remove") {
    return "bg-[color-mix(in_srgb,var(--failure)_13%,transparent)] text-foreground";
  }
  if (kind === "empty") {
    return "bg-[color-mix(in_srgb,var(--bg-deep)_45%,transparent)]";
  }
  return "";
}

/**
 * The Changes tab: the branch's commits, and under them every changed file, side by
 * side and each one collapsible.
 *
 * The commits are the picker for the diff rather than a tab of their own — a commit
 * is only interesting for what it changed, so making the reader navigate between
 * the two put the sha and the hunks on separate screens. Selecting one asks the
 * forge for that commit's diff against its parent; "All commits" is the merge
 * request's own diff, which is what the tab opens on.
 *
 * Fetched separately from the detail because the diff is by far the largest thing
 * the forge will hand over. A conversation with line comments may have already
 * primed this query to show their source lines; otherwise the first view starts it.
 * Two columns rather than a unified list: reading a rewritten block means reading
 * what it used to say, and a unified diff makes that a scroll instead of a glance.
 */
export function PullRequestChanges({
  prId,
  commits,
  threads,
  baseUrl,
}: {
  prId: string;
  commits: PullRequestDetailView["commits"];
  threads: PullRequestThreadView[];
  baseUrl?: string;
}) {
  const [sha, setSha] = useState<string>();
  // Not reset when `prId` changes: selecting another merge request re-mounts this
  // tab (the pane keys on the id), so there is no stale selection to clear.
  const changes = useApi(queries.prChanges(prId, sha));
  const scoped = sha !== undefined;

  return (
    <div className="flex flex-col gap-3.5">
      {commits.length > 0 ? (
        <PullRequestCommits commits={commits} selected={sha} onSelect={setSha} />
      ) : null}

      <QueryState query={changes} loading={scoped ? "Loading the commit…" : "Loading the diff…"}>
        {({ files, truncated }) =>
          files.length === 0 ? (
            <div className={EMPTY_STATE_CLASS}>
              {scoped
                ? "This commit changes no files."
                : "This merge request changes no files."}
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {truncated ? (
                <div className={INFO_BOX_CLASS}>
                  <Info size={16} strokeWidth={2} className={INFO_ICON_CLASS} />
                  <div>
                    {scoped ? "This commit touches" : "This merge request touches"} more files
                    than the pane will show. The rest are on the forge.
                  </div>
                </div>
              ) : null}
              {files.map((file, index) => (
                <FileDiff
                  // The sha is in the key so switching commits remounts each row:
                  // a file open in one commit's diff should not silently inherit
                  // the expanded state of a same-named file in another's.
                  key={`${sha ?? "head"}-${file.path}-${index}`}
                  file={file}
                  threads={threads.filter(
                    (thread) =>
                      thread.anchor?.path === file.path ||
                      thread.anchor?.path === file.previousPath,
                  )}
                  baseUrl={baseUrl}
                  prId={prId}
                  initiallyOpen={index < AUTO_OPEN}
                />
              ))}
            </div>
          )
        }
      </QueryState>
    </div>
  );
}

const STATUS_LABEL: Record<PullRequestFileChangeView["status"], string> = {
  added: "added",
  removed: "deleted",
  renamed: "renamed",
  modified: "modified",
};

function FileDiff({
  file,
  threads,
  baseUrl,
  prId,
  initiallyOpen,
}: {
  file: PullRequestFileChangeView;
  threads: PullRequestThreadView[];
  baseUrl?: string;
  prId: string;
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  // Parsed on every render of an open file rather than memoised: the input is a
  // prop that never changes for a mounted row, so a memo would guard nothing.
  const parsed = open && file.diff ? parseSideBySide(file.diff) : undefined;

  return (
    <section className="overflow-hidden rounded-[var(--radius)] border border-border bg-[var(--bg-raised)]">
      <Button
        type="button"
        variant="ghost"
        className={cn(
          "h-auto w-full justify-start gap-2 rounded-none border-0 bg-transparent px-[11px] py-2 text-left font-[inherit] text-sm text-[var(--text-dim)] hover:bg-[var(--bg-hover)] [&_svg]:shrink-0 [&_svg]:text-[var(--text-faint)]",
          open && "border-b border-border",
        )}
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown size={13} strokeWidth={2} />
        ) : (
          <ChevronRight size={13} strokeWidth={2} />
        )}
        <span className="mono overflow-hidden text-ellipsis whitespace-nowrap" title={file.path}>
          {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-[7px] py-px text-xs",
            fileStatusTone(file.status),
          )}
        >
          {STATUS_LABEL[file.status]}
        </span>
        {parsed ? (
          <span className="mono ml-auto inline-flex shrink-0 gap-[7px] text-[0.7812rem]">
            <span className="text-[var(--success)]">+{parsed.additions}</span>
            <span className="text-[var(--failure)]">−{parsed.deletions}</span>
          </span>
        ) : null}
      </Button>

      {open ? (
        file.tooLarge || !file.diff ? (
          <div className="p-3 text-sm text-[var(--text-faint)]">
            {file.tooLarge
              ? "The forge would not produce a diff for this file — it is too large."
              : "No textual diff for this file (it may be binary)."}
          </div>
        ) : parsed?.unparsed ? (
          // Not a diff we recognised. Showing the text we were given beats
          // claiming there is nothing here.
          <pre className="mono m-0 overflow-x-auto bg-[var(--bg-deep)] px-3 py-2.5 text-[0.7812rem] leading-normal">
            {file.diff}
          </pre>
        ) : (
          <div>
            {parsed?.hunks.map((hunk, index) => (
              <table
                className="w-full table-fixed border-collapse text-xs leading-[1.4]"
                key={index}
              >
                <colgroup>
                  <col className="w-9.5" />
                  <col className="w-[calc((100%-76px)/2)]" />
                  <col className="w-9.5" />
                  <col className="w-[calc((100%-76px)/2)]" />
                </colgroup>
                <tbody>
                  <tr className="[&_td]:bg-[var(--bg-deep)] [&_td]:px-2.5 [&_td]:py-1 [&_td]:text-[0.7812rem] [&_td]:text-[var(--text-faint)]">
                    <td colSpan={4} className="mono">
                      {hunk.header}
                    </td>
                  </tr>
                  {hunk.rows.map((row, rowIndex) => {
                    const rowThreads = threads.flatMap((thread) => {
                      const side = threadSide(thread, row);
                      return side ? [{ thread, side }] : [];
                    });

                    return (
                      <Fragment key={rowIndex}>
                        <tr>
                          <td
                            className={cn(
                              "border-r border-[color-mix(in_srgb,var(--border)_60%,transparent)] bg-[color-mix(in_srgb,var(--bg-deep)_60%,transparent)] px-[5px] text-right align-top font-mono text-xs text-[var(--text-faint)] select-none",
                              diffCellTone(row.left.kind),
                            )}
                          >
                            {row.left.line ?? ""}
                          </td>
                          <td
                            className={cn(
                              "px-[5px] align-top whitespace-pre-wrap text-[var(--text-dim)] [overflow-wrap:anywhere]",
                              diffCellTone(row.left.kind),
                            )}
                          >
                            <span className="mono">{row.left.text ?? ""}</span>
                          </td>
                          <td
                            className={cn(
                              "border-r border-[color-mix(in_srgb,var(--border)_60%,transparent)] bg-[color-mix(in_srgb,var(--bg-deep)_60%,transparent)] px-[5px] text-right align-top font-mono text-xs text-[var(--text-faint)] select-none",
                              diffCellTone(row.right.kind),
                            )}
                          >
                            {row.right.line ?? ""}
                          </td>
                          <td
                            className={cn(
                              "px-[5px] align-top whitespace-pre-wrap text-[var(--text-dim)] [overflow-wrap:anywhere]",
                              diffCellTone(row.right.kind),
                            )}
                          >
                            <span className="mono">{row.right.text ?? ""}</span>
                          </td>
                        </tr>
                        {rowThreads.map(({ thread, side }) => (
                          <tr className="[&_td]:p-0 [&_td]:align-top" key={thread.id}>
                            {side === "right" ? (
                              <td
                                className="bg-[color-mix(in_srgb,var(--bg-deep)_30%,transparent)]"
                                colSpan={2}
                              />
                            ) : null}
                            <td
                              className="border-l border-border bg-background !p-2"
                              colSpan={2}
                            >
                              <PullRequestThread
                                thread={thread}
                                collapsible
                                baseUrl={baseUrl}
                                prId={prId}
                              />
                            </td>
                            {side === "left" ? (
                              <td
                                className="bg-[color-mix(in_srgb,var(--bg-deep)_30%,transparent)]"
                                colSpan={2}
                              />
                            ) : null}
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            ))}
          </div>
        )
      ) : null}
    </section>
  );
}

function threadSide(
  thread: PullRequestThreadView,
  row: DiffRow,
): "left" | "right" | undefined {
  const anchor = thread.anchor;
  if (!anchor) return undefined;
  if (anchor.newLine != null) return anchor.newLine === row.right.line ? "right" : undefined;
  if (anchor.oldLine != null) return anchor.oldLine === row.left.line ? "left" : undefined;
  if (anchor.line === row.right.line) return "right";
  if (anchor.line === row.left.line) return "left";
  return undefined;
}
