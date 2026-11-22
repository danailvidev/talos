import { describe, expect, test } from "bun:test";
import {
  buildMrRevisionPrompt,
  MrRevisionOutputSchema,
} from "../src/tasks/mr-revision/agent.ts";

describe("MrRevisionOutputSchema", () => {
  test("requires a human-readable response", () => {
    expect(MrRevisionOutputSchema.parse({ response: "Updated the validation and tests." }))
      .toEqual({ response: "Updated the validation and tests." });
    expect(MrRevisionOutputSchema.safeParse({ response: "" }).success).toBe(false);
  });
});

describe("buildMrRevisionPrompt", () => {
  test("uses the current instruction and history without granting git writes", () => {
    const prompt = buildMrRevisionPrompt(12, "acme/web", "fix/one");
    expect(prompt).toContain(".talos/revision-request.json");
    expect(prompt).toContain("earlier turns");
    expect(prompt).toContain("Do not commit, push");
    expect(prompt).toContain("!12");
    expect(prompt).toContain("acme/web");
  });
});
