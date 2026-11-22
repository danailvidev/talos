import { useState } from "react";
import { Check, ChevronDown, ChevronRight, FileCode, MessageSquare } from "lucide-react";

import type { PullRequestFileChangeView, PullRequestThreadView } from "../api.ts";
import { ago } from "../format.ts";
import { useFormat } from "../FormatContext.tsx";
import { Tip } from "../Tip.tsx";
import { UserAvatar } from "./Avatar.tsx";
import { Markdown } from "./Markdown.tsx";
import { cn } from "../lib/utils.ts";
import { Button } from "../components/ui/button.tsx";
import { queries } from "../queries.ts";
import { useApi } from "../useApi.ts";
import { parseSideBySide, type DiffCellKind } from "./diff.ts";

/**
 * Every comment on the merge request, threaded the way the forge threads them.
 *
 * Open threads first, and only then the settled ones: the point of reading this
 * pane instead of the forge is to find what is still being asked, and an argument
 * resolved last Tuesday is history rather than work. Nothing is hidden, though —
 * including the forge's own system notes, which are what explain why a thread
 * suddenly changed subject.
 */
export function PullRequestConversation({
  threads,
  baseUrl,
  prId,
}: {
  threads: PullRequestThreadView[];
  baseUrl?: string;
  prId: string;
}) {
  const visibleThreads = withoutRedundantMetadataNotes(threads);
  // GitLab's discussion response carries the line coordinates but not the line
  // itself. Reuse the Changes query only when there is a line comment; its
  // result is cached for the Changes tab rather than fetched a second time.
  const changes = useApi({
    ...queries.prChanges(prId),
    enabled: visibleThreads.some(
      (thread) =>
        thread.anchor?.line != null ||
        thread.anchor?.newLine != null ||
        thread.anchor?.oldLine != null ||
        thread.anchor?.range != null,
    ),
  });
  if (visibleThreads.length === 0) {
    return (
      <div className="px-5 py-7 text-center text-[0.9375rem] text-[var(--text-faint)]">
        No comments on this merge request yet.
      </div>
    );
  }

  const open = visibleThreads.filter((thread) => thread.resolvable && !thread.resolved);
  const settled = visibleThreads.filter((thread) => !open.includes(thread));

  return (
    <div className="flex flex-col gap-3">
      {open.map((thread) => (
        <PullRequestThread
          key={thread.id}
          thread={thread}
          linePreview={findThreadLinePreview(thread, changes.data?.files)}
          baseUrl={baseUrl}
          prId={prId}
        />
      ))}
      {open.length > 0 && settled.length > 0 ? (
        <div className="my-1.5 border-t border-border pt-2.5 text-[0.8125rem] text-[var(--text-faint)]">
          {settled.length} resolved or informational{" "}
          {settled.length === 1 ? "thread" : "threads"}
        </div>
      ) : null}
      {settled.map((thread) => (
        <PullRequestThread
          key={thread.id}
          thread={thread}
          linePreview={findThreadLinePreview(thread, changes.data?.files)}
          baseUrl={baseUrl}
          prId={prId}
        />
      ))}
    </div>
  );
}

/**
 * GitLab emits standalone assignment, review-request, description-change and
 * bulk-resolution notes. The detail pane already carries those states or their
 * result, so repeating them as person-authored-looking conversations adds no
 * information. Empty system notes have nothing to render either.
 *
 * Keep the predicates deliberately exact: user comments with the same words and
 * every other system event remain part of the history.
 */
export function withoutRedundantMetadataNotes(
  threads: PullRequestThreadView[],
): PullRequestThreadView[] {
  return threads.flatMap((thread) => {
    const comments = thread.comments.filter((comment) => !isRedundantMetadataNote(comment));
    return comments.length > 0 ? [{ ...thread, comments }] : [];
  });
}

function isRedundantMetadataNote(
  comment: PullRequestThreadView["comments"][number],
): boolean {
  if (!comment.system) return false;
  const body = comment.body.trim();
  return (
    body === "" ||
    /^resolved all threads$/i.test(body) ||
    /^changed the description$/i.test(body) ||
    /^assigned to @[a-z0-9_.-]+$/i.test(body) ||
    /^requested review from @[a-z0-9_.-]+(?:,\s+@[a-z0-9_.-]+)*(?:,?\s+and\s+@[a-z0-9_.-]+)?$/i.test(
      body,
    )
  );
}

