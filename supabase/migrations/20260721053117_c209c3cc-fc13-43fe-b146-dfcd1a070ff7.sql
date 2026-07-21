
ALTER TABLE public.courts ADD COLUMN IF NOT EXISTS blocked_hours jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.courts ALTER COLUMN operating_hours SET DEFAULT '{"mon":"00:00-24:00","tue":"00:00-24:00","wed":"00:00-24:00","thu":"00:00-24:00","fri":"00:00-24:00","sat":"00:00-24:00","sun":"00:00-24:00"}'::jsonb;

UPDATE public.courts
SET operating_hours = '{"mon":"00:00-24:00","tue":"00:00-24:00","wed":"00:00-24:00","thu":"00:00-24:00","fri":"00:00-24:00","sat":"00:00-24:00","sun":"00:00-24:00"}'::jsonb;
