import { useEffect, useRef, useState } from "react";

type Props = {
  /** Converts a viewport point to map coordinates; null while the map boots. */
  pointToLatLng: (clientX: number, clientY: number) => { lat: number; lng: number } | null;
  /** The map container, used to bound the drop area and read its position. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Lets the map freeze its own pan/zoom handlers while a drag is in flight. */
  onDragStateChange?: (dragging: boolean) => void;
  className?: string;
};

/** Movement below this is a click, not a drag. */
const DRAG_THRESHOLD_PX = 10;

/**
 * Street View "pegman": drag the figure onto the map to open Google Street View
 * at that spot.
 *
 * Google is only ever opened in a new tab through its documented URL scheme
 * (`map_action=pano`), so this needs no Maps API key, no billing account, and
 * embeds nothing — the same approach as the Directions links elsewhere in the
 * app. Coverage is whatever Google has: dense along Philippine highways and
 * cities, sparse on small barangay roads, and Google shows its own "no imagery
 * here" screen when a spot has none.
 *
 * The drop is deliberately NOT gated on whether imagery exists. Checking that
 * needs Google's Street View Metadata API (an API key, though the calls are
 * free); the keyless alternative — treating "near an OSM road" as a proxy via
 * Overpass — measured ~15s per viewport query and would still be wrong, since
 * a mapped road does not imply Google drove it. So the copy sets expectations
 * instead, and Google shows its own message when a spot has no panorama.
 */
