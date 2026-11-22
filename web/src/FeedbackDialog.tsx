import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bug,
  ChevronLeft,
  ChevronRight,
  Image,
  KeyRound,
  Lightbulb,
  MessageSquare,
  Paperclip,
  RefreshCw,
  ShieldAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  FeedbackType,
  FeedbackView,
  PendingFeedbackEntryView,
} from "../../shared/api-contract.ts";

import { api } from "./api.ts";
import { Field, FormActions } from "./components/ui/field.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Modal } from "./components/ui/modal.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { ErrorBox } from "./components/ui/query-state.tsx";
import { useAction } from "./useAction.ts";
import { DIALOG_BODY_CLASS } from "./typography-styles.ts";

interface FeedbackOption {
  type: FeedbackType;
  label: string;
  description: string;
  scope: string;
  labels: string[];
  icon: LucideIcon;
}

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);
const SUPPORTED_IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const FEEDBACK_IMAGE_ACCEPT = [...SUPPORTED_IMAGE_TYPES].join(",");

const FEEDBACK_OPTIONS: FeedbackOption[] = [
  {
    type: "bug",
    label: "Bug report",
    description: "Report a reproducible problem in Automesh",
    scope: "Bug",
    labels: ["bug"],
    icon: Bug,
  },
  {
    type: "feature",
    label: "Feature request",
    description: "Suggest an improvement or new capability",
    scope: "Feature",
    labels: ["feature"],
    icon: Lightbulb,
  },
  {
    type: "general",
    label: "General feedback",
    description: "Share an idea, question, or other feedback",
    scope: "Feedback",
    labels: [],
    icon: MessageSquare,
  },
  {
    type: "security",
    label: "Report a security issue",
    description: "Share security concerns with administrators",
    scope: "Security",
    labels: ["security"],
    icon: ShieldAlert,
  },
];

