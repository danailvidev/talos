import { pullRequestId } from "../application/pull-requests.ts";
import type { App } from "../app.ts";
import type { AuthUser } from "../auth.ts";
import { ConfigError } from "../core/errors.ts";
import { E2E_TEST_TASK_ID } from "../tasks/e2e-test/index.ts";

export async function e2eArtifactResponse(
  app: App,
  user: AuthUser,
  jobId: string,
  artifactName: string,
  signal?: AbortSignal,
): Promise<Response> {
  const job = app.jobs.get(jobId);
  if (!job || job.kind !== E2E_TEST_TASK_ID || !job.executionId) {
    throw new ConfigError("E2E result not found.");
  }
  const target = pullRequestFromParams(job.params);
  if (!target) throw new ConfigError("E2E job has no merge request target.");

  // Authorise against the forge on every direct artifact request. A copied URL
  // therefore grants nothing to somebody whose own GitLab account cannot read
  // the merge request.
  await app.pullRequests.detail(
    user,
    pullRequestId({
      provider: "gitlab",
      repository: target.projectId,
      number: target.mrIid,
    }),
    { signal },
  );
  const opened = await app.e2eArtifacts.open(job.executionId, artifactName);
  if (!opened) throw new ConfigError("E2E artifact not found.");
  const disposition = opened.artifact.kind === "screenshot" ? "inline" : "attachment";
  return new Response(opened.body, {
    headers: {
      "content-type": opened.artifact.contentType,
      "content-length": String(opened.artifact.bytes),
      "content-disposition": `${disposition}; filename="${safeFilename(opened.artifact.name)}"`,
      "cache-control": "private, max-age=300",
      vary: "Cookie",
      "x-content-type-options": "nosniff",
    },
  });
}

function pullRequestFromParams(
  params: unknown,
): { projectId: string; mrIid: number } | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const gitlab = (params as { gitlab?: unknown }).gitlab;
  if (typeof gitlab !== "object" || gitlab === null) return undefined;
  const { projectId, mrIid } = gitlab as Record<string, unknown>;
  return typeof projectId === "string" &&
    typeof mrIid === "number" &&
    Number.isInteger(mrIid) &&
    mrIid > 0
    ? { projectId, mrIid }
    : undefined;
}

function safeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, "_");
}
