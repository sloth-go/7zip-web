/*
 * worker.js — 7-Zip WebAssembly engine worker (classic Worker script, no modules).
 *
 * Speaks the binding WORKER MESSAGE PROTOCOL with app.js:
 *   main -> worker: {id,type:'init'} | {id,type:'list'|'extract'|'test',archive:{name,data},password?}
 *                   | {id,type:'compress',files:[{path,data}],archiveName,format,level,password?,encryptHeaders}
 *   worker -> main: {id,type:'ready'|'progress'|'list-result'|'extract-result'|'compress-result'|'test-result'|'error',...}
 *
 * The engine is single-threaded: exactly one job runs at a time; messages that
 * arrive during init or while another job is running are queued in order.
 * Every job lives in /job<id>/in and /job<id>/out and is removed recursively
 * when the job finishes (success OR failure).
 *
 * Node-testable by contract: uses ONLY self.onmessage, self.postMessage,
 * importScripts, self.location, fetch, console and JS built-ins.
 */
'use strict';

(function () {
  var WASM_GLUE_PATH = './wasm/7zz.js';
  var WASM_BINARY_PATH = './wasm/7zz.wasm';
  var VALID_LEVELS = ['0', '1', '3', '5', '7', '9'];
  var RAW_TAIL_LINES = 60; // lines kept in 'raw' of test-result
  var ERROR_TAIL_LINES = 8; // output lines embedded in error messages

  // ---------------------------------------------------------------- state ---
  var Module = null; // emscripten Module, set once init resolves
  var initPromise = null; // in-flight/resolved init promise (reset on failure)
  var sawFirstMessage = false;
  var inbox = []; // messages received but not processed yet
  var pumping = false;
  var activeJobId = null; // job id whose output print()/printErr() route to
  var logLines = []; // output lines of the current callMain invocation

  // ------------------------------------------------------------- plumbing ---

  function post(msg, transfer) {
    if (transfer && transfer.length) self.postMessage(msg, transfer);
    else self.postMessage(msg);
  }

  function errText(e) {
    if (e === null || e === undefined) return 'Unknown error';
    if (typeof e === 'string') return e;
    if (typeof e.message === 'string' && e.message) return e.message;
    try {
      return String(e);
    } catch (ignored) {
      return 'Unknown error';
    }
  }

  // Convert an incoming binary payload (ArrayBuffer or any typed-array view,
  // possibly from another realm in the Node test harness) to a Uint8Array.
  function toU8(data) {
    if (data === null || data === undefined) {
      throw new Error('missing binary payload');
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return new Uint8Array(data); // ArrayBuffer (throws TypeError otherwise)
  }

  // Make an exactly-sized copy whose .buffer can go into a transfer list.
  function ownedCopy(bytes) {
    var copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy;
  }

  function baseName(p) {
    var s = String(p === null || p === undefined ? '' : p);
    s = s.replace(/\\/g, '/');
    var i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  // Basename safe to use as a single MEMFS file name (never empty, no NULs).
  function safeBaseName(p, fallback) {
    var s = baseName(p).replace(/\0/g, '');
    if (s === '' || s === '.' || s === '..') return fallback;
    return s;
  }

  // Normalize a caller-supplied relative path: '/' separators, no '.', no
  // leading '/', no escaping via '..', no empty segments. '' when unusable.
  function safeRelPath(p) {
    var s = String(p === null || p === undefined ? '' : p);
    s = s.replace(/\\/g, '/').replace(/\0/g, '');
    var segs = s.split('/');
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (out.length) out.pop();
        continue;
      }
      out.push(seg);
    }
    return out.join('/');
  }

  function writeFileDeep(FS, path, bytes) {
    var slash = path.lastIndexOf('/');
    if (slash > 0) FS.mkdirTree(path.slice(0, slash));
    FS.writeFile(path, bytes);
  }

  // Recursively delete a MEMFS path (no-op when it does not exist).
  function removeTree(FS, path) {
    var st;
    try {
      st = FS.stat(path);
    } catch (missing) {
      return;
    }
    if ((st.mode & 0o170000) === 0o040000) {
      var names = [];
      try {
        names = FS.readdir(path);
      } catch (unreadable) {
        names = [];
      }
      for (var i = 0; i < names.length; i++) {
        if (names[i] === '.' || names[i] === '..') continue;
        removeTree(FS, path + '/' + names[i]);
      }
      try {
        FS.rmdir(path);
      } catch (ignored) {}
    } else {
      try {
        FS.unlink(path);
      } catch (ignored) {}
    }
  }

  // Collect every regular file under absDir; rel paths are RELATIVE to absDir.
  function walkOutDir(FS, absDir, relPrefix, found) {
    var names;
    try {
      names = FS.readdir(absDir);
    } catch (unreadable) {
      return;
    }
    names = names.slice().sort();
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (name === '.' || name === '..') continue;
      var abs = absDir + '/' + name;
      var rel = relPrefix ? relPrefix + '/' + name : name;
      var st;
      try {
        st = FS.stat(abs);
      } catch (vanished) {
        continue;
      }
      var kind = st.mode & 0o170000;
      if (kind === 0o040000) walkOutDir(FS, abs, rel, found);
      else if (kind === 0o100000) found.push({ abs: abs, rel: rel });
      // anything else (links, devices) is not produced by MEMFS jobs
    }
  }

  // ----------------------------------------------------------------- init ---

  function onEnginePrint(line) {
    var s = typeof line === 'string' ? line : String(line);
    if (s.length && s.charCodeAt(s.length - 1) === 13) s = s.slice(0, -1);
    logLines.push(s);
    if (activeJobId !== null) {
      post({ id: activeJobId, type: 'progress', line: s });
    }
  }

  function loadEngine() {
    if (typeof create7zip === 'undefined') {
      importScripts(WASM_GLUE_PATH);
    }
    if (typeof create7zip !== 'function') {
      return Promise.reject(
        new Error('create7zip factory is not defined after importScripts(' + WASM_GLUE_PATH + ')')
      );
    }
    var wasmUrl = new URL(WASM_BINARY_PATH, self.location.href).href;
    return fetch(wasmUrl)
      .then(function (resp) {
        if (!resp || typeof resp.arrayBuffer !== 'function') {
          throw new Error('fetch(' + wasmUrl + ') returned no readable response');
        }
        if (resp.ok === false) {
          throw new Error('fetch(' + wasmUrl + ') failed with status ' + resp.status);
        }
        return resp.arrayBuffer();
      })
      .then(function (wasmBuf) {
        return create7zip({
          wasmBinary: new Uint8Array(wasmBuf),
          noInitialRun: true,
          // Force immediate EOF on stdin: 7-Zip prompts for a password when an
          // encrypted archive is opened without one; under Node the default
          // TTY read can throw or block, and in a browser worker the default
          // would be a blocking prompt path. EOF makes 7z fail cleanly, which
          // run7z() reports as {type:'error'}.
          stdin: function () {
            return null;
          },
          print: onEnginePrint,
          printErr: onEnginePrint,
          locateFile: function (p) {
            return new URL('./wasm/' + p, self.location.href).href;
          },
        });
      })
      .then(function (mod) {
        if (!mod || !mod.FS || typeof mod.callMain !== 'function') {
          throw new Error('7-Zip engine initialized without FS/callMain');
        }
        Module = mod;
        return Module;
      });
  }

  function ensureInit() {
    if (!initPromise) {
      initPromise = loadEngine().catch(function (e) {
        initPromise = null; // allow the next message to retry
        throw e;
      });
    }
    return initPromise;
  }

  // --------------------------------------------------------------- engine ---

  // Run one 7z command. callMain can THROW instead of returning an exit code
  // (the wasm build leaks C++ exception pointers on some fatal errors, e.g.
  // "no such file"), so it is always wrapped; a throw counts as a fatal error.
  function run7z(args) {
    logLines = [];
    var rc = 0;
    var crashed = false;
    try {
      rc = Module.callMain(args);
      if (typeof rc !== 'number' || isNaN(rc)) rc = 0;
    } catch (e) {
      crashed = true;
      rc = 2;
      console.error('[7zip-web worker] callMain threw:', e);
    }
    return { rc: rc, crashed: crashed, lines: logLines.slice() };
  }

  function tailOf(lines) {
    return lines
      .filter(function (l) {
        return l.trim() !== '';
      })
      .slice(-ERROR_TAIL_LINES)
      .join(' | ');
  }

  function jobFailure(r, what) {
    var reason = r.crashed
      ? what + ': the 7-Zip engine aborted'
      : what + ': 7-Zip exit code ' + r.rc;
    var tail = tailOf(r.lines);
    return new Error(tail ? reason + ' — ' + tail : reason);
  }

  function passwordArgs(msg) {
    var pw = msg && msg.password;
    return typeof pw === 'string' && pw !== '' ? ['-p' + pw] : [];
  }

  // Run fn inside a fresh /job<id> tree; always cleans up; never rejects.
  function withJob(msg, fn) {
    var id = msg.id;
    var jobDir = '/job' + id;
    var inDir = jobDir + '/in';
    var outDir = jobDir + '/out';
    activeJobId = id;
    logLines = [];
    return Promise.resolve()
      .then(function () {
        Module.FS.mkdirTree(inDir);
        Module.FS.mkdirTree(outDir);
        return fn(id, jobDir, inDir, outDir, Module.FS);
      })
      .catch(function (e) {
        post({ id: id, type: 'error', message: errText(e) });
      })
      .then(function () {
        activeJobId = null;
        logLines = [];
        removeTree(Module.FS, jobDir);
      });
  }

  // ------------------------------------------------------------------ ops ---

  // Write the request's archive into inDir; returns its MEMFS path.
  function stageArchive(FS, inDir, archive) {
    if (!archive || typeof archive !== 'object') {
      throw new Error('request is missing the archive payload');
    }
    var arcPath = inDir + '/' + safeBaseName(archive.name, 'archive.bin');
    writeFileDeep(FS, arcPath, toU8(archive.data));
    return arcPath;
  }

  function runListJob(msg) {
    return withJob(msg, function (id, jobDir, inDir, outDir, FS) {
      var arcPath = stageArchive(FS, inDir, msg.archive);
      var args = ['l', '-slt', arcPath, '-bd'].concat(passwordArgs(msg));
      var r = run7z(args);
      if (r.crashed || r.rc >= 2) throw jobFailure(r, 'Listing archive');
      post({
        id: id,
        type: 'list-result',
        entries: parseSltListing(r.lines),
        raw: r.lines.join('\n'),
      });
    });
  }

  function runTestJob(msg) {
    return withJob(msg, function (id, jobDir, inDir, outDir, FS) {
      var arcPath = stageArchive(FS, inDir, msg.archive);
      var args = ['t', arcPath, '-bd'].concat(passwordArgs(msg));
      var r = run7z(args);
      post({
        id: id,
        type: 'test-result',
        ok: !r.crashed && (r.rc === 0 || r.rc === 1),
        raw: r.lines.slice(-RAW_TAIL_LINES).join('\n'),
      });
    });
  }

  function runExtractJob(msg) {
    return withJob(msg, function (id, jobDir, inDir, outDir, FS) {
      var arcPath = stageArchive(FS, inDir, msg.archive);
      var args = ['x', arcPath, '-o' + outDir, '-bd', '-y'].concat(passwordArgs(msg));
      var r = run7z(args);
      if (r.crashed || r.rc >= 2) throw jobFailure(r, 'Extracting archive');
      var found = [];
      walkOutDir(FS, outDir, '', found);
      var files = [];
      var transfer = [];
      for (var i = 0; i < found.length; i++) {
        var copy = ownedCopy(FS.readFile(found[i].abs));
        files.push({ path: found[i].rel, data: copy.buffer });
        transfer.push(copy.buffer);
      }
      post({ id: id, type: 'extract-result', files: files }, transfer);
    });
  }

  function runCompressJob(msg) {
    return withJob(msg, function (id, jobDir, inDir, outDir, FS) {
      var files = msg.files;
      if (!files || !files.length) throw new Error('compress: no input files');
      var format = msg.format === 'zip' ? 'zip' : '7z';
      var level = VALID_LEVELS.indexOf(String(msg.level)) >= 0 ? String(msg.level) : '5';

      var relPaths = [];
      for (var i = 0; i < files.length; i++) {
        var rel = safeRelPath(files[i] && files[i].path);
        if (!rel) throw new Error('compress: invalid input path in request');
        if (rel.charAt(0) === '-') {
          throw new Error('compress: paths starting with "-" are not supported: ' + rel);
        }
        if (relPaths.indexOf(rel) >= 0) {
          throw new Error('compress: duplicate input path: ' + rel);
        }
        writeFileDeep(FS, inDir + '/' + rel, toU8(files[i].data));
        relPaths.push(rel);
      }

      // The archive is created as a single deterministic output file inside
      // /job<id>/out (named after the caller-supplied archiveName) and read
      // straight back — no need to walk the output tree.
      var arcName = safeBaseName(msg.archiveName, 'archive.' + format);
      var outPath = outDir + '/' + arcName;

      var args = ['a', outPath].concat(relPaths, [
        '-bd',
        '-y',
        '-t' + format,
        '-mx' + level,
      ]);
      if (msg.password) {
        args.push('-p' + msg.password);
        // -mhe=on (encrypt headers) is 7z-format-only and needs a password.
        if (msg.encryptHeaders && format === '7z') args.push('-mhe=on');
      }

      // Run with cwd = inDir so entry names are exactly the caller's relative
      // paths; input paths must be relative for that naming to hold.
      FS.chdir(inDir);
      var r;
      try {
        r = run7z(args);
      } finally {
        FS.chdir('/');
      }
      if (r.crashed || r.rc >= 2) throw jobFailure(r, 'Creating archive');

      var bytes;
      try {
        bytes = FS.readFile(outPath);
      } catch (missing) {
        throw jobFailure(r, 'Creating archive (output file ' + outPath + ' missing)');
      }
      var copy = ownedCopy(bytes);
      post(
        {
          id: id,
          type: 'compress-result',
          archive: {
            name: typeof msg.archiveName === 'string' && msg.archiveName !== '' ? msg.archiveName : arcName,
            data: copy.buffer,
          },
        },
        [copy.buffer]
      );
    });
  }

  // -------------------------------------------------- l -slt output parsing ---

  // Parse `l -slt` output: discard everything before the first '----------'
  // line, then read blank-line-separated 'Key = Value' blocks, one per entry.
  function parseSltListing(lines) {
    var entries = [];
    var inBody = false;
    var cur = null;

    function flush() {
      if (cur && cur.Path !== undefined) {
        var size = 0;
        if (cur.Size !== undefined && cur.Size !== '') {
          var parsed = parseInt(cur.Size, 10);
          size = isNaN(parsed) ? 0 : parsed;
        }
        // Directory detection differs by format: zip/tar emit 'Folder = +',
        // while 7z emits NO Folder field and marks directories only via
        // 'Attributes = D ...' (files: 'A ...' or ' -rw-...'). Tar entries
        // may also end with '/'. Accept all three signals.
        var attrs = (cur.Attributes !== undefined ? cur.Attributes : '').replace(/^ +/, '');
        var isFolder =
          cur.Folder === '+' || attrs.charAt(0) === 'D' || /\/$/.test(cur.Path);
        // 'Modified' carries fractional seconds ('... 09:32:58.0000000');
        // keep the human-readable whole-second form.
        var modified = cur.Modified !== undefined ? cur.Modified.split('.')[0] : '';
        entries.push({
          path: cur.Path.replace(/\/$/, ''),
          size: size,
          modified: modified,
          method: cur.Method !== undefined ? cur.Method : '',
          encrypted: cur.Encrypted === '+',
          isFolder: isFolder,
        });
      }
      cur = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!inBody) {
        if (line === '----------') inBody = true;
        continue;
      }
      if (line.trim() === '') {
        flush();
        continue;
      }
      var eq = line.indexOf('=');
      if (eq < 0) continue;
      var key = line.slice(0, eq).trim();
      var val = line.slice(eq + 1);
      if (val.charAt(0) === ' ') val = val.slice(1);
      if (key === 'Path' && cur && cur.Path !== undefined) flush(); // defensive
      if (!cur) cur = {};
      cur[key] = val;
    }
    flush();
    return entries;
  }

  // ------------------------------------------------------- message routing ---

  function dispatch(msg, first) {
    return ensureInit().then(
      function () {
        // 'ready' answers an explicit init and the very first message (which
        // implicitly triggered init).
        if (msg.type === 'init' || first) {
          post({ id: msg.id, type: 'ready' });
        }
        try {
          switch (msg.type) {
            case 'init':
              return undefined;
            case 'list':
              return runListJob(msg);
            case 'extract':
              return runExtractJob(msg);
            case 'compress':
              return runCompressJob(msg);
            case 'test':
              return runTestJob(msg);
            default:
              post({
                id: msg.id,
                type: 'error',
                message: 'Unknown message type: ' + String(msg.type),
              });
              return undefined;
          }
        } catch (e) {
          post({ id: msg.id, type: 'error', message: errText(e) });
          return undefined;
        }
      },
      function (e) {
        post({ id: msg.id, type: 'error', message: 'Engine init failed: ' + errText(e) });
      }
    );
  }

  // Never rejects: every failure becomes an {type:'error'} reply, so the
  // sequential pump always continues.
  function processMessage(msg) {
    var first = !sawFirstMessage;
    sawFirstMessage = true;
    return dispatch(msg, first).catch(function (e) {
      try {
        post({ id: msg.id, type: 'error', message: errText(e) });
      } catch (postFailed) {
        console.error('[7zip-web worker] unable to report error:', e);
      }
    });
  }

  function loop() {
    if (inbox.length === 0) {
      pumping = false;
      return;
    }
    var msg = inbox.shift();
    // processMessage never rejects (it converts every failure into an
    // {type:'error'} reply), so the chain always continues.
    processMessage(msg).then(loop, loop);
  }

  function pump() {
    if (pumping) return;
    pumping = true;
    loop();
  }

  self.onmessage = function (ev) {
    var msg = ev && ev.data;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    inbox.push(msg);
    pump();
  };
})();
