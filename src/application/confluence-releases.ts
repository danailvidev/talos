/**
 * The release catalogue maintained by QA in Confluence.
 *
 * The page is intentionally parsed from ADF rather than from rendered text:
 * rendered tables lose their cell boundaries, which makes the adjacent Prod,
 * Suggested and Tickets columns impossible to distinguish reliably.
 */
export interface ConfluenceReleaseSuggestion {
  service: string;
  version: string;
}

export interface ConfluenceRelease {
  title: string;
  suggestions: ConfluenceReleaseSuggestion[];
}

interface AdfNode {
  type?: unknown;
  text?: unknown;
  content?: unknown;
  attrs?: unknown;
  marks?: unknown;
}

/** Linked child pages in the release index, in document order. */
export function parseConfluenceReleaseLinks(
  document: unknown,
): { title: string; url: string }[] {
  const links = new Map<string, string>();

  function add(url: unknown, title: string) {
    if (typeof url !== "string" || url.trim() === "") return;
    const cleanTitle = oneLine(title);
    const existing = links.get(url);
    links.set(
      url,
      existing && cleanTitle && !existing.includes(cleanTitle)
        ? `${existing} ${cleanTitle}`
        : existing || cleanTitle,
    );
  }

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;

    const node = value as AdfNode;
    if (typeof node.text === "string" && Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (!mark || typeof mark !== "object") continue;
        const typed = mark as { type?: unknown; attrs?: unknown };
        if (typed.type !== "link" || !typed.attrs || typeof typed.attrs !== "object") continue;
        add((typed.attrs as Record<string, unknown>).href, node.text);
      }
    }

    if (["inlineCard", "blockCard", "embedCard"].includes(typeOf(node))) {
      const attrs =
        node.attrs && typeof node.attrs === "object"
          ? (node.attrs as Record<string, unknown>)
          : {};
      add(attrs.url, typeof attrs.title === "string" ? attrs.title : "");
    }

    visit(node.content);
  }

  visit(document);
  return [...links].map(([url, title]) => ({ title: title || titleFromUrl(url), url }));
}

/** Concrete Suggested values from every release table on one detail page. */
export function parseConfluenceReleaseSuggestions(
  document: unknown,
): ConfluenceReleaseSuggestion[] {
  const suggestions = new Map<string, ConfluenceReleaseSuggestion>();

  function visit(value: unknown): void {
    for (const node of children(value)) {
      if (typeOf(node) === "table") {
        for (const suggestion of suggestionsFromTable(node)) {
          suggestions.set(normalise(suggestion.service), suggestion);
        }
      } else {
        visit(node);
      }
    }
  }

  visit(document);
  return [...suggestions.values()];
}

/** Extract release titles and concrete values from each table's Suggested column. */
export function parseConfluenceReleases(document: unknown): ConfluenceRelease[] {
  const releases = new Map<string, ConfluenceRelease>();

  function add(title: string, suggestions: ConfluenceReleaseSuggestion[]) {
    const cleanTitle = oneLine(title);
    if (!cleanTitle || suggestions.length === 0) return;

    const release = releases.get(cleanTitle) ?? { title: cleanTitle, suggestions: [] };
    const byService = new Map(
      release.suggestions.map((suggestion) => [normalise(suggestion.service), suggestion]),
    );
    for (const suggestion of suggestions) {
      byService.set(normalise(suggestion.service), suggestion);
    }
    release.suggestions = [...byService.values()];
    releases.set(cleanTitle, release);
  }

  function scan(value: unknown, inheritedTitle = ""): string {
    const nodes = children(value);
    let activeTitle = inheritedTitle;

    for (const node of nodes) {
      const type = typeOf(node);
      if (type === "heading") {
        activeTitle = textOf(node);
        continue;
      }

      if (type === "expand" || type === "nestedExpand") {
        const title = stringAttr(node, "title") || activeTitle;
        scan(node, title);
        continue;
      }

      if (type === "table") {
        add(activeTitle, suggestionsFromTable(node));
        continue;
      }

      if (children(node).length > 0) {
        scan(node, activeTitle);
      }
    }
    return activeTitle;
  }

  scan(document);
  return [...releases.values()];
}

