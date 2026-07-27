// Pairwise "shared space" rules.
// A rule A -> B means: when court A is booked for an hour, court B is blocked
// for that same hour. Rules are directional, so a tenant can enable one side
// only, but by default both directions are enabled for every pair.

export type RuleCourt = { id: number; name: string; sport?: string | null; emoji?: string | null };

export const ruleKey = (a: number, b: number) => `${a}>${b}`;

/** Every ordered pair among the given courts, both directions enabled. */
export function allPairsEnabled(courtIds: number[]): Set<string> {
  const s = new Set<string>();
  for (const a of courtIds) for (const b of courtIds) if (a !== b) s.add(ruleKey(a, b));
  return s;
}

export function CourtBlockRulesEditor({
  courts,
  rules,
  onChange,
}: {
  courts: RuleCourt[];
  rules: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const toggle = (a: number, b: number) => {
    const next = new Set(rules);
    const k = ruleKey(a, b);
    if (next.has(k)) next.delete(k); else next.add(k);
    onChange(next);
  };

  if (courts.length < 2) {
    return (
      <div className="rounded-xl border border-dashed border-border p-3 text-xs text-muted-foreground">
        Select at least two courts above to configure which ones block each other.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
      <div className="text-xs font-semibold uppercase tracking-wider text-primary">Configured rules</div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Tap a court on the right to switch its rule on or off. <b className="text-foreground">Left → Right</b> means: when the
        left court is booked for an hour, the right court is blocked for that hour.
      </p>

      <div className="mt-3 space-y-2">
        {courts.map((src) => {
          const others = courts.filter((c) => c.id !== src.id);
          return (
            <div key={src.id} className="rounded-lg border border-border bg-background p-2.5">
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-[7.5rem] shrink-0">
                  <div className="text-sm font-semibold">
                    {src.emoji ? `${src.emoji} ` : ""}{src.name}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {src.sport ?? "—"}
                  </div>
                </div>
                <div className="text-muted-foreground">→</div>
                <div className="flex flex-1 flex-wrap gap-1.5">
                  {others.map((dst) => {
                    const on = rules.has(ruleKey(src.id, dst.id));
                    return (
                      <button
                        key={dst.id}
                        type="button"
                        onClick={() => toggle(src.id, dst.id)}
                        aria-pressed={on}
                        className={
                          "rounded-full border px-2.5 py-1 text-[11px] font-semibold transition " +
                          (on
                            ? "border-primary bg-primary/15 text-primary"
                            : "border-border text-muted-foreground hover:border-primary/50")
                        }
                      >
                        {on ? "✓ " : ""}{dst.emoji ? `${dst.emoji} ` : ""}{dst.name}
                        <span className="ml-1 font-normal opacity-70">{dst.sport ?? ""}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onChange(allPairsEnabled(courts.map((c) => c.id)))}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold hover:border-primary hover:text-primary"
        >
          Enable all (block each other)
        </button>
        <button
          type="button"
          onClick={() => onChange(new Set())}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold hover:border-destructive hover:text-destructive"
        >
          Clear all
        </button>
      </div>
    </div>
  );
}
