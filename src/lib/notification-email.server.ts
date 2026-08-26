/**
 * Booking-reminder email, sent through Resend.
 *
 * Resend rather than SMTP because this deploys to Cloudflare Workers, where there are
 * no raw sockets — an HTTP API is the only shape that works. The provider is reached
 * through one function so swapping it later means rewriting `deliverEmail` and
 * nothing else.
 *
 * Sending is a no-op when RESEND_API_KEY is unset. That is deliberate: a developer
 * running this locally should not need mail credentials, and the outbox row is marked
 * `skipped` rather than `failed`, so an unconfigured environment does not accumulate
 * a backlog that looks like an outage.
 */

const BRAND = "#0f4a40";
const ACCENT = "#b8f05a";

export type EmailNotification = {
  type: string;
  title: string;
  body: string | null;
  link: string | null;
};

export type EmailOutcome =
  { status: "sent" } | { status: "skipped"; reason: string } | { status: "failed"; reason: string };

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );

/** Inline styles and a table, because that is what mail clients render predictably —
 *  Gmail strips <style> blocks and Outlook ignores most of flexbox. */
export function renderNotificationEmail(n: EmailNotification, appUrl: string): string {
  const href = n.link ? new URL(n.link, appUrl).toString() : appUrl;
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f6f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e3e8e6;">
    <tr><td style="background:${BRAND};padding:20px 24px;">
      <span style="color:${ACCENT};font-size:18px;font-weight:800;letter-spacing:-0.02em;">CourtHub</span>
    </td></tr>
    <tr><td style="padding:28px 24px 8px;">
      <h1 style="margin:0;font-size:19px;line-height:1.35;color:#0d1f1b;font-weight:700;">${escapeHtml(n.title)}</h1>
      ${n.body ? `<p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#4a5b57;">${escapeHtml(n.body)}</p>` : ""}
    </td></tr>
    <tr><td style="padding:24px;">
      <a href="${escapeHtml(href)}" style="display:inline-block;background:${ACCENT};color:#102521;text-decoration:none;padding:11px 22px;border-radius:999px;font-size:14px;font-weight:700;">View booking</a>
    </td></tr>
    <tr><td style="padding:4px 24px 26px;border-top:1px solid #eef1f0;">
      <p style="margin:16px 0 0;font-size:11px;line-height:1.6;color:#8b9995;">
        You are getting this because booking reminders are on for your CourtHub account.
        Turn them off any time in <a href="${escapeHtml(new URL("/dashboard?view=settings", appUrl).toString())}" style="color:#3d7a6b;">Settings &rsaquo; Notifications</a>.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

export function renderNotificationText(n: EmailNotification, appUrl: string): string {
  const href = n.link ? new URL(n.link, appUrl).toString() : appUrl;
  return [n.title, n.body ?? "", "", href].filter(Boolean).join("\n");
}

export async function deliverEmail(
  to: string,
  n: EmailNotification,
  appUrl: string,
): Promise<EmailOutcome> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { status: "skipped", reason: "RESEND_API_KEY is not set" };
  if (!to) return { status: "skipped", reason: "recipient has no email address" };

  /* Resend's shared sender, which needs no DNS setup but only delivers to the address
     that owns the Resend account. That makes it exactly right as a default: a fresh
     deployment can prove the pipeline end to end, and going live is a matter of
     verifying a domain and setting this variable. */
  const from = process.env.NOTIFICATION_FROM_EMAIL ?? "CourtHub <onboarding@resend.dev>";

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: n.title,
      html: renderNotificationEmail(n, appUrl),
      text: renderNotificationText(n, appUrl),
    }),
  });

  if (res.ok) return { status: "sent" };
  const detail = await res.text().catch(() => "");
  return { status: "failed", reason: `Resend ${res.status}: ${detail.slice(0, 240)}` };
}
