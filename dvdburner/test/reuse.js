'use strict';

/**
 * The prepared disc is reused, and only what changed is prepared again.
 *
 * This is the one test that runs the real pipeline: real ffmpeg, real menu
 * rendering in a real offscreen window, real dvdauthor. It exists because the
 * caching added between those stages is a claim about all of them at once — that
 * a second build with nothing changed writes the same disc without re-encoding
 * anything, and that changing a slide does not invalidate a film.
 *
 * It uses one three-second fixture twice, so it takes seconds rather than the
 * minutes it would with real footage, and it asserts on what is on disk: the
 * encoded title files must still be the very same files, by modification time.
 *
 * Run with:  npm run test:reuse
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const pipeline = require('../src/core/pipeline');
const { detectTools } = require('../src/core/tools');
const probeMod = require('../src/core/probe');

const FIXTURE = path.join(__dirname, 'fixtures', 'fixture_ntsc.mp4');

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  PASS ${name}`);
    })
    .catch((err) => {
      failed += 1;
      failures.push({ name, message: String((err && err.message) || err) });
      console.log(`  FAIL ${name}`);
      console.log(`       ${String((err && err.message) || err)}`);
    });
}

function skip(name, reason) {
  skipped += 1;
  console.log(`  SKIP ${name} \u2014 ${reason}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message || 'Values differ'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `burnhouse-${tag}-`));
}

/**
 * What each prepared title looks like on disk: the files that were written, when
 * they were written, and how big they are.
 *
 * Modification time is the point. A rebuild that reuses a title leaves the file
 * exactly as it was; one that re-encodes it writes a new one, and no accounting
 * in the pipeline can hide that from the filesystem.
 */
