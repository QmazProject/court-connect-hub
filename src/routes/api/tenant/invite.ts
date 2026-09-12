import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { deliverEmail } from "@/lib/notification-email.server";
import { tenantLoginUrl } from "@/lib/tenant-login";
import { INVITE_RATE_LIMIT_PER_HOUR, MEMBER_ROLES, type MemberRole } from "@/lib/team";
import type { Database } from "@/integrations/supabase/types";

/**
 * Adding a member to a tenant.
 *
 * On the server because creating an account needs the service role, and because the
 * two decisions here must not be reachable from a browser: whether an email may be
 * invited at all, and how many invitations one admin may send in an hour.
 *
 * What it deliberately cannot do is grant access. It creates an account and a
 * membership marked `invited`; only `tenant_accept_invitation()` — which takes no
 * arguments and reads `auth.uid()` — can make that membership active. A successful
 * call here gives the invited person a way in and nothing more.
 *
 * `profiles.role` is never written on an account that already exists and
 * `claim_initial_role` is never called: a tenant-side account is *created* with its
 * role, and a player account is refused rather than converted.
 */

type InviteBody = { email?: unknown; fullName?: unknown; role?: unknown };

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* One sentence for both refusals. Which it was — a player account, or an account
   already with another business — is not the admin's business, and saying would turn
   this endpoint into a way to inspect other people's accounts. */
const ALREADY_REGISTERED =
  "That email is already registered — use a different one for this member.";

/** A Supabase client that acts *as the caller*, built from their own access token.
 *  The eligibility rule and its admin check then run under `auth.uid()` in SQL, so
 *  the gate is the database's rather than this file's. */
