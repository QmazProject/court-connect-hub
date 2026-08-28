/**
 * Venue filter as a searchable combobox rather than a `<select>`.
 *
 * A native select is fine for three venues and unusable for thirty: the only way to
 * reach the last one is to scroll a list that has no search. This keeps the same
 * value contract (`number | "all"`) so it drops straight into the existing filters,
 * and only shows the search box once there are enough venues for it to earn its
 * space — a two-venue tenant should not have to type.
 */

import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, MapPin, Search } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type VenueOption = { id: number; name: string; address?: string | null };

/** Below this, scrolling is faster than typing. */
const SEARCH_THRESHOLD = 6;

export function VenuePicker({
  venues,
  value,
  onChange,
  size = "sm",
  allLabel = "All venues",
  allowAll = true,
  className,
}: {
  venues: VenueOption[];
  value: number | "all";
  onChange: (v: number | "all") => void;
  size?: "sm" | "xs";
  allLabel?: string;
  /** Some pickers configure one venue at a time and have no "all" case. */
  allowAll?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = value === "all" ? null : venues.find((v) => v.id === value);
  const showSearch = venues.length >= SEARCH_THRESHOLD;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return venues;
    return venues.filter(
      (v) => v.name.toLowerCase().includes(q) || (v.address ?? "").toLowerCase().includes(q),
    );
  }, [venues, query]);

  const choose = (v: number | "all") => {
    onChange(v);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "inline-flex items-center justify-between gap-2 rounded-lg border border-border bg-background transition hover:border-primary/60",
            size === "xs" ? "px-2 py-1 text-xs" : "px-3 py-2 text-sm",
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <MapPin
              className={cn(
                "shrink-0 text-muted-foreground",
                size === "xs" ? "h-3 w-3" : "h-3.5 w-3.5",
              )}
            />
            <span className="truncate">{selected ? selected.name : allLabel}</span>
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="z-[1300] w-[min(20rem,calc(100vw-2rem))] p-0">
        {showSearch && (
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${venues.length} venues…`}
              className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        )}

        <div className="nice-scroll max-h-64 overflow-y-auto p-1">
          {allowAll && (
            <Option label={allLabel} active={value === "all"} onSelect={() => choose("all")} />
          )}
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              No venue matches “{query.trim()}”.
            </p>
          ) : (
            filtered.map((v) => (
              <Option
                key={v.id}
                label={v.name}
                sublabel={v.address ?? undefined}
                active={value === v.id}
                onSelect={() => choose(v.id)}
              />
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Option({
  label,
  sublabel,
  active,
  onSelect,
}: {
  label: string;
  sublabel?: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-secondary",
        active && "bg-secondary",
      )}
    >
      <Check
        className={cn("h-3.5 w-3.5 shrink-0", active ? "opacity-100 text-primary" : "opacity-0")}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {sublabel && (
          <span className="block truncate text-[11px] text-muted-foreground">{sublabel}</span>
        )}
      </span>
    </button>
  );
}
