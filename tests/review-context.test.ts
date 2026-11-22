import { describe, expect, test } from "bun:test";
import {
  MAX_REVIEW_DIFF_BYTES,
  reviewContextFiles,
} from "../src/tasks/code-review/context.ts";

describe("reviewContextFiles", () => {
  test("lists every MR commit and changed path, not only HEAD", () => {
    const files = reviewContextFiles({
      commits: [
        { id: "aaa111", short_id: "aaa111", title: "fix(tp): TP-3012 refresh raised-hand" },
        { id: "bbb222", short_id: "bbb222", title: "fix(tp): TP-3012 follow-up" },
        { id: "ccc333", short_id: "ccc333", title: "fix(tp): TP-3012 tests" },
      ],
      diffs: [
        {
          old_path: "src/report.ts",
          new_path: "src/report.ts",
          diff: "@@ -1 +1 @@\n-old\n+new\n",
        },
        {
          old_path: "src/report.test.ts",
          new_path: "src/report.test.ts",
          new_file: true,
          diff: "@@ -0,0 +1 @@\n+test\n",
        },
      ],
    });

    expect(files["mr-commits.txt"]).toContain("aaa111 fix(tp): TP-3012 refresh raised-hand");
    expect(files["mr-commits.txt"]).toContain("ccc333");
    expect(files["changed-files.txt"]).toBe("src/report.test.ts\nsrc/report.ts\n");
    expect(files["mr.diff"]).toContain("src/report.ts");
    expect(files["mr.diff"]).toContain("+new");
    expect(files["mr-diff-stat.txt"]).toContain("2 file(s)");
    expect(files["mr-diff-stat.txt"]).toContain("3 commit(s)");
  });

  test("omits hunks that would exceed the byte cap but keeps the path list", () => {
    const files = reviewContextFiles({
      commits: [{ id: "1", title: "wip" }],
      diffs: [
        { old_path: "a.ts", new_path: "a.ts", diff: "x".repeat(MAX_REVIEW_DIFF_BYTES) },
        { old_path: "b.ts", new_path: "b.ts", diff: "+tiny\n" },
      ],
    });
    expect(files["changed-files.txt"]).toBe("a.ts\nb.ts\n");
    expect(files["mr.diff"]).toContain("omitted");
    expect(files["mr.diff"]).toContain("b.ts");
    expect(files["mr.diff"]).not.toContain("diff --git a/a.ts");
  });
});