function callerClient(token: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return createClient<Database>(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** The three steps, in the order they actually happen.
 *
 *  Spelled out because each one is otherwise discovered by hitting it: the password
 *  link confirms the address but accepts nothing, the invitation is accepted on the
 *  dashboard, and only an accepted member is admitted to the workspace sign-in page.
 *  `workspaceUrl` is omitted when the business has no usable address yet, rather than
 *  printing a link that would turn them away. */
function inviteEmail(
  business: string,
  inviter: string,
  email: string,
  link: string,
  workspaceUrl: string | null,
) {
  return {
    type: "tenant_invite",
    title: `You have been invited to ${business} on CourtHub`,
    body:
      `${inviter} has invited you to join ${business} on CourtHub.\n\n` +
      `1. Set your password:\n${link}\n\n` +
      `2. Sign in and accept the invitation. Accepting is what joins you to ` +
      `${business} — this email on its own gives you no access, and nothing is ` +
      `shared with the business until you accept.\n\n` +
      (workspaceUrl ? `3. From then on, sign in to ${business} here:\n${workspaceUrl}\n\n` : "") +
      /* Said here because it is otherwise only discoverable by failing: signing in
         with a different Google address creates a separate account, which has no
         invitation waiting and cannot be given this one. */
      `Sign in as ${email} — if you use Continue with Google, choose that same address.\n\n` +
      `If you were not expecting this, you can ignore this email.`,
    link,
  };
}

export const Route = createFileRoute("/api/tenant/invite")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const header = request.headers.get("authorization") ?? "";
        const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
        if (!token) return json({ error: "Sign in first." }, 401);

        const { data: caller, error: callerError } = await supabaseAdmin.auth.getUser(token);
        if (callerError || !caller.user) return json({ error: "Sign in first." }, 401);
        const actorId = caller.user.id;

        let body: InviteBody;
        try {
          body = (await request.json()) as InviteBody;
        } catch {
          return json({ error: "Bad request." }, 400);
        }
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
        const role: MemberRole = MEMBER_ROLES.includes(body.role as MemberRole)
          ? (body.role as MemberRole)
          : "staff";
        if (!email.includes("@")) return json({ error: "Enter a valid email address." }, 400);
        if (!fullName) return json({ error: "Enter the member's name." }, 400);

        /* The caller's own membership, read with the service role. Their tenant comes
           from here and never from the request body, so an admin of one business
           cannot add someone to another by editing what they send. */
        const { data: membership } = await supabaseAdmin
          .from("tenant_members")
          .select("tenant_id, role, status")
          .eq("user_id", actorId)
          .maybeSingle();
        if (!membership || membership.role !== "admin" || membership.status !== "active") {
          return json({ error: "Only an admin can add members." }, 403);
        }
        const tenantId = membership.tenant_id;

        const record = (outcome: string) =>
          supabaseAdmin
            .from("tenant_invite_attempts")
            .insert({ tenant_id: tenantId, actor_id: actorId, email, outcome });

        /* Counted before anything is created, so a refused attempt costs a slot too —
           walking a list of addresses to see which are registered is made entirely of
           refusals, and would be free if only successes counted. */
        const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { count } = await supabaseAdmin
          .from("tenant_invite_attempts")
          .select("id", { count: "exact", head: true })
          .eq("actor_id", actorId)
          .gte("created_at", since);
        if ((count ?? 0) >= INVITE_RATE_LIMIT_PER_HOUR) {
          await record("rate_limited");
          return json(
            {
              error: `That is ${INVITE_RATE_LIMIT_PER_HOUR} invitations this hour. Try again later.`,
            },
            429,
          );
        }

        const asCaller = callerClient(token);
        if (!asCaller) return json({ error: "Server is not configured for invitations." }, 500);

        /* The rule itself lives in SQL, under the caller's own identity, so the admin
           gate is enforced by the database rather than by this file agreeing to. */
        const { data: verdicts, error: verdictError } = await asCaller.rpc(
          "tenant_member_eligibility",
          { _email: email },
        );
        if (verdictError) {
          await record("eligibility_failed");
          return json({ error: "Only an admin can add members." }, 403);
        }
        const verdict = Array.isArray(verdicts) ? verdicts[0] : verdicts;
        /* `resend` is the same person, already invited to this same business, who
           never received the first email. Sending it again is the point; it is not a
           second invitation and creates no second membership row. */
        const resending = verdict?.outcome === "resend";
        if (!verdict || (verdict.outcome !== "invitable" && !resending)) {
          await record(verdict?.outcome ?? "unknown");
          return json({ error: ALREADY_REGISTERED }, 409);
        }

        /* Created with its role, never promoted into one. An existing tenant-side
           account that belongs to nobody is reused exactly as it is. */
        let invitedId = verdict.user_id;
        if (!invitedId) {
          const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
            email,
            email_confirm: false,
            user_metadata: { full_name: fullName, role: "tenant" },
          });
          if (createError || !created.user) {
            await record("create_failed");
            return json({ error: "Could not create that account. Try again." }, 500);
          }
          invitedId = created.user.id;
        }

        /* Placed in SQL rather than inserted from here, because there may already be
           a row: a removed member keeps theirs, and one account may hold only one.
           The function decides between a new row, reinstating a removed one and
           re-arming an outstanding one, and it re-checks every rule under the
           caller's own identity rather than trusting the id this file passes it. */
        const { data: placement, error: memberError } = await asCaller.rpc(
          "tenant_place_invitation",
          { _user_id: invitedId, _role: role },
        );
        if (memberError) {
          /* An active membership, or one held by another business — the function
             refuses both. Answered the same way as any other already-registered
             address, so the refusal still says nothing about the account. */
          await record("member_failed");
          return json({ error: ALREADY_REGISTERED }, 409);
        }

        /* The recovery link `/reset-password` already understands, so an invited member
           sets their password through a flow that exists and is tested rather than a
           second one built for this. Following it is also what confirms their email,
           which `tenant_accept_invitation()` insists on before activating anything. */
        const origin = new URL(request.url).origin;
        const { data: linkData } = await supabaseAdmin.auth.admin.generateLink({
          type: "recovery",
          email,
          options: { redirectTo: `${origin}/reset-password` },
        });

        const [{ data: tenant }, { data: inviter }] = await Promise.all([
          supabaseAdmin.from("tenants").select("name, slug").eq("id", tenantId).maybeSingle(),
          supabaseAdmin.from("profiles").select("full_name").eq("id", actorId).maybeSingle(),
        ]);

        /* The outcome is read, not discarded. `deliverEmail` reports `skipped` with no
           RESEND_API_KEY and `failed` when the provider refuses — most often because
           NOTIFICATION_FROM_EMAIL is unset, which leaves the shared sandbox sender that
           delivers only to the Resend account's own address. Swallowing that told an
           admin the invitation was sent when nothing had left the building. */
        const delivery = await deliverEmail(
          email,
          inviteEmail(
            tenant?.name?.trim() || "your CourtHub workspace",
            inviter?.full_name?.trim() || "An admin",
            email,
            linkData?.properties?.action_link ?? `${origin}/reset-password`,
            /* The business's own slug, read here from the tenant row rather than
               built from its name. Null when it is not a usable address, which
               simply drops step 3 from the email. */
            tenantLoginUrl(origin, tenant?.slug),
          ),
          origin,
        );

        /* The membership stands either way — it is real, and the link can be resent —
           so the audit records how the invitation went rather than pretending it
           always goes one way. */
        /* Which of the three it was — a new invitation, a reinstated member or a
           resent email — is worth having in the audit trail rather than flattened. */
        const placed = typeof placement === "string" ? placement : "invited";
        await record(delivery.status === "sent" ? placed : `${placed}_email_${delivery.status}`);
        return json(
          {
            ok: true,
            email: delivery.status,
            emailReason: delivery.status === "sent" ? undefined : delivery.reason,
          },
          200,
        );
      },
    },
  },
});
