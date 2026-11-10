#!/usr/bin/env node
/*
 * Contract test: PWA file handling in manifest.webmanifest.
 *
 * Parses the real manifest (strict JSON), pulls ARCHIVE_EXTS / ARCHIVE_ACCEPT
 * out of the real app.js source and asserts the file_handlers + share_target
 * contract:
 *
 *   - file_handlers[0]: action "./", spec-valid launch_type enum, accept map
 *     covering exactly the 17 ARCHIVE_EXTS (leading dots, MIME-shaped keys),
 *     kept in sync with app.js ARCHIVE_ACCEPT
 *   - share_target: POST ./__share, multipart/form-data, params.files[0].name
 *   - no absolute / external / scheme-ful URLs anywhere in the manifest
 *   - the pre-existing members are unchanged in substance
 *
 * Usage: node tests/manifest-file-handling.test.mjs   (from the repo root)
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(REPO, 'manifest.webmanifest');
const APP_PATH = path.join(REPO, 'app.js');

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

function eq(a, b) {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch (err) {
    return false;
  }
}

/* ------------------------------------------------------------ source inputs */

const manifestSource = fs.readFileSync(MANIFEST_PATH, 'utf8');
const appSource = fs.readFileSync(APP_PATH, 'utf8');

let manifest = null;
section('manifest.webmanifest: strict JSON');
try {
  manifest = JSON.parse(manifestSource);
  check('manifest parses as strict JSON', true);
} catch (err) {
  check('manifest parses as strict JSON', false, err.message);
}

