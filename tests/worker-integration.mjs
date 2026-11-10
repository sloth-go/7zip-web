/*
 * worker-integration.mjs — Node integration test for <repo>/worker.js against
 * the REAL 7zz wasm build shipped in <repo>/wasm.
 *
 * Builds a vm context that stubs the Worker environment exactly per the
 * contract (self.onmessage / self.postMessage / importScripts / self.location /
 * fetch / console), loads worker.js into it and drives full jobs:
 *   init -> ready; compress (7z, level 5, nested path); list; extract
 *   roundtrip; test; password-protected compress with -mhe=on (correct and
 *   WRONG password); plus zip roundtrip, corrupted-archive recovery,
 *   back-to-back queueing and per-job MEMFS hygiene.
 *
 * Run: node tests/worker-integration.mjs   (from the repo root; any cwd works)
 * Prints "SKIPPED (wasm not built)" and exits 0 when <repo>/wasm is missing.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Repo root derived from this file's own location (tests/..), so the suite runs
// from any working directory and on any checkout path.
const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TESTS_DIR, '..');
const require_ = createRequire(import.meta.url);

const WASM_DIR = path.join(REPO, 'wasm');
const WORKER_JS = path.join(REPO, 'worker.js');
const JOB_TIMEOUT_MS = 120000;

if (!fs.existsSync(path.join(WASM_DIR, '7zz.js')) || !fs.existsSync(path.join(WASM_DIR, '7zz.wasm'))) {
  console.log('SKIPPED (wasm not built)');
  process.exit(0);
}

// ---------------------------------------------------------------- harness ---

const wasmFileBytes = fs.readFileSync(path.join(WASM_DIR, '7zz.wasm'));
// Exact-sized ArrayBuffer (Node Buffers can be pooled views!).
const wasmArrayBuffer = wasmFileBytes.buffer.slice(
  wasmFileBytes.byteOffset,
  wasmFileBytes.byteOffset + wasmFileBytes.byteLength
);

const messages = []; // every worker -> main message: { msg, transfer }
function capturePostMessage(msg, transfer) {
  messages.push({ msg, transfer });
}

// Captured via a transparent wrapper around the real factory so tests can
// assert MEMFS job-dir hygiene; behaves identically for worker.js.
let engineModule = null;

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

// Send a message to the worker and wait for a terminal reply for its id.
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

function assertJobDirCleaned(id) {
  if (!engineModule) return; // module capture unavailable — skip hygiene check
  const p = engineModule.FS.analyzePath('/job' + id);
  assert(!p.exists, `MEMFS job dir /job${id} removed after job finished`);
}

const enc = new TextEncoder();
const contentA = enc.encode('Hello from the worker integration test!\n'.repeat(40));
const contentB = enc.encode('Nested payload with unicode: ünicode ✓ 7-Zip\n'.repeat(60));

function bufOf(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}
function asBuffer(ab) {
  return Buffer.from(new Uint8Array(ab));
}
function expectError(res, id) {
  assert(
    res.response.type === 'error',
    `id ${id}: expected {type:'error'}, got '${res.response.type}'`
  );
  assert(
    typeof res.response.message === 'string' && res.response.message.length > 0,
    `id ${id}: error message must be a non-empty string`
  );
}

// ------------------------------------------------------------- scenarios ---

assert(typeof context.self.onmessage === 'function', 'worker.js assigns self.onmessage');

await runScenario('init -> ready', async () => {
  const id = nextId();
  const res = await sendAndWait({ id, type: 'init' }, ['ready', 'error']);
  assert(res.response.type === 'ready', "expected {type:'ready'}");
  assert(res.response.id === id, 'ready carries the request id');
  assert(engineModule && typeof engineModule.callMain === 'function', 'engine Module initialized');
  assert(typeof engineModule.FS.mkdirTree === 'function', 'Module.FS present');
});

let plainArchiveBytes = null;
let plainArchiveName = 'test-archive.7z';

await runScenario('compress two files (nested path) as 7z level 5', async () => {
  const id = nextId();
  const res = await sendAndWait(
    {
      id,
      type: 'compress',
      files: [
        { path: 'hello.txt', data: bufOf(contentA) },
        { path: 'sub/nested.txt', data: bufOf(contentB) },
      ],
      archiveName: plainArchiveName,
      format: '7z',
      level: '5',
    },
    ['compress-result', 'error']
  );
  if (res.response.type === 'error') throw new Error('worker error: ' + res.response.message);
  const arc = res.response.archive;
  assert(arc && arc.name === plainArchiveName, `archive.name === '${plainArchiveName}'`);
  assert(arc.data && typeof arc.data.byteLength === 'number', 'archive.data is a binary payload');
  const bytes = asBuffer(arc.data);
  assert(bytes.byteLength > 32, `archive has non-trivial size (got ${bytes.byteLength})`);
  const sig = bytes.subarray(0, 6);
  assert(
    sig[0] === 0x37 && sig[1] === 0x7a && sig[2] === 0xbc && sig[3] === 0xaf && sig[4] === 0x27 && sig[5] === 0x1c,
    'archive starts with the 7z signature'
  );
  assert(
    Array.isArray(res.transfer) && res.transfer.length === 1 && res.transfer[0] === arc.data,
    'archive ArrayBuffer sent in the transfer list'
  );
  assert(
    res.related.some((x) => x.msg.type === 'progress' && typeof x.msg.line === 'string'),
    'progress lines streamed for the job'
  );
  plainArchiveBytes = arc.data;
  assertJobDirCleaned(id);
});

await runScenario('list the archive -> entries match names/sizes', async () => {
  const id = nextId();
  const res = await sendAndWait(
    { id, type: 'list', archive: { name: plainArchiveName, data: plainArchiveBytes } },
    ['list-result', 'error']
  );
  if (res.response.type === 'error') throw new Error('worker error: ' + res.response.message);
  const entries = res.response.entries;
  assert(Array.isArray(entries), 'entries is an array');
  assert(typeof res.response.raw === 'string' && res.response.raw.includes('----------'), 'raw output included');
  const files = entries.filter((e) => !e.isFolder);
  const byPath = new Map(files.map((e) => [e.path, e]));
  assert(files.length === 2, `exactly 2 file entries (got ${files.length}: ${files.map((e) => e.path)})`);
  assert(byPath.has('hello.txt'), "entry 'hello.txt' listed");
  assert(byPath.has('sub/nested.txt'), "entry 'sub/nested.txt' listed (nested path preserved)");
  assert(byPath.get('hello.txt').size === contentA.byteLength, 'hello.txt size matches');
  assert(byPath.get('sub/nested.txt').size === contentB.byteLength, 'sub/nested.txt size matches');
  for (const e of files) {
    assert(typeof e.size === 'number', `${e.path}: size is a number`);
    assert(e.encrypted === false, `${e.path}: encrypted === false`);
    assert(typeof e.modified === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(e.modified), `${e.path}: modified raw string`);
    assert(typeof e.method === 'string' && e.method.length > 0, `${e.path}: method present`);
    assert(typeof e.isFolder === 'boolean', `${e.path}: isFolder boolean`);
  }
  for (const e of entries.filter((x) => x.isFolder)) {
    assert(e.path === 'sub', `unexpected folder entry '${e.path}'`);
  }
  assertJobDirCleaned(id);
});

await runScenario('extract -> byte-identical roundtrip incl. nested path', async () => {
  const id = nextId();
  const res = await sendAndWait(
    { id, type: 'extract', archive: { name: plainArchiveName, data: plainArchiveBytes } },
    ['extract-result', 'error']
  );
  if (res.response.type === 'error') throw new Error('worker error: ' + res.response.message);
  const files = res.response.files;
  assert(Array.isArray(files) && files.length === 2, `2 files extracted (got ${files && files.length})`);
  const byPath = new Map(files.map((f) => [f.path, asBuffer(f.data)]));
  assert(byPath.has('hello.txt') && byPath.has('sub/nested.txt'), 'relative paths preserved');
  assert(byPath.get('hello.txt').equals(Buffer.from(contentA)), 'hello.txt byte-identical');
  assert(byPath.get('sub/nested.txt').equals(Buffer.from(contentB)), 'sub/nested.txt byte-identical');
  assert(
    Array.isArray(res.transfer) && res.transfer.length === 2,
    'both ArrayBuffers sent in the transfer list'
  );
  assertJobDirCleaned(id);
});

await runScenario('test -> ok:true', async () => {
  const id = nextId();
  const res = await sendAndWait(
    { id, type: 'test', archive: { name: plainArchiveName, data: plainArchiveBytes } },
    ['test-result', 'error']
  );
  if (res.response.type === 'error') throw new Error('worker error: ' + res.response.message);
  assert(res.response.ok === true, 'ok === true');
  assert(typeof res.response.raw === 'string' && res.response.raw.length > 0, 'raw tail included');
  assertJobDirCleaned(id);
});

let secretBytes = null;

await runScenario('password compress (encryptHeaders) -> list/extract with correct password', async () => {
  const id = nextId();
  const res = await sendAndWait(
    {
      id,
      type: 'compress',
      files: [
        { path: 'hello.txt', data: bufOf(contentA) },
        { path: 'sub/nested.txt', data: bufOf(contentB) },
      ],
      archiveName: 'secret.7z',
      format: '7z',
      level: '5',
      password: 'hunter2',
      encryptHeaders: true,
    },
    ['compress-result', 'error']
  );
  if (res.response.type === 'error') throw new Error('worker error: ' + res.response.message);
  assert(res.response.archive.name === 'secret.7z', 'archive.name === secret.7z');
  const sig = asBuffer(res.response.archive.data).subarray(0, 2);
  assert(sig[0] === 0x37 && sig[1] === 0x7a, '7z signature');
  secretBytes = res.response.archive.data;
  assertJobDirCleaned(id);

  // list with correct password
  const id2 = nextId();
  const listRes = await sendAndWait(
    { id: id2, type: 'list', archive: { name: 'secret.7z', data: secretBytes }, password: 'hunter2' },
    ['list-result', 'error']
  );
  if (listRes.response.type === 'error') throw new Error('list with correct password errored: ' + listRes.response.message);
  const files = listRes.response.entries.filter((e) => !e.isFolder);
  assert(files.length === 2, 'header-encrypted archive lists 2 entries with correct password');
  const byPath = new Map(files.map((e) => [e.path, e]));
  assert(byPath.get('hello.txt').size === contentA.byteLength, 'hello.txt size (encrypted list)');
  assert(byPath.get('sub/nested.txt').size === contentB.byteLength, 'sub/nested.txt size (encrypted list)');
  assert(files.every((e) => e.encrypted === true), 'entries flagged encrypted');
  assertJobDirCleaned(id2);

  // extract with correct password
  const id3 = nextId();
  const extRes = await sendAndWait(
    { id: id3, type: 'extract', archive: { name: 'secret.7z', data: secretBytes }, password: 'hunter2' },
    ['extract-result', 'error']
  );
  if (extRes.response.type === 'error') throw new Error('extract with correct password errored: ' + extRes.response.message);
  const ext = new Map(extRes.response.files.map((f) => [f.path, asBuffer(f.data)]));
  assert(ext.get('hello.txt').equals(Buffer.from(contentA)), 'encrypted roundtrip hello.txt');
  assert(ext.get('sub/nested.txt').equals(Buffer.from(contentB)), 'encrypted roundtrip sub/nested.txt');
  assertJobDirCleaned(id3);
});

await runScenario('WRONG password -> list reports error', async () => {
  const id = nextId();
  const res = await sendAndWait(
    { id, type: 'list', archive: { name: 'secret.7z', data: secretBytes }, password: 'definitely-wrong' },
    ['error', 'list-result']
  );
  expectError(res, id);
  assertJobDirCleaned(id);
});

await runScenario('WRONG password -> extract reports error', async () => {
  const id = nextId();
  const res = await sendAndWait(
    { id, type: 'extract', archive: { name: 'secret.7z', data: secretBytes }, password: 'definitely-wrong' },
    ['error', 'extract-result']
  );
  expectError(res, id);
  assertJobDirCleaned(id);
});

await runScenario('WRONG password -> test reports ok:false (not error)', async () => {
  const id = nextId();
  const res = await sendAndWait(
    { id, type: 'test', archive: { name: 'secret.7z', data: secretBytes }, password: 'definitely-wrong' },
    ['test-result', 'error']
  );
  assert(res.response.type === 'test-result', 'test always answers test-result');
  assert(res.response.ok === false, 'ok === false for wrong password');
  assertJobDirCleaned(id);
});

await runScenario('zip format roundtrip (encryptHeaders ignored for zip)', async () => {
  const id = nextId();
  const res = await sendAndWait(
    {
      id,
      type: 'compress',
      files: [
        { path: 'hello.txt', data: bufOf(contentA) },
        { path: 'sub/nested.txt', data: bufOf(contentB) },
      ],
      archiveName: 'bundle.zip',
      format: 'zip',
      level: '5',
      encryptHeaders: true, // must be ignored for zip (no password anyway)
    },
    ['compress-result', 'error']
  );
  if (res.response.type === 'error') throw new Error('worker error: ' + res.response.message);
  const zipBytes = res.response.archive.data;
  const sig = asBuffer(zipBytes).subarray(0, 2);
  assert(sig[0] === 0x50 && sig[1] === 0x4b, 'zip starts with PK signature');

  const id2 = nextId();
  const listRes = await sendAndWait(
    { id: id2, type: 'list', archive: { name: 'bundle.zip', data: zipBytes } },
    ['list-result', 'error']
  );
  if (listRes.response.type === 'error') throw new Error('zip list errored: ' + listRes.response.message);
  const files = listRes.response.entries.filter((e) => !e.isFolder);
  const byPath = new Map(files.map((e) => [e.path, e]));
  assert(byPath.has('hello.txt') && byPath.has('sub/nested.txt'), 'zip entries listed');
  assert(byPath.get('hello.txt').size === contentA.byteLength, 'zip hello.txt size');
  assert(files.every((e) => e.encrypted === false), 'zip entries not encrypted');

  const id3 = nextId();
  const extRes = await sendAndWait(
    { id: id3, type: 'extract', archive: { name: 'bundle.zip', data: zipBytes } },
    ['extract-result', 'error']
  );
  if (extRes.response.type === 'error') throw new Error('zip extract errored: ' + extRes.response.message);
  const ext = new Map(extRes.response.files.map((f) => [f.path, asBuffer(f.data)]));
  assert(ext.get('hello.txt').equals(Buffer.from(contentA)), 'zip roundtrip hello.txt');
  assert(ext.get('sub/nested.txt').equals(Buffer.from(contentB)), 'zip roundtrip sub/nested.txt');
  assertJobDirCleaned(id3);
});

await runScenario('corrupt archive -> error, worker keeps functioning', async () => {
  const garbage = Buffer.alloc(64);
  for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37) & 0xff;
  const id = nextId();
  const res = await sendAndWait(
    { id, type: 'list', archive: { name: 'garbage.7z', data: garbage.buffer.slice(0) } },
    ['error', 'list-result']
  );
  expectError(res, id);
  assertJobDirCleaned(id);

  // engine still healthy afterwards
  const id2 = nextId();
  const ok = await sendAndWait(
    { id: id2, type: 'test', archive: { name: plainArchiveName, data: plainArchiveBytes } },
    ['test-result', 'error']
  );
  assert(ok.response.type === 'test-result' && ok.response.ok === true, 'worker still functional after error job');
  assertJobDirCleaned(id2);
});

await runScenario('back-to-back jobs are queued and processed sequentially', async () => {
  const idA = nextId();
  const idB = nextId();
  const startIdx = messages.length;
  // Fire two jobs WITHOUT waiting — the worker must queue and serialize them.
  context.self.onmessage({
    data: { id: idA, type: 'test', archive: { name: plainArchiveName, data: plainArchiveBytes } },
  });
  context.self.onmessage({
    data: { id: idB, type: 'list', archive: { name: plainArchiveName, data: plainArchiveBytes } },
  });
  const resA = await waitTerminal(idA, ['test-result', 'error'], startIdx);
  const resB = await waitTerminal(idB, ['list-result', 'error'], startIdx);
  assert(resA.response.type === 'test-result' && resA.response.ok === true, 'job A succeeded');
  assert(resB.response.type === 'list-result', 'job B succeeded');
  assert(resA.index < resB.index, 'job A completed before job B (sequential engine)');
  assertJobDirCleaned(idA);
  assertJobDirCleaned(idB);
});

await runScenario('unknown message type -> error reply', async () => {
  const id = nextId();
  const res = await sendAndWait({ id, type: 'frobnicate' }, ['error']);
  expectError(res, id);
});

// ---------------------------------------------------------------- summary ---

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`scenarios: ${results.length}, passed: ${results.length - failed.length}, failed: ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.name}`);
}
console.log(failed.length ? 'RESULT: FAIL' : 'RESULT: PASS (all scenarios green)');

// The emscripten glue sets process.exitCode = <rc> of every callMain; decide
// the exit status explicitly here instead.
process.exitCode = failed.length ? 1 : 0;
