// Generates <site-dir>/sw-manifest.js: the precache list + version stamp that
// sw.js consumes via importScripts('./sw-manifest.js').
//
// Usage: node generate-sw-manifest.mjs <site-dir>
//
// Node ESM, zero npm dependencies (Node >= 18). Fully deterministic: no Date,
// no randomness — the version always ends in a sha256 content hash of every
// listed asset, prefixed with "<version>-<builtAt>" from build-info.json when
// present, so identical site bytes always produce an identical manifest (and
// therefore an identical cache name) while ANY content change rotates it —
// even a redeploy that reuses an old build-info.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const USAGE = 'usage: node generate-sw-manifest.mjs <site-dir>';

// Top-level files that must never be precached:
//  - sw.js is the consumer of this list; caching it would defeat the
//    version-keyed cache busting that sw-manifest.js exists to provide,
//  - sw-manifest.js is this script's own output (re-runs must be idempotent),
//  - build-info.json is served network-first by sw.js, so a cached copy would
//    hide fresh build metadata.
const TOP_LEVEL_EXCLUDES = new Set(['sw.js', 'sw-manifest.js', 'build-info.json']);

// Directory/file name components skipped at any depth.
const EXCLUDED_DIRS = new Set(['node_modules', 'tests']);

// Always listed, even if the walk did not find them on disk, so the service
// worker can always fall back to a cached shell when the network is down.
const REQUIRED_ASSETS = ['./index.html', './offline.html'];

const NUL = Buffer.from([0]);
const EMPTY = Buffer.alloc(0);

function fail(message, code) {
  process.stderr.write(`generate-sw-manifest: ${message}\n`);
  process.exit(code);
}

// Recursively collect site-relative paths (always '/'-separated) of files
// under `dir`. `rel` is the '/'-selected path of `dir` relative to the site
// root ('' for the root itself). `seen` holds realpaths of visited directories
// so symlink loops cannot hang the build.
function walk(dir, rel, out, seen) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    fail(`cannot read directory '${rel || '.'}': ${err.message}`, 1);
  }
  // readdir order is filesystem-dependent; sort for a deterministic walk.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const name = entry.name;
    const relPath = rel ? `${rel}/${name}` : name;

    // Skip dotfiles/dot-directories (.git, .github, .DS_Store, ...) and
    // node_modules at any depth.
    if (name.startsWith('.')) continue;
    if (EXCLUDED_DIRS.has(name)) continue;
    // sw.js / sw-manifest.js / build-info.json are excluded only at the top
    // level, per the shared contract.
    if (rel === '' && TOP_LEVEL_EXCLUDES.has(name)) continue;

    const full = path.join(dir, name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      let st;
      try {
        st = fs.statSync(full); // follows the link
      } catch {
        continue; // broken symlink: nothing to precache
      }
      isDir = st.isDirectory();
      isFile = st.isFile();
    }

    if (isDir) {
      let real;
      try {
        real = fs.realpathSync(full);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      walk(full, relPath, out, seen);
    } else if (isFile) {
      out.push(relPath);
    }
  }
}

// Version from <site-dir>/build-info.json when it exists and carries both
// fields CI writes ("version", "builtAt"); null otherwise so the caller falls
// back to the content hash. A malformed file warns but never fails the build.
function buildInfoVersion(siteDir) {
  const file = path.join(siteDir, 'build-info.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // absent -> content-hash version
  }
  let info;
  try {
    info = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `generate-sw-manifest: warning: ignoring unparseable build-info.json (${err.message})\n`
    );
    return null;
  }
  if (!info || typeof info !== 'object') return null;
  const { version, builtAt } = info;
  if (typeof version !== 'string' || version === '') return null;
  if (typeof builtAt !== 'string' || builtAt === '') return null;
  return `${version}-${builtAt}`;
}

// sha256 over, for each asset in sorted order: relative path + NUL + file
// bytes. Truncated to 12 hex chars. Files that are listed but absent on disk
// (the REQUIRED_ASSETS guarantee) hash as empty rather than failing.
function contentVersion(siteDir, relPaths) {
  const hash = crypto.createHash('sha256');
  for (const rel of relPaths) {
    hash.update(Buffer.from(rel, 'utf8'));
    hash.update(NUL);
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(siteDir, rel));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        fail(`cannot read '${rel}' for hashing: ${err.message}`, 1);
      }
      bytes = EMPTY;
    }
    hash.update(bytes);
  }
  return hash.digest('hex').slice(0, 12);
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length !== 1) {
    process.stderr.write(`generate-sw-manifest: expected exactly one <site-dir> argument\n${USAGE}\n`);
    process.exit(2);
  }
  // Resolving a relative <site-dir> needs the cwd; if it is unreadable, report
  // a clear usage error rather than an unhandled ENOENT stack trace.
  let siteDir;
  try {
    siteDir = path.resolve(args[0]);
  } catch (err) {
    process.stderr.write(
      `generate-sw-manifest: cannot resolve '${args[0]}' against the working directory (${err.message})\n${USAGE}\n`
    );
    process.exit(2);
  }

  let st;
  try {
    st = fs.statSync(siteDir);
  } catch {
    process.stderr.write(`generate-sw-manifest: site directory not found: ${args[0]}\n${USAGE}\n`);
    process.exit(2);
  }
  if (!st.isDirectory()) {
    process.stderr.write(`generate-sw-manifest: not a directory: ${args[0]}\n${USAGE}\n`);
    process.exit(2);
  }

  let rootReal;
  try {
    rootReal = fs.realpathSync(siteDir);
  } catch (err) {
    fail(`cannot resolve site directory '${args[0]}': ${err.message}`, 1);
  }

  const relPaths = [];
  walk(siteDir, '', relPaths, new Set([rootReal]));
  relPaths.sort();

  // './'-prefixed relative URLs (never root-absolute: the site may be served
  // from a GitHub Pages subpath), de-duplicated, with the required shell
  // entries guaranteed present.
  const assets = [...new Set(relPaths.map((p) => `./${p}`))];
  for (const required of REQUIRED_ASSETS) {
    if (!assets.includes(required)) assets.push(required);
  }
  assets.sort();

  const fromBuildInfo = buildInfoVersion(siteDir);
  // The content hash is ALWAYS mixed in: a skip_build redeploy reuses the old
  // build-info.json, so a "<version>-<builtAt>"-only stamp would pin a site
  // whose bytes changed to a stale cache name — the updated service worker
  // would overwrite the live cache in place during install instead of
  // rotating cleanly to a new one.
  const contentHash = contentVersion(siteDir, assets.map((a) => a.slice(2)));
  const version = fromBuildInfo ? `${fromBuildInfo}-${contentHash}` : contentHash;

  // Exactly two statements, double-quoted JSON strings, no trailing comma in
  // the array so the literal is also valid JSON.
  const lines = [
    `self.__SW_VERSION__ = ${JSON.stringify(version)};`,
    'self.__SW_ASSETS__ = [',
    ...assets.map((asset, i) => `  ${JSON.stringify(asset)}${i === assets.length - 1 ? '' : ','}`),
    '];',
  ];
  const outPath = path.join(siteDir, 'sw-manifest.js');
  try {
    fs.writeFileSync(outPath, `${lines.join('\n')}\n`);
  } catch (err) {
    fail(`cannot write ${outPath}: ${err.message}`, 1);
  }

  // One-line summary: asset count + version. The path is printed absolute on
  // purpose — process.cwd() may be unreadable, and this must never throw.
  console.log(`generate-sw-manifest: ${assets.length} assets, version ${version} -> ${outPath}`);
}

main(process.argv);
