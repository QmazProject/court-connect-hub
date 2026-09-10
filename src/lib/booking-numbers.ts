/** The single definition of a tenant's own booking number, shared by the setting
 *  that configures it and every pane that prints one. It lives here rather than
 *  being restated at each call site for the same reason `booking-counts` does:
 *  two readings of what "BN1" means is the bug this module exists to prevent. */

/** How many letters a prefix may carry. Sixteen, because the default is derived
 *  from the venue's own name rather than typed — "LABANGONKALTEX" has to fit, and
 *  six only ever held initials like "BN". Mirrored by the CHECK constraint in
 *  20260910000000; widening it can only accept prefixes a tenant could not save
 *  before, so nothing already stored stops being valid. */
export const BOOKING_PREFIX_MAX = 16;

/** A prefix is letters only — the number is the system's half of the string.
 *
 *  Digits are rejected on purpose. A tenant who types `BN01` is describing the
 *  *first* booking, not a prefix, and if that were accepted their second booking
 *  would read `BN012`: the padding they intended as part of the counter would
 *  turn into part of the label. Refusing digits is what keeps the count plain —
 *  1, 2, 3 … 10, 11, 12 — instead of `01`, `02`, which is what a tenant is
 *  reaching for when they write `01` and is not what they would get. */
const PREFIX_PATTERN = /^[A-Za-z]*$/;

export type PrefixCheck = { ok: true } | { ok: false; reason: string };

/** Whether a tenant's typed prefix can be stored, and if not, the sentence to put
 *  in front of them. The message names what they typed rather than restating the
 *  rule in the abstract, because "letters only" does not tell someone who wrote
 *  `BN01` which half of it was wrong. */
export function checkBookingPrefix(raw: string): PrefixCheck {
  const value = raw.trim();
  /* Empty is allowed and means "no prefix": the number stands on its own as
     1, 2, 3. A tenant who wants nothing in front should not have to invent
     something to satisfy a form. */
  if (value === "") return { ok: true };
  if (/\d/.test(value)) {
    return {
      ok: false,
      reason:
        "Leave the number out — it is added for you, starting at 1. Enter just the letters, like BN or INV.",
    };
  }
  if (!PREFIX_PATTERN.test(value)) {
    return { ok: false, reason: "Letters only — no spaces, punctuation or symbols." };
  }
  if (value.length > BOOKING_PREFIX_MAX) {
    return { ok: false, reason: `Keep it to ${BOOKING_PREFIX_MAX} letters or fewer.` };
  }
  return { ok: true };
}

/** Stored form of a prefix: trimmed and upper-cased, so `bn`, `Bn` and `BN` are
 *  one setting rather than three, and the column cannot show `bn1` under a
 *  heading the tenant configured as `BN`. */
export function normaliseBookingPrefix(raw: string): string {
  return raw.trim().toUpperCase();
}

/** The number as a tenant reads it: the prefix, then the count with no padding
 *  and no separator — `BN1`, `BN12`, `BN130`, or `1` when no prefix is set.
 *
 *  `null` is returned rather than a placeholder string so the caller decides how
 *  an unnumbered booking should look; a booking predating the column, or one
 *  whose court has no venue, genuinely has no number and inventing "BN0" for it
 *  would put a number on screen that matches nothing in the database. */
export function formatBookingNo(
  prefix: string | null | undefined,
  no: number | null | undefined,
): string | null {
  if (no == null || !Number.isFinite(no)) return null;
  /* Guards a backfill gap rather than an expected value: the sequence starts at
     1, so anything below it was never assigned by the trigger. */
  if (no < 1) return null;
  return `${normaliseBookingPrefix(prefix ?? "")}${Math.trunc(no)}`;
}
