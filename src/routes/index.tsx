import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
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

function Landing() {
  const { data: courts, isLoading } = useQuery({
    queryKey: ["courts", "public"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts")
        .select("id, name, hourly_rate, is_indoor, sports(name, slug), venues(name, address)")
        .order("id", { ascending: false })
        .limit(24);
      if (error) throw error;
      return data as unknown as CourtRow[];
    },
  });

  return (
    <main>
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-border/60">
        <div className="court-pattern absolute inset-0 opacity-[0.08]" aria-hidden />
        <div className="relative mx-auto grid max-w-6xl gap-10 px-6 py-20 md:grid-cols-2 md:py-28">
          <div>
            <span className="inline-flex items-center rounded-full bg-accent/20 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-accent-foreground">
              Play more · Manage less
            </span>
            <h1 className="mt-5 text-5xl font-bold leading-[1.05] md:text-6xl">
              Find your court.<br />
              <span className="text-primary">Grow your venue.</span>
            </h1>
            <p className="mt-5 max-w-lg text-lg text-muted-foreground">
              CourtHub is the fastest way for players to discover local courts and for
              venue owners to list rates, hours and availability in minutes.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
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
          <div className="relative hidden md:block">
            <div className="court-pattern aspect-[4/5] w-full rounded-3xl shadow-2xl ring-1 ring-border/60" />
            <div className="absolute -bottom-6 -left-6 rounded-2xl border border-border bg-card px-5 py-4 shadow-xl">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Now on CourtHub</div>
              <div className="mt-1 text-2xl font-bold">{courts?.length ?? 0} courts</div>
            </div>
          </div>
        </div>
      </section>

      {/* Courts */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-3xl font-bold">Browse courts</h2>
            <p className="mt-1 text-muted-foreground">Fresh listings from CourtHub venues.</p>
          </div>
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
                      <span className="text-2xl font-bold text-primary">${Number(c.hourly_rate).toFixed(0)}</span>
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
            <p className="text-muted-foreground">No courts listed yet.</p>
            <Link to="/auth" search={{ mode: "signup", as: "tenant" }} className="mt-4 inline-block text-sm font-semibold text-primary hover:underline">
              Be the first tenant to list a court →
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}
