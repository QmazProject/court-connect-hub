-- ===========================================================================
-- Rollback for 20260910000000_venue_prefix_tenant_uniqueness.sql
--
-- The functions, trigger and indexes it created were new, so their previous
-- state is absence. The one object it *changed* is the prefix CHECK constraint,
-- whose earlier text is proven by 20260909 — `^[A-Za-z]{0,6}$` — and is restored
-- here verbatim rather than reinvented.
--
-- ⚠ THIS CAN REFUSE TO RUN, ON PURPOSE. The migration widened prefixes from six
--   letters to sixteen and then filled them in from venue names, so a prefix
--   like 'LAPULAPU' may now exist. Narrowing the constraint back would reject
--   those rows. Rather than truncate a tenant's data to make the constraint fit,
--   the guard below stops and names the venues. Shorten or clear them by hand,
--   deliberately, then run this again.
--
-- ⚠ ORDER. 20260911 redefines `set_venue_booking_prefix()` and adds the foreign
--   key on `venues.tenant_id`. Roll it back first.
-- ===========================================================================

-- 1. Refuse rather than damage: any prefix too long for the old rule.
DO $$
DECLARE
  _offenders text;
BEGIN
  SELECT string_agg(format('venue %s "%s" (prefix %s)', v.id, v.name, v.booking_no_prefix), '; '
                    ORDER BY v.id)
    INTO _offenders
    FROM public.venues v
   WHERE v.booking_no_prefix !~ '^[A-Za-z]{0,6}$';

  IF _offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot restore the six-letter prefix rule: % still carry a longer prefix. Shorten or clear them first, then re-run: %',
      (SELECT count(*) FROM public.venues v WHERE v.booking_no_prefix !~ '^[A-Za-z]{0,6}$'),
      _offenders
      USING ERRCODE = '23514';
  END IF;
END;
$$;

-- 2. The uniqueness index, the trigger and the two functions this migration added.
DROP INDEX IF EXISTS public.uq_venues_tenant_booking_prefix;

DROP TRIGGER IF EXISTS venues_set_booking_prefix ON public.venues;
DROP FUNCTION IF EXISTS public.set_venue_booking_prefix();
DROP FUNCTION IF EXISTS public.derive_venue_prefix(text);

-- 3. The constraint, back to 20260909's text.
ALTER TABLE public.venues
  DROP CONSTRAINT IF EXISTS venues_booking_no_prefix_letters;
ALTER TABLE public.venues
  ADD CONSTRAINT venues_booking_no_prefix_letters
  CHECK (booking_no_prefix ~ '^[A-Za-z]{0,6}$');

-- 4. The tenant grouping column.
--    ⚠ Dropping this discards the venue-to-workspace link. 20260911's rollback
--      restores the column's *values* from `tenant_id_legacy_user` before this
--      file runs, which is why the ordering note above matters.
DROP INDEX IF EXISTS public.idx_venues_tenant_id;
ALTER TABLE public.venues
  DROP COLUMN IF EXISTS tenant_id;
