/**
 * A signed-in person's profile picture, for the dark navigation rail.
 *
 * Shared by both shells because the avatar belongs to a *user account*, not to a
 * role: a venue manager and a player store their picture in the same bucket, under
 * the same `auth.uid()`-scoped path, and it renders the same way. Venue imagery is a
 * separate thing entirely and does not come through here.
 */

import { initialsOf } from "@/lib/avatar";
import { cn } from "@/lib/utils";

export function UserAvatar({
  avatarUrl,
  fullName,
  className = "h-8 w-8",
  fallback = "U",
  title,
}: {
  avatarUrl?: string | null;
  fullName?: string;
  className?: string;
  /** Shown when there is no name to take initials from. */
  fallback?: string;
  title?: string;
}) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        title={title}
        /* `object-cover` so a non-square upload is cropped to the circle rather than
           squashed — the same treatment the Settings preview gives it. */
        className={cn("shrink-0 rounded-full border border-white/25 object-cover", className)}
      />
    );
  }
  return (
    <span
      title={title}
      className={cn(
        "grid shrink-0 place-items-center rounded-full border border-white/25 bg-white/10 font-display text-[11px] font-bold text-[#b8f05a]",
        className,
      )}
    >
      {initialsOf(fullName, fallback)}
    </span>
  );
}
