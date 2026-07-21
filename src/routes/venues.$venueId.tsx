import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

const searchSchema = z.object({
  sport: z.string().optional(),
});

export const Route = createFileRoute("/venues/$venueId")({
  validateSearch: searchSchema,
  component: VenueDetail,
});

type Venue = {
  id: number;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
};

type Court = {
  id: number;
  name: string;
  hourly_rate: number;
  is_indoor: boolean;
  description: string | null;
  amenities: string[] | null;
  images: string[] | null;
  sports: { name: string; slug: string } | null;
};

function VenueDetail() {
  const { venueId } = Route.useParams();
  const { sport } = Route.useSearch();
  const navigate = useNavigate({ from: "/venues/$venueId" });

  const venueQ = useQuery({
    queryKey: ["venue", venueId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("venues")
        .select("id, name, address, latitude, longitude")
        .eq("id", Number(venueId))
        .maybeSingle();
      if (error) throw error;
      return data as Venue | null;
    },
  });

  const courtsQ = useQuery({
    queryKey: ["venue-courts", venueId, sport ?? "all"],
    queryFn: async () => {
      let q = supabase
        .from("courts")
        .select("id, name, hourly_rate, is_indoor, description, amenities, images, sports!inner(name, slug)")
        .eq("venue_id", Number(venueId))
        .order("id");
      if (sport) q = q.eq("sports.slug", sport);
      const { data, error } = await q;
      if (error) throw error;
      return data as unknown as Court[];
    },
  });

  const venue = venueQ.data;
  const courts = courtsQ.data ?? [];

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <button
        onClick={() => navigate({ to: "/", search: sport ? { sport } : {} })}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← Back to venues
      </button>

      {venueQ.isLoading ? (
        <div className="mt-6 h-24 animate-pulse rounded-2xl bg-muted" />
      ) : venue ? (
        <div className="mt-4">
          <h1 className="text-3xl font-bold sm:text-4xl">{venue.name}</h1>
          <p className="mt-1 text-muted-foreground">{venue.address}</p>
          {venue.latitude != null && venue.longitude != null && (
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${venue.latitude},${venue.longitude}`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
            >
              View on Google Maps →
            </a>
          )}
        </div>
      ) : (
        <p className="mt-6 text-muted-foreground">Venue not found.</p>
      )}

      <h2 className="mt-8 text-xl font-bold">
        {sport ? "Courts for this sport" : "All courts"}{" "}
        <span className="text-muted-foreground">({courts.length})</span>
      </h2>

      {courtsQ.isLoading ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-48 animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
      ) : courts.length > 0 ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {courts.map((c) => (
            <Link
              key={c.id}
              to="/courts/$courtId"
              params={{ courtId: String(c.id) }}
              className="group overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition hover:shadow-md"
            >
              {c.images && c.images.length > 0 ? (
                <img src={c.images[0]} alt={c.name} className="h-32 w-full object-cover" />
              ) : (
                <div className="court-pattern h-32" />
              )}
              <div className="p-5">
                <div className="flex items-center justify-between text-xs">
                  <span className="rounded-full bg-secondary px-2 py-1 font-medium text-secondary-foreground">
                    {c.sports?.name ?? "Sport"}
                  </span>
                  <span className="text-muted-foreground">{c.is_indoor ? "Indoor" : "Outdoor"}</span>
                </div>
                <h3 className="mt-3 text-lg font-semibold">{c.name}</h3>
                {c.description && (
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{c.description}</p>
                )}
                {c.amenities && c.amenities.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {c.amenities.slice(0, 3).map((a) => (
                      <span key={a} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {a}
                      </span>
                    ))}
                  </div>
                )}
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
        <div className="mt-4 rounded-2xl border border-dashed border-border p-12 text-center">
          <p className="text-muted-foreground">No courts available at this venue{sport ? " for the selected sport" : ""}.</p>
        </div>
      )}
    </main>
  );
}
