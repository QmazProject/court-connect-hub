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
        .select("id, type, title, body, link, booking_id, venue_id, conversation_id, read_at, created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as AppNotification[];
    },
  });

  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`notifications:${userId}`)
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
    await supabase.from("notifications").update({ read_at: new Date().toISOString() }).in("id", ids);
    qc.invalidateQueries({ queryKey: ["notifications", userId] });
  };

  const markAllRead = () => markRead(items.filter((n) => !n.read_at).map((n) => n.id));

  return { items, unread, loading: query.isLoading, markRead, markAllRead };
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

export const NOTIFICATION_ICON: Record<string, string> = {
  booking_cancelled: "🚫",
  booking_confirmed: "✅",
  refund: "💸",
  message: "💬",
  hours_changed: "🕒",
};
