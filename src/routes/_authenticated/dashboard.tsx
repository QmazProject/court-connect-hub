import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { MapPicker } from "@/components/MapPicker";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

type Venue = { id: number; name: string; address: string; timezone: string; latitude: number | null; longitude: number | null };
type Sport = { id: number; name: string };
type Court = {
  id: number; name: string; hourly_rate: number; is_indoor: boolean;
  sport_id: number; venue_id: number;
  description: string | null;
  amenities: string[] | null;
  images: string[] | null;
  blocked_hours: Record<string, number[]> | null;
  blocked_dates: Record<string, number[]> | null;
  sports: { name: string } | null;
};

const DAYS: { key: string; label: string }[] = [
  { key: "mon", label: "Mon" }, { key: "tue", label: "Tue" }, { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" }, { key: "fri", label: "Fri" }, { key: "sat", label: "Sat" }, { key: "sun", label: "Sun" },
];


function Dashboard() {
  const { user } = Route.useRouteContext() as { user: { id: string; email?: string } };
  const qc = useQueryClient();

  const profileQ = useQuery({
    queryKey: ["profile", user.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const venuesQ = useQuery({
    queryKey: ["my-venues", user.id],
    queryFn: async () => {
      const { data: staffRows, error: se } = await supabase.from("staff").select("venue_id").eq("user_id", user.id);
      if (se) throw se;
      const ids = (staffRows ?? []).map((r) => r.venue_id);
      if (ids.length === 0) return [] as Venue[];
      const { data, error } = await supabase.from("venues").select("*").in("id", ids);
      if (error) throw error;
      return data as Venue[];
    },
  });

  if (profileQ.isLoading) return <Shell><Skeleton /></Shell>;
  if (profileQ.data?.role !== "tenant") {
    return (
      <Shell>
        <EmptyState
          title="Player account"
          body="Your account is set up as a player. Head back to browse courts."
          cta={<Link to="/" className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Browse courts</Link>}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Tenant dashboard</h1>
        <p className="mt-1 text-muted-foreground">Manage your venues and courts.</p>
      </div>

      {venuesQ.isLoading ? <Skeleton /> : (venuesQ.data?.length ?? 0) === 0 ? (
        <CreateVenue onCreated={() => { qc.invalidateQueries({ queryKey: ["my-venues"] }); }} />
      ) : (
        <div className="space-y-8">
          {venuesQ.data!.map((v) => (
            <VenueSection key={v.id} venue={v} />
          ))}
          <CreateVenue onCreated={() => qc.invalidateQueries({ queryKey: ["my-venues"] })} compact />
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>;
}
function Skeleton() { return <div className="h-40 animate-pulse rounded-2xl bg-muted" />; }
function EmptyState({ title, body, cta }: { title: string; body: string; cta?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-border p-12 text-center">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      {cta && <div className="mt-6">{cta}</div>}
    </div>
  );
}

function CreateVenue({ onCreated, compact }: { onCreated: () => void; compact?: boolean }) {
  const [open, setOpen] = useState(!compact);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("venues").insert({ name, address, timezone, latitude: lat, longitude: lng });
      if (error) throw error;
    },
    onSuccess: () => { setName(""); setAddress(""); setLat(null); setLng(null); setErr(null); setOpen(false); onCreated(); },
    onError: (e: Error) => setErr(e.message),
  });

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="w-full rounded-2xl border-2 border-dashed border-border p-6 text-sm font-medium text-muted-foreground hover:border-primary hover:text-primary">
        + Add another venue
      </button>
    );
  }

  return (
    <section className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
      <h2 className="text-xl font-bold">{compact ? "New venue" : "Create your first venue"}</h2>
      <p className="mt-1 text-sm text-muted-foreground">A venue holds one or more courts.</p>
      <form onSubmit={(e) => { e.preventDefault(); mut.mutate(); }} className="mt-4 grid gap-3 sm:grid-cols-2">
        <Input label="Venue name" value={name} onChange={setName} required />
        <Input label="Address" value={address} onChange={setAddress} required />
        <Input label="Timezone" value={timezone} onChange={setTimezone} required />
        <div className="sm:col-span-2 rounded-xl border border-dashed border-border bg-secondary/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Map location</span>
            <button type="button" onClick={() => setPickerOpen(true)} className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:border-primary hover:text-primary">
              {lat != null ? "Change pin" : "📍 Pick on map"}
            </button>
          </div>
          {lat != null && lng != null ? (
            <button type="button" onClick={() => setPickerOpen(true)} className="mt-2 block w-full overflow-hidden rounded-lg border border-border">
              <iframe title="Selected location" src={osmEmbedUrl(lat, lng)} className="pointer-events-none h-28 w-full" loading="lazy" />
              <div className="bg-secondary/40 px-3 py-1.5 text-left font-mono text-[11px] text-muted-foreground">{lat.toFixed(6)}, {lng.toFixed(6)}</div>
            </button>
          ) : (
            <p className="mt-2 text-[11px] text-muted-foreground">Tap "Pick on map" to drop a pin so players can find your venue.</p>
          )}
        </div>
        <MapPicker
          open={pickerOpen}
          initialLat={lat}
          initialLng={lng}
          onClose={() => setPickerOpen(false)}
          onSave={(la, ln) => { setLat(la); setLng(ln); setPickerOpen(false); }}
          title="Pin your venue"
        />
        <div className="sm:col-span-2 flex flex-wrap gap-2">
          <button disabled={mut.isPending} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60">
            {mut.isPending ? "Creating…" : "Create venue"}
          </button>
          {compact && <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-border px-4 py-2 text-sm">Cancel</button>}
        </div>
        {err && <p className="sm:col-span-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
      </form>
    </section>
  );
}

function VenueSection({ venue }: { venue: Venue }) {
  const qc = useQueryClient();
  const courtsQ = useQuery({
    queryKey: ["courts", venue.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts").select("*, sports(name)").eq("venue_id", venue.id).order("id");
      if (error) throw error;
      return data as unknown as Court[];
    },
  });

  const courtIds = (courtsQ.data ?? []).map((c) => c.id);
  const [bookingDate, setBookingDate] = useState<string>("");
  const bookingsQ = useQuery({
    queryKey: ["venue-bookings", venue.id, courtIds.join(","), bookingDate || "upcoming"],
    enabled: courtIds.length > 0,
    queryFn: async () => {
      let q = supabase
        .from("bookings")
        .select("id, court_id, start_time, end_time, status")
        .in("court_id", courtIds)
        .order("start_time", { ascending: true })
        .limit(100);
      if (bookingDate) {
        const from = new Date(`${bookingDate}T00:00:00`).toISOString();
        const to = new Date(`${bookingDate}T23:59:59`).toISOString();
        q = q.gte("start_time", from).lte("start_time", to);
      } else {
        q = q.gte("end_time", new Date().toISOString());
      }
      const { data, error } = await q;
      if (error) throw error;
      return data as { id: number; court_id: number; start_time: string; end_time: string; status: string }[];
    },
  });

  const courtName = (id: number) => courtsQ.data?.find((c) => c.id === id)?.name ?? `Court #${id}`;

  return (
    <section className="rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-start sm:justify-between sm:p-6">
        <div>
          <h2 className="text-xl font-bold">{venue.name}</h2>
          <p className="text-sm text-muted-foreground">{venue.address} · {venue.timezone}</p>
        </div>
        <VenueLocation venue={venue} onSaved={() => qc.invalidateQueries({ queryKey: ["my-venues"] })} />
      </header>
      <div className="p-4 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(courtsQ.data ?? []).map((c) => (
            <CourtCard key={c.id} court={c} onChanged={() => qc.invalidateQueries({ queryKey: ["courts", venue.id] })} />
          ))}
          <AddCourt venueId={venue.id} onCreated={() => qc.invalidateQueries({ queryKey: ["courts", venue.id] })} />
        </div>


        <div className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {bookingDate ? `Bookings on ${new Date(`${bookingDate}T00:00:00`).toLocaleDateString()}` : "Upcoming bookings"}
            </h3>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={bookingDate}
                onChange={(e) => setBookingDate(e.target.value)}
                className="rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs"
              />
              {bookingDate && (
                <button onClick={() => setBookingDate("")} className="rounded-lg border border-border px-2.5 py-1.5 text-xs hover:border-primary hover:text-primary">
                  Show upcoming
                </button>
              )}
            </div>
          </div>
          {courtIds.length === 0 ? null : bookingsQ.isLoading ? (
            <div className="mt-3 h-16 animate-pulse rounded-lg bg-muted" />
          ) : (bookingsQ.data?.length ?? 0) === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">{bookingDate ? "No bookings on this date." : "No upcoming bookings yet."}</p>
          ) : (
            <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
              {bookingsQ.data!.map((b) => {
                const s = new Date(b.start_time);
                const e = new Date(b.end_time);
                return (
                  <li key={b.id} className="flex items-center justify-between px-4 py-3 text-sm">
                    <div>
                      <div className="font-medium">{courtName(b.court_id)}</div>
                      <div className="text-xs text-muted-foreground">
                        {s.toLocaleDateString()} · {s.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – {e.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </div>
                    <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary capitalize">{b.status}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function CourtCard({ court, onChanged }: { court: Court; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [managingHours, setManagingHours] = useState(false);
  if (editing) {
    return <EditCourt court={court} onDone={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />;
  }
  if (managingHours) {
    return <AvailabilityEditor court={court} onDone={() => { setManagingHours(false); onChanged(); }} onCancel={() => setManagingHours(false)} />;
  }
  const cover = court.images?.[0];
  const totalBlocked = Object.values(court.blocked_hours ?? {}).reduce((s, arr) => s + (arr?.length ?? 0), 0);
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      {cover ? (
        <img src={cover} alt={court.name} className="h-32 w-full object-cover" loading="lazy" />
      ) : (
        <div className="court-pattern h-32" />
      )}
      <div className="p-4">
        <div className="flex items-center justify-between text-xs">
          <span className="rounded-full bg-secondary px-2 py-1 font-medium">{court.sports?.name}</span>
          <span className="text-muted-foreground">{court.is_indoor ? "Indoor" : "Outdoor"}</span>
        </div>
        <h3 className="mt-2 font-semibold">{court.name}</h3>
        {court.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{court.description}</p>}
        {(court.amenities?.length ?? 0) > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {court.amenities!.slice(0, 4).map((a) => (
              <span key={a} className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">{a}</span>
            ))}
            {(court.amenities!.length > 4) && <span className="text-[10px] text-muted-foreground">+{court.amenities!.length - 4} more</span>}
          </div>
        )}
        <div className="mt-3 flex items-center justify-between">
          <div className="text-primary"><span className="text-lg font-bold">₱{Number(court.hourly_rate).toFixed(0)}</span> <span className="text-xs text-muted-foreground">/hr</span></div>
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">
          Open 24/7 · <span className="font-medium text-foreground">{totalBlocked}</span> hr{totalBlocked === 1 ? "" : "s"} blocked / week
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => setManagingHours(true)} className="flex-1 rounded-md bg-primary/10 px-2 py-1.5 text-xs font-semibold text-primary hover:bg-primary/20">
            Manage availability
          </button>
          <button onClick={() => setEditing(true)} className="rounded-md border border-border px-2 py-1.5 text-xs font-medium hover:border-primary hover:text-primary">Edit details</button>
        </div>
      </div>
    </div>
  );
}

function fmtHour(x: number) {
  const p = x < 12 ? "AM" : "PM";
  const h12 = x % 12 === 0 ? 12 : x % 12;
  return `${h12}:00 ${p}`;
}

function AvailabilityEditor({ court, onDone, onCancel }: { court: Court; onDone: () => void; onCancel: () => void }) {
  const [mode, setMode] = useState<"weekly" | "date">("weekly");
  const [err, setErr] = useState<string | null>(null);

  // --- Weekly state
  const initialWeekly: Record<string, Set<number>> = {};
  for (const d of DAYS) initialWeekly[d.key] = new Set(court.blocked_hours?.[d.key] ?? []);
  const [weekly, setWeekly] = useState(initialWeekly);
  const toggleWeekly = (day: string, hour: number) => {
    setWeekly((prev) => {
      const next = { ...prev, [day]: new Set(prev[day]) };
      if (next[day].has(hour)) next[day].delete(hour); else next[day].add(hour);
      return next;
    });
  };
  const setAllDayWeekly = (day: string, block: boolean) => {
    setWeekly((prev) => ({ ...prev, [day]: new Set(block ? Array.from({ length: 24 }, (_, i) => i) : []) }));
  };

  // --- Per-date state
  const localISO = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const shiftDate = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + days); return localISO(d); };
  const [selectedDate, setSelectedDate] = useState<string>(localISO(new Date()));
  const [dateBlocks, setDateBlocks] = useState<Record<string, Set<number>>>(() => {
    const map: Record<string, Set<number>> = {};
    for (const [date, hrs] of Object.entries(court.blocked_dates ?? {})) map[date] = new Set(hrs);
    return map;
  });
  const hasOverride = Object.prototype.hasOwnProperty.call(dateBlocks, selectedDate);
  const currentDateSet = dateBlocks[selectedDate] ?? new Set<number>();
  const toggleDate = (hour: number) => {
    setDateBlocks((prev) => {
      const set = new Set(prev[selectedDate] ?? []);
      if (set.has(hour)) set.delete(hour); else set.add(hour);
      return { ...prev, [selectedDate]: set };
    });
  };
  const setAllForDate = (block: boolean) => {
    setDateBlocks((prev) => ({ ...prev, [selectedDate]: new Set(block ? Array.from({ length: 24 }, (_, i) => i) : []) }));
  };
  const clearOverride = () => {
    setDateBlocks((prev) => {
      const next = { ...prev };
      delete next[selectedDate];
      return next;
    });
  };

  const mut = useMutation({
    mutationFn: async () => {
      const weeklyPayload: Record<string, number[]> = {};
      for (const d of DAYS) weeklyPayload[d.key] = Array.from(weekly[d.key]).sort((a, b) => a - b);
      const datesPayload: Record<string, number[]> = {};
      for (const [date, set] of Object.entries(dateBlocks)) datesPayload[date] = Array.from(set).sort((a, b) => a - b);
      const { error } = await supabase.from("courts").update({ blocked_hours: weeklyPayload, blocked_dates: datesPayload }).eq("id", court.id);
      if (error) throw error;
    },
    onSuccess: onDone,
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div className="col-span-full rounded-xl border border-primary/40 bg-secondary/30 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">Availability · {court.name}</h3>
          <p className="text-xs text-muted-foreground">Weekly rules repeat every week. Specific-date overrides apply to that date only and do NOT inherit weekly blocks.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={onCancel} type="button" className="rounded-lg border border-border px-3 py-1.5 text-xs">Cancel</button>
          <button onClick={() => mut.mutate()} disabled={mut.isPending} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-60">
            {mut.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="mt-3 inline-flex rounded-lg border border-border bg-background p-0.5 text-xs">
        <button type="button" onClick={() => setMode("weekly")} className={"rounded-md px-3 py-1.5 font-semibold " + (mode === "weekly" ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>Weekly pattern</button>
        <button type="button" onClick={() => setMode("date")} className={"rounded-md px-3 py-1.5 font-semibold " + (mode === "date" ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>Specific date</button>
      </div>

      {mode === "weekly" ? (
        <div className="mt-4 space-y-3">
          {DAYS.map((d) => (
            <div key={d.key} className="rounded-lg border border-border bg-background p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{d.label}</span>
                <div className="flex gap-1 text-[10px]">
                  <button type="button" onClick={() => setAllDayWeekly(d.key, false)} className="rounded border border-border px-2 py-0.5 hover:border-primary hover:text-primary">Open all</button>
                  <button type="button" onClick={() => setAllDayWeekly(d.key, true)} className="rounded border border-border px-2 py-0.5 hover:border-destructive hover:text-destructive">Close all</button>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
                {Array.from({ length: 24 }, (_, h) => h).map((h) => {
                  const isBlocked = weekly[d.key].has(h);
                  return (
                    <button key={h} type="button" onClick={() => toggleWeekly(d.key, h)}
                      className={"rounded px-2 py-1.5 text-[11px] font-semibold leading-tight tabular-nums transition " + (isBlocked ? "bg-destructive/15 text-destructive ring-1 ring-destructive/30" : "bg-primary/10 text-primary hover:bg-primary/20")}>
                      {fmtHourShort(h)}–{fmtHourShort((h + 1) % 24)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-border bg-background p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Date:</span>
            <button type="button" onClick={() => setSelectedDate(shiftDate(selectedDate, -1))} className="rounded border border-border px-2 py-1 hover:border-primary hover:text-primary">←</button>
            <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="rounded border border-input bg-background px-2 py-1" />
            <button type="button" onClick={() => setSelectedDate(shiftDate(selectedDate, 1))} className="rounded border border-border px-2 py-1 hover:border-primary hover:text-primary">→</button>
            <span className={"ml-2 rounded-full px-2 py-0.5 " + (hasOverride ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
              {hasOverride ? "Override active (weekly ignored)" : "No override · weekly applies"}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap gap-1 text-[10px]">
            <button type="button" onClick={() => setAllForDate(false)} className="rounded border border-border px-2 py-0.5 hover:border-primary hover:text-primary">Open all day</button>
            <button type="button" onClick={() => setAllForDate(true)} className="rounded border border-border px-2 py-0.5 hover:border-destructive hover:text-destructive">Close all day</button>
            {hasOverride && (
              <button type="button" onClick={clearOverride} className="rounded border border-border px-2 py-0.5 hover:border-primary hover:text-primary">Remove override (use weekly)</button>
            )}
          </div>

          <p className="mt-2 text-[11px] text-muted-foreground">Tapping any hour creates a fresh override for this date starting empty — weekly blocked hours do NOT carry over.</p>

          <div className="mt-3 grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4">
            {Array.from({ length: 24 }, (_, h) => h).map((h) => {
              const isBlocked = currentDateSet.has(h);
              return (
                <button key={h} type="button" onClick={() => toggleDate(h)}
                  className={"rounded px-1.5 py-1 text-[10px] font-medium leading-tight transition " + (isBlocked ? "bg-destructive/20 text-destructive line-through" : "bg-primary/10 text-primary hover:bg-primary/20")}>
                  {fmtHour(h)} – {fmtHour((h + 1) % 24)}
                </button>
              );
            })}
          </div>

          {Object.keys(dateBlocks).length > 0 && (
            <div className="mt-4 border-t border-border pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Existing overrides</div>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(dateBlocks).sort(([a], [b]) => a.localeCompare(b)).map(([date, set]) => (
                  <li key={date}>
                    <button type="button" onClick={() => setSelectedDate(date)} className={"rounded-full border px-2 py-0.5 text-[11px] " + (date === selectedDate ? "border-primary bg-primary/10 text-primary" : "border-border hover:border-primary hover:text-primary")}>
                      {new Date(`${date}T00:00:00`).toLocaleDateString()} · {set.size} hr{set.size === 1 ? "" : "s"}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {err && <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
    </div>
  );
}



function useSportsQuery(enabled: boolean) {
  return useQuery({
    queryKey: ["sports"],
    queryFn: async () => {
      const { data, error } = await supabase.from("sports").select("id, name").order("name");
      if (error) throw error;
      return data as Sport[];
    },
    enabled,
  });
}

function parseList(input: string): string[] {
  return input.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

function AddCourt({ venueId, onCreated }: { venueId: number; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [rate, setRate] = useState("25");
  const [sportId, setSportId] = useState<string>("");
  const [isIndoor, setIsIndoor] = useState(false);
  const [description, setDescription] = useState("");
  const [amenities, setAmenities] = useState("");
  const [images, setImages] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const sportsQ = useSportsQuery(open);

  const mut = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("courts").insert({
        venue_id: venueId,
        sport_id: Number(sportId),
        name,
        hourly_rate: Number(rate),
        is_indoor: isIndoor,
        description: description || null,
        amenities: parseList(amenities),
        images: parseList(images),
      });

      if (error) throw error;
    },
    onSuccess: () => {
      setOpen(false); setName(""); setRate("25"); setSportId(""); setDescription(""); setAmenities(""); setImages(""); setErr(null);
      onCreated();
    },
    onError: (e: Error) => setErr(e.message),
  });

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="grid min-h-[128px] place-items-center rounded-xl border-2 border-dashed border-border p-4 text-sm font-medium text-muted-foreground hover:border-primary hover:text-primary">
        + Add court
      </button>
    );
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!sportId) { setErr("Pick a sport"); return; } mut.mutate(); }}
      className="col-span-full rounded-xl border border-border bg-secondary/30 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input label="Court name" value={name} onChange={setName} required />
        <Input label="Hourly rate (₱)" value={rate} onChange={setRate} type="number" required />
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Sport</span>
          <select value={sportId} onChange={(e) => setSportId(e.target.value)} required
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
            <option value="">Select…</option>
            {(sportsQ.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={isIndoor} onChange={(e) => setIsIndoor(e.target.checked)} />
          Indoor court
        </label>
      </div>
      <div className="mt-3 grid gap-3">
        <Textarea label="Description" value={description} onChange={setDescription} placeholder="Court size, surface, lighting, rules, etc." />
        <Textarea label="Amenities (comma or new line separated)" value={amenities} onChange={setAmenities} placeholder="Showers, Parking, Locker room, Water dispenser" />
        <Textarea label="Image URLs (one per line)" value={images} onChange={setImages} placeholder="https://…/court-1.jpg&#10;https://…/court-2.jpg" />
      </div>
      {err && <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
      <div className="mt-3 flex gap-2">
        <button disabled={mut.isPending} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60">
          {mut.isPending ? "Adding…" : "Add court"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-border px-4 py-2 text-sm">Cancel</button>
      </div>
    </form>
  );
}

function EditCourt({ court, onDone, onCancel }: { court: Court; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(court.name);
  const [rate, setRate] = useState(String(court.hourly_rate));
  const [isIndoor, setIsIndoor] = useState(court.is_indoor);
  const [description, setDescription] = useState(court.description ?? "");
  const [amenities, setAmenities] = useState((court.amenities ?? []).join(", "));
  const [images, setImages] = useState((court.images ?? []).join("\n"));
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("courts").update({
        name,
        hourly_rate: Number(rate),
        is_indoor: isIndoor,
        description: description || null,
        amenities: parseList(amenities),
        images: parseList(images),
      }).eq("id", court.id);
      if (error) throw error;
    },
    onSuccess: onDone,
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); mut.mutate(); }} className="col-span-full rounded-xl border border-primary/40 bg-secondary/30 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input label="Court name" value={name} onChange={setName} required />
        <Input label="Hourly rate (₱)" value={rate} onChange={setRate} type="number" required />
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={isIndoor} onChange={(e) => setIsIndoor(e.target.checked)} />
          Indoor court
        </label>
      </div>
      <div className="mt-3 grid gap-3">
        <Textarea label="Description" value={description} onChange={setDescription} />
        <Textarea label="Amenities (comma or new line separated)" value={amenities} onChange={setAmenities} />
        <Textarea label="Image URLs (one per line)" value={images} onChange={setImages} />
      </div>
      {err && <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
      <div className="mt-3 flex gap-2">
        <button disabled={mut.isPending} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60">
          {mut.isPending ? "Saving…" : "Save changes"}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-border px-4 py-2 text-sm">Cancel</button>
      </div>
    </form>
  );
}

function Textarea(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{props.label}</span>
      <textarea
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        rows={3}
        className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}


function Input(props: { label: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{props.label}</span>
      <input
        type={props.type ?? "text"}
        required={props.required}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}

export function osmEmbedUrl(lat: number, lng: number, delta = 0.005) {
  const bbox = [lng - delta, lat - delta, lng + delta, lat + delta].join(",");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;
}

function VenueLocation({ venue, onSaved }: { venue: Venue; onSaved: () => void }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: async ({ lat, lng }: { lat: number; lng: number }) => {
      const { error } = await supabase.from("venues").update({ latitude: lat, longitude: lng }).eq("id", venue.id);
      if (error) throw error;
    },
    onSuccess: () => { setPickerOpen(false); setErr(null); onSaved(); },
    onError: (e: Error) => setErr(e.message),
  });

  const hasLoc = venue.latitude != null && venue.longitude != null;

  return (
    <div className="w-full sm:w-72">
      {hasLoc ? (
        <div className="overflow-hidden rounded-xl border border-border">
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="group relative block w-full"
            title="Click to change pin"
          >
            <iframe
              title={`${venue.name} map`}
              src={osmEmbedUrl(venue.latitude!, venue.longitude!)}
              className="pointer-events-none h-32 w-full"
              loading="lazy"
            />
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 text-xs font-semibold text-transparent transition group-hover:bg-black/40 group-hover:text-white">
              ✎ Change pin
            </span>
          </button>
          <div className="flex items-center justify-between gap-2 bg-secondary/40 px-3 py-2 text-xs">
            <a href={`https://www.google.com/maps?q=${venue.latitude},${venue.longitude}`} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
              Open in Google Maps ↗
            </a>
            <button onClick={() => setPickerOpen(true)} className="rounded-md border border-border bg-background px-2 py-1 font-medium hover:border-primary hover:text-primary">Edit pin</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setPickerOpen(true)} className="w-full rounded-xl border-2 border-dashed border-border px-3 py-4 text-xs font-medium text-muted-foreground hover:border-primary hover:text-primary">
          📍 Add map location
        </button>
      )}
      {err && <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{err}</p>}
      <MapPicker
        open={pickerOpen}
        initialLat={venue.latitude}
        initialLng={venue.longitude}
        onClose={() => setPickerOpen(false)}
        onSave={(lat, lng) => mut.mutate({ lat, lng })}
        saving={mut.isPending}
        title={`Pin ${venue.name}`}
      />
    </div>
  );
}
