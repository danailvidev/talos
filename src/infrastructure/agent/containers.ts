import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError } from "../../core/errors.ts";
import type {
  AgentRuntimeLifecycle,
  ManagedRuntimeResource,
  RuntimePresence,
} from "../../core/orchestration.ts";
import { AGENT_HOME, AGENT_IMAGE_TAG } from "./image.ts";

/** Marks every agent container so a cancel can find it after the CLI subprocess dies. */
export const AGENT_MANAGED_LABEL = "talos.managed";
export const AGENT_EXECUTION_LABEL = "talos.execution-id";
export const AGENT_ATTEMPT_LABEL = "talos.attempt-id";
export const AGENT_INSTALLATION_LABEL = "talos.installation-id";

let installationId: string | undefined;

export function configureAgentInstallation(id: string | undefined): void {
  installationId = id;
}

export function agentInstallationId(): string | undefined {
  return installationId;
}

export function agentOrchestrationLabelArgs(attemptId?: string): string[] {
  return [
    ...(installationId ? ["--label", `${AGENT_INSTALLATION_LABEL}=${installationId}`] : []),
    ...(attemptId ? ["--label", `${AGENT_ATTEMPT_LABEL}=${attemptId}`] : []),
  ];
}

/**
 * Runs the container as the uid that owns everything mounted into it — the
 * operator's `~/.claude`, connected-account homes, and the per-run temp dirs —
 * so it can read them without root or `DAC_OVERRIDE`.
 */
export function agentUserArgs(): string[] {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return ["--user", `${uid}:${gid}`, "-e", `HOME=${AGENT_HOME}`];
}

/**
 * Writes credentials as 0600 files for a container to read instead of `-e`
 * values, which `docker inspect` and `/proc/<pid>/environ` expose for the
 * container's lifetime. The directory must be mounted read-write: each
 * entrypoint deletes the files once read, so an agent with `Bash` cannot.
 */
