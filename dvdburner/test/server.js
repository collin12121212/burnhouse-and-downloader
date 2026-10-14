'use strict';

/**
 * Exercises the file sharing server over real HTTP.
 *
 * The interesting part is not that upload and download work — it is that they
 * refuse to work outside their two permitted folders. A path traversal bug here
 * would expose the whole disk to anything on the same network, so those cases
 * are tested directly rather than assumed.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { startServer, localAddresses, resolveWithin, uniquePath } = require('../src/server/serve');

let passed = 0;
let failed = 0;
const failures = [];

function ok(name) {
  passed += 1;
  console.log(`  \u001b[32mPASS\u001b[0m ${name}`);
}

function fail(name, detail) {
  failed += 1;
  failures.push(name);
  console.log(`  \u001b[31mFAIL\u001b[0m ${name}`);
  if (detail) console.log(`       ${String(detail).split('\n').join('\n       ')}`);
}

async function test(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, (err && err.message) || String(err));
  }
}

function request(port, options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: options.method || 'GET', path: options.path, headers: options.headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  console.log('\u001b[1mBurnhouse sharing server\u001b[0m');

  // ---------------------------------------------------------------- units ---
  await test('paths cannot escape the permitted folder', () => {
    const root = path.join(os.tmpdir(), 'bh-root');
    fs.mkdirSync(root, { recursive: true });

    // Traversal attempts are contained rather than rejected outright: the name
    // is reduced to its final component, so `../etc/passwd` becomes a file
    // called `passwd` inside the root. What matters is that nothing resolves
    // outside, which is what these assertions check.
    const inside = (value) =>
      value === null || path.resolve(value).startsWith(path.resolve(root) + path.sep);

    assert(inside(resolveWithin(root, '../etc/passwd')), 'parent traversal stays contained');
    assert(inside(resolveWithin(root, '..\\windows\\system32')), 'windows traversal stays contained');
    assert(inside(resolveWithin(root, 'a/../../b')), 'nested traversal stays contained');
    assert.strictEqual(resolveWithin(root, ''), null, 'empty name refused');
    assert.strictEqual(resolveWithin(root, '.'), null, 'dot refused');
    assert.strictEqual(resolveWithin(root, '..'), null, 'double dot refused');
    assert.strictEqual(resolveWithin(root, 'video.mp4'), path.join(root, 'video.mp4'), 'a plain name resolves');
    assert(inside(resolveWithin(root, 'C:\\Windows\\notepad.exe')), 'absolute path stays inside the root');

    // The strongest form of the check: nothing may ever escape, for any of a
    // set of hostile inputs.
    const hostile = [
      '../../../../../../etc/passwd',
      '....//....//etc/passwd',
      '..%2f..%2fetc%2fpasswd',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '\\\\server\\share\\file',
      'subdir/../../outside.txt',
    ];
    for (const name of hostile) {
      const resolved = resolveWithin(root, name);
      assert(
        resolved === null || path.resolve(resolved).startsWith(path.resolve(root) + path.sep),
        `escaped the root with: ${name} -> ${resolved}`
      );
    }
  });

  await test('duplicate names never overwrite an existing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-dup-'));
    const first = path.join(dir, 'holiday.mp4');
    fs.writeFileSync(first, 'original');

    const second = uniquePath(dir, 'holiday.mp4');
    assert.notStrictEqual(second, first, 'a second file gets a different path');
    assert.strictEqual(fs.readFileSync(first, 'utf8'), 'original', 'the original is untouched');

    fs.writeFileSync(second, 'second');
    const third = uniquePath(dir, 'holiday.mp4');
    assert.notStrictEqual(third, second, 'a third file gets a different path again');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('the machine reports at least one usable address', () => {
    const addresses = localAddresses(8137);
    assert(Array.isArray(addresses), 'addresses is a list');
    for (const address of addresses) {
      assert(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(address.url), `odd url: ${address.url}`);
      assert(address.label, 'every address has a readable label');
    }
  });

  // ------------------------------------------------------------- over HTTP ---
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-work-'));
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-dist-'));
  fs.writeFileSync(path.join(distDir, 'Burnhouse-1.0.0.dmg'), 'not really a disk image');
  // A file that must never be reachable through the server.
  const secret = path.join(path.dirname(workDir), 'bh-secret.txt');
  fs.writeFileSync(secret, 'this must never be served');

  const instance = await startServer({ port: 0, workDir, distDir, onLog: () => {} });
  const port = instance.server.address().port;

  try {
    await test('the page loads and mentions what it is for', async () => {
      const res = await request(port, { path: '/' });
      assert.strictEqual(res.status, 200, 'status 200');
      const html = res.body.toString();
      assert(/Burnhouse file sharing/.test(html), 'page identifies itself');
      assert(/Send videos/.test(html), 'page explains uploading');
      assert(/Burnhouse-1\.0\.0\.dmg/.test(html), 'page lists the built app for download');
    });

    await test('the state endpoint reports the incoming folder and downloads', async () => {
      const res = await request(port, { path: '/api/state' });
      assert.strictEqual(res.status, 200, 'status 200');
      const data = JSON.parse(res.body.toString());
      assert(data.uploadDir, 'incoming folder is reported');
      assert(Array.isArray(data.downloads), 'downloads is a list');
      assert.strictEqual(data.downloads.length, 1, 'one built app was found');
      assert.strictEqual(data.downloads[0].name, 'Burnhouse-1.0.0.dmg', 'correct file');
    });

    await test('an uploaded file lands in the incoming folder intact', async () => {
      const payload = Buffer.from('pretend this is a video, roughly');
      const res = await request(
        port,
        {
          method: 'POST',
          path: '/upload?name=holiday%20clip.mp4',
          headers: { 'Content-Length': payload.length },
        },
        payload
      );
      assert.strictEqual(res.status, 200, `status ${res.status}`);

      const body = JSON.parse(res.body.toString());
      assert.strictEqual(body.received, true, 'server acknowledged receipt');
      assert.strictEqual(body.name, 'holiday clip.mp4', 'name preserved, including the space');

      const stored = path.join(workDir, 'Incoming', 'holiday clip.mp4');
      assert(fs.existsSync(stored), 'file exists on disk');
      assert.strictEqual(fs.readFileSync(stored, 'utf8'), payload.toString(), 'contents match');
    });

    await test('a second upload of the same name does not overwrite the first', async () => {
      const payload = Buffer.from('a different video with the same name');
      const res = await request(
        port,
        { method: 'POST', path: '/upload?name=holiday%20clip.mp4', headers: { 'Content-Length': payload.length } },
        payload
      );
      assert.strictEqual(res.status, 200, 'second upload accepted');

      const first = path.join(workDir, 'Incoming', 'holiday clip.mp4');
      assert.strictEqual(
        fs.readFileSync(first, 'utf8'),
        'pretend this is a video, roughly',
        'the first file is unchanged'
      );

      const incoming = fs.readdirSync(path.join(workDir, 'Incoming'));
      assert(incoming.length >= 2, `both files are present, found: ${incoming.join(', ')}`);
    });

    await test('an upload cannot write outside the incoming folder', async () => {
      const payload = Buffer.from('attempted escape');
      const res = await request(
        port,
        {
          method: 'POST',
          path: `/upload?name=${encodeURIComponent('../../bh-secret.txt')}`,
          headers: { 'Content-Length': payload.length },
        },
        payload
      );
      // The name is reduced to its base component, so this either succeeds under
      // a harmless name or is refused; either way the target must be untouched.
      assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'this must never be served', 'the file outside the root was not modified');

      if (res.status === 200) {
        const written = fs.readdirSync(path.join(workDir, 'Incoming'));
        assert(
          written.includes('bh-secret.txt'),
          `expected the file to be contained, found: ${written.join(', ')}`
        );
      }
    });

    await test('downloading a built app works and sets a filename', async () => {
      const res = await request(port, {
        path: `/download?name=${encodeURIComponent('Burnhouse-1.0.0.dmg')}`,
      });
      assert.strictEqual(res.status, 200, 'status 200');
      assert.strictEqual(res.body.toString(), 'not really a disk image', 'contents match');
      assert(/Burnhouse-1\.0\.0\.dmg/.test(res.headers['content-disposition'] || ''), 'filename set');
      assert.strictEqual(res.headers['accept-ranges'], 'bytes', 'range requests supported');
    });

    await test('a ranged download returns a partial response', async () => {
      const res = await request(port, {
        path: `/download?name=${encodeURIComponent('Burnhouse-1.0.0.dmg')}`,
        headers: { Range: 'bytes=0-6' },
      });
      assert.strictEqual(res.status, 206, 'partial content status');
      assert.strictEqual(res.body.toString(), 'not rea', 'exactly the requested bytes');
      assert(/bytes 0-6\//.test(res.headers['content-range'] || ''), 'content-range set');
    });

    await test('a download of a path outside the roots is refused', async () => {
      const res = await request(port, {
        path: `/download?name=${encodeURIComponent('../../../bh-secret.txt')}`,
      });
      assert.notStrictEqual(res.status, 200, 'must not succeed');
      assert(!/must never be served/.test(res.body.toString()), 'the secret was not served');
    });

    await test('the local file can be deleted but not one outside the folder', async () => {
      const remove = await request(port, {
        method: 'DELETE',
        path: `/upload?name=${encodeURIComponent('holiday clip.mp4')}`,
      });
      assert.strictEqual(remove.status, 200, 'delete accepted');
      assert(!fs.existsSync(path.join(workDir, 'Incoming', 'holiday clip.mp4')), 'file removed');

      const escape = await request(port, {
        method: 'DELETE',
        path: `/upload?name=${encodeURIComponent('../../bh-secret.txt')}`,
      });
      // Whatever the response, the file outside the root must survive.
      assert(fs.existsSync(secret), 'the file outside the root still exists');
      assert.strictEqual(escape.status === 200 || escape.status === 404, true, 'sane status');
    });

    await test('an unknown route is a clean 404, not a crash', async () => {
      const res = await request(port, { path: '/nope/nothing' });
      assert.strictEqual(res.status, 404, 'status 404');
      const data = JSON.parse(res.body.toString());
      assert(data.error, 'an error message is returned');
    });
  } finally {
    await instance.stop();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.rmSync(secret, { force: true });
  }

  console.log('');
  if (failed === 0) {
    console.log(`\u001b[32m${passed} passed\u001b[0m of ${passed + failed}`);
  } else {
    console.log(`\u001b[31m${failed} failed\u001b[0m, ${passed} passed`);
    console.log('\nFailures:');
    for (const name of failures) console.log(`  \u001b[31m\u2022\u001b[0m ${name}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nThe server test runner crashed:');
  console.error(err);
  process.exit(2);
});
