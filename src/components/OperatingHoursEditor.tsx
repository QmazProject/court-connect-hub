import {
  HOUR_DAY_KEYS, HOUR_DAY_LABELS, ALL_DAY, CLOSED,
  parseWindow, makeWindow, describeWindow, isClosed, isOvernight, fmtHour,
  type DayKey, type HoursMap,
} from "@/lib/operating-hours";

const HOUR_OPTIONS = Array.from({ length: 25 }, (_, h) => h);

function HourSelect({ value, onChange, allowMidnightEnd }: { value: number; onChange: (v: number) => void; allowMidnightEnd?: boolean }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="rounded-lg border border-input bg-background px-2 py-1.5 text-xs"
    >
      {HOUR_OPTIONS.filter((h) => (allowMidnightEnd ? true : h < 24)).map((h) => (
        <option key={h} value={h}>{h === 24 ? "12:00 AM (midnight)" : fmtHour(h)}</option>
      ))}
    </select>
  );
}

function DayRow({ day, value, onChange }: { day: DayKey; value: string; onChange: (v: string) => void }) {
  const closed = isClosed(value);
  const w = parseWindow(value) ?? [8, 17];
  const open24 = !closed && w[0] === 0 && w[1] === 24;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border py-2 last:border-b-0">
      <span className="w-20 shrink-0 text-xs font-semibold">{HOUR_DAY_LABELS[day]}</span>

      <select
        value={closed ? "closed" : open24 ? "24h" : "custom"}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "closed") onChange(CLOSED);
          else if (v === "24h") onChange(ALL_DAY);
          else onChange(makeWindow(8, 17));
        }}
        className="rounded-lg border border-input bg-background px-2 py-1.5 text-xs"
      >
        <option value="24h">Open 24 hours</option>
        <option value="custom">Set hours</option>
        <option value="closed">Closed</option>
      </select>

      {!closed && !open24 && (
        <>
          <HourSelect value={w[0]} onChange={(v) => onChange(makeWindow(v, w[1]))} />
          <span className="text-xs text-muted-foreground">to</span>
          <HourSelect value={w[1]} onChange={(v) => onChange(makeWindow(w[0], v))} allowMidnightEnd />
          {isOvernight(value) && (
            <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              Overnight → next day
            </span>
          )}
        </>
      )}

      {(closed || open24) && (
        <span className="text-[11px] text-muted-foreground">{describeWindow(value)}</span>
      )}
    </div>
  );
}

export function OperatingHoursEditor({
  hours,
  onChange,
  title = "Operating hours",
  hint,
}: {
  hours: HoursMap;
  onChange: (h: HoursMap) => void;
  title?: string;
  hint?: string;
}) {
  const set = (day: DayKey, v: string) => onChange({ ...hours, [day]: v });
  const applyToAll = () => {
    const mon = hours.mon ?? ALL_DAY;
    onChange(Object.fromEntries(HOUR_DAY_KEYS.map((d) => [d, mon])) as HoursMap);
  };

  const order: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-primary">{title}</div>
          {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onChange(Object.fromEntries(HOUR_DAY_KEYS.map((d) => [d, ALL_DAY])) as HoursMap)}
            className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[11px] font-semibold hover:border-primary hover:text-primary"
          >
            Open 24/7
          </button>
          <button
            type="button"
            onClick={applyToAll}
            className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[11px] font-semibold hover:border-primary hover:text-primary"
          >
            Copy Monday to all days
          </button>
        </div>
      </div>

      <div className="mt-2">
        {order.map((d) => (
          <DayRow key={d} day={d} value={hours[d] ?? ALL_DAY} onChange={(v) => set(d, v)} />
        ))}
      </div>
    </div>
  );
}

export function CourtHoursEditor({
  inherit,
  onInheritChange,
  hours,
  onHoursChange,
  venueHours,
}: {
  inherit: boolean;
  onInheritChange: (v: boolean) => void;
  hours: HoursMap;
  onHoursChange: (h: HoursMap) => void;
  venueHours: HoursMap;
}) {
  const order: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  return (
    <div className="mt-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <label className="flex items-start gap-2 text-xs font-medium">
        <input type="checkbox" className="mt-0.5" checked={inherit} onChange={(e) => onInheritChange(e.target.checked)} />
        <span>
          Follow the venue&apos;s operating hours
          <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
            Recommended. Change the venue hours once and every court that follows them updates automatically.
          </span>
        </span>
      </label>

      {inherit ? (
        <div className="mt-2 grid gap-1 rounded-lg border border-border bg-background p-2.5 sm:grid-cols-2">
          {order.map((d) => (
            <div key={d} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="font-medium text-muted-foreground">{HOUR_DAY_LABELS[d].slice(0, 3)}</span>
              <span className="font-semibold">{describeWindow(venueHours[d])}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-2">
          <OperatingHoursEditor
            hours={hours}
            onChange={onHoursChange}
            title="Court-specific hours"
            hint="This court ignores the venue schedule and uses the hours below."
          />
        </div>
      )}
    </div>
  );
}
