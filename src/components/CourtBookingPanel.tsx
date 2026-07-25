import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { startBookingCheckout } from "@/lib/paymongo.functions";
import { useIsMobile } from "@/hooks/use-mobile";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { X } from "lucide-react";

type Court = {
  id: number;
  name: string;
  hourly_rate: number;
  is_indoor: boolean;
  operating_hours: Record<string, string>;
  blocked_hours: Record<string, number[]> | null;
  blocked_dates: Record<string, number[]> | null;
  description: string | null;
  amenities: string[] | null;
  images: string[] | null;
  coming_soon: boolean | null;
  capacity: number;
  physical_court_id: number;
  sports: { name: string } | null;
  venues: {
    name: string;
    address: string;
    timezone: string;
    latitude: number | null;
    longitude: number | null;
    payment_mode: "none" | "full" | "downpayment_50";
    refund_cutoff_hours: number;
  } | null;
};

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function toISODate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayISO() {
  return toISODate(new Date());
}
function shiftISO(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}
function fmtHour(h: number) {
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${period}`;
}

type PmMethod = "gcash" | "paymaya" | "grab_pay" | "qrph";
const PM_METHODS: { key: PmMethod; label: string; emoji: string }[] = [
  { key: "gcash", label: "GCash", emoji: "💙" },
  { key: "paymaya", label: "Maya", emoji: "💚" },
  { key: "grab_pay", label: "GrabPay", emoji: "🟢" },
  { key: "qrph", label: "QR Ph", emoji: "🔳" },
];

export function CourtBookingContent({ courtId, onClose }: { courtId: number; onClose?: () => void }) {
  const qc = useQueryClient();
  const [date, setDate] = useState(todayISO());
  const [selected, setSelected] = useState<number[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [payLoading, setPayLoading] = useState<PmMethod | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [carouselIdx, setCarouselIdx] = useState(0);

  const courtQ = useQuery({
    queryKey: ["court", courtId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts")
        .select(
          "id, name, hourly_rate, is_indoor, operating_hours, blocked_hours, blocked_dates, description, amenities, images, coming_soon, capacity, physical_court_id, sports(name), venues(name, address, timezone, latitude, longitude, payment_mode, refund_cutoff_hours)",
        )
        .eq("id", courtId)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as Court | null;
    },
  });

  const dayStart = useMemo(() => new Date(`${date}T00:00:00`), [date]);
  const dayEnd = useMemo(() => new Date(`${date}T23:59:59`), [date]);

  const availQ = useQuery({
    queryKey: ["avail", courtId, date],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_court_availability", {
        _court_id: courtId,
        _from: dayStart.toISOString(),
        _to: dayEnd.toISOString(),
      });
      if (error) throw error;
      const map = new Map<number, { remaining: number; blockedByOther: boolean }>();
      (data ?? []).forEach((row: { hour_start: string; remaining: number; blocked_by_other_sport: boolean }) => {
        const h = new Date(row.hour_start).getHours();
        map.set(h, { remaining: row.remaining, blockedByOther: row.blocked_by_other_sport });
      });
      return map;
    },
    enabled: !!courtQ.data,
  });

  const bookMut = useMutation({
    mutationFn: async (hours: number[]) => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Please sign in to book a court.");
      const sorted = [...hours].sort((a, b) => a - b);
      const rows = sorted.map((hour) => {
        const start = new Date(`${date}T${String(hour).padStart(2, "0")}:00:00`);
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        return {
          court_id: courtId,
          user_id: userData.user!.id,
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          status: "confirmed",
        };
      });
      const { error } = await supabase.from("bookings").insert(rows);
      if (error) throw error;
    },
    onSuccess: () => {
      setSelected([]);
      setErr(null);
      qc.invalidateQueries({ queryKey: ["avail", courtId, date] });
    },
    onError: (e: Error) => {
      if (/exclusion|overlap|conflict/i.test(e.message)) {
        setErr("One of those hours was just taken. Pick another slot.");
        qc.invalidateQueries({ queryKey: ["avail", courtId, date] });
      } else {
        setErr(e.message);
      }
    },
  });

  if (courtQ.isLoading) {
    return <div className="p-6"><div className="h-40 animate-pulse rounded-2xl bg-muted" /></div>;
  }
  if (!courtQ.data) {
    return (
      <div className="p-6 text-center">
        <h1 className="text-xl font-bold">Court not found</h1>
      </div>
    );
  }

  const court = courtQ.data;
  const dow = DAY_KEYS[new Date(`${date}T00:00:00`).getDay()];
  const dateOverride = court.blocked_dates?.[date];
  const blocked = new Set<number>(dateOverride ?? court.blocked_hours?.[dow] ?? []);
  const slots: number[] = Array.from({ length: 24 }, (_, i) => i);
  const capacity = Math.max(1, court.capacity ?? 1);
  const slotInfo = (hour: number) => availQ.data?.get(hour) ?? { remaining: capacity, blockedByOther: false };
  const isBooked = (hour: number) => slotInfo(hour).remaining <= 0 && !slotInfo(hour).blockedByOther;
  const isBlockedBySport = (hour: number) => slotInfo(hour).blockedByOther;
  const isBlocked = (hour: number) => blocked.has(hour);
  const isPast = (hour: number) => {
    const slotStart = new Date(`${date}T${String(hour).padStart(2, "0")}:00:00`).getTime();
    return slotStart < Date.now();
  };

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-card/95 px-5 py-4 backdrop-blur">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full bg-secondary px-2 py-0.5 font-medium">{court.sports?.name}</span>
            <span className="text-muted-foreground">{court.is_indoor ? "Indoor" : "Outdoor"}</span>
          </div>
          <h1 className="mt-1 truncate font-display text-xl font-bold">{court.name}</h1>
          <p className="truncate text-xs text-muted-foreground">{court.venues?.name} · {court.venues?.address}</p>
        </div>
        <div className="flex items-start gap-2">
          <div className="text-right">
            <div className="text-xl font-bold text-primary">₱{Number(court.hourly_rate).toFixed(0)}</div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">per hour</div>
          </div>
          {onClose && (
            <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-muted-foreground hover:bg-muted">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        {court.coming_soon && (
          <section className="mb-5 rounded-2xl border-2 border-amber-500/40 bg-amber-500/10 p-5 text-center">
            <span className="inline-block rounded-full bg-amber-500 px-3 py-1 text-xs font-bold uppercase tracking-wider text-white">
              Coming soon
            </span>
            <h2 className="mt-3 text-lg font-bold">This court isn&apos;t open for booking yet</h2>
            <p className="mt-1 text-sm text-muted-foreground">Check back soon.</p>
          </section>
        )}

        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Court images
            </h2>
            {(court.images?.length ?? 0) > 0 && (
              <span className="text-xs text-muted-foreground">
                {carouselIdx + 1} / {court.images!.length}
              </span>
            )}
          </div>
          {(court.images?.length ?? 0) === 0 ? (
            <div className="flex h-56 w-full flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/40 text-center sm:h-72">
              <svg className="h-10 w-10 text-muted-foreground/60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="m21 15-5-5L5 21" />
              </svg>
              <p className="mt-2 text-sm font-medium text-muted-foreground">No image set</p>
              <p className="text-xs text-muted-foreground/80">The tenant hasn&apos;t uploaded photos for this court yet.</p>
            </div>
          ) : (
            <>
              <div className="relative overflow-hidden rounded-xl border border-border bg-muted">
                <button
                  type="button"
                  onClick={() => setLightbox(carouselIdx)}
                  className="block w-full"
                  aria-label="Enlarge image"
                >
                  <img
                    src={court.images![carouselIdx]}
                    alt={`${court.name} photo ${carouselIdx + 1}`}
                    className="h-56 w-full object-cover sm:h-72"
                    loading="lazy"
                  />
                </button>
                {court.images!.length > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={() => setCarouselIdx((carouselIdx - 1 + court.images!.length) % court.images!.length)}
                      className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
                      aria-label="Previous image"
                    >‹</button>
                    <button
                      type="button"
                      onClick={() => setCarouselIdx((carouselIdx + 1) % court.images!.length)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
                      aria-label="Next image"
                    >›</button>
                  </>
                )}
              </div>
              {court.images!.length > 1 && (
                <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                  {court.images!.map((src, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setCarouselIdx(i)}
                      className={"flex-shrink-0 overflow-hidden rounded-lg border-2 transition " + (i === carouselIdx ? "border-primary" : "border-transparent opacity-70 hover:opacity-100")}
                      aria-label={`Show image ${i + 1}`}
                    >
                      <img src={src} alt="" className="h-14 w-20 object-cover" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </section>


        {(court.description || (court.amenities?.length ?? 0) > 0) && (
          <section className="mb-5 rounded-2xl border border-border bg-card p-4">
            {court.description && (
              <>
                <h2 className="text-sm font-semibold">About this court</h2>
                <p className="mt-1.5 whitespace-pre-line text-sm text-muted-foreground">{court.description}</p>
              </>
            )}
            {(court.amenities?.length ?? 0) > 0 && (
              <>
                <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Amenities</h3>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {court.amenities!.map((a) => (
                    <li key={a} className="rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs font-medium">
                      {a}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}

        {!court.coming_soon && (
          <section className="rounded-2xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold">Pick a time</h2>
              <div className="flex flex-wrap items-center gap-1.5 text-sm">
                <button
                  type="button"
                  onClick={() => { setDate(shiftISO(date, -1)); setSelected([]); setErr(null); }}
                  className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs font-semibold hover:border-primary hover:text-primary"
                  aria-label="Previous day"
                >← Prev</button>
                <button
                  type="button"
                  onClick={() => { setDate(todayISO()); setSelected([]); setErr(null); }}
                  className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs font-semibold hover:border-primary hover:text-primary"
                >Today</button>
                <button
                  type="button"
                  onClick={() => { setDate(shiftISO(date, 1)); setSelected([]); setErr(null); }}
                  className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs font-semibold hover:border-primary hover:text-primary"
                  aria-label="Next day"
                >Next →</button>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => { setDate(e.target.value); setSelected([]); setErr(null); }}
                  className="rounded-lg border border-input bg-background px-2 py-1.5 text-xs"
                />
              </div>
            </div>

            <p className="mt-2 text-xs text-muted-foreground">Tap multiple hours to book them together.</p>

            <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-green-500/50 bg-green-200" /> Available</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-yellow-500/60 bg-yellow-300" /> Selected</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-red-500/50 bg-red-300" /> Booked</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-amber-400/60 bg-amber-200/60" /> Unavailable</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-orange-500/50 bg-orange-300" /> Past</span>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-1.5 sm:grid-cols-4">
              {slots.map((h) => {
                const info = slotInfo(h);
                const otherSport = isBlockedBySport(h);
                const booked = isBooked(h);
                const blockedSlot = isBlocked(h);
                const past = isPast(h);
                const disabled = booked || blockedSlot || past || otherSport;
                const active = selected.includes(h);
                const label = blockedSlot ? "Unavailable" : otherSport ? "Other sport" : booked ? "Full" : past ? "Past" : capacity > 1 ? `${info.remaining}/${capacity} left` : "";
                const stateClass = active
                  ? "border-yellow-500 bg-yellow-300 text-yellow-950"
                  : booked
                    ? "cursor-not-allowed border-red-500/50 bg-red-300 text-red-900"
                    : otherSport
                      ? "cursor-not-allowed border-purple-400/60 bg-purple-200/60 text-purple-900"
                      : blockedSlot
                        ? "cursor-not-allowed border-amber-400/60 bg-amber-200/60 text-amber-900"
                        : past
                          ? "cursor-not-allowed border-orange-500/50 bg-orange-300 text-orange-900"
                          : "border-green-500/50 bg-green-200 text-green-900 hover:border-green-600 hover:bg-green-300";
                return (
                  <button
                    key={h}
                    disabled={disabled}
                    onClick={() => {
                      setErr(null);
                      setSelected((prev) =>
                        prev.includes(h) ? prev.filter((x) => x !== h) : [...prev, h].sort((a, b) => a - b),
                      );
                    }}
                    title={otherSport ? "Booked for a different sport" : label}
                    className={"flex flex-col items-center rounded-lg border px-1.5 py-1.5 text-xs font-medium transition " + stateClass}
                  >
                    <span className={"text-[11px] leading-tight " + (disabled ? "line-through" : "")}>{fmtHour(h)}</span>
                    {label && <span className="mt-0.5 text-[9px] uppercase tracking-wide">{label}</span>}
                  </button>
                );
              })}
            </div>

            {err && <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

            <div className="mt-4 border-t border-border pt-3">
              <div className="text-sm text-muted-foreground">
                {selected.length > 0
                  ? <>Selected <span className="font-semibold text-foreground">{selected.length} hr{selected.length > 1 ? "s" : ""}</span> · Total <span className="font-semibold text-foreground">₱{(Number(court.hourly_rate) * selected.length).toFixed(0)}</span></>
                  : "Choose one or more hours."}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {selected.length > 0 && (
                  <button
                    onClick={() => setSelected([])}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold hover:border-primary hover:text-primary"
                  >
                    Clear
                  </button>
                )}
                <button
                  disabled={selected.length === 0 || bookMut.isPending}
                  onClick={() => {
                    if (selected.length === 0) return;
                    const mode = court.venues?.payment_mode ?? "none";
                    if (mode === "none") {
                      bookMut.mutate(selected);
                    } else {
                      setErr(null);
                      setCheckoutOpen(true);
                    }
                  }}
                  className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {bookMut.isPending
                    ? "Booking…"
                    : court.venues?.payment_mode && court.venues.payment_mode !== "none"
                      ? `Continue to payment${selected.length > 1 ? ` (${selected.length} hrs)` : ""}`
                      : `Confirm booking${selected.length > 1 ? ` (${selected.length} hrs)` : ""}`}
                </button>
              </div>

              <p className="mt-2 text-xs text-muted-foreground">
                {court.venues?.payment_mode === "full" && "Full payment required online to reserve the slot."}
                {court.venues?.payment_mode === "downpayment_50" && "50% downpayment online; balance settled on-site."}
                {(!court.venues?.payment_mode || court.venues.payment_mode === "none") && "Payment handled at the venue."}
              </p>
            </div>
          </section>
        )}
      </div>

      {checkoutOpen && (
        <CheckoutDrawer
          courtId={courtId}
          date={date}
          hours={selected}
          hourlyRate={Number(court.hourly_rate)}
          paymentMode={court.venues?.payment_mode ?? "full"}
          venueName={court.venues?.name ?? "CourtHub"}
          courtName={court.name}
          onClose={() => { setCheckoutOpen(false); setPayLoading(null); }}
          payLoading={payLoading}
          setPayLoading={setPayLoading}
          onError={(m) => { setErr(m); setCheckoutOpen(false); }}
        />
      )}

      {lightbox !== null && court.images && court.images[lightbox] && (
        <div
          className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/90 p-4"
          onClick={() => setLightbox(null)}
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setLightbox(null); }}
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
          {lightbox > 0 && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setLightbox(lightbox - 1); }}
              className="absolute left-4 rounded-full bg-white/10 p-3 text-white hover:bg-white/20"
              aria-label="Previous"
            >‹</button>
          )}
          <img
            src={court.images[lightbox]}
            alt={`${court.name} photo ${lightbox + 1}`}
            className="max-h-[85vh] max-w-[92vw] rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          {lightbox < court.images.length - 1 && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setLightbox(lightbox + 1); }}
              className="absolute right-4 rounded-full bg-white/10 p-3 text-white hover:bg-white/20"
              aria-label="Next"
            >›</button>
          )}
          <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-white">
            {lightbox + 1} / {court.images.length}
          </span>
        </div>
      )}
    </div>
  );
}

export function CourtBookingPanel({
  courtId,
  open,
  onOpenChange,
}: {
  courtId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();

  if (!courtId) return null;

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="h-[92vh] p-0">
          <CourtBookingContent courtId={courtId} onClose={() => onOpenChange(false)} />
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full max-w-xl overflow-hidden p-0 pl-9 sm:max-w-xl"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 z-20 flex w-11 items-center justify-center border-r border-border bg-gradient-to-b from-indigo-600 via-fuchsia-600 to-rose-500 shadow-[inset_-6px_0_12px_-8px_rgba(0,0,0,0.35)]"
        >
          <span
            className="whitespace-nowrap font-display text-[17px] font-extrabold uppercase italic tracking-[0.4em] text-white drop-shadow-[0_1px_6px_rgba(0,0,0,0.45)] [writing-mode:vertical-rl] [transform:rotate(180deg)]"
          >
            Court Profile
          </span>
        </div>
        <CourtBookingContent courtId={courtId} onClose={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}

function CheckoutDrawer({
  courtId, date, hours, hourlyRate, paymentMode, venueName, courtName,
  onClose, payLoading, setPayLoading, onError,
}: {
  courtId: number; date: string; hours: number[]; hourlyRate: number;
  paymentMode: "full" | "downpayment_50" | "none"; venueName: string; courtName: string;
  onClose: () => void; payLoading: PmMethod | null;
  setPayLoading: (m: PmMethod | null) => void;
  onError: (m: string) => void;
}) {
  const fullAmount = hourlyRate * hours.length;
  const dueNow = paymentMode === "downpayment_50" ? fullAmount * 0.5 : fullAmount;

  const pay = async (method: PmMethod) => {
    setPayLoading(method);
    try {
      const res = await startBookingCheckout({
        data: { courtId, date, hours, method, origin: window.location.origin },
      });
      window.location.href = res.checkoutUrl;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Payment could not be started";
      onError(msg);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 sm:items-center">
      <div className="w-full max-w-md rounded-t-2xl border border-border bg-card p-6 shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold">Choose payment method</h2>
            <p className="mt-1 text-xs text-muted-foreground">{venueName} · {courtName}</p>
          </div>
          <button onClick={onClose} className="rounded-full p-1 text-muted-foreground hover:bg-secondary" aria-label="Close">✕</button>
        </div>

        <div className="mt-4 rounded-xl bg-secondary/50 p-3 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Hours</span><span>{hours.length}</span></div>
          <div className="mt-1 flex justify-between"><span className="text-muted-foreground">Total</span><span>₱{fullAmount.toFixed(2)}</span></div>
          {paymentMode === "downpayment_50" && (
            <div className="mt-1 flex justify-between border-t border-border pt-2 font-semibold"><span>Due now (50%)</span><span className="text-primary">₱{dueNow.toFixed(2)}</span></div>
          )}
          {paymentMode === "full" && (
            <div className="mt-1 flex justify-between border-t border-border pt-2 font-semibold"><span>Due now</span><span className="text-primary">₱{dueNow.toFixed(2)}</span></div>
          )}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          {PM_METHODS.map((m) => (
            <button
              key={m.key}
              disabled={payLoading !== null}
              onClick={() => pay(m.key)}
              className="flex flex-col items-center rounded-xl border border-border bg-background p-3 text-sm font-semibold transition hover:border-primary hover:bg-primary/5 disabled:opacity-50"
            >
              <span className="text-2xl">{m.emoji}</span>
              <span className="mt-1">{payLoading === m.key ? "Redirecting…" : m.label}</span>
            </button>
          ))}
        </div>

        <p className="mt-3 text-[11px] text-muted-foreground">Powered by PayMongo · Test mode.</p>
      </div>
    </div>
  );
}
