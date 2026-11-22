/**
 * Reading what a containerized agent says.
 *
 * Two vocabularies arrive interleaved on one stdout: Claude Code's own
 * `--output-format stream-json` events, and the `{"type":"talos",…}` progress
 * lines our entrypoint prints around the clone/fetch/push it does for the agent.
 * Both are turned into operator-facing log lines here, and both are read for the
 * job's result — the agent's final JSON, and what the entrypoint pushed.
 *
 * Unknown shapes are ignored rather than logged raw: a tool result can be a whole
 * file, and a run log that contains the repository is not a log.
 */

export interface StreamLog {
  message: string;
  /**
   * Omitted means `info`. A failed tool call and a failed run report `error`, so
   * the run log can draw them as failures — before this, every line of a run
   * that died on a bad `git fetch` was styled exactly like a successful file
   * read, and the one line that mattered was invisible in three hundred.
   */
  level?: "info" | "warn" | "error";
  meta?: Record<string, unknown>;
}

/** What the entrypoint reported pushing, if it pushed. */
export interface PushOutcome {
  sha: string;
  branch?: string;
}

/** Provider-reported usage for one CLI invocation. */
export interface AgentUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** The resolved model reported by the CLI, not merely the requested alias. */
  model?: string;
  turns?: number;
  durationMs?: number;
}

/**
 * Retains only the recent diagnostic tail plus the facts required to interpret
 * a completed run. Tool errors are counted as events arrive, so compaction does
 * not make the final reliability signal under-report a long execution.
 */
export class AgentEventAccumulator {
  private sequence = 0;
  private readonly tail: Array<{ sequence: number; value: unknown }> = [];
  private readonly critical = new Map<string, { sequence: number; value: unknown }>();
  private errors = 0;
  private streamUsage: AgentUsageSnapshot | undefined;
  private resultUsage: AgentUsageSnapshot | undefined;
  private model: string | undefined;

  constructor(private readonly tailLimit = 256) {}

  add(value: unknown): void {
    const item = { sequence: this.sequence++, value };
    this.errors += agentToolErrors([value]);
    this.captureUsage(value);
    const key = criticalEventKey(value);
    if (key) this.critical.set(key, item);
    this.tail.push(item);
    if (this.tail.length > this.tailLimit) this.tail.shift();
  }

  toolErrors(): number {
    return this.errors;
  }

  /**
   * Uses the result envelope when available because Claude reports invocation
   * totals there. Assistant-message usage is retained as a fallback for a run
   * that consumed tokens and then failed before producing a result.
   */
  usage(): AgentUsageSnapshot | undefined {
    const usage = this.resultUsage ?? this.streamUsage;
    if (!usage) return undefined;
    return { ...usage, ...(usage.model || !this.model ? {} : { model: this.model }) };
  }

  snapshot(): unknown[] {
    const bySequence = new Map<number, { sequence: number; value: unknown }>();
    for (const item of [...this.tail, ...this.critical.values()]) bySequence.set(item.sequence, item);
    return [...bySequence.values()]
      .sort((a, b) => a.sequence - b.sequence)
      .map((item) => item.value);
  }

  private captureUsage(value: unknown): void {
    if (!isRecord(value)) return;
    if (value.type === "system" && value.subtype === "init" && typeof value.model === "string") {
      this.model = value.model;
    }
    if (value.type === "assistant" && isRecord(value.message)) {
      const usage = tokenUsage(value.message.usage);
      if (usage) this.streamUsage = addUsage(this.streamUsage, usage);
    }
    if (value.type !== "result") return;
    const usage = tokenUsage(value.usage);
    if (!usage) return;
    this.resultUsage = {
      ...usage,
      ...(typeof value.model === "string" ? { model: value.model } : {}),
      ...(typeof value.num_turns === "number" ? { turns: value.num_turns } : {}),
      ...(typeof value.duration_ms === "number" ? { durationMs: value.duration_ms } : {}),
    };
  }
}

