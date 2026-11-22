import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { GitLabConfigSchema } from "../src/connectors/gitlab/client.ts";
import { JiraConfigSchema } from "../src/connectors/jira/client.ts";
import { extractJiraIssueKey, taskExternalLinks, usesGitLabRepo, usesJiraProject } from "../src/api/views.ts";
import type { SecretStore } from "../src/secrets/secret-store.ts";

function secrets(env: Record<string, string> = {}): SecretStore {
  return {
    get: (name) => env[name],
    require: (name) => env[name] ?? "",
    values: () => Object.values(env),
  };
}

describe("usesGitLabRepo", () => {
  test("true when the schema has a gitlab.projectId block", () => {
    const schema = z.object({ gitlab: GitLabConfigSchema });
    expect(usesGitLabRepo(schema, {})).toBe(true);
  });

  test("true for an extended GitLab block (code-review adds mrIid etc.)", () => {
    const schema = z.object({
      gitlab: GitLabConfigSchema.extend({ mrIid: z.number().optional() }),
    });
    expect(usesGitLabRepo(schema, {})).toBe(true);
  });

  test("true when stored params already name a project, even without that schema shape", () => {
    expect(usesGitLabRepo(z.object({}), { gitlab: { projectId: "acme/web" } })).toBe(true);
  });

  test("false for a task that never mentions GitLab", () => {
    expect(usesGitLabRepo(z.object({ message: z.string() }), { message: "hi" })).toBe(false);
  });

  test("false for a malformed gitlab block with no schema to back it", () => {
    expect(usesGitLabRepo(z.object({}), { gitlab: { projectId: null } })).toBe(false);
  });
});

describe("usesJiraProject", () => {
  test("true when the schema has a jira.project block", () => {
    const schema = z.object({ jira: JiraConfigSchema });
    expect(usesJiraProject(schema, {})).toBe(true);
  });

  test("true when stored params already name a project, even without that schema shape", () => {
    expect(usesJiraProject(z.object({}), { jira: { project: "sp" } })).toBe(true);
  });

  test("false for a task that never mentions Jira", () => {
    expect(usesJiraProject(z.object({ message: z.string() }), { message: "hi" })).toBe(false);
  });

  test("false for a malformed jira block with no schema to back it", () => {
    expect(usesJiraProject(z.object({}), { jira: { project: "" } })).toBe(false);
  });
});

describe("extractJiraIssueKey", () => {
  test("reads a key from a branch name or title", () => {
    expect(extractJiraIssueKey("fix/TP-3012", "clean up")).toBe("TP-3012");
    expect(extractJiraIssueKey("SP-3034-fix-login")).toBe("SP-3034");
  });

  test("is undefined when nothing looks like a Jira key", () => {
    expect(extractJiraIssueKey("refactor auth", "feature/login")).toBeUndefined();
  });
});

describe("taskExternalLinks", () => {
  test("builds a GitLab MR url from project + iid", () => {
    expect(
      taskExternalLinks({ gitlab: { projectId: "acme/web", mrIid: 42 } }, secrets()),
    ).toEqual({
      gitlabMr: { iid: 42, url: "https://gitlab.com/acme/web/-/merge_requests/42" },
    });
  });

  test("builds a Jira browse url when a key and site are present", () => {
    expect(
      taskExternalLinks(
        { gitlab: { projectId: "acme/web", jiraIssueKey: "TP-9" } },
        secrets({ JIRA_BASE_URL: "https://jira.test" }),
      ),
    ).toEqual({
      jiraIssue: { key: "TP-9", url: "https://jira.test/browse/TP-9" },
    });
  });

  test("keeps the Jira key without a url when the site is unset", () => {
    expect(taskExternalLinks({ gitlab: { jiraIssueKey: "TP-9" } }, secrets())).toEqual({
      jiraIssue: { key: "TP-9" },
    });
  });

  test("is empty when the task is not scoped to an MR or issue", () => {
    expect(taskExternalLinks({ gitlab: { projectId: "acme/web" } }, secrets())).toEqual({});
  });
});
