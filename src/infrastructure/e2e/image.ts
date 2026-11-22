import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../../core/errors.ts";
import type { Logger } from "../../logging/logger.ts";
import { requireDocker } from "../agent/image.ts";
// @ts-expect-error Bun embeds non-TypeScript files imported with the text loader.
import e2eDockerfile from "../../../images/e2e/v11/Dockerfile" with { type: "text" };
// @ts-expect-error Bun embeds non-TypeScript files imported with the text loader.
import e2eEntrypoint from "../../../images/e2e/v11/entrypoint.mjs" with { type: "text" };

export const E2E_IMAGE_TAG = "talos-e2e-agent:12";

/** Runs as the host's uid (see `agentUserArgs`), so its writable paths are world-writable. */
const DOCKERFILE = e2eDockerfile;

export const E2E_ENTRYPOINT = e2eEntrypoint;

let preparation: Promise<void> | undefined;

export function ensureE2eImage(logger?: Logger): Promise<void> {
  if (Bun.env.TALOS_EXECUTOR?.trim() === "kubernetes") return Promise.resolve();
  if (!preparation) {
    preparation = prepare(logger).catch((error) => {
      preparation = undefined;
      throw error;
    });
  }
  return preparation;
}

async function prepare(logger?: Logger): Promise<void> {
  await requireDocker();
  const inspect = Bun.spawn(["docker", "image", "inspect", E2E_IMAGE_TAG], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await inspect.exited) === 0) return;
  logger?.info({ tag: E2E_IMAGE_TAG }, `building ${E2E_IMAGE_TAG} — this happens once`);
  const directory = await mkdtemp(join(tmpdir(), "talos-e2e-image-"));
  try {
    await writeFile(join(directory, "Dockerfile"), DOCKERFILE);
    await writeFile(join(directory, "entrypoint.mjs"), E2E_ENTRYPOINT);
    const build = Bun.spawn(["docker", "build", "--no-cache", "-t", E2E_IMAGE_TAG, directory], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, , stderr] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new ConfigError(`docker build for ${E2E_IMAGE_TAG} failed:\n${stderr.trim()}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
