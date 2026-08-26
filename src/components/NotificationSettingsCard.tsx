/**
 * Notification settings, for either role.
 *
 * The channels — in-app, email, this device — are identical for a player and a venue,
 * so they live here once. Only the category list differs, because the two roles care
 * about different events: a player about their own bookings, a venue about everything
 * happening at it.
 *
 * The push half is deliberately the same code path as before, not a copy: one service
 * worker, one VAPID key, one `push_subscriptions` table, one permission flow. A venue
 * enabling push on the front-desk PC and again on a phone gets two rows, exactly as a
 * player would.
 */

import { useState } from "react";
import { AlertTriangle, Bell, BellRing, Loader2, Monitor, Smartphone } from "lucide-react";
import {
  DEFAULT_PREFS,
  useNotificationPrefs,
  useUpdateNotificationPrefs,
  type NotificationPrefs,
} from "@/lib/notification-prefs";
import { usePushSubscription } from "@/lib/push";

type Category = { key: keyof NotificationPrefs; label: string; description: string };

/** What a player is told about: their own games. */
const PLAYER_CATEGORIES: Category[] = [
  {
    key: "reminders_enabled",
    label: "Booking reminders",
    description: "A day before your game, and again when it is about to start.",
  },
  {
    key: "bookings_enabled",
    label: "Booking updates",
    description: "Confirmations, cancellations and changes to your court's hours.",
  },
  {
    key: "messages_enabled",
    label: "Messages",
    description: "Replies from a venue about one of your bookings.",
  },
  {
    key: "payments_enabled",
    label: "Payments and refunds",
    description: "Payment results and refunds returned to you.",
  },
];

/** What a venue is told about: what happened at it, and whether money moved. */
const TENANT_CATEGORIES: Category[] = [
  {
    key: "new_bookings_enabled",
    label: "New bookings",
    description: "A player books one of your courts. One notification per booking, not per hour.",
  },
  {
    key: "cancellations_enabled",
    label: "Cancellations",
    description: "A booking at one of your venues is cancelled.",
  },
  {
    key: "booking_changes_enabled",
    label: "Booking changes",
    description: "A booking is moved or rescheduled.",
  },
  {
    key: "payments_enabled",
    label: "Payments",
    description: "A payment for one of your bookings is received.",
  },
  {
    key: "refunds_enabled",
    label: "Refunds and payment issues",
    description: "A refund completes, or one needs your attention.",
  },
  {
    key: "messages_enabled",
    label: "Player messages",
    description: "A player sends a message about their booking.",
  },
];

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  busy,
  note,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  busy?: boolean;
  note?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border/70 py-3.5 first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <p className={"text-sm font-semibold " + (disabled ? "text-muted-foreground" : "")}>
          {label}
        </p>
        {description && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
        {note}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled || busy}
        onClick={() => onChange(!checked)}
        className={
          "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
          (checked ? "bg-primary" : "bg-muted-foreground/30")
        }
      >
        <span
          className={
            "inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow transition-transform " +
            (checked ? "translate-x-6" : "translate-x-1")
          }
        />
        {busy && (
          <Loader2 className="absolute -right-6 h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
      </button>
    </div>
  );
}

export function NotificationSettingsCard({
  userId,
  email,
  role,
}: {
  userId: string;
  email: string;
  role: "player" | "tenant";
}) {
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const prefsQ = useNotificationPrefs(userId);
  const updatePrefs = useUpdateNotificationPrefs(userId);
  const push = usePushSubscription(userId);
  const prefs = prefsQ.data ?? DEFAULT_PREFS;

  const categories = role === "tenant" ? TENANT_CATEGORIES : PLAYER_CATEGORIES;
  const blocked = push.permission === "denied";

  /* Two things that can fail separately: asking the browser, and recording the
     choice. The preference is only written once permission is actually granted, so
     the switch never claims to be on while the OS is dropping everything. */
  const togglePush = async (next: boolean) => {
    setTestMsg(null);
    if (next) {
      await push.subscribe();
      if (Notification.permission === "granted") updatePrefs.mutate({ push_enabled: true });
    } else {
      await push.unsubscribe();
      updatePrefs.mutate({ push_enabled: false });
    }
  };

  const showTest = async () => {
    setTestMsg(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      if (!reg) {
        setTestMsg("No service worker is registered yet. Turn the switch off and on again.");
        return;
      }
      await reg.showNotification("CourtHub notifications are on", {
        body:
          role === "tenant"
            ? "This is how a new booking will look."
            : "This is how a booking reminder will look.",
        icon: "/CHicon.png",
        badge: "/courthub-badge.png",
        tag: "courthub-test",
      });
      setTestMsg("Sent — check your notification area.");
    } catch (e) {
      setTestMsg(e instanceof Error ? e.message : "Could not show a test notification.");
    }
  };

  const setPref = (key: keyof NotificationPrefs) => (next: boolean) => {
    setTestMsg(null);
    updatePrefs.mutate({ [key]: next } as Partial<NotificationPrefs>);
  };

  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <Bell className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-base font-bold tracking-tight">Notifications</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {role === "tenant"
              ? "How CourtHub reaches you about activity at your venues."
              : "How CourtHub reaches you about your bookings."}
          </p>
        </div>
      </div>

      <div className="mt-5 rounded-xl border border-border bg-secondary/40 p-3.5">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <BellRing className="h-4 w-4 text-primary" /> In-app bell
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Always on. The bell is the activity record — everything below only changes what is sent to
          you <em>elsewhere</em>. Switching a category off still leaves its history in the bell.
        </p>
      </div>

      <div className="mt-5">
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
          Where to reach you
        </p>
        <div className="mt-2">
          <ToggleRow
            label="This device"
            description="Notifies you even when CourtHub is closed — another tab, another app, or the browser shut. Enable it separately on each device you use."
            checked={push.subscribed && prefs.push_enabled}
            onChange={togglePush}
            disabled={!push.support.supported || blocked}
            busy={push.busy}
            note={
              <>
                {!push.support.supported && (
                  <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                    <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {push.support.supported === false ? push.support.reason : null}
                  </p>
                )}
                {blocked && (
                  <p className="mt-1.5 flex items-start gap-1.5 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    This browser is blocking notifications for CourtHub. Allow them in the site
                    settings next to the address bar, then reload.
                  </p>
                )}
                {push.error && (
                  <p className="mt-1.5 text-xs font-medium text-destructive">{push.error}</p>
                )}
                {push.subscribed && !blocked && (
                  <button
                    type="button"
                    onClick={showTest}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-semibold transition hover:border-primary"
                  >
                    <Monitor className="h-3 w-3" /> Show a test notification
                  </button>
                )}
                {testMsg && <p className="mt-1.5 text-xs text-muted-foreground">{testMsg}</p>}
              </>
            }
          />
          <ToggleRow
            label="Email"
            description={email ? `Sent to ${email}.` : "Sent to your account email address."}
            checked={prefs.email_enabled}
            onChange={setPref("email_enabled")}
            busy={updatePrefs.isPending}
          />
        </div>
      </div>

      <div className="mt-6">
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
          What to send
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Applies to both email and this device. The bell keeps everything either way.
        </p>
        <div className="mt-2">
          {categories.map((c) => (
            <ToggleRow
              key={c.key}
              label={c.label}
              description={c.description}
              checked={prefs[c.key]}
              onChange={setPref(c.key)}
              busy={updatePrefs.isPending}
            />
          ))}
        </div>
      </div>

      {updatePrefs.isError && (
        <p className="mt-4 text-xs font-medium text-destructive">
          Could not save that change. It has been put back.
        </p>
      )}
    </section>
  );
}
