import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

const searchSchema = z.object({
  sport: z.string().optional(),
});

export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  component: Landing,
});

type CourtRow = {
  id: number;
  name: string;
  hourly_rate: number;
  is_indoor: boolean;
  sports: { name: string; slug: string } | null;
  venues: { name: string; address: string } | null;
};

type Sport = { id: number; name: string; slug: string };

const SPORT_ICONS: Record<string, string> = {
  basketball: "🏀",
  tennis: "🎾",
  badminton: "🏸",
  football: "⚽",
  soccer: "⚽",
  volleyball: "🏐",
  pickleball: "🥎",
  "table-tennis": "🏓",
  squash: "🎯",
};

function Landing() {
  const { sport } = Route.useSearch();
  const navigate = useNavigate({ from: "/" });

  const { data: sports } = useQuery({
    queryKey: ["sports"],
    queryFn: async () => {
      const { data, error } = await supabase.from("sports").select("id, name, slug").order("name");
      if (error) throw error;
      return data as Sport[];
    },
  });

  const { data: courts, isLoading } = useQuery({
    queryKey: ["courts", "public", sport ?? "all"],
    queryFn: async () => {
      let q = supabase
        .from("courts")
        .select("id, name, hourly_rate, is_indoor, venue_id, sports!inner(name, slug), venues(id, name, address)")
        .order("id", { ascending: false })
        .limit(200);
      if (sport) q = q.eq("sports.slug", sport);
      const { data, error } = await q;
      if (error) throw error;
      return data as unknown as (CourtRow & { venue_id: number; venues: { id: number; name: string; address: string } | null })[];
    },
    enabled: !!sport,
  });


  // Venue search (always available on landing)
  const [venueQuery, setVenueQuery] = useState("");
  const [venueFocus, setVenueFocus] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setVenueFocus(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);
  const { data: venueMatches } = useQuery({
    queryKey: ["venue-search", venueQuery.trim().toLowerCase()],
    queryFn: async () => {
      const term = venueQuery.trim();
      if (!term) return [] as { id: number; name: string; address: string }[];
      const { data, error } = await supabase
        .from("venues")
        .select("id, name, address")
        .ilike("name", `%${term}%`)
        .order("name")
        .limit(8);
      if (error) throw error;
      return data as { id: number; name: string; address: string }[];
    },
    enabled: venueQuery.trim().length > 0,
  });

  // Sport picker view
  if (!sport) {
    return (
      <main>
        <section className="relative overflow-hidden border-b border-border/60">
          <div className="court-pattern absolute inset-0 opacity-[0.08]" aria-hidden />
          <div className="relative mx-auto max-w-5xl px-6 py-20 text-center md:py-28">
            <div className="flex flex-col items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
                <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_10px_theme(colors.primary)]" />
                Premium Sports Hub
              </span>
              <h2 className="font-display text-4xl font-extrabold leading-[1.05] tracking-tight md:text-6xl">
                <span className="bg-gradient-to-r from-primary via-primary to-foreground bg-clip-text text-transparent">
                  Dedicated Court
                </span>{" "}
                <span className="text-foreground">Facility</span>
              </h2>
              <p className="mx-auto max-w-2xl text-base text-muted-foreground md:text-lg">
                Book premium courts in seconds — real-time availability, transparent pricing, zero hassle.
              </p>
            </div>


            <div ref={searchRef} className="relative mx-auto mt-6 max-w-xl">
              <div className="flex items-center gap-2 rounded-full border border-border bg-card px-5 py-3 shadow-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
                <span className="text-muted-foreground" aria-hidden>🔍</span>
                <input
                  type="text"
                  value={venueQuery}
                  onChange={(e) => setVenueQuery(e.target.value)}
                  onFocus={() => setVenueFocus(true)}
                  placeholder="Tap to find a venue you want"
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
              {venueFocus && venueQuery.trim() && (
                <div className="absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-2xl border border-border bg-card text-left shadow-lg">
                  {venueMatches && venueMatches.length > 0 ? (
                    venueMatches.map((v) => (
                      <Link
                        key={v.id}
                        to="/venues/$venueId"
                        params={{ venueId: String(v.id) }}
                        search={{}}
                        className="block border-b border-border/60 px-4 py-3 last:border-b-0 hover:bg-secondary"
                        onClick={() => setVenueFocus(false)}
                      >
                        <div className="text-sm font-semibold">{v.name}</div>
                        <div className="text-xs text-muted-foreground">{v.address}</div>
                      </Link>
                    ))
                  ) : (
                    <div className="px-4 py-3 text-sm text-muted-foreground">No venues match "{venueQuery}".</div>
                  )}
                </div>
              )}
            </div>

            <div className="mt-10 inline-flex items-center rounded-full bg-accent/20 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-accent-foreground">
              Play more · Manage less
            </div>
            <h1 className="mt-5 text-5xl font-bold leading-[1.05] md:text-6xl">
              What are you <span className="text-primary">playing today?</span>
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-lg text-muted-foreground">
              Pick a sport to see courts available near you.
            </p>

            <div className="mt-12 grid gap-4 sm:grid-cols-2 md:grid-cols-3">
              {(sports ?? []).map((s) => (
                <button
                  key={s.id}
                  onClick={() => navigate({ search: { sport: s.slug } })}
                  className="group flex flex-col items-center gap-3 rounded-2xl border border-border bg-card p-8 shadow-sm transition hover:-translate-y-1 hover:border-primary hover:shadow-lg"
                >
                  <span className="text-5xl transition group-hover:scale-110">
                    {SPORT_ICONS[s.slug] ?? "🏟️"}
                  </span>
                  <span className="text-lg font-semibold">{s.name}</span>
                </button>
              ))}
              {!sports && Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-40 animate-pulse rounded-2xl bg-muted" />
              ))}
            </div>

            <div className="mt-12 flex flex-wrap justify-center gap-3">
              <Link
                to="/auth"
                search={{ mode: "signup", as: "player" }}
                className="rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
              >
                Join as a player
              </Link>
              <Link
                to="/auth"
                search={{ mode: "signup", as: "tenant" }}
                className="rounded-lg border border-border bg-card px-6 py-3 text-sm font-semibold text-foreground transition hover:bg-secondary"
              >
                List your venue
              </Link>
            </div>
          </div>
        </section>
      </main>
    );
  }

  // Filtered courts view
  const activeSport = sports?.find((s) => s.slug === sport);

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <button
        onClick={() => navigate({ search: {} })}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← Choose a different sport
      </button>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <span className="text-4xl">{SPORT_ICONS[sport] ?? "🏟️"}</span>
            <h1 className="text-3xl font-bold">{activeSport?.name ?? "Courts"}</h1>
          </div>
          <p className="mt-1 text-muted-foreground">Available courts for {activeSport?.name.toLowerCase() ?? sport}.</p>
        </div>
        {sports && sports.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {sports.map((s) => (
              <button
                key={s.id}
                onClick={() => navigate({ search: { sport: s.slug } })}
                className={
                  "rounded-full border px-3 py-1.5 text-xs font-semibold transition " +
                  (s.slug === sport
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card hover:border-primary")
                }
              >
                {SPORT_ICONS[s.slug] ?? "•"} {s.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-48 animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
      ) : courts && courts.length > 0 ? (
        (() => {
          const grouped = new Map<number, { venue: { id: number; name: string; address: string }; courts: typeof courts }>();
          for (const c of courts) {
            if (!c.venues) continue;
            const v = c.venues;
            const g = grouped.get(v.id) ?? { venue: v, courts: [] as typeof courts };
            g.courts.push(c);
            grouped.set(v.id, g);
          }
          const venues = Array.from(grouped.values());
          return (
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {venues.map(({ venue, courts: vCourts }) => {
                const minRate = Math.min(...vCourts.map((c) => Number(c.hourly_rate)));
                const indoor = vCourts.some((c) => c.is_indoor);
                const outdoor = vCourts.some((c) => !c.is_indoor);
                return (
                  <Link
                    key={venue.id}
                    to="/venues/$venueId"
                    params={{ venueId: String(venue.id) }}
                    search={{ sport }}
                    className="group overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition hover:shadow-md"
                  >
                    <div className="court-pattern h-32" />
                    <div className="p-5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="rounded-full bg-primary/15 px-2 py-1 font-semibold text-primary">
                          {vCourts.length} {vCourts.length === 1 ? "court" : "courts"}
                        </span>
                        <span className="text-muted-foreground">
                          {indoor && outdoor ? "Indoor & Outdoor" : indoor ? "Indoor" : "Outdoor"}
                        </span>
                      </div>
                      <h3 className="mt-3 text-lg font-semibold">{venue.name}</h3>
                      <p className="text-sm text-muted-foreground">{venue.address}</p>
                      <div className="mt-4 flex items-baseline justify-between">
                        <div>
                          <span className="text-xs text-muted-foreground">From </span>
                          <span className="text-2xl font-bold text-primary">₱{minRate.toFixed(0)}</span>
                          <span className="text-sm text-muted-foreground"> / hour</span>
                        </div>
                        <span className="text-xs font-semibold text-primary opacity-0 transition group-hover:opacity-100">View courts →</span>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          );
        })()

      ) : (
        <div className="mt-8 rounded-2xl border border-dashed border-border p-12 text-center">
          <p className="text-muted-foreground">No {activeSport?.name.toLowerCase() ?? ""} courts listed yet.</p>
          <button
            onClick={() => navigate({ search: {} })}
            className="mt-4 text-sm font-semibold text-primary hover:underline"
          >
            ← Try another sport
          </button>
        </div>
      )}
    </main>
  );
}
