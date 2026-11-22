import type {
  InstanceRepository,
  TaskInstance,
} from "../application/ports.ts";
import type { TaskRegistry } from "./registry.ts";
import type { Task } from "./task.ts";

/**
 * Turns a stored instance row into an ordinary Task, borrowing its behaviour
 * (paramsSchema/run/kind) from the code-registered definition it points at.
 * Once registered, the executor/CLI/API cannot tell it apart from a
 * code-registered task — it just has a different id.
 */
export function instantiateTask(definition: Task<any>, row: TaskInstance): Task<any> {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? definition.description,
    kind: definition.kind,
    paramsSchema: definition.paramsSchema,
    defaultTrigger: definition.defaultTrigger,
    run: definition.run,
  };
}

/**
 * Registers every stored instance whose definition is still known and
 * instantiable. Refreshes metadata for existing instances. Orphaned rows (a
 * renamed/removed definition) are skipped rather than thrown on, so a stale
 * row cannot take down startup or a later refresh.
 */
export function loadInstances(registry: TaskRegistry, instances: InstanceRepository): void {
  for (const row of instances.all()) {
    const definition = registry.get(row.definitionId);
    if (!definition || !definition.instantiable) continue;
    registry.unregister(row.id);
    registry.register(instantiateTask(definition, row));
  }
}
