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
    icon: data.icon || "/icons/icon.svg",
    badge: "/icons/icon.svg",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    // sound: the Notification `sound` property is unsupported in browsers, so we rely on the OS's
    // default notification sound (silent:false) + a vibration pattern on mobile.
    silent: false,
    vibrate: [90, 40, 90],
    data: { url: data.url || "/tracker" },
  };
  // show the OS notification AND tell any open tabs (so a focused tab can play the in-app chime)
  const notifyClients = async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clients) c.postMessage({ type: "onside-push", title, body: options.body, url: options.data.url });
  };
  event.waitUntil(Promise.all([self.registration.showNotification(title, options), notifyClients()]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/tracker";
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
