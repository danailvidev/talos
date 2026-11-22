import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "bun:test";

import { TicketDetailService } from "../src/application/ticket-detail.ts";
import { doc, paragraph } from "../src/connectors/jira/adf.ts";
import { createLogger } from "../src/logging/logger.ts";
import { EnvSecretStore } from "../src/secrets/secret-store.ts";
import { FakeHttp } from "./fixtures/http.ts";
import { JIRA_FIELDS } from "./fixtures/jira.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("TicketDetailService", () => {
  test("shows a parent description when a child has none of its own", async () => {
    const requirementUrl = "https://jira.test/wiki/x/AoBLfQ";
    const http = new FakeHttp([
      { match: "/rest/api/3/field", respond: { json: JIRA_FIELDS } },
      {
        match: "/rest/api/3/issue/TP-3068",
        respond: {
          json: {
            id: "3068",
            key: "TP-3068",
            fields: {
              summary: "Design spike",
              description: null,
              parent: {
                key: "TP-2793",
                fields: { summary: "Edit Mode in Summary Table" },
              },
            },
          },
        },
      },
      {
        match: "/rest/api/3/issue/TP-3068/comment",
        respond: { json: { comments: [], total: 0 } },
      },
      {
        match: "/rest/api/3/issue/TP-2793",
        respond: {
          json: {
            id: "2793",
            key: "TP-2793",
            fields: {
              description: doc({ type: "embedCard", attrs: { url: requirementUrl } }),
            },
          },
        },
      },
      {
        match:
          "/wiki/api/v2/pages/2102099970?body-format=atlas_doc_format",
        respond: {
          json: {
            id: "2102099970",
            title: "Edit Mode in Summary Table",
            body: {
              atlas_doc_format: {
                representation: "atlas_doc_format",
                value: JSON.stringify(doc({
                  type: "paragraph",
                  content: [{ type: "text", text: "Full requirements" }],
                })),
              },
            },
          },
        },
      },
    ]);
    globalThis.fetch = http.fetch as typeof fetch;

    const secrets = new EnvSecretStore({
      JIRA_BASE_URL: "https://jira.test",
      JIRA_EMAIL: "developer@example.com",
      JIRA_TOKEN: "jira-token",
    });
    const service = new TicketDetailService({
      secretsFor: () => secrets,
      logger: createLogger({
        destination: new PassThrough(),
        pretty: false,
        level: "fatal",
      }),
    });

    const result = await service.get(
      { id: "user-1", name: "Developer", email: "developer@example.com" },
      "TP-3068",
    );

    expect(result.ticket?.description).toBeUndefined();
    expect(result.ticket?.parent?.key).toBe("TP-2793");
    expect(result.ticket?.parentDescription).toBe(
      `[Confluence page](<${requirementUrl}> "talos-smart-link")`,
    );
    expect(result.ticket?.confluencePreviews).toEqual([
      {
        url: requirementUrl,
        pageId: "2102099970",
        title: "Edit Mode in Summary Table",
        body: "Full requirements",
      },
    ]);
    expect(http.callsTo("/issue/TP-2793")).toHaveLength(1);
  });

  test("keeps complete ticket text and marks inline attachments", async () => {
    const longDescription = "description ".repeat(800).trimEnd();
    const longComment = "comment ".repeat(400).trimEnd();
    const http = new FakeHttp([
      { match: "/rest/api/3/field", respond: { json: JIRA_FIELDS } },
      {
        match: "/rest/api/3/issue/TP-1",
        respond: {
          json: {
            id: "1",
            key: "TP-1",
            fields: {
              description: doc(
                {
                  type: "mediaSingle",
                  content: [
                    {
                      type: "media",
                      attrs: { type: "file", id: "media-uuid", alt: "placed.png" },
                    },
                  ],
                },
                paragraph(longDescription),
              ),
              attachment: [
                { id: "10", filename: "placed.png", mimeType: "image/png" },
                { id: "12", filename: "comment.png", mimeType: "image/png" },
                { id: "11", filename: "extra.png", mimeType: "image/png" },
              ],
            },
          },
        },
      },
      {
        match: "/rest/api/3/issue/TP-1/comment",
        respond: {
          json: {
            comments: [
              {
                id: "comment-1",
                body: doc(
                  {
                    type: "mediaSingle",
                    content: [
                      {
                        type: "media",
                        attrs: {
                          type: "file",
                          id: "comment-media-uuid",
                          alt: "comment.png",
                        },
                      },
                    ],
                  },
                  paragraph(longComment),
                ),
              },
            ],
            total: 1,
          },
        },
      },
    ]);
    globalThis.fetch = http.fetch as typeof fetch;
    const secrets = new EnvSecretStore({
      JIRA_BASE_URL: "https://jira.test",
      JIRA_EMAIL: "developer@example.com",
      JIRA_TOKEN: "jira-token",
    });
    const service = new TicketDetailService({
      secretsFor: () => secrets,
      logger: createLogger({
        destination: new PassThrough(),
        pretty: false,
        level: "fatal",
      }),
    });

    const result = await service.get(
      { id: "user-1", name: "Developer", email: "developer@example.com" },
      "TP-1",
    );

    expect(result.ticket?.attachments).toEqual([
      {
        id: "10",
        filename: "placed.png",
        mimeType: "image/png",
        inline: true,
      },
      {
        id: "12",
        filename: "comment.png",
        mimeType: "image/png",
        inline: true,
      },
      { id: "11", filename: "extra.png", mimeType: "image/png" },
    ]);
    expect(result.ticket?.comments[0]?.body).toBe(
      `[comment.png](<#talos-attachment> "talos-attachment")\n\n${longComment}`,
    );
    expect(result.ticket?.description).toBe(
      `[placed.png](<#talos-attachment> "talos-attachment")\n\n${longDescription}`,
    );
  });
});
