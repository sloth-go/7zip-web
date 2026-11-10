#!/usr/bin/env node
/*
 * Mock-harness test for the 7-Zip WASM service worker: share target + shared
 * cache (PWA file handling), plus GET-flow regression checks.
 *
 * Runs the REAL /home/ubuntu/software/7zip-web/sw.js inside a vm context with
 * stubbed service-worker globals (self, location, caches, importScripts, fetch,
 * clients, skipWaiting, addEventListener) and Node's real Request/Response/
 * Headers/FormData/File/Blob/URL, from a SUBPATH deployment
 * (self.location = https://example.com/sub/dir/sw.js). Asserts:
 *
 *   (a) activate preserves "7zip-web-shared" while deleting other old caches
 *   (b) POST ./__share with 2 files -> 303 + absolute Location; shared cache
 *       holds __shared/0, __shared/1, count "2", X-File-Name round-trips
 *       (incl. a unicode name)
 *   (c) POST with zero files -> count "0" + 303
 *   (d) formData() rejecting -> still 303, warn logged, no crash
 *   (e) a second share clears stale keys first (no __shared/1+ leftovers)
 *   (f) GET regression: navigation->network, cached asset->cache hit,
 *       build-info.json->network-first, HEAD/PUT untouched, POST to a
 *       different path untouched, cross-origin passthrough, data: untouched
 *
 * Harness style mirrors /tmp/pwa-tests/sw-test.mjs (ported to tests/sw-test.mjs).
 *
 * Usage: node tests/sw-share-target.test.mjs   (from the repo root)
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW_PATH = path.join(REPO, 'sw.js');

// Subpath deployment: every relative URL in sw.js resolves against this.
const SW_URL = 'https://example.com/sub/dir/sw.js';
const SITE_BASE = 'https://example.com/sub/dir/';
const SHARE_URL = SITE_BASE + '__share';

const FIXTURE_VERSION = '26.06-share-test';
const FIXTURE_ASSETS = ['./index.html', './offline.html', './app.js', './build-info.json'];
const CACHE = '7zip-web-' + FIXTURE_VERSION;
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
      headers: null
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
    headers: response.headers
  };
}

function bytesEq(a, b) {
  return Buffer.from(a).equals(Buffer.from(b));
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

  async delete(request) {
    return this.entries.delete(cacheKey(request, false));
  }

  async keys() {
    return [...this.entries.values()].map((entry) => new Request(entry.url));
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

// A real multipart/form-data POST, exactly like the Android share sheet sends.
function makeSharePost(files, fields = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  for (const file of files) form.append('files', file);
  return new Request(SHARE_URL, { method: 'POST', body: form });
}

/* ------------------------------------------------------------- mock world */

