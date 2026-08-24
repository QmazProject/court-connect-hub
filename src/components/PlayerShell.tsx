import type React from "react";
import { Link } from "@tanstack/react-router";
import { BookOpen, CalendarDays, LogOut, MapPin, Menu, X } from "lucide-react";
import { NotificationBell } from "@/components/NotificationBell";

/* Lifted out of routes/_authenticated/dashboard.tsx, which is ~6,300 lines and pulls in the
   PayMongo and refund server functions. The landing page needs only this shell to wrap the
   explore view for signed-in players, and importing it from the dashboard dragged that whole
   module into the landing route's SSR graph — a cold render had to transform ten thousand
   lines before it could answer, which on /mnt/c meant the page appeared to hang. */

const chLogo = { url: "/CHicon.png" };

export type PlayerSectionKey = "explore" | "bookings" | "calendar";

/** No Home entry on purpose. Once a player is signed in their start page is
 *  Explore; the landing page belongs to signed-out visitors, and `LandingPage`
 *  bounces a signed-in player back to /explore. Signing out is the way back. */
export const PLAYER_NAV = [
  { key: "explore", label: "Explore", icon: MapPin, to: "/explore", search: {} },
  { key: "bookings", label: "My Bookings", icon: BookOpen, to: "/dashboard", search: {} },
  /* Same route as My Bookings, switched by search param — see the note on the dashboard's
     validateSearch for why this is not its own route. */
  {
    key: "calendar",
    label: "Calendar",
    icon: CalendarDays,
    to: "/dashboard",
    search: { view: "calendar" as const },
  },
] as const;

export function PlayerShell({
  children, section, mobileOpen, setMobileOpen, collapsed, setCollapsed, userId, onSignOut
}: {
  children: React.ReactNode;
  section: PlayerSectionKey;
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  userId?: string;
  onSignOut?: () => void;
}) {
  const current = PLAYER_NAV.find((n) => n.key === section);
  return (
    <div className="flex h-dvh w-full">
      {/* Desktop sidebar */}
      <aside
        className={
          "sticky top-0 hidden shrink-0 self-start border-r-2 border-[#b8f05a]/40 bg-linear-to-b from-[#0f4a40] to-[#09231f] text-white md:flex md:h-dvh md:flex-col transition-[width] duration-200 " +
          (collapsed ? "md:w-16" : "md:w-62.5")
        }
      >
        <PlayerSidebarBody
          section={section}
          collapsed={collapsed}
          setCollapsed={setCollapsed}
          onSignOut={onSignOut}
        />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-1200 md:hidden">
          <button aria-label="Close menu" onClick={() => setMobileOpen(false)} className="absolute inset-0 bg-black/40" />
          <aside className="absolute inset-y-0 left-0 flex w-62.5 flex-col border-r-2 border-[#b8f05a]/40 bg-linear-to-b from-[#0f4a40] to-[#09231f] text-white shadow-xl">
            <PlayerSidebarBody
              section={section}
              collapsed={false}
              setCollapsed={() => { }}
              onClose={() => setMobileOpen(false)}
              onSignOut={onSignOut}
            />
          </aside>
        </div>
      )}

      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <div className="flex items-center justify-between border-b border-border bg-background px-4 py-2 md:hidden">
          <button onClick={() => setMobileOpen(true)} className="inline-flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium">
            <Menu className="h-4 w-4" /> Menu
          </button>
          <span className="text-sm font-semibold">{current?.label ?? "Workspace"}</span>
          <NotificationBell userId={userId} />
        </div>
        
        {/* Desktop top bar ONLY if not explore */}
        {section !== "explore" && (
           <div className="hidden items-center justify-end border-b border-border bg-background px-6 py-2 md:flex">
             <NotificationBell userId={userId} />
           </div>
        )}

        {/* Content */}
        {section === "explore" ? (
          <div className="h-full w-full flex-1 min-h-0">
            {children}
          </div>
        ) : (
          <div className="nice-scroll mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-4 py-6 sm:px-6 sm:py-8">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

export function PlayerSidebarBody({
  section, collapsed, setCollapsed, onClose, onSignOut
}: {
  section: PlayerSectionKey;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  onClose?: () => void;
  onSignOut?: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* The rail collapses to 64px, where a 4:1 wordmark would sit ~15px tall and
              stop being readable — the circle icon stands in for it at that width. */}
          {collapsed ? (
            <img src={chLogo.url} alt="CourtHub" className="h-7 w-7 shrink-0 rounded-full object-contain" />
          ) : (
            <span className="logo-glaze shrink-0">
              <img
                src="/courthub-wordmark.png"
                alt="CourtHub"
                width={983}
                height={240}
                className="h-7 w-auto object-contain"
              />
            </span>
          )}
        </div>
        {onClose ? (
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-white/70 transition-colors hover:bg-white/10 hover:text-[#b8f05a]">
            <X className="h-4 w-4" />
          </button>
        ) : (
          <button
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="hidden rounded-md p-1 text-white/70 transition-colors hover:bg-white/10 hover:text-[#b8f05a] md:inline-flex"
          >
            <Menu className="h-4 w-4" />
          </button>
        )}
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <ul className="space-y-1">
          {PLAYER_NAV.map(({ key, label, icon: Icon, to, search }) => {
            const active = section === key;
            return (
              <li key={key}>
                <Link
                  to={to}
                  search={search}
                  onClick={onClose}
                  title={collapsed ? label : undefined}
                  className={
                    "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors " +
                    (active
                      ? "bg-[#b8f05a] text-[#102521] shadow-sm"
                      : "text-white/75 hover:bg-white/10 hover:text-[#b8f05a]")
                  }
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!collapsed && <span className="truncate">{label}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="mt-auto border-t border-white/10 p-2">
        <button
          onClick={onSignOut}
          title={collapsed ? "Sign out" : undefined}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/15 hover:text-red-200"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          {!collapsed && <span className="truncate">Sign out</span>}
        </button>
      </div>
      {!collapsed && (
        <div className="border-t border-white/10 px-3 py-3.5">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-[#b8f05a] shadow-[0_0_8px_#b8f05a]" />
            <span className="font-display text-[11px] font-bold uppercase tracking-[0.18em] text-white/55">
              Player
            </span>
          </div>
          <div className="mt-0.5 font-display text-base font-bold tracking-tight text-white">
            Workspace
          </div>
        </div>
      )}
    </>
  );
}
