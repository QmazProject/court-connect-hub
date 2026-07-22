import { useEffect, useRef, useState } from "react";

export type MapVenue = {
  id: number;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  courtCount: number;
  minRate: number | null;
  courts: { id: number; name: string; hourly_rate: number }[];
};

type Props = {
  venues: MapVenue[];
  activeVenueId: number | null;
  onSelectVenue: (id: number | null) => void;
  onOpenVenue: (id: number) => void;
  onOpenCourt: (courtId: number) => void;
  nearby: { lat: number; lng: number } | null;
};

// Spread court markers evenly around a venue on a small circle.
function courtOffset(lat: number, lng: number, i: number, total: number) {
  const R = 0.00035; // ~35–40m
  const angle = (i / total) * Math.PI * 2 - Math.PI / 2;
  return { lat: lat + Math.sin(angle) * R, lng: lng + Math.cos(angle) * R / Math.cos((lat * Math.PI) / 180) };
}

function divIcon(L: any, html: string, size = 44, className = "") {
  return L.divIcon({
    className: `ch-marker ${className}`,
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export function VenueMap({ venues, activeVenueId, onSelectVenue, onOpenVenue, onOpenCourt, nearby }: Props) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const meRef = useRef<any>(null);
  const streetLayerRef = useRef<any>(null);
  const satelliteLayerRef = useRef<any>(null);
  const readyRef = useRef(false);
  const [view, setView] = useState<"street" | "satellite">("street");

  // Init map once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default ?? (await import("leaflet"));
      if (!document.getElementById("leaflet-css")) {
        const link = document.createElement("link");
        link.id = "leaflet-css";
        link.rel = "stylesheet";
        link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        document.head.appendChild(link);
      }
      if (!document.getElementById("ch-marker-css")) {
        const s = document.createElement("style");
        s.id = "ch-marker-css";
        s.textContent = `
          .ch-marker { background: transparent !important; border: 0 !important; }
          @keyframes ch-bounce { 0%,100% { transform: translateY(0);} 50% { transform: translateY(-6px);} }
          @keyframes ch-pulse-ring { 0% { transform: scale(0.6); opacity:.7;} 100% { transform: scale(1.7); opacity:0;} }
          @keyframes ch-wiggle { 0%,100% { transform: rotate(-8deg);} 50% { transform: rotate(8deg);} }
          .ch-pin { position: relative; width: 52px; height: 52px; cursor: pointer; animation: ch-bounce 1.8s ease-in-out infinite; }
          .ch-pin::before { content:""; position:absolute; inset:4px; border-radius:9999px; background: hsl(var(--primary)); opacity:.35; animation: ch-pulse-ring 1.8s ease-out infinite; z-index:0; }
          .ch-pin:hover { animation-play-state: paused; }
          .ch-pin .body { position:absolute; inset:0; border-radius:9999px; background: hsl(var(--card)); border:2px solid hsl(var(--primary)); box-shadow: 0 8px 22px rgba(0,0,0,.22), 0 0 0 4px rgba(9,230,210,.18); display:flex; align-items:center; justify-content:center; font-size:22px; z-index:1; }
          .ch-pin .body .emoji { display:inline-block; animation: ch-wiggle 1.6s ease-in-out infinite; transform-origin:center; }
          .ch-pin .count { position:absolute; top:-4px; right:-4px; min-width:20px; height:20px; padding:0 5px; border-radius:9999px; background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); font-size:11px; font-weight:800; display:flex; align-items:center; justify-content:center; box-shadow: 0 2px 6px rgba(0,0,0,.25); z-index:2; }
          .ch-pin.active .body { background: hsl(var(--primary)); border-color: hsl(var(--primary)); }
          .ch-pin .tip { position:absolute; left:50%; bottom:-6px; width:10px; height:10px; background: hsl(var(--card)); border-right:2px solid hsl(var(--primary)); border-bottom:2px solid hsl(var(--primary)); transform: translateX(-50%) rotate(45deg); z-index:1; }
          .ch-pin.active .tip { background: hsl(var(--primary)); }
          .ch-court { width: 40px; height: 40px; animation: ch-bounce 2.2s ease-in-out infinite; }
          .ch-court::before { display:none; }
          .ch-court .body { background: hsl(var(--card)); color: hsl(var(--foreground)); border-color: hsl(var(--primary)); font-size:16px; }
          .ch-me { width:18px; height:18px; border-radius:9999px; background:#3b82f6; border:3px solid #fff; box-shadow: 0 0 0 6px rgba(59,130,246,.25); }
          .ch-popup .leaflet-popup-content-wrapper { border-radius: 14px; padding: 2px; }
          .ch-popup .leaflet-popup-content { margin: 10px 12px; font-family: inherit; }
        `;
        document.head.appendChild(s);
      }
      if (cancelled || !elRef.current) return;

      const map = L.map(elRef.current, { zoomControl: false }).setView([12.8797, 121.774], 6); // PH center
      L.control.zoom({ position: "topright" }).addTo(map);
      L.control.zoom({ position: "topright" }).addTo(map);
      const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap",
      });
      const satellite = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 19, attribution: "Tiles © Esri" }
      );
      street.addTo(map);
      streetLayerRef.current = street;
      satelliteLayerRef.current = satellite;
      mapRef.current = map;
      layerRef.current = L.layerGroup().addTo(map);
      readyRef.current = true;
      setTimeout(() => map.invalidateSize(), 60);

      // Deselect on background click
      map.on("click", () => onSelectVenue(null));
    })();
    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        layerRef.current = null;
        meRef.current = null;
        readyRef.current = false;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Nearby "me" marker
  useEffect(() => {
    (async () => {
      if (!readyRef.current) return;
      const L = (await import("leaflet")).default ?? (await import("leaflet"));
      if (meRef.current) { mapRef.current.removeLayer(meRef.current); meRef.current = null; }
      if (nearby) {
        meRef.current = L.marker([nearby.lat, nearby.lng], {
          icon: L.divIcon({ className: "ch-marker", html: `<div class="ch-me"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
        }).addTo(mapRef.current);
      }
    })();
  }, [nearby]);

  // Render pins whenever venues / active change
  useEffect(() => {
    (async () => {
      if (!readyRef.current) return;
      const L = (await import("leaflet")).default ?? (await import("leaflet"));
      const layer = layerRef.current;
      layer.clearLayers();

      const pinned = venues.filter((v) => v.latitude != null && v.longitude != null);
      if (pinned.length === 0) return;

      const active = activeVenueId != null ? pinned.find((v) => v.id === activeVenueId) : null;

      if (active && active.latitude != null && active.longitude != null) {
        // Show center venue pin + individual court pins around it
        const vLat = active.latitude as number;
        const vLng = active.longitude as number;

        const centerHtml = `<div class="ch-pin active"><div class="body"><span class="emoji">🏟️</span></div><div class="count">${active.courtCount}</div><div class="tip"></div></div>`;
        const centerIcon = divIcon(L, centerHtml);
        const centerMarker = L.marker([vLat, vLng], { icon: centerIcon }).addTo(layer);
        centerMarker.bindPopup(
          `<div class="ch-popup-inner"><div style="font-weight:700;font-size:13px;">${active.name}</div><div style="font-size:11px;opacity:.7;">${active.address}</div></div>`,
          { className: "ch-popup", closeButton: false }
        );
        centerMarker.on("mouseover", () => centerMarker.openPopup());

        const courts = active.courts;
        courts.forEach((c, i) => {
          const p = courtOffset(vLat, vLng, i, Math.max(courts.length, 1));
          const html = `<div class="ch-pin ch-court"><div class="body"><span class="emoji">🎾</span></div><div class="count">${i + 1}</div><div class="tip"></div></div>`;
          const m = L.marker([p.lat, p.lng], { icon: divIcon(L, html, 34, "ch-court") }).addTo(layer);
          m.bindPopup(
            `<div class="ch-popup-inner"><div style="font-weight:700;font-size:13px;">${c.name}</div><div style="font-size:11px;opacity:.7;">₱${Number(c.hourly_rate).toFixed(0)} / hour</div><div style="margin-top:6px;font-size:11px;color:hsl(var(--primary));font-weight:600;">Tap to book →</div></div>`,
            { className: "ch-popup", closeButton: false }
          );
          m.on("mouseover", () => m.openPopup());
          m.on("click", (e: any) => { e.originalEvent?.stopPropagation?.(); onOpenCourt(c.id); });
        });

        // Zoom in to venue
        mapRef.current.flyTo([vLat, vLng], 18, { duration: 0.6 });
      } else {
        // Show all venue pins
        pinned.forEach((v) => {
          const html = `<div class="ch-pin"><div class="body">${v.courtCount}</div><div class="tip"></div></div>`;
          const m = L.marker([v.latitude as number, v.longitude as number], { icon: divIcon(L, html) }).addTo(layer);
          m.bindPopup(
            `<div class="ch-popup-inner"><div style="font-weight:700;font-size:13px;">${v.name}</div><div style="font-size:11px;opacity:.7;">${v.address}</div>${v.minRate != null ? `<div style="margin-top:4px;font-size:12px;color:hsl(var(--primary));font-weight:700;">From ₱${v.minRate.toFixed(0)}/hr · ${v.courtCount} ${v.courtCount === 1 ? "court" : "courts"}</div>` : ""}</div>`,
            { className: "ch-popup", closeButton: false }
          );
          m.on("mouseover", () => m.openPopup());
          m.on("click", (e: any) => {
            e.originalEvent?.stopPropagation?.();
            onSelectVenue(v.id);
          });
        });

        // Fit bounds
        const bounds = L.latLngBounds(pinned.map((v) => [v.latitude as number, v.longitude as number]));
        if (nearby) bounds.extend([nearby.lat, nearby.lng]);
        mapRef.current.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
      }
    })();
  }, [venues, activeVenueId, onSelectVenue, onOpenCourt, nearby]);

  // Double-click a venue pin (via list) opens venue page
  useEffect(() => {
    // exposed via onOpenVenue; not wired to a specific dom event here
    void onOpenVenue;
  }, [onOpenVenue]);

  return (
    <>
      <div ref={elRef} className="absolute inset-0" />
      <div className="absolute left-3 top-3 z-[500] inline-flex overflow-hidden rounded-lg border border-border bg-background shadow">
        <button
          type="button"
          onClick={() => {
            if (view === "street" || !mapRef.current) return;
            mapRef.current.removeLayer(satelliteLayerRef.current);
            streetLayerRef.current.addTo(mapRef.current);
            setView("street");
          }}
          className={`px-3 py-1.5 text-xs font-medium ${view === "street" ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}
        >
          🗺️ Street
        </button>
        <button
          type="button"
          onClick={() => {
            if (view === "satellite" || !mapRef.current) return;
            mapRef.current.removeLayer(streetLayerRef.current);
            satelliteLayerRef.current.addTo(mapRef.current);
            setView("satellite");
          }}
          className={`px-3 py-1.5 text-xs font-medium ${view === "satellite" ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}
        >
          🛰️ Satellite
        </button>
      </div>
    </>
  );
}
