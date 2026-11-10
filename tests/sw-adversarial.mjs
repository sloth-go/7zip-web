#!/usr/bin/env node
/*
 * Adversarial verification of <repo>/sw.js, offline.html and
 * manifest.webmanifest (the repo root is derived from this file's location).
 *
 * Extends sw-test.mjs with:
 *   (a) cache-version rollover: install v1 assets, re-run sw.js against a v2
 *       fixture manifest (same URLs, new bytes), activate -> v1 cache deleted,
 *       v2 present, offline fetches serve the NEW bytes.
 *   (b) addAll rejects (one asset 404s / fully offline) -> install waitUntil
 *       promise REJECTS, skipWaiting NOT called, nothing half-cached.
 *   (c) missing __SW_ASSETS__ (importScripts threw, empty manifest, non-array)
 *       -> install still resolves (dev guard), skipWaiting called, 0 fetches.
 *   (d) non-ok network responses for same-origin misses (404, 500, 206
 *       partial, opaque) -> returned but cache.put NEVER called; positive
 *       control (200) IS cached; build-info.json 404 not cached; POST/PUT
 *       untouched.
 *   (e) navigation with query string while offline -> still served from cache
 *       (ignoreSearch / index.html fallback); offline.html fallback when index
 *       is absent.
 *   (g) share_target POST adversarial: URL look-alikes that must NOT be treated
 *       as the share endpoint, hostile file names, non-Blob form fields, an
 *       empty file list, a cache API that rejects, and the guarantee that the
 *       fixed-name shared cache survives a version rollover.
 *
 *   Plus static contract scans of sw.js / offline.html / manifest.webmanifest
 *   and PNG IHDR dimension checks for the four icons.
 *
 * Usage: node tests/sw-adversarial.mjs   (from the repo root; any cwd works)
 *        exit 0 = all pass
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Repo root derived from this file's own location (tests/..), so the suite runs
// from any checkout path and any cwd.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW_PATH = path.join(REPO, 'sw.js');
const OFFLINE_PATH = path.join(REPO, 'offline.html');
const MANIFEST_PATH = path.join(REPO, 'manifest.webmanifest');
const INDEX_PATH = path.join(REPO, 'index.html');

const SITE_BASE = 'https://example.github.io/7zip-web/';
const SW_URL = SITE_BASE + 'sw.js';
// The fixed-name cache sw.js keeps across version rollovers, and the endpoint
// the manifest share_target POSTs to.
const SHARED_CACHE = '7zip-web-shared';
const SHARE_URL = SITE_BASE + '__share';

/* ---------------------------------------------------------------- reporting */

let passCount = 0;
let failCount = 0;
let knownIssueCount = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    passCount++;
    console.log('PASS  ' + name);
  } else {
    failCount++;
    const detail = extra === undefined ? '' : ' -- ' + extra;
    failures.push(name + detail);
    console.log('FAIL  ' + name + detail);
  }
}

// Pins a deviation found in the site (which this suite may NOT fix: site files
// are read-only here). While the deviation is present it prints KNOWN and stays
// out of the pass/fail counts; the day the site is hardened it prints FIXED and
// counts as a pass, so the maintainer is told to promote it to a real check().
function knownIssue(name, stillPresent, extra) {
  if (stillPresent) {
    knownIssueCount++;
    console.log('KNOWN ' + name + (extra ? '  -- ' + extra : ''));
  } else {
    passCount++;
    console.log('FIXED ' + name + ' (promote this to a real check)');
  }
}

function section(title) {
  console.log('\n== ' + title + ' ==');
}

/* ------------------------------------------------------------------ helpers */

function urlOf(request) {
  if (typeof request === 'string') return request;
  if (request instanceof URL) return request.href;
  return request.url;
}

function cacheKey(request, ignoreSearch) {
  const u = new URL(urlOf(request));
  u.hash = '';
  if (ignoreSearch) u.search = '';
  return u.href;
}

async function settled(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

async function settledResponse(state) {
  const res = await settled(state.promise);
  if (!res.ok) {
    return {
      responded: state.responded,
      respondWithCalls: state.respondWithCalls,
      ok: false,
      error: res.error,
      detail: String((res.error && res.error.message) || res.error),
      status: null,
      body: null,
      contentType: null
    };
  }
  const response = res.value;
  return {
    responded: state.responded,
    respondWithCalls: state.respondWithCalls,
    ok: true,
    error: null,
    detail: 'status ' + response.status,
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get('content-type')
  };
}

/* ----------------------------------------------------------- mock Cache API */

class MockCache {
  constructor(name, world) {
    this.name = name;
    this.world = world;
    this.entries = new Map(); // cacheKey -> { url, body, status, statusText, headers }
  }

  async put(request, response) {
    if (!response) throw new TypeError('put: response required');
    if (response.status === 206) throw new TypeError('put: partial response');
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    const body = new Uint8Array(await response.arrayBuffer());
    const key = cacheKey(request, false);
    this.entries.set(key, { url: key, body, status: response.status, statusText: response.statusText, headers });
    return undefined;
  }

  async match(request, options = {}) {
    const target = cacheKey(request, !!options.ignoreSearch);
    for (const [key, entry] of this.entries) {
      const entryKey = options.ignoreSearch ? cacheKey(key, true) : key;
      if (entryKey === target) return this._response(entry);
    }
    return undefined;
  }

  async matchAll(request, options = {}) {
    if (request === undefined) {
      return [...this.entries.values()].map((entry) => this._response(entry));
    }
    const hit = await this.match(request, options);
    return hit ? [hit] : [];
  }

  async add(request) {
    return this.addAll([request]);
  }

  // Mirrors the real spec: fetch everything first, put only on total success
  // (atomic — a failure must not leave a half-populated cache).
  async addAll(requests) {
    const list = [...requests];
    const responses = [];
    for (const request of list) {
      const response = await this.world.fetch(request);
      if (!response || !response.ok) {
        throw new TypeError('addAll: bad response for ' + urlOf(request));
      }
      responses.push(response);
    }
    for (let i = 0; i < list.length; i++) {
      await this.put(urlOf(list[i]), responses[i]);
    }
    return undefined;
  }

  async delete(request) {
    return this.entries.delete(cacheKey(request, false));
  }

  async keys() {
    return [...this.entries.values()].map((entry) => new Request(entry.url));
  }

  _response(entry) {
    return new Response(entry.body.slice(), {
      status: entry.status,
      statusText: entry.statusText,
      headers: entry.headers
    });
  }
}

function createCacheStorage(world) {
  return {
    async open(name) {
      let cache = world.store.get(name);
      if (!cache) {
        cache = new MockCache(name, world);
        // put spy: counts every cache.put the SW actually performs.
        const origPut = cache.put.bind(cache);
        cache.put = async (request, response) => {
          world.putCalls.push(cacheKey(request, false));
          return origPut(request, response);
        };
        world.store.set(name, cache);
      }
      return cache;
    },
    async has(name) { return world.store.has(name); },
    async delete(name) { return world.store.delete(name); },
    async keys() { return [...world.store.keys()]; },
    async match(request, options) {
      for (const name of world.store.keys()) {
        const hit = await world.store.get(name).match(request, options);
        if (hit) return hit;
      }
      return undefined;
    }
  };
}

/* --------------------------------------------------------- mock SW requests */

function makeRequest(url, { method = 'GET', mode = 'cors', headers } = {}) {
  const init = { method, headers: new Headers(headers) };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = 'payload';
    init.duplex = 'half';
  }
  const href = String(new URL(url, SITE_BASE));
  if (mode === 'navigate') {
    // undici refuses mode:'navigate'; browsers only set it on real navigations.
    return { url: href, method, mode: 'navigate', destination: 'document', referrer: '', headers: init.headers };
  }
  return new Request(href, init);
}

