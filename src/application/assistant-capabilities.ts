import { randomBytes } from "node:crypto";
import type { Actor } from "../core/actor.ts";

export interface AssistantCapability {
  actor: Actor;
  expiresAt: number;
  signal: AbortSignal;
}

/**
 * Short-lived authority for the Claude subprocess to call the internal MCP
 * endpoint. Tokens are random, user-bound, revoked when a chat turn ends, and
 * intentionally never persisted.
 */
export class AssistantCapabilityStore {
  private readonly entries = new Map<string, AssistantCapability>();

  issue(
    actor: Actor,
    signal: AbortSignal,
    ttlMs = 10 * 60_000,
  ): { token: string; expiresAt: number } {
    this.prune();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + ttlMs;
    this.entries.set(token, { actor, expiresAt, signal });
    return { token, expiresAt };
  }

  resolve(token: string): AssistantCapability | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now() || entry.signal.aborted) {
      this.entries.delete(token);
      return undefined;
    }
    return entry;
  }

  revoke(token: string): void {
    this.entries.delete(token);
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now || entry.signal.aborted) this.entries.delete(token);
    }
  }
}
