import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const REPORT_CATEGORIES = [
  { icon: "📍", label: "Place address or location" },
  { icon: "🛣️", label: "Road or road name" },
  { icon: "🚫", label: "Explicit content (profanity, vandalism, hate speech)" },
  { icon: "🗺️", label: "Border of country, state, or city" },
  { icon: "🏷️", label: "Name of country, state, city, or landmark" },
  { icon: "🌳", label: "Feature such as water body, park, or terrain" },
  { icon: "📌", label: "Pin location is incorrect" },
  { icon: "❓", label: "Other" },
];

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
  const activeRef = useRef<{ id: number | null; lat: number; lng: number } | null>(null);
  const rezoomingRef = useRef(false);
  const [view, setView] = useState<"street" | "satellite">("street");
  const [showAttrib, setShowAttrib] = useState(false);
  const [showLegal, setShowLegal] = useState(false);
  const [reportCategory, setReportCategory] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportDesc, setReportDesc] = useState("");
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportSent, setReportSent] = useState(false);

  function closeReport() {
    setReportOpen(false);
    setReportCategory(null);
    setReportDesc("");
    setReportSent(false);
    setReportSubmitting(false);
  }

  async function submitReport() {
    if (!reportCategory || !reportDesc.trim()) return;
    setReportSubmitting(true);
    const center = mapRef.current?.getCenter?.();
    const { data: userData } = await supabase.auth.getUser();
    const { error } = await supabase.from("map_problems").insert({
      category: reportCategory,
      description: reportDesc.trim().slice(0, 2000),
      latitude: center?.lat ?? null,
      longitude: center?.lng ?? null,
      user_id: userData?.user?.id ?? null,
    });
    setReportSubmitting(false);
    if (error) {
      alert("Could not send report: " + error.message);
      return;
    }
    setReportSent(true);
  }


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
          @keyframes ch-pulse-ring { 0% { transform: scale(0.6); opacity:.75;} 100% { transform: scale(1.8); opacity:0;} }
          @keyframes ch-arrow-bounce { 0%,100% { transform: translate(-50%, 0);} 50% { transform: translate(-50%, 6px);} }
          .ch-pin { position: relative; width: 52px; height: 52px; cursor: pointer; }
          .ch-pin::before { content:""; position:absolute; inset:4px; border-radius:9999px; background: #ef4444; opacity:.55; animation: ch-pulse-ring 1.6s ease-out infinite; z-index:0; }
          .ch-pin .body { position:absolute; inset:0; border-radius:9999px; background: hsl(var(--card)); border:2px solid #ef4444; box-shadow: 0 8px 22px rgba(0,0,0,.22), 0 0 0 4px rgba(239,68,68,.2); display:flex; align-items:center; justify-content:center; font-size:22px; z-index:1; }
          .ch-pin .body .emoji { display:inline-block; }
          .ch-pin .count { position:absolute; top:-4px; right:-4px; min-width:20px; height:20px; padding:0 5px; border-radius:9999px; background:#ef4444; color:#fff; font-size:11px; font-weight:800; display:flex; align-items:center; justify-content:center; box-shadow: 0 2px 6px rgba(0,0,0,.25); z-index:2; }
          .ch-pin.active .body { background:#ef4444; border-color:#ef4444; }
          .ch-pin .tip { position:absolute; left:50%; bottom:-6px; width:10px; height:10px; background: hsl(var(--card)); border-right:2px solid #ef4444; border-bottom:2px solid #ef4444; transform: translateX(-50%) rotate(45deg); z-index:1; }
          .ch-pin.active .tip { background:#ef4444; }
          .ch-pin .arrow { position:absolute; left:50%; top:-26px; transform: translateX(-50%); width:0; height:0; border-left:9px solid transparent; border-right:9px solid transparent; border-top:14px solid #ef4444; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); animation: ch-arrow-bounce 1.1s ease-in-out infinite; z-index:3; }
          .ch-court { width: 40px; height: 40px; }
          .ch-court .body { background: hsl(var(--card)); color: hsl(var(--foreground)); border-color:#ef4444; font-size:16px; }
          .ch-court .point-wrap { position:absolute; inset:0; pointer-events:none; z-index:3; }
          .ch-court .point-wrap .point { position:absolute; left:50%; top:-10px; width:0; height:0; margin-left:-6px; border-left:6px solid transparent; border-right:6px solid transparent; border-bottom:10px solid #ef4444; filter: drop-shadow(0 1px 2px rgba(0,0,0,.4)); }
          .ch-me { width:18px; height:18px; border-radius:9999px; background:#3b82f6; border:3px solid #fff; box-shadow: 0 0 0 6px rgba(59,130,246,.25); }
          .ch-popup .leaflet-popup-content-wrapper { border-radius: 14px; padding: 2px; }
          .ch-popup .leaflet-popup-content { margin: 10px 12px; font-family: inherit; }
        `;

        document.head.appendChild(s);
      }
      if (cancelled || !elRef.current) return;

      const map = L.map(elRef.current, { zoomControl: false, attributionControl: false }).setView([12.8797, 121.774], 6); // PH center
      L.control.zoom({ position: "topright" }).addTo(map);
      const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "",
      });
      const satellite = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 19, attribution: "" }
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

      // If the user zooms out past the scatter threshold, deselect the venue
      // so the courts collapse back into a single venue pin and the right-side
      // list re-adapts to show all venues.
      map.on("zoomend", () => {
        const a = activeRef.current;
        if (!a || a.id == null) return;
        if (rezoomingRef.current) return;
        if (map.getZoom() < 17) {
          onSelectVenue(null);
        }
      });
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
        activeRef.current = { id: active.id, lat: vLat, lng: vLng };

        const centerHtml = `<div class="ch-pin active"><div class="arrow"></div><div class="body"><span class="emoji">🎾</span></div><div class="count">${active.courtCount}</div><div class="tip"></div></div>`;
        const centerIcon = divIcon(L, centerHtml);
        const centerMarker = L.marker([vLat, vLng], { icon: centerIcon }).addTo(layer);
        centerMarker.bindPopup(
          `<div class="ch-popup-inner"><div style="font-weight:700;font-size:13px;">${active.name}</div><div style="font-size:11px;opacity:.7;">${active.address}</div></div>`,
          { className: "ch-popup", closeButton: false }
        );
        centerMarker.on("mouseover", () => centerMarker.openPopup());

        const courts = active.courts;
        courts.forEach((c, i) => {
          const total = Math.max(courts.length, 1);
          const angle = (i / total) * Math.PI * 2 - Math.PI / 2;
          // CSS rotation (clockwise from up) so the arrow points from court back to venue
          const rotDeg = (Math.atan2(-Math.cos(angle), -Math.sin(angle)) * 180) / Math.PI;
          const p = courtOffset(vLat, vLng, i, total);
          const html = `<div class="ch-pin ch-court"><div class="point-wrap" style="transform: rotate(${rotDeg}deg)"><div class="point"></div></div><div class="body"><span class="emoji">🎾</span></div><div class="count">${i + 1}</div></div>`;
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
        activeRef.current = null;
        // Show all venue pins
        pinned.forEach((v) => {
          const html = `<div class="ch-pin"><div class="body"><span class="emoji">🎾</span></div><div class="count">${v.courtCount}</div><div class="tip"></div></div>`;
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
      <div className="absolute bottom-3 right-3 z-[500]">
        <button
          type="button"
          onClick={() => setShowAttrib((s) => !s)}
          aria-label="Map information"
          title="Map information"
          className={`inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background/95 text-sm font-semibold shadow hover:bg-secondary ${showAttrib ? "ring-2 ring-primary" : ""}`}
        >
          i
        </button>
        {showAttrib && (
          <>
            <div className="fixed inset-0 z-[600]" onClick={() => setShowAttrib(false)} />
            <div className="absolute bottom-10 right-0 z-[700] w-64 overflow-hidden rounded-xl border border-border bg-background shadow-xl">
              <button
                type="button"
                onClick={() => { setShowAttrib(false); alert("Report a map problem — coming soon."); }}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-secondary"
              >
                <span aria-hidden className="text-base">⚠️</span>
                <span>Report a problem with map</span>
              </button>
              <button
                type="button"
                onClick={() => { setShowAttrib(false); setShowLegal(true); }}
                className="flex w-full items-center gap-3 border-t border-border px-3 py-2.5 text-left text-sm hover:bg-secondary"
              >
                <span aria-hidden className="text-base">📄</span>
                <span>Map data legal notices</span>
              </button>
              <a
                href="https://www.openstreetmap.org/copyright/"
                target="_blank"
                rel="noreferrer"
                onClick={() => setShowAttrib(false)}
                className="flex w-full items-center gap-3 border-t border-border px-3 py-2.5 text-left text-sm hover:bg-secondary"
              >
                <span aria-hidden className="text-base">🗺️</span>
                <span>OpenStreetMap</span>
              </a>
              <div className="pointer-events-none absolute -bottom-1.5 right-3 h-3 w-3 rotate-45 border-b border-r border-border bg-background" />
            </div>
          </>
        )}
      </div>
      {showLegal && (
        <div
          className="absolute inset-0 z-[1000] flex items-end justify-center bg-black/40 p-3 sm:items-center"
          onClick={() => setShowLegal(false)}
        >
          <div
            className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-background p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-base font-semibold">Map Data Legal Notices</h3>
              <button
                type="button"
                onClick={() => setShowLegal(false)}
                className="rounded-md px-2 py-1 text-sm hover:bg-secondary"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="space-y-3 text-sm">
              <div>
                <div className="font-medium">OpenStreetMap</div>
                <div className="text-muted-foreground">© OpenStreetMap contributors</div>
                <a href="https://www.openstreetmap.org/copyright/" target="_blank" rel="noreferrer" className="text-primary hover:underline">openstreetmap.org/copyright</a>
              </div>
              <div>
                <div className="font-medium">Overture Maps Foundation</div>
                <div className="text-muted-foreground">Buildings: © OSM contributors, Microsoft, Esri Community Maps, Google Open Buildings, USGS 3DEP. Transportation: © OSM contributors. Base: © OSM contributors, ESA WorldCover.</div>
                <a href="https://docs.overturemaps.org/attribution/" target="_blank" rel="noreferrer" className="text-primary hover:underline">docs.overturemaps.org/attribution</a>
              </div>
              <div>
                <div className="font-medium">Natural Earth</div>
                <div className="text-muted-foreground">Made with Natural Earth.</div>
                <a href="https://www.naturalearthdata.com/" target="_blank" rel="noreferrer" className="text-primary hover:underline">naturalearthdata.com</a>
              </div>
              <div>
                <div className="font-medium">Esri</div>
                <a href="https://www.esri.com/en-us/legal/requirements/open-source-acknowledgements" target="_blank" rel="noreferrer" className="text-primary hover:underline">Open source acknowledgements</a>
              </div>
              <div>
                <div className="font-medium">City of Toronto</div>
                <div className="text-muted-foreground">Contains data licensed under Open Government License – Toronto.</div>
              </div>
              <div>
                <div className="font-medium">Open Data DC</div>
                <div className="text-muted-foreground">© DC GIS for D.C. OCTO. CC BY 4.0.</div>
              </div>
              <div>
                <div className="font-medium">City of Austin, Texas</div>
                <div className="text-muted-foreground">Public domain / PDDL — data.austintexas.gov</div>
              </div>
              <div>
                <div className="font-medium">Madrid City Council</div>
                <div className="text-muted-foreground">Public domain data licensed by Madrid City Council.</div>
              </div>
              <div>
                <div className="font-medium">City of Montreal</div>
                <div className="text-muted-foreground">© City of Montreal — CC BY 4.0.</div>
              </div>
              <div>
                <div className="font-medium">Delaware Valley Regional Planning Commission (DVRPC)</div>
                <div className="text-muted-foreground">© DVRPC.</div>
              </div>
              <div>
                <div className="font-medium">Canadian Pedestrian Network Database</div>
                <div className="text-muted-foreground">Open Government Licence – Canada.</div>
              </div>
              <div>
                <div className="font-medium">San Bernardino County</div>
                <div className="text-muted-foreground">© San Bernardino County — CC BY 4.0.</div>
              </div>
              <div>
                <div className="font-medium">UK Gov Food Safety</div>
                <a href="https://www.food.gov.uk/terms-and-conditions" target="_blank" rel="noreferrer" className="text-primary hover:underline">Terms & conditions</a>
              </div>
              <div>
                <div className="font-medium">Chicago Data Portal</div>
                <a href="https://www.chicago.gov/city/en/narr/foia/data_disclaimer.html" target="_blank" rel="noreferrer" className="text-primary hover:underline">Data disclaimer</a>
              </div>
              <div>
                <div className="font-medium">Houston-Galveston Area Council</div>
                <div className="text-muted-foreground">gishub-h-gac.hub.arcgis.com</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
