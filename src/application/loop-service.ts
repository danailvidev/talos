import { z } from "zod";
import type { Actor } from "../core/actor.ts";
import { ConfigError, PermissionError } from "../core/errors.ts";
import { definedRecord } from "../core/params-schema.ts";
import type { TaskRegistry } from "../core/registry.ts";
import type { ScheduledTask } from "../config/resolve-schedule.ts";
import type { InstanceRepository } from "./ports.ts";
import type { TaskApplicationService } from "./task-service.ts";
import { loopConfigYaml, parseLoopConfig } from "./loop-config.ts";

interface LoopServiceDeps {
  registry: TaskRegistry;
  instances: InstanceRepository;
  tasks: TaskApplicationService;
  scheduledTask(id: string): ScheduledTask | undefined;
  refresh(): void;
  access(actor: Actor): { read: boolean; manage: boolean };
  transaction<T>(work: () => T): T;
}

/** UI and assistant share documents, storage, validation and ownership rules. */
export class LoopApplicationService {
  constructor(private readonly deps: LoopServiceDeps) {}

  definitions(actor: Actor) {
    this.authorize(actor);
    return this.deps.registry.all().filter((task) => task.kind === "loop" && task.instantiable)
      .map((task) => ({
        id: task.id, name: task.name, description: task.description,
        paramsSchema: z.toJSONSchema(task.paramsSchema, { unrepresentable: "any" }),
      }));
  }

  read(actor: Actor, id: string) {
    this.authorize(actor);
    this.deps.refresh();
    const instance = this.deps.instances.get(id);
    if (instance?.visibility === "private" && instance.ownerId !== actor.id) {
      throw new ConfigError(`No loop '${id}'.`);
    }
    const task = this.deps.registry.require(id);
    if (task.kind !== "loop") throw new ConfigError(`'${id}' is not a loop.`);
    const scheduled = this.deps.scheduledTask(id);
    if (!scheduled) throw new ConfigError(`No loop '${id}'.`);
    const definitionId = instance?.definitionId ?? id;
    const params = { ...definedRecord(scheduled.params) };
    const prompt = definitionId === "custom-loop" ? params.prompt : instance?.promptTemplate;
    if (definitionId === "custom-loop") delete params.prompt;
    const config = parseLoopConfig({
      version: 1, definitionId, name: task.name, description: task.description ?? null,
      visibility: instance?.visibility ?? "public",
      prompt: typeof prompt === "string" ? prompt : null,
      enabled: scheduled.enabled.value, trigger: scheduled.trigger.value,
      maxItemsPerRun: scheduled.maxItemsPerRun, params,
    });
    return { id, editable: Boolean(instance), config, yaml: loopConfigYaml(config) };
  }

  create(actor: Actor, input: unknown) {
    this.authorize(actor);
    const config = parseLoopConfig(input);
    const definition = this.deps.registry.require(config.definitionId);
    if (definition.kind !== "loop") throw new ConfigError("Only loop definitions can be instantiated here.");
    const { task } = this.deps.transaction(() => this.deps.tasks.createInstance({
      definitionId: config.definitionId, name: config.name,
      description: config.description ?? undefined, visibility: config.visibility,
      ownerId: actor.id, promptTemplate: config.definitionId === "custom-loop" ? undefined : config.prompt ?? undefined,
      params: this.params(config), schedule: config,
    }));
    return this.read(actor, task.id);
  }

  replace(actor: Actor, id: string, input: unknown) {
    const current = this.read(actor, id);
    this.authorizeEdit(actor, id);
    if (!current.editable) throw new ConfigError("Built-in handlers cannot be replaced. Create a named instance or update its schedule.");
    const config = parseLoopConfig(input);
    if (config.definitionId !== current.config.definitionId) throw new ConfigError("A loop's definitionId cannot be changed.");
    if (config.visibility !== current.config.visibility) throw new ConfigError("A loop's visibility cannot be changed.");
    this.deps.transaction(() => this.deps.tasks.updateInstance(id, {
      name: config.name, description: config.description ?? null,
      promptTemplate: config.definitionId === "custom-loop" ? null : config.prompt,
    }, { ...config, params: this.params(config) }));
    return this.read(actor, id);
  }

  updateSchedule(actor: Actor, id: string, patch: unknown) {
    this.read(actor, id);
    this.authorizeEdit(actor, id);
    this.deps.tasks.updateSchedule(id, patch);
    return this.read(actor, id);
  }

  async delete(actor: Actor, id: string) {
    this.read(actor, id);
    const instance = this.deps.instances.get(id);
    if (!instance) throw new ConfigError("Built-in handlers cannot be deleted.");
    if (instance.ownerId && instance.ownerId !== actor.id) throw new PermissionError("Only the loop's owner can delete it.");
    await this.deps.tasks.deleteInstance(id);
    return { id, deleted: true };
  }

  private params(config: ReturnType<typeof parseLoopConfig>) {
    if (config.definitionId === "custom-loop" && !config.prompt?.trim()) throw new ConfigError("A custom loop requires a non-empty prompt.");
    return config.definitionId === "custom-loop" ? { ...config.params, prompt: config.prompt } : config.params;
  }

  private authorize(actor: Actor) {
    const access = this.deps.access(actor);
    if (!access.read) throw new PermissionError("Access to Loops is not permitted by your role.");
    return access;
  }

  private authorizeEdit(actor: Actor, id: string) {
    const access = this.authorize(actor);
    if (this.deps.instances.get(id)?.ownerId !== actor.id && !access.manage) {
      throw new PermissionError("Only a task manager or the loop's owner can change it.");
    }
  }
}
