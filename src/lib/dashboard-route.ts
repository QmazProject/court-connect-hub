import { z } from "zod";

/**
 * What the two dashboard addresses agree on.
 *
 * `/dashboard` and `/tenant/{slug}/dashboard` render the same screen, so they must
 * accept the same links. That contract lives here rather than in either route, so
 * neither can drift from the other and neither has to import the other to learn it.
 */

/** The tenant workspace switches panes with React state rather than routes, so a deep
 *  link carries the pane it wants and the screen seeds its state from it. */
export const TENANT_SECTIONS = [
  "dashboard",
  "calendar",
  "bookings",
  "courts",
  "customers",
  "team",
  "transactions",
  "vouchers",
  "settings",
] as const;

export type TenantSection = (typeof TENANT_SECTIONS)[number];

/** `view` picks which player pane is showing. A search param rather than a separate
 *  route, so the whole dashboard — including the tenant side, which ignores it — keeps
 *  one auth guard and one data layer. */
export const dashboardSearchSchema = z.object({
  view: z.enum(["bookings", "calendar", "favorites", "settings"]).optional().catch("bookings"),
  /* A notification about a booking has to land on the booking. */
  section: z.enum(TENANT_SECTIONS).optional().catch(undefined),
  /** Open the booking's conversation, not just the booking. Set by message links. */
  chat: z.coerce.boolean().optional().catch(undefined),
  /* Set by booking reminders so tapping the notification lands on the booking it is
     about, rather than the top of the workspace. */
  booking: z.coerce.number().int().positive().optional().catch(undefined),
});

export type DashboardSearch = z.infer<typeof dashboardSearchSchema>;

/** The signed-in account, as the authenticated layout resolves it. */
export type DashboardUser = {
  id: string;
  email?: string;
  user_metadata?: { role?: unknown; full_name?: unknown };
};
