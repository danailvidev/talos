import type { Database } from "bun:sqlite";
import type {
  CredentialRepository,
  StoredCredential,
} from "../application/ports.ts";
import { ConfigError } from "../core/errors.ts";
import { isActorSecret } from "../secrets/secret-store.ts";
import type { Cipher } from "../secrets/crypto.ts";
import { fromIso, toIso } from "./database.ts";

/**
 * One developer's GitLab/Jira tokens, encrypted with `TALOS_SECRET_KEY`.
 *
 * Decryption happens on read rather than being cached, and that is a deliberate
 * cost: a token revoked in the UI must stop working on the next run, not
 * whenever the process restarts. The reads are per-run, not per-request, so the
 * AES cost is invisible next to the API calls that follow.
 */
export class SqliteCredentialStore implements CredentialRepository {
  readonly enabled = true;

  constructor(
    private readonly db: Database,
    private readonly cipher: Cipher,
  ) {}

  all(userId: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.db
      .query<ValueRow, [string]>(
        "SELECT name, value FROM user_credentials WHERE user_id = ?",
      )
      .all(userId)) {
      out[row.name] = this.cipher.decrypt(row.value);
    }
    return out;
  }

  get(userId: string, name: string): string | undefined {
    const row = this.db
      .query<ValueRow, [string, string]>(
        "SELECT name, value FROM user_credentials WHERE user_id = ? AND name = ?",
      )
      .get(userId, name);
    return row ? this.cipher.decrypt(row.value) : undefined;
  }

  list(userId: string): StoredCredential[] {
    return this.db
      .query<MetaRow, [string]>(
        `SELECT user_id, name, updated_at FROM user_credentials
          WHERE user_id = ? ORDER BY name`,
      )
      .all(userId)
      .map((row) => ({
        userId: row.user_id,
        name: row.name,
        updatedAt: fromIso(row.updated_at)!,
      }));
  }

  set(userId: string, name: string, value: string): void {
    // The whitelist is enforced here rather than only at the CLI/API edge,
    // because a store that accepts JIRA_BASE_URL would let one developer point
    // the whole loop at a different Jira and call it a credential.
    if (!isActorSecret(name)) {
      throw new ConfigError(
        `'${name}' is not a per-user credential. See ACTOR_SECRETS in secrets/secret-store.ts.`,
      );
    }
    if (value.trim() === "") {
      throw new ConfigError(`Refusing to store an empty value for '${name}'.`);
    }
    const now = toIso(new Date());
    this.db.run(
      `INSERT INTO user_credentials (user_id, name, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, name) DO UPDATE
         SET value = excluded.value, updated_at = excluded.updated_at`,
      [userId, name, this.cipher.encrypt(value), now, now],
    );
  }

  delete(userId: string, name: string): boolean {
    const result = this.db.run(
      "DELETE FROM user_credentials WHERE user_id = ? AND name = ?",
      [userId, name],
    );
    return result.changes > 0;
  }
}

/**
 * What runs when `TALOS_SECRET_KEY` is unset.
 *
 * The alternative — deriving a key from something always present, like the
 * database path — is worse than storing nothing: it would produce tokens that
 * *look* encrypted while being readable by anyone holding the file. So the
 * feature is off, every run falls back to the shared environment credentials
 * exactly as before, and the one thing that fails is an attempt to store a
 * credential, where an error can explain what to do about it.
 */
export class DisabledCredentialStore implements CredentialRepository {
  readonly enabled = false;

  all(): Record<string, string> {
    return {};
  }

  get(): undefined {
    return undefined;
  }

  list(): StoredCredential[] {
    return [];
  }

  set(): never {
    throw new ConfigError(
      "Per-user credentials need an encryption key. Set TALOS_SECRET_KEY in " +
        "config/.env (generate one with `openssl rand -hex 32`) and restart.",
    );
  }

  delete(): boolean {
    return false;
  }
}

interface ValueRow {
  name: string;
  value: string;
}

interface MetaRow {
  user_id: string;
  name: string;
  updated_at: string;
}
