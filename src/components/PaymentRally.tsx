import { useEffect, useRef, useState } from "react";
import { Banknote } from "lucide-react";

/**
 * The rally that closes the Contact section: two players trade a pickleball over a net,
 * and the payment methods land beneath them.
 *
 * The rally itself is pure CSS — three looping animations that agree about the ball's
 * position because they share one duration (see `.rally-court` in styles.css). React's only
 * job is to notice when the pane comes into view: that starts the rally and deals the
 * payment cards in. Leaving the viewport pauses it rather than unmounting it, so scrolling
 * back finds the players mid-point rather than restarted.
 */

/** The two players, by name. Alliana is on the left, Ed on the right. */
const ALLIANA = "alliana";
const ED = "ed";

/** Rally-side chatter, in order. Ed opens, and the last line hands back to the first
 *  cleanly, so the loop reads as a continuing match rather than a restart. */
const DIALOGUE: { who: string; text: string }[] = [
  { who: ED, text: "Hi, Alliana! How are you?" },
  { who: ALLIANA, text: "So far, so good! How about you?" },
  { who: ED, text: "Mutual feeling. I\u2019m doing great. Ready for another game?" },
  { who: ALLIANA, text: "Definitely! But this time, don\u2019t go easy on me. \u{1F604}" },
  { who: ED, text: "Are you sure? Last game you were complaining about my serves." },
  { who: ALLIANA, text: "Because your serves are impossible to return! \u{1F602}" },
  { who: ED, text: "That\u2019s just part of the game." },
  { who: ALLIANA, text: "Okay, okay. Let\u2019s see if you can beat me this time." },
  { who: ED, text: "Challenge accepted!" },
  { who: ALLIANA, text: "Wait\u2026 here comes the ball!" },
  { who: ED, text: "I got it!" },
  { who: ALLIANA, text: "Nice shot!" },
  { who: ED, text: "Thanks! Your turn." },
  { who: ALLIANA, text: "And\u2026 there! Did you see that?" },
  { who: ED, text: "Okay, that was actually a good one." },
  { who: ALLIANA, text: "Told you I\u2019m getting better." },
  { who: ED, text: "I guess I need to step up my game." },
  { who: ALLIANA, text: "Exactly. Now, let\u2019s finish this match!" },
  { who: ED, text: "Let\u2019s do it! \u{1F3D3}" },
];

/** Long enough to read the longest line without rushing it. */
const LINE_MS = 3200;

type Method = {
  name: string;
  tint: string;
  initials: string;
  /**
   * Path to the provider's official brand asset under `public/payments/`.
   *
   * Deliberately null until the real files are added. These are registered trade marks and
   * every one of these providers publishes a brand kit whose terms require the supplied
   * artwork be used unaltered — a redrawn approximation is both inaccurate and a breach of
   * those terms, so none is shipped here. Drop the official SVG in and set the path; the
   * card renders it and keeps everything else. Anything that 404s falls back to the chip,
   * so a wrong path degrades quietly instead of showing a broken image on a payment row.
   */
  logo: string | null;
  /**
   * Backing for the mark, where the brand's own colour needs one. Maya's green is 1.43:1 on
   * white — its guidelines present it on dark, where it reaches 11:1 — so a dark chip is the
   * brand-correct treatment rather than a liberty taken with it. Everything else sits on the
   * card, which is what its own kit expects.
   */
  markBg?: string;
};

/** Live today through the PayMongo checkout — the same set the booking panel offers. */
const METHODS_LIVE: Method[] = [
  { name: "GCash", tint: "#007CFF", initials: "G", logo: "/payments/gcash.svg" },
  {
    name: "Maya",
    tint: "#00B37E",
    initials: "M",
    logo: "/payments/maya.svg",
    markBg: "#102521",
  },
  { name: "GrabPay", tint: "#00B14F", initials: "GP", logo: "/payments/grabpay.svg" },
  { name: "QR Ph", tint: "#204884", initials: "QR", logo: "/payments/qrph.svg" },
];

