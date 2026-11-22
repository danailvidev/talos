import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { TaskRegistry } from "../src/core/registry.ts";
import { ConfigError } from "../src/core/errors.ts";
import type { Task, TaskResult } from "../src/core/task.ts";
import { registerBuiltInTasks } from "../src/tasks/index.ts";

function stubTask(id: string): Task<{}> {
  return {
    id,
    name: id,
    kind: "task",
    paramsSchema: z.object({}).loose(),
    async run(): Promise<TaskResult> {
      return {};
    },
  };
}

describe("TaskRegistry", () => {
  test("registers and retrieves a task", () => {
    const registry = new TaskRegistry().register(stubTask("a"));
    expect(registry.get("a")?.id).toBe("a");
    expect(registry.has("a")).toBe(true);
  });

  test("rejects a duplicate id rather than silently replacing it", () => {
    const registry = new TaskRegistry().register(stubTask("a"));
    expect(() => registry.register(stubTask("a"))).toThrow(ConfigError);
  });

  test("require lists known ids so a typo is self-correcting, using the Task noun", () => {
    const registry = new TaskRegistry().register(stubTask("example-task"));
    expect(() => registry.require("example-taskk")).toThrow(/Unknown task/);
    expect(() => registry.require("example-taskk")).toThrow("example-task");
  });

  test("ids are sorted, so CLI output is stable", () => {
    const registry = new TaskRegistry()
      .register(stubTask("zebra"))
      .register(stubTask("alpha"));
    expect(registry.ids()).toEqual(["alpha", "zebra"]);
  });

  test("the app registers the example task", () => {
    expect(registerBuiltInTasks(new TaskRegistry()).ids()).toContain("example-task");
  });

  test("the app registers gitlab-ci-failure", () => {
    const ids = registerBuiltInTasks(new TaskRegistry()).ids();
    expect(ids).toContain("gitlab-ci-failure");
    expect(ids).not.toContain("example-loop");
  });

  test("the app registers gitlab-review-requested as an instantiable loop", () => {
    const task = registerBuiltInTasks(new TaskRegistry()).require("gitlab-review-requested");
    expect(task.kind).toBe("loop");
    expect(task.instantiable).toBe(true);
    expect(task.defaultTrigger).toEqual({ type: "cron", expression: "*/15 * * * *" });
    expect(task.paramsSchema.parse({})).toEqual({});
  });

  test("team loops can be represented by UUID-backed instances", () => {
    const registry = registerBuiltInTasks(new TaskRegistry());
    expect(registry.require("datadog-scan").instantiable).toBe(true);
    expect(registry.require("release-repo-poll").instantiable).toBe(true);
  });

  test("the app registers gitlab-mr-follow-up as an hourly instantiable loop", () => {
    const task = registerBuiltInTasks(new TaskRegistry()).require("gitlab-mr-follow-up");
    expect(task.kind).toBe("loop");
    expect(task.instantiable).toBe(true);
    expect(task.defaultTrigger).toEqual({ type: "cron", expression: "0 * * * *" });
    expect(task.paramsSchema.parse({})).toEqual({
      commit: { name: "Talos", email: "talos@talos.local" },
    });
  });

  test("the app registers per-MR follow-up work as a queue handler", () => {
    const task = registerBuiltInTasks(new TaskRegistry()).require("gitlab-mr-follow-up-one");
    expect(task.kind).toBe("job");
    expect(task.instantiable).toBeUndefined();
    expect(
      task.paramsSchema.parse({
        gitlab: { projectId: "acme/web", mrIid: 42 },
      }),
    ).toMatchObject({ gitlab: { projectId: "acme/web", mrIid: 42 } });
  });

  test("the app registers conversational MR revisions as a queue handler", () => {
    const task = registerBuiltInTasks(new TaskRegistry()).require("gitlab-mr-revision-one");
    expect(task.kind).toBe("job");
    expect(task.instantiable).toBeUndefined();
    expect(
      task.paramsSchema.parse({
        gitlab: { projectId: "acme/web", mrIid: 42 },
        instruction: "Keep this backwards compatible.",
      }),
    ).toMatchObject({
      gitlab: { projectId: "acme/web", mrIid: 42 },
      instruction: "Keep this backwards compatible.",
      history: [],
    });
  });

  test("gitlab-ci-failure has code defaults for gitlab/jira so an empty run is valid", () => {
    const task = registerBuiltInTasks(new TaskRegistry()).require("gitlab-ci-failure");
    const parsed = task.paramsSchema.parse({});
    expect(parsed).toMatchObject({
      gitlab: { projectId: "example-org/webapp" },
      jira: { project: "PROJ" },
      anyStatus: true,
      includeAllowedFailures: true,
    });
  });

  test("the app registers Automation report synchronization", () => {
    const task = registerBuiltInTasks(new TaskRegistry()).require("automation-report-sync");
    expect(task.kind).toBe("loop");
    expect(task.defaultTrigger).toEqual({
      type: "cron",
      expression: "*/10 * * * *",
    });
  });

  test("the app registers Automation AI triage as a queue handler", () => {
    const task = registerBuiltInTasks(new TaskRegistry()).require(
      "triage-automation-failure",
    );
    expect(task.kind).toBe("job");
    expect(
      task.paramsSchema.parse({
        projectId: "42",
        pipelineId: 9001,
        scheduleId: 22,
        signatureKey: "root-cause",
        targetRef: "main",
      }),
    ).toMatchObject({
      projectId: "42",
      pipelineId: 9001,
      scheduleId: 22,
      signatureKey: "root-cause",
      targetRef: "main",
    });
  });
});
