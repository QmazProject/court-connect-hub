/** The rule for a business name, shared by the prompt that asks for it and the tests
 *  that pin it down. It is deliberately loose: a trading name is whatever the business
 *  calls itself, and the only things refused are the ones that cannot be a name at all.
 *  The slug the workspace is addressed by is derived in the database from whatever is
 *  saved here, so nothing about URL-safety is the tenant's problem. */

/** Long enough for "Cebu City Sports and Recreation Complex Inc." with room to spare,
 *  short enough that the column it lands in never has to wrap it. */
export const BUSINESS_NAME_MAX = 80;

export type BusinessNameCheck = { ok: true; value: string } | { ok: false; reason: string };

/** Trims, collapses runs of whitespace, and refuses what cannot be a name. The
 *  normalised value is returned so the caller stores exactly what was checked. */
export function checkBusinessName(raw: string): BusinessNameCheck {
  const value = raw.replace(/\s+/g, " ").trim();
  if (value === "") return { ok: false, reason: "Enter the name of your business." };
  if (value.length > BUSINESS_NAME_MAX) {
    return { ok: false, reason: `Keep it to ${BUSINESS_NAME_MAX} characters or fewer.` };
  }
  /* A name made only of punctuation or digits has nothing for the slug to be built
     from and is not what anyone means by "business name". One letter is enough. */
  if (!/\p{L}/u.test(value)) {
    return { ok: false, reason: "The name needs at least one letter." };
  }
  return { ok: true, value };
}

/** The comparison form the database enforces uniqueness on — `normalize_tenant_name()`
 *  in SQL, transcribed here so a test can pin the two to each other. Whitespace runs
 *  collapse, the ends are trimmed, case is folded. The stored name is never this; only
 *  the question "is this the same business?" is. */
export function normalizeBusinessNameForComparison(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toLowerCase();
}

/** What an admin is told when the name they chose already belongs to another tenant.
 *  One sentence, and never the database's own wording. */
export const DUPLICATE_BUSINESS_NAME_MESSAGE =
  "This business name is already in use. Please choose another name.";

/** Whether a failed save was the uniqueness rule refusing a duplicate. Matched on the
 *  SQLSTATE first and the index name second, so a change to the driver's message text
 *  cannot turn a clear refusal into a raw error on screen. */
export function isDuplicateBusinessNameError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown; details?: unknown };
  if (e.code === "23505") return true;
  const text = `${String(e.message ?? "")} ${String(e.details ?? "")}`;
  return text.includes("uq_tenants_name_normalized");
}

/** What a member is told when the database refuses to let them create a venue. The
 *  policy asks for an active admin of the workspace the venue would go into, and
 *  that is the whole sentence; the driver's "row-level security" wording is not. */
export const VENUE_CREATION_REFUSED_MESSAGE = "Only an admin of this workspace can create a venue.";

/** Whether a failed venue insert was the row-level policy refusing it. SQLSTATE 42501
 *  is insufficient_privilege, which is what Postgres raises for a WITH CHECK
 *  violation; the message match is the fallback for a driver that drops the code. */
export function isVenueCreationRefused(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === "42501") return true;
  return /row-level security/i.test(String(e.message ?? ""));
}
