import { describe, expect, test } from "bun:test";

import { filterTalosUsers } from "../src/TalosAssigneeSelect.tsx";

const users = [
  { id: "alice-id", name: "Alice Baker", email: "alice@example.com" },
  { id: "bob-id", name: "Bob Carter", email: "bob@example.com" },
];

describe("Talos assignee search", () => {
  test("matches names, emails, and stable Talos ids case-insensitively", () => {
    expect(filterTalosUsers(users, "BAKER").map((user) => user.id)).toEqual([
      "alice-id",
    ]);
    expect(filterTalosUsers(users, "bob@").map((user) => user.id)).toEqual([
      "bob-id",
    ]);
    expect(filterTalosUsers(users, "alice-id").map((user) => user.id)).toEqual([
      "alice-id",
    ]);
  });

  test("returns every Talos user for an empty search", () => {
    expect(filterTalosUsers(users, "  ")).toEqual(users);
  });
});
