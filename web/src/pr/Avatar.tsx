import { useState } from "react";

import type { PullRequestUserView } from "../api.ts";
import { cn } from "../lib/utils.ts";

/**
 * A person's avatar, ahead of their name — the visual cue a reviewer already uses
 * to spot "whose work is this" on the forge itself.
 *
 * Falls back to initials rather than hiding: GitLab returns an `avatar_url` for
 * every user including its own generated default, so a missing one here means the
 * image failed to load, not that the person has none.
 */
export function UserAvatar({
  user,
  size,
  className,
}: {
  user: PullRequestUserView;
  size: number;
  className?: string;
}) {
  const [brokenUrl, setBrokenUrl] = useState<string>();

  if (user.avatarUrl && user.avatarUrl !== brokenUrl) {
    return (
      <img
        className={cn("shrink-0 rounded-full object-cover", className)}
        src={user.avatarUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setBrokenUrl(user.avatarUrl)}
      />
    );
  }

  const initial = (user.name ?? user.username).trim().charAt(0).toUpperCase();
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--bg-muted)] font-sans text-xs font-bold text-[var(--text-faint)]",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {initial}
    </span>
  );
}

/** Name plus avatar, the way every list of people on the pane renders. */
export function UserChip({ user, size = 18 }: { user: PullRequestUserView; size?: number }) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-[5px] overflow-hidden text-ellipsis whitespace-nowrap"
      title={user.username}
    >
      <UserAvatar user={user} size={size} />
      {user.name ?? user.username}
    </span>
  );
}