/* ------------------------------------------------------------- mock world */

function manifestSource(version, assets) {
  return 'self.__SW_VERSION__ = ' + JSON.stringify(version) + ';\n' +
    'self.__SW_ASSETS__ = ' + JSON.stringify(assets, null, 2) + ';\n';
}

// options: { manifest: string|null (null = importScripts 404s), store: shared Map }
function createWorld({ manifest = manifestSource('v0', []), store = new Map() } = {}) {
  const world = {
    listeners: new Map(),
    store,
    fetchCalls: [],
    fetchImpl: null,
    skipWaitingCalls: 0,
    claimCalls: 0,
    importScriptsCalls: [],
    logs: [],
    warnings: [],
    putCalls: []
  };

  const cachesApi = createCacheStorage(world);

  const sandbox = {
    console: {
      log: (...args) => world.logs.push(args.join(' ')),
      info: (...args) => world.logs.push(args.join(' ')),
      warn: (...args) => world.warnings.push(args.join(' ')),
      error: (...args) => world.warnings.push(args.join(' '))
    },
    URL, Request, Response, Headers, TextEncoder, TextDecoder, AbortController,
    // The share_target branch builds and inspects multipart bodies: same-realm
    // constructors so `value instanceof Blob` inside sw.js works on our Files.
    FormData, Blob, File,
    caches: cachesApi,
    addEventListener(type, handler) {
      const list = world.listeners.get(type) || [];
      list.push(handler);
      world.listeners.set(type, list);
    },
    removeEventListener() {},
    importScripts(...urls) {
      for (const url of urls) {
        world.importScriptsCalls.push(String(url));
        if (manifest === null) throw new Error('Failed to load ' + url + ' (404)');
        vm.runInContext(manifest, world.ctx, { filename: String(url) });
      }
    },
    skipWaiting: async () => { world.skipWaitingCalls++; },
    clients: {
      claim: async () => { world.claimCalls++; },
      matchAll: async () => [],
      get: async () => undefined
    },
    location: new URL(SW_URL)
  };
  sandbox.fetch = (...args) => {
    world.fetchCalls.push(urlOf(args[0]));
    return Promise.resolve().then(() => world.fetchImpl(...args));
  };
  sandbox.self = sandbox;
  world.fetch = sandbox.fetch; // MockCache.addAll uses this, like the real spec
  world.sandbox = sandbox;
  world.cachesApi = cachesApi;

  const ctx = vm.createContext(sandbox);
  world.ctx = ctx;
  world.load = () => vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), ctx, { filename: SW_PATH });
  return world;
}

