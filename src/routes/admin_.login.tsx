/**
 * The admin sign-in page.
 *
 * Deliberately outside the /admin layout — a guarded login page would redirect to
 * itself. It is also not a security boundary: knowing this URL grants nothing. The
 * page authenticates with the ordinary Supabase session, then asks the database
 * whether the account holds an admin role, and signs straight back out if it does
 * not. There is no admin sign-up here or anywhere else.
 */

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { fetchAdminIdentity } from "@/lib/admin";

export const Route = createFileRoute("/admin_/login")({
  ssr: false,
  component: AdminLogin,
});

function AdminLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      const identity = await fetchAdminIdentity();
      if (!identity) {
        /* Authenticated, but not an admin. The session is dropped rather than left
           open, so a mistaken sign-in here does not silently log someone into the
           player app on an admin machine. */
        await supabase.auth.signOut();
        setError("That account does not have CourtHub admin access.");
        return;
      }
      await navigate({ to: "/admin", search: {} as never });
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

        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
          Admin accounts are provisioned by CourtHub. There is no sign-up here.
        </p>
      </div>
    </div>
  );
}
