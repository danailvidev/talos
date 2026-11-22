import { isMap, isScalar, isSeq, parseDocument, Scalar, stringify } from "yaml";
import { ValidationError } from "../core/errors.ts";

/**
 * The releases model, forge-neutral and free of any GitLab detail — the same
 * discipline as `pull-requests.ts`.
 *
 * Each environment is a folder in the releases repo holding a `cluster.yaml`.
 * That file has two top-level lists — user-facing `applications` and backend
 * `services` — and every entry is `{ name, image?, version }`. A deploy is a
 * developer bumping the `version` of one entry, identified by its `name` within
 * its section. The console never assumes a fixed set of environments or
 * services: whatever the folders and files hold is what the page shows.
 */
export const MANIFEST_SECTIONS = ["applications", "services"] as const;
export type ManifestSection = (typeof MANIFEST_SECTIONS)[number];

export interface ServiceVersion {
  /** Unique within its section, e.g. `web`, `gateway`. */
  name: string;
  version: string;
  /** The container image, when the entry names one distinct from `name`. */
  image?: string;
  section: ManifestSection;
}

export interface EnvironmentVersions {
  /** The folder name, which is the environment name. */
  name: string;
  services: ServiceVersion[];
}

/** The immutable container reference Kubernetes must report for this release. */
export function deploymentTargetFor(
  service: ServiceVersion,
  version = service.version,
): { service: string; expectedImage: string } {
  const repository = (service.image ?? service.name).trim();
  const trimmedVersion = version.trim();
  return {
    service: service.name,
    expectedImage: trimmedVersion.startsWith("sha256:")
      ? `${repository}@${trimmedVersion}`
      : `${repository}:${trimmedVersion}`,
  };
}

/** One requested edit: set `service` in `section` of `environment` to `version`. */
export interface ServiceVersionChange {
  environment: string;
  service: string;
  version: string;
  section: ManifestSection;
}

/**
 * Is this environment folder production?
 *
 * Name matching, not a config field — chosen deliberately over an explicit
 * per-environment flag, because every environment folder observed so far already
 * spells production with the same prefix (`PROD`, `prod-eu`, …), and a naming
 * convention costs nothing to keep versus a setting somebody has to remember to
 * flip when a new environment folder shows up. Kept in one named, greppable place
 * so it is a one-line swap for a config field later if a folder ever breaks the
 * convention.
 */
export function isProductionEnvironment(name: string): boolean {
  return /^prod/i.test(name.trim());
}

/** The top-level environment for an exact `ENV/<manifestPath>` repository path. */
export function environmentOfManifestPath(
  path: string,
  manifestPath: string,
): string | null {
  const slash = path.indexOf("/");
  if (slash <= 0) return null;
  if (path.slice(slash + 1) !== manifestPath) return null;
  return path.slice(0, slash);
}

/**
 * Reads one environment's `cluster.yaml` into the forge-neutral model.
 *
 * Deliberately tolerant: the file is hand-edited and full of comments and
 * commented-out entries (which YAML drops on parse, exactly what we want here).
 * An entry missing a `name` or `version` is skipped rather than blanking the
 * page, and a scalar version is coerced to a string.
 */
export function parseClusterManifest(text: string, path: string): ServiceVersion[] {
  let root: unknown;
  try {
    const doc = parseDocument(text);
    if (doc.errors.length > 0) throw doc.errors[0];
    root = doc.toJS();
  } catch (cause) {
    throw new ValidationError(`Could not parse manifest '${path}'.`, { cause });
  }

  if (root == null || typeof root !== "object" || Array.isArray(root)) {
    throw new ValidationError(
      `Manifest '${path}' must be a mapping with 'applications' and/or 'services' lists.`,
    );
  }

  const out: ServiceVersion[] = [];
  for (const section of MANIFEST_SECTIONS) {
    const list = (root as Record<string, unknown>)[section];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const name = record.name;
      const version = record.version;
      if (typeof name !== "string" || version == null || typeof version === "object") continue;
      out.push({
        name,
        version: String(version),
        ...(typeof record.image === "string" && record.image !== name
          ? { image: record.image }
          : {}),
        section,
      });
    }
  }
  return out;
}

/** One version move a past commit made to a manifest entry. */
export interface ManifestVersionChange {
  service: string;
  /** Absent when the diff's hunk headers did not say which list the entry is in. */
  section?: ManifestSection;
  /** The version replaced, or null when the commit added the entry outright. */
  from: string | null;
  to: string;
}

/**
 * Reads the version moves out of a unified diff of one environment's manifest —
 * how the history tab answers "who changed what" for a commit.
 *
 * Parsing the diff rather than fetching the file at the commit and at its parent:
 * one request per commit instead of two, and the hunks already say which lines
 * moved. What makes it reliable for this file is the shape of the entries — the
 * `name:` of an entry is one or two lines above its `version:`, so it is inside
 * the three lines of context a diff carries, and the section comes from the hunk
 * header's enclosing-context suffix (`@@ … @@ services:`), which git fills with
 * the nearest unindented line.
 *
 * Deliberately forgiving in the same spirit as `parseClusterManifest`: anything
 * it cannot attribute is dropped rather than raised. A history entry that is
 * missing a bump is a worse page; a history tab that 500s because somebody
 * reformatted the YAML is a broken one.
 */