export async function writeSecretFiles(dir: string, files: Record<string, string>): Promise<void> {
  await Promise.all(
    Object.entries(files).map(([name, body]) => writeFile(join(dir, name), body, { mode: 0o600 })),
  );
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `export NAME='value'` lines for the agent entrypoint to source. */
export function shellEnvFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => {
      if (!ENV_NAME.test(name)) {
        throw new ConfigError(`Invalid agent environment variable name '${name}'.`);
      }
      return `export ${name}='${value.replaceAll("'", `'\\''`)}'\n`;
    })
    .join("");
}

/**
 * A legal docker `--name` derived from the execution id, plus an optional
 * discriminator for the case of two agent containers in one execution.
 */
export function agentContainerName(executionId: string, label?: string | number): string {
  const safe = `${executionId}${label != null ? `-${label}` : ""}`.replace(
    /[^a-zA-Z0-9_.-]/g,
    "-",
  );
  return `talos-${safe}`.slice(0, 128);
}

/**
 * Maps a non-zero `docker run` exit (or an abort with no exit) to an
 * operator-facing sentence. Exit 143 is SIGTERM — almost always our own timeout
 * aborting the container, which used to surface as a blank `(exit 143):` because
 * stderr is empty when the process is killed.
 */
export function agentContainerFailure(args: {
  project: string;
  branch: string;
  exitCode: number | null;
  stderr: string;
  /**
   * What the agent itself said before it stopped — `agentFailureReason`. Carried
   * separately from `stderr` because the two are usually mutually exclusive: the
   * agent talks on stdout and docker on stderr, so an agent that failed on its
   * own leaves stderr empty and used to produce a bare `(exit 1)`.
   */
  reason?: string;
  timedOut: boolean;
  cancelled: boolean;
  timeoutMs: number;
}): string {
  const target = `${args.project}@${args.branch}`;
  const minutes = Math.max(1, Math.round(args.timeoutMs / 60_000));
  const detail = [args.reason?.trim(), args.stderr].filter((part) => part).join("; ");
  const tail = detail ? `: ${detail}` : "";

  if (args.timedOut) {
    return (
      `claude: containerized agent for ${target} timed out after ${minutes}m ` +
      `(the container was sent SIGTERM${args.exitCode != null ? `, exit ${args.exitCode}` : ""})`
    );
  }
  if (args.cancelled) {
    return `claude: containerized agent for ${target} was cancelled`;
  }
  if (args.exitCode === 137) {
    return (
      `claude: containerized agent for ${target} was killed (SIGKILL, exit 137; ` +
      `often the 2g container memory limit)${tail}`
    );
  }
  if (args.exitCode === 143) {
    return `claude: containerized agent for ${target} was stopped (SIGTERM, exit 143)${tail}`;
  }
  return `claude: containerized agent for ${target} failed (exit ${args.exitCode})${tail}`;
}

/**
 * Stops agent containers left behind when a run is cancelled or the docker CLI
 * subprocess dies before `--rm` runs. Also drops dangling images from a
 * failed/interrupted `docker build`.
 *
 * Does not delete `talos-agent:*` — that tag is the shared cache every later
 * run reuses.
 */
export async function stopAgentContainers(
  options: {
    executionId?: string;
    /** When true, also `docker rm -f` every container from the agent image. */
    allAgentImage?: boolean;
    pruneDanglingImages?: boolean;
  } = {},
): Promise<{ containers: string[]; unresolved: string[] }> {
  const containers = new Set<string>();

  const filters = options.executionId
    ? [
        `label=${AGENT_EXECUTION_LABEL}=${options.executionId}`,
        ...(installationId ? [`label=${AGENT_INSTALLATION_LABEL}=${installationId}`] : []),
      ]
    : [
        `label=${AGENT_MANAGED_LABEL}=1`,
        ...(installationId ? [`label=${AGENT_INSTALLATION_LABEL}=${installationId}`] : []),
      ];
  const labeled = await dockerIds(
    "ps",
    "-aq",
    ...filters.flatMap((filter) => ["--filter", filter]),
  );
  for (const id of labeled) containers.add(id);

  // The ancestor fallback is available only for emergency or process-shutdown
  // cleanup. Even then, retain installation scoping: sharing a
  // Docker host does not grant this database ownership of another installation.
  if (options.allAgentImage && installationId) {
    for (const id of await dockerIds(
      "ps",
      "-aq",
      "--filter",
      `ancestor=${AGENT_IMAGE_TAG}`,
      "--filter",
      `label=${AGENT_INSTALLATION_LABEL}=${installationId}`,
    )) {
      containers.add(id);
    }
  }

  const lifecycle = new DockerAgentRuntime();
  const unresolved: string[] = [];
  await Promise.all([...containers].map(async (id) => {
    if (!await lifecycle.stop(id)) unresolved.push(id);
  }));

  if (options.pruneDanglingImages) {
    await dockerSilent("image", "prune", "-f");
  }

  return { containers: [...containers], unresolved };
}

export async function dockerIds(...args: string[]): Promise<string[]> {
  const { stdout } = await dockerSilent(...args);
  return stdout
    .split(/\s+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Best-effort docker call: cleanup must never be the thing that fails a run. */
export async function dockerSilent(
  ...args: string[]
): Promise<{ exitCode: number; stdout: string }> {
  try {
    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "ignore" });
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    return { exitCode, stdout };
  } catch {
    return { exitCode: 1, stdout: "" };
  }
}

/** Lifecycle operations used by startup and periodic reconciliation. */
export class DockerAgentRuntime implements AgentRuntimeLifecycle {
  readonly kind = "docker" as const;

  async inspect(id: string): Promise<RuntimePresence> {
    const result = await docker(["inspect", "--format", "{{.State.Status}}", id]);
    if (result.exitCode === 0) {
      return result.stdout.trim() === "running" ? "running" : "stopped";
    }
    if (/no such (object|container)/i.test(result.stderr)) return "missing";
    return "unknown";
  }

  async list(installation: string): Promise<ManagedRuntimeResource[]> {
    return this.listByFilters(
      [`label=${AGENT_MANAGED_LABEL}=1`, `label=${AGENT_INSTALLATION_LABEL}=${installation}`],
    );
  }

  async listUnscoped(): Promise<ManagedRuntimeResource[]> {
    const resources = await this.listByFilters([`label=${AGENT_MANAGED_LABEL}=1`], true);
    return resources;
  }

  private async listByFilters(
    filters: string[],
    unscopedOnly = false,
  ): Promise<ManagedRuntimeResource[]> {
    const result = await docker([
      "ps",
      "-a",
      ...filters.flatMap((filter) => ["--filter", filter]),
      "--format",
      `{{.Names}}\t{{.State}}\t{{.Label "${AGENT_ATTEMPT_LABEL}"}}\t{{.Label "${AGENT_EXECUTION_LABEL}"}}\t{{.Label "${AGENT_INSTALLATION_LABEL}"}}`,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Docker resource listing failed");
    }
    return result.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      const [id = "", state = "", attemptId = "", executionId = "", installation = ""] =
        line.split("\t");
      if (unscopedOnly && installation) return [];
      return [{
        kind: "docker" as const,
        id,
        presence: state === "running" ? "running" as const : "stopped" as const,
        ...(attemptId ? { attemptId } : {}),
        ...(executionId ? { executionId } : {}),
      }];
    });
  }

  async stop(id: string): Promise<boolean> {
    const before = await this.inspect(id);
    if (before === "missing") return true;
    if (before === "unknown") return false;
    await docker(["rm", "-f", id]);
    return await this.inspect(id) === "missing";
  }
}

export async function stopDockerContainerConfirmed(id: string): Promise<boolean> {
  return new DockerAgentRuntime().stop(id);
}

async function docker(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } catch (cause) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
