import { z } from "zod";

import type { Logger } from "../../logging/logger.ts";
import type { SecretStore } from "../../secrets/secret-store.ts";
import {
  ConfigError,
  ConnectorError,
  TransientError,
  errorFromHttpStatus,
} from "../../core/errors.ts";
import { HttpClient, type FetchLike } from "../http.ts";
import { encodeProject, GITLAB_API_URL } from "./client.ts";

export interface FeedbackIssueAttachment {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface FeedbackIssueInput {
  /** Stable local id used to reconcile an issue after an ambiguous timeout. */
  idempotencyKey: string;
  title: string;
  body: string;
  bodySuffix?: string;
  labels: string[];
  attachments?: readonly FeedbackIssueAttachment[];
  signal?: AbortSignal;
}

export interface CreatedFeedbackIssue {
  number: number;
  url: string;
}

export interface GitLabFeedbackIssue {
  number: number;
  url: string;
  state: "opened" | "closed";
  title: string;
  description: string;
  labels: string[];
  createdAt: Date;
  updatedAt: Date;
  /** Present for issues created by the current Talos feedback publisher. */
  feedbackId?: string;
}

export interface FeedbackIssuePublisher {
  createIssue(input: FeedbackIssueInput): Promise<CreatedFeedbackIssue>;
  /** Every issue in the bound project, newest first; callers select feedback rows. */
  listIssues(signal?: AbortSignal): Promise<GitLabFeedbackIssue[]>;
}

export interface GitLabIssuePublisherOptions {
  secrets: SecretStore;
  project: string;
  fetch?: FetchLike;
  logger?: Logger;
}

const CreatedIssueSchema = z.object({
  iid: z.number().int().positive(),
  web_url: z.string().url(),
  description: z.string().nullish(),
});

const IssueListSchema = z.array(CreatedIssueSchema);

const ProjectIssueSchema = z.object({
  iid: z.number().int().positive(),
  web_url: z.string().url(),
  state: z.enum(["opened", "closed"]),
  title: z.string(),
  description: z.string().nullish(),
  labels: z.array(z.string()),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

const ProjectIssueListSchema = z.array(ProjectIssueSchema);

const UploadedFileSchema = z.object({
  markdown: z.string().min(1),
});

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/**
 * Files feedback in one GitLab project as the submitting developer. Callers
 * must pass an actor-scoped secret store: silently borrowing the instance token
 * would attribute the issue to the wrong person and bypass their permissions.
 */
export class GitLabIssuePublisher implements FeedbackIssuePublisher {
  private readonly project: string;
  private readonly baseUrl: string;

  constructor(private readonly options: GitLabIssuePublisherOptions) {
    this.project = options.project.trim();
    if (!this.project) {
      throw new ConfigError("The GitLab feedback project must not be empty.");
    }
    // Validate the project eagerly so a malformed path fails during startup.
    encodeProject(this.project);
    this.baseUrl = (options.secrets.get("GITLAB_API_URL") ?? GITLAB_API_URL).replace(
      /\/+$/,
      "",
    );
  }

  async createIssue(input: FeedbackIssueInput): Promise<CreatedFeedbackIssue> {
    const token = this.options.secrets.require("GITLAB_TOKEN");
    const http = this.httpClient(token);
    const marker = feedbackMarker(input.idempotencyKey);
    const existing = await this.findIssue(
      http,
      input.idempotencyKey,
      marker,
      input.signal,
    );
    if (existing) return existing;

    const attachmentMarkdown: string[] = [];
    for (const attachment of input.attachments ?? []) {
      attachmentMarkdown.push(
        await this.uploadAttachment(token, attachment, input.signal),
      );
    }

    const { data } = await http.postJson(
      CreatedIssueSchema,
      `/projects/${encodeProject(this.project)}/issues`,
      {
        title: input.title,
        description: [input.body, ...attachmentMarkdown, input.bodySuffix, marker]
          .filter(Boolean)
          .join("\n\n"),
        ...(input.labels.length ? { labels: input.labels.join(",") } : {}),
      },
      { signal: input.signal },
    );
    return { number: data.iid, url: data.web_url };
  }

  async listIssues(signal?: AbortSignal): Promise<GitLabFeedbackIssue[]> {
    const token = this.options.secrets.require("GITLAB_TOKEN");
    const http = this.httpClient(token);
    const out: GitLabFeedbackIssue[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, headers } = await http.getJson(
        ProjectIssueListSchema,
        `/projects/${encodeProject(this.project)}/issues`,
        {
          signal,
          query: {
            scope: "all",
            state: "all",
            order_by: "created_at",
            sort: "desc",
            per_page: PAGE_SIZE,
            page,
          },
        },
      );
      out.push(
        ...data.map((issue) => {
          const feedbackId = feedbackIdFromDescription(issue.description ?? "");
          return {
            number: issue.iid,
            url: issue.web_url,
            state: issue.state,
            title: issue.title,
            description: issue.description ?? "",
            labels: issue.labels,
            createdAt: issue.created_at,
            updatedAt: issue.updated_at,
            ...(feedbackId ? { feedbackId } : {}),
          };
        }),
      );
      const next = headers.get("x-next-page");
      if (!next || next.trim() === "") return out;
    }

    throw new ConnectorError(
      `gitlab: feedback issue listing exceeded ${MAX_PAGES * PAGE_SIZE} issues`,
      { connector: "gitlab", retryable: false },
    );
  }

  private async findIssue(
    http: HttpClient,
    idempotencyKey: string,
    marker: string,
    signal?: AbortSignal,
  ): Promise<CreatedFeedbackIssue | undefined> {
    const { data } = await http.getJson(
      IssueListSchema,
      `/projects/${encodeProject(this.project)}/issues`,
      {
        signal,
        query: {
          search: idempotencyKey,
          in: "description",
          scope: "all",
          state: "all",
          per_page: 20,
        },
      },
    );
    const issue = data.find((candidate) => candidate.description?.includes(marker));
    return issue ? { number: issue.iid, url: issue.web_url } : undefined;
  }

  private httpClient(token: string): HttpClient {
    return new HttpClient({
      baseUrl: this.baseUrl,
      connector: "gitlab",
      headers: { "private-token": token },
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      maxConcurrency: 4,
    });
  }

  private async uploadAttachment(
    token: string,
    attachment: FeedbackIssueAttachment,
    signal?: AbortSignal,
  ): Promise<string> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([attachment.bytes], { type: attachment.contentType }),
      attachment.name,
    );
    const timeout = AbortSignal.timeout(30_000);
    const uploadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(
        `${this.baseUrl}/projects/${encodeProject(this.project)}/uploads`,
        {
          method: "POST",
          headers: { "private-token": token },
          body: form,
          signal: uploadSignal,
        },
      );
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new TransientError(`gitlab: failed to upload '${attachment.name}'.`, {
        cause,
        connector: "gitlab",
      });
    }

    if (!response.ok) {
      throw errorFromHttpStatus(
        response.status,
        `gitlab: uploading '${attachment.name}' returned ${response.status} ${response.statusText}.`,
        { connector: "gitlab" },
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new ConnectorError(
        `gitlab: uploading '${attachment.name}' returned invalid JSON.`,
        { cause, connector: "gitlab" },
      );
    }
    const parsed = UploadedFileSchema.safeParse(body);
    if (!parsed.success) {
      throw new ConnectorError(
        `gitlab: uploading '${attachment.name}' returned an invalid response.`,
        { connector: "gitlab" },
      );
    }
    return parsed.data.markdown;
  }
}

function feedbackMarker(idempotencyKey: string): string {
  const key = idempotencyKey.trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
    throw new ConfigError("Feedback idempotency key is invalid.");
  }
  return `<!-- automesh-feedback:${key} -->`;
}

function feedbackIdFromDescription(description: string): string | undefined {
  return description.match(
    /<!--\s*automesh-feedback:([A-Za-z0-9_-]{8,128})\s*-->/,
  )?.[1];
}
