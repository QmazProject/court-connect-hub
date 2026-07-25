import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, useRef, useEffect, useMemo, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, X, MapPin, Info, Phone, Clock, Sparkles, UtensilsCrossed, Wrench, Wallet, RotateCcw, ClipboardList, Navigation, Compass, CalendarDays } from "lucide-react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { MapPicker } from "@/components/MapPicker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";
import { CourtBookingPanel } from "@/components/CourtBookingPanel";

const searchSchema = z.object({
  sport: z.string().optional(),
  court: z.coerce.number().int().positive().optional(),
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
  operating_hours: Record<string, string> | null;
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
  const { sport, court: openCourtId } = Route.useSearch();
  const navigate = useNavigate({ from: "/venues/$venueId" });
  const openCourt = (id: number | null) =>
    navigate({ search: (prev: { sport?: string; court?: number }) => ({ ...prev, court: id ?? undefined }), replace: !id });
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
        .select("id, name, hourly_rate, is_indoor, description, amenities, images, coming_soon, operating_hours, sports!inner(name, slug)")
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
          label: "Operating Hours",
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

  const chipSubtitle = (key: ChipKey, venueName: string): string => {
    switch (key) {
      case "about": return `Get to know ${venueName}`;
      case "location": return "Where to find us";
      case "inquiries": return "Reach out to the venue";
      case "hours": return "When we're open for play";
      case "amenities": return "What's included on-site";
      case "fb": return "Food & drinks available";
      case "fs": return "Services offered here";
      case "fees": return "Additional charges to note";
      case "cancellation": return "Refund & cancellation policy";
      case "rules": return "Please follow these guidelines";
    }
  };

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
                <dd className="font-medium select-text">{venue.contact_phone}</dd>
              </div>
            )}
            {venue.contact_email && (() => {
              const email = venue.contact_email.trim();
              const isGmail = /@gmail\.com$/i.test(email);
              const href = isGmail
                ? `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}`
                : `mailto:${email}`;
              return (
                <div className="flex items-center justify-between gap-3">
                  <dt className="flex items-center gap-1.5 text-muted-foreground"><span aria-hidden>✉️</span>Email</dt>
                  <dd className="font-medium break-all">
                    <a
                      href={href}
                      target={isGmail ? "_blank" : undefined}
                      rel={isGmail ? "noreferrer" : undefined}
                      className="text-primary hover:underline"
                    >
                      {email}
                    </a>
                  </dd>
                </div>
              );
            })()}
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

      <ExploreCourts
        venue={venue ?? undefined}
        courts={courts}
        loading={courtsQ.isLoading}
        selectedSport={sport}
        onSelectSport={(slug) =>
          navigate({ to: "/venues/$venueId", params: { venueId }, search: slug ? { sport: slug } : {} })
        }
        onOpenCourt={(id) => openCourt(id)}
      />


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
            className="w-full max-w-lg overflow-hidden rounded-t-3xl bg-background shadow-2xl sm:rounded-2xl"
          >
            <div className="mx-auto mt-3 h-1 w-10 rounded-full bg-white/50 sm:hidden" />
            <div className="flex items-start justify-between gap-3 bg-gradient-to-br from-primary/25 via-primary/10 to-accent/20 px-5 py-4 sm:px-6 sm:py-5">
              <div className="flex items-start gap-3">
                <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md ring-2 ring-white/50 [&>svg]:h-5 [&>svg]:w-5">
                  {activeChip.icon}
                </span>
                <div>
                  <h2 className="text-lg font-bold leading-tight text-foreground">{activeChip.label}</h2>
                  <p className="mt-0.5 text-xs text-foreground/70">{chipSubtitle(activeChip.key, venue.name)}</p>
                </div>
              </div>
              <button
                onClick={() => setOpenChip(null)}
                aria-label="Close"
                className="rounded-full p-2 text-foreground/70 hover:bg-white/40 hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-[65vh] overflow-y-auto px-5 py-5 sm:px-6">
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

type ExploreCourtsProps = {
  venue: Venue | undefined;
  courts: Court[];
  loading: boolean;
  selectedSport: string | undefined;
  onSelectSport: (slug: string | null) => void;
  onOpenCourt: (id: number) => void;
};

