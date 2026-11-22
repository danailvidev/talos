import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Which coding agents this host is signed in to, and as whom.
 *
 * Custom loops ask the operator to pick an agent, and the honest list is
 * "whatever is already logged in on this machine" — talos runs the agent
 * locally (see `run.ts`), so an account it cannot reach is not an option. Hence
 * detection rather than a connect flow: there is nothing to connect, and a
 * stored provider+email pair would only be a second copy of what the vendor's
 * own config already says.
 *
 * Every probe is best-effort and read-only. A provider whose config is missing,
 * unreadable or a different shape than expected is simply absent from the
 * result — never an error, because "Cursor is not installed" is the normal case,
 * not a failure. A provider that is present but whose email we cannot find is
 * still returned with no `account`: knowing it is signed in is most of the
 * value, and the vendors move that field between versions.
 *
 * Only the account identifier is read out of these files. The credentials
 * beside it are deliberately left alone — the agent gets them by having its own
 * config directory mounted (`runAgentJob`), not by talos handling them.
 */
export const AGENT_PROVIDERS = ["claude", "cursor", "codex", "copilot"] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export interface DetectedAgent {
  provider: AgentProvider;
  /** Display name, e.g. "Claude Code". */
  name: string;
  /** The signed-in account, when the vendor's config records one. */
  account?: string;
  /**
   * Whether talos can actually *run* this agent, as opposed to merely seeing
   * that it is installed. Only Claude today: the agent image ships the `claude`
   * CLI and the entrypoint drives it (see `image.ts`). The others are listed so
   * the loop form can show them greyed out rather than pretending the host has
   * nothing but Claude on it.
   */
  runnable: boolean;
}

interface Probe {
  provider: AgentProvider;
  name: string;
  runnable: boolean;
  /** Existing anywhere in this list means "installed". */
  markers: string[];
  /** Where the signed-in account is recorded, tried in order. */
  account: (home: string) => Promise<string | undefined>;
}

const PROBES: readonly Probe[] = [
  {
    provider: "claude",
    name: "Claude Code",
    runnable: true,
    markers: [".claude", ".claude.json"],
    // Claude Code writes the subscription's account under `oauthAccount` once it
    // has been through OAuth. Absent on an API-key install, and absent on
    // versions that keep it in the OS keyring instead — both of which still run,
    // so a missing email is not treated as "not signed in".
    account: async (home) =>
      firstString(await json(join(home, ".claude.json")), [
        ["oauthAccount", "emailAddress"],
        ["oauthAccount", "email"],
      ]),
  },
  {
    provider: "cursor",
    name: "Cursor",
    runnable: false,
    markers: [".cursor"],
    account: async (home) =>
      firstString(await json(join(home, ".cursor", "cli-config.json")), [
        ["authInfo", "email"],
      ]),
  },
  {
    provider: "codex",
    name: "Codex",
    runnable: false,
    markers: [".codex"],
    // Codex stores an OpenAI id_token, whose payload carries the email. Read as
    // a JWT rather than looking for a plain field, because there isn't one.
    account: async (home) => {
      const auth = await json(join(home, ".codex", "auth.json"));
      const token = firstString(auth, [
        ["tokens", "id_token"],
        ["id_token"],
      ]);
      return token ? emailFromJwt(token) : undefined;
    },
  },
  {
    provider: "copilot",
    name: "GitHub Copilot",
    runnable: false,
    markers: [".copilot", ".github-copilot-cli"],
    // GitHub identifies people by login, not email, so a handle is what this one
    // yields when it yields anything. Often it yields nothing: recent Copilot CLI
    // versions write `config.json` as an opaque blob rather than JSON, which is
    // precisely the case the "detected, account unknown" state exists for.
    account: async (home) =>
      firstString(await json(join(home, ".copilot", "config.json")), [
        ["lastLoggedInUser"],
        ["email"],
      ]),
  },
];

export async function detectAgents(home = homedir()): Promise<DetectedAgent[]> {
  const found = await Promise.all(
    PROBES.map(async (probe) => {
      if (!probe.markers.some((marker) => existsSync(join(home, marker)))) return undefined;
      const account = await probe.account(home).catch(() => undefined);
      return {
        provider: probe.provider,
        name: probe.name,
        runnable: probe.runnable,
        ...(account ? { account } : {}),
      } satisfies DetectedAgent;
    }),
  );
  return found.filter((agent): agent is DetectedAgent => agent != null);
}

async function json(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The first of several candidate paths that holds a non-empty string. */
function firstString(source: unknown, paths: readonly string[][]): string | undefined {
  for (const path of paths) {
    let cursor = source;
    for (const key of path) {
      if (cursor == null || typeof cursor !== "object") {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (typeof cursor === "string" && cursor.trim() !== "") return cursor.trim();
  }
  return undefined;
}

/**
 * The `email` claim out of a JWT's payload. No signature check: this is not an
 * authentication decision, it is reading a label off a credential the operator
 * already holds, to print it in a dropdown.
 */
function emailFromJwt(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const decoded = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    return firstString(decoded, [["email"]]);
  } catch {
    return undefined;
  }
}
