/**
 * Loading secrets from `config/.env`.
 *
 * Bun reads `.env` from the project root automatically, but the plan puts config
 * — including secrets — under `config/`. Without this, every command runs with no
 * credentials and fails as though the tokens were never set, which is a slow and
 * confusing thing to debug.
 *
 * Not a general dotenv implementation: it handles the syntax a token file
 * actually uses, and ignores what it does not understand rather than guessing.
 *
 * The file takes precedence over the environment. See `loadEnvFile` for why that
 * is the opposite of the usual dotenv convention.
 */

/** Where secrets live, relative to the working directory. */
export const DEFAULT_ENV_PATH = "config/.env";

export interface LoadEnvResult {
  path: string;
  /** False when the file is absent — not an error; the environment may be set. */
  found: boolean;
  /** Names read from the file and applied. Names only: never values. */
  applied: string[];
  /**
   * Names the file replaced because the environment already had a different
   * value. A subset of `applied`, reported separately so the override is
   * visible: a stale token left exported in a shell profile is otherwise
   * indistinguishable from a wrong token in the file.
   */
  overrode: string[];
  /**
   * Names the file mentions but leaves empty, where the environment has a real
   * value — so the environment's value survives. Copying `example.env` produces a
   * file full of empty entries, and a blank line must not wipe a token that a CI
   * runner or shell legitimately provided.
   */
  skipped: string[];
}

/**
 * Parses an env file into name/value pairs.
 *
 * Exported for testing, and because the parse is the part worth pinning down:
 * a mis-parsed quote silently truncates a token, and the resulting 401 says
 * nothing about why.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    // `export FOO=bar` is common in a file people also source from a shell.
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;

    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const name = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;

    out.set(name, unquote(withoutExport.slice(eq + 1).trim()));
  }

  return out;
}

/**
 * Strips one matching pair of surrounding quotes.
 *
 * An unquoted value keeps everything up to the first ` #`, since a trailing
 * comment is otherwise silently appended to the token. Inside quotes a `#` is
 * literal — some API keys contain one.
 */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }

  const comment = value.indexOf(" #");
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

/**
 * Applies an env file to `process.env`. **The file wins.**
 *
 * The precedence used to run the other way, so an exported variable beat the
 * file. That reads well — "CI secrets keep working" — and is wrong for this tool.
 * A `GITLAB_TOKEN` left exported in a shell profile months ago silently took
 * precedence over the correct token in `config/.env`, and the only symptom was a
 * 401 whose body said the token was expired. It named a token the operator was
 * not looking at and could not see. Debugging that means suspecting the file,
 * the scopes, and the project id before suspecting the shell.
 *
 * `config/.env` is the file the operator edits, so it is the file that decides.
 * A deliberate one-off override is still available and still explicit:
 * `--env-file` picks a different file, and an absent or empty entry defers to the
 * environment, which is what keeps a CI runner injecting a secret this file does
 * not carry working.
 *
 * Returns names rather than logging, so the caller decides what to report — and
 * so nothing here can put a token in a log line.
 */
export async function loadEnvFile(
  path: string = DEFAULT_ENV_PATH,
  env: Record<string, string | undefined> = process.env,
): Promise<LoadEnvResult> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { path, found: false, applied: [], overrode: [], skipped: [] };
  }

  const parsed = parseEnvFile(await file.text());
  const applied: string[] = [];
  const overrode: string[] = [];
  const skipped: string[] = [];

  for (const [name, value] of parsed) {
    const existing = env[name];
    const hasExisting = existing != null && existing !== "";

    // An empty entry is the absence of an opinion, not an instruction to clear.
    // `example.env` ships a dozen of them, so treating them as authoritative
    // would make copying it delete every token the environment provides.
    if (value === "") {
      if (hasExisting) skipped.push(name);
      continue;
    }

    if (hasExisting && existing !== value) overrode.push(name);
    env[name] = value;
    applied.push(name);
  }

  return { path, found: true, applied, overrode, skipped };
}
