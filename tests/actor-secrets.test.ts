import { describe, expect, test } from "bun:test";

import { actorIdentitySecretStore } from "../src/secrets/actor-secrets.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";

const actor = {
  id: "user-1",
  name: "QA User",
  email: "qa@example.com",
};

describe("actor provider identity", () => {
  test("interactive reads never inherit shared GitLab or Jira identities", () => {
    const shared = new EnvSecretStore({
      GITLAB_TOKEN: "shared-gitlab-token",
      GITLAB_API_URL: "https://gitlab.example/api/v4",
      JIRA_EMAIL: "shared@example.com",
      JIRA_TOKEN: "shared-jira-token",
      JIRA_BASE_URL: "https://jira.example",
      JIRA_BOARD_ID: "42",
    });

    const effective = actorIdentitySecretStore(shared, actor, {});

    expect(effective.get("GITLAB_TOKEN")).toBeUndefined();
    expect(effective.get("JIRA_EMAIL")).toBeUndefined();
    expect(effective.get("JIRA_TOKEN")).toBeUndefined();
    expect(effective.get("GITLAB_API_URL")).toBe("https://gitlab.example/api/v4");
    expect(effective.get("JIRA_BASE_URL")).toBe("https://jira.example");
    expect(effective.get("JIRA_BOARD_ID")).toBe("42");
  });

  test("uses only the signed-in developer's identity when it is present", () => {
    const shared = new EnvSecretStore({
      GITLAB_TOKEN: "shared-gitlab-token",
      JIRA_EMAIL: "shared@example.com",
      JIRA_TOKEN: "shared-jira-token",
      JIRA_BASE_URL: "https://jira.example",
    });

    const effective = actorIdentitySecretStore(shared, actor, {
      GITLAB_TOKEN: "personal-gitlab-token",
      JIRA_EMAIL: "qa@example.com",
      JIRA_TOKEN: "personal-jira-token",
    });

    expect(effective.get("GITLAB_TOKEN")).toBe("personal-gitlab-token");
    expect(effective.get("JIRA_EMAIL")).toBe("qa@example.com");
    expect(effective.get("JIRA_TOKEN")).toBe("personal-jira-token");
  });
});
