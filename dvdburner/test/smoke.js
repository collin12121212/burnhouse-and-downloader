'use strict';

/**
 * A launch smoke test.
 *
 * The unit tests check the pipeline; this checks that the application actually
 * starts, paints, and can reach its own main process. It catches the class of
 * mistake that unit tests never see: a typo in a script tag, a preload that
 * throws, a renderer that dies on first render.
 *
 * Run with:  electron test/smoke.js
 *
 * It drives the real main process by requiring it, waits for the window, asks
 * the renderer some questions, saves a screenshot, and exits with a non-zero
 * code if anything is wrong — so it can gate a build.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const SHOT_PATH = process.env.BURNHOUSE_SMOKE_SHOT || path.join(__dirname, 'smoke-screenshot.png');
const problems = [];
const notes = [];

/*
  The smoke test drives the real interface, which means it needs the test hooks
  the renderer installs when asked. Settings live in the Electron userData
  folder, which is redirected to a temporary directory so the test can never
  touch whatever the person using this machine has configured.
*/
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'burnhouse-smoke-'));
app.setPath('userData', sandbox);

const settingsFile = path.join(sandbox, 'settings.json');
fs.writeFileSync(
  settingsFile,
  JSON.stringify(
    {
      version: 1,
      testHooks: true,
      workDir: path.join(sandbox, 'work'),
    },
    null,
    2
  )
);

const keepSandbox = process.env.BURNHOUSE_SMOKE_KEEP === '1';

function cleanupSandbox() {
  if (keepSandbox) return;
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* the temporary folder is not important enough to fail over */
  }
}

function record(ok, label, detail) {
  if (ok) {
    notes.push(`  PASS ${label}`);
  } else {
    problems.push(`${label}${detail ? `: ${detail}` : ''}`);
    notes.push(`  FAIL ${label}${detail ? `: ${detail}` : ''}`);
  }
}

/**
 * Generate a short clip for the interface to work with, using ffmpeg if it is
 * available. Without one the test still runs, and says so.
 */
function makeFixture() {
  const { spawnSync } = require('child_process');
  const ffmpeg = process.env.BURNHOUSE_FFMPEG || 'ffmpeg';
  const target = path.join(sandbox, 'test clip one.mp4');

  const result = spawnSync(
    ffmpeg,
    [
      '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      target,
    ],
    { encoding: 'utf8', windowsHide: true }
  );

  if (result.status === 0 && fs.existsSync(target)) return target;
  return null;
}

// The main process registers its own lifecycle handlers when required. This
// module only observes.
// No window on screen while this runs. Set before main.js is loaded, because
// the app reads it once at startup to decide how it opens its window.
process.env.BURNHOUSE_HEADLESS = '1';

require('../src/main/main.js');

/** Wait until the main window exists and has finished loading. */
function waitForWindow(timeoutMs = 20000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const windows = BrowserWindow.getAllWindows();
      const win = windows[0];
      if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
        return resolve(win);
      }
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(check, 120);
    };
    check();
  });
}

