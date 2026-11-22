import { afterEach, describe, expect, test } from "bun:test";
import {
  acquireAgentCapacity,
  activeAgentJobs,
  agentResourceLimits,
  setAgentConcurrency,
  setAgentResourceLimits,
  setInteractiveAgentReserve,
  waitingAgentJobs,
} from "../src/infrastructure/agent/capacity.ts";

afterEach(() => {
  setAgentConcurrency(2);
  setInteractiveAgentReserve(1);
  setAgentResourceLimits({ memory: "2g", cpus: 1, pids: 256 });
});

function track(promise: ReturnType<typeof acquireAgentCapacity>) {
  const state: { release?: () => void } = {};
  void promise.then((lease) => {
    state.release = () => void lease.release();
  });
  return state;
}

describe("agent capacity", () => {
  test("validates and exposes container resource limits", () => {
    setAgentResourceLimits({ memory: "768m", cpus: 0.5, pids: 128 });
    expect(agentResourceLimits()).toEqual({ memory: "768m", cpus: 0.5, pids: 128 });
    expect(() => setAgentResourceLimits({ memory: "many", cpus: 1, pids: 128 })).toThrow();
  });

  test("admits only the configured number of container jobs", async () => {
    setAgentConcurrency(1);
    const releaseFirst = await acquireAgentCapacity();
    let admitted = false;
    const second = acquireAgentCapacity().then((release) => {
      admitted = true;
      return release;
    });
    await Bun.sleep(1);
    expect(activeAgentJobs()).toBe(1);
    expect(admitted).toBe(false);
    await releaseFirst.release();
    const releaseSecond = await second;
    expect(admitted).toBe(true);
    await releaseSecond.release();
    expect(activeAgentJobs()).toBe(0);
  });

  test("removes an aborted job while it waits for capacity", async () => {
    setAgentConcurrency(1);
    const release = await acquireAgentCapacity();
    const controller = new AbortController();
    const waiting = acquireAgentCapacity({ signal: controller.signal });
    controller.abort("no longer needed");
    await expect(waiting).rejects.toBe("no longer needed");
    await release.release();
    expect(activeAgentJobs()).toBe(0);
  });

  test("keeps a reserved slot for interactive work that background work cannot take", async () => {
    setAgentConcurrency(1);
    setInteractiveAgentReserve(1);
    const background = await acquireAgentCapacity();
    const queued = track(acquireAgentCapacity());
    const chat = await acquireAgentCapacity({ priority: "interactive" });
    await Bun.sleep(1);
    expect(activeAgentJobs()).toBe(2);
    expect(queued.release).toBeUndefined();

    await chat.release();
    await Bun.sleep(1);
    expect(queued.release).toBeUndefined();
    await background.release();
    await Bun.sleep(1);
    expect(queued.release).toBeFunction();
    queued.release?.();
    expect(activeAgentJobs()).toBe(0);
  });

  test("admits interactive waiters before background waiters", async () => {
    setAgentConcurrency(1);
    setInteractiveAgentReserve(0);
    const running = await acquireAgentCapacity();
    const background = track(acquireAgentCapacity());
    const chat = track(acquireAgentCapacity({ priority: "interactive" }));
    expect(waitingAgentJobs()).toEqual({ interactive: 1, background: 1 });

    await running.release();
    await Bun.sleep(1);
    expect(chat.release).toBeFunction();
    expect(background.release).toBeUndefined();
    chat.release?.();
    await Bun.sleep(1);
    background.release?.();
    expect(activeAgentJobs()).toBe(0);
  });

  test("admits the waiting actor with the fewest running agents first", async () => {
    setAgentConcurrency(2);
    const alice = await acquireAgentCapacity({ actorId: "alice" });
    const other = await acquireAgentCapacity({ actorId: "carol" });
    const aliceAgain = track(acquireAgentCapacity({ actorId: "alice" }));
    const bob = track(acquireAgentCapacity({ actorId: "bob" }));

    await other.release();
    await Bun.sleep(1);
    expect(bob.release).toBeFunction();
    expect(aliceAgain.release).toBeUndefined();

    await alice.release();
    await Bun.sleep(1);
    expect(aliceAgain.release).toBeFunction();
    aliceAgain.release?.();
    bob.release?.();
    expect(activeAgentJobs()).toBe(0);
  });

  test("bounds interactive priority so background work cannot starve", async () => {
    setAgentConcurrency(1);
    setInteractiveAgentReserve(0);
    const running = await acquireAgentCapacity();
    const background = track(acquireAgentCapacity());
    const chats = [
      track(acquireAgentCapacity({ priority: "interactive" })),
      track(acquireAgentCapacity({ priority: "interactive" })),
      track(acquireAgentCapacity({ priority: "interactive" })),
      track(acquireAgentCapacity({ priority: "interactive" })),
    ];

    await running.release();
    for (const chat of chats.slice(0, 3)) {
      await Bun.sleep(1);
      expect(chat.release).toBeFunction();
      chat.release?.();
    }
    await Bun.sleep(1);
    expect(background.release).toBeFunction();
    expect(chats[3]?.release).toBeUndefined();
    background.release?.();
    await Bun.sleep(1);
    chats[3]?.release?.();
  });
});
