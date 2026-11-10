#!/usr/bin/env node
/*
 * Integration check (bonus, sibling-generator dependent):
 * run the real .github/scripts/generate-sw-manifest.mjs over a copy of the
 * site, then drive sw.js with the REAL generated sw-manifest.js in the same
 * mock harness used by sw-test.mjs.
 *
 * Usage: node tests/sw-integration-check.mjs   (from the repo root; any cwd)
 *
 * The staged site copy lives OUTSIDE the repo ($TMPDIR/7zip-web-tests/
 * sw-integration-check/site): it copies every non-dot top-level entry of the
 * repo, tests/ included, so copying into tests/ itself would recurse — and
 * keeping tests/ in the copy is what proves the generator excludes it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Repo root derived from this file's own location (tests/..).
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = path.join(REPO, '.github/scripts/generate-sw-manifest.mjs');
const SITE = path.join(os.tmpdir(), '7zip-web-tests', 'sw-integration-check', 'site');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' -- ' + extra : '')); console.log('FAIL  ' + name + (extra ? '  -- ' + extra : '')); }
}

/* ------------------------------------------------- stage a copy of the site */
// The offline wasm byte-compare at the end needs the real build; without it the
// staged site would have nothing meaningful to precache.
if (!fs.existsSync(path.join(REPO, 'wasm', '7zz.js')) || !fs.existsSync(path.join(REPO, 'wasm', '7zz.wasm'))) {
  console.log('SKIPPED (wasm not built)');
  process.exit(0);
}

fs.rmSync(SITE, { recursive: true, force: true });
fs.mkdirSync(SITE, { recursive: true });
for (const entry of fs.readdirSync(REPO, { withFileTypes: true })) {
  if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
  const src = path.join(REPO, entry.name);
  const dst = path.join(SITE, entry.name);
  fs.cpSync(src, dst, { recursive: true });
}
// app.js / worker.js may not exist yet while siblings are still writing them.
for (const name of ['app.js', 'worker.js']) {
  const p = path.join(SITE, name);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '/* placeholder ' + name + ' */\n');
}

execFileSync(process.execPath, [GENERATOR, SITE], { stdio: 'inherit' });

const manifestPath = path.join(SITE, 'sw-manifest.js');
check('generator wrote <site>/sw-manifest.js', fs.existsSync(manifestPath));
const generated = fs.readFileSync(manifestPath, 'utf8');
console.log('--- generated sw-manifest.js ---\n' + generated.trim() + '\n--------------------------------');

// Pull the two globals out with a throwaway context.
const probe = { self: {} };
vm.runInNewContext(generated, probe);
const version = probe.self.__SW_VERSION__;
const assets = probe.self.__SW_ASSETS__;
check('__SW_VERSION__ is a non-empty string', typeof version === 'string' && version.length > 0, String(version));
check('__SW_ASSETS__ is a non-empty array of "./" URLs',
  Array.isArray(assets) && assets.length > 0 && assets.every((a) => typeof a === 'string' && a.startsWith('./')),
  JSON.stringify(assets));
check('assets include ./index.html and ./offline.html',
  assets.includes('./index.html') && assets.includes('./offline.html'));
check('assets exclude sw.js, sw-manifest.js and build-info.json',
  !assets.some((a) => /(^|\/)(sw\.js|sw-manifest\.js|build-info\.json)$/.test(a)), JSON.stringify(assets));
check('the staged copy really contains tests/ files (so the next check is not vacuous)',
  fs.existsSync(path.join(SITE, 'tests')) &&
  fs.readdirSync(path.join(SITE, 'tests')).filter((n) => n.endsWith('.mjs')).length > 0,
  JSON.stringify(fs.existsSync(path.join(SITE, 'tests')) ? fs.readdirSync(path.join(SITE, 'tests')) : null));
check('assets exclude every tests/ entry (test suites are never precached or published)',
  !assets.some((a) => a.startsWith('./tests/')),
  JSON.stringify(assets.filter((a) => a.startsWith('./tests/'))));

const CACHE = '7zip-web-' + version;
const SITE_BASE = 'https://example.github.io/7zip-web/';

/* ------------------------------------ minimal mock SW environment for sw.js */
const store = new Map();
const listeners = new Map();
const fetchCalls = [];
let skipWaitingCalls = 0;
let claimCalls = 0;

