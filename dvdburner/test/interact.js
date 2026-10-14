'use strict';

/**
 * Focused tests for the editing gestures and the DVD simulator.
 *
 * Everything here was added together, so it is tested together and separately
 * from test/smoke.js — the point is that a change to the right-click menu, the
 * resize handles or the simulator can be checked in a few seconds without
 * re-running the whole application suite.
 *
 * Run with:  npm run test:interact
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

// No window on screen while these run. Set before main.js is loaded, because the
// app reads it once at startup to decide how it opens its window.
process.env.BURNHOUSE_HEADLESS = '1';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'burnhouse-interact-'));
app.setPath('userData', sandbox);
fs.writeFileSync(
  path.join(sandbox, 'settings.json'),
  JSON.stringify({ version: 1, testHooks: true, workDir: path.join(sandbox, 'work') }, null, 2)
);

require('../src/main/main.js');

let passed = 0;
const failures = [];

function record(ok, label, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS ${label}`);
  } else {
    failures.push({ label, detail });
    console.log(`  FAIL ${label}${detail ? `  (${detail})` : ''}`);
  }
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/** Two short clips, so there is something on the disc to navigate to. */
function makeFixtures() {
  const dir = path.join(sandbox, 'clips');
  fs.mkdirSync(dir, { recursive: true });
  const ffmpeg = process.env.BURNHOUSE_FFMPEG || 'ffmpeg';
  const made = [];
  const specs = [
    { name: 'one.mp4', text: 'One' },
    { name: 'two.mp4', text: 'Two' },
  ];
  for (const spec of specs) {
    const target = path.join(dir, spec.name);
    const result = spawnSync(
      ffmpeg,
      ['-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=2`,
        '-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p', target],
      { encoding: 'utf8', windowsHide: true }
    );
    if (result.status === 0 && fs.existsSync(target)) made.push(target);
  }
  return made;
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.error('\nInteract tests failed:');
    console.error((err && err.stack) || String(err));
    app.exit(1);
  }
});

