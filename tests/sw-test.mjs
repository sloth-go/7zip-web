#!/usr/bin/env node
/*
 * Mock-harness test for the 7-Zip WASM service worker.
 *
 * Runs <repo>/sw.js inside a vm context with stubbed service-worker globals
 * (self, caches, importScripts, fetch, clients, addEventListener) and Node's
 * real Request/Response/Headers/URL/FormData/Blob, then fires install /
 * activate / fetch events and asserts the contract:
 *
 *   - install precaches every __SW_ASSETS__ entry and calls skipWaiting
 *     (also when the generated manifest is absent)
 *   - activate deletes stale caches (keeping the fixed-name shared-file cache)
 *     and calls clients.claim
 *   - navigations: cache-first -> network -> ./offline.html
 *   - build-info.json: network-first + cache put + cached fallback
 *   - same-origin assets: cache-first, successful network results cached
 *   - cross-origin: plain fetch, never cached
 *   - non-http(s) and non-GET: untouched — EXCEPT the manifest share_target
 *     POST to ./__share, which stashes its files in '7zip-web-shared' and
 *     answers with a 303 redirect back to the site root
 *
 * Usage: node tests/sw-test.mjs   (from the repo root; any cwd works)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Repo root derived from this file's own location (tests/..) so the suite runs
// from anywhere; the generated sw-manifest.js fixture goes to a scratch dir.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW_PATH = REPO + '/sw.js';
const OFFLINE_PATH = REPO + '/offline.html';
const MANIFEST_PATH = REPO + '/manifest.webmanifest';
const FIXTURE_DIR = path.join(os.tmpdir(), '7zip-web-tests', 'sw-test', 'fixture');
const FIXTURE_MANIFEST = FIXTURE_DIR + '/sw-manifest.js';

const SITE_BASE = 'https://example.github.io/7zip-web/';
const SW_URL = SITE_BASE + 'sw.js';
const SHARE_URL = SITE_BASE + '__share';

const FIXTURE_VERSION = '26.06-2026-11-09T04:00:00Z';
const FIXTURE_ASSETS = [
  './index.html',
  './offline.html',
  './app.js',
  './worker.js',
  './manifest.webmanifest',
  './wasm/7zz.js',
  './wasm/7zz.wasm',
  './icons/icon-192.png'
];
const CACHE = '7zip-web-' + FIXTURE_VERSION;
const ORPHAN_CACHE = '7zip-web-old';
// Fixed-name cache for share_target files (never versioned, survives activate).
const SHARED_CACHE = '7zip-web-shared';

/* ---------------------------------------------------------------- reporting */

let passCount = 0;
let failCount = 0;
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

function section(title) {
  console.log('\n== ' + title + ' ==');
}

/* ------------------------------------------------------------------ helpers */

function urlOf(request) {
  if (typeof request === 'string') return request;
  if (request instanceof URL) return request.href;
  return request.url;
}

// Cache-key normalisation: absolute URL, fragment always dropped, query dropped
// when ignoreSearch is set (mirrors the CacheStorage matching algorithm closely
// enough for these tests).
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

// Resolves a respondWith() promise exactly once, reading the body a single time.
async function respondInfo(state) {
  const res = await settled(state.promise);
  if (!res.ok) {
    return {
      responded: state.responded,
      ok: false,
      error: res.error,
      detail: String((res.error && res.error.message) || res.error),
      body: null,
      status: null,
      contentType: null
    };
  }
  const response = res.value;
  return {
    responded: state.responded,
    ok: true,
    error: null,
    detail: 'status ' + response.status,
    body: await response.text(),
    status: response.status,
    contentType: response.headers.get('content-type'),
    headers: response.headers
  };
}

/* ----------------------------------------------------------- mock Cache API */

class MockCache {
  constructor(name, world) {
    this.name = name;
    this.world = world;
    this.entries = new Map(); // cacheKey -> { url, status, statusText, headers, body }
  }

  async put(request, response) {
    if (!response) throw new TypeError('put: response required');
    if (response.status === 206) throw new TypeError('put: partial response');
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    const body = new Uint8Array(await response.arrayBuffer());
    const key = cacheKey(request, false);
    this.entries.set(key, {
      url: key,
      body,
      status: response.status,
      statusText: response.statusText,
      headers
    });
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
    // A fresh Response per match, like the real API (bodies are single-use).
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
        world.store.set(name, cache);
      }
      return cache;
    },
    async has(name) {
      return world.store.has(name);
    },
    async delete(name) {
      return world.store.delete(name);
    },
    async keys() {
      return [...world.store.keys()];
    },
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
  const href = String(new URL(url));
  // undici refuses `mode: 'navigate'` in the Request constructor (browsers only
  // set it for real navigations), so navigations use a plain mock request.
  if (mode === 'navigate') {
    return {
      url: href,
      method,
      mode: 'navigate',
      destination: 'document',
      referrer: '',
      headers: init.headers
    };
  }
  return new Request(href, init);
}

/* ------------------------------------------------------------- mock world */

function createWorld({ manifestAvailable = true } = {}) {
  const world = {
    listeners: new Map(),
    store: new Map(), // cache name -> MockCache
    fetchCalls: [],
    fetchImpl: null,
    online: false,
    skipWaitingCalls: 0,
    claimCalls: 0,
    importScriptsCalls: [],
    logs: [],
    warnings: [],
    errors: [],
    waitUntils: []
  };

  const cachesApi = createCacheStorage(world);

  const sandbox = {
    console: {
      log: (...args) => world.logs.push(args.join(' ')),
      info: (...args) => world.logs.push(args.join(' ')),
      warn: (...args) => world.warnings.push(args.join(' ')),
      error: (...args) => world.errors.push(args.join(' '))
    },
    URL,
    Request,
    Response,
    Headers,
    // The share_target branch builds/inspects multipart bodies: same-realm
    // constructors so `value instanceof Blob` inside sw.js works.
    FormData,
    Blob,
    File,
    TextEncoder,
    TextDecoder,
    AbortController,
    caches: cachesApi,
    addEventListener(type, handler) {
      const list = world.listeners.get(type) || [];
      list.push(handler);
      world.listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = world.listeners.get(type) || [];
      world.listeners.set(type, list.filter((fn) => fn !== handler));
    },
    importScripts(...urls) {
      for (const url of urls) {
        world.importScriptsCalls.push(url);
        if (!manifestAvailable) {
          throw new Error('Failed to load ' + url + ' (404)');
        }
        vm.runInContext(fs.readFileSync(FIXTURE_MANIFEST, 'utf8'), world.ctx, { filename: String(url) });
      }
    },
    skipWaiting: async () => {
      world.skipWaitingCalls++;
    },
    clients: {
      claim: async () => {
        world.claimCalls++;
      },
      matchAll: async () => [],
      get: async () => undefined
    },
    location: new URL(SW_URL)
  };
  sandbox.fetch = (...args) => {
    world.fetchCalls.push(args[0]);
    // Real fetch always returns a promise, even for network failures.
    return Promise.resolve().then(() => world.fetchImpl(...args));
  };
  sandbox.self = sandbox;
  world.fetch = sandbox.fetch; // used by MockCache.addAll(), like the real spec

  const ctx = vm.createContext(sandbox);
  world.ctx = ctx;
  world.sandbox = sandbox;
  world.cachesApi = cachesApi;
  world.load = () => vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), ctx, { filename: SW_PATH });
  world.fetchCount = () => world.fetchCalls.length;
  world.resetFetchCalls = () => { world.fetchCalls.length = 0; };
  return world;
}

