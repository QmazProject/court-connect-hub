import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { X, Send, ShieldAlert, Paperclip, Reply, Loader2, FileText } from "lucide-react";

type Message = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  attachment_url: string | null;
  attachment_type: string | null;
  attachment_name: string | null;
  reply_to: string | null;
};

const MAX_LEN = 2000;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const ATTACHMENT_BUCKET = "chat-attachments";
/** Ten years, matching the other signed URLs in this project. A link that expires
 *  would blank an attachment that is still a valid record of an agreement. */
const SIGNED_EXPIRY = 60 * 60 * 24 * 365 * 10;

const ALLOWED_ATTACHMENTS = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
];

/**
 * Private thread attached to a single booking (player <-> venue staff).
 *
 * This is where a refund that is being settled by hand gets agreed, so it carries
 * screenshots and quoted replies. Account numbers are legitimate here — see the notice
 * in the header for what is not.
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
  const [uploading, setUploading] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

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
        .select(
          "id, conversation_id, sender_id, body, created_at, attachment_url, attachment_type, attachment_name, reply_to",
        )
        .eq("conversation_id", conversationId!)
        .order("created_at", { ascending: true })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as Message[];
    },
  });

  const messages = useMemo(() => msgsQ.data ?? [], [msgsQ.data]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  const namesQ = useQuery({
    queryKey: ["chat-names", conversationId, messages.length],
    enabled: messages.length > 0,
    queryFn: async () => {
      const ids = Array.from(new Set(messages.map((m) => m.sender_id)));
      const { data } = await supabase.from("profiles").select("id, full_name").in("id", ids);
      return new Map((data ?? []).map((p) => [p.id, p.full_name || "Member"]));
    },
  });

  useEffect(() => {
    if (!conversationId) return;
    const channel = supabase
      .channel(`messages:${conversationId}:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => qc.invalidateQueries({ queryKey: ["messages", conversationId] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId, qc]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  /* Reading the thread is what clears the unread badge on the booking row. Runs again
     whenever a message arrives while the thread is open, so a chat left on screen does
     not accumulate a phantom count. */
  useEffect(() => {
    if (!conversationId) return;
    void supabase.rpc("mark_conversation_read", { _conversation_id: conversationId }).then(() => {
      qc.invalidateQueries({ queryKey: ["unread-messages"] });
    });
  }, [conversationId, messages.length, qc]);

  const insertMessage = useCallback(
    async (fields: Partial<Message> & { body: string }) => {
      if (!conversationId) return false;
      const { error } = await supabase.from("messages").insert({
        conversation_id: conversationId,
        sender_id: meId,
        reply_to: replyTo?.id ?? null,
        ...fields,
      });
      if (error) {
        setErr(error.message);
        return false;
      }
      setReplyTo(null);
      qc.invalidateQueries({ queryKey: ["messages", conversationId] });
      return true;
    },
    [conversationId, meId, replyTo, qc],
  );

  const send = async () => {
    const body = text.trim();
    if (!body || !conversationId) return;
    if (body.length > MAX_LEN) {
      setErr(`Messages are limited to ${MAX_LEN} characters.`);
      return;
    }
    setSending(true);
    setErr(null);
    const ok = await insertMessage({ body });
    setSending(false);
    if (ok) setText("");
  };

  const attach = async (file: File | undefined) => {
    if (!file || !conversationId) return;
    setErr(null);
    if (!ALLOWED_ATTACHMENTS.includes(file.type)) {
      setErr("Attach a PNG, JPG, WebP, GIF or PDF.");
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setErr("Attachments are limited to 8 MB.");
      return;
    }
    setUploading(true);
    try {
      /* First path segment is the conversation id — every storage policy on this
         bucket checks `is_conversation_participant` against it, so the path is the
         authorisation subject and neither side can reach another thread's files. */
      const dot = file.name.lastIndexOf(".");
      const ext =
        dot > 0 && dot < file.name.length - 1
          ? file.name
              .slice(dot + 1)
              .toLowerCase()
              .replace(/[^a-z0-9]/g, "")
          : "";
      const path = `${conversationId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext || "bin"}`;

      const { error: upErr } = await supabase.storage
        .from(ATTACHMENT_BUCKET)
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;

      const { data: signed, error: sErr } = await supabase.storage
        .from(ATTACHMENT_BUCKET)
        .createSignedUrl(path, SIGNED_EXPIRY);
      if (sErr) throw sErr;

      await insertMessage({
        body: text.trim(),
        attachment_url: signed.signedUrl,
        attachment_type: file.type,
        attachment_name: file.name.slice(0, 120),
      });
      setText("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not attach that file.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const jumpTo = (id: string) => {
    document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const senderName = (id: string) => (id === meId ? "You" : (namesQ.data?.get(id) ?? "Member"));

  return (
    <div className="fixed inset-0 z-[1400] grid place-items-end bg-black/50 sm:place-items-center sm:p-4">
      <div className="flex h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-card shadow-2xl sm:h-[600px] sm:max-w-lg sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h3 className="truncate font-display text-sm font-semibold">{title}</h3>
            {subtitle && <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close chat"
            className="rounded-md p-1 hover:bg-secondary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Sharing an e-wallet number IS the point of this thread when a refund is being
            settled by hand, so the old blanket warning was telling people not to do the
            thing the product now asks them to do. The line is drawn at credentials
            instead: an account number identifies where money goes, an OTP or password
            lets someone take it. */}
        <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[11px] text-amber-800 dark:text-amber-300">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            Sharing a GCash or bank <b>account number</b> here is fine when you are arranging a
            refund. Never share a <b>password, OTP or card CVV</b> — no one from CourtHub or the
            venue will ever ask for those.
          </p>
        </div>

        <div className="nice-scroll flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {convQ.isLoading || msgsQ.isLoading ? (
            <p className="text-center text-xs text-muted-foreground">Loading conversation…</p>
          ) : convQ.error ? (
            <p className="text-center text-xs text-destructive">{(convQ.error as Error).message}</p>
          ) : messages.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No messages yet. Say hello — this thread is only about this booking.
            </p>
          ) : (
            messages.map((m) => {
              const mine = m.sender_id === meId;
              const quoted = m.reply_to ? byId.get(m.reply_to) : null;
              const isImage = !!m.attachment_type?.startsWith("image/");
              return (
                <div
                  key={m.id}
                  id={`msg-${m.id}`}
                  className={"group flex flex-col " + (mine ? "items-end" : "items-start")}
                >
                  {!mine && (
                    <span className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {senderName(m.sender_id)}
                    </span>
                  )}
                  <div
                    className={
                      "max-w-[80%] overflow-hidden rounded-2xl text-sm " +
                      (mine ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground")
                    }
                  >
                    {quoted && (
                      <button
                        onClick={() => jumpTo(quoted.id)}
                        className={
                          "block w-full border-l-2 px-3 py-1.5 text-left text-[11px] transition " +
                          (mine
                            ? "border-primary-foreground/50 bg-black/10 hover:bg-black/20"
                            : "border-primary/50 bg-black/5 hover:bg-black/10 dark:bg-white/5")
                        }
                      >
                        <span className="block font-semibold opacity-80">
                          {senderName(quoted.sender_id)}
                        </span>
                        <span className="line-clamp-2 opacity-70">
                          {quoted.body || quoted.attachment_name || "Attachment"}
                        </span>
                      </button>
                    )}

                    {m.attachment_url &&
                      (isImage ? (
                        <a href={m.attachment_url} target="_blank" rel="noreferrer">
                          <img
                            src={m.attachment_url}
                            alt={m.attachment_name ?? "Attachment"}
                            className="max-h-64 w-full object-cover"
                          />
                        </a>
                      ) : (
                        <a
                          href={m.attachment_url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-2 px-3 py-2 underline-offset-2 hover:underline"
                        >
                          <FileText className="h-4 w-4 shrink-0" />
                          <span className="truncate text-xs">
                            {m.attachment_name ?? "Attachment"}
                          </span>
                        </a>
                      ))}

                    {m.body && (
                      <p className="whitespace-pre-wrap break-words px-3 py-2">{m.body}</p>
                    )}
                  </div>

                  <div className="mt-0.5 flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(m.created_at).toLocaleString("en-PH", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </span>
                    <button
                      onClick={() => setReplyTo(m)}
                      className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-muted-foreground opacity-0 transition hover:text-primary focus:opacity-100 group-hover:opacity-100"
                    >
                      <Reply className="h-3 w-3" /> Reply
                    </button>
                  </div>
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>

        {err && <p className="px-4 pb-1 text-[11px] text-destructive">{err}</p>}

        {replyTo && (
          <div className="flex items-start gap-2 border-t border-border bg-secondary/50 px-4 py-2">
            <Reply className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Replying to {senderName(replyTo.sender_id)}
              </p>
              <p className="line-clamp-1 text-[11px] text-muted-foreground">
                {replyTo.body || replyTo.attachment_name || "Attachment"}
              </p>
            </div>
            <button
              onClick={() => setReplyTo(null)}
              aria-label="Cancel reply"
              className="rounded p-1 hover:bg-secondary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <div className="flex items-end gap-2 border-t border-border p-3">
          <input
            ref={fileRef}
            type="file"
            accept={ALLOWED_ATTACHMENTS.join(",")}
            className="hidden"
            onChange={(e) => attach(e.target.files?.[0])}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading || !conversationId}
            aria-label="Attach a file"
            title="Attach an image or PDF"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border text-muted-foreground transition hover:border-primary hover:text-primary disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Paperclip className="h-4 w-4" />
            )}
          </button>
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
            placeholder={replyTo ? "Write a reply…" : "Write a message…"}
            className="min-h-[44px] flex-1 resize-none rounded-xl border border-input bg-background px-3 py-2 text-sm"
          />
          <button
            onClick={send}
            disabled={sending || uploading || !text.trim() || !conversationId}
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
