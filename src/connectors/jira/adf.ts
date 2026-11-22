/**
 * Atlassian Document Format, the only description format REST v3 accepts.
 *
 * v2 took a plain string with wiki markup; v3 takes a JSON document tree and
 * rejects a string outright. That makes this file unavoidable rather than a
 * nicety — and it is why the trace formatter produces plain text: plain text is
 * the one thing that goes into a terminal, a SQLite row and a `codeBlock` without
 * escaping.
 */

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
}

export interface AdfDocument {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

/**
 * Jira rejects a description over roughly 32,767 characters with a 400 that names
 * no field, so the cap is applied here rather than discovered in production. The
 * budget is on the whole document because that is what Jira measures.
 */
export const MAX_DESCRIPTION_CHARS = 30_000;

export function doc(...content: (AdfNode | null | undefined)[]): AdfDocument {
  return { type: "doc", version: 1, content: content.filter(isNode) };
}

export function paragraph(text: string): AdfNode {
  // An empty text node is invalid ADF — Jira 400s on `{type:"text",text:""}` —
  // so an empty paragraph carries no content at all.
  return text === ""
    ? { type: "paragraph" }
    : { type: "paragraph", content: [{ type: "text", text }] };
}

export function heading(text: string, level = 3): AdfNode {
  return {
    type: "heading",
    attrs: { level },
    content: [{ type: "text", text }],
  };
}

/**
 * A code block. Used for log excerpts: it is monospaced, preserves indentation,
 * and — the reason it matters here — needs no escaping of the `●`, `›` and ANSI
 * remnants that turn up in test output.
 */
export function codeBlock(text: string, language?: string): AdfNode {
  const body = text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  return {
    type: "codeBlock",
    attrs: language ? { language } : {},
    // Same rule as paragraph: no empty text node.
    ...(body === "" ? {} : { content: [{ type: "text", text: body }] }),
  };
}

export function bulletList(items: string[]): AdfNode {
  return {
    type: "bulletList",
    content: items.map((item) => ({
      type: "listItem",
      content: [paragraph(item)],
    })),
  };
}

/** A link rendered as its own paragraph, e.g. the pipeline or job URL. */
export function linkParagraph(text: string, href: string): AdfNode {
  return {
    type: "paragraph",
    content: [
      { type: "text", text, marks: [{ type: "link", attrs: { href } }] },
    ],
  };
}

export function rule(): AdfNode {
  return { type: "rule" };
}

/**
 * Trims a document to fit Jira's limit, dropping whole nodes from the end.
 *
 * Whole nodes rather than a character cut: a truncated ADF tree is still valid
 * JSON, so a cut mid-node would produce a document Jira accepts and renders
 * wrongly. Dropping from the end keeps the summary and the first failures, which
 * are the part worth reading.
 */
export function fitDocument(
  document: AdfDocument,
  maxChars = MAX_DESCRIPTION_CHARS,
): AdfDocument {
  if (JSON.stringify(document).length <= maxChars) return document;

  const kept: AdfNode[] = [];
  // Reserve room for the notice appended below, so adding it cannot push the
  // document back over the limit.
  const notice = paragraph("… truncated to fit Jira's description limit.");
  const reserve = JSON.stringify(notice).length + 32;

  for (const node of document.content) {
    const candidate = { ...document, content: [...kept, node] };
    if (JSON.stringify(candidate).length > maxChars - reserve) break;
    kept.push(node);
  }

  return { ...document, content: [...kept, notice] };
}

function isNode(node: AdfNode | null | undefined): node is AdfNode {
  return node != null;
}

/**
 * The other direction: an ADF document as plain text, for reading rather than
 * writing.
 *
 * A ticket's description arrives as ADF and has to reach an agent as prose. This
 * is deliberately lossy and deliberately total — it takes `unknown`, walks
 * whatever it finds, and never throws. Atlassian adds node types (panels, media,
 * expands, macros) without notice, and a renderer that failed on an unfamiliar
 * one would fail the ticket rather than the formatting. So the rule is: emit the
 * text of anything that has text, keep block boundaries, and ignore the rest.
 */
export function adfToText(node: unknown): string {
  return collapseBlankLines(render(node).trim());
}

/** Node types that end a line, so paragraphs do not run together. */
const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "codeBlock",
  "blockquote",
  "listItem",
  "panel",
  "rule",
  "tableRow",
  "mediaSingle",
  "expand",
]);

