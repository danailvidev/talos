import { ConfigError } from "./errors.ts";
import type { Task } from "./task.ts";

/**
 * Name-to-item lookup, generic over anything with an `id`. Tasks are
 * registered in code and looked up by id; the only per-kind thing is the noun
 * used in error messages.
 */
export class Registry<T extends { id: string }> {
  private readonly items = new Map<string, T>();

  constructor(private readonly kind: string) {}

  register(item: T): this {
    if (this.items.has(item.id)) {
      throw new ConfigError(`${this.kind} '${item.id}' is already registered.`);
    }
    this.items.set(item.id, item);
    return this;
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  /**
   * Drops an item, reporting whether there was one. The counterpart to
   * `register` for instances, which unlike code-registered tasks can go away
   * while the process runs: `loadInstances` only ever adds, so a deleted row
   * would otherwise stay runnable until a restart.
   */
  unregister(id: string): boolean {
    return this.items.delete(id);
  }

  /** Throws with the available ids, so a typo is self-correcting. */
  require(id: string): T {
    const item = this.items.get(id);
    if (!item) {
      const known = this.ids();
      const lowerKind = this.kind.toLowerCase();
      const hint = known.length > 0 ? ` Known ${lowerKind}s: ${known.join(", ")}.` : "";
      throw new ConfigError(`Unknown ${lowerKind} '${id}'.${hint}`);
    }
    return item;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  ids(): string[] {
    return [...this.items.keys()].sort();
  }

  all(): T[] {
    return this.ids().map((id) => this.items.get(id)!);
  }
}

/**
 * Tasks are registered in code (plan §19: start with TypeScript definitions).
 * A task's optional schedule configuration lives in the database — see
 * `config/resolve-schedule.ts` — but the task itself is always code.
 */
export class TaskRegistry extends Registry<Task<any>> {
  constructor() {
    super("Task");
  }
}