// url -> body map responder; anything unmapped 404s. Content-Type inferred
// from the extension, like a real static host (GitHub Pages) would serve it.
function contentTypeFor(url) {
  if (/\.html(\?|#|$)/.test(url)) return 'text/html; charset=utf-8';
  if (/\.json(\?|#|$)/.test(url)) return 'application/json';
  if (/\.wasm(\?|#|$)/.test(url)) return 'application/wasm';
  return 'text/plain; charset=utf-8';
}

function goOnlineMap(world, map) {
  world.fetchImpl = async (request) => {
    const url = urlOf(request);
    if (Object.prototype.hasOwnProperty.call(map, url)) {
      return new Response(map[url], { status: 200, headers: { 'Content-Type': contentTypeFor(url) } });
    }
    return new Response('NOT FOUND ' + url, { status: 404, headers: { 'Content-Type': 'text/plain' } });
  };
}

function goOnlineEcho(world) {
  world.fetchImpl = async (request) =>
    new Response('NET ' + urlOf(request), { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

function goOffline(world) {
  world.fetchImpl = () => { throw new TypeError('Failed to fetch (offline)'); };
}

function dispatch(world, type, event) {
  const handlers = world.listeners.get(type) || [];
  for (const handler of handlers) handler.call(world.sandbox, event);
  return handlers.length;
}

function fireLifecycle(world, type) {
  const state = { promises: [] };
  state.handlerCount = dispatch(world, type, { type, waitUntil: (p) => state.promises.push(p) });
  state.done = Promise.all(state.promises);
  return state;
}

function fireFetch(world, request) {
  const state = { responded: false, promise: null, respondWithCalls: 0 };
  state.handlerCount = dispatch(world, 'fetch', {
    type: 'fetch',
    request,
    clientId: 'client-1',
    resultingClientId: 'client-1',
    preloadResponse: Promise.resolve(undefined),
    waitUntil: () => {},
    respondWith: (p) => {
      state.respondWithCalls++;
      if (state.responded) throw new Error('respondWith called twice');
      state.responded = true;
      state.promise = p;
    }
  });
  return state;
}

function totalEntries(world) {
  let n = 0;
  for (const cache of world.store.values()) n += cache.entries.size;
  return n;
}

function cacheNames(world) {
  return [...world.store.keys()].sort();
}

function abs(rel) {
  return new URL(rel, SITE_BASE).href;
}

/* --------------------------------------------------- source-level scanning */

function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i + 2);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/* ================================ (3) static contract review of the files == */

section('static review: sw.js');

const swSource = fs.readFileSync(SW_PATH, 'utf8');
const swCode = stripComments(swSource);

check('sw.js parses as a classic script', (() => {
  try { new vm.Script(swSource, { filename: SW_PATH }); return true; } catch (e) { return false; }
})());
check('sw.js: no http(s):// literal anywhere', !/https?:\/\//i.test(swSource));
check("sw.js: importScripts is relative './sw-manifest.js'", /importScripts\(\s*'\.\/sw-manifest\.js'\s*\)/.test(swCode));
check("sw.js: cache name = '7zip-web-' + (self.__SW_VERSION__ || 'dev')", swCode.includes("'7zip-web-' + (self.__SW_VERSION__ || 'dev')"));
check('sw.js: precache URLs resolved via new URL(entry, self.location).href', /new URL\(entry,\s*self\.location\)\.href/.test(swCode.replace(/\s+/g, ' ')) || /new URL\(entry, self\.location\)\.href/.test(swSource));
check("sw.js: './index.html' fallback URL present", swCode.includes("'./index.html'"));
check("sw.js: './offline.html' fallback URL present", swCode.includes("'./offline.html'"));
check('sw.js: install/activate/fetch listeners all registered',
  /addEventListener\('install'/.test(swCode) && /addEventListener\('activate'/.test(swCode) && /addEventListener\('fetch'/.test(swCode));
check('sw.js: install chain calls skipWaiting', /self\.skipWaiting\(\)/.test(swCode));
check('sw.js: activate calls clients.claim', /self\.clients\.claim\(\)/.test(swCode));
check('sw.js: only GET and POST are considered, and the gate precedes any respondWith',
  swCode.indexOf("request.method !== 'GET' && request.method !== 'POST'") !== -1 &&
  swCode.indexOf("request.method !== 'POST'") < swCode.indexOf('respondWith'),
  'gate index=' + swCode.indexOf("request.method !== 'POST'") +
    ' first respondWith=' + swCode.indexOf('respondWith'));
check("sw.js: the fixed-name shared cache is '7zip-web-shared'",
  swCode.includes("var SHARED_CACHE = '7zip-web-shared';"), '');
check("sw.js: the share endpoint is derived relatively (new URL('./__share', self.location))",
  /new URL\('\.\/__share',\s*self\.location\)/.test(swCode));
check('sw.js: activate keeps BOTH the current cache and the shared cache',
  /key !== CACHE && key !== SHARED_CACHE/.test(swCode.replace(/\s+/g, ' ')) ||
  /key!==CACHE&&key!==SHARED_CACHE/.test(swCode.replace(/\s+/g, '')),
  'no `key !== CACHE && key !== SHARED_CACHE` filter found');
check('sw.js: the POST branch runs before the navigation branch (a share POST is a navigation)',
  swCode.indexOf("request.method === 'POST'") !== -1 &&
  swCode.indexOf("request.method === 'POST'") < swCode.indexOf("request.mode === 'navigate'"),
  'POST branch=' + swCode.indexOf("request.method === 'POST'") +
    ' navigate branch=' + swCode.indexOf("request.mode === 'navigate'"));
// Exact pathname equality only: a fuzzy match would let ./__shared/x or
// ./__share/../admin be hijacked as the share endpoint. (The unrelated
// build-info.json endsWith() routing is deliberately not scanned here.)
const shareLines = swCode.split('\n').filter((l) => l.includes('SHARE_URL') || l.includes("'./__share'"));
check('sw.js: the share pathname is matched with === (no startsWith/includes/endsWith)',
  /url\.pathname === SHARE_URL\.pathname/.test(swCode) &&
  shareLines.length > 0 &&
  !shareLines.some((l) => /pathname\.(startsWith|includes|endsWith)\(/.test(l)),
  JSON.stringify(shareLines.map((l) => l.trim())));
check('sw.js: the share answer is a 303 redirect to the site root',
  /status:\s*303/.test(swCode) && /Location:/.test(swCode.replace(/\s+/g, ' ')));
check("sw.js: shared files land under './__shared/<i>' with an X-File-Name header",
  swCode.includes("'./__shared/' + i") && swCode.includes("'X-File-Name'") &&
  swCode.includes("'./__shared/count'"));
check('sw.js: a share failure is caught (console.warn) so the redirect always happens',
  /console\.warn\(/.test(swCode) && /catch/.test(swCode));
check('sw.js: only http/https handled', /protocol === 'http:'/.test(swCode) && /protocol === 'https:'/.test(swCode));
check('sw.js: navigation uses ignoreSearch cache match', /ignoreSearch:\s*true/.test(swCode));
check('sw.js: build-info.json routed network-first', /build-info\.json/.test(swCode) && /networkFirstResponse/.test(swCode));
check('sw.js: cross-origin branch never touches caches', (() => {
  const i = swCode.indexOf('url.origin !== self.location.origin');
  if (i === -1) return false;
  const branch = swCode.slice(i, swCode.indexOf('}', swCode.indexOf('respondWith', i)) + 1);
  return /respondWith\(fetch\(request\)\)/.test(branch.replace(/\s+/g, '')) || /respondWith\(\s*fetch\(request\)\s*\)/.test(branch);
})());
check('sw.js: network responses cached only when response.ok (and non-opaque)', /response\.ok/.test(swCode) && /type !== 'opaque'/.test(swCode));

section('static review: offline.html');

const offlineSource = fs.readFileSync(OFFLINE_PATH, 'utf8');
check('offline.html: no external http(s) URLs', !/https?:\/\//i.test(offlineSource));
check('offline.html: no resource reference to app.js / worker.js / sw.js / wasm files / manifest',
  !/app\.js|worker\.js|sw\.js|\.wasm\b|wasm\/|manifest/i.test(offlineSource));
check('offline.html: product name "7-Zip WASM" allowed as prose only (sanity)',
  /7-Zip WASM/.test(offlineSource));
check('offline.html: no external <script src> and no <link rel=stylesheet>',
  !/<script[^>]+src=/i.test(offlineSource) && !/<link[^>]+stylesheet/i.test(offlineSource));
check('offline.html: CSS is inline (<style> block present)', /<style>[\s\S]*<\/style>/i.test(offlineSource));
check('offline.html: has a retry mechanism (location.reload)', /location\.reload\(\)/.test(offlineSource));
check('offline.html: all href/src attributes are relative "./" URLs', (() => {
  const refs = [...offlineSource.matchAll(/(?:href|src)\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
  return refs.length > 0 && refs.every((r) => r.startsWith('./'));
})());
check('offline.html: every referenced local file exists on disk', (() => {
  const refs = [...offlineSource.matchAll(/(?:href|src)\s*="\.\?\/?([^"]*)"/gi)].map((m) => m[1].replace(/^\.\//, ''));
  const files = [...offlineSource.matchAll(/(?:href|src)\s*="\.\/([^"]*)"/gi)].map((m) => REPO + '/' + m[1]);
  void refs;
  return files.length > 0 && files.every((f) => fs.existsSync(f));
})());
check('offline.html: has theme-color meta', /<meta\s+name="theme-color"\s+content="#[0-9a-fA-F]{6}">/i.test(offlineSource));

section('static review: manifest.webmanifest');

const webmanifestSource = fs.readFileSync(MANIFEST_PATH, 'utf8');
let manifestJson = null;
check('manifest.webmanifest: strict JSON parses', (() => {
  try { manifestJson = JSON.parse(webmanifestSource); return true; } catch (e) { return false; }
})());
check('manifest.webmanifest: no external http(s) URLs', !/https?:\/\//i.test(webmanifestSource));

if (manifestJson) {
  check("manifest: name === '7-Zip WASM'", manifestJson.name === '7-Zip WASM');
  check("manifest: short_name === '7-Zip'", manifestJson.short_name === '7-Zip');
  check("manifest: start_url === './'", manifestJson.start_url === './');
  check("manifest: scope === './'", manifestJson.scope === './');
  check("manifest: display === 'standalone'", manifestJson.display === 'standalone');
  check('manifest: background_color present', typeof manifestJson.background_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(manifestJson.background_color));

  const indexSource = fs.readFileSync(INDEX_PATH, 'utf8');
  const metaTheme = (indexSource.match(/<meta\s+name="theme-color"\s+content="([^"]+)"/i) || [])[1];
  check('manifest: theme_color matches index.html theme-color meta (' + metaTheme + ')',
    manifestJson.theme_color === metaTheme);

  const icons = manifestJson.icons || [];
  check('manifest: exactly 4 icons', icons.length === 4);
  const expected = [
    { src: './icons/icon-16.png', sizes: '16x16', type: 'image/png', purpose: undefined, dim: 16 },
    { src: './icons/icon-32.png', sizes: '32x32', type: 'image/png', purpose: undefined, dim: 32 },
    { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any', dim: 192 },
    { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable', dim: 512 }
  ];
  for (const exp of expected) {
    const icon = icons.find((i) => i.src === exp.src);
    check('manifest icon ' + exp.src + ': present with sizes/type' + (exp.purpose ? '/purpose ' + exp.purpose : ''),
      !!icon && icon.sizes === exp.sizes && icon.type === exp.type &&
      (exp.purpose === undefined ? true : icon.purpose === exp.purpose));
    if (icon) {
      const file = path.join(REPO, exp.src.slice(2));
      let dims = null;
      try {
        const b = fs.readFileSync(file);
        if (b.readUInt32BE(0) === 0x89504e47) dims = { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
      } catch (e) { dims = null; }
      check('manifest icon ' + exp.src + ': file exists and real PNG dimensions are ' + exp.dim + 'x' + exp.dim,
        !!dims && dims.w === exp.dim && dims.h === exp.dim,
        dims ? 'actual ' + dims.w + 'x' + dims.h : 'missing/not a PNG');
    }
  }

  /* ---- PWA file handling: share_target (Android share sheet -> SW POST) --- */
  const st = manifestJson.share_target;
  check('manifest: share_target present', !!st, JSON.stringify(Object.keys(manifestJson)));
  if (st) {
    check("manifest share_target: action is the relative './__share'", st.action === './__share', String(st.action));
    check('manifest share_target: action resolves to the URL sw.js intercepts',
      new URL(st.action, SITE_BASE).href === SHARE_URL, new URL(st.action, SITE_BASE).href);
    check("manifest share_target: method POST + multipart/form-data (a GET share would leak file bodies)",
      st.method === 'POST' && st.enctype === 'multipart/form-data',
      JSON.stringify({ method: st.method, enctype: st.enctype }));
    const filesParam = st.params && Array.isArray(st.params.files) ? st.params.files[0] : null;
    check("manifest share_target: files field is named 'files'",
      !!filesParam && filesParam.name === 'files', JSON.stringify(st.params));
    check("manifest share_target: sw.js reads the SAME field name it declares",
      !!filesParam && swSource.includes("getAll('" + filesParam.name + "')"),
      filesParam ? filesParam.name : 'n/a');
    check("manifest share_target: accepts any file type ('*/*'), so odd archives are not rejected by the OS",
      !!filesParam && Array.isArray(filesParam.accept) && filesParam.accept.includes('*/*'),
      JSON.stringify(filesParam && filesParam.accept));
    check('manifest share_target: the optional text params are declared',
      !!st.params && st.params.title === 'title' && st.params.text === 'text' && st.params.url === 'url',
      JSON.stringify(st.params));
  }

  /* ---- PWA file handling: file_handlers (desktop "Open with") ------------- */
  const fh = manifestJson.file_handlers;
  check('manifest: file_handlers present and a non-empty array',
    Array.isArray(fh) && fh.length === 1, JSON.stringify(fh));
  if (Array.isArray(fh) && fh[0]) {
    const handler = fh[0];
    check("manifest file_handlers: action is relative ('./') and inside the manifest scope",
      typeof handler.action === 'string' && handler.action.startsWith('./') &&
      new URL(handler.action, SITE_BASE).href.startsWith(new URL(manifestJson.scope || './', SITE_BASE).href),
      String(handler.action));
    const accept = handler.accept || {};
    const mimes = Object.keys(accept);
    check('manifest file_handlers: declares the archive MIME types the app can actually open (' + mimes.length + ')',
      mimes.length >= 5 &&
      ['application/x-7z-compressed', 'application/zip'].every((m) => mimes.includes(m)),
      JSON.stringify(mimes));
    const exts = [].concat(...Object.values(accept).map((v) => (Array.isArray(v) ? v : [v])));
    check('manifest file_handlers: every extension is a lowercase dotted string, no duplicates',
      exts.length > 0 && exts.every((e) => typeof e === 'string' && /^\.[a-z0-9]+$/.test(e)) &&
      new Set(exts).size === exts.length,
      JSON.stringify(exts));
    check('manifest file_handlers: .7z and .zip are covered',
      exts.includes('.7z') && exts.includes('.zip'), JSON.stringify(exts));
    check("manifest file_handlers: launch_type is a spec value ('single-client' | 'multiple-clients')",
      handler.launch_type === 'single-client' || handler.launch_type === 'multiple-clients',
      String(handler.launch_type));
  }

  /* ---- every manifest URL stays relative (works from any subpath) --------- */
  const urlStrings = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') return Object.values(node).forEach(walk);
    if (typeof node === 'string') urlStrings.push(node);
  })(manifestJson);
  check('manifest: no absolute or protocol-relative URL anywhere',
    !urlStrings.some((v) => /^([a-z][a-z0-9+.-]*:)?\/\//i.test(v) || v.startsWith('/')),
    JSON.stringify(urlStrings.filter((v) => /^([a-z][a-z0-9+.-]*:)?\/\//i.test(v) || v.startsWith('/'))));
}

/* =============================== (a) cache-version rollover (v1 -> v2) ===== */

section('(a) cache-version rollover: weekly wasm rebuild, same URLs, new bytes');

const ROLLOVER_ASSETS = ['./index.html', './offline.html', './wasm/7zz.wasm'];
const V1 = manifestSource('26.05-2026-11-02T04:00:00Z', ROLLOVER_ASSETS);
const V2 = manifestSource('26.06-2026-11-09T04:00:00Z', ROLLOVER_ASSETS);
const CACHE_V1 = '7zip-web-26.05-2026-11-02T04:00:00Z';
const CACHE_V2 = '7zip-web-26.06-2026-11-09T04:00:00Z';
const sharedStore = new Map();

{
  // --- v1 install + activate ------------------------------------------------
  const w1 = createWorld({ manifest: V1, store: sharedStore });
  goOnlineMap(w1, {
    [abs('./index.html')]: 'INDEX-V1',
    [abs('./offline.html')]: 'OFFLINE-V1',
    [abs('./wasm/7zz.wasm')]: 'WASM-BYTES-V1'
  });
  // A share left over from before the weekly rebuild: files the user handed us
  // but has not opened yet. It must survive BOTH activates.
  {
    const shared = await w1.cachesApi.open(SHARED_CACHE);
    await shared.put(abs('./__shared/0'), new Response('ROLLOVER-SHARED-FILE', {
      status: 200,
      headers: { 'Content-Type': 'application/x-7z-compressed', 'X-File-Name': 'pending.7z' }
    }));
    await shared.put(abs('./__shared/count'), new Response('1', {
      status: 200, headers: { 'Content-Type': 'text/plain' }
    }));
  }
  w1.load();
  const inst1 = fireLifecycle(w1, 'install');
  const r1 = await settled(inst1.done);
  check('(a) v1 install resolved', r1.ok, r1.detail || '');
  check('(a) v1 cache created with exactly the 3 assets',
    sharedStore.has(CACHE_V1) && sharedStore.get(CACHE_V1).entries.size === 3,
    cacheNames(w1).join(','));
  const act1 = fireLifecycle(w1, 'activate');
  await act1.done;
  check('(a) v1 activate kept its own cache', sharedStore.has(CACHE_V1));
  check('(a) v1 activate kept the pending shared file', sharedStore.has(SHARED_CACHE),
    cacheNames(w1).join(','));

  // --- v2: fresh SW script instance, SAME shared cache storage --------------
  const w2 = createWorld({ manifest: V2, store: sharedStore });
  goOnlineMap(w2, {
    [abs('./index.html')]: 'INDEX-V2',
    [abs('./offline.html')]: 'OFFLINE-V2',
    [abs('./wasm/7zz.wasm')]: 'WASM-BYTES-V2'
  });
  w2.load();
  const inst2 = fireLifecycle(w2, 'install');
  const r2 = await settled(inst2.done);
  check('(a) v2 install resolved', r2.ok, r2.detail || '');
  check('(a) v2 cache exists after install', sharedStore.has(CACHE_V2));
  check('(a) v1 cache still present before v2 activate (old SW still serving)',
    sharedStore.has(CACHE_V1));
  check('(a) v2 cache holds the NEW wasm bytes', (() => {
    const entry = sharedStore.get(CACHE_V2).entries.get(abs('./wasm/7zz.wasm'));
    return !!entry && Buffer.from(entry.body).toString() === 'WASM-BYTES-V2';
  })());

  const act2 = fireLifecycle(w2, 'activate');
  const ra2 = await settled(act2.done);
  check('(a) v2 activate resolved', ra2.ok, ra2.detail || '');
  check('(a) v1 cache DELETED by activate', !sharedStore.has(CACHE_V1));
  check('(a) v2 cache SURVIVES activate', sharedStore.has(CACHE_V2));
  check('(a) the shared cache SURVIVES the rollover (fixed name, not versioned)',
    sharedStore.has(SHARED_CACHE), cacheNames(w2).join(','));
  check('(a) the pending shared file bytes are untouched by the rollover', (() => {
    const entry = sharedStore.get(SHARED_CACHE)?.entries.get(abs('./__shared/0'));
    return !!entry && Buffer.from(entry.body).toString() === 'ROLLOVER-SHARED-FILE' &&
      entry.headers['x-file-name'] === 'pending.7z';
  })(), JSON.stringify([...(sharedStore.get(SHARED_CACHE)?.entries.keys() || [])]));
  check('(a) nothing but the new version cache and the shared cache remain',
    cacheNames(w2).join(',') === [CACHE_V2, SHARED_CACHE].sort().join(','), cacheNames(w2).join(','));
  check('(a) v2 activate claimed clients once', w2.claimCalls === 1);

  // --- fully offline on v2: same URL must serve the NEW bytes ---------------
  goOffline(w2);
  const before = w2.fetchCalls.length;
  const wasmReq = fireFetch(w2, makeRequest(abs('./wasm/7zz.wasm')));
  const wasmRes = await settledResponse(wasmReq);
  check('(a) offline after rollover: wasm request served from v2 cache',
    wasmRes.ok && wasmRes.body === 'WASM-BYTES-V2', wasmRes.ok ? wasmRes.body : wasmRes.detail);
  const navReq = fireFetch(w2, makeRequest(SITE_BASE, { mode: 'navigate' }));
  const navRes = await settledResponse(navReq);
  check('(a) offline after rollover: navigation serves v2 index.html',
    navRes.ok && navRes.body === 'INDEX-V2', navRes.ok ? navRes.body : navRes.detail);
  check('(a) offline after rollover: zero network calls', w2.fetchCalls.length === before);
}

/* ============================ (b) addAll rejection: clean install failure == */

section('(b) install with a 404 asset: waitUntil rejects, no skipWaiting, nothing half-cached');

{
  const B_ASSETS = ['./index.html', './offline.html', './wasm/7zz.wasm', './icons/icon-192.png'];
  const w = createWorld({ manifest: manifestSource('b-ver', B_ASSETS) });
  goOnlineMap(w, {
    [abs('./index.html')]: 'B-INDEX',
    [abs('./offline.html')]: 'B-OFFLINE',
    [abs('./wasm/7zz.wasm')]: 'B-WASM'
    // ./icons/icon-192.png intentionally unmapped -> 404
  });
  w.load();
  const inst = fireLifecycle(w, 'install');
  const r = await settled(inst.done);
  check('(b) install waitUntil promise REJECTS when one asset 404s', !r.ok);
  check('(b) skipWaiting NOT called after failed install', w.skipWaitingCalls === 0, 'calls=' + w.skipWaitingCalls);
  check('(b) cache.put never called (no half-caching)', w.putCalls.length === 0, w.putCalls.join(','));
  check('(b) zero entries across all caches after failed install', totalEntries(w) === 0, 'entries=' + totalEntries(w));
  check('(b) no success log emitted', !w.logs.some((l) => /precached/.test(l)));
  check('(b) all 4 assets were attempted over the network', w.fetchCalls.length === 4, 'fetches=' + w.fetchCalls.length);
}

section('(b2) install while fully offline: rejects cleanly too');

{
  const w = createWorld({ manifest: manifestSource('b2-ver', ['./index.html', './offline.html']) });
  goOffline(w);
  w.load();
  const inst = fireLifecycle(w, 'install');
  const r = await settled(inst.done);
  check('(b2) offline install rejects', !r.ok);
  check('(b2) offline install did not skipWaiting', w.skipWaitingCalls === 0);
  check('(b2) offline install cached nothing', totalEntries(w) === 0);
}

/* ================================ (c) missing __SW_ASSETS__ dev guard ===== */

section('(c) missing __SW_ASSETS__: install still resolves (dev guard)');

{
  // c1: importScripts itself fails (sw-manifest.js absent — local dev today)
  const w = createWorld({ manifest: null });
  goOnlineEcho(w);
  let loadedC1 = true;
  try { w.load(); } catch (err) { loadedC1 = false; console.log('  load error: ' + err.message); }
  check('(c1) sw.js loads even when importScripts 404s', loadedC1);
  check('(c1) a warning was logged about the missing manifest', w.warnings.length >= 1);
  const inst = fireLifecycle(w, 'install');
  const r = await settled(inst.done);
  check('(c1) install RESOLVES with no manifest', r.ok, r.detail || '');
  check('(c1) skipWaiting still called', w.skipWaitingCalls === 1);
  check('(c1) zero network fetches during install', w.fetchCalls.length === 0);

  const act = fireLifecycle(w, 'activate');
  const ra = await settled(act.done);
  check('(c1) activate resolves with no manifest', ra.ok, ra.detail || '');
  check('(c1) activate claims clients', w.claimCalls === 1);

  // fetch handling must still work (navigation falls through to the network)
  const nav = fireFetch(w, makeRequest(SITE_BASE, { mode: 'navigate' }));
  const navRes = await settledResponse(nav);
  check('(c1) online navigation still served from network in dev-guard mode',
    navRes.ok && navRes.body.startsWith('NET '), navRes.ok ? navRes.body : navRes.detail);
  const cacheNamesAfterFetch = cacheNames(w);
  check('(c1) INFO: dev-guard fetch opened cache "' + cacheNamesAfterFetch.join(',') + '"',
    cacheNamesAfterFetch.every((n) => n === '7zip-web-undefined' || n.startsWith('7zip-web-')),
    'cosmetic: empty cache created lazily by caches.open in fetch paths');

  // c2: importScripts succeeds but the file defines nothing
  const w2 = createWorld({ manifest: '/* empty generated file */\n' });
  goOnlineEcho(w2);
  w2.load();
  const inst2 = fireLifecycle(w2, 'install');
  const r2 = await settled(inst2.done);
  check('(c2) install resolves when manifest defined no globals at all', r2.ok, r2.detail || '');
  check('(c2) skipWaiting called', w2.skipWaitingCalls === 1);
  check('(c2) zero fetches', w2.fetchCalls.length === 0);

  // c3: __SW_ASSETS__ present but not an array
  const w3 = createWorld({ manifest: "self.__SW_VERSION__ = 'c3'; self.__SW_ASSETS__ = './index.html';" });
  goOnlineEcho(w3);
  w3.load();
  const inst3 = fireLifecycle(w3, 'install');
  const r3 = await settled(inst3.done);
  check('(c3) install resolves when __SW_ASSETS__ is a non-array', r3.ok, r3.detail || '');
  check('(c3) skipWaiting called, zero fetches', w3.skipWaitingCalls === 1 && w3.fetchCalls.length === 0);
}

/* =================== (d) non-ok / opaque / partial responses never cached == */

section('(d) same-origin misses with non-ok network responses: returned, never cached');

{
  const w = createWorld({ manifest: manifestSource('d-ver', ['./index.html']) });
  const OPAQUE = {
    ok: false,
    type: 'opaque',
    status: 0,
    statusText: '',
    headers: new Headers(),
    text: async () => '',
    arrayBuffer: async () => new ArrayBuffer(0),
    clone() { return OPAQUE; }
  };
  w.fetchImpl = async (request) => {
    const url = urlOf(request);
    if (url.endsWith('/missing.js')) return new Response('nope', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    if (url.endsWith('/broken.js')) return new Response('boom', { status: 500, headers: { 'Content-Type': 'text/plain' } });
    if (url.endsWith('/partial.js')) return new Response('part', { status: 206, headers: { 'Content-Type': 'text/plain' } });
    if (url.endsWith('/opaque.js')) return OPAQUE;
    if (url.endsWith('/good.js')) return new Response('GOOD', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    if (url.endsWith('/build-info.json')) return new Response('{"version":"404"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    return new Response('?', { status: 418 });
  };
  w.load();
  // NOTE: no install here — everything is a cache miss by construction.
  const dCacheName = '7zip-web-d-ver';

  const cases = [
    { path: './missing.js', status: 404, label: '404' },
    { path: './broken.js', status: 500, label: '500' },
    { path: './opaque.js', status: 0, label: 'opaque (no-cors)' }
  ];
  for (const c of cases) {
    const before = w.putCalls.length;
    const st = fireFetch(w, makeRequest(abs(c.path)));
    const res = await settledResponse(st);
    check('(d) ' + c.label + ' response is passed through to the caller (status ' + c.status + ')',
      res.ok && res.status === c.status, res.ok ? 'status ' + res.status : res.detail);
    check('(d) ' + c.label + ' response (ok === false): cache.put NOT called', w.putCalls.length === before,
      w.putCalls.slice(before).join(','));
  }

  // 206 partial (range) response: per Fetch spec response.ok is TRUE for 206
  // (status 200-299), so the ok-guard lets it through to put(); the platform
  // (real CacheStorage.put) rejects 206 with TypeError and sw.js swallows it
  // non-fatally. The binding outcome: the partial body must never be persisted.
  {
    const before = w.putCalls.length;
    const st = fireFetch(w, makeRequest(abs('./partial.js')));
    const res = await settledResponse(st);
    check('(d) 206 partial (range) response is passed through to the caller',
      res.ok && res.status === 206 && res.body === 'part', res.ok ? 'status ' + res.status : res.detail);
    const attempted = w.putCalls.length > before;
    check('(d) 206 partial response NOT persisted in the cache',
      !w.store.has('7zip-web-d-ver') || !w.store.get('7zip-web-d-ver').entries.has(abs('./partial.js')),
      'entries=' + [...(w.store.get('7zip-web-d-ver')?.entries.keys() || [])].join(','));
    check('(d) INFO: 206 put ' + (attempted ?
      'was ATTEMPTED (ok===true); safe only because spec CacheStorage.put rejects 206 — caught non-fatally' :
      'was not attempted (explicit status guard present)'), true);
  }

  check('(d) cache holds zero entries after all non-ok responses',
    !w.store.has(dCacheName) || w.store.get(dCacheName).entries.size === 0,
    'entries=' + totalEntries(w));

  // build-info.json 404: network-first must not cache the failure
  const biBefore = w.putCalls.length;
  const bi = fireFetch(w, makeRequest(abs('./build-info.json')));
  const biRes = await settledResponse(bi);
  check('(d) build-info.json 404 passed through', biRes.ok && biRes.status === 404, biRes.ok ? 'status ' + biRes.status : biRes.detail);
  check('(d) build-info.json 404 NOT cached', w.putCalls.length === biBefore);

  // positive control: a 200 miss IS cached exactly once
  const good = fireFetch(w, makeRequest(abs('./good.js')));
  const goodRes = await settledResponse(good);
  check('(d) positive control: 200 miss served', goodRes.ok && goodRes.body === 'GOOD');
  check('(d) positive control: 200 miss cached via exactly one put',
    w.putCalls.length === biBefore + 1 && w.putCalls[biBefore] === abs('./good.js'),
    w.putCalls.join(','));
  check('(d) positive control: entry now in cache',
    w.store.has(dCacheName) && w.store.get(dCacheName).entries.size === 1);

  // non-GET: untouched entirely
  const putBefore = w.putCalls.length;
  const fetchBefore = w.fetchCalls.length;
  const post = fireFetch(w, makeRequest(abs('./good.js'), { method: 'POST' }));
  check('(d) POST: no respondWith', post.respondWithCalls === 0 && !post.responded);
  const put = fireFetch(w, makeRequest(abs('./good.js'), { method: 'PUT' }));
  check('(d) PUT: no respondWith', put.respondWithCalls === 0 && !put.responded);
  check('(d) POST/PUT: nothing cached, nothing fetched',
    w.putCalls.length === putBefore && w.fetchCalls.length === fetchBefore,
    'puts=' + (w.putCalls.length - putBefore) + ' fetches=' + (w.fetchCalls.length - fetchBefore));
}

/* ================= (e) navigation with query string while offline ========= */

section('(e) navigation requests with query strings offline');

{
  const E_ASSETS = ['./index.html', './offline.html'];
  const w = createWorld({ manifest: manifestSource('e-ver', E_ASSETS) });
  goOnlineMap(w, {
    [abs('./index.html')]: 'E-INDEX',
    [abs('./offline.html')]: 'E-OFFLINE-PAGE'
  });
  w.load();
  const inst = fireLifecycle(w, 'install');
  const ri = await settled(inst.done);
  check('(e) install resolved', ri.ok, ri.detail || '');
  fireLifecycle(w, 'activate');
  goOffline(w);
  const before = w.fetchCalls.length;

  const q1 = fireFetch(w, makeRequest(abs('./index.html?v=2'), { mode: 'navigate' }));
  const r1 = await settledResponse(q1);
  check('(e) offline "./index.html?v=2" served from cache (ignoreSearch)',
    r1.ok && r1.body === 'E-INDEX', r1.ok ? r1.body : r1.detail);

  const q2 = fireFetch(w, makeRequest(abs('./?v=2'), { mode: 'navigate' }));
  const r2res = await settledResponse(q2);
  check('(e) offline "./?v=2" falls back to cached index.html',
    r2res.ok && r2res.body === 'E-INDEX', r2res.ok ? r2res.body : r2res.detail);

  const q3 = fireFetch(w, makeRequest(abs('./deep/path?v=2&x=1'), { mode: 'navigate' }));
  const r3 = await settledResponse(q3);
  check('(e) offline deep link with query falls back to cached index.html',
    r3.ok && r3.body === 'E-INDEX', r3.ok ? r3.body : r3.detail);

  const q4 = fireFetch(w, makeRequest(abs('./index.html#frag'), { mode: 'navigate' }));
  const r4 = await settledResponse(q4);
  check('(e) offline navigation with fragment served from cache',
    r4.ok && r4.body === 'E-INDEX', r4.ok ? r4.body : r4.detail);

  check('(e) zero network calls for any offline navigation', w.fetchCalls.length === before,
    'fetches=' + (w.fetchCalls.length - before));

  // index.html NOT cached -> offline.html must answer the query-string nav
  const w2 = createWorld({ manifest: manifestSource('e2-ver', ['./offline.html']) });
  goOnlineMap(w2, { [abs('./offline.html')]: 'E2-OFFLINE-ONLY' });
  w2.load();
  await fireLifecycle(w2, 'install').done;
  fireLifecycle(w2, 'activate');
  goOffline(w2);
  const q5 = fireFetch(w2, makeRequest(abs('./index.html?v=2'), { mode: 'navigate' }));
  const r5 = await settledResponse(q5);
  check('(e2) offline nav with query and no cached index -> cached offline.html served',
    r5.ok && r5.body === 'E2-OFFLINE-ONLY', r5.ok ? r5.body : r5.detail);
  check('(e2) offline.html served as text/html',
    r5.ok && /text\/html/i.test(r5.contentType || ''), r5.contentType || 'no content-type');
}

/* ============ (g) share_target POST: adversarial shapes ================== */

section('(g) share_target POST: look-alikes, hostile names, quota failure');

// Builds a real multipart Request the way the browser does when the user picks
// "Share -> 7-Zip WASM" from the OS file manager / share sheet.
function shareRequest(files, fields, url) {
  const form = new FormData();
  for (const name of Object.keys(fields || {})) form.append(name, fields[name]);
  for (const file of files) form.append('files', file);
  return new Request(url || SHARE_URL, { method: 'POST', body: form });
}

// Same, but the multipart body never round-trips through a Request: sw.js only
// ever calls request.formData(), so handing it a real FormData directly keeps
// these cases about sw.js logic and not about undici's serializer (which, for
// instance, turns a File whose name is '' into a plain string on append()).
function mockFormRequest(files, fields, url) {
  const form = new FormData();
  for (const name of Object.keys(fields || {})) form.append(name, fields[name]);
  for (const file of files) form.append('files', file);
  return {
    url: url || SHARE_URL,
    method: 'POST',
    mode: 'navigate',
    destination: 'document',
    referrer: '',
    headers: new Headers({ 'Content-Type': 'multipart/form-data' }),
    formData: async () => form
  };
}

// The browser sends the share POST as a NAVIGATION; undici refuses to construct
// one, so the navigation flavour is a plain mock that reuses the real body.
function navShareRequest(files, fields) {
  const real = shareRequest(files, fields);
  return {
    url: real.url,
    method: 'POST',
    mode: 'navigate',
    destination: 'document',
    referrer: '',
    headers: real.headers,
    formData: () => real.formData()
  };
}

function sharedKeys(world) {
  const cache = world.store.get(SHARED_CACHE);
  return cache ? [...cache.entries.keys()].sort() : [];
}

function sharedEntry(world, i) {
  const cache = world.store.get(SHARED_CACHE);
  return cache ? cache.entries.get(abs('./__shared/' + i)) : undefined;
}

const G_ASSETS = ['./index.html', './offline.html'];
const G_CACHE = '7zip-web-g-ver';

/* --- (g1) URLs that merely LOOK like the share endpoint ------------------ */
{
  const w = createWorld({ manifest: manifestSource('g-ver', G_ASSETS) });
  goOnlineMap(w, {
    [abs('./index.html')]: 'G-INDEX',
    [abs('./offline.html')]: 'G-OFFLINE'
  });
  w.load();
  await fireLifecycle(w, 'install').done;
  fireLifecycle(w, 'activate');

  const lookalikes = [
    abs('./__share-x'),
    abs('./__share/'),
    abs('./sub/__share'),
    abs('./__shared/0'),
    abs('./__shared/count'),
    'https://evil.example/__share'
  ];
  let hijacked = [];
  const fetchesBefore = w.fetchCalls.length;
  const putsBefore = w.putCalls.length;
  for (const url of lookalikes) {
    const state = fireFetch(w, shareRequest(
      [new File([new Uint8Array([1, 2, 3])], 'x.7z', { type: 'application/x-7z-compressed' })],
      {}, url));
    await settled(state.promise);
    if (state.respondWithCalls !== 0 || state.responded) hijacked.push(url);
  }
  check('(g1) no look-alike URL is treated as the share endpoint (' + lookalikes.length + ' POSTs)',
    hijacked.length === 0, JSON.stringify(hijacked));
  check('(g1) a cross-origin share POST is not intercepted and not fetched',
    w.fetchCalls.length === fetchesBefore, 'fetches=' + (w.fetchCalls.length - fetchesBefore));
  check('(g1) look-alike POSTs never wrote to any cache',
    w.putCalls.length === putsBefore && !w.store.has(SHARED_CACHE),
    'puts=' + (w.putCalls.length - putsBefore) + ' caches=' + cacheNames(w).join(','));

  // Hardened: the share branch compares url.origin alongside url.pathname, so a
  // cross-origin POST whose path happens to equal our share path is left to the
  // network stack instead of being answered with a 303 to OUR origin — sw.js's
  // "cross-origin requests never touch the caches" invariant holds for POSTs
  // too. (Was pinned as a knownIssue before the origin guard landed in sw.js.)
  {
    const xo = createWorld({ manifest: manifestSource('g-xo-ver', G_ASSETS) });
    goOnlineMap(xo, { [abs('./index.html')]: 'XO-INDEX' });
    xo.load();
    const xoFetchesBefore = xo.fetchCalls.length;
    const xoState = fireFetch(xo, shareRequest(
      [new File([new Uint8Array([8])], 'cross.7z', { type: 'application/x-7z-compressed' })],
      {}, 'https://evil.example/7zip-web/__share'));
    await settled(xoState.promise);
    check('(g1x) a cross-origin POST to the same pathname is NOT hijacked as a share',
      xoState.respondWithCalls === 0 && xoState.responded === false &&
        xo.fetchCalls.length === xoFetchesBefore && !xo.store.has(SHARED_CACHE),
      'respondWithCalls=' + xoState.respondWithCalls +
        ' fetches=' + (xo.fetchCalls.length - xoFetchesBefore) +
        ' sharedKeys=' + JSON.stringify(sharedKeys(xo)));
  }

  // A GET to the share URL is an ordinary same-origin GET: no 303, no shared cache.
  const getState = fireFetch(w, makeRequest(abs('./__share')));
  const getRes = await settledResponse(getState);
  check('(g1) GET ./__share is NOT answered with a share redirect',
    getState.respondWithCalls === 1 && getRes.ok && getRes.status !== 303,
    getRes.ok ? 'status ' + getRes.status : getRes.detail);
  check('(g1) GET ./__share left the shared cache alone', !w.store.has(SHARED_CACHE),
    JSON.stringify(sharedKeys(w)));
  const getNavRes = await settledResponse(fireFetch(w, makeRequest(abs('./__share'), { mode: 'navigate' })));
  check('(g1) a GET navigation to ./__share serves index.html (never a redirect loop)',
    getNavRes.ok && getNavRes.status === 200 && getNavRes.body === 'G-INDEX',
    getNavRes.ok ? getNavRes.status + ' ' + getNavRes.body.slice(0, 40) : getNavRes.detail);
  check('(g1) the app-shell cache never receives ./__shared/* entries',
    ![...(w.store.get(G_CACHE)?.entries.keys() || [])].some((k) => k.includes('__shared')),
    JSON.stringify([...(w.store.get(G_CACHE)?.entries.keys() || [])]));
}

/* --- (g2) hostile file names and a nameless file ------------------------- */
{
  const w = createWorld({ manifest: manifestSource('g2-ver', G_ASSETS) });
  goOnlineMap(w, { [abs('./index.html')]: 'G2-INDEX', [abs('./offline.html')]: 'G2-OFFLINE' });
  w.load();
  const hostile = [
    new File([new Uint8Array([1])], '../../etc/passwd', { type: 'application/x-7z-compressed' }),
    new File([new Uint8Array([2])], '/etc/shadow', { type: 'application/zip' }),
    new File([new Uint8Array([3])], 'a\r\nX-Injected: yes.txt', { type: 'text/plain' }),
    new File([new Uint8Array([4])], '', { type: '' })
  ];
  const res = await settledResponse(fireFetch(w, mockFormRequest(hostile, { title: 'pwn' })));
  check('(g2) a share with hostile file names still answers 303',
    res.ok && res.status === 303, res.ok ? 'status ' + res.status : res.detail);
  check('(g2) cache keys stay positional (a file name can never choose a cache key)',
    JSON.stringify(sharedKeys(w)) === JSON.stringify(
      [0, 1, 2, 3].map((i) => abs('./__shared/' + i)).concat([abs('./__shared/count')]).sort()),
    JSON.stringify(sharedKeys(w)));
  const badHeaders = [];
  for (let i = 0; i < hostile.length; i++) {
    const entry = sharedEntry(w, i);
    const value = entry ? String(entry.headers['x-file-name'] || '') : '';
    if (!entry || /[/\\\r\n]/.test(value) || value.includes('%00')) badHeaders.push(i + ':' + JSON.stringify(value));
  }
  check('(g2) every X-File-Name is percent-encoded (no path separators, no CRLF injection)',
    badHeaders.length === 0, JSON.stringify(badHeaders));
  check('(g2) traversal names survive round-trip-decodable, so app.js sees the original name',
    decodeURIComponent(String(sharedEntry(w, 0).headers['x-file-name'])) === '../../etc/passwd',
    String(sharedEntry(w, 0).headers['x-file-name']));
  check('(g2) a nameless file falls back to "file<i>" instead of an empty header',
    String(sharedEntry(w, 3).headers['x-file-name']) === 'file3',
    String(sharedEntry(w, 3).headers['x-file-name']));
  check('(g2) a file with no MIME type falls back to application/octet-stream',
    String(sharedEntry(w, 3).headers['content-type']) === 'application/octet-stream',
    String(sharedEntry(w, 3).headers['content-type']));
  check('(g2) the count entry reflects only the real files',
    Buffer.from(sharedEntry(w, 'count').body).toString() === '4');
}

/* --- (g3) junk mixed into the files field -------------------------------- */
{
  const w = createWorld({ manifest: manifestSource('g3-ver', G_ASSETS) });
  goOnlineMap(w, { [abs('./index.html')]: 'G3-INDEX', [abs('./offline.html')]: 'G3-OFFLINE' });
  w.load();
  const form = new FormData();
  form.append('title', 'text only');
  form.append('files', 'i-am-a-string-not-a-file');
  form.append('files', new File([new Uint8Array([7, 7])], 'real.7z', { type: 'application/x-7z-compressed' }));
  form.append('url', 'https://example.com/x');
  const res = await settledResponse(fireFetch(w, {
    url: SHARE_URL, method: 'POST', mode: 'navigate', headers: form.headers,
    formData: () => new Request(SHARE_URL, { method: 'POST', body: form }).formData()
  }));
  check('(g3) a share whose files field holds a plain string still answers 303',
    res.ok && res.status === 303, res.ok ? 'status ' + res.status : res.detail);
  check('(g3) non-Blob form values are filtered out (only the real file is cached)',
    JSON.stringify(sharedKeys(w)) ===
      JSON.stringify([abs('./__shared/0'), abs('./__shared/count')].sort()),
    JSON.stringify(sharedKeys(w)));
  check('(g3) the string value was NOT written as a file body',
    Buffer.from(sharedEntry(w, 0).body).toString('hex') === '0707',
    Buffer.from(sharedEntry(w, 0).body).toString('hex'));
  check('(g3) the count is 1 (a text-only share does not invent a file)',
    Buffer.from(sharedEntry(w, 'count').body).toString() === '1');
}

/* --- (g4) zero-byte files, many files, and repeat shares ----------------- */
{
  const w = createWorld({ manifest: manifestSource('g4-ver', G_ASSETS) });
  goOnlineMap(w, { [abs('./index.html')]: 'G4-INDEX', [abs('./offline.html')]: 'G4-OFFLINE' });
  w.load();

  const empty = await settledResponse(fireFetch(w, navShareRequest([
    new File([], 'empty.7z', { type: 'application/x-7z-compressed' })
  ])));
  check('(g4) a zero-byte file share still answers 303', empty.ok && empty.status === 303,
    empty.ok ? 'status ' + empty.status : empty.detail);
  check('(g4) the zero-byte file is cached as an empty body (not skipped)',
    !!sharedEntry(w, 0) && Buffer.from(sharedEntry(w, 0).body).length === 0,
    JSON.stringify(sharedKeys(w)));

  const many = [];
  for (let i = 0; i < 25; i++) {
    many.push(new File([new Uint8Array([i])], 'f' + i + '.7z', { type: 'application/x-7z-compressed' }));
  }
  const manyRes = await settledResponse(fireFetch(w, navShareRequest(many)));
  check('(g4) a 25-file share answers 303', manyRes.ok && manyRes.status === 303,
    manyRes.ok ? 'status ' + manyRes.status : manyRes.detail);
  check('(g4) all 25 files plus the count are cached, and the 0-byte leftovers are gone',
    sharedKeys(w).length === 26 && !sharedKeys(w).includes(abs('./__shared/25')),
    'keys=' + sharedKeys(w).length);
  check('(g4) count === 25 after the big share',
    Buffer.from(sharedEntry(w, 'count').body).toString() === '25');
  check('(g4) file 24 kept its own bytes',
    Buffer.from(sharedEntry(w, 24).body).toString('hex') === '18',
    Buffer.from(sharedEntry(w, 24).body).toString('hex'));

  // Immediately re-share one file: everything from the 25 must be dropped.
  await settledResponse(fireFetch(w, navShareRequest([
    new File([new Uint8Array([42])], 'after.7z', { type: 'application/x-7z-compressed' })
  ])));
  check('(g4) re-sharing clears all 25 stale entries (no ./__shared/1 left)',
    JSON.stringify(sharedKeys(w)) ===
      JSON.stringify([abs('./__shared/0'), abs('./__shared/count')].sort()),
    JSON.stringify(sharedKeys(w)));
  check('(g4) no stale-key leak into the app-shell cache either',
    ![...(w.store.get('7zip-web-g4-ver')?.entries.keys() || [])].some((k) => k.includes('__shared')),
    JSON.stringify([...(w.store.get('7zip-web-g4-ver')?.entries.keys() || [])]));
  check('(g4) the whole share flow made zero network calls', w.fetchCalls.length === 0,
    'fetches=' + w.fetchCalls.length);
}

/* --- (g5) the Cache API refuses (quota) -> still a clean redirect --------- */
{
  const w = createWorld({ manifest: manifestSource('g5-ver', G_ASSETS) });
  goOnlineMap(w, { [abs('./index.html')]: 'G5-INDEX', [abs('./offline.html')]: 'G5-OFFLINE' });
  w.load();
  // Simulate a full disk: every cache operation for the shared cache rejects.
  w.cachesApi.open = async () => {
    const err = new Error('QuotaExceededError');
    err.name = 'QuotaExceededError';
    throw err;
  };
  const warnsBefore = w.warnings.length;
  const res = await settledResponse(fireFetch(w, navShareRequest([
    new File([new Uint8Array([1, 2])], 'q.7z', { type: 'application/x-7z-compressed' })
  ])));
  check('(g5) a quota failure still answers 303 (the user is never stranded on a POST)',
    res.ok && res.status === 303, res.ok ? 'status ' + res.status : res.detail);
  check('(g5) the quota failure is reported via console.warn, not thrown at the browser',
    w.warnings.length === warnsBefore + 1 && /share/i.test(w.warnings[warnsBefore]),
    JSON.stringify(w.warnings.slice(warnsBefore)));
  check('(g5) no shared cache was created and no network call was made',
    !w.store.has(SHARED_CACHE) && w.fetchCalls.length === 0,
    'caches=' + cacheNames(w).join(',') + ' fetches=' + w.fetchCalls.length);
}

/* --- (g6) a share that arrives before install ever ran, fully offline ----- */
{
  const w = createWorld({ manifest: manifestSource('g6-ver', G_ASSETS) });
  goOffline(w);
  w.load(); // no install, no activate: a brand-new SW woken by the share POST
  const res = await settledResponse(fireFetch(w, navShareRequest([
    new File([new Uint8Array([5, 6, 7])], 'offline-share.zip', { type: 'application/zip' })
  ])));
  check('(g6) an offline share on a never-installed SW still answers 303 to ./',
    res.ok && res.status === 303, res.ok ? 'status ' + res.status : res.detail);
  check('(g6) the offline share stored the file bytes for app.js to pick up',
    Buffer.from(sharedEntry(w, 0).body).toString('hex') === '050607' &&
    String(sharedEntry(w, 0).headers['x-file-name']) === encodeURIComponent('offline-share.zip'),
    JSON.stringify(sharedKeys(w)));
  check('(g6) handling the offline share required zero network calls', w.fetchCalls.length === 0,
    'fetches=' + w.fetchCalls.length);
}

/* ------------------------------------------------------------------ result */

console.log('\n' + '-'.repeat(70));
console.log('sw-adversarial: ' + passCount + ' passed, ' + failCount + ' failed' +
  (knownIssueCount ? ', ' + knownIssueCount + ' known site issue(s)' : ''));
if (failCount > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('ALL ADVERSARIAL SW CHECKS PASSED');
