/**
 * Court favorites — a player's shortlist of courts to book again.
 *
 * A favorite is a court, not a venue: what a player comes back for is the specific
 * court they liked, and the venue is context for finding it. Everything here reads
 * `public.court_favorites`, whose RLS restricts every row to `auth.uid()`, so no
 * query needs its own `user_id` filter to be safe — the filters below are there so
 * the cache key and the rows agree, not for access control.
 *
 * Two queries, deliberately:
 *   - `useFavoriteCourtIds` is the one a court tile asks. It reads ids only, so
 *     putting a heart on every tile of a venue page costs one small request.
 *   - `useFavoriteCourts` joins court and venue, and only the favorites view needs
 *     that much.
 * The toggle writes through both: the id set optimistically (a heart that waits for
 * the network reads as broken), the detail list by invalidation.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/** Enough of a court to render a tile and price it — the same fields the venue
 *  page's own tiles use, so a favorite shows the same rate the venue does. */
export type FavoriteCourt = {
  id: number;
  name: string;
  hourly_rate: number;
  rate_rules: unknown;
  images: string[] | null;
  map_emoji: string | null;
  is_indoor: boolean;
  is_active: boolean;
  coming_soon: boolean | null;
  operating_hours: Record<string, string> | null;
  inherit_venue_hours: boolean | null;
  sports: { name: string; slug: string } | null;
  venues: {
    id: number;
    name: string;
    address: string | null;
    is_active: boolean;
    operating_hours: Record<string, string> | null;
  } | null;
};

export type FavoriteRow = {
  court_id: number;
  created_at: string;
  courts: FavoriteCourt | null;
};

const FAVORITE_SELECT =
  "court_id, created_at, " +
  "courts(id, name, hourly_rate, rate_rules, images, map_emoji, is_indoor, is_active, coming_soon, " +
  "operating_hours, inherit_venue_hours, sports(name, slug), venues(id, name, address, is_active, operating_hours))";

export const favoriteIdsKey = (userId: string | undefined) => ["court-favorite-ids", userId];
export const favoriteCourtsKey = (userId: string | undefined) => ["court-favorites", userId];

/** Which courts this player has favorited. A `Set` because every tile on a page
 *  asks the same question about itself. */
export function useFavoriteCourtIds(userId: string | undefined) {
  return useQuery({
    queryKey: favoriteIdsKey(userId),
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("court_favorites")
        .select("court_id")
        .eq("user_id", userId!);
      if (error) throw error;
      return new Set<number>((data ?? []).map((r) => r.court_id));
    },
  });
}

/** The favorites list itself, newest first — the order a player added them is the
 *  only order they have any memory of. */
export function useFavoriteCourts(userId: string | undefined) {
  return useQuery({
    queryKey: favoriteCourtsKey(userId),
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("court_favorites")
        .select(FAVORITE_SELECT)
        .eq("user_id", userId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      /* A favorited court that was deleted comes back with a null join. Dropping it
         here keeps every consumer from having to re-check. */
      return ((data ?? []) as unknown as FavoriteRow[]).filter((r) => !!r.courts);
    },
  });
}

/** Add or remove one favorite. `favorite` is the state being moved *to*, so the
 *  caller passes what it wants rather than what it currently has. */
export function useFavoriteToggle(userId: string | undefined) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ courtId, favorite }: { courtId: number; favorite: boolean }) => {
      if (!userId) throw new Error("Sign in to save favorites.");
      if (favorite) {
        /* Upsert, not insert: the primary key is (user_id, court_id), so a double
           tap — or a second tab — would otherwise fail on a duplicate row. */
        const { error } = await supabase
          .from("court_favorites")
          .upsert({ user_id: userId, court_id: courtId }, { onConflict: "user_id,court_id" });
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("court_favorites")
          .delete()
          .eq("user_id", userId)
          .eq("court_id", courtId);
        if (error) throw error;
      }
    },

    onMutate: async ({ courtId, favorite }) => {
      const key = favoriteIdsKey(userId);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<Set<number>>(key);
      if (previous) {
        const next = new Set(previous);
        if (favorite) next.add(courtId);
        else next.delete(courtId);
        qc.setQueryData(key, next);
      }
      return { previous };
    },

    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(favoriteIdsKey(userId), ctx.previous);
    },

    onSettled: () => {
      qc.invalidateQueries({ queryKey: favoriteIdsKey(userId) });
      qc.invalidateQueries({ queryKey: favoriteCourtsKey(userId) });
    },
  });
}
