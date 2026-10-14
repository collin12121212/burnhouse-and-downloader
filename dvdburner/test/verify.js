'use strict';

/**
 * Run every suite in one go, in the order that makes failures easiest to read.
 *
 * The Electron suites are separate processes because Electron cannot run twice
 * in one process, so they are spawned rather than required.
 *
 * Usage: npm run verify
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/** Find the Electron binary without depending on where npm happened to put it. */
function electronBinary() {
  try {
    // The `electron` package exports the path to its binary.
    return require('electron');
  } catch {
    const candidates = [
      path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
      path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
      path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
    ];
    return candidates.find((c) => fs.existsSync(c)) || null;
  }
}

const suites = [
  { name: 'Core pipeline', command: process.execPath, args: [path.join(ROOT, 'test', 'run.js')] },
  { name: 'Sharing server', command: process.execPath, args: [path.join(ROOT, 'test', 'server.js')] },
  { name: 'Menu rendering', command: null, args: [path.join(ROOT, 'test', 'menu.js')], electron: true },
  { name: 'Application launch', command: null, args: [path.join(ROOT, 'test', 'smoke.js')], electron: true },
];

const results = [];

for (const suite of suites) {
  let command = suite.command;
  if (suite.electron) {
    command = electronBinary();
    if (!command) {
      console.log(`\n\u001b[33mSKIP\u001b[0m ${suite.name} — Electron is not installed. Run: npm install`);
      results.push({ name: suite.name, status: 'skip' });
      continue;
    }
  }

  console.log(`\n\u001b[1m${'='.repeat(64)}\u001b[0m`);
  console.log(`\u001b[1m${suite.name}\u001b[0m`);
  console.log(`\u001b[1m${'='.repeat(64)}\u001b[0m`);

  const run = spawnSync(command, suite.args, {
    stdio: 'inherit',
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env },
  });

  const status = run.status === 0 ? 'pass' : 'fail';
  results.push({ name: suite.name, status, code: run.status });
}

console.log(`\n\u001b[1m${'='.repeat(64)}\u001b[0m`);
console.log('\u001b[1mSummary\u001b[0m');
console.log(`\u001b[1m${'='.repeat(64)}\u001b[0m`);

for (const result of results) {
  const mark =
    result.status === 'pass' ? '\u001b[32mPASS\u001b[0m' :
    result.status === 'skip' ? '\u001b[33mSKIP\u001b[0m' :
    '\u001b[31mFAIL\u001b[0m';
  const suffix = result.code !== undefined && result.code !== 0 ? `  (exit ${result.code})` : '';
  console.log(`  ${mark}  ${result.name}${suffix}`);
}

const failed = results.filter((r) => r.status === 'fail').length;
const skipped = results.filter((r) => r.status === 'skip').length;

console.log('');
if (failed) {
  console.log(`\u001b[31m${failed} suite${failed === 1 ? '' : 's'} failed.\u001b[0m`);
  process.exit(1);
}
console.log(
  `\u001b[32mAll suites passed.\u001b[0m` + (skipped ? ` (${skipped} skipped)` : '')
);
