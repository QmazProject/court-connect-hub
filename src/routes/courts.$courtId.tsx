import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/courts/$courtId")({
  component: CourtRedirect,
});

function CourtRedirect() {
  const { courtId } = Route.useParams();
  const navigate = useNavigate();

  const q = useQuery({
    queryKey: ["court-venue", courtId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courts")
        .select("id, venue_id, is_active")
        .eq("id", Number(courtId))
        .eq("is_active", true)
        .maybeSingle();
      if (error) throw error;
      return data as { id: number; venue_id: number } | null;
    },
  });


  useEffect(() => {
    if (q.data?.venue_id) {
      navigate({
        to: "/venues/$venueId",
        params: { venueId: String(q.data.venue_id) },
        search: { court: q.data.id },
        replace: true,
      });
    }
  }, [q.data, navigate]);

  if (q.isLoading) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-10">
        <div className="h-40 animate-pulse rounded-2xl bg-muted" />
      </main>
    );
  }
  if (!q.data) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-16 text-center">
        <h1 className="text-2xl font-bold">Court unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This court doesn’t exist or is not currently accepting bookings.
        </p>
        <Link to="/" className="mt-4 inline-block text-primary hover:underline">← Back to courts</Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-10 text-center text-muted-foreground">
      Opening booking panel…
    </main>
  );
}
