import { z } from "zod";
import { ConfigError } from "./errors.ts";

/**
 * Applies a params schema's defaults to a stored (possibly empty) blob without
 * throwing. Incomplete stored params for a task that has code defaults — e.g.
 * gitlab-ci-failure's gitlab/jira targets — become the effective values a run
 * and the UI should see. Invalid stored params are left as-is; TaskExecutor.run
 * is still the validation gate.
 */
export function applyParamsDefaults(schema: z.ZodTypeAny, stored: unknown): unknown {
  const parsed = schema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : (stored ?? {});
}

/**
 * Plain-object spread that drops `undefined` values. Needed because a shallow
 * `{ ...stored, ...override }` would replace a stored `gitlab` object with
 * `undefined` if an API body explicitly included it after a round-trip.
 */
export function definedRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * Layers for an explicit run (UI Rerun, CLI `task run`, POST /run). Later
 * layers win. Typical order: last run (fallback) → stored schedule → request.
 */
export function mergeInvocationParams(...layers: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const layer of layers) Object.assign(out, definedRecord(layer));
  return out;
}

/**
 * A flat description of one field of a params/config schema — enough for a
 * caller to build a UI from without touching zod internals itself. The web API
 * turns this into JSON a form can render.
 */
export interface ParamField {
  name: string;
  kind: "string" | "number" | "boolean" | "enum";
  required: boolean;
  default?: unknown;
  description?: string;
  choices?: string[];
}

/**
 * Describes a flat `z.object` of primitives/enums (plus optional/default
 * wrappers around them) as a list of `ParamField`. Anything richer — nested
 * object, array, union — is a `ConfigError` at the call site, not a confusing
 * runtime failure once a form or a CLI flag set is half-built from it.
 */
export function describeParamsSchema(schema: z.ZodTypeAny): ParamField[] {
  if (!(schema instanceof z.ZodObject)) {
    throw new ConfigError("paramsSchema must be a flat z.object({...}).");
  }

  return Object.entries(schema.shape).map(([name, rawField]) => {
    const meta = describeField(rawField as z.ZodTypeAny);
    const kind = kindOf(name, meta.inner);

    return {
      name,
      kind,
      required: meta.required,
      ...(meta.defaultValue !== undefined ? { default: meta.defaultValue } : {}),
      ...(meta.description !== undefined ? { description: meta.description } : {}),
      ...(kind === "enum" ? { choices: (meta.inner as z.ZodEnum).options as string[] } : {}),
    };
  });
}

/**
 * Same as `describeParamsSchema`, but tolerant of a schema that is not flat —
 * a nested object/array/union field, e.g. gitlab-ci-failure's `gitlab`/`jira`
 * blocks. The task list API cannot let one such task's shape break the whole
 * listing, so it gets an empty field list instead.
 */
export function describeParamsSchemaLoosely(schema: z.ZodTypeAny): ParamField[] {
  try {
    return describeParamsSchema(schema);
  } catch (err) {
    if (err instanceof ConfigError) return [];
    throw err;
  }
}

interface FieldMeta {
  inner: z.ZodTypeAny;
  required: boolean;
  defaultValue?: unknown;
  description?: string;
}

/**
 * Unwraps ZodOptional/ZodDefault layers to find the field's real type, its
 * default (if any), and whether it's required — while reading `.description`
 * from the original (wrapped) schema, since that's where `.describe()` sets it.
 */
export function describeField(field: z.ZodTypeAny): FieldMeta {
  const description = field.description;
  let inner: z.ZodTypeAny = field;
  let required = true;
  let defaultValue: unknown;

  while (inner instanceof z.ZodDefault || inner instanceof z.ZodOptional) {
    if (inner instanceof z.ZodDefault) {
      defaultValue = inner.def.defaultValue;
      required = false;
      inner = inner.unwrap() as z.ZodTypeAny;
    } else if (inner instanceof z.ZodOptional) {
      required = false;
      inner = inner.unwrap() as z.ZodTypeAny;
    }
  }

  return { inner, required, defaultValue, description };
}

function kindOf(name: string, inner: z.ZodTypeAny): ParamField["kind"] {
  if (inner instanceof z.ZodBoolean) return "boolean";
  if (inner instanceof z.ZodNumber) return "number";
  if (inner instanceof z.ZodEnum) return "enum";
  if (inner instanceof z.ZodString) return "string";

  throw new ConfigError(
    `Params field '${name}' is not representable (only string/number/boolean/enum are). ` +
      "Flatten it or accept it as a JSON string and parse it yourself.",
  );
}
