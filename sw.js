// service worker بسيط: بيخلّي الموقع قابل للتثبيت، ومفيش كاش عشان التحديثات تظهر فوراً
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});