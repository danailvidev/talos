/**
 * The second level of grouping: folding clusters that are one root cause together.
 *
 * Signature clustering answers "which distinct error shapes are there". It turns
 * out that is not the same question as "what is broken", and the first real scan of
 * this estate showed the gap plainly. Thirty-eight rows described about six
 * problems, because a single failure writes several log lines:
 *
 *   lcm  285,462  java.lang.Error: …InvocationTargetException
 *   lcm  285,462  PublishAssetPreview._fo2png: srcFile: <PATH>
 *   lcm  228,369  AhfServiceClient: FILE_READ, can't read `<STR>`
 *   lcm  228,369  AhfServiceClient$RenderPng: [FILE_READ] - can't read
 *   ahf  186,404  AhfServiceCore.exportToPng: [FILE_READ] …
 *
 * Those are related failures logged from five frames across two services. They are
 * grouped only inside one service: a service is also the repository boundary, so
 * merging `lcm` and `ahf` would leave a "write a test" action with no honest answer
 * to which repository it should inspect. Within each service the duplicate-frame
 * folding still keeps counts from being inflated.
 *
 * ## How two clusters are recognised as one
 *
 * By cross-reference: they mention each other's code. Each cluster contributes the
 * distinctive identifiers in its signature — an error code like `FILE_READ`, a
 * class or method name like `PublishAssetPreview._fo2png` — and two clusters are
 * merged when a distinctive identifier appears in both of their sample bodies,
 * stack traces included. The wrapping `java.lang.Error` finds its partner because
 * its own stack trace names `PublishAssetPreview._fo2png`.
 *
 * Two filters keep that from becoming a machine for wrong answers:
 *
 *  - **Generic identifiers are excluded outright.** `InvocationTargetException`
 *    means "something inside threw" and identifies nothing; merging on it would
 *    join every reflective call site in the estate into one problem.
 *  - **A token has to be rare.** An identifier appearing in more than a handful of
 *    clusters is a component name, not a fault — `AhfServiceClient` in the stack of
 *    every lcm error would otherwise collapse the whole service to a single row.
 *
 * No LLM and no time correlation. A model could do this better and is not free; and
 * time is useless here specifically because `sampleLogs` reads the *newest* page,
 * so in a service writing twenty errors a second every sample is within a few
 * seconds of every other one and everything "co-occurs".
 *
 * The bias throughout is towards under-merging. Two rows for one bug is a nuisance;
 * one row for two bugs hides a bug, and nothing downstream can recover it.
 */

import { DATADOG_REGRESSION_POLICY } from "../../shared/datadog-policy.ts";

/** One clustered signature, offered up for grouping. */
export interface ProblemCandidate {
  service?: string;
  signature: string;
  /** The scan's estimate for this signature alone. */
  eventCount: number;
  /** Sample message body, verbatim. Searched for other clusters' identifiers. */
  sampleMessage?: string;
  /** Sample stack trace. The strongest link there is — it names the real call path. */
  sampleStack?: string;
}

export interface Problem {
  /**
   * Stable for one scan's output, and no longer. Derived from the member
   * signatures, so it changes the moment membership does — it groups a scan's rows
   * and identifies nothing across scans. The Jira link is what persists.
   */
  key: string;
  /** The member signature that best describes the whole thing. */
  title: string;
  /** The service every member belongs to. */
  service?: string;
  /**
   * The problem's estimate: the **largest** member, not the sum.
   *
   * Members are the same occurrences seen from different frames, so adding them
   * counts one failure three times — which is the exact inflation this grouping
   * exists to undo. The largest member is the closest honest answer: at least this
   * many failures happened.
   */
  eventCount: number;
  /** Indices into the candidate array, primary first. */
  members: number[];
  /** Why these were merged, for the row's own explanation. Empty for a lone cluster. */
  linkedBy: string[];
}

/**
 * Identifiers that carry no identity, and so must never merge anything.
 *
 * Two kinds: wrappers that only say "something inside failed", and framework names
 * common enough to appear in unrelated stacks. Matched case-insensitively against
 * the whole token.
 */
