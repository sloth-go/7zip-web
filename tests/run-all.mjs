#!/usr/bin/env node
/*
 * Runs every test suite in this directory and prints one table + totals.
 *
 * Usage (from the repo root, or anywhere — the repo root is derived from this
 * file's own location):
 *
 *   node tests/run-all.mjs                # everything
 *   node tests/run-all.mjs sw-test        # only suites whose name matches
 *   node tests/run-all.mjs worker sw-     # multiple filters, substring match
 *   VERBOSE=1 node tests/run-all.mjs      # echo each suite's full output
 *
 * Exit code: 0 if every suite passed or was legitimately SKIPPED (e.g. the wasm
 * build is absent), 1 as soon as one suite fails, times out or crashes.
 *
 * Suites are discovered two ways and de-duplicated:
 *   1. PORTED  - the vm/wasm suites ported into tests/ (explicit, so a rename
 *                or a partially-written file shows up instead of vanishing);
 *   2. tests/*.test.mjs - everything else, picked up as it lands. Other agents
 *                may still be writing these files, so discovery is defensive:
 *                unreadable, empty or vanished entries are reported as SKIPPED
 *                rather than crashing the run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TESTS_DIR, '..');

// Suites ported into tests/ (run in this order: fast static checks first, the
// slow wasm-driven ones last).
const PORTED = [
  'index-html.test.mjs',
  'verify-index-html.test.mjs',
  'generator-test.mjs',
  'verify-generator.mjs',
  'sw-test.mjs',
  'sw-adversarial.mjs',
  'sw-integration-check.mjs',
  'isfolder-check.mjs',
  'worker-integration.mjs',
  'worker-adversarial.mjs'
];

// Helpers, not suites: never auto-discovered as tests.
const NOT_SUITES = new Set(['run-all.mjs', 'make-dir-archive-fixture.mjs']);

// Per-suite wall-clock budget. The wasm suites drive the real 7zz build, so the
// default is generous; override with TEST_TIMEOUT_MS.
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 600000);
const VERBOSE = process.env.VERBOSE === '1';

const filters = process.argv.slice(2);

/* ------------------------------------------------------------ suite listing */

function discoverSuites() {
  const names = [];
  const seen = new Set();
  const push = (name) => {
    if (!name || seen.has(name) || NOT_SUITES.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  for (const name of PORTED) push(name);
  let entries = [];
  try {
    entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  } catch (err) {
    console.log('warning: cannot list ' + TESTS_DIR + ': ' + err.message);
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.test.mjs')) push(entry.name);
  }
  return names.filter((name) => filters.length === 0 || filters.some((f) => name.includes(f)));
}

/* ------------------------------------------------------------- result parse */

// Pull "N passed, M failed" out of whatever a suite prints; suites disagree on
// wording, so fall back to the last non-empty line for the one-line report.
function summarize(output) {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  let passed = null;
  let failed = null;
  for (const line of lines) {
    // "149 passed, 0 failed" (most suites) and
    // "scenarios: 13, passed: 13, failed: 0" (the worker suites).
    const m = line.match(/(\d+)\s+passed\s*,\s*(\d+)\s+failed/i) ||
      line.match(/passed:\s*(\d+)\s*,\s*failed:\s*(\d+)/i) ||
      line.match(/(\d+)\s+passed\b/i);
    if (m) {
      passed = Number(m[1]);
      failed = m[2] === undefined ? null : Number(m[2]);
    }
  }
  // Suites that also report known-issue / xfail diagnostics.
  let extra = null;
  const known = output.match(/(\d+)\s+known site issue/i);
  const xfail = output.match(/xfail[a-z-]*:\s*(\d+)/i);
  if (known && Number(known[1]) > 0) extra = known[1] + ' known site issue';
  else if (xfail && Number(xfail[1]) > 0) extra = xfail[1] + ' xfail';
  return {
    passed,
    failed,
    extra,
    skipped: /^SKIPPED\b/m.test(output) || /SKIPPED \(wasm not built\)/.test(output),
    lastLine: lines.length ? lines[lines.length - 1] : ''
  };
}

function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join('tests', file)], {
      cwd: REPO,
      env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS || '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      out += '\n[run-all] timed out after ' + TIMEOUT_MS + ' ms, killing ' + file + '\n';
      try { child.kill('SIGKILL'); } catch (err) { /* already gone */ }
      finish({ code: null, timedOut: true, output: out });
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; if (VERBOSE) process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d; if (VERBOSE) process.stderr.write(d); });
    child.on('error', (err) => {
      finish({ code: null, spawnError: err.message, output: out });
    });
    child.on('close', (code, signal) => {
      finish({ code, signal, timedOut: false, output: out });
    });
  });
}