export function PullRequestThread({
  thread,
  linePreview,
  collapsible = false,
  baseUrl,
  prId,
}: {
  thread: PullRequestThreadView;
  linePreview?: ThreadLinePreview;
  collapsible?: boolean;
  baseUrl?: string;
  prId?: string;
}) {
  const fmt = useFormat();
  const [expanded, setExpanded] = useState(true);
  const resolved = thread.resolvable && thread.resolved;
  // A thread of only system notes is the forge narrating itself; it reads as a
  // timeline entry, not as somebody asking for something.
  const chatter = thread.comments.every((comment) => comment.system);

  return (
    <article
      className={cn(
        "overflow-hidden rounded-[var(--radius)] border border-l-2 border-border border-l-[var(--warn)] bg-[var(--bg-raised)]",
        resolved && "border-l-[var(--success)]",
        chatter && "border-l-border bg-transparent",
      )}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-[7px] text-[0.8125rem] text-muted-foreground">
        {collapsible ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0 p-0 text-[var(--text-faint)] hover:text-foreground"
            aria-label={expanded ? "Collapse conversation" : "Expand conversation"}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <ChevronDown size={13} strokeWidth={2} />
            ) : (
              <ChevronRight size={13} strokeWidth={2} />
            )}
          </Button>
        ) : null}
        {thread.anchor ? (
          <span
            className="mono inline-flex items-center gap-[5px] overflow-hidden text-ellipsis whitespace-nowrap"
            title={thread.anchor.path}
          >
            <FileCode size={12} strokeWidth={2} />
            {shortPath(thread.anchor.path)}
            {anchorLineLabel(thread.anchor)}
          </span>
        ) : (
          <span className="inline-flex items-center gap-[5px] overflow-hidden text-ellipsis whitespace-nowrap">
            <MessageSquare size={12} strokeWidth={2} />
            Discussion
          </span>
        )}
        {thread.resolvable ? (
          <span
            className={cn(
              "ml-auto inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
              resolved
                ? "bg-[color-mix(in_srgb,var(--success)_18%,var(--bg-deep))] text-[var(--success)]"
                : "bg-[color-mix(in_srgb,var(--warn)_18%,var(--bg-deep))] text-[var(--warn)]",
            )}
          >
            {resolved ? (
              <>
                <Check size={11} strokeWidth={3} />
                Resolved
              </>
            ) : (
              "Open"
            )}
          </span>
        ) : null}
      </header>

      {expanded && linePreview ? <LinePreview preview={linePreview} /> : null}

      {expanded
        ? thread.comments.map((comment) => (
            <div
              key={comment.id}
              className={cn(
                "border-b border-[color-mix(in_srgb,var(--border)_55%,transparent)] px-3 py-2.5 last:border-b-0",
                comment.system && "text-sm text-[var(--text-faint)]",
              )}
            >
              <div className="mb-1.5 flex items-center gap-[7px] text-sm">
                {comment.author ? <UserAvatar user={comment.author} size={18} /> : null}
                <span
                  className={cn(
                    "font-semibold text-foreground",
                    comment.system && "font-medium text-muted-foreground",
                  )}
                >
                  {comment.author?.name ?? comment.author?.username ?? "Unknown"}
                </span>
                <Tip label={fmt.stamp(comment.createdAt)}>
                  <span className="text-[0.8125rem] text-[var(--text-faint)]">
                    {ago(comment.createdAt)}
                  </span>
                </Tip>
              </div>
              <Markdown text={comment.body} baseUrl={baseUrl} prId={prId} />
            </div>
          ))
        : null}
    </article>
  );
}

interface ThreadLinePreview {
  lines: Array<{
    line: number;
    text: string;
    kind: DiffCellKind;
  }>;
}

const PREVIEW_LINES_BEFORE = 6;
const PREVIEW_LINES_AFTER = 2;

function LinePreview({ preview }: { preview: ThreadLinePreview }) {
  return (
    <div className="border-b border-border bg-[var(--bg-deep)] text-xs leading-5">
      {preview.lines.map((line) => (
        <div
          key={line.line}
          className={cn(
            "grid grid-cols-[3rem_minmax(0,1fr)]",
            line.kind === "add" &&
              "bg-[color-mix(in_srgb,var(--success)_10%,var(--bg-deep))]",
            line.kind === "remove" &&
              "bg-[color-mix(in_srgb,var(--failure)_10%,var(--bg-deep))]",
          )}
        >
          <span className="mono select-none border-r border-border px-2 py-1 text-right text-[var(--text-faint)]">
            {line.line}
          </span>
          <pre className="mono m-0 overflow-x-auto px-2.5 py-1 text-[var(--text-dim)]">
            {line.text || " "}
          </pre>
        </div>
      ))}
    </div>
  );
}

