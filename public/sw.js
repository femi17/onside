/* Onside service worker — web-push notifications + install support.
   Intentionally does NOT cache app routes/data (this is an auth'd, live app; stale caches would be
   worse than a network wait). Its job is push + notification handling. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Onside";
  const options = {
    body: data.body || "",
    icon: data.icon || "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    // sound: the Notification `sound` property is unsupported in browsers, so we rely on the OS's
    // default notification sound (silent:false) + a vibration pattern on mobile.
    silent: false,
    vibrate: [90, 40, 90],
    // optional inline action buttons (e.g. "Mute" on agent picks) — carry the handler URL + category
    // on the notification data so the click handler can act without opening the app
    actions: Array.isArray(data.actions) ? data.actions : undefined,
    data: { url: data.url || "/tracker", muteUrl: data.muteUrl, muteCategory: data.muteCategory },
  };
  // show the OS notification AND tell any open tabs (so a focused tab can play the in-app chime)
  const notifyClients = async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clients) c.postMessage({ type: "onside-push", title, body: options.body, url: options.data.url });
  };
  event.waitUntil(Promise.all([self.registration.showNotification(title, options), notifyClients()]));
});

self.addEventListener("notificationclick", (event) => {
  const d = event.notification.data || {};
  event.notification.close();

  // "Mute" button — silence this category in the background (no app open). Auth is the device's own
  // push endpoint, which push-action maps back to the user. Then a brief confirmation so the tap lands.
  if (event.action === "mute" && d.muteUrl) {
    event.waitUntil(
      (async () => {
        try {
          const sub = await self.registration.pushManager.getSubscription();
          if (sub) {
            await fetch(d.muteUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ endpoint: sub.endpoint, category: d.muteCategory || "agent_picks" }),
            });
            await self.registration.showNotification("Muted", {
              body: "You won't get these alerts. Turn them back on in Profile · Notifications.",
              icon: "/icons/icon-192.png",
              tag: "onside-mute-confirm",
              data: { url: "/profile" },
            });
          }
        } catch { /* best-effort; the Profile toggle is always available */ }
      })(),
    );
    return;
  }

  const url = d.url || "/tracker";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of wins) {
        if ("focus" in c) {
          try { await c.navigate(url); } catch { /* cross-origin or not allowed */ }
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })(),
  );
});
