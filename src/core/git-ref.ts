/**
 * Branch names built out of human text — a Jira summary, a production error's
 * title — and the rules git will actually accept for them.
 *
 * git refuses a ref whose slash-separated component ends in `.` or `.lock`,
 * contains `..`, or holds a space, `~`, `^`, `:`, `?`, `*`, `[`, `\` or a control
 * character. Nothing checks any of that until the push: a name that breaks a rule
 * clones fine, lets the agent work for twenty minutes, and then dies on
 * `fatal: invalid refspec` with the whole run wasted. So both halves live here —
 * `branchSlug` to build a name that cannot break the rules, and
 * `invalidBranchNameReason` to refuse one that does before a container starts.
 *
 * The trailing-`.` case is not hypothetical: truncating
 * `unit-test-failure-rich-text-editor.component.spec.ts` to 50 characters lands
 * exactly on the dot before `ts`.
 */

/** Leading/trailing punctuation git either forbids outright or reads as noise. */
function trimEdges(value: string): string {
  return value.replace(/^[-._]+|[-._]+$/g, "");
}

/**
 * `refs/heads/foo.lock` is how git names the lock file for `refs/heads/foo`, so a
 * component may never end that way.
 */
function dropLockSuffix(value: string): string {
  return value.endsWith(".lock") ? trimEdges(value.slice(0, -".lock".length)) : value;
}

/**
 * One path component of a branch name, derived from arbitrary text and safe to
 * push: lowercased, punctuation collapsed, and cut to `maxLength` without ever
 * ending on a character git rejects.
 */
export function branchSlug(value: string, maxLength = 50): string {
  const slug = trimEdges(
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      // `..` is illegal anywhere in a ref, not just at the edges.
      .replace(/\.{2,}/g, "."),
  );
  if (slug.length <= maxLength) return dropLockSuffix(slug);

  // Cutting mid-token leaves the tail of a filename dangling (`...component.sp`),
  // so the cut moves back to the last separator inside the budget — but only if
  // that leaves a slug worth reading, otherwise a long first token would truncate
  // to nothing.
  const head = slug.slice(0, maxLength);
  const boundary = Math.max(head.lastIndexOf("-"), head.lastIndexOf("."), head.lastIndexOf("_"));
  return dropLockSuffix(trimEdges(boundary >= maxLength / 2 ? head.slice(0, boundary) : head));
}

/** Characters git forbids anywhere in a ref, plus ASCII control characters. */
const ILLEGAL_IN_REF = new RegExp("[\\s~^:?*\\[\\\\\\u0000-\\u001f\\u007f]");

/**
 * Why git would reject this branch name, or `undefined` if it would accept it.
 *
 * A reason string rather than a thrown error: the callers sit in different layers
 * and each wraps it in its own error type, and the one thing they all need is a
 * sentence naming what is wrong with the name.
 */
export function invalidBranchNameReason(name: string): string | undefined {
  if (name.trim() === "") return "it is empty";
  const illegal = name.match(ILLEGAL_IN_REF);
  if (illegal) {
    const shown = illegal[0].trim() === "" ? "whitespace" : `'${illegal[0]}'`;
    return `${shown} is not allowed in a branch name`;
  }
  if (name.includes("..")) return "'..' is not allowed in a branch name";
  if (name.includes("@{")) return "'@{' is not allowed in a branch name";
  if (name === "@") return "'@' on its own is not a branch name";
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) {
    return "a branch name cannot start or end with '/' or contain an empty path component";
  }
  for (const component of name.split("/")) {
    if (component.startsWith(".")) return `path component '${component}' starts with '.'`;
    if (component.endsWith(".")) return `path component '${component}' ends with '.'`;
    if (component.endsWith(".lock")) return `path component '${component}' ends with '.lock'`;
  }
  return undefined;
}
