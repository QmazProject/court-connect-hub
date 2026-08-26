/**
 * The master search field that sits beside the notification bell.
 *
 * One box, two roles: it renders whatever `entries` it is handed and knows nothing
 * about what a venue or a booking is — see `@/lib/master-search` for the ranking and
 * the per-role registries for what goes in. The query is owned by the shell rather
 * than by this component because the role registries need it too: the static half of
 * the list is matched locally on every keystroke, while the half that comes from
 * Supabase is fetched from the same (debounced) string.
 *
 * Built on the existing cmdk wrapper in `@/components/ui/command`, so arrow keys,
 * Enter and the roving selection are the ones the rest of the app already uses. The
 * only thing overridden is the chrome: cmdk's input ships as a dialog header with a
 * bottom border, and here it has to read as an ordinary field in a toolbar.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, CornerDownLeft, Loader2 } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandInput,
  CommandList,
} from "@/components/ui/command";
import { groupEntries, rankEntries, type SearchEntry } from "@/lib/master-search";

const RECENTS_LIMIT = 4;

function readRecents(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeRecents(key: string, ids: string[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(ids.slice(0, RECENTS_LIMIT)));
  } catch {
    /* Private mode, or storage full. Recents are a convenience; losing them is fine. */
  }
}

export function MasterSearch({
  value,
  onValueChange,
  entries,
  loading = false,
  placeholder = "Search…",
  /** Namespaces the recents so a shared browser does not show a tenant their
   *  player history, and vice versa. */
  storageKey,
  /** Mobile top bars have no room for a field — collapse to an icon that opens the
   *  same panel. */
  compact = false,
  /** "dark" is for the Explore toolbar, which is a deep green panel where the default
   *  light chrome would disappear. Only the field and the icon button change; the
   *  dropdown stays on `bg-popover` so it reads the same wherever it is opened. */
  tone = "light",
  className = "",
}: {
  value: string;
  onValueChange: (v: string) => void;
  entries: SearchEntry[];
  loading?: boolean;
  placeholder?: string;
  storageKey: string;
  compact?: boolean;
  tone?: "light" | "dark";
  className?: string;
}) {
  const dark = tone === "dark";
  const [open, setOpen] = useState(false);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /* After mount, not during render: the server has no localStorage, and seeding
     state from it directly would make the first client render disagree with the
     HTML that was sent. */
  useEffect(() => setRecentIds(readRecents(storageKey)), [storageKey]);

  const results = useMemo(() => rankEntries(value, entries), [value, entries]);

  /* With nothing typed the panel is a launcher rather than a result list: what you
     used last, then the highest-priority destinations of this role. */
  const recentEntries = useMemo(() => {
    if (value.trim()) return [];
    const byId = new Map(entries.map((e) => [e.id, e]));
    return recentIds.map((id) => byId.get(id)).filter((e): e is SearchEntry => !!e);
  }, [recentIds, entries, value]);

  const groups = useMemo(() => {
    const recentSet = new Set(recentEntries.map((e) => e.id));
    const rest = results.filter((e) => !recentSet.has(e.id));
    return [
      ...(recentEntries.length ? [{ group: "Recent", items: recentEntries }] : []),
      ...groupEntries(rest),
    ];
  }, [recentEntries, results]);

  const close = useCallback(() => {
    setOpen(false);
    onValueChange("");
  }, [onValueChange]);

  const choose = useCallback(
    (entry: SearchEntry) => {
      setRecentIds((prev) => {
        const next = [entry.id, ...prev.filter((id) => id !== entry.id)].slice(0, RECENTS_LIMIT);
        writeRecents(storageKey, next);
        return next;
      });
      close();
      inputRef.current?.blur();
      entry.run();
    },
    [close, storageKey],
  );

  /* ⌘K / Ctrl-K. Both top bars mount an instance and only one of them is ever on
     screen, so the hidden one has to decline the shortcut — `offsetParent` is null
     for anything inside a `display: none` container, which is exactly how the
     responsive bars are hidden. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      e.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [open, close]);

  /* Two shapes, one input. On a wide bar the field is the trigger; on a phone the bar
     has room for an icon only, so the same field moves to the top of the panel the
     icon opens. */
  const showPanel = open || (!compact && value.trim().length > 0);

  useEffect(() => {
    if (open && compact) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, compact]);

  /* The hint lives inside the field, on the same line as the sample text, rather than
     as a badge pinned to the far end: a native placeholder cannot be styled a piece at
     a time, so the real placeholder is suppressed and this row is drawn underneath the
     (transparent) input. It is `pointer-events-none`, so a click still lands on the
     input beneath it, and it disappears the moment anything is typed. */
  const sampleText = (
    <span
      aria-hidden
      /* `inset-0`, not `inset-y-0 left-0`: with only `left` set, an absolutely
         positioned box is shrink-to-fit, and the `nowrap` this row needs makes its
         minimum content width the full unwrapped string — so it sized straight past
         the pill and printed the ⌘K chip outside the field. Pinning both edges makes
         the width the container's, and `overflow-hidden` keeps the chip in. */
      className={
        "pointer-events-none absolute inset-0 flex items-center gap-2 overflow-hidden text-sm " +
        (dark ? "text-white/55" : "text-muted-foreground")
      }
    >
      {/* The text yields first — `min-w-0` is what lets it ellipsize instead of
          pushing the chip out — and the chip keeps its natural size right beside it. */}
      <span className="min-w-0 truncate">{placeholder}</span>
      <kbd
        className={
          "hidden shrink-0 rounded-[5px] border px-1.5 py-px font-sans text-[10px] font-semibold leading-relaxed tracking-wide sm:inline-block " +
          (dark
            ? "border-white/25 bg-white/10 text-white/70"
            : "border-border bg-muted text-muted-foreground")
        }
      >
        ⌘K
      </kbd>
    </span>
  );

  const field = (inPanel: boolean) => (
    <div
      className={
        "flex items-center gap-2 transition-colors " +
        (inPanel
          ? "border-b border-border px-3 focus-within:border-primary"
          : "h-9 rounded-full border px-3 " +
            (dark
              ? "w-64 border-white/20 bg-white/10 backdrop-blur-sm focus-within:border-[#b8f05a] focus-within:bg-white/15 lg:w-80"
              : "w-64 border-border bg-background focus-within:border-primary lg:w-80"))
      }
    >
      <Search
        className={
          "h-4 w-4 shrink-0 " + (dark && !inPanel ? "text-[#b8f05a]" : "text-muted-foreground")
        }
      />
      {/* `relative` so the sample row can sit over the input's own box rather than the
          whole field — otherwise it would start at the magnifier. */}
      <span className="relative flex min-w-0 flex-1 items-center">
        {!value && !inPanel && sampleText}
        <CommandInput
          ref={inputRef}
          value={value}
          onValueChange={(v) => {
            onValueChange(v);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={inPanel ? placeholder : ""}
          className={
            "h-9 border-0 bg-transparent px-0 text-sm " +
            (dark && !inPanel ? "text-white placeholder:text-white/55" : "")
          }
        />
      </span>
      {loading && (
        <Loader2
          className={
            "h-3.5 w-3.5 shrink-0 animate-spin " +
            (dark && !inPanel ? "text-white/70" : "text-muted-foreground")
          }
        />
      )}
    </div>
  );

  return (
    <div ref={rootRef} className={"relative " + className}>
      <Command
        shouldFilter={false}
        /* cmdk's own Escape handling only clears the selection, and the event never
           reaches the window while the input has focus — closing happens here. cmdk
           calls this before its own handler, so arrow keys and Enter still work. */
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
            inputRef.current?.blur();
          }
        }}
        /* The shared cmdk input ships as a dialog header — a bottom border, its own
           padding and its own magnifier. Here it has to read as a plain field in a
           toolbar, and the magnifier is drawn above so it can be tinted with the rest
           of the row. */
        className="overflow-visible bg-transparent [&_[cmdk-input-wrapper]>svg]:hidden [&_[cmdk-input-wrapper]]:min-w-0 [&_[cmdk-input-wrapper]]:flex-1 [&_[cmdk-input-wrapper]]:border-b-0 [&_[cmdk-input-wrapper]]:px-0"
      >
        {compact ? (
          <button
            type="button"
            aria-label="Search"
            aria-expanded={open}
            onClick={() => (open ? close() : setOpen(true))}
            className={
              "rounded-md border p-2 transition-colors " +
              (open
                ? dark
                  ? "border-[#b8f05a] bg-[#b8f05a]/15 text-[#b8f05a]"
                  : "border-primary bg-primary/10 text-primary"
                : dark
                  ? "border-white/20 bg-white/10 text-white hover:bg-white/20"
                  : "border-border text-foreground hover:bg-secondary")
            }
          >
            <Search className="h-4 w-4" />
          </button>
        ) : (
          field(false)
        )}

        {showPanel && (
          <div className="absolute right-0 top-[calc(100%+0.5rem)] z-[1300] w-[min(26rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
            {compact && field(true)}
            <CommandList className="nice-scroll max-h-[60vh]">
              <CommandEmpty>
                <span className="text-xs text-muted-foreground">
                  {loading ? "Searching…" : `Nothing matches “${value.trim()}”.`}
                </span>
              </CommandEmpty>
              {groups.map(({ group, items }) => (
                <CommandGroup key={group} heading={group}>
                  {items.map((entry) => {
                    const Icon = entry.icon;
                    return (
                      <CommandItem
                        key={entry.id}
                        value={entry.id}
                        onSelect={() => choose(entry)}
                        className="group cursor-pointer gap-2.5 px-2 py-2"
                      >
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground">
                          {Icon ? (
                            <Icon className="h-3.5 w-3.5" />
                          ) : (
                            <Search className="h-3.5 w-3.5" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{entry.label}</span>
                          {entry.hint && (
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {entry.hint}
                            </span>
                          )}
                        </span>
                        <CornerDownLeft className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-data-[selected=true]:opacity-60" />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
              {loading && (
                <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                  Still looking for matching records…
                </p>
              )}
            </CommandList>
          </div>
        )}
      </Command>
    </div>
  );
}
