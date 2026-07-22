
CREATE TABLE public.map_problems (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  category text NOT NULL,
  description text NOT NULL,
  latitude double precision,
  longitude double precision,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT INSERT ON public.map_problems TO anon, authenticated;
GRANT ALL ON public.map_problems TO service_role;

ALTER TABLE public.map_problems ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can submit a map problem"
  ON public.map_problems
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    length(description) > 0
    AND length(description) <= 2000
    AND length(category) > 0
    AND length(category) <= 100
  );
