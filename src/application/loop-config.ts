import { z } from "zod";
import { parseDocument, stringify } from "yaml";
import { TriggerSchema } from "../config/schema.ts";
import { ConfigError } from "../core/errors.ts";

/** Portable configuration; executable handlers and credentials are never serialized. */
export const LoopConfigSchema = z.strictObject({
  version: z.literal(1),
  definitionId: z.string().min(1),
  name: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  visibility: z.enum(["private", "public"]),
  prompt: z.string().nullable(),
  enabled: z.boolean(),
  trigger: TriggerSchema,
  maxItemsPerRun: z.number().int().min(1),
  params: z.record(z.string(), z.unknown()),
});
export type LoopConfig = z.infer<typeof LoopConfigSchema>;

export function parseLoopConfig(input: unknown): LoopConfig {
  let value = input;
  if (typeof input === "string") {
    if (input.length > 100_000) throw new ConfigError("Loop configuration exceeds 100000 characters.");
    try {
      const document = parseDocument(input, { uniqueKeys: true });
      if (document.errors.length) throw new Error(document.errors.map((e) => e.message).join("\n"));
      value = document.toJS({ maxAliasCount: 0 });
    } catch (cause) {
      throw new ConfigError(`Invalid YAML: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  const parsed = LoopConfigSchema.safeParse(value);
  if (!parsed.success) throw new ConfigError(`Invalid loop configuration: ${parsed.error.message}`);
  return parsed.data;
}

export function loopConfigYaml(config: LoopConfig): string {
  return stringify(config);
}
