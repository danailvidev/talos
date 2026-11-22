export interface SlackActivityChange {
  userId: string;
  conversationId?: string;
}

type Listener = (change: SlackActivityChange) => void;

/** In-process fan-out from SQLite activity writes to authenticated SSE clients. */
export class SlackActivityEventHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  publish(change: SlackActivityChange): void {
    for (const listener of this.listeners.get(change.userId) ?? []) listener(change);
  }

  activeUserIds(): string[] {
    return [...this.listeners.entries()]
      .filter(([, listeners]) => listeners.size > 0)
      .map(([userId]) => userId);
  }

  stream(
    userId: string,
    signal: AbortSignal,
    snapshot: (conversationIds: string[]) => unknown,
  ): Response {
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (conversationIds: string[]) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(snapshot(conversationIds))}\n\n`),
          );
        };
        const listener: Listener = (change) =>
          send(change.conversationId ? [change.conversationId] : []);
        let listeners = this.listeners.get(userId);
        if (!listeners) {
          listeners = new Set();
          this.listeners.set(userId, listeners);
        }
        listeners.add(listener);
        send([]);

        const heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        }, 20_000);
        cleanup = () => {
          clearInterval(heartbeat);
          listeners!.delete(listener);
          if (listeners!.size === 0) this.listeners.delete(userId);
          try {
            controller.close();
          } catch {
            // The browser already closed the stream.
          }
        };
        signal.addEventListener("abort", cleanup, { once: true });
      },
      cancel: () => cleanup(),
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "private, no-store",
        connection: "keep-alive",
        vary: "Cookie",
        "x-accel-buffering": "no",
      },
    });
  }
}