function tokenUsage(value: unknown): AgentUsageSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const fields = {
    inputTokens: nonNegativeNumber(value.input_tokens ?? value.inputTokens),
    outputTokens: nonNegativeNumber(value.output_tokens ?? value.outputTokens),
    cacheReadInputTokens: nonNegativeNumber(
      value.cache_read_input_tokens ?? value.cacheReadInputTokens,
    ),
    cacheCreationInputTokens: nonNegativeNumber(
      value.cache_creation_input_tokens ?? value.cacheCreationInputTokens,
    ),
  };
  if (Object.values(fields).every((field) => field == null)) return undefined;
  return {
    inputTokens: fields.inputTokens ?? 0,
    outputTokens: fields.outputTokens ?? 0,
    cacheReadInputTokens: fields.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: fields.cacheCreationInputTokens ?? 0,
  };
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function addUsage(
  current: AgentUsageSnapshot | undefined,
  next: AgentUsageSnapshot,
): AgentUsageSnapshot {
  return {
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    cacheReadInputTokens: (current?.cacheReadInputTokens ?? 0) + next.cacheReadInputTokens,
    cacheCreationInputTokens:
      (current?.cacheCreationInputTokens ?? 0) + next.cacheCreationInputTokens,
  };
}

function criticalEventKey(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "result") return "result";
  if (value.type === "talos" && value.event === "push" && value.status === "done") return "push";
  return undefined;
}

/** Per-token/per-turn telemetry, not a diagnostic — fires continuously. */
const NOISY_SYSTEM_SUBTYPES = new Set(["thinking_tokens"]);

export function logsFromStreamLine(line: string): StreamLog[] {
  const text = line.trim();
  if (!text) return [];

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }

  if (event.type === "talos") return logsFromTalos(event);
  if (event.type === "system" && event.subtype === "init") {
    const model = typeof event.model === "string" ? event.model : undefined;
    return [
      {
        message: model ? `claude started (${model})` : "claude started",
        meta: { agent: "claude" },
      },
    ];
  }
  // Every other `system` subtype — a warning, a model-fallback notice, a
  // compaction event — was previously dropped along with unhandled shapes in
  // general. Unlike a tool result or assistant text, a `system` event is a
  // small control signal, not content that could be a whole file, so it is
  // safe to surface in full rather than staying invisible — except the
  // subtypes below, which are per-token/per-turn telemetry pings that fire
  // continuously and would flood the log with nothing diagnostic in them.
  if (event.type === "system" && !NOISY_SYSTEM_SUBTYPES.has(String(event.subtype))) {
    return [
      {
        message: `claude system (${String(event.subtype ?? "unknown")}): ${clip(JSON.stringify(event), 2000)}`,
        level: "warn",
        meta: { agent: "claude" },
      },
    ];
  }
  if (event.type === "assistant") return logsFromAssistant(event);
  if (event.type === "user") return logsFromUser(event);
  if (event.type === "result") {
    const error = event.is_error === true;
    const turns = typeof event.num_turns === "number" ? event.num_turns : undefined;
    return [
      {
        message: error ? "claude finished with an error" : "claude finished",
        ...(error ? { level: "error" as const } : {}),
        meta: { agent: "claude", ...(turns != null ? { turns } : {}) },
      },
    ];
  }
  return [];
}

/**
 * The text of the last `result` event — what `--output-format json` used to print
 * as a single blob. Undefined means the container exited without the agent ever
 * producing an answer, which is a different failure from producing a bad one.
 */
export function agentResultText(events: readonly unknown[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!isRecord(event) || event.type !== "result") continue;
    // `--json-schema` puts the validated object here and leaves `result` as
    // whatever prose the model said around it. The object is the answer.
    if ("structured_output" in event && event.structured_output != null) {
      const structured = event.structured_output;
      return typeof structured === "string" ? structured : JSON.stringify(structured);
    }
    const payload = event.result;
    if (typeof payload === "string") return payload;
    return payload != null ? JSON.stringify(payload) : "";
  }
  return undefined;
}

