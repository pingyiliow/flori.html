// Self-destructing service worker.
//
// Earlier versions of this app shipped a cache-first service worker that
// pinned the page to an old cached copy of "/" (it even referenced the old
// /florist_app.html filename). Once installed, it served stale HTML and the
// network was never consulted, so the app could never update — closing and
// reopening the tab just re-served the old version.
//
// This replacement takes over from that old SW, wipes every cache,
// unregisters itself, and reloads any open tabs so they fetch a fresh copy
// from the network. It has NO fetch handler, so while briefly active it never
// serves anything from cache. After it unregisters, the app runs with no
// service worker at all (flori.html intentionally does not register one).

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) { /* ignore */ }

    await self.clients.claim();
    await self.registration.unregister();

    // Reload every open tab so it picks up the latest HTML from the network.
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((client) => {
      try { client.navigate(client.url); } catch (e) { /* ignore */ }
    });
  })());
});
