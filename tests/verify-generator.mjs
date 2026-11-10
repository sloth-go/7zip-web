// Adversarial verification of <repo>/.github/scripts/generate-sw-manifest.mjs
// Run: node tests/verify-generator.mjs   (from the repo root; any cwd works)
// Scratch areas live OUTSIDE the repo (a copy of the repo cannot be staged
// inside itself): $TMPDIR/7zip-web-tests/verify-generator/{site-copy,
// verify-fixture,verify-empty,verify-unreadable}  (unique names, no clashes).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Repo root derived from this file's own location (tests/..).
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GEN = path.join(REPO, '.github/scripts/generate-sw-manifest.mjs');
const BASE = path.join(os.tmpdir(), '7zip-web-tests', 'verify-generator');
const COPY = path.join(BASE, 'site-copy');
const FIX = path.join(BASE, 'verify-fixture');
const EMPTY = path.join(BASE, 'verify-empty');
const UNREADABLE = path.join(BASE, 'verify-unreadable');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + (err && err.message ? err.message : err));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEq(got, want, msg) {
  if (got !== want) throw new Error((msg ? msg + ': ' : '') + 'want ' + JSON.stringify(want) + ' got ' + JSON.stringify(got));
}

function runGen(cwd, args, scriptPath) {
  const r = spawnSync(process.execPath, [scriptPath || GEN, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function evalManifest(file) {
  const src = fs.readFileSync(file, 'utf8');
  const self = {};
  new Function('self', src)(self); // throws on syntax error
  return { src, version: self.__SW_VERSION__, assets: self.__SW_ASSETS__ };
}

// Independent expected-set computation from `find` output (NUL-separated so any
// filename is safe), applying the contract's exclusion rules.
function findExpected(rootDir) {
  const raw = execFileSync('find', [rootDir, '-type', 'f', '-print0'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
    .split('\0')
    .filter(Boolean);
  let rels = raw.map((p) => path.relative(rootDir, p).split(path.sep).join('/'));
  rels = rels.filter((rel) => {
    const comps = rel.split('/');
    if (comps.some((c) => c.startsWith('.'))) return false;
    // EXCLUDED_DIRS in the generator: skipped at any depth.
    if (comps.some((c) => c === 'node_modules' || c === 'tests')) return false;
    if (comps.length === 1 && ['sw.js', 'sw-manifest.js', 'build-info.json'].includes(comps[0])) return false;
    return true;
  });
  const set = new Set(rels.map((r) => './' + r));
  set.add('./index.html');
  set.add('./offline.html');
  return [...set].sort();
}

function sha12(siteDir, assets) {
  const h = crypto.createHash('sha256');
  for (const a of assets) {
    h.update(Buffer.from(a.slice(2), 'utf8'));
    h.update(Buffer.from([0]));
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(siteDir, a.slice(2)));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      bytes = Buffer.alloc(0);
    }
    h.update(bytes);
  }
  return h.digest('hex').slice(0, 12);
}

/* ------------------------------------------------------------------ staging */

fs.mkdirSync(BASE, { recursive: true });
fs.rmSync(COPY, { recursive: true, force: true });
execFileSync('cp', ['-a', REPO, COPY]);
fs.rmSync(path.join(COPY, '.git'), { recursive: true, force: true });

check('staging: .git removed from the copy', () => {
  assert(!fs.existsSync(path.join(COPY, '.git')), '.git still present');
});

let wasmWasReal = true;
for (const f of ['7zz.js', '7zz.wasm']) {
  const p = path.join(COPY, 'wasm', f);
  if (!fs.existsSync(p)) {
    wasmWasReal = false;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f === '7zz.js' ? '/* dummy glue */' : Buffer.from([0, 97, 115, 109]));
  }
}
const BUILD_INFO = {
  version: '26.06',
  ref: '26.06',
  commit: 'a'.repeat(40),
  builtAt: '2026-11-10T04:00:00Z',
  emscripten: '4.0.10',
};
fs.writeFileSync(path.join(COPY, 'build-info.json'), JSON.stringify(BUILD_INFO, null, 2) + '\n');

// expected set computed from find BEFORE the generator ever runs on the copy
const expected = findExpected(COPY);

/* ------------------------------------------- step 2: real-repo dry run + CI form */

let firstRun;
check('CI invocation form: cwd=<scratch base>, absolute script, relative dir arg "site-copy" exits 0 with 1-line stdout, empty stderr', () => {
  firstRun = runGen(BASE, ['site-copy']);
  assertEq(firstRun.code, 0, 'exit code');
  assertEq(firstRun.stderr, '', 'stderr');
  const lines = firstRun.stdout.split('\n').filter((l) => l !== '');
  assertEq(lines.length, 1, 'stdout line count');
  assert(/26\.06-2026-11-10T04:00:00Z/.test(lines[0]), 'summary should mention version: ' + lines[0]);
  assert(fs.existsSync(path.join(COPY, 'sw-manifest.js')), 'sw-manifest.js not written');
});

const manifestPath = path.join(COPY, 'sw-manifest.js');
let m1 = evalManifest(manifestPath);
const run1Bytes = fs.readFileSync(manifestPath);

check('__SW_ASSETS__ exactly equals the independent find-based expected set (set + order)', () => {
  assert(Array.isArray(m1.assets), 'assets not an array');
  assert(m1.assets.every((a) => typeof a === 'string'), 'non-string asset');
  assertEq(JSON.stringify(m1.assets), JSON.stringify(expected));
});

check('every emitted URL is relative ("./"-prefixed), none root-absolute or external', () => {
  for (const a of m1.assets) {
    assert(a.startsWith('./'), 'not ./ -prefixed: ' + a);
    assert(!a.startsWith('//') && !a.includes('://'), 'external-looking: ' + a);
  }
});

check('__SW_VERSION__ === "<version>-<builtAt>-<contentHash>" from build-info.json', () => {
  // The content-hash suffix must ALWAYS be mixed in: a skip_build redeploy
  // reuses this build-info.json while site bytes may have changed, so the
  // prefix alone would pin new content to a stale cache name.
  assertEq(m1.version, `26.06-2026-11-10T04:00:00Z-${sha12(COPY, m1.assets)}`);
});

check('output is exactly the two documented statements; array literal is valid JSON', () => {
  const match = m1.src.match(
    /^self\.__SW_VERSION__ = ("(?:[^"\\]|\\.)*");\nself\.__SW_ASSETS__ = (\[[\s\S]*?\]);\n$/
  );
  assert(match, 'file does not match the documented two-statement format:\n' + m1.src.slice(0, 200));
  const parsed = JSON.parse(match[2]);
  assertEq(JSON.stringify(parsed), JSON.stringify(m1.assets), 'array literal not JSON-equal to evaluated value');
  assertEq(JSON.parse(match[1]), m1.version, 'version literal not JSON-equal');
});

/* --------------------------------------------- step 3: cross-artifact coverage */

const SIBLINGS = [
  './index.html',
  './app.js',
  './worker.js',
  './offline.html',
  './manifest.webmanifest',
  './wasm/7zz.js',
  './wasm/7zz.wasm',
  './icons/icon-16.png',
  './icons/icon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
check('all sibling-agent artifacts + wasm + icons land in __SW_ASSETS__', () => {
  const missingRepo = SIBLINGS.filter((s) => !fs.existsSync(path.join(COPY, s.slice(2))));
  const missing = SIBLINGS.filter((s) => !m1.assets.includes(s));
  assert(missing.length === 0, 'missing from assets: ' + JSON.stringify(missing) +
    (missingRepo.length ? ' (also absent on disk: ' + JSON.stringify(missingRepo) + ')' : ''));
});

check('exclusions absent: ./sw.js, ./sw-manifest.js, ./build-info.json, dotfiles, .github/**, node_modules', () => {
  for (const bad of ['./sw.js', './sw-manifest.js', './build-info.json', './.gitignore']) {
    assert(!m1.assets.includes(bad), bad + ' must be excluded');
  }
  // slice(1): the first component is always '.' from the './' prefix itself
  assert(!m1.assets.some((a) => a.split('/').slice(1).some((c) => c.startsWith('.'))), 'dotfile leaked');
  assert(!m1.assets.some((a) => a.includes('node_modules')), 'node_modules leaked');
});

check('the copied repo tests/ tree is excluded from __SW_ASSETS__ (test suites never ship)', () => {
  const testsDir = path.join(COPY, 'tests');
  assert(fs.existsSync(testsDir) && fs.readdirSync(testsDir).length > 0,
    'staged copy has no tests/ content — the exclusion would be untested');
  const leaked = m1.assets.filter((a) => a.startsWith('./tests/'));
  assert(leaked.length === 0, 'tests/ leaked into the precache list: ' + JSON.stringify(leaked));
});

/* ------------------------------------------------------- determinism + CI form */

check('determinism: re-run over existing manifest is byte-identical', () => {
  const r = runGen(BASE, ['site-copy']);
  assertEq(r.code, 0, 'exit code');
  assert(fs.readFileSync(manifestPath).equals(run1Bytes), 'bytes differ on re-run');
});

check('trailing-slash dir arg "site-copy/" produces byte-identical output', () => {
  const r = runGen(BASE, ['site-copy/']);
  assertEq(r.code, 0, 'exit code');
  assert(fs.readFileSync(manifestPath).equals(run1Bytes), 'bytes differ with trailing slash');
});

check('exact CI form: cwd=site root, relative script path, dir arg "." — byte-identical output', () => {
  const r = runGen(COPY, ['.'], '.github/scripts/generate-sw-manifest.mjs');
  assertEq(r.code, 0, 'exit code');
  assertEq(r.stderr, '', 'stderr');
  assert(fs.readFileSync(manifestPath).equals(run1Bytes), 'bytes differ for CI-style invocation');
});

/* ------------------------------------------------- content-hash fallback path */

let hashVersion;
check('without build-info.json: version is first 12 hex of the documented sha256, computed independently', () => {
  fs.rmSync(path.join(COPY, 'build-info.json'));
  const r = runGen(BASE, ['site-copy']);
  assertEq(r.code, 0, 'exit code');
  const m = evalManifest(manifestPath);
  assert(/^[0-9a-f]{12}$/.test(m.version), 'version not 12 lowercase hex: ' + m.version);
  // asset set must be unchanged (build-info.json was excluded anyway)
  assertEq(JSON.stringify(m.assets), JSON.stringify(expected), 'asset set changed unexpectedly');
  const want = sha12(COPY, m.assets);
  assertEq(m.version, want, 'hash does not match independent sha256(path+NUL+bytes) computation');
  hashVersion = m.version;
});

check('content-hash determinism: two runs byte-identical, no timestamps involved', () => {
  const before = fs.readFileSync(manifestPath);
  const r = runGen(BASE, ['site-copy']);
  assertEq(r.code, 0, 'exit code');
  assert(fs.readFileSync(manifestPath).equals(before), 'bytes differ between hash-mode runs');
});

check('content hash changes when an asset byte changes', () => {
  const f = path.join(COPY, 'app.js');
  const orig = fs.readFileSync(f);
  try {
    fs.appendFileSync(f, '\n// verify probe\n');
    const r = runGen(BASE, ['site-copy']);
    assertEq(r.code, 0, 'exit code');
    const m = evalManifest(manifestPath);
    assert(m.version !== hashVersion, 'version did not change after byte edit');
    assertEq(m.version, sha12(COPY, m.assets), 'changed hash still mismatches independent computation');
  } finally {
    fs.writeFileSync(f, orig);
  }
  const r = runGen(BASE, ['site-copy']);
  assertEq(r.code, 0, 'exit code');
  const m = evalManifest(manifestPath);
  assertEq(m.version, hashVersion, 'hash not restored after reverting the byte edit');
});

/* --------------------------------------- step 5: weird names + symlinks in copy */

const WEIRD = 'weird name ümlaut "quote".txt';
check('filename with space + umlaut + double quote is JSON-escaped correctly and survives eval round-trip', () => {
  fs.writeFileSync(path.join(COPY, WEIRD), 'x');
  const r = runGen(BASE, ['site-copy']);
  assertEq(r.code, 0, 'exit code');
  const m = evalManifest(manifestPath);
  assert(m.assets.includes('./' + WEIRD), 'weird filename missing from assets');
  // raw source must contain the JSON-escaped form (quote escaped), raw umlaut allowed
  assert(m.src.includes(JSON.stringify('./' + WEIRD)), 'raw file lacks correct JSON escaping: ' + JSON.stringify('./' + WEIRD));
  assert(m.src.includes('\\"'), 'quote not backslash-escaped in raw output');
  // full expected set + the weird file, nothing else new
  const want = [...expected, './' + WEIRD].sort();
  assertEq(JSON.stringify(m.assets), JSON.stringify(want), 'asset set diverged beyond the weird file');
});

check('symlinks: file symlink followed, broken symlink skipped, no crash, no duplicates', () => {
  fs.symlinkSync('README.md', path.join(COPY, 'readme-link'));
  fs.symlinkSync('/nonexistent/xyz/abc', path.join(COPY, 'broken-link'));
  const r = runGen(BASE, ['site-copy']);
  assertEq(r.code, 0, 'exit code');
  assertEq(r.stderr, '', 'stderr');
  const m = evalManifest(manifestPath);
  assert(!m.assets.includes('./broken-link'), 'broken symlink listed');
  assertEq(new Set(m.assets).size, m.assets.length, 'duplicate entries present');
  // file symlink: contract allows skip-or-follow; this generator follows (statSync)
  if (m.assets.includes('./readme-link')) {
    assert(m.assets.includes('./README.md'), 'target README.md must still be listed');
  }
  const wantFollow = [...expected, './' + WEIRD, './readme-link'].sort();
  const wantSkip = [...expected, './' + WEIRD].sort();
  const got = JSON.stringify(m.assets);
  assert(got === JSON.stringify(wantFollow) || got === JSON.stringify(wantSkip),
    'asset set diverged beyond weird file + symlink policy');
  console.log('      (symlink-to-file policy: ' + (m.assets.includes('./readme-link') ? 'follow' : 'skip') + ')');
});

/* --------------------------------------------- adversarial build-info.json values */

check('build-info version containing quote + backslash is emitted as valid escaped JS/JSON', () => {
  fs.writeFileSync(path.join(COPY, 'build-info.json'), JSON.stringify({ version: '1.0"x\\y', builtAt: 'B' }));
  try {
    const r = runGen(BASE, ['site-copy']);
    assertEq(r.code, 0, 'exit code');
    const m = evalManifest(manifestPath);
    // build-info prefix + the always-mixed-in content hash (excluded assets
    // like build-info.json itself never affect the hash).
    const want = `1.0"x\\y-B-${sha12(COPY, m.assets)}`;
    assertEq(m.version, want, 'version round-trip');
    assert(m.src.includes(JSON.stringify(want)), 'raw output not properly escaped');
  } finally {
    fs.rmSync(path.join(COPY, 'build-info.json'));
    runGen(BASE, ['site-copy']);
  }
});

/* ------------------------------------------ separate fixture: dirs, nesting, newline */

fs.rmSync(FIX, { recursive: true, force: true });
fs.mkdirSync(path.join(FIX, 'sub/node_modules/pkg'), { recursive: true });
fs.mkdirSync(path.join(FIX, 'node_modules/pkg'), { recursive: true });
fs.writeFileSync(path.join(FIX, 'index.html'), '<!doctype html>');
fs.writeFileSync(path.join(FIX, 'offline.html'), 'offline');
fs.writeFileSync(path.join(FIX, 'sub/sw.js'), '// nested sw.js must be INCLUDED (top-level-only exclusion)');
fs.writeFileSync(path.join(FIX, 'sub/build-info.json'), '{"x":1}');
fs.writeFileSync(path.join(FIX, 'sub/node_modules/y.js'), 'y');
fs.writeFileSync(path.join(FIX, 'node_modules/pkg/x.js'), 'x');
fs.writeFileSync(path.join(FIX, 'new\nline.txt'), 'nl');
fs.symlinkSync('sub', path.join(FIX, 'dirlink')); // directory symlink
fs.symlinkSync('.', path.join(FIX, 'selflink'));  // loop back to root
fs.mkdirSync(path.join(FIX, 'build-info-dir.json')); // unrelated dir, sanity

check('fixture: nested sw.js/build-info.json included, node_modules excluded at any depth, newline name escaped', () => {
  const r = runGen(BASE, ['verify-fixture']);
  assertEq(r.code, 0, 'exit code (stderr: ' + r.stderr + ')', );
  const m = evalManifest(path.join(FIX, 'sw-manifest.js'));
  const A = m.assets;
  const occurrences = (name) => A.filter((a) => a.endsWith('/' + name) || a === './' + name);
  assertEq(occurrences('sw.js').length, 1, 'nested sw.js count');
  assertEq(occurrences('build-info.json').length, 1, 'nested build-info.json count');
  assert(!A.some((a) => a.includes('node_modules')), 'node_modules leaked');
  assert(A.includes('./new\nline.txt'), 'newline filename missing after eval');
  assert(m.src.includes('"./new\\nline.txt"'), 'newline not escaped in raw output');
  assertEq(new Set(A).size, A.length, 'duplicates');
});

check('fixture: directory symlink + selflink loop — no crash, no hang, contents listed exactly once', () => {
  const r = runGen(BASE, ['verify-fixture']);
  assertEq(r.code, 0, 'exit code');
  const m = evalManifest(path.join(FIX, 'sw-manifest.js'));
  const A = m.assets;
  // 'sw.js' content may appear under ./sub/ or ./dirlink/ depending on walk order,
  // but exactly once total; and no ./selflink/** explosion.
  const swEntries = A.filter((a) => a.endsWith('sw.js'));
  assertEq(swEntries.length, 1, 'sw.js listed once regardless of symlink policy: ' + JSON.stringify(swEntries));
  assert(!A.some((a) => a.startsWith('./selflink')), 'root loop symlink was followed');
  // sub/ contains exactly 2 includable files (sw.js, build-info.json; its
  // node_modules is excluded). The newline file lives at the fixture root.
  const subCount = A.filter((a) => a.startsWith('./sub/')).length;
  const dirCount = A.filter((a) => a.startsWith('./dirlink/')).length;
  assert(subCount === 2 || dirCount === 2, 'sub contents listed exactly once under one prefix; got sub=' + subCount + ' dirlink=' + dirCount);
  assert(!(subCount === 2 && dirCount === 2), 'sub contents listed twice (under both prefixes)');
  console.log('      (dir-symlink policy: contents listed under ' + (dirCount === 2 ? './dirlink/ (link wins alphabetically)' : './sub/') + ')');
});

/* ------------------------------------------------------------- empty site dir */

fs.rmSync(EMPTY, { recursive: true, force: true });
fs.mkdirSync(EMPTY, { recursive: true });
check('empty site dir: exit 0, guarantees present, 12-hex version, stable across runs', () => {
  const r = runGen(BASE, ['verify-empty']);
  assertEq(r.code, 0, 'exit code');
  const m = evalManifest(path.join(EMPTY, 'sw-manifest.js'));
  assertEq(JSON.stringify(m.assets), JSON.stringify(['./index.html', './offline.html']));
  assert(/^[0-9a-f]{12}$/.test(m.version), 'version: ' + m.version);
  const bytes1 = fs.readFileSync(path.join(EMPTY, 'sw-manifest.js'));
  const r2 = runGen(BASE, ['verify-empty']);
  assertEq(r2.code, 0, 'exit code 2nd run');
  assert(fs.readFileSync(path.join(EMPTY, 'sw-manifest.js')).equals(bytes1), 'empty-dir output not stable');
});

/* ---------------------------------------------------------- unreadable subdir */

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
if (!isRoot) {
  fs.rmSync(UNREADABLE, { recursive: true, force: true });
  fs.mkdirSync(path.join(UNREADABLE, 'locked'), { recursive: true });
  fs.writeFileSync(path.join(UNREADABLE, 'index.html'), 'x');
  fs.writeFileSync(path.join(UNREADABLE, 'locked/secret.txt'), 'x');
  fs.chmodSync(path.join(UNREADABLE, 'locked'), 0o000);
  check('unreadable subdir: clean exit 1 with prefixed stderr message, no stack trace', () => {
    try {
      const r = runGen(BASE, ['verify-unreadable']);
      assertEq(r.code, 1, 'exit code');
      assert(r.stderr.startsWith('generate-sw-manifest:'), 'stderr not prefixed: ' + r.stderr);
      assert(!/at .*\(.*:\d+:\d+\)/.test(r.stderr), 'stack trace leaked: ' + r.stderr);
    } finally {
      fs.chmodSync(path.join(UNREADABLE, 'locked'), 0o755);
    }
  });
} else {
  console.log('SKIP  unreadable subdir (running as root)');
}

/* ------------------------------------------------------ real wasm sanity note */

console.log('INFO  wasm/7zz.wasm in copy came from repo staging: ' + wasmWasReal +
  ' (' + fs.statSync(path.join(COPY, 'wasm/7zz.wasm')).size + ' bytes)');

/* ------------------------------------------------------------------- cleanup */

for (const d of [FIX, EMPTY, UNREADABLE]) fs.rmSync(d, { recursive: true, force: true });

console.log(`\nverify-generator: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('VERIFICATION FAILURES PRESENT');
  process.exit(1);
}
console.log('ALL VERIFICATION CHECKS PASSED');
