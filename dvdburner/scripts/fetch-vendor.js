'use strict';

/**
 * Fetch the command line tools Burnhouse bundles.
 *
 * The macOS build gets its tools from Homebrew inside GitHub Actions, because
 * gathering them there is reliable and the resulting bundle is verified by the
 * build. This script exists for the other case: preparing a vendor folder by
 * hand, or on a machine where Homebrew is not available.
 *
 * It never invents a download. If it cannot fetch something, it says so
 * plainly rather than leaving a half-populated vendor folder that would fail
 * later with a confusing error.
 *
 * Usage: npm run vendor:fetch
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'bin');
const BIN_DIR = path.join(VENDOR);
const LIB_DIR = path.join(VENDOR, 'lib');

const TOOLS = ['ffmpeg', 'ffprobe', 'dvdauthor', 'spumux'];

function log(message) {
  console.log(message);
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function findOnPath(name) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (probe.status !== 0) return null;
  const first = String(probe.stdout || '').split('\n')[0].trim();
  return first && fs.existsSync(first) ? first : null;
}

function main() {
  log('Burnhouse — collecting the bundled tools\n');

  if (process.platform !== 'darwin') {
    log(`This script bundles macOS binaries, and this is ${process.platform}.`);
    log('');
    log('The macOS build collects its tools automatically in GitHub Actions,');
    log('which is the supported path. See .github/workflows/build-mac.yml.');
    log('');
    log('For local development on this machine, Burnhouse will use whatever');
    log('ffmpeg is already on your PATH, so nothing needs bundling here.');
    log('');
    log(`If you want to populate ${path.relative(ROOT, VENDOR)} anyway, run this on a Mac.`);
    process.exit(0);
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(LIB_DIR, { recursive: true });

  const found = {};
  const missing = [];

  for (const tool of TOOLS) {
    const located = findOnPath(tool);
    if (located) found[tool] = located;
    else missing.push(tool);
  }

  if (missing.length) {
    log('These tools were not found on this machine:');
    for (const tool of missing) log(`  - ${tool}`);
    log('');
    log('Install them with Homebrew, then run this again:');
    log('  brew install ffmpeg dvdauthor');
    fail('Nothing was copied.');
  }

  for (const [tool, located] of Object.entries(found)) {
    log(`  ${tool.padEnd(10)} ${located}`);
  }
  log('');
  log('Copying and relocating libraries…');

  const bundler = path.join(ROOT, 'scripts', 'bundle-deps.sh');
  if (!fs.existsSync(bundler)) fail(`Missing ${bundler}`);

  try {
    execFileSync('bash', [bundler, BIN_DIR, ...TOOLS.map((t) => found[t])], {
      stdio: 'inherit',
    });
  } catch (err) {
    fail(`Bundling failed: ${err.message}`);
  }

  log('');
  log('Bundled tools:');
  for (const file of fs.readdirSync(BIN_DIR)) {
    const full = path.join(BIN_DIR, file);
    if (fs.statSync(full).isFile()) {
      log(`  ${file}  ${(fs.statSync(full).size / 1e6).toFixed(1)} MB`);
    }
  }

  const libs = fs.readdirSync(LIB_DIR).filter((f) => f.endsWith('.dylib'));
  log(`\n${libs.length} libraries bundled.`);
  log('\nDone. The macOS build will pick these up automatically.');
}

main();
