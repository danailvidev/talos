import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { ConfigError } from "../core/errors.ts";

/**
 * Encryption for credentials that have to live in the database.
 *
 * Per-developer tokens cannot be environment variables — there are fifteen of
 * them and they change independently — so they go in SQLite. A GitLab token in
 * plaintext next to the loop that uses it turns "someone copied the database
 * file" into "someone has push access to every repository", so the values are
 * encrypted with a key that lives only in the environment. The database alone is
 * then useless; both halves are needed.
 *
 * AES-256-GCM specifically, for the authentication tag: without it a corrupted
 * or tampered ciphertext decrypts to garbage that would be sent to GitLab as a
 * token and come back as an inscrutable 401. With it, tampering fails here,
 * where the error can say so.
 */
export interface Cipher {
  encrypt(plaintext: string): string;
  /** Throws ConfigError when the key is wrong or the value was tampered with. */
  decrypt(token: string): string;
}

/**
 * Version prefix on every stored value. Version 2 uses the Talos salt; version
 * 1 remains readable so rebranding an existing install does not invalidate its
 * encrypted credentials.
 */
const VERSION = "v2";
const LEGACY_VERSION = "v1";

/**
 * Fixed rather than per-row, and deliberately so.
 *
 * A per-row salt would mean a scrypt derivation per credential read — tens of
 * milliseconds each, on the hot path of every run — for a threat this does not
 * face: the salt defends against precomputed tables across *many* databases,
 * and there is one key here, not a password per user. The random IV per value is
 * what stops two identical tokens producing identical ciphertext.
 */
const SALT = Buffer.from("talos-credentials-v2");
// Encoded to keep the retired product name out of current source and logs.
const LEGACY_SALT = Buffer.from("YXV0b21lc2gtY3JlZGVudGlhbHMtdjE=", "base64");

const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Rejects a key short enough to brute-force, since nothing else will. */
const MIN_KEY_LENGTH = 16;

export function createCipher(masterKey: string): Cipher {
  if (masterKey.length < MIN_KEY_LENGTH) {
    throw new ConfigError(
      `TALOS_SECRET_KEY must be at least ${MIN_KEY_LENGTH} characters; ` +
        "generate one with `openssl rand -hex 32`.",
    );
  }
  // Derived once per process. scryptSync is intentionally slow, which is right
  // for a key derivation and wrong for a per-call one.
  const key = scryptSync(masterKey, SALT, KEY_BYTES);
  let legacyKey: ReturnType<typeof scryptSync> | undefined;

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      return [
        VERSION,
        iv.toString("base64"),
        cipher.getAuthTag().toString("base64"),
        ciphertext.toString("base64"),
      ].join(":");
    },

    decrypt(token: string): string {
      const parts = token.split(":");
      if (
        parts.length !== 4 ||
        (parts[0] !== VERSION && parts[0] !== LEGACY_VERSION)
      ) {
        throw new ConfigError("Stored credential is not in a format this version can read.");
      }
      const [version, iv, tag, ciphertext] = parts as [string, string, string, string];
      try {
        if (version === LEGACY_VERSION) {
          legacyKey ??= scryptSync(masterKey, LEGACY_SALT, KEY_BYTES);
        }
        const decipher = createDecipheriv(
          "aes-256-gcm",
          version === VERSION ? key : legacyKey!,
          Buffer.from(iv, "base64"),
        );
        decipher.setAuthTag(Buffer.from(tag, "base64"));
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertext, "base64")),
          decipher.final(),
        ]).toString("utf8");
      } catch (cause) {
        // Overwhelmingly the first cause: TALOS_SECRET_KEY changed, and every
        // stored credential is now unreadable. Say that, rather than letting a
        // GCM tag mismatch surface as a mystery.
        throw new ConfigError(
          "Could not decrypt a stored credential. TALOS_SECRET_KEY has most " +
            "likely changed since it was saved; the credential has to be set again.",
          { cause },
        );
      }
    },
  };
}
