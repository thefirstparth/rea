// Crease service worker. It caches nothing and serves no requests: it exists so alerts can
// be shown with showNotification (Android requires a service worker for that) and so a
// tapped alert opens its match.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url ?? "/", self.location.origin);
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const win = wins.find((w) => new URL(w.url).origin === url.origin);
      if (!win) return self.clients.openWindow(url.href);
      // The page routes by hash; it moves itself so it keeps its state.
      win.postMessage({ type: "open", hash: url.hash });
      return win.focus();
    })(),
  );
});
