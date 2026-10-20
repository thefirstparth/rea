// Crease service worker. It keeps Crease's own files and the last answer to each of its
// API requests, so the app opens and shows the last scores without a connection; and
// it shows alerts (Android requires a service worker for showNotification) and opens
// a tapped alert's match.
//
// Always the network first: online, every request goes to the server as before (the
// page's own no-store fetches included), and the copy is only refreshed. The copy is
// served only when the network fails. The page marks offline data by the device being
// offline and by the data's age (asOf), so an old score never passes for a fresh one.

const CACHE = "crease-v1";
// Last answers kept for API requests, oldest dropped first; pages of older commentary
// (requests with a query) aren't kept.
const MAX_API = 60;
const SHELL = [
  "/",
  "/app.js",
  "/app.css",
  "/alerts.js",
  "/icon.svg",
  "/manifest.webmanifest",
  "/about.html",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {
        // Offline at install: the copy fills in as pages load.
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys())
        if (k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  ),
);

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Only Crease's own GETs; fonts and images from other sites go straight through.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  const api = url.pathname.startsWith("/api/");
  // Kept: API answers without a query, and the app's own files under their path (a
  // link's ?utm_source or ?ref isn't kept). Anything else goes straight through.
  if (api ? url.search : !SHELL.includes(url.pathname)) return;
  const key = api ? req : url.pathname;
  e.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const copy = res.clone();
          e.waitUntil(keep(key, copy, api));
        }
        return res;
      } catch (err) {
        const hit = await caches.match(key);
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});

// Only what the app can use replaces the last good copy: JSON for the API, Crease's own
// page for "/" (a Wi-Fi login page answering 200 must not become the offline app).
async function usable(res, api, key) {
  const type = res.headers.get("content-type") ?? "";
  if (api) {
    if (!type.includes("json")) return false;
    try {
      const body = await res.clone().json();
      return !!body && typeof body === "object";
    } catch {
      return false;
    }
  }
  if (key !== "/") return true;
  return (
    type.includes("html") && (await res.clone().text()).includes('id="view"')
  );
}

async function keep(key, res, api) {
  if (!(await usable(res, api, key))) return;
  const c = await caches.open(CACHE);
  await c.delete(key);
  await c.put(key, res);
  if (!api) return;
  const answers = (await c.keys()).filter((r) =>
    new URL(r.url).pathname.startsWith("/api/"),
  );
  for (const old of answers.slice(0, Math.max(0, answers.length - MAX_API)))
    await c.delete(old);
}

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
