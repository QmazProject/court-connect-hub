# Google sign-in / sign-up integration

How "Continue with Google" was added to the auth sheet in `src/routes/index.tsx`, and the
Supabase/Google configuration it depends on that lives outside this repo. Supabase's own
Google provider is used — there is no custom OAuth client code here, and the app never
touches your Google Client Secret.

## Why this shape

For a **hosted** Supabase project, Google OAuth is a two-party handoff:

1. The browser calls `supabase.auth.signInWithOAuth({ provider: "google" })`, which sends
   the browser to Google, then to Supabase's own callback endpoint, then back to the app with
   a session already established.
2. Supabase's backend — not this app — exchanges the code with Google using the Client
   ID/Secret you enter in the **Supabase Dashboard**. The frontend never sees the secret and
   doesn't need to.

That redirect is the reason the implementation looks the way it does: the page fully
unloads and reloads on the way back, so nothing held in React state survives the round
trip. Anything that needs to survive it — specifically, which role the person picked before
leaving — has to go somewhere that outlives the page, which is `sessionStorage` here.

## What's wired up in the app

### The button, twice, in two different roles

| Location | Step | Role source | What it does |
| --- | --- | --- | --- |
| Below the **Create account** button | `authSheetStep === "signup"` | Whatever was already picked on the role step (`signupRole`) | Signup — role travels with it |
| Top of the form, above the divider | `authSheetStep === "signin"` | None (`null`) | Sign-in — no role is implied |

Both call the same handler, `handleGoogleAuth(role)`, defined next to `submitAuth`:

```ts
const handleGoogleAuth = async (role: "player" | "tenant" | null) => {
  setSignInError(null);
  if (role) {
    sessionStorage.setItem(GOOGLE_PENDING_ROLE_KEY, role);
  } else {
    sessionStorage.removeItem(GOOGLE_PENDING_ROLE_KEY);
  }
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
  if (error) {
    sessionStorage.removeItem(GOOGLE_PENDING_ROLE_KEY);
    setSignInError(error.message);
  }
};
```

`GOOGLE_PENDING_ROLE_KEY` (`"courthub_google_pending_role"`) is the `sessionStorage` key that
carries the role across the redirect. It's only ever set from the signup button — the sign-in
button always clears it, so a stale value from an earlier attempt can never leak into a plain
sign-in.

The role step itself (`authSheetStep === "role"`) is untouched — it's still the only way to
reach the signup form, and its **Continue** button is still `disabled={!signupRole}`. Google
was deliberately *not* offered as a shortcut off that screen; reaching the Google button
requires having already picked a role and pressed Continue, same as reaching the
email/password form does.

### Coming back — `hydrateAccount`

The existing account-hydration effect (the one that already ran on every mount and on every
`supabase.auth.onAuthStateChange` event, for ordinary email/password sessions too) is where
the post-redirect logic lives. Right after it gets a `user`:

```ts
const pendingRole = sessionStorage.getItem(GOOGLE_PENDING_ROLE_KEY);
if ((pendingRole === "player" || pendingRole === "tenant") && hasGoogleProvider(user)) {
  sessionStorage.removeItem(GOOGLE_PENDING_ROLE_KEY);
  await supabase.from("profiles").update({ role: pendingRole }).eq("id", user.id);
  await supabase.auth.updateUser({ data: { role: pendingRole } });
} else if (isFreshGoogleAccount(user)) {
  await supabase.auth.signOut();
  // ...show the "no account" message, stop here
}
```

Two module-level helpers do the recognition work (defined near `GoogleGlyph`, top of the
file):

- **`hasGoogleProvider(user)`** — true if `google` is among `user.app_metadata.providers`.
  Gates the pending-role apply: the stashed role is only ever written to an account that was
  actually just authenticated via Google. See "Edge case closed" below for why that guard
  exists.
- **`isFreshGoogleAccount(user)`** — true only for a Google account whose `created_at` and
  `last_sign_in_at` land within 10 seconds of each other, i.e. this sign-in *is* the moment
  the account was created. A returning Google user's `last_sign_in_at` is long past their
  `created_at`, so this is false for them.

### Why role has to be corrected after the fact, not set at creation

Supabase's own `handle_new_user()` trigger (`supabase/migrations/20260721013823_...sql`)
fires the instant `auth.users` gets a new row — before any of this app's JS runs — and reads
`role` out of `raw_user_meta_data`. Google's OAuth payload only ever carries name/email/
avatar, never a custom `role` field, so **every brand-new Google account is born
`role = 'player'`** at the database level, regardless of what was picked on the role step.
The `profiles.update({ role: pendingRole })` call above corrects it a moment later, before
the person is routed anywhere — so nobody ever sees the wrong role — but the row briefly
exists as `player` first. This is invisible in normal use; it matters only if you're reading
the database mid-request.

### The "you don't have an account" case

Clicking **Continue with Google** from Sign in (not Sign up) never carries a role. If
`isFreshGoogleAccount(user)` is also true — meaning Google just handed back a session for an
account that provably didn't exist a moment ago — the app:

1. Calls `supabase.auth.signOut()` immediately.
2. Sets `authSheetStep` back to `"signin"` and opens the sheet.
3. Shows the existing error banner (`signInError`, the same one email/password errors use)
   with: *"We couldn't find a CourtHub account for that Google account. Please create one
   first."*

The Google-side account (`auth.users` + a `profiles` row, defaulted to `player`) still gets
created — that's unavoidable, it happens before this app's code runs — but the session for
it is discarded and the person is told to sign up. If they come back later and go through the
role step → Continue with Google properly, Supabase matches the *same* underlying account by
Google identity rather than creating a duplicate, and the role-apply branch above sets its
role correctly at that point.

