/* CourtHub service worker — push notifications only.
 *
 * Deliberately not a caching/offline worker. It exists so the browser has somewhere
 * to deliver a push while no CourtHub tab is open, which is the whole point of the
 * feature: the OS wakes this worker, it draws the notification, and the page it
 * belongs to may not exist yet.
 *
 * Kept in `public/` as plain JS rather than bundled, because a service worker has to
 * be served from the origin root to control the whole site, and its URL has to stay
 * stable across deploys or every existing subscription is orphaned.
 */

self.addEventListener("install", () => {
  // Take over immediately: a player who just switched notifications on should not
  // have to close every tab before the first push can arrive.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "CourtHub", body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || "CourtHub";
  const options = {
    body: payload.body || "",
    icon: "/CHicon.png",
    badge: "/courthub-badge.png",
    /* Collapse by booking rather than showing a stack: the day reminder and the
       "starting soon" reminder are about the same game, and two entries in the
       shade for one booking is how a player decides to turn these off. */
    tag: payload.link || payload.type || "courthub",
    renotify: true,
    data: { link: payload.link || "/dashboard" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/dashboard";
  const target = new URL(link, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      /* Reuse a tab that is already on this origin instead of opening a third
         CourtHub window — `navigate` keeps the SPA's router state alive. */
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          return client.focus().then((c) => (c.navigate ? c.navigate(target) : c));
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
