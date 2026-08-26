import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Bell, CheckCheck } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { useNotifications, timeAgo, NOTIFICATION_ICON } from "@/lib/notifications";

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
  const { items, unread, loading, markRead, markAllRead } = useNotifications(userId);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  if (!userId) return null;

  return (
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
                    onClick={() => {
                      if (!n.read_at) markRead([n.id]);
                      if (n.booking_id && onOpenBooking) {
                        onOpenBooking(n.booking_id, n.conversation_id);
                        setOpen(false);
                        return;
                      }
                      /* Without a host handler a notification was a dead end. Reminders
                         carry their own deep link, so follow it — a reminder you cannot
                         act on is worse than no reminder. */
                      if (n.link) {
                        setOpen(false);
                        navigate({ to: n.link });
                      }
                    }}
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
  );
}
