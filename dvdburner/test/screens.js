'use strict';

/**
 * Capture screenshots of the interface for review.
 *
 * This produces pictures of the real application — the same windows, the same
 * drawing code — populated with several videos so the layout can be judged with
 * something in it rather than empty. It writes to test/screens/.
 *
 * Settings are redirected to a temporary folder, so running this can never
 * disturb whatever the person using this machine has set up.
 *
 * Run with:  npm run screens
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const OUT = path.join(__dirname, 'screens');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'burnhouse-screens-'));

app.setPath('userData', sandbox);
fs.writeFileSync(
  path.join(sandbox, 'settings.json'),
  JSON.stringify({ version: 1, testHooks: true, workDir: path.join(sandbox, 'work') })
);

// No window on screen while this runs. Set before main.js is loaded, because
// the app reads it once at startup to decide how it opens its window.
process.env.BURNHOUSE_HEADLESS = '1';

require('../src/main/main.js');

/** Make a few short clips of different shapes, so the disc looks real. */
function makeFixtures() {
  const specs = [
    { name: 'Episode 1 - The Arrival.mp4', size: '1280x720', rate: 30, seconds: 3, tone: 440 },
    { name: 'Episode 2 - The Long Walk.mov', size: '960x540', rate: 25, seconds: 3, tone: 520 },
    { name: 'Episode 3 - Garden Final.mkv', size: '640x480', rate: 30, seconds: 3, tone: 330 },
  ];

  const made = [];
  for (const spec of specs) {
    const target = path.join(sandbox, spec.name);
    const result = spawnSync(
      'ffmpeg',
      [
        '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `testsrc2=size=${spec.size}:rate=${spec.rate}:duration=${spec.seconds}`,
        '-f', 'lavfi', '-i', `sine=frequency=${spec.tone}:sample_rate=48000:duration=${spec.seconds}`,
        '-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest', target,
      ],
      { encoding: 'utf8', windowsHide: true }
    );
    if (result.status === 0 && fs.existsSync(target)) made.push(target);
  }
  return made;
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(win, name) {
  const image = await win.webContents.capturePage();
  const target = path.join(OUT, `${name}.png`);
  fs.writeFileSync(target, image.toPNG());
  console.log(`  wrote ${path.relative(process.cwd(), target)}`);
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.error('\nScreens run failed:');
    console.error((err && err.stack) || String(err));
    app.exit(1);
  }
});

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  await settle(2500);

  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.log('No window was created.');
    app.exit(1);
    return;
  }
  win.setSize(1280, 820);

  const fixtures = makeFixtures();
  console.log(`Made ${fixtures.length} test clips.`);

  // ---- 0. The projects welcome screen --------------------------------
  await win.webContents.executeJavaScript(`window.__burnhouseTest.closeProject()`, true);
  await settle(1500);
  await shoot(win, '0-projects-welcome');

  // Return to editor for the remaining screens
  await win.webContents.executeJavaScript(`window.__burnhouseTest.goToStep('slides')`, true);
  await settle(1500);

  // ---- 1. The editor as it opens, before any videos -------------------
  await shoot(win, '1-editor-empty');

  // ---- 2. Adding videos fills the menu slide automatically ------------
  await win.webContents.executeJavaScript(
    `window.__burnhouseTest.addVideos(${JSON.stringify(fixtures)})`,
    true
  );
  await settle(3500);
  await shoot(win, '2-editor-with-videos');

  // ---- 3. With a menu button selected, showing its controls -----------
  // Taken here, while the menu slide is still the active one, rather than
  // navigating back later.
  let state = await win.webContents.executeJavaScript(`window.__burnhouseTest.getState()`, true);
  const firstButton = state.slides[0]
    ? state.slides[0].elements.find((e) => e.kind === 'button')
    : null;
  if (firstButton) {
    await win.webContents.executeJavaScript(
      `window.__burnhouseTest.selectElement(${JSON.stringify(firstButton.id)})`,
      true
    );
    await settle(900);
    await shoot(win, '3-button-selected');
  }

  // ---- 3b. A video on its own episode slide ---------------------------
  // This is the thing she actually does: make a slide, put a video on it.
  // Captured so the tile's size, centring and the anamorphic preview can be
  // eyeballed rather than only asserted.
  const videoClick = await win.webContents.executeJavaScript(
    `(() => {
       try {
         const btn = [...document.querySelectorAll('.btn')]
           .find((b) => b.textContent.trim() === '+ Video');
         if (!btn) return 'no + Video button';
         btn.click();
         return 'clicked';
       } catch (err) {
         return 'ERR: ' + err.message;
       }
     })()`,
    true
  );
  console.log(`  + Video -> ${videoClick}`);
  await settle(2500);
  await shoot(win, '3b-video-on-slide');

  // ---- 4. A blank slide with a decorative heading ---------------------
  await win.webContents.executeJavaScript(`window.__burnhouseTest.addSlide({ title: 'About' })`, true);
  await settle(1400);
  state = await win.webContents.executeJavaScript(`window.__burnhouseTest.getState()`, true);
  const blank = state.slides.find((s) => s.title === 'About');
  if (blank) {
    await win.webContents.executeJavaScript(
      `window.__burnhouseTest.selectElement(null)`,
      true
    );
    await win.webContents.executeJavaScript(
      `window.__burnhouseTest.addElement('text', { x: 90, y: 160, width: 540, text: 'Filmed over one summer.' })`,
      true
    );
    await settle(1200);
    await shoot(win, '4-decorated-slide');
  }

  // ---- 6. The Testing step -------------------------------------------
  await win.webContents.executeJavaScript(`window.__burnhouseTest.goToStep('testing')`, true);
  await settle(2600);
  await shoot(win, '8-testing-step');

  // With the second button highlighted, so the moving highlight is visible.
  await win.webContents.executeJavaScript(`window.__burnhouseTest.simulateArrow('down')`, true);
  await settle(700);
  await shoot(win, '9-testing-highlight');

  // Escape must put the slides back, not leave an empty page.
  await win.webContents.executeJavaScript(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    true
  );
  await settle(1800);
  const afterEscape = await win.webContents.executeJavaScript(
    `(() => {
       const stage = document.getElementById('stage');
       return {
         step: (typeof state !== 'undefined') ? state.step : '?',
         stageChildren: stage ? stage.children.length : -1,
         hasEditor: Boolean(document.querySelector('.editor')),
         hasCanvas: Boolean(document.getElementById('slideCanvas')),
       };
     })()`,
    true
  );
  console.log(`  after Escape: ${JSON.stringify(afterEscape)}`);

  // ---- 7. Finish ------------------------------------------------------
  await win.webContents.executeJavaScript(`window.__burnhouseTest.goToStep('finish')`, true);
  await settle(1500);
  await shoot(win, '5-finish');

  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* not important */
  }

  console.log('\nScreenshots are in test/screens/');
  app.exit(0);
}
