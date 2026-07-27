import { useMemo } from "react";
import {
  DAY_KEYS, DAY_LABELS, WEEKDAYS, WEEKENDS,
  rateBands, defaultRuleTemplate, newRule, fmtHour12, peso,
  type DayKey, type RateRule,
} from "@/lib/court-pricing";

const sameSet = (a: DayKey[], b: DayKey[]) => a.length === b.length && b.every((d) => a.includes(d));

function DayPreset({ rule, onChange }: { rule: RateRule; onChange: (days: DayKey[]) => void }) {
  const preset = sameSet(rule.days, WEEKDAYS) ? "weekdays" : sameSet(rule.days, WEEKENDS) ? "weekends" : "custom";
  return (
    <div>
      <select
        value={preset}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "weekdays") onChange([...WEEKDAYS]);
          else if (v === "weekends") onChange([...WEEKENDS]);
        }}
        className="w-full rounded-lg border border-input bg-background px-2 py-1.5 text-xs"
      >
        <option value="weekdays">Weekdays (Mon–Fri)</option>
        <option value="weekends">Weekends (Sat–Sun)</option>
        <option value="custom">Custom days</option>
      </select>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {DAY_KEYS.map((d) => {
          const on = rule.days.includes(d);
          return (
            <button
              key={d}
              type="button"
              onClick={() => onChange(on ? rule.days.filter((x) => x !== d) : [...rule.days, d])}
              className={
                "rounded-full border px-2 py-0.5 text-[10px] font-semibold transition " +
                (on ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground hover:border-primary/50")
              }
            >
              {DAY_LABELS[d]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function HourSelect({ value, onChange, max = 24 }: { value: number; onChange: (v: number) => void; max?: number }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full rounded-lg border border-input bg-background px-2 py-1.5 text-xs"
    >
      {Array.from({ length: max + 1 }, (_, h) => h).map((h) => (
        <option key={h} value={h}>{h === 24 ? "12:00 AM (next day)" : fmtHour12(h)}</option>
      ))}
    </select>
  );
}

function PreviewStrip({ baseRate, rules, day, title }: { baseRate: number; rules: RateRule[]; day: DayKey; title: string }) {
  const bands = useMemo(() => rateBands(baseRate, rules, day), [baseRate, rules, day]);
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {bands.map((b) => (
          <span
            key={`${b.start}-${b.end}`}
            className={
              "rounded-md border px-2 py-0.5 text-[10px] font-medium " +
              (b.rate === Number(baseRate) ? "border-border bg-muted text-muted-foreground" : "border-primary/40 bg-primary/10 text-foreground")
            }
          >
            {fmtHour12(b.start)}–{fmtHour12(b.end % 24)} · <b>{peso(b.rate)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

export function RateRulesEditor({
  baseRate,
  rules,
  onChange,
}: {
  baseRate: number;
  rules: RateRule[];
  onChange: (rules: RateRule[]) => void;
}) {
  const enabled = rules.length > 0;
  const update = (id: string, patch: Partial<RateRule>) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const invalid = rules.filter((r) => r.days.length === 0 || r.start_hour >= r.end_hour || !(r.rate > 0));

  return (
    <div className="mt-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-primary">Time-based pricing</div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Charge different rates for morning, afternoon and evening, and for weekends. Any hour without a rule uses the hourly rate above.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs font-medium">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onChange(e.target.checked ? defaultRuleTemplate(baseRate) : [])}
          />
          Use time-based pricing
        </label>
      </div>

      {enabled && (
        <>
          <div className="mt-3 space-y-2">
            {rules.map((r) => (
              <div key={r.id} className="rounded-lg border border-border bg-background p-2.5">
                <div className="grid gap-2 sm:grid-cols-[1.4fr_1fr_1fr_0.9fr_auto] sm:items-start">
                  <div>
                    <input
                      value={r.label ?? ""}
                      onChange={(e) => update(r.id, { label: e.target.value })}
                      placeholder="Label (e.g. Weekday evening)"
                      className="w-full rounded-lg border border-input bg-background px-2 py-1.5 text-xs"
                    />
                    <div className="mt-1.5"><DayPreset rule={r} onChange={(days) => update(r.id, { days })} /></div>
                  </div>
                  <label className="block">
                    <span className="text-[10px] font-medium text-muted-foreground">From</span>
                    <HourSelect value={r.start_hour} onChange={(v) => update(r.id, { start_hour: v })} max={23} />
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-medium text-muted-foreground">Until</span>
                    <HourSelect value={r.end_hour} onChange={(v) => update(r.id, { end_hour: v })} />
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-medium text-muted-foreground">Rate / hr (₱)</span>
                    <input
                      type="number"
                      min={1}
                      value={r.rate}
                      onChange={(e) => update(r.id, { rate: Number(e.target.value) })}
                      className="w-full rounded-lg border border-input bg-background px-2 py-1.5 text-xs"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => onChange(rules.filter((x) => x.id !== r.id))}
                    className="self-end rounded-lg border border-border px-2 py-1.5 text-xs text-muted-foreground hover:border-destructive hover:text-destructive"
                    aria-label="Remove rule"
                  >
                    Remove
                  </button>
                </div>
                {(r.days.length === 0 || r.start_hour >= r.end_hour || !(r.rate > 0)) && (
                  <p className="mt-1.5 text-[11px] text-destructive">
                    Pick at least one day, an end time after the start time, and a rate above ₱0.
                  </p>
                )}
              </div>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onChange([...rules, newRule(baseRate)])}
              className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold hover:border-primary hover:text-primary"
            >
              + Add rule
            </button>
            <button
              type="button"
              onClick={() => onChange(defaultRuleTemplate(baseRate))}
              className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold hover:border-primary hover:text-primary"
            >
              Quick setup (AM / PM / evening)
            </button>
          </div>

          <div className="mt-3 space-y-2 rounded-lg border border-border bg-background p-2.5">
            <div className="text-[11px] font-semibold">Player-facing preview</div>
            <PreviewStrip baseRate={baseRate} rules={rules} day="wed" title="Typical weekday" />
            <PreviewStrip baseRate={baseRate} rules={rules} day="sat" title="Typical weekend" />
            <p className="text-[10px] text-muted-foreground">
              If two rules overlap, the one lower in the list wins. Grey bands use your default hourly rate.
            </p>
          </div>

          {invalid.length > 0 && (
            <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-200">
              ⚠ {invalid.length} rule{invalid.length > 1 ? "s are" : " is"} incomplete and will be ignored when saving.
            </p>
          )}
        </>
      )}
    </div>
  );
}
