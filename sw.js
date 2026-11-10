/*
 * 7-Zip WASM — service worker.
 *
 * Precaches the app shell (plus the emscripten glue and wasm binary) listed by
 * the generated sw-manifest.js and serves it cache-first, so the whole site
 * keeps working offline after the first load.
 *
 * Every URL here is RELATIVE to this script's own location, so the site works
 * from any GitHub Pages subpath (user.github.io/7zip-web/) and from a plain
 * local static server. No external resources are ever requested.
 */

'use strict';

// Written by CI: node .github/scripts/generate-sw-manifest.mjs <site-dir>
// It defines self.__SW_VERSION__ and self.__SW_ASSETS__.
// During local development the file may not exist yet — a failed importScripts
// must not brick the install, so it is guarded.
try {
  importScripts('./sw-manifest.js');
} catch (err) {
  console.warn('[sw] sw-manifest.js unavailable, running without a precache list: ' + (err && err.message ? err.message : err));
}

var CACHE = '7zip-web-' + (self.__SW_VERSION__ || 'dev');
var ASSETS = Array.isArray(self.__SW_ASSETS__) ? self.__SW_ASSETS__.slice() : [];

// Absolute URLs for the precache list. Resolved against this script's own
// location, so they work from any subpath the site is published under.
var ASSET_URLS = ASSETS.map(function (entry) {
  return new URL(entry, self.location).href;
});
var INDEX_URL = new URL('./index.html', self.location).href;
var OFFLINE_URL = new URL('./offline.html', self.location).href;

// Last-resort navigation body, used only if offline.html itself is not cached.
var OFFLINE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="color-scheme" content="dark light"><title>Offline</title></head>' +
  '<body style="margin:0;display:flex;align-items:center;justify-content:center;' +
  'min-height:100vh;font:16px/1.5 system-ui,sans-serif;background:#111;color:#eee">' +
  '<main style="max-width:34rem;margin:1.5rem;padding:2rem;text-align:center">' +
  '<h1 style="font-size:1.3rem">You are offline</h1>' +
  '<p>You are offline and this page was not cached.</p>' +
  '<p><button type="button" onclick="location.reload()" ' +
  'style="font:inherit;padding:.5rem 1rem;cursor:pointer">Retry</button></p>' +
  '</main></body></html>';

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function isHttp(url) {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function requestUrl(request) {
  try {
    return new URL(typeof request === 'string' ? request : request.url);
  } catch (err) {
    return null;
  }
}

/* ---------------------------------------------------------------- install */

self.addEventListener('install', function (event) {
  event.waitUntil(
    (async function () {
      if (ASSET_URLS.length === 0) {
        // No generated manifest (local dev / broken build): still activate so
        // the worker is never stuck waiting.
        console.warn('[sw] __SW_ASSETS__ is missing or empty — nothing precached');
      } else {
        const cache = await caches.open(CACHE);
        await cache.addAll(ASSET_URLS);
        console.log('[sw] precached ' + ASSET_URLS.length + ' assets into ' + CACHE);
      }
      await self.skipWaiting();
    })()
  );
});

/* --------------------------------------------------------------- activate */

self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(function (key) { return key !== CACHE; })
          .map(function (key) { return caches.delete(key); })
      );
      await self.clients.claim();
    })()
  );
});

/* ------------------------------------------------------------------ fetch */

// Navigations: cache-first (the exact request, then ./index.html), then the
// network without caching it (keeps index.html from going stale behind the
// worker), then ./offline.html from the cache.
async function navigationResponse(request) {
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    const index = await cache.match(INDEX_URL, { ignoreSearch: true });
    if (index) return index;
  } catch (err) {
    // Cache unavailable — fall through to the network.
  }

  try {
    return await fetch(request);
  } catch (err) {
    let offline = null;
    try {
      const cache = await caches.open(CACHE);
      offline = await cache.match(OFFLINE_URL, { ignoreSearch: true });
    } catch (err2) {
      offline = null;
    }
    return offline || offlineResponse();
  }
}

// build-info.json: always prefer the network so the UI shows the fresh version,
// but keep a copy for offline use.
async function networkFirstResponse(request) {
  const cache = await caches.open(CACHE);
  let response;
  try {
    response = await fetch(request);
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
  if (response && response.ok && response.status !== 206) {
    try {
      await cache.put(request, response.clone());
    } catch (err) {
      // Non-fatal: the response is still returned to the page.
    }
  }
  return response;
}

// Everything else same-origin: cache-first, then network (and cache the result).
async function cacheFirstResponse(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;

  const response = await fetch(request);
  if (response && response.ok && response.status !== 206 && response.type !== 'opaque') {
    try {
      await cache.put(request, response.clone());
    } catch (err) {
      // Non-fatal: the response is still returned to the caller.
    }
  }
  return response;
}

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (!request || request.method !== 'GET') return; // let the browser handle it

  const url = requestUrl(request);
  if (!url || !isHttp(url)) return; // data:, blob:, ... — untouched

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }

  if (url.origin !== self.location.origin) {
    // Cross-origin: plain fetch, never cached (there should be none).
    event.respondWith(fetch(request));
    return;
  }

  if (url.pathname.endsWith('/build-info.json')) {
    event.respondWith(networkFirstResponse(request));
    return;
  }

  event.respondWith(cacheFirstResponse(request));
});