/* --------------------------------------------------------------------- main */

const suites = discoverSuites();
if (suites.length === 0) {
  console.log('run-all: no suites matched' + (filters.length ? ' ' + JSON.stringify(filters) : ''));
  process.exit(0);
}

console.log('run-all: ' + suites.length + ' suite(s) from ' + REPO);
console.log('node ' + process.version + ', timeout ' + Math.round(TIMEOUT_MS / 1000) + 's per suite');
console.log('-'.repeat(78));

const results = [];
for (const file of suites) {
  const started = Date.now();
  const full = path.join(TESTS_DIR, file);
  let res;
  // The file may have been removed (or never fully written) between discovery
  // and now; treat that as a skip so one agent's in-flight edit cannot fail the
  // whole run.
  let stat = null;
  try { stat = fs.statSync(full); } catch (err) { stat = null; }
  if (!stat || !stat.isFile() || stat.size === 0) {
    res = {
      code: 0,
      timedOut: false,
      output: 'SKIPPED (' + (stat ? 'file is empty' : 'file missing') + ')'
    };
  } else {
    process.stdout.write('RUN   ' + file + '\n');
    res = await runSuite(file);
  }
  const info = summarize(res.output);
  const missing = res.spawnError || (!stat && 'file missing');
  let status;
  if (res.timedOut) status = 'TIMEOUT';
  else if (res.spawnError) status = 'ERROR';
  else if (res.code === 0 && info.skipped) status = 'SKIP';
  else if (res.code === 0) status = 'PASS';
  else status = 'FAIL';

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const checks = info.passed === null
    ? '-'
    : info.passed + ' ok' + (info.failed === null ? '' : ', ' + info.failed + ' bad');
  console.log(
    status.padEnd(8) + file.padEnd(34) +
    ('exit=' + (res.code === null ? '-' + (res.signal || 'killed') : res.code)).padEnd(14) +
    (secs + 's').padEnd(8) +
    checks.padEnd(14) +
    (info.extra ? '[' + info.extra + '] ' : '') +
    info.lastLine.slice(0, 90)
  );
  if (status === 'FAIL' || status === 'TIMEOUT' || status === 'ERROR') {
    const tail = res.output.split('\n').filter((l) => l.trim()).slice(-40);
    console.log('  --- last ' + tail.length + ' lines of ' + file + ' ---');
    for (const line of tail) console.log('  | ' + line.slice(0, 200));
  }
  results.push({ file, status, code: res.code, info, secs, missing });
}

/* ------------------------------------------------------------------- report */

const counts = { PASS: 0, FAIL: 0, SKIP: 0, TIMEOUT: 0, ERROR: 0 };
for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

const totalPassed = results.reduce((n, r) => n + (r.info.passed || 0), 0);
const totalFailed = results.reduce((n, r) => n + (r.info.failed || 0), 0);

console.log('-'.repeat(78));
console.log('SUITE SUMMARY');
console.log('  ' + 'suite'.padEnd(34) + 'status'.padEnd(9) + 'exit'.padEnd(6) + 'time'.padEnd(8) + 'checks');
for (const r of results) {
  console.log('  ' + r.file.padEnd(34) + r.status.padEnd(9) +
    String(r.code === null ? '-' : r.code).padEnd(6) + (r.secs + 's').padEnd(8) +
    (r.info.passed === null ? '-' : r.info.passed + ' passed, ' + (r.info.failed === null ? '?' : r.info.failed) + ' failed') +
    (r.info.extra ? ' (' + r.info.extra + ')' : ''));
}
console.log('-'.repeat(78));
console.log('run-all: ' + results.length + ' suites | ' +
  counts.PASS + ' passed, ' + counts.FAIL + ' failed, ' + counts.SKIP + ' skipped' +
  (counts.TIMEOUT ? ', ' + counts.TIMEOUT + ' timed out' : '') +
  (counts.ERROR ? ', ' + counts.ERROR + ' errored' : ''));
console.log('run-all: ' + totalPassed + ' checks passed, ' + totalFailed + ' checks failed' +
  (counts.SKIP ? ' (skipped suites contribute none)' : ''));

const bad = results.filter((r) => r.status !== 'PASS' && r.status !== 'SKIP');
if (bad.length) {
  console.log('\nFAILED SUITES:');
  for (const r of bad) console.log('  - ' + r.file + ' (' + r.status + ')');
  process.exit(1);
}
console.log('\nALL SUITES GREEN');
process.exit(0);
