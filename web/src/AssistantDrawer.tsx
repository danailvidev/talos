import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import {
  AlertTriangle,
  Check,
  LoaderCircle,
  RotateCcw,
  Send,
  Square,
  X,
} from "lucide-react";

import { api, type AssistantMessage, type AssistantStreamEvent } from "./api.ts";
import { queryClient } from "./query-client.ts";
import { AssistantIcon } from "./AssistantIcon.tsx";
import { ICON_BUTTON_CLASS } from "./app-styles.ts";
import { Markdown } from "./components/Markdown.tsx";
import { Button } from "./components/ui/button.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { SplitHandle } from "./SplitHandle.tsx";
import { useNarrowLayout } from "./useNarrowLayout.ts";
import { useResizableHeight, useResizableWidth } from "./useResizableWidth.ts";

interface ChatMessage extends AssistantMessage {
  id: string;
}

interface ToolActivity {
  id: string;
  name: string;
  status: "started" | "completed" | "failed";
}

export function AssistantSidebar({
  open,
  onOpenChange,
  seed,
  userId,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Replaces the draft when the console asks Talos to start from a prompt. */
  seed?: { id: number; text: string } | null;
  userId: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadChatHistory(userId));
  const [draft, setDraft] = useState("");
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const [account, setAccount] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [activeReplyId, setActiveReplyId] = useState<string>();
  const [error, setError] = useState<string>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const dashboardTouched = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrowLayout();
  const { width, onPointerDown, onPointerMove, onPointerUp } = useResizableWidth(
    "talos-assistant-width",
    420,
    320,
    720,
    "left",
  );
  const composer = useResizableHeight("talos-assistant-composer", 168, 120, 420);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: busy ? "auto" : "smooth",
    });
  }, [messages, tools, busy]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (seed?.text) setDraft(seed.text);
  }, [seed?.id, seed?.text]);

  useEffect(() => {
    saveChatHistory(userId, messages);
  }, [messages, userId]);

  const runTurn = async (base: ChatMessage[]) => {
    const assistantId = crypto.randomUUID();
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    dashboardTouched.current = false;
    setActiveReplyId(assistantId);
    setMessages([...base, { id: assistantId, role: "assistant", content: "" }]);
    setTools([]);
    setError(undefined);
    setBusy(true);
    let streamError: string | undefined;

    try {
      await api.assistantChat(
        {
          messages: outboundMessages(base),
        },
        (event) => {
          if (event.type === "start") setAccount(event.account);
          if (event.type === "text") {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? { ...message, content: message.content + event.text }
                  : message,
              ),
            );
          }
          if (event.type === "tool") {
            updateTool(setTools, event);
            const name = event.name.replaceAll("_", " ");
            if (name.includes("dashboard")) dashboardTouched.current = true;
            if (event.status !== "started" && /^(talos ui action|talos loop (create|update|delete|schedule)|talos dashboard (create|update|delete))$/.test(name)) {
              void refreshDashboards();
            }
          }
          if (event.type === "done" && dashboardTouched.current) {
            void refreshDashboards();
          }
          if (event.type === "error") streamError = event.message;
        },
        controller.signal,
      );
      if (streamError) throw new Error(streamError);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = undefined;
      setActiveReplyId((current) => (current === assistantId ? undefined : current));
      setMessages((current) =>
        current.filter((message) => message.id !== assistantId || message.content.trim().length > 0),
      );
      setBusy(false);
    }
  };

  const send = () => {
    const content = draft.trim();
    if (!content || busy) return;
    const history = messages.filter((message) => message.content.trim().length > 0);
    const next = [...history, { id: crypto.randomUUID(), role: "user" as const, content }];
    setDraft("");
    void runTurn(next);
  };

  const retry = () => {
    if (busy) return;
    const base =
      messages.at(-1)?.role === "assistant" ? messages.slice(0, -1) : messages;
    if (base.at(-1)?.role === "user") void runTurn(base);
  };

  const stop = () => abortRef.current?.abort();

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <>
      <SplitHandle
        label="Resize assistant"
        value={width}
        className={open && !narrow ? undefined : "hidden"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <aside
        aria-label="Assistant"
        className={
          open
            ? "flex min-h-0 flex-col overflow-hidden bg-background max-[900px]:fixed max-[900px]:inset-0 max-[900px]:z-50 max-[900px]:pt-[env(safe-area-inset-top)] max-[900px]:pb-[env(safe-area-inset-bottom)]"
            : "hidden"
        }
        style={narrow ? undefined : { width }}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-medium text-foreground">
              <AssistantIcon size={18} />
              Assistant
            </h2>
            {account ? (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">Connected · {account}</p>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={ICON_BUTTON_CLASS}
            aria-label="Close assistant"
            onClick={() => onOpenChange(false)}
          >
            <X size={14} strokeWidth={2} />
          </Button>
        </header>

        <div
          ref={transcriptRef}
          role="log"
          aria-live="polite"
          aria-label="Assistant conversation"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"
        >
          {messages.length === 0 ? (
            <EmptyState onPrompt={(prompt) => setDraft(prompt)} />
          ) : (
            <div className="flex flex-col gap-4">
              {messages.map((message) => (
                <article
                  key={message.id}
                  className={
                    message.role === "user"
                      ? "ml-10 self-end rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
                      : "mr-4 self-stretch text-sm text-foreground"
                  }
                >
                  {message.role === "assistant" ? (
                    message.content ? (
                      <Markdown text={message.content} className="text-sm" />
                    ) : message.id === activeReplyId ? (
                      <span className="inline-flex items-center gap-2 text-muted-foreground">
                        <LoaderCircle className="animate-spin" size={14} />
                        Thinking…
                      </span>
                    ) : null
                  ) : (
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  )}
                </article>
              ))}
            </div>
          )}

          {tools.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-1.5" aria-label="Data sources used">
              {tools.map((tool) => (
                <span
                  key={tool.id}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-1 text-xs text-muted-foreground"
                >
                  {tool.status === "started" ? (
                    <LoaderCircle className="animate-spin" size={11} />
                  ) : tool.status === "completed" ? (
                    <Check size={11} />
                  ) : (
                    <AlertTriangle size={11} />
                  )}
                  {tool.name}
                </span>
              ))}
            </div>
          ) : null}

          {error ? (
            <div
              role="alert"
              className="mt-4 rounded-md border border-destructive/35 bg-destructive/10 p-3 text-sm text-destructive"
            >
              <p>{error}</p>
              <Button className="mt-2" size="sm" variant="outline" onClick={retry}>
                <RotateCcw data-icon="inline-start" />
                Retry
              </Button>
            </div>
          ) : null}
        </div>

        <SplitHandle
          orientation="horizontal"
          label="Resize assistant input"
          value={composer.height}
          onPointerDown={composer.onPointerDown}
          onPointerMove={composer.onPointerMove}
          onPointerUp={composer.onPointerUp}
        />
        <footer
          className="flex shrink-0 flex-col overflow-hidden p-3"
          style={{ height: composer.height }}
        >
          <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-background p-2 focus-within:border-[var(--focus)]">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about your work…"
              aria-label="Message the assistant"
              rows={2}
              maxLength={20_000}
              disabled={busy}
              className="min-h-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent p-1 focus-visible:border-0"
              autoFocus={open}
            />
            <div className="mt-1 flex shrink-0 items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground max-[900px]:sr-only">
                Enter to send · Shift+Enter for a new line
              </span>
              {busy ? (
                <Button type="button" size="icon-sm" variant="outline" onClick={stop} aria-label="Stop">
                  <Square size={12} fill="currentColor" />
                </Button>
              ) : (
                <Button
                  type="button"
                  size="icon-sm"
                  onClick={send}
                  disabled={!draft.trim()}
                  aria-label="Send message"
                >
                  <Send size={13} />
                </Button>
              )}
            </div>
          </div>
        </footer>
      </aside>
    </>
  );
}

