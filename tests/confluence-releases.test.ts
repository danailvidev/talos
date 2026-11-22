import { describe, expect, test } from "bun:test";
import {
  parseConfluenceReleaseLinks,
  parseConfluenceReleases,
  parseConfluenceReleaseSuggestions,
} from "../src/application/confluence-releases.ts";

const text = (value: string) => ({ type: "text", text: value });
const paragraph = (value: string) => ({ type: "paragraph", content: [text(value)] });
const cell = (value: string, type = "tableCell") => ({
  type,
  content: [paragraph(value)],
});
const row = (values: string[], type = "tableCell") => ({
  type: "tableRow",
  content: values.map((value) => cell(value, type)),
});
const table = (rows: ReturnType<typeof row>[]) => ({ type: "table", content: rows });

describe("parseConfluenceReleases", () => {
  test("reads concrete Suggested values and ignores unchanged or blank rows", () => {
    const document = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [text("4.2.142-a Sept 11 Hotfix Release")] },
        table([
          row(["version", "Prod", "Suggested", "Tickets"], "tableHeader"),
          row(["web", "3.365.0-prod-091126.6", "3.365.0-prod-091126.10", "PP-2124"]),
          row(["parentportal2", "3.365.0-prod-091126.1", " unchanged ", ""]),
          row(["bookstore", "2.4.35", "2.4.44", "PP-2135"]),
          row(["Reports", "", "", ""]),
        ]),
      ],
    };

    expect(parseConfluenceReleases(document)).toEqual([
      {
        title: "4.2.142-a Sept 11 Hotfix Release",
        suggestions: [
          { service: "web", version: "3.365.0-prod-091126.10" },
          { service: "bookstore", version: "2.4.44" },
        ],
      },
    ]);
  });

  test("uses an expand title and combines multiple Suggested tables", () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "expand",
          attrs: { title: "4.3.0 October Release" },
          content: [
            table([
              row(["version", "Prod", "Suggested"], "tableHeader"),
              row(["studentportal2", "1.0", "1.1"]),
            ]),
            table([
              row(["Component", "Production", "Suggested"], "tableHeader"),
              row(["CMS", "4.2", "4.3"]),
            ]),
          ],
        },
      ],
    };

    expect(parseConfluenceReleases(document)).toEqual([
      {
        title: "4.3.0 October Release",
        suggestions: [
          { service: "studentportal2", version: "1.1" },
          { service: "CMS", version: "4.3" },
        ],
      },
    ]);
  });

  test("keeps columns aligned below a row-spanning group cell", () => {
    const document = {
      type: "doc",
      content: [
        { type: "heading", content: [text("Grouped release")] },
        {
          type: "table",
          content: [
            row(["", "", "Prod", "Suggested", "Tickets"], "tableHeader"),
            {
              type: "tableRow",
              content: [
                { ...cell("version"), attrs: { rowspan: 3 } },
                cell("web"),
                cell("1.0"),
                cell("1.1"),
                cell("PP-1"),
              ],
            },
            row(["bookstore", "2.0", "unchanged", ""]),
            row(["communication", "3.0", "3.1", "OP-2"]),
          ],
        },
      ],
    };

    expect(parseConfluenceReleases(document)[0]?.suggestions).toEqual([
      { service: "web", version: "1.1" },
      { service: "communication", version: "3.1" },
    ]);
  });

  test("ignores unrelated tables without a Suggested column", () => {
    expect(
      parseConfluenceReleases({
        type: "doc",
        content: [
          { type: "heading", content: [text("Notes")] },
          table([row(["Owner", "Date"], "tableHeader"), row(["QA", "Friday"])]),
        ],
      }),
    ).toEqual([]);
  });
});

describe("parseConfluenceReleaseLinks", () => {
  test("reads linked text and smart-link cards from the release index", () => {
    expect(
      parseConfluenceReleaseLinks({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "4.2.142-a Sept 11 Hotfix Release",
                marks: [
                  {
                    type: "link",
                    attrs: {
                      href: "https://jira.test/wiki/spaces/QA/pages/40001/Hotfix",
                    },
                  },
                ],
              },
            ],
          },
          {
            type: "inlineCard",
            attrs: {
              url: "https://jira.test/wiki/spaces/QA/pages/40002/4.2.143+September+Release",
            },
          },
        ],
      }),
    ).toEqual([
      {
        title: "4.2.142-a Sept 11 Hotfix Release",
        url: "https://jira.test/wiki/spaces/QA/pages/40001/Hotfix",
      },
      {
        title: "4.2.143 September Release",
        url: "https://jira.test/wiki/spaces/QA/pages/40002/4.2.143+September+Release",
      },
    ]);
  });
});

test("parseConfluenceReleaseSuggestions does not require a heading on a detail page", () => {
  expect(
    parseConfluenceReleaseSuggestions({
      type: "doc",
      content: [
        table([
          row(["Service", "Prod", "Suggested"], "tableHeader"),
          row(["bookstore", "2.4.35", "2.4.44"]),
        ]),
      ],
    }),
  ).toEqual([{ service: "bookstore", version: "2.4.44" }]);
});
