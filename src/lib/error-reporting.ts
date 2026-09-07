// Loaders and server fns commonly throw a raw Response; String(it) is the
// opaque "[object Response]", so pull out the status and URL instead.
function describeError(error: unknown): string {
  if (error instanceof Response) {
    return `Response ${error.status}${error.url ? ` at ${error.url}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

// Prod React does not rethrow boundary-caught errors to window.onerror, so an
// error boundary swallows the failure unless it reports it itself. There is no
// telemetry backend wired up, so the console is the sink; passing `error` along
// keeps the stack expandable in devtools.
export function reportClientError(error: unknown, context: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  console.error(`[client] ${describeError(error)}`, {
    route: window.location.pathname,
    ...context,
    error,
  });
}
