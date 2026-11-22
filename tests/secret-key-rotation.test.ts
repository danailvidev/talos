import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCipher } from "../src/secrets/crypto.ts";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("offline TALOS_SECRET_KEY rotation", () => {
  test("backs up and re-encrypts every credential-bearing column", async () => {
    directory = await mkdtemp(join(tmpdir(), "talos-key-rotation-"));
    const database = join(directory, "talos.db");
    const backup = join(directory, "talos.db.backup");
    const oldKeyFile = join(directory, "old-key");
    const newKeyFile = join(directory, "new-key");
    const oldKey = "old-key-" + "a".repeat(56);
    const newKey = "new-key-" + "b".repeat(56);
    const oldCipher = createCipher(oldKey);

    await writeFile(oldKeyFile, oldKey, { mode: 0o600 });
    await writeFile(newKeyFile, newKey, { mode: 0o600 });
    await chmod(oldKeyFile, 0o600);
    await chmod(newKeyFile, 0o600);

    const db = new Database(database);
    db.run("CREATE TABLE user_credentials (value TEXT)");
    db.run("CREATE TABLE slack_connections (access_token TEXT, refresh_token TEXT)");
    db.run("CREATE TABLE agent_accounts (secret TEXT)");
    db.run("CREATE TABLE integration_config (value TEXT, encrypted INTEGER)");
    db.run("CREATE TABLE e2e_test_config (runtime_config_override TEXT)");
    db.run("INSERT INTO user_credentials VALUES (?)", [oldCipher.encrypt("gitlab")]);
    db.run("INSERT INTO slack_connections VALUES (?, ?)", [
      oldCipher.encrypt("slack-access"),
      oldCipher.encrypt("slack-refresh"),
    ]);
    db.run("INSERT INTO agent_accounts VALUES (?)", [oldCipher.encrypt("agent")]);
    db.run("INSERT INTO integration_config VALUES (?, 1)", [oldCipher.encrypt("jira")]);
    db.run("INSERT INTO integration_config VALUES ('not-secret', 0)");
    db.run("INSERT INTO e2e_test_config VALUES (?)", [oldCipher.encrypt("qa")]);
    db.close();

    const process = Bun.spawn(
      ["bun", "run", "scripts/rotate-secret-key.ts", database, backup],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...Bun.env,
          TALOS_OLD_SECRET_KEY_FILE: oldKeyFile,
          TALOS_NEW_SECRET_KEY_FILE: newKeyFile,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await process.exited).toBe(0);
    expect(await Bun.file(backup).exists()).toBe(true);

    const rotated = new Database(database, { readonly: true });
    const newCipher = createCipher(newKey);
    const values = [
      rotated.query<{ value: string }, []>("SELECT value FROM user_credentials").get()!.value,
      rotated.query<{ value: string }, []>("SELECT access_token AS value FROM slack_connections")
        .get()!.value,
      rotated.query<{ value: string }, []>("SELECT refresh_token AS value FROM slack_connections")
        .get()!.value,
      rotated.query<{ value: string }, []>("SELECT secret AS value FROM agent_accounts").get()!.value,
      rotated.query<{ value: string }, []>(
        "SELECT value FROM integration_config WHERE encrypted = 1",
      ).get()!.value,
      rotated.query<{ value: string }, []>(
        "SELECT runtime_config_override AS value FROM e2e_test_config",
      ).get()!.value,
    ];
    expect(values.map((value) => newCipher.decrypt(value))).toEqual([
      "gitlab",
      "slack-access",
      "slack-refresh",
      "agent",
      "jira",
      "qa",
    ]);
    expect(
      rotated.query<{ value: string }, []>(
        "SELECT value FROM integration_config WHERE encrypted = 0",
      ).get()!.value,
    ).toBe("not-secret");
    rotated.close();
  });
});