function key(request, ignoreSearch) {
  const u = new URL(typeof request === 'string' ? request : request.url);
  u.hash = '';
  if (ignoreSearch) u.search = '';
  return u.href;
}
class MockCache {
  constructor(name, world) { this.name = name; this.world = world; this.entries = new Map(); }
  async put(request, response) {
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    const k = key(request, false);
    this.entries.set(k, { url: k, body: new Uint8Array(await response.arrayBuffer()), status: response.status, statusText: response.statusText, headers });
  }
  async match(request, options = {}) {
    const target = key(request, !!options.ignoreSearch);
    for (const [k, e] of this.entries) {
      if ((options.ignoreSearch ? key(k, true) : k) === target) {
        return new Response(e.body.slice(), { status: e.status, statusText: e.statusText, headers: e.headers });
      }
    }
    return undefined;
  }
  async addAll(requests) {
    const list = [...requests];
    const responses = [];
    for (const r of list) {
      const res = await this.world.fetch(r);
      if (!res || !res.ok) throw new TypeError('addAll: bad response for ' + (typeof r === 'string' ? r : r.url));
      responses.push(res);
    }
    for (let i = 0; i < list.length; i++) await this.put(typeof list[i] === 'string' ? list[i] : list[i].url, responses[i]);
  }
  async delete(r) { return this.entries.delete(key(r, false)); }
  async keys() { return [...this.entries.values()].map((e) => new Request(e.url)); }
}
const world = { fetch: null, store };
const cachesApi = {
  async open(name) { if (!store.has(name)) store.set(name, new MockCache(name, world)); return store.get(name); },
  async has(name) { return store.has(name); },
  async delete(name) { return store.delete(name); },
  async keys() { return [...store.keys()]; }
};
const sandbox = {
  console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
  URL, Request, Response, Headers, TextEncoder, TextDecoder,
  caches: cachesApi,
  addEventListener(t, fn) { listeners.set(t, [...(listeners.get(t) || []), fn]); },
  importScripts(...urls) {
    for (const u of urls) {
      // Resolve './sw-manifest.js' against the staged site, exactly as the
      // browser would resolve it against the deployed site root.
      const rel = u.replace(/^\.\//, '');
      vm.runInContext(fs.readFileSync(path.join(SITE, rel), 'utf8'), ctx, { filename: u });
    }
  },
  skipWaiting: async () => { skipWaitingCalls++; },
  clients: { claim: async () => { claimCalls++; } },
  location: new URL(SITE_BASE + 'sw.js')
};
sandbox.fetch = (...args) => {
  fetchCalls.push(args[0]);
  return Promise.resolve().then(() => {
    const rel = String(typeof args[0] === 'string' ? args[0] : args[0].url).slice(SITE_BASE.length);
    const file = path.join(SITE, rel);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return new Response('404 ' + rel, { status: 404, statusText: 'Not Found' });
    }
    return new Response(fs.readFileSync(file), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  });
};
sandbox.self = sandbox;
world.fetch = sandbox.fetch;
const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(REPO + '/sw.js', 'utf8'), ctx, { filename: 'sw.js' });

/* ------------------------------------------------------------- run install */
const waitUntils = [];
for (const fn of listeners.get('install') || []) {
  fn.call(sandbox, { type: 'install', waitUntil: (p) => waitUntils.push(p) });
}
let installError = null;
try { await Promise.all(waitUntils); } catch (e) { installError = e; }
check('install against the REAL generated manifest resolved', installError === null,
  installError ? installError.message : '');
check('install created cache "' + CACHE + '"', store.has(CACHE), JSON.stringify([...store.keys()]));
const cache = store.get(CACHE);
const missing = [];
for (const asset of assets) {
  const url = new URL(asset, SITE_BASE).href;
  if (!cache || !(await cache.match(url))) missing.push(asset);
}
check('install precached all ' + assets.length + ' generated assets', missing.length === 0, JSON.stringify(missing));
check('install called skipWaiting', skipWaitingCalls === 1);

const activateP = [];
for (const fn of listeners.get('activate') || []) {
  fn.call(sandbox, { type: 'activate', waitUntil: (p) => activateP.push(p) });
}
let activateError = null;
try { await Promise.all(activateP); } catch (e) { activateError = e; }
check('activate resolved and claimed clients', activateError === null && claimCalls === 1,
  activateError ? activateError.message : 'claimCalls=' + claimCalls);

/* ---------------------------------------- offline navigation + wasm serving */
fetchCalls.length = 0;
const offlineFetch = () => { throw new TypeError('Failed to fetch (offline)'); };
sandbox.fetch = (...args) => { fetchCalls.push(args[0]); return Promise.resolve().then(offlineFetch); };
world.fetch = sandbox.fetch;

function fire(request) {
  let promise = null;
  for (const fn of listeners.get('fetch') || []) {
    fn.call(sandbox, {
      type: 'fetch', request, clientId: 'c1', resultingClientId: 'c1',
      waitUntil: () => {}, respondWith: (p) => { promise = p; }
    });
  }
  return promise;
}

const navBody = await fire({ url: SITE_BASE, method: 'GET', mode: 'navigate', headers: new Headers() }).then((r) => r.text());
check('fully offline: navigation serves the generated, precached index.html',
  navBody === fs.readFileSync(path.join(SITE, 'index.html'), 'utf8'), 'got ' + navBody.slice(0, 60) + '...');
const wasmRes = await fire(new Request(SITE_BASE + 'wasm/7zz.wasm'));
const wasmBody = new Uint8Array(await wasmRes.arrayBuffer());
const wasmOnDisk = fs.readFileSync(path.join(SITE, 'wasm/7zz.wasm'));
check('fully offline: wasm/7zz.wasm served byte-identical from the cache (' + wasmOnDisk.length + ' bytes)',
  wasmBody.length === wasmOnDisk.length && Buffer.from(wasmBody).equals(wasmOnDisk),
  'cached=' + wasmBody.length + ' disk=' + wasmOnDisk.length);
check('fully offline: zero network calls were made', fetchCalls.length === 0, 'fetchCalls=' + fetchCalls.length);

console.log('\n' + '-'.repeat(60));
console.log('sw-integration-check: ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\nFailures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('ALL INTEGRATION CHECKS PASSED');
process.exit(0);
