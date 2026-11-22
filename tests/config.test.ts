import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/load.ts";
import { ConfigError, ValidationError } from "../src/core/errors.ts";

const dirs: string[] = [];

async function writeConfig(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "talos-cfg-"));
  dirs.push(dir);
  const path = join(dir, "talos.yaml");
  await Bun.write(path, yaml);
  return path;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("loadConfig", () => {
  test("applies defaults to an empty file", async () => {
    const { config } = await loadConfig(await writeConfig(""));
    expect(config.logLevel).toBe("info");
    expect(config.database).toBe("./data/talos.db");
  });

  test("resolves a relative database path against the config directory", async () => {
    const path = await writeConfig("database: ./state/db.sqlite\n");
    const { databasePath } = await loadConfig(path);
    expect(databasePath).toBe(join(path, "..", "state", "db.sqlite"));
  });

  test("keeps an absolute database path as given", async () => {
    const { databasePath } = await loadConfig(
      await writeConfig("database: /var/lib/talos/db.sqlite\n"),
    );
    expect(databasePath).toBe("/var/lib/talos/db.sqlite");
  });

  test("names the missing file rather than failing obscurely", async () => {
    await expect(loadConfig("/nonexistent/nope.yaml")).rejects.toThrow(ConfigError);
  });

  test("rejects malformed YAML", async () => {
    await expect(loadConfig(await writeConfig("logLevel: [unclosed\n"))).rejects.toThrow(
      ConfigError,
    );
  });

  test("rejects an unknown log level with a validation error", async () => {
    await expect(loadConfig(await writeConfig("logLevel: chatty\n"))).rejects.toThrow(
      ValidationError,
    );
  });

  test("keeps per-task workflows blocks instead of dropping them", async () => {
    const { config } = await loadConfig(
      await writeConfig(
        "workflows:\n  gitlab-ci-failure:\n    pipelineSchedule: nightly\n    anyStatus: true\n",
      ),
    );
    expect(config.workflows?.["gitlab-ci-failure"]).toEqual({
      pipelineSchedule: "nightly",
      anyStatus: true,
    });
  });
});