export function MapPegman({ pointToLatLng, containerRef, onDragStateChange, className }: Props) {
  const [dragging, setDragging] = useState(false);
  const [ghost, setGhost] = useState<{
    x: number;
    y: number;
    overMap: boolean;
    touch: boolean;
  } | null>(null);
  const [hint, setHint] = useState(false);

  /**
   * Drag state is held in a ref, not just React state, and the listeners below
   * are always mounted. Gating on state instead would drop the very first drag:
   * the pointer events can all arrive before React commits `dragging = true`,
   * leaving the handlers looking at a stale `false`.
   */
  const draggingRef = useRef(false);
  /** Where the drag began, to tell a real drag from a stray click. */
  const startRef = useRef<{ x: number; y: number } | null>(null);
  // Keep the latest props reachable from listeners registered once on mount.
  const depsRef = useRef({ pointToLatLng, containerRef, onDragStateChange });
  depsRef.current = { pointToLatLng, containerRef, onDragStateChange };
  /** Pointer type of the active drag; touch needs the ghost offset off-finger. */
  const touchRef = useRef(false);

  /**
   * True when the map is the thing actually visible at this point. A plain
   * rectangle test is not enough: on phones the venue sheet overlays the lower
   * part of the map, and dropping onto the sheet must not count as dropping on
   * the map. Hit-testing the topmost element handles any overlay. The drag
   * ghost is `pointer-events-none`, so it never shadows the result.
   */
  const isOverMap = (x: number, y: number) => {
    const el = depsRef.current.containerRef.current;
    if (!el) return false;
    const top = document.elementFromPoint(x, y);
    return !!top && el.contains(top);
  };

  const endDrag = () => {
    if (draggingRef.current) depsRef.current.onDragStateChange?.(false);
    draggingRef.current = false;
    setDragging(false);
    setGhost(null);
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      e.preventDefault();
      setGhost({
        x: e.clientX,
        y: e.clientY,
        overMap: isOverMap(e.clientX, e.clientY),
        touch: touchRef.current,
      });
    };

    const up = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const start = startRef.current;
      endDrag();
      // A click without movement would otherwise open Street View at the
      // pegman's own resting spot, which is meaningless.
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD_PX) return;
      if (!isOverMap(e.clientX, e.clientY)) return;
      const at = depsRef.current.pointToLatLng(e.clientX, e.clientY);
      if (!at) return;
      // Documented Google Maps URL scheme — opens the Street View panorama
      // nearest the dropped point. No API key required.
      const url =
        "https://www.google.com/maps/@?api=1&map_action=pano" +
        `&viewpoint=${at.lat.toFixed(6)},${at.lng.toFixed(6)}`;
      window.open(url, "_blank", "noopener,noreferrer");
    };

    const cancel = (e: KeyboardEvent) => {
      if (e.key === "Escape") endDrag();
    };

    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("keydown", cancel);
    };
  }, []);

  return (
    <>
      <div
        // The hint below is positioned absolutely on purpose: in normal flow it
        // grew this bottom-anchored box and shoved the button up out from under
        // the cursor hovering it, so the drag never started.
        //
        // Placement differs by breakpoint: on phones the venue sheet covers the
        // bottom 42–70vh of the map, so a bottom-anchored pegman would sit
        // behind it. Sit below the top-right status badge there instead, and
        // only drop to the bottom corner (above the map info button) on md+.
        className={"absolute z-500 " + (className ?? "right-3 top-16 md:bottom-24 md:top-auto")}
      >
        <button
          type="button"
          aria-label="Drag onto a street to open Street View"
          title="Drag onto a road to see it at street level. Google has no imagery for every spot — roads and towns are covered best."
          onPointerDown={(e) => {
            e.preventDefault();
            draggingRef.current = true; // synchronous: listeners see it immediately
            startRef.current = { x: e.clientX, y: e.clientY };
            touchRef.current = e.pointerType !== "mouse";
            onDragStateChange?.(true);
            setHint(false);
            setDragging(true);
            setGhost({
              x: e.clientX,
              y: e.clientY,
              overMap: isOverMap(e.clientX, e.clientY),
              touch: touchRef.current,
            });
          }}
          onMouseEnter={() => setHint(true)}
          onMouseLeave={() => setHint(false)}
          className={
            // `after:-inset-2` grows only the hit area (44px visible -> ~60px
            // touchable) without enlarging the icon. `touch-none` stops the
            // browser scrolling/panning the page from a press on the pegman.
            "relative flex h-11 w-11 touch-none select-none items-center justify-center rounded-full border-2 border-[#0f4a40] bg-white text-2xl shadow-lg ring-1 ring-[#b8f05a]/50 transition after:absolute after:-inset-2 after:content-[''] hover:scale-110 active:scale-95 dark:bg-neutral-900 " +
            (dragging ? "cursor-grabbing opacity-40" : "cursor-grab")
          }
        >
          <span aria-hidden>🧍</span>
        </button>
        {hint && !dragging && (
          <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-[#09231f] px-2 py-1 text-[10px] font-semibold text-[#b8f05a] shadow-lg">
            Drop me on a street
          </span>
        )}
      </div>

      {/* Cursor-following ghost while dragging */}
      {ghost && (
        <div
          className={
            "pointer-events-none fixed z-1200 -translate-x-1/2 " +
            // A fingertip covers roughly 40-50px; lift the ghost clear of it.
            (ghost.touch ? "-translate-y-[150%]" : "-translate-y-1/2")
          }
          style={{ left: ghost.x, top: ghost.y }}
        >
          <div
            className={
              "flex h-12 w-12 items-center justify-center rounded-full text-3xl shadow-xl transition-colors " +
              (ghost.overMap ? "bg-[#b8f05a] ring-4 ring-[#b8f05a]/40" : "bg-white/80 grayscale")
            }
          >
            <span aria-hidden>🧍</span>
          </div>
          {ghost.overMap && (
            <div className="mt-1 whitespace-nowrap rounded-md bg-[#09231f] px-2 py-1 text-center text-[10px] font-bold text-[#b8f05a] shadow-lg">
              Drop for Street View
              <span className="block text-[9px] font-medium text-white/60">
                works best on roads
              </span>
            </div>
          )}
        </div>
      )}
    </>
  );
}
