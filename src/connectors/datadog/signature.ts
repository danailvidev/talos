/**
 * Turning error log lines into a countable set of distinct problems.
 *
 * This is the part Error Tracking would have done for us. It does not exist for
 * this install (zero indexed issues), so the loop reads raw logs — and raw logs
 * are 2M lines a day of which perhaps forty are distinct bugs. Grouping is
 * therefore not a nicety, it is the entire difference between a triage list and a
 * log tail.
 *
 * The rule: two lines are the same problem when they are the same *shape*. So
 * every part of a message that varies between two occurrences of one bug — an id,
 * a timestamp, a path, a duration, a hostname, a GUID — is replaced by a
 * placeholder, and what remains is the signature. `Unable to store Job with name:
 * 'ONE OFF'` and `Unable to store Job with name: 'NIGHTLY'` are one row.
 *
 * The risk of over-normalising is real and worth naming: strip too much and two
 * genuinely different bugs merge, which loses a bug. The order below is chosen
 * against that — narrow, well-anchored patterns (UUIDs, ISO timestamps, hex
 * blobs, quoted strings) run before the blunt "any long number" rule, so a
 * meaningful token is rarely reduced to `<NUM>` before a more specific rule has
 * had a chance to describe it.
 */

/** Signatures are a table column and a Jira summary; a stack trace is neither. */
const MAX_SIGNATURE_CHARS = 500;

/**
 * Replacements applied in order. Each is anchored enough not to eat a word:
 * `<UUID>` cannot match a version number, `<PATH>` needs a separator.
 */
