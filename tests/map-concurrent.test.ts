import { describe, expect, test } from "bun:test";
import { mapConcurrent } from "../src/core/map-concurrent.ts";

describe("mapConcurrent", () => {
  test("bounds active work and preserves input order", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapConcurrent([4, 3, 2, 1], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(value);
      active -= 1;
      return value * 2;
    });
    expect(peak).toBe(2);
    expect(result).toEqual([8, 6, 4, 2]);
  });

  test("does not start more work after cancellation", async () => {
    const controller = new AbortController();
    let started = 0;
    const result = mapConcurrent([1, 2, 3], 1, async (value) => {
      started += 1;
      if (value === 1) controller.abort("stop");
      return value;
    }, controller.signal);
    await expect(result).rejects.toBe("stop");
    expect(started).toBe(1);
  });
});