function goOnline(world, responder) {
  world.online = true;
  world.fetchImpl = async (request) => {
    const url = urlOf(request);
    if (responder) return responder(url, request);
    return new Response('NET ' + url, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' }
    });
  };
}

function goOffline(world) {
  world.online = false;
  world.fetchImpl = () => {
    throw new TypeError('Failed to fetch (offline)');
  };
}

async function seed(world, cacheName, relPath, body, contentType) {
  const cache = await world.cachesApi.open(cacheName);
  const url = relPath instanceof URL ? relPath.href : new URL(relPath, SITE_BASE).href;
  await cache.put(url, new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType || 'text/plain; charset=utf-8' }
  }));
  return url;
}

async function cachedBody(world, cacheName, relPath) {
  const cache = world.store.get(cacheName);
  if (!cache) return undefined;
  const url = relPath instanceof URL ? relPath.href : new URL(relPath, SITE_BASE).href;
  const hit = await cache.match(url, { ignoreSearch: true });
  return hit ? await hit.text() : undefined;
}

function dispatch(world, type, event) {
  const handlers = world.listeners.get(type) || [];
  for (const handler of handlers) handler.call(world.sandbox, event);
  return handlers.length;
}

function fireLifecycle(world, type) {
  const state = { promises: [] };
  state.handlerCount = dispatch(world, type, {
    type,
    waitUntil: (p) => state.promises.push(p)
  });
  state.done = Promise.all(state.promises);
  return state;
}

function fireFetch(world, request) {
  const state = { responded: false, promise: null, respondWithCalls: 0, waitUntils: [] };
  state.handlerCount = dispatch(world, 'fetch', {
    type: 'fetch',
    request,
    clientId: 'client-1',
    resultingClientId: 'client-1',
    preloadResponse: Promise.resolve(undefined),
    waitUntil: (p) => state.waitUntils.push(p),
    respondWith: (p) => {
      state.respondWithCalls++;
      if (state.responded) throw new Error('respondWith called twice');
      state.responded = true;
      state.promise = p;
    }
  });
  world.waitUntils.push(...state.waitUntils);
  return state;
}

/* --------------------------------------------------- source-level scanning */

// Removes // and /* */ comments (string literals preserved) so that prose in
// comments cannot masquerade as a URL literal, and vice versa.
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

/* ------------------------------------------------------------------ fixture */

fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
fs.mkdirSync(FIXTURE_DIR, { recursive: true });
fs.writeFileSync(
  FIXTURE_MANIFEST,
  'self.__SW_VERSION__ = ' + JSON.stringify(FIXTURE_VERSION) + ';\n' +
  'self.__SW_ASSETS__ = ' + JSON.stringify(FIXTURE_ASSETS, null, 2) + ';\n'
);

/* ============================== static contract checks on the site files == */

section('static contract checks (sw.js / offline.html / manifest.webmanifest)');

const swSource = fs.readFileSync(SW_PATH, 'utf8');
const offlineSource = fs.readFileSync(OFFLINE_PATH, 'utf8');
const manifestSource = fs.readFileSync(MANIFEST_PATH, 'utf8');
const swCode = stripComments(swSource);