const NORMALISERS: readonly { pattern: RegExp; with: string }[] = [
  // Generated filenames, first, because every later rule shreds one. A name that
  // carries a digit and ends in a known extension is an artefact rather than a
  // word, and the first real scan showed what happens without this:
  // `foFile: [<PATH>] => [cms-gid-15201E83-md5-<32 hex>-057A.png]` became three
  // separate issues, one per asset id, all of them the same bug.
  //
  // It has to run before `<HEX>` and `<TS>` specifically: those replace part of the
  // name with a placeholder containing `<` and `>`, and the fragments left either
  // side no longer look like a filename to anything. The extension list is closed
  // on purpose — matching any dotted token here would eat class names, which are
  // the most load-bearing part of a Java signature.
  {
    pattern:
      /\b[\w-]*\d[\w.-]*\.(?:png|jpe?g|gif|svg|pdf|fo|xml|json|ya?ml|html?|txt|csv|log|tmp|temp|zip|gz|tar|docx?|xlsx?|pptx?|bin|dat)\b/gi,
    with: "<FILE>",
  },
  // ISO-8601 and common log timestamps, before any number rule can shred them.
  {
    pattern: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    with: "<TS>",
  },
  { pattern: /\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, with: "<TIME>" },
  { pattern: /\b\d{4}-\d{2}-\d{2}\b/g, with: "<DATE>" },
  // UUIDs, then bare hex runs (trace ids, hashes, .NET object ids).
  {
    pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    with: "<UUID>",
  },
  { pattern: /\b(?:0x)?[0-9a-fA-F]{16,}\b/g, with: "<HEX>" },
  // Shorter hex ids: the `<HEX>` rule above needs sixteen characters, and this
  // estate's asset ids are eight (`cms-gid-15201E83`). Both a digit and a hex
  // letter are required, which is what keeps it off real words — `facade` and
  // `deface` have no digit, `12345678` has no letter and is left to `<NUM>`.
  {
    pattern: /\b(?=[0-9a-fA-F]{6,12}\b)(?=[0-9a-fA-F]*\d)(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{6,12}\b/g,
    with: "<HEX>",
  },
  { pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, with: "<EMAIL>" },
  { pattern: /\b(?:https?|ftp):\/\/[^\s'"<>)]+/g, with: "<URL>" },
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, with: "<IP>" },
  // Windows and POSIX paths. The trailing filename goes too: one bug reported
  // across twelve tenant directories is one bug.
  { pattern: /\b[A-Za-z]:\\[^\s'"<>|]*/g, with: "<PATH>" },
  // The opening delimiter set includes a backtick because log messages quote
  // paths that way more often than one would guess (`can't read \`/var/…\``), and
  // a path that fails to match here degrades into a `<NUM>` in a filename — which
  // is what splits one bug across every temp file it ever touched.
  { pattern: /(?:^|(?<=[\s'"`(=[]))\/(?:[\w.@%+-]+\/)+[\w.@%+-]*/g, with: "<PATH>" },
  // Quoted literals: the quotes stay so the shape of the sentence survives. The
  // ceiling is generous because a truncated quote is worse than a long one — see
  // the unterminated rule below.
  { pattern: /'[^']{0,500}'/g, with: "'<STR>'" },
  { pattern: /"[^"]{0,500}"/g, with: '"<STR>"' },
  { pattern: /`[^`]{0,500}`/g, with: "`<STR>`" },
  // A quote that opens and never closes, because the log line itself was cut off
  // mid-sentence. Without this the surviving fragment is part of the signature, so
  // `CMS call failed: <NUM> INTERNAL_SERVER_ERROR "<STR>"` and the same error whose
  // message happened to be truncated three words earlier are two issues.
  //
  // Three guards, all learned the hard way. The quote must open a literal —
  // preceded by a delimiter, not by a letter — or the apostrophe in `can't read`
  // becomes `can'<STR>` and eats the rest of the message. A `>` is excluded from
  // that delimiter set specifically because the closing quote of an
  // already-replaced `` `<STR>` `` sits right after one, and is otherwise
  // indistinguishable from a quote that never closed. And the tail must be at least
  // a sentence long, so a short trailing fragment is left alone.
  { pattern: /(?:^|(?<=[\s(=[:,]))(['"`])[^'"`]{20,}$/g, with: "$1<STR>" },
  // Kubernetes pod suffixes (`api-7d9f8b6c4-x2k9p`) and numeric replica suffixes.
  { pattern: /\b([a-z][a-z0-9-]*?)-[0-9a-f]{6,10}-[a-z0-9]{5}\b/g, with: "$1-<POD>" },
  { pattern: /\b(\d+(?:\.\d+)+)\b/g, with: "<VER>" },
  { pattern: /\b\d[\d,_]*(?:\.\d+)?(?:ms|s|m|h|kb|mb|gb|%)\b/gi, with: "<QTY>" },
  // A value introduced by a key that says it is an id. Base64url call ids are the
  // case that forced this: `callId=dbaHyAqUZkScJslAEk4xJg.<NUM>` carries only two
  // digits, so the general opaque-id rule below — which demands three — left it
  // alone, and one roster bug arrived as *nineteen* rows differing by nothing but
  // the id.
  //
  // Safe where the general rule would not be, because the key vouches for the
  // value: after `callId=`, a mixed-case token is an id and not a class name. The
  // key list is closed for the same reason — `key = PublishAssetPreview` names
  // something, and only `…Id`, `…Token`, `…Hash` and the GUID spellings are
  // reliably opaque. The value must still look generated (a digit, or both cases)
  // so that `valid=SomeEnum` survives.
  {
    pattern:
      /\b([\w.]*(?:[Ii]d|[Uu]uid|[Gg]uid|[Tt]oken|[Hh]ash))(\s*[=:]\s*)(?=[A-Za-z0-9_-]{8,}\b)(?:(?=[A-Za-z0-9_-]*\d)|(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z]))[A-Za-z0-9_-]+/g,
    with: "$1$2<ID>",
  },
  // Opaque alphanumeric ids that are not hex: `loadFixedSvg: key = 140924lnlj46vi`
  // produced one issue per key until this rule existed. Deliberately demanding —
  // eight characters, at least three digits and two letters — because this is the
  // bluntest rule in the list and the one most able to erase a real word. `log4j2`,
  // `utf8mb4` and `Svg4HrefHelper` all fall short of it; `0x80131904` does not, and
  // is an id.
  {
    pattern: /\b(?=[A-Za-z0-9]{8,}\b)(?=(?:[A-Za-z]*\d){3})(?=(?:\d*[A-Za-z]){2})[A-Za-z0-9]+\b/g,
    with: "<ID>",
  },
  { pattern: /\b\d+\b/g, with: "<NUM>" },
];

/**
 * The stable shape of one error, or undefined when there is nothing to key on.
 *
 * Prefers the structured error attributes when the emitting library set them —
 * `error.kind` is already a signature and needs no guessing — and falls back to
 * the message, which is what the overwhelming majority of these logs have.
 */
export function signatureOf(sample: {
  errorKind?: string;
  errorMessage?: string;
  message?: string;
}): string | undefined {
  const kind = sample.errorKind?.trim();
  const body = sample.errorMessage ?? sample.message;
  const shape = body ? normaliseMessage(body) : undefined;

  if (kind && shape) return cap(`${kind}: ${shape}`);
  if (kind) return kind;
  return shape ? cap(shape) : undefined;
}

/**
 * A message with its variable parts replaced, collapsed to one line.
 *
 * Only the first few lines are considered: a log line that carries its own stack
 * trace in the message body would otherwise produce a signature dominated by
 * frames, and two occurrences whose stacks differ by one frame would not group.
 */
export function normaliseMessage(message: string): string {
  let out = collapseNesting(headOf(message));
  for (const rule of NORMALISERS) out = out.replace(rule.pattern, rule.with);
  // Repeated placeholders (`<NUM> <NUM> <NUM>`) carry no more information than one.
  out = out.replace(/(<[A-Z]+>)(?:[\s,;:|/-]*\1)+/g, "$1");
  // A path already stands for the file at the end of it, so `<PATH><FILE>` says the
  // same thing twice — an artefact of `<FILE>` running first, which it must.
  out = out.replace(/<PATH><FILE>/g, "<PATH>");
  return out.replace(/\s+/g, " ").trim();
}

/**
 * The first line or two of a message, without the Java habit of saying it twice.
 *
 * Two lines rather than one because the second often carries the detail the first
 * omits. But a Java stack trace in a message body opens by repeating the throwable
 * header, so the naive join produces `java.lang.Error: …InvocationTargetException
 * java.lang.Error: …InvocationTargetException` — half a signature's budget spent
 * saying nothing, and two occurrences that differ only in how far the duplicate got
 * truncated end up as two issues.
 */
function headOf(message: string): string {
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  const second = lines[1];
  if (!second) return first;
  // Either direction: the repeat may be the longer of the two when the first line
  // is the one that was clipped.
  const duplicate = second.startsWith(first) || first.startsWith(second);
  return duplicate ? (second.length > first.length ? second : first) : `${first} ${second}`;
}

/**
 * Cuts a wrapped exception off after the first cause's class name.
 *
 * `System.AggregateException: One or more errors occurred. ---> Intacct.SDK.…` is
 * one bug, and this estate produced *fifteen* rows of it — identical outer
 * exception, identical first cause, differing only in a response detail four
 * hundred characters in. The outer type plus the first cause is the identity of a
 * wrapped failure; everything past that is one occurrence's paperwork.
 *
 * Deliberately keeps the marker and the class name rather than dropping the whole
 * tail: `AggregateException` on its own says nothing, and `AggregateException --->
 * ResultException` says what actually went wrong.
 */
function collapseNesting(message: string): string {
  return message.replace(
    /\s*(--->|Caused by:)\s*([\w.$]*[\w$](?:Exception|Error|Throwable|Fault))\b[\s\S]*$/,
    " $1 $2",
  );
}

/**
 * What makes two clusters the same issue across days.
 *
 * Service plus signature, and nothing else: the same exception in two services is
 * two problems with two owners, while the same problem on forty hosts in three
 * environments is one. Environment is deliberately excluded from the key — a bug
 * seen in beta and then in prod is one bug whose blast radius grew, and splitting
 * it would file two tickets.
 */
export function fingerprintOf(service: string | undefined, signature: string): string {
  const basis = `${service ?? "unknown"} ${signature}`;
  return new Bun.CryptoHasher("sha256").update(basis).digest("hex").slice(0, 32);
}

/**
 * A short human title for a cluster, for a table row and a Jira summary.
 *
 * The signature with its placeholders left in. Substituting a sample's real
 * values back in would read better and lie: the ticket is about every occurrence,
 * not about the one line we happened to fetch.
 */
export function titleOf(service: string | undefined, signature: string): string {
  const label = signature.length > 140 ? `${signature.slice(0, 139)}…` : signature;
  return service ? `${service}: ${label}` : label;
}

function cap(value: string): string {
  return value.length > MAX_SIGNATURE_CHARS
    ? `${value.slice(0, MAX_SIGNATURE_CHARS - 1)}…`
    : value;
}

export interface Cluster<S> {
  signature: string;
  count: number;
  /** The most recent sample, which is the one worth quoting in a ticket. */
  sample: S;
  firstSeenAt?: Date;
  lastSeenAt?: Date;
}

/**
 * Groups samples by signature, newest sample kept per group.
 *
 * Counts here are *sample* counts, not the true occurrence count — the caller
 * fetched a bounded page of logs, not all 2M. Scaling them to the aggregate total
 * is the caller's job (see `application/datadog-scan.ts`); doing it here would
 * bury an estimate inside something that looks like a fact.
 */
export function clusterSamples<
  S extends {
    errorKind?: string;
    errorMessage?: string;
    message?: string;
    timestamp?: Date;
  },
>(samples: readonly S[]): Cluster<S>[] {
  const groups = new Map<string, Cluster<S>>();

  for (const sample of samples) {
    const signature = signatureOf(sample);
    if (!signature) continue;

    const existing = groups.get(signature);
    if (!existing) {
      groups.set(signature, {
        signature,
        count: 1,
        sample,
        ...(sample.timestamp ? { firstSeenAt: sample.timestamp, lastSeenAt: sample.timestamp } : {}),
      });
      continue;
    }

    existing.count += 1;
    if (sample.timestamp) {
      if (!existing.firstSeenAt || sample.timestamp < existing.firstSeenAt) {
        existing.firstSeenAt = sample.timestamp;
      }
      if (!existing.lastSeenAt || sample.timestamp > existing.lastSeenAt) {
        existing.lastSeenAt = sample.timestamp;
        existing.sample = sample;
      }
    }
  }

  return [...groups.values()].sort((a, b) => b.count - a.count);
}
