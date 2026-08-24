import {
  rateCardGroups,
  rateInBounds,
  fmtHour12,
  peso,
  type RateRule,
  type PriceBounds,
} from "@/lib/court-pricing";
import { type HoursMap } from "@/lib/operating-hours";

/** "₱25/hr and up", "up to ₱500/hr", "₱25–500/hr" — how the active filter reads
 *  back to the person who typed it. */
function describeBounds({ min, max }: PriceBounds) {
  if (min != null && max != null) return `₱${min}–${max}/hr`;
  if (min != null) return `₱${min}/hr and up`;
  return `up to ₱${max}/hr`;
}

/** The court's price per hour laid out day-group by day-group.
 *
 *  Shared by the booking panel and the explore sidebar so the two can never
 *  disagree about what a court charges. `variant` only swaps the palette:
 *  "light" sits on the app's card surfaces, "dark" on the explore panel's
 *  teal-and-lime tiles.
 *
 *  Pass `highlight` to answer "why is this court in my results?" — the hours whose
 *  rate falls inside the filter stay lit and the rest recede, so a ₱20 morning
 *  visibly drops out while the ₱38 evening that earned the match stands out. */
export function RateCard({
  baseRate,
  rules,
  hours = null,
  variant = "light",
  highlight = null,
  className = "",
}: {
  baseRate: number;
  rules: RateRule[];
  /** The court's schedule. Given one, only bookable hours are listed — the base
   *  rate stops appearing for hours the court is shut. */
  hours?: HoursMap | null;
  variant?: "light" | "dark";
  highlight?: PriceBounds | null;
  className?: string;
}) {
  const dark = variant === "dark";
  const groups = rateCardGroups(baseRate, rules, hours);
  // An all-null bound is the same as no filter — don't dim every band for it.
  const bounds = highlight && (highlight.min != null || highlight.max != null) ? highlight : null;

  const bandClass = (rate: number) => {
    const base = "rounded-md px-2 py-0.5 text-[10px] font-medium transition-opacity ";
    if (!bounds) {
      return (
        base +
        (dark
          ? "border border-white/15 bg-white/5 text-white/85"
          : "border border-border bg-background")
      );
    }
    if (rateInBounds(rate, bounds)) {
      return (
        base +
        (dark
          ? "border border-[#b8f05a]/60 bg-[#b8f05a]/15 font-semibold text-[#b8f05a]"
          : "border border-primary/60 bg-primary/10 font-semibold text-primary")
      );
    }
    return (
      base +
      (dark
        ? "border border-white/10 bg-transparent text-white/30"
        : "border border-border/50 bg-transparent text-muted-foreground/50")
    );
  };

  return (
    <div
      className={
        (dark
          ? "rounded-xl border border-[#b8f05a]/30 bg-[#09231f] p-3"
          : "rounded-xl border border-primary/30 bg-primary/5 p-3") +
        (className ? ` ${className}` : "")
      }
    >
      <div
        className={
          "text-[11px] font-semibold uppercase tracking-wider " +
          (dark ? "text-[#b8f05a]" : "text-primary")
        }
      >
        Rate card
      </div>
      {groups.map((g) => (
        <div key={g.label} className="mt-1.5">
          <div
            className={
              "text-[10px] font-semibold uppercase tracking-wide " +
              (dark ? "text-white/50" : "text-muted-foreground")
            }
          >
            {g.label}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {g.bands.map((b) => (
              <span
                key={`${g.label}-${b.start}`}
                className={bandClass(b.rate)}
                title={
                  bounds && !rateInBounds(b.rate, bounds)
                    ? `Outside your ${describeBounds(bounds)} filter`
                    : undefined
                }
              >
                {fmtHour12(b.start)}–{fmtHour12(b.end % 24)} · <b>{peso(b.rate)}</b>
              </span>
            ))}
          </div>
        </div>
      ))}
      <p className={"mt-1.5 text-[10px] " + (dark ? "text-white/50" : "text-muted-foreground")}>
        {bounds
          ? `Highlighted hours match your ${describeBounds(bounds)} filter. Each hour is charged at its own rate; your total adds them up.`
          : "Each hour is charged at its own rate; your total adds them up."}
      </p>
    </div>
  );
}
