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
  const [slot, setSlot] = useState<{ date: string; range: string; court: string | null; venue: string | null } | null>(null);

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
        .select("id, court_id, start_time, end_time, status, payment_status, refund_status, courts(name, venues(name))")
        .in("id", ids);
      if (!cancelled && bks && bks.length > 0) {
        if (bks.some((booking) => booking.status === "expired")) setReservationState("expired");
        else if (bks.some((booking) => booking.status === "cancelled")) setReservationState("cancelled");
        setRefundPending(bks.some((booking) => booking.refund_status === "pending"));
        const grouped = groupBookingSessions(bks as unknown as (HourlyBooking & { courts: { name: string; venues: { name: string } | null } | null })[]);
        const s = grouped[0];
        setSlot({
          date: formatDateLabel(s.start_time),
          range: formatSessionLabel(s.start_time, s.end_time),
          court: s.first.courts?.name ?? null,
          venue: s.first.courts?.venues?.name ?? null,
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
    <main className="mx-auto flex min-h-[70vh] max-w-lg items-center justify-center px-6 py-12">
      <div className="w-full rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
        {status === "cancel" ? (
          <>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/10 text-2xl">✕</div>
            <h1 className="mt-4 text-2xl font-bold">Payment cancelled</h1>
            <p className="mt-2 text-sm text-muted-foreground">Your reservation was not placed. You can try again anytime from your dashboard.</p>
          </>
        ) : reservationState === "expired" || reservationState === "cancelled" ? (
          <>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/10 text-2xl">⌛</div>
            <h1 className="mt-4 text-2xl font-bold">Your reservation has expired</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              The selected time may already have been booked by another player. {refundPending ? "Your payment was received after the hold ended and is awaiting refund." : "Create a new booking to reserve another available slot."}
            </p>
          </>
        ) : txStatus === "paid" ? (
          <>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-2xl text-primary">✓</div>
            <h1 className="mt-4 text-2xl font-bold">Payment received</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {amount != null ? <>We received <span className="font-semibold text-foreground">₱{amount.toFixed(2)}</span>. </> : null}
              Your booking is now confirmed.
            </p>
          </>
        ) : txStatus === "failed" ? (
          <>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 text-2xl text-destructive">!</div>
            <h1 className="mt-4 text-2xl font-bold">Payment failed</h1>
            <p className="mt-2 text-sm text-muted-foreground">The provider reported a failure. You can retry from your dashboard.</p>
          </>
        ) : timedOut ? (
          <>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted text-2xl">⏳</div>
            <h1 className="mt-4 text-2xl font-bold">Still processing…</h1>
            <p className="mt-2 text-sm text-muted-foreground">This can take a minute. Your booking will appear in your dashboard once confirmed.</p>
          </>
        ) : (
          <>
            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <h1 className="mt-4 text-2xl font-bold">Confirming payment…</h1>
            <p className="mt-2 text-sm text-muted-foreground">Hang tight, we're syncing with PayMongo.</p>
          </>
        )}

        {slot && status !== "cancel" && (
          <div className="mt-5 rounded-xl border border-border bg-secondary/40 p-4 text-left">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Your session</p>
            {(slot.venue || slot.court) && (
              <p className="mt-1 text-sm font-semibold">
                {slot.venue ?? "Venue"}{slot.court ? <span className="text-muted-foreground"> · {slot.court}</span> : null}
              </p>
            )}
            <p className="mt-1 text-sm">{slot.date}</p>
            <p className="text-sm font-medium text-primary">{slot.range}</p>
          </div>
        )}



        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link to="/dashboard" className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90">
            My bookings
          </Link>
          <Link to="/" className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold hover:border-primary hover:text-primary">
            Back to venues
          </Link>
        </div>
      </div>
    </main>
  );
}
