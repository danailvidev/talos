import { describe, expect, test } from "bun:test";
import { TtlCache } from "../src/core/ttl-cache.ts";

describe("TtlCache", () => {
  test("keeps a slow pending load coalesced after its normal TTL", async () => {
    let now = 0;
    let calls = 0;
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const cache = new TtlCache({ now: () => now });
    const load = () => {
      calls += 1;
      return pending;
    };

    const first = cache.fetch("key", 100, load);
    now = 101;
    const second = cache.fetch("key", 100, load);

    expect(calls).toBe(1);
    expect(cache.stats.coalesced).toBe(1);
    resolve("value");
    await expect(first).resolves.toBe("value");
    await expect(second).resolves.toBe("value");

    now = 200;
    await expect(cache.fetch("key", 100, load)).resolves.toBe("value");
    expect(calls).toBe(1);
  });

  test("rejects distinct overload without evicting pending single flights", async () => {
    let resolve!: (value: string) => void;
    const cache = new TtlCache({ max: 2, maxPending: 1 });
    const first = cache.fetch("one", 100, () => new Promise<string>((done) => { resolve = done; }));
    await expect(cache.fetch("two", 100, async () => "two")).rejects.toThrow("pending-load capacity");
    expect(cache.has("one")).toBe(true);
    expect(cache.stats).toMatchObject({ pending: 1, rejected: 1 });
    resolve("one");
    await first;
  });

  test("evicts settled values when their estimated byte budget is exceeded", async () => {
    const cache = new TtlCache({ max: 10, maxBytes: 5, sizeOf: (value) => String(value).length });
    await cache.fetch("one", 1_000, async () => "1234");
    await cache.fetch("two", 1_000, async () => "5678");
    await Bun.sleep(0);
    expect(cache.stats.bytes).toBeLessThanOrEqual(5);
    expect(cache.stats.evictions).toBeGreaterThan(0);
  });

  test("coalesces repeated refreshes into one follow-up load", async () => {
    const cache = new TtlCache();
    const resolvers: Array<(value: string) => void> = [];
    let calls = 0;
    const load = () => {
      calls += 1;
      return new Promise<string>((resolve) => resolvers.push(resolve));
    };
    const initial = cache.fetch("key", 1_000, load);
    const firstRefresh = cache.refresh("key", 1_000, load);
    const secondRefresh = cache.refresh("key", 1_000, load);
    expect(calls).toBe(1);
    resolvers.shift()!("old");
    await initial;
    await Bun.sleep(0);
    expect(calls).toBe(2);
    resolvers.shift()!("fresh");
    await expect(firstRefresh).resolves.toBe("fresh");
    await expect(secondRefresh).resolves.toBe("fresh");
    expect(calls).toBe(2);
  });
});
