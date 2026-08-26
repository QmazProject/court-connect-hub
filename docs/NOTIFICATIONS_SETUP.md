# Turning on notification delivery

The in-app bell needs no setup. Email and push do, and they are independent — either
can be switched on without the other.

`.env` is **local only**. Vercel never reads it, so every variable below has to be
entered again in the Vercel dashboard.

## 1. Environment variables in Vercel

Project → Settings → Environment Variables. Add to **Production** (and Preview, if you
test there):

| Variable | Value | When it is read |
|---|---|---|
| `VITE_VAPID_PUBLIC_KEY` | the public key | **build time** |
| `VAPID_PUBLIC_KEY` | the same public key | runtime |
| `VAPID_PRIVATE_KEY` | the private key | runtime |
| `VAPID_SUBJECT` | `mailto:you@yourdomain.com` | runtime |
| `RESEND_API_KEY` | from resend.com | runtime |
| `NOTIFICATION_FROM_EMAIL` | see §3 | runtime |
| `NOTIFICATION_DRAIN_SECRET` | any long random string | runtime |
| `APP_URL` | `https://court-connect-hub.vercel.app` | runtime |

`VITE_VAPID_PUBLIC_KEY` is the one that catches people out. Anything prefixed `VITE_`
is **baked into the client bundle at build time**, not read when the server runs — so
adding it does nothing until the next deployment. Add it first, then redeploy.

## 2. Deploy

The endpoint that sends is part of the app, so it only exists once the code is pushed:

```bash
git add -A && git commit -m "Player settings, push and email notifications" && git push
```

Check it landed — this should return `403 Forbidden` as plain text, **not** an HTML
404 page. A 404 means the route is not deployed:

```bash
curl -i -X POST https://court-connect-hub.vercel.app/api/internal/notifications/drain
```

## 3. Resend

There is no URL to configure in Resend. What it needs is a **verified sender**.

- **To test today:** leave `NOTIFICATION_FROM_EMAIL` unset. It falls back to
  `onboarding@resend.dev`, which needs no DNS — but only delivers to the address that
  owns your Resend account. Sign in to CourtHub with that address and reminders will
  arrive.
- **To reach real players:** add your domain in Resend → Domains, publish the DNS
  records it gives you, wait for it to verify, then set
  `NOTIFICATION_FROM_EMAIL=CourtHub <notifications@yourdomain.com>`.

Until a domain is verified, sending to anyone else fails with a 403 from Resend and
the outbox row is marked `failed` with that message in `last_error`.

## 4. Schedule the sender

Notifications queue in `notification_outbox` the moment they are created, but nothing
leaves until something calls the drain endpoint. Two options.

### Supabase pg_cron (recommended)

Works on any Vercel plan and lives next to the reminder job that produces the work.
Run once in the Supabase SQL editor, substituting your own values:

```sql
create extension if not exists pg_net;

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

Check on it with `select * from cron.job;` and
`select * from net._http_response order by created desc limit 5;`.

### Vercel Cron

`vercel.json` in the project root. Note that Vercel Cron sends **GET** with
`Authorization: Bearer $CRON_SECRET` — the endpoint accepts that shape too:

```json
{ "crons": [{ "path": "/api/internal/notifications/drain", "schedule": "*/5 * * * *" }] }
```

On the **Hobby plan cron jobs run at most once per day**, which is no use for a
reminder that fires two hours before a game. Use pg_cron unless you are on Pro.

## 5. Test it end to end

1. Open **Settings** in the player workspace. Upload a picture — it should appear
   beside your name in the left rail immediately.
2. Turn on **This device**. The browser asks for permission; allow it. Then press
   **Show a test notification** — that confirms permission and the service worker,
   though not the server.
3. Force a real one. In the Supabase SQL editor:

   ```sql
   select public.notify_user(
     '<your-user-uuid>', 'booking_reminder_soon',
     'Test reminder', 'If this reached your email and your device, it all works.',
     '/dashboard'
   );
   ```

4. Check it queued: `select * from public.notification_outbox order by id desc limit 5;`
   You should see one `pending` row per enabled channel.
5. Trigger the drain by hand rather than waiting for cron:

   ```bash
   curl -X POST https://court-connect-hub.vercel.app/api/internal/notifications/drain \
     -H "x-drain-secret: YOUR_NOTIFICATION_DRAIN_SECRET"
   ```

   It returns `{"claimed":N,"sent":N,"failed":0,"skipped":0}`.
6. Re-check the outbox. Anything `failed` or `skipped` carries the reason in
   `last_error` — that column is where every misconfiguration shows up.

## Known limits

- **iPhone and iPad**: web push only works if CourtHub is added to the Home Screen.
  Settings detects this and says so instead of offering a switch that cannot work.
- **Push needs the tab to have been opened once** on that device, to register the
  service worker and create the subscription. It then works with the browser closed.
- Rotating the VAPID keys invalidates every existing subscription; everyone has to
  turn the switch on again.
