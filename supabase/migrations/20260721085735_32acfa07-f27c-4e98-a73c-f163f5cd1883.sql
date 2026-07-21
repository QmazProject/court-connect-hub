ALTER TABLE public.venues 
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS images text[] NOT NULL DEFAULT '{}';