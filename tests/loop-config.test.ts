import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { parseLoopConfig } from "../src/application/loop-config.ts";

let app: App;
let dir: string;
const owner = { id: "operator", name: "Operator", email: "operator@talos.local" };
const admin = { id: "admin", name: "Admin", email: "admin@talos.local" };
const config = () => ({
  version: 1, definitionId: "custom-loop", name: "Daily audit",
  description: "Check the repository", visibility: "private", prompt: "Find missing tests.\nSummarize them.",
  enabled: false, trigger: { type: "manual" }, maxItemsPerRun: 10,
  params: { repositories: [], permissions: "read-only" },
});
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "talos-loop-config-"));
  writeFileSync(join(dir, "talos.yaml"), "database: ./test.db\nlogLevel: fatal\n");
  app = await createApp({ config: join(dir, "talos.yaml") });
});
afterEach(() => { app.close(); rmSync(dir, { recursive: true, force: true }); });

describe("persistent loop documents", () => {
  test("assistant creates, exports, updates, restarts and deletes the same UI loop", async () => {
    const created = await app.assistant.invoke(owner, { name: "talos_loop_create", arguments: { config: config() } }) as ReturnType<App["loops"]["read"]>;
    expect(app.instances.get(created.id)?.ownerId).toBe(owner.id);
    expect(parseLoopConfig(created.yaml)).toEqual(created.config);
    expect((app.scheduledTask(created.id)?.params as { prompt: string }).prompt).toBe(config().prompt);
    const updated = { ...created.config, name: "Updated audit", prompt: "Check dependencies", enabled: true,
      trigger: { type: "cron", expression: "0 9 * * *" } };
    await app.assistant.invoke(owner, { name: "talos_loop_update", arguments: { id: created.id, config: updated } });
    expect(app.taskRegistry.require(created.id).name).toBe("Updated audit");
    app.close();
    app = await createApp({ config: join(dir, "talos.yaml") });
    expect(app.loops.read(owner, created.id).config.prompt).toBe("Check dependencies");
    expect(app.scheduledTask(created.id)?.enabled.value).toBe(true);
    await app.assistant.invoke(owner, { name: "talos_loop_delete", arguments: { id: created.id } });
    expect(app.instances.get(created.id)).toBeNull();
    expect(app.taskRegistry.get(created.id)).toBeUndefined();
  });

  test("rejects invalid schedules and prompts without leaving loop rows", () => {
    const before = app.instances.all().length;
    expect(() => app.loops.create(owner, { ...config(), maxItemsPerRun: 0 })).toThrow();
    expect(() => app.loops.create(owner, { ...config(), prompt: "" })).toThrow();
    expect(() => app.tasks.createInstance({ definitionId: "custom-loop", name: "bad", params: { prompt: "Hello" }, schedule: { maxItemsPerRun: 0 } })).toThrow();
    expect(app.instances.all()).toHaveLength(before);
  });

  test("invalid replacement preserves metadata and configuration", () => {
    const created = app.loops.create(owner, config());
    expect(() => app.loops.replace(owner, created.id, { ...created.config, name: "Lost name", params: { permissions: "invalid" } })).toThrow();
    expect(app.loops.read(owner, created.id)).toEqual(created);
  });

  test("private loops are hidden and public loops cannot be deleted by another user", async () => {
    const privateLoop = app.loops.create(owner, config());
    expect(() => app.loops.read(admin, privateLoop.id)).toThrow("No loop");
    const publicLoop = app.loops.create(admin, { ...config(), visibility: "public" });
    expect(() => app.loops.replace(owner, publicLoop.id, publicLoop.config)).toThrow("Only a task manager");
    await expect(app.loops.delete(owner, publicLoop.id)).rejects.toThrow("Only the loop's owner");
    expect(() => app.loops.create({ ...owner, id: "unknown" }, config())).toThrow("not permitted");
  });

  test("lists usable handlers and supports YAML input", () => {
    expect(app.loops.definitions(owner).some((item) => item.id === "custom-loop")).toBe(true);
    const original = app.loops.create(owner, config());
    const copy = app.loops.create(owner, original.yaml);
    expect(copy.id).not.toBe(original.id);
    expect(copy.config).toEqual(original.config);
  });

  test("rejects unsupported versions, duplicate YAML keys and unknown fields", () => {
    expect(() => parseLoopConfig({ ...config(), version: 2 })).toThrow();
    expect(() => parseLoopConfig({ ...config(), ownerId: "admin" })).toThrow();
    expect(() => parseLoopConfig("version: 1\nversion: 1")).toThrow();
  });
});

test("updated prompts reach queued workers and deletion refuses active work", async () => {
  const created = app.loops.create(owner, config());
  app.loops.replace(owner, created.id, { ...created.config, prompt: "Updated worker instructions" });
  await app.tasks.run(created.id, {}, { actor: owner });
  const job = app.jobs.byLoop(created.id)[0]!;
  expect((job.params as { loop: { prompt: string } }).loop.prompt).toBe("Updated worker instructions");
  await expect(app.loops.delete(owner, created.id)).rejects.toThrow("queued or running jobs");
  expect(app.instances.get(created.id)).not.toBeNull();
  await app.cancellations.cancelJob(job.id);
  await app.loops.delete(owner, created.id);
  expect(app.instances.get(created.id)).toBeNull();
});
