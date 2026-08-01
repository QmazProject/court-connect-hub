import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { cancelPendingBookings } from "@/lib/paymongo.functions";
import { groupBookingSessions, formatDateLabel, formatSessionLabel, type HourlyBooking } from "@/lib/booking-groups";


type Search = { ref?: string; status?: string };

export const Route = createFileRoute("/payment/return")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ref: typeof s.ref === "string" ? s.ref : undefined,
    status: typeof s.status === "string" ? s.status : undefined,
  }),
  component: PaymentReturn,
  head: () => ({
    meta: [
      { title: "Payment status · CourtHub" },
      { name: "description", content: "Confirming your CourtHub payment." },
    ],
  }),
});

function PaymentReturn() {
  const { ref, status } = useSearch({ from: "/payment/return" });
  const [txStatus, setTxStatus] = useState<"pending" | "paid" | "failed" | "cancelled" | "refunded">(
    status === "cancel" ? "cancelled" : "pending",
  );
  const [amount, setAmount] = useState<number | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const [reservationState, setReservationState] = useState<"active" | "expired" | "cancelled">("active");
  const [refundPending, setRefundPending] = useState(false);
  const [slot, setSlot] = useState<{ date: string; range: string; court: string | null; venue: string | null; venueImage: string | null; venueId: number | null } | null>(null);

  const cancelFn = useServerFn(cancelPendingBookings);
  const didCancel = useRef(false);

  // If user cancelled the checkout, void the pending unpaid bookings.
  useEffect(() => {
    if (status !== "cancel" || !ref || didCancel.current) return;
    const bookingId = Number(ref.split("_")[1]);
    if (!bookingId) return;
    didCancel.current = true;
    (async () => {
      const { data: primary } = await supabase
        .from("transactions")
        .select("provider_ref")
        .eq("booking_id", bookingId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const { data: sessionRows } = primary?.provider_ref
        ? await supabase.from("transactions").select("booking_id").eq("provider_ref", primary.provider_ref)
        : { data: [] as { booking_id: number }[] };
      const ids = Array.from(new Set([bookingId, ...((sessionRows ?? []).map((r) => r.booking_id))]));
      try {
        await cancelFn({ data: { bookingIds: ids } });
      } catch (e) {
        console.error("cancel pending", e);
      }
    })();
  }, [status, ref, cancelFn]);

  useEffect(() => {
    if (!ref || status === "cancel") return;
    let cancelled = false;
    const poll = async () => {
      const bookingId = Number(ref.split("_")[1]);
      if (!bookingId) return;
      const { data } = await supabase
        .from("transactions")
        .select("status, amount, provider_ref")
        .eq("booking_id", bookingId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled || !data) return;

      // Sum the whole checkout session (bookings are stored one row per hour).
      let total = Number(data.amount);
      let ids = [bookingId];
      if (data.provider_ref) {
        const { data: sess } = await supabase
          .from("transactions")
          .select("booking_id, amount")
          .eq("provider_ref", data.provider_ref);
        if (sess && sess.length > 0) {
          total = sess.reduce((s, t) => s + Number(t.amount ?? 0), 0);
          ids = Array.from(new Set(sess.map((t) => t.booking_id as number)));
        }
      }
      if (cancelled) return;
      setAmount(total);

      const { data: bks } = await supabase
        .from("bookings")
        .select("id, court_id, start_time, end_time, status, payment_status, refund_status, courts(name, venues(id, name, images))")
        .in("id", ids);
      if (!cancelled && bks && bks.length > 0) {
        if (bks.some((booking) => booking.status === "expired")) setReservationState("expired");
        else if (bks.some((booking) => booking.status === "cancelled")) setReservationState("cancelled");
        setRefundPending(bks.some((booking) => booking.refund_status === "pending"));
        const grouped = groupBookingSessions(bks as unknown as (HourlyBooking & { courts: { name: string; venues: { id: number; name: string; images: string[] } | null } | null })[]);
        const s = grouped[0];
        setSlot({
          date: formatDateLabel(s.start_time),
          range: formatSessionLabel(s.start_time, s.end_time),
          court: s.first.courts?.name ?? null,
          venue: s.first.courts?.venues?.name ?? null,
          venueImage: s.first.courts?.venues?.images?.[0] ?? null,
          venueId: s.first.courts?.venues?.id ?? null,
        });
      }

      if (["paid", "failed", "cancelled", "refunded"].includes(data.status)) {
        setTxStatus(data.status as "paid" | "failed" | "cancelled" | "refunded");
      }
    };
    const timer = setInterval(() => {
      setPollCount((n) => n + 1);
      poll();
    }, 2500);
    poll();
    return () => { cancelled = true; clearInterval(timer); };
  }, [ref, status]);


  const stopAt = 20;
  const timedOut = pollCount > stopAt && txStatus === "pending";

  return (
    <div className="relative flex min-h-dvh w-full items-center justify-center overflow-hidden p-4 sm:p-6">
      {/* Background Venue Image */}
      {slot?.venueImage ? (
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat transition-opacity duration-1000"
          style={{ backgroundImage: `url(${slot.venueImage})` }}
        />
      ) : (
        <div className="absolute inset-0 bg-[#061a17]" />
      )}
      {/* Heavy Blur Overlay */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-xl" />

      {/* Modal Card */}
      <main className="relative w-full max-w-sm rounded-3xl border border-white/10 bg-[#09231f]/95 p-8 text-center text-white shadow-2xl animate-in fade-in zoom-in duration-300">
        {status === "cancel" ? (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-white/10 text-3xl">✕</div>
            <h1 className="mt-5 text-2xl font-bold">Payment cancelled</h1>
            <p className="mt-2 text-sm text-white/60">Your reservation was not placed. You can try again anytime from your dashboard.</p>
          </>
        ) : reservationState === "expired" || reservationState === "cancelled" ? (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-white/10 text-3xl">⌛</div>
            <h1 className="mt-5 text-2xl font-bold">Reservation expired</h1>
            <p className="mt-2 text-sm text-white/60">
              {refundPending ? "Your payment was received after the hold ended and is awaiting refund." : "Create a new booking to reserve another available slot."}
            </p>
          </>
        ) : txStatus === "paid" ? (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#b8f05a]/20 text-3xl text-[#b8f05a]">✓</div>
            <h1 className="mt-5 font-display text-2xl font-bold text-[#b8f05a]">Payment received</h1>
            <p className="mt-2 text-sm text-white/70">
              {amount != null ? <>We received <span className="font-semibold text-white">₱{amount.toFixed(2)}</span>. </> : null}
              Your booking is confirmed!
            </p>
          </>
        ) : txStatus === "failed" ? (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-500/20 text-3xl text-red-400">!</div>
            <h1 className="mt-5 text-2xl font-bold text-red-400">Payment failed</h1>
            <p className="mt-2 text-sm text-white/60">The provider reported a failure. You can retry from your dashboard.</p>
          </>
        ) : timedOut ? (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-white/10 text-3xl">⏳</div>
            <h1 className="mt-5 text-2xl font-bold">Still processing…</h1>
            <p className="mt-2 text-sm text-white/60">This can take a minute. Your booking will appear in your dashboard once confirmed.</p>
          </>
        ) : (
          <>
            <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-white/20 border-t-[#b8f05a]" />
            <h1 className="mt-6 font-display text-xl font-bold tracking-tight">Confirming payment…</h1>
            <p className="mt-2 text-sm text-white/50">Hang tight, we're syncing securely.</p>
          </>
        )}

        {slot && status !== "cancel" && (
          <div className="mt-8 overflow-hidden rounded-2xl border border-white/10 bg-white/5 text-left">
            <div className="border-b border-white/10 bg-white/5 px-4 py-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">Your Session</p>
            </div>
            <div className="px-4 py-4">
              {(slot.venue || slot.court) && (
                <p className="text-base font-semibold text-white">
                  {slot.venue ?? "Venue"}{slot.court ? <span className="text-white/50"> · {slot.court}</span> : null}
                </p>
              )}
              <div className="mt-3 flex flex-col gap-1 text-sm text-white/70">
                <p className="flex items-center gap-2">
                  <span className="text-white/40">📅</span> {slot.date}
                </p>
                <p className="flex items-center gap-2">
                  <span className="text-white/40">⏱️</span> {slot.range}
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="mt-8 flex flex-col gap-3">
          <Link
            to="/dashboard"
            className="w-full rounded-xl bg-[#b8f05a] px-4 py-3.5 text-center text-sm font-bold text-[#102521] shadow-lg shadow-[#b8f05a]/20 transition hover:bg-[#d3ff87]"
          >
            Go to My Bookings
          </Link>
          <Link
            to={slot?.venueId ? "/venues/$venueId" : "/"}
            params={slot?.venueId ? { venueId: String(slot.venueId) } : {}}
            className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3.5 text-center text-sm font-bold text-white transition hover:bg-white/10"
          >
            Back to Venue
          </Link>
        </div>
      </main>
    </div>
  );
}
