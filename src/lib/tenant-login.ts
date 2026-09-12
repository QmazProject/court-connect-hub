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

/** The path a workspace's own sign-in page lives at. One definition, so the route,
 *  the OAuth `redirectTo` and the link an admin shares cannot drift apart. */
export function tenantLoginPath(slug: string): string {
  return `/tenant/${slug}/login`;
}

/** The absolute link an admin gives their team.
 *
 *  Built from the origin the app is actually being served from, so a preview
 *  deployment, a custom domain and a laptop each produce their own correct link with
 *  nothing hard-coded. The slug is the one the database returned for this admin's own
 *  tenant — never derived from the business name, which would guess at a slug that is
 *  frozen and may no longer match it.
 *
 *  Null when there is no slug yet rather than a half-built URL: a link to
 *  `/tenant//login` looks real and goes nowhere. */
export function tenantLoginUrl(origin: string, slug: string | null | undefined): string | null {
  const value = (slug ?? "").trim();
  if (!isWellFormedSlug(value)) return null;
  const base = origin.replace(/\/+$/, "");
  if (!base) return null;
  return `${base}${tenantLoginPath(value)}`;
}

/** What a tenant-side account's own membership says about where it may go after
 *  signing in on the *general* CourtHub page. */
export type MembershipStatusLike = "invited" | "active" | "inactive" | null | undefined;

export type GeneralSignInRoute =
  /** Not a tenant account. The player experience, untouched. */
  | { kind: "player" }
  /** A tenant account with no membership yet: a founder whose workspace has not been
   *  created. Must pass through to the dashboard, because that is where
   *  `ensure_tenant_workspace()` runs. Blocking here would strand every new signup. */
  | { kind: "bootstrap" }
  /** An invitation not yet accepted, or a membership that was removed. The dashboard
   *  again — it is the only place the acceptance panel lives, and a removed member
   *  has nothing to be redirected to. */
  | { kind: "accept" }
  /** An active member of a workspace. Their business has its own sign-in page, and
   *  this is the one case the general page turns away. */
  | { kind: "workspace" };

/** Where a successful sign-in on the general page should lead.
 *
 *  Only an *active* membership is turned away. Everything else passes through, and
 *  that is deliberate rather than lenient: a founder mid-bootstrap has no membership
 *  to redirect to, and an invited member sent to their workspace page would be refused
 *  there by the active-only rule and left unable to accept anything.
 *
 *  The status comes from the member's own `tenant_members` row, read after
 *  authentication. Nothing here is derived from an email domain, a guess at a slug,
 *  user metadata or anything the browser kept. */
export function routeAfterGeneralSignIn(
  isTenantAccount: boolean,
  membershipStatus: MembershipStatusLike,
): GeneralSignInRoute {
  if (!isTenantAccount) return { kind: "player" };
  if (membershipStatus === "active") return { kind: "workspace" };
  if (membershipStatus === "invited" || membershipStatus === "inactive") return { kind: "accept" };
  return { kind: "bootstrap" };
}

/** The sentence the general page shows an active member. Names the business, because
 *  they have just proved they belong to it, and says nothing else about the account. */
export const WORKSPACE_ELSEWHERE_MESSAGE =
  "Your account belongs to a business workspace. Please use your workspace sign-in page.";

/** Shown once an invitation has been accepted, so the member learns where to sign in
 *  from then on rather than discovering it by being turned away. */
export const WORKSPACE_ACTIVATED_MESSAGE =
  "Your workspace access is active. Use this sign-in page next time:";

/** Just enough of the caller's own workspace to route and to name. */
export type MyWorkspace = {
  status: Exclude<MembershipStatusLike, null | undefined>;
  slug: string;
  name: string | null;
};

/** The three calls this module makes against Supabase, and nothing more. */
export type WorkspaceReader = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => { maybeSingle: () => PromiseLike<{ data: unknown }> };
    };
  };
};

/** The caller's membership and workspace, read after they have authenticated.
 *
 *  One implementation, shared by the general sign-in page and the password-reset
 *  page, so the two cannot disagree about where someone belongs. Both reads are
 *  row-level-security scoped to the caller: the membership row is theirs, and
 *  `tenants` admits only `id = current_tenant_id()`. No tenant id is supplied by the
 *  caller and none is guessed — a member of another business gets nothing from this.
 *
 *  Null when there is no membership at all, which is a founder before bootstrap and
 *  every player. A read that fails is also null: the callers treat "unknown" as
 *  "carry on as before" rather than as a reason to turn someone away, because
 *  turning people away on a failed query is how an outage becomes a lockout. */
export async function resolveMyWorkspace(
  /* Structural, and deliberately minimal: the Supabase query builder is a PromiseLike
     rather than a Promise, and typing it any more tightly than the three calls actually
     used drags the whole generated Database type through inference here. */
  client: WorkspaceReader,
  userId: string,
): Promise<MyWorkspace | null> {
  const { data: membership } = await client
    .from("tenant_members")
    .select("tenant_id, status")
    .eq("user_id", userId)
    .maybeSingle();
  const m = membership as { tenant_id?: string; status?: string } | null;
  if (!m?.tenant_id || !m.status) return null;

  const { data: tenant } = await client
    .from("tenants")
    .select("slug, name")
    .eq("id", m.tenant_id)
    .maybeSingle();
  const t = tenant as { slug?: string; name?: string | null } | null;
  if (!t?.slug) return null;

  return {
    status: m.status as MyWorkspace["status"],
    slug: t.slug,
    name: t.name ?? null,
  };
}

/** Where the workspace screen belongs, given who is looking at it and where they are.
 *
 *  `stay` is the common answer. The two corrections exist so that an active member's
 *  address always names their own business, and so that nobody sits at a workspace
 *  address they have no active membership in. */
export type WorkspaceAddress =
  | { kind: "stay" }
  /** Go to CourtHub's own address: where an invitation is accepted and where a new
   *  founder's workspace is created. */
  | { kind: "generic" }
  /** Go to this business's own address. */
  | { kind: "workspace"; slug: string };

/** The rule behind both dashboard routes.
 *
 *  Only an active membership moves anyone. A player has no membership, a founder has
 *  none yet and needs the generic address for their workspace to be created at all, an
 *  invitation not yet accepted is not a workspace to be sent to, and a removed member
 *  has nothing to be sent to either.
 *
 *  `membershipKnown` is load-bearing: acting before the membership has been read would
 *  bounce a founder away from the one page that bootstraps them. */
export function workspaceAddressFor(args: {
  membershipKnown: boolean;
  status: MembershipStatusLike;
  /** The slug on the caller's own membership, from the database. */
  mySlug: string | null | undefined;
  /** The slug in the address bar, or undefined at the generic address. */
  addressSlug: string | undefined;
}): WorkspaceAddress {
  const { membershipKnown, status, mySlug, addressSlug } = args;
  if (!membershipKnown) return { kind: "stay" };

  if (status !== "active" || !mySlug) {
    /* No active membership. Fine at the generic address; not at a workspace's. */
    return addressSlug === undefined ? { kind: "stay" } : { kind: "generic" };
  }
  if (addressSlug !== undefined && slugsMatch(addressSlug, mySlug)) return { kind: "stay" };
  return { kind: "workspace", slug: mySlug };
}
