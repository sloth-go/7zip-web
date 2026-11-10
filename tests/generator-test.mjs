// Tests for .github/scripts/generate-sw-manifest.mjs (the sw.js precache list
// generator). Zero dependencies; runs on Node >= 18.
//
//   node tests/generator-test.mjs      (from the repo root; any cwd works)
//
// Prints PASS/FAIL per assertion and exits nonzero if any assertion fails.
// All scratch fixtures are built under $TMPDIR/7zip-web-tests/generator-test so
// the repo working tree stays clean.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Repo root derived from this file's own location (tests/..).
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, '.github/scripts/generate-sw-manifest.mjs');
const ROOT = path.join(os.tmpdir(), '7zip-web-tests', 'generator-test'); // scratch — holds THIS suite's fixtures, never rm -rf the repo
const SITE = path.join(ROOT, 'fixture-site');
const MANIFEST = path.join(SITE, 'sw-manifest.js');

const BUILD_INFO = {
  version: '26.06',
  ref: '26.06',
  commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  builtAt: '2026-11-10T04:00:00Z',
  emscripten: '4.0.10',
};
const EXPECTED_VERSION = `${BUILD_INFO.version}-${BUILD_INFO.builtAt}`;

// What the walk must produce for the fixture below, sorted.
const EXPECTED_ASSETS = [
  './about/index.html',
  './app.js',
  './icons/icon-192.png',
  './index.html',
  './manifest.webmanifest',
  './offline.html',
  './wasm/7zz.js',
  './wasm/7zz.wasm',
  './worker.js',
];

// Entries that must NEVER appear.
const FORBIDDEN = [
  './sw.js',
  './sw-manifest.js',
  './build-info.json',
  './.git/dummy',
  './.hidden',
  './node_modules/x.js',
  // Test suites live in the repo but must never ship in the published site.
  './tests/run-all.mjs',
  './tests/sw.test.mjs',
  './tests/nested/deep.test.mjs',
];

let passed = 0;
let failed = 0;