export function FeedbackDialog({
  onClose,
  onOpenProviderAccess,
}: {
  onClose: () => void;
  onOpenProviderAccess: () => void;
}) {
  const [selected, setSelected] = useState<FeedbackOption>();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [result, setResult] = useState<FeedbackView>();
  const [pending, setPending] = useState<PendingFeedbackEntryView[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const send = useAction();
  const previews = useMemo(
    () => attachments.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [attachments],
  );

  useEffect(
    () => () => {
      for (const preview of previews) URL.revokeObjectURL(preview.url);
    },
    [previews],
  );

  useEffect(() => {
    let active = true;
    void api.pendingFeedback().then(
      ({ feedback }) => active && setPending(feedback),
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);

  const addAttachments = (incoming: readonly File[]) => {
    const next = [...attachments];
    let error: string | undefined;
    for (const file of incoming) {
      if (!SUPPORTED_IMAGE_TYPES.has(file.type) && !SUPPORTED_IMAGE_EXTENSION.test(file.name)) {
        error = `'${file.name}' is not a supported image. Use PNG, JPEG, GIF, WebP, or SVG.`;
        continue;
      }
      if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
        error = `'${file.name}' must be between 1 byte and 10 MB.`;
        continue;
      }
      if (
        next.some(
          (existing) =>
            existing.name === file.name &&
            existing.size === file.size &&
            existing.lastModified === file.lastModified,
        )
      ) {
        continue;
      }
      if (next.length >= MAX_IMAGES) {
        error = `Attach at most ${MAX_IMAGES} images.`;
        break;
      }
      next.push(file);
    }
    setAttachments(next);
    setAttachmentError(error);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (images.length === 0) return;
    event.preventDefault();
    addAttachments(images);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (send.busy) return;
    addAttachments(Array.from(event.dataTransfer.files));
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    send.run(async () => {
      if (!selected) throw new Error("Choose a feedback type.");
      if (!title.trim()) throw new Error("Add a title.");
      if (!description.trim()) throw new Error("Add a description.");
      const created = await api.submitFeedback({
        type: selected.type,
        title: title.trim(),
        description: description.trim(),
      }, attachments);
      setResult(created);
    });
  };

  const retry = (id: string) => {
    send.run(async () => {
      const updated = await api.publishFeedback(id);
      setResult(updated);
      if (updated.publicationStatus === "published") {
        setPending((current) => current.filter((entry) => entry.id !== id));
      }
    });
  };

  return (
    <Modal
      onClose={send.busy ? () => {} : onClose}
      title={send.done ? "Feedback sent" : selected ? selected.label : "Create feedback"}
      className="max-w-150"
      titleActions={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={send.busy}
          onClick={onClose}
          aria-label="Close feedback dialog"
        >
          <X />
        </Button>
      }
    >
      {send.done ? (
        <>
          <p className={DIALOG_BODY_CLASS}>
            Thanks — your feedback has been saved
            {selected ? <> as <strong>{selected.scope}</strong></> : null}.
          </p>
          {result?.publicationStatus === "published" && result.issueUrl ? (
            <a
              className="text-sm font-medium text-primary hover:underline"
              href={result.issueUrl}
              target="_blank"
              rel="noreferrer"
            >
              View GitLab issue #{result.issueNumber}
            </a>
          ) : result?.publicationStatus === "pending" ? (
            <div className="grid gap-3">
              <ErrorBox>{pendingReasonMessage(result.publicationReason)}</ErrorBox>
              {send.error ? <ErrorBox>{send.error}</ErrorBox> : null}
            </div>
          ) : null}
          <FormActions>
            {result?.publicationStatus === "pending" ? (
              <>
                <Button type="button" variant="outline" onClick={onOpenProviderAccess}>
                  <KeyRound />
                  My provider access
                </Button>
                <Button
                  type="button"
                  disabled={send.busy}
                  onClick={() => retry(result.id)}
                >
                  <RefreshCw className={send.busy ? "animate-spin" : ""} />
                  {send.busy ? "Retrying…" : "Retry GitLab"}
                </Button>
              </>
            ) : null}
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
          </FormActions>
        </>
      ) : !selected ? (
        <>
          {pending.length > 0 ? (
            <div className="mb-3 grid gap-2 rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-sm font-medium">Pending GitLab publication</p>
              {pending.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between gap-3 rounded-md bg-background p-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{entry.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {pendingReasonMessage(entry.publicationReason)}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={send.busy}
                    onClick={() => retry(entry.id)}
                  >
                    Retry
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="mt-2 overflow-hidden rounded-lg border border-border">
            {FEEDBACK_OPTIONS.map((option, index) => {
              const Icon = option.icon;
              return (
                <Button
                  key={option.type}
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-between rounded-none border-b border-border px-4 py-3 text-left leading-normal whitespace-normal last:border-b-0 hover:bg-muted min-[901px]:h-auto"
                  autoFocus={index === 0 && pending.length === 0}
                  onClick={() => setSelected(option)}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <Icon className="size-5 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block text-sm leading-5 font-medium text-foreground">{option.label}</span>
                      <span className="mt-0.5 block text-xs leading-4 font-normal text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </span>
                  <ChevronRight className="ml-3 text-muted-foreground" />
                </Button>
              );
            })}
          </div>
        </>
      ) : (
        <form className="mt-2 flex flex-col gap-3" onSubmit={handleSubmit}>
          <Field
            label="Title"
            hint={`Submitted as [${selected.scope}]: ${title.trim() || "Ticket title"}`}
          >
            <Input
              value={title}
              maxLength={160}
              placeholder="Short summary"
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label="Description">
            <Textarea
              className="min-h-36"
              placeholder="Describe the request and include any useful context. Paste images here to attach them."
              value={description}
              maxLength={4000}
              onPaste={handlePaste}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <div
            className="rounded-lg border border-dashed border-border bg-muted/30 p-3"
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <Paperclip className="size-4 shrink-0" />
                <span>Paste, drop, or choose up to 5 images (10 MB each).</span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={send.busy || attachments.length >= MAX_IMAGES}
                onClick={() => fileInput.current?.click()}
              >
                <Image />
                Add images
              </Button>
              <input
                ref={fileInput}
                className="hidden"
                type="file"
                multiple
                accept={FEEDBACK_IMAGE_ACCEPT}
                disabled={send.busy}
                onChange={(event) => {
                  addAttachments(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
            </div>
            {previews.length > 0 ? (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {previews.map(({ file, url }) => (
                  <li
                    key={`${file.name}-${file.size}-${file.lastModified}`}
                    className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background p-2"
                  >
                    <img
                      className="size-10 shrink-0 rounded object-cover"
                      src={url}
                      alt=""
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-foreground">
                        {file.name}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {formatFileSize(file.size)}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={send.busy}
                      aria-label={`Remove ${file.name}`}
                      onClick={() => {
                        setAttachments((current) => current.filter((item) => item !== file));
                        setAttachmentError(undefined);
                      }}
                    >
                      <X />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {attachmentError ? <ErrorBox>{attachmentError}</ErrorBox> : null}
          {selected.labels.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Label added automatically:{" "}
              {selected.labels.map((label) => (
                <span
                  key={label}
                  className="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground"
                >
                  {label}
                </span>
              ))}
            </p>
          ) : null}
          {send.error ? <ErrorBox>{send.error}</ErrorBox> : null}
          <FormActions>
            <Button type="submit" disabled={send.busy}>
              {send.busy ? "Submitting…" : "Submit feedback"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={send.busy}
              onClick={() => {
                send.clear();
                setSelected(undefined);
              }}
            >
              <ChevronLeft />
              Back
            </Button>
          </FormActions>
        </form>
      )}
    </Modal>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pendingReasonMessage(reason: FeedbackView["publicationReason"]): string {
  if (reason === "missing_token") {
    return "No personal GitLab token is connected. Add one, then retry.";
  }
  if (reason === "invalid_token") {
    return "Your GitLab token is invalid or expired. Replace it, then retry.";
  }
  if (reason === "insufficient_access") {
    return "Your GitLab token cannot create issues in example-org/tools/talos. " +
      "Grant it API scope and project access, then retry.";
  }
  return "GitLab could not be reached. Your feedback and screenshots are saved; retry later.";
}
