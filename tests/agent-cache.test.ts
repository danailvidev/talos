import { afterEach, describe, expect, test } from "bun:test";
import { agentCacheArgs, setAgentWorkspaceCache } from "../src/infrastructure/agent/cache.ts";
import { AGENT_ENTRYPOINT_SH, GIT_CACHE_REFRESH_SH } from "../src/infrastructure/agent/image.ts";

afterEach(() => setAgentWorkspaceCache(true));

describe("agent workspace caches", () => {
  test("mounts only the project's repository cache, read-only, once refreshed", () => {
    const args = agentCacheArgs({ project: "group/app", gitCacheReady: true, writes: false }).join(" ");
    expect(args).toContain("dst=/cache/repo,volume-subpath=group/app.git,readonly");
    expect(args).not.toContain("/cache/packages");

    expect(agentCacheArgs({ project: "group/app", gitCacheReady: false, writes: false })).toEqual([]);
  });

  test("mounts the package cache only for runs that install", () => {
    const args = agentCacheArgs({ project: undefined, gitCacheReady: false, writes: true }).join(" ");
    expect(args).toContain("dst=/cache/packages");
    expect(args).toContain("npm_config_cache=/cache/packages/npm");
  });

  test("mounts nothing when disabled", () => {
    setAgentWorkspaceCache(false);
    expect(agentCacheArgs({ project: "group/app", gitCacheReady: true, writes: true })).toEqual([]);
  });

  test("the refresh script keeps the token out of the cache and refuses unsafe paths", () => {
    expect(GIT_CACHE_REFRESH_SH).toContain("--no-write-fetch-head");
    expect(GIT_CACHE_REFRESH_SH).not.toContain("remote add");
    expect(GIT_CACHE_REFRESH_SH).toContain('""|/*|*..*)');
    expect(GIT_CACHE_REFRESH_SH).toContain("flock");
  });

  test("the entrypoint falls back to a network clone when the cache cannot be used", () => {
    expect(AGENT_ENTRYPOINT_SH).toContain("/cache/repo /workspace");
    expect(AGENT_ENTRYPOINT_SH).toContain("git -c safe.directory=/cache/repo clone");
    expect(AGENT_ENTRYPOINT_SH).toContain('git -C /workspace remote set-url origin "$auth_url"');
    expect(AGENT_ENTRYPOINT_SH).toContain('git clone $clone_filter --single-branch --branch "$BRANCH" "$auth_url" /workspace');
  });
});
