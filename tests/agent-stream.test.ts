import { describe, expect, test } from "bun:test";
import {
  AgentEventAccumulator,
  agentResultText,
  logsFromStreamLine,
  modelJsonValues,
  pushOutcome,
} from "../src/infrastructure/agent/stream.ts";
import {
  ReviewOutputSchema,
  unstructuredReview,
} from "../src/tasks/code-review/review-result.ts";

/** How `runAgentJob.parseOutput` composes these, without a container. */
function parseReview(rawText: string) {
  for (const value of modelJsonValues(rawText)) {
    const parsed = ReviewOutputSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return unstructuredReview(rawText);
}

describe("logsFromStreamLine", () => {
  test("turns clone progress into a line", () => {
    const line = JSON.stringify({
      type: "talos",
      event: "clone",
      status: "started",
      project: "acme/web",
      branch: "fix/1",
    });
    expect(logsFromStreamLine(line)).toEqual([{ message: "cloning acme/web@fix/1" }]);
  });

  test("turns target-branch fetch into a line", () => {
    const line = JSON.stringify({
      type: "talos",
      event: "fetch-target",
      status: "done",
    });
    expect(logsFromStreamLine(line)).toEqual([{ message: "wrote combined MR diff vs target" }]);
  });

  test("turns guideline collection into a line", () => {
    const line = JSON.stringify({
      type: "talos",
      event: "guidelines",
      status: "started",
    });
    expect(logsFromStreamLine(line)).toEqual([
      { message: "collecting CLAUDE.md / AGENTS.md / docs/guidelines" },
    ]);
  });

  test("reports how many repository guideline files were collected", () => {
    const line = JSON.stringify({
      type: "talos",
      event: "guidelines",
      status: "done",
      files: 3,
      bytes: 4096,
    });
    expect(logsFromStreamLine(line)).toEqual([
      {
        message: "collected 3 repository guideline files",
        meta: { guidelineFiles: 3, guidelineBytes: 4096 },
      },
    ]);
  });

  test("warns when the checkout contains no repository guidelines", () => {
    const line = JSON.stringify({
      type: "talos",
      event: "guidelines",
      status: "done",
      files: 0,
      bytes: 0,
    });
    expect(logsFromStreamLine(line)).toEqual([
      {
        message: "no CLAUDE.md, AGENTS.md, or docs guidelines found",
        level: "warn",
        meta: { guidelineFiles: 0, guidelineBytes: 0 },
      },
    ]);
  });

  test("reports what the entrypoint pushed, and where", () => {
    const line = JSON.stringify({
      type: "talos",
      event: "push",
      status: "done",
      sha: "0123456789abcdef",
      branch: "fix/1",
    });
    expect(logsFromStreamLine(line)).toEqual([{ message: "pushed 0123456789ab to fix/1" }]);
  });

  test("summarizes a Read tool call without dumping the rest of the payload", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: "src/app.ts" } }],
      },
    });
    expect(logsFromStreamLine(line)).toEqual([
      { message: "claude Read src/app.ts", meta: { agent: "claude", tool: "Read" } },
    ]);
  });

  test("ignores the final JSON blob so the log is not a second copy of the review", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: '```json\n{"summary":"ok","findings":[]}\n```' }] },
    });
    expect(logsFromStreamLine(line)).toEqual([]);
  });

  test("ignores a malformed line rather than throwing", () => {
    expect(logsFromStreamLine("not json")).toEqual([]);
  });
});

describe("agentResultText", () => {
  test("returns the result event's text, the way --output-format json used to print it", () => {
    const raw = agentResultText([
      { type: "system", subtype: "init" },
      { type: "result", result: '```json\n{"summary":"looks fine","findings":[]}\n```' },
    ]);
    expect(parseReview(raw!)).toEqual({
      summary: "looks fine",
      findings: [],
      unstructured: false,
    });
  });

  test("is undefined when the agent never produced an answer", () => {
    // Distinct from a malformed answer: `runAgentJob` reports the two differently.
    expect(agentResultText([{ type: "system", subtype: "init" }])).toBeUndefined();
  });

  test("prefers structured_output over the prose result", () => {
    expect(
      agentResultText([
        { type: "result", result: "not json", structured_output: { summary: "ok" } },
      ]),
    ).toBe('{"summary":"ok"}');
  });
});

describe("pushOutcome", () => {
  test("reads the sha and branch the entrypoint reported", () => {
    expect(
      pushOutcome([
        { type: "result", result: "{}" },
        { type: "talos", event: "push", status: "done", sha: "abc123", branch: "fix/1" },
      ]),
    ).toEqual({ sha: "abc123", branch: "fix/1" });
  });

  test("is undefined when nothing was pushed", () => {
    expect(pushOutcome([{ type: "talos", event: "push", status: "no-change" }])).toBeUndefined();
  });
});

