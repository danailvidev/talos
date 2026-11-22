import { createHash } from "node:crypto";
import type {
  MergeRequestDiscussion,
  MergeRequestDiscussionNote,
} from "../../connectors/gitlab/types.ts";

/** Where a diff comment sits. A merge-request comment has none. */
export interface DiscussionAnchor {
  path: string;
  line?: number;
  oldLine?: number;
  newLine?: number;
  range?: {
    start: { oldLine?: number; newLine?: number };
    end: { oldLine?: number; newLine?: number };
  };
}

export interface PendingDiscussion {
  discussionId: string;
  noteId: number;
  resolvableNoteId?: number;
  /**
   * `path:line` of the diff comment. Reviewers often leave the file name out of
   * the body ("prefer real entities"), so without this the agent treats every
   * similar note as one file and edits whatever the latest commit happened to
   * touch.
   */
  location?: string;
  anchor?: DiscussionAnchor;
  body: string;
  author: string;
  notes: {
    id: number;
    author: string;
    body: string;
    createdAt: string;
  }[];
}

/**
 * A resolvable thread remains actionable until a reviewer resolves it. Plain
 * discussion notes have no resolved flag, so only an unanswered question is
 * actionable there. A later reviewer note makes the thread pending again
 * under a new note id.
 */
export function pendingDiscussions(
  discussions: readonly MergeRequestDiscussion[],
): PendingDiscussion[] {
  const pending: PendingDiscussion[] = [];

  for (const discussion of discussions) {
    const notes = discussion.notes.filter((note) => note.system !== true);
    const latest = notes.at(-1);
    if (!latest) continue;
    if (isBotAuthor(latest.author)) continue;

    const resolvable = notes.filter((note) => note.resolvable === true);
    const unresolvedNote = resolvable.find((note) => note.resolved !== true);
    const unresolved = unresolvedNote != null;
    if (!unresolved && !looksLikeQuestion(latest)) continue;

    const anchor = discussionAnchor(notes);
    pending.push({
      discussionId: discussion.id,
      noteId: latest.id,
      ...(unresolvedNote ? { resolvableNoteId: unresolvedNote.id } : {}),
      ...(anchor ? { location: formatLocation(anchor), anchor } : {}),
      body: latest.body,
      author: latest.author.username,
      notes: notes.map(toContextNote),
    });
  }

  return pending;
}

/** Distinct anchored paths, in first-seen order. */
export function anchoredFiles(pending: readonly PendingDiscussion[]): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const item of pending) {
    const path = item.anchor?.path;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    files.push(path);
  }
  return files;
}

/**
 * A stable name for "this exact set of unanswered threads".
 *
 * The subject here is the merge request, but what makes it actionable is its
 * pending feedback — so the fingerprint has to be the feedback, not the head sha.
 * A reviewer adding a note changes the set and makes the MR actionable again; a
 * push that touches no discussion does not. Sorted, so the order GitLab happens
 * to return threads in cannot manufacture a change. Hashed because the raw list
 * grows without bound on a busy MR, and this lands in an indexed column.
 */
export function pendingFingerprint(pending: readonly PendingDiscussion[]): string {
  const keys = pending
    .map((item) => `${item.discussionId}:${item.noteId}`)
    .sort()
    .join(",");
  return createHash("sha1").update(keys).digest("hex").slice(0, 16);
}

export function discussionEventId(
  projectId: string,
  mrIid: number,
  discussion: Pick<PendingDiscussion, "discussionId" | "noteId">,
): string {
  return `${projectId}!${mrIid}:${discussion.discussionId}:${discussion.noteId}`;
}

function looksLikeQuestion(note: MergeRequestDiscussionNote): boolean {
  return /\?/.test(note.body);
}

/**
 * Service accounts like SonarQube/CI bots post status notes ("Quality Gate
 * passed") that GitLab may leave unresolved; without this they get claimed as
 * reviewer feedback and answered with a spam reply. GitLab flags real bot
 * users with `bot: true`, but token-based integrations often show up as a
 * plain user, so a username pattern backs that up.
 */
const BOT_USERNAME_PATTERN = /(^|[-_])(bot|sonar|sonarqube|sonarcloud)([-_]|$)/i;

function isBotAuthor(author: { username: string; bot?: boolean }): boolean {
  return author.bot === true || BOT_USERNAME_PATTERN.test(author.username);
}

function discussionAnchor(
  notes: readonly MergeRequestDiscussionNote[],
): DiscussionAnchor | undefined {
  const position = notes.find(
    (note) => note.position?.new_path || note.position?.old_path,
  )?.position;
  if (!position) return undefined;
  const path = position.new_path ?? position.old_path;
  if (!path) return undefined;
  const oldLine = position.old_line ?? undefined;
  const newLine = position.new_line ?? undefined;
  const line = newLine ?? oldLine;
  const rangeStart = rangePoint(position.line_range?.start);
  const rangeEnd = rangePoint(position.line_range?.end);
  return {
    path,
    ...(line != null ? { line } : {}),
    ...(oldLine != null ? { oldLine } : {}),
    ...(newLine != null ? { newLine } : {}),
    ...(rangeStart && rangeEnd ? { range: { start: rangeStart, end: rangeEnd } } : {}),
  };
}

function rangePoint(
  point?: { old_line?: number | null; new_line?: number | null } | null,
): { oldLine?: number; newLine?: number } | undefined {
  if (!point) return undefined;
  const oldLine = point.old_line ?? undefined;
  const newLine = point.new_line ?? undefined;
  if (oldLine == null && newLine == null) return undefined;
  return {
    ...(oldLine != null ? { oldLine } : {}),
    ...(newLine != null ? { newLine } : {}),
  };
}

function formatLocation(anchor: DiscussionAnchor): string {
  return anchor.line != null ? `${anchor.path}:${anchor.line}` : anchor.path;
}

function toContextNote(note: MergeRequestDiscussionNote): PendingDiscussion["notes"][number] {
  return {
    id: note.id,
    author: note.author.username,
    body: note.body,
    createdAt: note.created_at.toISOString(),
  };
}
