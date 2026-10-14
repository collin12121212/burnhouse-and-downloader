'use strict';

/**
 * Checks the real first-run experience.
 *
 * Every other launch test sets `testHooks`, which deliberately opens the editor
 * so the tests can drive it. That means none of them prove what a person
 * actually sees on a fresh install — which is the projects page. This runs the
 * app with a clean profile and no test hooks, and reports the screen it lands
 * on.
 *
 * Run with:  npm run test:firstrun
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const OUT = path.join(__dirname, 'screens');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'burnhouse-firstrun-'));

// A genuinely clean profile: no saved settings, no saved projects, and
// crucially no test hooks.
app.setPath('userData', sandbox);

// No window on screen while this runs. Set before main.js is loaded, because
// the app reads it once at startup to decide how it opens its window.
process.env.BURNHOUSE_HEADLESS = '1';

require('../src/main/main.js');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    await settle(3000);

    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('No window was created.');
    win.setSize(1280, 820);
    await settle(1500);

    const screen = await win.webContents.executeJavaScript(
      `(() => ({
         hasProjectsView: Boolean(document.querySelector('.projects-view')),
         hasNewProjectCard: Boolean(document.querySelector('.project-card-new')),
         hasRecentPane: Boolean(document.querySelector('.recent-projects-pane')),
         hasStepsNav: (() => {
           const nav = document.getElementById('steps');
           return nav ? getComputedStyle(nav).display !== 'none' : false;
         })(),
         hasBackToProjects: (() => {
           const b = document.getElementById('btnProjectsHome');
           return b ? getComputedStyle(b).display !== 'none' : false;
         })(),
         hasEditor: Boolean(document.querySelector('.editor')),
         headline: (document.querySelector('.projects-hero h1') || {}).textContent || '',
         bodyClasses: document.body.className,
       }))()`,
      true
    );

    const checks = [];
    const record = (ok, label, detail) => {
      checks.push({ ok, label, detail });
      console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
    };

    record(screen.hasProjectsView, 'a fresh install opens on the projects page');
    record(screen.hasNewProjectCard, 'the "start fresh" card is offered');
    record(screen.hasRecentPane, 'the recent projects pane is offered');
    record(!screen.hasEditor, 'the editor is not shown before a project is chosen');

    /*
      The window itself must never appear on screen.

      This suite runs the real application, not a mock, so if the headless flag
      were ignored a full-size window would appear on the machine of whoever ran
      it — mid-work, unexplained, and with to be closed by hand. Offscreen mode is
      also what makes the screenshot below worth having: a hidden window is never
      painted, so `capturePage()` on one can come back empty, and every check that
      reads pixels would quietly pass on a blank image.
    */
    record(
      !win.isVisible(),
      'the window is never shown on screen',
      `visible: ${win.isVisible()}`
    );
    record(
      win.webContents.isOffscreen(),
      'and it renders offscreen, so pixels can still be read back',
      `offscreen: ${win.webContents.isOffscreen()}`
    );

    const offscreenShot = await win.webContents.capturePage();
    record(
      offscreenShot && !offscreenShot.isEmpty() && offscreenShot.getSize().width > 0,
      'a screenshot of it has real content',
      offscreenShot ? `${offscreenShot.getSize().width}x${offscreenShot.getSize().height}` : 'no image'
    );
    record(
      !screen.hasStepsNav,
      'the Slides/Finish navigation is hidden until a project is open'
    );
    record(
      !screen.hasBackToProjects,
      'the "back to projects" button is hidden while already there'
    );
    record(
      /welcome/i.test(screen.headline),
      'the projects page greets the user',
      screen.headline.slice(0, 40)
    );

    fs.mkdirSync(OUT, { recursive: true });
    const image = await win.webContents.capturePage();
    const shot = path.join(OUT, 'first-run.png');
    fs.writeFileSync(shot, image.toPNG());
    console.log(`\n  wrote ${path.relative(process.cwd(), shot)}`);

    const failed = checks.filter((c) => !c.ok).length;
    console.log(failed ? `\n${failed} check(s) failed.` : `\nAll ${checks.length} checks passed.`);

    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* not important */
    }
    app.exit(failed ? 1 : 0);
  } catch (err) {
    console.error('\nFirst-run check failed:');
    console.error((err && err.stack) || String(err));
    app.exit(1);
  }
});
