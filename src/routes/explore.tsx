import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { VenueExplorer } from "./index";

const explorerSearchSchema = z.object({
  sport: z.string().optional(),
});

export const Route = createFileRoute("/explore")({
  validateSearch: explorerSearchSchema,
  component: ExplorerRoute,
  head: () => ({
    meta: [
      { title: "Explore venues | CourtHub" },
      { name: "description", content: "Find and book sports courts across the Philippines." },
    ],
  }),
});

function ExplorerRoute() {
  const { sport } = Route.useSearch();
  return <VenueExplorer sport={sport} />;
}
