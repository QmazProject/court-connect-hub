import { useMemo, useState, useEffect, useRef, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { startBookingCheckout } from "@/lib/paymongo.functions";
import { getCourtAvailability } from "@/lib/availability.functions";
import { useIsMobile } from "@/hooks/use-mobile";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { X } from "lucide-react";
import {
  normalizeRules, rateForHour, priceForHours, priceBreakdown, minRate, maxRate,
  hasVariablePricing, rateBands, peso, type RateRule, type DayKey,
} from "@/lib/court-pricing";
import { normalizeHours, effectiveHours, openHoursForDate, describeWindow } from "@/lib/operating-hours";
import { addZonedDays, zonedDateISO, zonedDayBoundsUtc, zonedDayOfWeek, zonedHour, zonedHourToUtc } from "@/lib/tz";

type Court = {
  id: number;
  name: string;
  hourly_rate: number;
  is_indoor: boolean;
  operating_hours: Record<string, string>;
  inherit_venue_hours?: boolean | null;
  blocked_hours: Record<string, number[]> | null;
  blocked_dates: Record<string, number[]> | null;
  description: string | null;
  amenities: string[] | null;
  images: string[] | null;
  coming_soon: boolean | null;
  capacity: number;
  physical_court_id: number;
  map_emoji: string | null;
  surface_type: string | null;
  player_capacity: number | null;
  voucher_enabled: boolean | null;
  rate_rules: unknown;
  sports: { name: string } | null;
  venues: {
    name: string;
    address: string;
    timezone: string;
    latitude: number | null;
    longitude: number | null;
    payment_mode: "none" | "full" | "downpayment_50";
    refund_cutoff_hours: number;
    operating_hours?: Record<string, string> | null;
  } | null;
};

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="border-b border-border px-4 py-2.5 last:border-b-0 sm:odd:border-r">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function shiftISO(iso: string, days: number) {
  return addZonedDays(iso, days);
}
function fmtHour(h: number) {
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${period}`;
}
// Group adjacent selected hours into contiguous [startHour, endHour) ranges.
// e.g. [17,18,19,20,21] -> [{ start: 17, end: 22 }] shown as "5:00 PM – 10:00 PM".
function groupHourRanges(hours: number[]): { start: number; end: number }[] {
  if (hours.length === 0) return [];
  const sorted = [...hours].sort((a, b) => a - b);
  const out: { start: number; end: number }[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const h = sorted[i];
    if (h === prev + 1) {
      prev = h;
    } else {
      out.push({ start, end: prev + 1 });
      start = h;
      prev = h;
    }
  }
  out.push({ start, end: prev + 1 });
  return out;
}

type PmMethod = "gcash" | "paymaya" | "grab_pay" | "qrph";
const PM_METHODS: { key: PmMethod; label: string; emoji: string }[] = [
  { key: "gcash", label: "GCash", emoji: "💙" },
  { key: "paymaya", label: "Maya", emoji: "💚" },
  { key: "grab_pay", label: "GrabPay", emoji: "🟢" },
  { key: "qrph", label: "QR Ph", emoji: "🔳" },
];

export function CourtBookingContent({ courtId, onClose, userId }: { courtId: number; onClose?: () => void; userId?: string | null }) {
  const qc = useQueryClient();
  const [date, setDate] = useState(() => zonedDateISO());
  const [selected, setSelected] = useState<number[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [payLoading, setPayLoading] = useState<PmMethod | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [carouselIdx, setCarouselIdx] = useState(0);
  const [voucherCode, setVoucherCode] = useState("");
  const [voucher, setVoucher] = useState<{ id: string; discount: number; type: string; value: number } | null>(null);
  const [voucherErr, setVoucherErr] = useState<string | null>(null);
  const [voucherLoading, setVoucherLoading] = useState(false);

  const courtQ = useQuery({
    queryKey: ["court", courtId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts")
        .select(
          "id, name, hourly_rate, is_indoor, operating_hours, inherit_venue_hours, blocked_hours, blocked_dates, description, amenities, images, coming_soon, capacity, physical_court_id, map_emoji, surface_type, player_capacity, voucher_enabled, rate_rules, sports(name), venues(name, address, timezone, latitude, longitude, payment_mode, refund_cutoff_hours, operating_hours)",
        )
        .eq("id", courtId)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as Court | null;
    },
  });

  const dayBounds = useMemo(() => zonedDayBoundsUtc(date), [date]);

  const availQ = useQuery({
    queryKey: ["avail", courtId, date],
    refetchInterval: 10000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const rows = await getCourtAvailability({
        data: { courtId, from: dayBounds.start.toISOString(), to: dayBounds.end.toISOString() },
      });
      const map = new Map<number, { remaining: number; blockedByOther: boolean }>();
      rows.forEach((row) => {
        const h = zonedHour(row.hour_start);
        map.set(h, { remaining: row.remaining, blockedByOther: row.blocked_by_other_sport });
      });
      return map;
    },
    enabled: !!courtQ.data,
  });

  // Live refresh when any booking changes (staff/own rows arrive via realtime;
  // the interval above covers rows RLS hides from this viewer).
  useEffect(() => {
    const channel = supabase
      .channel(`avail-${courtId}-${date}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, () => {
        qc.invalidateQueries({ queryKey: ["avail", courtId, date] });
        qc.invalidateQueries({ queryKey: ["venue-day-bookings"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [courtId, date, qc]);


  const ownBookingsQ = useQuery({
    queryKey: ["court-own-bookings", courtId, date, userId],
    enabled: !!courtQ.data && !!userId,
    queryFn: async () => {
      if (!userId) return [];
      const { data, error } = await supabase
        .from("bookings")
        .select("start_time, end_time, status, payment_status, created_at")
        .eq("court_id", courtId)
        .eq("user_id", userId)
        .lt("start_time", dayBounds.end.toISOString())
        .gt("end_time", dayBounds.start.toISOString());
      if (error) throw error;
      return (data ?? []) as Array<{
        start_time: string;
        end_time: string;
        status: string;
        payment_status: string;
        created_at: string;
      }>;
    },
  });

  const bookMut = useMutation({
    mutationFn: async (hours: number[]) => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Please sign in to book a court.");
      const sorted = [...hours].sort((a, b) => a - b);
      const rows = sorted.map((hour, idx) => {
        const start = zonedHourToUtc(date, hour);
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        const applyVoucher = idx === 0 && voucher;
        return {
          court_id: courtId,
          user_id: userData.user!.id,
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          status: "confirmed",
          unit_price: rateForHour(Number(courtQ.data!.hourly_rate), normalizeRules(courtQ.data!.rate_rules), date, hour),
          voucher_id: applyVoucher ? voucher!.id : null,
          discount_amount: applyVoucher ? voucher!.discount : 0,
        };
      });
      const { error } = await supabase.from("bookings").insert(rows);
      if (error) throw error;
    },
    onSuccess: () => {
      setSelected([]);
      setErr(null);
      setVoucher(null);
      setVoucherCode("");
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

  async function applyVoucher() {
    if (!voucherCode.trim() || !courtQ.data) return;
    setVoucherLoading(true); setVoucherErr(null);
    try {
      const rules = normalizeRules(courtQ.data.rate_rules);
      const amount = selected.length
        ? priceForHours(Number(courtQ.data.hourly_rate), rules, date, selected)
        : Number(courtQ.data.hourly_rate);
      const { data, error } = await supabase.rpc("preview_voucher", {
        _code: voucherCode.trim(),
        _court_id: courtId,
        _amount: amount,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.ok) { setVoucher(null); setVoucherErr(row?.reason || "Invalid voucher"); return; }
      setVoucher({ id: row.voucher_id, discount: Number(row.discount), type: row.discount_type, value: Number(row.discount_value) });
    } catch (e) {
      setVoucher(null);
      setVoucherErr((e as Error).message);
    } finally {
      setVoucherLoading(false);
    }
  }

  const ownSlotInfo = useMemo(() => {
    const map = new Map<number, { kind: "hold" | "booking" }>();
    for (const b of ownBookingsQ.data ?? []) {
      const start = new Date(b.start_time).getTime();
      const end = new Date(b.end_time).getTime();
      const startHr = Math.floor((start - dayBounds.start.getTime()) / 3600000);
      const endHr = Math.ceil((end - dayBounds.start.getTime()) / 3600000);
      const isHold = b.status === "pending" && b.payment_status !== "paid";
      for (let h = startHr; h < endHr; h++) {
        map.set(h, { kind: isHold ? "hold" : "booking" });
      }
    }
    return map;
  }, [ownBookingsQ.data, dayBounds.start]);

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
  const rules = normalizeRules(court.rate_rules);
  const baseRate = Number(court.hourly_rate);
  const variablePricing = hasVariablePricing(baseRate, rules);
  const rateOf = (hour: number) => rateForHour(baseRate, rules, date, hour);
  const subtotal = priceForHours(baseRate, rules, date, selected);
  const breakdown = priceBreakdown(baseRate, rules, date, selected);
  const dow = DAY_KEYS[zonedDayOfWeek(date)];
  const dateOverride = court.blocked_dates?.[date];
  const blocked = new Set<number>(dateOverride ?? court.blocked_hours?.[dow] ?? []);
  const venueHours = normalizeHours((court.venues as unknown as { operating_hours?: unknown } | null)?.operating_hours);
  const openHours = openHoursForDate(
    effectiveHours({ inherit_venue_hours: court.inherit_venue_hours, operating_hours: court.operating_hours }, venueHours),
    date,
  );
  const slots: number[] = Array.from({ length: 24 }, (_, i) => i).filter((h) => openHours.has(h));
  const closedToday = slots.length === 0;
  const capacity = Math.max(1, court.capacity ?? 1);
  const slotInfo = (hour: number) => availQ.data?.get(hour) ?? { remaining: capacity, blockedByOther: false };
  const isBooked = (hour: number) => slotInfo(hour).remaining <= 0 && !slotInfo(hour).blockedByOther;
  const isBlockedBySport = (hour: number) => slotInfo(hour).blockedByOther;
  const isBlocked = (hour: number) => blocked.has(hour);
  const isPast = (hour: number) => {
    const slotStart = zonedHourToUtc(date, hour).getTime();
    return slotStart < Date.now();
  };



  return (
    <div className="flex h-full flex-col">
      {onClose && (
        <div className="sticky top-0 z-10 flex justify-end border-b border-border bg-card/95 px-3 py-2 backdrop-blur">
          <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

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

        <section className="mb-5 overflow-hidden rounded-2xl border border-border bg-card">
          <div className="border-b border-border bg-gradient-to-r from-indigo-600/10 via-fuchsia-500/10 to-rose-500/10 px-4 py-2">
            <h2 className="text-[11px] font-extrabold uppercase italic tracking-[0.3em] text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 via-fuchsia-500 to-rose-500">
              Court profile
            </h2>
          </div>
          <dl className="grid grid-cols-1 gap-0 sm:grid-cols-2">
            <DetailRow
              label="Sport type"
              value={
                <span className="inline-flex items-center gap-1.5">
                  {court.map_emoji && <span className="text-base leading-none">{court.map_emoji}</span>}
                  <span>{court.sports?.name ?? "—"}</span>
                </span>
              }
            />
            <DetailRow label="Court type" value={court.is_indoor ? "Indoor" : "Outdoor"} />
            <DetailRow label="Court name" value={court.name} />
            <DetailRow
              label="Court location"
              value={
                <span className="block">
                  <span className="font-semibold">{court.venues?.name ?? "—"}</span>
                  {court.venues?.address && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">{court.venues.address}</span>
                  )}
                </span>
              }
            />
            <DetailRow
              label="Rate"
              value={
                variablePricing ? (
                  <span className="block">
                    <span className="font-bold text-primary">from {peso(minRate(baseRate, rules))}</span>{" "}
                    <span className="text-xs text-muted-foreground">/ hour · up to {peso(maxRate(baseRate, rules))}</span>
                    <span className="mt-0.5 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Rates vary by time &amp; day</span>
                  </span>
                ) : (
                  <span><span className="font-bold text-primary">{peso(baseRate)}</span> <span className="text-xs text-muted-foreground">/ hour</span></span>
                )
              }
            />
            <DetailRow label="Surface type" value={court.surface_type || <span className="text-muted-foreground">Not specified</span>} />
            <DetailRow
              label="Player capacity"
              value={
                court.player_capacity
                  ? <span>{court.player_capacity} <span className="text-xs text-muted-foreground">player{court.player_capacity === 1 ? "" : "s"}</span></span>
                  : <span className="text-muted-foreground">Not specified</span>
              }
            />
          </dl>
        </section>

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
              <h2 className="text-base font-semibold">Pick a Time Slots</h2>
              <div className="flex flex-wrap items-center gap-1.5 text-sm">
                <button
                  type="button"
                  onClick={() => { setDate(shiftISO(date, -1)); setSelected([]); setErr(null); }}
                  className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs font-semibold hover:border-primary hover:text-primary"
                  aria-label="Previous day"
                >← Prev</button>
                <button
                  type="button"
                  onClick={() => { setDate(zonedDateISO()); setSelected([]); setErr(null); }}
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

            <p className="mt-2 text-xs text-muted-foreground">
              {closedToday
                ? "This court is closed on this date. Pick another day."
                : `Open ${describeWindow(
                    effectiveHours({ inherit_venue_hours: court.inherit_venue_hours, operating_hours: court.operating_hours }, venueHours)[
                      (["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const)[zonedDayOfWeek(date)]
                    ],
                  )} · tap a time slot to select or deselect it; consecutive slots are automatically combined into a single time range.`}
            </p>

            {variablePricing && (
              <div className="mt-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">Rate card</div>
                {([["Weekdays (Mon–Fri)", "wed"], ["Weekends (Sat–Sun)", "sat"]] as [string, DayKey][]).map(([title, day]) => (
                  <div key={day} className="mt-1.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {rateBands(baseRate, rules, day).map((b) => (
                        <span key={`${day}-${b.start}`} className="rounded-md border border-border bg-background px-2 py-0.5 text-[10px] font-medium">
                          {fmtHour(b.start)}–{fmtHour(b.end % 24)} · <b>{peso(b.rate)}</b>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
                <p className="mt-1.5 text-[10px] text-muted-foreground">Each hour is charged at its own rate; your total adds them up.</p>
              </div>
            )}

            <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-green-500/50 bg-green-200" /> Available</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-yellow-500/60 bg-yellow-300" /> Selected</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-primary/50 bg-primary/15" /> Your booking</span>
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
                const mine = ownSlotInfo.get(h);
                const disabled = booked || blockedSlot || past || otherSport;
                const active = selected.includes(h);
                const label = blockedSlot
                  ? "Unavailable"
                  : otherSport
                    ? "Other sport"
                    : mine
                      ? mine.kind === "hold"
                        ? "Your hold"
                        : "Your booking"
                      : booked
                        ? "Booked"
                        : past
                          ? "Past"
                          : capacity > 1
                            ? `${info.remaining}/${capacity} left`
                            : "";
                const stateClass = active
                  ? "border-yellow-500 bg-yellow-300 text-yellow-950"
                  : mine
                    ? "cursor-not-allowed border-primary/50 bg-primary/10 text-primary"
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
                  title={mine ? "Booked by you" : otherSport ? "Booked for a different sport" : label}
                  className={"flex flex-col items-center rounded-lg border px-1.5 py-1.5 text-xs font-medium transition " + stateClass}
                >
                  <span className={"text-[11px] leading-tight " + (disabled ? "line-through" : "")}>{fmtHour(h)} – {fmtHour((h + 1) % 24)}</span>
                    <span className="mt-0.5 text-[10px] font-semibold tabular-nums">{peso(rateOf(h))}</span>
                    {label && <span className="mt-0.5 text-[9px] uppercase tracking-wide">{label}</span>}
                  </button>
                );
              })}
            </div>

            {err && <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

            <div className="mt-4 border-t border-border pt-3">
              {court.voucher_enabled && selected.length > 0 && (
                <div className="mb-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
                  <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-primary">Voucher code</div>
                  {voucher ? (
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm">
                        <span className="rounded bg-emerald-100 px-2 py-0.5 font-mono text-xs font-semibold text-emerald-700">Applied</span>
                        <span className="ml-2">
                          {voucher.type === "percent" ? `${voucher.value}% off` : `₱${voucher.value.toFixed(0)} off`} — you save <b>₱{voucher.discount.toFixed(2)}</b>
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => { setVoucher(null); setVoucherCode(""); setVoucherErr(null); }}
                        className="text-xs text-muted-foreground underline hover:text-foreground"
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        value={voucherCode}
                        onChange={(e) => { setVoucherCode(e.target.value.toUpperCase()); setVoucherErr(null); }}
                        placeholder="Enter code"
                        className="flex-1 rounded-md border bg-background px-2 py-1.5 text-sm uppercase"
                      />
                      <button
                        type="button"
                        onClick={applyVoucher}
                        disabled={voucherLoading || !voucherCode.trim()}
                        className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                      >
                        {voucherLoading ? "Checking…" : "Apply"}
                      </button>
                    </div>
                  )}
                  {voucherErr && <p className="mt-1.5 text-xs text-red-600">{voucherErr}</p>}
                </div>
              )}

              <div className="text-sm text-muted-foreground">
                {selected.length > 0 ? (
                  <>
                    Selected <span className="font-semibold text-foreground">{selected.length} hr{selected.length > 1 ? "s" : ""}</span>
                    {voucher ? (
                      <> · Subtotal <span className="line-through">{peso(subtotal)}</span> · Total <span className="font-semibold text-emerald-700">₱{Math.max(0, subtotal - voucher.discount).toFixed(2)}</span></>
                    ) : (
                      <> · Total <span className="font-semibold text-foreground">{peso(subtotal)}</span></>
                    )}
                    {variablePricing && breakdown.length > 0 && (
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {breakdown.map((b, i) => (
                          <span key={b.rate}>
                            {i > 0 && " + "}
                            {b.hours} hr{b.hours > 1 ? "s" : ""} × {peso(b.rate)}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {groupHourRanges(selected).map((r) => {
                        const hrs = r.end - r.start;
                        return (
                          <span
                            key={`${r.start}-${r.end}`}
                            className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-foreground"
                          >
                            {fmtHour(r.start)} – {fmtHour(r.end % 24)}
                            <span className="text-[10px] text-muted-foreground">· {hrs} hr{hrs > 1 ? "s" : ""}</span>
                          </span>
                        );
                      })}
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">Adjacent slots are combined into one segment.</p>
                  </>
                ) : "Choose one or more hours."}
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
          subtotal={subtotal}
          breakdown={breakdown}
          voucherCode={voucher ? voucherCode.trim() : null}
          discount={voucher?.discount ?? 0}
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
  userId,
}: {
  courtId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId?: string | null;
}) {
  const isMobile = useIsMobile();

  // Retain last courtId during close animation so the sheet can slide out
  // instead of unmounting instantly when the parent clears the id.
  const [renderedId, setRenderedId] = useState<number | null>(courtId);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (courtId) {
      if (clearTimer.current) clearTimeout(clearTimer.current);
      setRenderedId(courtId);
    } else if (renderedId !== null) {
      clearTimer.current = setTimeout(() => setRenderedId(null), 550);
    }
    return () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, [courtId, renderedId]);

  if (!renderedId) return null;

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="h-[92vh] p-0 transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]">
          <CourtBookingContent courtId={renderedId} userId={userId} onClose={() => onOpenChange(false)} />
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full max-w-xl overflow-hidden p-0 pl-11 sm:max-w-xl data-[state=open]:duration-500 data-[state=closed]:duration-500 data-[state=open]:ease-[cubic-bezier(0.22,1,0.36,1)] data-[state=closed]:ease-[cubic-bezier(0.7,0,0.84,0)]"
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
        <CourtBookingContent courtId={renderedId} userId={userId} onClose={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}

function CheckoutDrawer({
  courtId, date, hours, subtotal, breakdown, voucherCode, discount, paymentMode, venueName, courtName,
  onClose, payLoading, setPayLoading, onError,
}: {
  courtId: number; date: string; hours: number[]; subtotal: number;
  breakdown: { rate: number; hours: number }[];
  voucherCode: string | null; discount: number;
  paymentMode: "full" | "downpayment_50" | "none"; venueName: string; courtName: string;
  onClose: () => void; payLoading: PmMethod | null;
  setPayLoading: (m: PmMethod | null) => void;
  onError: (m: string) => void;
}) {
  const fullAmount = Math.max(0, subtotal - (discount || 0));
  const dueNow = paymentMode === "downpayment_50" ? fullAmount * 0.5 : fullAmount;

  const pay = async (method: PmMethod) => {
    setPayLoading(method);
    try {
      const res = await startBookingCheckout({
        data: { courtId, date, hours, method, origin: window.location.origin, voucherCode: voucherCode || undefined },
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
          {breakdown.length > 1 && breakdown.map((b) => (
            <div key={b.rate} className="mt-1 flex justify-between text-xs text-muted-foreground">
              <span>{b.hours} hr{b.hours > 1 ? "s" : ""} × {peso(b.rate)}</span>
              <span>{peso(b.rate * b.hours)}</span>
            </div>
          ))}
          {discount > 0 && (
            <div className="mt-1 flex justify-between text-xs"><span className="text-muted-foreground">Subtotal</span><span>{peso(subtotal)}</span></div>
          )}
          {discount > 0 && (
            <div className="mt-1 flex justify-between text-xs text-emerald-700"><span>Voucher discount</span><span>−₱{discount.toFixed(2)}</span></div>
          )}
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
