import type { Database } from "bun:sqlite";

import type {
  AgentAccountCredential,
  AgentAccountRepository,
  StoredAgentAccount,
} from "../application/ports.ts";
import { ConfigError } from "../core/errors.ts";
import type { Cipher } from "../secrets/crypto.ts";
import { fromIso, toIso } from "./database.ts";
import { newId } from "./id.ts";

interface Row {
  id: string;
  user_id: string;
  provider: string;
  label: string;
  method: string;
  option_id: string;
  env_name: string | null;
  secret: string | null;
  home_dir: string | null;
  account: string | null;
  use_for_runs: number;
  created_at: string;
  updated_at: string;
}

/**
 * The agent accounts one developer has connected — see migration 47 for the two
 * shapes this table holds and `infrastructure/agent/catalog.ts` for why there are
 * only two.
 *
 * Decrypted on read rather than cached, for the reason `SqliteCredentialStore`
 * gives: an account disconnected in the UI has to stop working on the next run.
 *
 * The store works without a cipher, unlike the credential store, and that is not
 * an inconsistency: the `cli` accounts hold no secret at all — the vendor's CLI
 * kept the credential in its own directory — so they are storable either way.
 * Only `secret` needs the key, and `save` refuses that one rather than writing a
 * token in plaintext.
 */
export class SqliteAgentAccountStore implements AgentAccountRepository {
  constructor(
    private readonly db: Database,
    private readonly cipher: Cipher | null,
  ) {}

  get secretsEnabled(): boolean {
    return this.cipher != null;
  }

  list(userId: string): StoredAgentAccount[] {
    return this.db
      .query<Row, [string]>(
        `SELECT * FROM agent_accounts WHERE user_id = ? ORDER BY provider, label`,
      )
      .all(userId)
      .map((row) => this.toAccount(row));
  }

  get(userId: string, id: string): StoredAgentAccount | undefined {
    const row = this.db
      .query<Row, [string, string]>(`SELECT * FROM agent_accounts WHERE user_id = ? AND id = ?`)
      .get(userId, id);
    return row ? this.toAccount(row) : undefined;
  }

  credential(userId: string, id: string): AgentAccountCredential | undefined {
    const row = this.db
      .query<Row, [string, string]>(`SELECT * FROM agent_accounts WHERE user_id = ? AND id = ?`)
      .get(userId, id);
    if (!row) return undefined;
    // An undecryptable secret throws rather than yielding `{}`: an empty
    // environment would silently run the agent unauthenticated, or worse, on
    // whatever the host's own environment happens to hold. `list` reports the same
    // row as `unreadable` so the UI can say what to do about it first.
    const env = row.secret ? this.decryptEnv(row) : {};
    return { env, ...(row.home_dir ? { homeDir: row.home_dir } : {}) };
  }

