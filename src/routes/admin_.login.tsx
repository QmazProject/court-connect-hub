/**
 * The admin sign-in page.
 *
 * Deliberately outside the /admin layout — a guarded login page would redirect to
 * itself. It is also not a security boundary: knowing this URL grants nothing. The
 * page authenticates with the ordinary Supabase session, then asks the database
 * whether the account holds an admin role, and signs straight back out if it does
 * not. There is no admin sign-up here or anywhere else.
 *
 * Two ways in, one rule. An account can hold a password or it can be a Google
 * account with no password at all — the super admin is whichever account the
 * bootstrap SQL named, and that account was very likely created with "Continue
 * with Google" on the player side. Both paths end at the same `admit()`: a
 * session is not an admission, `is_courthub_admin()` is, and an account that
 * fails it is signed out here whichever door it came through.
 */

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { Loader2, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { fetchAdminIdentity } from "@/lib/admin";

export const Route = createFileRoute("/admin_/login")({
  ssr: false,
  component: AdminLogin,
});

/* Written before leaving for Google, read on return. Its presence is what tells a
   fresh page load "you are the second half of a sign-in that started here", so the
   admission check runs; a plain visit to this page with some other session open is
   left alone, exactly as before. It is cleared only once that check has finished,
   so a remount part-way through picks the work up rather than losing it. */
const GOOGLE_PENDING_KEY = "courthub-admin-login:google-pending";

const NOT_ADMIN = "That account does not have CourtHub admin access.";
const GOOGLE_INCOMPLETE = "Google sign-in did not complete. Try again.";

/* Nothing on this page may wait forever. The return leg makes at most three
   network calls; if any of them has not answered in this long, the page says so
   and hands control back rather than showing a spinner nobody can dismiss. */
const RETURN_TIMEOUT_MS = 15_000;

function readPending(): boolean {
  try {
    return sessionStorage.getItem(GOOGLE_PENDING_KEY) === "1";
  } catch {
    /* Without storage the return is an ordinary visit; the /admin guard still
       checks authority on its own, so nothing is granted by skipping this. */
    return false;
  }
}

function writePending(on: boolean) {
  try {
    if (on) sessionStorage.setItem(GOOGLE_PENDING_KEY, "1");
    else sessionStorage.removeItem(GOOGLE_PENDING_KEY);
  } catch {
    /* see readPending */
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** The session Google's redirect leaves behind.
 *
 *  `getSession` waits for the client to finish exchanging the code in the URL,
 *  but on a slow exchange a first call can still come back empty. A missing
 *  session is therefore given a bounded chance to arrive through the auth event
 *  — the same event the landing page listens for — before it is called a failure. */
async function awaitReturnedSession(): Promise<Session | null> {
  const {
    data: { session },
  } = await withTimeout(supabase.auth.getSession(), RETURN_TIMEOUT_MS, "getSession");
  if (session) return session;

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (s: Session | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(s);
    };
    const timer = setTimeout(() => finish(null), RETURN_TIMEOUT_MS);
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, s) => {
      if (
        s &&
        (event === "SIGNED_IN" || event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED")
      ) {
        finish(s);
      }
    });
    unsubscribe = () => subscription.unsubscribe();
  });
}

function AdminLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* One return leg at a time. A second effect run — a remount, a dev-mode
     double-invoke — joins the one in flight instead of starting another. */
  const returnLeg = useRef<Promise<void> | null>(null);

  /** The one admission decision, shared by both doors. */
  const admit = async () => {
    setStatus("Checking admin access…");
    const identity = await withTimeout(fetchAdminIdentity(), RETURN_TIMEOUT_MS, "admin check");
    if (!identity) {
      /* Authenticated, but not an admin. The session is dropped rather than left
         open, so a mistaken sign-in here does not silently log someone into the
         player app on an admin machine. */
      await supabase.auth.signOut();
      setError(NOT_ADMIN);
      return;
    }
    setStatus("Opening the console…");
    await navigate({ to: "/admin", search: {} as never });
  };

  /* The return leg of a Google sign-in. Supabase has already established the
     session by the time this page loads again; all that is left is the same
     question the password path asks. */
  useEffect(() => {
    if (!readPending()) return;
    if (returnLeg.current) return;

    setBusy(true);
    setError(null);
    setStatus("Finishing Google sign-in…");
    returnLeg.current = (async () => {
      try {
        const session = await awaitReturnedSession();
        if (!session) {
          setError(GOOGLE_INCOMPLETE);
          return;
        }
        await admit();
      } catch (err) {
        /* The detail goes to the console for whoever is debugging; the screen
           gets one sentence, because the specific failure is not the user's to fix. */
        console.error("[admin login] Google return leg failed", err);
        setError(GOOGLE_INCOMPLETE);
      } finally {
        /* Unconditional. Whatever happened above, this page is never left busy. */
        writePending(false);
        setBusy(false);
        setStatus(null);
        returnLeg.current = null;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) throw signInError;
      await admit();
    } catch (err) {
      /* One message for every failure. Distinguishing "wrong password" from "not an
         admin" would turn this form into a way to enumerate admin accounts. */
      setError(
        err instanceof Error && /admin access/.test(err.message)
          ? err.message
          : "Those credentials did not work.",
      );
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  const signInWithGoogle = async () => {
    if (busy) return;
    setError(null);
    writePending(true);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      /* Back to this exact page, so the admission check above is what runs next —
         not the player landing, which would happily accept the session as a player. */
      options: { redirectTo: `${window.location.origin}/admin/login` },
    });
    if (oauthError) {
      writePending(false);
      setError("Google sign-in did not start. Try again.");
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-lg">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-foreground text-popover">
            <ShieldCheck className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0">
            <h1 className="font-display text-lg font-bold tracking-tight text-foreground">
              CourtHub Admin
            </h1>
            <p className="text-xs text-muted-foreground">Internal access only</p>
          </div>
        </div>

        <form onSubmit={submit} className="mt-5 space-y-3">
          <label className="block">
            <span className="text-xs font-semibold text-muted-foreground">Email</span>
            <input
              name="login-email"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-muted-foreground">Password</span>
            <input
              name="login-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </label>

          {error && (
            <p
              role="alert"
              className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-sm font-semibold text-popover transition hover:opacity-90 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Sign in
          </button>
        </form>

        <div className="my-4 flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>

        {/* For an admin whose account was created with Google and has no password.
            Same admission rule as the form above: the session Google returns is
            checked against user_roles and dropped if it holds nothing. */}
        <button
          type="button"
          onClick={signInWithGoogle}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold text-foreground transition hover:bg-secondary disabled:opacity-50"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4">
            <path
              fill="currentColor"
              d="M21.6 12.23c0-.68-.06-1.33-.18-1.96H12v3.71h5.38a4.6 4.6 0 0 1-2 3.02v2.5h3.24c1.9-1.75 2.98-4.32 2.98-7.27Z"
            />
            <path
              fill="currentColor"
              d="M12 22c2.7 0 4.96-.9 6.62-2.43l-3.24-2.5c-.9.6-2.04.96-3.38.96-2.6 0-4.8-1.75-5.59-4.11H3.07v2.58A10 10 0 0 0 12 22Z"
            />
            <path
              fill="currentColor"
              d="M6.41 13.92A6.01 6.01 0 0 1 6.1 12c0-.67.11-1.31.31-1.92V7.5H3.07A10 10 0 0 0 2 12c0 1.61.39 3.14 1.07 4.5l3.34-2.58Z"
            />
            <path
              fill="currentColor"
              d="M12 5.97c1.47 0 2.79.5 3.83 1.5l2.87-2.87C16.96 2.99 14.7 2 12 2a10 10 0 0 0-8.93 5.5l3.34 2.58C7.2 7.72 9.4 5.97 12 5.97Z"
            />
          </svg>
          Continue with Google
        </button>

        {/* What is happening while the page is busy, so a wait reads as progress
            and a stall reads as a stall. */}
        {busy && status && (
          <p role="status" className="mt-3 text-center text-xs text-muted-foreground">
            {status}
          </p>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
          Admin accounts are provisioned by CourtHub. There is no sign-up here. An account created
          with Google signs in with Google.
        </p>
      </div>
    </div>
  );
}