function createWorld() {
  const world = {
    listeners: new Map(),
    store: new Map(), // cache name -> MockCache
    fetchCalls: [],
    fetchImpl: null,
    skipWaitingCalls: 0,
    claimCalls: 0,
    importScriptsCalls: [],
    logs: [],
    warnings: [],
    errors: []
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
    FormData,
    Blob,
    File,
    TextEncoder,
    TextDecoder,
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
        // Inline the generated manifest fixture (no files outside tests/).
        vm.runInContext(
          'self.__SW_VERSION__ = ' + JSON.stringify(FIXTURE_VERSION) + ';\n' +
          'self.__SW_ASSETS__ = ' + JSON.stringify(FIXTURE_ASSETS) + ';\n',
          world.ctx,
          { filename: String(url) }
        );
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

async function cachedText(world, cacheName, relPath) {
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

// Shared-cache entry lookup by synthetic sub-path ('__shared/0', '__shared/count').
function sharedEntry(world, subPath) {
  const cache = world.store.get(SHARED_CACHE);
  if (!cache) return undefined;
  return cache.entries.get(new URL('./' + subPath, SITE_BASE).href);
}

function sharedKeys(world) {
  const cache = world.store.get(SHARED_CACHE);
  if (!cache) return [];
  return [...cache.entries.keys()].map((k) => new URL(k).pathname).sort();
}

/* ============================ static contract checks on the sw.js source == */

section('static source contract');

const swSource = fs.readFileSync(SW_PATH, 'utf8');
check("sw.js: CACHE name expression unchanged ('7zip-web-' + (self.__SW_VERSION__ || 'dev'))",
  swSource.includes("var CACHE = '7zip-web-' + (self.__SW_VERSION__ || 'dev');"));
check("sw.js: SHARED_CACHE is the fixed, never-versioned '7zip-web-shared'",
  /var SHARED_CACHE = '7zip-web-shared';/.test(swSource));
check('sw.js: no external http(s) URL literals', !/https?:\/\//i.test(swSource));

/* ======================================================== (a) activate ==== */

section('(a) activate: keeps CACHE + SHARED_CACHE, deletes every other cache');

{
  const world = createWorld();
  world.load();
  await seed(world, CACHE, './index.html', 'SHELL', 'text/html');
  await seed(world, SHARED_CACHE, './__shared/0', 'UNCONSUMED SHARE', 'application/octet-stream');
  await seed(world, '7zip-web-old', './index.html', 'OLD', 'text/html');
  await seed(world, 'junk-v1', './x', 'JUNK', 'text/plain');
  goOnline(world);

  const activate = await settled(fireLifecycle(world, 'activate').done);
  check('(a) activate promise resolved', activate.ok,
    activate.ok ? '' : String(activate.error));

  const keys = [...world.store.keys()].sort();
  check('(a) only CACHE and SHARED_CACHE survive activate',
    keys.length === 2 && keys.indexOf(CACHE) >= 0 && keys.indexOf(SHARED_CACHE) >= 0,
    JSON.stringify(keys));
  check('(a) the pre-existing shared cache entry is intact',
    (await cachedText(world, SHARED_CACHE, './__shared/0')) === 'UNCONSUMED SHARE');
  check('(a) the current app-shell cache is intact',
    (await cachedText(world, CACHE, './index.html')) === 'SHELL');
  check('(a) clients.claim was called once', world.claimCalls === 1,
    'claimCalls=' + world.claimCalls);
}

/* ================================== (b) share POST with two files ========= */

section('(b) POST ./__share from a subpath with 2 multipart files');

const shareWorld = createWorld();
shareWorld.load();
goOnline(shareWorld);
await seed(shareWorld, CACHE, './index.html', 'SHELL', 'text/html');
shareWorld.resetFetchCalls();

const FILE_A_BYTES = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 1, 2, 3]);
const FILE_B_TEXT = 'shared notes body';
const FILE_A_NAME = 'отчёт.7z'; // unicode name, must survive the header round-trip
const FILE_B_NAME = 'notes txt.zip';

const shareReq = makeSharePost(
  [
    new File([FILE_A_BYTES], FILE_A_NAME, { type: 'application/x-7z-compressed' }),
    new File([FILE_B_TEXT], FILE_B_NAME, { type: 'application/zip' })
  ],
  { title: 'Look at this', text: 'cool archive', url: 'https://elsewhere.example/page' }
);

const shareFetch = fireFetch(shareWorld, shareReq);
check('(b) the share POST was answered via respondWith exactly once',
  shareFetch.responded === true && shareFetch.respondWithCalls === 1,
  'respondWithCalls=' + shareFetch.respondWithCalls);

const shareRes = await respondInfo(shareFetch);
check('(b) response is a 303 redirect', shareRes.ok && shareRes.status === 303,
  shareRes.ok ? 'status ' + shareRes.status : shareRes.detail);
check('(b) Location is the ABSOLUTE app root under the subpath',
  shareRes.ok && shareRes.headers.get('location') === 'https://example.com/sub/dir/',
  shareRes.ok ? JSON.stringify(shareRes.headers.get('location')) : shareRes.detail);
check('(b) the share POST never hit the network fetch spy',
  shareWorld.fetchCount() === 0, 'fetchCalls=' + shareWorld.fetchCount());

check('(b) shared cache holds exactly __shared/0, __shared/1 and __shared/count',
  sharedKeys(shareWorld).length === 3 &&
  !!sharedEntry(shareWorld, '__shared/0') &&
  !!sharedEntry(shareWorld, '__shared/1') &&
  !!sharedEntry(shareWorld, '__shared/count'),
  JSON.stringify(sharedKeys(shareWorld)));

check('(b) __shared/count === "2"',
  sharedEntry(shareWorld, '__shared/count') &&
  new TextDecoder().decode(sharedEntry(shareWorld, '__shared/count').body) === '2');
check('(b) count entry Content-Type is text/plain',
  sharedEntry(shareWorld, '__shared/count') &&
  sharedEntry(shareWorld, '__shared/count').headers['content-type'] === 'text/plain',
  JSON.stringify(sharedEntry(shareWorld, '__shared/count') && sharedEntry(shareWorld, '__shared/count').headers));

const entry0 = sharedEntry(shareWorld, '__shared/0');
const entry1 = sharedEntry(shareWorld, '__shared/1');
check('(b) __shared/0 X-File-Name decodes to the unicode original',
  entry0 && decodeURIComponent(entry0.headers['x-file-name']) === FILE_A_NAME,
  entry0 ? JSON.stringify(entry0.headers['x-file-name']) : 'missing');
check('(b) __shared/0 Content-Type is the file type',
  entry0 && entry0.headers['content-type'] === 'application/x-7z-compressed',
  entry0 ? JSON.stringify(entry0.headers['content-type']) : 'missing');
check('(b) __shared/0 body bytes are the file bytes',
  entry0 && bytesEq(entry0.body, FILE_A_BYTES));
check('(b) __shared/1 X-File-Name decodes to the second file name',
  entry1 && decodeURIComponent(entry1.headers['x-file-name']) === FILE_B_NAME,
  entry1 ? JSON.stringify(entry1.headers['x-file-name']) : 'missing');
check('(b) __shared/1 body matches the second file',
  entry1 && new TextDecoder().decode(entry1.body) === FILE_B_TEXT);
check('(b) nothing was written into the versioned app-shell cache',
  [...(shareWorld.store.get(CACHE) || { entries: new Map() }).entries.keys()]
    .filter((k) => k.includes('__shared')).length === 0);

// The shared entries must be readable through the real Cache API surface
// (fresh Response per match), like app.js consumeSharedFiles() reads them.
{
  const cache = shareWorld.store.get(SHARED_CACHE);
  const keys = await cache.keys();
  const matched = [];
  for (const key of keys) {
    const resp = await cache.match(key);
    matched.push({
      url: key.url,
      name: decodeURIComponent(resp.headers.get('X-File-Name') || ''),
      bytes: new Uint8Array(await resp.arrayBuffer())
    });
  }
  const zero = matched.find((m) => m.url.endsWith('/__shared/0'));
  const one = matched.find((m) => m.url.endsWith('/__shared/1'));
  check('(b) cache.match on cache.keys() round-trips header + body (app.js read path)',
    matched.length === 3 && !!zero && zero.name === FILE_A_NAME &&
    bytesEq(zero.bytes, FILE_A_BYTES) &&
    !!one && one.name === FILE_B_NAME &&
    new TextDecoder().decode(one.bytes) === FILE_B_TEXT);
}

/* ===================================== (c) share POST with zero files ===== */

section('(c) POST ./__share with zero files');

{
  const world = createWorld();
  world.load();
  goOnline(world);
  const res = await respondInfo(fireFetch(world, makeSharePost([], { title: 'just text', url: 'https://x.example' })));
  check('(c) zero-file share still redirects with 303', res.ok && res.status === 303,
    res.ok ? 'status ' + res.status : res.detail);
  check('(c) Location is the absolute app root',
    res.ok && res.headers.get('location') === 'https://example.com/sub/dir/');
  check('(c) __shared/count === "0"',
    sharedEntry(world, '__shared/count') &&
    new TextDecoder().decode(sharedEntry(world, '__shared/count').body) === '0');
  check('(c) no __shared/0 entry was created', !sharedEntry(world, '__shared/0'));
  check('(c) exactly one shared-cache key', sharedKeys(world).length === 1,
    JSON.stringify(sharedKeys(world)));
}

/* ================================== (d) formData() rejects ================ */

section('(d) request.formData() rejecting');

{
  const world = createWorld();
  world.load();
  goOnline(world);
  const brokenRequest = {
    url: SHARE_URL,
    method: 'POST',
    mode: 'navigate',
    headers: new Headers(),
    formData: () => Promise.reject(new Error('multipart parse boom'))
  };
  const res = await respondInfo(fireFetch(world, brokenRequest));
  check('(d) a broken share POST still resolves to a 303 redirect',
    res.ok && res.status === 303, res.ok ? 'status ' + res.status : res.detail);
  check('(d) Location is the absolute app root',
    res.ok && res.headers.get('location') === 'https://example.com/sub/dir/');
  check('(d) the failure was logged via console.warn',
    world.warnings.some((w) => w.includes('share-target handling failed') && w.includes('multipart parse boom')),
    JSON.stringify(world.warnings));
  check('(d) nothing crashed into console.error', world.errors.length === 0,
    JSON.stringify(world.errors));
}

/* ============================== (e) second share clears stale keys ======== */

section('(e) a second share clears the leftovers of the first');

{
  const world = createWorld();
  world.load();
  goOnline(world);

  const first = await respondInfo(fireFetch(world, makeSharePost([
    new File(['A1'], 'a1.7z', { type: 'application/x-7z-compressed' }),
    new File(['A2'], 'a2.zip', { type: 'application/zip' }),
    new File(['A3'], 'a3.tar', { type: 'application/x-tar' })
  ])));
  check('(e) first share (3 files) redirected 303', first.ok && first.status === 303,
    first.ok ? 'status ' + first.status : first.detail);
  check('(e) first share wrote __shared/0..2 + count "3"',
    sharedKeys(world).length === 4 &&
    new TextDecoder().decode(sharedEntry(world, '__shared/count').body) === '3',
    JSON.stringify(sharedKeys(world)));

  const second = await respondInfo(fireFetch(world, makeSharePost([
    new File(['B1'], 'b1.7z', { type: 'application/x-7z-compressed' })
  ])));
  check('(e) second share (1 file) redirected 303', second.ok && second.status === 303,
    second.ok ? 'status ' + second.status : second.detail);

  const keys = sharedKeys(world);
  check('(e) stale keys were cleared: exactly __shared/0 + __shared/count remain',
    keys.length === 2 &&
    keys.indexOf('/sub/dir/__shared/0') >= 0 &&
    keys.indexOf('/sub/dir/__shared/count') >= 0,
    JSON.stringify(keys));
  check('(e) no __shared/1 or __shared/2 leftovers',
    !sharedEntry(world, '__shared/1') && !sharedEntry(world, '__shared/2'));
  check('(e) count === "1" after the second share',
    new TextDecoder().decode(sharedEntry(world, '__shared/count').body) === '1');
  check('(e) __shared/0 is the SECOND share\'s file (not stale bytes)',
    decodeURIComponent(sharedEntry(world, '__shared/0').headers['x-file-name']) === 'b1.7z' &&
    new TextDecoder().decode(sharedEntry(world, '__shared/0').body) === 'B1');
}

/* =============== (b2) navigate-mode share POST + name/type fallbacks ====== */

section('(b2) navigate-mode POST to ./__share (how the real share sheet delivers it)');

{
  const world = createWorld();
  world.load();
  goOnline(world);
  world.resetFetchCalls();

  // Real Android/Chrome share-target POSTs arrive as *navigations*. undici
  // refuses to construct such a Request, so use a plain mock carrying a real
  // FormData body — the SW only reads .url, .method and .formData().
  const form = new FormData();
  form.append('title', 'shared from the browser UI');
  form.append('files', new File(['NAVBYTES'], 'nav-share.7z', { type: 'application/x-7z-compressed' }));
  const navPost = {
    url: SHARE_URL,
    method: 'POST',
    mode: 'navigate',
    destination: 'document',
    referrer: '',
    headers: new Headers(),
    formData: async () => form
  };
  const fetchState = fireFetch(world, navPost);
  check('(b2) navigate-mode POST to ./__share is intercepted (POST branch runs before navigate handling)',
    fetchState.responded === true && fetchState.respondWithCalls === 1,
    'respondWithCalls=' + fetchState.respondWithCalls);
  const res = await respondInfo(fetchState);
  check('(b2) navigate-mode share answers 303 with the absolute app root',
    res.ok && res.status === 303 && res.headers.get('location') === 'https://example.com/sub/dir/',
    res.ok ? 'status ' + res.status + ' loc ' + JSON.stringify(res.headers.get('location')) : res.detail);
  check('(b2) the navigated share file landed in the shared cache with name + bytes intact',
    !!sharedEntry(world, '__shared/0') &&
    decodeURIComponent(sharedEntry(world, '__shared/0').headers['x-file-name']) === 'nav-share.7z' &&
    new TextDecoder().decode(sharedEntry(world, '__shared/0').body) === 'NAVBYTES');
  check('(b2) the navigate-mode share never hit the network fetch spy',
    world.fetchCount() === 0, 'fetchCalls=' + world.fetchCount());

  // Contract fallbacks: empty file.name -> 'file' + index; empty file.type
  // -> application/octet-stream.
  const form2 = new FormData();
  form2.append('files', new File(['NONAME'], ''));
  const res2 = await respondInfo(fireFetch(world, {
    url: SHARE_URL,
    method: 'POST',
    mode: 'cors',
    headers: new Headers(),
    formData: async () => form2
  }));
  check('(b3) a nameless/typeless shared file still redirects 303',
    res2.ok && res2.status === 303,
    res2.ok ? 'status ' + res2.status : res2.detail);
  const e0 = sharedEntry(world, '__shared/0');
  check('(b3) empty file.name falls back to "file0" and empty type to application/octet-stream',
    !!e0 && decodeURIComponent(e0.headers['x-file-name']) === 'file0' &&
    e0.headers['content-type'] === 'application/octet-stream' &&
    new TextDecoder().decode(e0.body) === 'NONAME',
    e0 ? JSON.stringify(e0.headers) : 'missing');
  check('(b3) the stale nav-share keys were cleared before the fallback share',
    sharedKeys(world).length === 2, JSON.stringify(sharedKeys(world)));
}

/* ============================== (f) GET / non-share regression ============ */

section('(f) regression: existing GET behavior is untouched');

{
  const world = createWorld();
  world.load();
  goOnline(world);

  // Navigation with nothing cached -> network.
  world.resetFetchCalls();
  const nav = await respondInfo(fireFetch(world, makeRequest(SITE_BASE, { mode: 'navigate' })));
  check('(f) uncached navigation goes to the network',
    nav.ok && nav.body === 'NET ' + SITE_BASE && world.fetchCount() === 1,
    nav.ok ? JSON.stringify(nav.body) : nav.detail);

  // Cached asset -> cache hit, no network.
  await seed(world, CACHE, './app.js', 'APP-CACHED', 'text/javascript');
  world.resetFetchCalls();
  const hit = await respondInfo(fireFetch(world, makeRequest(SITE_BASE + 'app.js')));
  check('(f) a cached same-origin asset is served from the cache',
    hit.ok && hit.body === 'APP-CACHED' && world.fetchCount() === 0,
    hit.ok ? JSON.stringify(hit.body) : hit.detail);

  // build-info.json -> network first, cache refreshed, offline fallback.
  await seed(world, CACHE, './build-info.json', '{"version":"OLD"}', 'application/json');
  goOnline(world, async (url) => {
    if (url.endsWith('/build-info.json')) {
      return new Response('{"version":"FRESH"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('NET ' + url, { status: 200 });
  });
  world.resetFetchCalls();
  const info = await respondInfo(fireFetch(world, makeRequest(SITE_BASE + 'build-info.json')));
  check('(f) build-info.json is network-first (fresh body returned)',
    info.ok && info.body === '{"version":"FRESH"}' && world.fetchCount() === 1,
    info.ok ? JSON.stringify(info.body) : info.detail);
  check('(f) build-info.json fresh copy was cached',
    (await cachedText(world, CACHE, './build-info.json')) === '{"version":"FRESH"}');
  goOffline(world);
  const infoOff = await respondInfo(fireFetch(world, makeRequest(SITE_BASE + 'build-info.json?v=2')));
  check('(f) offline build-info.json falls back to the cached copy',
    infoOff.ok && infoOff.body === '{"version":"FRESH"}',
    infoOff.ok ? JSON.stringify(infoOff.body) : infoOff.detail);
  goOnline(world);

  // Non-GET non-POST methods are untouched.
  world.resetFetchCalls();
  const head = fireFetch(world, makeRequest(SITE_BASE + 'app.js', { method: 'HEAD' }));
  check('(f) HEAD is untouched (no respondWith, no fetch)',
    head.responded === false && head.respondWithCalls === 0 && world.fetchCount() === 0);
  const put = fireFetch(world, makeRequest(SITE_BASE + 'app.js', { method: 'PUT' }));
  check('(f) PUT is untouched (no respondWith, no fetch)',
    put.responded === false && put.respondWithCalls === 0 && world.fetchCount() === 0);
  const del = fireFetch(world, makeRequest(SITE_BASE + 'app.js', { method: 'DELETE' }));
  check('(f) DELETE is untouched (no respondWith, no fetch)',
    del.responded === false && del.respondWithCalls === 0 && world.fetchCount() === 0);

  // POST to a different path is untouched (and never cached).
  world.resetFetchCalls();
  const otherPost = fireFetch(world, makeRequest(SITE_BASE + 'upload', { method: 'POST' }));
  check('(f) POST to a non-__share path is untouched (no respondWith, no fetch)',
    otherPost.responded === false && otherPost.respondWithCalls === 0 && world.fetchCount() === 0,
    'respondWithCalls=' + otherPost.respondWithCalls);
  const cachedUploads = [];
  for (const [, cache] of world.store) {
    for (const key of cache.entries.keys()) if (key.endsWith('/upload')) cachedUploads.push(key);
  }
  check('(f) the non-share POST was not cached', cachedUploads.length === 0, JSON.stringify(cachedUploads));

  // A POST navigation (form POST to the app root) must NOT reach navigationResponse.
  world.resetFetchCalls();
  const navPost = fireFetch(world, {
    url: SITE_BASE,
    method: 'POST',
    mode: 'navigate',
    destination: 'document',
    headers: new Headers()
  });
  check('(f) a POST navigation to "/" is untouched (never answered as a navigation)',
    navPost.responded === false && navPost.respondWithCalls === 0 && world.fetchCount() === 0);

  // Cross-origin GET: plain fetch, never cached.
  world.resetFetchCalls();
  const cross = await respondInfo(fireFetch(world, makeRequest('https://cdn.example/other.js')));
  check('(f) cross-origin GET is passed through to the network',
    cross.ok && cross.body === 'NET https://cdn.example/other.js' && world.fetchCount() === 1,
    cross.ok ? JSON.stringify(cross.body) : cross.detail);
  const cachedCross = [];
  for (const [, cache] of world.store) {
    for (const key of cache.entries.keys()) if (key.includes('cdn.example')) cachedCross.push(key);
  }
  check('(f) the cross-origin response was never cached', cachedCross.length === 0, JSON.stringify(cachedCross));

  // Non-http(s) GET: untouched.
  const dataReq = fireFetch(world, {
    url: 'data:text/plain,hi',
    method: 'GET',
    mode: 'no-cors',
    headers: new Headers()
  });
  check('(f) data: URL GET is untouched (no respondWith)', dataReq.responded === false);
}

/* ----------------------------------------------------------------- report */

console.log('\n' + '-'.repeat(70));
console.log('sw-share-target: ' + passCount + ' passed, ' + failCount + ' failed');
if (failCount > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log('  - ' + failure);
  process.exit(1);
}
console.log('ALL SW SHARE-TARGET TESTS PASSED');
process.exit(0);
