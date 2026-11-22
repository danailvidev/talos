/**
 * Whatever was thrown, as a line a person can read.
 *
 * `catch` binds `unknown`, and every write in this app ended up spelling the same
 * coercion out by hand — 44 copies of it, which is 44 chances for one of them to
 * print "[object Object]" on the day the forge returns something that isn't an
 * `Error`.
 */
export function toMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  // A rejected fetch or a thrown response object: `String()` on it would give
  // "[object Object]", which tells the reader nothing at all.
  if (cause && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(cause);
}
