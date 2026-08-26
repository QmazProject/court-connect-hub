import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Bell, CheckCheck, Undo2, X } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  useNotifications,
  timeAgo,
  formatFullDate,
  notificationLabel,
  notificationActionLabel,
  NOTIFICATION_ICON,
  type AppNotification,
} from "@/lib/notifications";

export function NotificationBell({
  userId,
  onOpenBooking,
  align = "end",
  /** "dark" is for the Explore toolbar, a deep green panel where the default light
   *  border and near-black icon would not be visible. The popover itself is unchanged. */
  tone = "light",
}: {
  userId: string | undefined;
  onOpenBooking?: (bookingId: number, conversationId: string | null) => void;
  align?: "start" | "center" | "end";
  tone?: "light" | "dark";
}) {
  const { items, unread, loading, markRead, markAllRead, markUnread } = useNotifications(userId);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<AppNotification | null>(null);
  const navigate = useNavigate();

  /* The list re-fetches constantly — realtime, and opening one marks it read — so the
     detail view reads through to the live row rather than rendering the snapshot it
     was opened with, which would show a stale read state the moment it appeared. */
  const active = selected ? (items.find((n) => n.id === selected.id) ?? selected) : null;

  /* Where a notification goes when acted on. Shared by the modal's button so the
     destination is identical whichever way it was reached. */
  const followUp = (n: AppNotification) => {
    setSelected(null);
    setOpen(false);
    if (n.booking_id && onOpenBooking) {
      onOpenBooking(n.booking_id, n.conversation_id);
      return;
    }
    if (n.link) navigate({ to: n.link });
  };

  const openDetail = (n: AppNotification) => {
    if (!n.read_at) markRead([n.id]);
    setSelected(n);
    setOpen(false);
  };

  if (!userId) return null;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            aria-label={unread > 0 ? `${unread} unread notifications` : "Notifications"}
            className={
              "relative rounded-md border p-2 transition-colors " +
              (tone === "dark"
                ? "border-white/20 bg-white/10 text-white hover:bg-white/20"
                : "border-border text-foreground hover:bg-secondary")
            }
          >
            <Bell className="h-4 w-4" />
            {unread > 0 && (
              <span
                className={
                  "absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-bold " +
                  (tone === "dark"
                    ? "bg-[#b8f05a] text-[#102521]"
                    : "bg-primary text-primary-foreground")
                }
              >
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align={align} className="z-[1300] w-[min(22rem,calc(100vw-2rem))] p-0">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="font-display text-sm font-semibold">Notifications</span>
            {unread > 0 && (
              <button
                onClick={() => markAllRead()}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-primary hover:bg-primary/10"
              >
                <CheckCheck className="h-3.5 w-3.5" /> Mark all read
              </button>
            )}
          </div>
          <div className="nice-scroll max-h-[60vh] overflow-y-auto">
            {loading ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">Loading…</p>
            ) : items.length === 0 ? (
              <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                Nothing yet. Booking changes, refunds and messages will show up here.
              </p>
            ) : (
              <ul>
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      /* Opens the detail rather than jumping straight to the booking.
                       The row clamps the body to two lines and has no room for the
                       full timestamp, so a notification with anything to say was
                       being truncated; the modal shows all of it, and still offers
                       the jump as a deliberate second step. */
                      onClick={() => openDetail(n)}
                      className={
                        "flex w-full gap-2.5 border-b border-border/70 px-3 py-2.5 text-left transition hover:bg-secondary/70 " +
                        (n.read_at ? "" : "bg-primary/5")
                      }
                    >
                      <span className="mt-0.5 text-base leading-none">
                        {NOTIFICATION_ICON[n.type] ?? "🔔"}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold leading-snug">{n.title}</span>
                        {n.body && (
                          <span className="mt-0.5 block line-clamp-2 text-[11px] text-muted-foreground">
                            {n.body}
                          </span>
                        )}
                        <span className="mt-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                          {timeAgo(n.created_at)}
                        </span>
                      </span>
                      {!n.read_at && (
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {active && (
        <NotificationDetail
          notification={active}
          onClose={() => setSelected(null)}
          onFollowUp={() => followUp(active)}
          onMarkUnread={() => {
            markUnread(active.id);
            setSelected(null);
          }}
        />
      )}
    </>
  );
}

/**
 * One notification, in full.
 *
 * Hand-rolled rather than the shared `Dialog`, which sits at `z-50` — below the
 * Explore toolbar (`z-900`) that now hosts the bell, so a Radix dialog would open
 * behind it. `BookingChat` solved the same problem the same way; this matches it.
 */
function NotificationDetail({
  notification: n,
  onClose,
  onFollowUp,
  onMarkUnread,
}: {
  notification: AppNotification;
  onClose: () => void;
  onFollowUp: () => void;
  onMarkUnread: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  /* Escape closes, and the page behind does not scroll while this is up. Both come
     free with Radix; hand-rolling the overlay means hand-rolling these too. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const canFollowUp = !!(n.link || n.booking_id);

  return (
    <div
      className="fixed inset-0 z-[1400] grid place-items-end bg-black/50 sm:place-items-center sm:p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="notification-detail-title"
        /* The backdrop closes on click; the panel must not pass its own clicks up. */
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-card shadow-xl sm:max-w-md sm:rounded-2xl"
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-secondary text-2xl leading-none">
            {NOTIFICATION_ICON[n.type] ?? "🔔"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-primary">
              {notificationLabel(n.type)}
            </p>
            <h2
              id="notification-detail-title"
              className="mt-1 font-display text-base font-bold leading-snug tracking-tight"
            >
              {n.title}
            </h2>
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          {n.body ? (
            /* `whitespace-pre-line` because reminder bodies are composed in SQL with
               real line breaks, and the list view flattens them. */
            <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">
              {n.body}
            </p>
          ) : (
            <p className="text-sm italic text-muted-foreground">No further details.</p>
          )}

          <dl className="mt-5 space-y-2 border-t border-border pt-4 text-xs">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Received</dt>
              <dd className="text-right font-medium">{formatFullDate(n.created_at)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">When</dt>
              <dd className="text-right font-medium">{timeAgo(n.created_at)}</dd>
            </div>
            {n.booking_id && (
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Booking</dt>
                <dd className="text-right font-medium tabular-nums">#{n.booking_id}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-4">
          {canFollowUp && (
            <button
              onClick={onFollowUp}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:opacity-90"
            >
              {notificationActionLabel(n.type)} <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={onMarkUnread}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-semibold transition hover:border-primary"
          >
            <Undo2 className="h-3.5 w-3.5" /> Mark unread
          </button>
          {!canFollowUp && (
            <button
              onClick={onClose}
              className="flex-1 rounded-lg border border-border px-4 py-2 text-sm font-semibold transition hover:bg-secondary"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
