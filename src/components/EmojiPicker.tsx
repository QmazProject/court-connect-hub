import { useState } from "react";

const PRESETS = [
  "🎾", "🥎", "🏓", "🏸", "🏀", "🏐", "⚽", "🏈",
  "🏑", "🏒", "🥅", "⛳", "🎱", "🏊", "🥊", "🤸",
  "🏟️", "📍", "⭐", "🔥", "💪", "🏆",
];

type Props = {
  label?: string;
  value: string | null | undefined;
  fallback?: string;
  onChange: (v: string | null) => void;
  hint?: string;
};

// Grab the first visible emoji-ish grapheme from a string (handles ZWJ + skin tones)
function firstEmoji(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return "";
  try {
    // @ts-ignore
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    // @ts-ignore
    const it = seg.segment(trimmed)[Symbol.iterator]();
    const first = it.next();
    return first.done ? trimmed.slice(0, 2) : (first.value.segment as string);
  } catch {
    return Array.from(trimmed)[0] ?? "";
  }
}

export function EmojiPicker({ label = "Map emoji", value, fallback = "🎾", onChange, hint }: Props) {
  const [custom, setCustom] = useState("");
  const current = value || fallback;

  return (
    <div className="w-full">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-[11px] font-medium text-muted-foreground hover:text-primary"
          >
            Reset to default
          </button>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <div
          aria-label="Current emoji preview"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full border-2 border-primary bg-primary/10 text-2xl"
        >
          {current}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => onChange(e)}
              className={
                "grid h-8 w-8 place-items-center rounded-md border text-lg transition " +
                (value === e
                  ? "border-primary bg-primary/10"
                  : "border-border bg-background hover:border-primary")
              }
            >
              {e}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="text"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Or paste any emoji…"
          maxLength={8}
          className="w-32 rounded-md border border-input bg-background px-2 py-1 text-sm"
        />
        <button
          type="button"
          onClick={() => {
            const pick = firstEmoji(custom);
            if (pick) { onChange(pick); setCustom(""); }
          }}
          className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:border-primary hover:text-primary"
        >
          Use
        </button>
        {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      </div>
    </div>
  );
}