  save(account: {
    userId: string;
    provider: string;
    label: string;
    method: "key" | "cli";
    optionId: string;
    values?: Record<string, string>;
    homeDir?: string;
    account?: string;
  }): StoredAgentAccount {
    const label = account.label.trim();
    if (!label) throw new ConfigError("An account name is required.");
    // Trimmed here and not only in the add dialog: these values become `docker -e`
    // arguments verbatim, and a provider that validates the *shape* of a key rejects
    // one with a leading space for a reason no error message explains ("Invalid API
    // Key format: Must start with pre-defined prefix"). Whitespace around a pasted
    // credential is never meaningful, and the API accepts saves the dialog never sent.
    const values = account.values
      ? Object.fromEntries(
          Object.entries(account.values).map(([name, value]) => [name, value.trim()]),
        )
      : undefined;
    if (values) {
      for (const [name, value] of Object.entries(values)) {
        if (!value) throw new ConfigError(`${name} cannot be empty.`);
      }
      if (Object.keys(values).length === 0) {
        throw new ConfigError("The credential cannot be empty.");
      }
    }
    // The whole set as one blob rather than a row per variable: they are filled
    // in together, used together and revoked together, and a half-decryptable
    // Bedrock account is not a state worth being able to represent.
    const secret = values ? JSON.stringify(values) : undefined;
    if (secret && !this.cipher) {
      throw new ConfigError(
        "Storing an agent credential needs an encryption key. Set TALOS_SECRET_KEY in " +
          "config/.env (generate one with `openssl rand -hex 32`) and restart. Connecting " +
          "through the vendor's own login works without it — that credential stays with the " +
          "vendor.",
      );
    }
    if (account.method === "key" && !secret) {
      throw new ConfigError(`Option '${account.optionId}' has no environment variable to set.`);
    }

    const now = toIso(new Date());
    // Upsert on (user_id, provider, label) so re-adding an account under a name
    // that already exists reconnects it instead of failing on the unique index --
    // which is what "my token expired, here is a new one" should do. `id` is only
    // used when the row is new; the conflict path keeps the existing one so links
    // to it stay valid.
    const row = this.db
      .query<Row, [string, string, string, string, string, string, string | null, string | null,
        string | null, string | null, string, string]>(
        `INSERT INTO agent_accounts
           (id, user_id, provider, label, method, option_id, env_name, secret, home_dir,
            account, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, provider, label) DO UPDATE SET
           method     = excluded.method,
           option_id  = excluded.option_id,
           env_name   = excluded.env_name,
           -- Only when this save carried one, so re-labelling or re-detecting the
           -- account does not wipe a credential that is still good.
           secret     = COALESCE(excluded.secret, agent_accounts.secret),
           home_dir   = COALESCE(excluded.home_dir, agent_accounts.home_dir),
           account    = COALESCE(excluded.account, agent_accounts.account),
           updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get(
        newId(),
        account.userId,
        account.provider,
        label,
        account.method,
        account.optionId,
        // The names in the clear beside the encrypted values, so listing which
        // variables an account sets does not need the key -- and still cannot
        // reach one of them. Comma-separated because a variable name cannot
        // contain a comma.
        values ? Object.keys(values).join(",") : null,
        secret ? this.cipher!.encrypt(secret) : null,
        account.homeDir ?? null,
        account.account ?? null,
        now,
        now,
      );
    if (!row) throw new ConfigError(`Could not store the '${label}' account.`);
    // The first account this developer connects for a provider becomes the one
    // their runs use, so pasting a Bedrock key is all it takes for their next run
    // to go through it. Later ones do not steal the flag: switching which of your
    // accounts is billed is a decision, not a side effect of adding a second one.
    this.promoteIfNoRuntimeAccount(account.userId, account.provider);
    return this.toAccount(this.require(row.id));
  }

  useForRuns(userId: string, id: string): StoredAgentAccount | undefined {
    const existing = this.get(userId, id);
    if (!existing) return undefined;
    if (existing.unreadable) {
      throw new ConfigError(
        `The '${existing.label}' credential cannot be decrypted, so runs would fail on it. ` +
          "Connect the account again first.",
      );
    }
    // One statement per half rather than a transaction: the flag is advisory, and
    // the worst interleaving leaves two of this developer's accounts flagged, which
    // `runtimeCredential` resolves deterministically anyway.
    this.clearRuntimeFlag(userId, existing.provider);
    this.db.run(`UPDATE agent_accounts SET use_for_runs = 1 WHERE id = ?`, [id]);
    return this.toAccount(this.require(id));
  }

  runtimeAccount(userId: string, provider: string): StoredAgentAccount | undefined {
    const row = this.runtimeRow(userId, provider);
    return row ? this.toAccount(row) : undefined;
  }

  runtimeCredential(
    userId: string,
    provider: string,
  ): (AgentAccountCredential & { id: string; label: string; optionId: string }) | undefined {
    const row = this.runtimeRow(userId, provider);
    if (!row) return undefined;
    return {
      id: row.id,
      label: row.label,
      optionId: row.option_id,
      env: row.secret ? this.decryptEnv(row) : {},
      ...(row.home_dir ? { homeDir: row.home_dir } : {}),
    };
  }

  delete(userId: string, id: string): boolean {
    const row = this.db
      .query<{ id: string; provider: string }, [string, string]>(
        `DELETE FROM agent_accounts WHERE user_id = ? AND id = ? RETURNING id, provider`,
      )
      .get(userId, id);
    if (!row) return false;
    // Disconnecting the account this developer's runs were using would otherwise
    // leave them with none active, silently dropping their runs back to the host's
    // login. Another of their accounts is promoted instead, and only a developer
    // with nothing left falls back.
    this.promoteIfNoRuntimeAccount(userId, row.provider);
    return true;
  }

  /** This developer's active row for the provider. */
  private runtimeRow(userId: string, provider: string): Row | undefined {
    return this.db
      .query<Row, [string, string]>(
        // Newest first, so two rows flagged by a race still resolve to one answer.
        `SELECT * FROM agent_accounts
          WHERE user_id = ? AND provider = ? AND use_for_runs = 1
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(userId, provider) ?? undefined;
  }

  /** Flags this developer's newest account for the provider when none is flagged. */
  private promoteIfNoRuntimeAccount(userId: string, provider: string): void {
    const flagged = this.db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM agent_accounts
          WHERE user_id = ? AND provider = ? AND use_for_runs = 1 LIMIT 1`,
      )
      .get(userId, provider);
    if (flagged) return;
    this.db.run(
      `UPDATE agent_accounts SET use_for_runs = 1
        WHERE id = (
          SELECT id FROM agent_accounts
            WHERE user_id = ? AND provider = ? ORDER BY updated_at DESC LIMIT 1
        )`,
      [userId, provider],
    );
  }

  private clearRuntimeFlag(userId: string, provider: string): void {
    this.db.run(`UPDATE agent_accounts SET use_for_runs = 0 WHERE user_id = ? AND provider = ?`, [
      userId,
      provider,
    ]);
  }

  private require(id: string): Row {
    const row = this.db
      .query<Row, [string]>(`SELECT * FROM agent_accounts WHERE id = ?`)
      .get(id);
    if (!row) throw new ConfigError("The agent account went missing while it was being saved.");
    return row;
  }

  private toAccount(row: Row): StoredAgentAccount {
    return {
      id: row.id,
      userId: row.user_id,
      provider: row.provider,
      label: row.label,
      method: row.method === "cli" ? "cli" : "key",
      optionId: row.option_id,
      ...(row.env_name ? { envNames: row.env_name.split(",") } : {}),
      ...(row.home_dir ? { homeDir: row.home_dir } : {}),
      ...(row.account ? { account: row.account } : {}),
      ...(row.secret && !this.readable(row.secret) ? { unreadable: true } : {}),
      ...(row.use_for_runs ? { usedForRuns: true } : {}),
      createdAt: fromIso(row.created_at),
      updatedAt: fromIso(row.updated_at),
    };
  }

  /** Whether the stored value can still be decrypted, without returning it. */
  private readable(secret: string): boolean {
    try {
      this.decrypt(secret);
      return true;
    } catch {
      return false;
    }
  }

  /** The stored blob as the variables it holds. */
  private decryptEnv(row: Row): Record<string, string> {
    const decrypted = this.decrypt(row.secret!);
    let parsed: unknown;
    try {
      parsed = JSON.parse(decrypted);
    } catch (cause) {
      throw new ConfigError(
        `The '${row.label}' account's credential is stored in a shape this version cannot ` +
          "read. Connect the account again.",
        { cause },
      );
    }
    const env: Record<string, string> = {};
    if (parsed && typeof parsed === "object") {
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") env[name] = value;
      }
    }
    return env;
  }

  private decrypt(secret: string): string {
    if (!this.cipher) {
      throw new ConfigError(
        "This account's credential was stored with an encryption key that is no longer set. " +
          "Restore TALOS_SECRET_KEY, or reconnect the account.",
      );
    }
    return this.cipher.decrypt(secret);
  }
}
