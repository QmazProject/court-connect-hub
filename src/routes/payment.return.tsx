import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

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

  useEffect(() => {
    if (!ref || status === "cancel") return;
    let cancelled = false;
    const poll = async () => {
      // Poll transactions table (webhook updates it). Match by booking id embedded in reference.
      const bookingId = Number(ref.split("_")[1]);
      if (!bookingId) return;
      const { data } = await supabase
        .from("transactions")
        .select("status, amount")
        .eq("booking_id", bookingId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled || !data) return;
      setAmount(Number(data.amount));
      if (data.status === "paid" || data.status === "failed") {
        setTxStatus(data.status as "paid" | "failed");
      }
    };
    const timer = setInterval(() => {
      setPollCount((n) => n + 1);
      poll();
    }, 2500);
    poll();
    return () => { cancelled = true; clearInterval(timer); };
  }, [ref, status]);

  const stopAt = 20; // ~50s
  const timedOut = pollCount > stopAt && txStatus === "pending";

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-lg items-center justify-center px-6 py-12">
      <div className="w-full rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
        {status === "cancel" ? (
          <>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/10 text-2xl">✕</div>
            <h1 className="mt-4 text-2xl font-bold">Payment cancelled</h1>
            <p className="mt-2 text-sm text-muted-foreground">Your reservation was not confirmed. You can try again from the court page.</p>
          </>
        ) : txStatus === "paid" ? (
          <>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-2xl text-primary">✓</div>
            <h1 className="mt-4 text-2xl font-bold">Payment received</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {amount != null ? <>We received <span className="font-semibold text-foreground">₱{amount.toFixed(2)}</span>. </> : null}
              Your booking is confirmed.
            </p>
          </>
        ) : txStatus === "failed" ? (
          <>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 text-2xl text-destructive">!</div>
            <h1 className="mt-4 text-2xl font-bold">Payment failed</h1>
            <p className="mt-2 text-sm text-muted-foreground">The provider reported a failure. Please try booking again.</p>
          </>
        ) : timedOut ? (
          <>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted text-2xl">⏳</div>
            <h1 className="mt-4 text-2xl font-bold">Still processing…</h1>
            <p className="mt-2 text-sm text-muted-foreground">This can take a minute. Refresh the page — your booking will appear once confirmed.</p>
          </>
        ) : (
          <>
            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <h1 className="mt-4 text-2xl font-bold">Confirming payment…</h1>
            <p className="mt-2 text-sm text-muted-foreground">Hang tight, we're syncing with PayMongo.</p>
          </>
        )}

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link to="/" className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold hover:border-primary hover:text-primary">
            Back to venues
          </Link>
        </div>
      </div>
    </main>
  );
}
