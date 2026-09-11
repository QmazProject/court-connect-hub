/** The rules the tenant-specific login page runs on, kept out of the component so
 *  they can be tested without a browser or a session.
 *
 *  None of this is the authority. `membership_matches_slug()` in the database decides
 *  who may enter a workspace; this module decides what the page *says*, and makes the
 *  two failure paths — a refused membership and a broken check — end the same way. */

/** The one sentence every failure produces. Deliberately the same for a wrong
 *  password, an address with no account, a player, a member of another business, an
 *  invitation not yet accepted, a removed member, an unknown slug, and a check that
 *  errored. Telling those apart is exactly what an attacker at this page is trying to
 *  do, and the page has no reason to help. */
export const WORKSPACE_SIGN_IN_FAILED = "These credentials don't work for this workspace.";

/** Where the intended workspace is kept across the Google round trip. sessionStorage,
 *  not localStorage: the intent belongs to this tab and this attempt, and should not
 *  outlive either. Its own key, shared with nothing — the landing page's OAuth keys
 *  drive role claiming, and a value that meant two things would eventually be read as
 *  the wrong one. */
export const TENANT_LOGIN_PENDING_SLUG_KEY = "courthub_tenant_login_pending_slug";

/** A slug as it may appear in a URL. Generated slugs are lowercase words joined by
 *  single hyphens, or the `t-xxxxxxxx` placeholder; this accepts that shape and
 *  refuses anything that is not one, so a malformed path never reaches the database
 *  and never becomes a lookup. */
export function isWellFormedSlug(raw: string | null | undefined): boolean {
  const value = (raw ?? "").trim();
  return value.length > 0 && value.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

/** Slugs compare case-insensitively and ignore padding, matching the `lower(btrim(…))`
 *  the two functions use. Anything not well-formed is not a slug and matches nothing. */
export function slugsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? "").trim().toLowerCase();
  const y = (b ?? "").trim().toLowerCase();
  return x !== "" && x === y;
}

export type OAuthReturn =
  | { kind: "none" } // not an OAuth return; nothing was stashed
  | { kind: "verify"; slug: string } // a return for this page — check membership
  | { kind: "mismatch" }; // stash and URL disagree: fail closed

/** What to do when this page loads with a session that OAuth may have just created.
 *
 *  The stash is the authority, never the URL. Google returns to a URL, and a URL can
 *  be edited between leaving and arriving; the slug written before the redirect cannot.
 *  When the two disagree the answer is neither of them — it is a refusal, because a
 *  disagreement is the shape tampering takes.
 *
 *  Nothing stashed means the visitor simply has a session already and did not come
 *  through this page's OAuth; the page checks them against its own slug in the normal
 *  way rather than treating it as an attempt. */
export function classifyOAuthReturn(
  urlSlug: string,
  stashedSlug: string | null | undefined,
): OAuthReturn {
  if (!stashedSlug) return { kind: "none" };
  if (!slugsMatch(stashedSlug, urlSlug)) return { kind: "mismatch" };
  return { kind: "verify", slug: stashedSlug };
}
