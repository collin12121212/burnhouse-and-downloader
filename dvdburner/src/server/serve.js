'use strict';

/**
 * The local sharing server.
 *
 * This exists for one practical reason: getting a large video file or a built
 * .dmg from one computer to another on the same network, without a cloud
 * account, a USB stick, or a cable.
 *
 * It is deliberately small and deliberately local:
 *
 *   - It binds to the local network only and is never exposed to the internet.
 *   - It only ever serves files from two directories: the working folder and
 *     the built application folder. A request cannot name a path outside them,
 *     because every path is resolved and then checked against those roots.
 *   - It is off unless the user turns it on, and it says so plainly while it
 *     is running.
 *
 * The upload endpoint streams to disk rather than buffering in memory, because
 * a DVD's worth of video will not fit in memory and a naive implementation
 * would fall over on exactly the files this app is for.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');

const UPLOAD_DIR_NAME = 'Incoming';

function startServer({ port = 8137, workDir, distDir, onLog = () => {} }) {
  return new Promise((resolve, reject) => {
    const uploadDir = path.join(workDir, UPLOAD_DIR_NAME);
    fs.mkdirSync(uploadDir, { recursive: true });

    // The only two directories this server will ever read from.
    const roots = [workDir, distDir].filter(Boolean);

    // The port is not known until the socket is bound, but the address list is
    // needed by the request handler, so it is computed once here and refreshed
    // if the port turns out to differ (which happens when port 0 is requested).
    let addresses = localAddresses(port);

    const server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        onLog(`request failed: ${err.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) });
        else res.end();
      });
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        return reject(
          new Error(
            `Port ${port} is already in use. Close whatever is using it, or choose a ` +
              `different port in Setup.`
          )
        );
      }
      reject(err);
    });

    server.listen(port, '0.0.0.0', () => {
      const bound = server.address();
      const actualPort = bound && typeof bound === 'object' ? bound.port : port;
      addresses = localAddresses(actualPort);
      onLog(`sharing on port ${actualPort}`);
      resolve({
        port: actualPort,
        server,
        info: () => ({
          running: true,
          port: actualPort,
          addresses,
          uploadDir,
          downloads: listDownloads(distDir),
          primaries: addresses.filter((a) => a.primary).map((a) => a.url),
        }),
        stop: () =>
          new Promise((done) => {
            server.close(() => {
              onLog('sharing stopped');
              done();
            });
            // In-flight keep-alive connections would otherwise hold the port
            // open after the user has asked for it to stop.
            server.closeAllConnections?.();
          }),
      });
    });

    // ---------------------------------------------------------------------
    // Routing
    // ---------------------------------------------------------------------

    async function handle(req, res) {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const route = url.pathname;

      // The interface is a single page; keep the routes flat and obvious.
      if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
        return sendHtml(res, page(addresses, listDownloads(distDir)));
      }

      if (req.method === 'GET' && route === '/api/state') {
        return sendJson(res, 200, {
          port,
          addresses,
          uploadDir,
          downloads: listDownloads(distDir),
          incoming: listIncoming(uploadDir),
          platform: process.platform,
        });
      }

      if (req.method === 'GET' && route === '/api/downloads') {
        return sendJson(res, 200, { downloads: listDownloads(distDir) });
      }

      if (req.method === 'GET' && route === '/api/incoming') {
        return sendJson(res, 200, { incoming: listIncoming(uploadDir) });
      }

      // Download a built app or an incoming file.
      if (req.method === 'GET' && route === '/download') {
        const name = url.searchParams.get('name') || '';
        const filePath = resolveWithin(distDir, name) || resolveWithin(uploadDir, name);
        if (!filePath) return sendJson(res, 404, { error: 'No such file.' });
        return sendFile(res, filePath, req);
      }

      // Upload a video from the other computer.
      if (req.method === 'POST' && route === '/upload') {
        return receiveUpload(req, res, uploadDir, url);
      }

      if (req.method === 'DELETE' && route === '/upload') {
        const name = url.searchParams.get('name') || '';
        const filePath = resolveWithin(uploadDir, name);
        if (!filePath) return sendJson(res, 404, { error: 'No such file.' });
        fs.rmSync(filePath, { force: true });
        return sendJson(res, 200, { removed: true });
      }

      return sendJson(res, 404, { error: 'Not found.' });
    }

    /**
     * Receive one uploaded file.
     *
     * Streamed straight to disk. A `?name=` parameter names the destination;
     * when it is absent, a raw body is still accepted and named from the
     * content-disposition header if present. Duplicate names get a numeric
     * suffix rather than overwriting whatever is already there, because losing
     * a file that was already on the machine would be unforgivable.
     */
    function receiveUpload(req, res, destDir, url) {
      const headerName = req.headers['x-filename'];
      let name = url.searchParams.get('name') || headerName || 'upload.bin';

      // Take only the final path component. A name like `../../etc/passwd`
      // must not be able to escape the upload folder.
      name = path.basename(String(name)).replace(/[\u0000-\u001f]/g, '').trim();
      if (!name || name === '.' || name === '..') name = 'upload.bin';

      const destination = uniquePath(destDir, name);
      const out = fs.createWriteStream(destination);

      let received = 0;
      let aborted = false;

      req.on('data', (chunk) => {
        received += chunk.length;
        // A ceiling so a runaway client cannot fill the disk unnoticed. This is
        // far above any single video.
        if (received > 32 * 1024 * 1024 * 1024) {
          aborted = true;
          out.destroy();
          req.destroy();
          res.statusCode = 413;
          res.end();
        }
      });

      req.pipe(out);

      out.on('error', (err) => {
        onLog(`upload failed: ${err.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'Could not write the file.' });
      });

      out.on('finish', () => {
        if (aborted) return;
        const finalName = path.basename(destination);
        onLog(`received ${finalName} (${received} bytes)`);
        sendJson(res, 200, { received: true, name: finalName, bytes: received });
      });

      req.on('aborted', () => {
        aborted = true;
        out.destroy();
        // A cancelled upload leaves a partial file; remove it rather than
        // leaving something that looks complete.
        fs.rmSync(destination, { force: true });
        onLog('upload cancelled');
      });
    }

    function sendHtml(res, markup) {
      const body = Buffer.from(markup, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(body);
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Serve a file, with byte-range support.
 *
 * Ranges matter here: without them a browser cannot resume a large download,
 * and a .dmg of a couple of hundred megabytes over a flaky connection would
 * have to start over.
 */
function sendFile(res, filePath, req) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return sendJson(res, 404, { error: 'No such file.' });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: 'Not a file.' });

  const type = contentType(filePath);
  const range = req.headers.range;

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (start <= end && start < stat.size) {
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`,
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`,
  });
  fs.createReadStream(filePath).pipe(res);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.dmg') return 'application/x-apple-diskimage';
  if (ext === '.zip') return 'application/zip';
  if (ext === '.iso') return 'application/x-iso9660-image';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

/**
 * Resolve `name` inside `root`, or return null.
 *
 * This is the whole path-traversal defence and it is one check: resolve the
 * path, then confirm the result is still inside the root. Anything that climbs
 * out is refused.
 */
function resolveWithin(root, name) {
  if (!root || !name) return null;
  const safe = path.basename(String(name));
  if (!safe || safe === '.' || safe === '..') return null;
  const full = path.resolve(root, safe);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;
  return full;
}

/** An unused path in `dir`, appending ` 2`, ` 3`, ... before the extension. */
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let counter = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} ${counter}${ext}`);
    counter += 1;
    if (counter > 999) {
      // Give up on pretty names rather than looping forever.
      return path.join(dir, `${stem}-${Date.now()}${ext}`);
    }
  }
  return candidate;
}

function listDownloads(distDir) {
  if (!distDir) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(distDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => /\.(dmg|zip|iso|pkg)$/i.test(f))
    .map((f) => {
      const full = path.join(distDir, f);
      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(full).size;
      } catch {
        /* reported as zero */
      }
      return { name: f, sizeBytes, url: `/download?name=${encodeURIComponent(f)}` };
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
}

function listIncoming(uploadDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(uploadDir);
  } catch {
    return [];
  }
  return entries
    .map((f) => {
      const full = path.join(uploadDir, f);
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch {
        return null;
      }
      if (!stat || !stat.isFile()) return null;
      return {
        name: f,
        sizeBytes: stat.size,
        modified: stat.mtime.toISOString(),
        url: `/download?name=${encodeURIComponent(f)}`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Every usable IPv4 address on this machine, with the likely ones marked. */
function localAddresses(port) {
  const result = [];
  const interfaces = os.networkInterfaces();

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;

      // Link-local addresses (169.254.x.x) mean no DHCP lease, so they cannot
      // reach anything useful.
      const linkLocal = address.address.startsWith('169.254.');
      const privateRange =
        address.address.startsWith('192.168.') ||
        address.address.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(address.address);

      result.push({
        interface: name,
        address: address.address,
        url: `http://${address.address}:${port}`,
        primary: privateRange && !linkLocal,
        linkLocal,
        label: describeInterface(name),
      });
    }
  }

  // Private, routable addresses first: those are the ones worth typing in.
  return result.sort((a, b) => Number(b.primary) - Number(a.primary));
}

function describeInterface(name) {
  const lower = String(name).toLowerCase();
  if (/^en0|wi-?fi|wlan|wireless/.test(lower)) return 'Wi-Fi';
  if (/^en\d|ethernet|eth/.test(lower)) return 'Ethernet';
  if (/bridge|utun|tun|tap|vpn/.test(lower)) return 'Virtual network';
  return name;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function page(addresses, downloads) {
  const primary = addresses.find((a) => a.primary) || addresses[0] || { url: 'http://localhost' };
  const others = addresses.filter((a) => a !== primary).filter((a) => !a.linkLocal);

  // Built inline, with no external requests of any kind, so this page works on
  // a machine with no internet access.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Burnhouse \u2014 File Sharing</title>
<style>
  :root {
    --ink: #1b1a18; --raised: #232120; --panel: #2a2725; --line: #3a3632;
    --paper: #f3ede2; --muted: #8d8579; --dim: #6d675e; --amber: #d9a353;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--ink); color: var(--paper); font-family: var(--sans);
    font-size: 15px; line-height: 1.55; padding: 40px 22px; -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 620px; margin: 0 auto; }
  h1 { font-size: 22px; font-weight: 600; margin-bottom: 6px; }
  .lede { color: var(--muted); margin-bottom: 28px; }
  .card { background: var(--raised); border: 1px solid var(--line); border-radius: 10px; padding: 20px; margin-bottom: 18px; }
  h2 { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
  .note { color: var(--dim); font-size: 13px; margin-bottom: 16px; }
  .drop {
    border: 1px dashed var(--line); border-radius: 8px; padding: 30px 20px; text-align: center;
    background: #171614; transition: border-color .12s, background .12s;
  }
  .drop.over { border-color: var(--amber); background: rgba(217,163,83,.07); }
  .drop strong { display: block; font-size: 15px; font-weight: 500; margin-bottom: 4px; }
  .drop span { color: var(--dim); font-size: 13px; }
  input[type=file] { display: none; }
  button, .btn {
    appearance: none; border: 1px solid var(--line); background: var(--panel); color: var(--paper);
    font: inherit; font-size: 14px; padding: 8px 15px; border-radius: 6px; cursor: pointer;
    text-decoration: none; display: inline-block;
  }
  button:hover, .btn:hover { background: #322e2b; }
  .primary { background: var(--amber); border-color: var(--amber); color: #241d10; font-weight: 600; }
  .primary:hover { background: #eab96f; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid #302d2a; }
  .row:last-child { border-bottom: 0; }
  .row-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-size { color: var(--dim); font-size: 13px; white-space: nowrap; }
  .mono { font-family: var(--mono); font-size: 13px; }
  .addr { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; }
  .addr b { font-weight: 500; }
  a { color: var(--amber); }
  .progress { height: 6px; background: #171614; border: 1px solid var(--line); border-radius: 3px; overflow: hidden; margin-top: 12px; display: none; }
  .progress div { height: 100%; width: 0; background: var(--amber); transition: width .15s linear; }
  .log { margin-top: 12px; font-size: 13px; color: var(--muted); }
  .log div { padding: 3px 0; }
  .warn { color: var(--amber); }
  .err { color: #c4685c; }
  @media (max-width: 520px) { body { padding: 24px 14px; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>Burnhouse file sharing</h1>
  <p class="lede">Send videos to the computer running Burnhouse, or download the app.</p>

  <div class="card">
    <h2>Send videos to Burnhouse</h2>
    <p class="note">Files land in the Incoming folder on the other computer, ready to add to a disc.</p>

    <div class="drop" id="drop">
      <strong>Drag videos here</strong>
      <span>or</span>
      <div style="margin-top:12px">
        <button class="primary" id="choose" type="button">Choose Files</button>
      </div>
    </div>
    <input type="file" id="files" multiple>
    <div class="progress" id="progress"><div id="progressFill"></div></div>
    <div class="log" id="log"></div>
  </div>

  <div class="card">
    <h2>Download</h2>
    <p class="note">${downloads.length ? 'Built applications found on the other computer.' : 'Nothing built yet. When the Mac app is built it will appear here.'}</p>
    <div id="downloads">
      ${downloads.length
        ? downloads.map((d) => `<div class="row"><span class="row-name">${escapeHtml(d.name)}</span><span class="row-size">${human(d.sizeBytes)}</span><a class="btn" href="${d.url}">Download</a></div>`).join('')
        : '<div class="row"><span class="row-size">No files yet</span></div>'}
    </div>
  </div>

  <div class="card">
    <h2>Received files</h2>
    <p class="note">Anything sent to this computer.</p>
    <div id="incoming"><div class="row"><span class="row-size">Nothing received yet</span></div></div>
  </div>

  <div class="card">
    <h2>Addresses for this computer</h2>
    <p class="note">Use the first one on the other machine.</p>
    ${[primary, ...others]
      .filter(Boolean)
      .map(
        (a) =>
          `<div class="addr"><b>${escapeHtml(a.label || 'Network')}</b><span class="mono">${escapeHtml(a.url)}</span></div>`
      )
      .join('')}
  </div>
</div>

<script>
(function () {
  var drop = document.getElementById('drop');
  var input = document.getElementById('files');
  var choose = document.getElementById('choose');
  var progress = document.getElementById('progress');
  var fill = document.getElementById('progressFill');
  var log = document.getElementById('log');
  var queue = [];
  var active = false;

  function say(text, cls) {
    var line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = text;
    log.appendChild(line);
  }

  choose.addEventListener('click', function () { input.click(); });
  input.addEventListener('change', function () { enqueue(input.files); input.value = ''; });

  ['dragenter', 'dragover'].forEach(function (type) {
    drop.addEventListener(type, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    drop.addEventListener(type, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files) enqueue(e.dataTransfer.files);
  });

  function enqueue(fileList) {
    for (var i = 0; i < fileList.length; i++) queue.push(fileList[i]);
    pump();
  }

  function pump() {
    if (active || !queue.length) return;
    active = true;
    var file = queue.shift();
    upload(file, function () { active = false; pump(); });
  }

  function upload(file, done) {
    // XHR rather than fetch, because upload progress is not available with
    // fetch in older browsers and this page has to work in whatever browser is
    // already on the machine.
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload?name=' + encodeURIComponent(file.name));
    progress.style.display = 'block';
    fill.style.width = '0%';
    say('Sending ' + file.name + ' (' + human(file.size) + ')\\u2026');

    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) {
        var pct = Math.round((e.loaded / e.total) * 100);
        fill.style.width = pct + '%';
        if (pct === 100) say('Finishing\\u2026');
      }
    };

    xhr.onload = function () {
      progress.style.display = 'none';
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          say('Sent ' + data.name, '');
        } catch (err) { say('Sent ' + file.name, ''); }
        refreshIncoming();
      } else {
        say('Failed: ' + file.name + ' (server said ' + xhr.status + ')', 'err');
      }
      done();
    };

    xhr.onerror = function () {
      progress.style.display = 'none';
      say('Failed: ' + file.name + ' (connection lost)', 'err');
      done();
    };

    var form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  }

  function refreshIncoming() {
    fetch('/api/incoming').then(function (r) { return r.json(); }).then(function (data) {
      var box = document.getElementById('incoming');
      if (!data.incoming || !data.incoming.length) return;
      box.innerHTML = data.incoming.map(function (f) {
        return '<div class="row"><span class="row-name">' + escapeHtml(f.name) + '</span>' +
          '<span class="row-size">' + human(f.sizeBytes) + '</span>' +
          '<a class="btn" href="' + f.url + '">Download</a></div>';
      }).join('');
    }).catch(function () {});
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function human(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(0) + ' KB';
    return bytes + ' bytes';
  }

  refreshIncoming();
})();
</script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function human(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} bytes`;
}

module.exports = { startServer, localAddresses, resolveWithin, uniquePath };

// ---------------------------------------------------------------------------
// Standalone entry point: `npm run serve`
// ---------------------------------------------------------------------------

if (require.main === module) {
  const workDir = process.env.BURNHOUSE_WORK_DIR || path.join(os.homedir(), 'Burnhouse');
  const distDir = path.join(__dirname, '..', '..', 'dist');
  const port = Number(process.env.PORT) || 8137;

  startServer({
    port,
    workDir,
    distDir,
    onLog: (line) => console.log(`[share] ${line}`),
  })
    .then((instance) => {
      const info = instance.info();
      console.log('\nBurnhouse file sharing is running.\n');
      for (const address of info.addresses) {
        console.log(`  ${address.label.padEnd(16)} ${address.url}${address.primary ? '   <- use this one' : ''}`);
      }
      console.log(`\n  Incoming files: ${info.uploadDir}`);
      console.log('  Press Ctrl+C to stop.\n');
    })
    .catch((err) => {
      console.error(`Could not start: ${err.message}`);
      process.exit(1);
    });
}