/**
 * How many of the agent's own tool calls came back as errors.
 *
 * Not a failure on its own — a `grep` that matches nothing, a test command run to
 * see whether it fails, and a `git show` of an object this partial clone does not
 * have are all normal parts of an investigation. It is evidence, and it matters
 * most on a run that concluded there was nothing to change: "no change made" is
 * a very different claim when the commands behind it worked than when three of
 * them errored, and until this was counted the difference lived only in the
 * activity log.
 */
export function agentToolErrors(events: readonly unknown[]): number {
  let errors = 0;
  for (const event of events) {
    if (!isRecord(event) || event.type !== "user") continue;
    for (const block of contentBlocks(event)) {
      if (block.type === "tool_result" && block.is_error === true) errors++;
    }
  }
  return errors;
}

/**
 * Why the agent gave up, in its own words — for the exception, not the log.
 *
 * The container writes its diagnosis to *stdout*, as `stream-json` events, and
 * exits non-zero with an empty stderr. So the failure talos raised said only
 * `failed (exit 1)` while the actual reason ("Failed to authenticate. API Error:
 * 403 …") sat in the run log, one join away from the operator reading the error.
 * This is that line, so the two say the same thing.
 *
 * Read newest-first because the last thing said is the reason it stopped: the
 * error-carrying `result` event when there is one, otherwise the final thing the
 * assistant managed to say.
 */
export function agentFailureReason(events: readonly unknown[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!isRecord(event)) continue;

    if (event.type === "result" && event.is_error === true) {
      const text = firstText(event.result, event.error);
      if (text) return clip(text, 240);
      continue;
    }
    if (event.type === "assistant") {
      for (const block of contentBlocks(event).reverse()) {
        if (block.type !== "text" || typeof block.text !== "string") continue;
        const text = block.text.trim();
        // The reply the run was *for* is not a failure reason; a run that produced
        // one and still exited non-zero failed at something else.
        if (text && !looksLikeFinalJson(text)) return clip(text, 240);
      }
    }
  }
  return undefined;
}

/**
 * A credential the provider rejected, as opposed to work that went wrong.
 *
 * Matched on wording rather than on a status code: the agent CLI reports its
 * provider's answer as prose on stdout, and there is no structured field to read.
 * Deliberately narrow — every pattern here names an authentication or credential
 * failure outright, including the AWS exception names Bedrock answers with. A bare
 * "401"/"403" is *not* matched, because an agent reviewing code that handles those
 * statuses would print them for entirely innocent reasons.
 */
const CREDENTIAL_FAILURE =
  /failed to authenticate|authentication (?:error|failed)|authentication_error|invalid[ _-]?api[ _-]?key|invalid bearer token|invalid[ _-]?credentials?|credentials? (?:are |is )?(?:invalid|expired|missing)|token (?:has )?expired|expired[ _-]?token|please run \/login|AccessDeniedException|UnrecognizedClientException|InvalidSignatureException|ExpiredTokenException|InvalidClientTokenId/i;

export function isCredentialFailure(text: string | undefined): boolean {
  return text != null && CREDENTIAL_FAILURE.test(text);
}

