import { z } from "zod";

/**
 * Global, bootstrap-only settings. Everything task-specific (enabled,
 * schedule/trigger, maxItemsPerRun, connector blocks) used to live alongside
 * these in YAML; it now lives in the scheduled_task_config table instead, since it
 * needs to be editable live via the web UI. What's left here is only
 * what's needed before the database can even be opened — the database path
 * itself, obviously, cannot live inside it.
 *
 * `logLevel`, `timezone` and `llm` are only the *defaults* now: an operator
 * can override any of them live via the general_config table in the web UI,
 * without touching this file or restarting — see config/resolve-settings.ts.
 * `database` cannot be overridden that way since it is what has to be open
 * before that table can even be read.
 */

export const cronExpression = z
  .string()
  .min(1)
  .refine((value) => value.trim().split(/\s+/).length >= 5, {
    message: "expected at least 5 cron fields, e.g. '*/5 * * * *'",
  });

const isoDatetime = z.string().refine((value) => !Number.isNaN(new Date(value).getTime()), {
  message: "expected an ISO datetime",
});

export const TriggerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cron"),
    expression: cronExpression,
    timezone: z.string().optional(),
    /** Do not fire before this instant. The cron still decides the clock time. */
    startAt: isoDatetime.optional(),
  }),
  z.object({
    type: z.literal("once"),
    at: isoDatetime,
    timezone: z.string().optional(),
  }),
  z.object({ type: z.literal("manual") }),
]);

export type Trigger = z.infer<typeof TriggerSchema>;

/**
 * Claude Code aliases — `gitlab-code-review` passes these to `claude --model`.
 * Each tracks the latest of that family rather than pinning a dated snapshot.
 */
export const LLM_MODELS = ["haiku", "sonnet", "opus", "fable"] as const;
export const LlmModelSchema = z.enum(LLM_MODELS);

/**
 * Claude Code effort levels — `gitlab-code-review` passes these to
 * `claude --effort`. Available levels can still vary by model; Claude Code
 * clamps rather than rejecting an unsupported one.
 */
export const LLM_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const LlmEffortSchema = z.enum(LLM_EFFORTS);

export type LlmModel = z.infer<typeof LlmModelSchema>;
export type LlmEffort = z.infer<typeof LlmEffortSchema>;

export const LlmDefaultsSchema = z.object({
  provider: z.string().default("anthropic"),
  model: LlmModelSchema.optional(),
  effort: LlmEffortSchema.optional(),
  maxTokens: z.number().int().positive().default(2048),
});

export const AppConfigSchema = z.object({
  /** SQLite file. Relative paths resolve from the config file's directory. */
  database: z.string().default("./data/talos.db"),
  logLevel: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  /** Applies to cron triggers that do not set their own. */
  timezone: z.string().optional(),
  llm: LlmDefaultsSchema.default({ provider: "anthropic", maxTokens: 2048 }),
  /**
   * Deprecated migration input. Each registered task block is copied to SQLite
   * once, after which live DB values are the sole runtime source.
   */
  workflows: z.record(z.string(), z.unknown()).optional(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export const LogLevelSchema = AppConfigSchema.shape.logLevel;

/**
 * A partial update to the general (non-task) settings, as accepted by
 * `PUT /api/settings`. `null` on a field clears
 * the override and reverts to the YAML default; `undefined`/absent leaves it
 * untouched.
 */
export const GeneralSettingsPatchSchema = z.object({
  logLevel: LogLevelSchema.nullable().optional(),
  timezone: z.string().nullable().optional(),
  llm: z
    .object({
      provider: z.string().nullable().optional(),
      model: LlmModelSchema.nullable().optional(),
      effort: LlmEffortSchema.nullable().optional(),
      maxTokens: z.number().int().positive().nullable().optional(),
    })
    .optional(),
});

export type GeneralSettingsPatch = z.infer<typeof GeneralSettingsPatchSchema>;
