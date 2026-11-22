import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigError, ValidationError } from "../core/errors.ts";
import { AppConfigSchema, type AppConfig } from "./schema.ts";

export const DEFAULT_CONFIG_PATH = "config/workflows.yaml";

export interface LoadedConfig {
  /** Absolute path the config came from. */
  path: string;
  config: AppConfig;
  /** `database` resolved against the config file's directory. */
  databasePath: string;
}

/**
 * Loads global bootstrap settings and optional legacy `workflows` migration
 * input. Registered workflow blocks are imported into SQLite once during app
 * creation and are never consulted during runtime resolution.
 */
export async function loadConfig(path?: string): Promise<LoadedConfig> {
  const configPath = resolve(path ?? DEFAULT_CONFIG_PATH);
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    throw new ConfigError(
      `No config file at ${configPath}. Copy config/workflows.example.yaml to get started.`,
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(await file.text());
  } catch (cause) {
    throw new ConfigError(`Could not parse YAML in ${configPath}`, { cause });
  }

  // An empty file parses to null, which is a legitimate "all defaults".
  const parsed = AppConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid config in ${configPath}:\n${formatIssues(parsed.error)}`,
      { issues: parsed.error.issues },
    );
  }

  const config = parsed.data;

  return {
    path: configPath,
    config,
    databasePath: isAbsolute(config.database)
      ? config.database
      : resolve(dirname(configPath), config.database),
  };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  ${path}: ${issue.message}`;
    })
    .join("\n");
}
