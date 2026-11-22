import { describe, expect, test } from "bun:test";
import type { ScheduledTask } from "../src/config/resolve-schedule.ts";
import {
  CONNECTORS,
  connectorNames,
  findConnector,
  gitlabProjects,
  missingSecrets,
} from "../src/connectors/registry.ts";
import { ConfigError } from "../src/core/errors.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";

const fx = (id: string, params: unknown): ScheduledTask => ({
  id,
  enabled: { value: true, origin: "default" },
  trigger: { value: { type: "manual" }, origin: "default" },
  maxItemsPerRun: 10,
  params,
});

describe("connector registry", () => {
  test("names every registered connector", () => {
    expect(connectorNames()).toContain("gitlab");
  });

  test("an unknown name lists the valid ones, so a typo self-corrects", () => {
    const err = (() => {
      try {
        findConnector("gitlabb");
      } catch (e) {
        return e as Error;
      }
    })();

    expect(err).toBeInstanceOf(ConfigError);
    expect(err!.message).toContain("gitlab");
  });

  test("reports which secrets are missing before attempting to connect", () => {
    const gitlab = findConnector("gitlab");
    expect(missingSecrets(gitlab, new EnvSecretStore({}))).toEqual(["GITLAB_TOKEN"]);
    expect(missingSecrets(gitlab, new EnvSecretStore({ GITLAB_TOKEN: "x" }))).toEqual([]);
  });

  test("nothing is constructed until asked for", () => {
    // `talos status` must work with no tokens set at all; eager construction
    // would make it throw on a fresh checkout.
    for (const definition of CONNECTORS) {
      expect(typeof definition.build).toBe("function");
    }
  });

  test("building without the required secret names the variable", () => {
    const gitlab = findConnector("gitlab");
    expect(() =>
      gitlab.build({
        secrets: new EnvSecretStore({}),
        logger: undefined as never,
        scheduledTasks: [],
      }),
    ).toThrow(/GITLAB_TOKEN/);
  });
});

describe("gitlabProjects", () => {
  test("collects the project from each task's params block", () => {
    const projects = gitlabProjects([
      fx("gitlab-ci-failure", { gitlab: { projectId: 42 } }),
      fx("other-task", { gitlab: { projectId: "acme/webportal" } }),
    ]);

    expect(projects).toEqual([42, "acme/webportal"]);
  });

  test("deduplicates, so one project is checked once", () => {
    const projects = gitlabProjects([
      fx("a", { gitlab: { projectId: 42 } }),
      fx("b", { gitlab: { projectId: 42, ref: "main" } }),
    ]);

    expect(projects).toEqual([42]);
  });

  test("ignores tasks with no GitLab block", () => {
    expect(gitlabProjects([fx("example", {})])).toEqual([]);
  });

  test("skips a malformed block rather than failing the whole health check", () => {
    // The task's own paramsSchema reports this when it runs; a health check
    // that throws here would hide the checks that would have passed.
    const projects = gitlabProjects([
      fx("broken", { gitlab: { projectId: null } }),
      fx("good", { gitlab: { projectId: 7 } }),
    ]);

    expect(projects).toEqual([7]);
  });
});
