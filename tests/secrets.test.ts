import { describe, expect, test } from "bun:test";
import { ConfigError } from "../src/core/errors.ts";
import { createCipher } from "../src/secrets/crypto.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";

describe("EnvSecretStore", () => {
  test("reads a value from the injected environment", () => {
    const store = new EnvSecretStore({ GITLAB_TOKEN: "glpat-abc123456" });
    expect(store.get("GITLAB_TOKEN")).toBe("glpat-abc123456");
  });

  test("treats an empty string as unset — a blank .env line is not a secret", () => {
    const store = new EnvSecretStore({ GITLAB_TOKEN: "" });
    expect(store.get("GITLAB_TOKEN")).toBeUndefined();
    expect(store.presence().GITLAB_TOKEN).toBe(false);
  });

  test("require names the missing variable", () => {
    const store = new EnvSecretStore({});
    expect(() => store.require("JIRA_TOKEN")).toThrow(ConfigError);
    expect(() => store.require("JIRA_TOKEN")).toThrow("JIRA_TOKEN");
  });

  test("exposes only known credentials for scrubbing, not the whole environment", () => {
    const store = new EnvSecretStore({
      GITLAB_TOKEN: "glpat-abc123456",
      PATH: "/usr/bin:/bin",
      HOME: "/home/someone",
    });

    expect(store.values()).toEqual(["glpat-abc123456"]);
  });

  test("does not scrub JIRA_EMAIL, which is an identifier rather than a secret", () => {
    const store = new EnvSecretStore({
      JIRA_EMAIL: "someone@example.com",
      JIRA_TOKEN: "jira-token-abcdef",
    });

    expect(store.values()).toEqual(["jira-token-abcdef"]);
  });

  test("reports presence across all known secrets", () => {
    const store = new EnvSecretStore({ SLACK_BOT_TOKEN: "xoxb-123456789" });
    const presence = store.presence();

    expect(presence.SLACK_BOT_TOKEN).toBe(true);
    expect(presence.GITLAB_TOKEN).toBe(false);
    expect(presence.ANTHROPIC_API_KEY).toBe(false);
  });

  test("snapshots at construction, so values() cannot drift from what was handed out", () => {
    const env: Record<string, string | undefined> = { GITLAB_TOKEN: "glpat-original1" };
    const store = new EnvSecretStore(env);

    env.GITLAB_TOKEN = "glpat-changed99";

    expect(store.get("GITLAB_TOKEN")).toBe("glpat-original1");
    expect(store.values()).toEqual(["glpat-original1"]);
  });
});

describe("credential encryption", () => {
  const masterKey = "a sufficiently long test key";

  test("writes Talos ciphertext and round-trips it", () => {
    const cipher = createCipher(masterKey);
    const encrypted = cipher.encrypt("current-token");

    expect(encrypted).toStartWith("v2:");
    expect(cipher.decrypt(encrypted)).toBe("current-token");
  });

  test("keeps credentials encrypted before the rebrand readable", () => {
    const legacy =
      "v1:BwcHBwcHBwcHBwcH:qp23VRY4upp27PIetsEjxg==:Cz4DlRjgoc8Zejpu";

    expect(createCipher(masterKey).decrypt(legacy)).toBe("legacy-token");
  });
});
