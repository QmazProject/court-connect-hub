import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import appCss from "../styles.css?url";
import chLogo from "@/assets/courthub-logo.png.asset.json";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { supabase } from "@/integrations/supabase/client";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <p className="mt-4 text-muted-foreground">This court doesn't exist.</p>
        <Link to="/" className="mt-6 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
          Back to CourtHub
        </Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  useEffect(() => { reportLovableError(error, { boundary: "root" }); }, [error]);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <button
          onClick={() => { router.invalidate(); reset(); }}
          className="mt-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "CourtHub — Book & manage sports courts" },
      { name: "description", content: "CourtHub connects players with courts and gives venue tenants tools to list and manage their courts, rates and hours." },
      { property: "og:title", content: "CourtHub" },
      { property: "og:description", content: "Book & manage sports courts." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.png", type: "image/png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head><HeadContent /></head>
      <body>{children}<Scripts /></body>
    </html>
  );
}

function Header() {
  const [session, setSession] = useState<{ email?: string; role?: string } | null>(null);
  const router = useRouter();

  useEffect(() => {
    let mounted = true;
    async function hydrate(userId: string | undefined, email: string | undefined) {
      if (!userId) { if (mounted) setSession(null); return; }
      const { data } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
      if (mounted) setSession({ email, role: data?.role });
    }
    supabase.auth.getUser().then(({ data }) => hydrate(data.user?.id, data.user?.email));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      hydrate(s?.user?.id, s?.user?.email);
      router.invalidate();
    });
    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, [router]);

  async function signOut() {
    await supabase.auth.signOut();
    router.navigate({ to: "/", replace: true });
  }

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link to="/" className="flex items-center" aria-label="CourtHub home">
          <img src={chLogo.url} alt="CourtHub" className="h-12 w-auto object-contain" />
        </Link>
        <nav className="flex items-center gap-2">
          {session ? (
            <>
              {session.role === "tenant" && (
                <Link to="/dashboard" className="rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-secondary">
                  Dashboard
                </Link>
              )}
              <span className="hidden text-xs text-muted-foreground sm:inline">{session.email}</span>
              <button onClick={signOut} className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-secondary">
                Sign out
              </button>
            </>
          ) : (
            <Link to="/auth" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen">
        <Header />
        <Outlet />
      </div>
    </QueryClientProvider>
  );
}
