/**
 * Unified diff → side-by-side rows.
 *
 * The forge hands us the same text `git diff` prints, and a two-column view needs
 * it pivoted: a run of removals paired positionally against the run of additions
 * that follows it, so a changed line sits opposite the line it replaced. Where the
 * runs are uneven the shorter side gets blank cells, which is what makes an
 * insertion read as an insertion rather than as everything below it shifting.
 *
 * Pure and self-contained on purpose — no forge vocabulary, no React — so the
 * pairing rules can be reasoned about (and, if it ever earns it, tested) without a
 * merge request in hand.
 */

export type DiffCellKind = "context" | "add" | "remove" | "empty";

export interface DiffCell {
  kind: DiffCellKind;
  /** Absent on an `empty` cell, which stands for "this side has no line here". */
  line?: number;
  text?: string;
}

export interface DiffRow {
  left: DiffCell;
  right: DiffCell;
}

export interface DiffHunk {
  /** The `@@ … @@` line verbatim, including any trailing section heading git added. */
  header: string;
  rows: DiffRow[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** Set when the text was not a diff we could read — the raw text is shown instead. */
  unparsed?: boolean;
}

const EMPTY: DiffCell = { kind: "empty" };

/** `@@ -12,7 +12,9 @@ optional section heading` */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * File-level preamble git prints before the first hunk. Dropped rather than
 * rendered: the pane already says which file this is, and what changed about its
 * mode is not what somebody opened the Changes tab to read.
 */
const PREAMBLE =
  /^(diff --git |index |--- |\+\+\+ |old mode |new mode |deleted file |new file |similarity index |rename |copy |Binary files )/;

export function parseSideBySide(diff: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;

  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  // Held back rather than emitted immediately: a removal can only be placed once
  // we know whether an addition arrives to sit opposite it.
  let removed: DiffCell[] = [];
  let added: DiffCell[] = [];

  const flush = () => {
    if (hunk) {
      for (let index = 0; index < Math.max(removed.length, added.length); index += 1) {
        hunk.rows.push({ left: removed[index] ?? EMPTY, right: added[index] ?? EMPTY });
      }
    }
    removed = [];
    added = [];
  };

  for (const raw of diff.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      flush();
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunk = { header: raw, rows: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue; // Preamble, or leading noise before the first hunk.
    if (PREAMBLE.test(raw)) continue;
    // "\ No newline at end of file" is a note about the line above, not a line.
    if (raw.startsWith("\\")) continue;

    const marker = raw.charAt(0);
    const text = raw.slice(1);

    if (marker === "-") {
      deletions += 1;
      removed.push({ kind: "remove", line: oldLine, text });
      oldLine += 1;
    } else if (marker === "+") {
      additions += 1;
      added.push({ kind: "add", line: newLine, text });
      newLine += 1;
    } else if (marker === " " || raw === "") {
      // An empty string is a context line whose content is empty: git writes the
      // leading space, but trailing whitespace gets stripped in transit often
      // enough that treating it as context is the safer reading.
      flush();
      hunk.rows.push({
        left: { kind: "context", line: oldLine, text },
        right: { kind: "context", line: newLine, text },
      });
      oldLine += 1;
      newLine += 1;
    }
    // Anything else inside a hunk is not diff syntax; skipping it keeps one odd
    // line from throwing the line numbering off for the rest of the file.
  }
  flush();

  if (hunks.length === 0) return { hunks: [], additions: 0, deletions: 0, unparsed: true };
  return { hunks, additions, deletions };
}