/** Card payments exist in the checkout schema but are not offered to players yet. */
const METHODS_SOON: Method[] = [
  { name: "Visa", tint: "#1A1F71", initials: "V", logo: "/payments/visa.svg" },
  { name: "Mastercard", tint: "#EB001B", initials: "MC", logo: "/payments/mastercard.svg" },
];

export function PaymentRally() {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  /* Latched separately from `inView`: the rally may pause and resume many times, but the
     payment cards should deal in once and stay dealt rather than re-animating on every
     pass. */
  const [dealt, setDealt] = useState(false);

  const [line, setLine] = useState(0);

  /* The chatter runs on its own clock rather than the rally's: the rally loops every 5.6s
     and a line needs longer than that to read. It advances only while the pane is on screen
     and picks up where it left off, so scrolling away mid-conversation does not restart it.
     Reduced motion holds it on the opening line instead — auto-advancing text is exactly
     what that preference is asking us not to do. */
  useEffect(() => {
    if (!inView) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setLine((prev) => (prev + 1) % DIALOGUE.length), LINE_MS);
    return () => window.clearInterval(id);
  }, [inView]);

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setInView(entry.isIntersecting);
        if (entry.isIntersecting) setDealt(true);
      },
      { threshold: 0.25 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={paneRef}
      className="mt-14 overflow-hidden rounded-3xl border border-[#dce8e2] bg-white"
    >
      <div className="flex items-center justify-between gap-4 border-b border-[#dce8e2] bg-[#f6f8f7] px-5 py-4 sm:px-7">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#5e746e]">
            Checkout
          </p>
          <h3 className="mt-0.5 font-cabinet text-lg font-bold tracking-tight text-[#102521]">
            Keep the rally going. We&rsquo;ll handle the rest.
          </h3>
        </div>
        <p className="hidden max-w-[15rem] text-right text-[11px] leading-relaxed text-[#5e746e] sm:block">
          Every booking is settled through our secure checkout.
        </p>
      </div>

      {/* ---- what they are saying ----
           Deliberately a band above the court rather than bubbles floating inside it: the
           ball's arc and the paddles' rest height are tuned to the court's exact geometry,
           and anything added inside would have moved them. */}
      <Chatter line={line} />

      {/* ---- the court ---- */}
      <div
        className="rally-court relative h-44 overflow-hidden bg-gradient-to-b from-[#f6f8f7] to-[#eaf5d8] sm:h-56"
        data-playing={inView}
        role="img"
        aria-label="Alliana and Ed rallying a pickleball across a net"
      >
        {/* Court floor. */}
        <span className="absolute inset-x-0 bottom-8 h-px bg-[#c3d6cd]" />
        <span className="absolute inset-x-0 bottom-0 h-8 bg-[#dfeed2]" />

        <Net />

        {/* The players stand on the floor line, facing each other across it. */}
        <Player variant="girl" className="absolute bottom-6 left-[2%] h-28 w-auto sm:h-36" />
        <Player
          variant="boy"
          className="absolute bottom-6 right-[2%] h-28 w-auto -scale-x-100 sm:h-36"
        />

        <Ball />
      </div>

      {/* ---- what the rally is paying for ---- */}
      <div className="px-5 py-7 sm:px-7">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#5e746e]">
            Pay with
          </p>
          <p className="text-[11px] text-[#5e746e]">Secured by our payment provider.</p>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {METHODS_LIVE.map((method, index) => (
            <MethodCard key={method.name} {...method} shown={dealt} index={index} />
          ))}
          {METHODS_SOON.map((method, index) => (
            <MethodCard
              key={method.name}
              {...method}
              soon
              shown={dealt}
              index={METHODS_LIVE.length + index}
            />
          ))}
        </div>
        {/* Kept out of the grid above deliberately. That row sits under "Secured by our
            payment provider", which is not true of cash — it never touches the provider.
            And whether it is offered is the venue's call, not ours: `payment_mode` defaults
            to 'none' (settle at the venue) but a venue can require the full amount online
            before a slot is held, so this must not read as a promise every court takes it. */}
        <div className="mt-5 border-t border-[#eef3f0] pt-5">
          <p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#5e746e]">
            Or pay on arrival
          </p>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="pay-card flex items-center gap-2.5 rounded-xl border border-[#dce8e2] bg-white px-3 py-2.5 transition-all duration-300 hover:-translate-y-0.5 hover:border-[#b8f05a] hover:shadow-md sm:w-56">
              <span
                className="grid h-7 w-10 shrink-0 place-items-center rounded-md"
                style={{ backgroundColor: "#0b3d351a" }}
              >
                <Banknote className="h-4 w-4 text-[#0b3d35]" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block font-cabinet text-xs font-bold text-[#102521]">
                  Cash at the venue
                </span>
                <span className="block text-[9px] font-semibold text-[#5e746e]">
                  Settle when you arrive
                </span>
              </span>
            </div>
            <p className="text-[11px] leading-relaxed text-[#5e746e] sm:flex-1">
              Prefer to pay in person? Many venues let you settle in cash on the day. Each venue
              sets its own rule, and its booking page says which it takes before you confirm.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Chatter({ line }: { line: number }) {
  const speaker = DIALOGUE[line].who;
  /* Each side keeps its own last line on screen, dimmed, so the band reads as a exchange in
     progress rather than a single caption jumping from one player to the other. */
  const lastFrom = (who: string) => {
    for (let i = line; i >= 0; i -= 1) if (DIALOGUE[i].who === who) return i;
    return -1;
  };

  return (
    /* items-end so a bubble grows upward off a fixed baseline: the lines vary from three
       words to a dozen, and anchoring the top would jog the whole band on every change.
       aria-hidden because this is flavour that rewrites itself every few seconds — the court
       below carries the real description, and a live region here would just chatter at a
       screen reader. */
    <div
      aria-hidden
      className="flex min-h-[6.5rem] items-end justify-between gap-3 bg-[#f6f8f7] px-5 pb-3 pt-5 sm:gap-6 sm:px-7"
    >
      {[ALLIANA, ED].map((who) => {
        const index = lastFrom(who);
        const isAlliana = who === ALLIANA;
        return (
          <div key={who} className={`min-w-0 flex-1 ${isAlliana ? "" : "flex justify-end"}`}>
            {index >= 0 && (
              <div
                /* Keyed on the line so React remounts it and the pop animation replays. */
                key={index}
                className={`bubble-pop relative max-w-[17rem] rounded-2xl border px-3 py-2 transition-opacity duration-300 ${
                  speaker === who
                    ? "border-[#dce8e2] bg-white opacity-100 shadow-sm"
                    : "border-[#e3ece7] bg-[#fbfdfc] opacity-55"
                }`}
              >
                <p
                  className={`text-[9px] font-bold uppercase tracking-[.14em] ${
                    isAlliana ? "text-[#12806d]" : "text-[#2f6d8f]"
                  }`}
                >
                  {isAlliana ? "Alliana" : "Ed"}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-[#41564f]">
                  {DIALOGUE[index].text}
                </p>
                {/* Tail: a rotated square tucked under the edge nearest its speaker, with
                    two borders hidden so only the outer corner shows. */}
                <span
                  className={`absolute -bottom-1 h-2.5 w-2.5 rotate-45 border-b border-r ${
                    speaker === who ? "border-[#dce8e2] bg-white" : "border-[#e3ece7] bg-[#fbfdfc]"
                  } ${isAlliana ? "left-5" : "right-5"}`}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Net() {
  return (
    <div className="absolute bottom-8 left-1/2 h-20 w-24 -translate-x-1/2 sm:h-24 sm:w-32">
      {/* Mesh, drawn as a crosshatch so it does not cost an image. */}
      <div className="absolute inset-x-2 bottom-0 top-2 bg-[repeating-linear-gradient(90deg,#7d9a90_0_1px,transparent_1px_7px),repeating-linear-gradient(0deg,#7d9a90_0_1px,transparent_1px_7px)] opacity-55" />
      {/* Tape along the top, the brightest part of a real net. */}
      <div className="absolute inset-x-1 top-0 h-2 rounded-sm bg-white shadow-[0_1px_2px_rgba(16,37,33,0.2)]" />
      {/* Posts. */}
      <div className="absolute bottom-0 left-0 top-0 w-1.5 rounded-full bg-[#0b3d35]" />
      <div className="absolute bottom-0 right-0 top-0 w-1.5 rounded-full bg-[#0b3d35]" />
    </div>
  );
}

function Ball() {
  return (
    /* Three nested layers, one axis each, because a single CSS animation can only apply one
       timing function per segment to every property it touches — see the keyframes. Outer
       carries the horizontal at a flat rate, middle the arc, inner the spin. */
    <span className="rally-ball absolute h-6 w-6 sm:h-7 sm:w-7">
      <span className="rally-ball-arc absolute inset-0">
        <span className="rally-ball-spin absolute inset-0 grid place-items-center rounded-full bg-[#d9f24f] shadow-[0_2px_10px_rgba(16,37,33,0.25)] ring-1 ring-[#0b3d35]/15">
          {/* Pickleballs are perforated — the holes are what make it read as one. */}
          <span className="grid grid-cols-3 gap-[3px]">
            {Array.from({ length: 9 }).map((_, i) => (
              <span key={i} className="h-[3px] w-[3px] rounded-full bg-[#0b3d35]/35" />
            ))}
          </span>
        </span>
      </span>
    </span>
  );
}

function MethodCard({
  name,
  tint,
  initials,
  logo,
  markBg,
  soon,
  shown,
  index,
}: Method & { soon?: boolean; shown: boolean; index: number }) {
  /* A logo path that fails to load falls back to the chip rather than leaving a broken
     image on a payment row, which is the one place a visitor is deciding whether to trust
     the page. */
  const [logoBroken, setLogoBroken] = useState(false);
  const showLogo = Boolean(logo) && !logoBroken;
  const delay = index * 80;

  return (
    <div
      data-dealt={shown}
      style={
        {
          "--deal-delay": `${delay}ms`,
          transitionDelay: shown ? `${delay}ms` : "0ms",
        } as React.CSSProperties
      }
      className={`pay-card group flex items-center gap-2 rounded-xl border px-2.5 py-2 transition-all duration-500 ease-out motion-reduce:transition-none ${
        soon
          ? "border-dashed border-[#c3d6cd] bg-[#f6f8f7]"
          : "border-[#dce8e2] bg-white hover:-translate-y-0.5 hover:border-[#b8f05a] hover:shadow-md"
      } ${shown ? "translate-y-0 scale-100 opacity-100" : "translate-y-2.5 scale-[.96] opacity-0"}`}
    >
      <span
        /* w-16, not w-10: four of the six marks are wordmarks rather than square glyphs, and
           object-contain would otherwise shrink them to a few pixels tall to fit the width. */
        className={`pay-mark grid h-7 w-16 shrink-0 place-items-center overflow-hidden rounded-md px-1 transition-transform duration-300 motion-reduce:transition-none ${
          soon ? "" : "group-hover:scale-110"
        }`}
        /* A real mark sits on nothing — it brings its own colour, and painting it onto a
           tinted chip breaks the provider's background rules. The stand-in chips match that
           treatment (brand colour on a wash of itself) so a row that mixes the two still
           reads as one set rather than two designs. */
        style={
          showLogo
            ? markBg
              ? { backgroundColor: markBg }
              : undefined
            : { backgroundColor: `${soon ? "#9db3ac" : tint}1a` }
        }
      >
        {showLogo ? (
          <img
            src={logo as string}
            alt={`${name} logo`}
            loading="lazy"
            onError={() => setLogoBroken(true)}
            /* Dimmed rather than desaturated for the unavailable ones: a grayscale filter
               restates the mark in colours the brand never authorised, where opacity is the
               ordinary disabled-state convention and leaves the hues intact. */
            className={`h-full w-full object-contain ${soon ? "opacity-60" : ""}`}
          />
        ) : (
          <span className="text-[9px] font-bold" style={{ color: soon ? "#5e746e" : tint }}>
            {initials}
          </span>
        )}
      </span>
      <span className="min-w-0">
        <span
          className={`block truncate font-cabinet text-xs font-bold ${soon ? "text-[#5e746e]" : "text-[#102521]"}`}
        >
          {name}
        </span>
        {soon && <span className="block text-[9px] font-semibold text-[#8aa39a]">Coming soon</span>}
      </span>
    </div>
  );
}

/** Flat illustration, drawn rather than photographed so it recolours with the brand and
 *  costs no image request. Limbs are round-capped strokes; only the kit is filled.
 *  The two variants share every coordinate — they differ in hair, kit and palette, which
 *  is what keeps their paddles meeting the ball at the same height. */
function Player({ variant, className }: { variant: "girl" | "boy"; className: string }) {
  const girl = variant === "girl";
  const skin = girl ? "#f0c6a0" : "#d9a172";
  const hair = girl ? "#3a2a1e" : "#241a12";
  const kit = girl ? "#b8f05a" : "#12806d";
  const kitShade = girl ? "#a5e243" : "#0f6b5c";
  const bottoms = girl ? "#0b3d35" : "#123f57";

  return (
    /* The viewBox starts at y -16, not 0: at the top of the wind-up the paddle's far corner
       swings to about y -6 in figure coordinates, and an SVG clips to its viewBox, so
       without that headroom the corner is sliced off at the peak of the swing. */
    <svg viewBox="0 -16 132 172" className={className} aria-hidden focusable="false">
      <ellipse cx="52" cy="150" rx="30" ry="4.5" fill="#0b3d35" opacity="0.12" />

      {girl ? (
        <path
          d="M36 24c-9 2-14 10-13 20 1 9 5 14 9 19"
          stroke={hair}
          strokeWidth="9"
          strokeLinecap="round"
          fill="none"
        />
      ) : null}

      {/* Back leg and arm first, so the front pair overlaps them. */}
      <path
        d="M44 88 32 112l-7 22"
        stroke={skin}
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M40 54 29 68l3 14"
        stroke={skin}
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      <path
        d="M56 88l9 24 3 22"
        stroke={skin}
        strokeWidth="8.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      <path d="M20 136h14a3 3 0 0 1 0 6H19a3 3 0 0 1 1-6Z" fill="#0b3d35" />
      <path d="M62 138h14a3 3 0 0 1 0 6H61a3 3 0 0 1 1-6Z" fill="#0b3d35" />

      {/* A flared skirt for her, straight shorts with a leg split for him. */}
      {girl ? (
        <path d="M35 74h32l6 20H30l5-20Z" fill={bottoms} />
      ) : (
        <>
          <path d="M35 74h32v18H35V74Z" fill={bottoms} />
          <path d="M50 84h2v8h-2v-8Z" fill="#0b3d35" opacity="0.35" />
        </>
      )}

      <path d="M38 42h26l6 34H32l6-34Z" fill={kit} />
      <path d="M38 42h26l2 10H36l2-10Z" fill={kitShade} />

      <circle cx="52" cy="28" r="14" fill={skin} />
      {girl ? (
        <path d="M38 26c1-9 7-14 14-14s13 5 14 14c-4-5-9-7-14-7s-10 2-14 7Z" fill={hair} />
      ) : (
        /* Cropped, with a short fringe rather than a full sweep. */
        <path
          d="M38 25c0-9 6-14 14-14s14 5 14 14c-2-3-5-5-8-5-6 0-8 3-14 3-3 0-5 1-6 2Z"
          fill={hair}
        />
      )}
      <circle cx="59" cy="29" r="1.8" fill="#2b2018" />
      <path
        d="M56 35c2 1.5 4.5 1.5 6.5 0"
        stroke="#2b2018"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />

      {/* Playing arm and paddle rotate together about the shoulder, so the paddle stays in
          the hand through the whole swing. The far player runs half a cycle behind. */}
      <g className={`rally-swing ${girl ? "" : "rally-swing-far"}`}>
        <path
          d="M64 52l22 6 14-4"
          stroke={skin}
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        {/* Handle and face are centred on y 53.5 — the height the arm above ends at — so the
            paddle sits in the grip instead of floating over it. */}
        <rect x="98" y="50" width="16" height="7" rx="3.5" fill="#0b3d35" />
        <rect x="112" y="36" width="17" height="35" rx="8" fill={girl ? "#12806d" : "#b8f05a"} />
        <rect x="115" y="39" width="11" height="29" rx="5.5" fill={girl ? "#0f6b5c" : "#a5e243"} />
      </g>
    </svg>
  );
}
