/**
 * One colour per sport, shared by every calendar in the app.
 *
 * Lifted out of the tenant dashboard so the player workspace can use the same
 * palette without importing that route — dashboard.tsx is ~5,700 lines and pulls in
 * the PayMongo and refund server functions, and dragging it into the player's module
 * graph is the exact cost `PlayerWorkspace` was split out to avoid.
 *
 * A player's calendar and the venue's calendar therefore agree on what colour
 * badminton is, which is the point: someone looking at both should not have to
 * re-learn the legend.
 */

export type SportStyle = { bg: string; dot: string; text: string; border: string };

export const SPORT_COLORS: Record<string, SportStyle> = {
  tennis: { bg: "bg-emerald-100", dot: "bg-emerald-500", text: "text-emerald-900", border: "border-emerald-200" },
  basketball: { bg: "bg-amber-100", dot: "bg-amber-500", text: "text-amber-900", border: "border-amber-200" },
  badminton: { bg: "bg-sky-100", dot: "bg-sky-500", text: "text-sky-900", border: "border-sky-200" },
  volleyball: { bg: "bg-violet-100", dot: "bg-violet-500", text: "text-violet-900", border: "border-violet-200" },
  pickleball: { bg: "bg-pink-100", dot: "bg-pink-500", text: "text-pink-900", border: "border-pink-200" },
  football: { bg: "bg-lime-100", dot: "bg-lime-500", text: "text-lime-900", border: "border-lime-200" },
  squash: { bg: "bg-rose-100", dot: "bg-rose-500", text: "text-rose-900", border: "border-rose-200" },
  default: { bg: "bg-slate-100", dot: "bg-slate-500", text: "text-slate-900", border: "border-slate-200" },
};

/** Colour for a sport slug. Unknown sports fall back to slate rather than to no
 *  colour at all — an uncoloured block reads as a different kind of thing. */
export function sportStyle(slug?: string | null): SportStyle {
  if (!slug) return SPORT_COLORS.default;
  return SPORT_COLORS[slug.toLowerCase()] ?? SPORT_COLORS.default;
}