function EmptyState({ onPrompt }: { onPrompt(prompt: string): void }) {
  const prompts = [
    "What needs my attention today?",
    "Summarize my open merge requests.",
    "Which production errors are most urgent?",
  ];
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 py-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <AssistantIcon size={22} />
      </div>
      <div>
        <h2 className="text-base font-medium text-foreground">Ask across your connected tools</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Claude can read the same GitLab and Jira data you can, plus connected observability data.
        </p>
      </div>
      <div className="flex w-full max-w-sm flex-col gap-2">
        {prompts.map((prompt) => (
          <Button
            key={prompt}
            type="button"
            variant="outline"
            className="h-auto justify-start whitespace-normal py-2 text-left font-normal"
            onClick={() => onPrompt(prompt)}
          >
            {prompt}
          </Button>
        ))}
      </div>
    </div>
  );
}

function refreshDashboards(): Promise<void> {
  return queryClient.refetchQueries({ queryKey: ["dashboards"] });
}

const CHAT_HISTORY_LIMIT = 30;

function chatHistoryKey(userId: string): string {
  return `talos-assistant-chat:${userId}`;
}

function loadChatHistory(userId: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(chatHistoryKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as { id?: unknown; role?: unknown; content?: unknown };
      if (
        (candidate.role !== "user" && candidate.role !== "assistant")
        || typeof candidate.content !== "string"
        || typeof candidate.id !== "string"
        || candidate.content.trim().length === 0
      ) {
        return [];
      }
      const role: "user" | "assistant" = candidate.role === "assistant" ? "assistant" : "user";
      return [{
        id: candidate.id,
        role,
        content: candidate.content.slice(0, ASSISTANT_MESSAGE_LIMIT),
      }];
    }).slice(-CHAT_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveChatHistory(userId: string, messages: ChatMessage[]): void {
  const kept = messages
    .filter((message) => message.content.trim().length > 0)
    .slice(-CHAT_HISTORY_LIMIT)
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content.slice(0, ASSISTANT_MESSAGE_LIMIT),
    }));
  try {
    localStorage.setItem(chatHistoryKey(userId), JSON.stringify(kept));
  } catch {
    // A full browser store should not block the conversation.
  }
}

const ASSISTANT_MESSAGE_LIMIT = 20_000;

/** The API rejects a blank message and anything over 20,000 characters. */
function outboundMessages(messages: ChatMessage[]): AssistantMessage[] {
  return messages
    .slice(-30)
    .map(({ role, content }) => ({ role, content: content.trim() }))
    .filter((message) => message.content.length > 0)
    .map((message) =>
      message.content.length <= ASSISTANT_MESSAGE_LIMIT
        ? message
        : { ...message, content: message.content.slice(-ASSISTANT_MESSAGE_LIMIT) },
    );
}

function updateTool(
  setTools: Dispatch<SetStateAction<ToolActivity[]>>,
  event: Extract<AssistantStreamEvent, { type: "tool" }>,
): void {
  setTools((current) => {
    const existing = current.findIndex((tool) => tool.id === event.id);
    if (existing < 0) return [...current, event];
    return current.map((tool, index) => (index === existing ? event : tool));
  });
}
