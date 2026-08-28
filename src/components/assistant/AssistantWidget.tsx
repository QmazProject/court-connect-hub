/**
 * The floating assistant.
 *
 * It holds no knowledge of its own — every message it prints came back from
 * `ask()` in `src/lib/assistant`, which reads this system's rows. The widget's only
 * jobs are asking who is signed in, handing the engine a location when the player
 * offers one, and turning an `Answer` into something tappable.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarPlus,
  ExternalLink,
  Lightbulb,
  LightbulbOff,
  Loader2,
  MapPin,
  MessageCircle,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { ask } from "@/lib/assistant/engine";
import { newConversation, type Conversation } from "@/lib/assistant/context";
import type { Answer, AnswerBlock, AssistantRole, Chip, Nav, Origin } from "@/lib/assistant/types";

/* Split from the id so `push` can take a body: Omit<> over a union drops the
   members' distinguishing fields. */
type MsgBody =
  { from: "you"; text: string } | { from: "bot"; answer: Answer } | { from: "bot"; text: string };

type Msg = MsgBody & { id: number };

let nextId = 1;

/* How the nudge behaves. Kept together so the cadence is one place to change:
   NUDGE_EVERY_MS is the "every 10 seconds" pop, NUDGE_VISIBLE_MS how long each one
   stays before it gets out of the way. */
/* A per-browser UI preference, not user data: whether the tips are wanted at all.
   Read after mount, never during render — the server has no localStorage. */
const TIPS_KEY = "courthub:assistant:tips";

function readTipsOff(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(TIPS_KEY) === "off";
  } catch {
    /* Private window, or storage disabled. Showing the tips is the safe default. */
    return false;
  }
}

function writeTipsOff(off: boolean) {
  try {
    if (off) window.localStorage.setItem(TIPS_KEY, "off");
    else window.localStorage.removeItem(TIPS_KEY);
  } catch {
    /* The choice still holds for this page; it just will not survive a reload. */
  }
}

const NUDGE_FIRST_MS = 1_200;
const NUDGE_EVERY_MS = 10_000;
const NUDGE_VISIBLE_MS = 5_000;

/* Rotated rather than repeated: the same sentence every ten seconds stops being
   read after the second time. Each one names something the assistant can actually
   do, so the invitation is never a promise the engine cannot keep. */
const PLAYER_NUDGES = [
  "Ask me anything — live court availability, real prices, and what's open near you.",
  "Looking for a game tonight? I check live availability, not a stale list.",
  "Try: \u201ccheapest badminton near me tonight\u201d",
  "I can find courts by price, distance, sport or time — just ask.",
  "Try: \u201cis Court 2 free tomorrow 7\u20139pm?\u201d",
  "Ask about parking, GCash, refunds or opening hours — straight from the venue.",
];

const TENANT_NUDGES = [
  "Ask me anything about your venues — bookings, free courts, payments, occupancy.",
  "Try: \u201chow booked am I tonight?\u201d",
  "I can total today's payments across every venue you manage.",
  "Try: \u201cany cancellations today?\u201d",
  "Ask which court is busiest, or what's still free from 6\u201310 PM.",
];

function useViewer() {
  return useQuery({
    queryKey: ["assistant-viewer"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ userId: string; role: AssistantRole } | null> => {
      const { data } = await supabase.auth.getUser();
      const user = data.user;
      if (!user) return null;
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      /* Metadata carries the role before the profile row propagates on sign-up, so a
         brand new tenant is not greeted as a player on their first visit. */
      const metaRole = user.user_metadata?.role === "tenant" ? "tenant" : "player";
      const role: AssistantRole = profile?.role === "tenant" ? "tenant" : metaRole;
      return { userId: user.id, role };
    },
  });
}

