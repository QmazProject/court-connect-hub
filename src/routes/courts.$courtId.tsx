import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/courts/$courtId")({
  component: CourtBooking,
});

type Court = {
  id: number;
  name: string;
  hourly_rate: number;
  is_indoor: boolean;
  operating_hours: Record<string, string>;
  blocked_hours: Record<string, number[]> | null;
  description: string | null;
  amenities: string[] | null;
  images: string[] | null;
  sports: { name: string } | null;
  venues: { name: string; address: string; timezone: string; latitude: number | null; longitude: number | null } | null;
};

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function fmtHour(h: number) {
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${period}`;
}


function CourtBooking() {
  const { courtId } = Route.useParams();
  const router = useRouter();
  const qc = useQueryClient();
  const [date, setDate] = useState(todayISO());
  const [selected, setSelected] = useState<number[]>([]);
  const [err, setErr] = useState<string | null>(null);


  const courtQ = useQuery({
    queryKey: ["court", courtId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts")
        .select("id, name, hourly_rate, is_indoor, operating_hours, blocked_hours, description, amenities, images, sports(name), venues(name, address, timezone, latitude, longitude)")
        .eq("id", Number(courtId))
        .maybeSingle();

      if (error) throw error;
      return data as unknown as Court | null;
    },
  });

  const dayStart = useMemo(() => new Date(`${date}T00:00:00`), [date]);
  const dayEnd = useMemo(() => new Date(`${date}T23:59:59`), [date]);

  const busyQ = useQuery({
    queryKey: ["busy", courtId, date],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_court_bookings", {
        _court_id: Number(courtId),
        _from: dayStart.toISOString(),
        _to: dayEnd.toISOString(),
      });
      if (error) throw error;
      return (data ?? []) as { start_time: string; end_time: string }[];
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
          court_id: Number(courtId),
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
      qc.invalidateQueries({ queryKey: ["busy", courtId, date] });
    },
    onError: (e: Error) => {
      if (/exclusion|overlap|conflict/i.test(e.message)) {
        setErr("One of those hours was just taken. Pick another slot.");
        qc.invalidateQueries({ queryKey: ["busy", courtId, date] });
      } else {
        setErr(e.message);
      }
    },
  });


  if (courtQ.isLoading) {
    return <main className="mx-auto max-w-4xl px-6 py-10"><div className="h-40 animate-pulse rounded-2xl bg-muted" /></main>;
  }
  if (!courtQ.data) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-16 text-center">
        <h1 className="text-2xl font-bold">Court not found</h1>
        <Link to="/" className="mt-4 inline-block text-primary hover:underline">← Back to courts</Link>
      </main>
    );
  }

  const court = courtQ.data;
  const dow = DAY_KEYS[new Date(`${date}T00:00:00`).getDay()];
  const blocked = new Set<number>(court.blocked_hours?.[dow] ?? []);
  const slots: number[] = Array.from({ length: 24 }, (_, i) => i);
  const isBooked = (hour: number) => {
    const slotStart = new Date(`${date}T${String(hour).padStart(2, "0")}:00:00`).getTime();
    const slotEnd = slotStart + 60 * 60 * 1000;
    return (busyQ.data ?? []).some((b) => {
      const bs = new Date(b.start_time).getTime();
      const be = new Date(b.end_time).getTime();
      return bs < slotEnd && be > slotStart;
    });
  };
  const isBlocked = (hour: number) => blocked.has(hour);

  const isPast = (hour: number) => {
    const slotStart = new Date(`${date}T${String(hour).padStart(2, "0")}:00:00`).getTime();
    return slotStart < Date.now();
  };

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <button onClick={() => router.history.back()} className="text-sm text-muted-foreground hover:text-foreground">← Back</button>

      <header className="mt-4 rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded-full bg-secondary px-2 py-1 font-medium">{court.sports?.name}</span>
              <span className="text-muted-foreground">{court.is_indoor ? "Indoor" : "Outdoor"}</span>
            </div>
            <h1 className="mt-2 text-3xl font-bold">{court.name}</h1>
            <p className="text-sm text-muted-foreground">{court.venues?.name} · {court.venues?.address}</p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold text-primary">₱{Number(court.hourly_rate).toFixed(0)}</div>
            <div className="text-xs text-muted-foreground">per hour</div>
          </div>
        </div>
      </header>

      {(court.images?.length ?? 0) > 0 && (
        <section className="mt-6 grid gap-3 sm:grid-cols-2">
          {court.images!.map((src, i) => (
            <img
              key={i}
              src={src}
              alt={`${court.name} photo ${i + 1}`}
              className={
                "w-full rounded-2xl border border-border object-cover " +
                (i === 0 ? "h-64 sm:col-span-2 sm:h-80" : "h-40")
              }
              loading="lazy"
            />
          ))}
        </section>
      )}

      {(court.description || (court.amenities?.length ?? 0) > 0) && (
        <section className="mt-6 rounded-2xl border border-border bg-card p-6 shadow-sm">
          {court.description && (
            <>
              <h2 className="text-lg font-semibold">About this court</h2>
              <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">{court.description}</p>
            </>
          )}
          {(court.amenities?.length ?? 0) > 0 && (
            <>
              <h3 className="mt-6 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Amenities</h3>
              <ul className="mt-3 flex flex-wrap gap-2">
                {court.amenities!.map((a) => (
                  <li key={a} className="rounded-full border border-border bg-secondary px-3 py-1 text-xs font-medium">
                    {a}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {court.venues?.latitude != null && court.venues?.longitude != null && (
        <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 p-4 sm:p-6">
            <div>
              <h2 className="text-lg font-semibold">Location</h2>
              <p className="text-sm text-muted-foreground">{court.venues.address}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${court.venues.latitude},${court.venues.longitude}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold hover:border-primary hover:text-primary"
              >
                View on Google Maps ↗
              </a>
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${court.venues.latitude},${court.venues.longitude}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
              >
                Get directions ↗
              </a>
            </div>
          </div>
          <iframe
            title={`${court.venues.name} map`}
            src={`https://www.openstreetmap.org/export/embed.html?bbox=${court.venues.longitude - 0.005},${court.venues.latitude - 0.005},${court.venues.longitude + 0.005},${court.venues.latitude + 0.005}&layer=mapnik&marker=${court.venues.latitude},${court.venues.longitude}`}
            className="h-64 w-full sm:h-80"
            loading="lazy"
          />
        </section>
      )}

      <section className="mt-6 rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Pick a time</h2>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Date</span>
            <input
              type="date"
              value={date}
              min={todayISO()}
              onChange={(e) => { setDate(e.target.value); setSelected([]); setErr(null); }}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
        </div>

        <p className="mt-2 text-xs text-muted-foreground">Tap multiple hours to book them together.</p>

        <div className="mt-3 flex flex-wrap gap-3 text-xs">
          <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm border border-green-500/50 bg-green-200" /> Available</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm border border-yellow-500/60 bg-yellow-300" /> Selected</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm border border-red-500/50 bg-red-300" /> Booked</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm border border-amber-400/60 bg-amber-200/60" /> Unavailable</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm border border-orange-500/50 bg-orange-300" /> Past</span>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
          {slots.map((h) => {
            const booked = isBooked(h);
            const blockedSlot = isBlocked(h);
            const past = isPast(h);
            const disabled = booked || blockedSlot || past;
            const active = selected.includes(h);
            const label = blockedSlot ? "Unavailable" : booked ? "Booked" : past ? "Past" : "";
            const stateClass = active
              ? "border-yellow-500 bg-yellow-300 text-yellow-950"
              : booked
                ? "cursor-not-allowed border-red-500/50 bg-red-300 text-red-900"
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
                    prev.includes(h) ? prev.filter((x) => x !== h) : [...prev, h].sort((a, b) => a - b)
                  );
                }}
                title={label}
                className={"flex flex-col items-center rounded-lg border px-2 py-2 text-sm font-medium transition " + stateClass}
              >
                <span className={"text-xs leading-tight " + (disabled ? "line-through" : "")}>{fmtHour(h)} – {fmtHour((h + 1) % 24)}</span>
                {label && <span className="mt-0.5 text-[10px] uppercase tracking-wide">{label}</span>}
              </button>
            );
          })}
        </div>


        {err && <p className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="text-sm text-muted-foreground">
            {selected.length > 0
              ? <>Selected <span className="font-semibold text-foreground">{selected.length} hr{selected.length > 1 ? "s" : ""}</span> ({selected.map((h) => `${fmtHour(h)}–${fmtHour((h + 1) % 24)}`).join(", ")}) · Total <span className="font-semibold text-foreground">₱{(Number(court.hourly_rate) * selected.length).toFixed(0)}</span></>
              : "Choose one or more available hours above."}
          </div>
          <div className="flex gap-2">
            {selected.length > 0 && (
              <button
                onClick={() => setSelected([])}
                className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold hover:border-primary hover:text-primary"
              >
                Clear
              </button>
            )}
            <button
              disabled={selected.length === 0 || bookMut.isPending}
              onClick={() => selected.length > 0 && bookMut.mutate(selected)}
              className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {bookMut.isPending ? "Booking…" : `Confirm booking${selected.length > 1 ? ` (${selected.length} hrs)` : ""}`}
            </button>
          </div>
        </div>

        <p className="mt-2 text-xs text-muted-foreground">Payment will be handled at the venue for now.</p>
      </section>
    </main>
  );
}