describe("extractJsonBlock", () => {
  test("unwraps a fenced JSON block that is not inside an envelope", () => {
    expect(parseReview('```json\n{"summary":"direct","findings":[]}\n```')).toEqual({
      summary: "direct",
      findings: [],
      unstructured: false,
    });
  });

  test("still accepts the json envelope", () => {
    const stdout = JSON.stringify({
      result:
        '```json\n{"summary":"ok","findings":[{"severity":"nit","file":"a.ts","comment":"n"}]}\n```',
    });
    const review = parseReview(stdout);
    expect(review.summary).toBe("ok");
    expect(review.findings).toHaveLength(1);
  });

  test("falls back to prose when the reply is not the requested JSON", () => {
    expect(parseReview("I could not find the diff.").unstructured).toBe(true);
  });
});

describe("modelJsonValues", () => {
  test("repairs a trailing comma, a comment, and a raw newline inside a string", () => {
    expect(
      modelJsonValues('{/* note */ "summary": "line1\nline2", "findings": [], /* done */}'),
    ).toEqual([{ summary: "line1\nline2", findings: [] }]);
  });

  test("keeps // inside a string", () => {
    expect(modelJsonValues('{"summary":"https://example.com","findings":[]}')).toEqual([
      { summary: "https://example.com", findings: [] },
    ]);
  });

  test("reads the object when a later fence would swallow a greedy match", () => {
    const raw = '```json\n{"summary":"see ```ts code```","findings":[]}\n```\nthen ```more```';
    expect(parseReview(raw)).toEqual({
      summary: "see ```ts code```",
      findings: [],
      unstructured: false,
    });
  });

  test("does not treat a type sketch as JSON", () => {
    expect(modelJsonValues('{"summary": string}')).toEqual([]);
  });

  test("returns the last object first", () => {
    expect(modelJsonValues('{"summary":"first"}\n{"summary":"second"}')).toEqual([
      { summary: "second" },
      { summary: "first" },
    ]);
  });
});

describe("AgentEventAccumulator", () => {
  test("bounds history while preserving results, pushes, and tool-error counts", () => {
    const events = new AgentEventAccumulator(2);
    events.add({ type: "result", result: "{\"summary\":\"done\"}" });
    events.add({ type: "talos", event: "push", status: "done", sha: "abc" });
    events.add({
      type: "user",
      message: { content: [{ type: "tool_result", is_error: true }] },
    });
    events.add({ type: "assistant", content: [{ type: "text", text: "latest" }] });

    const snapshot = events.snapshot();
    expect(snapshot).toHaveLength(4);
    expect(agentResultText(snapshot)).toContain("done");
    expect(pushOutcome(snapshot)).toEqual({ sha: "abc" });
    expect(events.toolErrors()).toBe(1);
  });

  test("uses terminal token totals and preserves model, turns, duration, and cache usage", () => {
    const events = new AgentEventAccumulator();
    events.add({ type: "system", subtype: "init", model: "claude-sonnet-4-5" });
    events.add({
      type: "assistant",
      message: { usage: { input_tokens: 5, output_tokens: 7 } },
    });
    events.add({
      type: "result",
      num_turns: 2,
      duration_ms: 1234,
      usage: {
        input_tokens: 11,
        output_tokens: 13,
        cache_read_input_tokens: 17,
        cache_creation_input_tokens: 19,
      },
    });

    expect(events.usage()).toEqual({
      inputTokens: 11,
      outputTokens: 13,
      cacheReadInputTokens: 17,
      cacheCreationInputTokens: 19,
      model: "claude-sonnet-4-5",
      turns: 2,
      durationMs: 1234,
    });
  });

  test("sums assistant message usage when a failed run has no result envelope", () => {
    const events = new AgentEventAccumulator();
    events.add({
      type: "assistant",
      message: {
        usage: {
          input_tokens: 3,
          output_tokens: 4,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 6,
        },
      },
    });
    events.add({
      type: "assistant",
      message: { usage: { input_tokens: 7, output_tokens: 8 } },
    });

    expect(events.usage()).toEqual({
      inputTokens: 10,
      outputTokens: 12,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 6,
    });
  });

  test("does not invent zero usage when Claude emits no telemetry", () => {
    const events = new AgentEventAccumulator();
    events.add({ type: "result", result: "{}" });
    expect(events.usage()).toBeUndefined();
  });
});
