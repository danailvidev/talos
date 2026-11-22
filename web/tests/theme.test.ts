import { describe, expect, test } from "bun:test";

import {
  appearanceFromCache,
  parseAppearance,
  resolveAppearance,
} from "../src/theme.ts";

describe("theme preference", () => {
  test("accepts supported appearances and defaults invalid values to dark", () => {
    expect(parseAppearance("system")).toBe("system");
    expect(parseAppearance("light")).toBe("light");
    expect(parseAppearance("dark")).toBe("dark");
    expect(parseAppearance("sepia")).toBe("dark");
    expect(parseAppearance(null)).toBe("dark");
  });

  test("resolves system appearance while preserving explicit choices", () => {
    expect(resolveAppearance("system", true)).toBe("light");
    expect(resolveAppearance("system", false)).toBe("dark");
    expect(resolveAppearance("light", false)).toBe("light");
    expect(resolveAppearance("dark", true)).toBe("dark");
  });

  test("reads the shared preference cache safely", () => {
    expect(appearanceFromCache('{"theme.appearance":"light"}')).toBe("light");
    expect(appearanceFromCache('{"theme.appearance":"unknown"}')).toBe("dark");
    expect(appearanceFromCache("[]")).toBe("dark");
    expect(appearanceFromCache("{broken")).toBe("dark");
    expect(appearanceFromCache(null)).toBe("dark");
  });
});
