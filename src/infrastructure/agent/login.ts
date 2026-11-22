import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type * as ApiContract from "../../../shared/api-contract.ts";
import type { AgentAccountRepository, StoredAgentAccount } from "../../application/ports.ts";
import { ConfigError } from "../../core/errors.ts";
import type { Logger } from "../../logging/logger.ts";
import { agentAuthOption, type AgentAuthOptionSpec } from "./catalog.ts";
import { detectAgents } from "./detect.ts";

/** Long enough for somebody to find their phone; short enough not to leak processes. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** How long a finished session stays readable, so the modal can show the result. */
const KEEP_FINISHED_MS = 60_000;
/** A login transcript is a screenful. Anything past this is a CLI in a loop. */
const MAX_OUTPUT = 16_000;

interface Session {
  id: string;
  userId: string;
  provider: string;
  label: string;
  option: AgentAuthOptionSpec;
  homeDir: string;
  output: string;
  state: ApiContract.AgentLoginState;
  url?: string;
  code?: string;
  account?: StoredAgentAccount;
  error?: string;
  write: (line: string) => void;
  kill: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Delegated logins: the vendor's own CLI, run on this host, with its output
 * pointed at the browser.
 *
 * This exists because the thing a person actually wants — "use my ChatGPT
 * subscription" — is not something talos can be granted. No vendor here
 * publishes an OAuth app for third parties, so the only way to a subscription
 * credential is the vendor's own login on a machine the person controls. Running
 * it for them and relaying what it prints is as close as it gets, and it has the
 * property that talos never holds the credential: it stays in the config
 * directory the CLI wrote it to.
 *
 * A transcript plus stdin, rather than a parser per vendor. These commands change
 * their wording between releases, and a flow that only proceeds when we recognise
 * a line is a flow that breaks on the next update. `url` and `code` are lifted
 * out for convenience; if a command asks something we did not anticipate, the
 * developer can still read it and type the answer.
 *
 * Sessions are in memory and per process. A restart loses the ones in flight,
 * which is correct — the child processes died with it.
 */
export class AgentLoginManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly accounts: AgentAccountRepository,
    /** Where each account's isolated config directory lives. */
    private readonly homesRoot: string,
    private readonly logger?: Logger,
  ) {}

  async start(input: {
    userId: string;
    optionId: string;
    label: string;
  }): Promise<ApiContract.AgentLoginView> {
    const option = agentAuthOption(input.optionId);
    if (!option?.login) {
      throw new ConfigError(`'${input.optionId}' is not a sign-in-on-this-host option.`);
    }
    const label = input.label.trim();
    if (!label) throw new ConfigError("An account name is required.");
    const provider = input.optionId.split(":")[0]!;

    // One session per account at a time: two `codex login`s writing the same
    // directory would race over auth.json and the second would win silently.
    for (const existing of this.sessions.values()) {
      if (
        existing.state === "running" &&
        existing.userId === input.userId &&
        existing.provider === provider &&
        existing.label === label
      ) {
        return toView(existing);
      }
    }

    // Deterministic rather than random, so reconnecting an account reuses the
    // directory the last credential lived in instead of leaving it orphaned on
    // disk. Per user as well as per account: two developers on one host must not
    // share a login.
    const homeDir = join(this.homesRoot, slug(input.userId), provider, dirName(label));
    await mkdir(homeDir, { recursive: true, mode: 0o700 });

    const id = crypto.randomUUID();
    const proc = Bun.spawn({
      cmd: [...option.login.argv],
      // `HOME` alone is what isolates these: every one of these CLIs keeps its
      // credential under `$HOME/.<vendor>`, which is also why `detectAgents` can
      // be pointed at this directory afterwards to read back who we logged in as.
      // XDG is set alongside it because some builds prefer it and would otherwise
      // fall back to the operator's own config.
      env: {
        ...process.env,
        HOME: homeDir,
        XDG_CONFIG_HOME: join(homeDir, ".config"),
        XDG_CACHE_HOME: join(homeDir, ".cache"),
        XDG_DATA_HOME: join(homeDir, ".local", "share"),
        ...option.login.env,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const session: Session = {
      id,
      userId: input.userId,
      provider,
      label,
      option,
      homeDir,
      output: "",
      state: "running",
      write: (line) => {
        proc.stdin.write(`${line}\n`);
        proc.stdin.flush();
      },
      kill: () => proc.kill(),
      timer: setTimeout(() => {
        proc.kill();
      }, LOGIN_TIMEOUT_MS),
    };
    this.sessions.set(id, session);

    // Both pipes into one transcript, in the order they arrive: these CLIs print
    // the URL to one and the prompt to the other depending on version, and a
    // developer reading it does not care which.
    void this.pump(session, proc.stdout);
    void this.pump(session, proc.stderr);
    void this.finish(session, proc);

    this.logger?.info(
      { provider, option: option.id, label },
      `running '${option.command}' for a delegated agent login`,
    );
    return toView(session);
  }

  view(userId: string, id: string): ApiContract.AgentLoginView | undefined {
    const session = this.sessions.get(id);
    if (!session || session.userId !== userId) return undefined;
    return toView(session);
  }

  /** Answers whatever the command asked — a pasted code, usually. */
  respond(userId: string, id: string, input: string): ApiContract.AgentLoginView {
    const session = this.sessions.get(id);
    if (!session || session.userId !== userId) {
      throw new ConfigError("That sign-in is no longer running.");
    }
    if (session.state !== "running") throw new ConfigError("That sign-in has already finished.");
    session.write(input);
    // Echoed into the transcript so the modal shows the exchange rather than
    // appearing to swallow what was typed. Not the value itself: a pasted OAuth
    // code is a credential for the seconds it is valid.
    session.output += "\n[sent]\n";
    return toView(session);
  }

  cancel(userId: string, id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.userId !== userId) return;
    session.kill();
  }

  private async pump(session: Session, stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      if (session.output.length > MAX_OUTPUT) continue;
      session.output += decoder.decode(chunk, { stream: true });
      session.url ??= firstUrl(session.output);
      session.code ??= firstCode(session.output);
    }
  }

  private async finish(session: Session, proc: Bun.Subprocess): Promise<void> {
    const exitCode = await proc.exited;
    clearTimeout(session.timer);
    // The pumps are still draining when `exited` resolves; the last lines of a
    // login -- "Logged in as …", or the token itself -- are exactly the ones that
    // matter here.
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      if (exitCode !== 0) {
        throw new ConfigError(
          `'${session.option.command}' exited with code ${exitCode}. ` +
            (session.output.trim()
              ? "See the output above."
              : `Is the ${session.provider} CLI installed on this host?`),
        );
      }
      session.account = await this.record(session);
      session.state = "done";
      this.logger?.info(
        { provider: session.provider, account: session.account.account },
        `connected a ${session.provider} account through its own login`,
      );
    } catch (err) {
      session.state = "failed";
      session.error = err instanceof Error ? err.message : String(err);
      this.logger?.warn(
        { provider: session.provider, err: session.error },
        "delegated agent login failed",
      );
    } finally {
      setTimeout(() => this.sessions.delete(session.id), KEEP_FINISHED_MS);
    }
  }

  /** Turns a finished login into the stored account row. */
  private async record(session: Session): Promise<StoredAgentAccount> {
    const capture = session.option.login?.capture;
    if (capture) {
      // Claude's `setup-token` prints the credential and saves it nowhere, so
      // this is the one delegated flow with something to keep. Scrubbed from the
      // transcript in the same step it is stored, because that transcript is
      // about to be sent to a browser.
      const match = session.output.match(capture);
      if (!match) {
        throw new ConfigError(
          `'${session.option.command}' finished without printing a token. Nothing was stored.`,
        );
      }
      session.output = session.output.replaceAll(match[0], "«token stored by talos»");
      const captureEnv = session.option.login?.captureEnv;
      if (!captureEnv) {
        throw new ConfigError(
          `Option '${session.option.id}' captures a token but does not say which variable to ` +
            "set it as. Nothing was stored.",
        );
      }
      return this.accounts.save({
        userId: session.userId,
        provider: session.provider,
        label: session.label,
        method: "key",
        optionId: session.option.id,
        values: { [captureEnv]: match[0] },
      });
    }

    // Read back who we just logged in as, out of the directory the CLI wrote --
    // the same probes the agent picker uses, pointed at this account's home
    // instead of the operator's. Best-effort: an account with no email is still a
    // working account, and the vendors move that field between versions.
    const detected = await detectAgents(session.homeDir).catch(() => []);
    const account = detected.find((entry) => entry.provider === session.provider)?.account;
    return this.accounts.save({
      userId: session.userId,
      provider: session.provider,
      label: session.label,
      method: "cli",
      optionId: session.option.id,
      homeDir: session.homeDir,
      ...(account ? { account } : {}),
    });
  }
}

