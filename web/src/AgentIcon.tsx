import type { AgentProvider } from "./api.ts";

/**
 * Brand marks for the coding agents `/api/agents` can detect on the host.
 *
 * Inline SVG per provider, same as `GitLabIcon`/`JiraIcon`: the agent dropdown
 * has to render offline and inside the packaged binary, so no sprite sheet and no
 * remote favicon. Each mark is a single path in the brand's own colour, sized off
 * one `size` prop so a row lines up with the email beside it.
 */
export function AgentIcon({ provider, size = 16 }: { provider: AgentProvider; size?: number }) {
  if (provider === "claude") return <ClaudeIcon size={size} />;
  if (provider === "cursor") return <CursorIcon size={size} />;
  if (provider === "codex") return <CodexIcon size={size} />;
  return <CopilotIcon size={size} />;
}

/** Anthropic's burst. */
function ClaudeIcon({ size }: { size: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M4.71 15.3l4.62-2.6.08-.23-.08-.13H9.1l-.79-.05-2.7-.07-2.34-.1-2.27-.12-.57-.12L0 11.15l.06-.35.48-.32.68.06 1.52.1 2.27.16 1.65.1 2.44.25h.39l.05-.16-.13-.1-.1-.09-2.36-1.6-2.56-1.69-1.34-.98L2.4 5.9l-.37-.46-.16-1.02.67-.73.89.06.23.06.9.7 1.94 1.5 2.53 1.86.37.31.15-.1.02-.08-.17-.28-1.38-2.5L7.55 2.5l-.65-1.05-.18-.63a2.4 2.4 0 01-.04-.5L7.44 0l.42.13 1.75 2.4 2.84 3.94.44.73.21-.12.11-.6.6-3.23.63-3.97.2-.46.66-.29.52.24.42.6-.06.4-.26 1.66-.5 2.6-.32 1.75h.19l.21-.22.87-1.15 1.45-1.82.65-.72.75-.8.49-.39h.91l.67 1-.3.99-.94 1.19-.78 1.01-1.12 1.5-.7 1.21.06.1.16-.02 2.5-.53 1.35-.25 1.61-.27.73.34.08.35-.29.71-1.74.43-2.04.4-3.04.73-.04.02.04.05 1.37.13.58.03h1.44l2.68.2.7.46.42.57-.07.43-1.08.55-1.45-.34-3.39-.81-1.16-.29h-.16v.1l.97.94 1.78 1.6 2.22 2.07.11.51-.28.4-.3-.04-1.94-1.46-.75-.66-1.7-1.42h-.11v.15l.39.57 2.07 3.11.1.95-.14.31-.54.19-.59-.11-1.21-1.7-1.25-1.92-1.01-1.72-.13.07-.6 6.4-.28.33-.64.25-.54-.4-.29-.67.29-1.31.34-1.7.28-1.36.25-1.68.15-.56-.01-.04-.13.02-1.28 1.76-1.94 2.62-1.54 1.65-.37.14-.64-.33.06-.6.36-.52 2.13-2.71.83-1.09.9-1.05-.01-.15h-.05L5.1 18.06l-1.42.19-.61-.58.07-.94.29-.3 2.4-1.65-.01-.01z"
        fill="#D97757"
      />
    </svg>
  );
}

/** Cursor's cube. */
function CursorIcon({ size }: { size: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12 1.5 22.4 7.5v9L12 22.5 1.6 16.5v-9L12 1.5z" fill="#0F0F0F" />
      <path d="M12 1.5 22.4 7.5 12 13.5 1.6 7.5 12 1.5z" fill="#5B5B5B" />
      <path d="M22.4 7.5v9L12 22.5v-9l10.4-6z" fill="#2C2C2C" />
      <path d="M12 13.5v9L1.6 16.5v-9l10.4 6z" fill="#7D7D7D" />
    </svg>
  );
}

/** OpenAI's knot, which Codex ships under. */
function CodexIcon({ size }: { size: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M22.28 9.82a5.99 5.99 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.99 5.99 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.52 2.9A6.06 6.06 0 0 0 19.02 19.8a5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.74-7.08ZM12.3 21.6a4.5 4.5 0 0 1-2.88-1.04l.14-.08 4.79-2.77a.79.79 0 0 0 .39-.68V10.2l2.02 1.17a.07.07 0 0 1 .04.06v5.6a4.5 4.5 0 0 1-4.5 4.57Zm-9.68-4.13a4.47 4.47 0 0 1-.54-3.01l.14.09 4.8 2.77a.78.78 0 0 0 .78 0l5.85-3.38v2.34a.07.07 0 0 1-.03.06l-4.8 2.77a4.5 4.5 0 0 1-6.2-1.64ZM1.4 7.87a4.49 4.49 0 0 1 2.35-1.98v5.7a.77.77 0 0 0 .38.67l5.83 3.36-2.02 1.17a.07.07 0 0 1-.07 0L3.07 14a4.5 4.5 0 0 1-1.65-6.14Zm16.24 3.78L11.8 8.27l2.02-1.16a.07.07 0 0 1 .07 0l4.8 2.77a4.5 4.5 0 0 1-.7 8.12v-5.7a.78.78 0 0 0-.35-.65Zm2.01-3.03-.14-.09-4.79-2.79a.78.78 0 0 0-.79 0L8.09 9.12V6.78a.07.07 0 0 1 .03-.06l4.79-2.77a4.5 4.5 0 0 1 6.74 4.66Zm-12.6 4.16-2.02-1.16a.07.07 0 0 1-.04-.06V5.97a4.5 4.5 0 0 1 7.38-3.45l-.14.08-4.79 2.77a.79.79 0 0 0-.39.68v6.73Zm1.1-2.36 2.6-1.5 2.61 1.5v3l-2.6 1.5-2.61-1.5v-3Z" />
    </svg>
  );
}

/** GitHub's mark, which the Copilot CLI authenticates against. */
function CopilotIcon({ size }: { size: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.55v-1.93c-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.24 2.76.12 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.26 5.69.41.36.78 1.06.78 2.14v3.17c0 .3.2.66.79.55A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}
