/**
 * Telling a Google account that already belongs here from one that Supabase created
 * a second ago.
 *
 * Shared rather than copied, because both sign-in pages need the same answer and a
 * second implementation of it would be a second thing to get wrong. The landing page
 * has behaved this way since Google sign-in existed; the workspace login page now
 * uses the same test rather than a lifecycle of its own.
 */

export type GoogleAccountLike = {
  app_metadata?: { provider?: string; providers?: string[] } | null;
  created_at: string;
  last_sign_in_at?: string | null;
};

export function hasGoogleProvider(user: {
  app_metadata?: { provider?: string; providers?: string[] } | null;
}): boolean {
  const providers =
    user.app_metadata?.providers ??
    (user.app_metadata?.provider ? [user.app_metadata.provider] : []);
  return providers.includes("google");
}

/** How long after creation a first sign-in still counts as the same event. */
const FIRST_SIGN_IN_WINDOW_MS = 10_000;

/** True only for a Google account whose very first sign-in is happening right now —
 *  `created_at` and `last_sign_in_at` within a few seconds of each other.
 *
 *  That is the signature of pressing "Continue with Google" with no CourtHub account
 *  behind it: Supabase creates the account on the spot, because that is how OAuth
 *  works, but nobody has chosen what it is for. A returning user's last sign-in is
 *  long after their creation, so this stays false for them. */
export function isFreshGoogleAccount(user: GoogleAccountLike): boolean {
  if (!hasGoogleProvider(user)) return false;
  const createdAt = new Date(user.created_at).getTime();
  const lastSignIn = user.last_sign_in_at ? new Date(user.last_sign_in_at).getTime() : createdAt;
  return Math.abs(lastSignIn - createdAt) < FIRST_SIGN_IN_WINDOW_MS;
}
