import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  AGENT_ENTRYPOINT_SH,
  agentContainerFailure,
  agentContainerName,
  BRANCH_MOVED_EXIT_CODE,
  claudeCliFlags,
} from "../src/infrastructure/agent/index.ts";
import { resolveAgentOutput } from "../src/infrastructure/agent/run.ts";
import { buildReviewPrompt } from "../src/tasks/code-review/prompt.ts";

describe("claudeCliFlags", () => {
  test("omits both flags when unset so Claude uses its own defaults", () => {
    expect(claudeCliFlags({})).toEqual([]);
  });

  test("passes --model and --effort through to the container entrypoint", () => {
    expect(claudeCliFlags({ model: "opus", effort: "high" })).toEqual([
      "--model",
      "opus",
      "--effort",
      "high",
    ]);
  });

  test("passes --json-schema for a corrected-result rewrite", () => {
    expect(claudeCliFlags({ jsonSchema: '{"type":"object"}' })).toEqual([
      "--json-schema",
      '{"type":"object"}',
    ]);
  });
});

describe("resolveAgentOutput", () => {
  const output = z.object({ summary: z.string() });

  test("accepts a trailing comma without a second container", async () => {
    const result = await resolveAgentOutput(
      { executionId: "e", prompt: "work", output, writePolicy: "none" },
      [{ type: "result", result: '{"summary":"ok",}' }],
      async () => {
        throw new Error("should not rewrite");
      },
    );
    expect(result).toEqual({ summary: "ok" });
  });

  test("keeps prose when the caller accepts an unstructured answer", async () => {
    const result = await resolveAgentOutput(
      {
        executionId: "e",
        prompt: "work",
        output,
        writePolicy: "none",
        onUnstructured: () => ({ summary: "prose" }),
      },
      [{ type: "result", result: "not json" }],
      async () => {
        throw new Error("should not rewrite");
      },
    );
    expect(result).toEqual({ summary: "prose" });
  });

  test("asks once for a corrected result and does not repeat the checkout", async () => {
    let calls = 0;
    const result = await resolveAgentOutput(
      {
        executionId: "e",
        label: 6439,
        prompt: "work",
        output: output.extend({ noteId: z.number().int().positive() }),
        writePolicy: "push",
        model: "haiku",
      },
      [{ type: "result", result: '{"summary": string}' }],
      async (repair) => {
        calls++;
        expect(repair.writePolicy).toBe("none");
        expect(repair.jsonRewrite).toBe(true);
        expect(repair.workspace).toBeUndefined();
        expect(repair.label).toBe("6439-json");
        expect(repair.model).toBe("haiku");
        expect(repair.prompt).toContain('{"summary": string}');
        expect(repair.prompt).toContain('"type":"object"');
        expect(repair.prompt).not.toContain("exclusiveMinimum");
        return [{ type: "result", structured_output: { summary: "fixed", noteId: 4 } }];
      },
    );
    expect(calls).toBe(1);
    expect(result).toEqual({ summary: "fixed", noteId: 4 });
  });

  test("keeps the original error when the corrected-result request fails", async () => {
    await expect(
      resolveAgentOutput(
        { executionId: "e", prompt: "work", output, writePolicy: "none" },
        [{ type: "result", result: "not json" }],
        async () => {
          throw new Error("docker down");
        },
      ),
    ).rejects.toThrow(/was not JSON/);
  });
});

describe("buildReviewPrompt", () => {
  test("points the reviewer at GitLab's MR diff and the repo's review guidelines", () => {
    const prompt = buildReviewPrompt("This is merge request !6193.", "main");
    expect(prompt).toContain("Changes tab");
    expect(prompt).toContain(".talos/mr.diff");
    expect(prompt).toContain(".talos/guidelines.md");
    expect(prompt).toContain("repository review rubric appended below");
    expect(prompt).toContain("CLAUDE.md");
    // Not a literal 'docs/guidelines' path any more: the entrypoint collects
    // single-file conventions too, so the prompt names the collected file.
    expect(prompt).toContain("docs guidelines");
    expect(prompt).toContain("changed-files.txt");
    expect(prompt).toContain("bootstrap");
    expect(prompt).toContain("main");
    // Reading the rest of the repo is what makes the diff judgeable; only
    // *reporting* is scoped to it. Asserted because the previous wording
    // ("open only paths listed in changed-files.txt") said the opposite.
    expect(prompt).toContain("Reading an unchanged file is expected");
  });
});

