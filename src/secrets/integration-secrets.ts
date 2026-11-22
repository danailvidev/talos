import { ConfigError } from "../core/errors.ts";
import {
  isRedactedSecret,
  type KnownSecret,
  type PresenceSecretStore,
  KNOWN_SECRETS,
} from "./secret-store.ts";

/**
 * The instance-wide integration settings, layered over `config/.env`.
 *
 * **The stored value wins**, for the same reason `config/.env` beats an exported
 * variable (see `env-file.ts`): it is the thing an operator most recently
 * edited, and in a UI they can see. A settings page whose saved token silently
 * lost to a stale environment variable would be worse than not having one — the
 * only symptom is a 401 naming a token nobody is looking at.
 *
 * Install-originated work reads this store directly. Work attributed to a
 * developer wraps it with `actorIdentitySecretStore`, which keeps these
 * endpoint/configuration values but refuses its shared identity credentials.
 *
 * Reads go through `overrides()` on every call rather than a snapshot, and that
 * is deliberate: a token an operator has just replaced in the UI has to be the
 * one the next request uses, not the one from process start. The cost is an AES
 * decrypt per lookup, which is invisible next to the API call that follows.
 */
export class OverlaySecretStore implements PresenceSecretStore {
  constructor(
    private readonly base: PresenceSecretStore,
    /** Decrypted stored overrides, by secret name. Read live. */
    private readonly overrides: () => Record<string, string>,
  ) {}

  get(name: string): string | undefined {
    const stored = this.overrides()[name];
    if (stored != null && stored !== "") return stored;
    return this.base.get(name);
  }

  require(name: string): string {
    const value = this.get(name);
    if (value == null) {
      // Deliberately points at the settings page first: it is where whoever
      // hits this can actually fix it, without a shell on the host.
      throw new ConfigError(
        `Missing required secret '${name}'. Set it under Settings → Integrations, ` +
          "or in config/.env as an instance-wide fallback.",
      );
    }
    return value;
  }

  /**
   * Both layers, so the scrubber redacts a token stored in the UI as
   * thoroughly as one from the environment. The environment's value is included
   * even when overridden — it is still a live credential somewhere, and it
   * would be careless to start printing it in full the moment it stops being
   * the effective one.
   */
  values(): readonly string[] {
    const out = [...this.base.values()];
    for (const [name, value] of Object.entries(this.overrides())) {
      if (value !== "" && isRedactedSecret(name)) out.push(value);
    }
    return out;
  }

  presence(): Record<KnownSecret, boolean> {
    const stored = this.overrides();
    const out = { ...this.base.presence() };
    for (const name of KNOWN_SECRETS) {
      if (stored[name] != null && stored[name] !== "") out[name] = true;
    }
    return out;
  }
}
