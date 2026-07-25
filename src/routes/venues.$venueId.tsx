import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, useRef, useEffect, useMemo, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, X, MapPin, Info, Phone, Clock, Sparkles, UtensilsCrossed, Wrench, Wallet, RotateCcw, ClipboardList, Navigation, Compass } from "lucide-react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

const searchSchema = z.object({
  sport: z.string().optional(),
});

const SPORT_EMOJI: Record<string, string> = {
  badminton: "🏸",
  basketball: "🏀",
  football: "⚽",
  pickleball: "🥎",
  squash: "🏟️",
  tennis: "🎾",
  volleyball: "🏐",
};

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

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

type ChipKey =
  | "about"
  | "location"
  | "inquiries"
  | "hours"
  | "amenities"
  | "fb"
  | "fs"
  | "fees"
  | "cancellation"
  | "rules";

function VenueDetail() {
  const { venueId } = Route.useParams();
  const { sport } = Route.useSearch();
  const navigate = useNavigate({ from: "/venues/$venueId" });
  const [imgIdx, setImgIdx] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [openChip, setOpenChip] = useState<ChipKey | null>(null);
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const [panelHidden, setPanelHidden] = useState(false);

  const venueQ = useQuery({
    queryKey: ["venue", venueId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("venues")
        .select("id, name, address, latitude, longitude, description, images, amenities, food_beverages, facility_services, fees, fees_notes, contact_phone, contact_email, operating_hours_text, refund_cutoff_hours, cancellation_notes, rules")
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

  const feesList: FeeItem[] = Array.isArray(venue?.fees) ? (venue!.fees as FeeItem[]) : [];
  const rulesList = (venue?.rules ?? "")
    .split(/\r?\n/)
    .map((s) => s.replace(/^\s*[-•]\s*/, "").trim())
    .filter(Boolean);

  const chips: { key: ChipKey; icon: ReactNode; label: string; preview: string; show: boolean }[] = venue
    ? [
        {
          key: "about",
          icon: <Info className="h-4 w-4" />,
          label: "About",
          preview: venue.description ?? "",
          show: !!venue.description,
        },
        {
          key: "location",
          icon: <MapPin className="h-4 w-4" />,
          label: "Location",
          preview: venue.address,
          show: !!venue.address,
        },
        {
          key: "inquiries",
          icon: <Phone className="h-4 w-4" />,
          label: "Inquiries",
          preview: venue.contact_phone ?? venue.contact_email ?? "",
          show: !!(venue.contact_phone || venue.contact_email),
        },
        {
          key: "hours",
          icon: <Clock className="h-4 w-4" />,
          label: "Hours",
          preview: (venue.operating_hours_text ?? "").split(/\r?\n/)[0] ?? "",
          show: !!venue.operating_hours_text,
        },
        {
          key: "amenities",
          icon: <Sparkles className="h-4 w-4" />,
          label: "Amenities",
          preview: `${venue.amenities?.length ?? 0} items`,
          show: (venue.amenities?.length ?? 0) > 0,
        },
        {
          key: "fb",
          icon: <UtensilsCrossed className="h-4 w-4" />,
          label: "Food & Beverages",
          preview: `${venue.food_beverages?.length ?? 0} items`,
          show: (venue.food_beverages?.length ?? 0) > 0,
        },
        {
          key: "fs",
          icon: <Wrench className="h-4 w-4" />,
          label: "Facility Services",
          preview: `${venue.facility_services?.length ?? 0} items`,
          show: (venue.facility_services?.length ?? 0) > 0,
        },
        {
          key: "fees",
          icon: <Wallet className="h-4 w-4" />,
          label: "Fees & Charges",
          preview: feesList.length > 0 ? `${feesList.length} listed` : "See details",
          show: feesList.length > 0 || !!venue.fees_notes,
        },
        {
          key: "cancellation",
          icon: <RotateCcw className="h-4 w-4" />,
          label: "Cancellation",
          preview:
            venue.refund_cutoff_hours != null
              ? venue.refund_cutoff_hours > 0
                ? `Cancel up to ${venue.refund_cutoff_hours}h before`
                : "Last-minute allowed"
              : "See policy",
          show: venue.refund_cutoff_hours != null || !!venue.cancellation_notes,
        },
        {
          key: "rules",
          icon: <ClipboardList className="h-4 w-4" />,
          label: "Rules",
          preview: `${rulesList.length} rules`,
          show: rulesList.length > 0,
        },
      ]
    : [];

  const visibleChips = chips.filter((c) => c.show);

  const scrollChips = (dir: 1 | -1) => {
    const el = chipsRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.min(el.clientWidth * 0.8, 400), behavior: "smooth" });
  };

  const CheckList = ({ items }: { items: string[] }) => (
    <ul className="mt-1 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {items.map((v) => (
        <li key={v} className="flex items-start gap-2 text-sm text-foreground">
          <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3">
              <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 111.4-1.4l3.8 3.8 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
            </svg>
          </span>
          <span>{v}</span>
        </li>
      ))}
    </ul>
  );

  const renderChipModalBody = (key: ChipKey): ReactNode => {
    if (!venue) return null;
    switch (key) {
      case "about":
        return <p className="whitespace-pre-line text-sm leading-relaxed text-foreground">{venue.description}</p>;
      case "location":
        return (
          <div className="space-y-3">
            <p className="text-sm text-foreground">{venue.address}</p>
            {venue.latitude != null && venue.longitude != null && (
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${venue.latitude},${venue.longitude}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
              >
                View on Google Maps →
              </a>
            )}
          </div>
        );
      case "inquiries":
        return (
          <dl className="space-y-2 text-sm">
            {venue.contact_phone && (
              <div className="flex items-center justify-between gap-3">
                <dt className="flex items-center gap-1.5 text-muted-foreground"><span aria-hidden>📱</span>Phone</dt>
                <dd className="font-medium">
                  <a href={`tel:${venue.contact_phone}`} className="hover:text-primary">{venue.contact_phone}</a>
                </dd>
              </div>
            )}
            {venue.contact_email && (
              <div className="flex items-center justify-between gap-3">
                <dt className="flex items-center gap-1.5 text-muted-foreground"><span aria-hidden>✉️</span>Email</dt>
                <dd className="font-medium">
                  <a href={`mailto:${venue.contact_email}`} className="hover:text-primary">{venue.contact_email}</a>
                </dd>
              </div>
            )}
          </dl>
        );
      case "hours":
        return <p className="whitespace-pre-line text-sm text-foreground">{venue.operating_hours_text}</p>;
      case "amenities":
        return <CheckList items={venue.amenities ?? []} />;
      case "fb":
        return <CheckList items={venue.food_beverages ?? []} />;
      case "fs":
        return <CheckList items={venue.facility_services ?? []} />;
      case "fees":
        return (
          <div>
            {feesList.length > 0 && (
              <ul className="divide-y divide-border">
                {feesList.map((f, i) => (
                  <li key={i} className="flex items-center justify-between py-2 text-sm">
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
        );
      case "cancellation":
        return (
          <div className="space-y-2 text-sm">
            {venue.refund_cutoff_hours != null && (
              <p className="text-foreground">
                {venue.refund_cutoff_hours > 0
                  ? <>Cancel up to <span className="font-semibold text-primary">{venue.refund_cutoff_hours}h</span> before start time.</>
                  : <>Last-minute cancellations allowed.</>}
              </p>
            )}
            {venue.cancellation_notes && (
              <p className="whitespace-pre-line text-xs text-muted-foreground">{venue.cancellation_notes}</p>
            )}
          </div>
        );
      case "rules":
        return (
          <ul className="space-y-1.5 text-sm text-foreground">
            {rulesList.map((r, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3">
                    <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 111.4-1.4l3.8 3.8 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
                  </svg>
                </span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        );
    }
  };

  const activeChip = visibleChips.find((c) => c.key === openChip) ?? null;

  return (
    <main className="pb-8 sm:pb-12">
      <section className="relative">
        {/* Image carousel */}
        <div className="relative h-[320px] w-full overflow-hidden bg-muted sm:h-[440px] lg:h-[520px]">
          {currentImg ? (
            <button
              type="button"
              onClick={() => setLightboxOpen(true)}
              onMouseEnter={() => setPanelHidden(true)}
              onMouseLeave={() => setPanelHidden(false)}
              aria-label="View full size image"
              className="block h-full w-full cursor-zoom-in"
            >
              <img src={currentImg} alt={venue?.name ?? "Venue"} className="h-full w-full object-cover" />
            </button>
          ) : (
            <div className="court-pattern h-full w-full" />
          )}

          {/* Gradient scrim for readability */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />

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

              <div className="absolute right-4 top-4 z-10 rounded-full bg-black/50 px-2.5 py-1 text-xs font-medium text-white backdrop-blur">
                {((imgIdx % images.length) + images.length) % images.length + 1} / {images.length}
              </div>
            </>
          )}

          {/* Back button overlaid */}
          <button
            onClick={() => navigate({ to: "/", search: sport ? { sport } : {} })}
            className="absolute left-3 top-3 z-10 rounded-full bg-background/90 px-3 py-1.5 text-xs font-medium text-foreground shadow backdrop-blur hover:bg-background sm:left-5 sm:top-5 sm:text-sm"
          >
            ← Back
          </button>

          {/* Bottom overlay panel — compact glass */}
          {venue && (
            <div
              className={`absolute inset-x-0 bottom-0 z-10 transition-all duration-300 ease-out ${panelHidden ? "pointer-events-none translate-y-4 opacity-0" : "translate-y-0 opacity-100"}`}
              onMouseEnter={() => setPanelHidden(false)}
            >
              <div className="mx-auto max-w-5xl px-3 pb-3 sm:px-6 sm:pb-4">
                <div className="rounded-xl border border-white/25 bg-black/35 px-3 py-2 shadow-lg ring-1 ring-white/10 backdrop-blur-xl backdrop-saturate-150 sm:px-4 sm:py-2.5">
                  {/* Identity + nav */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h1 className="truncate text-sm font-semibold text-white drop-shadow sm:text-base">{venue.name}</h1>
                      <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-white/75 sm:text-xs">
                        <MapPin className="h-3 w-3 flex-shrink-0" />
                        <span className="truncate">{venue.address}</span>
                      </p>
                    </div>
                    {visibleChips.length > 3 && (
                      <div className="hidden shrink-0 gap-1 sm:flex">
                        <button
                          type="button"
                          onClick={() => scrollChips(-1)}
                          aria-label="Scroll left"
                          className="rounded-full border border-white/20 bg-white/10 p-1 text-white transition hover:bg-white/20"
                        >
                          <ChevronLeft className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => scrollChips(1)}
                          aria-label="Scroll right"
                          className="rounded-full border border-white/20 bg-white/10 p-1 text-white transition hover:bg-white/20"
                        >
                          <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Chips row */}
                  {visibleChips.length > 0 && (
                    <div
                      ref={chipsRef}
                      className="mt-2 flex snap-x snap-mandatory gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                    >
                      {visibleChips.map((c) => (
                        <button
                          key={c.key}
                          type="button"
                          onClick={() => setOpenChip(c.key)}
                          className="group flex shrink-0 snap-start items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-2.5 py-1.5 text-left text-white transition hover:border-primary/60 hover:bg-white/20"
                        >
                          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary/30 text-primary-foreground [&>svg]:h-3 [&>svg]:w-3">
                            {c.icon}
                          </span>
                          <span className="text-[11px] font-medium tracking-wide">{c.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-4 sm:px-6">
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

      {/* Chip detail modal */}
      {activeChip && venue && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
          onClick={() => setOpenChip(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-t-3xl bg-background p-5 shadow-2xl sm:rounded-2xl sm:p-6"
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted sm:hidden" />
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/15 text-primary">
                  {activeChip.icon}
                </span>
                <h2 className="text-lg font-bold">{activeChip.label}</h2>
              </div>
              <button
                onClick={() => setOpenChip(null)}
                aria-label="Close"
                className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-[65vh] overflow-y-auto">
              {renderChipModalBody(activeChip.key)}
            </div>
          </div>
        </div>
      )}

      {/* Lightbox */}
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

      {venueQ.isLoading && (
        <div className="mx-auto mt-6 max-w-6xl px-4">
          <div className="h-24 animate-pulse rounded-2xl bg-muted" />
        </div>
      )}
      {!venueQ.isLoading && !venue && (
        <div className="mx-auto mt-6 max-w-6xl px-4">
          <p className="text-muted-foreground">Venue not found.</p>
        </div>
      )}
    </main>
  );
}
