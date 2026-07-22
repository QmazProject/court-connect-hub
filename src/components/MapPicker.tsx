import { useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  initialLat: number | null;
  initialLng: number | null;
  onClose: () => void;
  onSave: (lat: number, lng: number) => void;
  saving?: boolean;
  title?: string;
};

export function MapPicker({ open, initialLat, initialLng, onClose, onSave, saving, title }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const streetLayerRef = useRef<any>(null);
  const satelliteLayerRef = useRef<any>(null);
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(
    initialLat != null && initialLng != null ? { lat: initialLat, lng: initialLng } : null
  );
  const [locBusy, setLocBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ display_name: string; lat: string; lon: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [view, setView] = useState<"street" | "satellite">("street");

  // Debounced Nominatim search
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 3) { setResults([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(q)}`,
          { signal: ctrl.signal, headers: { Accept: "application/json" } }
        );
        if (res.ok) setResults(await res.json());
      } catch { /* aborted */ }
      finally { setSearching(false); }
    }, 400);
    return () => { ctrl.abort(); clearTimeout(t); };
  }, [query, open]);

  const flyTo = async (lat: number, lng: number, zoom = 16) => {
    setPos({ lat, lng });
    const L = (await import("leaflet")).default ?? (await import("leaflet"));
    if (!mapRef.current) return;
    mapRef.current.setView([lat, lng], zoom);
    if (markerRef.current) markerRef.current.setLatLng([lat, lng]);
    else {
      const icon = L.icon({
        iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
        iconSize: [25, 41], iconAnchor: [12, 41],
      });
      markerRef.current = L.marker([lat, lng], { icon, draggable: true }).addTo(mapRef.current);
      markerRef.current.on("dragend", () => {
        const p = markerRef.current.getLatLng();
        setPos({ lat: p.lat, lng: p.lng });
      });
    }
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    (async () => {
      const L = (await import("leaflet")).default ?? (await import("leaflet"));
      // Inject CSS once
      if (!document.getElementById("leaflet-css")) {
        const link = document.createElement("link");
        link.id = "leaflet-css";
        link.rel = "stylesheet";
        link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        document.head.appendChild(link);
      }
      if (cancelled || !containerRef.current) return;

      const start: [number, number] =
        initialLat != null && initialLng != null ? [initialLat, initialLng] : [14.5995, 120.9842]; // Manila

      const map = L.map(containerRef.current, { zoomControl: false }).setView(start, initialLat != null ? 15 : 11);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap",
      }).addTo(map);

      const icon = L.icon({
        iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
        iconSize: [25, 41],
        iconAnchor: [12, 41],
      });

      if (initialLat != null && initialLng != null) {
        markerRef.current = L.marker([initialLat, initialLng], { icon, draggable: true }).addTo(map);
        markerRef.current.on("dragend", () => {
          const { lat, lng } = markerRef.current.getLatLng();
          setPos({ lat, lng });
        });
      }

      map.on("click", (e: any) => {
        const { lat, lng } = e.latlng;
        setPos({ lat, lng });
        if (markerRef.current) {
          markerRef.current.setLatLng(e.latlng);
        } else {
          markerRef.current = L.marker(e.latlng, { icon, draggable: true }).addTo(map);
          markerRef.current.on("dragend", () => {
            const p = markerRef.current.getLatLng();
            setPos({ lat: p.lat, lng: p.lng });
          });
        }
      });

      mapRef.current = map;
      setTimeout(() => map.invalidateSize(), 100);
    })();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const useMyLocation = () => {
    if (!navigator.geolocation) { setErr("Geolocation not supported."); return; }
    setLocBusy(true);
    navigator.geolocation.getCurrentPosition(
      async (p) => {
        const lat = p.coords.latitude, lng = p.coords.longitude;
        setPos({ lat, lng });
        setLocBusy(false);
        const L = (await import("leaflet")).default ?? (await import("leaflet"));
        if (mapRef.current) {
          mapRef.current.setView([lat, lng], 16);
          if (markerRef.current) markerRef.current.setLatLng([lat, lng]);
          else {
            const icon = L.icon({
              iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
              iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
              shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
              iconSize: [25, 41], iconAnchor: [12, 41],
            });
            markerRef.current = L.marker([lat, lng], { icon, draggable: true }).addTo(mapRef.current);
          }
        }
      },
      (e) => { setErr(e.message); setLocBusy(false); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="flex h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-background shadow-xl sm:h-[70vh] sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">{title ?? "Pin venue location"}</h3>
            <p className="text-xs text-muted-foreground">Tap the map to drop a pin. Drag to fine-tune.</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-secondary">✕</button>
        </div>

        <div className="border-b border-border px-4 py-2">
          <div className="relative">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a place, street, or landmark…"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-8 text-sm outline-none focus:border-primary"
            />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(""); setResults([]); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-xs text-muted-foreground hover:bg-secondary"
                aria-label="Clear"
              >✕</button>
            )}
            {(results.length > 0 || searching) && (
              <ul className="absolute left-0 right-0 top-full z-[1000] mt-1 max-h-60 overflow-auto rounded-lg border border-border bg-background shadow-lg">
                {searching && <li className="px-3 py-2 text-xs text-muted-foreground">Searching…</li>}
                {results.map((r, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => { flyTo(Number(r.lat), Number(r.lon)); setResults([]); setQuery(r.display_name.split(",")[0]); }}
                      className="block w-full px-3 py-2 text-left text-xs hover:bg-secondary"
                    >
                      {r.display_name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div ref={containerRef} className="flex-1" style={{ minHeight: 240 }} />

        <div className="space-y-2 border-t border-border bg-secondary/30 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <button
              type="button"
              onClick={useMyLocation}
              disabled={locBusy}
              className="rounded-md border border-border bg-background px-2 py-1 font-medium hover:border-primary hover:text-primary disabled:opacity-60"
            >
              {locBusy ? "Locating…" : "📍 Use my location"}
            </button>
            {pos ? (
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${pos.lat},${pos.lng}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-border bg-background px-2 py-1 font-medium hover:border-primary hover:text-primary"
              >
                View on Google Maps ↗
              </a>
            ) : (
              <span className="font-mono text-muted-foreground">No pin yet</span>
            )}
          </div>
          {pos && (
            <p className="font-mono text-[11px] text-muted-foreground">
              📍 {pos.lat.toFixed(6)}, {pos.lng.toFixed(6)}
            </p>
          )}
          {err && <p className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{err}</p>}
          <div className="flex gap-2">
            <button
              disabled={!pos || saving}
              onClick={() => pos && onSave(pos.lat, pos.lng)}
              className="flex-1 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save pin"}
            </button>
            <button onClick={onClose} className="rounded-md border border-border px-3 py-2 text-sm">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