A hover-only tooltip was added to the sign-in button for the same reason, warning up front
rather than after the fact:

> Use the same Google account you signed up with — a different one won't be able to continue.

### Edge case closed: abandoned redirects

`hydrateAccount` runs on *every* auth state change, not just ones that follow a Google
redirect — so a `sessionStorage` key set right before leaving for Google, then never cleared
because the person backed out of the Google consent screen, would still be sitting there the
next time *any* sign-in completes in that tab. Without a guard, someone who started "Continue
with Google" as tenant, gave up, and signed up normally by email as player would have their
brand-new player account silently flipped to tenant. The `hasGoogleProvider(user)` check on
the apply branch closes this: the stashed role is only ever written to a user whose current
session actually came from Google.

## What Supabase/Google need — not done here

This app's code is complete and will not need further changes for this feature. Everything
below happens in the Supabase Dashboard and Google Cloud Console, outside this repo. It
could not be done as part of this change: the sandbox this was built in has no outbound
network access, so it can't reach either console on your behalf.

### 1. Google Cloud Console — OAuth client

In the Google Cloud project that holds your Client ID/Secret, under **APIs & Services → 
Credentials → OAuth 2.0 Client IDs** (application type **Web application**), add this exact
redirect URI:

```
https://eamyzqenkqxclyaihdoh.supabase.co/auth/v1/callback
```

That's Supabase's callback, not this app's — the whole point of the redirect flow is that
Google only ever talks to Supabase directly. Nothing app-specific needs to be registered
here.

### 2. Supabase Dashboard — enable the provider

**Authentication → Sign In / Providers → Google**: paste the **Client ID** and **Client
Secret**, toggle it on, save. This is the only place the Client Secret is ever entered — it
does not belong in `.env`, and this app's code never reads it.

### 3. Supabase Dashboard — allow this app's URL

**Authentication → URL Configuration**: the app calls `signInWithOAuth` with
`redirectTo: window.location.origin`, and Supabase refuses to redirect back to an origin
that isn't on its allow-list. Add every origin this app is actually served from — at least:

- Your local dev URL (e.g. `http://localhost:8080`, whatever port `npm run dev` actually
  binds — check the terminal output, `vite.config.ts` doesn't pin one)
- Your deployed origin. This project is built with `@lovable.dev/vite-tanstack-config`
  (see `vite.config.ts`), so that's most likely a Lovable-issued `*.lovable.app` domain or a
  custom domain connected through Lovable's project settings — check there for the exact
  value rather than guessing it.

Missing this step is the most common reason "it's configured and still doesn't work" — the
redirect completes on Google and Supabase's side, then fails silently (or with a vague
error) coming back to a URL that isn't allow-listed.

### About the "session key"

Supabase's Google provider form only has two fields — Client ID and Client Secret. There's no
third "session key" field anywhere in that flow. If you're thinking of something specific
(not just another name for the Client Secret), say what it's for and where you saw it, and
this doc — and the implementation, if it turns out something's missing — can be updated.

## Behaviour reference

| Entry point | Account state | Result |
| --- | --- | --- |
| Role step → Continue → signup form → **Continue with Google** | New Google account | Created with the role picked on the role step; routed to `/dashboard` (tenant) or `/explore` (player) |
| Role step → Continue → signup form → **Continue with Google** | Google account already exists (e.g. previously created via this same flow, or via Sign in earlier) | Signed in as that existing account; the role picked *this time* is applied, overwriting whatever it was |
| Sign in → **Continue with Google** | Account already exists for that Google identity | Ordinary sign-in — routed by the role already on file, same as email/password |
| Sign in → **Continue with Google** | No CourtHub account for that Google identity | Signed back out immediately; sign-in sheet shows *"We couldn't find a CourtHub account for that Google account. Please create one first."* |

## How to test once configured

1. `npm run dev`, open the site, click **Sign in**.
2. Hover **Continue with Google** on the sign-in step — confirm the warning tooltip appears.
3. Click it with a Google account that has never touched this app. Expect to be bounced back
   with the "couldn't find a CourtHub account" message, signed out.
4. Click **Create an account** → pick **I manage a venue** → **Continue** → **Continue with
   Google** (below Create account) using the *same* Google account from step 3. Expect to
   land on `/dashboard`.
5. Sign out, click **Sign in → Continue with Google** again with that same account. Expect to
   land back on `/dashboard` directly, no message.
6. Check the `profiles` row for that user in the Supabase table editor — `role` should read
   `tenant`, not the `player` it was born with.

## Known limitations

- **The "no account" case still creates a row.** Supabase creates `auth.users` +
  `profiles` server-side as part of completing the OAuth exchange; the app finds out only
  after the fact and can sign the session back out, not prevent the row. It's inert until
  reused by a real signup with the same Google identity — see "The 'you don't have an
  account' case" above.
- **`isFreshGoogleAccount`'s 10-second window** is a heuristic, not a guarantee. Supabase
  doesn't expose an explicit "this was just created" flag on the client, so this is the
  closest available signal. In practice the gap between account creation and the client
  reading it back is milliseconds, not seconds, so this has wide margin.
- **The role handoff assumes the same browser tab returns.** `sessionStorage` doesn't survive
  the redirect if Google/Supabase ever opens the flow in a new tab/window instead of
  navigating the current one (not the default behavior of `signInWithOAuth`, but worth
  knowing if that ever changes).
