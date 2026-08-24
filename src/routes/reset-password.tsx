import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/reset-password")({
  component: ResetPasswordRoute,
  head: () => ({
    meta: [
      { title: "Reset your password — CourtHub" },
      { name: "robots", content: "noindex" },
    ],
  }),
});

type Status = "checking" | "ready" | "invalid" | "done";

function ResetPasswordRoute() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    // Supabase encodes a used/expired/tampered recovery link as an error in the URL hash
    // rather than a session, so that never resolves via onAuthStateChange — check for it
    // up front instead of waiting on a session that will never arrive.
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    if (hashParams.get("error")) {
      setStatus("invalid");
      return;
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      if (session) setStatus("ready");
    });

    // The recovery link's session lands via this event — supabase-js parses it out of the
    // URL on load, which can take a beat after the redirect completes.
    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      if (event === "PASSWORD_RECOVERY" && session) setStatus("ready");
    });

    // Nothing arrived by either path within a reasonable window — this is not a valid
    // recovery visit (e.g. someone opened /reset-password directly).
    const timeout = window.setTimeout(() => {
      if (mounted) setStatus((current) => (current === "checking" ? "invalid" : current));
    }, 4000);

    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
      window.clearTimeout(timeout);
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Use a password with at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don’t match.");
      return;
    }
    setBusy(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setStatus("done");
  };

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-[#f4f7f5] px-4 py-12 sm:px-6">
      <div className="w-full max-w-md overflow-hidden rounded-3xl border border-[#d8e4df] bg-white shadow-xl">
        <div className="relative overflow-hidden bg-[#09231f] px-6 pb-8 pt-7 text-white sm:px-8">
          <div className="absolute -right-10 -top-16 h-44 w-44 rounded-full bg-[#b8f05a]/20 blur-3xl" />
          <span
            className="logo-glaze relative inline-block"
            style={{ "--logo-glaze-src": "url(/courthub-wordmark.png)" } as CSSProperties}
          >
            <img src="/courthub-wordmark.png" alt="CourtHub" className="h-7 w-auto object-contain" />
          </span>
          <p className="relative mt-8 text-xs font-bold uppercase tracking-[.2em] text-[#b8f05a]">
            Account security
          </p>
          <h1 className="relative mt-2 font-display text-3xl font-bold tracking-tight">
            {status === "done" ? "Password updated" : "Set a new password"}
          </h1>
          <p className="relative mt-3 text-sm leading-relaxed text-white/70">
            {status === "invalid"
              ? "This link couldn’t be used."
              : status === "done"
                ? "You’re all set — this device is already signed in with it."
                : "Choose a new password for your CourtHub account."}
          </p>
        </div>

        <div className="px-6 py-8 sm:px-8">
          {status === "checking" && (
            <p className="text-center text-sm text-[#5e746e]">Checking your reset link…</p>
          )}

          {status === "invalid" && (
            <div className="text-center">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-red-50 text-2xl">
                ⚠️
              </div>
              <p className="mt-5 text-sm leading-relaxed text-[#5e746e]">
                This link is invalid or has expired — reset links only work once. Head back to
                the sign-in screen and request a new one.
              </p>
              <Link
                to="/landing"
                search={{ signin: true }}
                className="mt-7 inline-block rounded-full bg-[#0b3d35] px-5 py-3.5 text-sm font-bold text-white transition hover:bg-[#126152]"
              >
                Back to sign in
              </Link>
            </div>
          )}

          {status === "ready" && (
            <form onSubmit={submit} className="flex flex-col">
              <label className="text-sm font-bold text-[#102521]">
                New password
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-[#d8e4df] bg-white px-3 py-3 outline-none transition focus:border-[#12806d] focus:ring-2 focus:ring-[#b8f05a]/50"
                  placeholder="At least 8 characters"
                  required
                  minLength={8}
                />
              </label>
              <label className="mt-5 text-sm font-bold text-[#102521]">
                Confirm new password
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-[#d8e4df] bg-white px-3 py-3 outline-none transition focus:border-[#12806d] focus:ring-2 focus:ring-[#b8f05a]/50"
                  placeholder="Type it again"
                  required
                  minLength={8}
                />
              </label>
              {error && (
                <p className="mt-5 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={busy}
                className="mt-7 rounded-full bg-[#0b3d35] px-5 py-3.5 text-sm font-bold text-white transition hover:bg-[#126152] disabled:cursor-wait disabled:opacity-60"
              >
                {busy ? "Updating…" : "Update password"}
              </button>
            </form>
          )}

          {status === "done" && (
            <div className="text-center">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#eaf5d8] text-2xl">
                ✅
              </div>
              <p className="mt-5 text-sm leading-relaxed text-[#5e746e]">
                Your password has been changed. Continue to CourtHub — you're already signed in.
              </p>
              {/* No role passed here on purpose: LandingPage's own hydration effect already
                  knows how to read the active session and route a tenant to /dashboard or a
                  player to /explore, so this doesn't need to duplicate that lookup. */}
              <button
                type="button"
                onClick={() => navigate({ to: "/landing", search: {} })}
                className="mt-7 rounded-full bg-[#0b3d35] px-5 py-3.5 text-sm font-bold text-white transition hover:bg-[#126152]"
              >
                Continue to CourtHub
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
