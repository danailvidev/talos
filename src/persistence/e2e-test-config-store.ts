import type { Database } from "bun:sqlite";
import type {
  E2eTestConfig,
  E2eTestConfigRepository,
} from "../application/ports.ts";
import { ConfigError } from "../core/errors.ts";
import type { Cipher } from "../secrets/crypto.ts";
import { toIso } from "./database.ts";

interface Row {
  agent_instructions_override: string | null;
  runtime_config_override: string | null;
  additional_instructions: string | null;
}

const EMPTY_CONFIG: E2eTestConfig = {
  agentInstructionsOverride: null,
  runtimeConfigOverride: null,
  additionalInstructions: null,
};

/** The singleton configuration edited under Settings → E2E tests. */
export class SqliteE2eTestConfigStore implements E2eTestConfigRepository {
  constructor(
    private readonly db: Database,
    private readonly cipher: Cipher | null,
  ) {}

  get(): E2eTestConfig {
    const row = this.row();
    if (!row) return { ...EMPTY_CONFIG };
    return {
      agentInstructionsOverride: row.agent_instructions_override,
      runtimeConfigOverride: this.decryptRuntimeConfig(row.runtime_config_override),
      additionalInstructions: row.additional_instructions,
    };
  }

  inspect(): E2eTestConfig & {
    secretsEnabled: boolean;
    runtimeConfigUnreadable: boolean;
  } {
    const row = this.row();
    if (!row) {
      return {
        ...EMPTY_CONFIG,
        secretsEnabled: this.cipher != null,
        runtimeConfigUnreadable: false,
      };
    }
    let runtimeConfigOverride: string | null = null;
    let runtimeConfigUnreadable = false;
    try {
      runtimeConfigOverride = this.decryptRuntimeConfig(row.runtime_config_override);
    } catch {
      runtimeConfigUnreadable = row.runtime_config_override != null;
    }
    return {
      agentInstructionsOverride: row.agent_instructions_override,
      runtimeConfigOverride,
      additionalInstructions: row.additional_instructions,
      secretsEnabled: this.cipher != null,
      runtimeConfigUnreadable,
    };
  }

  set(patch: Partial<E2eTestConfig>): void {
    if (patch.runtimeConfigOverride != null && !this.cipher) {
      throw new ConfigError(
        "Storing the E2E runtime config needs an encryption key. Set TALOS_SECRET_KEY " +
          "in config/.env and restart.",
      );
    }
    const now = toIso(new Date());
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO e2e_test_config (
           id, agent_instructions_override, runtime_config_override,
           additional_instructions, updated_at
         ) VALUES (1, NULL, NULL, NULL, ?)
         ON CONFLICT(id) DO NOTHING`,
        [now],
      );
      if ("agentInstructionsOverride" in patch) {
        this.updateColumn(
          "agent_instructions_override",
          patch.agentInstructionsOverride ?? null,
          now,
        );
      }
      if ("runtimeConfigOverride" in patch) {
        this.updateColumn(
          "runtime_config_override",
          patch.runtimeConfigOverride == null
            ? null
            : this.cipher!.encrypt(patch.runtimeConfigOverride),
          now,
        );
      }
      if ("additionalInstructions" in patch) {
        this.updateColumn(
          "additional_instructions",
          patch.additionalInstructions ?? null,
          now,
        );
      }
    })();
  }

  private row(): Row | null {
    return this.db.query<Row, []>(
      `SELECT agent_instructions_override, runtime_config_override,
              additional_instructions
         FROM e2e_test_config
        WHERE id = 1`,
    ).get() ?? null;
  }

  private decryptRuntimeConfig(value: string | null): string | null {
    if (value == null) return null;
    if (!this.cipher) {
      throw new ConfigError(
        "The stored E2E runtime config cannot be decrypted because TALOS_SECRET_KEY is unset.",
      );
    }
    return this.cipher.decrypt(value);
  }

  private updateColumn(
    column: "agent_instructions_override" | "runtime_config_override" | "additional_instructions",
    value: string | null,
    updatedAt: string,
  ): void {
    this.db.run(
      `UPDATE e2e_test_config SET ${column} = ?, updated_at = ? WHERE id = 1`,
      [value, updatedAt],
    );
  }
}