function Blocks({ blocks, onNav }: { blocks: AnswerBlock[]; onNav: (n: Nav) => void }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === "text") {
          return (
            <p key={i} className="text-sm leading-relaxed text-foreground">
              {b.text}
            </p>
          );
        }
        if (b.kind === "note") {
          return (
            <p key={i} className="text-xs leading-relaxed text-muted-foreground">
              {b.text}
            </p>
          );
        }
        return (
          <ul key={i} className="space-y-2">
            {b.rows.map((r, j) => {
              const accent =
                r.tone === "ok"
                  ? "before:bg-primary"
                  : r.tone === "warn"
                    ? "before:bg-amber-500"
                    : r.tone === "off"
                      ? "before:bg-muted-foreground/30"
                      : "before:bg-border";
              const body = (
                <>
                  <span className="block text-[13px] font-semibold leading-tight text-foreground">
                    {r.title}
                  </span>
                  {/* The venue sits right under the court, because "Court 2" on its
                      own does not tell anyone where to go. */}
                  {r.subtitle && (
                    <span className="mt-0.5 flex items-center gap-1 text-[11.5px] font-medium text-muted-foreground">
                      <MapPin className="h-3 w-3 shrink-0" />
                      <span className="truncate">{r.subtitle}</span>
                    </span>
                  )}
                  {r.detail && (
                    <span className="mt-1 block text-xs leading-snug text-foreground/80">
                      {r.detail}
                    </span>
                  )}
                  {r.meta && (
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">{r.meta}</span>
                  )}
                </>
              );
              return (
                <li
                  key={j}
                  className={
                    "relative overflow-hidden rounded-lg border border-border bg-card px-3 py-2.5 pl-3.5 " +
                    "before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-[''] " +
                    accent
                  }
                >
                  {r.nav && !r.actions ? (
                    <button
                      type="button"
                      onClick={() => onNav(r.nav!)}
                      className="w-full text-left"
                    >
                      {body}
                    </button>
                  ) : (
                    body
                  )}

                  {/* Each action is a real route. Small and inline so a list of five
                      results still reads as a list rather than five panels. */}
                  {r.actions && r.actions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {r.actions.map((a, k) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => onNav(a.nav)}
                          className={
                            "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition " +
                            (a.emphasis === "primary"
                              ? "bg-foreground text-popover hover:opacity-90"
                              : "border border-border bg-background text-foreground hover:bg-secondary")
                          }
                        >
                          {a.emphasis === "primary" ? (
                            <CalendarPlus className="h-3 w-3" />
                          ) : (
                            <ExternalLink className="h-3 w-3" />
                          )}
                          {a.label}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        );
      })}
    </>
  );
}

export function AssistantWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [mounted, setMounted] = useState(false);
  /* The pointing tooltip above the bubble. `leaving` drives the exit animation so it
     fades out rather than vanishing mid-sentence. */
  const [nudge, setNudge] = useState<{ index: number; leaving: boolean } | null>(null);
  /* Two different refusals. `nudgeOff` is "not on this page"; `tipsOff` is the
     standing preference that survives a reload. */
  const [nudgeOff, setNudgeOff] = useState(false);
  const [tipsOff, setTipsOff] = useState(false);
  const nudgeCount = useRef(0);
  const lastQuestion = useRef<string>("");
  /* Where the last broad answer stopped, so "Show more" continues from it. */
  const lastShown = useRef<number>(0);
  const lastReason = useRef<string | null>(null);
  /* Session-local and in memory only: it holds which venue and which booking the
     player was just looking at, which is not something to leave in storage. */
  const conversation = useRef<Conversation>(newConversation());
  const threadRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const viewerQ = useViewer();
  const viewer = viewerQ.data ?? null;

  /* The engine talks to Supabase and the browser's geolocation, neither of which
     exists during SSR. */
  useEffect(() => {
    setMounted(true);
    setTipsOff(readTipsOff());
  }, []);

  const stopTips = () => {
    setTipsOff(true);
    setNudge(null);
    writeTipsOff(true);
  };

  const resumeTips = () => {
    setTipsOff(false);
    setNudgeOff(false);
    writeTipsOff(false);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  /* The nudge. It fires once shortly after mount — which is what makes it appear on
     a refresh — and then on a fixed interval. It never runs while the panel is open,
     because pointing at a button the player is already using is just noise. */
  useEffect(() => {
    if (!mounted || !viewer || open || nudgeOff || tipsOff) return;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;

    const show = () => {
      setNudge({ index: nudgeCount.current++, leaving: false });
      /* Start the exit a beat early so the fade finishes on time. */
      leaveTimer = setTimeout(
        () => setNudge((n) => (n ? { ...n, leaving: true } : n)),
        NUDGE_VISIBLE_MS - 280,
      );
      hideTimer = setTimeout(() => setNudge(null), NUDGE_VISIBLE_MS);
    };

    const first = setTimeout(show, NUDGE_FIRST_MS);
    const every = setInterval(show, NUDGE_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
      clearTimeout(hideTimer);
      clearTimeout(leaveTimer);
    };
  }, [mounted, viewer, open, nudgeOff, tipsOff]);

  /* Opening the panel retires whatever is on screen immediately. */
  useEffect(() => {
    if (open) setNudge(null);
  }, [open]);

  const push = (m: MsgBody) => setMsgs((prev) => [...prev, { ...m, id: nextId++ }]);

  const run = async (question: string, withOrigin: Origin | null = origin, offset = 0) => {
    if (!viewer || !question.trim()) return;
    lastQuestion.current = question;
    /* A "Show more" is a continuation, not a new question — echoing it back would
       make the thread read as if the player asked twice. */
    if (offset === 0) push({ from: "you", text: question });
    setBusy(true);
    try {
      const answer = await ask(
        question,
        { role: viewer.role, userId: viewer.userId, origin: withOrigin },
        { offset, conversation: conversation.current },
      );
      lastShown.current = answer.page?.shown ?? 0;
      lastReason.current = answer.meta?.rankReason ?? null;
      push({ from: "bot", answer });
    } catch {
      /* A failed read must not look like a confident "no". */
      push({
        from: "bot",
        text: "I could not reach the booking data just now. Try that again in a moment.",
      });
    } finally {
      setBusy(false);
    }
  };

  const locate = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      push({
        from: "bot",
        text: 'This browser will not share a location. Name a place instead — "courts near Cebu City".',
      });
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const next: Origin = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          label: "your location",
          source: "gps",
        };
        setOrigin(next);
        setBusy(false);
        void run(lastQuestion.current || "what is near me", next);
      },
      () => {
        setBusy(false);
        /* Once the browser has refused, stop asking and offer the typed route. */
        conversation.current.locationDenied = true;
        push({
          from: "bot",
          text: 'Location is off or was declined. Type a city, barangay, landmark or mall instead — "courts near Ayala Center Cebu".',
        });
      },
      { timeout: 10_000, maximumAge: 300_000 },
    );
  };

  const go = (n: Nav) => {
    setOpen(false);
    if (n.kind === "venue") {
      navigate({
        to: "/venues/$venueId",
        params: { venueId: String(n.id) } as never,
        search: {} as never,
      });
    } else if (n.venueId) {
      /* With the venue known we can open the real booking panel directly, on the
         right day and with the hours already picked. The panel re-checks them before
         selecting anything — nothing here holds a slot. */
      navigate({
        to: "/venues/$venueId",
        params: { venueId: String(n.venueId) } as never,
        search: {
          court: n.id,
          ...(n.date ? { date: n.date } : {}),
          ...(n.hours && n.hours.length > 0 ? { hours: n.hours.join(",") } : {}),
        } as never,
      });
    } else {
      navigate({
        to: "/courts/$courtId",
        params: { courtId: String(n.id) } as never,
        search: {} as never,
      });
    }
  };

  const onChip = (c: Chip) => {
    if (c.action === "locate") {
      if (conversation.current.locationDenied) {
        push({
          from: "bot",
          text: 'This browser has already refused location for CourtHub. Name a place instead — "courts near Lahug".',
        });
        return;
      }
      return locate();
    }
    if (c.action === "more") return void run(lastQuestion.current, origin, lastShown.current);
    if (c.action === "why") {
      /* Only the criteria the ranking actually applied — the string was built
         alongside the ordering, not invented here. */
      const reason = lastReason.current;
      push({
        from: "bot",
        text: reason
          ? `It came first because it ${reason}.`
          : "That answer was not ranked, so there is nothing to explain.",
      });
      return;
    }
    if (c.nav) return go(c.nav);
    if (c.ask) void run(c.ask);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    void run(q);
  };

  /* A change of signed-in identity must not leave the previous account's results on
     screen. `forIdentity` clears the structured context inside the engine; this
     clears what the player can still read. */
  const identity = viewer ? `${viewer.userId}:${viewer.role}` : null;
  useEffect(() => {
    conversation.current = newConversation();
    setMsgs([]);
    setOrigin(null);
    lastShown.current = 0;
    lastQuestion.current = "";
  }, [identity]);

  /* Signed out there is nothing to scope answers to, so the bubble stays away. */
  if (!mounted || !viewer) return null;

  const quickActions =
    viewer.role === "tenant"
      ? ["Today's bookings", "Free courts", "Payments today", "Occupancy"]
      : ["Available tonight", "Near me", "Cheapest courts", "My next booking"];

  return (
    <>
      {!open && nudge && (
        /* aria-live rather than a dialog: it is an aside the screen reader can
           announce without stealing focus from whatever the player is doing. */
        <div
          role="status"
          aria-live="polite"
          className={
            "fixed bottom-22 right-5 z-1150 w-63 max-w-[calc(100vw-2.5rem)] " +
            (nudge.leaving ? "assistant-nudge-leave" : "assistant-nudge-enter")
          }
        >
          <div className="relative rounded-2xl rounded-br-md border border-border bg-popover px-3.5 py-3 text-popover-foreground shadow-xl">
            <button
              type="button"
              onClick={() => {
                setNudge(null);
                setNudgeOff(true);
              }}
              aria-label="Hide this tip for now"
              className="absolute right-1.5 top-1.5 rounded-md p-0.5 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>

            <div className="flex items-center gap-1.5 pr-4">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-popover">
                <Sparkles className="h-3 w-3" />
              </span>
              <span className="font-display text-[11px] font-bold uppercase tracking-wider text-foreground">
                CourtHub Assistant
              </span>
              <span className="assistant-wave-hand text-sm" aria-hidden>
                &#128075;
              </span>
            </div>

            <p className="mt-1.5 text-[12.5px] leading-snug text-muted-foreground">
              {
                (viewer.role === "tenant" ? TENANT_NUDGES : PLAYER_NUDGES)[
                  nudge.index % (viewer.role === "tenant" ? TENANT_NUDGES : PLAYER_NUDGES).length
                ]
              }
            </p>

            {/* The × above only quiets this page. This is the standing choice, and it
                is spelled out rather than hidden behind an icon — someone trying to
                concentrate should not have to guess which control stops it. */}
            <button
              type="button"
              onClick={stopTips}
              className="mt-2 inline-flex items-center gap-1 rounded-md text-[11px] font-semibold text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
            >
              <LightbulbOff className="h-3 w-3" />
              Stop showing tips
            </button>

            {/* The tail. A rotated square rather than a border triangle, so it takes
                the bubble's own border and background and lines up under it. */}
            <span
              aria-hidden
              className="absolute -bottom-1.5 right-5 h-3 w-3 rotate-45 border-b border-r border-border bg-popover"
            />
          </div>
        </div>
      )}

      {!open && (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            if (msgs.length === 0) void run("hi");
          }}
          aria-label="Ask the assistant"
          className={
            /* Inverted against the page rather than brand-coloured: --foreground is
               near-black on the light theme and white on the dark one, so the button
               is the highest-contrast thing on screen either way, and it follows the
               theme instead of fighting it. */
            "fixed bottom-5 right-5 z-1150 flex h-13 w-13 items-center justify-center rounded-full bg-foreground text-popover shadow-lg ring-1 ring-border transition hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground " +
            (nudge && !nudge.leaving ? "assistant-pulse-ring" : "")
          }
        >
          <MessageCircle className="h-6 w-6" />
        </button>
      )}

      {open && (
        <div className="fixed inset-x-0 bottom-0 z-1150 flex justify-end p-0 sm:inset-auto sm:bottom-5 sm:right-5">
          <div className="flex h-[70dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-card shadow-2xl sm:h-[600px] sm:w-[26rem] sm:rounded-2xl">
            <div className="flex items-center gap-2 border-b border-border bg-linear-to-r from-[#0f4a40] to-[#09231f] px-4 py-3 text-white">
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-sm font-bold tracking-tight">
                  CourtHub Assistant
                </p>
                <p className="truncate text-[11px] text-white/70">
                  {viewer.role === "tenant" ? "Your venue operations" : "Live CourtHub data"}
                </p>
              </div>
              {/* The controls live in their own group, divided from the title, so the
                  tips switch is not mistaken for part of the heading and not crowded
                  against the close button. */}
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={tipsOff ? resumeTips : stopTips}
                  aria-label={
                    tipsOff ? "Turn assistant tips back on" : "Stop showing assistant tips"
                  }
                  aria-pressed={!tipsOff}
                  title={
                    tipsOff
                      ? "Pop-up tips are off — turn them on"
                      : "Pop-up tips are on — turn them off"
                  }
                  className={
                    "rounded-md p-1.5 transition hover:bg-white/10 " +
                    (tipsOff ? "text-white/40 hover:text-white/70" : "text-[#b8f05a]")
                  }
                >
                  {tipsOff ? (
                    <LightbulbOff className="h-4 w-4" />
                  ) : (
                    <Lightbulb className="h-4 w-4" />
                  )}
                </button>
                <span className="mx-0.5 h-4 w-px bg-white/20" aria-hidden />
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close assistant"
                  className="rounded-md p-1.5 text-white/70 transition hover:bg-white/10 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div
              ref={threadRef}
              className="nice-scroll flex-1 space-y-3.5 overflow-y-auto bg-background/40 px-3.5 py-3.5"
            >
              {msgs.map((m) =>
                m.from === "you" ? (
                  <div key={m.id} className="flex justify-end">
                    <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-[#0f4a40] px-3 py-2 text-sm text-white">
                      {m.text}
                    </p>
                  </div>
                ) : (
                  <div
                    key={m.id}
                    className="max-w-[95%] space-y-2 rounded-2xl rounded-bl-sm border border-border bg-card px-3 py-2.5 shadow-sm"
                  >
                    {"answer" in m ? (
                      <>
                        <Blocks blocks={m.answer.blocks} onNav={go} />
                        {m.answer.chips.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {m.answer.chips.map((c, i) => (
                              <button
                                key={i}
                                type="button"
                                onClick={() => onChip(c)}
                                className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-semibold text-foreground transition hover:border-primary hover:bg-primary/10"
                              >
                                {c.action === "locate" && <MapPin className="h-3 w-3" />}
                                {c.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-foreground">{m.text}</p>
                    )}
                  </div>
                ),
              )}
              {/* Role-aware openers. Each runs a real intent — none is a canned reply. */}
              {msgs.length <= 1 && !busy && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {quickActions.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => void run(q)}
                      className="inline-flex items-center rounded-full border border-primary/40 bg-primary/5 px-2.5 py-1 text-[11px] font-semibold text-foreground transition hover:bg-primary/15"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              )}
              {busy && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking the schedule…
                </div>
              )}
            </div>

            <form
              onSubmit={submit}
              className="flex items-center gap-2 border-t border-border px-3 py-2.5"
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  viewer.role === "tenant" ? "How booked am I tonight?" : "Cheapest court tonight?"
                }
                aria-label="Ask a question"
                className="min-w-0 flex-1 rounded-full border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
              <button
                type="submit"
                disabled={busy || !input.trim()}
                aria-label="Send"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0f4a40] text-[#b8f05a] transition hover:bg-[#126152] disabled:opacity-40"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
