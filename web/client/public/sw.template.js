const SHELL_ASSETS = __SWITCHBOARD_SHELL_ASSETS__;
const CACHE_NAME = "switchboard-shell-__SWITCHBOARD_CACHE_VERSION__";
const BASE = "__SWITCHBOARD_BASE__";

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(names => Promise.all(names
      .filter(name => name.startsWith("switchboard-shell-") && name !== CACHE_NAME)
      .map(name => caches.delete(name))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(`${BASE}api/`) || event.request.headers.get("accept")?.includes("text/event-stream")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(caches.match(event.request)
      .then(hit => hit ?? caches.match(`${BASE}index.html`))
      .then(hit => hit ?? caches.match(BASE))
      .then(hit => hit ?? fetch(event.request)));
    return;
  }
  event.respondWith(caches.match(event.request).then(hit => hit ?? fetch(event.request)));
});
