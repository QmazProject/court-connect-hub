import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { X as CloseIcon, Check, ArrowDown } from "lucide-react";
import {
  LEGAL_EFFECTIVE_DATE,
  LEGAL_VERSION,
  type LegalBlock,
  type LegalDocument,
} from "@/lib/legal";

function Blocks({ blocks }: { blocks: LegalBlock[] }) {
  return (
    <>
      {blocks.map((block, index) =>
        typeof block === "string" ? (
          <p key={index} className="mt-3 text-sm leading-relaxed text-[#41564f] first:mt-0">
            {block}
          </p>
        ) : (
          <ul key={index} className="mt-3 space-y-2">
            {block.list.map((item) => (
              <li key={item} className="flex gap-2.5 text-sm leading-relaxed text-[#41564f]">
                <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#12806d]" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}

/** The document itself — headings and prose, with no page or modal chrome around it. */
export function LegalBody({ doc }: { doc: LegalDocument }) {
  return (
    <div className="space-y-7">
      {doc.sections.map((section) => (
        <section key={section.id} id={section.id} className="scroll-mt-28">
          <h2 className="font-display text-lg font-bold tracking-tight text-[#102521]">
            {section.heading}
          </h2>
          <div className="mt-2">
            <Blocks blocks={section.blocks} />
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * Reader used inside the auth sheet, so agreeing never costs you the form you just
 * filled in.  `onAgree` is only offered once the reader has actually reached the end
 * of the text — scrolling to the bottom is what unlocks it.
 */
export function LegalReader({
  doc,
  onClose,
  onAgree,
}: {
  doc: LegalDocument;
  onClose: () => void;
  onAgree?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [reachedEnd, setReachedEnd] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // A document short enough not to scroll would otherwise never fire a scroll event and
  // would leave the agree button permanently disabled, so measure once on mount too.
  const measure = () => {
    const node = scrollRef.current;
    if (!node) return;
    if (node.scrollTop + node.clientHeight >= node.scrollHeight - 24) setReachedEnd(true);
  };
  useEffect(measure, []);

  return (
    <div
      className="fixed inset-0 z-1500 grid place-items-center bg-[#061a17]/70 p-3 backdrop-blur-sm motion-safe:animate-[landing-overlay-in_.2s_ease-out_both] sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-reader-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-[#f6f8f7] shadow-2xl">
        <div className="relative shrink-0 overflow-hidden bg-[#0b3d35] px-5 py-5 text-white sm:px-7">
          <span
            aria-hidden
            className="absolute -right-12 -top-16 h-40 w-40 rounded-full bg-[#b8f05a]/20 blur-3xl"
          />
          <div className="relative flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[.2em] text-[#b8f05a]">
                {doc.kicker}
              </p>
              <h2
                id="legal-reader-title"
                className="mt-1 font-display text-2xl font-bold tracking-tight"
              >
                {doc.title}
              </h2>
              <p className="mt-1 text-[11px] text-white/60">
                Effective {LEGAL_EFFECTIVE_DATE} · Version {LEGAL_VERSION}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={`Close ${doc.title}`}
              className="shrink-0 rounded-full border border-white/20 p-2 text-white/80 transition hover:bg-white/10 hover:text-white"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div
          ref={scrollRef}
          onScroll={measure}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-7"
        >
          <p className="rounded-2xl border border-[#d8e4df] bg-white px-4 py-3 text-sm leading-relaxed text-[#41564f]">
            {doc.summary}
          </p>
          <div className="mt-7">
            <LegalBody doc={doc} />
          </div>
        </div>

        <div className="shrink-0 border-t border-[#dce8e2] bg-white px-5 py-4 sm:px-7">
          {onAgree ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-center gap-2 text-xs text-[#5e746e]">
                {reachedEnd ? (
                  <>
                    <Check className="h-3.5 w-3.5 shrink-0 text-[#12806d]" />
                    You&rsquo;ve reached the end of this document.
                  </>
                ) : (
                  <>
                    <ArrowDown className="h-3.5 w-3.5 shrink-0" />
                    Scroll to the end to continue.
                  </>
                )}
              </p>
              <button
                type="button"
                disabled={!reachedEnd}
                onClick={onAgree}
                className="rounded-full bg-[#0b3d35] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#126152] disabled:cursor-not-allowed disabled:opacity-40"
              >
                I have read and agree
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-full bg-[#0b3d35] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#126152]"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Standalone /privacy and /terms pages. */
export function LegalPage({ doc, counterpart }: { doc: LegalDocument; counterpart: ReactNode }) {
  return (
    <main className="min-h-screen bg-[#f6f8f7] text-[#102521]">
      <div className="relative overflow-hidden bg-[#0b3d35] text-white">
        <span
          aria-hidden
          className="absolute -right-20 -top-28 h-72 w-72 rounded-full bg-[#b8f05a]/20 blur-3xl"
        />
        <div className="relative mx-auto w-full max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
          <Link
            to="/landing"
            className="inline-flex items-center gap-2 text-xs font-bold text-white/70 transition hover:text-[#b8f05a]"
          >
            <span className="logo-glaze">
              <img
                src="/courthub-wordmark.png"
                alt="CourtHub"
                width={983}
                height={240}
                className="h-6 w-auto object-contain"
              />
            </span>
          </Link>
          <p className="mt-10 text-[11px] font-bold uppercase tracking-[.2em] text-[#b8f05a]">
            {doc.kicker}
          </p>
          <h1 className="mt-2 font-display text-4xl font-bold tracking-tight sm:text-5xl">
            {doc.title}
          </h1>
          <p className="mt-3 text-xs text-white/60">
            Effective {LEGAL_EFFECTIVE_DATE} · Version {LEGAL_VERSION}
          </p>
          <p className="mt-5 max-w-xl text-sm leading-relaxed text-white/75">{doc.summary}</p>
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
        <nav
          aria-label="Contents"
          className="rounded-3xl border border-[#dce8e2] bg-white p-5 sm:p-6"
        >
          <p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#5e746e]">
            Contents
          </p>
          <ol className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {doc.sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="text-sm text-[#12806d] transition hover:underline"
                >
                  {section.heading}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-9">
          <LegalBody doc={doc} />
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-[#dce8e2] pt-7 sm:flex-row sm:items-center sm:justify-between">
          {counterpart}
          <Link
            to="/landing"
            className="text-sm font-bold text-[#12806d] transition hover:underline"
          >
            Back to CourtHub
          </Link>
        </div>
      </div>
    </main>
  );
}
