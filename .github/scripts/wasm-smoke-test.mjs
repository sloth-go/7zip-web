// Smoke test: run the emscripten-built 7zz WASM under Node.
// Verifies the module loads, exposes callMain, and can actually
// compress + extract a file through the emscripten FS.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const [,, jsPath, wasmPath] = process.argv;
if (!jsPath || !wasmPath) {
  console.error('usage: wasm-smoke-test.mjs <7zz.js> <7zz.wasm>');
  process.exit(2);
}

const jsAbs = path.resolve(jsPath);
const wasmBin = fs.readFileSync(path.resolve(wasmPath));

// Emscripten glue reads the .wasm relative to the script; give Node a
// fetch-like loader that satisfies it regardless of cwd.
const mod = require(jsAbs);
const factory = mod.default ?? mod.createModule ?? mod;
const create7zip = typeof factory === 'function' ? factory : mod;

const Module = await create7zip({
  locateFile: (p) => (p.endsWith('.wasm') ? path.resolve(wasmPath) : p),
  wasmBinary: wasmBin,
  noInitialRun: true,
  print: (t) => process.stdout.write(t + '\n'),
  printErr: (t) => process.stderr.write(t + '\n'),
});

if (typeof Module.callMain !== 'function') {
  console.error('FAIL: Module.callMain is not available');
  process.exit(1);
}

// Seed a file, compress it, list the archive, extract it, compare.
const original = 'hello 7-zip wasm smoke test\n'.repeat(100);
Module.FS.mkdir('/work');
Module.FS.writeFile('/work/hello.txt', original);
const rc1 = Module.callMain(['a', '/work/out.7z', '/work/hello.txt', '-bd']);
if (rc1 !== 0) { console.error('FAIL: 7z a rc=' + rc1); process.exit(1); }
const rc2 = Module.callMain(['l', '/work/out.7z', '-bd']);
if (rc2 !== 0) { console.error('FAIL: 7z l rc=' + rc2); process.exit(1); }
Module.FS.writeFile('/work/out.7z02', Module.FS.readFile('/work/out.7z'));
const rc3 = Module.callMain(['e', '/work/out.7z', '-o/work/extracted', '-bd', '-y']);
if (rc3 !== 0) { console.error('FAIL: 7z e rc=' + rc3); process.exit(1); }
const extracted = new TextDecoder().decode(Module.FS.readFile('/work/extracted/hello.txt'));
if (extracted !== original) {
  console.error('FAIL: extracted content differs from original');
  process.exit(1);
}
console.log('SMOKE TEST PASSED (create, list, extract, roundtrip content OK)');
