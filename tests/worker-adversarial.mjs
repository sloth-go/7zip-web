/*
 * worker-adversarial.mjs — adversarial Node verification of <repo>/worker.js
 * against the REAL 7zz wasm build shipped in <repo>/wasm.
 *
 * Harness approach bootstrapped from the implementer's worker-integration.mjs:
 * a vm context stubbing self{location,postMessage,onmessage}, importScripts
 * (mapping './wasm/' to the repo build), fetch (real 7zz.wasm bytes),
 * console, URL — then driving context.self.onmessage({data}).
 *
 * Scenarios (all required by the verification task):
 *   (a) unicode filenames incl. CJK and emoji (compress -> list -> extract)
 *   (b) 0-byte file compress + extract roundtrip
 *   (c) ~1 MiB pseudorandom (incompressible) file roundtrip with byte compare
 *   (d) zip format compress then list + extract
 *   (e) two sequential jobs back-to-back proving /job<id> FS cleanup
 *       (probe Module.FS.readdir('/') — no stale job dirs, no stale-path errors)
 *   (f) extract of an archive containing directory entries
 *
 * Run: node tests/worker-adversarial.mjs   (from the repo root; any cwd works)
 * Prints "SKIPPED (wasm not built)" and exits 0 when <repo>/wasm is missing.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Repo root derived from this file's own location (tests/..) so the suite runs
// from anywhere. The directory-entry fixture is REBUILT on every run (7z stamps
// the current time into it), so it goes to a scratch dir outside the repo.
const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TESTS_DIR, '..');
const require_ = createRequire(import.meta.url);

const WASM_DIR = path.join(REPO, 'wasm');
const WORKER_JS = path.join(REPO, 'worker.js');
const FIXTURE_MAKER = path.join(TESTS_DIR, 'make-dir-archive-fixture.mjs');
const SCRATCH = path.join(os.tmpdir(), '7zip-web-tests', 'worker-adversarial');
const JOB_TIMEOUT_MS = 180000;

if (!fs.existsSync(path.join(WASM_DIR, '7zz.js')) || !fs.existsSync(path.join(WASM_DIR, '7zz.wasm'))) {
  console.log('SKIPPED (wasm not built)');
  process.exit(0);
}

// ---------------------------------------------------------------- harness ---

const wasmFileBytes = fs.readFileSync(path.join(WASM_DIR, '7zz.wasm'));
const wasmArrayBuffer = wasmFileBytes.buffer.slice(
  wasmFileBytes.byteOffset,
  wasmFileBytes.byteOffset + wasmFileBytes.byteLength
);

const messages = []; // every worker -> main message: { msg, transfer }
function capturePostMessage(msg, transfer) {
  messages.push({ msg, transfer });
}

let engineModule = null; // captured via transparent create7zip wrapper

const selfObj = {
  location: new URL('file://' + WORKER_JS),
  postMessage: capturePostMessage,
  onmessage: null,
};

const sandbox = {
  self: selfObj,
  importScripts(p) {
    const mapped = String(p).replace('./wasm/', WASM_DIR + '/');
    const factory = require_(mapped);
    sandbox.create7zip = function (...args) {
      const pr = factory(...args);
      Promise.resolve(pr).then(
        (mod) => {
          engineModule = mod;
        },
        () => {}
      );
      return pr;
    };
  },
  fetch: async (url) => {
    const u = String((url && url.href) || url);
    if (u.includes('7zz.wasm') || u.includes('/wasm/')) {
      return { ok: true, status: 200, arrayBuffer: async () => wasmArrayBuffer };
    }
    return {
      ok: false,
      status: 404,
      arrayBuffer: async () => {
        throw new Error('not found: ' + u);
      },
    };
  },
  postMessage: capturePostMessage,
  console,
  URL,
  TextEncoder,
  TextDecoder,
  require: require_,
  setTimeout,
  clearTimeout,
  Promise,
  ArrayBuffer,
  Uint8Array,
};

const context = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(WORKER_JS, 'utf8'), context, { filename: WORKER_JS });

// ------------------------------------------------------------ test plumbing ---

const results = [];
function assert(cond, what) {
  if (!cond) throw new Error('assertion failed: ' + what);
}

async function runScenario(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.log(`FAIL  ${name}`);
    console.log('      ' + String(e && e.message ? e.message : e).split('\n').join('\n      '));
  }
}

let idCounter = 0;
function nextId() {
  return ++idCounter;
}

function sendAndWait(msg, terminalTypes, timeoutMs = JOB_TIMEOUT_MS) {
  const startIdx = messages.length;
  context.self.onmessage({ data: msg });
  return waitTerminal(msg.id, terminalTypes, startIdx, timeoutMs);
}

function waitTerminal(id, terminalTypes, startIdx, timeoutMs = JOB_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      for (let i = startIdx; i < messages.length; i++) {
        const m = messages[i].msg;
        if (m && m.id === id && terminalTypes.includes(m.type)) {
          clearInterval(timer);
          resolve({
            index: i,
            response: m,
            transfer: messages[i].transfer,
            related: messages.slice(startIdx, i + 1).filter((x) => x.msg && x.msg.id === id),
          });
        }
      }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        const seen = messages
          .slice(startIdx)
          .map((x) => (x.msg ? `${x.msg.id}:${x.msg.type}` : '?'))
          .join(', ');
        reject(new Error(`timeout waiting for [${terminalTypes}] on id ${id}; saw: ${seen}`));
      }
    }, 5);
  });
}

function bufOf(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}
function asBuffer(ab) {
  return Buffer.from(new Uint8Array(ab));
}
function errIfError(res, label) {
  if (res.response.type === 'error') {
    throw new Error(`${label}: worker reported error: ${res.response.message}`);
  }
}

// FS hygiene probes -----------------------------------------------------------

function assertJobDirCleaned(id) {
  assert(engineModule, 'engine Module captured');
  const p = engineModule.FS.analyzePath('/job' + id);
  assert(!p.exists, `MEMFS job dir /job${id} removed after job ${id} finished`);
}

// readdir('/') probe: no leftover /job* dirs from ANY job so far.
function assertRootHasNoJobDirs(when) {
  assert(engineModule, 'engine Module captured');
  const root = engineModule.FS.readdir('/');
  const stale = root.filter((n) => /^job\d+$/.test(n));
  assert(
    stale.length === 0,
    `${when}: MEMFS root has no leftover job dirs (found: ${JSON.stringify(stale)}; root=${JSON.stringify(root)})`
  );
}

// ---------------------------------------------------------------- payloads ---

const enc = new TextEncoder();

// (c) deterministic 1 MiB pseudorandom buffer (xorshift32 — incompressible).
function pseudoRandomBytes(n, seed) {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 0x9e3779b9;
  for (let i = 0; i < n; i += 4) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
    if (i + 1 < n) out[i + 1] = (x >>> 8) & 0xff;
    if (i + 2 < n) out[i + 2] = (x >>> 16) & 0xff;
    if (i + 3 < n) out[i + 3] = (x >>> 24) & 0xff;
  }
  return out;
}

const ONE_MIB = 1024 * 1024;

// ---------------------------------------------------------------- scenarios ---

assert(typeof context.self.onmessage === 'function', 'worker.js assigns self.onmessage');

await runScenario('init -> ready (engine boots)', async () => {
  const id = nextId();
  const res = await sendAndWait({ id, type: 'init' }, ['ready', 'error']);
  assert(res.response.type === 'ready', "expected {type:'ready'}");
  assert(engineModule && typeof engineModule.callMain === 'function', 'engine Module initialized');
  assertRootHasNoJobDirs('after init');
});

// (a) unicode filenames incl. CJK and emoji -----------------------------------

const unicodeFiles = [
  { path: '日本語のファイル.txt', data: enc.encode('日本語コンテンツ — CJK roundtrip ✓\n'.repeat(10)) },
  { path: 'emoji-🚀🎉-test.bin', data: enc.encode('emoji filename payload 🎈🐈‍⬛\n'.repeat(8)) },
  { path: 'accented-éàü-ñ-ø.txt', data: enc.encode('accented names ünicode ✓\n'.repeat(8)) },
  { path: 'кириллица/файл.txt', data: enc.encode('вложенная кириллица\n'.repeat(6)) },
  { path: 'dir/中文/混合-🎈.dat', data: pseudoRandomBytes(2048, 0xc0ffee) },
];

let unicodeArchive = null;

await runScenario('(a) unicode filenames (CJK + emoji) compress', async () => {
  const id = nextId();
  const res = await sendAndWait(
    {
      id,
      type: 'compress',
      files: unicodeFiles.map((f) => ({ path: f.path, data: bufOf(f.data) })),
      archiveName: 'unicode-日本語-🚀.7z',
      format: '7z',
      level: '5',
    },
    ['compress-result', 'error']
  );
  errIfError(res, 'unicode compress');
  assert(res.response.archive.name === 'unicode-日本語-🚀.7z', 'archive.name echoes request archiveName (unicode preserved)');
  assert(
    Array.isArray(res.transfer) && res.transfer.length === 1 && res.transfer[0] === res.response.archive.data,
    'compress-result ArrayBuffer sent in transfer list'
  );
  unicodeArchive = res.response.archive.data;
  assertJobDirCleaned(id);
  assertRootHasNoJobDirs('after unicode compress');
});

await runScenario('(a) unicode filenames list -> paths byte-exact', async () => {
  const id = nextId();
  const res = await sendAndWait(
    { id, type: 'list', archive: { name: 'unicode-日本語-🚀.7z', data: unicodeArchive } },
    ['list-result', 'error']
  );
  errIfError(res, 'unicode list');
  const files = res.response.entries.filter((e) => !e.isFolder);
  const byPath = new Map(files.map((e) => [e.path, e]));
  assert(files.length === unicodeFiles.length, `listed ${unicodeFiles.length} files (got ${files.length}: ${JSON.stringify(files.map((e) => e.path))})`);
  for (const f of unicodeFiles) {
    assert(byPath.has(f.path), `entry path round-trips exactly: ${JSON.stringify(f.path)}`);
    assert(byPath.get(f.path).size === f.data.byteLength, `size matches for ${f.path}`);
    assert(byPath.get(f.path).encrypted === false, `${f.path}: not encrypted`);
  }
  assertJobDirCleaned(id);
  assertRootHasNoJobDirs('after unicode list');
});

await runScenario('(a) unicode filenames extract -> byte-identical', async () => {
  const id = nextId();
  const res = await sendAndWait(
    { id, type: 'extract', archive: { name: 'unicode-日本語-🚀.7z', data: unicodeArchive } },
    ['extract-result', 'error']
  );
  errIfError(res, 'unicode extract');
  const files = res.response.files;
  assert(files.length === unicodeFiles.length, `extracted ${unicodeFiles.length} files (got ${files.length})`);
  const byPath = new Map(files.map((f) => [f.path, asBuffer(f.data)]));
  for (const f of unicodeFiles) {
    assert(byPath.has(f.path), `extracted path exact: ${JSON.stringify(f.path)}`);
    assert(byPath.get(f.path).equals(Buffer.from(f.data)), `byte-identical: ${f.path}`);
  }
  assert(
    Array.isArray(res.transfer) && res.transfer.length === files.length,
    'every extracted ArrayBuffer is in the transfer list'
  );
  assertJobDirCleaned(id);
  assertRootHasNoJobDirs('after unicode extract');
});

// (b) 0-byte file roundtrip ----------------------------------------------------

await runScenario('(b) 0-byte file compress + list + extract roundtrip', async () => {
  const id1 = nextId();
  const cRes = await sendAndWait(
    {
      id: id1,
      type: 'compress',
      files: [
        { path: 'empty.txt', data: new ArrayBuffer(0) },
        { path: 'sub/also-empty.bin', data: new Uint8Array(0).buffer },
        { path: 'not-empty.txt', data: bufOf(enc.encode('x')) },
      ],
      archiveName: 'zeros.7z',
      format: '7z',
      level: '5',
    },
    ['compress-result', 'error']
  );
  errIfError(cRes, '0-byte compress');
  const zerosArchive = cRes.response.archive.data;
  assertJobDirCleaned(id1);

  const id2 = nextId();
  const lRes = await sendAndWait(
    { id: id2, type: 'list', archive: { name: 'zeros.7z', data: zerosArchive } },
    ['list-result', 'error']
  );
  errIfError(lRes, '0-byte list');
  const byPathL = new Map(lRes.response.entries.filter((e) => !e.isFolder).map((e) => [e.path, e]));
  assert(byPathL.get('empty.txt') && byPathL.get('empty.txt').size === 0, 'empty.txt listed with size 0');
  assert(byPathL.get('sub/also-empty.bin') && byPathL.get('sub/also-empty.bin').size === 0, 'sub/also-empty.bin listed with size 0');
  assert(byPathL.get('not-empty.txt') && byPathL.get('not-empty.txt').size === 1, 'not-empty.txt listed with size 1');
  assertJobDirCleaned(id2);

  const id3 = nextId();
  const eRes = await sendAndWait(
    { id: id3, type: 'extract', archive: { name: 'zeros.7z', data: zerosArchive } },
    ['extract-result', 'error']
  );
  errIfError(eRes, '0-byte extract');
  const byPathE = new Map(eRes.response.files.map((f) => [f.path, asBuffer(f.data)]));
  assert(byPathE.has('empty.txt') && byPathE.get('empty.txt').byteLength === 0, 'empty.txt extracted as 0 bytes');
  assert(byPathE.has('sub/also-empty.bin') && byPathE.get('sub/also-empty.bin').byteLength === 0, 'sub/also-empty.bin extracted as 0 bytes');
  assert(byPathE.get('not-empty.txt').equals(Buffer.from('x')), 'not-empty.txt extracted byte-identical');
  assertJobDirCleaned(id3);
  assertRootHasNoJobDirs('after 0-byte roundtrip');
});

// (c) ~1 MiB incompressible roundtrip ------------------------------------------

const randomContent = pseudoRandomBytes(ONE_MIB, 0xdeadbeef);

await runScenario('(c) 1 MiB pseudorandom (incompressible) roundtrip, byte-compared', async () => {
  const id1 = nextId();
  const cRes = await sendAndWait(
    {
      id: id1,
      type: 'compress',
      files: [{ path: 'random-1mib.bin', data: bufOf(randomContent) }],
      archiveName: 'big-random.7z',
      format: '7z',
      level: '5',
    },
    ['compress-result', 'error']
  );
  errIfError(cRes, '1MiB compress');
  const arcBytes = asBuffer(cRes.response.archive.data);
  assert(arcBytes.byteLength > ONE_MIB * 0.9, `archive is incompressible-ish (got ${arcBytes.byteLength} bytes for ${ONE_MIB} random input bytes)`);
  const bigArchive = cRes.response.archive.data;
  assertJobDirCleaned(id1);

  const id2 = nextId();
  const lRes = await sendAndWait(
    { id: id2, type: 'list', archive: { name: 'big-random.7z', data: bigArchive } },
    ['list-result', 'error']
  );
  errIfError(lRes, '1MiB list');
  const entry = lRes.response.entries.filter((e) => !e.isFolder)[0];
  assert(entry && entry.path === 'random-1mib.bin' && entry.size === ONE_MIB, `listed size === ${ONE_MIB} (got ${entry && entry.size})`);
  assertJobDirCleaned(id2);

  const id3 = nextId();
  const eRes = await sendAndWait(
    { id: id3, type: 'extract', archive: { name: 'big-random.7z', data: bigArchive } },
    ['extract-result', 'error']
  );
  errIfError(eRes, '1MiB extract');
  assert(eRes.response.files.length === 1, 'exactly one extracted file');
  const extracted = asBuffer(eRes.response.files[0].data);
  assert(extracted.byteLength === ONE_MIB, `extracted length ${ONE_MIB} (got ${extracted.byteLength})`);
  assert(extracted.equals(Buffer.from(randomContent)), 'extracted bytes identical to the 1 MiB pseudorandom source');
  assert(
    Array.isArray(eRes.transfer) && eRes.transfer.length === 1,
    '1 MiB buffer sent in transfer list'
  );
  assertJobDirCleaned(id3);
  assertRootHasNoJobDirs('after 1MiB roundtrip');
});

// (d) zip compress -> list -> extract -------------------------------------------

const zipFiles = [
  { path: 'zip-root.txt', data: enc.encode('zip root entry ✓\n'.repeat(20)) },
  { path: 'zipdir/nested-🚀.txt', data: enc.encode('nested zip entry 日本語\n'.repeat(20)) },
];

await runScenario('(d) zip format compress then list + extract', async () => {
  const id1 = nextId();
  const cRes = await sendAndWait(
    {
      id: id1,
      type: 'compress',
      files: zipFiles.map((f) => ({ path: f.path, data: bufOf(f.data) })),
      archiveName: 'adversarial.zip',
      format: 'zip',
      level: '5',
      encryptHeaders: true, // must be ignored for zip
    },
    ['compress-result', 'error']
  );
  errIfError(cRes, 'zip compress');
  const sig = asBuffer(cRes.response.archive.data).subarray(0, 2);
  assert(sig[0] === 0x50 && sig[1] === 0x4b, 'zip starts with PK signature');
  const zipArchive = cRes.response.archive.data;
  assertJobDirCleaned(id1);

  const id2 = nextId();
  const lRes = await sendAndWait(
    { id: id2, type: 'list', archive: { name: 'adversarial.zip', data: zipArchive } },
    ['list-result', 'error']
  );
  errIfError(lRes, 'zip list');
  const files = lRes.response.entries.filter((e) => !e.isFolder);
  const byPath = new Map(files.map((e) => [e.path, e]));
  assert(files.length === zipFiles.length, `zip lists ${zipFiles.length} files (got ${files.length}: ${JSON.stringify(files.map((e) => e.path))})`);
  for (const f of zipFiles) {
    assert(byPath.has(f.path), `zip entry path exact: ${f.path}`);
    assert(byPath.get(f.path).size === f.data.byteLength, `zip entry size: ${f.path}`);
    assert(byPath.get(f.path).encrypted === false, `zip entry not encrypted: ${f.path}`);
    assert(typeof byPath.get(f.path).method === 'string' && byPath.get(f.path).method.length > 0, `zip entry method present: ${f.path}`);
  }
  assertJobDirCleaned(id2);

  const id3 = nextId();
  const eRes = await sendAndWait(
    { id: id3, type: 'extract', archive: { name: 'adversarial.zip', data: zipArchive } },
    ['extract-result', 'error']
  );
  errIfError(eRes, 'zip extract');
  const ext = new Map(eRes.response.files.map((f) => [f.path, asBuffer(f.data)]));
  for (const f of zipFiles) {
    assert(ext.has(f.path), `zip extracted path exact: ${f.path}`);
    assert(ext.get(f.path).equals(Buffer.from(f.data)), `zip byte-identical: ${f.path}`);
  }
  assertJobDirCleaned(id3);
  assertRootHasNoJobDirs('after zip roundtrip');
});

// (e) two sequential jobs back-to-back -> /job<id> cleanup proven via readdir('/') --

await runScenario('(e) two back-to-back jobs: queued sequentially, no stale /job dirs', async () => {
  const content1 = enc.encode('sequential job archive one ✓\n'.repeat(30));
  const content2 = pseudoRandomBytes(4096, 0x12345);

  const idC1 = nextId();
  const c1 = await sendAndWait(
    {
      id: idC1,
      type: 'compress',
      files: [{ path: 'one.txt', data: bufOf(content1) }],
      archiveName: 'seq-one.7z',
      format: '7z',
      level: '3',
    },
    ['compress-result', 'error']
  );
  errIfError(c1, 'seq compress one');
  const archiveOne = c1.response.archive.data;
  assertJobDirCleaned(idC1);

  const idC2 = nextId();
  const c2 = await sendAndWait(
    {
      id: idC2,
      type: 'compress',
      files: [{ path: 'two.bin', data: bufOf(content2) }],
      archiveName: 'seq-two.7z',
      format: '7z',
      level: '3',
    },
    ['compress-result', 'error']
  );
  errIfError(c2, 'seq compress two');
  const archiveTwo = c2.response.archive.data;
  assertJobDirCleaned(idC2);

  // Fire BOTH list jobs without waiting — the worker must serialize them and
  // neither may hit a stale-path error from the other's leftovers.
  const idL1 = nextId();
  const idL2 = nextId();
  const startIdx = messages.length;
  context.self.onmessage({
    data: { id: idL1, type: 'list', archive: { name: 'seq-one.7z', data: archiveOne } },
  });
  context.self.onmessage({
    data: { id: idL2, type: 'list', archive: { name: 'seq-two.7z', data: archiveTwo } },
  });
  const l1 = await waitTerminal(idL1, ['list-result', 'error'], startIdx);
  const l2 = await waitTerminal(idL2, ['list-result', 'error'], startIdx);
  errIfError(l1, 'seq list one');
  errIfError(l2, 'seq list two');
  assert(l1.index < l2.index, 'list one completed before list two (sequential engine)');
  const f1 = l1.response.entries.filter((e) => !e.isFolder);
  const f2 = l2.response.entries.filter((e) => !e.isFolder);
  assert(f1.length === 1 && f1[0].path === 'one.txt' && f1[0].size === content1.byteLength, 'archive one lists correctly');
  assert(f2.length === 1 && f2[0].path === 'two.bin' && f2[0].size === content2.byteLength, 'archive two lists correctly');
  assertJobDirCleaned(idL1);
  assertJobDirCleaned(idL2);
  assertRootHasNoJobDirs('after two sequential jobs (readdir("/") probe)');
});

// (f) archive containing directory entries ---------------------------------------
// NOTE: archives produced by worker.js compress (plain file input paths) contain
// NO explicit directory entries — 7z only stores them when a directory is an
// input path. So the fixture is built by driving the real 7zz standalone with
// 'docs' as the input directory (make-dir-archive-fixture.mjs, separate
// process), which yields explicit folder entries incl. an empty dir and a
// unicode dir. This is exactly the real-world case the task asks to verify.

await runScenario('(f) archive WITH directory entries: extract yields files only, byte-identical', async () => {
  const fixtureDir = path.join(SCRATCH, 'fixture-dir-entries');
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.mkdirSync(fixtureDir, { recursive: true });
  const arcPath = path.join(fixtureDir, 'with-dirs.7z');
  const metaPath = path.join(fixtureDir, 'with-dirs.meta.json');
  const { execFileSync } = await import('node:child_process');
  execFileSync(
    process.execPath,
    [FIXTURE_MAKER, arcPath, metaPath],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }
  );
  const dirsArchive = bufOf(new Uint8Array(fs.readFileSync(arcPath)));
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const expectedFiles = new Map(
    Object.entries(meta.files).map(([p, b64]) => [p, Buffer.from(b64, 'base64')])
  );
  assert(expectedFiles.size === 3, 'fixture has 3 files');
  assert(meta.folders.length >= 4, `fixture has explicit folder entries (got ${JSON.stringify(meta.folders)})`);
  assert(meta.folders.includes('docs/empty-dir'), 'fixture includes an EMPTY directory entry');
  // stash for the (f2) diagnostic scenario
  globalThis.__dirsFixture = { dirsArchive, meta };

  const id2 = nextId();
  const lRes = await sendAndWait(
    { id: id2, type: 'list', archive: { name: 'with-dirs.7z', data: dirsArchive } },
    ['list-result', 'error']
  );
  errIfError(lRes, 'dirs list');
  const listedPaths = new Set(lRes.response.entries.map((e) => e.path.replace(/\/$/, '')));
  for (const f of meta.folders) {
    assert(listedPaths.has(f.replace(/\/$/, '')), `directory entry '${f}' present in list-result entries`);
  }
  const filesL = lRes.response.entries
    .filter((e) => !listedDirs(e, meta))
    .map((e) => e.path)
    .sort();
  assert(
    JSON.stringify(filesL) === JSON.stringify([...expectedFiles.keys()].sort()),
    `file entries exact (got ${JSON.stringify(filesL)})`
  );
  for (const e of lRes.response.entries) {
    const p = e.path.replace(/\/$/, '');
    if (meta.folders.map((f) => f.replace(/\/$/, '')).includes(p)) {
      assert(e.size === 0, `directory entry '${p}' has size 0`);
    } else {
      assert(e.size === expectedFiles.get(p).byteLength, `listed size matches for ${p}`);
    }
  }
  assertJobDirCleaned(id2);

  const id3 = nextId();
  const eRes = await sendAndWait(
    { id: id3, type: 'extract', archive: { name: 'with-dirs.7z', data: dirsArchive } },
    ['extract-result', 'error']
  );
  errIfError(eRes, 'dirs extract');
  const ext = new Map(eRes.response.files.map((f) => [f.path, asBuffer(f.data)]));
  assert(
    ext.size === expectedFiles.size,
    `extract returns exactly the ${expectedFiles.size} regular files, no dir entries (got ${ext.size}: ${JSON.stringify([...ext.keys()])})`
  );
  for (const [p, want] of expectedFiles) {
    assert(ext.has(p), `extracted path exact: ${p}`);
    assert(ext.get(p).equals(want), `byte-identical: ${p}`);
  }
  assert(
    Array.isArray(eRes.transfer) && eRes.transfer.length === eRes.response.files.length,
    'all extracted buffers transferred'
  );
  assertJobDirCleaned(id3);

  const id4 = nextId();
  const tRes = await sendAndWait(
    { id: id4, type: 'test', archive: { name: 'with-dirs.7z', data: dirsArchive } },
    ['test-result', 'error']
  );
  errIfError(tRes, 'dirs test');
  assert(tRes.response.ok === true, 'test ok:true on directory-entry archive');
  assertJobDirCleaned(id4);
  assertRootHasNoJobDirs('after directory-entry roundtrip');
});

function listedDirs(entry, meta) {
  return meta.folders.map((f) => f.replace(/\/$/, '')).includes(entry.path.replace(/\/$/, ''));
}

// DIAGNOSTIC (xfail, beyond the required (a)-(f) list): contract semantics of
// isFolder. Contract: "Folder (= '+' for directories)" in 'l -slt' output, and
// entries carry isFolder. Empirically (probe3.mjs) the real build emits NO
// Folder field for 7z archives (only zip/tar do), so worker.js's literal
// `Folder === '+'` mapping leaves isFolder=false for every directory entry of
// a real 7z archive -> the UI shows dirs as 0-byte files. Reported as a
// finding; does not affect the suite exit code (required scenario (f) —
// EXTRACT of a directory-entry archive — is asserted above and passes).
{
  const name = '(f2-diagnostic, xfail) 7z directory entries flagged isFolder=true';
  try {
    const { dirsArchive, meta } = globalThis.__dirsFixture;
    const id = nextId();
    const res = await sendAndWait(
      { id, type: 'list', archive: { name: 'with-dirs.7z', data: dirsArchive } },
      ['list-result', 'error']
    );
    errIfError(res, 'dirs list (diagnostic)');
    const byPath = new Map(res.response.entries.map((e) => [e.path.replace(/\/$/, ''), e]));
    const wrong = meta.folders
      .map((f) => f.replace(/\/$/, ''))
      .filter((f) => !(byPath.get(f) && byPath.get(f).isFolder === true));
    assertJobDirCleaned(id);
    assert(
      wrong.length === 0,
      `directory entries reported with isFolder=false: ${JSON.stringify(wrong)}`
    );
    results.push({ name, ok: true });
    console.log(`PASS  ${name}  (parser fixed — dirs now flagged)`);
  } catch (e) {
    results.push({ name, ok: true, xfail: true });
    console.log(`XFAIL ${name}`);
    console.log(`      KNOWN DEFECT CONFIRMED: ${String(e && e.message ? e.message : e)}`);
  }
}

// ---------------------------------------------------------------- summary ---

const failed = results.filter((r) => !r.ok);
const xfails = results.filter((r) => r.xfail);
console.log('');
console.log(`scenarios: ${results.length}, passed: ${results.length - failed.length}, failed: ${failed.length}, xfail-diagnostics: ${xfails.length}`);
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.name}`);
}
console.log(failed.length ? 'RESULT: FAIL' : 'RESULT: PASS (all adversarial scenarios green)');

// The emscripten glue sets process.exitCode = <rc> of every callMain; decide
// the exit status explicitly here instead.
process.exitCode = failed.length ? 1 : 0;
