import { createFileRoute, Link } from "@tanstack/react-router";
import { LegalPage } from "@/components/LegalDocument";
import { TERMS } from "@/lib/legal";

export const Route = createFileRoute("/terms")({
  component: TermsRoute,
  head: () => ({
    meta: [
      { title: "Terms & Conditions — CourtHub" },
      {
        name: "description",
        content:
          "The terms that govern your use of CourtHub, including account rules, bookings and payments, intellectual property and the restrictions on reverse engineering the platform.",
      },
      { property: "og:title", content: "Terms & Conditions — CourtHub" },
      { property: "og:type", content: "website" },
    ],
  }),
});

function TermsRoute() {
  return (
    <LegalPage
      doc={TERMS}
      counterpart={
        <Link to="/privacy" className="text-sm font-bold text-[#12806d] transition hover:underline">
          Read the Privacy Policy
        </Link>
      }
    />
  );
}