/** The first of these that is a non-empty string. */
function firstText(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

export function pushOutcome(events: readonly unknown[]): PushOutcome | undefined {
  for (const value of events) {
    if (!isRecord(value)) continue;
    if (
      value.type === "talos" &&
      value.event === "push" &&
      value.status === "done" &&
      typeof value.sha === "string"
    ) {
      return {
        sha: value.sha,
        ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
      };
    }
  }
  return undefined;
}

/**
 * The JSON inside a fenced block, or the whole text when the agent skipped the
 * fence. Every prompt in this codebase asks for exactly one fenced block; models
 * comply most of the time, and this is the "most" part.
 */
export function extractJsonBlock(text: string): string {
  const trimmed = text.trim();

  // A `--output-format json` envelope, which wraps the reply under `result`.
  // Unwrapped *before* looking for a fence, because the envelope's own JSON
  // encoding contains the fence too — matching that first yields the block with
  // every quote still backslash-escaped, which no longer parses.
  try {
    const envelope = JSON.parse(trimmed) as unknown;
    if (isRecord(envelope) && "result" in envelope) {
      const inner = String(envelope.result);
      return fencedJson(inner) ?? inner;
    }
  } catch {
    // Not JSON at all; a bare fenced block is the normal case.
  }

  return fencedJson(trimmed) ?? trimmed;
}

/**
 * Greedy on purpose: a JSON string value can legitimately contain its own
 * ``` (release notes with a code sample, a markdown description, ...), and a
 * non-greedy match would stop at that inner fence and hand back a truncated,
 * unparseable prefix. Every prompt in this codebase asks for exactly one
 * fenced block and no other prose, so matching through to the *last* ``` in
 * the reply is the correct read even when the JSON itself contains more.
 */
function fencedJson(text: string): string | undefined {
  return text.match(/```json\s*([\s\S]*)```/)?.[1];
}

/**
 * JSON values the agent may have meant, last one first.
 *
 * Haiku's final answer often *is* the object the prompt asked for, invalidated
 * by a trailing comma, a comment, a raw newline inside a string, or a second
 * ``` later in the reply. The greedy fence match then swallows that prose and
 * `JSON.parse` rejects the run after the commit has already been pushed. Each
 * balanced object is parsed strictly and, if that fails, again after those
 * repairs. Callers keep the first value their schema accepts.
 */
export function modelJsonValues(text: string): unknown[] {
  const source = loosenJson(unwrapResultEnvelope(text.trim()));
  const slices = topLevelJsonSlices(source).reverse();
  if (slices.length === 0 && source) slices.push(source);
  const values: unknown[] = [];
  const seen = new Set<string>();
  for (const slice of slices) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(slice);
    } catch {
      continue;
    }
    const key = JSON.stringify(parsed);
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(parsed);
  }
  return values;
}

/** A `{result: string}` envelope, unwrapped the way `extractJsonBlock` does. */
function unwrapResultEnvelope(text: string): string {
  try {
    const envelope = JSON.parse(text) as unknown;
    if (isRecord(envelope) && typeof envelope.result === "string") return envelope.result;
  } catch {
    // The normal case is the reply itself, not an envelope around it.
  }
  return text;
}

/**
 * Repairs that do not change a value `JSON.parse` would already accept:
 * trailing commas, comments outside strings, and raw newlines inside strings.
 */
function loosenJson(input: string): string {
  const text = input
    .replace(/^\uFEFF/, "")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += text[i] === "*" ? 1 : 0;
      continue;
    }
    if (ch === ",") {
      const next = nextSignificant(text, i + 1);
      if (text[next] === "}" || text[next] === "]") continue;
    }
    out += ch;
  }
  return out.trim();
}

/** The next character that is not whitespace or a comment. */
function nextSignificant(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (/\s/.test(text[i]!)) {
      i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    return i;
  }
  return i;
}

/** Balanced `{...}` / `[...]` values at the top level, strings left intact. */
function topLevelJsonSlices(text: string): string[] {
  const slices: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch !== "{" && ch !== "[") continue;
    const end = matchingJsonEnd(text, i);
    if (end < 0) continue;
    slices.push(text.slice(i, end));
    i = end - 1;
  }
  return slices;
}

function matchingJsonEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function logsFromTalos(event: Record<string, unknown>): StreamLog[] {
  const status = typeof event.status === "string" ? event.status : "";
  if (event.event === "clone") {
    if (status === "started") {
      const project = typeof event.project === "string" ? event.project : "";
      const branch = typeof event.branch === "string" ? event.branch : "";
      return [{ message: `cloning ${project}@${branch}` }];
    }
    if (status === "done") {
      return [{ message: event.source === "cache" ? "clone finished (from repository cache)" : "clone finished" }];
    }
    if (status === "failed") return [{ message: "clone failed" }];
  }
  if (event.event === "fetch-target") {
    if (status === "started") return [{ message: "fetching target branch for MR diff" }];
    if (status === "done") return [{ message: "wrote combined MR diff vs target" }];
    if (status === "failed") {
      return [{ message: "could not fetch target branch; reviewing without MR diff" }];
    }
  }
  if (event.event === "install") {
    if (status === "started") return [{ message: "installing dependencies" }];
    if (status === "done") return [{ message: "dependencies installed" }];
    if (status === "failed") {
      return [{ message: "dependency install failed; claude will verify without them" }];
    }
  }
  if (event.event === "guidelines") {
    if (status === "started") {
      return [{ message: "collecting CLAUDE.md / AGENTS.md / docs/guidelines" }];
    }
    if (status === "done") {
      const files = typeof event.files === "number" ? event.files : undefined;
      const bytes = typeof event.bytes === "number" ? event.bytes : undefined;
      if (files === 0) {
        return [{
          message: "no CLAUDE.md, AGENTS.md, or docs guidelines found",
          level: "warn",
          meta: { guidelineFiles: 0, ...(bytes != null ? { guidelineBytes: bytes } : {}) },
        }];
      }
      return [{
        message:
          files == null
            ? "wrote review guidelines"
            : `collected ${files} repository guideline ${files === 1 ? "file" : "files"}`,
        meta: {
          ...(files != null ? { guidelineFiles: files } : {}),
          ...(bytes != null ? { guidelineBytes: bytes } : {}),
        },
      }];
    }
  }
  if (event.event === "agent" && status === "started") {
    return [{ message: "starting claude agent" }];
  }
  if (event.event === "push") {
    const branch = typeof event.branch === "string" ? event.branch : "";
    if (status === "done") {
      const sha = typeof event.sha === "string" ? event.sha.slice(0, 12) : "";
      return [{ message: `pushed ${sha} to ${branch}`.trim() }];
    }
    if (status === "no-change") return [{ message: "agent left no changes to push" }];
    if (status === "branch-moved") return [{ message: `${branch} moved; nothing pushed`.trim() }];
    if (status === "branch-exists") return [{ message: `${branch} already exists; nothing pushed` }];
  }
  return [];
}

function logsFromAssistant(event: Record<string, unknown>): StreamLog[] {
  const logs: StreamLog[] = [];
  for (const block of contentBlocks(event)) {
    if (block.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "tool";
      // `toolUseId` is what lets the run log pair this call with its result into
      // one row instead of two. Matching on position would work until the agent
      // fires several tools in one turn, which is exactly when it matters.
      const id = typeof block.id === "string" ? block.id : undefined;
      logs.push({
        message: `claude ${name} ${summarizeToolInput(block.input)}`.trim(),
        meta: { agent: "claude", tool: name, ...(id ? { toolUseId: id } : {}) },
      });
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      // The full text decides whether this is the answer; only what gets logged is
      // clipped. Deciding on the clipped snippet would cut the closing fence off a
      // long reply and log the answer as if it were prose.
      const text = block.text.trim();
      if (!text || looksLikeFinalJson(text)) continue;
      const snippet = clip(text, 240);
      // Flagged as the agent talking, as opposed to the entrypoint's progress
      // lines, which reach the log through the same `agent: "claude"` meta. The
      // run log renders this as prose rather than as another console row.
      logs.push({ message: snippet, meta: { agent: "claude", kind: "message" } });
    }
  }
  return logs;
}

function logsFromUser(event: Record<string, unknown>): StreamLog[] {
  const logs: StreamLog[] = [];
  for (const block of contentBlocks(event)) {
    if (block.type !== "tool_result") continue;
    const err = block.is_error === true;
    const body = resultText(block.content);
    const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    logs.push({
      message: err ? `tool error: ${clip(body, 160)}` : `tool returned ${body.length} chars`,
      ...(err ? { level: "error" as const } : {}),
      // `bytes` and `ok` as fields rather than only as prose, so the run log can
      // fold this into the calling row ("Read foo.ts · 22 KB") instead of
      // printing "tool returned 22175 chars" as a line of its own.
      meta: {
        agent: "claude",
        bytes: body.length,
        ok: !err,
        ...(id ? { toolUseId: id } : {}),
      },
    });
  }
  return logs;
}