function toView(session: Session): ApiContract.AgentLoginView {
  return {
    id: session.id,
    provider: session.provider as ApiContract.AgentProvider,
    state: session.state,
    command: session.option.command ?? session.option.login?.argv.join(" ") ?? "",
    output: session.output.slice(0, MAX_OUTPUT),
    ...(session.url ? { url: session.url } : {}),
    ...(session.code ? { code: session.code } : {}),
    ...(session.account ? { account: toAccountView(session.account) } : {}),
    ...(session.error ? { error: session.error } : {}),
  };
}

/** The stored row as the API returns it — no credential, and never one. */
export function toAccountView(account: StoredAgentAccount): ApiContract.AgentAccountView {
  return {
    id: account.id,
    provider: account.provider as ApiContract.AgentProvider,
    label: account.label,
    method: account.method,
    optionId: account.optionId,
    ...(account.account ? { account: account.account } : {}),
    ...(account.unreadable ? { unreadable: true } : {}),
    ...(account.usedForRuns ? { usedForRuns: true } : {}),
    createdAt: account.createdAt.toISOString(),
  };
}

/** The verification URL a device flow printed. */
function firstUrl(output: string): string | undefined {
  // Trailing punctuation trimmed: these are printed inside prose as often as on
  // their own line, and a URL ending in a full stop is a 404.
  return output.match(/https?:\/\/[^\s"'<>]+/)?.[0]?.replace(/[.,)\]]+$/, "");
}

/**
 * The pairing code, when the command printed one.
 *
 * The labelled form is tried first because the shape alone is ambiguous — a
 * request id in a log line looks the same — and a wrong code shown next to the
 * right URL is worse than showing none and letting the transcript speak.
 */
function firstCode(output: string): string | undefined {
  const labelled = output.match(/\bcode[:\s]+([A-Z0-9]{4}[-\s]?[A-Z0-9]{4})\b/i);
  if (labelled?.[1]) return labelled[1].trim();
  return output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
}

/** A path segment that is safe and stable for one label. */
function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "default";
}

/**
 * The directory for one account label — readable, and distinct for labels the
 * slug would collapse together.
 *
 * The hash is not decoration: "Work" and "work" are two different rows by the
 * table's unique key, and letting them share a directory would mean logging into
 * one silently replaced the other's credential.
 */
function dirName(label: string): string {
  const hash = createHash("sha256").update(label).digest("hex").slice(0, 8);
  return `${slug(label)}-${hash}`;
}