function render(value: unknown): string {
  if (Array.isArray(value)) return value.map(render).join("");
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  const node = value as { type?: unknown; text?: unknown; content?: unknown; attrs?: unknown };
  if (typeof node.text === "string") return node.text;

  const type = typeof node.type === "string" ? node.type : "";
  if (type === "hardBreak") return "\n";
  if (type === "rule") return "\n---\n";
  if (type === "inlineCard" || type === "blockCard" || type === "embedCard") {
    return smartLinkUrl(node.attrs) ?? "";
  }
  // A mention or an emoji carries its label in attrs and nothing in content, so
  // dropping it would silently remove the person a sentence is about.
  if (type === "mention" || type === "emoji") {
    const attrs = node.attrs as { text?: unknown; shortName?: unknown } | undefined;
    const label = attrs?.text ?? attrs?.shortName;
    return typeof label === "string" ? label : "";
  }

  const inner = render(node.content);
  if (type === "listItem") return `- ${inner.trim()}\n`;
  if (type === "codeBlock") return `\n\`\`\`\n${inner.replace(/\n+$/, "")}\n\`\`\`\n`;
  if (type === "tableCell" || type === "tableHeader") return `${inner.trim()} | `;
  return BLOCK_TYPES.has(type) ? `${inner}\n` : inner;
}

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

/**
 * The same document as Markdown, for reading by a person rather than an agent.
 *
 * `adfToText` throws the formatting away, which is right for a prompt and wrong for
 * a panel: a bug report is mostly structure — numbered repro steps, a table of
 * environments, a fenced stack trace — and flattening it into one run of lines is
 * what makes reading a ticket here worse than reading it in Jira. Markdown is the
 * carrier because it survives a JSON response, a cache and a `<pre>` unharmed,
 * where HTML would have to be sanitised at the other end.
 *
 * Total and lossy in exactly the same way as `adfToText`, and for the same reason:
 * Atlassian ships node types without notice, so anything unrecognised has its
 * children rendered rather than failing the ticket. What it does not do is guess —
 * a node type it has never heard of contributes its text and no syntax.
 *
 * Text is escaped, which matters more here than it looks: a description that
 * literally contains `*` or `<td>` must not come out the other end as emphasis or
 * as a swallowed HTML tag. The client renderer is `web/src/components/Markdown.tsx`
 * and reads only what this function writes.
 */
export function adfToMarkdown(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return collapseBlankLines(blocks(childrenOf(value)).trim());
}

/** Distinct Smart Link URLs in document order, for optional server-side previews. */
export function adfSmartLinkUrls(value: unknown): string[] {
  const urls: string[] = [];

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const type = typeOf(node);
    if (type === "inlineCard" || type === "blockCard" || type === "embedCard") {
      const url = smartLinkUrl(attrsOf(node));
      if (url && !urls.includes(url)) urls.push(url);
    }
    for (const child of childrenOf(node)) visit(child);
  };

  visit(value);
  return urls;
}

/** Attachment filenames referenced by ADF media nodes, in document order. */
export function adfMediaFilenames(value: unknown): string[] {
  const names: string[] = [];

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeOf(node) === "media") {
      const name = mediaName(node);
      if (name && !names.includes(name)) names.push(name);
    }
    for (const child of childrenOf(node)) visit(child);
  };

  visit(value);
  return names;
}

function childrenOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const content = (value as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

function typeOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" ? type : "";
}

function attrsOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const attrs = (value as { attrs?: unknown }).attrs;
  return attrs && typeof attrs === "object" ? (attrs as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Blocks are separated by a blank line, which is the one thing Markdown insists on. */
function blocks(nodes: readonly unknown[]): string {
  return nodes
    .map(block)
    .filter((text) => text.trim() !== "")
    .join("\n\n");
}

function block(node: unknown): string {
  if (typeof node === "string") return escapeText(node);
  const type = typeOf(node);
  const children = childrenOf(node);

  switch (type) {
    case "paragraph":
      return escapeBlockStarts(inlines(children));
    case "heading": {
      const level = Number(attrsOf(node).level);
      const hashes = "#".repeat(Number.isFinite(level) ? Math.min(Math.max(level, 1), 6) : 3);
      return `${hashes} ${inlines(children)}`;
    }
    case "codeBlock":
      return fence(plain(children), str(attrsOf(node).language));
    case "blockquote":
      return quote(blocks(children));
    case "rule":
      return "---";
    case "bulletList":
      return list(node, false);
    case "orderedList":
      return list(node, true);
    case "taskList":
      return list(node, false);
    case "decisionList":
      return list(node, false);
    case "table":
      return table(node);
    case "panel":
      return panel(node);
    case "mediaSingle":
    case "mediaGroup":
      return children.map(media).filter(Boolean).join("\n\n");
    case "media":
      return media(node);
    case "blockCard":
    case "embedCard":
      return smartLink(node);
    case "expand":
    case "nestedExpand": {
      // No `<details>`, because the client renders no raw HTML. The title becomes a
      // heading-ish line so a collapsed section still announces itself.
      const title = str(attrsOf(node).title);
      const body = blocks(children);
      return title ? `**${escapeText(title)}**\n\n${body}` : body;
    }
    default:
      // Includes `doc` and anything Atlassian added since. A node with text but no
      // recognised block type is inline content that lost its paragraph.
      return children.length > 0 || typeof (node as { text?: unknown })?.text === "string"
        ? escapeBlockStarts(children.length > 0 ? blocks(children) : inlines([node]))
        : "";
  }
}

/** List items, including task items — GFM checkboxes, which Jira's task lists are. */
function list(node: unknown, ordered: boolean): string {
  const start = Number(attrsOf(node).order);
  const first = ordered && Number.isFinite(start) ? start : 1;

  return childrenOf(node)
    .map((item, index) => {
      const marker =
        typeOf(item) === "taskItem"
          ? attrsOf(item).state === "DONE"
            ? "- [x] "
            : "- [ ] "
          : ordered
            ? `${first + index}. `
            : "- ";
      const body = blocks(childrenOf(item)) || inlines(childrenOf(item));
      return hang(marker, body);
    })
    .filter((text) => text.trim() !== "")
    .join("\n");
}

/** A marker on the first line, everything after it indented under it. */
function hang(marker: string, body: string): string {
  const pad = " ".repeat(marker.length);
  const [head = "", ...rest] = body.split("\n");
  return [
    marker + head,
    ...rest.map((line) => (line === "" ? "" : pad + line)),
  ].join("\n");
}

/**
 * A GFM table.
 *
 * Cells are flattened to one line because a Markdown table cell cannot hold blocks
 * — a cell with two paragraphs in Jira becomes one sentence here, which is the
 * least-bad option and still beats losing the columns. A table whose first row is
 * not headers gets an empty header row, because GFM has no way to write a table
 * without one.
 */
function table(node: unknown): string {
  const rows = childrenOf(node).filter((row) => typeOf(row) === "tableRow");
  if (rows.length === 0) return "";

  const cells = rows.map((row) =>
    childrenOf(row).map((cell) => oneLine(blocks(childrenOf(cell)))),
  );
  const width = Math.max(...cells.map((row) => row.length));
  const pad = (row: string[]) => [...row, ...Array(width - row.length).fill("")];

  const headed =
    childrenOf(rows[0]).length > 0 &&
    childrenOf(rows[0]).every((cell) => typeOf(cell) === "tableHeader");
  const head = pad(headed ? cells[0]! : Array(width).fill(""));
  const body = (headed ? cells.slice(1) : cells).map(pad);
  const row = (values: string[]) => `| ${values.join(" | ")} |`;

  return [row(head), row(head.map(() => "---")), ...body.map(row)].join("\n");
}

/** Jira's coloured callouts. A blockquote with its kind named, since Markdown has no panel. */
function panel(node: unknown): string {
  const kind = str(attrsOf(node).panelType);
  const label = kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : undefined;
  const body = blocks(childrenOf(node));
  return quote(label ? `**${label}**\n\n${body}` : body);
}

/**
 * An attachment or embedded image placeholder.
 *
 * Jira's media URLs are authenticated and short-lived, and the id in the node is
 * not the numeric attachment id used by its content API. The filename survives as
 * a marked link so the browser can match it to the issue's attachment metadata and
 * render the media at this exact document position.
 */
function media(node: unknown): string {
  const name = mediaName(node) ?? "attachment";
  return `[${escapeText(name)}](<#talos-attachment> "talos-attachment")`;
}

function mediaName(node: unknown): string | undefined {
  const attrs = attrsOf(node);
  return str(attrs.alt) ?? str(attrs.__fileName);
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

/** A fence long enough to survive a body that itself contains one. */
function fence(body: string, language?: string): string {
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${language ?? ""}\n${body.replace(/\n+$/, "")}\n${ticks}`;
}

function oneLine(text: string): string {
  return (
    text
      .replace(/\s*\n+\s*/g, " ")
      // A cell's own text is already escaped; this catches a pipe that arrived inside
      // a code span, where it would still end the column early.
      .replace(/(?<!\\)\|/g, "\\|")
      .trim()
  );
}

function inlines(nodes: readonly unknown[]): string {
  return nodes.map(inline).join("");
}

function inline(node: unknown): string {
  if (typeof node === "string") return escapeText(node);
  if (!node || typeof node !== "object") return "";

  const text = (node as { text?: unknown }).text;
  if (typeof text === "string") return marked(text, (node as { marks?: unknown }).marks);

  const type = typeOf(node);
  const attrs = attrsOf(node);

  switch (type) {
    // Two trailing spaces would be eaten by any trim on the way here; a trailing
    // backslash is the other CommonMark hard break and survives one.
    case "hardBreak":
      return "\\\n";
    case "mention":
      return escapeText(str(attrs.text) ?? "");
    case "emoji":
      return emojiMarkdown(attrs);
    case "date":
      return escapeText(isoDay(attrs.timestamp));
    // A Jira status lozenge — "IN PROGRESS". Code-spanned so it keeps the look of a
    // label rather than reading as a shouted word in the middle of a sentence.
    case "status":
      return code(str(attrs.text) ?? "");
    case "inlineCard":
    case "blockCard":
    case "embedCard": {
      const url = smartLinkUrl(attrs);
      return url ? `<${url}>` : "";
    }
    case "hardbreak":
      return "\\\n";
    default:
      return inlines(childrenOf(node));
  }
}

function emojiMarkdown(attrs: Record<string, unknown>): string {
  const text = str(attrs.text);
  const shortName = str(attrs.shortName);
  if (
    text === "❌" ||
    shortName === ":x:" ||
    shortName === ":cross_mark:"
  ) {
    return '[❌](<#talos-failure> "talos-failure")';
  }
  return escapeText(text ?? shortName ?? "");
}

/**
 * A standalone Jira Smart Link.
 *
 * Jira stores card and embed appearances as top-level nodes with no text content,
 * so the generic unknown-node fallback used to erase them completely. The title
 * marks this as a card for Talos's Markdown renderer; it remains ordinary, useful
 * Markdown in any other renderer and always exposes the destination itself.
 */
function smartLink(node: unknown): string {
  const attrs = attrsOf(node);
  const url = smartLinkUrl(attrs);
  if (!url) return "";
  const label = smartLinkLabel(attrs, url);
  return `[${escapeText(label)}](<${url.replace(/[\\<>]/g, (char) => `\\${char}`)}> "talos-smart-link")`;
}

function smartLinkUrl(value: unknown): string | undefined {
  const attrs =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const data =
    attrs.data && typeof attrs.data === "object"
      ? (attrs.data as Record<string, unknown>)
      : {};
  return str(attrs.url) ?? str(data.url);
}

function smartLinkLabel(attrs: Record<string, unknown>, url: string): string {
  const data =
    attrs.data && typeof attrs.data === "object"
      ? (attrs.data as Record<string, unknown>)
      : {};
  const supplied = str(data.name) ?? str(data.title);
  if (supplied) return supplied;

  try {
    const parsed = new URL(url);
    return parsed.pathname.startsWith("/wiki/") ? "Confluence page" : parsed.hostname;
  } catch {
    return "Smart link";
  }
}

/** One text node with its marks. Code wins outright — nothing nests inside it. */
function marked(text: string, marks: unknown): string {
  const all = Array.isArray(marks) ? marks : [];
  const has = (type: string) => all.some((mark) => typeOf(mark) === type);
  const href = str(attrsOf(all.find((mark) => typeOf(mark) === "link")).href);

  if (has("code")) {
    const out = code(text);
    return href ? `[${out}](${href})` : out;
  }

  /*
   * ADF marks commonly include the space after a label (for example Jira stores
   * "Current behavior: " as one strong node). Markdown closing delimiters are not
   * valid after whitespace, so wrapping that node verbatim produces
   * `**Current behavior: **` and react-markdown displays the asterisks as text.
   * Keep boundary whitespace outside every mark; whitespace-only marked nodes
   * then remain whitespace instead of becoming an empty-looking `** **`.
   */
  const [, leading = "", core = "", trailing = ""] =
    text.match(/^(\s*)([\s\S]*?)(\s*)$/) ?? [];
  if (core === "") return text;

  let out = escapeText(core);
  if (has("strong")) out = `**${out}**`;
  if (has("em")) out = `*${out}*`;
  if (has("strike")) out = `~~${out}~~`;
  // The link goes outermost so the whole styled run is clickable, and an empty label
  // falls back to the URL rather than producing `[](…)`, which renders as nothing.
  if (href) out = `[${out.trim() === "" ? escapeText(href) : out}](${href})`;
  return `${leading}${out}${trailing}`;
}

function code(text: string): string {
  if (text === "") return "";
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  // A code span starting or ending in a backtick needs the padding spaces, which
  // CommonMark then strips back off.
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

function isoDay(timestamp: unknown): string {
  const ms = Number(timestamp);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

/** The raw text of a subtree, for a code block — where escaping would be wrong. */
function plain(nodes: readonly unknown[]): string {
  return nodes
    .map((node) => {
      if (typeof node === "string") return node;
      const text = (node as { text?: unknown })?.text;
      if (typeof text === "string") return text;
      if (typeOf(node) === "hardBreak") return "\n";
      return plain(childrenOf(node));
    })
    .join("");
}

/**
 * Characters that would otherwise be read as syntax.
 *
 * `<` is in the set for a reason that is easy to miss: the client renders no raw
 * HTML, so an unescaped `<td>` in a description would not appear wrong — it would
 * silently disappear.
 */
const INLINE_SYNTAX = /[\\`*_[\]<>|~]/g;

function escapeText(text: string): string {
  return text.replace(INLINE_SYNTAX, (char) => `\\${char}`);
}

/**
 * Markers that only mean something at the start of a line, escaped there only —
 * escaping every `#` and `-` in a paragraph would litter it with backslashes for
 * the one in ten that begins a line.
 */
function escapeBlockStarts(text: string): string {
  return text.replace(/^(\s*)([#>+=-]|\d+[.)])(\s|$)/gm, "$1\\$2$3");
}
