import { Heart } from "lucide-react";
import { useFavoriteCourtIds, useFavoriteToggle } from "@/lib/favorites";

/**
 * The heart that marks one court as a favorite.
 *
 * Meant to sit on top of a court tile, so it stops the click from reaching whatever
 * the tile itself does — on the venue page that is "open the court images", in the
 * favorites list it is "go book this court", and neither is what a player pressing
 * the heart is asking for.
 *
 * It renders nothing for a signed-out visitor. Favorites are stored per account, so
 * an offer to save one is an offer we cannot keep until they sign in.
 *
 * Hidden until hover on a pointer device, always visible on touch (where there is no
 * hover to reveal it) and always visible once the court is favorited — a mark that
 * disappears when you move the mouse away is not a mark.
 */
export function FavoriteButton({
  courtId,
  courtName,
  userId,
  className = "",
}: {
  courtId: number;
  courtName?: string;
  userId?: string | null;
  className?: string;
}) {
  const idsQ = useFavoriteCourtIds(userId ?? undefined);
  const toggle = useFavoriteToggle(userId ?? undefined);

  if (!userId) return null;

  const on = idsQ.data?.has(courtId) ?? false;
  const what = courtName ?? "this court";
  const label = on ? `Remove ${what} from favorites` : `Save ${what} to favorites`;

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={label}
      disabled={toggle.isPending}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle.mutate({ courtId, favorite: !on });
      }}
      className={
        "z-10 grid h-9 w-9 place-items-center rounded-full bg-black/45 text-white shadow-lg backdrop-blur-sm transition " +
        "hover:bg-black/70 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 " +
        "active:scale-95 disabled:opacity-60 " +
        (on
          ? "text-rose-400 "
          : "opacity-0 max-md:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 ") +
        className
      }
    >
      <Heart className={"h-4.5 w-4.5 " + (on ? "fill-current" : "")} />
    </button>
  );
}
