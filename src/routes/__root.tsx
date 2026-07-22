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
import chLogo from "@/assets/CHicon.png.asset.json";
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
  const [session, setSession] = useState<{ name?: string; role?: string } | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [progress, setProgress] = useState(0);
  const router = useRouter();


  useEffect(() => {
    let mounted = true;
    async function hydrate(userId: string | undefined, fallbackName: string | undefined) {
      if (!userId) { if (mounted) setSession(null); return; }
      const { data } = await supabase.from("profiles").select("role, full_name").eq("id", userId).maybeSingle();
      if (mounted) setSession({ name: data?.full_name || fallbackName, role: data?.role });
    }
    supabase.auth.getUser().then(({ data }) => hydrate(data.user?.id, (data.user?.user_metadata as { full_name?: string } | undefined)?.full_name));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      hydrate(s?.user?.id, (s?.user?.user_metadata as { full_name?: string } | undefined)?.full_name);
      router.invalidate();
    });
    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, [router]);

  useEffect(() => {
    let ticking = false;
    let lastY = 0;
    const update = (target: EventTarget | null) => {
      let y = 0;
      let max = 0;
      if (target instanceof HTMLElement) {
        y = target.scrollTop;
        max = target.scrollHeight - target.clientHeight;
      } else {
        const main = document.querySelector("main") as HTMLElement | null;
        if (main && main.scrollHeight > main.clientHeight) {
          y = main.scrollTop;
          max = main.scrollHeight - main.clientHeight;
        } else {
          y = window.scrollY;
          max = document.documentElement.scrollHeight - window.innerHeight;
        }
      }
      setScrolled(y > 8);
      const pct = max > 0 ? Math.min(100, Math.max(0, (y / max) * 100)) : 0;
      setProgress(y < 4 ? 0 : pct);
      const delta = y - lastY;
      if (y < 12) setHidden(false);
      else if (delta > 6) setHidden(true);
      else if (delta < -6) setHidden(false);
      lastY = y;
    };
    const onScroll = (e: Event) => {
      if (ticking) return;
      ticking = true;
      const t = e.target;
      requestAnimationFrame(() => { update(t); ticking = false; });
    };
    update(null);
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
  }, []);


  async function signOut() {
    await supabase.auth.signOut();
    router.navigate({ to: "/", replace: true });
  }

  return (
    <header
      className={
        "sticky top-0 z-[1100] border-b bg-background/85 backdrop-blur transition-[height,background,border-color,box-shadow] duration-300 " +
        (scrolled
          ? "h-12 border-border shadow-sm supports-[backdrop-filter]:bg-background/70"
          : "h-16 border-border/60")
      }

    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-blue-500 shadow-[0_0_10px_rgba(37,99,235,0.85)] transition-[width,opacity] duration-100 ease-out"
        style={{ width: `${progress}%`, opacity: progress > 0 ? 1 : 0 }}

      />
      <div className="mx-auto flex h-full max-w-6xl items-center justify-between px-4 sm:px-6">

        <Link to="/" className="flex items-center gap-2 font-display font-bold tracking-tight">
          <img
            src={chLogo.url}
            alt="CourtHub logo"
            className={"rounded-full object-contain transition-all duration-200 " + (scrolled ? "h-7 w-7" : "h-9 w-9")}
          />
          <span className={"transition-all duration-200 " + (scrolled ? "text-base" : "text-xl")}>CourtHub</span>
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
            <>
              <a href="/contact" className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-secondary">
                Contact
              </a>
              <Link to="/auth" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                Sign in
              </Link>
            </>
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
      <div className="flex h-[100dvh] flex-col">
        <Header />
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </QueryClientProvider>
  );
}
