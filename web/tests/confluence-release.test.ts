import { describe, expect, test } from "bun:test";
import {
  applyConfluenceRelease,
  isProdEnvironment,
} from "../src/confluence-release.ts";

describe("Confluence releases", () => {
  test("recognises only the exact prod environment", () => {
    expect(isProdEnvironment("prod")).toBe(true);
    expect(isProdEnvironment("PROD")).toBe(true);
    expect(isProdEnvironment(" prod ")).toBe(true);
    expect(isProdEnvironment("prod-us")).toBe(false);
    expect(isProdEnvironment("production")).toBe(false);
  });

  test("applies concrete suggestions case-insensitively and leaves unchanged services alone", () => {
    const environment = {
      name: "dev",
      services: [
        { name: "StaffPortal", version: "1.0", section: "applications" as const },
        { name: "bookstore", version: "2.4.35", section: "services" as const },
        { name: "communication", version: "3.5.88", section: "services" as const },
      ],
    };
    const result = applyConfluenceRelease(
      environment,
      {
        "applications:StaffPortal": "1.0",
        "services:bookstore": "2.4.35",
        "services:communication": "3.5.88",
      },
      {
        title: "4.2.142-a Sept 11 Hotfix Release",
        suggestions: [
          { service: "web", version: "1.1" },
          { service: "bookstore", version: "2.4.44" },
          { service: "communication", version: "unchanged" },
          { service: "not-in-manifest", version: "9.0" },
        ],
      },
    );

    expect(result).toEqual({
      versions: {
        "applications:StaffPortal": "1.1",
        "services:bookstore": "2.4.44",
        "services:communication": "3.5.88",
      },
      applied: 2,
      changed: 2,
      missing: ["not-in-manifest"],
    });
  });
});
