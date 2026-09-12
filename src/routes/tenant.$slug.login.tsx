import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  classifyOAuthReturn,
  isWellFormedSlug,
  TENANT_LOGIN_PENDING_SLUG_KEY,
  WORKSPACE_SIGN_IN_FAILED,
} from "@/lib/tenant-login";
import { isFreshGoogleAccount } from "@/lib/google-account";

/**
 * A workspace's own sign-in page.
 *
 * The slug in the address says which workspace is being entered. It does not open it:
 * the database decides, through `membership_matches_slug()`, which reads `auth.uid()`
 * and takes no tenant id from anyone. Everything here is arranged so that a failure of
 * any kind — wrong password, wrong workspace, a player, an unaccepted invitation, an
 * unknown slug, or the check itself erroring — ends in the same place: signed out, with
 * one sentence that distinguishes none of them.
 *
 * There is no sign-up, no create-account link, no role selector and no way to change
 * workspace. Someone who needs an account here is given one by an admin through Team.
 */
export const Route = createFileRoute("/tenant/$slug/login")({
  ssr: false,
  component: TenantLoginPage,
});

/** The one exit that means success, and the only place this file navigates.
 *
 *  The workspace's own address, not CourtHub's: someone who signed in at their
 *  business's page stays visibly inside it. It is the same screen either way — the
 *  slug in the address is where they are, never what they may see. */
const WORKSPACE_DASHBOARD = "/tenant/$slug/dashboard" as const;

