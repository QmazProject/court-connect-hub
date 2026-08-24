import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { VenueExplorer } from "./index";

const guestSearchSchema = z.object({
  sport: z.string().optional(),
});

/** Guest mode: the signed-out face of /explore — same map, same list, same filters, with a
 *  Guest mode badge and no booking. Deliberately a separate URL rather than a state of /explore.
 *
 *  Known trade-off: auth state now lives in the URL as well as in the session, so signing in
 *  while sitting here leaves the badge showing on a page that is no longer a guest view until
 *  the visitor navigates. A `beforeLoad` redirect for authenticated users would close that,
 *  and is the obvious thing to add if it starts to bite.
 */
export const Route = createFileRoute("/explore_/guest")({
  validateSearch: guestSearchSchema,
  component: ExploreGuestRoute,
  head: () => ({
    meta: [
      { title: "Explore venues | CourtHub" },
      {
        name: "description",
        content: "Browse sports courts across the Philippines. Sign in to book.",
      },
    ],
  }),
});

function ExploreGuestRoute() {
  const { sport } = Route.useSearch();
  return <VenueExplorer sport={sport} guestMode />;
}
