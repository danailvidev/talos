import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { applyParamsDefaults, describeParamsSchema, mergeInvocationParams } from "../src/core/params-schema.ts";
import { ConfigError } from "../src/core/errors.ts";

describe("describeParamsSchema", () => {
  test("a required string field is required with no default", () => {
    const [field] = describeParamsSchema(
      z.object({ message: z.string().describe("Message to echo") }),
    );
    expect(field).toMatchObject({
      name: "message",
      kind: "string",
      required: true,
      description: "Message to echo",
    });
    expect(field!.default).toBeUndefined();
  });

  test("a defaulted number field is not required and carries its default", () => {
    const [field] = describeParamsSchema(z.object({ repeat: z.number().int().default(1) }));
    expect(field).toMatchObject({ name: "repeat", kind: "number", required: false, default: 1 });
  });

  test("a boolean field reports its kind and default", () => {
    const [field] = describeParamsSchema(z.object({ flag: z.boolean().default(false) }));
    expect(field).toMatchObject({ kind: "boolean", required: false, default: false });
  });

  test("an enum field carries its choices", () => {
    const [field] = describeParamsSchema(z.object({ mode: z.enum(["a", "b", "c"]) }));
    expect(field).toMatchObject({ kind: "enum", required: true, choices: ["a", "b", "c"] });
  });

  test("an optional field is not required and has no default", () => {
    const [field] = describeParamsSchema(z.object({ note: z.string().optional() }));
    expect(field).toMatchObject({ kind: "string", required: false });
    expect(field!.default).toBeUndefined();
  });

  test("a non-object schema is rejected", () => {
    expect(() => describeParamsSchema(z.string())).toThrow(ConfigError);
  });

  test("a nested object field is rejected, not silently dropped", () => {
    expect(() =>
      describeParamsSchema(z.object({ nested: z.object({ a: z.string() }) })),
    ).toThrow(ConfigError);
  });

  test("an array field is rejected", () => {
    expect(() => describeParamsSchema(z.object({ items: z.array(z.string()) }))).toThrow(
      ConfigError,
    );
  });
});

describe("applyParamsDefaults", () => {
  test("empty stored params pick up schema defaults", () => {
    const schema = z.object({
      gitlab: z.object({ projectId: z.string() }).default({ projectId: "acme/web" }),
    });
    expect(applyParamsDefaults(schema, {})).toEqual({ gitlab: { projectId: "acme/web" } });
  });

  test("invalid stored params are left as-is rather than thrown", () => {
    const schema = z.object({ n: z.number() });
    expect(applyParamsDefaults(schema, { n: "nope" })).toEqual({ n: "nope" });
  });
});

describe("mergeInvocationParams", () => {
  test("later layers win, and undefined does not clobber a stored object", () => {
    expect(
      mergeInvocationParams(
        { gitlab: { projectId: "a" }, jira: { project: "TP" } },
        { gitlab: undefined, anyStatus: true },
        {},
      ),
    ).toEqual({
      gitlab: { projectId: "a" },
      jira: { project: "TP" },
      anyStatus: true,
    });
  });

  test("an empty override keeps last-run params", () => {
    expect(
      mergeInvocationParams(
        { gitlab: { projectId: "acme/web" }, jira: { project: "WP" } },
        {},
        {},
      ),
    ).toEqual({
      gitlab: { projectId: "acme/web" },
      jira: { project: "WP" },
    });
  });
});
