
ALTER TABLE public.courts
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS amenities text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS images text[] NOT NULL DEFAULT '{}';
