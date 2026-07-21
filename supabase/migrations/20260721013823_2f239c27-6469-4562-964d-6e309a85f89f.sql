
-- Profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player','tenant')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Profiles are viewable by authenticated"
  ON public.profiles FOR SELECT TO authenticated USING (true);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE TO authenticated
  USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = id);

-- Auto-create profile on signup, reading role/full_name/phone from user metadata
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, phone, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    CASE WHEN NEW.raw_user_meta_data->>'role' = 'tenant' THEN 'tenant' ELSE 'player' END
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- updated_at trigger for profiles
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Helper: is current user a tenant?
CREATE OR REPLACE FUNCTION public.is_tenant(_user_id uuid)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = _user_id AND role = 'tenant');
$$;

-- Fix venues insert policy: allow any authenticated tenant to create a venue
DROP POLICY IF EXISTS "Staff can insert venues" ON public.venues;
CREATE POLICY "Tenants can insert venues"
  ON public.venues FOR INSERT TO authenticated
  WITH CHECK (public.is_tenant(auth.uid()));

-- After a venue is created, auto-assign creator as owner in staff
CREATE OR REPLACE FUNCTION public.assign_venue_owner()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.staff (user_id, venue_id, role)
  VALUES (auth.uid(), NEW.id, 'owner')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS venues_assign_owner ON public.venues;
CREATE TRIGGER venues_assign_owner
  AFTER INSERT ON public.venues
  FOR EACH ROW EXECUTE FUNCTION public.assign_venue_owner();

-- Seed sports (idempotent)
INSERT INTO public.sports (name, slug) VALUES
  ('Tennis','tennis'),
  ('Basketball','basketball'),
  ('Football','football'),
  ('Badminton','badminton'),
  ('Pickleball','pickleball'),
  ('Squash','squash'),
  ('Volleyball','volleyball')
ON CONFLICT DO NOTHING;
