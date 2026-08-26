import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type AppNotification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  booking_id: number | null;
  venue_id: number | null;
  conversation_id: string | null;
  read_at: string | null;
  created_at: string;
};

/** Live notification feed for the signed-in user. */
export function useNotifications(userId: string | undefined) {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ["notifications", userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notifications")
        .select(
          "id, type, title, body, link, booking_id, venue_id, conversation_id, read_at, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as AppNotification[];
    },
  });

  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`notifications:${userId}:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
        () => qc.invalidateQueries({ queryKey: ["notifications", userId] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, qc]);

  const items = query.data ?? [];
  const unread = items.filter((n) => !n.read_at).length;

  const markRead = async (ids: string[]) => {
    if (ids.length === 0) return;
    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .in("id", ids);
    qc.invalidateQueries({ queryKey: ["notifications", userId] });
  };

  const markAllRead = () => markRead(items.filter((n) => !n.read_at).map((n) => n.id));

  /* Opening a notification marks it read, so the detail view needs a way to undo
     that — "I will deal with this later" is the whole reason an unread badge is
     useful, and without this, reading one is irreversible. */
  const markUnread = async (id: string) => {
    await supabase.from("notifications").update({ read_at: null }).eq("id", id);
    qc.invalidateQueries({ queryKey: ["notifications", userId] });
  };

  return { items, unread, loading: query.isLoading, markRead, markAllRead, markUnread };
}

export function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-PH", { month: "short", day: "numeric" });
}

/** The full date, for the detail view. `timeAgo` is right in a list — "2h ago" is
 *  what you want when scanning — but a notification you have opened deserves the
 *  actual time, because that is usually the thing being checked. */
export function formatFullDate(iso: string) {
  return new Date(iso).toLocaleString("en-PH", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Human name for a notification `type`. The raw values are snake_case identifiers
 *  written for the database; this is what a player should read. */
export const NOTIFICATION_LABEL: Record<string, string> = {
  // Player
  booking_cancelled: "Booking cancelled",
  booking_confirmed: "Booking confirmed",
  booking_reminder_day: "Booking reminder",
  booking_reminder_soon: "Starting soon",
  refund: "Refund",
  message: "Message",
  hours_changed: "Opening hours changed",
  // Tenant — venue operations
  venue_booking_new: "New booking",
  venue_booking_changed: "Booking changed",
  venue_booking_cancelled: "Booking cancelled",
  venue_payment_received: "Payment received",
  venue_refund_processed: "Refund processed",
  venue_refund_failed: "Refund needs attention",
};

/** What the primary button in the detail view should say. A message wants "Open
 *  conversation", a payment wants "View payment" — "View booking" for all of them
 *  reads as if the app does not know what it just told you. */
export function notificationActionLabel(type: string): string {
  if (type === "message") return "Open conversation";
  if (type === "venue_payment_received" || type === "refund") return "View payment";
  if (type.startsWith("venue_refund")) return "View refund";
  if (type === "venue_booking_cancelled" || type === "booking_cancelled")
    return "Review cancellation";
  return "View booking";
}

/** Falls back to a readable version of the raw type rather than hiding it — an
 *  unlabelled new type should still show something a human can act on. */
export function notificationLabel(type: string): string {
  return NOTIFICATION_LABEL[type] ?? type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export const NOTIFICATION_ICON: Record<string, string> = {
  booking_cancelled: "🚫",
  booking_confirmed: "✅",
  booking_reminder_day: "📅",
  booking_reminder_soon: "⏰",
  refund: "💸",
  message: "💬",
  hours_changed: "🕒",
  venue_booking_new: "🎉",
  venue_booking_changed: "🔄",
  venue_booking_cancelled: "❌",
  venue_payment_received: "💳",
  venue_refund_processed: "💸",
  venue_refund_failed: "⚠️",
};
