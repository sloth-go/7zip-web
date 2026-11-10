# 7-Zip WASM

[7-Zip](https://www.7-zip.org/) compiled to WebAssembly, served as an offline-capable
PWA on GitHub Pages. Compress, extract, inspect and test archives **entirely in your
browser** — no uploads, no server-side processing, works offline after the first visit.

## Features

- Create `.7z` and `.zip` archives (with optional password + header encryption for 7z)
- List, test and extract archives with paths preserved (7z, zip, tar, gz, xz, zst, rar, iso, …)
- Runs in a Web Worker — the UI never blocks on big archives
- Installable PWA with a versioned service-worker cache: every weekly build invalidates
  the cache automatically

## File handling

When installed, the PWA doubles as a system-level archive handler. Everything here is
feature-detected; browsers without support keep the plain dropzone/download behavior:

- **Open with** (desktop Chrome/Edge): `file_handlers` in `manifest.webmanifest`
  registers the app for the supported archive extensions; launched files arrive via
  `window.launchQueue` and open like dropped ones.
- **Share sheet** (Android Chrome): `share_target` receives shared files as a POST to
  `./__share`, which the service worker intercepts, stashes in a dedicated cache and
  answers with a redirect; the app picks the files up on the next load.
- **Native pickers** (Chromium only): “Open archive…” (`showOpenFilePicker`),
  “Extract to folder…” writes entries into a real directory (`showDirectoryPicker`),
  and each download row offers “Save as…” (`showSaveFilePicker`).
- Everywhere else (Firefox, Safari, …) these entry points stay hidden and nothing
  changes.

## How publishing works

`.github/workflows/publish.yml` runs **every Monday 04:00 UTC** (and on demand):

1. Resolves the latest upstream tag of [`ip7z/7zip`](https://github.com/ip7z/7zip)
   (or builds a ref you specify via `workflow_dispatch`)
2. Compiles `7zz` to wasm with emscripten (emsdk 4.0.10), single-threaded
   (`ST_MODE=1` — GitHub Pages cannot serve the COOP/COEP headers that
   `SharedArrayBuffer`/pthreads would require)
3. Smoke-tests the artifact under Node (create → list → extract → byte-compare)
4. Generates `sw-manifest.js` (asset list + cache version) and deploys to GitHub Pages

`workflow_dispatch` with `skip_build: true` redeploys the site using the wasm from the
most recent successful run (useful for shipping UI fixes without a 20-minute rebuild).

## Repository layout

| Path | Purpose |
| --- | --- |
| `index.html`, `app.js` | UI (no frameworks, no external resources) |
| `worker.js` | Web Worker hosting the wasm engine (`callMain` per operation) |
| `sw.js`, `offline.html`, `manifest.webmanifest` | PWA / offline layer |
| `.github/workflows/publish.yml` | Weekly build & publish pipeline |
| `.github/scripts/emscripten_shim.c` | `sysinfo()` + `umask()` shims (see below) |
| `.github/scripts/wasm-smoke-test.mjs` | Node roundtrip test run in CI |
| `.github/scripts/generate-sw-manifest.mjs` | Writes the versioned precache manifest |
| `icons/` | PWA icons |
| `wasm/` | Build output — **gitignored**; CI generates it, drop local builds here for dev |

## Local development

```sh
# put a wasm build in place (CI artifact, or build locally with emsdk), then:
python3 -m http.server -d . 8080
# open http://localhost:8080
```

## Build notes (why the flags are what they are)

- **No `--no-entry`**: it removes the `main` export and emscripten then dead-strips
  `callMain` from the glue, even when listed in `-sEXPORTED_RUNTIME_METHODS`.
  `-sINVOKE_RUN=0` prevents auto-running main instead.
- **`-sEXIT_RUNTIME=0`**: `callMain` may be invoked repeatedly (one call per user
  operation); `EXIT_RUNTIME=1` would tear the runtime down after the first one.
- **`emscripten_shim.c`**: emscripten lacks `sysinfo()` (used by 7-Zip's
  `GetRamSize()`), and its `__syscall_umask` stub starts the process umask at `0777`,
  which would zero 7-Zip's `C_umask` mask and make every extracted file mode `0000`
  (EACCES). The shim provides `sysinfo()` and a POSIX `umask()` defaulting to `0022`.

## License / attribution

7-Zip is Copyright (c) 1999-2026 Igor Pavlov, distributed under the GNU LGPL.
This repository contains only the web wrapper, CI pipeline and PWA assets; the 7-Zip
source is fetched from upstream at build time.
