import { describe, expect, test } from "bun:test";

import { AssistantCapabilityStore } from "../src/application/assistant-capabilities.ts";

const actor = { id: "u1", name: "One", email: "one@example.com" };

describe("assistant capabilities", () => {
  test("binds a random token to one actor and revokes it", () => {
    const store = new AssistantCapabilityStore();
    const abort = new AbortController();
    const first = store.issue(actor, abort.signal);
    const second = store.issue(actor, abort.signal);

    expect(first.token).not.toBe(second.token);
    expect(store.resolve(first.token)?.actor).toEqual(actor);
    store.revoke(first.token);
    expect(store.resolve(first.token)).toBeUndefined();
    expect(store.resolve(second.token)?.actor.id).toBe(actor.id);
  });

  test("rejects expired and aborted capabilities", () => {
    const store = new AssistantCapabilityStore();
    const live = new AbortController();
    const expired = store.issue(actor, live.signal, -1);
    expect(store.resolve(expired.token)).toBeUndefined();

    const cancelled = new AbortController();
    const issued = store.issue(actor, cancelled.signal);
    cancelled.abort();
    expect(store.resolve(issued.token)).toBeUndefined();
  });
});
