/*
 * make-dir-archive-fixture.mjs — builds a REAL 7z archive that contains
 * explicit DIRECTORY entries (including an empty directory and a unicode
 * directory), by driving the actual 7zz wasm build standalone (separate
 * process from the worker test) and passing a directory as the input path.
 *
 * Usage: node tests/make-dir-archive-fixture.mjs <out.7z> <out-meta.json>
 * Writes the archive plus a JSON sidecar {files:{path:base64}, folders:[...]}.
 * Self-verifying: fails loudly if the archive has no 'Folder = +' entries.
 * Prints "SKIPPED (wasm not built)" and exits 0 when <repo>/wasm is missing.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root derived from this file's own location (tests/..).
const TESTS_DIR = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO = nodePath.resolve(TESTS_DIR, '..');
const require_ = createRequire(import.meta.url);
const WASM_DIR = nodePath.join(REPO, 'wasm');

const outArchive = process.argv[2];
const outMeta = process.argv[3];
if (!outArchive || !outMeta) {
  console.error('usage: node tests/make-dir-archive-fixture.mjs <out.7z> <out-meta.json>');
  process.exit(2);
}

if (!fs.existsSync(nodePath.join(WASM_DIR, '7zz.js')) || !fs.existsSync(nodePath.join(WASM_DIR, '7zz.wasm'))) {
  console.log('SKIPPED (wasm not built)');
  process.exit(0);
}

const create7zip = require_(nodePath.join(WASM_DIR, '7zz.js'));
const wasmFileBytes = fs.readFileSync(WASM_DIR + '/7zz.wasm');
const wasmBinary = new Uint8Array(
  wasmFileBytes.buffer.slice(wasmFileBytes.byteOffset, wasmFileBytes.byteOffset + wasmFileBytes.byteLength)
);

let out = [];
const Module = await create7zip({
  wasmBinary,
  noInitialRun: true,
  print: (l) => out.push(l),
  printErr: (l) => out.push('[stderr] ' + l),
  locateFile: (p) => WASM_DIR + '/' + p,
});
const FS = Module.FS;
const enc = new TextEncoder();

function run(args) {
  out = [];
  let rc = 0;
  try {
    rc = Module.callMain(args);
  } catch (e) {
    rc = 'THREW(' + typeof e + ':' + String(e).slice(0, 40) + ')';
  }
  return { rc, lines: out.slice() };
}

function pseudoRandomBytes(n, seed) {
  const o = new Uint8Array(n);
  let x = seed >>> 0 || 0x9e3779b9;
  for (let i = 0; i < n; i += 4) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    o[i] = x & 0xff;
    if (i + 1 < n) o[i + 1] = (x >>> 8) & 0xff;
    if (i + 2 < n) o[i + 2] = (x >>> 16) & 0xff;
    if (i + 3 < n) o[i + 3] = (x >>> 24) & 0xff;
  }
  return o;
}

const files = {
  'docs/readme.txt': enc.encode('readme inside a directory-entry archive\n'.repeat(10)),
  'docs/sub/notes.txt': pseudoRandomBytes(1234, 0x77),
  'docs/sub/deep/🚀-leaf/leaf.bin': enc.encode('deep leaf under a unicode directory 🎈\n'.repeat(5)),
};
const extraFolders = ['docs/empty-dir'];

FS.mkdirTree('/fix/in');
FS.mkdirTree('/fix/out');
for (const [p, data] of Object.entries(files)) {
  const abs = '/fix/in/' + p;
  FS.mkdirTree(abs.slice(0, abs.lastIndexOf('/')));
  FS.writeFile(abs, data);
}
for (const d of extraFolders) FS.mkdirTree('/fix/in/' + d);

FS.chdir('/fix/in');
let r = run(['a', '/fix/out/with-dirs.7z', 'docs', '-bd', '-y', '-t7z', '-mx5']);
FS.chdir('/');
if (r.rc !== 0 && r.rc !== 1) {
  console.error('fixture creation failed rc=' + r.rc);
  console.error(r.lines.join('\n'));
  process.exitCode = 1;
  process.exit(1);
}

// Self-verify: the archive must contain explicit directory entries.
// NOTE (empirical, probe3.mjs): for 7z archives 'l -slt' emits NO Folder
// field at all — dirs are identifiable only via 'Attributes = D ...'.
// (zip/tar listings DO emit 'Folder = +'.) Detect dirs via either signal.
r = run(['l', '-slt', '/fix/out/with-dirs.7z', '-bd']);
const listing = r.lines.join('\n');
if (!listing.includes('Attributes = D') && !listing.includes('Folder = +')) {
  console.error('fixture archive contains NO directory entries; listing was:');
  console.error(listing);
  process.exitCode = 1;
  process.exit(1);
}
// Collect the folder paths 7z itself reports, for the consumer's assertions.
const folders = [];
let curPath = null;
let curIsDir = false;
let inBody = false;
function flushBlock() {
  if (curPath !== null && curIsDir) folders.push(curPath);
  curPath = null;
  curIsDir = false;
}
for (const line of r.lines) {
  if (!inBody) { if (line === '----------') inBody = true; continue; }
  if (line.trim() === '') { flushBlock(); continue; }
  const eq = line.indexOf('=');
  if (eq < 0) continue;
  const key = line.slice(0, eq).trim();
  let val = line.slice(eq + 1);
  if (val.charAt(0) === ' ') val = val.slice(1);
  if (key === 'Path') curPath = val;
  if (key === 'Folder' && val === '+') curIsDir = true;
  if (key === 'Attributes' && /^D/.test(val)) curIsDir = true;
}
flushBlock();
if (folders.length === 0) {
  console.error('fixture self-check: no Folder=+ entry parsed');
  process.exitCode = 1;
  process.exit(1);
}

const bytes = FS.readFile('/fix/out/with-dirs.7z');
fs.mkdirSync(nodePath.dirname(outArchive), { recursive: true });
fs.writeFileSync(outArchive, Buffer.from(bytes));
fs.writeFileSync(
  outMeta,
  JSON.stringify(
    {
      files: Object.fromEntries(Object.entries(files).map(([p, d]) => [p, Buffer.from(d).toString('base64')])),
      folders,
    },
    null,
    2
  )
);
console.log('fixture written: ' + outArchive + ' (' + bytes.length + ' bytes), folders=' + JSON.stringify(folders));
process.exitCode = 0;
