import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { LandingPage } from "./index";

const landingSearchSchema = z.object({
  /** Set by /dashboard and the legacy header when an unauthenticated visitor is bounced
   *  here; LandingPage consumes it once and clears it so a refresh does not reopen the sheet. */
  signin: z.boolean().optional().catch(false),
  /** Opens the sheet straight on the player/tenant role picker, for "create account" links
   *  arriving from pages that have no auth UI of their own (explore, venue detail). */
  signup: z.boolean().optional().catch(false),
  sport: z.string().optional(),
});

export const Route = createFileRoute("/landing")({
  validateSearch: landingSearchSchema,
  component: LandingRoute,
  head: () => ({
    meta: [
      { title: "CourtHub — Find & book premium sports courts" },
      {
        name: "description",
        content:
          "Discover courts near you on the map, filter by sport and price, and book in seconds.",
      },
      { property: "og:title", content: "CourtHub — Find & book premium sports courts" },
      {
        property: "og:description",
        content: "Map-first court discovery. Filter, browse and book premium venues.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

function LandingRoute() {
  const { signin, signup } = Route.useSearch();
  return <LandingPage signin={signin} signup={signup} />;
}
