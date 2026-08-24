import { useEffect, useRef, useState } from "react";
import { MapInfoButton } from "./MapInfoButton";
import { MapPegman } from "./MapPegman";

export type MapVenue = {
  id: number;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  courtCount: number;
  minRate: number | null;
  /** Dearest ₱/hr across this venue's courts once time-based rules apply. Null
   *  when unknown; equal to `minRate` when nothing varies. */
  maxRate?: number | null;
  mapEmoji: string | null;
  courts: { id: number; name: string; hourly_rate: number; mapEmoji: string | null }[];
};

type Props = {
  venues: MapVenue[];
  activeVenueId: number | null;
  onSelectVenue: (id: number | null) => void;
  onOpenVenue: (id: number) => void;
  onOpenCourt: (courtId: number) => void;
  nearby: { lat: number; lng: number } | null;
  radiusKm?: number | null;
  radiusHasMatches?: boolean;
  /**
   * Kept pointed at the map's current centre so callers can bias place search
   * toward whatever the user is looking at. A ref, not a callback, so panning
   * never re-renders the parent.
   */
  centerRef?: React.MutableRefObject<{ lat: number; lng: number } | null>;
};

// Spread court markers evenly around a venue on a small circle.
function courtOffset(lat: number, lng: number, i: number, total: number) {
  const R = 0.00035; // ~35–40m
  const angle = (i / total) * Math.PI * 2 - Math.PI / 2;
  return { lat: lat + Math.sin(angle) * R, lng: lng + Math.cos(angle) * R / Math.cos((lat * Math.PI) / 180) };
}
function buildDirUrl(lat: number, lng: number, from: { lat: number; lng: number } | null) {
  const base = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  return from ? `${base}&origin=${from.lat},${from.lng}` : base;
}


