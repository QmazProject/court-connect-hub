import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

const searchSchema = z.object({
  sport: z.string().optional(),
});

export const Route = createFileRoute("/venues/$venueId")({
  validateSearch: searchSchema,
  component: VenueDetail,
});

type FeeItem = { label: string; amount: number };
type Venue = {
  id: number;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  description: string | null;
  images: string[] | null;
  amenities: string[] | null;
  food_beverages: string[] | null;
  facility_services: string[] | null;
  fees: FeeItem[] | null;
  fees_notes: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  operating_hours_text: string | null;
  refund_cutoff_hours: number | null;
  cancellation_notes: string | null;
  rules: string | null;
};

type Court = {
  id: number;
  name: string;
  hourly_rate: number;
  is_indoor: boolean;
  description: string | null;
  amenities: string[] | null;
  images: string[] | null;
  coming_soon: boolean | null;
  sports: { name: string; slug: string } | null;
};

function VenueDetail() {
  const { venueId } = Route.useParams();
  const { sport } = Route.useSearch();
  const navigate = useNavigate({ from: "/venues/$venueId" });
  const [imgIdx, setImgIdx] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);


  const venueQ = useQuery({
    queryKey: ["venue", venueId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("venues")
        .select("id, name, address, latitude, longitude, description, images, amenities, food_beverages, facility_services, fees, fees_notes")
        .eq("id", Number(venueId))
        .maybeSingle();
      if (error) throw error;
      return data as unknown as Venue | null;
    },
  });

  const courtsQ = useQuery({
    queryKey: ["venue-courts", venueId, sport ?? "all"],
    queryFn: async () => {
      let q = supabase
        .from("courts")
        .select("id, name, hourly_rate, is_indoor, description, amenities, images, coming_soon, sports!inner(name, slug)")
        .eq("venue_id", Number(venueId))
        .order("coming_soon", { ascending: true })
        .order("id");
      if (sport) q = q.eq("sports.slug", sport);
      const { data, error } = await q;
      if (error) throw error;
      return data as unknown as Court[];
    },
  });

  const venue = venueQ.data;
  const courts = courtsQ.data ?? [];
  const images = venue?.images ?? [];
  const hasImages = images.length > 0;
  const currentImg = hasImages ? images[((imgIdx % images.length) + images.length) % images.length] : null;
  const prev = () => setImgIdx((i) => i - 1);
  const next = () => setImgIdx((i) => i + 1);

  return (
    <main className="pb-8 sm:pb-12">
      <section className="relative">
        {/* Image carousel — fully visible */}
        <div className="relative h-[280px] w-full overflow-hidden bg-muted sm:h-[380px] lg:h-[460px]">
          {currentImg ? (
            <button
              type="button"
              onClick={() => setLightboxOpen(true)}
              aria-label="View full size image"
              className="block h-full w-full cursor-zoom-in"
            >
              <img src={currentImg} alt={venue?.name ?? "Venue"} className="h-full w-full object-cover" />
            </button>
          ) : (
            <div className="court-pattern h-full w-full" />
          )}


          {hasImages && images.length > 1 && (
            <>
              <button
                onClick={prev}
                aria-label="Previous image"
                className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-background/90 p-2.5 text-foreground shadow-lg backdrop-blur transition hover:bg-background sm:left-5 sm:p-3"
              >
                <ChevronLeft className="h-5 w-5 sm:h-6 sm:w-6" />
              </button>
              <button
                onClick={next}
                aria-label="Next image"
                className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-background/90 p-2.5 text-foreground shadow-lg backdrop-blur transition hover:bg-background sm:right-5 sm:p-3"
              >
                <ChevronRight className="h-5 w-5 sm:h-6 sm:w-6" />
              </button>

              <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-1.5">
                {images.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setImgIdx(i)}
                    aria-label={`Go to image ${i + 1}`}
                    className={`h-1.5 rounded-full transition-all ${
                      i === ((imgIdx % images.length) + images.length) % images.length
                        ? "w-6 bg-primary"
                        : "w-1.5 bg-white/60 hover:bg-white/80"
                    }`}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Header content below the image */}
        <div className="mx-auto max-w-6xl px-5 pt-6 sm:px-6 sm:pt-8">
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
              {venue.description && (
                <p className="mt-3 max-w-2xl text-sm text-foreground/80">{venue.description}</p>
              )}
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
        </div>
      </section>


      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        {venue && (() => {
          const hasAmenities = (venue.amenities?.length ?? 0) > 0;
          const hasFB = (venue.food_beverages?.length ?? 0) > 0;
          const hasFS = (venue.facility_services?.length ?? 0) > 0;
          const feesList = Array.isArray(venue.fees) ? venue.fees : [];
          const hasFees = feesList.length > 0 || !!venue.fees_notes;
          const hasAny = hasAmenities || hasFB || hasFS || hasFees;
          if (!hasAny) return null;
          const Chips = ({ items }: { items: string[] }) => (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {items.map((v) => (
                <span key={v} className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">{v}</span>
              ))}
            </div>
          );
          return (
            <section className="mt-8 grid gap-4 sm:grid-cols-2">
              {hasAmenities && (
                <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Amenities</h3>
                  <Chips items={venue.amenities!} />
                </div>
              )}
              {hasFB && (
                <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Food & Beverages</h3>
                  <Chips items={venue.food_beverages!} />
                </div>
              )}
              {hasFS && (
                <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Facility Services</h3>
                  <Chips items={venue.facility_services!} />
                </div>
              )}
              {hasFees && (
                <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Fees & Charges</h3>
                  {feesList.length > 0 && (
                    <ul className="mt-2 divide-y divide-border">
                      {feesList.map((f, i) => (
                        <li key={i} className="flex items-center justify-between py-1.5 text-sm">
                          <span className="text-foreground">{f.label}</span>
                          <span className="font-semibold text-primary">₱{Number(f.amount).toFixed(2)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {venue.fees_notes && (
                    <p className="mt-3 whitespace-pre-line text-xs text-muted-foreground">{venue.fees_notes}</p>
                  )}
                </div>
              )}
            </section>
          );
        })()}

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
          {courts.map((c) => {
            const soon = !!c.coming_soon;
            const inner = (
              <>
                <div className="relative">
                  {c.images && c.images.length > 0 ? (
                    <img src={c.images[0]} alt={c.name} className={`h-32 w-full object-cover ${soon ? "opacity-70" : ""}`} />
                  ) : (
                    <div className={`court-pattern h-32 ${soon ? "opacity-70" : ""}`} />
                  )}
                  {soon && (
                    <span className="absolute left-3 top-3 rounded-full bg-amber-500 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white shadow">
                      Coming soon
                    </span>
                  )}
                </div>
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
                    {soon ? (
                      <span className="text-xs font-semibold text-amber-600">Opening soon</span>
                    ) : (
                      <span className="text-xs font-semibold text-primary opacity-0 transition group-hover:opacity-100">Book →</span>
                    )}
                  </div>
                </div>
              </>
            );
            const baseCls = "group overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition";
            return soon ? (
              <div key={c.id} className={`${baseCls} cursor-not-allowed`} aria-disabled>
                {inner}
              </div>
            ) : (
              <Link
                key={c.id}
                to="/courts/$courtId"
                params={{ courtId: String(c.id) }}
                className={`${baseCls} hover:shadow-md`}
              >
                {inner}
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-dashed border-border p-12 text-center">
          <p className="text-muted-foreground">No courts available at this venue{sport ? " for the selected sport" : ""}.</p>
        </div>
      )}
      </div>

      {lightboxOpen && currentImg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setLightboxOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <button
            onClick={() => setLightboxOpen(false)}
            aria-label="Close"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20"
          >
            <X className="h-6 w-6" />
          </button>
          {hasImages && images.length > 1 && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); prev(); }}
                aria-label="Previous image"
                className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20 sm:left-6"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); next(); }}
                aria-label="Next image"
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white transition hover:bg-white/20 sm:right-6"
              >
                <ChevronRight className="h-6 w-6" />
              </button>
            </>
          )}
          {hasImages && images.length > 1 && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-sm font-medium text-white backdrop-blur">
              {((imgIdx % images.length) + images.length) % images.length + 1} / {images.length}
            </div>
          )}
          <img
            src={currentImg}
            alt={venue?.name ?? "Venue"}
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </main>


  );
}
