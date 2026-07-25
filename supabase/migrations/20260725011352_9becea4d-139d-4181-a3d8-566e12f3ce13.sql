
ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS amenities text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS food_beverages text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS facility_services text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS fees jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS fees_notes text;