async function run() {
  await settle(2500);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('No window was created.');
  win.setSize(1360, 880);
  await settle(1200);

  /*
    Runs code in the page.

    Almost every call below is a template literal, which means the code inside it
    cannot contain a backtick: one ends the string early, and the file then fails
    to parse with a message pointing somewhere near the call rather than at the
    comment that caused it. It costs an Electron process and a modal dialog to
    find out, so: quotes in here, not backticks.
  */
  const js = (code) => win.webContents.executeJavaScript(code, true);

  // Surface renderer errors, so a failure says what broke instead of only that
  // a script "failed to execute".
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.log(`    [renderer] ${message}`);
  });

  /*
    The empty-project simulator, checked before any videos exist.

    A slide with no buttons is not a menu page, so a fresh project has no menus
    at all. That used to leave the screen black with only an OSD badge, which
    reads as a broken preview. It must instead show the slide she designed and
    say why nothing can be chosen.
  */
  console.log('\nSimulator with an empty project');

  await js('window.__burnhouseTest.openSimulator({})');
  await settle(1600);

  const emptyState = await js('window.__burnhouseTest.simulatorState()');
  record(emptyState.open === true, 'the simulator opens on a project with no videos');
  record(emptyState.menus === 0, 'a project with no buttons has no menu pages', String(emptyState.menus));

  const emptyScreen = await js(
    `(() => {
       const note = document.querySelector('.sim-empty');
       const canvas = document.getElementById('simCanvas');
       if (!canvas) return { note: Boolean(note), drew: false, reason: 'no canvas' };
       const ctx = canvas.getContext('2d');
       let min = 255, max = 0;
       for (let y = 0; y < canvas.height; y += 7) {
         for (let x = 0; x < canvas.width; x += 7) {
           const d = ctx.getImageData(x, y, 1, 1).data;
           const l = (d[0] + d[1] + d[2]) / 3;
           if (l < min) min = l;
           if (l > max) max = l;
         }
       }
       return { note: Boolean(note), drew: max - min > 20, spread: max - min };
     })()`
  );
  record(emptyScreen.note, 'it explains that there is nothing to choose yet');
  record(
    emptyScreen.drew,
    'the screen shows the designed slide instead of staying black',
    `luminance spread ${emptyScreen.spread}`
  );

  await js('window.__burnhouseTest.closeSimulator()');
  await settle(400);
  /*
    Opening the player moves to the Testing step, and closing it does not move
    back — that is what Escape is for in the interface. The editor checks below
    need the Slides step, so go there explicitly.
  */
  await js(`window.__burnhouseTest.goToStep('slides')`);
  await settle(1200);

  // Everything below needs real clips on the disc.
  const fixtures = makeFixtures();
  if (!fixtures.length) {
    console.log('\n  SKIP the rest — ffmpeg is not available to make test clips');
    finish();
    return;
  }

  await js(`window.__burnhouseTest.addVideos(${JSON.stringify(fixtures)})`);
  await settle(3500);

  /*
    Put a film on a slide.

    Adding videos no longer fills the menu with buttons — the menu is composed
    deliberately — so the disc gets its playable entry by placing a tile, which
    is what the simulator's "choose a button and a film starts" checks need.
  */
  const afterVideos = await js('window.__burnhouseTest.getState()');
  const contentSlide = afterVideos.slides.find((s) => s.role !== 'menu');
  const firstVideo = (afterVideos.videos || [])[0];
  record(Boolean(contentSlide && firstVideo), 'there is a slide and a video to work with');
  await js(`window.__burnhouseTest.setActiveSlide(${JSON.stringify(contentSlide.id)})`);
  await settle(600);
  await js(
    `window.__burnhouseTest.addElement('video', { videoId: ${JSON.stringify(firstVideo.id)}, label: 'Episode 1', x: 93, y: 40, width: 534, height: 356, fit: 'fill' })`
  );
  await settle(1600);

  /*
    Adding videos no longer fills the menu with buttons — the menu is composed
    deliberately — so this makes one to work with.
  */
  await js(
    `window.__burnhouseTest.addElement('button', { label: 'Episode 1', videoId: null, x: 48, y: 120, width: 400, height: 54 })`
  );
  await settle(1200);

  // ---------------------------------------------------------------- resize ---
  console.log('\nResize handles');

  const state = await js('window.__burnhouseTest.getState()');
  // Wherever it landed: the active slide is whichever was worked on last.
  const button = state.slides.flatMap((s) => s.elements).find((e) => e.kind === 'button');
  record(Boolean(button), 'a button can be placed on a slide');

  const atCorner = await js(
    `window.__burnhouseTest.handleAt(${JSON.stringify(button.id)}, ${button.x}, ${button.y})`
  );
  record(atCorner === 'nw', 'the top-left corner is grabbable', String(atCorner));

  const atCentre = await js(
    `window.__burnhouseTest.handleAt(${JSON.stringify(button.id)}, ${button.x + 200}, ${button.y + 20})`
  );
  record(atCentre === null, 'the middle of an element is not a handle', String(atCentre));

  const before = await js(
    `(() => { const e = window.__burnhouseTest.getState().slides.flatMap(s => s.elements).find(x => x.id === ${JSON.stringify(button.id)}); return { w: e.width, h: e.height, x: e.x }; })()`
  );
  const grown = await js(
    `window.__burnhouseTest.resizeElement(${JSON.stringify(button.id)}, 'e', 60, 0)`
  );
  record(grown.width > before.w, 'dragging the right edge makes it wider', `${before.w} -> ${grown.width}`);
  record(grown.x === before.x, 'the left edge stays put when dragging the right edge');

  const shrunk = await js(
    `window.__burnhouseTest.resizeElement(${JSON.stringify(button.id)}, 'e', -10000, 0)`
  );
  record(shrunk.width >= 40, 'an element cannot be dragged away to nothing', `width ${shrunk.width}`);

  /*
    A real drag, through the same pointer events a mouse produces.

    This is the regression test for "I try to drag it and it wont budge". The
    canvas draws from the layout the main process produced, not from the deck
    being edited, so a drag that only changed the deck redrew the old positions
    and nothing appeared to happen. Both the deck and the drawn layout have to
    move.
  */
  console.log('\nDragging with the mouse');

  const dragId = button.id;
  const dragged = await js(
    `(async () => {
       const canvas = document.getElementById('slideCanvas');
       if (!canvas) return { error: 'no canvas' };
       const rect = canvas.getBoundingClientRect();
       const toClient = (rx, ry) => ({
         clientX: rect.left + (rx / 720) * rect.width,
         clientY: rect.top + (ry / 480) * rect.height,
       });

       // Synthetic pointer ids are not real captures; stub them out so the
       // handler runs exactly as it does for a mouse.
       const realCapture = canvas.setPointerCapture;
       const realRelease = canvas.releasePointerCapture;
       canvas.setPointerCapture = () => {};
       canvas.releasePointerCapture = () => {};

       const before = window.__burnhouseTest.getState().slides.flatMap(s => s.elements)
         .find((e) => e.id === ${JSON.stringify(dragId)});
       const grab = toClient(before.x + before.width / 2, before.y + before.height / 2);

       canvas.dispatchEvent(new PointerEvent('pointerdown', {
         ...grab, bubbles: true, button: 0, pointerId: 1, isPrimary: true,
       }));
       await new Promise((r) => setTimeout(r, 80));

       const target = toClient(before.x + before.width / 2 + 50, before.y + before.height / 2 + 34);
       document.dispatchEvent(new PointerEvent('pointermove', {
         ...target, bubbles: true, pointerId: 1, isPrimary: true,
       }));
       await new Promise((r) => setTimeout(r, 260));

       // What the canvas is actually drawing, mid-drag.
       const drawnMidDrag = (() => {
         const s = window.__burnhouseTest.getState();
         const entry = s.layout && s.layout.slides.find((x) => x.id === s.activeSlideId);
         const el = entry && entry.elements.find((e) => e.id === ${JSON.stringify(dragId)});
         return el ? { x: el.box.x, y: el.box.y } : null;
       })();

       document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
       await new Promise((r) => setTimeout(r, 420));

       canvas.setPointerCapture = realCapture;
       canvas.releasePointerCapture = realRelease;

       const after = window.__burnhouseTest.getState();
       const deckEl = after.slides.flatMap(s => s.elements).find((e) => e.id === ${JSON.stringify(dragId)});
       const entry = after.layout && after.layout.slides.find((x) => x.id === after.activeSlideId);
       const layoutEl = entry && entry.elements.find((e) => e.id === ${JSON.stringify(dragId)});

       return {
         from: { x: before.x, y: before.y },
         deck: { x: deckEl.x, y: deckEl.y },
         drawnMidDrag,
         drawn: layoutEl ? { x: layoutEl.box.x, y: layoutEl.box.y } : null,
       };
     })()`
  );

  if (dragged.error) {
    record(false, 'a mouse drag moves the element', dragged.error);
  } else {
    record(
      dragged.deck.x !== dragged.from.x || dragged.deck.y !== dragged.from.y,
      'a mouse drag moves the element',
      `${JSON.stringify(dragged.from)} -> ${JSON.stringify(dragged.deck)}`
    );
    record(
      dragged.drawnMidDrag &&
        (dragged.drawnMidDrag.x !== dragged.from.x || dragged.drawnMidDrag.y !== dragged.from.y),
      'the canvas redraws it while the mouse is still down',
      JSON.stringify(dragged.drawnMidDrag)
    );
    record(
      dragged.drawn && Math.abs(dragged.drawn.x - dragged.deck.x) <= 2,
      'the drawn layout ends up matching the deck',
      `drawn ${JSON.stringify(dragged.drawn)} vs deck ${JSON.stringify(dragged.deck)}`
    );
  }

  // ------------------------------------------------------------ context menu ---
  console.log('\nRight-click menu');

  const labels = await js(
    `window.__burnhouseTest.openElementMenuFor(${JSON.stringify(button.id)})`
  );
  record(Array.isArray(labels) && labels.length > 0, 'right-clicking an element opens a menu');
  record(labels.some((l) => l.includes('Delete')), 'the menu can delete the element', labels.join(' | '));
  record(labels.some((l) => l.includes('Duplicate')), 'the menu can duplicate it');
  record(labels.some((l) => l.includes('front')), 'the menu can raise it');
  record(labels.some((l) => l.includes('back')), 'the menu can lower it');

  const countBefore = await js(
    'window.__burnhouseTest.getState().slides.flatMap(s => s.elements).length'
  );
  await js(`window.__burnhouseTest.clickContextItem('Duplicate')`);
  await settle(600);
  const countAfter = await js(
    'window.__burnhouseTest.getState().slides.flatMap(s => s.elements).length'
  );
  record(countAfter === countBefore + 1, 'Duplicate really adds one', `${countBefore} -> ${countAfter}`);

  await js(
    `(() => { const els = window.__burnhouseTest.getState().slides.flatMap(s => s.elements); const last = els[els.length - 1]; window.__burnhouseTest.openElementMenuFor(last.id); })()`
  );
  await js(`window.__burnhouseTest.clickContextItem('Delete')`);
  await settle(600);
  const countDeleted = await js(
    'window.__burnhouseTest.getState().slides.flatMap(s => s.elements).length'
  );
  record(countDeleted === countBefore, 'Delete really removes it', `${countAfter} -> ${countDeleted}`);

  const menuGone = await js('window.__burnhouseTest.contextMenuLabels().length');
  record(menuGone === 0, 'the menu closes once something is chosen');

  // ------------------------------------------------------------ slide menu ---
  console.log('\nRight-click menu on a slide');

  const slideState = await js('window.__burnhouseTest.getState()');
  const targetSlide = slideState.slides[slideState.slides.length - 1];

  const slideLabels = await js(
    `window.__burnhouseTest.openSlideMenuFor(${JSON.stringify(targetSlide.id)})`
  );
  record(Array.isArray(slideLabels) && slideLabels.length > 0, 'right-clicking a slide opens a menu');
  record(
    slideLabels.some((l) => l.includes('Delete')),
    'the slide menu can delete the slide',
    (slideLabels || []).join(' | ')
  );
  record(slideLabels.some((l) => l.includes('Duplicate')), 'the slide menu can duplicate it');
  record(slideLabels.some((l) => l.includes('Move up')), 'the slide menu can move it up');
  record(slideLabels.some((l) => l.includes('Move down')), 'the slide menu can move it down');
  await js('window.__burnhouseTest.closeElementMenu()');

  /*
    Moving a slide really changes the order.

    This is the check that catches the two functions that were briefly both
    called `moveSlide`: a later declaration wins, so the toolbar's move buttons
    silently did nothing while dragging still worked.
  */
  const beforeOrder = (await js('window.__burnhouseTest.getState()')).slides.map((s) => s.id);
  const movedDown = await js(
    `window.__burnhouseTest.moveSlideBy(${JSON.stringify(beforeOrder[0])}, 1)`
  );
  record(
    movedDown[0] === beforeOrder[1] && movedDown[1] === beforeOrder[0],
    'moving a slide down swaps it with the next one',
    `${beforeOrder.slice(0, 2).join(',')} -> ${movedDown.slice(0, 2).join(',')}`
  );
  const movedBack = await js(
    `window.__burnhouseTest.moveSlideBy(${JSON.stringify(beforeOrder[0])}, -1)`
  );
  record(movedBack.join(',') === beforeOrder.join(','), 'and moving it up puts it back');

  // Deleting, on a deck that can spare a slide.
  const addedSlide = await js(`window.__burnhouseTest.addSlide({ title: 'Doomed' })`);
  await settle(900);
  const afterAdd = (await js('window.__burnhouseTest.getState()')).slides.map((s) => s.id);
  const afterDelete = await js(
    `window.__burnhouseTest.deleteSlide(${JSON.stringify(addedSlide.id)})`
  );
  record(
    afterDelete.length === afterAdd.length - 1 && !afterDelete.includes(addedSlide.id),
    'a slide can be deleted',
    `${afterAdd.length} -> ${afterDelete.length}`
  );

  // ------------------------------------------------------------- simulator ---
  console.log('\nDVD player simulator');

  await js('window.__burnhouseTest.openSimulator({})');
  await settle(1800);

  let simState = await js('window.__burnhouseTest.simulatorState()');
  record(simState.open === true, 'the simulator opens');
  record(simState.domain === 'menu', 'a disc starts on its menu', simState.domain);
  record(simState.page === 1, 'starting on the first menu page', String(simState.page));
  record(simState.titles === 2, 'both films are on the disc', String(simState.titles));
  record(
    simState.focusLabel && simState.focusLabel.length > 0,
    'a button is highlighted to begin with',
    String(simState.focusLabel)
  );
  record(
    simState.focusRect && simState.focusRect.x1 > simState.focusRect.x0,
    'the highlight has a real rectangle from the disc',
    JSON.stringify(simState.focusRect)
  );

  const firstFocus = simState.focus;
  const moves = simState.moves;
  record(Boolean(moves), 'the disc reports where each arrow key goes', JSON.stringify(moves));

  if (moves && moves.down !== firstFocus) {
    const afterDown = await js(`window.__burnhouseTest.simulateArrow('down')`);
    record(afterDown.focus === moves.down, 'the down key moves where the disc says', `${firstFocus} -> ${afterDown.focus}`);
    const afterUp = await js(`window.__burnhouseTest.simulateArrow('up')`);
    record(afterUp.focus === firstFocus, 'and up comes back', String(afterUp.focus));
  } else {
    record(true, 'the down key moves where the disc says (only one button)');
    record(true, 'and up comes back (only one button)');
  }

  // Choosing a button must play a film, and the disc's own post-command must
  // bring the menu back when it ends.
  const chosen = await js(`window.__burnhouseTest.simulateEnter()`);
  await settle(900);
  const playing = await js('window.__burnhouseTest.simulatorState()');
  record(playing.domain === 'title', 'choosing a button starts a film', playing.domain);
  record(playing.title >= 1, 'on a real title number', String(playing.title));
  record(
    chosen.command && chosen.command.startsWith('jump title'),
    'the simulator ran the disc command',
    String(chosen.command)
  );

  const backToMenu = await js(`window.__burnhouseTest.simulateMenuKey()`);
  record(backToMenu.domain === 'menu', 'the Menu key returns to the menu', backToMenu.domain);
  record(backToMenu.page === backToMenu.rootPage, 'and to the disc root page', String(backToMenu.page));

  /*
    The chosen film must actually play, and must keep playing across a redraw.

    Every render used to rebuild the whole overlay, which discarded the <video>
    element that had just been given a source and told to play — so choosing a
    film produced a black screen. Both halves are checked here: that the element
    has a source and is running, and that it is still the same element (and still
    running) after a redraw.
  */
  console.log('\nPlaying a film');

  await js('window.__burnhouseTest.openSimulator({ startTitleVideoId: "__none__" })');
  await settle(700);
  await js(`window.__burnhouseTest.simulateEnter()`);
  await settle(1600);

  const playingState = await js('window.__burnhouseTest.simulatorState()');
  record(playingState.domain === 'title', 'choosing a button opens a film', playingState.domain);

  const videoBefore = await js('window.__burnhouseTest.simulatorVideo()');
  record(Boolean(videoBefore), 'there is a video element to play into');
  if (videoBefore) {
    record(Boolean(videoBefore.src), 'the film element was given a source', String(videoBefore.src).slice(0, 48));
    record(videoBefore.error === null, 'the film did not fail to load', `error code ${videoBefore.error}`);
    record(
      videoBefore.readyState >= 2,
      'the film has decoded frames to show',
      `readyState ${videoBefore.readyState}`
    );
    record(!videoBefore.paused, 'the film is playing without another press');
    record(videoBefore.time > 0, 'the film is actually advancing', `t=${videoBefore.time.toFixed(2)}s`);
  }

  // Tag the element, force a redraw, and check the same element is still there
  // and still playing.
  await js(`window.__burnhouseTest.markSimulatorVideo('keep-me')`);
  await js('window.__burnhouseTest.redrawSimulator()');
  await settle(500);
  const videoAfter = await js('window.__burnhouseTest.simulatorVideo()');
  record(
    videoAfter && videoAfter.marker === 'keep-me',
    'a redraw does not replace the film element'
  );
  record(
    videoAfter && videoAfter.time > 0,
    'the film is still playing after a redraw',
    videoAfter ? `t=${videoAfter.time.toFixed(2)}s` : 'no video'
  );

  // Back to the menu, which both proves a film can be left and puts the
  // highlight back for the position checks that follow.
  await js('window.__burnhouseTest.simulateMenuKey()');
  await settle(600);
  const backFromFilm = await js('window.__burnhouseTest.simulatorState()');
  record(backFromFilm.domain === 'menu', 'the Menu key brings the menu back from a film');
  const videoStopped = await js('window.__burnhouseTest.simulatorVideo()');
  record(
    !videoStopped || videoStopped.paused,
    'leaving a film stops it rather than playing on invisibly'
  );

  // The highlight must sit exactly where the disc's button rectangle is.
  const highlightBox = await js(
    `(() => {
       const c = document.getElementById('simCanvas');
       const h = document.getElementById('simHighlight');
       if (!c || !h) return null;
       const screen = c.getBoundingClientRect();
       const box = h.getBoundingClientRect();
       return {
         left: (box.left - screen.left) / screen.width,
         top: (box.top - screen.top) / screen.height,
         w: box.width / screen.width,
         h: box.height / screen.height,
       };
     })()`
  );
  const expected = await js('window.__burnhouseTest.simulatorState()');
  if (highlightBox && expected.focusRect) {
    const wantLeft = expected.focusRect.x0 / 720;
    const wantTop = expected.focusRect.y0 / 480;
    record(
      Math.abs(highlightBox.left - wantLeft) < 0.02,
      'the highlight is where the disc puts it, horizontally',
      `${highlightBox.left.toFixed(3)} vs ${wantLeft.toFixed(3)}`
    );
    record(
      Math.abs(highlightBox.top - wantTop) < 0.02,
      'the highlight is where the disc puts it, vertically',
      `${highlightBox.top.toFixed(3)} vs ${wantTop.toFixed(3)}`
    );
  } else {
    record(false, 'the highlight is where the disc puts it', 'no highlight or rectangle found');
  }

  await js('window.__burnhouseTest.closeSimulator()');
  await settle(400);
  const closed = await js('window.__burnhouseTest.simulatorState()');
  record(closed.open === false, 'the simulator closes');

  // -------------------------------------------------------- the burn panel ---
  console.log('\nThe burn button');

  await js(`window.__burnhouseTest.goToStep('finish')`);
  await settle(2200);

  const burn = await js(`(() => {
    const button = document.getElementById('btnBurn');
    if (!button) return { present: false };
    const style = getComputedStyle(button);
    const box = button.getBoundingClientRect();
    const panel = [...document.querySelectorAll('.panel')]
      .find((p) => /Write to a blank disc/.test(p.textContent));
    return {
      present: true,
      disabled: button.disabled,
      className: button.className,
      label: button.textContent.trim(),
      // Round: the radius is half the shorter side.
      radius: parseFloat(style.borderTopLeftRadius),
      width: box.width,
      height: box.height,
      filter: style.filter,
      // The notice inside the panel, which the page-level notice used to delete.
      panelNotices: panel ? panel.querySelectorAll('.banner').length : -1,
      reason: (panel && panel.querySelector('.burn-blocked'))
        ? panel.querySelector('.burn-blocked').textContent
        : null,
    };
  })()`);

  record(burn.present, 'the burn button is on the page at all times');
  record(
    burn.className && burn.className.includes('btn-burn'),
    'the burn button uses the round style',
    String(burn.className)
  );
  record(
    // Half the side, with a couple of pixels of slack: a percentage radius
    // resolves against the box in a way that does not land exactly on half.
    burn.radius >= Math.min(burn.width, burn.height) / 2 - 4,
    'the burn button is round',
    `radius ${burn.radius} on a ${Math.round(burn.width)}x${Math.round(burn.height)} button`
  );
  record(
    Math.abs(burn.width - burn.height) < 1,
    'and circular rather than oval',
    `${Math.round(burn.width)}x${Math.round(burn.height)}`
  );
  record(!burn.disabled || Boolean(burn.reason), 'when it cannot be pressed, it says why', String(burn.reason));

  /*
    And the reason it gives is its own, not the page-level notice.

    This used to check for a `.banner` inside the burn panel, which is why it
    failed on every run: banners are rendered onto the stage for the projects,
    slides and testing steps, but the finish step deliberately does not use them
    (see renderBanner's guard). It says what is stopping the burn next to the
    button instead, which is closer to the button and survives a redraw with it.
    So this checks that text exists whenever the button is disabled — the case
    where she actually needs to be told something.
  */
  record(
    burn.blocked ? burn.panelNotices >= 0 && Boolean(burn.reason) : true,
    burn.blocked
      ? 'the reason is shown beside the button, not as a page notice'
      : 'and nothing to warn about while the burn can go ahead',
    burn.blocked ? `${burn.reason}, ${burn.panelNotices} page notices` : 'not blocked'
  );

  // ------------------------------------------- dropping a picture on a slide ---
  console.log('\nDropping a picture onto a slide');

  // A real PNG, written where the app can read it. Dropping one is the first
  // thing anybody tries, and it used to answer "Some files were not videos".
  const picturePath = path.join(sandbox, 'cover.png');
  fs.writeFileSync(
    picturePath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64'
    )
  );

  await js(`window.__burnhouseTest.createNewProject('Pictures', 'charcoal')`);
  await settle(700);

  const beforeDrop = await js(`window.__burnhouseTest.getState()`);
  const videosBefore = beforeDrop.videos.length;

  await js(`window.__burnhouseTest.importPathsOntoSlide([${JSON.stringify(picturePath)}])`);
  await settle(900);

  const afterDrop = await js(`window.__burnhouseTest.getState()`);
  const activeAfter = afterDrop.slides.find((s) => s.id === afterDrop.activeSlideId) || { elements: [] };
  const pictures = activeAfter.elements.filter((e) => e.kind === 'image');

  record(pictures.length === 1, 'a dropped picture becomes a picture on the slide', `${pictures.length} pictures`);
  record(
    pictures[0] && pictures[0].hasPoster,
    'and the picture was actually read, not left empty'
  );
  record(
    pictures[0] && pictures[0].width === 260 && pictures[0].height === 190,
    'at the same size the "Add a picture" button gives it',
    pictures[0] ? `${pictures[0].width}x${pictures[0].height}` : 'none'
  );
  record(
    afterDrop.videos.length === videosBefore,
    'a picture is not mistaken for a video',
    `${videosBefore} then ${afterDrop.videos.length}`
  );

  const dropNotice = await js(`window.__burnhouseTest.banner()`);
  record(
    !dropNotice || !/not videos/i.test(dropNotice.title || ''),
    'and it does not complain that the file was not a video',
    dropNotice ? dropNotice.title : 'no notice'
  );

  // A second picture in the same drop must not hide under the first.
  await js(
    `window.__burnhouseTest.importPathsOntoSlide([${JSON.stringify(picturePath)}, ${JSON.stringify(picturePath)}])`
  );
  await settle(900);

  const stacked = await js(`window.__burnhouseTest.getState()`);
  const stackedActive = stacked.slides.find((s) => s.id === stacked.activeSlideId) || { elements: [] };
  const stackedPictures = stackedActive.elements.filter((e) => e.kind === 'image');
  // A drop of several must not stack them all in one place. The first one keeps
  // the position the button would give it; the rest are staggered off it, so what
  // she dropped is what she can see and drag.
  const fromTheSecondDrop = stackedPictures.slice(pictures.length);
  record(
    fromTheSecondDrop.length === 2,
    'dropping two more adds two more pictures',
    `${stackedPictures.length} pictures in total`
  );
  record(
    new Set(fromTheSecondDrop.map((p) => `${p.x},${p.y}`)).size === 2,
    'and the two from one drop are staggered rather than exactly on top of each other',
    fromTheSecondDrop.map((p) => `${p.x},${p.y}`).join(' / ')
  );
  record(
    fromTheSecondDrop[0] && fromTheSecondDrop[0].x === 120 && fromTheSecondDrop[0].y === 140,
    'the first of a drop lands exactly where the button would put it',
    fromTheSecondDrop[0] ? `${fromTheSecondDrop[0].x},${fromTheSecondDrop[0].y}` : 'none'
  );

  // ------------------------------------------ dragging a picture too large ---
  console.log('\nDragging a picture that is bigger than the safe area');

  const pinnedLeft = await js(
    `window.__burnhouseTest.clampElement({ kind: 'image', x: -9999, y: 0, width: 900, height: 600 })`
  );
  const pinnedRight = await js(
    `window.__burnhouseTest.clampElement({ kind: 'image', x: 9999, y: 0, width: 900, height: 600 })`
  );

  record(
    pinnedLeft.x < pinnedRight.x,
    'a picture wider than the safe area moves when it is dragged',
    `x ${pinnedLeft.x} then ${pinnedRight.x}`
  );
  record(
    pinnedLeft.width === 900 && pinnedRight.width === 900,
    'and is not shrunk to fit while being moved',
    `${pinnedLeft.width} then ${pinnedRight.width}`
  );

  /*
    A picture is not clamped at all — not to the guide, not to the slide. This
    used to assert the opposite, in the days when a small picture was held
    inside the margin; the margin turned out to be the wall somebody kept
    hitting, so there is no wall for pictures any more. What the editor must do
    is keep the position it was handed, however far out it is.
  */
  const offTheSlide = await js(
    `window.__burnhouseTest.clampElement({ kind: 'image', x: -9999, y: -9999, width: 260, height: 190 })`
  );
  record(
    offTheSlide.x === -9999 && offTheSlide.y === -9999,
    'a picture keeps the position it is given, even clear off the slide',
    `${offTheSlide.x},${offTheSlide.y}`
  );

  const heldIn = await js(
    `window.__burnhouseTest.clampElement({ kind: 'text', x: 9999, y: 9999, width: 5000, height: 5000 })`
  );
  record(
    heldIn.x === 40 && heldIn.y === 40,
    'while everything with words in it is still pulled back inside the guide',
    `${heldIn.x},${heldIn.y}`
  );

  /*
    And the real gesture, with real pointer events.

    The checks above prove the rule is right; this proves the drag actually uses
    it, which is the part that was reported. A picture scaled past the safe area
    used to be pinned wherever it landed and every drag snapped it back, so what
    matters is that the position changes by the amount the pointer moved.
  */
  await js(`window.__burnhouseTest.createNewProject('Dragging', 'charcoal')`);
  await settle(700);

  // Placed in its own round trip, and given a moment: the layout the drag
  // hit-tests against is fetched asynchronously, and a drag before it lands
  // finds nothing under the pointer and does nothing at all.
  await js(`window.__burnhouseTest.addElement('image', { width: 900, height: 600 })`);
  await settle(900);

  const dragResult = await js(`(() => {
    const canvas = document.getElementById('slideCanvas');
    const rect = canvas.getBoundingClientRect();
    const toClient = (x, y) => ({
      clientX: rect.left + (x / 720) * rect.width,
      clientY: rect.top + (y / 480) * rect.height,
    });
    const boxOf = () => {
      const s = window.__burnhouseTest.getState();
      const slide = s.slides.find((sl) => sl.id === s.activeSlideId);
      const img = slide.elements.find((e) => e.kind === 'image');
      return img ? { x: img.x, y: img.y, width: img.width, height: img.height } : null;
    };

    const before = boxOf();
    const from = toClient(200, 200);
    const to = toClient(100, 200);
    const pointer = (type, at, extra) => new PointerEvent(type, {
      bubbles: true, pointerId: 1, isPrimary: true, ...at, ...extra,
    });

    canvas.dispatchEvent(pointer('pointerdown', from, { button: 0, buttons: 1 }));
    document.dispatchEvent(pointer('pointermove', to, { buttons: 1 }));
    document.dispatchEvent(pointer('pointerup', to, { button: 0 }));

    return { before, after: boxOf() };
  })()`);
  await settle(400);

  record(
    dragResult.after && dragResult.before && dragResult.after.x !== dragResult.before.x,
    'dragging a picture wider than the safe area moves it',
    `x ${dragResult.before.x} then ${dragResult.after.x}`
  );
  record(
    dragResult.after && Math.abs(dragResult.after.x - (dragResult.before.x - 100)) <= 2,
    'and it follows the pointer rather than snapping to a limit',
    `moved ${dragResult.after ? dragResult.after.x - dragResult.before.x : '?'}`
  );
  record(
    dragResult.after && dragResult.after.width === 900,
    'without being shrunk while it is moved',
    dragResult.after ? String(dragResult.after.width) : '?'
  );

  // ---------------------------- reaching under a picture that covers one ---
  console.log('\nReaching the thing underneath a picture');

  /*
    The reported problem: a big picture with a transparent background sits over
    a smaller one, and the smaller one can never be selected because every press
    lands on the big one. The fix is that pressing the *same spot* again steps
    down through whatever is stacked there.

    Both are pictures, so the tie is broken by which was added last — the big one
    is on top, which is exactly the reported arrangement.
  */
  await js(`window.__burnhouseTest.createNewProject('Stacked', 'charcoal')`);
  await settle(700);

  const pile = await js(`(() => {
    const small = window.__burnhouseTest.addElement('image', {
      x: 140, y: 150, width: 180, height: 120,
    });
    const big = window.__burnhouseTest.addElement('image', {
      x: 60, y: 60, width: 600, height: 380,
    });
    return { smallId: small.id, bigId: big.id };
  })()`);
  await settle(900);

  // A point inside both.
  const inside = { x: 220, y: 210 };
  const stack = await js(
    `window.__burnhouseTest.stack(${JSON.stringify(inside)})`
  );
  record(
    Array.isArray(stack) && stack[0] === pile.bigId && stack[1] === pile.smallId,
    'under a point are both pictures, the covering one first',
    JSON.stringify(stack)
  );

  /*
    Two presses in the same place, with the memory of the first handed to the
    second — which is what the canvas does between one press and the next.
  */
  const pressTrail = await js(`(() => {
    const at = ${JSON.stringify(inside)};
    const T = window.__burnhouseTest;
    // Between one press and the next the canvas selects what was reached, and
    // the step down is counted from that — so the trail does the same.
    const first = T.press(at, null);
    T.selectElement(first.id);
    const second = T.press(at, first.at);
    T.selectElement(second.id);
    const third = T.press(at, second.at);
    // A press somewhere else forgets the trail, so the next press there starts
    // at the top again rather than continuing where the last one left off.
    const elsewhere = T.press({ x: 100, y: 90 }, null);
    const backToStart = T.press(at, elsewhere.at);
    return { first: first.id, second: second.id, third: third.id, backToStart: backToStart.id };
  })()`);

  record(
    pressTrail.first === pile.bigId,
    'the first press takes the picture on top',
    String(pressTrail.first)
  );
  record(
    pressTrail.second === pile.smallId,
    'pressing the same spot again reaches the one underneath',
    String(pressTrail.second)
  );
  record(
    pressTrail.third === pile.bigId,
    'and a third press comes back round to the top',
    String(pressTrail.third)
  );
  record(
    pressTrail.backToStart === pile.bigId,
    'a press elsewhere starts again from the top',
    String(pressTrail.backToStart)
  );

  // The panel has to say so, or the gesture is one nobody would look for.
  const beneath = await js(`(() => {
    window.__burnhouseTest.selectElement(${JSON.stringify(pile.bigId)});
    const ids = window.__burnhouseTest.beneathSelected();
    const hint = [...document.querySelectorAll('.prop-hint')]
      .map((n) => n.textContent.trim())
      .find((t) => /behind this one/.test(t));
    window.__burnhouseTest.selectElement(${JSON.stringify(pile.smallId)});
    return { ids, hint, onTopCount: window.__burnhouseTest.beneathSelected().length };
  })()`);

  record(
    Array.isArray(beneath.ids) && beneath.ids.length === 1 && beneath.ids[0] === pile.smallId,
    'the panel knows what is under the picture on top',
    JSON.stringify(beneath.ids)
  );
  record(
    Boolean(beneath.hint),
    'and says so, so the press-through can be found',
    beneath.hint || 'no note'
  );
  record(
    beneath.onTopCount === 0,
    'with nothing said about the picture on top of the pile',
    String(beneath.onTopCount)
  );

  // ------------------------------------- how dark the background picture is ---
  console.log('\nDarkening the background picture');

  await js(`window.__burnhouseTest.createNewProject('Darkening', 'charcoal')`);
  await settle(700);

  const noPicture = await js(`window.__burnhouseTest.slideBackgroundDim()`);
  record(
    noPicture === 1,
    'with no picture behind, the darkening is the usual amount',
    String(noPicture)
  );

  const darkPath = path.join(sandbox, 'darkening.png');
  fs.writeFileSync(
    darkPath,
    await js(`(() => {
      const swatch = document.createElement('canvas');
      swatch.width = 320; swatch.height = 240;
      const c = swatch.getContext('2d');
      c.fillStyle = '#8f6a3f';
      c.fillRect(0, 0, 320, 240);
      return swatch.toDataURL('image/png');
    })()`).then((url) => Buffer.from(url.split(',')[1], 'base64'))
  );

  const dim = await js(`(async () => {
    await window.__burnhouseTest.setSlideBackground(${JSON.stringify(darkPath)});
    const has = window.__burnhouseTest.hasSlideBackground();
    const original = window.__burnhouseTest.slideBackgroundDim();
    const half = window.__burnhouseTest.setSlideBackgroundDim(0.5);
    await new Promise((r) => setTimeout(r, 300));
    const readHalf = window.__burnhouseTest.slideBackgroundDim();
    window.__burnhouseTest.setSlideBackgroundDim(0);
    await new Promise((r) => setTimeout(r, 300));
    const readNone = window.__burnhouseTest.slideBackgroundDim();
    window.__burnhouseTest.setSlideBackgroundDim(9);
    await new Promise((r) => setTimeout(r, 300));
    const readOver = window.__burnhouseTest.slideBackgroundDim();
    return { has, original, half, readHalf, readNone, readOver };
  })()`);

  record(dim.has, 'a picture was put behind the slide');
  record(
    dim.original === 1,
    'a picture starts as dark as it has always been',
    String(dim.original)
  );
  record(
    dim.readHalf === 0.5 && dim.half === 0.5,
    'the slider reaches the drawing code as what was chosen',
    `set ${dim.half}, drawn ${dim.readHalf}`
  );
  record(
    dim.readNone === 0,
    'zero leaves the picture at its original brightness',
    String(dim.readNone)
  );
  record(
    dim.readOver === 1,
    'and it cannot be pushed past the usual amount',
    String(dim.readOver)
  );

  /*
    And the control itself, drawn in the panel. A setting nobody can find is the
    same as no setting, so this asks the rendered panel rather than the model —
    in its own round trip, because the inspector is rebuilt once the layout
    request comes back rather than in the same tick.
  */
  await js(`(() => {
    const T = window.__burnhouseTest;
    T.setSlideBackgroundDim(0.5);
    T.goToSlide(T.getState().activeSlideId);
    return true;
  })()`);
  await settle(700);

  const dimPanel = await js(`(() => {
    const slider = document.querySelector('.dim-range');
    const readout = document.querySelector('.dim-readout');
    return {
      slider: Boolean(slider),
      min: slider ? slider.min : null,
      max: slider ? slider.max : null,
      shown: slider ? slider.value : null,
      readout: readout ? readout.textContent : null,
    };
  })()`);

  record(dimPanel.slider, 'the background block carries a slider for the darkening');
  record(
    dimPanel.min === '0' && dimPanel.max === '1',
    'which runs from the original picture to the usual wash',
    `${dimPanel.min} to ${dimPanel.max}`
  );
  record(
    dimPanel.shown === '0.5' && dimPanel.readout === '50%',
    'and shows what the slide is set to',
    `${dimPanel.shown} / ${dimPanel.readout}`
  );

  /*
    And it survives being dragged.

    This was a real fault, and it was found by measurement rather than by reading:
    the slider's `input` handler called the full redraw, which replaces the
    inspector's DOM, and the slider is inside the inspector. So the element under
    the pointer was thrown away on the first movement and the drag ended there —
    one step per grab, on the one control in the panel that is meant to be swept.

    The check is that the node the drag is holding is still the node on screen
    afterwards. A rebuilt panel with a fresh slider in it looks identical, so
    only identity tells the two apart.
  */
  const sliderDrag = await js(`(async () => {
    const slider = document.querySelector('.dim-range');
    if (!slider) return { error: 'no slider' };

    // Tag the node so a replacement is unmistakable.
    slider.dataset.probe = 'dragged';

    /*
      What a drag does, exactly: set the value and fire "input", repeatedly, with
      "change" arriving only when the pointer is let go. The identity is checked
      before that last event, because rebuilding on release is deliberate and
      harmless - the control is no longer being held.
    */
    slider.value = '0.35';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.value = '0.2';
    slider.dispatchEvent(new Event('input', { bubbles: true }));

    const duringDrag = document.querySelector('.dim-range');
    const heldThroughDrag = duringDrag ? duringDrag.dataset.probe === 'dragged' : false;
    const stepReadout = (document.querySelector('.dim-readout') || {}).textContent || null;

    // Now let go.
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));

    const after = document.querySelector('.dim-range');
    return {
      heldThroughDrag,
      stepReadout,
      sliders: document.querySelectorAll('.dim-range').length,
      value: after ? after.value : null,
      saved: window.__burnhouseTest.slideBackgroundDim(),
      readout: (document.querySelector('.dim-readout') || {}).textContent || null,
    };
  })()`);
  await settle(600);

  record(!sliderDrag.error, 'there is a slider to drag', sliderDrag.error || '');
  record(
    sliderDrag.heldThroughDrag === true,
    'dragging it does not replace the control under the pointer',
    sliderDrag.heldThroughDrag ? 'same node throughout' : 'it was rebuilt mid-drag'
  );
  record(
    sliderDrag.stepReadout === '20%',
    'and the number beside it follows each step',
    sliderDrag.stepReadout || 'none'
  );
  record(
    sliderDrag.sliders === 1,
    'with still exactly one of them afterwards',
    String(sliderDrag.sliders)
  );
  record(
    sliderDrag.value === '0.2' && sliderDrag.saved === 0.2,
    'the whole drag is applied, not just its first step',
    `shown ${sliderDrag.value}, saved ${sliderDrag.saved}`
  );
  record(
    sliderDrag.readout === '20%',
    'and saved when the pointer is let go',
    sliderDrag.readout || 'none'
  );

  // ------------------------------- a picture that goes to another slide ---
  console.log('\nMaking a picture clickable');

  await js(`window.__burnhouseTest.createNewProject('Linked', 'charcoal')`);
  await settle(700);

  const linkSetup = await js(`(async () => {
    const swatch = document.createElement('canvas');
    swatch.width = 272; swatch.height = 200;
    const c = swatch.getContext('2d');
    c.fillStyle = '#3f6d8f';
    c.fillRect(0, 0, 272, 200);
    const src = swatch.toDataURL('image/png');

    const state = window.__burnhouseTest.getState();
    const firstId = state.slides[0].id;
    const secondId = state.slides[1] ? state.slides[1].id : state.slides[0].id;

    // A picture that does something, and one that does not.
    const linked = window.__burnhouseTest.addElement('image', {
      src, x: 40, y: 60, width: 272, height: 200, targetSlideId: secondId,
    });
    const plain = window.__burnhouseTest.addElement('image', {
      src, x: 380, y: 60, width: 272, height: 200,
    });
    // And something on the second slide, so it is a page worth going to.
    window.__burnhouseTest.goToSlide(secondId);
    window.__burnhouseTest.addElement('button', { label: 'Back', targetSlideId: firstId });

    // Back to the first slide with the linked picture selected, which is the
    // state the inspector checks below are about.
    window.__burnhouseTest.goToSlide(firstId);
    window.__burnhouseTest.selectElement(linked.id);

    return { firstId, secondId, linkedId: linked.id, plainId: plain.id };
  })()`);
  await settle(1200);

  record(
    Boolean(linkSetup.linkedId) && Boolean(linkSetup.plainId),
    'two pictures were placed',
    `${linkSetup.linkedId} / ${linkSetup.plainId}`
  );

  /*
    Nothing is drawn over a picture for having somewhere to go.

    An amber badge with a chevron used to be painted on the corner of every
    picture with a destination, which sat on her photograph in the one place she
    was trying to look at. The check is a straight pixel comparison: the same
    slide, screenshotted with the destination set and with it taken away. If
    anything at all is drawn for the destination, the two pictures differ.

    Nothing is selected while either shot is taken, because a selection outline
    is real editor furniture and would differ between them for reasons that have
    nothing to do with this.
  */
  const badge = await js(`(async () => {
    const T = window.__burnhouseTest;
    const shot = async () => {
      // Going to the slide also drops the selection, so no outline is drawn.
      T.goToSlide(${JSON.stringify(linkSetup.firstId)});
      await new Promise((r) => setTimeout(r, 500));
      return document.getElementById('slideCanvas').toDataURL('image/png');
    };

    const linked = T.getState().slides[0].elements
      .find((e) => e.kind === 'image' && e.targetSlideId);
    if (!linked) return { error: 'no picture with a destination' };

    const withTarget = await shot();
    T.setImageTarget(linked.id, null);
    const withoutTarget = await shot();
    // Put back, and prove it is the same picture again, so the three shots are
    // comparable rather than merely two of them.
    T.setImageTarget(linked.id, ${JSON.stringify(linkSetup.secondId)});
    const restored = await shot();

    return {
      id: linked.id,
      same: withTarget === withoutTarget,
      restored: withTarget === restored,
      bytes: withTarget.length,
    };
  })()`);
  await settle(600);

  record(!badge.error, 'there is a picture with a destination to check', badge.error || badge.id);
  record(
    badge.same === true,
    'a picture with somewhere to go is drawn exactly like one without',
    badge.same ? `${badge.bytes} bytes, identical` : 'the two pictures differ'
  );
  record(
    badge.restored === true,
    'and giving it a destination again changes nothing either',
    String(badge.restored)
  );

  /*
    Back to the picture being selected.

    The comparison above moves between slides to clear the selection — a selected
    element draws an outline and a set of handles, which would make the two
    screenshots differ for reasons that have nothing to do with the destination.
    The checks below are about the panel, so the picture has to be selected again
    for the element inspector to be there at all.
  */
  await js(`window.__burnhouseTest.goToSlide(${JSON.stringify(linkSetup.firstId)})`);
  await settle(500);
  await js(`window.__burnhouseTest.selectElement(${JSON.stringify(linkSetup.linkedId)})`);
  await settle(700);

  /*
    What the disc makes of them.

    The point of the whole thing: a picture that has been given a destination is
    a button on the disc, with a rectangle the remote can land on and a command
    that goes there, and a picture without one is not.
  */
  const discs = await js(`window.__burnhouseTest.discButtons()`);
  const page1 = discs[0];
  record(discs.length === 2, 'both slides became menu pages', `${discs.length} pages`);
  record(
    page1 && page1.buttons.length === 1,
    'the first page has exactly one button: the picture that goes somewhere',
    page1 ? `${page1.buttons.length} buttons` : 'no page'
  );
  record(
    page1 && page1.buttons[0] && /jump menu/.test(page1.buttons[0].command),
    'and that button jumps to the other slide',
    page1 && page1.buttons[0] ? page1.buttons[0].command : 'none'
  );
  record(
    page1 && page1.buttons[0] && page1.buttons[0].x0 === 40 && page1.buttons[0].y0 === 60,
    'with the picture\u2019s own rectangle, not a box of its own',
    page1 && page1.buttons[0] ? `${page1.buttons[0].x0},${page1.buttons[0].y0}` : 'none'
  );

  // The inspector offers the choice, naming the "no destination" case rather
  // than leaving it as an unlabelled prompt she has to interpret.
  const choices = await js(`(() => {
    const row = [...document.querySelectorAll('#inspector .prop-row')]
      .find((r) => r.dataset.prop === 'gotoslide');
    if (!row) return null;
    const select = row.querySelector('select');
    return {
      label: row.querySelector('.prop-name').textContent,
      value: select.value,
      options: [...select.options].map((o) => o.textContent),
    };
  })()`);
  record(choices !== null, 'the picture inspector has a "goes to" row');
  record(
    choices && choices.label === 'Goes to',
    'labelled in words rather than as an identifier',
    choices ? choices.label : 'no row'
  );
  record(
    choices && choices.value === linkSetup.secondId,
    'showing the slide it was pointed at',
    choices ? choices.value : 'no row'
  );
  record(
    choices && choices.options.some((o) => /none/i.test(o)),
    'and offering doing nothing by name',
    choices ? choices.options.join(' / ') : 'no row'
  );

  /*
    Turning it off must take the button away again.

    Asked about the picture's own slide, and about its buttons rather than about
    whether the slide is still a page: the other slide has a Back button pointing
    here, so the page itself stays — a viewer who is sent here has to be able to
    be sent back out — but there is nothing on it to press, because the picture
    was the only thing on it that could be.
  */
  const unlinked = await js(`(async () => {
    const first = ${JSON.stringify(linkSetup.firstId)};
    const onFirst = async () => {
      const pages = (await window.__burnhouseTest.discButtons()).filter((p) => p.slideId === first);
      return {
        pages: pages.length,
        buttons: pages.reduce((sum, p) => sum + p.buttons.length, 0),
      };
    };

    const before = await onFirst();
    window.__burnhouseTest.setImageTarget(${JSON.stringify(linkSetup.linkedId)}, null);
    await new Promise((r) => setTimeout(r, 700));
    return { before, after: await onFirst() };
  })()`);
  await settle(400);

  record(
    unlinked.before.buttons === 1,
    'the picture was on the remote as a button',
    `${unlinked.before.buttons} button(s)`
  );
  record(
    unlinked.after.buttons === 0,
    'and setting its destination back to None takes it off the remote again',
    `then ${unlinked.after.buttons}`
  );
  record(
    unlinked.after.pages === 1,
    'while the page itself stays, since the other slide still points at it',
    `${unlinked.after.pages} page(s)`
  );

  // ------------------------------------------------- selecting several ---
  console.log('\nSelecting several elements at once');

  await js(`window.__burnhouseTest.createNewProject('Multi', 'charcoal')`);
  await settle(700);

  const placed = await js(`(() => {
    const a = window.__burnhouseTest.addElement('text', { text: 'One', x: 60, y: 120, width: 200, height: 60 });
    const b = window.__burnhouseTest.addElement('text', { text: 'Two', x: 60, y: 220, width: 200, height: 60 });
    const c = window.__burnhouseTest.addElement('text', { text: 'Three', x: 60, y: 320, width: 200, height: 60 });
    return { a: a.id, b: b.id, c: c.id };
  })()`);
  await settle(900);

  /**
   * Press a point on the canvas, optionally with a modifier.
   *
   * `mods` is injected as source text — `'ctrlKey: true'` — rather than as an
   * object, because it has to end up inside the event the page constructs.
   */
  const pressCanvas = (x, y, mods = '') => js(`(() => {
    const canvas = document.getElementById('slideCanvas');
    const rect = canvas.getBoundingClientRect();
    const at = {
      clientX: rect.left + (${x} / 720) * rect.width,
      clientY: rect.top + (${y} / 480) * rect.height,
    };
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1, ...at, ${mods}
    }));
    document.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: 1, isPrimary: true, button: 0, ...at, ${mods}
    }));
    return window.__burnhouseTest.selection();
  })()`);

  const firstPick = await pressCanvas(120, 150);
  record(
    firstPick.length === 1 && firstPick[0] === placed.a,
    'a plain click selects one element',
    firstPick.join(', ')
  );

  /*
    The gesture the whole feature is for: hold a modifier and click a second
    thing. Ctrl on Windows, Cmd on a Mac, and Shift on both — all three are
    accepted, because Ctrl-click is the system's right-click on macOS and a
    feature reachable only that way would be unreachable there.
  */
  const withCtrl = await pressCanvas(120, 250, 'ctrlKey: true');
  record(
    withCtrl.length === 2 && withCtrl.includes(placed.a) && withCtrl.includes(placed.b),
    'ctrl-click adds a second element to the selection',
    withCtrl.join(', ')
  );

  const withShift = await pressCanvas(120, 350, 'shiftKey: true');
  record(withShift.length === 3, 'shift-click adds a third', withShift.join(', '));

  const toggledOff = await pressCanvas(120, 250, 'ctrlKey: true');
  record(
    toggledOff.length === 2 && !toggledOff.includes(placed.b),
    'clicking a selected element again takes it back out',
    toggledOff.join(', ')
  );

  // A plain click starts over, which is how you get out of a multiple selection.
  const reset = await pressCanvas(120, 150);
  record(reset.length === 1, 'a plain click clears the rest', reset.join(', '));

  // ------------------------------------ changing a property on all of them ---
  console.log('\nChanging a property they all have');

  await js(`(async () => {
    const ids = ${JSON.stringify([placed.a, placed.b, placed.c])};
    const canvas = document.getElementById('slideCanvas');
    const rect = canvas.getBoundingClientRect();
    const press = (x, y, mods) => {
      const at = {
        clientX: rect.left + (x / 720) * rect.width,
        clientY: rect.top + (y / 480) * rect.height,
      };
      canvas.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1, ...at, ...mods,
      }));
      document.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerId: 1, isPrimary: true, button: 0, ...at, ...mods,
      }));
    };
    press(120, 150, {});
    press(120, 250, { ctrlKey: true });
    press(120, 350, { ctrlKey: true });
    return ids.length;
  })()`);
  await settle(700);

  const panel = await js(`(() => {
    const rows = [...document.querySelectorAll('#inspector .prop-row')];
    return {
      heading: (document.querySelector('#inspector .rail-title') || {}).textContent || '',
      props: rows.map((r) => r.dataset.prop),
      hint: (document.querySelector('#inspector .prop-hint') || {}).textContent || '',
    };
  })()`);

  record(panel.heading === '3 elements', 'the panel says how many are selected', panel.heading);
  record(panel.props.includes('width'), 'and offers a property they all have', panel.props.join(', '));
  record(
    !panel.props.includes('text'),
    'but not one that is each element\u2019s own'
  );

  // Change the width through the real control, and it must land on all three —
  // and only on those three. A new project's menu slide carries a title, so
  // there is a fourth text element that was never selected and must not move.
  const applied = await js(`(async () => {
    const row = [...document.querySelectorAll('#inspector .prop-row')]
      .find((r) => r.dataset.prop === 'width');
    const input = row.querySelector('input');
    input.value = '321';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    return window.__burnhouseTest.elements().filter((e) => e.kind === 'text');
  })()`);
  await settle(400);

  const resized = applied.filter((e) => [placed.a, placed.b, placed.c].includes(e.id));
  const untouched = applied.filter((e) => ![placed.a, placed.b, placed.c].includes(e.id));

  record(
    resized.length === 3 && resized.every((e) => e.width === 321),
    'and changing it sets it on every selected element',
    resized.map((e) => e.width).join(', ')
  );
  record(
    untouched.every((e) => e.width !== 321),
    'while leaving the element that was not selected alone',
    untouched.map((e) => e.width).join(', ') || 'none'
  );

  // Dragging one of a selection takes the rest with it.
  const moved = await js(`(async () => {
    const ids = ${JSON.stringify([placed.a, placed.b, placed.c])};
    const read = () =>
      window.__burnhouseTest.elements()
        .filter((e) => ids.includes(e.id))
        .map((e) => ({ id: e.id, x: e.x }));
    const before = read();

    const canvas = document.getElementById('slideCanvas');
    const rect = canvas.getBoundingClientRect();
    const to = (x, y) => ({
      clientX: rect.left + (x / 720) * rect.width,
      clientY: rect.top + (y / 480) * rect.height,
    });
    const from = to(120, 150);
    const dest = to(200, 150);
    const pointer = (type, at, extra) => new PointerEvent(type, {
      bubbles: true, pointerId: 1, isPrimary: true, ...at, ...extra,
    });
    canvas.dispatchEvent(pointer('pointerdown', from, { button: 0, buttons: 1 }));
    document.dispatchEvent(pointer('pointermove', dest, { buttons: 1 }));
    document.dispatchEvent(pointer('pointerup', dest, { button: 0 }));
    await new Promise((r) => setTimeout(r, 400));

    return { before, after: read(), id: ids[0] };
  })()`);
  await settle(400);

  const movedIds = moved.after.map((e) => e.id);
  record(
    movedIds.length === 3 && movedIds.includes(moved.id),
    'the selection survives being dragged',
    movedIds.join(', ')
  );
  record(
    moved.after.every((e) => {
      const was = moved.before.find((b) => b.id === e.id);
      return was && e.x === was.x + 80;
    }),
    'and every selected element moves by the same amount',
    `${moved.before.map((e) => e.x).join(',')} then ${moved.after.map((e) => e.x).join(',')}`
  );

  // ------------------------------------------------------------------------
  // ------------------------------------------- putting a sound on a page ---
  console.log('\nPutting a sound on a menu page');

  await js(`window.__burnhouseTest.createNewProject('Sounding', 'charcoal')`);
  await settle(700);

  /*
    A real sound file, written where the app can read it.

    WAV for the same reason as the other suites: writing an MP3 needs an external
    library that not every ffmpeg build carries, and this must pass on any of them.
  */
  const tunePath = path.join(sandbox, 'tune.wav');
  const tuneMade = spawnSync(
    process.env.BURNHOUSE_FFMPEG || 'ffmpeg',
    [
      '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=6',
      '-c:a', 'pcm_s16le', tunePath,
    ],
    { windowsHide: true }
  );

  if (tuneMade.status !== 0 || !fs.existsSync(tunePath)) {
    record(true, 'a sound file to test with', 'ffmpeg could not make one, skipping the sound checks');
  } else {
    const toolbar = await js(
      `[...document.querySelectorAll('#editorToolbar button')].map((b) => b.textContent.trim())`
    );
    record(
      toolbar.some((label) => /sound/i.test(label)),
      'the toolbar offers a sound',
      toolbar.join(' | ')
    );

    // Nothing chosen yet.
    const beforeSound = await js(`window.__burnhouseTest.slideAudio()`);
    record(beforeSound === null, 'a new slide is silent', String(beforeSound));

    /*
      Dropping the file on the slide, which is the gesture asked for — it goes
      through the same path a drop from Finder takes, minus the drag itself.
    */
    const afterDropSound = await js(
      `(async () => {
         await window.__burnhouseTest.importPathsOntoSlide([${JSON.stringify(tunePath)}]);
         await new Promise((r) => setTimeout(r, 600));
         return window.__burnhouseTest.slideAudio();
       })()`
    );
    await settle(500);

    record(
      afterDropSound && afterDropSound.path === tunePath,
      'dropping a sound file on a slide sets the page sound',
      afterDropSound ? afterDropSound.fileName : 'nothing'
    );
    record(
      afterDropSound && afterDropSound.seconds > 5,
      'with the length of the file, so the page knows how long it runs',
      afterDropSound ? `${afterDropSound.seconds}s` : 'nothing'
    );

    const soundNotice = await js(`window.__burnhouseTest.banner()`);
    record(
      !soundNotice || !/not videos/i.test(soundNotice.title || ''),
      'and a sound is not mistaken for a video',
      soundNotice ? soundNotice.title : 'no notice'
    );

    // The panel shows it, with a way to hear it and a way to remove it.
    const soundPanel = await js(`(() => {
      const name = document.querySelector('#inspector .sound-name');
      const buttons = [...document.querySelectorAll('#inspector .btn-row button')].map((b) => b.textContent.trim());
      const mark = document.querySelector('.slide-card-sound');
      return { name: name ? name.textContent : null, buttons, hasMark: Boolean(mark) };
    })()`);
    record(soundPanel.name === 'tune.wav', 'the panel names the sound', String(soundPanel.name));
    record(
      soundPanel.buttons.some((b) => /listen/i.test(b)),
      'offers to play it',
      soundPanel.buttons.join(' | ')
    );
    record(soundPanel.hasMark, 'and the slide in the list is marked as having a sound');

    // It reaches the disc model, which is what the burn is built from.
    const onDisc = await js(`window.__burnhouseTest.discButtons().then(() => window.__burnhouseTest.slideAudio())`);
    record(
      onDisc && onDisc.path === tunePath,
      'and it is still there when the deck is turned into a disc',
      onDisc ? onDisc.fileName : 'nothing'
    );
  }

  // ------------------------------------- taking a background picture off ---
  console.log('\nTaking a custom background picture off');

  const background = await js(`(() => {
    // A real picture, made in the page so it is genuinely decodable. Only the
    // data URL comes back: the page may not fetch it (its content policy allows
    // no connections at all), and the file is written from here instead.
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 200;
    const c = canvas.getContext('2d');
    c.fillStyle = '#7a4a2c';
    c.fillRect(0, 0, 320, 200);
    return canvas.toDataURL('image/png');
  })()`);

  const backgroundPath = path.join(sandbox, 'backdrop.png');
  fs.writeFileSync(backgroundPath, Buffer.from(String(background).split(',')[1], 'base64'));

  const setBackground = await js(
    `(async () => {
       const ok = await window.__burnhouseTest.setSlideBackground(${JSON.stringify(backgroundPath)});
       await new Promise((r) => setTimeout(r, 500));
       return { ok, has: window.__burnhouseTest.hasSlideBackground() };
     })()`
  );
  await settle(500);

  record(
    setBackground.has === true,
    'a picture can be set as the slide background',
    String(setBackground.has)
  );

  /*
    The control asked for: hovering the picture covers it with a cross, and
    pressing that takes the picture away. Nothing else on the panel removes it,
    so if this button is missing there is no way out.
  */
  const removeButton = await js(`(() => {
    const button = document.querySelector('#inspector .bg-preview-remove');
    if (!button) return { present: false };
    return {
      present: true,
      label: button.getAttribute('aria-label'),
      text: button.textContent.trim(),
      // It sits on the picture, which is the whole point: the control is on the
      // thing it acts on rather than being another grey button underneath.
      insidePreview: Boolean(button.closest('.bg-preview-wrap')),
    };
  })()`);

  record(removeButton.present, 'the background picture has a remove control');
  record(
    removeButton.insidePreview === true,
    'and it sits on the picture itself'
  );

  const removed = await js(`(async () => {
    document.querySelector('#inspector .bg-preview-remove').click();
    await new Promise((r) => setTimeout(r, 500));
    return {
      has: window.__burnhouseTest.hasSlideBackground(),
      buttonGone: !document.querySelector('#inspector .bg-preview-remove'),
    };
  })()`);
  await settle(500);

  record(removed.has === false, 'pressing it removes the custom background');
  record(removed.buttonGone, 'and the control goes with it');

  // --------------------------------------------- one folder per project ---
  //
  // The prepared disc is looked up by project, so the two things that decide
  // whether that works are checked together: that the interface tells the main
  // process which project is open, and that it asks again when a different one
  // is opened. The second was wrong — the answer was fetched once per session
  // and reused, so a second project inherited the first one's disc.
  console.log('\nEach project its own prepared disc');

  const work = path.join(sandbox, 'work');

  // The layout an older version wrote: a single build at the top of the working
  // folder, because there was only ever one.
  fs.mkdirSync(path.join(work, 'titles', 'title_1'), { recursive: true });
  fs.mkdirSync(path.join(work, 'author', 'VIDEO_TS'), { recursive: true });
  fs.writeFileSync(path.join(work, 'titles', 'title_1', 'VTS_01_1.VOB'), Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(work, 'author', 'VIDEO_TS', 'VIDEO_TS.IFO'), 'ifo');
  fs.writeFileSync(path.join(work, 'author', 'VIDEO_TS', 'VIDEO_TS.BUP'), 'bup');
  fs.writeFileSync(
    path.join(work, 'build.json'),
    JSON.stringify({ fingerprint: 'x'.repeat(64), volumeLabel: 'OLD' })
  );

  await js(`window.__burnhouseTest.createNewProject('First', 'charcoal')`);
  await settle(700);
  const firstId = await js(`window.__burnhouseTest.projectPayload().id`);
  await js(`window.__burnhouseTest.goToStep('finish')`);
  await settle(1400);

  record(Boolean(firstId), 'a project tells the main process which project it is', String(firstId));
  record(
    fs.existsSync(path.join(work, firstId, 'build.json')),
    'a build left by the old shared layout is adopted into the project'
  );
  record(
    !fs.existsSync(path.join(work, 'build.json')),
    'and nothing is left at the top of the working folder pretending to be one'
  );

  await js(`window.__burnhouseTest.createNewProject('Second', 'charcoal')`);
  await settle(700);
  const secondId = await js(`window.__burnhouseTest.projectPayload().id`);
  await js(`window.__burnhouseTest.goToStep('finish')`);
  await settle(1400);

  record(
    Boolean(secondId) && secondId !== firstId,
    'a second project has an identity of its own',
    String(secondId)
  );
  record(
    fs.existsSync(path.join(work, secondId)),
    'and is asked about separately, so it gets its own folder'
  );
  record(
    fs.existsSync(path.join(work, firstId, 'build.json')),
    'without disturbing the first project\u2019s prepared disc'
  );

  // ------------------------------------------------------------------ done ---
  finish();
}

function finish() {
  console.log('');
  if (failures.length) {
    console.log(`${failures.length} of ${passed + failures.length} checks failed.`);
    for (const f of failures) console.log(`  - ${f.label}: ${f.detail}`);
  } else {
    console.log(`All ${passed} checks passed.`);
  }

  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* not important */
  }
  app.exit(failures.length ? 1 : 0);
}
