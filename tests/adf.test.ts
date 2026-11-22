import { describe, expect, test } from "bun:test";
import {
  MAX_DESCRIPTION_CHARS,
  adfMediaFilenames,
  adfToMarkdown,
  adfToText,
  bulletList,
  codeBlock,
  doc,
  fitDocument,
  heading,
  linkParagraph,
  paragraph,
  rule,
  type AdfNode,
} from "../src/connectors/jira/adf.ts";

describe("doc", () => {
  test("wraps content in a versioned document", () => {
    const document = doc(paragraph("hi"));
    expect(document.type).toBe("doc");
    expect(document.version).toBe(1);
    expect(document.content).toHaveLength(1);
  });

  test("drops null nodes, so callers can inline conditionals", () => {
    const document = doc(paragraph("a"), null, undefined, paragraph("b"));
    expect(document.content).toHaveLength(2);
  });
});

describe("paragraph", () => {
  test("holds a single text node", () => {
    expect(paragraph("hello")).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "hello" }],
    });
  });

  test("carries no content when empty — an empty text node is a 400", () => {
    expect(paragraph("")).toEqual({ type: "paragraph" });
  });
});

describe("codeBlock", () => {
  test("normalises CRLF and strips trailing whitespace", () => {
    const block = codeBlock("line one\r\nline two\n\n  ");
    expect(block.content?.[0]?.text).toBe("line one\nline two");
  });

  test("keeps the characters that make escaping a problem elsewhere", () => {
    // ● and › are ordinary Jest output; a code block needs no escaping for them.
    const text = "● Component › renders\n  expect(a).toBe(b)";
    expect(codeBlock(text).content?.[0]?.text).toBe(text);
  });

  test("sets a language only when one is given", () => {
    expect(codeBlock("x", "text").attrs).toEqual({ language: "text" });
    expect(codeBlock("x").attrs).toEqual({});
  });

  test("emits no content for an empty block", () => {
    expect(codeBlock("   \n ").content).toBeUndefined();
  });
});

describe("bulletList", () => {
  test("wraps each item in a listItem paragraph", () => {
    const list = bulletList(["one", "two"]);
    expect(list.content).toHaveLength(2);
    expect(list.content?.[0]).toEqual({
      type: "listItem",
      content: [paragraph("one")],
    });
  });
});

describe("linkParagraph", () => {
  test("marks the text as a link with an href", () => {
    const node = linkParagraph("Pipeline #7", "https://gitlab.test/p/7");
    expect(node.content?.[0]?.marks).toEqual([
      { type: "link", attrs: { href: "https://gitlab.test/p/7" } },
    ]);
  });
});

describe("heading and rule", () => {
  test("default to level 3 and carry the level in attrs", () => {
    expect(heading("Failing tests").attrs).toEqual({ level: 3 });
    expect(heading("Details", 4).attrs).toEqual({ level: 4 });
    expect(rule()).toEqual({ type: "rule" });
  });
});

describe("adfToMarkdown", () => {
  test("keeps marked boundary whitespace outside Markdown delimiters", () => {
    const document = doc({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Current behavior: ",
          marks: [{ type: "strong" }],
        },
        {
          type: "text",
          text: "\u00a0",
          marks: [{ type: "strong" }],
        },
        { type: "text", text: "Details" },
      ],
    });

    expect(adfToMarkdown(document)).toBe("**Current behavior:** \u00a0Details");
  });

  test("keeps standalone Jira Smart Links visible as previewable cards", () => {
    const url =
      "https://example.atlassian.net/wiki/x/AoBLfQ?xpis=smart-link";
    const document = doc(
      { type: "blockCard", attrs: { url } },
      { type: "embedCard", attrs: { url: "https://example.com/spec" } },
    );

    expect(adfToMarkdown(document)).toBe(
      `[Confluence page](<${url}> "talos-smart-link")\n\n` +
        `[example.com](<https://example.com/spec> "talos-smart-link")`,
    );
  });

  test("uses embedded Smart Link metadata when Jira supplies it", () => {
    const document = doc({
      type: "blockCard",
      attrs: {
        data: {
          name: "Checkout requirements",
          url: "https://example.atlassian.net/wiki/spaces/ENG/pages/42",
        },
      },
    });

    expect(adfToMarkdown(document)).toBe(
      "[Checkout requirements](<https://example.atlassian.net/wiki/spaces/ENG/pages/42> \"talos-smart-link\")",
    );
  });

  test("keeps Smart Link URLs in the plain-text agent view", () => {
    const url = "https://example.atlassian.net/wiki/x/AoBLfQ";
    const document = doc({ type: "blockCard", attrs: { url } });

    expect(adfToText(document)).toBe(url);
  });

  test("keeps Jira media at its document position for client-side attachment matching", () => {
    const document = doc(
      paragraph("Before"),
      {
        type: "mediaSingle",
        content: [
          {
            type: "media",
            attrs: { type: "file", alt: "screenshot.png", id: "media-uuid" },
          },
        ],
      },
      paragraph("After"),
    );

    expect(adfToMarkdown(document)).toBe(
      'Before\n\n[screenshot.png](<#talos-attachment> "talos-attachment")\n\nAfter',
    );
    expect(adfMediaFilenames(document)).toEqual(["screenshot.png"]);
  });

  test("preserves Jira's failed emoji as a semantic UI marker", () => {
    const document = doc({
      type: "paragraph",
      content: [
        {
          type: "emoji",
          attrs: { shortName: ":x:", id: "274c", text: "❌" },
        },
        { type: "text", text: " Test failed" },
      ],
    });

    expect(adfToMarkdown(document)).toBe(
      '[❌](<#talos-failure> "talos-failure") Test failed',
    );
    expect(adfToText(document)).toBe("❌ Test failed");
  });
});

describe("fitDocument", () => {
  test("returns a document that already fits, unchanged", () => {
    const document = doc(paragraph("short"));
    expect(fitDocument(document)).toBe(document);
  });

  test("drops whole nodes from the end and says so", () => {
    const big = (label: string): AdfNode => codeBlock(`${label} ${"x".repeat(400)}`);
    const document = doc(paragraph("summary"), big("a"), big("b"), big("c"));

    const fitted = fitDocument(document, 1200);
    const json = JSON.stringify(fitted);

    expect(json.length).toBeLessThanOrEqual(1200);
    // The head is what is worth reading, so it is what survives.
    expect(json).toContain("summary");
    expect(json).toContain("a xxx");
    expect(json).not.toContain("c xxx");
    expect(json).toContain("truncated");
  });

  test("never cuts inside a node, so the result is renderable ADF", () => {
    const document = doc(...Array.from({ length: 40 }, (_, i) => codeBlock("y".repeat(200) + i)));
    const fitted = fitDocument(document, 2000);

    // Every surviving code block still holds its complete text: a mid-node cut
    // would produce valid JSON that Jira renders wrongly.
    for (const node of fitted.content) {
      if (node.type !== "codeBlock") continue;
      expect(node.content?.[0]?.text).toMatch(/^y{200}\d+$/);
    }
  });

  test("keeps the truncation notice even when nothing else fits", () => {
    const fitted = fitDocument(doc(codeBlock("z".repeat(5000))), 200);
    expect(fitted.content).toHaveLength(1);
    expect(fitted.content[0]?.content?.[0]?.text).toContain("truncated");
  });

  test("defaults to a limit below Jira's own", () => {
    // Jira rejects around 32,767; the margin absorbs the fields around it.
    expect(MAX_DESCRIPTION_CHARS).toBeLessThan(32_767);
  });
});