/**
 * A tool result's text, whether the CLI sent it as a string or as content blocks.
 * The block form used to fall through to `""`, so every image-or-structured
 * result logged "tool returned 0 chars" — indistinguishable from a tool that
 * genuinely returned nothing.
 */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

function contentBlocks(event: Record<string, unknown>): Record<string, unknown>[] {
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

/**
 * What the tool was pointed at, in one line.
 *
 * `command` is in the list because Bash is the tool the agent reaches for most
 * and the only one whose subject is not a path: without it every shell call in
 * the log read `claude Bash` and nothing else, so a run that spent four minutes
 * on `npm test` was indistinguishable from one that ran `git status`. Commands
 * get a longer budget than paths — the interesting part of a shell line is
 * often at the end (`… | grep foo`) — and newlines are folded so a heredoc
 * cannot turn one log line into thirty.
 *
 * Still a whitelist, not a dump of `input`: a `Write` payload is a whole file,
 * and a run log that contains the repository is not a log.
 */
function summarizeToolInput(input: unknown): string {
  if (!isRecord(input)) return "";
  const parts: string[] = [];
  for (const key of ["file_path", "path", "pattern", "glob", "query", "url"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) parts.push(clip(value, 120));
  }
  if (typeof input.command === "string" && input.command.trim()) {
    parts.push(clip(input.command.replace(/\s+/g, " ").trim(), 200));
  }
  // The agent's own one-liner for the call, and the only readable subject a
  // Task/Agent call has. Skipped when something concrete was already found, so a
  // Bash call shows what it ran rather than what it meant to do.
  if (parts.length === 0 && typeof input.description === "string" && input.description.trim()) {
    parts.push(clip(input.description.replace(/\s+/g, " ").trim(), 120));
  }
  return parts.join(" ");
}

/**
 * Whether this message *is* the run's answer, as opposed to the agent explaining
 * why it could not produce one.
 *
 * Not anchored to the start of the text: models routinely introduce the fenced
 * block with a sentence or two ("Based on the guidelines, I'll write minimal
 * release notes since…"), and treating that preamble as a failure reason put a
 * successful answer in front of the actual cause — a `fatal: invalid refspec`
 * from the push — in the operator-facing error.
 */
function looksLikeFinalJson(text: string): boolean {
  return fencedJson(text) !== undefined || text.trim().startsWith("{");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Splits a byte stream into lines as they arrive, rather than buffering to EOF.
 * A twenty-minute agent run whose log only appears at the end is not observable,
 * which is the whole reason `stream-json` is used over `json`.
 */
export async function consumeNdjson(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  // A tool can print an entire source tree without a newline. Such a line is
  // neither useful stream-json nor safe to retain while waiting for EOF.
  const maxLineBytes = 1 * 1024 * 1024;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let leftover = "";
  let discardingLongLine = false;
  for (;;) {
    const { done, value } = await reader.read();
    leftover += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const pieces = leftover.split("\n");
    leftover = pieces.pop() ?? "";
    for (const piece of pieces) {
      if (discardingLongLine) {
        discardingLongLine = false;
        continue;
      }
      if (piece.trim() && Buffer.byteLength(piece) <= maxLineBytes) onLine(piece);
    }
    if (Buffer.byteLength(leftover) > maxLineBytes) {
      // Drop the oversized partial line and ignore its suffix through the next
      // delimiter, then resume normal parsing. This caps retained memory even
      // when a container emits a multi-gigabyte line.
      leftover = "";
      discardingLongLine = true;
    }
    if (done) {
      if (!discardingLongLine && leftover.trim()) onLine(leftover);
      return;
    }
  }
}
