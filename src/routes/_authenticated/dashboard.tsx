import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

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
  sports: { name: string } | null;
};

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
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("venues").insert({ name, address, timezone });
      if (error) throw error;
    },
    onSuccess: () => { setName(""); setAddress(""); setErr(null); setOpen(!!compact ? false : false); onCreated(); },
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
    <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <h2 className="text-xl font-bold">{compact ? "New venue" : "Create your first venue"}</h2>
      <p className="mt-1 text-sm text-muted-foreground">A venue holds one or more courts.</p>
      <form onSubmit={(e) => { e.preventDefault(); mut.mutate(); }} className="mt-4 grid gap-3 sm:grid-cols-2">
        <Input label="Venue name" value={name} onChange={setName} required />
        <Input label="Address" value={address} onChange={setAddress} required />
        <Input label="Timezone" value={timezone} onChange={setTimezone} required />
        <div className="flex items-end gap-2">
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
  const bookingsQ = useQuery({
    queryKey: ["venue-bookings", venue.id, courtIds.join(",")],
    enabled: courtIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bookings")
        .select("id, court_id, start_time, end_time, status")
        .in("court_id", courtIds)
        .gte("end_time", new Date().toISOString())
        .order("start_time", { ascending: true })
        .limit(50);
      if (error) throw error;
      return data as { id: number; court_id: number; start_time: string; end_time: string; status: string }[];
    },
  });

  const courtName = (id: number) => courtsQ.data?.find((c) => c.id === id)?.name ?? `Court #${id}`;

  return (
    <section className="rounded-2xl border border-border bg-card shadow-sm">
      <header className="flex items-center justify-between border-b border-border p-6">
        <div>
          <h2 className="text-xl font-bold">{venue.name}</h2>
          <p className="text-sm text-muted-foreground">{venue.address} · {venue.timezone}</p>
        </div>
      </header>
      <div className="p-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(courtsQ.data ?? []).map((c) => (
            <CourtCard key={c.id} court={c} onChanged={() => qc.invalidateQueries({ queryKey: ["courts", venue.id] })} />
          ))}
          <AddCourt venueId={venue.id} onCreated={() => qc.invalidateQueries({ queryKey: ["courts", venue.id] })} />
        </div>


        <div className="mt-8">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Upcoming bookings</h3>
          {courtIds.length === 0 ? null : bookingsQ.isLoading ? (
            <div className="mt-3 h-16 animate-pulse rounded-lg bg-muted" />
          ) : (bookingsQ.data?.length ?? 0) === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No upcoming bookings yet.</p>
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
  if (editing) {
    return <EditCourt court={court} onDone={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />;
  }
  const cover = court.images?.[0];
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
          <button onClick={() => setEditing(true)} className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:border-primary hover:text-primary">Edit details</button>
        </div>
      </div>
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
        operating_hours: { mon: "08:00-22:00", tue: "08:00-22:00", wed: "08:00-22:00", thu: "08:00-22:00", fri: "08:00-22:00", sat: "08:00-22:00", sun: "08:00-22:00" },
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
