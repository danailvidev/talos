import { useState } from "react";

import { Markdown as RenderedMarkdown } from "../components/Markdown.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";

/**
 * GitLab-flavoured Markdown for descriptions, comments, and system notes.
 * GitLab system notes contain small HTML fragments, so the shared renderer parses
 * them through its sanitizer. Arbitrary scripts and attributes remain disabled.
 */
export function Markdown({
  text,
  className,
  baseUrl,
  prId,
}: {
  text: string;
  className?: string;
  baseUrl?: string;
  prId?: string;
}) {
  const [preview, setPreview] = useState<{ src: string; alt: string }>();
  if (!text.trim()) return null;
  return (
    <>
      <RenderedMarkdown
        text={normalizeGitLabMarkdown(text)}
        className={className}
        renderSafeHtml
        linkBaseUrl={baseUrl}
        imageUrlTransform={(src) => pullRequestImageUrl(src, baseUrl, prId)}
        onImagePreview={setPreview}
        canPreviewImage={(src) => src.startsWith("/api/pull-requests/")}
      />
      <Dialog
        open={preview != null}
        onOpenChange={(open) => {
          if (!open) setPreview(undefined);
        }}
      >
        <DialogContent
          className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-3 overflow-hidden rounded-none bg-black/95 p-3 text-white sm:max-w-none"
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setPreview(undefined);
          }}
        >
          <DialogHeader className="min-w-0 pr-10">
            <DialogTitle className="overflow-hidden text-ellipsis whitespace-nowrap text-sm text-white">
              {preview ? previewTitle(preview) : "Image preview"}
            </DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
            {preview ? (
              <img
                className="max-h-full max-w-full object-contain"
                src={preview.src}
                alt={preview.alt}
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function previewTitle(image: { src: string; alt: string }): string {
  if (image.alt && image.alt.toLowerCase() !== "image") return image.alt;
  try {
    const url = new URL(image.src, "http://talos.local");
    const path = url.searchParams.get("path") ?? url.pathname;
    return decodeURIComponent(path.split("/").pop() || "") || "Image preview";
  } catch {
    return "Image preview";
  }
}

function pullRequestImageUrl(src: string, baseUrl?: string, prId?: string): string {
  if (!baseUrl) return src;
  try {
    const base = new URL(baseUrl);
    const image = new URL(src, base);
    if (
      prId &&
      image.origin === base.origin &&
      /^\/uploads\/[a-f0-9]{32}\/[^/]+$/i.test(image.pathname)
    ) {
      return (
        `/api/pull-requests/${encodeURIComponent(prId)}/assets?path=` +
        encodeURIComponent(image.pathname)
      );
    }
    return image.toString();
  } catch {
    return src;
  }
}

/**
 * GitLab appends presentation hints after uploaded images:
 * `![image](…){width=900 height=476}`. CommonMark treats the braces as prose,
 * so remove only this narrow generated suffix. The image remains responsive via
 * the shared Markdown styles and retains its natural aspect ratio.
 */
function normalizeGitLabMarkdown(text: string): string {
  const dimensionsRemoved = text.replace(
    /(!\[[^\]\n]*\]\([^\n)]+\))\s*\{\s*(?:(?:width|height)=\d+\s*){1,2}\}/gi,
    "$1",
  );
  return dimensionsRemoved.replace(
    /^([ \t]{4,})```([\s\S]*?)`{2,3}[ \t]*(?=\n|$)/gm,
    (_match, indentation: string, body: string) => {
      const code = body
        .split("\n")
        .map((line, index) =>
          index > 0 && line.startsWith(indentation)
            ? line.slice(indentation.length)
            : line,
        )
        .join("\n")
        .replace(/^\n+|\n+$/g, "");
      return `\`\`\`\n${code}\n\`\`\``;
    },
  );
}