function suggestionsFromTable(table: unknown): ConfluenceReleaseSuggestion[] {
  const rows = tableGrid(table);
  const headerIndex = rows.findIndex((row) =>
    row.some((cell) => normalise(cell) === "suggested"),
  );
  if (headerIndex < 0) return [];

  const header = rows[headerIndex]!;
  const suggestedIndex = header.findIndex((cell) => normalise(cell) === "suggested");
  const prodIndex = header.findIndex((cell) => {
    const value = normalise(cell);
    return value === "prod" || value === "production";
  });
  // The QA table currently calls its first column "version". Prefer the column
  // immediately before Prod, while retaining a safe first-column fallback if the
  // header is renamed.
  const serviceIndex = prodIndex > 0 ? prodIndex - 1 : 0;

  return rows.slice(headerIndex + 1).flatMap((row) => {
    const service = oneLine(row[serviceIndex] ?? "");
    const version = oneLine(row[suggestedIndex] ?? "");
    if (!service || !version || normalise(version) === "unchanged") return [];
    return [{ service, version }];
  });
}

/**
 * Expand ADF row/column spans into a stable logical grid.
 *
 * The QA page groups rows under a leading "version" cell. Confluence represents
 * that as one cell with a large rowspan and omits the covered cell from later
 * rows; reading physical indexes directly would therefore mistake the PROD value
 * for the service name after the first row.
 */
function tableGrid(table: unknown): string[][] {
  const physicalRows = children(table).filter((node) => typeOf(node) === "tableRow");
  const spans = new Map<number, number>();
  const rows: string[][] = [];

  for (let rowIndex = 0; rowIndex < physicalRows.length; rowIndex += 1) {
    const values: string[] = [];
    let column = 0;

    for (const cell of children(physicalRows[rowIndex])) {
      while ((spans.get(column) ?? 0) > rowIndex) {
        values[column] = "";
        column += 1;
      }

      const colspan = Math.max(1, numberAttr(cell, "colspan"));
      const rowspan = Math.max(1, numberAttr(cell, "rowspan"));
      values[column] = textOf(cell);
      for (let offset = 1; offset < colspan; offset += 1) {
        values[column + offset] = "";
      }
      if (rowspan > 1) {
        for (let offset = 0; offset < colspan; offset += 1) {
          spans.set(column + offset, rowIndex + rowspan);
        }
      }
      column += colspan;
    }

    const lastSpannedColumn = Math.max(-1, ...spans.keys());
    while (column <= lastSpannedColumn) {
      if ((spans.get(column) ?? 0) > rowIndex) values[column] = "";
      column += 1;
    }
    rows.push(values);
  }

  return rows;
}

function children(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  const content = (value as AdfNode).content;
  return Array.isArray(content) ? content : [];
}

function typeOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const type = (value as AdfNode).type;
  return typeof type === "string" ? type : "";
}

function textOf(value: unknown): string {
  if (Array.isArray(value)) return oneLine(value.map(textOf).join(" "));
  if (!value || typeof value !== "object") return typeof value === "string" ? value : "";

  const node = value as AdfNode;
  if (typeof node.text === "string") return node.text;
  if (typeOf(node) === "hardBreak") return " ";
  return oneLine(children(node).map(textOf).join(" "));
}

function stringAttr(value: unknown, name: string): string {
  if (!value || typeof value !== "object") return "";
  const attrs = (value as AdfNode).attrs;
  if (!attrs || typeof attrs !== "object") return "";
  const result = (attrs as Record<string, unknown>)[name];
  return typeof result === "string" ? result : "";
}

function numberAttr(value: unknown, name: string): number {
  if (!value || typeof value !== "object") return 1;
  const attrs = (value as AdfNode).attrs;
  if (!attrs || typeof attrs !== "object") return 1;
  const result = Number((attrs as Record<string, unknown>)[name]);
  return Number.isInteger(result) && result > 0 ? result : 1;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalise(value: string): string {
  return oneLine(value).toLocaleLowerCase();
}

function titleFromUrl(rawUrl: string): string {
  try {
    const segment = new URL(rawUrl).pathname.split("/").filter(Boolean).at(-1) ?? "";
    return oneLine(decodeURIComponent(segment).replace(/\+/g, " "));
  } catch {
    return rawUrl;
  }
}
