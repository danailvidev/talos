import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown } from "../src/pr/Markdown.tsx";

describe("pull request Markdown", () => {
  test("renders GitLab system-note HTML and resolves its relative link", () => {
    const html = renderToStaticMarkup(
      <Markdown
        baseUrl="https://gitlab.example/example-org/webapp/-/merge_requests/6307"
        text={`added 1 commit

<ul><li>021bfb8a - fixes</li></ul>

[Compare with previous version](/example-org/webapp/-/merge_requests/6307/diffs?diff_id=2030145574)`}
      />,
    );

    expect(html).toContain("<ul><li>021bfb8a - fixes</li></ul>");
    expect(html).toContain(
      'href="https://gitlab.example/example-org/webapp/-/merge_requests/6307/diffs?diff_id=2030145574"',
    );
    expect(html).toContain(">Compare with previous version</a>");
  });

  test("sanitizes raw HTML from merge request authors", () => {
    const html = renderToStaticMarkup(
      <Markdown text={'<img src="x" onerror="alert(1)"><script>alert(2)</script>'} />,
    );

    expect(html).toContain('src="x"');
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert");
  });

  test("shows GitLab uploads without exposing its dimension suffix as text", () => {
    const html = renderToStaticMarkup(
      <Markdown
        baseUrl="https://gitlab.example/example-org/webapp/-/merge_requests/6307"
        prId="gitlab:example-org/webapp!6307"
        text="![image](/uploads/0123456789abcdef0123456789abcdef/screenshot.png){width=900 height=476}"
      />,
    );

    expect(html).toContain(
      'src="/api/pull-requests/gitlab%3Aexample-org%2Fwebapp!6307/assets?path=%2Fuploads%2F0123456789abcdef0123456789abcdef%2Fscreenshot.png"',
    );
    expect(html).toContain('alt="image"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('aria-label="Preview image"');
    expect(html).toContain("max-h-48");
    expect(html).toContain("max-w-80");
    expect(html).not.toContain("{width=");
  });

  test("keeps Sonar status icons inline and vertically centered", () => {
    const html = renderToStaticMarkup(
      <Markdown
        baseUrl="https://gitlab.example/acme/web/-/merge_requests/1"
        prId="gitlab:acme/web!1"
        text={"![](https://sonarsource.example/passed.svg '') [3 New issues](https://sonar.example/issues)"}
      />,
    );

    expect(html).toContain("inline-block align-middle");
    expect(html).not.toContain('aria-label="Preview image"');
  });

  test("normalizes GitLab-tolerated indented code fences", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={`The guard is:

    \`\`\`return !!this.selectedLesson && !this.selectedLesson.lessonPlanId;\`\`\`

    \`\`\`if (!this.selectedLesson?.lessonPlanId) {
      return EMPTY;
    }\`\`\`

    \`\`\`if (!this.selectedLesson?.lessonPlanId) { ... }\`\``}
      />,
    );

    expect(html).toContain("<pre><code>return !!this.selectedLesson");
    expect(html).toContain("<pre><code>if (!this.selectedLesson?.lessonPlanId) {");
    expect(html).toContain("  return EMPTY;");
    expect(html).not.toContain("```");
  });
});
