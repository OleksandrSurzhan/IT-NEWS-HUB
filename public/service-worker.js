// Minimal service worker — just enough for browsers to consider the
// site "installable". No offline caching: the feed needs to be live
// anyway, so we always go to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // presence alone satisfies the install criteria
