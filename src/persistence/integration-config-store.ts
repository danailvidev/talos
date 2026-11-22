import type { Database } from "bun:sqlite";
import type {
  IntegrationConfigRepository,
  StoredIntegrationSetting,
} from "../application/ports.ts";
import { ConfigError } from "../core/errors.ts";
import { integrationField, isIntegrationField } from "../../shared/integrations.ts";
import type { Cipher } from "../secrets/crypto.ts";
import { fromIso, toIso } from "./database.ts";

interface Row {
  name: string;
  value: string;
  encrypted: number;
  updated_at: string;
}

/**
 * The instance-wide integration settings, one row per field.
 *
 * Secret fields are encrypted with `TALOS_SECRET_KEY`; the non-secret ones (a
 * Jira site URL, an account email) are plaintext on purpose, so the page still
 * works — and a wrong URL is still visible and fixable — on an install with no
 * key configured. Which of the two a name is comes from
 * `shared/integrations.ts`, not from the caller: a field that is secret in the
 * UI and plaintext in the database would be the worst of both.
 *
 * Decryption happens per read rather than being cached, for the same reason as
 * `SqliteCredentialStore`: a token replaced in the UI must take effect on the
 * next request, not on the next restart.
 */
export class SqliteIntegrationConfigStore implements IntegrationConfigRepository {
  /** Null when `TALOS_SECRET_KEY` is unset — see `set`. */
  constructor(
    private readonly db: Database,
    private readonly cipher: Cipher | null,
  ) {}

  get secretsEnabled(): boolean {
    return this.cipher != null;
  }

  all(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.rows()) {
      const value = this.read(row);
      if (value != null) out[row.name] = value;
    }
    return out;
  }

  list(): StoredIntegrationSetting[] {
    return this.rows().map((row) => ({
      name: row.name,
      updatedAt: fromIso(row.updated_at)!,
      // Secret values are withheld here rather than at the API edge, so there is
      // no serialisation path that could carry one to a browser by accident.
      ...(row.encrypted === 0 ? { value: row.value } : {}),
      ...(row.encrypted === 1 && this.read(row) == null ? { unreadable: true } : {}),
    }));
  }

  set(name: string, value: string): void {
    const field = integrationField(name);
    // Enforced here as well as at the API edge: a store that took any name would
    // let the settings page write TALOS_SECRET_KEY — the key that decrypts
    // everything else — into the database it protects.
    if (!field) {
      throw new ConfigError(
        `'${name}' is not an integration setting. See INTEGRATIONS in shared/integrations.ts.`,
      );
    }

    const trimmed = value.trim();
    // Clearing is a real intent, and an empty string stored as an override would
    // shadow the environment with nothing — see OverlaySecretStore.
    if (trimmed === "") {
      this.delete(name);
      return;
    }

    if (field.secret && !this.cipher) {
      throw new ConfigError(
        `Storing '${name}' needs an encryption key. Set TALOS_SECRET_KEY in ` +
          "config/.env (generate one with `openssl rand -hex 32`) and restart.",
      );
    }

    const stored = field.secret ? this.cipher!.encrypt(trimmed) : trimmed;
    const now = toIso(new Date());
    this.db.run(
      `INSERT INTO integration_config (name, value, encrypted, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE
         SET value = excluded.value,
             encrypted = excluded.encrypted,
             updated_at = excluded.updated_at`,
      [name, stored, field.secret ? 1 : 0, now],
    );
  }

  delete(name: string): boolean {
    const result = this.db.run("DELETE FROM integration_config WHERE name = ?", [name]);
    return result.changes > 0;
  }

  /**
   * Stored rows for fields that still exist. A row left behind by a removed
   * integration is skipped rather than returned: handing it to the secret store
   * would keep overriding an environment variable through a UI that no longer
   * shows it.
   */
  private rows(): Row[] {
    return this.db
      .query<Row, []>(
        "SELECT name, value, encrypted, updated_at FROM integration_config ORDER BY name",
      )
      .all()
      .filter((row) => isIntegrationField(row.name));
  }

  /**
   * Undefined for a value this process cannot decrypt. `TALOS_SECRET_KEY`
   * having changed (or gone) must not take down every request that reads a
   * secret store — the effect should be that the override is absent and the
   * environment answers instead, which is what the page reports too.
   */
  private read(row: Row): string | undefined {
    if (row.encrypted === 0) return row.value;
    if (!this.cipher) return undefined;
    try {
      return this.cipher.decrypt(row.value);
    } catch {
      return undefined;
    }
  }
}
