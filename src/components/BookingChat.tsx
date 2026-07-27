import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { X, Send, ShieldAlert } from "lucide-react";

type Message = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
};

const MAX_LEN = 2000;

/**
 * Private thread attached to a single booking (player <-> venue staff).
 * Payment details must never be exchanged here — refunds are processed
 * back to the original payment method by the venue.
 */
export function BookingChat({
  bookingId,
  venueId,
  playerId,
  meId,
  title,
  subtitle,
  onClose,
}: {
  bookingId: number;
  venueId: number;
  playerId: string;
  meId: string;
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const convQ = useQuery({
    queryKey: ["conversation", bookingId],
    queryFn: async () => {
      const { data: existing, error } = await supabase
        .from("conversations")
        .select("id, booking_id, venue_id, player_id")
        .eq("booking_id", bookingId)
        .maybeSingle();
      if (error) throw error;
      if (existing) return existing;
      const { data: created, error: insErr } = await supabase
        .from("conversations")
        .insert({ booking_id: bookingId, venue_id: venueId, player_id: playerId })
        .select("id, booking_id, venue_id, player_id")
        .single();
      if (insErr) throw insErr;
      return created;
    },
  });

  const conversationId = convQ.data?.id;

  const msgsQ = useQuery({
    queryKey: ["messages", conversationId],
    enabled: !!conversationId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("id, conversation_id, sender_id, body, created_at")
        .eq("conversation_id", conversationId!)
        .order("created_at", { ascending: true })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as Message[];
    },
  });

  const namesQ = useQuery({
    queryKey: ["chat-names", conversationId, (msgsQ.data ?? []).length],
    enabled: !!msgsQ.data && msgsQ.data.length > 0,
    queryFn: async () => {
      const ids = Array.from(new Set((msgsQ.data ?? []).map((m) => m.sender_id)));
      const { data } = await supabase.from("profiles").select("id, full_name").in("id", ids);
      return new Map((data ?? []).map((p) => [p.id, p.full_name || "Member"]));
    },
  });

  useEffect(() => {
    if (!conversationId) return;
    const channel = supabase
      .channel(`messages:${conversationId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` },
        () => qc.invalidateQueries({ queryKey: ["messages", conversationId] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId, qc]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgsQ.data?.length]);

  const send = async () => {
    const body = text.trim();
    if (!body || !conversationId) return;
    if (body.length > MAX_LEN) {
      setErr(`Messages are limited to ${MAX_LEN} characters.`);
      return;
    }
    setSending(true);
    setErr(null);
    const { error } = await supabase.from("messages").insert({ conversation_id: conversationId, sender_id: meId, body });
    setSending(false);
    if (error) {
      setErr(error.message);
      return;
    }
    setText("");
    qc.invalidateQueries({ queryKey: ["messages", conversationId] });
  };

  return (
    <div className="fixed inset-0 z-[1400] grid place-items-end bg-black/50 sm:place-items-center sm:p-4">
      <div className="flex h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-card shadow-2xl sm:h-[600px] sm:max-w-lg sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h3 className="truncate font-display text-sm font-semibold">{title}</h3>
            {subtitle && <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>}
          </div>
          <button onClick={onClose} aria-label="Close chat" className="rounded-md p-1 hover:bg-secondary">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[11px] text-amber-800 dark:text-amber-300">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>Never share GCash numbers, card details or passwords here. Refunds are returned to your original payment method.</p>
        </div>

        <div className="nice-scroll flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {convQ.isLoading || msgsQ.isLoading ? (
            <p className="text-center text-xs text-muted-foreground">Loading conversation…</p>
          ) : convQ.error ? (
            <p className="text-center text-xs text-destructive">{(convQ.error as Error).message}</p>
          ) : (msgsQ.data ?? []).length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No messages yet. Say hello — this thread is only about this booking.
            </p>
          ) : (
            (msgsQ.data ?? []).map((m) => {
              const mine = m.sender_id === meId;
              return (
                <div key={m.id} className={"flex flex-col " + (mine ? "items-end" : "items-start")}>
                  {!mine && (
                    <span className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {namesQ.data?.get(m.sender_id) ?? "Member"}
                    </span>
                  )}
                  <div
                    className={
                      "max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm " +
                      (mine ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground")
                    }
                  >
                    {m.body}
                  </div>
                  <span className="mt-0.5 text-[10px] text-muted-foreground">
                    {new Date(m.created_at).toLocaleString("en-PH", { dateStyle: "short", timeStyle: "short" })}
                  </span>
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>

        {err && <p className="px-4 pb-1 text-[11px] text-destructive">{err}</p>}

        <div className="flex items-end gap-2 border-t border-border p-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, MAX_LEN))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="Write a message…"
            className="min-h-[44px] flex-1 resize-none rounded-xl border border-input bg-background px-3 py-2 text-sm"
          />
          <button
            onClick={send}
            disabled={sending || !text.trim() || !conversationId}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground disabled:opacity-50"
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
