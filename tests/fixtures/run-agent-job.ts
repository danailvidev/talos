// Spawned by agent-container-hardening.test.ts with a fake `docker` first on PATH.
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { setAgentWorkspaceCache } from "../../src/infrastructure/agent/cache.ts";
import { runAgentJob, setAgentRuntimeAuth } from "../../src/infrastructure/agent/run.ts";
import { setAgentUsageRecorder } from "../../src/infrastructure/agent/usage.ts";

setAgentWorkspaceCache(false);
setAgentRuntimeAuth(() => ({
  id: "test-account",
  env: { ANTHROPIC_API_KEY: "sk-ant-it's-secret" },
  label: "test account",
  optionId: "claude:key-api",
}));
setAgentUsageRecorder(async (usage) => {
  await writeFile(`${process.env.FAKE_DOCKER_LOG}.usage`, JSON.stringify(usage));
});

const result = await runAgentJob({
  executionId: "hardening-test",
  workspace: { project: "group/app", branch: "main", token: "glpat-super-secret" },
  prompt: "review",
  output: z.object({ ok: z.boolean() }),
  writePolicy: "none",
  actor: { id: "test-user", email: "test@example.com" },
});
console.log(JSON.stringify(result.output));
