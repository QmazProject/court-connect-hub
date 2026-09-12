import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "@/routes/_authenticated/dashboard";
import { dashboardSearchSchema, type DashboardUser } from "@/lib/dashboard-route";

/**
 * The workspace at its own address.
 *
 * A thin wrapper and nothing else: the screen, its queries, its permissions, Team,
 * bookings, transactions and settings are the same `Dashboard` that `/dashboard`
 * renders. Duplicating any of that would mean two implementations drifting apart, and
 * the second one would be the one nobody remembered to fix.
 *
 * The slug decides nothing. It is checked against the caller's own membership inside
 * `Dashboard`, which corrects the address when they disagree, and every query below it
 * is scoped by row-level security to `auth.uid()` — so this address cannot show one
 * business another's data however it is typed. Authentication comes from the
 * `_authenticated` layout, exactly as it does for `/dashboard`.
 */
export const Route = createFileRoute("/_authenticated/tenant/$slug/dashboard")({
  validateSearch: dashboardSearchSchema,
  component: WorkspaceDashboardRoute,
});

function WorkspaceDashboardRoute() {
  const { user } = Route.useRouteContext() as { user: DashboardUser };
  const { slug } = Route.useParams();
  return <Dashboard user={user} search={Route.useSearch()} workspaceSlug={slug} />;
}