function snapshot(prepared) {
  const out = [];
  for (const video of prepared.videos) {
    for (const part of video.parts || []) {
      const stat = fs.statSync(part.file);
      out.push({ file: part.file, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  return out;
}

function sameSnapshot(before, after) {
  if (before.length !== after.length) {
    return `the file list changed: ${before.length} then ${after.length}`;
  }
  for (let i = 0; i < before.length; i += 1) {
    if (before[i].file !== after[i].file) return `file ${i} is a different file`;
    if (before[i].mtimeMs !== after[i].mtimeMs) return `${path.basename(before[i].file)} was rewritten`;
    if (before[i].size !== after[i].size) return `${path.basename(before[i].file)} changed size`;
  }
  return null;
}

/** A project shaped the way the interface builds one. */
function projectWith(root, videos, overrides = {}) {
  return pipeline.normaliseProject({
    discTitle: 'Reuse Test',
    themeId: 'charcoal',
    titleAspect: '16:9',
    chaptersEnabled: false,
    output: { workDir: root, buildIso: false },
    videos,
    ...overrides,
  });
}

/**
 * A menu slide with a button on it, which is the least a page needs to exist.
 *
 * The editor builds these from the video list; a headless build has to do the
 * same, because a slide with no button is not a menu page at all and there would
 * be nothing to attach a sound to.
 */
function menuDeck({ title = 'Menu' } = {}) {
  const deckModel = require('../src/core/deck');
  const slide = deckModel.episodeListSlide(
    [{ id: 'v1', name: 'Episode One', duration: 3 }],
    { id: 'menu-slide', title, themeId: 'charcoal' }
  );
  return { discTitle: 'Reuse Test', themeId: 'charcoal', buttonStyle: 'bar', slides: [slide] };
}

/** The menu VOB dvdauthor wrote, whichever title set it numbered. */
function findMenuVob(videoTsDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(videoTsDir);
  } catch {
    return null;
  }
  const name = entries.find((entry) => /_0\.VOB$/i.test(entry));
  return name ? path.join(videoTsDir, name) : null;
}

app.whenReady().then(async () => {
  console.log('\nBurnhouse reuse\n');

  /*
    A window that stays open for the whole run.

    Electron quits when the last window closes, and rendering a slide opens and
    closes its own offscreen window each time. Without something else open, the
    app would quit between two builds — invisibly, and only when nothing happened
    to reopen a window quickly enough, which is why this showed up as a suite that
    stopped halfway with a success code. The real application always has its main
    window open, so this is the test catching up with reality rather than a
    workaround.
  */
  const keeper = new BrowserWindow({ show: false, width: 400, height: 300 });

  const tools = detectTools({});
  const missing = ['ffmpeg', 'ffprobe', 'dvdauthor', 'spumux'].filter((name) => !tools[name]);

  if (missing.length) {
    skip('reuse the prepared disc', `${missing.join(', ')} not installed on this machine`);
  } else if (!fs.existsSync(FIXTURE)) {
    skip('reuse the prepared disc', `the fixture ${FIXTURE} is missing`);
  } else {
    const root = tmpdir('reuse');
    const info = await probeMod.probeVideo(tools.ffprobe, FIXTURE);

    const videos = [
      { id: 'v1', path: FIXTURE, name: 'Episode One.mp4', menuLabel: 'Episode One', duration: info.duration },
      { id: 'v2', path: FIXTURE, name: 'Episode Two.mp4', menuLabel: 'Episode Two', duration: info.duration },
    ];

    const quiet = { tools, onProgress: () => {}, onLog: () => {}, BrowserWindow };
    /** The same, but pointed at its own working folder. */
    const quietIn = (dir) => ({ ...quiet, workDir: dir });

    let first = null;
    let second = null;
    let snapFirst = null;

    await test('a first build prepares every title', async () => {
      first = await pipeline.prepare(projectWith(root, videos), quietIn(root));
      assertEqual(first.videos.length, 2, 'Both videos should be on the disc');
      assertEqual(first.reusedTitles, 0, 'Nothing can be reused on a first build');
      assertEqual(first.encodedTitles, 2, 'And both should have been encoded');
      assertEqual(first.videoTsDir.includes('VIDEO_TS'), true, 'A VIDEO_TS tree was produced');
      assert(fs.existsSync(path.join(first.videoTsDir, 'VIDEO_TS.IFO')), 'With a real IFO');
      snapFirst = snapshot(first);
      assertEqual(snapFirst.length, 2, 'One VOB per title');
    });

    await test('a second build re-encodes nothing and rewrites nothing', async () => {
      second = await pipeline.prepare(projectWith(root, videos), quietIn(root));
      assertEqual(second.reusedTitles, 2, 'Both titles should have been reused');
      assertEqual(second.encodedTitles, 0, 'And nothing should have been encoded');
      const difference = sameSnapshot(snapFirst, snapshot(second));
      assertEqual(difference, null, `The title files must be untouched: ${difference}`);
    });

    await test('changing the disc name and the slides does not touch the films', async () => {
      const renamed = projectWith(root, videos, {
        discTitle: 'A Different Name',
        deck: {
          discTitle: 'A Different Name',
          themeId: 'library',
          slides: [
            {
              id: 'menu',
              role: 'menu',
              title: 'A Different Name',
              elements: [{ id: 't', kind: 'text', text: 'Now with a subtitle', x: 40, y: 40, width: 400 }],
            },
          ],
        },
      });

      const after = await pipeline.prepare(renamed, quietIn(root));
      assertEqual(after.reusedTitles, 2, 'A renamed disc with new slides is still the same two films');
      assertEqual(after.encodedTitles, 0, 'So nothing should have been re-encoded');
      const difference = sameSnapshot(snapFirst, snapshot(after));
      assertEqual(difference, null, `The title files must be untouched: ${difference}`);
      assertEqual(after.volumeLabel !== first.volumeLabel, true, 'But the disc really did change its name');
    });

    await test('changing one film re-encodes only that film', async () => {
      // The second entry is given a different name, which is what a different
      // file looks like to the cache: same path, different size and timestamp.
      const swapped = path.join(root, 'swapped.mp4');
      fs.copyFileSync(FIXTURE, swapped);
      fs.appendFileSync(swapped, Buffer.alloc(64, 0));

      const changed = projectWith(root, [videos[0], { ...videos[1], path: swapped }]);
      const after = await pipeline.prepare(changed, quietIn(root));

      assertEqual(after.reusedTitles, 1, 'The untouched film should have been kept');
      assertEqual(after.encodedTitles, 1, 'And only the changed one prepared again');

      const before = snapFirst[0];
      const kept = snapshot(after)[0];
      assertEqual(kept.file, before.file, 'The kept title is the same file');
      assertEqual(kept.mtimeMs, before.mtimeMs, 'And it was not rewritten');
    });

    await test('forcing a rebuild prepares everything again', async () => {
      const after = await pipeline.prepare(projectWith(root, videos), { ...quietIn(root), force: true });
      assertEqual(after.reusedTitles, 0, 'Nothing may be reused when a rebuild is forced');
      assertEqual(after.encodedTitles, 2, 'Both titles should have been prepared again');
    });

    await test('a menu page with a sound is built into the disc with it', async () => {
      /*
        The whole feature, end to end: a sound chosen for a page has to reach the
        authored VIDEO_TS as a decodable audio stream. Everything before this
        test checks a piece of it; this checks that a real disc comes out the
        other end with the music in it.
      */
      const root = tmpdir('reuse-sound');
      /*
        WAV rather than MP3: writing an MP3 needs an external library that not
        every ffmpeg build carries, and decoding one needs nothing extra. The
        pipeline suite covers the MP3 case where the build can write one.
      */
      const song = path.join(root, 'menu-song.wav');
      const made = spawnSync(
        tools.ffmpeg,
        [
          '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=8',
          '-c:a', 'pcm_s16le', song,
        ],
        { windowsHide: true }
      );
      assertEqual(made.status, 0, 'Could generate a sound to put on the menu');

      const project = projectWith(root, [
        { id: 'v1', path: FIXTURE, name: 'Episode One.mp4', duration: info.duration },
      ]);
      /*
        A real menu slide, with a button on it.

        The default deck for a project is an empty episode list, which has no
        buttons and so is not a menu page at all — the editor fills it from the
        video list, and a headless build has to do the same to have a page to put
        a sound on.
      */
      project.deck = menuDeck({ title: 'Menu' });
      project.deck.slides[0].audio = { path: song, fileName: 'menu-song.wav', duration: 8 };

      const prepared = await pipeline.prepare(project, quietIn(root));
      const menu = prepared.menus[0];
      assert(menu, 'A menu page was built');
      assert(menu.sound, 'And it kept the sound it was given');
      assertEqual(menu.sound.seconds, 8, 'For as long as the file runs');

      const menuVob = findMenuVob(prepared.videoTsDir);
      assert(menuVob, 'The authored menu VOB is there');

      const probed = await probeMod.probeAudio(tools.ffprobe, menuVob);
      assertEqual(probed.codec, 'ac3', 'And it carries AC-3, the sound a DVD menu may have');
      assertEqual(Number(probed.sampleRate), 48000, 'Resampled to the 48 kHz a DVD requires');
      assert(probed.duration > 5, `And it is not silent: ${probed.duration}s of audio`);
    });

    await test('a sound that has been moved makes the page silent, not the build fail', async () => {
      /*
        A path in a saved project can point at a file that is no longer there —
        an album tidied up, a drive unplugged. Losing the music is a
        disappointment; losing the disc because of it would be a failure, so the
        page falls back to silence and the build carries on.
      */
      const root = tmpdir('reuse-nosound');
      const project = projectWith(root, [
        { id: 'v1', path: FIXTURE, name: 'Episode One.mp4', duration: info.duration },
      ]);
      project.deck = menuDeck({ title: 'Menu' });
      project.deck.slides[0].audio = {
        path: path.join(root, 'gone.wav'),
        fileName: 'gone.wav',
        duration: 10,
      };

      const logs = [];
      const prepared = await pipeline.prepare(project, {
        ...quietIn(root),
        onLog: (line) => logs.push(String(line)),
      });

      assertEqual(prepared.menus.length, 1, 'The disc was still built');
      assert(fs.existsSync(path.join(prepared.videoTsDir, 'VIDEO_TS.IFO')), 'With a real VIDEO_TS');
      assert(
        logs.some((line) => /no longer at/.test(line)),
        `The log should say the sound was missing, got: ${logs.join(' | ')}`
      );

      const menuVob = findMenuVob(prepared.videoTsDir);
      assert(menuVob, 'A menu VOB was still produced');
      const probed = await probeMod.probeAudio(tools.ffprobe, menuVob);
      assertEqual(probed.codec, 'ac3', 'And the page is silent rather than broken');
      assertEqual(Number(probed.sampleRate), 48000, 'Still legal for a DVD menu');
    });

    await test('a source that is already a DVD title is copied, not encoded', async () => {
      /*
        The VOB the build just produced is, by definition, a legal DVD title. Put
        it back in as the source and the pipeline should recognise that and copy
        it — which is the difference between seconds and the length of the film.

        Its own working folder, because a title folder is cleared before it is
        written and this source lives in one.
      */
      const copyRoot = tmpdir('reuse-copy');
      const prepared = await pipeline.prepare(
        projectWith(copyRoot, [
          { id: 'v1', path: snapFirst[0].file, name: 'From a DVD.vob', duration: info.duration },
        ]),
        quietIn(copyRoot)
      );

      assertEqual(prepared.copiedTitles, 1, 'It should have been recognised as already DVD video');
      assertEqual(prepared.encodedTitles, 0, 'So the encoder should not have been involved');
      assertEqual(prepared.reusedTitles, 0, 'And it was prepared, not reused');
      assert(fs.existsSync(path.join(prepared.videoTsDir, 'VIDEO_TS.IFO')), 'And still authored a disc');
    });
  }

  console.log('');
  if (failed) {
    console.log(`${failed} of ${passed + failed} checks failed.`);
    for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
    app.exit(1);
  } else {
    console.log(`All ${passed} checks passed.${skipped ? ` (${skipped} skipped)` : ''}`);
    app.exit(0);
  }
});
