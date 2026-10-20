// Service Worker für die Home-Bildschirm-App (PWA) des Dashboards.
//
// Bewusst zurückhaltend: Das Dashboard selbst (index.html) und alle
// Supabase-Aufrufe kommen IMMER frisch aus dem Netz (vercel.json setzt
// dafür ohnehin no-cache) - es soll nie eine veraltete Version oder alte
// Daten angezeigt werden. Zwischengespeichert werden nur:
//  - die Offline-Seite + App-Symbole (Hinweis "Keine Verbindung" statt
//    einer leeren Seite, wenn das Netz beim Öffnen fehlt)
//  - die versionierten Bibliotheken von cdnjs (xlsx/html2canvas/jsPDF) -
//    die URLs enthalten die Version, ändern sich also nie -> schnellerer Start
//  - supabase-js von jsDelivr (Version "@2" nicht fest) - aus dem Cache,
//    im Hintergrund aktualisiert.
// Die <script>-Tags in index.html tragen crossorigin="anonymous", damit die
// Antworten hier lesbar sind (res.ok) - so wird nie eine fehlerhafte Antwort
// dauerhaft zwischengespeichert.
// Bei Änderungen an dieser Datei CACHE_VERSION erhöhen.
const CACHE_VERSION = "wg-dashboard-v1";
const PRECACHE = [
  "offline.html",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Seitenaufrufe: immer Netz, nur bei fehlender Verbindung die Offline-Seite.
  // Die Event-Seiten unter /events/ bleiben komplett unberührt.
  if (req.mode === "navigate") {
    if (url.origin === self.location.origin && url.pathname.startsWith("/events/")) return;
    event.respondWith(
      fetch(req).catch(() => caches.match("offline.html"))
    );
    return;
  }

  // Versionierte Bibliotheken: einmal laden, danach aus dem Cache.
  if (url.hostname === "cdnjs.cloudflare.com") {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  // supabase-js (unversioniert "@2"): Cache sofort, Update im Hintergrund.
  if (url.hostname === "cdn.jsdelivr.net" && url.pathname.startsWith("/npm/@supabase/")) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(cache =>
        cache.match(req).then(hit => {
          const net = fetch(req).then(res => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          }).catch(() => hit);
          return hit || net;
        })
      )
    );
    return;
  }

  // App-Symbole/Startbilder: aus dem Cache, sonst Netz (und merken).
  if (url.origin === self.location.origin && url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, copy));
        }
        return res;
      }))
    );
  }
  // Alles andere (Supabase-API, Edge Functions, ...) geht unverändert ans Netz.
});