/**
 * Resolves GitLab's single-line or `line_range` coordinates against the already
 * parsed merge-request diff. A missing/old hunk simply keeps the heading.
 */
export function findThreadLinePreview(
  thread: PullRequestThreadView,
  files?: PullRequestFileChangeView[],
): ThreadLinePreview | undefined {
  const anchor = thread.anchor;
  if (!anchor || !files) return undefined;
  const file = files.find(
    (candidate) =>
      candidate.path === anchor.path || candidate.previousPath === anchor.path,
  );
  if (!file?.diff) return undefined;

  const parsed = parseSideBySide(file.diff);
  const rows = parsed.hunks.flatMap((hunk) => hunk.rows);
  const range = anchor.range;
  if (range?.start.newLine != null && range.end.newLine != null) {
    const lines = rows
      .map((row) => row.right)
      .filter(
        (cell) =>
          cell.line != null &&
          cell.text != null &&
          cell.line >= range.start.newLine! &&
          cell.line <= range.end.newLine!,
      )
      .map((cell) => ({ ...cell, line: cell.line!, text: cell.text! }));
    if (
      lines[0]?.line === range.start.newLine &&
      lines.at(-1)?.line === range.end.newLine
    ) {
      return { lines };
    }
  }
  if (range?.start.oldLine != null && range.end.oldLine != null) {
    const lines = rows
      .map((row) => row.left)
      .filter(
        (cell) =>
          cell.line != null &&
          cell.text != null &&
          cell.line >= range.start.oldLine! &&
          cell.line <= range.end.oldLine!,
      )
      .map((cell) => ({ ...cell, line: cell.line!, text: cell.text! }));
    if (
      lines[0]?.line === range.start.oldLine &&
      lines.at(-1)?.line === range.end.oldLine
    ) {
      return { lines };
    }
  }
  if (anchor.newLine != null) {
    const lines = surroundingLines(parsed.hunks, "right", anchor.newLine);
    if (lines) return { lines };
  }
  if (anchor.oldLine != null) {
    const lines = surroundingLines(parsed.hunks, "left", anchor.oldLine);
    if (lines) return { lines };
  }
  if (anchor.line != null) {
    const lines =
      surroundingLines(parsed.hunks, "right", anchor.line) ??
      surroundingLines(parsed.hunks, "left", anchor.line);
    if (lines) return { lines };
  }
  return undefined;
}

function surroundingLines(
  hunks: ReturnType<typeof parseSideBySide>["hunks"],
  side: "left" | "right",
  anchorLine: number,
): ThreadLinePreview["lines"] | undefined {
  for (const hunk of hunks) {
    const cells = hunk.rows
      .map((row) => row[side])
      .filter(
        (cell): cell is typeof cell & { line: number; text: string } =>
          cell.line != null && cell.text != null,
      );
    const anchorIndex = cells.findIndex((cell) => cell.line === anchorLine);
    if (anchorIndex < 0) continue;
    // Duo commonly anchors a block-level finding on its closing delimiter. In
    // that case the useful range is entirely above the anchor; lines after it
    // usually belong to the next method or statement.
    const linesAfter = /^[}\])]+[;,]?$/.test(cells[anchorIndex]!.text.trim())
      ? 0
      : PREVIEW_LINES_AFTER;
    return cells
      .slice(
        Math.max(0, anchorIndex - PREVIEW_LINES_BEFORE),
        anchorIndex + linesAfter + 1,
      )
      .map((cell) => ({
        kind: cell.kind,
        line: cell.line,
        text: cell.text,
      }));
  }
  return undefined;
}

function anchorLineLabel(anchor: NonNullable<PullRequestThreadView["anchor"]>): string {
  const start =
    anchor.range?.start.newLine ?? anchor.range?.start.oldLine;
  const end = anchor.range?.end.newLine ?? anchor.range?.end.oldLine;
  if (start != null && end != null) {
    return start === end ? `:${start}` : `:${start}-${end}`;
  }
  return anchor.line != null ? `:${anchor.line}` : "";
}

/** Repository paths run long; the file and its parent directory are what identifies it. */
function shortPath(path: string): string {
  const parts = path.split("/");
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}
