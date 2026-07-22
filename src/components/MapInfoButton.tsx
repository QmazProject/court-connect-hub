import { useState } from "react";
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

type Props = {
  /** Returns current map center for tagging reports (optional). */
  getCenter?: () => { lat: number; lng: number } | null;
  /** Positioning classes relative to the map container. */
  className?: string;
  /** Which side of the button the popover aligns to. */
  align?: "left" | "right";
};

/**
 * Floating "i" info button used on every map. Replaces Leaflet's built-in
 * attribution overlay with a compact menu:
 *   • Report a problem with map
 *   • Map data legal notices
 *   • OpenStreetMap
 */
export function MapInfoButton({ getCenter, className, align = "right" }: Props) {
  const [showAttrib, setShowAttrib] = useState(false);
  const [showLegal, setShowLegal] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportCategory, setReportCategory] = useState<string | null>(null);
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
    const center = getCenter?.() ?? null;
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

  return (
    <>
      <div className={`absolute z-[500] ${className ?? "bottom-3 right-3"}`}>
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
            <div className={`absolute bottom-10 z-[700] w-64 overflow-hidden rounded-xl border border-border bg-background shadow-xl ${align === "left" ? "left-0" : "right-0"}`}>
              <button
                type="button"
                onClick={() => { setShowAttrib(false); setReportOpen(true); }}
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
              <div className={`pointer-events-none absolute -bottom-1.5 h-3 w-3 rotate-45 border-b border-r border-border bg-background ${align === "left" ? "left-3" : "right-3"}`} />
            </div>
          </>
        )}
      </div>

      {reportOpen && (
        <div
          className="absolute inset-0 z-[1000] flex items-end justify-center bg-black/50 p-3 sm:items-center"
          onClick={closeReport}
        >
          <div
            className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-xl border border-border bg-background p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold">
                {reportSent ? "Report sent" : reportCategory ? "Describe the issue" : "Report a problem with map"}
              </h3>
              <button
                type="button"
                onClick={closeReport}
                className="rounded-md px-2 py-1 text-sm hover:bg-secondary"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {reportSent ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Thanks — your report has been sent. We'll review it shortly.
                </p>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={closeReport}
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : !reportCategory ? (
              <div className="space-y-1">
                <p className="mb-2 text-sm text-muted-foreground">What's wrong with the map?</p>
                {REPORT_CATEGORIES.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    onClick={() => setReportCategory(c.label)}
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm hover:bg-secondary"
                  >
                    <span aria-hidden className="text-base">{c.icon}</span>
                    <span>{c.label}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-md border border-border bg-secondary/50 px-3 py-2 text-sm">
                  <span className="text-muted-foreground">Category: </span>
                  <span className="font-medium">{reportCategory}</span>
                </div>
                <label className="block text-sm font-medium">Describe the issue</label>
                <textarea
                  value={reportDesc}
                  onChange={(e) => setReportDesc(e.target.value.slice(0, 2000))}
                  rows={5}
                  maxLength={2000}
                  placeholder="Tell us what's incorrect or misleading on the map…"
                  className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{reportDesc.length}/2000</span>
                </div>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => { setReportCategory(null); setReportDesc(""); }}
                    disabled={reportSubmitting}
                    className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50"
                  >
                    ← Back
                  </button>
                  <button
                    type="button"
                    onClick={submitReport}
                    disabled={reportSubmitting || !reportDesc.trim()}
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {reportSubmitting ? "Sending…" : "Send"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

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
            </div>
          </div>
        </div>
      )}
    </>
  );
}