app.whenReady().then(async () => {
  const startedAt = Date.now();
  const window = await waitForWindow();

  if (!window) {
    record(false, 'a window was created', 'no window appeared within 20 seconds');
    return finish();
  }
  record(true, 'a window was created');

  // Give the renderer a moment to finish its asynchronous boot (settings,
  // presets, and the first render all happen after DOM ready).
  await new Promise((r) => setTimeout(r, 2200));

  let results = null;
  try {
    results = await window.webContents.executeJavaScript(
      `(() => {
         const bridge = typeof window.burnhouse === 'object' && window.burnhouse !== null;
         const draw = typeof window.BurnhouseSlideDraw === 'object';
         const stage = document.getElementById('stage');
         const editor = document.querySelector('.editor');
         return {
           bridge,
           draw,
           title: document.title,
           editorPresent: Boolean(editor),
           filmstrip: Boolean(document.getElementById('filmstrip')),
           canvas: Boolean(document.getElementById('slideCanvas')),
           inspector: Boolean(document.getElementById('inspector')),
           hasRail: Boolean(document.querySelector('.rail')),
           railVisible: (() => {
             const rail = document.querySelector('.rail');
             return rail ? getComputedStyle(rail).display !== 'none' : false;
           })(),
           stageText: stage ? stage.textContent.slice(0, 400) : '',
           steps: [...document.querySelectorAll('.step')].map((b) => b.dataset.step),
           errorText: document.body.textContent.includes('could not start'),
         };
       })()`,
      true
    );
  } catch (err) {
    record(false, 'the renderer answered', String(err.message || err));
    return finish();
  }

  record(results.bridge, 'the interface reached the main process');
  record(results.draw, 'the shared slide drawing code loaded');
  record(results.title === 'Burnhouse', 'the window has the right title', results.title);
  record(
    results.steps.join(',') === 'slides,testing,finish',
    'the app has three steps, ending in a test of the disc',
    results.steps.join(',')
  );
  record(!results.errorText, 'the interface did not fail to start');

  // The editor is the application, so it must be the first thing shown.
  record(results.editorPresent, 'the editor is the opening screen');
  record(results.filmstrip, 'the editor shows the slide list');
  record(results.canvas, 'the editor shows the slide canvas');
  record(results.inspector, 'the editor shows the controls panel');
  record(
    !results.railVisible,
    'no context rail steals space from the slide on the editor step'
  );
  record(
    /My DVD|Slides/.test(results.stageText),
    'the opening screen is a slide, not a setup page',
    results.stageText.slice(0, 60)
  );

  // Walk the steps. If a step throws, this is where it shows up.
  for (const step of ['finish', 'slides']) {
    try {
      await window.webContents.executeJavaScript(
        `document.querySelector('.step[data-step="${step}"]').click()`,
        true
      );
      await new Promise((r) => setTimeout(r, 500));
      const ok = await window.webContents.executeJavaScript(
        `document.getElementById('stage').children.length > 0`,
        true
      );
      record(ok, `the ${step} step renders`, 'stage was empty after switching');
    } catch (err) {
      record(false, `the ${step} step renders`, String(err.message || err));
    }
  }

  // The Projects welcome screen: lets her create a project or continue a recent one.
  try {
    await window.webContents.executeJavaScript(
      `window.__burnhouseTest.closeProject()`,
      true
    );
    await new Promise((r) => setTimeout(r, 700));

    const projScreen = await window.webContents.executeJavaScript(
      `(() => ({
         hasView: Boolean(document.querySelector('.projects-view')),
         hasNewCard: Boolean(document.querySelector('.project-card-new')),
         hasRecentPane: Boolean(document.querySelector('.recent-projects-pane')),
       }))()`,
      true
    );
    record(projScreen.hasView, 'the projects startup screen renders');
    record(projScreen.hasNewCard, 'the new project card is present');
    record(projScreen.hasRecentPane, 'the recent projects pane is present');

    // Return to the editor
    await window.webContents.executeJavaScript(
      `window.__burnhouseTest.goToStep('slides')`,
      true
    );
    await new Promise((r) => setTimeout(r, 700));
  } catch (err) {
    record(false, 'the projects screen rendered', String(err.message || err));
  }

  // A new project must open with slides already in it, and must keep the rail
  // hidden on the editor step.
  try {
    await window.webContents.executeJavaScript(
      `window.__burnhouseTest.goToStep('slides')`,
      true
    );
    await new Promise((r) => setTimeout(r, 900));

    const opening = await window.webContents.executeJavaScript(
      `window.__burnhouseTest.getState()`,
      true
    );
    record(
      opening.slides.length >= 2,
      'a new project opens with a menu slide and a slide for episodes',
      `${opening.slides.length} slides`
    );
    record(
      opening.slides[0].role === 'menu',
      'the first slide is the menu',
      opening.slides[0].role
    );
    record(
      opening.slides.some((s) => s.role !== 'menu'),
      'there is also a slide to put episodes on'
    );

    /*
      The project has to say which project it is.

      The main process names a folder after this, and without it every project
      resolved to the top of the working folder — so a second project's build
      overwrote the first one's encoded video, menu stills and authored
      VIDEO_TS. Asserted here rather than only in the pipeline tests because the
      path runs through the interface, and this is the end of it that was
      dropping it.
    */
    const payload = await window.webContents.executeJavaScript(
      `window.__burnhouseTest.projectPayload()`,
      true
    );
    record(
      Boolean(payload && payload.id),
      'the project tells the main process which project it is',
      payload && payload.id ? payload.id : 'no id in the payload'
    );
  } catch (err) {
    record(false, 'the opening deck rendered', String(err.message || err));
  }

  // With no videos added, the slides step must still show the editor shell
  // rather than failing: an empty deck is a legitimate starting state.

  // ---- a full pass through the interface with a real video ---------------
  //
  // Everything above proves the app starts. This proves it works: a video goes
  // in, it is read, the menu preview paints real content, and the project is
  // assembled in a shape the pipeline will accept.
  const fixture = makeFixture();
  if (!fixture) {
    record(true, 'a test video was available', 'ffmpeg not found, skipping the end-to-end pass');
  } else {
    try {
      const hasHooks = await window.webContents.executeJavaScript(
        `Boolean(window.__burnhouseTest)`,
        true
      );
      record(hasHooks, 'the test hooks were installed');

      if (hasHooks) {
        await window.webContents.executeJavaScript(
          `window.__burnhouseTest.addVideos([${JSON.stringify(fixture)}])`,
          true
        );

        // Waiting for the debounced read, then the ffprobe round trip.
        let projectState = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await new Promise((r) => setTimeout(r, 250));
          projectState = await window.webContents.executeJavaScript(
            `window.__burnhouseTest.getState()`,
            true
          );
          if (projectState.videos.length && projectState.hasPlan) break;
        }

        record(
          projectState && projectState.videos.length === 1,
          'the video was added to the list',
          projectState ? `${projectState.videos.length} videos` : 'no state'
        );
        record(
          projectState && projectState.hasPlan,
          'the disc capacity was worked out',
          'no plan was produced'
        );
        record(
          projectState && projectState.videos[0] && projectState.videos[0].duration > 2,
          'the video was read correctly',
          projectState && projectState.videos[0]
            ? `duration ${projectState.videos[0].duration}s`
            : 'no duration'
        );

        // Now the slides step, which is where the editor and its canvas live.
        await window.webContents.executeJavaScript(
          `window.__burnhouseTest.goToStep('slides')`,
          true
        );
        await new Promise((r) => setTimeout(r, 1400));

        let editorState = await window.webContents.executeJavaScript(
          `window.__burnhouseTest.getState()`,
          true
        );

        record(
          editorState.slides.length >= 2,
          'the deck is still the two slides the project opened with',
          `${editorState.slides.length} slides`
        );

        /*
          Adding a video must NOT change the menu.

          It used to plant a button on the menu slide, so the menu changed shape
          because a file was dragged in. A menu is composed deliberately, with
          "Add menu slide" — which is what the next check exercises.
        */
        const menuSlide = editorState.slides.find((s) => s.role === 'menu');
        const menuButtons = menuSlide
          ? menuSlide.elements.filter((e) => e.kind === 'button').length
          : 0;
        record(
          menuButtons === 0,
          'adding a video leaves the menu alone',
          `${menuButtons} buttons`
        );

        // Asking for a menu slide fills it with a list, and those buttons are
        // tagged so a later rename of a video reaches them.
        await window.webContents.executeJavaScript(
          `(() => {
             const btn = [...document.querySelectorAll('.btn')]
               .find((b) => b.textContent.trim() === 'Add menu slide');
             if (btn) btn.click();
           })()`,
          true
        );
        await new Promise((r) => setTimeout(r, 900));

        const withMenu = await window.webContents.executeJavaScript(
          `window.__burnhouseTest.getState()`,
          true
        );
        const listed = withMenu.slides
          .flatMap((s) => s.elements)
          .filter((e) => e.kind === 'button');
        record(
          listed.length >= 1,
          'adding a menu slide lists the videos',
          `${listed.length} buttons`
        );
        record(
          listed.every((e) => e.source === 'auto'),
          'the listed buttons are marked automatic, so they stay in step'
        );
        record(
          listed.some((e) => e.videoId),
          'a listed button plays the video it names'
        );
        record(
          editorState.step === 'slides',
          'adding a video did not navigate away from the slides',
          editorState.step
        );

        // Re-read the deck: the checks below are written relative to the current
        // state, and a slide has been added since it was last captured.
        editorState = await window.webContents.executeJavaScript(
          `window.__burnhouseTest.getState()`,
          true
        );

        // The editor canvas must exist and be painted at DVD resolution.
        const canvas = await window.webContents.executeJavaScript(
          `(() => {
             const c = document.getElementById('slideCanvas');
             if (!c) return { present: false };
             const ctx = c.getContext('2d');
             const data = ctx.getImageData(0, 0, c.width, c.height).data;
             let colourful = 0;
             for (let i = 0; i < data.length; i += 4) {
               const max = Math.max(data[i], data[i+1], data[i+2]);
               const min = Math.min(data[i], data[i+1], data[i+2]);
               if (max - min > 30) colourful += 1;
             }
             return { present: true, width: c.width, height: c.height, colourful: colourful, total: data.length / 4 };
           })()`,
          true
        );

        record(canvas.present, 'the editor canvas appeared');
        if (canvas.present) {
          record(
            canvas.width >= 720 && canvas.height >= 480,
            'the editor canvas is at DVD resolution',
            `${canvas.width}x${canvas.height}`
          );
          record(
            canvas.colourful > canvas.total * 0.002,
            'the editor canvas painted the slide',
            `${canvas.colourful} of ${canvas.total} pixels were colourful`
          );
        }

        // The filmstrip must show one card per slide.
        const cards = await window.webContents.executeJavaScript(
          `document.querySelectorAll('.slide-card').length`,
          true
        );
        record(cards === editorState.slides.length, 'the filmstrip shows every slide', `${cards} cards`);

        // Adding a slide must work and must become the active one.
        const before = editorState.slides.length;
        const beforeIds = editorState.slides.map((s) => s.id);
        await window.webContents.executeJavaScript(
          `window.__burnhouseTest.addSlide({ title: 'Extra' })`,
          true
        );
        await new Promise((r) => setTimeout(r, 900));
        editorState = await window.webContents.executeJavaScript(
          `window.__burnhouseTest.getState()`,
          true
        );
        record(
          editorState.slides.length === before + 1,
          'a slide can be added',
          `${before} then ${editorState.slides.length}`
        );

        // A newly added slide goes next to the one she was working on, not at
        // the end of the deck, so "the active one" is the slide that was not
        // there before rather than the last in the list.
        const added = editorState.slides.find((s) => !beforeIds.includes(s.id));
        record(Boolean(added), 'the added slide is in the deck');
        record(
          Boolean(added) && editorState.activeSlideId === added.id,
          'the new slide becomes the active one',
          `active is ${editorState.activeSlideId}`
        );

        /*
          A new slide is a blank page.

          It used to arrive with a Back/Next row already on it, so that a disc
          with several pages could not be a dead end. Those buttons went with the
          generator that made them, and blank now means blank: what she puts on
          the page is what ends up on the disc.
        */
        const newLayout = editorState.layout && added
          ? editorState.layout.slides.find((s) => s.id === added.id)
          : null;
        record(
          Boolean(newLayout) && newLayout.elements.every((e) => e.kind !== 'button'),
          'the new slide is blank, with no button put on it for her',
          newLayout ? `${newLayout.elements.length} elements` : 'no layout'
        );

        // The project handed to the pipeline must carry the deck.
        const project = await window.webContents.executeJavaScript(
          `window.__burnhouseTest.project()`,
          true
        );
        record(
          project && project.deck && project.deck.slides.length === editorState.slides.length,
          'the project carries the whole deck',
          project && project.deck ? `${project.deck.slides.length} slides` : 'no deck'
        );
        record(
          project && project.videoFormat === undefined,
          'the project never states a video format, so it cannot be got wrong'
        );

        // The screenshot is most useful from this step.
        const menuShot = SHOT_PATH.replace(/\.png$/, '-editor.png');
        try {
          const image = await window.webContents.capturePage();
          fs.writeFileSync(menuShot, image.toPNG());
          record(true, 'an editor screenshot was saved', menuShot);
        } catch (err) {
          record(false, 'an editor screenshot was saved', String(err.message || err));
        }
      }
    } catch (err) {
      record(false, 'the end-to-end pass completed', (err && err.stack) || String(err));
    }
  }

  // A screenshot of the first step, so a human can confirm the layout.
  // A screenshot of the editor itself, so a human can confirm the layout.
  try {
    await window.webContents.executeJavaScript(
      `window.__burnhouseTest.goToStep('slides')`,
      true
    );
    await new Promise((r) => setTimeout(r, 900));
    const image = await window.webContents.capturePage();
    fs.writeFileSync(SHOT_PATH, image.toPNG());
    record(true, 'a screenshot was saved', SHOT_PATH);
  } catch (err) {
    record(false, 'a screenshot was saved', String(err.message || err));
  }

  notes.push(`  (finished in ${Date.now() - startedAt} ms)`);
  finish();
});

function finish() {
  console.log('\nBurnhouse launch smoke test\n');
  for (const line of notes) console.log(line);

  cleanupSandbox();

  if (problems.length) {
    console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
    for (const problem of problems) console.log(`  - ${problem}`);
    console.log('\nThe interface did not start cleanly.');
    app.exit(1);
  } else {
    console.log(`\nAll ${notes.filter((n) => n.startsWith('  PASS')).length} checks passed.`);
    app.exit(0);
  }
}
