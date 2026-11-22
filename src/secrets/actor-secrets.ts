import type { Actor } from "../core/actor.ts";
import { ConfigError } from "../core/errors.ts";
import {
  isActorSecret,
  isRedactedSecret,
  type SecretStore,
} from "./secret-store.ts";

/**
 * A developer's provider identity without any shared identity fallback.
 *
 * Non-identity configuration still comes from the instance (GitLab API URL,
 * Jira site/board, team roster). Only ACTOR_SECRETS are isolated, so a person
 * with no token gets a "not connected" result instead of seeing data as the
 * account behind the instance-wide token.
 */
export function actorIdentitySecretStore(
  base: SecretStore,
  actor: Actor,
  credentials: Record<string, string>,
): SecretStore {
  const own = new Map(Object.entries(credentials));

  const read = (name: string): string | undefined => {
    const mine = own.get(name);
    if (mine != null) return mine;
    return isActorSecret(name) ? undefined : base.get(name);
  };

  return {
    get: read,

    require(name: string): string {
      const value = read(name);
      if (value == null) {
        throw new ConfigError(
          `Missing required secret '${name}' for ${actor.email}. Store it in Provider ` +
            "access in the web UI.",
        );
      }
      return value;
    },

    /**
     * Both layers. The actor's tokens are the ones most worth scrubbing — they
     * belong to a person rather than to a service account — and a scrubber seeded
     * only from the environment would print them in full.
     */
    values(): readonly string[] {
      const out = [...base.values()];
      for (const [name, value] of own) {
        if (isRedactedSecret(name)) out.push(value);
      }
      return out;
    },
  };
}
