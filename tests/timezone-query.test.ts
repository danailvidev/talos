import { describe, expect, test } from "bun:test";
import { matchesTimezoneQuery } from "../web/src/timezones.ts";

describe("matchesTimezoneQuery", () => {
  test("matches city names ignoring spaces and underscores", () => {
    expect(matchesTimezoneQuery("America/New_York", "new york")).toBe(true);
    expect(matchesTimezoneQuery("Europe/Sofia", "sofia")).toBe(true);
    expect(matchesTimezoneQuery("Europe/Berlin", "tokyo")).toBe(false);
  });

  test("empty query matches everything", () => {
    expect(matchesTimezoneQuery("UTC", "")).toBe(true);
    expect(matchesTimezoneQuery("System default (Europe/Sofia)", "  ")).toBe(true);
  });
});
