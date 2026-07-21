import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
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
  pickleball: "🎾",
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
        .select("id, name, hourly_rate, is_indoor, sports!inner(name, slug), venues(name, address)")
        .order("id", { ascending: false })
        .limit(48);
      if (sport) q = q.eq("sports.slug", sport);
      const { data, error } = await q;
      if (error) throw error;
      return data as unknown as CourtRow[];
    },
    enabled: !!sport,
  });

  // Sport picker view
  if (!sport) {
    return (
      <main>
        <section className="relative overflow-hidden border-b border-border/60">
          <div className="court-pattern absolute inset-0 opacity-[0.08]" aria-hidden />
          <div className="relative mx-auto max-w-5xl px-6 py-20 text-center md:py-28">
            <span className="inline-flex items-center rounded-full bg-accent/20 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-accent-foreground">
              Play more · Manage less
            </span>
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
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {courts.map((c) => (
            <Link
              key={c.id}
              to="/courts/$courtId"
              params={{ courtId: String(c.id) }}
              className="group overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition hover:shadow-md"
            >
              <div className="court-pattern h-32" />
              <div className="p-5">
                <div className="flex items-center justify-between text-xs">
                  <span className="rounded-full bg-secondary px-2 py-1 font-medium text-secondary-foreground">
                    {c.sports?.name ?? "Sport"}
                  </span>
                  <span className="text-muted-foreground">{c.is_indoor ? "Indoor" : "Outdoor"}</span>
                </div>
                <h3 className="mt-3 text-lg font-semibold">{c.name}</h3>
                <p className="text-sm text-muted-foreground">{c.venues?.name} · {c.venues?.address}</p>
                <div className="mt-4 flex items-baseline justify-between">
                  <div>
                    <span className="text-2xl font-bold text-primary">₱{Number(c.hourly_rate).toFixed(0)}</span>
                    <span className="text-sm text-muted-foreground"> / hour</span>
                  </div>
                  <span className="text-xs font-semibold text-primary opacity-0 transition group-hover:opacity-100">Book →</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
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