function brief(msg) {
  const text = String(msg).split('\n').join('\n      ');
  return text.length > 1200 ? `${text.slice(0, 1200)}\n      [...truncated]` : text;
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${brief(err && err.message)}`);
  }
}

function writeFixture() {
  fs.rmSync(SITE, { recursive: true, force: true });
  fs.mkdirSync(path.join(SITE, 'wasm'), { recursive: true });
  fs.mkdirSync(path.join(SITE, 'icons'), { recursive: true });
  fs.mkdirSync(path.join(SITE, 'about'), { recursive: true });
  fs.mkdirSync(path.join(SITE, '.git'), { recursive: true });
  fs.mkdirSync(path.join(SITE, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(SITE, 'tests', 'nested'), { recursive: true });

  fs.writeFileSync(path.join(SITE, 'index.html'), '<!doctype html><title>7-Zip WASM</title>\n');
  fs.writeFileSync(path.join(SITE, 'offline.html'), '<!doctype html><title>Offline</title>\n');
  fs.writeFileSync(path.join(SITE, 'app.js'), '// app\nconsole.log("app");\n');
  fs.writeFileSync(path.join(SITE, 'worker.js'), '// worker\nself.onmessage = () => {};\n');
  fs.writeFileSync(
    path.join(SITE, 'manifest.webmanifest'),
    JSON.stringify({ name: '7-Zip WASM', start_url: './' }, null, 2) + '\n'
  );
  // Must be EXCLUDED from the asset list.
  fs.writeFileSync(path.join(SITE, 'sw.js'), "importScripts('./sw-manifest.js');\n");
  // Excluded from assets, but drives __SW_VERSION__.
  fs.writeFileSync(path.join(SITE, 'build-info.json'), JSON.stringify(BUILD_INFO, null, 2) + '\n');
  // Dummy wasm glue + binary bytes.
  fs.writeFileSync(path.join(SITE, 'wasm', '7zz.js'), 'function create7zip(){}\n');
  fs.writeFileSync(path.join(SITE, 'wasm', '7zz.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 2, 3]));
  // Dummy PNG.
  fs.writeFileSync(path.join(SITE, 'icons', 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  // Excluded: dot-dir, dot-file, node_modules.
  fs.writeFileSync(path.join(SITE, '.git', 'dummy'), 'x');
  fs.writeFileSync(path.join(SITE, '.hidden'), 'x');
  fs.writeFileSync(path.join(SITE, 'node_modules', 'x.js'), 'x');
  // Excluded at any depth: the test-suite directory must never be published.
  fs.writeFileSync(path.join(SITE, 'tests', 'run-all.mjs'), '// runner\n');
  fs.writeFileSync(path.join(SITE, 'tests', 'sw.test.mjs'), '// suite\n');
  fs.writeFileSync(path.join(SITE, 'tests', 'nested', 'deep.test.mjs'), '// nested suite\n');
  // Subdir page must be INCLUDED as './about/index.html'.
  fs.writeFileSync(path.join(SITE, 'about', 'index.html'), '<!doctype html><title>About</title>\n');
}

// Run the generator. Returns { status, stdout, stderr }; throws only on an
// unexpected spawn failure (non-zero exits are captured, not thrown).
function run(args = [SITE]) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    if (typeof err.status !== 'number') throw err;
    return { status: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

// Evaluate the generated file the way sw.js does: importScripts assigns onto
// `self`. vm gives us a real JS evaluation with a stubbed self. The array is
// copied out of the sandbox realm so assert.deepStrictEqual (which compares
// prototypes) can compare it against literals from this realm.
function loadManifest(file = MANIFEST) {
  const code = fs.readFileSync(file, 'utf8');
  const sandbox = { self: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file });
  const raw = sandbox.self.__SW_ASSETS__;
  return {
    version: sandbox.self.__SW_VERSION__,
    assets: Array.isArray(raw) ? Array.from(raw) : raw,
    rawAssets: raw,
    code,
  };
}

// ---------------------------------------------------------------- fixture ---
// Sit outside the fixture (a deleted cwd makes process.cwd() throw for this
// process and for every child we spawn).
fs.mkdirSync(ROOT, { recursive: true });
process.chdir(path.dirname(ROOT));
writeFixture();

check('script exists and is readable', () => {
  assert.equal(fs.statSync(SCRIPT).isFile(), true);
});

// ------------------------------------------------------- happy path (A) -----
const runA = run();
check('generator exits 0 on a valid site dir', () => {
  assert.equal(runA.status, 0, `stderr: ${runA.stderr}`);
});

check('sw-manifest.js is written into the site dir', () => {
  assert.equal(fs.existsSync(MANIFEST), true);
});

check('stdout is a single-line summary containing count + version', () => {
  const lines = runA.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `expected one line, got: ${JSON.stringify(runA.stdout)}`);
  assert.match(lines[0], /\b9 assets\b/, 'summary should mention the asset count');
  assert.ok(lines[0].includes(EXPECTED_VERSION), `summary should mention version: ${lines[0]}`);
  assert.equal(runA.stderr, '', 'a clean run must not write to stderr');
});

const manA = loadManifest();

check('generated file evaluates and sets self.__SW_ASSETS__ to an array of strings', () => {
  assert.ok(Array.isArray(manA.rawAssets), '__SW_ASSETS__ must be an array in the evaluated sandbox');
  assert.ok(Array.isArray(manA.assets), '__SW_ASSETS__ must be an array');
  assert.ok(manA.assets.length > 0, '__SW_ASSETS__ must not be empty');
  for (const a of manA.assets) assert.equal(typeof a, 'string', `non-string entry: ${a}`);
});

check('__SW_ASSETS__ matches the expected set exactly (set equality)', () => {
  assert.deepEqual([...manA.assets].sort(), [...EXPECTED_ASSETS].sort());
});

check('__SW_ASSETS__ is sorted, de-duplicated, and includes ./index.html', () => {
  const sorted = [...manA.assets].sort();
  assert.deepEqual(manA.assets, sorted, 'assets must be emitted in sorted order');
  assert.equal(new Set(manA.assets).size, manA.assets.length, 'assets must be unique');
  assert.ok(manA.assets.includes('./index.html'), './index.html must be listed');
  assert.equal(manA.assets[0], './about/index.html');
});

check('subdir page included as ./about/index.html', () => {
  assert.ok(manA.assets.includes('./about/index.html'));
});

check('wasm glue + wasm binary are both precached', () => {
  assert.ok(manA.assets.includes('./wasm/7zz.js'));
  assert.ok(manA.assets.includes('./wasm/7zz.wasm'));
});

check('icons and all site files are precached', () => {
  for (const a of ['./icons/icon-192.png', './app.js', './worker.js', './manifest.webmanifest', './offline.html']) {
    assert.ok(manA.assets.includes(a), `missing ${a}`);
  }
});

check('exclusions absent: sw.js, sw-manifest.js, build-info.json, dot paths, node_modules, tests', () => {
  for (const bad of FORBIDDEN) {
    assert.ok(!manA.assets.includes(bad), `${bad} must be excluded`);
  }
  for (const a of manA.assets) {
    // Strip the './' prefix before inspecting path components, otherwise the
    // prefix's own '.' looks like a dot-component.
    const components = a.replace(/^\.\//, '').split('/');
    assert.ok(
      !components.some((c) => c.startsWith('.')),
      `dot component leaked: ${a}`
    );
    assert.ok(!components.includes('node_modules'), `node_modules leaked: ${a}`);
    assert.ok(!components.includes('tests'), `tests dir leaked: ${a}`);
  }
});

check('the excluded tests/ tree really exists in the fixture (exclusion is exercised, not vacuous)', () => {
  for (const rel of ['tests/run-all.mjs', 'tests/sw.test.mjs', 'tests/nested/deep.test.mjs']) {
    assert.equal(fs.existsSync(path.join(SITE, rel)), true, `fixture file missing: ${rel}`);
  }
  assert.ok(!manA.assets.some((a) => a.startsWith('./tests/')), 'no ./tests/ URL may be precached');
});

check('every URL is relative (no root-absolute, no external origin)', () => {
  for (const a of manA.assets) {
    assert.ok(a.startsWith('./'), `not relative: ${a}`);
    assert.ok(!a.startsWith('//'), `protocol-relative: ${a}`);
    assert.ok(!a.includes('://'), `absolute origin: ${a}`);
  }
});

check('__SW_VERSION__ === "<version>-<builtAt>" from build-info.json', () => {
  assert.equal(manA.version, EXPECTED_VERSION);
});

check('array literal is valid JSON (no trailing comma) and uses double quotes', () => {
  const m = manA.code.match(/self\.__SW_ASSETS__\s*=\s*(\[[\s\S]*?\]);/);
  assert.ok(m, 'could not locate __SW_ASSETS__ array literal');
  assert.deepEqual(JSON.parse(m[1]), EXPECTED_ASSETS);
  const v = manA.code.match(/self\.__SW_VERSION__\s*=\s*("[^"]*");/);
  assert.ok(v, 'could not locate __SW_VERSION__ string literal');
  assert.equal(JSON.parse(v[1]), EXPECTED_VERSION);
});

check('generated content is exactly the two documented statements', () => {
  const lines = manA.code.replace(/\n$/, '').split('\n');
  assert.equal(lines[0], `self.__SW_VERSION__ = "${EXPECTED_VERSION}";`);
  assert.equal(lines[1], 'self.__SW_ASSETS__ = [');
  assert.equal(lines[lines.length - 1], '];');
  assert.equal(lines.length, 2 + EXPECTED_ASSETS.length + 1);
  for (let i = 0; i < EXPECTED_ASSETS.length; i += 1) {
    const comma = i === EXPECTED_ASSETS.length - 1 ? '' : ',';
    assert.equal(lines[2 + i], `  ${JSON.stringify(EXPECTED_ASSETS[i])}${comma}`);
  }
});

// --------------------------------------------------- determinism (B) -------
const bytesA = fs.readFileSync(MANIFEST);

check('re-running over an existing sw-manifest.js is idempotent (byte-identical)', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(MANIFEST), bytesA, 'second run changed the output');
  // The previous output must not have leaked into the new asset list.
  assert.ok(!loadManifest().assets.includes('./sw-manifest.js'));
});

check('delete + rerun produces byte-identical output (deterministic)', () => {
  fs.rmSync(MANIFEST);
  assert.equal(fs.existsSync(MANIFEST), false);
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(MANIFEST), bytesA);
});

// --------------------------------------- content-hash version path (C) ----
let hashV1;
let hashV2;

check('without build-info.json, version is a 12-hex sha256 prefix', () => {
  fs.rmSync(path.join(SITE, 'build-info.json'));
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const m = loadManifest();
  assert.match(m.version, /^[0-9a-f]{12}$/, `unexpected version: ${m.version}`);
  hashV1 = m.version;
  // build-info.json is gone from disk; the asset list is unchanged (it was excluded).
  assert.deepEqual(m.assets, EXPECTED_ASSETS);
});

check('content hash is stable across repeated runs (no timestamps/randomness)', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  hashV2 = loadManifest().version;
  assert.equal(hashV2, hashV1);
});

check('changing one asset byte changes the content-hash version', () => {
  fs.appendFileSync(path.join(SITE, 'app.js'), '// bumped\n');
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const v = loadManifest().version;
  assert.match(v, /^[0-9a-f]{12}$/);
  assert.notEqual(v, hashV1, 'version did not change after an asset changed');
  fs.writeFileSync(path.join(SITE, 'app.js'), '// app\nconsole.log("app");\n'); // restore
  const r2 = run();
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(loadManifest().version, hashV1, 'version did not return to its original value');
});

check('adding a new file changes the content-hash version', () => {
  fs.writeFileSync(path.join(SITE, 'extra.txt'), 'new\n');
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const m = loadManifest();
  assert.notEqual(m.version, hashV1);
  assert.ok(m.assets.includes('./extra.txt'));
  fs.rmSync(path.join(SITE, 'extra.txt'));
});

// ------------------------------------------------- guarantee path (D) -----
check('./offline.html stays listed after the file is deleted', () => {
  fs.rmSync(path.join(SITE, 'offline.html'));
  const r = run();
  assert.equal(r.status, 0, `generator crashed on a missing offline.html: ${r.stderr}`);
  const m = loadManifest();
  assert.ok(m.assets.includes('./offline.html'), './offline.html must still be listed');
  assert.ok(m.assets.includes('./index.html'));
  assert.match(m.version, /^[0-9a-f]{12}$/, 'must still produce a hash version');
});

check('./index.html stays listed after the file is deleted', () => {
  fs.rmSync(path.join(SITE, 'index.html'));
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const m = loadManifest();
  assert.ok(m.assets.includes('./index.html'));
  assert.ok(m.assets.includes('./offline.html'));
  assert.deepEqual([...m.assets].sort(), m.assets, 'still sorted');
});

check('guaranteed entries survive a build-info.json version too', () => {
  fs.writeFileSync(path.join(SITE, 'build-info.json'), JSON.stringify(BUILD_INFO) + '\n');
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const m = loadManifest();
  assert.equal(m.version, EXPECTED_VERSION);
  assert.ok(m.assets.includes('./index.html') && m.assets.includes('./offline.html'));
});

check('malformed build-info.json falls back to the content hash instead of crashing', () => {
  fs.writeFileSync(path.join(SITE, 'build-info.json'), '{ not json');
  const r = run();
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const m = loadManifest();
  assert.match(m.version, /^[0-9a-f]{12}$/, `expected hash fallback, got ${m.version}`);
});

check('build-info.json missing builtAt falls back to the content hash', () => {
  fs.writeFileSync(path.join(SITE, 'build-info.json'), JSON.stringify({ version: '26.06' }) + '\n');
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(loadManifest().version, /^[0-9a-f]{12}$/);
});

// ---------------------------------------------------- error paths (E) -----
check('no arguments -> exit 2 with a stderr usage message', () => {
  const r = run([]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
  assert.ok(r.stderr.length > 0, 'stderr must not be empty');
  assert.match(r.stderr, /generate-sw-manifest/i);
  assert.match(r.stderr, /site-dir|usage/i);
  assert.equal(r.stdout, '', 'usage errors must not write to stdout');
});

check('nonexistent site dir -> exit 2 with a stderr message', () => {
  const r = run([path.join(ROOT, 'does-not-exist')]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
  assert.ok(r.stderr.length > 0);
  assert.match(r.stderr, /not found|no such|exist/i);
});

check('site dir that is a file -> exit 2 with a stderr message', () => {
  const f = path.join(ROOT, 'not-a-dir.txt');
  fs.writeFileSync(f, 'x');
  const r = run([f]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
  assert.ok(r.stderr.length > 0);
});

// --------------------------------------- real-world invocation shape -------
check('works with a relative site dir (as CI invokes it) and a trailing slash', () => {
  writeFixture(); // fresh, complete fixture
  const rel = run([`${path.relative(process.cwd(), SITE)}/`]);
  assert.equal(rel.status, 0, rel.stderr);
  const m = loadManifest();
  assert.equal(m.version, EXPECTED_VERSION);
  assert.deepEqual(m.assets, EXPECTED_ASSETS);
});

check('empty site dir still yields a valid manifest with the guaranteed entries', () => {
  const empty = path.join(ROOT, 'empty-site');
  fs.rmSync(empty, { recursive: true, force: true });
  fs.mkdirSync(empty, { recursive: true });
  const r = run([empty]);
  assert.equal(r.status, 0, r.stderr);
  const m = loadManifest(path.join(empty, 'sw-manifest.js'));
  assert.deepEqual([...m.assets].sort(), ['./index.html', './offline.html']);
  assert.match(m.version, /^[0-9a-f]{12}$/);
});

check('generator never emits root-absolute or external URLs', () => {
  writeFixture();
  run();
  const code = fs.readFileSync(MANIFEST, 'utf8');
  assert.ok(!/"\/[^/]/.test(code), 'root-absolute URL found in manifest');
  assert.ok(!/https?:\/\//.test(code), 'external URL found in manifest');
});

// ------------------------------------------------------------ summary -----
console.log('');
console.log(`generator-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('ALL GENERATOR TESTS PASSED');