function TenantLoginPage() {
  const { slug } = Route.useParams();
  const navigate = useNavigate();

  const [businessName, setBusinessName] = useState<string | null>(null);
  const [pageReady, setPageReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"signin" | "forgot" | "forgot-sent">("signin");
  /* Set the moment a rejection begins, so the OAuth-return effect cannot race the
     password path into a second sign-out or a stale message. */
  const settling = useRef(false);

  /** Sign out first, then speak. The order is the requirement: a refused attempt must
   *  not leave a usable session behind for even as long as it takes to render a
   *  message. `signOut` is awaited, and its own failure does not stop the refusal. */
  const rejectAndSignOut = useCallback(async () => {
    settling.current = true;
    try {
      await supabase.auth.signOut();
    } catch {
      /* Already signed out, or the network went. Either way the attempt is refused;
         there is nothing better to do and nothing to tell the visitor. */
    }
    try {
      sessionStorage.removeItem(TENANT_LOGIN_PENDING_SLUG_KEY);
    } catch {
      /* Storage can be unavailable in a private window; the stash is a convenience. */
    }
    setBusy(false);
    setError(WORKSPACE_SIGN_IN_FAILED);
    settling.current = false;
  }, []);

  /* The name at the top of the page. `tenant_login_page` answers before anyone has
     signed in and returns the name and nothing else — no id, so there is no id in this
     browser to be swapped for another. An unknown slug simply yields no name, and the
     page then looks and behaves like a workspace that refuses everyone. */
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!isWellFormedSlug(slug)) {
        if (alive) setPageReady(true);
        return;
      }
      const { data } = await supabase.rpc("tenant_login_page", { _slug: slug });
      if (!alive) return;
      const row = Array.isArray(data) ? data[0] : data;
      setBusinessName(row?.name ?? null);
      setPageReady(true);
    };
    void load();
    return () => {
      alive = false;
    };
  }, [slug]);

  /** The check both paths share. True only for an active member of exactly this
   *  workspace; anything else, including the call failing, refuses. */
  const admitOrReject = useCallback(
    async (intendedSlug: string) => {
      const { data, error: checkError } = await supabase.rpc("membership_matches_slug", {
        _slug: intendedSlug,
      });
      /* A failed check is a refusal, never a pass. Treating an error as "unknown, let
         them through" is how a broken query becomes an open door. */
      if (checkError || data !== true) {
        await rejectAndSignOut();
        return;
      }
      try {
        sessionStorage.removeItem(TENANT_LOGIN_PENDING_SLUG_KEY);
      } catch {
        /* see above */
      }
      /* `intendedSlug` and not the address bar: this is the slug the database just
         confirmed the member belongs to, which is the only one worth landing on. */
      navigate({
        to: WORKSPACE_DASHBOARD,
        params: { slug: intendedSlug },
        replace: true,
      });
    },
    [navigate, rejectAndSignOut],
  );

  /* Two different things can bring a signed-in visitor to this page, and they deserve
     different endings.

     The first is a Google round trip that *started here*: an authentication attempt,
     marked by the slug stashed before leaving. That slug is the authority and the
     address bar is not, because a URL can be edited between leaving and arriving. A
     failure of any kind ends signed out, because a refused attempt must not leave a
     usable session behind.

     The second is simply arriving with a session already — a stale bookmark, a link
     from a colleague, a mistyped slug. That is not an attempt at anything, and it used
     to end with the visitor signed out of the workspace they were already using. Any
     page on the internet could log a CourtHub member out by linking here. Now the
     membership check still runs, so an existing session opens nothing it should not,
     but a refusal just leaves the sign-in form standing and the session alone. */
  useEffect(() => {
    let alive = true;
    const settle = async () => {
      let stashed: string | null = null;
      try {
        stashed = sessionStorage.getItem(TENANT_LOGIN_PENDING_SLUG_KEY);
      } catch {
        stashed = null;
      }
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!alive || !session || settling.current) return;

      /* Nothing stashed: a visit, not an attempt. */
      if (stashed === null) {
        const { data, error: checkError } = await supabase.rpc("membership_matches_slug", {
          _slug: slug,
        });
        if (!alive) return;
        /* The same question the attempt path asks, and only a clear yes admits anyone.
           A no is silent: they were not trying to sign in, so there is nothing to
           refuse and nothing to say. */
        if (!checkError && data === true) {
          navigate({ to: WORKSPACE_DASHBOARD, params: { slug }, replace: true });
        }
        return;
      }

      /* An account Supabase created seconds ago, in this very round trip: a Google
         address with nothing behind it on CourtHub. Refused with the same test and the
         same cleanup the landing page has always used, rather than a second lifecycle
         invented for this page. No membership is created and no workspace is
         bootstrapped, so what remains is an empty player profile — exactly what the
         landing page leaves, and never a tenant account. */
      if (isFreshGoogleAccount(session.user)) {
        await rejectAndSignOut();
        return;
      }

      const verdict = classifyOAuthReturn(slug, stashed);
      if (verdict.kind === "mismatch") {
        await rejectAndSignOut();
        return;
      }
      setBusy(true);
      await admitOrReject(verdict.kind === "verify" ? verdict.slug : slug);
    };
    void settle();
    return () => {
      alive = false;
    };
  }, [slug, admitOrReject, rejectAndSignOut, navigate]);

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    /* A bad password and an address with no account are the same answer here, and the
       same answer as belonging to another workspace. */
    if (authError) {
      await rejectAndSignOut();
      return;
    }
    await admitOrReject(slug);
  };

  const signInWithGoogle = async () => {
    setError(null);
    try {
      /* Written before leaving, read on return. This, not the address bar, is what the
         membership check is run against. */
      sessionStorage.setItem(TENANT_LOGIN_PENDING_SLUG_KEY, slug);
    } catch {
      /* Without storage the return is treated as an ordinary visit and checked against
         the URL's slug — still checked, never skipped. */
    }
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      /* Back to this exact page, so the workspace being entered is the one the round
         trip started from. */
      options: { redirectTo: `${window.location.origin}/tenant/${slug}/login` },
    });
    if (oauthError) {
      try {
        sessionStorage.removeItem(TENANT_LOGIN_PENDING_SLUG_KEY);
      } catch {
        /* see above */
      }
      setError(WORKSPACE_SIGN_IN_FAILED);
    }
  };

  const sendReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    /* The existing recovery route, unchanged. A reset establishes a session and grants
       no membership, so the next sign-in here faces exactly the same check. */
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    /* Always the same screen, whether or not that address has an account. */
    setMode("forgot-sent");
  };

  const heading = businessName ? `Sign in to ${businessName}` : "Sign in to your workspace";

  return (
    <div className="grid min-h-dvh place-items-center bg-[#f6f8f7] px-4 py-10">
      <div className="w-full max-w-md overflow-hidden rounded-3xl border border-[#d8e4df] bg-white shadow-xl">
        <div className="bg-linear-to-b from-[#0f4a40] to-[#09231f] px-6 py-8 text-white sm:px-8">
          <p className="text-xs font-bold uppercase tracking-[.2em] text-[#b8f05a]">CourtHub</p>
          <h1 className="mt-2 font-display text-2xl font-bold tracking-tight">
            {/* Rendered only once the lookup has answered, so the generic heading never
                flashes in front of a workspace that does have a name. */}
            {pageReady ? heading : " "}
          </h1>
          <p className="mt-2 text-sm text-white/70">
            {mode === "signin"
              ? "Sign in with your team account."
              : "We'll email you a link to set a new password."}
          </p>
        </div>

        <div className="px-6 py-8 sm:px-8">
          {mode === "signin" && (
            <>
              <button
                type="button"
                onClick={signInWithGoogle}
                disabled={busy}
                className="flex w-full items-center justify-center gap-2.5 rounded-full border-2 border-[#d8e4df] bg-white px-5 py-3.5 text-sm font-bold text-[#102521] transition hover:border-[#12806d]/40 disabled:opacity-60"
              >
                Continue with Google
              </button>
              <div className="my-5 flex items-center gap-3">
                <span className="h-px flex-1 bg-[#d8e4df]" />
                <span className="text-xs font-bold uppercase tracking-wider text-[#8a9c96]">
                  or
                </span>
                <span className="h-px flex-1 bg-[#d8e4df]" />
              </div>
            </>
          )}

          {mode === "forgot-sent" ? (
            <div className="text-center">
              <p className="text-sm leading-relaxed text-[#5e746e]">
                If an account exists for <strong className="text-[#102521]">{email}</strong>, a link
                to set a new password is on its way.
              </p>
              <button
                type="button"
                onClick={() => {
                  setMode("signin");
                  setError(null);
                }}
                className="mt-6 rounded-full bg-[#0b3d35] px-5 py-3.5 text-sm font-bold text-white hover:bg-[#126152]"
              >
                Back to sign in
              </button>
            </div>
          ) : (
            <form onSubmit={mode === "signin" ? signIn : sendReset}>
              <label className="text-sm font-bold text-[#102521]">
                Email
                <input
                  name="tenant-login-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  className="mt-2 w-full rounded-xl border border-[#d8e4df] bg-white px-3 py-3 outline-none transition focus:border-[#12806d] focus:ring-2 focus:ring-[#b8f05a]/50"
                  placeholder="you@yourbusiness.com"
                />
              </label>

              {mode === "signin" && (
                <>
                  <div className="mt-5 flex items-center justify-between gap-3">
                    <label
                      htmlFor="tenant-login-password"
                      className="text-sm font-bold text-[#102521]"
                    >
                      Password
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setMode("forgot");
                        setError(null);
                      }}
                      className="text-xs font-bold text-[#12806d] hover:underline"
                    >
                      Forgot password?
                    </button>
                  </div>
                  <input
                    id="tenant-login-password"
                    name="tenant-login-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    className="mt-2 w-full rounded-xl border border-[#d8e4df] bg-white px-3 py-3 outline-none transition focus:border-[#12806d] focus:ring-2 focus:ring-[#b8f05a]/50"
                    placeholder="Your password"
                  />
                </>
              )}

              {error && (
                <p
                  role="alert"
                  className="mt-4 rounded-xl bg-[#d03b3b]/10 px-3 py-2.5 text-sm font-semibold text-[#d03b3b]"
                >
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={busy}
                className="mt-6 w-full rounded-full bg-[#0b3d35] px-5 py-3.5 text-sm font-bold text-white transition hover:bg-[#126152] disabled:opacity-60"
              >
                {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Send reset link"}
              </button>

              {mode === "forgot" && (
                <button
                  type="button"
                  onClick={() => {
                    setMode("signin");
                    setError(null);
                  }}
                  className="mt-5 w-full text-sm font-bold text-[#12806d] hover:underline"
                >
                  Back to sign in
                </button>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
