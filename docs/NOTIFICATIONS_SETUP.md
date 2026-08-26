# Notification delivery — full setup runbook

Three channels, independent of each other:

| Channel | Needs | Reaches |
|---|---|---|
| **In-app bell** | nothing | the app while it is open |
| **Email** | a Resend key | anywhere mail goes |
| **Web push** | VAPID keys + a service worker | the device, even with the browser closed |

Work through this in order. Each step ends with a check — if the check fails, stop
there rather than moving on, because every later step assumes the earlier one worked.

> **Secrets never go in the repo.** `.env` is gitignored and is for local runs only.
> Vercel does not read it. Everything real is entered in the Vercel dashboard.

---

## Step 0 — The two values you generate yourself

Before anything else, understand where each value comes from. Only one of them is
issued by a website — that is the thing that trips people up.

| Variable | Where it comes from |
|---|---|
| `RESEND_API_KEY` | **Issued to you** — copy it from the Resend dashboard (Step 1) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | **You generate them.** No site issues these |
| `VAPID_SUBJECT` | **You choose it** — your own contact address |
| `NOTIFICATION_DRAIN_SECRET` | **You invent it** — any long random string |
| `APP_URL` | Your own deployment URL |

There is no "VAPID provider" to sign up with, and no dashboard to copy the drain
secret from. If you have been looking for one, that is why you could not find it.

---

### 0a. VAPID keys — what they are

