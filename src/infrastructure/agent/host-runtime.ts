import { readFile } from "node:fs/promises";
import type {
  AgentRuntimeLifecycle,
  ManagedRuntimeResource,
  RuntimePresence,
} from "../../core/orchestration.ts";

const MARKER = "TALOS_AGENT_ATTEMPT_ID";

export function hostProcessRuntimeId(pid: number, attemptId: string): string {
  return `pid:${pid}:${attemptId}`;
}

export function hostProcessMarker(attemptId: string): Record<string, string> {
  return { [MARKER]: attemptId };
}

/**
 * Reconciles the host-local Claude process used by interactive chat. The
 * attempt marker prevents PID reuse from targeting an unrelated process.
 */
export class HostProcessRuntime implements AgentRuntimeLifecycle {
  readonly kind = "host" as const;

  async inspect(id: string): Promise<RuntimePresence> {
    const parsed = parseRuntimeId(id);
    if (!parsed) return "unknown";
    try {
      const environment = await readFile(`/proc/${parsed.pid}/environ`, "utf8");
      return environment.split("\0").includes(`${MARKER}=${parsed.attemptId}`)
        ? "running"
        : "missing";
    } catch (cause) {
      if (isMissing(cause)) return "missing";
      return "unknown";
    }
  }

  async list(): Promise<ManagedRuntimeResource[]> {
    // Host processes are recovered from their durable PID+marker identity. No
    // installation-wide /proc scan is needed or permitted.
    return [];
  }

  async stop(id: string): Promise<boolean> {
    const parsed = parseRuntimeId(id);
    if (!parsed) return false;
    const before = await this.inspect(id);
    if (before === "missing") return true;
    if (before === "unknown") return false;
    try {
      process.kill(parsed.pid, "SIGTERM");
    } catch (cause) {
      if (isMissing(cause)) return true;
      return false;
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      await Bun.sleep(50);
      if (await this.inspect(id) === "missing") return true;
    }
    try {
      process.kill(parsed.pid, "SIGKILL");
    } catch (cause) {
      if (isMissing(cause)) return true;
      return false;
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      await Bun.sleep(50);
      if (await this.inspect(id) === "missing") return true;
    }
    return false;
  }
}

function parseRuntimeId(id: string): { pid: number; attemptId: string } | undefined {
  const match = /^pid:(\d+):(.+)$/.exec(id);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0
    ? { pid, attemptId: match[2]! }
    : undefined;
}

function isMissing(cause: unknown): boolean {
  return cause instanceof Error &&
    "code" in cause &&
    ((cause as NodeJS.ErrnoException).code === "ENOENT" ||
      (cause as NodeJS.ErrnoException).code === "ESRCH");
}
