import type * as ApiContract from "../../../shared/api-contract.ts";
import type { AgentProvider } from "./detect.ts";

/**
 * What it takes to connect one vendor's agent account to talos, per vendor.
 *
 * The uncomfortable finding this file encodes: none of these vendors publish an
 * OAuth app a third party can use. There is no "Sign in with ChatGPT" talos
 * could implement to act on somebody's Plus plan, and the same goes for Claude
 * subscriptions, Copilot seats and Cursor plans. The subscription credential is
 * always minted by the vendor's own CLI, on a machine the person controls.
 *
 * So there are exactly two shapes, and every option below is one of them:
 *
 *   `key` — the developer pastes a credential. Either an API key that bills usage
 *           directly, or a subscription token their own CLI printed for them
 *           (`claude setup-token`, a GitHub PAT with Copilot Requests), or the
 *           handful of values a cloud provider needs (Bedrock: a region and a key).
 *           talos encrypts the set and injects it as the option's `fields`.
 *
 *   `cli` — talos runs `command` on the host against a config directory it
 *           reserved for this account, and shows the developer what it prints.
 *           The vendor mints and keeps the credential; talos stores none of
 *           it. See `login.ts`.
 *
 * `needsCli` is the honest caveat on the second shape and on the tokens that a
 * CLI has to print: it says whether the vendor's own tooling must be installed
 * on this host for the option to work at all.
 */
export interface AgentAuthOptionSpec extends ApiContract.AgentAuthOption {
  /**
   * How to run the vendor's login, for `cli` options.
   *
   * `argv` is spawned directly — no shell — with `HOME` pointed at the account's
   * own directory, so two ChatGPT accounts do not overwrite each other's
   * `~/.codex/auth.json`.
   */
  login?: {
    argv: readonly string[];
    /** Added to the child's environment, on top of the isolated `HOME`. */
    env?: Readonly<Record<string, string>>;
    /**
     * When the command's whole output *is* the credential (Claude's
     * `setup-token`), the pattern that finds it. Matched against the transcript;
     * the match is stored encrypted and scrubbed from what the browser sees.
     * Absent for the flows that leave their credential in `HOME`.
     */
    capture?: RegExp;
    /**
     * The variable a captured credential is injected as. Here rather than on the
     * option, because it is only meaningful together with `capture` — the option
     * itself is a delegated login, not something you paste a value into.
     */
    captureEnv?: string;
  };
}

export interface AgentCatalogSpec {
  provider: AgentProvider;
  name: string;
  tagline: string;
  docs: string;
  options: readonly AgentAuthOptionSpec[];
}

