import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

const searchSchema = z.object({
  mode: z.enum(["signin", "signup"]).default("signin").catch("signin"),
  as: z.enum(["player", "tenant"]).default("player").catch("player"),
});

export const Route = createFileRoute("/auth")({
  validateSearch: searchSchema,
  component: AuthPage,
});

type Step = "role" | "form";

function AuthPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">(search.mode);
  const [role, setRole] = useState<"player" | "tenant" | null>(null);
  const [step, setStep] = useState<Step>(mode === "signup" ? "role" : "form");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPwHints, setShowPwHints] = useState(false);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signupSuccess, setSignupSuccess] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) navigate({ to: "/", replace: true });
    });
  }, [navigate]);

  function switchMode(next: "signin" | "signup") {
    setMode(next);
    setError(null);
    setStep(next === "signup" ? "role" : "form");
    if (next === "signin") setRole(null);
  }

  const pwChecks = {
    length: password.length >= 8,
    upper: /[A-Z]/.test(password),
    number: /[0-9]/.test(password),
    special: /[^A-Za-z0-9]/.test(password),
  };
  const pwStrong = Object.values(pwChecks).every(Boolean);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (mode === "signup") {
        if (!role) throw new Error("Please choose an account type.");
        if (!pwStrong) throw new Error("Password does not meet the requirements.");
        const { data, error } = await supabase.auth.signUp({
          email, password,
          options: {
            emailRedirectTo: window.location.origin,
            data: { full_name: fullName, phone, role },
          },
        });
        if (error) throw error;
        // If email confirmation is required, session will be null
        if (!data.session) {
          setSignupSuccess(email);
          return;
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      const { data: u } = await supabase.auth.getUser();
      if (u.user) {
        const { data: p } = await supabase.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
        navigate({ to: p?.role === "tenant" ? "/dashboard" : "/", replace: true });
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-md place-items-center px-6 py-12">
      <div className="w-full rounded-2xl border border-border bg-card p-8 shadow-sm">
        {signupSuccess ? (
          <div className="text-center">
            <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-primary/10 text-3xl">
              📧
            </div>
            <h1 className="text-2xl font-bold">Check your email</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              We've sent a confirmation link to{" "}
              <span className="font-medium text-foreground">{signupSuccess}</span>.
              Click the link in the email to activate your {role} account, then sign in.
            </p>
            <div className="mt-4 rounded-lg bg-secondary/50 p-3 text-left text-xs text-muted-foreground">
              <p className="font-semibold text-foreground">Didn't get it?</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                <li>Check your spam or junk folder</li>
                <li>Make sure the email address is correct</li>
                <li>Wait a minute and refresh your inbox</li>
              </ul>
            </div>
            <button
              type="button"
              onClick={() => {
                setSignupSuccess(null);
                switchMode("signin");
              }}
              className="mt-6 w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
            >
              Go to sign in
            </button>
          </div>
        ) : mode === "signup" && step === "role" ? (
          <RoleStep
            role={role}
            setRole={setRole}
            onContinue={() => role && setStep("form")}
            onSwitchToSignIn={() => switchMode("signin")}
          />
        ) : (
          <>
            <div className="flex items-center justify-between">
              <h1 className="text-2xl font-bold">
                {mode === "signup" ? "Create your account" : "Welcome back"}
              </h1>
              {mode === "signup" && role && (
                <button
                  type="button"
                  onClick={() => setStep("role")}
                  className="rounded-full border border-border px-3 py-1 text-xs font-medium capitalize hover:bg-secondary"
                >
                  {role === "player" ? "🎾 Player" : "🏟️ Tenant"} · change
                </button>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {mode === "signup"
                ? `Signing up as ${role === "tenant" ? "a tenant / admin" : "a player"}.`
                : "Sign in to continue."}
            </p>

            <form onSubmit={onSubmit} className="mt-6 space-y-3">
              {mode === "signup" && (
                <>
                  <Field label="Full name" value={fullName} onChange={setFullName} required />
                  <Field label="Phone" value={phone} onChange={setPhone} type="tel" />
                </>
              )}
              <Field label="Email" value={email} onChange={setEmail} type="email" required />

              <div className="relative">
                <Field
                  label="Password"
                  value={password}
                  onChange={setPassword}
                  type="password"
                  required
                  minLength={mode === "signup" ? 8 : 6}
                  onFocus={() => mode === "signup" && setShowPwHints(true)}
                  onBlur={() => setShowPwHints(false)}
                />
                {mode === "signup" && showPwHints && (
                  <div className="absolute left-0 right-0 top-full z-10 mt-2 rounded-lg border border-border bg-popover p-3 text-sm shadow-lg">
                    <p className="mb-2 text-xs font-semibold text-muted-foreground">Password must include:</p>
                    <ul className="space-y-1">
                      <Check ok={pwChecks.length}>At least 8 characters</Check>
                      <Check ok={pwChecks.upper}>An uppercase letter</Check>
                      <Check ok={pwChecks.number}>A number</Check>
                      <Check ok={pwChecks.special}>A special character</Check>
                    </ul>
                  </div>
                )}
              </div>

              {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
              >
                {busy ? "Please wait…" : mode === "signup" ? `Create ${role} account` : "Sign in"}
              </button>
            </form>

            <div className="mt-6 text-center text-sm text-muted-foreground">
              {mode === "signup" ? "Already have an account?" : "New to CourtHub?"}{" "}
              <button
                onClick={() => switchMode(mode === "signup" ? "signin" : "signup")}
                className="font-medium text-primary hover:underline"
              >
                {mode === "signup" ? "Sign in" : "Create one"}
              </button>
            </div>
          </>
        )}

        <div className="mt-4 text-center">
          <Link to="/" className="text-xs text-muted-foreground hover:underline">← Back to home</Link>
        </div>
      </div>
    </main>
  );
}

function RoleStep(props: {
  role: "player" | "tenant" | null;
  setRole: (r: "player" | "tenant") => void;
  onContinue: () => void;
  onSwitchToSignIn: () => void;
}) {
  return (
    <>
      <h1 className="text-2xl font-bold">Join CourtHub</h1>
      <p className="mt-1 text-sm text-muted-foreground">First, tell us how you'll use CourtHub.</p>

      <div className="mt-6 space-y-3">
        <RoleCard
          selected={props.role === "player"}
          onClick={() => props.setRole("player")}
          icon="🎾"
          title="I'm a Player"
          desc="Browse and book courts near you."
        />
        <RoleCard
          selected={props.role === "tenant"}
          onClick={() => props.setRole("tenant")}
          icon="🏟️"
          title="I'm a Tenant / Admin"
          desc="List and manage your venue's courts, rates and hours."
        />
      </div>

      <button
        type="button"
        disabled={!props.role}
        onClick={props.onContinue}
        className="mt-6 w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
      >
        Continue
      </button>

      <div className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <button onClick={props.onSwitchToSignIn} className="font-medium text-primary hover:underline">
          Sign in
        </button>
      </div>
    </>
  );
}

function RoleCard(props: {
  selected: boolean; onClick: () => void; icon: string; title: string; desc: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`flex w-full items-start gap-3 rounded-xl border-2 p-4 text-left transition ${
        props.selected ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
      }`}
    >
      <span className="text-2xl">{props.icon}</span>
      <span>
        <span className="block font-semibold">{props.title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{props.desc}</span>
      </span>
    </button>
  );
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className={`flex items-center gap-2 text-xs ${ok ? "text-primary" : "text-muted-foreground"}`}>
      <span className={`grid h-4 w-4 place-items-center rounded-full text-[10px] ${ok ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
        {ok ? "✓" : "•"}
      </span>
      {children}
    </li>
  );
}

function Field(props: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; required?: boolean; minLength?: number;
  onFocus?: () => void; onBlur?: () => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{props.label}</span>
      <input
        type={props.type ?? "text"}
        required={props.required}
        minLength={props.minLength}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onFocus={props.onFocus}
        onBlur={props.onBlur}
        className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}