function ExploreCourts({ venue, courts, loading, selectedSport, onSelectSport, onOpenCourt }: ExploreCourtsProps) {
  // ALL sports the system supports (system-wide list)
  const allSportsQ = useQuery({
    queryKey: ["all-sports"],
    queryFn: async () => {
      const { data, error } = await supabase.from("sports").select("name, slug").order("name");
      if (error) throw error;
      return (data ?? []) as { name: string; slug: string }[];
    },
  });

  // Sports actually offered at this venue (for the "supported here" badge + empty-state logic)
  const venueSportsQ = useQuery({
    queryKey: ["venue-sports", venue?.id],
    enabled: !!venue?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts")
        .select("sports!inner(slug)")
        .eq("venue_id", venue!.id);
      if (error) throw error;
      const set = new Set<string>();
      for (const row of (data ?? []) as unknown as { sports: { slug: string } | null }[]) {
        if (row.sports) set.add(row.sports.slug);
      }
      return set;
    },
  });

  const allSports = allSportsQ.data ?? [];
  const venueSportSlugs = venueSportsQ.data ?? new Set<string>();
  const noCourtsForSport =
    !!selectedSport && !loading && courts.length === 0;

  // Sidebar collapse (persisted)
  const [sportsCollapsed, setSportsCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("venue:sportsCollapsed") === "1";
  });
  useEffect(() => {
    try { window.localStorage.setItem("venue:sportsCollapsed", sportsCollapsed ? "1" : "0"); } catch {}
  }, [sportsCollapsed]);

  // Player location (with venue as fallback anchor)
  const [playerLoc, setPlayerLoc] = useState<{ lat: number; lng: number } | null>(null);
  const [geoDenied, setGeoDenied] = useState(false);
  const [locationModalOpen, setLocationModalOpen] = useState(false);
  const [manualPickerOpen, setManualPickerOpen] = useState(false);
  const [geoBusy, setGeoBusy] = useState(false);
  const [locResolved, setLocResolved] = useState(false); // user made a choice this session

  // When the player picks a sport not offered here, prompt them (once per session)
  // to share their location so we can rank nearby alternatives.
  useEffect(() => {
    if (!noCourtsForSport) return;
    if (playerLoc || geoDenied || locResolved) return;
    try {
      if (sessionStorage.getItem("venue:locPrompted") === "1") {
        setLocResolved(true);
        return;
      }
    } catch {}
    setLocationModalOpen(true);
  }, [noCourtsForSport, playerLoc, geoDenied, locResolved]);

  function markPrompted() {
    try { sessionStorage.setItem("venue:locPrompted", "1"); } catch {}
    setLocResolved(true);
  }

  function requestGeolocation() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoDenied(true);
      markPrompted();
      setLocationModalOpen(false);
      return;
    }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPlayerLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGeoBusy(false);
        markPrompted();
        setLocationModalOpen(false);
      },
      () => {
        setGeoDenied(true);
        setGeoBusy(false);
        markPrompted();
        setLocationModalOpen(false);
      },
      { timeout: 8000, maximumAge: 5 * 60 * 1000 }
    );
  }

  function skipLocation() {
    setGeoDenied(true);
    markPrompted();
    setLocationModalOpen(false);
  }

  const anchor = playerLoc ?? (venue?.latitude != null && venue?.longitude != null ? { lat: venue.latitude, lng: venue.longitude } : null);

  // Suggested venues elsewhere that offer the selected sport
  const suggestQ = useQuery({
    queryKey: ["suggest-venues", selectedSport, venue?.id],
    enabled: noCourtsForSport && !!selectedSport,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts")
        .select("venue_id, hourly_rate, sports!inner(slug), venues!inner(id, name, address, latitude, longitude, images, map_emoji, is_active)")
        .eq("sports.slug", selectedSport!)
        .eq("venues.is_active", true)
        .neq("venue_id", venue?.id ?? -1);
      if (error) throw error;
      const map = new Map<number, { id: number; name: string; address: string; lat: number | null; lng: number | null; images: string[]; emoji: string | null; minRate: number }>();
      for (const row of (data ?? []) as unknown as Array<{ venue_id: number; hourly_rate: number; venues: { id: number; name: string; address: string; latitude: number | null; longitude: number | null; images: string[] | null; map_emoji: string | null } }>) {
        const v = row.venues;
        const existing = map.get(v.id);
        if (existing) {
          existing.minRate = Math.min(existing.minRate, Number(row.hourly_rate));
        } else {
          map.set(v.id, {
            id: v.id,
            name: v.name,
            address: v.address,
            lat: v.latitude,
            lng: v.longitude,
            images: v.images ?? [],
            emoji: v.map_emoji,
            minRate: Number(row.hourly_rate),
          });
        }
      }
      return Array.from(map.values());
    },
  });

  const suggestions = useMemo(() => {
    const list = suggestQ.data ?? [];
    if (!anchor) return list.slice(0, 3).map((v) => ({ ...v, distanceKm: null as number | null }));
    return list
      .map((v) => ({
        ...v,
        distanceKm: v.lat != null && v.lng != null ? haversineKm(anchor, { lat: v.lat, lng: v.lng }) : null,
      }))
      .sort((a, b) => {
        if (a.distanceKm == null && b.distanceKm == null) return 0;
        if (a.distanceKm == null) return 1;
        if (b.distanceKm == null) return -1;
        return a.distanceKm - b.distanceKm;
      })
      .slice(0, 3);
  }, [suggestQ.data, anchor]);

  const selectedSportName = selectedSport ? allSports.find((s) => s.slug === selectedSport)?.name ?? selectedSport : null;

  // ---- Real-time availability for a selected date ----
  const todayStr = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
  }, []);
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);

  const bookableCourtIds = useMemo(
    () => courts.filter((c) => !c.coming_soon).map((c) => c.id),
    [courts]
  );

  const dayBounds = useMemo(() => {
    const start = new Date(`${selectedDate}T00:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { startISO: start.toISOString(), endISO: end.toISOString() };
  }, [selectedDate]);

  const bookingsQ = useQuery({
    queryKey: ["venue-day-bookings", venue?.id, selectedDate, bookableCourtIds.join(",")],
    enabled: bookableCourtIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bookings")
        .select("court_id, start_time, end_time, status")
        .in("court_id", bookableCourtIds)
        .eq("status", "confirmed")
        .lt("start_time", dayBounds.endISO)
        .gt("end_time", dayBounds.startISO);
      if (error) throw error;
      return (data ?? []) as { court_id: number; start_time: string; end_time: string }[];
    },
  });

  const weekdayKey = useMemo(() => {
    const d = new Date(`${selectedDate}T00:00:00`);
    return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d.getDay()];
  }, [selectedDate]);

  function parseOpHours(oh: Record<string, string> | null | undefined): [number, number] {
    const raw = oh?.[weekdayKey] ?? "00:00-24:00";
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(raw.trim());
    if (!m) return [0, 24];
    const start = Math.max(0, Math.min(24, parseInt(m[1], 10)));
    const end = Math.max(0, Math.min(24, parseInt(m[3], 10)));
    if (end <= start) return [0, 24];
    return [start, end];
  }

  const availability = useMemo(() => {
    const byCourt = new Map<number, { total: number; booked: number }>();
    const dayStart = new Date(`${selectedDate}T00:00:00`).getTime();
    for (const c of courts) {
      if (c.coming_soon) continue;
      const [oh0, oh1] = parseOpHours(c.operating_hours);
      const total = oh1 - oh0;
      const bookedSet = new Set<number>();
      for (const b of bookingsQ.data ?? []) {
        if (b.court_id !== c.id) continue;
        const s = Math.max(new Date(b.start_time).getTime(), dayStart + oh0 * 3600_000);
        const e = Math.min(new Date(b.end_time).getTime(), dayStart + oh1 * 3600_000);
        if (e <= s) continue;
        const startHr = Math.floor((s - dayStart) / 3600_000);
        const endHr = Math.ceil((e - dayStart) / 3600_000);
        for (let h = startHr; h < endHr; h++) bookedSet.add(h);
      }
      byCourt.set(c.id, { total, booked: Math.min(bookedSet.size, total) });
    }
    return byCourt;
  }, [courts, bookingsQ.data, selectedDate, weekdayKey]);

  const isPastDate = selectedDate < todayStr;


  return (
    <section className="mx-auto mt-10 max-w-6xl px-4 sm:mt-14 sm:px-6">
      {/* Heading */}
      <div className="text-center">
        <h2 className="font-display text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          Explore Our Courts at{" "}
          <span className="bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
            {venue?.name ?? "this venue"}
          </span>
        </h2>
        <p className="mx-auto mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
          Pick your game, book your slot, and play like it&apos;s your home court.
        </p>
      </div>

      {/* Sport chips (all breakpoints) */}
      {allSports.length > 0 && (
        <div className="mt-6">
          <div className="flex flex-wrap gap-2">
            <SportChip
              active={!selectedSport}
              emoji="✨"
              label="All"
              onClick={() => onSelectSport(null)}
            />
            {allSports.map((s) => (
              <SportChip
                key={s.slug}
                active={selectedSport === s.slug}
                emoji={SPORT_EMOJI[s.slug] ?? "🏟️"}
                label={s.name}
                offered={venueSportSlugs.has(s.slug)}
                onClick={() => onSelectSport(s.slug)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Date picker for real-time availability */}
      <div className="mt-6 rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-primary/10 p-2 text-primary">
              <CalendarDays className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold text-foreground">Check court availability</div>
              <p className="text-xs text-muted-foreground">Select a date to view real-time court availability.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(() => {
              const addDays = (base: string, n: number) => {
                const d = new Date(`${base}T00:00:00`);
                d.setDate(d.getDate() + n);
                const off = d.getTimezoneOffset();
                return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
              };
              const today = new Date(`${todayStr}T00:00:00`);
              const dow = today.getDay();
              const daysToSat = dow === 6 ? 0 : (6 - dow + 7) % 7;
              const thisWeekend = addDays(todayStr, daysToSat);
              const daysToNextMon = ((8 - dow) % 7) || 7;
              const nextWeek = addDays(todayStr, daysToNextMon);
              const tomorrow = addDays(todayStr, 1);
              const shortcuts: { label: string; value: string }[] = [
                { label: "Today", value: todayStr },
                { label: "Tomorrow", value: tomorrow },
                { label: "This weekend", value: thisWeekend },
                { label: "Next week", value: nextWeek },
              ];
              const activeShortcut = shortcuts.find((s) => s.value === selectedDate);
              const selectedD = new Date(`${selectedDate}T00:00:00`);
              const displayLabel = activeShortcut?.label ?? selectedD.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
              const minDate = new Date(`${todayStr}T00:00:00`);
              return (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:border-primary/50 focus:border-primary focus:outline-none"
                    >
                      <CalendarDays className="h-4 w-4 text-primary" />
                      {displayLabel}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-auto p-0 pointer-events-auto">
                    <div className="grid grid-cols-2 gap-1.5 border-b border-border p-2">
                      {shortcuts.map((s) => (
                        <button
                          key={s.label}
                          type="button"
                          onClick={() => setSelectedDate(s.value)}
                          className={cn(
                            "rounded-md px-3 py-1.5 text-xs font-medium text-center transition",
                            selectedDate === s.value
                              ? "bg-primary text-primary-foreground"
                              : "text-foreground hover:bg-muted"
                          )}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                    <Calendar
                      mode="single"
                      selected={selectedD}
                      onSelect={(d) => {
                        if (!d) return;
                        const off = d.getTimezoneOffset();
                        setSelectedDate(new Date(d.getTime() - off * 60000).toISOString().slice(0, 10));
                      }}
                      disabled={{ before: minDate }}
                      initialFocus
                      className={cn("p-3 pointer-events-auto")}
                    />
                  </PopoverContent>
                </Popover>
              );
            })()}
          </div>
        </div>
        {isPastDate && (
          <p className="mt-2 text-xs text-amber-600">This date is in the past — availability is read-only.</p>
        )}
      </div>

      <div className="mt-6">
        {/* Courts grid */}
        <div>



          {loading ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-48 animate-pulse rounded-2xl bg-muted" />
              ))}
            </div>
          ) : courts.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {courts.map((c) => {
                const soon = !!c.coming_soon;
                const avail = availability.get(c.id);
                const remaining = avail ? Math.max(avail.total - avail.booked, 0) : null;
                const pct = avail && avail.total > 0 ? Math.round((avail.booked / avail.total) * 100) : 0;
                const availTone =
                  remaining == null
                    ? "bg-muted text-muted-foreground"
                    : remaining === 0
                    ? "bg-red-100 text-red-700"
                    : remaining <= 2
                    ? "bg-amber-100 text-amber-700"
                    : "bg-emerald-100 text-emerald-700";
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
                      {!soon && (
                        <div className="mt-3 rounded-xl border border-border/70 bg-muted/40 p-2.5">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-medium text-foreground">
                              {bookingsQ.isLoading ? (
                                <span className="text-muted-foreground">Checking availability…</span>
                              ) : remaining == null ? (
                                <span className="text-muted-foreground">No hours today</span>
                              ) : remaining === 0 ? (
                                <span>Fully booked</span>
                              ) : (
                                <span>
                                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${availTone}`}>
                                    {remaining} hr{remaining === 1 ? "" : "s"} open
                                  </span>
                                </span>
                              )}
                            </span>
                            {avail && avail.total > 0 && (
                              <span className="text-muted-foreground">{avail.booked}/{avail.total} booked</span>
                            )}
                          </div>
                          {avail && avail.total > 0 && (
                            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background">
                              <div
                                className={`h-full transition-all ${pct >= 100 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-primary"}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          )}
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
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => openCourt(c.id)}
                    className={`${baseCls} text-left hover:shadow-md`}
                  >
                    {inner}
                  </button>
                );
              })}
            </div>
          ) : (
            <EmptySport
              sportName={selectedSportName}
              onClearFilter={() => onSelectSport(null)}
              suggestions={suggestions}
              suggestLoading={suggestQ.isLoading}
              usingPlayerLoc={!!playerLoc}
              anchorLabel={playerLoc ? "your location" : venue?.name ?? "this venue"}
            />
          )}
        </div>
      </div>

      {/* Location primer modal */}
      {locationModalOpen && (
        <div
          className="fixed inset-0 z-[900] flex items-end justify-center bg-black/50 p-4 backdrop-blur-sm sm:items-center"
          onClick={skipLocation}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-2xl bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative bg-gradient-to-br from-primary/15 via-primary/5 to-transparent px-6 pt-6 pb-4">
              <button
                type="button"
                onClick={skipLocation}
                className="absolute right-3 top-3 rounded-full p-1.5 text-muted-foreground hover:bg-muted"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">
                <Navigation className="h-6 w-6" />
              </div>
              <h3 className="mt-3 text-center font-display text-lg font-bold">
                Find {selectedSportName ?? "this sport"} near you
              </h3>
              <p className="mt-1 text-center text-sm text-muted-foreground">
                This venue doesn&apos;t offer {selectedSportName ?? "that sport"} yet.
                Share your location so we can rank the closest venues that do —
                or pick a spot on the map instead.
              </p>
            </div>

            <div className="space-y-2 px-6 py-4">
              <button
                type="button"
                onClick={requestGeolocation}
                disabled={geoBusy}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow transition hover:opacity-90 disabled:opacity-60"
              >
                <Navigation className="h-4 w-4" />
                {geoBusy ? "Getting your location…" : "Use my current location"}
              </button>
              <button
                type="button"
                onClick={() => { setLocationModalOpen(false); setManualPickerOpen(true); }}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-semibold hover:bg-muted"
              >
                <MapPin className="h-4 w-4" />
                Pick a spot on the map
              </button>
              <button
                type="button"
                onClick={skipLocation}
                className="w-full rounded-xl px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Skip — rank by this venue instead
              </button>
            </div>

            <p className="border-t border-border bg-muted/40 px-6 py-3 text-center text-[11px] text-muted-foreground">
              Your location is used only in your browser to sort nearby venues. It&apos;s never stored or shared.
            </p>
          </div>
        </div>
      )}

      <MapPicker
        open={manualPickerOpen}
        initialLat={venue?.latitude ?? null}
        initialLng={venue?.longitude ?? null}
        onClose={() => { setManualPickerOpen(false); markPrompted(); }}
        onSave={(lat, lng) => {
          setPlayerLoc({ lat, lng });
          setManualPickerOpen(false);
          markPrompted();
        }}
        title="Pick your location"
      />
    </section>
  );
}


function SportChip({ active, emoji, label, offered = true, onClick }: { active: boolean; emoji: string; label: string; offered?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={offered ? undefined : `Not offered here — tap to see nearby venues with ${label}`}
      className={`relative flex shrink-0 snap-start items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
        active
          ? "border-primary bg-primary text-primary-foreground shadow"
          : offered
            ? "border-border bg-card text-foreground hover:border-primary/50 hover:bg-primary/5"
            : "border-dashed border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground"
      }`}
    >
      <span aria-hidden>{emoji}</span>
      <span>{label}</span>
    </button>
  );
}

function SportItem({ active, emoji, label, offered = true, onClick, index = 0 }: { active: boolean; emoji: string; label: string; offered?: boolean; onClick: () => void; index?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={offered ? undefined : `Not offered here — tap to see nearby venues with ${label}`}
      style={{ animationDelay: `${50 + index * 45}ms` }}
      className={`sport-stagger group flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left transition-all duration-300 ${
        active
          ? "bg-primary/10 font-semibold text-foreground"
          : offered
            ? "text-muted-foreground hover:-translate-y-0.5 hover:translate-x-1 hover:bg-muted/60 hover:text-foreground"
            : "cursor-pointer text-muted-foreground/70 hover:bg-muted/40"
      }`}
    >
      <span className="flex items-center gap-3">
        <span
          aria-hidden
          className={`flex h-8 w-8 items-center justify-center rounded-lg text-base transition-all duration-300 ${
            active
              ? "bg-primary text-primary-foreground shadow-[0_0_15px_rgba(9,230,210,0.35)]"
              : offered
                ? "bg-transparent group-hover:scale-110 group-hover:bg-primary/10"
                : "opacity-70 grayscale group-hover:grayscale-0"
          }`}
        >
          {emoji}
        </span>
        <span className="text-sm">{label}</span>
      </span>
      {!offered && !active && (
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          Nearby
        </span>
      )}
    </button>
  );
}



function EmptySport({
  sportName,
  onClearFilter,
  suggestions,
  suggestLoading,
  usingPlayerLoc,
  anchorLabel,
}: {
  sportName: string | null;
  onClearFilter: () => void;
  suggestions: Array<{ id: number; name: string; address: string; images: string[]; emoji: string | null; minRate: number; distanceKm: number | null }>;
  suggestLoading: boolean;
  usingPlayerLoc: boolean;
  anchorLabel: string;
}) {
  const count = suggestions.length;
  const closest = suggestions[0];
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card/50 p-6 sm:p-8">
      <div className="text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Compass className="h-6 w-6" />
        </div>
        <h3 className="mt-3 text-lg font-semibold">
          No {sportName ?? "courts"} at this venue yet
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          But don't worry — {sportName ?? "this sport"} is available at other venues on CourtHub.
        </p>

        {!suggestLoading && count > 0 && (
          <div className="mx-auto mt-4 max-w-md rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-left">
            <p className="text-sm font-semibold text-foreground">
              ✅ Found {count} nearby {count === 1 ? "venue" : "venues"} offering {sportName}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {usingPlayerLoc
                ? "Sorted by distance from your current location."
                : `Sorted by distance from ${anchorLabel}.`}
              {closest?.distanceKm != null && (
                <>
                  {" "}Closest is <span className="font-medium text-foreground">{closest.name}</span>
                  {" "}·{" "}
                  {closest.distanceKm < 1
                    ? `${Math.round(closest.distanceKm * 1000)} m away`
                    : `${closest.distanceKm.toFixed(1)} km away`}
                  {" "}· from ₱{closest.minRate.toFixed(0)}/hr.
                </>
              )}
            </p>
          </div>
        )}

        <button
          type="button"
          onClick={onClearFilter}
          className="mt-4 text-xs font-semibold text-primary hover:underline"
        >
          Or view all courts at this venue →
        </button>
      </div>


      {suggestLoading ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : suggestions.length > 0 ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {suggestions.map((v) => (
            <Link
              key={v.id}
              to="/venues/$venueId"
              params={{ venueId: String(v.id) }}
              className="group flex gap-3 rounded-xl border border-border bg-background p-3 shadow-sm transition hover:border-primary/40 hover:shadow-md"
            >
              <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg bg-muted">
                {v.images[0] ? (
                  <img src={v.images[0]} alt={v.name} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-2xl">{v.emoji ?? "🏟️"}</div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground group-hover:text-primary">{v.name}</p>
                <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                  <MapPin className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">{v.address}</span>
                </p>
                <div className="mt-1.5 flex items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-primary">from ₱{v.minRate.toFixed(0)}/hr</span>
                  {v.distanceKm != null && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">
                      <Navigation className="h-3 w-3" />
                      {v.distanceKm < 1 ? `${Math.round(v.distanceKm * 1000)} m` : `${v.distanceKm.toFixed(1)} km`}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <p className="mt-6 text-center text-sm text-muted-foreground">
          No venues offering {sportName ?? "this sport"} yet in your area — check back soon.
        </p>
      )}
    </div>
  );
}