export const AGENT_CATALOG: readonly AgentCatalogSpec[] = [
  {
    provider: "claude",
    name: "Claude Code",
    tagline: "Anthropic's coding agent — the one talos runs today.",
    docs: "https://code.claude.com/docs/en/setup",
    // Bedrock first because it is what teams running Claude through their own AWS
    // account need, and because the first option is what the add dialog preselects.
    // Order here is "most likely to be the right answer", not the order these
    // authentication routes appeared.
    options: [
      {
        id: "claude:bedrock-iam",
        method: "key",
        label: "Amazon Bedrock — IAM credentials",
        description:
          "Claude on your own AWS account, with an IAM access key. Usage bills to " +
          "AWS rather than to an Anthropic plan, and the models available are the " +
          "ones that account has enabled in the region. Works with temporary STS " +
          "credentials too.",
        fields: [
          { env: "CLAUDE_CODE_USE_BEDROCK", value: "1" },
          { env: "AWS_REGION", label: "Region", hint: "us-east-1" },
          { env: "AWS_ACCESS_KEY_ID", label: "Access key ID", secret: true, hint: "AKIA…" },
          { env: "AWS_SECRET_ACCESS_KEY", label: "Secret access key", secret: true },
          // Temporary credentials only, hence optional — a long-lived IAM key has
          // no session token and asking for one would look like a missing field.
          {
            env: "AWS_SESSION_TOKEN",
            label: "Session token",
            secret: true,
            optional: true,
          },
        ],
        needsCli: false,
      },
      {
        id: "claude:bedrock-token",
        method: "key",
        label: "Amazon Bedrock — API key",
        description:
          "The same thing with a Bedrock API key instead of an IAM access key — one " +
          "long-lived credential minted in the Bedrock console, for accounts that " +
          "have them.",
        fields: [
          // A switch rather than a credential: Claude Code only talks to Bedrock
          // when this is set, and the value is always 1.
          { env: "CLAUDE_CODE_USE_BEDROCK", value: "1" },
          { env: "AWS_REGION", label: "Region", hint: "us-east-1" },
          {
            env: "AWS_BEARER_TOKEN_BEDROCK",
            label: "Bedrock API key",
            secret: true,
            hint: "ABSKQmVk…",
          },
        ],
        needsCli: false,
      },
      {
        id: "claude:key-oauth",
        method: "key",
        label: "Claude subscription token",
        description:
          "Run `claude setup-token` on a machine you are logged in on. It prints a " +
          "one-year token and saves it nowhere — paste it here. Work runs against " +
          "your Pro or Max plan.",
        fields: [{ env: "CLAUDE_CODE_OAUTH_TOKEN", secret: true, hint: "sk-ant-oat01-…" }],
        needsCli: true,
      },
      {
        id: "claude:key-api",
        method: "key",
        label: "Anthropic API key",
        description:
          "A key from console.anthropic.com. Billed as API usage against that " +
          "organisation, not against a subscription.",
        fields: [{ env: "ANTHROPIC_API_KEY", secret: true, hint: "sk-ant-api03-…" }],
        needsCli: false,
      },
      {
        id: "claude:cli",
        method: "cli",
        label: "Sign in on this host",
        description:
          "talos runs `claude setup-token` for you and keeps the token it " +
          "prints. You will get a URL to open and a code to paste back.",
        command: "claude setup-token",
        needsCli: true,
        login: {
          argv: ["claude", "setup-token"],
          // The token is printed to the terminal and stored nowhere, so unlike
          // every other `cli` option this one has something to keep. Captured
          // here and encrypted like a pasted key -- which is also why it is
          // scrubbed out of the transcript before the browser sees it.
          capture: /sk-ant-oat[\w-]{10,}/,
          captureEnv: "CLAUDE_CODE_OAUTH_TOKEN",
        },
      },
    ],
  },
  {
    provider: "codex",
    name: "Codex",
    tagline: "OpenAI's coding agent, on your ChatGPT plan or an API key.",
    docs: "https://developers.openai.com/codex/auth",
    options: [
      {
        id: "codex:cli",
        method: "cli",
        label: "Connect your ChatGPT account",
        description:
          "talos runs Codex's own device login. Open the URL it prints, enter " +
          "the code, and work runs on your ChatGPT Plus, Pro or Business plan. " +
          "Device login has to be allowed in your account's security settings.",
        command: "codex login --device-auth",
        needsCli: true,
        login: {
          // Device flow rather than `codex login`: the plain command starts a
          // local callback server on port 1455 and expects a browser on this
          // machine, which is exactly what a console on a remote host does not
          // have.
          argv: ["codex", "login", "--device-auth"],
        },
      },
      {
        id: "codex:key",
        method: "key",
        label: "OpenAI API key",
        description:
          "A key from platform.openai.com. Billed as API usage — a ChatGPT " +
          "subscription does not cover it.",
        fields: [{ env: "OPENAI_API_KEY", secret: true, hint: "sk-proj-…" }],
        needsCli: false,
      },
    ],
  },
  {
    provider: "cursor",
    name: "Cursor",
    tagline: "Cursor's agent CLI, on your Cursor plan.",
    docs: "https://cursor.com/docs/cli/reference/authentication",
    options: [
      {
        id: "cursor:cli",
        method: "cli",
        label: "Connect your Cursor account",
        description:
          "talos runs `agent login` without opening a browser, so it prints a " +
          "URL you can open anywhere. Work runs on your Cursor plan.",
        command: "NO_OPEN_BROWSER=1 agent login",
        needsCli: true,
        login: {
          argv: ["agent", "login"],
          // Without this the CLI tries to open a browser on the host and prints
          // nothing useful to stdout -- there would be no URL to show.
          env: { NO_OPEN_BROWSER: "1" },
        },
      },
      {
        id: "cursor:key",
        method: "key",
        label: "Cursor API key",
        description: "A key from your Cursor dashboard, billed to that account.",
        fields: [{ env: "CURSOR_API_KEY", secret: true }],
        needsCli: false,
      },
    ],
  },
  {
    provider: "copilot",
    name: "GitHub Copilot",
    tagline: "GitHub's agent CLI, on your Copilot seat.",
    docs: "https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli",
    options: [
      {
        id: "copilot:key",
        method: "key",
        label: "GitHub personal access token",
        description:
          "A fine-grained token with the Copilot Requests permission, on an " +
          "account that has a Copilot seat. Copilot CLI has no scriptable login, " +
          "so this is the only way to connect it from here.",
        fields: [{ env: "COPILOT_GITHUB_TOKEN", secret: true, hint: "github_pat_…" }],
        needsCli: false,
      },
    ],
  },
];

const OPTIONS = new Map<string, AgentAuthOptionSpec>(
  AGENT_CATALOG.flatMap((entry) => entry.options.map((option) => [option.id, option] as const)),
);

/** The option an account was created through, or undefined if the id is unknown. */
export function agentAuthOption(optionId: string): AgentAuthOptionSpec | undefined {
  return OPTIONS.get(optionId);
}

export function agentCatalogEntry(provider: string): AgentCatalogSpec | undefined {
  return AGENT_CATALOG.find((entry) => entry.provider === provider);
}

/**
 * The catalog as the browser sees it: everything above except the `login` specs,
 * which name executables and so are the server's business.
 */
export function agentCatalogView(): ApiContract.AgentCatalogEntry[] {
  return AGENT_CATALOG.map((entry) => ({
    provider: entry.provider,
    name: entry.name,
    tagline: entry.tagline,
    docs: entry.docs,
    options: entry.options.map(({ login: _login, ...option }) => option),
    accounts: [],
  }));
}
