// Direct check of the isFolder fix against REAL 7z and zip archives with
// directory entries, driving the actual worker.js through a vm harness.
//
// Run: node tests/isfolder-check.mjs   (from the repo root; any cwd works)
// Prints "SKIPPED (wasm not built)" and exits 0 when <repo>/wasm is missing.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Repo root derived from this file's own location (tests/..).
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WASM_DIR = path.join(REPO, 'wasm');

if (!fs.existsSync(path.join(WASM_DIR, '7zz.js')) || !fs.existsSync(path.join(WASM_DIR, '7zz.wasm'))) {
  console.log('SKIPPED (wasm not built)');
  process.exit(0);
}

const wasmBytes = fs.readFileSync(path.join(WASM_DIR, '7zz.wasm'));

// build fixture archives with dir entries using the module directly
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const create7zip = require(path.join(WASM_DIR, '7zz.js'));
const M = await create7zip({ locateFile: p => path.join(WASM_DIR, p), wasmBinary: wasmBytes, noInitialRun: true, stdin: () => null, print: () => {}, printErr: () => {} });
M.FS.mkdirTree('/fx/in/sub');
M.FS.writeFile('/fx/in/a.txt', 'A\n');
M.FS.writeFile('/fx/in/sub/b.txt', 'B\n');
const arc7z = M.callMain(['a', '/fx/d.7z', '/fx/in', '-bd', '-y']);
const arcZip = M.callMain(['a', '-tzip', '/fx/d.zip', '/fx/in', '-bd', '-y']);
if (arc7z || arcZip) throw new Error('fixture creation failed');
const d7z = M.FS.readFile('/fx/d.7z'), dzip = M.FS.readFile('/fx/d.zip');

// vm harness around worker.js
const replies = [];
const selfStub = { location: new URL('file://' + path.join(REPO, 'worker.js')), postMessage: (m) => replies.push(m) };
const context = vm.createContext({
  self: selfStub, postMessage: (m) => replies.push(m), console,
  importScripts: (p) => { const f = require(path.join(WASM_DIR, path.basename(p))); context.create7zip = f; },
  fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength) }),
  URL, TextEncoder, TextDecoder, Promise, ArrayBuffer, Uint8Array, setTimeout, clearTimeout,
});
vm.runInContext(fs.readFileSync(path.join(REPO, 'worker.js'), 'utf8'), context, { filename: 'worker.js' });
const send = (m) => context.self.onmessage({ data: m });

const waitFor = (id, type) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout waiting ' + type)), 60000);
  const iv = setInterval(() => {
    const m = replies.find(r => r.id === id && r.type === type);
    if (m) { clearTimeout(t); clearInterval(iv); res(m); }
    const e = replies.find(r => r.id === id && r.type === 'error');
    if (e) { clearTimeout(t); clearInterval(iv); rej(new Error(e.message)); }
  }, 20);
});

send({ id: 1, type: 'init' });
await waitFor(1, 'ready');

let pass = 0, fail = 0;
const cases = [[2, 'd.7z', d7z], [3, 'd.zip', dzip]];
for (const [id, name, bytes] of cases) {
  try {
    send({ id, type: 'list', archive: { name, data: bytes.slice().buffer } });
    const res = await waitFor(id, 'list-result');
    const folders = res.entries.filter(e => e.isFolder).map(e => e.path).sort();
    const files = res.entries.filter(e => !e.isFolder).map(e => e.path).sort();
    const noFrac = res.entries.every(e => !/\.\d{7}$/.test(e.modified));
    console.log('      ' + name, 'folders:', JSON.stringify(folders), 'files:', JSON.stringify(files), 'modified-trimmed:', noFrac);
    const wantFolders = JSON.stringify(['in', 'in/sub']);
    if (JSON.stringify(folders) !== wantFolders) throw new Error(name + ' isFolder WRONG: ' + JSON.stringify(folders));
    if (!noFrac) throw new Error(name + ' Modified still has fractional seconds');
    pass++;
    console.log('PASS  ' + name + ': directory entries flagged isFolder, Modified has no fractional seconds');
  } catch (e) {
    fail++;
    console.log('FAIL  ' + name + ': ' + (e && e.message ? e.message : e));
  }
}

console.log('');
console.log('isfolder-check: ' + pass + ' passed, ' + fail + ' failed');
if (fail) {
  console.log('ISFOLDER + MODIFIED CHECKS FAILED');
  process.exitCode = 1;
} else {
  console.log('ISFOLDER + MODIFIED CHECKS PASSED (real 7z and zip archives)');
  // The emscripten glue sets process.exitCode from every callMain; decide it here.
  process.exitCode = 0;
}