function divIcon(L: any, html: string, size = 44, className = "") {
  return L.divIcon({
    className: `ch-marker ${className}`,
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export function VenueMap({ venues, activeVenueId, onSelectVenue, onOpenVenue, onOpenCourt, nearby, radiusKm, radiusHasMatches, centerRef }: Props) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const meRef = useRef<any>(null);
  const circleRef = useRef<any>(null);
  const streetLayerRef = useRef<any>(null);
  const satelliteLayerRef = useRef<any>(null);
  const readyRef = useRef(false);
  /* readyRef alone was not enough. Leaflet is imported dynamically, so the map becomes ready
     asynchronously — and if the venues query resolved first, the pin effect below ran, saw
     readyRef.current === false, and returned. A ref does not re-render, so nothing ever ran
     it again and the map stayed empty while the list showed a full set of venues. Mirroring
     readiness into state gives those effects something to depend on. */
  const [mapReady, setMapReady] = useState(false);
  const activeRef = useRef<{ id: number | null; lat: number; lng: number } | null>(null);
  const rezoomingRef = useRef(false);
  const userInteractedRef = useRef(false);
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
          @keyframes ch-pulse-ring { 0% { transform: scale(0.6); opacity:.75;} 100% { transform: scale(1.8); opacity:0;} }
          @keyframes ch-arrow-bounce { 0%,100% { transform: translate(-50%, 0);} 50% { transform: translate(-50%, 6px);} }
          .ch-pin { position: relative; width: 52px; height: 52px; cursor: pointer; }
          .ch-pin::before { content:""; position:absolute; inset:4px; border-radius:9999px; background: #b8f05a; opacity:.55; animation: ch-pulse-ring 1.6s ease-out infinite; z-index:0; }
          .ch-pin .body { position:absolute; inset:0; border-radius:9999px; background: hsl(var(--card)); border:2px solid #12806d; box-shadow: 0 8px 22px rgba(0,0,0,.22), 0 0 0 4px rgba(18,128,109,.2); display:flex; align-items:center; justify-content:center; font-size:22px; z-index:1; }
          .ch-pin .body .emoji { display:inline-block; }
          .ch-pin .count { position:absolute; top:-4px; right:-4px; min-width:20px; height:20px; padding:0 5px; border-radius:9999px; background:#12806d; color:#fff; font-size:11px; font-weight:800; display:flex; align-items:center; justify-content:center; box-shadow: 0 2px 6px rgba(0,0,0,.25); z-index:2; }
          .ch-pin.active .body { background:#12806d; border-color:#b8f05a; }
          .ch-pin .tip { position:absolute; left:50%; bottom:-6px; width:10px; height:10px; background: hsl(var(--card)); border-right:2px solid #12806d; border-bottom:2px solid #12806d; transform: translateX(-50%) rotate(45deg); z-index:1; }
          .ch-pin.active .tip { background:#12806d; border-color:#b8f05a; }
          .ch-pin .arrow { position:absolute; left:50%; top:-26px; transform: translateX(-50%); width:0; height:0; border-left:9px solid transparent; border-right:9px solid transparent; border-top:14px solid #b8f05a; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); animation: ch-arrow-bounce 1.1s ease-in-out infinite; z-index:3; }
          .ch-court { width: 40px; height: 40px; }
          .ch-court .body { background: hsl(var(--card)); color: hsl(var(--foreground)); border-color:#12806d; font-size:16px; }
          .ch-court .point-wrap { position:absolute; inset:0; pointer-events:none; z-index:3; }
          .ch-court .point-wrap .point { position:absolute; left:50%; top:-10px; width:0; height:0; margin-left:-6px; border-left:6px solid transparent; border-right:6px solid transparent; border-bottom:10px solid #12806d; filter: drop-shadow(0 1px 2px rgba(0,0,0,.4)); }
          .ch-me { width:18px; height:18px; border-radius:9999px; background:#12806d; border:3px solid #fff; box-shadow: 0 0 0 6px rgba(184,240,90,.5); }
          .ch-popup .leaflet-popup-content-wrapper { border-radius: 14px; padding: 2px; }
          .ch-popup .leaflet-popup-content { margin: 10px 12px; font-family: inherit; }
          .leaflet-tooltip.ch-tip-wrap { background: #ffffff; color: #0f172a; border: 1px solid rgba(0,0,0,.08); border-radius: 10px; box-shadow: 0 6px 18px rgba(0,0,0,.18); padding: 6px 10px; font-family: inherit; white-space: nowrap; max-width: none; pointer-events: auto; }
          .ch-tip-dir { display:inline-flex; align-items:center; gap:4px; font-size:11px; font-weight:700; color:#126152; text-decoration:none; padding:3px 8px; border-radius:9999px; background:rgba(184,240,90,.28); border:1px solid rgba(18,128,109,.35); }
          .ch-tip-dir:hover { background:rgba(184,240,90,.5); }
          .ch-dir-btn { display:inline-flex; align-items:center; gap:6px; margin-top:8px; font-size:12px; font-weight:700; color:#126152; text-decoration:none; padding:5px 10px; border-radius:9999px; background:rgba(184,240,90,.28); border:1px solid rgba(18,128,109,.35); }
          .ch-dir-btn:hover { background:rgba(184,240,90,.5); }
          .leaflet-tooltip.ch-tip-wrap::before { border-top-color: #ffffff; }
          .ch-tip { display: inline-flex; align-items: center; gap: 8px; }
          .ch-tip-sep { width: 1px; height: 12px; background: rgba(0,0,0,.12); flex: none; }
          .ch-tip-name { font-weight: 700; font-size: 12px; line-height: 1.2; color: #0f172a; }
          .ch-tip-addr { font-size: 11px; color: #64748b; line-height: 1.2; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
          .ch-tip-rate { font-size: 11px; font-weight: 700; color: #12806d; }
          .ch-tip-rate.ch-tip-muted { color: #64748b; font-weight: 600; }
          @keyframes ch-signal { 0% { transform: scale(0.05); opacity: .85; } 100% { transform: scale(1); opacity: 0; } }
          .ch-radius-base { transition: stroke .3s ease, fill .3s ease; }
          .ch-radius-ping { transform-box: fill-box; transform-origin: center; animation: ch-signal 2.6s ease-out infinite; }
          .ch-radius-ping-2 { animation-delay: 0.87s; }
          .ch-radius-ping-3 { animation-delay: 1.73s; }
        `;

        document.head.appendChild(s);
      }
      if (cancelled || !elRef.current) return;

      const map = L.map(elRef.current, { zoomControl: false, attributionControl: false }).setView([12.8797, 121.774], 6); // PH center
      L.control.zoom({ position: "bottomright" }).addTo(map);
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
      setMapReady(true);
      setTimeout(() => map.invalidateSize(), 60);

      // Deselect on background click
      map.on("click", () => onSelectVenue(null));

      // Publish the viewport centre for proximity-biased place search.
      const publishCenter = () => {
        if (!centerRef) return;
        const c = map.getCenter();
        centerRef.current = { lat: c.lat, lng: c.lng };
      };
      publishCenter();
      map.on("moveend", publishCenter);

      // Track user-initiated map interactions so we don't auto-refit their view.
      map.on("zoomstart", (e: any) => {
        if (!rezoomingRef.current) userInteractedRef.current = true;
      });
      map.on("dragstart", () => { userInteractedRef.current = true; });

      // While a venue is active (scattered court view), keep the user zoomed in
      // on that venue — if they zoom out, snap back to the venue focus.
      map.on("zoomend", () => {
        const a = activeRef.current;
        if (!a || a.id == null) return;
        if (rezoomingRef.current) return;
        if (map.getZoom() < 17) {
          // User zoomed out of the scattered-courts view — exit back to all venues.
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

  // Nearby "me" marker + radius circle
  useEffect(() => {
    (async () => {
      if (!readyRef.current) return;
      const L = (await import("leaflet")).default ?? (await import("leaflet"));
      if (meRef.current) { mapRef.current.removeLayer(meRef.current); meRef.current = null; }
      if (circleRef.current) { mapRef.current.removeLayer(circleRef.current); circleRef.current = null; }
      if (nearby) {
        meRef.current = L.marker([nearby.lat, nearby.lng], {
          icon: L.divIcon({ className: "ch-marker", html: `<div class="ch-me"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
        }).addTo(mapRef.current);
        if (radiusKm && radiusKm > 0) {
          const color = radiusHasMatches ? "#12806d" : "#b8f05a";
          const group = L.layerGroup().addTo(mapRef.current);
          const base = L.circle([nearby.lat, nearby.lng], {
            radius: radiusKm * 1000,
            weight: 2,
            color,
            fillColor: color,
            fillOpacity: radiusHasMatches ? 0.08 : 0.12,
            interactive: false,
            className: "ch-radius-base",
          }).addTo(group);
          const ringClasses = ["ch-radius-ping", "ch-radius-ping ch-radius-ping-2", "ch-radius-ping ch-radius-ping-3"];
          ringClasses.forEach((cls) => {
            L.circle([nearby.lat, nearby.lng], {
              radius: radiusKm * 1000,
              weight: 2,
              color,
              fill: false,
              interactive: false,
              className: cls,
            }).addTo(group);
          });
          circleRef.current = group;
          if (activeVenueId == null) {
            mapRef.current.fitBounds(base.getBounds(), { padding: [40, 40] });
          }
        }
      }
    })();
  }, [mapReady, nearby, radiusKm, radiusHasMatches, activeVenueId]);

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

        const venueEmoji = active.mapEmoji || "🎾";
        const centerHtml = `<div class="ch-pin active"><div class="arrow"></div><div class="body"><span class="emoji">${venueEmoji}</span></div><div class="count">${active.courtCount}</div><div class="tip"></div></div>`;
        const centerIcon = divIcon(L, centerHtml);
        const centerMarker = L.marker([vLat, vLng], { icon: centerIcon }).addTo(layer);
        const dirUrl = buildDirUrl(vLat, vLng, nearby);
        centerMarker.bindPopup(
          `<div class="ch-popup-inner"><div style="font-weight:700;font-size:13px;">${active.name}</div><div style="font-size:11px;opacity:.7;">${active.address}</div><a class="ch-dir-btn" href="${dirUrl}" target="_blank" rel="noopener noreferrer">🧭 Get directions</a></div>`,
          { className: "ch-popup", closeButton: false, autoClose: false, closeOnClick: false }
        );
        centerMarker.on("mouseover", () => centerMarker.openPopup());

        const courts = active.courts;
        courts.forEach((c, i) => {
          const total = Math.max(courts.length, 1);
          const angle = (i / total) * Math.PI * 2 - Math.PI / 2;
          // CSS rotation (clockwise from up) so the arrow points from court back to venue
          const rotDeg = (Math.atan2(-Math.cos(angle), -Math.sin(angle)) * 180) / Math.PI;
          const p = courtOffset(vLat, vLng, i, total);
          const courtEmoji = c.mapEmoji || venueEmoji;
          const html = `<div class="ch-pin ch-court"><div class="point-wrap" style="transform: rotate(${rotDeg}deg)"><div class="point"></div></div><div class="body"><span class="emoji">${courtEmoji}</span></div><div class="count">${i + 1}</div></div>`;
          const m = L.marker([p.lat, p.lng], { icon: divIcon(L, html, 34, "ch-court") }).addTo(layer);
          m.bindPopup(
            `<div class="ch-popup-inner"><div style="font-weight:700;font-size:13px;">${c.name}</div><div style="font-size:11px;opacity:.7;">₱${Number(c.hourly_rate).toFixed(0)} / hour</div><div style="margin-top:6px;font-size:11px;color:hsl(var(--primary));font-weight:600;">Tap to book →</div></div>`,
            { className: "ch-popup", closeButton: false }
          );
          m.on("mouseover", () => m.openPopup());
          m.on("click", (e: any) => { e.originalEvent?.stopPropagation?.(); onOpenCourt(c.id); });
        });

        // Zoom in to venue (user-driven selection, safe to move the view)
        rezoomingRef.current = true;
        mapRef.current.flyTo([vLat, vLng], 18, { duration: 0.6 });
        setTimeout(() => { rezoomingRef.current = false; userInteractedRef.current = false; }, 700);
      } else {
        activeRef.current = null;
        // Show all venue pins
        pinned.forEach((v) => {
          const emoji = v.mapEmoji || "🎾";
          const html = `<div class="ch-pin"><div class="body"><span class="emoji">${emoji}</span></div><div class="count">${v.courtCount}</div><div class="tip"></div></div>`;
          const m = L.marker([v.latitude as number, v.longitude as number], { icon: divIcon(L, html) }).addTo(layer);
          // A range, not a "from" price: a court priced ₱20 at dawn and ₱43 in
          // the evening should say so on the pin, same as its sidebar tile.
          const rateText = v.minRate == null
            ? ""
            : v.maxRate != null && v.maxRate > v.minRate
              ? `₱${v.minRate.toFixed(0)}–${v.maxRate.toFixed(0)}/hr`
              : `₱${v.minRate.toFixed(0)}/hr`;
          const rateLine = v.minRate != null
            ? `<div class="ch-tip-rate">${rateText} · ${v.courtCount} ${v.courtCount === 1 ? "court" : "courts"}</div>`
            : `<div class="ch-tip-rate ch-tip-muted">${v.courtCount} ${v.courtCount === 1 ? "court" : "courts"}</div>`;
          const tipHtml = `<div class="ch-tip"><span class="ch-tip-name">${v.name}</span><span class="ch-tip-sep"></span><span class="ch-tip-addr">${v.address}</span><span class="ch-tip-sep"></span>${rateLine}</div>`;
          m.bindTooltip(tipHtml, {
            direction: "top",
            offset: [0, -28],
            className: "ch-tip-wrap",
            opacity: 1,
            sticky: false,
          });
          m.on("click", (e: any) => {
            e.originalEvent?.stopPropagation?.();
            userInteractedRef.current = false;
            onSelectVenue(v.id);
          });
        });

        // Only auto-fit if the user hasn't manually panned/zoomed yet.
        if (!userInteractedRef.current) {
          const bounds = L.latLngBounds(pinned.map((v) => [v.latitude as number, v.longitude as number]));
          if (nearby) bounds.extend([nearby.lat, nearby.lng]);
          rezoomingRef.current = true;
          mapRef.current.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
          setTimeout(() => { rezoomingRef.current = false; }, 300);
        }
      }
    })();
  }, [mapReady, venues, activeVenueId, onSelectVenue, onOpenCourt, nearby]);

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
      <MapPegman
        containerRef={elRef}
        onDragStateChange={(active) => {
          // Freeze the map while the pegman is being dragged, so the drag does
          // not pan the map underneath it. Pinch-zoom is only suspended for the
          // duration of the drag and restored immediately after.
          const map = mapRef.current;
          if (!map) return;
          if (active) {
            map.dragging?.disable();
            map.touchZoom?.disable();
          } else {
            map.dragging?.enable();
            map.touchZoom?.enable();
          }
        }}
        pointToLatLng={(clientX, clientY) => {
          const map = mapRef.current;
          const el = elRef.current;
          if (!map || !el) return null;
          const r = el.getBoundingClientRect();
          // Leaflet expects a point relative to the map container, not the page.
          const pt = map.containerPointToLatLng([clientX - r.left, clientY - r.top]);
          return { lat: pt.lat, lng: pt.lng };
        }}
      />
      <MapInfoButton getCenter={() => {
        const c = mapRef.current?.getCenter?.();
        return c ? { lat: c.lat, lng: c.lng } : null;
      }} />

    </>
  );
}
