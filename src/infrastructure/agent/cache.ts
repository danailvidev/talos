import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../logging/logger.ts";
import {
  AGENT_EXECUTION_LABEL,
  AGENT_MANAGED_LABEL,
  agentContainerName,
  agentUserArgs,
  dockerSilent,
  writeSecretFiles,
} from "./containers.ts";
import { AGENT_IMAGE_TAG, AGENT_SECRETS_MOUNT } from "./image.ts";

/**
 * Docker volumes that outlive agent containers, so each fresh container skips
 * the work every job used to repeat: a full clone and a cold dependency install.
 *
 * Containers themselves are never reused. Each job runs as a different developer
 * with different credentials mounted at creation, and a reused container would
 * carry one job's checkout and shell state into the next.
 *
 * `-v2` since containers stopped running as root: the original volumes are
 * root-owned, and a fresh one takes the image's world-writable mount point.
 */
export const GIT_CACHE_VOLUME = "talos-git-cache-v2";
export const PACKAGE_CACHE_VOLUME = "talos-package-cache-v2";

const REFRESH_TIMEOUT_MS = 10 * 60_000;

let enabled = true;

/** `TALOS_AGENT_CACHE=0` turns both caches off; runs then clone and install from the network. */
export function setAgentWorkspaceCache(next: boolean): void {
  enabled = next;
}

export function agentWorkspaceCacheEnabled(): boolean {
  return enabled;
}

/**
 * Fetches the job's branch (and target) into the project's cache using the
 * job's own token. Resolves false rather than throwing: a missing or broken
 * cache costs a network clone, never the run.
 */
export async function refreshGitCache(options: {
  executionId: string;
  label?: string | number;
  project: string;
  branch: string;
  targetBranch?: string;
  token: string;
  signal: AbortSignal;
  logger?: Logger;
}): Promise<boolean> {
  if (!enabled) return false;
  const containerName = agentContainerName(options.executionId, `${options.label ?? "agent"}-git-cache`);
  const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, timeout]);
  const started = performance.now();
  const secretsDir = await mkdtemp(join(tmpdir(), "talos-git-cache-secrets-"));
  const kill = () => void dockerSilent("rm", "-f", containerName);
  signal.addEventListener("abort", kill, { once: true });
  try {
    await writeSecretFiles(secretsDir, { "gitlab-token": options.token });
    const args = [
      "docker",
      "run",
      "--rm",
      "--name",
      containerName,
      "--label",
      `${AGENT_MANAGED_LABEL}=1`,
      "--label",
      `${AGENT_EXECUTION_LABEL}=${options.executionId}`,
      ...agentUserArgs(),
      "--memory",
      "1g",
      "--pids-limit",
      "256",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--entrypoint",
      "/refresh-git-cache.sh",
      "-e",
      `PROJECT=${options.project}`,
      "-e",
      `BRANCH=${options.branch}`,
      ...(options.targetBranch ? ["-e", `TARGET=${options.targetBranch}`] : []),
      "-v",
      `${secretsDir}:${AGENT_SECRETS_MOUNT}:rw`,
      "--mount",
      `type=volume,src=${GIT_CACHE_VOLUME},dst=/cache/git`,
      AGENT_IMAGE_TAG,
    ];
    const proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe", signal });
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    const durationMs = Math.round(performance.now() - started);
    if (exitCode === 0) {
      options.logger?.info({ project: options.project, durationMs }, "repository cache refreshed");
      return true;
    }
    options.logger?.warn(
      { project: options.project, exitCode, durationMs, stderr: redact(stderr.trim(), options.token).slice(-2_000) },
      "repository cache refresh failed; cloning from the network",
    );
    return false;
  } catch (error) {
    if (options.signal.aborted) throw error;
    options.logger?.warn(
      { project: options.project, timedOut: timeout.aborted },
      "repository cache refresh did not finish; cloning from the network",
    );
    return false;
  } finally {
    signal.removeEventListener("abort", kill);
    await rm(secretsDir, { recursive: true, force: true });
  }
}

/**
 * Mounts for the agent container. The repository cache is the one project's
 * subdirectory only, read-only. The package cache is writable because installs
 * fill it, and only mounted for writing policies, the only runs that install;
 * npm, yarn and pnpm verify package integrity against the lockfile on read.
 */
export function agentCacheArgs(options: {
  project: string | undefined;
  gitCacheReady: boolean;
  writes: boolean;
}): string[] {
  if (!enabled) return [];
  return [
    ...(options.project && options.gitCacheReady
      ? [
          "--mount",
          `type=volume,src=${GIT_CACHE_VOLUME},dst=/cache/repo,volume-subpath=${options.project}.git,readonly`,
        ]
      : []),
    ...(options.writes
      ? [
          "--mount",
          `type=volume,src=${PACKAGE_CACHE_VOLUME},dst=/cache/packages`,
          "-e",
          "npm_config_cache=/cache/packages/npm",
          "-e",
          "YARN_CACHE_FOLDER=/cache/packages/yarn",
          "-e",
          "npm_config_store_dir=/cache/packages/pnpm",
          "-e",
          "BUN_INSTALL_CACHE_DIR=/cache/packages/bun",
        ]
      : []),
  ];
}

function redact(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}