const GENERIC_TOKENS = new Set(
  [
    // The root types. `java.lang.Error` reads as specific because it is qualified,
    // and it is the single most generic thing a JVM can throw — left in, it merged
    // an SVG parsing fault into an asset publishing fault on the strength of both
    // being errors.
    "java.lang.Error",
    "java.lang.Exception",
    "java.lang.Throwable",
    "java.lang.RuntimeException",
    "System.Exception",
    "System.SystemException",
    "System.ApplicationException",
    // Wrappers and re-throws.
    "InvocationTargetException",
    "UndeclaredThrowableException",
    "ExecutionException",
    "CompletionException",
    "AggregateException",
    "RuntimeException",
    "TargetInvocationException",
    "TypeInitializationException",
    // Faults so generic that the type is not the bug.
    "NullPointerException",
    "IllegalStateException",
    "IllegalArgumentException",
    "ArgumentNullException",
    "ArgumentException",
    "IndexOutOfBoundsException",
    "NullReferenceException",
    "InvalidOperationException",
    "IOException",
    "SocketException",
    "TimeoutException",
    "InterruptedException",
    "ClassCastException",
    "NumberFormatException",
    "UnsupportedOperationException",
    // Generic error codes seen across unrelated endpoints.
    "INTERNAL_SERVER_ERROR",
    "SERVICE_UNAVAILABLE",
    "BAD_REQUEST",
    "NOT_FOUND",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "GATEWAY_TIMEOUT",
    "UNKNOWN_ERROR",
  ].map((token) => token.toLowerCase()),
);

/**
 * How many clusters an identifier may appear in and still be considered a fault
 * rather than a component.
 *
 * Three is chosen from the data: the FILE_READ fault spans exactly three clusters,
 * and a service's own base-class name appears in a dozen. There is no safe general
 * value — this one is tuned to "the largest genuine fan-out observed, and no
 * larger", which is the conservative side of the trade.
 */
const MAX_TOKEN_SPREAD = DATADOG_REGRESSION_POLICY.maxGroupingTokenSpread;

/** Identifiers shorter than this are too likely to be a word. */
const MIN_TOKEN_CHARS = 6;

/**
 * Groups candidates into problems, worst first.
 *
 * Every candidate ends up in exactly one problem; a cluster nothing linked to
 * becomes a problem of one, which is the common case and the right one — most
 * distinct error shapes really are distinct problems.
 */
export function groupIntoProblems(candidates: readonly ProblemCandidate[]): Problem[] {
  const contexts = candidates.map(contextOf);
  const parent = candidates.map((_, index) => index);
  const reasons = new Map<number, Set<string>>();

  // Which clusters each distinctive identifier turns up in, scoped to a service.
  // Service is the repository boundary: a shared code token can explain why two
  // services fail together, but it must not merge the actions that write to their
  // separate repositories.
  const spread = new Map<string, number[]>();
  for (const candidate of candidates) {
    for (const token of distinctiveTokens(candidate.signature)) {
      const spreadKey = `${candidate.service ?? ""}\0${token.toLowerCase()}`;
      if (spread.has(spreadKey)) continue;
      const holders: number[] = [];
      const needle = token.toLowerCase();
      for (const [index, context] of contexts.entries()) {
        if (
          candidates[index]!.service === candidate.service &&
          context.includes(needle)
        ) {
          holders.push(index);
        }
      }
      spread.set(spreadKey, holders);
    }
  }

  for (const [spreadKey, holders] of spread) {
    if (holders.length < 2 || holders.length > MAX_TOKEN_SPREAD) continue;
    const token = spreadKey.slice(spreadKey.indexOf("\0") + 1);
    const first = holders[0]!;
    for (const other of holders.slice(1)) union(parent, first, other);
    // Recorded against a member rather than the root, because the root moves as
    // unions happen; the reasons are gathered per group at the end.
    for (const holder of holders) {
      let set = reasons.get(holder);
      if (!set) reasons.set(holder, (set = new Set()));
      set.add(token);
    }
  }

  const groups = new Map<number, number[]>();
  for (let index = 0; index < candidates.length; index += 1) {
    const root = find(parent, index);
    const members = groups.get(root);
    if (members) members.push(index);
    else groups.set(root, [index]);
  }

  const problems: Problem[] = [];
  for (const members of groups.values()) {
    const ordered = [...members].sort(
      (a, b) => primaryScore(candidates[b]!) - primaryScore(candidates[a]!),
    );
    const primary = candidates[ordered[0]!]!;
    const linkedBy =
      members.length > 1
        ? [
            ...new Set(
              members.flatMap((member) => [...(reasons.get(member) ?? [])]),
            ),
          ].sort()
        : [];

    problems.push({
      key: keyFor(
        primary.service,
        members.map((member) => candidates[member]!.signature),
      ),
      title: primary.signature,
      ...(primary.service ? { service: primary.service } : {}),
      eventCount: Math.max(...members.map((member) => candidates[member]!.eventCount)),
      members: ordered,
      linkedBy,
    });
  }

  return problems.sort((a, b) => b.eventCount - a.eventCount);
}