VAPID is how a push service (Google's FCM for Chrome, Mozilla's for Firefox,
Apple's for Safari) knows a push really came from **your** site and not someone who
scraped a subscription.

It is an **ECDSA P-256 keypair that you create once and keep**:

- The **public** key is handed to the browser when a player enables push. The browser
  bakes it into the subscription it creates.
- The **private** key never leaves your server. It signs a token on every send.

The push service checks the signature against the public key that is already inside
the subscription. If they do not match, it rejects the push with `403`. That is the
entire mechanism — which is why the two keys must be **from the same pair**, and why
the public key has to be identical in both `VAPID_PUBLIC_KEY` and
`VITE_VAPID_PUBLIC_KEY`.

### 0b. Generating a pair

You already have one — it is in your local `.env`, and was generated with exactly
this. Run it again only if you need a **new** pair (see 0d for the consequences).

```bash
node -e "
const { generateKeyPairSync } = require('crypto');
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65);
console.log('VAPID_PUBLIC_KEY=' + Buffer.from(pub).toString('base64url'));
console.log('VAPID_PRIVATE_KEY=' + privateKey.export({ format: 'jwk' }).d);
"
```

No install needed — `crypto` is built into Node. It prints two lines ready to paste.

`npx web-push generate-vapid-keys` produces an equivalent pair if you prefer a tool,
but it downloads a package to do what the line above does with none.

### 0c. Checking a pair is valid

If push fails with `403`, check the keys before suspecting anything else. A correct
pair is always **65 bytes public** (starting with byte `0x04`, the uncompressed-point
marker) and **32 bytes private**:

```bash
node -e "
const pub='PASTE_PUBLIC', priv='PASTE_PRIVATE';
const p=Buffer.from(pub,'base64url'), s=Buffer.from(priv,'base64url');
console.log('public :', p.length, p.length===65?'OK':'WRONG (want 65)', '| first byte 0x'+p[0].toString(16), p[0]===4?'OK':'WRONG (want 04)');
console.log('private:', s.length, s.length===32?'OK':'WRONG (want 32)');
"
```

Wrong lengths almost always mean a copy-paste problem — a truncated value, or a
stray newline. Base64url uses `-` and `_`, never `+` or `/`, and has no `=` padding.

### 0d. `VAPID_SUBJECT`, and rotation

`VAPID_SUBJECT` is a contact address for you, in the signed token, so a push service
can reach you if your sending misbehaves. It must be a `mailto:` or `https:` URL —
`mailto:you@yourdomain.com` is right. It is not secret.

**Rotating the keys invalidates every existing subscription.** Subscriptions already
in browsers are bound to the old public key, so after a change every player has to
open Settings and turn **This device** on again. Generate once, store them, and do
not regenerate casually. If you do rotate, clear the stale rows:

```sql
delete from public.push_subscriptions;
```

---

### 0e. `NOTIFICATION_DRAIN_SECRET` — in detail

**What it protects.** `/api/internal/notifications/drain` is the endpoint that
actually sends. It is on the public internet, and anyone who can call it can make
your deployment burn through its Resend quota and fire pushes at your players. This
secret is the only thing in front of it.

**How to make one.** Any long random string. Pick whichever you have to hand:

```bash
openssl rand -base64 32                      # macOS / Linux / Git Bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

```powershell
# Windows PowerShell
[Convert]::ToBase64String((1..32 | % { Get-Random -Max 256 }))
```

**Where it goes — exactly two places, and they must match byte for byte:**

1. **Vercel** → Settings → Environment Variables → `NOTIFICATION_DRAIN_SECRET`
2. **The pg_cron job** in Step 6, inside the `headers` JSON

A mismatch produces a `403` in `net._http_response`, and mail silently stops. When
copying, watch for a trailing newline or space — that is the usual cause, and the
value looks identical on screen.

**The three ways the endpoint accepts it.** All are checked against the same secret,
so use whichever suits the caller:

| Caller | Shape |
|---|---|
| pg_cron / `curl` | `x-drain-secret: <secret>` header |
| Vercel Cron | `Authorization: Bearer <secret>` |
| Vercel Cron with its own `CRON_SECRET` set | `Authorization: Bearer <CRON_SECRET>` |

Vercel Cron can only send `GET` with a bearer token, which is why the endpoint
accepts `GET` as well as `POST`. Both do the same work.

**What it returns.** A JSON summary of one pass:

```json
{ "claimed": 2, "sent": 2, "failed": 0, "skipped": 0 }
```

| Field | Meaning |
|---|---|
| `claimed` | rows taken off the queue this run (max 50) |
| `sent` | delivered — mail accepted by Resend, or at least one live device pushed |
| `failed` | will be retried, up to 5 attempts, then left alone |
| `skipped` | not attempted and not retried — e.g. no API key, no subscriptions |

`"claimed": 0` means the queue was empty, which is the normal steady state once the
scheduler is running.

**It is safe to call repeatedly.** Rows are claimed with `FOR UPDATE SKIP LOCKED`, so
two overlapping runs never pick up the same row and nothing is sent twice. You can
leave pg_cron running and still trigger it by hand while debugging.

---

## Step 1 — Resend

### 1a. API key

1. Sign up at [resend.com](https://resend.com).
2. **API Keys → Create API Key.**
3. Permission: **Sending access** is enough. Full access is not needed.
4. Copy the key — it starts with `re_` and is shown **once**. Losing it means making
   a new one.

### 1b. Sender address — pick one of two paths

There is no URL or webhook to configure in Resend. The only thing it needs is a
sender address it trusts.

**Path A — testing today, no DNS.**

Leave `NOTIFICATION_FROM_EMAIL` unset. The code falls back to
`CourtHub <onboarding@resend.dev>`, which is Resend's shared sender and needs no
setup at all.

The catch: it **only delivers to the email address that owns your Resend account.**
Sending to anyone else returns a 403. For proving the pipeline works, that is fine —
just make sure the CourtHub account you test with uses that same address.

**Path B — real players, needs a domain you own.**

You **cannot** use `court-connect-hub.vercel.app` here. Resend verifies domains by
DNS records, and you do not control `vercel.app`. You need a domain you actually own.

1. **Domains → Add Domain**, enter e.g. `courthub.ph`.
2. Resend shows you a set of DNS records. Add them at your registrar exactly as
   shown — copy the values verbatim rather than typing them, especially the DKIM key.
   You will get roughly:

   | Type | Purpose |
   |---|---|
   | `MX` on a `send.` subdomain | where bounces go |
   | `TXT` (SPF) on the same subdomain | authorises Resend to send as you |
   | `TXT` (DKIM) on `resend._domainkey` | signs your mail so it is not spam |
   | `TXT` (DMARC) — optional but recommended | tells receivers what to do on failure |

3. Wait for Resend to flip the domain to **Verified**. Usually minutes; DNS can take
   longer.
4. Set `NOTIFICATION_FROM_EMAIL=CourtHub <notifications@courthub.ph>` — the address
   must be **on the verified domain**.

> ✅ **Check:** Resend → Domains shows *Verified*, or you have consciously chosen
> Path A and know mail only reaches your own address.

---

## Step 2 — Environment variables in Vercel

**Project → Settings → Environment Variables.** Add each to **Production** (and
**Preview** too if you test on preview URLs).

| Variable | Value | Where from | Read at |
|---|---|---|---|
| `VITE_VAPID_PUBLIC_KEY` | your VAPID **public** key | [§0b](#0b-generating-a-pair) | **build** |
| `VAPID_PUBLIC_KEY` | the **same** public key | [§0b](#0b-generating-a-pair) | runtime |
| `VAPID_PRIVATE_KEY` | your VAPID **private** key | [§0b](#0b-generating-a-pair) | runtime |
| `VAPID_SUBJECT` | `mailto:you@yourdomain.com` | [§0d](#0d-vapid_subject-and-rotation) | runtime |
| `RESEND_API_KEY` | the `re_…` key | [§1a](#1a-api-key) | runtime |
| `NOTIFICATION_FROM_EMAIL` | Path B address, or omit for Path A | [§1b](#1b-sender-address--pick-one-of-two-paths) | runtime |
| `NOTIFICATION_DRAIN_SECRET` | a long random string | [§0e](#0e-notification_drain_secret--in-detail) | runtime |
| `APP_URL` | `https://court-connect-hub.vercel.app` | your deployment | runtime |

Only `RESEND_API_KEY` is copied from somebody's dashboard. The VAPID pair and the
drain secret you produce yourself — see Step 0 if you have not yet.

### The one that catches everyone

`VITE_VAPID_PUBLIC_KEY` is **compiled into the browser bundle at build time**. It is
not read when the server runs. So:

- Add it **before** the deploy that should use it.
- Changing it later does nothing until you **redeploy**.
- If Settings says *"Push is not configured on this deployment"*, this is why —
  redeploy, do not debug the database.

The other seven are ordinary server variables and take effect on the next request.

> ✅ **Check:** all eight rows present, and `VITE_VAPID_PUBLIC_KEY` is byte-identical
> to `VAPID_PUBLIC_KEY`. A mismatch produces push subscriptions your server cannot
> sign for, and every send fails with `403` from the push service. Validate the pair
> with the snippet in [§0c](#0c-checking-a-pair-is-valid).

---

## Step 3 — Deploy

The endpoint that sends is part of the app, so it does not exist until the code is
pushed.

```bash
git add -A
git commit -m "Player settings, push and email notifications"
git push
```

Wait for the Vercel build to go green, then:

```bash
curl -i -X POST https://court-connect-hub.vercel.app/api/internal/notifications/drain
```

| You get | Meaning |
|---|---|
| `403 Forbidden`, plain text | ✅ deployed and guarding itself correctly |
| `500 Drain secret not configured` | deployed, but `NOTIFICATION_DRAIN_SECRET` is missing in Vercel |
| `404` with an **HTML** body | ❌ not deployed — this is the app's 404 page |

> ✅ **Check:** you get a plain-text `403`. Do not continue on a `404`.

---

## Step 4 — Database extensions (Supabase SQL Editor)

### 4a. See what you already have

Your booking-reminders migration already tries to enable `pg_cron`. Check before
creating anything:

```sql
select extname from pg_extension where extname in ('pg_cron', 'pg_net');
select jobname, schedule, active from cron.job;
```

If `cron.job` errors with *schema "cron" does not exist*, `pg_cron` never got enabled
— that migration swallows the failure on purpose so it degrades instead of breaking
your deploy.

### 4b. Create whatever is missing

Safe to run even if they already exist:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

You can equally use **Database → Extensions** in the dashboard and toggle them — same
result, and better if the SQL editor complains about privileges.

### 4c. Confirm where `http_post` lives

Do not assume the schema. Find the function you are about to call:

```sql
select n.nspname as schema, p.proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.proname like 'http_%';
```

Whatever schema it reports is the prefix to use below. `net` is the normal outcome.

> ✅ **Check:** both extensions listed, and `http_post` found.

---

## Step 5 — Test all three channels by hand

Do this **before** scheduling the drain. Once the scheduler runs every two minutes it
empties the outbox on its own, and rows vanish before you can look at them.

### 5a. Profile picture and the bell

Open the player workspace → **Settings**. Upload a picture; it should appear beside
your name in the left rail straight away.

### 5b. Turn on push

Still in Settings → **Notifications** → enable **This device**. Chrome/Edge will ask
for permission — allow it.

Press **Show a test notification**. Be clear on what this proves: it fires a
notification **locally from your browser**. It confirms permission and the service
worker — the two things that usually break — but it never touches your server. It can
succeed on a deployment where real push delivery is broken.

Now confirm the subscription reached the database:

```sql
select endpoint, user_agent, created_at
from public.push_subscriptions
where user_id = '<your-user-uuid>';
```

> ✅ **Check:** at least one row. No row means push cannot be queued at all, whatever
> the switch shows.

### 5c. Fire a real notification

```sql
select public.notify_user(
  '<your-user-uuid>',
  'booking_reminder_soon',
  'Test reminder',
  'If this reached your email and your device, all three channels work.',
  '/dashboard'
);
```

### 5d. Confirm it queued

```sql
select o.channel, o.status, o.attempts, o.last_error, n.title
from public.notification_outbox o
join public.notifications n on n.id = o.notification_id
order by o.id desc limit 10;
```

You want two `pending` rows — `email` and `push`.

**If the `push` row is missing entirely**, the drain is not the problem and re-running
curl will never fix it. A push row is only created when **both** are true:

```sql
select push_enabled, email_enabled from public.notification_preferences where user_id = '<your-user-uuid>';
select count(*) from public.push_subscriptions where user_id = '<your-user-uuid>';
```

`push_enabled` must be `true` **and** the count must be at least 1.

### 5e. Drain it manually

```bash
curl -X POST https://court-connect-hub.vercel.app/api/internal/notifications/drain \
  -H "x-drain-secret: YOUR_NOTIFICATION_DRAIN_SECRET"
```

Returns e.g. `{"claimed":2,"sent":2,"failed":0,"skipped":0}`.

Re-run the query from 5d. Both rows should read `sent`, the email should be in your
inbox, and the push should have appeared on your device — try it with the browser
minimised, which is the whole point of the channel.

> ✅ **Check:** `email sent` and `push sent`. Anything `failed` or `skipped` carries
> the reason in `last_error` — that column is where every misconfiguration surfaces.

---

## Step 6 — Schedule the drain automatically

Until now you have been the scheduler. Real players need this running on its own.

### Supabase pg_cron — recommended

Works on any Vercel plan and sits next to the reminder job that creates the work. Run
once in the SQL Editor with your real values:

```sql
select cron.schedule(
  'drain-notification-outbox',
  '*/2 * * * *',
  $$
  select net.http_post(
    url     := 'https://court-connect-hub.vercel.app/api/internal/notifications/drain',
    headers := '{"x-drain-secret": "YOUR_NOTIFICATION_DRAIN_SECRET"}'::jsonb
  );
  $$
);
```

To change it later, unschedule first — re-running with the same name errors:

```sql
select cron.unschedule('drain-notification-outbox');
```

### Vercel Cron — alternative

`vercel.json` in the project root:

```json
{ "crons": [{ "path": "/api/internal/notifications/drain", "schedule": "*/5 * * * *" }] }
```

Vercel Cron sends **GET** with `Authorization: Bearer $CRON_SECRET`; the endpoint
accepts that shape as well as the header form.

⚠️ On the **Hobby plan, cron jobs run at most once per day** — useless for a reminder
that fires two hours before a game. Use pg_cron unless you are on Pro.

---

## Step 7 — Confirm the scheduler is really running

```sql
select jobname, schedule, active from cron.job;
select status_code, created from net._http_response order by created desc limit 5;
```

| Result | Meaning |
|---|---|
| `200` | ✅ working |
| `403` | the secret in the cron job ≠ `NOTIFICATION_DRAIN_SECRET` in Vercel |
| `500` | `NOTIFICATION_DRAIN_SECRET` missing in Vercel |
| `404` | wrong URL, or the code is not deployed |
| table empty after 5 min | the job is not firing — check `active` is true |

Then leave it alone for a real booking and confirm a reminder arrives unprompted.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Settings: *"Push is not configured on this deployment"* | `VITE_VAPID_PUBLIC_KEY` missing at **build** time | Add it, then **redeploy** |
| Settings: *"add CourtHub to your Home Screen first"* | iPhone/iPad in a normal Safari tab | Share → Add to Home Screen, open from there |
| Push switch will not turn on, says blocked | Notifications denied at browser level | Site settings by the address bar → Allow → reload |
| No `push` row in the outbox | `push_enabled` false, or no subscription row | See 5d |
| `push` row `failed`, `last_error` mentions 403 | VAPID public/private mismatch, or keys rotated | Make the two public keys identical; re-subscribe |
| `push` row `skipped`: *all subscriptions were revoked* | Browser data cleared / app uninstalled | Turn the switch on again on that device |
| `email` `skipped`: *RESEND_API_KEY is not set* | Missing in Vercel | Add it |
| `email` `failed`, Resend 403 | Sending from an unverified domain, or Path A to a non-owner address | Verify the domain, or test with the account owner's address |
| Everything `sent` but nothing arrives | Check spam; on Path A, mail only goes to the Resend account owner | Complete Path B |
| `curl` returns HTML `404` | Code not deployed | `git push`, wait for the build |

---

## Reference

**What each variable does**

- `VAPID_*` — an ECDSA P-256 keypair identifying **your origin** to push services.
  The public half goes to the browser; the private half signs each send. Rotating
  them invalidates **every existing subscription** and everyone must re-enable push.
- `NOTIFICATION_DRAIN_SECRET` — the only thing standing between the public internet
  and your send loop. Long and random.
- `APP_URL` — the absolute origin used to build links inside emails and pushes. It
  falls back to the request origin, which is wrong behind a proxy, so set it.

**How a notification travels**

```
notify_user()  →  notifications row  →  AFTER INSERT trigger
                                             │  reads notification_preferences
                                             ▼
                                     notification_outbox   (one row per channel)
                                             │
                          pg_cron ──────────▶│  POST /api/internal/notifications/drain
                                             ▼
                                    Resend   ·   Web Push
```

The trigger is the only place that knows email and push exist, which is why any
notification type added later gets both channels for free.

**Do not commit**: `VAPID_PRIVATE_KEY`, `RESEND_API_KEY`, `NOTIFICATION_DRAIN_SECRET`.
They belong in Vercel and in your local `.env` (already gitignored) — nowhere else.
