import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../../core/errors.ts";
import type { Logger } from "../../logging/logger.ts";
// @ts-expect-error Bun embeds non-TypeScript files imported with the text loader.
import agentDockerfile from "../../../images/agent/v15/Dockerfile" with { type: "text" };
// @ts-expect-error Bun embeds non-TypeScript files imported with the text loader.
import agentEntrypoint from "../../../images/agent/v15/entrypoint.sh" with { type: "text" };
// @ts-expect-error Bun embeds non-TypeScript files imported with the text loader.
import gitCacheRefresh from "../../../images/agent/v15/refresh-git-cache.sh" with { type: "text" };

/**
 * Bumped by hand whenever the versioned Dockerfile or entrypoints change — the same
 * append-only convention `persistence/migrations.ts` uses for schema versions.
 * `ensureAgentImage` skips the build whenever this tag already exists, so bumping
 * it is what forces a rebuild.
 *
 * One tag, not one per task. Reviewing and fixing differ in which tools Claude may
 * call and in whether the result gets pushed — neither is a different *image*, and
 * maintaining two meant two builds, two caches, and two entrypoints that drifted
 * apart (the review one never stripped the token from `origin`, which was only
 * safe because that agent had no Bash).
 *
 * Also bumped to pull a newer `@anthropic-ai/claude-code`: the image install is
 * unpinned, so a long-lived image keeps whatever CLI it was built with, and that
 * CLI is what resolves `--model sonnet` to a concrete snapshot. A stale image
 * silently runs a model generation behind the alias.
 */
export const AGENT_IMAGE_TAG = "talos-agent:17";

/**
 * The exit code the entrypoint uses for "the branch is not where we left it".
 * Distinct from any failure of the agent itself, because it is *retryable*: the
 * work is still wanted, just against the new head.
 */
export const BRANCH_MOVED_EXIT_CODE = 42;

/** The agent's `$HOME` inside every container; world-writable in both images. */
export const AGENT_HOME = "/home/talos";

/** Where the agent entrypoint and the git-cache refresh read their credentials. */
export const AGENT_SECRETS_MOUNT = "/run/talos-secrets";
const SECRETS = AGENT_SECRETS_MOUNT;

/**
 * Small Node base: `@anthropic-ai/claude-code` is an npm package, and `git` is the
 * only other thing the entrypoint needs. Installed via npm rather than the native
 * installer used interactively on a desktop, since npm is the documented
 * container-friendly path.
 *
 * Containers run as the host's uid (see `agentUserArgs`), which has no entry in
 * this image, so everything it writes to is created world-writable here. The
 * cache dirs are too, because an empty named volume takes its first mount
 * point's permissions. `NPM_CONFIG_PREFIX` is set only after claude-code is
 * installed: from then on, the entrypoint's `npm install -g` lands in `$HOME`.
 */
const DOCKERFILE = agentDockerfile;

/**
 * Brings one project's bare repository cache up to date with the job's own
 * token. Run as its own container, before the agent's, because the agent has
 * Bash: a cache it could write would let it plant config or hooks that run
 * inside a later job holding somebody else's token. The agent container only
 * ever sees its project's cache read-only.
 *
 * The fetch is also the access check — the agent container gets the cache only
 * when this developer's token could fetch the project just now.
 * `--no-write-fetch-head` keeps the token-bearing URL out of the cache; nothing
 * else records it, since the fetch is by URL with no configured remote.
 */
export const GIT_CACHE_REFRESH_SH = gitCacheRefresh;

/**
 * Everything that happens around the agent, in the order it has to happen.
 *
 * The clone stays inside the container so `GITLAB_TOKEN` never touches the host
 * checkout, and the whole script is driven by env vars the host sets from a
 * `WritePolicy` — one script, because the *sequence* is identical for every agent
 * and only the tools and the ending differ.
 *
 * Credentials are stripped from `origin` immediately after the last read that
 * needs them and re-added only for the push. A write-policy agent gets `Bash`, so
 * anything left in `.git/config` is something the agent can read.
 */
export const AGENT_ENTRYPOINT_SH = agentEntrypoint;

/** Throws with a clear, actionable message if Docker isn't usable on this host. */
export async function requireDocker(): Promise<void> {
  const proc = Bun.spawn(["docker", "version", "--format", "{{.Server.Version}}"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    throw new ConfigError(
      "Talos runs Claude agents inside a container, so it requires Docker — " +
        "'docker version' failed. Install Docker and make sure the daemon is running.",
    );
  }
}

/**
 * Builds the agent image if it does not already exist. The versioned checked-in
 * context is imported as text so compiled binaries retain local-build support; the
 * embedded files are materialized in a temporary Docker context at build time.
 */
let imagePreparation: Promise<void> | undefined;

export function ensureAgentImage(logger?: Logger): Promise<void> {
  if (Bun.env.TALOS_EXECUTOR?.trim() === "kubernetes") return Promise.resolve();
  if (!imagePreparation) {
    imagePreparation = prepareAgentImage(logger).catch((error) => {
      imagePreparation = undefined;
      throw error;
    });
  }
  return imagePreparation;
}

async function prepareAgentImage(logger?: Logger): Promise<void> {
  await requireDocker();

  const inspect = Bun.spawn(["docker", "image", "inspect", AGENT_IMAGE_TAG], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await inspect.exited) === 0) return;

  logger?.info({ tag: AGENT_IMAGE_TAG }, `building ${AGENT_IMAGE_TAG} — this happens once`);

  const buildDir = await mkdtemp(join(tmpdir(), "talos-agent-image-"));
  try {
    await writeFile(join(buildDir, "Dockerfile"), DOCKERFILE);
    await writeFile(join(buildDir, "entrypoint.sh"), AGENT_ENTRYPOINT_SH, { mode: 0o755 });
    await writeFile(join(buildDir, "refresh-git-cache.sh"), GIT_CACHE_REFRESH_SH, { mode: 0o755 });

    // --no-cache: the npm install below is unpinned so it should pull whatever
    // @anthropic-ai/claude-code npm serves right now, but the Dockerfile text
    // that runs it never changes between tag bumps — without this, Docker
    // reuses that layer's old cached result and a "rebuild" installs nothing
    // new. Only paid once per bump, since ensureAgentImage already skips this
    // whole function once AGENT_IMAGE_TAG exists.
    const build = Bun.spawn(["docker", "build", "--no-cache", "-t", AGENT_IMAGE_TAG, buildDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
    ]);

    if (exitCode !== 0) {
      throw new ConfigError(`docker build for ${AGENT_IMAGE_TAG} failed:\n${stderr.trim()}`);
    }
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
}
