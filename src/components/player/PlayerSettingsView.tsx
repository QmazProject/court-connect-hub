/**
 * Player Settings — who you are, and how CourtHub is allowed to reach you.
 *
 * The notification block is the reason this page exists. Three channels with
 * genuinely different reach, so each says plainly what it does and what it needs:
 * the bell is always on and is the record; email arrives wherever mail does; push is
 * the only one that reaches a closed browser, and the only one that can be refused by
 * something outside this app.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bell,
  BellRing,
  Camera,
  Check,
  Loader2,
  Mail,
  Monitor,
  Smartphone,
  Trash2,
  User as UserIcon,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { initialsOf, useAvatarUpload, useRemoveAvatar } from "@/lib/avatar";
import {
  DEFAULT_PREFS,
  useNotificationPrefs,
  useUpdateNotificationPrefs,
  type NotificationPrefs,
} from "@/lib/notification-prefs";
import { usePushSubscription } from "@/lib/push";

function Card({
  title,
  subtitle,
  icon: Icon,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-base font-bold tracking-tight">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** A row with a switch. Disabled rows explain themselves rather than going grey in
 *  silence — a control a player cannot use is a question they will otherwise ask. */
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

export function PlayerSettingsView({
  userId,
  fullName,
  email,
  avatarUrl,
}: {
  userId: string;
  fullName: string;
  email: string;
  avatarUrl: string | null;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(fullName);
  const [nameSaved, setNameSaved] = useState(false);
  const [avatarErr, setAvatarErr] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  /* `fullName` lands after the profile query settles, which is usually after the
     first render — without this the field would sit empty for a signed-in player. */
  useEffect(() => setName(fullName), [fullName]);

  const upload = useAvatarUpload(userId);
  const removeAvatar = useRemoveAvatar(userId);
  const prefsQ = useNotificationPrefs(userId);
  const updatePrefs = useUpdateNotificationPrefs(userId);
  const push = usePushSubscription(userId);

  const prefs = prefsQ.data ?? DEFAULT_PREFS;

  const saveName = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("profiles")
        .update({ full_name: name.trim() })
        .eq("id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      setNameSaved(true);
      qc.invalidateQueries({ queryKey: ["profile", userId] });
      qc.invalidateQueries({ queryKey: ["auth-player-session"] });
      setTimeout(() => setNameSaved(false), 2500);
    },
  });

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setAvatarErr(null);
    try {
      await upload.mutateAsync(file);
    } catch (e) {
      setAvatarErr(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  /* Turning the switch on has to do two things that can fail separately: ask the
     browser (which may refuse) and record the choice. The preference is only written
     once the browser has actually granted, so the switch never claims to be on while
     the OS is silently dropping everything. */
  const togglePush = async (next: boolean) => {
    setTestMsg(null);
    if (next) {
      await push.subscribe();
      if (Notification.permission === "granted") {
        updatePrefs.mutate({ push_enabled: true });
      }
    } else {
      await push.unsubscribe();
      updatePrefs.mutate({ push_enabled: false });
    }
  };

  /* Draws a notification through the registered worker. It does not exercise the
     server, and says so — what it proves is the part that usually goes wrong: that
     permission is real and the OS will actually show it. */
  const showTest = async () => {
    setTestMsg(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      if (!reg) {
        setTestMsg("No service worker is registered yet. Turn the switch off and on again.");
        return;
      }
      await reg.showNotification("CourtHub notifications are on", {
        body: "This is how a booking reminder will look.",
        icon: "/CHicon.png",
        badge: "/courthub-badge.png",
        tag: "courthub-test",
        data: { link: "/dashboard?view=settings" },
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

  const initials = initialsOf(name || fullName, "P");
  const blocked = push.permission === "denied";

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
          Player workspace
        </p>
        <h1 className="mt-1 font-cabinet text-2xl font-bold tracking-tight sm:text-3xl">
          Settings
        </h1>
      </div>

      <Card
        title="Profile"
        subtitle="Your picture and name, shown across CourtHub."
        icon={UserIcon}
      >
        <div className="flex flex-wrap items-center gap-5">
          <div className="relative">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt=""
                className="h-20 w-20 rounded-full border-2 border-border object-cover"
              />
            ) : (
              <span className="grid h-20 w-20 place-items-center rounded-full border-2 border-border bg-secondary font-display text-xl font-bold text-muted-foreground">
                {initials}
              </span>
            )}
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={upload.isPending}
              aria-label="Change profile picture"
              className="absolute -bottom-1 -right-1 grid h-8 w-8 place-items-center rounded-full border-2 border-card bg-primary text-primary-foreground shadow transition hover:opacity-90 disabled:opacity-50"
            >
              {upload.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Camera className="h-3.5 w-3.5" />
              )}
            </button>
          </div>

          <div className="min-w-0 flex-1">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={upload.isPending}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold transition hover:border-primary disabled:opacity-50"
              >
                {avatarUrl ? "Change picture" : "Upload picture"}
              </button>
              {avatarUrl && (
                <button
                  type="button"
                  onClick={() => removeAvatar.mutate()}
                  disabled={removeAvatar.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-semibold text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </button>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">JPG, PNG or WebP, up to 3 MB.</p>
            {avatarErr && <p className="mt-2 text-xs font-medium text-destructive">{avatarErr}</p>}
          </div>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Full name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your full name"
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Email</span>
            <input
              value={email}
              readOnly
              className="mt-1 w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
            />
          </label>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => saveName.mutate()}
            disabled={saveName.isPending || name.trim() === fullName.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {saveName.isPending ? "Saving…" : "Save changes"}
          </button>
          {nameSaved && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary">
              <Check className="h-3.5 w-3.5" /> Saved
            </span>
          )}
          {saveName.isError && (
            <span className="text-xs font-medium text-destructive">
              {saveName.error instanceof Error ? saveName.error.message : "Could not save."}
            </span>
          )}
        </div>
      </Card>

      <Card
        title="Notifications"
        subtitle="How CourtHub reaches you about your bookings."
        icon={Bell}
      >
        <div className="rounded-xl border border-border bg-secondary/40 p-3.5">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <BellRing className="h-4 w-4 text-primary" /> In-app bell
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Always on. The bell is the record of everything that happened to your bookings, so it
            cannot be switched off — the settings below only change what gets sent to you elsewhere.
          </p>
        </div>

        <div className="mt-5">
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
            Where to reach you
          </p>
          <div className="mt-2">
            <ToggleRow
              label="This device"
              description="Notifies you even when CourtHub is closed — another tab, another app, or the browser shut. Works in Chrome, Edge, Firefox and installed apps."
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
              description={
                email
                  ? `Sent to ${email}. Best for reminders you want to find later.`
                  : "Sent to your account email address."
              }
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
            Applies to both email and this device.
          </p>
          <div className="mt-2">
            <ToggleRow
              label="Booking reminders"
              description="A day before your game, and again when it is about to start."
              checked={prefs.reminders_enabled}
              onChange={setPref("reminders_enabled")}
              busy={updatePrefs.isPending}
            />
            <ToggleRow
              label="Booking updates"
              description="Confirmations, cancellations and changes to your court's hours."
              checked={prefs.bookings_enabled}
              onChange={setPref("bookings_enabled")}
              busy={updatePrefs.isPending}
            />
            <ToggleRow
              label="Messages"
              description="Replies from a venue about one of your bookings."
              checked={prefs.messages_enabled}
              onChange={setPref("messages_enabled")}
              busy={updatePrefs.isPending}
            />
            <ToggleRow
              label="Payments and refunds"
              description="Payment results and refunds returned to you."
              checked={prefs.payments_enabled}
              onChange={setPref("payments_enabled")}
              busy={updatePrefs.isPending}
            />
          </div>
        </div>

        {updatePrefs.isError && (
          <p className="mt-4 flex items-center gap-1.5 text-xs font-medium text-destructive">
            <Mail className="h-3.5 w-3.5" /> Could not save that change. It has been put back.
          </p>
        )}
      </Card>
    </div>
  );
}
