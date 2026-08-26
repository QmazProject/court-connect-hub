-- Court favorites.
--
-- A player marks a court, not a venue: what someone comes back to book is the
-- specific court they liked, and the venue is only how they find it again. The
-- favorites list in the player workspace therefore reads courts and joins the
-- venue for context, rather than the other way round.
--
-- The pair (user_id, court_id) is the primary key, so favoriting twice is a
-- conflict rather than a duplicate row and the client can upsert without first
-- checking. Both foreign keys cascade: a deleted court or a deleted account
-- leaves no orphan favorites behind.
--
-- No UPDATE grant. A favorite has no mutable state — it is inserted or removed,
-- and `created_at` is the only other column, which nobody should be rewriting.

CREATE TABLE IF NOT EXISTS public.court_favorites (
  user_id    uuid   NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  court_id   bigint NOT NULL REFERENCES public.courts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, court_id)
);

-- The list is always read as "this player's favorites, newest first"; the primary
-- key alone orders by court_id, which is arbitrary to a player.
CREATE INDEX IF NOT EXISTS court_favorites_user_idx
  ON public.court_favorites (user_id, created_at DESC);

GRANT SELECT, INSERT, DELETE ON public.court_favorites TO authenticated;
GRANT ALL ON public.court_favorites TO service_role;

ALTER TABLE public.court_favorites ENABLE ROW LEVEL SECURITY;

-- Favorites are private. A player reads and writes only their own rows, and no
-- role reaches another player's list -- there is no venue-side view of who
-- favorited what, so nothing needs to see across users.
CREATE POLICY "Users manage own court favorites"
ON public.court_favorites
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
