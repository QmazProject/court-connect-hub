import { createFileRoute, Link } from "@tanstack/react-router";
import { LegalPage } from "@/components/LegalDocument";
import { PRIVACY } from "@/lib/legal";

export const Route = createFileRoute("/privacy")({
  component: PrivacyRoute,
  head: () => ({
    meta: [
      { title: "Privacy Policy — CourtHub" },
      {
        name: "description",
        content:
          "How CourtHub collects, uses, shares and protects your personal data, and the rights you have over it under the Data Privacy Act of 2012.",
      },
      { property: "og:title", content: "Privacy Policy — CourtHub" },
      { property: "og:type", content: "website" },
    ],
  }),
});

function PrivacyRoute() {
  return (
    <LegalPage
      doc={PRIVACY}
      counterpart={
        <Link to="/terms" className="text-sm font-bold text-[#12806d] transition hover:underline">
          Read the Terms &amp; Conditions
        </Link>
      }
    />
  );
}