check('sw.js: no external http(s) URL literals in code', !/https?:\/\//i.test(swCode));
check('sw.js: no external http(s) URL anywhere in the file', !/https?:\/\//i.test(swSource));
check('offline.html: no external http(s) URL literals', !/https?:\/\//i.test(offlineSource));
check('manifest.webmanifest: no external http(s) URL literals', !/https?:\/\//i.test(manifestSource));

const quotedLiterals = [...swCode.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)].map((m) => m[2]);
const rootAbsolute = quotedLiterals.filter((s) => /^\/\//.test(s) || /^\/[^/]/.test(s));
check('sw.js: no root-absolute URL literals (only the /build-info.json pathname suffix)',
  rootAbsolute.length === 0 || (rootAbsolute.length === 1 && rootAbsolute[0] === '/build-info.json'),
  JSON.stringify(rootAbsolute));
check('sw.js: imports ./sw-manifest.js relatively',
  /importScripts\(\s*'\.\/sw-manifest\.js'\s*\)/.test(swSource));
check("sw.js: cache name is '7zip-web-' + (self.__SW_VERSION__ || 'dev')",
  /'7zip-web-'\s*\+\s*\(self\.__SW_VERSION__\s*\|\|\s*'dev'\)/.test(swSource));
check('sw.js: resolves assets via new URL(entry, self.location).href',
  /new URL\([^)]*self\.location[^)]*\)\.href/.test(swSource));
check('sw.js: registers install, activate and fetch listeners',
  ['install', 'activate', 'fetch'].every((t) => new RegExp("addEventListener\\(\\s*'" + t + "'").test(swSource)));
check('sw.js: calls self.skipWaiting()', /self\.skipWaiting\(\)/.test(swSource));
check('sw.js: calls self.clients.claim()', /self\.clients\.claim\(\)/.test(swSource));
check('sw.js: still bails on non-GET requests', /method\s*!==\s*'GET'/.test(swSource));

// --- share_target additions (PWA file handling) ---
check("sw.js: POST is admitted only alongside GET ('GET' && 'POST' bail-out)",
  /request\.method !== 'GET' && request\.method !== 'POST'/.test(swCode.replace(/\s+/g, ' ')));
check("sw.js: declares the fixed-name shared cache var SHARED_CACHE = '7zip-web-shared'",
  /var SHARED_CACHE = '7zip-web-shared';/.test(swSource));
check('sw.js: resolves the share endpoint relatively via new URL(\'./__share\', self.location)',
  /new URL\('\.\/__share',\s*self\.location\)/.test(swSource));
check('sw.js: activate keeps both CACHE and SHARED_CACHE',
  /key !== CACHE && key !== SHARED_CACHE/.test(swCode.replace(/\s+/g, ' ')));
check('sw.js: the POST branch precedes the navigate branch (a navigation POST never reaches navigationResponse)',
  swCode.indexOf("request.method === 'POST'") !== -1 &&
  swCode.indexOf("request.method === 'POST'") < swCode.indexOf("request.mode === 'navigate'"));
check('sw.js: only the ./__share pathname is answered, every other POST returns untouched',
  /url\.pathname === SHARE_URL\.pathname/.test(swCode));
check('sw.js: share replies are 303 redirects with a Location header',
  /status:\s*303/.test(swCode) && /Location:/.test(swCode));
check('sw.js: shared files are stashed under ./__shared/<i> with an X-File-Name header',
  /'\.\/__shared\/' \+ i/.test(swSource) && /'X-File-Name'/.test(swSource));
check('sw.js: a ./__shared/count entry records the file count',
  /'\.\/__shared\/count'/.test(swSource));

check('offline.html: shows the required offline message',
  offlineSource.includes('You are offline and this page was not cached.'));
check('offline.html: has a Retry button that reloads the page',
  /<button[^>]*onclick="location\.reload\(\)"/i.test(offlineSource) && /Retry/i.test(offlineSource));
check('offline.html: links to ./index.html', /href="\.\/index\.html"/.test(offlineSource));
check('offline.html: declares both dark and light color schemes',
  /<meta[^>]+name="color-scheme"[^>]+content="dark light"/i.test(offlineSource) &&
  /color-scheme:\s*dark light/i.test(offlineSource));
check('offline.html: is dark/light aware via a prefers-color-scheme media query',
  /@media\s*\(\s*prefers-color-scheme:\s*light\s*\)/i.test(offlineSource));
check('offline.html: default background matches manifest background_color (#111111)',
  /--bg:\s*#111111/i.test(offlineSource));
check('offline.html: inline CSS only (no external stylesheet, no external script)',
  !/<link[^>]+stylesheet/i.test(offlineSource) && !/<script[^>]+src=/i.test(offlineSource));
check('offline.html: does not reference app.js / worker.js / sw.js / manifest.webmanifest',
  !/\b(?:app|worker|sw)\.js\b/.test(offlineSource) && !/manifest\.webmanifest/.test(offlineSource));
check('offline.html: its only JS is the inline onclick handler',
  !/<script/i.test(offlineSource) && /onclick="location\.reload\(\)"/.test(offlineSource));

const offlineRefs = [...offlineSource.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
check('offline.html: every href/src is a relative ./ URL',
  offlineRefs.length > 0 && offlineRefs.every((ref) => ref.startsWith('./')), JSON.stringify(offlineRefs));
check('offline.html: tiny (< 16 KB)', fs.statSync(OFFLINE_PATH).size < 16 * 1024,
  fs.statSync(OFFLINE_PATH).size + ' bytes');

let manifest = null;
try {
  manifest = JSON.parse(manifestSource);
  check('manifest.webmanifest: parses as strict JSON (no comments / trailing commas)', true);
} catch (error) {
  check('manifest.webmanifest: parses as strict JSON (no comments / trailing commas)', false, error.message);
}
if (manifest) {
  check('manifest: name === "7-Zip WASM"', manifest.name === '7-Zip WASM', String(manifest.name));
  check('manifest: short_name === "7-Zip"', manifest.short_name === '7-Zip', String(manifest.short_name));
  check('manifest: start_url === "./"', manifest.start_url === './', String(manifest.start_url));
  check('manifest: scope === "./"', manifest.scope === './', String(manifest.scope));
  check('manifest: display === "standalone"', manifest.display === 'standalone', String(manifest.display));
  check('manifest: background_color === "#111111"', manifest.background_color === '#111111', String(manifest.background_color));
  check('manifest: theme_color === "#111111"', manifest.theme_color === '#111111', String(manifest.theme_color));
  const expectedIcons = [
    { src: './icons/icon-16.png', sizes: '16x16', type: 'image/png' },
    { src: './icons/icon-32.png', sizes: '32x32', type: 'image/png' },
    { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
  ];
  check('manifest: exactly the four contract icons, in order',
    JSON.stringify(manifest.icons) === JSON.stringify(expectedIcons), JSON.stringify(manifest.icons));
  check('manifest: every icon src is relative and the file exists on disk',
    (manifest.icons || []).every((icon) => icon.src.startsWith('./') && fs.existsSync(REPO + '/' + icon.src.slice(2))));
  const metaTheme = /<meta[^>]+name="theme-color"[^>]+content="([^"]+)"/i.exec(offlineSource);
  check('offline.html theme-color matches manifest theme_color',
    !!metaTheme && metaTheme[1].toLowerCase() === String(manifest.theme_color).toLowerCase(),
    metaTheme ? metaTheme[1] : 'none');

  // --- PWA file handling members (must line up with what sw.js intercepts) ---
  const shareTarget = manifest.share_target;
  check('manifest: share_target member present', !!shareTarget && typeof shareTarget === 'object',
    JSON.stringify(shareTarget));
  if (shareTarget) {
    check('manifest: share_target.action === "./__share" (the endpoint sw.js intercepts)',
      shareTarget.action === './__share', String(shareTarget.action));
    check('manifest: share_target.method === "POST"', shareTarget.method === 'POST', String(shareTarget.method));
    check('manifest: share_target.enctype === "multipart/form-data"',
      shareTarget.enctype === 'multipart/form-data', String(shareTarget.enctype));
    const filesParam = shareTarget.params && shareTarget.params.files;
    check('manifest: share_target.params.files is a single entry named "files" (the field sw.js reads)',
      Array.isArray(filesParam) && filesParam.length === 1 && filesParam[0].name === 'files',
      JSON.stringify(shareTarget.params));
    check('manifest: share_target.params.files[0].accept === ["*/*"]',
      !!filesParam && JSON.stringify(filesParam[0].accept) === JSON.stringify(['*/*']),
      JSON.stringify(filesParam && filesParam[0].accept));
    check('manifest: share_target also maps title/text/url',
      shareTarget.params && shareTarget.params.title === 'title' &&
      shareTarget.params.text === 'text' && shareTarget.params.url === 'url',
      JSON.stringify(shareTarget.params));
  }
  const fileHandlers = manifest.file_handlers;
  check('manifest: file_handlers is a single entry with the relative action "./"',
    Array.isArray(fileHandlers) && fileHandlers.length === 1 && fileHandlers[0].action === './',
    JSON.stringify(fileHandlers));
  if (Array.isArray(fileHandlers) && fileHandlers[0]) {
    check('manifest: file_handlers[0].launch_type is one of the spec values',
      ['single-client', 'multiple-clients'].includes(fileHandlers[0].launch_type),
      String(fileHandlers[0].launch_type));
    const acceptExts = Object.values(fileHandlers[0].accept || {}).flat();
    check('manifest: file_handlers accept values are extensions with a leading dot',
      acceptExts.length > 0 && acceptExts.every((e) => /^\.[a-z0-9]+$/.test(e)), JSON.stringify(acceptExts));
  }

  // Informational only: index.html is authored by a sibling agent, so a mismatch
  // there must not fail this test — but it is worth surfacing.
  try {
    const indexSource = fs.readFileSync(REPO + '/index.html', 'utf8');
    const indexTheme = /<meta[^>]+name="theme-color"[^>]+content="([^"]+)"/i.exec(indexSource);
    const same = indexTheme && indexTheme[1].toLowerCase() === String(manifest.theme_color).toLowerCase();
    console.log('INFO  index.html theme-color is ' + (indexTheme ? indexTheme[1] : 'absent') +
      ' -> ' + (same ? 'matches manifest theme_color' : 'DIFFERS from manifest theme_color'));
  } catch (error) {
    console.log('INFO  index.html not present yet; skipping theme-color cross-check');
  }
}

/* =============================================================== install == */

section('install: precache every __SW_ASSETS__ entry, then skipWaiting');

const world = createWorld();
world.load();
goOnline(world);

check('sw.js registered one handler each for install / activate / fetch',
  ['install', 'activate', 'fetch'].every((t) => (world.listeners.get(t) || []).length === 1),
  JSON.stringify([...world.listeners.keys()]));
check('install importScripts("./sw-manifest.js")',
  world.importScriptsCalls.length === 1 && world.importScriptsCalls[0] === './sw-manifest.js',
  JSON.stringify(world.importScriptsCalls));
check('sw.js read __SW_VERSION__ from the generated manifest',
  world.sandbox.__SW_VERSION__ === FIXTURE_VERSION, String(world.sandbox.__SW_VERSION__));
check('sw.js read all ' + FIXTURE_ASSETS.length + ' __SW_ASSETS__ entries',
  Array.isArray(world.sandbox.__SW_ASSETS__) &&
  world.sandbox.__SW_ASSETS__.length === FIXTURE_ASSETS.length);

const install = fireLifecycle(world, 'install');
const installResult = await settled(install.done);
check('install waitUntil() promise resolved', installResult.ok,
  installResult.ok ? '' : String(installResult.error && installResult.error.message));
check('install fetched each asset exactly once',
  world.fetchCount() === FIXTURE_ASSETS.length, 'fetchCalls=' + world.fetchCount());
check('install opened the versioned cache "' + CACHE + '"', world.store.has(CACHE),
  JSON.stringify([...world.store.keys()]));
const missingAssets = [];
for (const asset of FIXTURE_ASSETS) {
  if ((await cachedBody(world, CACHE, asset)) === undefined) missingAssets.push(asset);
}
check('install precached every fixture asset ("./x" resolved against ' + SITE_BASE + ')',
  missingAssets.length === 0, 'missing=' + JSON.stringify(missingAssets));
const precachedUrls = [...(world.store.get(CACHE) || { entries: new Map() }).entries.keys()];
check('precached keys are absolute same-origin URLs under the site subpath',
  precachedUrls.length === FIXTURE_ASSETS.length &&
  precachedUrls.every((u) => u.startsWith(SITE_BASE)), JSON.stringify(precachedUrls));
check('install called skipWaiting exactly once', world.skipWaitingCalls === 1,
  'calls=' + world.skipWaitingCalls);
check('install did not call clients.claim', world.claimCalls === 0);

/* ======================= install guard: generated manifest file missing === */

section('install guard: sw-manifest.js missing (local dev must not brick)');

const devWorld = createWorld({ manifestAvailable: false });
let devLoadError = null;
try {
  devWorld.load();
} catch (error) {
  devLoadError = error;
}
check('sw.js still loads when importScripts("./sw-manifest.js") throws',
  devLoadError === null, devLoadError ? devLoadError.message : '');
goOnline(devWorld);
const devInstall = await settled(fireLifecycle(devWorld, 'install').done);
check('install resolves without a manifest (no unhandled rejection)', devInstall.ok,
  devInstall.ok ? '' : String(devInstall.error && devInstall.error.message));
check('install still calls skipWaiting without a manifest', devWorld.skipWaitingCalls === 1,
  'calls=' + devWorld.skipWaitingCalls);
check('install fetches nothing without a manifest', devWorld.fetchCount() === 0,
  'fetchCalls=' + devWorld.fetchCount());
check('the missing manifest is logged as a warning, not thrown',
  devWorld.warnings.some((w) => /sw-manifest|__SW_ASSETS__/i.test(w)), JSON.stringify(devWorld.warnings));
const devFetch = fireFetch(devWorld, makeRequest(SITE_BASE + 'index.html', { mode: 'navigate' }));
const devFetchInfo = await respondInfo(devFetch);
check('with no manifest, an online navigation still falls through to the network',
  devFetchInfo.ok && devFetchInfo.body === 'NET ' + SITE_BASE + 'index.html', devFetchInfo.detail);

/* ============================================================== activate == */

section('activate: delete every cache !== current (keeping the shared cache), then clients.claim');

const activateWorld = createWorld();
activateWorld.load();
goOnline(activateWorld);
await seed(activateWorld, ORPHAN_CACHE, './index.html', 'STALE INDEX', 'text/html');
await seed(activateWorld, 'some-other-app-v1', './whatever.js', 'OTHER', 'text/javascript');
await seed(activateWorld, CACHE, './index.html', 'CURRENT INDEX', 'text/html');
// An unconsumed share_target file must survive the worker update: SHARED_CACHE
// is never versioned, so activate must not treat it as stale.
await seed(activateWorld, SHARED_CACHE, './__shared/0', 'SHARED FILE', 'application/x-7z-compressed');
await seed(activateWorld, SHARED_CACHE, './__shared/count', '1', 'text/plain');

const activate = await settled(fireLifecycle(activateWorld, 'activate').done);
check('activate waitUntil() promise resolved', activate.ok,
  activate.ok ? '' : String(activate.error && activate.error.message));
const remaining = await activateWorld.cachesApi.keys();
check('activate deleted the stale "' + ORPHAN_CACHE + '" cache', !remaining.includes(ORPHAN_CACHE),
  JSON.stringify(remaining));
check('activate deleted unrelated caches', !remaining.includes('some-other-app-v1'),
  JSON.stringify(remaining));
check('activate kept the current versioned cache', remaining.includes(CACHE), JSON.stringify(remaining));
check('activate kept the fixed-name shared cache "' + SHARED_CACHE + '"',
  remaining.includes(SHARED_CACHE), JSON.stringify(remaining));
check('activate left the current cache contents intact',
  (await cachedBody(activateWorld, CACHE, './index.html')) === 'CURRENT INDEX');
check('activate left the unconsumed shared file intact',
  (await cachedBody(activateWorld, SHARED_CACHE, './__shared/0')) === 'SHARED FILE');
check('activate left the shared-file count entry intact',
  (await cachedBody(activateWorld, SHARED_CACHE, './__shared/count')) === '1');
check('activate called clients.claim exactly once', activateWorld.claimCalls === 1,
  'calls=' + activateWorld.claimCalls);
check('activate did not call skipWaiting', activateWorld.skipWaitingCalls === 0);

/* =================================================== fetch: navigations == */

section('fetch: navigation requests (cache-first -> network -> offline.html)');

const navWorld = createWorld();
navWorld.load();
goOffline(navWorld);
await seed(navWorld, CACHE, './index.html', 'INDEX-BODY', 'text/html');
await seed(navWorld, CACHE, './offline.html', 'OFFLINE-BODY', 'text/html');

// (a) offline navigation to the site root -> cached index.html
navWorld.resetFetchCalls();
const navA = await respondInfo(fireFetch(navWorld, makeRequest(SITE_BASE, { mode: 'navigate' })));
check('(a) offline navigation was answered via respondWith', navA.responded === true);
check('(a) offline navigation resolves to the cached index.html',
  navA.ok && navA.body === 'INDEX-BODY', navA.ok ? JSON.stringify(navA.body) : navA.detail);
check('(a) offline navigation served from cache without a network round-trip',
  navWorld.fetchCount() === 0, 'fetchCalls=' + navWorld.fetchCount());

// (a2) offline navigation to a deep link -> cached index.html
const navDeep = await respondInfo(fireFetch(navWorld, makeRequest(SITE_BASE + 'some/deep/link', { mode: 'navigate' })));
check('(a2) offline deep-link navigation falls back to the cached index.html',
  navDeep.ok && navDeep.body === 'INDEX-BODY', navDeep.ok ? JSON.stringify(navDeep.body) : navDeep.detail);

// (a3) navigation whose URL is itself cached -> that exact entry
const navExact = await respondInfo(fireFetch(navWorld,
  makeRequest(new URL('./offline.html', SITE_BASE).href, { mode: 'navigate' })));
check('(a3) a navigation matching a cached URL is served that exact entry',
  navExact.ok && navExact.body === 'OFFLINE-BODY', navExact.ok ? JSON.stringify(navExact.body) : navExact.detail);

// (a4) online navigation with nothing cached -> network, and NOT cached
const navOnlineWorld = createWorld();
navOnlineWorld.load();
goOnline(navOnlineWorld, async (url) => new Response('FRESH NETWORK HTML for ' + url, {
  status: 200,
  headers: { 'Content-Type': 'text/html' }
}));
const navOnline = await respondInfo(fireFetch(navOnlineWorld, makeRequest(SITE_BASE, { mode: 'navigate' })));
check('(a4) online navigation is served from the network',
  navOnline.ok && navOnline.body.startsWith('FRESH NETWORK HTML'),
  navOnline.ok ? JSON.stringify(navOnline.body) : navOnline.detail);
check('(a4) the navigation response was not written to the cache (index.html cannot go stale)',
  (await cachedBody(navOnlineWorld, CACHE, './index.html')) === undefined,
  'caches=' + JSON.stringify([...navOnlineWorld.store.keys()]));

// (b) offline navigation, index.html NOT cached, only offline.html -> offline.html
const bWorld = createWorld();
bWorld.load();
goOffline(bWorld);
await seed(bWorld, CACHE, './offline.html', 'OFFLINE-BODY', 'text/html');
const navB = await respondInfo(fireFetch(bWorld, makeRequest(SITE_BASE, { mode: 'navigate' })));
check('(b) offline navigation with nothing but the fallback cached serves ./offline.html',
  navB.ok && navB.body === 'OFFLINE-BODY', navB.ok ? JSON.stringify(navB.body) : navB.detail);
check('(b) the offline fallback response is an HTML document',
  navB.ok && /text\/html/i.test(String(navB.contentType)), String(navB.contentType));

// (b2) offline navigation with a completely empty cache -> synthetic offline HTML
const b2World = createWorld();
b2World.load();
goOffline(b2World);
const navB2 = await respondInfo(fireFetch(b2World, makeRequest(SITE_BASE, { mode: 'navigate' })));
check('(b2) offline navigation with an empty cache still answers with an offline page',
  navB2.ok && navB2.body.includes('You are offline and this page was not cached.'),
  navB2.ok ? JSON.stringify(navB2.body.slice(0, 80)) : navB2.detail);
check('(b2) that synthetic response is a 503 HTML document',
  navB2.ok && navB2.status === 503 && /text\/html/i.test(String(navB2.contentType)),
  navB2.ok ? navB2.status + ' ' + navB2.contentType : navB2.detail);

/* ============================================== fetch: same-origin assets == */

section('fetch: same-origin assets (cache-first, cache successful responses)');

const assetWorld = createWorld();
assetWorld.load();
await seed(assetWorld, CACHE, './app.js', 'APP-CACHED', 'text/javascript');
await seed(assetWorld, CACHE, './wasm/7zz.wasm', 'WASM-CACHED', 'application/wasm');
goOnline(assetWorld);
assetWorld.resetFetchCalls();

// (c) cached asset -> served from cache, network never touched
const assetC = await respondInfo(fireFetch(assetWorld, makeRequest(SITE_BASE + 'app.js')));
check('(c) cached same-origin asset is served from the cache',
  assetC.ok && assetC.body === 'APP-CACHED', assetC.ok ? JSON.stringify(assetC.body) : assetC.detail);
check('(c) the network spy was NOT called for a cache hit', assetWorld.fetchCount() === 0,
  'fetchCalls=' + assetWorld.fetchCount());

// (c2) cached asset requested with a query string -> still a cache hit
const assetQ = await respondInfo(fireFetch(assetWorld, makeRequest(SITE_BASE + 'app.js?v=2')));
check('(c2) a cache hit ignores the query string',
  assetQ.ok && assetQ.body === 'APP-CACHED', assetQ.ok ? JSON.stringify(assetQ.body) : assetQ.detail);
check('(c2) the network spy was still not called', assetWorld.fetchCount() === 0,
  'fetchCalls=' + assetWorld.fetchCount());

// (c3) precached wasm binary served offline from the cache
goOffline(assetWorld);
const assetWasm = await respondInfo(fireFetch(assetWorld, makeRequest(SITE_BASE + 'wasm/7zz.wasm')));
check('(c3) the precached wasm binary is served offline',
  assetWasm.ok && assetWasm.body === 'WASM-CACHED', assetWasm.ok ? JSON.stringify(assetWasm.body) : assetWasm.detail);

// (c4) uncached asset while online -> network response returned AND cached
goOnline(assetWorld);
assetWorld.resetFetchCalls();
const workerBody = 'NET ' + SITE_BASE + 'worker.js';
const assetNet = await respondInfo(fireFetch(assetWorld, makeRequest(SITE_BASE + 'worker.js')));
check('(c4) an uncached same-origin asset is fetched from the network',
  assetNet.ok && assetNet.body === workerBody && assetNet.status === 200,
  assetNet.ok ? JSON.stringify(assetNet.body) : assetNet.detail);
check('(c4) the successful network response was put in the cache',
  (await cachedBody(assetWorld, CACHE, './worker.js')) === workerBody,
  JSON.stringify(await cachedBody(assetWorld, CACHE, './worker.js')));

// (c5) uncached asset while offline -> rejection (no HTML substituted for an asset)
goOffline(assetWorld);
const assetOff = await respondInfo(fireFetch(assetWorld, makeRequest(SITE_BASE + 'icons/icon-512.png')));
check('(c5) an offline asset miss rejects instead of returning offline.html for a binary',
  assetOff.ok === false, assetOff.ok ? 'got ' + assetOff.status + ' ' + JSON.stringify(assetOff.body) : '');

// (c6) non-ok network responses are passed through but not cached
const errWorld = createWorld();
errWorld.load();
goOnline(errWorld, async () => new Response('nope', { status: 404, statusText: 'Not Found' }));
const errFetch = await respondInfo(fireFetch(errWorld, makeRequest(SITE_BASE + 'missing.js')));
check('(c6) a 404 is passed through to the caller', errFetch.ok && errFetch.status === 404,
  errFetch.ok ? String(errFetch.status) : errFetch.detail);
check('(c6) a 404 is not cached', (await cachedBody(errWorld, CACHE, './missing.js')) === undefined);

/* ==================================== fetch: build-info.json network-first == */

section('fetch: build-info.json (network-first, cache put, cached fallback)');

const infoWorld = createWorld();
infoWorld.load();
const INFO_URL = new URL('./build-info.json', SITE_BASE).href;
const OLD_INFO = JSON.stringify({ version: '25.01', builtAt: 'OLD' });
const NEW_INFO = JSON.stringify({ version: '26.06', builtAt: '2026-11-09T04:00:00Z' });
await seed(infoWorld, CACHE, './build-info.json', OLD_INFO, 'application/json');
goOnline(infoWorld, async (url) => {
  if (url.endsWith('/build-info.json')) {
    return new Response(NEW_INFO, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('NET ' + url, { status: 200 });
});
infoWorld.resetFetchCalls();

const infoOn = await respondInfo(fireFetch(infoWorld, makeRequest(INFO_URL)));
check('(d) online build-info.json returns the network body, not the stale cache',
  infoOn.ok && infoOn.body === NEW_INFO, infoOn.ok ? JSON.stringify(infoOn.body) : infoOn.detail);
check('(d) online build-info.json went to the network exactly once',
  infoWorld.fetchCount() === 1, 'fetchCalls=' + infoWorld.fetchCount());
check('(d) the successful build-info.json response was put in the cache',
  (await cachedBody(infoWorld, CACHE, './build-info.json')) === NEW_INFO,
  JSON.stringify(await cachedBody(infoWorld, CACHE, './build-info.json')));

goOffline(infoWorld);
const infoOff = await respondInfo(fireFetch(infoWorld, makeRequest(INFO_URL)));
check('(d) offline build-info.json falls back to the cached copy',
  infoOff.ok && infoOff.body === NEW_INFO, infoOff.ok ? JSON.stringify(infoOff.body) : infoOff.detail);

const infoEmpty = createWorld();
infoEmpty.load();
goOffline(infoEmpty);
const infoMiss = await respondInfo(fireFetch(infoEmpty, makeRequest(INFO_URL)));
check('(d2) offline build-info.json with nothing cached rejects cleanly (app.js then shows "local")',
  infoMiss.ok === false, infoMiss.ok ? 'got ' + infoMiss.status + ' ' + JSON.stringify(infoMiss.body) : '');

/* ================================================= fetch: cross-origin === */

section('fetch: cross-origin requests (plain fetch, never cached)');

const xoWorld = createWorld();
xoWorld.load();
await seed(xoWorld, CACHE, './app.js', 'APP-CACHED', 'text/javascript');
goOnline(xoWorld);
xoWorld.resetFetchCalls();

const CROSS_URL = 'https://cdn.example.net/lib/something.js';
const xoFetch = fireFetch(xoWorld, makeRequest(CROSS_URL));
const xo = await respondInfo(xoFetch);
check('(e) cross-origin GET is handed to the fetch spy untouched',
  xoWorld.fetchCount() === 1 && urlOf(xoWorld.fetchCalls[0]) === CROSS_URL && xoFetch.respondWithCalls === 1,
  JSON.stringify(xoWorld.fetchCalls.map(urlOf)));
check('(e) cross-origin response is the raw network response',
  xo.ok && xo.body === 'NET ' + CROSS_URL, xo.ok ? JSON.stringify(xo.body) : xo.detail);
const cachedCross = [];
for (const [name, cache] of xoWorld.store) {
  for (const key of cache.entries.keys()) {
    if (key.includes('cdn.example.net')) cachedCross.push(name + ' -> ' + key);
  }
}
check('(e) the cross-origin response was never cached', cachedCross.length === 0, JSON.stringify(cachedCross));

goOffline(xoWorld);
const xoOff = await respondInfo(fireFetch(xoWorld, makeRequest(CROSS_URL)));
check('(e2) an offline cross-origin request rejects (offline.html is not served for it)',
  xoOff.ok === false, xoOff.ok ? 'got ' + xoOff.status + ' ' + JSON.stringify(xoOff.body) : '');

const dataFetch = fireFetch(xoWorld, {
  url: 'data:text/plain,hi',
  method: 'GET',
  mode: 'no-cors',
  headers: new Headers()
});
check('(e3) non-http(s) requests are left alone (no respondWith)', dataFetch.responded === false);

/* ==================================================== fetch: non-GET ===== */

section('fetch: non-GET requests are untouched (except the share_target POST)');

const postWorld = createWorld();
postWorld.load();
await seed(postWorld, CACHE, './app.js', 'APP-CACHED', 'text/javascript');
goOnline(postWorld);
postWorld.resetFetchCalls();

const postFetch = fireFetch(postWorld, makeRequest(SITE_BASE + 'upload', { method: 'POST' }));
check('(f) a POST that is not ./__share is not handled (no respondWith)',
  postFetch.responded === false && postFetch.respondWithCalls === 0);
check('(f) that POST never reached the fetch spy', postWorld.fetchCount() === 0,
  'fetchCalls=' + postWorld.fetchCount());
const cachedPost = [];
for (const [name, cache] of postWorld.store) {
  for (const key of cache.entries.keys()) {
    if (key.endsWith('/upload')) cachedPost.push(name + ' -> ' + key);
  }
}
check('(f) that POST was not cached', cachedPost.length === 0, JSON.stringify(cachedPost));

const putFetch = fireFetch(postWorld, makeRequest(SITE_BASE + 'app.js', { method: 'PUT' }));
check('(f2) PUT to an already-cached URL is also left alone',
  putFetch.responded === false && postWorld.fetchCount() === 0);

const deleteFetch = fireFetch(postWorld, makeRequest(SITE_BASE + 'app.js', { method: 'DELETE' }));
const headFetch = fireFetch(postWorld, makeRequest(SITE_BASE + 'app.js', { method: 'HEAD' }));
check('(f3) DELETE and HEAD are left alone too (only GET and the share POST are ours)',
  deleteFetch.responded === false && headFetch.responded === false && postWorld.fetchCount() === 0,
  'fetchCalls=' + postWorld.fetchCount());

// A cross-origin POST must be dropped before any origin/cache logic runs.
const xoPost = fireFetch(postWorld, makeRequest('https://cdn.example.net/collect', { method: 'POST' }));
check('(f4) a cross-origin POST is left alone (no respondWith, no fetch)',
  xoPost.responded === false && postWorld.fetchCount() === 0);

/* ============================================ fetch: share_target POST ==== */

section('fetch: POST ./__share (manifest share_target) -> shared cache + 303 redirect');

// The endpoint the browser actually POSTs to, derived from the manifest rather
// than hardcoded, so a manifest/sw.js mismatch fails here.
const manifestShareAction = manifest && manifest.share_target ? manifest.share_target.action : null;
const MANIFEST_SHARE_URL = manifestShareAction ? new URL(manifestShareAction, SITE_BASE).href : null;
check('(g0) manifest share_target.action resolves to the same URL sw.js intercepts',
  MANIFEST_SHARE_URL === SHARE_URL, MANIFEST_SHARE_URL + ' vs ' + SHARE_URL);

const shareWorld = createWorld();
shareWorld.load();
goOnline(shareWorld);
await seed(shareWorld, CACHE, './index.html', 'INDEX-BODY', 'text/html');
shareWorld.resetFetchCalls();

function makeShareRequest(files, fields) {
  const form = new FormData();
  for (const name of Object.keys(fields || {})) form.append(name, fields[name]);
  for (const file of files) form.append('files', file);
  return new Request(SHARE_URL, { method: 'POST', body: form });
}

function sharedEntries(world) {
  const cache = world.store.get(SHARED_CACHE);
  return cache ? [...cache.entries.keys()].sort() : [];
}

const sevenzBytes = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 1, 2, 3]);
const zipBytes = new Uint8Array([0x50, 0x4b, 3, 4, 5, 6]);
const shareReq = makeShareRequest([
  new File([sevenzBytes], 'photo archive.7z', { type: 'application/x-7z-compressed' }),
  new File([zipBytes], 'bundle.zip', { type: 'application/zip' })
], { title: 'Check this', text: 'shared from the file manager', url: '' });

const shareState = fireFetch(shareWorld, shareReq);
check('(g1) POST ./__share is answered via respondWith exactly once',
  shareState.responded === true && shareState.respondWithCalls === 1,
  'calls=' + shareState.respondWithCalls);
const shareRes = await respondInfo(shareState);
check('(g1) the share response is a 303 redirect', shareRes.ok && shareRes.status === 303,
  shareRes.ok ? 'status ' + shareRes.status : shareRes.detail);
check('(g1) Location points at the relative site root (resolved against the SW location)',
  shareRes.ok && shareRes.headers && shareRes.headers.get('location') === SITE_BASE,
  shareRes.ok ? String(shareRes.headers && shareRes.headers.get('location')) : shareRes.detail);
check('(g1) the redirect body is empty (a 200 body would leave the user on a blank page)',
  shareRes.ok && shareRes.body === '', JSON.stringify(shareRes.body));
check('(g1) share handling never touched the network', shareWorld.fetchCount() === 0,
  'fetchCalls=' + shareWorld.fetchCount());

const sharedCache = shareWorld.store.get(SHARED_CACHE);
check('(g2) the shared files went into the fixed-name cache "' + SHARED_CACHE + '"', !!sharedCache,
  JSON.stringify([...shareWorld.store.keys()]));
check('(g2) exactly the two files plus the count entry are cached',
  JSON.stringify(sharedEntries(shareWorld)) ===
    JSON.stringify([SITE_BASE + '__shared/0', SITE_BASE + '__shared/1', SITE_BASE + '__shared/count'].sort()),
  JSON.stringify(sharedEntries(shareWorld)));
check('(g2) nothing was written to the versioned app-shell cache',
  (await cachedBody(shareWorld, CACHE, './__shared/0')) === undefined &&
  (await cachedBody(shareWorld, CACHE, './__shared/count')) === undefined,
  JSON.stringify([...(shareWorld.store.get(CACHE) || { entries: new Map() }).entries.keys()]));

if (sharedCache) {
  const first = sharedCache.entries.get(SITE_BASE + '__shared/0');
  const second = sharedCache.entries.get(SITE_BASE + '__shared/1');
  check('(g3) file bytes are cached intact (index 0)',
    !!first && Buffer.from(first.body).equals(Buffer.from(sevenzBytes)),
    first ? Buffer.from(first.body).toString('hex') : 'missing');
  check('(g3) file bytes are cached intact (index 1)',
    !!second && Buffer.from(second.body).equals(Buffer.from(zipBytes)),
    second ? Buffer.from(second.body).toString('hex') : 'missing');
  check('(g3) X-File-Name carries the percent-encoded original name (spaces included)',
    !!first && first.headers['x-file-name'] === encodeURIComponent('photo archive.7z'),
    first ? String(first.headers['x-file-name']) : 'missing');
  check('(g3) the file Content-Type is preserved',
    !!first && first.headers['content-type'] === 'application/x-7z-compressed',
    first ? String(first.headers['content-type']) : 'missing');
  const count = sharedCache.entries.get(SITE_BASE + '__shared/count');
  check('(g4) ./__shared/count holds the number of shared files as text/plain',
    !!count && Buffer.from(count.body).toString() === '2' &&
    /text\/plain/.test(String(count.headers['content-type'])),
    count ? Buffer.from(count.body).toString() + ' / ' + count.headers['content-type'] : 'missing');
}

// A second share must clear the leftovers of the first (stale-key deletion).
const secondShare = await respondInfo(fireFetch(shareWorld, makeShareRequest([
  new File([new Uint8Array([9, 9, 9])], 'only.7z', { type: 'application/x-7z-compressed' })
])));
check('(g5) a second share also answers 303', secondShare.ok && secondShare.status === 303,
  secondShare.ok ? 'status ' + secondShare.status : secondShare.detail);
check('(g5) stale entries from the previous share are deleted (no ./__shared/1 left)',
  JSON.stringify(sharedEntries(shareWorld)) ===
    JSON.stringify([SITE_BASE + '__shared/0', SITE_BASE + '__shared/count'].sort()),
  JSON.stringify(sharedEntries(shareWorld)));
check('(g5) the count entry now reports 1',
  (await cachedBody(shareWorld, SHARED_CACHE, './__shared/count')) === '1',
  JSON.stringify(await cachedBody(shareWorld, SHARED_CACHE, './__shared/count')));
check('(g5) the surviving entry is the NEW file, not the stale one',
  Buffer.from(shareWorld.store.get(SHARED_CACHE).entries.get(SITE_BASE + '__shared/0').body)
    .equals(Buffer.from([9, 9, 9])),
  Buffer.from(shareWorld.store.get(SHARED_CACHE).entries.get(SITE_BASE + '__shared/0').body).toString('hex'));

// Zero files: still a redirect, count 0, no file entries.
const emptyWorld = createWorld();
emptyWorld.load();
goOnline(emptyWorld);
const emptyShare = await respondInfo(fireFetch(emptyWorld, makeShareRequest([], { title: 'just text' })));
check('(g6) a share with zero files still answers 303', emptyShare.ok && emptyShare.status === 303,
  emptyShare.ok ? 'status ' + emptyShare.status : emptyShare.detail);
check('(g6) a share with zero files writes count 0 and nothing else',
  JSON.stringify(sharedEntries(emptyWorld)) === JSON.stringify([SITE_BASE + '__shared/count']) &&
  (await cachedBody(emptyWorld, SHARED_CACHE, './__shared/count')) === '0',
  JSON.stringify(sharedEntries(emptyWorld)));

// The browser sends the share POST as a NAVIGATION; the POST branch must win.
const shareNavWorld = createWorld();
shareNavWorld.load();
goOffline(shareNavWorld);
await seed(shareNavWorld, CACHE, './index.html', 'INDEX-BODY', 'text/html');
const shareNavRequest = makeShareRequest([new File([zipBytes], 'nav.zip', { type: 'application/zip' })]);
const shareNavState = fireFetch(shareNavWorld, {
  url: shareNavRequest.url,
  method: 'POST',
  mode: 'navigate',
  destination: 'document',
  referrer: '',
  headers: shareNavRequest.headers,
  formData: () => shareNavRequest.formData()
});
const shareNavRes = await respondInfo(shareNavState);
check('(g7) a navigation-mode POST to ./__share is handled as a share (never as a navigation)',
  shareNavState.responded === true && shareNavRes.ok && shareNavRes.status === 303,
  shareNavRes.ok ? 'status ' + shareNavRes.status : shareNavRes.detail);
check('(g7) the navigation-mode share still cached its file while offline',
  (await cachedBody(shareNavWorld, SHARED_CACHE, './__shared/count')) === '1',
  JSON.stringify(sharedEntries(shareNavWorld)));

// A broken multipart body must not strand the user: warn + still redirect.
const brokenWorld = createWorld();
brokenWorld.load();
goOnline(brokenWorld);
const brokenShare = fireFetch(brokenWorld, {
  url: SHARE_URL,
  method: 'POST',
  mode: 'navigate',
  headers: new Headers(),
  formData: async () => {
    throw new TypeError('no multipart boundary');
  }
});
const brokenRes = await respondInfo(brokenShare);
check('(g8) an unparseable share body still answers 303 (the share never strands the user)',
  brokenRes.ok && brokenRes.status === 303, brokenRes.ok ? 'status ' + brokenRes.status : brokenRes.detail);
check('(g8) the failure is logged as a console.warn, not thrown at the browser',
  brokenWorld.warnings.length >= 1 && brokenWorld.errors.length === 0,
  JSON.stringify({ warnings: brokenWorld.warnings, errors: brokenWorld.errors }));
check('(g8) a failed share leaves no shared-file entries behind',
  sharedEntries(brokenWorld).length === 0, JSON.stringify(sharedEntries(brokenWorld)));

/* ======================================================== full lifecycle == */

section('end-to-end: install -> activate -> fully offline browsing');

const e2e = createWorld();
e2e.load();
goOnline(e2e, async (url) => {
  if (url.endsWith('/index.html')) {
    return new Response('REAL INDEX', { status: 200, headers: { 'Content-Type': 'text/html' } });
  }
  if (url.endsWith('/offline.html')) {
    return new Response('REAL OFFLINE', { status: 200, headers: { 'Content-Type': 'text/html' } });
  }
  return new Response('ASSET ' + url, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
});
const e2eInstall = await settled(fireLifecycle(e2e, 'install').done);
check('e2e install resolved', e2eInstall.ok, e2eInstall.ok ? '' : String(e2eInstall.error));
const e2eActivate = await settled(fireLifecycle(e2e, 'activate').done);
check('e2e activate resolved', e2eActivate.ok, e2eActivate.ok ? '' : String(e2eActivate.error));
check('e2e cache holds all ' + FIXTURE_ASSETS.length + ' assets after install',
  e2e.store.get(CACHE).entries.size === FIXTURE_ASSETS.length,
  'entries=' + e2e.store.get(CACHE).entries.size);

goOffline(e2e);
e2e.resetFetchCalls();
const e2eNav = await respondInfo(fireFetch(e2e, makeRequest(SITE_BASE + 'index.html?fresh=1', { mode: 'navigate' })));
check('e2e offline navigation served the precached index.html',
  e2eNav.ok && e2eNav.body === 'REAL INDEX', e2eNav.ok ? JSON.stringify(e2eNav.body) : e2eNav.detail);
const e2eWasm = await respondInfo(fireFetch(e2e, makeRequest(SITE_BASE + 'wasm/7zz.wasm')));
check('e2e offline request served the precached wasm binary',
  e2eWasm.ok && e2eWasm.body === 'ASSET ' + SITE_BASE + 'wasm/7zz.wasm',
  e2eWasm.ok ? JSON.stringify(e2eWasm.body) : e2eWasm.detail);
const e2eWorker = await respondInfo(fireFetch(e2e, makeRequest(SITE_BASE + 'worker.js')));
check('e2e offline request served the precached worker.js',
  e2eWorker.ok && e2eWorker.body === 'ASSET ' + SITE_BASE + 'worker.js',
  e2eWorker.ok ? JSON.stringify(e2eWorker.body) : e2eWorker.detail);
check('e2e made zero network calls while offline', e2e.fetchCount() === 0,
  'fetchCalls=' + e2e.fetchCount());

/* ----------------------------------------------------------------- report */

console.log('\n' + '-'.repeat(70));
console.log('sw-test: ' + passCount + ' passed, ' + failCount + ' failed');
if (failCount > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log('  - ' + failure);
  process.exit(1);
}
console.log('ALL SW TESTS PASSED');
process.exit(0);
