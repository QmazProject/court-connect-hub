ALTER TABLE public.staff DROP CONSTRAINT staff_role_check;
ALTER TABLE public.staff ADD CONSTRAINT staff_role_check
  CHECK (role = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text]));