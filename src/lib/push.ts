/**
 * Browser push: permission, subscription, and keeping the server's copy in sync.
 *
 * What a player is actually turning on here is an OS-level notification that arrives
 * whether or not CourtHub is open — a different tab, a different app, the browser
 * closed. That only works through a service worker, so everything below is gated on
 * one being registrable.
 *
 * A subscription belongs to a browser, not to an account: the same player on a phone
 * and a laptop produces two rows, and clearing site data silently invalidates one
 * without telling the server. `syncSubscription` is therefore called on load, not
 * only when the switch is flipped — the DB copy is a cache of what the browser says,
 * and the browser is the authority.
 */

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export type PushSupport = { supported: true } | { supported: false; reason: string };

/** Why push is unavailable, in the words of the thing the player would have to change. */
export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return { supported: false, reason: "Not available." };
  if (!("serviceWorker" in navigator))
    return { supported: false, reason: "This browser does not support service workers." };
  if (!("PushManager" in window))
    return { supported: false, reason: "This browser does not support push notifications." };
  if (!("Notification" in window))
    return { supported: false, reason: "This browser does not support notifications." };
  /* iOS only exposes PushManager to an installed web app. Detecting the capability is
     not enough — Safari in a normal tab reports support and then refuses to subscribe. */
  const isIos = /iP(hone|ad|od)/.test(navigator.userAgent);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  if (isIos && !standalone)
    return {
      supported: false,
      reason: "On iPhone and iPad, add CourtHub to your Home Screen first, then turn this on.",
    };
  if (!VAPID_PUBLIC_KEY)
    return { supported: false, reason: "Push is not configured on this deployment." };
  return { supported: true };
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function keyToBase64(sub: PushSubscription, name: "p256dh" | "auth"): string {
  const key = sub.getKey(name);
  if (!key) throw new Error(`Subscription is missing its ${name} key.`);
  const bytes = new Uint8Array(key);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

/** Write the browser's current subscription to the server, replacing whatever it had
 *  for this endpoint. Upsert on the endpoint, because re-subscribing in the same
 *  browser returns the same endpoint with fresh keys. */
async function saveSubscription(userId: string, sub: PushSubscription) {
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      endpoint: sub.endpoint,
      user_id: userId,
      p256dh: keyToBase64(sub, "p256dh"),
      auth: keyToBase64(sub, "auth"),
      user_agent: navigator.userAgent.slice(0, 400),
      last_used_at: new Date().toISOString(),
    },
    { onConflict: "endpoint" },
  );
  if (error) throw error;
}

export function usePushSubscription(userId: string | undefined) {
  const [support] = useState<PushSupport>(() => pushSupport());
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Read the browser's actual state on mount rather than trusting the DB. A player
     who revoked permission in site settings, or cleared data, still has a row here. */
  useEffect(() => {
    if (!support.supported || !userId) return;
    let cancelled = false;
    (async () => {
      try {
        setPermission(Notification.permission);
        const reg = await navigator.serviceWorker.getRegistration("/sw.js");
        const existing = await reg?.pushManager.getSubscription();
        if (cancelled) return;
        setSubscribed(!!existing && Notification.permission === "granted");
        // Keys can be rotated by the browser; refresh the stored copy while we have it.
        if (existing && Notification.permission === "granted") {
          await saveSubscription(userId, existing).catch(() => {});
        }
      } catch {
        /* Reading state must never break Settings — the switch simply shows off. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [support.supported, userId]);

  const subscribe = useCallback(async () => {
    if (!userId || !support.supported) return;
    setBusy(true);
    setError(null);
    try {
      const reg = await registerServiceWorker();
      await navigator.serviceWorker.ready;

      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") {
        setError(
          result === "denied"
            ? "Your browser is blocking notifications for this site. Allow them in the address-bar site settings, then try again."
            : "Notifications were not allowed.",
        );
        return;
      }

      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          // Required by Chrome: a push that cannot show a notification is not allowed.
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY!) as BufferSource,
        }));

      await saveSubscription(userId, sub);
      setSubscribed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not turn on push notifications.");
    } finally {
      setBusy(false);
    }
  }, [userId, support.supported]);

  const unsubscribe = useCallback(async () => {
    if (!userId) return;
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        /* Drop the server row first. If unsubscribe() succeeds and the delete fails,
           the worker keeps pushing at a dead endpoint until it 410s; the other order
           just means one stale row that the next sync overwrites. */
        await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not turn off push notifications.");
    } finally {
      setBusy(false);
    }
  }, [userId]);

  return { support, permission, subscribed, busy, error, subscribe, unsubscribe };
}