// ARCHIVE_EXTS, parsed out of the real app.js source.
const extsMatch = /var ARCHIVE_EXTS\s*=\s*\[([\s\S]*?)\];/.exec(appSource);
const ARCHIVE_EXTS = extsMatch
  ? [...extsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  : [];

// ARCHIVE_ACCEPT, parsed out of the real app.js source (plain object literal).
const acceptMatch = /var ARCHIVE_ACCEPT\s*=\s*\{([\s\S]*?)\n {2}\};/.exec(appSource);
let APP_ARCHIVE_ACCEPT = null;
if (acceptMatch) {
  try {
    APP_ARCHIVE_ACCEPT = eval('({' + acceptMatch[1] + '})'); // eslint-disable-line no-eval
  } catch (err) {
    APP_ARCHIVE_ACCEPT = null;
  }
}

// The contract's accept map (MIME -> extensions WITH leading dot).
const CONTRACT_ACCEPT = {
  'application/x-7z-compressed': ['.7z'],
  'application/zip': ['.zip'],
  'application/vnd.rar': ['.rar'],
  'application/x-tar': ['.tar'],
  'application/gzip': ['.gz', '.tgz'],
  'application/x-bzip2': ['.bz2', '.tbz'],
  'application/x-xz': ['.xz', '.txz'],
  'application/zstd': ['.zst', '.tzst'],
  'application/x-iso9660-image': ['.iso'],
  'application/vnd.ms-cab-compressed': ['.cab'],
  'application/x-lzma': ['.lzma'],
  'application/x-lzh-compressed': ['.lzh'],
  'application/x-arj': ['.arj'],
};

/* --------------------------------------------------------- pre-existing set */

// The manifest as of git HEAD (before file handling), for the "everything else
// unchanged in substance" check.
const EXPECTED_PREEXISTING = {
  name: '7-Zip WASM',
  short_name: '7-Zip',
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: '#111111',
  theme_color: '#111111',
  icons: [
    { src: './icons/icon-16.png', sizes: '16x16', type: 'image/png' },
    { src: './icons/icon-32.png', sizes: '32x32', type: 'image/png' },
    { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
};

/* ======================================================== file_handlers === */

section('file_handlers');

const handlers = manifest && manifest.file_handlers;
check('file_handlers exists and is an array of length 1',
  Array.isArray(handlers) && handlers.length === 1,
  JSON.stringify(handlers && handlers.length));

const handler = Array.isArray(handlers) ? handlers[0] : null;

check('file_handlers[0].action === "./"', handler && handler.action === './',
  handler && JSON.stringify(handler.action));

// The File Handling spec enum is "single-client" | "multiple-clients"
// (NOT the contract draft's "multiple" — research wins, per the contract's
// own deviation rule).
const LAUNCH_TYPE_ENUM = ['single-client', 'multiple-clients'];
check('file_handlers[0].launch_type is a spec-valid enum value',
  !!handler && LAUNCH_TYPE_ENUM.indexOf(handler.launch_type) >= 0,
  handler && JSON.stringify(handler.launch_type));

check('file_handlers[0] has exactly the keys {action, accept, launch_type}',
  !!handler && eq(Object.keys(handler).sort(), ['accept', 'action', 'launch_type']),
  handler && JSON.stringify(Object.keys(handler)));

const accept = handler && handler.accept;
check('accept is a non-empty plain object',
  !!accept && typeof accept === 'object' && !Array.isArray(accept) &&
  Object.keys(accept).length > 0);

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&_.+-]*$/i;
const acceptKeys = accept ? Object.keys(accept) : [];
const badKeys = acceptKeys.filter((k) => !MIME_RE.test(k));
check('every accept key looks like a MIME type (type/subtype)',
  acceptKeys.length > 0 && badKeys.length === 0, JSON.stringify(badKeys));

const acceptValues = acceptKeys.reduce((acc, k) => acc.concat(accept[k]), []);
const badValues = [];
for (const k of acceptKeys) {
  if (!Array.isArray(accept[k]) || accept[k].length === 0) badValues.push(k + ': not a non-empty array');
  else for (const v of accept[k]) {
    if (typeof v !== 'string' || !v.startsWith('.') || v.length < 2) badValues.push(k + ': ' + JSON.stringify(v));
  }
}
check('every accept value is a string extension WITH a leading dot',
  badValues.length === 0, JSON.stringify(badValues));

check('app.js ARCHIVE_EXTS parsed from source has 17 entries',
  ARCHIVE_EXTS.length === 17, 'got ' + ARCHIVE_EXTS.length + ': ' + JSON.stringify(ARCHIVE_EXTS));

const dotted = ARCHIVE_EXTS.map((e) => '.' + e);
const missing = dotted.filter((d) => acceptValues.indexOf(d) < 0);
check('every one of the 17 ARCHIVE_EXTS appears in the accept values',
  ARCHIVE_EXTS.length === 17 && missing.length === 0, 'missing: ' + JSON.stringify(missing));

const extras = acceptValues.filter((v) => dotted.indexOf(v) < 0);
check('accept values cover EXACTLY the 17 ARCHIVE_EXTS (no extras)',
  extras.length === 0, 'extra: ' + JSON.stringify(extras));

const dupes = acceptValues.filter((v, i) => acceptValues.indexOf(v) !== i);
check('no duplicate extensions across accept values', dupes.length === 0, JSON.stringify(dupes));

check('accept map deep-equals the contract map',
  !!accept && eq(accept, CONTRACT_ACCEPT),
  JSON.stringify(accept));

check('accept map is in sync with app.js ARCHIVE_ACCEPT',
  !!APP_ARCHIVE_ACCEPT && eq(accept, APP_ARCHIVE_ACCEPT),
  JSON.stringify(APP_ARCHIVE_ACCEPT));

/* ========================================================= share_target === */

section('share_target');

const share = manifest && manifest.share_target;
const CONTRACT_SHARE = {
  action: './__share',
  method: 'POST',
  enctype: 'multipart/form-data',
  params: {
    title: 'title',
    text: 'text',
    url: 'url',
    files: [{ name: 'files', accept: ['*/*'] }],
  },
};

check('share_target exists and is an object',
  !!share && typeof share === 'object' && !Array.isArray(share));
check('share_target.action === "./__share"', !!share && share.action === './__share',
  share && JSON.stringify(share.action));
check('share_target.method === "POST"', !!share && share.method === 'POST',
  share && JSON.stringify(share.method));
check('share_target.enctype === "multipart/form-data"',
  !!share && share.enctype === 'multipart/form-data',
  share && JSON.stringify(share && share.enctype));
check('share_target.params.files[0].name === "files"',
  !!share && !!share.params && Array.isArray(share.params.files) &&
  share.params.files.length === 1 && share.params.files[0].name === 'files',
  JSON.stringify(share && share.params && share.params.files));
check('share_target.params wires title/text/url and files accept ["*/*"]',
  !!share && eq(share.params, CONTRACT_SHARE.params),
  JSON.stringify(share && share.params));
check('share_target deep-equals the contract shape', !!share && eq(share, CONTRACT_SHARE),
  JSON.stringify(share));

/* ==================================================== relative-URL purity == */

section('no absolute / external URLs anywhere');

check('manifest source contains no "http" substring at all', !/http/i.test(manifestSource));

function walkStrings(value, out) {
  const list = out || [];
  if (typeof value === 'string') list.push(value);
  else if (Array.isArray(value)) value.forEach((v) => walkStrings(v, list));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => walkStrings(v, list));
  return list;
}

const strings = manifest ? walkStrings(manifest) : [];
const schemeful = strings.filter((s) => /^[a-z][a-z0-9+.-]*:/i.test(s));
check('no string value carries a URL scheme', schemeful.length === 0, JSON.stringify(schemeful));

const rootAbsolute = strings.filter((s) => s.startsWith('/'));
check('no string value is root-absolute or protocol-relative',
  rootAbsolute.length === 0, JSON.stringify(rootAbsolute));

// Every URL-ish member (action/start_url/scope/src) must be relative "./...".
const urlish = [];
if (manifest) {
  urlish.push(['start_url', manifest.start_url], ['scope', manifest.scope]);
  (manifest.icons || []).forEach((ic, i) => urlish.push(['icons[' + i + '].src', ic.src]));
  (manifest.file_handlers || []).forEach((fh, i) => urlish.push(['file_handlers[' + i + '].action', fh.action]));
  if (manifest.share_target) urlish.push(['share_target.action', manifest.share_target.action]);
}
const nonRelative = urlish.filter(([, v]) => typeof v !== 'string' || !v.startsWith('./'));
check('all URL members (start_url/scope/icons/actions) are relative "./..."',
  urlish.length >= 8 && nonRelative.length === 0, JSON.stringify(nonRelative));

/* ================================================ pre-existing members ==== */

section('pre-existing members unchanged in substance');

const rest = manifest ? Object.assign({}, manifest) : null;
if (rest) {
  delete rest.file_handlers;
  delete rest.share_target;
}
check('manifest minus {file_handlers, share_target} deep-equals the pre-existing manifest',
  !!rest && eq(rest, EXPECTED_PREEXISTING),
  JSON.stringify(rest && Object.keys(rest)));

check('name === "7-Zip WASM"', !!manifest && manifest.name === '7-Zip WASM');
check('short_name === "7-Zip"', !!manifest && manifest.short_name === '7-Zip');
check('start_url === "./"', !!manifest && manifest.start_url === './');
check('scope === "./"', !!manifest && manifest.scope === './');
check('display === "standalone"', !!manifest && manifest.display === 'standalone');
check('background_color / theme_color unchanged (#111111)',
  !!manifest && manifest.background_color === '#111111' && manifest.theme_color === '#111111');
check('icons: 4 entries with relative src, sizes, type and purpose preserved',
  !!manifest && eq(manifest.icons, EXPECTED_PREEXISTING.icons),
  JSON.stringify(manifest && manifest.icons));

const iconFiles = (manifest && manifest.icons ? manifest.icons : []).map((ic) => ic.src);
const missingIcons = iconFiles.filter((src) => !fs.existsSync(path.join(REPO, src)));
check('every icon src exists on disk', missingIcons.length === 0, JSON.stringify(missingIcons));

check('top-level members are exactly the 8 pre-existing + file_handlers + share_target',
  !!manifest && eq(Object.keys(manifest).sort(),
    Object.keys(EXPECTED_PREEXISTING).concat(['file_handlers', 'share_target']).sort()),
  JSON.stringify(manifest && Object.keys(manifest)));

/* ----------------------------------------------------------------- report */

console.log('\n' + '-'.repeat(70));
console.log('manifest-file-handling: ' + passCount + ' passed, ' + failCount + ' failed');
if (failCount > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log('  - ' + failure);
  process.exit(1);
}
console.log('ALL MANIFEST FILE-HANDLING TESTS PASSED');
process.exit(0);
