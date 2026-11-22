import { describe, expect, test } from "bun:test";
import { fixIssueMergeRequestTitle } from "../src/tasks/fix-jira-issue/title.ts";

describe("fixIssueMergeRequestTitle", () => {
  test("adds the semantic-release prefix to an agent title that only starts with the ticket", () => {
    expect(
      fixIssueMergeRequestTitle(
        "TD-1826",
        "TD-1826 Unit test failure: geogebra-expandable.component.spec.ts — GeogebraExpandableComponent › should render the title and an asset-scoped qa attribute on the toggle button (+3 more)",
        "Unit test failure",
      ),
    ).toBe(
      "fix: TD-1826 Unit test failure: geogebra-expandable.component.spec.ts — GeogebraExpandableComponent › should render the title and an asset-scoped qa attribute on the toggle button (+3 more)",
    );
  });

  test("preserves an allowed change type while normalizing scope and ticket placement", () => {
    expect(
      fixIssueMergeRequestTitle(
        "TD-1826",
        "feat(component): render an asset-scoped QA attribute",
        "Render an asset-scoped QA attribute",
      ),
    ).toBe("feat: TD-1826 render an asset-scoped QA attribute");
  });

  test("replaces unsupported conventional types with fix", () => {
    expect(
      fixIssueMergeRequestTitle(
        "TD-1826",
        "test: TD-1826 cover the expandable toggle",
        "Cover the expandable toggle",
      ),
    ).toBe("fix: TD-1826 cover the expandable toggle");
  });

  test("uses the Jira summary when the agent omits a title", () => {
    expect(
      fixIssueMergeRequestTitle("TD-1826", undefined, "Unit test failure"),
    ).toBe("fix: TD-1826 Unit test failure");
  });
});
