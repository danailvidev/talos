import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Link2,
  X as FailureIcon,
} from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import type { ConfluencePreviewView } from "../api.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import { Card, CardContent } from "./ui/card.tsx";

const SMART_LINK_TITLE = "talos-smart-link";
const ATTACHMENT_LINK_TITLE = "talos-attachment";
const FAILURE_LINK_TITLE = "talos-failure";
const SAFE_HTML_PLUGINS = [rehypeRaw, rehypeSanitize];

/**
 * Markdown as elements.
 *
 * Raw HTML stays disabled by default. Forge content can opt into it because
 * GitLab's own system notes mix Markdown with fragments such as `<ul><li>…`.
 * Those fragments pass through `rehype-sanitize` before becoming React elements,
 * so comment authors cannot smuggle scripts or event handlers into the page.
 *
 * GFM is on for tables, strikethrough and task lists — the three things Jira has
 * that plain CommonMark does not. Styling lives in `styles/markdown.css` under one
 * `.md` scope rather than on each element, so a Markdown block picks up the same
 * treatment wherever it is dropped.
 */
export const Markdown = memo(function Markdown({
  text,
  className,
  smartLinkPreviews = [],
  renderAttachment,
  renderSafeHtml = false,
  linkBaseUrl,
  imageUrlTransform,
  onImagePreview,
  canPreviewImage,
}: {
  text: string;
  className?: string;
  smartLinkPreviews?: readonly ConfluencePreviewView[];
  renderAttachment?: (filename: string) => ReactNode;
  renderSafeHtml?: boolean;
  /** Resolves forge-generated root-relative links before opening them. */
  linkBaseUrl?: string;
  imageUrlTransform?: (src: string) => string;
  onImagePreview?: (image: { src: string; alt: string }) => void;
  canPreviewImage?: (src: string) => boolean;
}) {
  return (
    <div className={`md ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={renderSafeHtml ? SAFE_HTML_PLUGINS : undefined}
        components={{
          p: ({ node, children, ...props }) => {
            const link = standaloneSmartLink(node);
            if (link) {
              return (
                <SmartLink
                  href={link.href}
                  preview={smartLinkPreviews.find((preview) => preview.url === link.href)}
                >
                  {link.label}
                </SmartLink>
              );
            }
            const attachment = standaloneAttachment(node);
            const rendered = attachment ? renderAttachment?.(attachment) : undefined;
            return rendered != null ? rendered : <p {...props}>{children}</p>;
          },
          // Jira's links point at Jira, Confluence and whatever was pasted in. All
          // of them leave this page, so none of them replace it.
          a: ({ node: _node, title, href, children, ...props }) => {
            const resolvedHref = resolveHref(href, linkBaseUrl);
            return title === SMART_LINK_TITLE ? (
              <a {...props} href={resolvedHref} target="_blank" rel="noreferrer">
                {children}
              </a>
            ) : title === ATTACHMENT_LINK_TITLE ? (
              <span className="text-[var(--text-faint)] italic">📎 {children}</span>
            ) : title === FAILURE_LINK_TITLE ? (
              <span
                className="inline-flex align-[-0.2em]"
                style={{ color: "var(--failure)" }}
                role="img"
                aria-label="Failed"
                title="Failed"
              >
                <FailureIcon size={20} strokeWidth={2.75} aria-hidden="true" />
              </span>
            ) : (
              <a
                {...props}
                href={resolvedHref}
                title={title}
                target="_blank"
                rel="noreferrer"
              >
                {children}
              </a>
            );
          },
          img: ({ node: _node, src, alt = "", className, ...props }) => {
            const resolvedSrc = src
              ? imageUrlTransform?.(src) ?? resolveHref(src, linkBaseUrl)
              : undefined;
            const previewable = Boolean(
              onImagePreview &&
              resolvedSrc &&
              (canPreviewImage ? canPreviewImage(resolvedSrc) : true),
            );
            const image = (
              <img
                {...props}
                src={resolvedSrc}
                alt={alt}
                loading="lazy"
                className={cn(
                  className,
                  previewable
                    ? "max-h-48 max-w-80 object-contain transition-transform group-hover:scale-[1.02]"
                    : "inline-block align-middle",
                )}
              />
            );
            return previewable && resolvedSrc && onImagePreview ? (
              <Button
                type="button"
                variant="outline"
                className="group my-2 h-auto max-h-48 max-w-80 overflow-hidden border-border bg-[var(--bg-deep)] p-0 align-top hover:border-[var(--border-strong)] hover:bg-[var(--bg-deep)]"
                aria-label={`Preview ${alt || "image"}`}
                onClick={() => onImagePreview({ src: resolvedSrc, alt })}
              >
                {image}
              </Button>
            ) : (
              image
            );
          },
          // Preserve Jira's heading semantics as well as its visual hierarchy.
          // Rich-text headings are content, but flattening them to paragraphs made
          // requirements hard to scan and removed useful screen-reader navigation.
          h1: ({ node: _node, ...props }) => <h1 className="md-heading md-h1" {...props} />,
          h2: ({ node: _node, ...props }) => <h2 className="md-heading md-h2" {...props} />,
          h3: ({ node: _node, ...props }) => <h3 className="md-heading md-h3" {...props} />,
          h4: ({ node: _node, ...props }) => <h4 className="md-heading md-h4" {...props} />,
          h5: ({ node: _node, ...props }) => <h5 className="md-heading md-h5" {...props} />,
          h6: ({ node: _node, ...props }) => <h6 className="md-heading md-h6" {...props} />,
          // Wrapped so a wide table scrolls inside the panel instead of widening it.
          table: ({ node: _node, ...props }) => (
            <div className="md-table-scroll">
              <table {...props} />
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

function resolveHref(href: string | undefined, baseUrl: string | undefined): string | undefined {
  if (!href || !baseUrl) return href;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

/**
 * Jira's standalone Smart Link appearance.
 *
 * The header remains a normal external link. When the ticket service resolved a
 * same-site Confluence page, its ADF body follows underneath as sanitized Markdown;
 * otherwise this gracefully remains the compact link card.
 */
function SmartLink({
  href,
  children,
  preview,
}: {
  href?: string;
  children: ReactNode;
  preview?: ConfluencePreviewView;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!href) return <>{children}</>;

  const confluence = isConfluenceUrl(href);
  const Icon = confluence ? BookOpen : Link2;
  const previewIsLong = (preview?.body.length ?? 0) > 900;

  return (
    <Card size="sm" className="my-2 gap-0 py-0">
      <a
        className="group flex min-w-0 items-center gap-2.5 px-3 py-2.5 [text-decoration:none!important] hover:bg-[var(--bg-hover)]"
        href={href}
        target="_blank"
        rel="noreferrer"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--bg-deep)] text-[var(--text-muted)]">
          <Icon size={16} strokeWidth={2} aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-foreground">{preview?.title ?? children}</span>
          <span className="overflow-hidden text-xs text-ellipsis whitespace-nowrap text-[var(--text-faint)]">
            {href}
          </span>
        </span>
        <ExternalLink
          className="shrink-0 text-[var(--text-faint)] transition-colors group-hover:text-[var(--text-muted)]"
          size={14}
          strokeWidth={2}
          aria-hidden="true"
        />
      </a>
      {preview?.body ? (
        <>
          <CardContent
            className={`relative border-t border-border pt-3 ${
              previewIsLong && !expanded ? "max-h-72 overflow-hidden" : ""
            }`}
          >
            <Markdown text={preview.body} className="text-sm" />
            {previewIsLong && !expanded ? (
              <span
                className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-b from-transparent to-card"
                aria-hidden="true"
              />
            ) : null}
          </CardContent>
          {previewIsLong ? (
            <div className="flex justify-center border-t border-border px-3 py-1.5">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? (
                  <ChevronUp data-icon="inline-start" />
                ) : (
                  <ChevronDown data-icon="inline-start" />
                )}
                {expanded ? "Show less" : "Show full page"}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

function standaloneSmartLink(node: unknown): { href: string; label: string } | undefined {
  const link = standaloneMarkedLink(node, SMART_LINK_TITLE);
  return link ? { href: link.href, label: link.label } : undefined;
}

function standaloneAttachment(node: unknown): string | undefined {
  return standaloneMarkedLink(node, ATTACHMENT_LINK_TITLE)?.label;
}

function standaloneMarkedLink(
  node: unknown,
  title: string,
): { href: string; label: string } | undefined {
  if (!node || typeof node !== "object") return undefined;
  const children = (node as { children?: unknown }).children;
  if (!Array.isArray(children) || children.length !== 1) return undefined;
  const link = children[0];
  if (!link || typeof link !== "object" || (link as { tagName?: unknown }).tagName !== "a") {
    return undefined;
  }
  const properties = (link as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object") return undefined;
  const values = properties as Record<string, unknown>;
  if (values.title !== title || typeof values.href !== "string") return undefined;
  return { href: values.href, label: textOf(link) || values.href };
}

function textOf(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const value = (node as { value?: unknown }).value;
  if (typeof value === "string") return value;
  const children = (node as { children?: unknown }).children;
  return Array.isArray(children) ? children.map(textOf).join("") : "";
}

function isConfluenceUrl(href: string): boolean {
  try {
    return new URL(href).pathname.startsWith("/wiki/");
  } catch {
    return false;
  }
}