export function parseManifestVersionDiff(diff: string): ManifestVersionChange[] {
  type Token =
    | { kind: "name"; value: string }
    | { kind: "version"; side: "old" | "new"; value: string; section?: ManifestSection };

  const tokens: Token[] = [];
  let section: ManifestSection | undefined;

  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      // `@@ -12,7 +12,7 @@ services:` — the suffix is the enclosing context.
      const suffix = line.slice(line.indexOf("@@", 2) + 2).trim();
      const heading = MANIFEST_SECTIONS.find((s) => suffix.startsWith(`${s}:`));
      section = heading ?? undefined;
      continue;
    }
    // File headers, and git's "no newline at end of file" marker.
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("\\")) continue;

    const prefix = line[0];
    if (prefix !== " " && prefix !== "+" && prefix !== "-") continue;
    const content = line.slice(1);

    // A list entry's key, whether it moved or is only context around one that did.
    const name = /^\s*-?\s*name:\s*["']?([^"'\s#]+)/.exec(content);
    if (name?.[1]) {
      tokens.push({ kind: "name", value: name[1] });
      continue;
    }
    if (prefix === " ") continue;
    const version = /^\s*version:\s*["']?([^"'\s#]+)/.exec(content);
    if (version?.[1]) {
      tokens.push({
        kind: "version",
        side: prefix === "-" ? "old" : "new",
        value: version[1],
        ...(section ? { section } : {}),
      });
    }
  }

  // Every version line, attributed to the entry it sits in: the name above it,
  // or — for the rare manifest that puts `version` before `name` — the one below.
  const byService = new Map<
    string,
    { section?: ManifestSection; old: string[]; new: string[] }
  >();
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== "version") continue;
    const before = tokens.slice(0, index).findLast((t) => t.kind === "name");
    const after = before ? undefined : tokens.slice(index + 1).find((t) => t.kind === "name");
    const service = (before ?? after)?.value;
    if (!service) continue;

    let entry = byService.get(service);
    if (!entry) {
      entry = { ...(token.section ? { section: token.section } : {}), old: [], new: [] };
      byService.set(service, entry);
    }
    entry[token.side === "old" ? "old" : "new"].push(token.value);
  }

  const out: ManifestVersionChange[] = [];
  for (const [service, entry] of byService) {
    // Zipped by position: an entry appears once per manifest, so in practice this
    // is one removed line paired with one added line.
    for (const [i, to] of entry.new.entries()) {
      const from = entry.old[i] ?? null;
      if (from === to) continue;
      out.push({ service, ...(entry.section ? { section: entry.section } : {}), from, to });
    }
  }
  return out;
}

/**
 * Applies version changes to one environment's `cluster.yaml`, preserving its
 * formatting.
 *
 * The edit is surgical — the parsed nodes identify each version scalar's exact
 * source range, and only those ranges are replaced in the original text. Calling
 * `doc.toString()` here would normalize sequence indentation and line endings
 * across the whole manifest, making a one-service upload look like a full-file
 * change in GitLab.
 *
 * Every change must target an entry that already exists in the named section:
 * a deploy bumps a service that is there, and a typo that silently appended a
 * new entry would deploy nothing.
 */
export function applyChanges(
  text: string,
  path: string,
  changes: ServiceVersionChange[],
): string {
  if (changes.length === 0) return text;

  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new ValidationError(`Could not parse manifest '${path}'.`);
  }

  const edits = new Map<number, { end: number; value: string }>();
  for (const change of changes) {
    const seq = doc.get(change.section);
    const item = isSeq(seq)
      ? seq.items.find((node) => isMap(node) && node.get("name") === change.service)
      : undefined;
    if (!isMap(item)) {
      throw new ValidationError(
        `'${change.service}' is not in the '${change.section}' list of '${change.environment}' (${path}).`,
      );
    }

    const version = item.get("version", true);
    if (!isScalar(version) || !version.range) {
      throw new ValidationError(
        `'${change.service}' has no scalar 'version' in '${change.environment}' (${path}).`,
      );
    }

    const replacement = new Scalar(change.version);
    if (
      version.type === Scalar.PLAIN ||
      version.type === Scalar.QUOTE_SINGLE ||
      version.type === Scalar.QUOTE_DOUBLE
    ) {
      replacement.type = version.type;
    }
    edits.set(version.range[0], {
      end: version.range[1],
      value: stringify(replacement).replace(/\n$/, ""),
    });
  }

  let updated = text;
  for (const [start, edit] of [...edits].sort(([a], [b]) => b - a)) {
    updated = updated.slice(0, start) + edit.value + updated.slice(edit.end);
  }
  return updated;
}
