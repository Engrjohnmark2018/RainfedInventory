/*
 * RAINfed-Tagging Alcala — Service Worker.
 * - Caches the app shell so the farmer form works with no internet in the field.
 * - Never caches /admin or /api requests (admin needs fresh data).
 * - Background-syncs the offline submission queue when connectivity returns.
 */
"use strict";

importScripts("/static/js/offline-store.js");

var CACHE_NAME = "rainfedtag-shell-v4";
var SHELL = [
  "/",
  "/static/css/style.css",
  "/static/js/farmer.js",
  "/static/js/offline-store.js",
  "/static/vendor/exifr.min.js",
  "/static/vendor/leaflet/leaflet.css",
  "/static/vendor/leaflet/leaflet.js",
  "/static/vendor/leaflet/images/marker-icon.png",
  "/static/vendor/leaflet/images/marker-icon-2x.png",
  "/static/vendor/leaflet/images/marker-shadow.png",
  "/static/vendor/leaflet/images/layers.png",
  "/static/vendor/leaflet/images/layers-2x.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME) return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function isApi(url) { return url.pathname.indexOf("/api/") === 0; }
function isAdmin(url) { return url.pathname.indexOf("/admin") === 0; }
function isStatic(url) { return url.pathname.indexOf("/static/") === 0; }

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return; // POSTs (submissions) are handled by the app/sync
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Admin + API: always network (never show stale admin data).
  if (isAdmin(url) || isApi(url)) return;

  // Static assets: cache-first (fast, works offline).
  if (isStatic(url)) {
    event.respondWith(
      caches.match(req).then(function (cached) {
        return cached || fetch(req).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
          }
          return res;
        });
      })
    );
    return;
  }

  // Navigations (farmer page): network-first with cached shell fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put("/", copy); });
        }
        return res;
      }).catch(function () {
        return caches.match("/");
      })
    );
  }
});

/* -------------------------------------------------------------------------
 * Background sync: send queued submissions when connectivity returns,
 * even if the farmer already closed the page.
 * ---------------------------------------------------------------------- */
function buildFormData(item) {
  var fd = new FormData();
  fd.append("first_name", item.first_name);
  fd.append("middle_name", item.middle_name || "");
  fd.append("last_name", item.last_name);
  fd.append("capture_source", "camera");
  fd.append("client_id", item.client_id);
  fd.append("captured_at", item.captured_at || "");
  if (item.live_lat != null) {
    fd.append("live_lat", item.live_lat);
    fd.append("live_lon", item.live_lon);
    fd.append("live_accuracy", item.live_accuracy != null ? item.live_accuracy : "");
  }
  fd.append("photo", item.photo, "capture.jpg");
  return fd;
}

function syncQueue() {
  return OfflineStore.getPending().then(function (items) {
    var chain = Promise.resolve();
    items.forEach(function (item) {
      chain = chain.then(function () {
        return fetch("/api/submit", { method: "POST", body: buildFormData(item) })
          .then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
              if (res.ok && data.ok) {
                return OfflineStore.remove(item.client_id);
              }
              // Valid HTTP response but rejected data — stop retrying this item.
              if (res.status >= 400 && res.status < 500) {
                var msg = (data.errors && data.errors.join(" ")) || "Tinanggihan ng server.";
                return OfflineStore.markRejected(item.client_id, msg);
              }
              // Server error: keep pending for a later retry.
            });
          })
          .catch(function () {
            // Network error — stay pending.
          });
      });
    });
    return chain;
  });
}

self.addEventListener("sync", function (event) {
  if (event.tag === "sync-submissions") {
    event.waitUntil(syncQueue());
  }
});

// The page can ask the SW to sync immediately.
self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SYNC_NOW") {
    event.waitUntil(syncQueue().then(function () {
      return self.clients.matchAll({ includeUncontrolled: true }).then(function (clients) {
        clients.forEach(function (c) { c.postMessage({ type: "SYNC_DONE" }); });
      });
    }));
  }
});