describe("AGENT_ENTRYPOINT_SH", () => {
  test("clones full branch history, prefers mounted GitLab diffs, and collects guidelines", () => {
    expect(AGENT_ENTRYPOINT_SH).not.toContain("git clone --depth");
    // The filter is a variable now, because 'rebase' needs a full clone: it replays
    // every commit after the token has gone, when a partial clone could no longer
    // fetch the blobs it needs.
    expect(AGENT_ENTRYPOINT_SH).toContain('clone_filter="--filter=blob:none"');
    expect(AGENT_ENTRYPOINT_SH).toContain("git clone $clone_filter --single-branch");
    expect(AGENT_ENTRYPOINT_SH).toContain("/mr-input");
    expect(AGENT_ENTRYPOINT_SH).not.toContain("cp -a");
    expect(AGENT_ENTRYPOINT_SH).toContain('cat "$f" > ".talos/$(basename "$f")"');
    expect(AGENT_ENTRYPOINT_SH).toContain('git diff "origin/$TARGET"...HEAD > .talos/mr.diff');
    expect(AGENT_ENTRYPOINT_SH).toContain("-iname 'claude.md'");
    expect(AGENT_ENTRYPOINT_SH).toContain("*/docs/guidelines/*");
    expect(AGENT_ENTRYPOINT_SH).toContain("APPEND_REPOSITORY_GUIDELINES");
    expect(AGENT_ENTRYPOINT_SH).toContain('cat .talos/guidelines.md >> "$agent_prompt_file"');
    expect(AGENT_ENTRYPOINT_SH).toContain('--permission-mode dontAsk "$@" < "$agent_prompt_file"');
    expect(AGENT_ENTRYPOINT_SH).not.toContain('"$(cat "$agent_prompt_file")"');
    expect(AGENT_ENTRYPOINT_SH).toContain("GIT_CONFIG_KEY_0=safe.directory");
    expect(AGENT_ENTRYPOINT_SH).toContain("GIT_CONFIG_VALUE_0=/workspace");
  });

  test("keeps credentials away from the agent, and only ever force-pushes with a lease", () => {
    // The token is stripped after the last read that needs it, unconditionally —
    // the old review entrypoint left it in place, which was only safe because that
    // agent had no Bash.
    expect(AGENT_ENTRYPOINT_SH).toContain('git remote set-url origin "$plain_url"');
    expect(AGENT_ENTRYPOINT_SH).toContain('git push origin "HEAD:refs/heads/$BRANCH"');
    expect(AGENT_ENTRYPOINT_SH).toContain('remote_head" != "$START_SHA');
    expect(AGENT_ENTRYPOINT_SH).toContain(`exit ${BRANCH_MOVED_EXIT_CODE}`);

    // 'rebase' rewrites history, so it is the one policy that forces — but never
    // bare: the lease against the head the job was raised for is what stops it
    // discarding a commit somebody pushed while the agent was working.
    expect(AGENT_ENTRYPOINT_SH).not.toContain("push --force ");
    expect(AGENT_ENTRYPOINT_SH).not.toContain("push -f");
    expect(AGENT_ENTRYPOINT_SH).toContain(
      'git push --force-with-lease="refs/heads/$BRANCH:$START_SHA"',
    );
  });

  test("rebase is started by the shell and never pushed half-finished", () => {
    expect(AGENT_ENTRYPOINT_SH).toContain('git rebase "origin/$TARGET"');
    // Non-interactive: with no terminal attached, an editor prompt would hang the
    // container until its timeout.
    expect(AGENT_ENTRYPOINT_SH).toContain("export GIT_SEQUENCE_EDITOR=true");
    expect(AGENT_ENTRYPOINT_SH).toContain(".talos/rebase-state.txt");
    expect(AGENT_ENTRYPOINT_SH).toContain("git rebase --abort");
    expect(AGENT_ENTRYPOINT_SH).toContain("the agent left a rebase in progress");
  });

  test("commits nothing under the read-only policy, and never commits its own scratch dir", () => {
    expect(AGENT_ENTRYPOINT_SH).toContain(
      'if [ "${WRITE_POLICY:-none}" = "none" ]; then\n  exit 0\nfi',
    );
    expect(AGENT_ENTRYPOINT_SH).toContain("echo '/.talos/' >> .git/info/exclude");
  });

  test("limits available tools instead of only auto-approving them", () => {
    expect(AGENT_ENTRYPOINT_SH).toContain(
      '--tools "$AVAILABLE_TOOLS" --allowedTools "$ALLOWED_TOOLS"',
    );
    expect(AGENT_ENTRYPOINT_SH).toContain(
      "--strict-mcp-config --mcp-config /tmp/talos-empty-mcp.json",
    );
    expect(AGENT_ENTRYPOINT_SH).toContain("--permission-mode dontAsk");
    expect(AGENT_ENTRYPOINT_SH).toContain('{"mcpServers":{}}');
  });

  test("push+mr refuses to write over an existing branch", () => {
    expect(AGENT_ENTRYPOINT_SH).toContain('git push origin "HEAD:refs/heads/$PUSH_BRANCH"');
    expect(AGENT_ENTRYPOINT_SH).toContain("refusing to push over the existing branch");
  });
});

describe("agentContainerName", () => {
  test("is a legal docker name derived from the execution id", () => {
    expect(agentContainerName("task-89c85ceb-4709-46a3-913e-1d5b02aff816")).toBe(
      "talos-task-89c85ceb-4709-46a3-913e-1d5b02aff816",
    );
    expect(agentContainerName("weird/id")).toBe("talos-weird-id");
  });

  test("discriminates two agents in one execution", () => {
    expect(agentContainerName("exec-1", 6193)).toBe("talos-exec-1-6193");
  });
});

describe("agentContainerFailure", () => {
  const base = {
    project: "example-org/webapp",
    branch: "fix/TP-3012",
    stderr: "",
    timeoutMs: 5 * 60_000,
  };

  test("names a timeout instead of a blank exit 143", () => {
    expect(
      agentContainerFailure({ ...base, exitCode: 143, timedOut: true, cancelled: false }),
    ).toContain("timed out after 5m");
  });

  test("explains SIGTERM when the container was stopped without a timeout", () => {
    expect(
      agentContainerFailure({ ...base, exitCode: 143, timedOut: false, cancelled: false }),
    ).toBe(
      "claude: containerized agent for example-org/webapp@fix/TP-3012 was stopped (SIGTERM, exit 143)",
    );
  });

  test("explains SIGKILL as likely OOM", () => {
    expect(
      agentContainerFailure({ ...base, exitCode: 137, timedOut: false, cancelled: false }),
    ).toContain("2g container memory limit");
  });
});
