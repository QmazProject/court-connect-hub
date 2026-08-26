import { createFileRoute } from "@tanstack/react-router";
import { deliverEmail } from "@/lib/notification-email.server";
import { sendWebPush, type VapidKeys } from "@/lib/web-push.server";

/**
 * Drains the notification outbox: one pass, email and push.
 *
 * A worker rather than a send inside the reminder job. `send_booking_reminders()`
 * runs in Postgres on pg_cron and cannot make an HTTPS request; more importantly, a
 * reminder run that failed halfway through a provider call would roll back
 * notifications the player can already see in the bell. The trigger queues, this
 * drains, and the two fail independently.
 *
 * Call it on a schedule every few minutes. Two shapes are accepted because the two
 * realistic schedulers disagree: Supabase pg_cron + pg_net sends POST and can set any
 * header, while Vercel Cron only ever sends GET with `Authorization: Bearer`. Either
 * is fine, and the secret is the same one.
 *
 * Safe to run concurrently — and to have both schedulers pointed at it at once:
 * `claim_notification_outbox` takes its batch with FOR UPDATE SKIP LOCKED, so two
 * overlapping runs never claim the same row.
 */

type ClaimedRow = {
  id: number;
  notification_id: string;
  user_id: string;
  channel: string;
  attempts: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
};

function vapidKeys(): VapidKeys | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject: process.env.VAPID_SUBJECT ?? "mailto:support@courthub.app",
  };
}

/** The secret may arrive as our own header or as a bearer token — Vercel Cron can
 *  only send the latter. `CRON_SECRET` is accepted as well, because that is the name
 *  Vercel injects into its own cron requests. */
function isAuthorised(request: Request): boolean {
  const expected = process.env.NOTIFICATION_DRAIN_SECRET;
  if (!expected) return false;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  return (
    request.headers.get("x-drain-secret") === expected ||
    bearer === expected ||
    (!!cronSecret && bearer === cronSecret)
  );
}

async function drain(request: Request): Promise<Response> {
  if (!process.env.NOTIFICATION_DRAIN_SECRET) {
    console.error("[drain] NOTIFICATION_DRAIN_SECRET is not configured");
    return new Response("Drain secret not configured", { status: 500 });
  }
  /* Compared as whole strings rather than char by char. This guards an
           internal scheduler endpoint, not a user credential, and the timing signal
           on a 32-byte random secret is not the weak link. */
  if (!isAuthorised(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const appUrl = process.env.APP_URL ?? new URL(request.url).origin;

  const { data: claimed, error: claimErr } = await supabaseAdmin.rpc("claim_notification_outbox", {
    _limit: 50,
  });
  if (claimErr) {
    console.error("[drain] could not claim outbox rows", claimErr);
    return new Response("DB error", { status: 500 });
  }

  const rows = (claimed ?? []) as unknown as ClaimedRow[];
  if (rows.length === 0) {
    return Response.json({ claimed: 0, sent: 0, failed: 0, skipped: 0 });
  }

  /* Addresses live in auth.users, not in profiles, so they are fetched once per
           batch rather than per row — a reminder run wakes many players at once and
           this is the difference between one admin call and fifty. */
  const emailTargets = [
    ...new Set(rows.filter((r) => r.channel === "email").map((r) => r.user_id)),
  ];
  const emailByUser = new Map<string, string>();
  await Promise.all(
    emailTargets.map(async (uid) => {
      const { data } = await supabaseAdmin.auth.admin.getUserById(uid);
      if (data?.user?.email) emailByUser.set(uid, data.user.email);
    }),
  );

  const pushTargets = [...new Set(rows.filter((r) => r.channel === "push").map((r) => r.user_id))];
  const subsByUser = new Map<string, { endpoint: string; p256dh: string; auth: string }[]>();
  if (pushTargets.length > 0) {
    const { data: subs } = await supabaseAdmin
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth, user_id")
      .in("user_id", pushTargets);
    for (const s of subs ?? []) {
      const list = subsByUser.get(s.user_id) ?? [];
      list.push({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth });
      subsByUser.set(s.user_id, list);
    }
  }

  const keys = vapidKeys();
  let sent = 0,
    failed = 0,
    skipped = 0;

  const settle = async (id: number, status: "sent" | "failed" | "skipped", error?: string) => {
    if (status === "sent") sent++;
    else if (status === "failed") failed++;
    else skipped++;
    await supabaseAdmin
      .from("notification_outbox")
      .update({
        status,
        last_error: error ?? null,
        sent_at: status === "sent" ? new Date().toISOString() : null,
      })
      .eq("id", id);
  };

  await Promise.all(
    rows.map(async (row) => {
      const payload = {
        type: row.type,
        title: row.title,
        body: row.body,
        link: row.link,
      };

      if (row.channel === "email") {
        const to = emailByUser.get(row.user_id) ?? "";
        const outcome = await deliverEmail(to, payload, appUrl);
        await settle(
          row.id,
          outcome.status,
          outcome.status === "sent" ? undefined : outcome.reason,
        );
        return;
      }

      if (row.channel === "push") {
        if (!keys) {
          await settle(row.id, "skipped", "VAPID keys are not configured");
          return;
        }
        const subs = subsByUser.get(row.user_id) ?? [];
        if (subs.length === 0) {
          await settle(row.id, "skipped", "no push subscriptions");
          return;
        }
        const body = JSON.stringify(payload);
        const results = await Promise.all(subs.map((s) => sendWebPush(s, body, keys)));

        /* A revoked subscription is permanent — the browser has thrown the key
                 away. Deleting it here is what stops one uninstalled device from
                 failing every future notification for that player. */
        const dead = subs
          .filter((_, i) => {
            const r = results[i];
            return !r.ok && r.gone;
          })
          .map((s) => s.endpoint);
        if (dead.length > 0) {
          await supabaseAdmin.from("push_subscriptions").delete().in("endpoint", dead);
        }

        /* One live device is a delivered notification. Marking the row failed
                 because a second, stale device rejected it would retry a push the
                 player has already seen. */
        if (results.some((r) => r.ok)) {
          await settle(row.id, "sent");
        } else if (dead.length === subs.length) {
          await settle(row.id, "skipped", "all subscriptions were revoked");
        } else {
          const first = results.find((r) => !r.ok);
          await settle(
            row.id,
            "failed",
            first && !first.ok ? `push ${first.status}: ${first.detail}` : "push failed",
          );
        }
        return;
      }

      await settle(row.id, "failed", `unknown channel "${row.channel}"`);
    }),
  );

  return Response.json({ claimed: rows.length, sent, failed, skipped });
}

export const Route = createFileRoute("/api/internal/notifications/drain")({
  server: {
    handlers: {
      POST: ({ request }) => drain(request),
      GET: ({ request }) => drain(request),
    },
  },
});