/**
 * The identifiers in a signature specific enough to name a fault.
 *
 * Three shapes, in descending order of how much they usually mean: an error code
 * in SCREAMING_SNAKE (`FILE_READ`), a dotted or `$`-separated qualified name
 * (`AhfServiceCore.exportToPng`), and a bare camelCase identifier. Placeholders are
 * skipped — `<PATH>` is in every second signature.
 */
export function distinctiveTokens(signature: string): string[] {
  const withoutPlaceholders = signature.replace(/<[A-Z]+>/g, " ");
  const found = new Set<string>();

  const patterns: readonly RegExp[] = [
    /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
    /\b[A-Za-z_$][\w$]*(?:[.$][A-Za-z_$][\w$]*)+\b/g,
    /\b[A-Za-z_$][\w$]*[a-z][A-Z][\w$]*\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of withoutPlaceholders.matchAll(pattern)) {
      const token = match[0];
      if (token.length < MIN_TOKEN_CHARS) continue;
      if (GENERIC_TOKENS.has(token.toLowerCase())) continue;
      // A qualified name whose every segment is generic is generic: matching
      // `Intacct.SDK.Exceptions.ResultException` is useful, matching
      // `java.lang.RuntimeException` is not.
      const segments = token.split(/[.$]/).filter((s) => s.length >= MIN_TOKEN_CHARS);
      if (segments.length > 0 && segments.every((s) => GENERIC_TOKENS.has(s.toLowerCase()))) {
        continue;
      }
      found.add(token);
    }
  }

  return [...found];
}

/**
 * Everything a cluster's identifiers may be looked for in, lowercased once.
 *
 * The stack trace matters more than the message here: a wrapping exception's
 * message says nothing about what it wrapped, and its stack names the exact method
 * that threw.
 */
function contextOf(candidate: ProblemCandidate): string {
  return [candidate.signature, candidate.sampleMessage, candidate.sampleStack]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

/**
 * How good a member is as the thing the row is titled after.
 *
 * Volume decides, with a nudge towards signatures that name something. Of two
 * members of one problem at identical counts — which is the normal case, since they
 * are the same occurrences — `PublishAssetPreview._fo2png: srcFile: <PATH>` is a
 * better row title than `java.lang.Error: …InvocationTargetException`, and the
 * count alone cannot express that.
 */
function primaryScore(candidate: ProblemCandidate): number {
  const named = distinctiveTokens(candidate.signature).length > 0 ? 1.5 : 1;
  return candidate.eventCount * named;
}

/** Deterministic for one service and a set of member signatures, order-independent. */
function keyFor(service: string | undefined, signatures: readonly string[]): string {
  const basis = [service ?? "", ...[...signatures].sort()].join("\0");
  return new Bun.CryptoHasher("sha256").update(basis).digest("hex").slice(0, 32);
}

function find(parent: number[], index: number): number {
  let root = index;
  while (parent[root] !== root) root = parent[root]!;
  // Path compression, so a chain of five merges does not cost five hops on the
  // next lookup. Cheap here and free to omit — kept because the loop above runs
  // once per candidate per token.
  let walk = index;
  while (parent[walk] !== root) {
    const next = parent[walk]!;
    parent[walk] = root;
    walk = next;
  }
  return root;
}

function union(parent: number[], a: number, b: number): void {
  const rootA = find(parent, a);
  const rootB = find(parent, b);
  if (rootA !== rootB) parent[rootB] = rootA;
}
