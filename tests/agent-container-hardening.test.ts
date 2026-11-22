import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentUserArgs, shellEnvFile } from "../src/infrastructure/agent/containers.ts";
import { AGENT_ENTRYPOINT_SH, GIT_CACHE_REFRESH_SH } from "../src/infrastructure/agent/image.ts";

/**
 * Stands in for the docker CLI: records the argv of `docker run` and what the
 * mounted secrets directory held while the "container" was running, then
 * replies like an agent that answered `{"ok":true}`.
 */
const RESULT_LINE = JSON.stringify({
  type: "result",
  result: '```json\n{"ok":true}\n```',
  num_turns: 2,
  duration_ms: 250,
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 40,
  },
});
const FAKE_DOCKER = String.raw`#!/bin/sh
[ "$1" = "run" ] || exit 0
printf '%s\n' "$@" > "$FAKE_DOCKER_LOG.args"
prev=""
for a in "$@"; do
  if [ "$prev" = "-v" ]; then
    case "$a" in
      *:/run/talos-secrets:rw)
        dir="$(printf '%s' "$a" | cut -d: -f1)"
        echo "$dir" > "$FAKE_DOCKER_LOG.dir"
        for f in "$dir"/*; do
          [ -f "$f" ] || continue
          printf '== %s %s\n' "$(basename "$f")" "$(stat -c %a "$f")" >> "$FAKE_DOCKER_LOG.secrets"
          cat "$f" >> "$FAKE_DOCKER_LOG.secrets"
          printf '\n' >> "$FAKE_DOCKER_LOG.secrets"
        done
        ;;
    esac
  fi
  prev="$a"
done
cat "$FAKE_DOCKER_LOG.result"
`;

let binDir: string;
let log: string;

beforeEach(async () => {
  binDir = await mkdtemp(join(tmpdir(), "talos-fake-docker-"));
  log = join(binDir, "log");
  await writeFile(join(binDir, "docker"), FAKE_DOCKER);
  await chmod(join(binDir, "docker"), 0o755);
  await writeFile(`${log}.result`, `${RESULT_LINE}\n`);
});

afterEach(async () => {
  await rm(binDir, { recursive: true, force: true });
});

describe("agent container hardening", () => {
  test("runs as the host user, without DAC_OVERRIDE, and keeps secrets off the argv", async () => {
    // A child process, because Bun resolves `docker` against the PATH it started with.
    const proc = Bun.spawn(["bun", join(import.meta.dir, "fixtures", "run-agent-job.ts")], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, FAKE_DOCKER_LOG: log },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout.trim().split("\n").at(-1)).toBe('{"ok":true}');

    const args = await readFile(`${log}.args`, "utf8");
    expect(args).toContain(`--user\n${process.getuid!()}:${process.getgid!()}\n`);
    expect(args).toContain("HOME=/home/talos");
    expect(args).not.toContain("DAC_OVERRIDE");
    expect(args).not.toContain("GITLAB_TOKEN=");
    expect(args).not.toContain("glpat-super-secret");
    expect(args).not.toContain("sk-ant-it's-secret");
    expect(args).not.toContain(":/root/");

    const secrets = await readFile(`${log}.secrets`, "utf8");
    expect(secrets).toContain("== gitlab-token 600\nglpat-super-secret");
    expect(secrets).toContain("== agent.env 600\nexport ANTHROPIC_API_KEY='sk-ant-it'\\''s-secret'");

    const secretsDir = (await readFile(`${log}.dir`, "utf8")).trim();
    expect(existsSync(secretsDir)).toBe(false);

    const usage = JSON.parse(await readFile(`${log}.usage`, "utf8"));
    expect(usage).toMatchObject({
      userId: "test-user",
      accountId: "test-account",
      accountLabel: "test account",
      optionId: "claude:key-api",
      authSource: "connected",
      source: "task",
      executionId: "hardening-test",
      status: "success",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 40,
        turns: 2,
        durationMs: 250,
      },
    });
  });

  test("uid and gid come from the Talos process", () => {
    expect(agentUserArgs()).toEqual([
      "--user",
      `${process.getuid!()}:${process.getgid!()}`,
      "-e",
      "HOME=/home/talos",
    ]);
  });
});

describe("shellEnvFile", () => {
  test("round-trips quotes, spaces and newlines through sh", async () => {
    const value = `it's "quoted" $HOME \`x\`\nline two`;
    const dir = await mkdtemp(join(tmpdir(), "talos-env-file-"));
    try {
      await writeFile(join(dir, "agent.env"), shellEnvFile({ TALOS_TEST_VALUE: value }));
      const proc = Bun.spawn(
        ["sh", "-c", `set -a; . "${join(dir, "agent.env")}"; printf '%s' "$TALOS_TEST_VALUE"`],
        { stdout: "pipe" },
      );
      expect(await new Response(proc.stdout).text()).toBe(value);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses names that are not shell identifiers", () => {
    expect(() => shellEnvFile({ "BAD-NAME": "x" })).toThrow("Invalid agent environment variable name");
    expect(() => shellEnvFile({ "A;rm -rf /": "x" })).toThrow();
  });
});

describe("entrypoints read and delete their secret files", () => {
  test("agent entrypoint", () => {
    expect(AGENT_ENTRYPOINT_SH).toContain('GITLAB_TOKEN="$(cat /run/talos-secrets/gitlab-token)"');
    expect(AGENT_ENTRYPOINT_SH).toContain("rm -f /run/talos-secrets/gitlab-token");
    expect(AGENT_ENTRYPOINT_SH).toContain(". /run/talos-secrets/agent.env");
    expect(AGENT_ENTRYPOINT_SH).toContain("rm -f /run/talos-secrets/agent.env");
    expect(AGENT_ENTRYPOINT_SH).toContain("unset GITLAB_TOKEN");
    expect(AGENT_ENTRYPOINT_SH).toContain('corepack enable --install-directory "$NPM_CONFIG_PREFIX/bin"');
    expect(AGENT_ENTRYPOINT_SH).not.toContain("rm -rf /workspace\n");
  });

  test("git cache refresh", () => {
    expect(GIT_CACHE_REFRESH_SH).toContain('GITLAB_TOKEN="$(cat /run/talos-secrets/gitlab-token)"');
    expect(GIT_CACHE_REFRESH_SH).toContain("rm -f /run/talos-secrets/gitlab-token");
  });
});
