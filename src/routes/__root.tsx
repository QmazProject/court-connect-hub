import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";

import { useEffect, type ReactNode } from "react";

import { AssistantWidget } from "@/components/assistant/AssistantWidget";
import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <p className="mt-4 text-muted-foreground">This court doesn't exist.</p>
        <Link to="/landing" className="mt-6 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
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
      /* Colours the OS chrome once CourtHub is installed, and is what makes the
         Add to Home Screen prompt offer a real app rather than a shortcut — which
         is the only route to push notifications on iOS. */
      { name: "theme-color", content: "#0f4a40" },
      // Both spellings, deliberately: Chrome deprecated the apple- prefix and warns
      // about it, but iOS Safari still reads only that one for standalone mode.
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "CourtHub" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // Hand-scaled at each size the tab actually asks for: the badge is detailed
      // enough that leaving the browser to squeeze 256px into a 16px slot turns it
      // to mush. Largest last — browsers pick the closest `sizes` match.
      { rel: "icon", href: "/favicon-16.png", type: "image/png", sizes: "16x16" },
      { rel: "icon", href: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { rel: "icon", href: "/favicon.png", type: "image/png", sizes: "256x256" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/CHicon.png" },
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


function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isVenuePage = pathname.startsWith("/venues/");
  const isCourtPage = pathname.startsWith("/courts/");
  /* Legal, auth and the payment hand-back are single-purpose pages — a chat bubble
     floating over a receipt or a consent form is noise, not help. */
  const quietPage = [
    "/landing",
    "/terms",
    "/privacy",
    "/reset-password",
    "/payment",
  ].some((p) => pathname.startsWith(p));
  /* The legacy header is gone, so these two detail pages have no chrome of their own —
     without a Back control a visitor who opened one from the map has no way out but the
     browser button. */
  const showFloatingNav = isVenuePage || isCourtPage;

  /* Register the push worker once per load. Registration is idempotent and cheap —
     the browser keeps it across sessions — but doing it here rather than only when
     Settings turns push on is what picks up a new sw.js after a deploy, and what
     restores handling for a player who subscribed on an earlier visit. */
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* Blocked by a private window or an unsupported browser. Push simply stays
         off; Settings explains why when the player looks. */
    });
  }, []);
  
  const handleBack = () => {
    if (window.history.length > 2) {
      router.history.back();
    } else {
      router.navigate({ to: isVenuePage || isCourtPage ? "/explore" : "/landing" });
    }
  };

  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex h-dvh flex-col">
        {showFloatingNav && (
          <div className="fixed left-4 top-4 z-1100 flex items-center gap-2">
            {(isVenuePage || isCourtPage) && (
              <button
                type="button"
                onClick={handleBack}
                className="inline-flex items-center rounded-full border border-border bg-background/90 px-4 py-2 text-sm font-semibold text-foreground shadow-sm backdrop-blur transition hover:bg-secondary"
              >
                ← Back
              </button>
            )}
          </div>
        )}
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <Outlet />
        </main>
        {/* Renders nothing until it knows who is signed in, so it is safe on every route. */}
        {!quietPage && <AssistantWidget />}
      </div>
    </QueryClientProvider>
  );
}
