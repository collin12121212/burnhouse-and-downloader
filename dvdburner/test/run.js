'use strict';

/**
 * Burnhouse test suite.
 *
 * Run with `npm test`. Two kinds of test live here:
 *
 *   - Logic tests, which check the rules (bitrate budgets, XML generation,
 *     chapter arithmetic) and run everywhere in under a second.
 *   - Pipeline tests, which actually invoke ffmpeg on generated video and read
 *     the result back with ffprobe to confirm it is spec-legal DVD-Video.
 *
 * The pipeline tests are the ones that matter. Everything else is arithmetic;
 * this is the part that used to crash.
 *
 * Tests that need a tool this machine does not have are reported as SKIP with
 * the reason, never as a pass. A test that silently does nothing is worse than
 * no test at all.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const spec = require('../src/core/dvd_spec');
const deckModel = require('../src/core/deck');
const slideLayout = require('../src/core/slide_layout');
const author = require('../src/core/author');
const encode = require('../src/core/encode');
const probeMod = require('../src/core/probe');
const pipeline = require('../src/core/pipeline');
const { detectTools } = require('../src/core/tools');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function ok(name) {
  passed += 1;
  console.log(`  \u001b[32mPASS\u001b[0m ${name}`);
}

function fail(name, detail) {
  failed += 1;
  failures.push({ name, detail });
  console.log(`  \u001b[31mFAIL\u001b[0m ${name}`);
  if (detail) console.log(`       ${String(detail).split('\n').join('\n       ')}`);
}

function skip(name, reason) {
  skipped += 1;
  console.log(`  \u001b[33mSKIP\u001b[0m ${name} \u2014 ${reason}`);
}

async function test(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, (err && err.stack) || String(err));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Values differ'}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `${message || 'Values differ'}\n  expected: ${expected} (\u00b1${tolerance})\n  actual:   ${actual}`
    );
  }
}

function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

/** Run a command, returning {code, stdout, stderr}. */
function run(file, args, opts = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...opts,
  });
  return {
    code: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error,
  };
}

/**
 * Generate a source clip to work from.
 *
 * Deliberately awkward: 640x360 is not a DVD size, 24 fps is not a DVD frame
 * rate, and 44.1 kHz audio is not the DVD sample rate. A pipeline that only
 * works on already-conformant input is not a pipeline.
 */
function makeFixture(ffmpeg, { name, seconds = 3, size = '640x360', fps = 24, audio = true }) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const out = path.join(FIXTURE_DIR, name);
  if (fs.existsSync(out)) return out;

  const args = [
    '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', `testsrc2=size=${size}:rate=${fps}:duration=${seconds}`,
  ];
  if (audio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`);
  }
  args.push(
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  );
  if (audio) args.push('-c:a', 'aac', '-shortest');
  args.push(out);

  const result = run(ffmpeg, args);
  if (result.code !== 0 || !fs.existsSync(out)) {
    throw new Error(
      `Could not generate the test clip "${name}".\n${result.stderr || (result.error && result.error.message)}`
    );
  }
  return out;
}

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `burnhouse-${label}-`));
}

/**
 * Every file in a disc image's ISO 9660 directory, as "DIR/NAME" -> sector and
 * size. Written from the specification rather than borrowed from the code under
 * test, so the image is checked by something that did not make it.
 */
function isoFileSectors(buf) {
  const out = new Map();
  const walk = (lba, size, prefix) => {
    const dir = buf.subarray(lba * 2048, lba * 2048 + size);
    let off = 0;
    while (off < dir.length) {
      const len = dir[off];
      if (len === 0) {
        off = (Math.floor(off / 2048) + 1) * 2048;
        continue;
      }
      const extent = dir.readUInt32LE(off + 2);
      const dataLength = dir.readUInt32LE(off + 10);
      const isDir = (dir[off + 25] & 2) !== 0;
      const nameLength = dir[off + 32];
      const raw = dir.subarray(off + 33, off + 33 + nameLength);
      off += len;
      if (nameLength === 1 && raw[0] <= 1) continue;
      const name = raw.toString('latin1').replace(/;1$/, '');
      if (isDir) walk(extent, dataLength, `${prefix}${name}/`);
      else out.set(`${prefix}${name}`, { lba: extent, size: dataLength });
    }
  };
  const root = buf.subarray(16 * 2048 + 156);
  walk(root.readUInt32LE(2), root.readUInt32LE(10), '');
  return out;
}

// ---------------------------------------------------------------------------

async function main() {
  const tools = detectTools();
  console.log('\u001b[1mBurnhouse checks\u001b[0m');
  console.log(`  platform   ${process.platform} ${process.arch}`);
  console.log(`  ffmpeg     ${tools.ffmpeg || 'not found'}`);
  console.log(`  ffprobe    ${tools.ffprobe || 'not found'}`);
  console.log(`  dvdauthor  ${tools.dvdauthor || 'not found'}`);
  console.log(`  spumux     ${tools.spumux || 'not found'}`);
  console.log(`  hdiutil    ${tools.hdiutil || 'not found'}`);

  // ---------------------------------------------------------------- spec ---
  section('Disc format rules');

  await test('NTSC and PAL resolve to spec-legal rasters', () => {
    const ntsc = spec.resolveFormat('ntsc');
    assertEqual(ntsc.width, 720, 'NTSC width');
    assertEqual(ntsc.height, 480, 'NTSC height');
    assertClose(ntsc.fps, 29.97, 0.001, 'NTSC frame rate');

    const pal = spec.resolveFormat('pal');
    assertEqual(pal.width, 720, 'PAL width');
    assertEqual(pal.height, 576, 'PAL height');
    assertEqual(pal.fps, 25, 'PAL frame rate');
  });

  await test('GOP sizes stay within what DVD allows', () => {
    // NTSC permits 12, 15 or 18; PAL permits 12 or 15.
    assert([12, 15, 18].includes(spec.resolveFormat('ntsc').gop), 'NTSC GOP must be 12/15/18');
    assert([12, 15].includes(spec.resolveFormat('pal').gop), 'PAL GOP must be 12/15');
  });

  await test('an unknown format is rejected rather than guessed', () => {
    let threw = false;
    try {
      spec.resolveFormat('secam');
    } catch {
      threw = true;
    }
    assert(threw, 'An unknown format should throw, not silently default.');
  });

  await test('bitrate budget never exceeds the DVD program stream limit', () => {
    const cases = [
      { seconds: 60, discType: 'dvd5' },
      { seconds: 1800, discType: 'dvd5' },
      { seconds: 3600, discType: 'dvd5' },
      { seconds: 7200, discType: 'dvd5' },
      { seconds: 10800, discType: 'dvd5' },
    ];
    for (const c of cases) {
      const plan = spec.planBitrate({ ...c, formatId: 'ntsc' });
      assert(
        plan.videoBitrate + plan.audioBitrate <= 10080000,
        `Total ${plan.videoBitrate + plan.audioBitrate} exceeds the 10.08 Mbit/s cap for ${c.seconds}s`
      );
      assert(
        plan.muxrate <= 10080000,
        `Muxrate ${plan.muxrate} exceeds the 10.08 Mbit/s cap for ${c.seconds}s`
      );
      assert(plan.videoBitrate > 0, 'Video bitrate must be positive');
    }
  });

  await test('a short clip gets the maximum sensible quality', () => {
    const plan = spec.planBitrate({ totalSeconds: 120, formatId: 'ntsc' });
    assert(
      plan.videoBitrate >= 9000000,
      `A two minute clip should get near-maximum bitrate, got ${plan.videoBitrate}`
    );
    assert(plan.fits, 'A two minute clip should fit comfortably');
  });

  await test('disc capacity is the real sector count, not the marketing figure', () => {
    /*
      A DVD-5 is 2,295,104 sectors of 2048 bytes = 4,700,372,992 bytes, which is
      the "4.7 GB" on the packaging. That figure is decimal, so the same disc is
      4.38 GiB — and using the GiB number as a byte count, which is what this
      used to do, silently threw away about 320 MB of usable disc.
    */
    assertEqual(spec.DISC_BYTES.dvd5, 2295104 * 2048, 'DVD-5 capacity in bytes');
    assertEqual(spec.DISC_BYTES.dvd9, 4173824 * 2048, 'DVD-9 capacity in bytes');
    assertEqual(
      Math.round((spec.DISC_BYTES.dvd5 / 1e9) * 10) / 10,
      4.7,
      'A DVD-5 has to come out as the 4.7 GB it is sold as'
    );
  });

  await test('the size estimate includes the container, not just the payload', () => {
    const plan = spec.planBitrate({ totalSeconds: 3600, formatId: 'ntsc' });
    const payload = ((plan.videoBitrate + plan.audioBitrate) / 8) * 3600;

    assert(
      plan.estimatedBytes > payload,
      'A finished VOB is bigger than the audio and video inside it'
    );
    const overhead = plan.estimatedBytes / payload;
    assert(
      overhead > 1.02 && overhead < 1.08,
      `The container overhead should be a few per cent, got ${overhead.toFixed(3)}`
    );
    // The same figure is used to decide what fits and to say how big it will be,
    // so a plan that says it fits must not come out over the capacity.
    assert(
      plan.estimatedBytes <= plan.discCapacityBytes,
      'A disc reported as fitting must actually fit'
    );
  });

  await test('a disc that fits leaves room for the structure as well as the films', () => {
    // The IFOs, the menus and the filesystem are not in the estimate, so the
    // reserve has to cover them.
    const capacity = spec.DISC_BYTES.dvd5;
    const plan = spec.planBitrate({ totalSeconds: 90 * 60, formatId: 'ntsc' });
    assertEqual(plan.fits, true, 'Ninety minutes should fit');
    const spare = capacity - plan.estimatedBytes;
    assert(
      spare >= spec.AUTHORING_OVERHEAD_BYTES,
      `Only ${Math.round(spare / 1e6)} MB spare, less than the structure reserve`
    );
  });

  await test('too much material is warned about, not silently mangled', () => {
    // Six hours will not fit on one single-layer disc at decent quality.
    const plan = spec.planBitrate({ totalSeconds: 6 * 3600, formatId: 'ntsc' });
    assertEqual(plan.fits, false, 'Six hours should not be reported as fitting');
    assert(plan.warning && plan.warning.length > 20, 'A warning should be produced');
  });

  await test('frame rate pre-selection is a suggestion, not a decision', () => {
    // 29.97 and 23.976 film both belong on an NTSC disc; 25 and 50 are PAL.
    assertEqual(spec.guessFormatFromProbe({ fps: 29.97 }), 'ntsc');
    assertEqual(spec.guessFormatFromProbe({ fps: 25 }), 'pal');
    assertEqual(spec.guessFormatFromProbe({ fps: 50 }), 'pal');
    assertEqual(spec.guessFormatFromProbe({ fps: 23.976 }), 'ntsc', 'Film goes on NTSC at 29.97');
    // Nothing readable at all should fall back rather than throw.
    assertEqual(spec.guessFormatFromProbe({ fps: 0, height: 0 }), 'ntsc');
    assertEqual(spec.guessFormatFromProbe({}), 'ntsc');
  });

  await test('capacity figures are reported against real disc sizes', () => {
    const plan = spec.planBitrate({ totalSeconds: 3600, formatId: 'ntsc' });
    const pct = spec.usagePercent(plan.estimatedBytes, 'dvd5');
    assert(pct > 50 && pct < 100, `An hour should use most of a DVD-R, got ${pct}%`);
  });

  // ---------------------------------------------------------------- deck ---
  section('The slide deck');

  const sampleVideos = [
    { id: 'v1', name: 'first_clip.mp4', duration: 120, durationLabel: '2m 0s' },
    { id: 'v2', name: 'second_clip.mov', duration: 340, durationLabel: '5m 40s' },
    { id: 'v3', name: 'third_clip.mkv', duration: 95, durationLabel: '1m 35s' },
  ];

  await test('an episode list has one button per video, each playing its own title', () => {
    const slide = deckModel.episodeListSlide(sampleVideos, { title: 'Episodes' });
    const buttons = slide.elements.filter((e) => e.kind === 'button');

    assertEqual(buttons.length, 3, 'One button per video');
    assertEqual(buttons[0].videoId, 'v1', 'First button plays the first video');
    assertEqual(buttons[2].videoId, 'v3', 'Last button plays the last video');
    assertEqual(buttons[0].number, 1, 'Numbering starts at one');
    assertEqual(buttons[2].number, 3, 'Numbering runs in order');

    // Each button must point at a different video, or choosing one would play
    // the wrong episode.
    const targets = new Set(buttons.map((b) => b.videoId));
    assertEqual(targets.size, 3, 'Every button plays a different video');
  });

  await test('an episode list slide is laid out as a menu, to be navigated', () => {
    const slide = deckModel.episodeListSlide(sampleVideos, { title: 'Episodes' });
    assertEqual(slide.role, 'menu', 'An episode list is a menu hub');
    /*
      Only the buttons she put there are on the slide. The layout used to add a
      Back/Next row of its own to any slide it decided was not a hub; that is
      gone, so a page can never grow furniture nobody asked for — and a deck
      saved before that change loses the row too.
    */
    const layout = slideLayout.layoutSlide({ slides: [slide], themeId: 'charcoal' }, slide);
    const buttons = layout.elements.filter((e) => e.kind === 'button');
    assertEqual(buttons.length, sampleVideos.length, 'The layout adds no buttons of its own');
  });

  await test('a full episode list slide keeps every button on the picture', () => {
    // Exactly as many videos as one slide can hold.
    const capacity = deckModel.episodeCapacity();
    const many = Array.from({ length: capacity }, (_, i) => ({
      id: `v${i}`,
      name: `Episode ${i + 1}.mp4`,
      duration: 600,
      durationLabel: '10m',
    }));

    const slide = deckModel.episodeListSlide(many, { title: 'Everything' });
    const layout = slideLayout.layoutSlide({ slides: [slide], themeId: 'charcoal' }, slide);

    assertEqual(layout.buttons.length, capacity, 'Every video got a button');

    for (const button of layout.buttons) {
      const b = button.box;
      assert(b.x >= 0, `button x ${b.x} is off the left`);
      assert(b.y >= 0, `button y ${b.y} is off the top`);
      assert(
        b.x + b.width <= layout.width,
        `button ends at ${b.x + b.width}, past the ${layout.width}px picture`
      );
      assert(
        b.y + b.height <= layout.height,
        `button ends at ${b.y + b.height}, past the ${layout.height}px picture`
      );
    }
  });

  await test('a series longer than one slide is paged across several menus', () => {
    const capacity = deckModel.episodeCapacity();
    const total = capacity + 5;
    const many = Array.from({ length: total }, (_, i) => ({
      id: `v${i}`,
      name: `Episode ${i + 1}.mp4`,
      duration: 600,
      durationLabel: '10m',
    }));

    const slides = deckModel.episodeListSlides(many, { title: 'The Series' });
    assertEqual(slides.length, 2, `Expected two pages for ${total} videos`);

    // Every video must appear exactly once across the pages.
    const listed = slides.flatMap((s) => s.elements.filter((e) => e.kind === 'button').map((e) => e.videoId));
    assertEqual(listed.length, total, 'Every video is listed once');
    assertEqual(new Set(listed).size, total, 'No video is listed twice');

    // Numbering must run continuously, so the numbers on screen still count up.
    const numbers = slides
      .flatMap((s) => s.elements.filter((e) => e.kind === 'button'))
      .map((b) => b.number);
    assertEqual(numbers[0], 1, 'Numbering starts at one');
    assertEqual(numbers[numbers.length - 1], total, 'Numbering ends at the count');

    // Every page must be a menu hub so it is reachable and navigable.
    for (const slide of slides) {
      assertEqual(slide.role, 'menu', 'Each page is a menu hub');
    }

    // And the pages must be labelled so she can tell them apart.
    assert(/1 of 2/.test(slides[0].title), `First page title: ${slides[0].title}`);
    assert(/2 of 2/.test(slides[1].title), `Second page title: ${slides[1].title}`);
  });

  await test('an episode list of nothing still produces a usable slide', () => {
    const slides = deckModel.episodeListSlides([], { title: 'Empty' });
    assertEqual(slides.length, 1, 'One empty slide');
    assertEqual(slides[0].elements.filter((e) => e.kind === 'button').length, 0, 'No buttons');
  });

  await test('a slide over-full of buttons is reported rather than silently broken', () => {
    // The episode-list generator pages itself, so this only happens if someone
    // piles buttons onto a slide by hand. The layout must still say so, because
    // a DVD menu has a hard limit and exceeding it fails at burn time.
    const slide = deckModel.makeSlide({ title: 'Too many', role: 'menu' });
    const over = deckModel.MAX_BUTTONS_PER_SLIDE + 3;
    for (let i = 0; i < over; i += 1) {
      slide.elements.push(
        deckModel.makeButtonElement({ label: `Button ${i + 1}`, videoId: 'v1', x: 40, y: 40 + i * 20, width: 300, height: 18 })
      );
    }

    const layout = slideLayout.layoutSlide({ themeId: 'charcoal', slides: [slide] }, slide);
    assertEqual(layout.buttons.length, over, 'All the buttons are laid out');
    assert(layout.problems.length > 0, 'An over-full slide is reported');
    assert(
      /move some to another slide/i.test(layout.problems[0]),
      `The message should say what to do, got: ${layout.problems[0]}`
    );

    // A slide within the limit must be quiet about it.
    const fine = deckModel.makeSlide({ title: 'Fine', role: 'menu' });
    fine.elements.push(
      deckModel.makeButtonElement({ label: 'One', videoId: 'v1', x: 40, y: 60, width: 300, height: 40 })
    );
    const fineLayout = slideLayout.layoutSlide({ themeId: 'charcoal', slides: [fine] }, fine);
    assertEqual(fineLayout.problems.length, 0, 'A normal slide reports no problems');
  });

  await test('the layout never puts a button on a slide by itself', () => {
    const menu = deckModel.episodeListSlide(sampleVideos, { title: 'Menu' });
    const about = deckModel.makeSlide({ title: 'About', role: 'content' });
    about.elements = [deckModel.makeTextElement({ text: 'Hello' })];
    const second = deckModel.makeSlide({ title: 'Second', role: 'content' });
    second.elements = [deckModel.makeTextElement({ text: 'World' })];

    const deck = { themeId: 'charcoal', slides: [menu, about, second] };
    const layout = slideLayout.layoutDeck(deck);

    /*
      The Back/Next row used to be added here, to every page that was not the
      hub. It is gone, so the buttons on the canvas are exactly the buttons in
      the deck — on every page, not only on the first. That is the whole of what
      "what she sees is what gets burned" means, and it is also why a project
      saved before this change loses the row rather than keeping it.
    */
    for (const [index, entry] of layout.slides.entries()) {
      const burned = entry.elements.filter((e) => e.kind === 'button').length;
      const authored = deck.slides[index].elements.filter((e) => e.kind === 'button').length;
      assertEqual(burned, authored, `Slide ${index} carries only the buttons that are in the deck`);
    }
  });

  await test('a lone slide invents nothing either', () => {
    const only = deckModel.makeSlide({ title: 'Only', role: 'content' });
    only.elements = [deckModel.makeTextElement({ text: 'Alone' })];
    const layout = slideLayout.layoutSlide({ themeId: 'charcoal', slides: [only] }, only);
    assertEqual(
      layout.elements.filter((e) => e.kind === 'button').length,
      0,
      'Nothing to navigate to, and nothing invented for it'
    );
  });

  await test('buttons are rounded to even coordinates for the highlight layer', () => {
    const slide = deckModel.makeSlide({ title: 'Odd', role: 'menu' });
    slide.elements = [
      deckModel.makeButtonElement({ label: 'Odd', videoId: 'v1', x: 41, y: 101, width: 301, height: 55 }),
    ];
    const layout = slideLayout.layoutSlide({ themeId: 'charcoal', slides: [slide] }, slide);
    const buttons = slideLayout.buttonsForAuthoring(layout);

    for (const button of buttons) {
      assertEqual(button.x0 % 2, 0, 'x0 is even');
      assertEqual(button.y0 % 2, 0, 'y0 is even');
      assertEqual(button.x1 % 2, 0, 'x1 is even');
      assertEqual(button.y1 % 2, 0, 'y1 is even');
    }
  });

  await test('text wraps to its own width instead of overflowing', () => {
    const px = deckModel.textSizePx('medium');
    const lines = slideLayout.wrapText(
      'The quick brown fox jumps over the lazy dog and keeps on running well past the edge of the slide',
      300,
      px,
      'plain'
    );
    assert(lines.length > 1, `Expected wrapping, got ${lines.length} line(s)`);

    const maxWidth = 300;
    for (const line of lines) {
      const width = slideLayout.measureText(line, px, 'plain');
      assert(width <= maxWidth + 1, `Line "${line}" measures ${Math.round(width)}px, over ${maxWidth}px`);
    }
    // Nothing may be lost in the wrapping.
    assertEqual(
      lines.join(' ').replace(/\s+/g, ' '),
      'The quick brown fox jumps over the lazy dog and keeps on running well past the edge of the slide',
      'Wrapping must not drop words'
    );
  });

  await test('a single enormous word is broken rather than allowed to overflow', () => {
    const px = deckModel.textSizePx('large');
    const lines = slideLayout.wrapText('Supercalifragilisticexpialidocious', 120, px, 'plain');
    assert(lines.length > 1, 'A word too long for the line should be broken');
    for (const line of lines) {
      assert(
        slideLayout.measureText(line, px, 'plain') <= 121,
        `Broken piece "${line}" is still too wide`
      );
    }
  });

  await test('explicit line breaks in text are honoured', () => {
    const lines = slideLayout.wrapText('One\nTwo\nThree', 400, 16, 'plain');
    assertEqual(lines.join('|'), 'One|Two|Three', 'Newlines start new lines');
  });

  await test('empty text produces one empty line, not a crash', () => {
    assertEqual(slideLayout.wrapText('', 200, 16, 'plain').length, 1, 'Empty text is one blank line');
    assertEqual(slideLayout.wrapText(null, 200, 16, 'plain').length, 1, 'Null text is one blank line');
  });

  await test('every element is kept inside the television-safe area', () => {
    const deck = {
      themeId: 'charcoal',
      slides: [
        deckModel.makeSlide({
          title: 'Edges',
          elements: [
            deckModel.makeTextElement({ text: 'Top left', x: -500, y: -500, width: 200 }),
            deckModel.makeTextElement({ text: 'Bottom right', x: 9999, y: 9999, width: 200 }),
            deckModel.makeButtonElement({ label: 'Huge', videoId: 'v1', x: 0, y: 0, width: 5000, height: 5000 }),
          ],
        }),
      ],
    };

    const clamped = slideLayout.clampDeck(deckModel.normaliseDeck(deck));
    for (const slide of clamped.slides) {
      for (const element of slide.elements) {
        assert(element.x >= deckModel.SAFE_MARGIN - 1, `${element.kind} x=${element.x} is past the left margin`);
        assert(element.y >= deckModel.SAFE_MARGIN - 1, `${element.kind} y=${element.y} is past the top margin`);
        assert(
          element.x + element.width <= deckModel.RASTER.width - deckModel.SAFE_MARGIN + 1,
          `${element.kind} runs past the right margin`
        );
        assert(
          element.y + element.height <= deckModel.RASTER.height - deckModel.SAFE_MARGIN + 1,
          `${element.kind} runs past the bottom margin`
        );
      }
    }
  });

  await test('a deck survives a round trip through settings storage', () => {
    const original = {
      discTitle: 'Round Trip',
      themeId: 'cedar',
      buttonStyle: 'outline',
      slides: [
        deckModel.episodeListSlide(sampleVideos, { title: 'Menu', themeId: 'cedar' }),
        (() => {
          const s = deckModel.makeSlide({ title: 'Extras', role: 'content', themeId: 'cedar' });
          s.elements = [deckModel.makeTextElement({ text: 'Behind the scenes' })];
          return s;
        })(),
      ],
    };

    const normalised = deckModel.normaliseDeck(JSON.parse(JSON.stringify(original)));
    assertEqual(normalised.slides.length, 2, 'Both slides survived');
    assertEqual(normalised.slides[0].elements.length, original.slides[0].elements.length, 'Elements survived');
    assertEqual(normalised.slides[0].role, 'menu', 'Role survived');
    assertEqual(normalised.themeId, 'cedar', 'Theme survived');

    // An element of an unknown kind must be dropped, not crash the app.
    const withJunk = deckModel.normaliseDeck({
      slides: [{ title: 'Junk', elements: [{ kind: 'nonsense' }, { kind: 'text', text: 'Real' }] }],
    });
    assertEqual(withJunk.slides[0].elements.length, 1, 'An unknown element kind is dropped');
    assertEqual(withJunk.slides[0].elements[0].kind, 'text', 'The valid element is kept');
  });

  await test('normalising a deck never changes its identifiers', () => {
    // Everything that refers to a slide or an element refers to it by id: a
    // button's target, the editor's selection, and the mapping between the
    // layout and the pictures being burned. If normalising regenerated ids, the
    // editor would receive a layout describing slides it had never heard of and
    // the preview would draw nothing at all.
    const original = deckModel.episodeListSlide(sampleVideos, { title: 'Identity' });
    const deck = {
      discTitle: 'Identity',
      themeId: 'charcoal',
      slides: [
        original,
        (() => {
          const s = deckModel.makeSlide({ title: 'Second', role: 'content' });
          s.elements = [deckModel.makeTextElement({ id: 'fixed_text', text: 'Hello' })];
          return s;
        })(),
      ],
    };

    const slideIds = deck.slides.map((s) => s.id);
    const elementIds = deck.slides.flatMap((s) => s.elements.map((e) => e.id));

    // Normalise repeatedly: ids must be identical every time.
    let current = deckModel.normaliseDeck(deck);
    for (let i = 0; i < 3; i += 1) current = deckModel.normaliseDeck(current);

    assertEqual(current.slides.map((s) => s.id).join(','), slideIds.join(','), 'Slide ids are stable');
    assertEqual(
      current.slides.flatMap((s) => s.elements.map((e) => e.id)).join(','),
      elementIds.join(','),
      'Element ids are stable'
    );
    assert(current.slides[1].elements[0].id === 'fixed_text', 'A supplied id is kept exactly');

    // And the layout must describe the same slides the editor holds.
    const layout = slideLayout.layoutDeck(current);
    assertEqual(
      layout.slides.map((s) => s.slide.id).join(','),
      slideIds.join(','),
      'The layout reports the same slide ids as the deck'
    );
  });

  await test('a deck with no slides normalises without crashing', () => {
    const empty = deckModel.normaliseDeck({});
    assertEqual(empty.slides.length, 0, 'No slides');
    assert(empty.themeId, 'A default theme is chosen');
    const layout = slideLayout.layoutDeck(empty);
    assertEqual(layout.slides.length, 0, 'Layout of an empty deck is empty');
  });

  await test('a button that points nowhere produces no DVD command', () => {
    const slide = deckModel.makeSlide({ title: 'Broken', role: 'menu' });
    slide.elements = [
      deckModel.makeButtonElement({ label: 'Nothing', x: 40, y: 60, width: 300 }),
      deckModel.makeButtonElement({ label: 'Something', videoId: 'v1', x: 40, y: 130, width: 300 }),
    ];
    const layout = slideLayout.layoutSlide({ themeId: 'charcoal', slides: [slide] }, slide);
    const buttons = slideLayout.buttonsForAuthoring(layout);
    assertEqual(buttons.length, 2, 'Both buttons are laid out');
    assertEqual(buttons[0].videoId, null, 'The broken one has no target');
  });

  // ------------------------------------------------------- menu geometry ---
  section('Menu geometry on a television');

  await test('the anamorphic stretch is what a DVD raster actually has', () => {
    // A player stretches 720x480 to fill a 16:9 screen: 854/720 = 1.185.
    const stretch = slideLayout.rasterStretch(16 / 9);
    assertClose(stretch, 854 / 720, 0.001, 'NTSC widescreen stretch');

    // A 4:3 disc displays the same raster as 640x480, so it is squeezed a little.
    const fourThree = slideLayout.rasterStretch(4 / 3);
    assertClose(fourThree, 640 / 720, 0.001, 'NTSC standard stretch');
  });

  await test('a 16:9 video tile is 3:2 in raster units, so it looks 16:9 on screen', () => {
    // This is the conversion that keeps faces the right shape on the television.
    const rasterAspect = slideLayout.displayAspectToRaster(16 / 9);
    assertClose(rasterAspect, 1.5, 0.01, 'A 16:9 picture must be 3:2 in the raster');

    // And the reverse: the raster aspect of a 4:3 picture is 4:3 divided by the
    // stretch, i.e. narrower than 4:3 in pixels.
    const fourThree = slideLayout.displayAspectToRaster(4 / 3);
    assertClose(fourThree, 1.333 / (854 / 720), 0.01, 'A 4:3 picture in raster units');
    assert(fourThree < 1.333, 'A 4:3 picture is narrower in raster units than on screen');
  });

  await test('a laid-out slide reports the stretch the drawing code needs', () => {
    const slide = deckModel.makeSlide({ title: 'Stretch', role: 'menu' });
    slide.elements = [deckModel.makeTextElement({ text: 'Hello' })];
    const layout = slideLayout.layoutSlide({ themeId: 'charcoal', slides: [slide] }, slide);
    assertClose(layout.stretch, 854 / 720, 0.001, 'Layout carries the stretch factor');
  });

  await test('a video tile laid out for a 16:9 source displays as widescreen', () => {
    // Reproduce what the editor does, then check the shape a television shows.
    const displayAspect = 16 / 9;
    const rasterAspect = slideLayout.displayAspectToRaster(displayAspect);

    // The whole safe height, which is what the editor now uses: a tile no longer
    // stops short to leave room for a row of buttons that is not drawn.
    const maxHeight = deckModel.RASTER.height - deckModel.SAFE_MARGIN * 2;
    const maxWidth = deckModel.RASTER.width - deckModel.SAFE_MARGIN * 2;
    let width = maxWidth;
    let height = Math.round(width / rasterAspect);
    if (height > maxHeight) {
      height = maxHeight;
      width = Math.round(height * rasterAspect);
    }

    const stretch = slideLayout.rasterStretch(displayAspect);
    const onScreen = (width * stretch) / height;
    assertClose(onScreen, displayAspect, 0.05, 'The tile must look 16:9 on the television');

    assert(width <= maxWidth, 'The tile fits the width');
    assert(height <= maxHeight, 'The tile clears the bottom of the picture');
    assert(width % 2 === 0 && height % 2 === 0, 'Even dimensions for clean subpicture pixels');
  });

  // -------------------------------------------------------------- themes ---
  section('Themes');

  // ------------------------------------------------------------ authoring ---
  section('Disc structure XML');

  await test('dvdauthor XML is well formed and names buttons in order', () => {
    const menu = {
      vobPath: '/tmp/menu_buttoned.mpg',
      buttons: [
        { name: 'btn1', command: 'jump title 1;', x0: 48, y0: 100, x1: 672, y1: 160 },
        { name: 'btn2', command: 'jump title 2;', x0: 48, y0: 170, x1: 672, y1: 230 },
        { name: 'btn3', command: 'jump menu 2;', x0: 48, y0: 240, x1: 672, y1: 300 },
      ],
    };

    const xml = author.buildDvdauthorXml({
      videoFormat: 'ntsc',
      titleAspect: '16:9',
      menus: [menu],
      titles: [
        { parts: [{ file: '/tmp/t1/VTS_01_1.VOB', bytes: 1000 }], chapters: [[]] },
        { parts: [{ file: '/tmp/t2/VTS_01_1.VOB', bytes: 1000 }], chapters: [[]] },
      ],
    });

    // A dvdauthor control file is XML; if it does not parse, dvdauthor will
    // reject it and the user sees a cryptic failure.
    assert(/<dvdauthor[\s>]/.test(xml), 'Document element present');
    assert(/<\/dvdauthor>$/.test(xml.trim()), 'Document element closed');
    assert(/<vmgm>/.test(xml), 'VMGM present');
    // Not self-closing: the video manager has to declare the video format, or
    // dvdauthor cannot write its tables and stops with "no video format
    // specified for VMGM".
    assert(
      /<vmgm>[\s\S]*?<video format="NTSC"/.test(xml),
      'The VMGM declares the video format'
    );
    assert(/<titleset>/.test(xml), 'Titleset present');
    assert(/entry="root"/.test(xml), 'The first menu page is the root entry');
    assert(/pause="inf"/.test(xml), 'Menu stills pause indefinitely');

    const buttonCount = (xml.match(/<button /g) || []).length;
    assertEqual(buttonCount, 3, 'All three buttons are emitted');

    // Order is what binds buttons to the rectangles spumux drew.
    const order = [...xml.matchAll(/<button name="([^"]+)"/g)].map((m) => m[1]);
    assertEqual(order.join(','), 'btn1,btn2,btn3', 'Buttons are named in order');

    // Commands must survive intact: one plays a title, one moves to a slide.
    assert(/jump title 1;/.test(xml), 'A title command is present');
    assert(/jump menu 2;/.test(xml), 'A menu navigation command is present');

    const opens = (xml.match(/<pgc[\s>]/g) || []).length;
    const closes = (xml.match(/<\/pgc>/g) || []).length;
    assertEqual(opens, closes, 'Every <pgc> is closed');
  });

  await test('every slide with buttons becomes its own DVD menu page', () => {
    const menus = [1, 2, 3].map((n) => ({
      vobPath: `/tmp/menu_${n}.mpg`,
      buttons: [{ name: 'btn1', command: 'jump title 1;', x0: 40, y0: 60, x1: 400, y1: 110 }],
    }));

    const xml = author.buildDvdauthorXml({
      videoFormat: 'ntsc',
      titleAspect: '16:9',
      menus,
      titles: [{ parts: [{ file: '/tmp/t1.VOB', bytes: 1 }], chapters: [[]] }],
    });

    // Three distinct menu pages, each with its own still.
    const menuPgcs = (xml.match(/<pgc/g) || []).length;
    assertEqual(menuPgcs, 4, 'Three menu pages plus one title');
    for (const n of [1, 2, 3]) {
      assert(xml.includes(`menu_${n}.mpg`), `Menu page ${n} has its own picture`);
    }

    // Only the first may be the root entry, or a player would not know which to
    // show when the disc is inserted.
    const rootCount = (xml.match(/entry="root"/g) || []).length;
    assertEqual(rootCount, 1, 'Exactly one menu page is the entry point');
  });

  await test('a disc with no menu pages still plays on insert', () => {
    const xml = author.buildDvdauthorXml({
      videoFormat: 'ntsc',
      titleAspect: '16:9',
      menus: [],
      titles: [{ parts: [{ file: '/tmp/t1/VTS_01_1.VOB', bytes: 1 }], chapters: [[]] }],
    });
    // The video manager always has a <menus> element, because that is where its
    // video format is declared. What matters is that no menu PAGE exists.
    assert(!/pause="inf"/.test(xml), 'No menu page is present');
    assert(!/entry="root"/.test(xml), 'Nothing is the menu entry point');
    // No `entry` attribute: dvdauthor only accepts "notitle" on a title page,
    // and it builds a first-play chain that jumps to title 1 when none is given.
    assert(!/entry=/.test(xml), 'A title page carries no entry attribute');
    assert(
      /<post> \{ jump title 1; \} <\/post>/.test(xml),
      'The only title loops to itself so the disc never dead-ends'
    );
  });

  await test('no page carries an empty command block', () => {
    // dvdauthor's command parser rejects `{ }` outright, so a page with nothing
    // to do must have no <pre> at all.
    const withMenus = author.buildDvdauthorXml({
      videoFormat: 'ntsc',
      titleAspect: '16:9',
      menus: [{ vobPath: '/tmp/menu.mpg', buttons: [{ name: 'btn1', command: 'jump title 1;' }] }],
      titles: [{ parts: [{ file: '/tmp/t1/VTS_01_1.VOB', bytes: 1 }], chapters: [[]] }],
    });
    assert(!/\{\s*\}/.test(withMenus), `Empty command block present:\n${withMenus}`);
    assert(!/<pre>/.test(withMenus), 'No empty <pre> element');
  });

  await test('the control file only uses attributes dvdauthor accepts', () => {
    const xml = author.buildDvdauthorXml({
      videoFormat: 'ntsc',
      titleAspect: '16:9',
      menus: [{ vobPath: '/tmp/menu.mpg', buttons: [{ name: 'btn1', command: 'jump title 1;' }] }],
      titles: [{ parts: [{ file: '/tmp/t1/VTS_01_1.VOB', bytes: 1 }], chapters: [[]] }],
    });
    // dvdauthor aborts on any attribute it does not recognise, and these are the
    // ones it rejected in turn: the namespace declaration on the root, and `gop`
    // on <video>.
    assert(!/xmlns/.test(xml), 'No xmlns declaration: dvdauthor does not parse namespaces');
    assert(!/gop=/.test(xml), 'No gop attribute on <video>: dvdauthor rejects it');
    assert(/<dvdauthor>/.test(xml), 'The root element is exactly what dvdauthor expects');
    assert(!/jumppad/.test(xml), 'No jumppad: it requires a video-manager menu we do not have');
  });

  await test('the spumux control file names the video format', () => {
    // Without it spumux stops with "no default video format".
    const xml = author.buildSpumuxXml({ buttons: [{ name: 'btn1', x0: 0, y0: 0, x1: 10, y1: 10 }] });
    assert(/<subpictures format="NTSC">/.test(xml), `Format missing:\n${xml.split('\n')[0]}`);
    const pal = author.buildSpumuxXml({
      buttons: [{ name: 'btn1', x0: 0, y0: 0, x1: 10, y1: 10 }],
      videoFormat: 'pal',
    });
    assert(/<subpictures format="PAL">/.test(pal), 'PAL is passed through');
  });

  await test('a title returns to the first menu page when it finishes', () => {
    const xml = author.buildDvdauthorXml({
      videoFormat: 'ntsc',
      titleAspect: '16:9',
      menus: [{ vobPath: '/tmp/m.mpg', buttons: [{ name: 'btn1', command: 'jump title 1;', x0: 0, y0: 0, x1: 10, y1: 10 }] }],
      titles: [{ parts: [{ file: '/tmp/t1.VOB', bytes: 1 }], chapters: [[]] }],
    });
    // Without this the disc is a one-way trip and the remote's menu button is
    // the only way back.
    //
    // `call menu entry root` — not a jump, and not a page number. dvdauthor
    // refuses to jump from the titles domain into the menu domain, and refuses
    // to call a specific menu page: "Cannot call to a specific menu PGC, only an
    // entry". Both messages were how this line was arrived at.
    assert(
      /<post> \{ call menu entry root; \} <\/post>/.test(xml),
      'Playback returns to the menu entry point'
    );
  });

  await test('chapter marks are written in dvdauthor time format', () => {
    assertEqual(author.formatChapterTime(0), '00:00');
    assertEqual(author.formatChapterTime(65), '01:05');
    assertEqual(author.formatChapterTime(3661), '1:01:01');

    const xml = author.buildDvdauthorXml({
      videoFormat: 'ntsc',
      titleAspect: '16:9',
      menus: [],
      titles: [{ parts: [{ file: '/tmp/a.VOB', bytes: 1 }], chapters: [[60, 120]] }],
    });
    assert(/chapters="01:00,02:00"/.test(xml), `Chapter marks missing from XML:\n${xml}`);
  });

  await test('titles containing XML metacharacters cannot break the control file', () => {
    // A video called `Tom & Jerry <Best of>.vob` would otherwise produce invalid
    // XML that dvdauthor rejects with a cryptic message.
    const buttons = [
      { name: 'btn1', command: 'jump title 1;', x0: 40, y0: 60, x1: 400, y1: 110 },
    ];
    const xml = author.buildDvdauthorXml({
      videoFormat: 'ntsc',
      titleAspect: '16:9',
      menus: [{ vobPath: '/tmp/a & b menu.mpg', buttons }],
      titles: [{ parts: [{ file: '/tmp/a & b.VOB', bytes: 1 }], chapters: [[]] }],
    });

    // No raw ampersand or angle bracket may survive anywhere in the document.
    assert(!/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(xml), 'No raw ampersands in the XML');
    assert(/a &amp; b\.VOB/.test(xml), 'File paths are escaped');
    assert(/a &amp; b menu\.mpg/.test(xml), 'Menu picture paths are escaped');

    // Button labels are painted into the slide picture rather than carried in
    // the XML, so the control file holds only names and commands. Asserting it
    // directly also proves no label leaked out unescaped.
    assert(!/<button[^>]*>Tom/.test(xml), 'Labels must not be duplicated into the control file');
    assert(/<button name="btn1">/.test(xml), 'Buttons are matched to spumux by name');

    // The document must actually be well formed. A full parser would be a
    // dependency taken on purely to run a test, so this checks it structurally:
    // every element opened must be closed, and no stray angle bracket may
    // appear inside attribute values.
    const stripped = xml.replace(/<\?xml[^>]*\?>/, '');
    const opens = [...stripped.matchAll(/<([a-zA-Z][\w:-]*)(?=[\s/>])/g)].map((m) => m[1]);
    const selfClosing = [...stripped.matchAll(/<([a-zA-Z][\w:-]*)[^>]*\/>/g)].map((m) => m[1]);
    const closes = [...stripped.matchAll(/<\/([a-zA-Z][\w:-]*)>/g)].map((m) => m[1]);

    const balance = {};
    for (const tag of opens) balance[tag] = (balance[tag] || 0) + 1;
    for (const tag of selfClosing) balance[tag] = (balance[tag] || 0) - 1;
    for (const tag of closes) balance[tag] = (balance[tag] || 0) - 1;

    for (const [tag, count] of Object.entries(balance)) {
      assertEqual(count, 0, `<${tag}> is unbalanced (${count})`);
    }
    assert(opens.length >= 8, 'The document should have real content');
  });

  await test('spumux rectangles are forced even', () => {
    const xml = author.buildSpumuxXml({
      buttons: [{ x0: 47, y0: 101, x1: 671, y1: 159 }],
    });
    assert(/x0="48"/.test(xml), `x0 should round up to even:\n${xml}`);
    assert(/y0="102"/.test(xml), `y0 should round up to even:\n${xml}`);
    assert(/x1="672"/.test(xml), `x1 should round up to even:\n${xml}`);
    assert(/y1="160"/.test(xml), `y1 should round up to even:\n${xml}`);
  });

  await test('chapters are spread across split VOB files, not all dumped in the first', () => {
    // A two hour film split into two 1 GB halves with chapters every 5 minutes.
    const parts = [
      { file: '/tmp/VTS_01_1.VOB', bytes: 1000 },
      { file: '/tmp/VTS_01_2.VOB', bytes: 1000 },
    ];
    const lists = author.distributeChapters(parts, 7200, { intervalSeconds: 300, maxChapters: 24 });
    assertEqual(lists.length, 2, 'One chapter list per part');
    assert(lists[0].length > 0, 'First part has chapters');
    assert(lists[1].length > 0, 'Second part also has chapters');

    // Marks must be in ascending order and inside their own part's duration.
    for (const list of lists) {
      const sorted = list.slice().sort((a, b) => a - b);
      assertEqual(list.join(','), sorted.join(','), 'Chapter marks ascend');
      for (const t of list) {
        assert(t > 0 && t < 3600, `Chapter at ${t}s is outside a one hour part`);
      }
    }
  });

  await test('a disc too short for chapters gets none', () => {
    const lists = author.distributeChapters([{ file: 'a.VOB', bytes: 10 }], 45);
    assertEqual(lists[0].length, 0, 'A 45 second clip needs no chapters');
  });

  await test('disc labels are reduced to what a player can display', () => {
    assertEqual(author.discLabel('Summer 2024'), 'SUMMER_2024');
    assertEqual(author.discLabel('  trip   to   the  coast  '), 'TRIP_TO_THE_COAST');
    assert(author.discLabel('').length > 0, 'An empty title still yields a label');
    assert(author.discLabel('x'.repeat(100)).length <= 32, 'Labels are length limited');
    assert(
      /^[A-Z0-9_.-]+$/.test(author.discLabel('Caf\u00e9 \u2014 Na\u00efve \u4e2d\u6587')),
      `Unexpected characters survived: ${author.discLabel('Caf\u00e9 \u2014 Na\u00efve \u4e2d\u6587')}`
    );
  });

  // ------------------------------------------------------------- ffmpeg ---
  section('Encoding');

  if (!tools.ffmpeg) {
    skip('build the ffmpeg argument list', 'ffmpeg is not installed on this machine');
  } else {
    await test('the ffmpeg argument list is spec-compliant', () => {
      const plan = spec.planBitrate({ totalSeconds: 3600, formatId: 'ntsc' });
      const args = encode.buildEncodeArgs({
        input: '/tmp/in.mp4',
        outputVob: '/tmp/VTS_01_1.VOB',
        plan: { ...plan, hasAudio: true },
        durationSeconds: 3600,
        aspect: { ratio: '16:9' },
      });
      const joined = args.join(' ');

      assert(joined.includes('-c:v mpeg2video'), 'Video codec must be MPEG-2');
      assert(joined.includes('-c:a ac3'), 'Audio codec must be AC-3');
      assert(joined.includes('-ar 48000'), 'Audio must be 48 kHz');
      assert(joined.includes('-f dvd'), 'Must use the DVD muxer');
      assert(joined.includes('-aspect 16:9'), 'Aspect must be signalled');
      assert(!joined.includes('-bf 3'), 'More than two B frames is not DVD-legal');
      // Rate-distortion decisions and the non-linear quantiser are the pro
      // quality flags; both were verified against the shipped ffmpeg.
      assert(joined.includes('-mbd rd'), 'Must use rate-distortion macroblock decisions');
      assert(joined.includes('-non_linear_quant 1'), 'Must use the non-linear quantiser');
      assert(joined.includes('-qmax 28'), 'qmax 28 is the ceiling this build accepts');
      assert(joined.includes('-alternate_scan 1'), 'Must use the alternate scan for interlaced material');
      // The scale filter must letterbox rather than crop, and must convert the
      // HD colour matrix to the SD one. For 16:9 widescreen, it sets the DVD
      // anamorphic sample aspect ratio (32:27) so modern TVs fill the screen.
      assert(joined.includes('min(854,480*dar)') && joined.includes('pad=720:480'), 'Must fit and pad, never crop');
      assert(!/crop=/.test(joined), 'Must not crop the picture');
      assert(joined.includes('setsar=32/27'), 'Must set anamorphic widescreen SAR (32:27)');
      assert(joined.includes('out_range=tv'), 'Must produce broadcast-legal levels');
      assert(joined.includes('out_color_matrix=bt601'), 'Must convert HD colour to the DVD matrix');
      // The peak rate must fit inside the mux rate, or cheap players choke.
      const maxrate = Number(/-maxrate (\d+)/.exec(joined)[1]);
      const muxrate = Number(/-muxrate (\d+)/.exec(joined)[1]);
      assert(maxrate < muxrate, `Peak ${maxrate} must stay under muxrate ${muxrate}`);
    });

    const fixture = makeFixture(tools.ffmpeg, { name: 'fixture_ntsc.mp4' });

    await test('a non-conformant source video is read correctly', () => {
      const info = spawnSync(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', '-i', fixture], { encoding: 'utf8', windowsHide: true });
      assertEqual(info.status, 0, 'ffprobe should read the generated fixture');
    });

    await test('a weird source encodes to spec-legal DVD video', async () => {
      const dir = tmpdir('encode');
      const outputVob = path.join(dir, 'VTS_01_1.VOB');
      const plan = spec.planBitrate({ totalSeconds: 3, formatId: 'ntsc' });

      // A bright, colourful source so the encoded frame is clearly not black at
      // the edges — that is how the "does it fill the screen" check below works.
      const brightFixture = path.join(dir, 'bright.mp4');
      const madeBright = run(tools.ffmpeg, [
        '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=0xcccccc:s=1280x720:r=30:d=3',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        brightFixture,
      ]);
      assertEqual(madeBright.code, 0, 'Could make a bright 16:9 test clip');

      await encode.encodeTitle({
        ffmpegPath: tools.ffmpeg,
        input: brightFixture,
        outputVob,
        plan: { ...plan, hasAudio: false },
        durationSeconds: 3,
        aspect: { ratio: '16:9' },
      });

      assert(fs.existsSync(outputVob), 'A VOB was produced');
      assert(fs.statSync(outputVob).size > 1000, 'The VOB is not empty');

      const info = await probeMod.probeVideo(tools.ffprobe, outputVob);
      assertEqual(info.width, 720, 'Width must be 720');
      assertEqual(info.height, 480, 'Height must be 480 for NTSC');
      assertClose(info.fps, 29.97, 0.05, 'Frame rate must be 29.97');
      assertEqual(info.videoCodec, 'mpeg2video', 'Video must be MPEG-2');

      /*
        A 16:9 source must fill the whole 720x480 frame — that is what makes it
        play full-screen on a widescreen television. If it were squeezed into a
        square-pixel intermediate and padded, black bars would appear down the
        sides and the film would play as a narrow strip.
      */
      const frame = path.join(dir, 'frame.raw');
      const grab = run(tools.ffmpeg, [
        '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-i', outputVob, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', frame,
      ]);
      assertEqual(grab.code, 0, 'Could read the encoded frame back');

      const pixels = fs.readFileSync(frame);
      assertEqual(pixels.length, 720 * 480, 'Raw frame is the expected size');
      const rowStart = 240 * 720;
      let left = 0;
      for (let i = 0; i < 40; i += 1) left += pixels[rowStart + i];
      left /= 40;
      assert(
        left > 40,
        `The left edge of the encoded film is black (${left.toFixed(0)}), so a 16:9 ` +
          `video does not fill the frame and will not play full-screen.`
      );

      fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('a portrait source is pillarboxed, not cropped', async () => {
      const portrait = makeFixture(tools.ffmpeg, {
        name: 'fixture_portrait.mp4',
        size: '360x640',
        fps: 30,
      });
      const dir = tmpdir('portrait');
      const outputVob = path.join(dir, 'VTS_01_1.VOB');
      const plan = spec.planBitrate({ totalSeconds: 3, formatId: 'ntsc' });

      await encode.encodeTitle({
        ffmpegPath: tools.ffmpeg,
        input: portrait,
        outputVob,
        plan: { ...plan, hasAudio: true },
        durationSeconds: 3,
        aspect: { ratio: '4:3' },
      });

      const info = await probeMod.probeVideo(tools.ffprobe, outputVob);
      assertEqual(info.width, 720, 'Still 720 wide after pillarboxing');
      assertEqual(info.height, 480, 'Still 480 tall');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('PAL output is 576 lines at 25 fps', async () => {
      const dir = tmpdir('pal');
      const outputVob = path.join(dir, 'VTS_01_1.VOB');
      const plan = spec.planBitrate({ totalSeconds: 3, formatId: 'pal' });

      await encode.encodeTitle({
        ffmpegPath: tools.ffmpeg,
        input: fixture,
        outputVob,
        plan: { ...plan, hasAudio: true },
        durationSeconds: 3,
        aspect: { ratio: '16:9' },
      });

      const info = await probeMod.probeVideo(tools.ffprobe, outputVob);
      assertEqual(info.height, 576, 'PAL height');
      assertEqual(info.width, 720, 'PAL width');
      assertClose(info.fps, 25, 0.01, 'PAL frame rate');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('a source with no audio still produces a playable title', async () => {
      const silent = makeFixture(tools.ffmpeg, {
        name: 'fixture_silent.mp4',
        audio: false,
        fps: 25,
      });
      const dir = tmpdir('silent');
      const outputVob = path.join(dir, 'VTS_01_1.VOB');
      const plan = spec.planBitrate({ totalSeconds: 3, formatId: 'ntsc' });

      // hasAudio:false replicates the silent-source path in the pipeline.
      await encode.encodeTitle({
        ffmpegPath: tools.ffmpeg,
        input: silent,
        outputVob,
        plan: { ...plan, hasAudio: false },
        durationSeconds: 3,
        aspect: { ratio: '16:9' },
      });

      assert(fs.existsSync(outputVob), 'A silent title still encodes');
      const info = await probeMod.probeVideo(tools.ffprobe, outputVob);
      // Some players refuse a title with no audio, so silence is mixed in by
      // the encode itself rather than by a second pass over the file.
      assertEqual(info.hasAudio, true, 'The title carries a sound track');
      assertEqual(info.audioCodec, 'ac3', 'Of the kind a DVD carries');
      assert(Math.abs(info.duration - 3) < 0.5, `And it lasts as long as the picture, got ${info.duration}`);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    /*
      Every source frame reaches the disc once, and only once.

      Measured on the filter chain itself, before any compression, by hashing
      every frame it produces. The old chain interlaced everything, and the
      interlace filter builds each output frame from two input frames — so a 30p
      clip came out at 15 frames a second and `-r` doubled each one back: every
      frame repeated, and on a television the fields of each pair played twice,
      stepping backwards half the time. A 30p source must now produce no repeats
      at all, and a 60p source one interlaced frame per pair of source frames.
    */
    const frameHashes = (input, motion) => {
      const vf = encode.buildVideoFilter({ width: 720, height: 480, aspect: '16:9', motion });
      const r = run(tools.ffmpeg, ['-v', 'error', '-i', input, '-an', '-vf', vf, '-f', 'framemd5', '-']);
      return r.stdout.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
    };
    const repeats = (hashes) => hashes.filter((h, i) => i > 0 && h === hashes[i - 1]).length;

    await test('a 30 frame-a-second video keeps every frame', async () => {
      const clip = makeFixture(tools.ffmpeg, { name: 'fixture_30p.mp4', fps: 30, seconds: 2 });
      const info = await probeMod.probeVideo(tools.ffprobe, clip);
      assertEqual(encode.motionFor(info), 'progressive', 'It is carried as progressive frames');
      const hashes = frameHashes(clip, 'progressive');
      assert(Math.abs(hashes.length - 60) <= 1, `Two seconds is 60 frames, got ${hashes.length}`);
      assertEqual(repeats(hashes), 0, 'No frame is shown twice');
    });

    await test('a 60 frame-a-second video becomes true interlaced video', async () => {
      const clip = makeFixture(tools.ffmpeg, { name: 'fixture_60p.mp4', fps: 60, seconds: 2 });
      const info = await probeMod.probeVideo(tools.ffprobe, clip);
      assertEqual(encode.motionFor(info), 'interlaced', 'Each field gets its own moment');
      const hashes = frameHashes(clip, 'interlaced');
      assert(Math.abs(hashes.length - 60) <= 1, `Two seconds is 60 interlaced frames, got ${hashes.length}`);
      assertEqual(repeats(hashes), 0, 'No frame is shown twice');
    });

    await test('progressive video is not put through interlaced motion search', () => {
      const plan = spec.planBitrate({ totalSeconds: 3600, formatId: 'ntsc' });
      const build = (fps) =>
        encode.buildEncodeArgs({
          input: 'in.mp4',
          outputVob: 'out.VOB',
          plan: { ...plan, hasAudio: true, probe: { fps, width: 1920, height: 1080 } },
          durationSeconds: 60,
          aspect: { ratio: '16:9' },
        }).join(' ');
      const thirty = build(29.97);
      // 3.7 times slower for the same picture, measured — and pointless on
      // frames whose two fields are the same instant.
      assert(!thirty.includes('ilme'), 'No interlaced motion search for 30p');
      assert(thirty.includes('-alternate_scan 1'), 'Still marked interlaced, as a DVD must be');
      assert(thirty.includes('setfield=bff') && !thirty.includes('interlace='), 'Labelled, not re-woven');
      const sixty = build(59.94);
      assert(sixty.includes('+ildct+ilme'), 'Interlaced coding for interlaced pictures');
      assert(sixty.includes('interlace=scan=bff'), 'Bottom field first on NTSC');
    });

    /*
      The copy path, end to end and against real ffmpeg.

      A title produced by this encoder is, by definition, a legal DVD title — so
      feeding it back in must take the copy branch, and the picture inside the
      result must be byte-identical to the picture that went in. That identity is
      the whole claim being made: same picture, no second generation, no time
      spent. Anything that quietly re-encoded would still probe as MPEG-2 at
      720x480 and fail here.
    */
    await test('an existing DVD title is copied, not encoded again', async () => {
      const dir = tmpdir('remux');

      const first = path.join(dir, 'VTS_01_1.VOB');
      // A long-disc plan, so the source's own bitrate sits comfortably inside
      // the budget of the disc it is about to go on.
      const sourcePlan = spec.planBitrate({ totalSeconds: 5400, formatId: 'ntsc' });
      await encode.encodeTitle({
        ffmpegPath: tools.ffmpeg,
        input: fixture,
        outputVob: first,
        plan: { ...sourcePlan, hasAudio: true },
        durationSeconds: 3,
        aspect: { ratio: '16:9' },
      });

      const sourceInfo = await probeMod.probeVideo(tools.ffprobe, first);
      assertEqual(sourceInfo.videoCodec, 'mpeg2video', 'The source really is MPEG-2');
      assertEqual(sourceInfo.displayAspect, '16:9', 'And it says so in its own stream');
      assert(sourceInfo.bitrate > 0, `Its bitrate must be readable (got ${sourceInfo.bitrate})`);

      const second = path.join(dir, 'copy.VOB');
      const result = await encode.encodeTitle({
        ffmpegPath: tools.ffmpeg,
        input: first,
        outputVob: second,
        // A short disc, so there is plainly room for it.
        plan: { ...spec.planBitrate({ totalSeconds: 3, formatId: 'ntsc' }), hasAudio: true, probe: sourceInfo },
        durationSeconds: 3,
        aspect: { ratio: '16:9' },
      });

      assertEqual(result.mode, 'copy', `It should have been copied, but: ${result.copyReason}`);
      assert(fs.existsSync(second), 'A VOB came out the other side');

      const copied = await probeMod.probeVideo(tools.ffprobe, second);
      assertEqual(copied.width, 720, 'Still 720 wide');
      assertEqual(copied.height, 480, 'Still 480 tall');
      assertEqual(copied.videoCodec, 'mpeg2video', 'Still MPEG-2');
      assertEqual(copied.displayAspect, '16:9', 'Still the shape it was');
      assertEqual(copied.hasAudio, true, 'And it still has its sound');
      assertEqual(copied.audioCodec, 'ac3', 'Which is still AC-3');
      assertEqual(Number(copied.audioSampleRate), 48000, 'At 48 kHz');

      // The picture, stream for stream. This is the assertion that proves the
      // encoder was not involved: a re-encode cannot reproduce these bytes.
      const digest = (file) => {
        const out = spawnSync(
          tools.ffmpeg,
          ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-c:v', 'copy', '-f', 'md5', '-'],
          { encoding: 'utf8', windowsHide: true }
        );
        return String(out.stdout || '').trim();
      };
      const before = digest(first);
      const after = digest(second);
      assert(/^MD5=/.test(before), `Could not digest the source picture (${before})`);
      assertEqual(after, before, 'The picture must be identical, bit for bit');

      fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('the menu still encodes to a legal single-frame stream', async () => {
      // A 720x480 PNG with recognisable blocks, standing in for the canvas.
      const dir = tmpdir('menustill');
      const png = path.join(dir, 'menu.png');
      const makePng = run(tools.ffmpeg, [
        '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=0x1c1b19:s=720x480',
        '-frames:v', '1', png,
      ]);
      assertEqual(makePng.code, 0, 'Could generate a test menu picture');

      const still = path.join(dir, 'menu_still.mpg');
      const args = author.buildMenuStillArgs({ inputPng: png, outputVob: still, videoFormat: 'ntsc' });
      const result = run(tools.ffmpeg, args);
      assertEqual(result.code, 0, `Menu still encode failed:\n${result.stderr}`);
      assert(fs.existsSync(still), 'Menu still was written');

      const info = await probeMod.probeVideo(tools.ffprobe, still);
      assertEqual(info.width, 720, 'Menu width');
      assertEqual(info.height, 480, 'Menu height');
      assertEqual(info.videoCodec, 'mpeg2video', 'Menu must be MPEG-2');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('a menu page with sound becomes a motion menu that is still small', async () => {
      /*
        The page's sound replaces the silent track, and the still is held for as
        long as the sound runs. Two things have to be true or the feature is worse
        than not having it: the audio has to survive into the menu VOB as
        something a DVD player will decode, and the held still must not be encoded
        all-intra — at the maximum still bitrate that is nine megabits *per frame*,
        which for a minute of music would be hundreds of megabytes of disc for a
        picture that never changes.

        The size check is the guard on the second: an all-intra encode of twelve
        seconds is around fifteen megabytes, and this must be a small fraction of
        that.
      */
      const dir = tmpdir('menusound');
      const png = path.join(dir, 'menu.png');
      const madePng = run(tools.ffmpeg, [
        '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=0x1c1b19:s=720x480',
        '-frames:v', '1', png,
      ]);
      assertEqual(madePng.code, 0, 'Could generate a test menu picture');

      /*
        A real sound file, in a shape no DVD would accept as it stands: 44.1 kHz
        stereo, which has to be resampled to the 48 kHz a DVD requires.

        WAV rather than MP3 deliberately. Encoding an MP3 needs an external
        library that not every ffmpeg build carries — the bundled one on the Mac
        included — and a test that only passes where that happens to be present is
        worse than no test. Decoding an MP3 needs nothing extra, and that is
        checked separately below.
      */
      const song = path.join(dir, 'song.wav');
      const madeSong = run(tools.ffmpeg, [
        '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=12',
        '-c:a', 'pcm_s16le', song,
      ]);
      assertEqual(madeSong.code, 0, 'Could generate a test sound');
      assert(fs.statSync(song).size > 1000, 'The test sound has content');

      const menuVob = path.join(dir, 'menu_sound.mpg');
      const args = author.buildMenuStillArgs({
        inputPng: png,
        outputVob: menuVob,
        videoFormat: 'ntsc',
        audioPath: song,
        seconds: 12,
      });
      const encoded = run(tools.ffmpeg, args);
      assertEqual(encoded.code, 0, `Menu with sound failed:\n${encoded.stderr}`);

      const info = await probeMod.probeVideo(tools.ffprobe, menuVob);
      assertEqual(info.width, 720, 'Still a DVD raster');
      assertEqual(info.height, 480, 'Still 480 lines');
      assertEqual(info.videoCodec, 'mpeg2video', 'Still MPEG-2');
      assertEqual(info.hasAudio, true, 'The menu now carries a sound track');
      assertEqual(info.audioCodec, 'ac3', 'Which is AC-3, the codec a DVD menu may carry');
      assertEqual(Number(info.audioSampleRate), 48000, 'At the 48 kHz a DVD requires');

      const bytes = fs.statSync(menuVob).size;
      assert(
        bytes < 3 * 1024 * 1024,
        `A twelve-second menu took ${(bytes / 1024 / 1024).toFixed(1)} MB, which means the ` +
          `still is being encoded all-intra at the full bitrate for every frame.`
      );

      fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('the sound of a menu page is read from the file it names', async () => {
      const dir = tmpdir('audioprobe');
      const song = path.join(dir, 'tune.wav');
      const made = run(tools.ffmpeg, [
        '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=7',
        '-c:a', 'pcm_s16le', song,
      ]);
      assertEqual(made.code, 0, 'Could generate a test sound');

      const info = await probeMod.probeAudio(tools.ffprobe, song);
      assertEqual(info.codec, 'pcm_s16le', 'The codec is read');
      assert(Number(info.channels) >= 1, 'So are the channels');
      assertClose(info.duration, 7, 0.5, 'And the length, which decides how long the page runs');

      // A file with no sound in it must give a clear reason, not a length of
      // zero that would silently make the page run for the maximum.
      const picture = path.join(dir, 'notsound.png');
      run(tools.ffmpeg, [
        '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=64x64', '-frames:v', '1', picture,
      ]);
      let failed = '';
      try {
        await probeMod.probeAudio(tools.ffprobe, picture);
      } catch (err) {
        failed = String(err.message || err);
      }
      assert(/no sound/i.test(failed), `A picture should be refused as a sound, got: ${failed}`);

      fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('an MP3 chosen as a menu sound is read and used', async () => {
      /*
        What she will actually pick most of the time.

        Conditional on purpose: writing an MP3 needs an external library that
        some ffmpeg builds do not carry, and this must not fail a build on a
        machine that simply lacks it. Decoding an MP3 needs nothing extra, which
        is the half that matters here — and if this ffmpeg cannot encode one, it
        says so rather than passing quietly.
      */
      const dir = tmpdir('mp3sound');
      const song = path.join(dir, 'tune.mp3');
      const made = run(tools.ffmpeg, [
        '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=5',
        '-c:a', 'libmp3lame', '-b:a', '128k', song,
      ]);

      if (made.code !== 0 || !fs.existsSync(song)) {
        skip('an MP3 chosen as a menu sound', 'this ffmpeg cannot write MP3');
      } else {
        const info = await probeMod.probeAudio(tools.ffprobe, song);
        assertEqual(info.codec, 'mp3', 'The MP3 is recognised as sound');
        assertClose(info.duration, 5, 0.5, 'With its length');

        const png = path.join(dir, 'menu.png');
        run(tools.ffmpeg, [
          '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'color=c=0x1c1b19:s=720x480', '-frames:v', '1', png,
        ]);

        const menuVob = path.join(dir, 'menu.mp3sound.mpg');
        const encoded = run(
          tools.ffmpeg,
          author.buildMenuStillArgs({
            inputPng: png,
            outputVob: menuVob,
            videoFormat: 'ntsc',
            audioPath: song,
            seconds: 5,
          })
        );
        assertEqual(encoded.code, 0, `A menu with an MP3 failed:\n${encoded.stderr}`);

        const menu = await probeMod.probeVideo(tools.ffprobe, menuVob);
        assertEqual(menu.audioCodec, 'ac3', 'And it comes out of the menu as AC-3');
        assertEqual(Number(menu.audioSampleRate), 48000, 'At 48 kHz, resampled from 44.1');
      }

      fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('the menu fills the whole frame instead of being pillarboxed', async () => {
      /*
        The menu design is drawn on the DVD raster already, so it must be
        labelled anamorphic and left alone. An earlier version scaled it into a
        square-pixel intermediate and padded it, which pillarboxed the design:
        the menu played as a narrow card with black bars down each side instead
        of filling a widescreen television.

        This is checked on real encoded pixels, because that is the only place
        the bug is visible — the PNG on disk looks perfectly correct.
      */
      const dir = tmpdir('menufill');
      const png = path.join(dir, 'grey.png');
      // A mid-grey design: any pillarboxing shows up as pure black at the edges.
      const makePng = run(tools.ffmpeg, [
        '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=0x808080:s=720x480',
        '-frames:v', '1', png,
      ]);
      assertEqual(makePng.code, 0, 'Could generate a grey menu picture');

      const still = path.join(dir, 'grey.mpg');
      const result = run(
        tools.ffmpeg,
        author.buildMenuStillArgs({ inputPng: png, outputVob: still, videoFormat: 'ntsc' })
      );
      assertEqual(result.code, 0, `Menu still encode failed:\n${result.stderr}`);

      // Sample the encoded frame's left and right edges against its centre.
      const frame = path.join(dir, 'frame.png');
      const grab = run(tools.ffmpeg, [
        '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-i', still, '-frames:v', '1', frame,
      ]);
      assertEqual(grab.code, 0, 'Could read the encoded menu frame back');

      const width = 720;
      const height = 480;
      const raw = path.join(dir, 'frame.raw');
      const toRaw = run(tools.ffmpeg, [
        '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-i', frame, '-pix_fmt', 'gray', '-f', 'rawvideo', raw,
      ]);
      assertEqual(toRaw.code, 0, 'Could convert the frame to raw pixels');

      const pixels = fs.readFileSync(raw);
      assertEqual(pixels.length, width * height, 'Raw frame is the expected size');

      const row = Math.floor(height / 2);
      const rowStart = row * width;
      let left = 0;
      let centre = 0;
      for (let i = 0; i < 40; i += 1) left += pixels[rowStart + i];
      for (let i = 340; i < 380; i += 1) centre += pixels[rowStart + i];
      left /= 40;
      centre /= 40;

      assert(
        left > 40,
        `The left edge of the menu is black (${left.toFixed(0)}), so the design is ` +
          `pillarboxed and will not fill a widescreen television.`
      );
      assert(
        Math.abs(left - centre) < 24,
        `The left edge (${left.toFixed(0)}) does not match the centre (${centre.toFixed(0)}), ` +
          `so the design is not covering the frame evenly.`
      );

      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  // ------------------------------------------------------------ full disc ---
  section('Full disc');

  if (!tools.ffmpeg) {
    skip('author a complete VIDEO_TS tree', 'ffmpeg is not installed');
  } else if (!tools.dvdauthor) {
    skip(
      'author a complete VIDEO_TS tree',
      'dvdauthor is not installed on this machine (it is bundled into the macOS build)'
    );
  } else {
    await test('a complete VIDEO_TS tree with a menu page is produced', async () => {
      const dir = tmpdir('disc');
      const titleDir = path.join(dir, 'titles', 'title_1');
      // The pipeline creates this when it prepares a title; the test has to as
      // well, or ffmpeg has nowhere to write.
      fs.mkdirSync(titleDir, { recursive: true });
      const outputVob = path.join(titleDir, 'VTS_01_1.VOB');
      const plan = spec.planBitrate({ totalSeconds: 3, formatId: 'ntsc' });

      // Its own fixture: the one in the encoding section is scoped to that
      // block, and this test never used to run, so the reference went unnoticed.
      const clip = makeFixture(tools.ffmpeg, { name: 'disc_source.mp4' });

      await encode.encodeTitle({
        ffmpegPath: tools.ffmpeg,
        input: clip,
        outputVob,
        plan: { ...plan, hasAudio: true },
        durationSeconds: 3,
        aspect: { ratio: '16:9' },
      });

      // A real menu page: a genuine one-frame MPEG-2 still, built the same way
      // the pipeline builds it. A menu with no button would not be a menu, so
      // the button rectangle is supplied as well.
      const menuDir = path.join(dir, 'menu');
      fs.mkdirSync(menuDir, { recursive: true });
      const menuPng = path.join(menuDir, 'slide.png');
      const makePng = run(tools.ffmpeg, [
        '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=0x1c1b19:s=720x480',
        '-frames:v', '1', menuPng,
      ]);
      assertEqual(makePng.code, 0, 'Could generate a menu picture');

      const menuVob = path.join(menuDir, 'menu_still.mpg');
      const still = run(
        tools.ffmpeg,
        author.buildMenuStillArgs({ inputPng: menuPng, outputVob: menuVob, videoFormat: 'ntsc' })
      );
      assertEqual(still.code, 0, `Menu still encode failed:\n${still.stderr}`);

      /*
        The buttons have to be multiplexed into the menu VOB by spumux before
        dvdauthor is run — that is how dvdauthor learns the button rectangles,
        by reading them back out of the subpicture stream. Handing it a menu with
        no subpicture stream fails with "Partial sector read".

        This is the same order the real pipeline uses, so this test exercises the
        actual sequence rather than an approximation of it.
      */
      const menuButtons = [{ name: 'btn1', x0: 40, y0: 60, x1: 400, y1: 110 }];
      const spumuxXml = author.buildSpumuxXml({
        buttons: menuButtons,
        navigation: { btn1: { up: 'btn1', down: 'btn1', left: 'btn1', right: 'btn1' } },
        videoFormat: 'ntsc',
      });
      const spumuxXmlPath = path.join(menuDir, 'menu_buttons.xml');
      fs.writeFileSync(spumuxXmlPath, spumuxXml, 'utf8');

      const buttonedVob = path.join(menuDir, 'menu_buttoned.mpg');
      // The control file is the only argument; the video goes in on stdin.
      const spumux = spawnSync(tools.spumux, [spumuxXmlPath], {
        input: fs.readFileSync(menuVob),
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      });
      assertEqual(
        spumux.status,
        0,
        `spumux failed:\n${String(spumux.stderr || '').slice(-600)}`
      );
      fs.writeFileSync(buttonedVob, spumux.stdout);
      assert(fs.statSync(buttonedVob).size > 1000, 'The buttoned menu has content');

      const parts = encode.listTitleParts(titleDir).map((file) => ({ file, bytes: fs.statSync(file).size }));

      const xml = author.buildDvdauthorXml({
        videoFormat: 'ntsc',
        titleAspect: '16:9',
        menus: [
          {
            vobPath: buttonedVob,
            buttons: [{ name: 'btn1', command: 'jump title 1;', x0: 40, y0: 60, x1: 400, y1: 110 }],
          },
        ],
        titles: [{ parts, chapters: parts.map(() => []), nextTitle: null }],
      });

      const result = await author.runDvdauthor({ dvdauthorPath: tools.dvdauthor, xml, workDir: dir });
      assert(fs.existsSync(path.join(result.videoTsDir, 'VIDEO_TS.IFO')), 'VIDEO_TS.IFO exists');

      const files = fs.readdirSync(result.videoTsDir);
      assert(files.filter((f) => f.endsWith('.IFO')).length >= 1, 'At least one IFO was written');
      // A menu lives in the menu domain, which is the `_0` VOB of a title set.
      assert(
        files.some((f) => /VTS_01_0\.VOB$/i.test(f)),
        `The menu domain VOB is present, found: ${files.join(', ')}`
      );
      assert(
        files.some((f) => /VTS_01_1\.VOB$/i.test(f)),
        `The title domain VOB is present, found: ${files.join(', ')}`
      );

      /*
        And the disc image of it puts every file where the IFOs say it is.

        A set-top player finds the title set and the menu by the sector numbers
        written in the IFOs, not by the filesystem. Checked here by reading the
        finished image's own directory for each file's sector and comparing it
        with what VIDEO_TS.IFO and VTS_01_0.IFO claim.
      */
      const dvdImage = require('../src/core/dvd_image');
      const iso = path.join(dir, 'disc.iso');
      const made = await dvdImage.writeDvdImage({ sourceDir: dir, outputIso: iso, volumeLabel: 'TEST DISC' });
      assertEqual(made.dvdCompliant, true, 'The IFOs were read and followed');
      const placed = isoFileSectors(fs.readFileSync(iso));
      const at = (name) => placed.get(`VIDEO_TS/${name}`);
      const vmg = fs.readFileSync(path.join(result.videoTsDir, 'VIDEO_TS.IFO'));
      const vts = fs.readFileSync(path.join(result.videoTsDir, 'VTS_01_0.IFO'));
      const ttSrpt = vmg.readUInt32BE(0xc4) * 2048;
      assertEqual(
        at('VTS_01_0.IFO').lba - at('VIDEO_TS.IFO').lba,
        vmg.readUInt32BE(ttSrpt + 8 + 8),
        'The title set starts where the title table says'
      );
      assertEqual(at('VTS_01_0.VOB').lba - at('VTS_01_0.IFO').lba, vts.readUInt32BE(0xc0), 'The menu is where the title set says');
      assertEqual(at('VTS_01_1.VOB').lba - at('VTS_01_0.IFO').lba, vts.readUInt32BE(0xc4), 'The film is where the title set says');
      const image = fs.readFileSync(iso);
      for (const name of files) {
        const original = fs.readFileSync(path.join(result.videoTsDir, name));
        const entry = at(name);
        assertEqual(entry.size, original.length, `${name} has its full length`);
        assert(image.subarray(entry.lba * 2048, entry.lba * 2048 + original.length).equals(original), `${name} is intact`);
      }

      fs.rmSync(dir, { recursive: true, force: true });
    });

    // ------------------------------------------------------ menu page rules ---
    section('Building the menu pages');

    /*
      A stand-in for the window that draws slides.

      `buildMenus` takes BrowserWindow as an argument precisely so this can be
      done without one: the only things the renderer is asked for are a PNG of
      each slide, and this answers with one. It means the rules about which
      slides become pages — and when to refuse the disc altogether — are checked
      here, in a plain Node process, rather than only through the interface.
    */
    function stubWindow(pngBase64) {
      return class {
        constructor() {
          this.webContents = {
            executeJavaScript: async () => ({
              ok: true,
              dataUrl: `data:image/png;base64,${pngBase64}`,
            }),
          };
        }
        async loadFile() {}
        destroy() {}
      };
    }

    await test('a page a button points at is built, even with nothing on it', async () => {
      const dir = tmpdir('pages');
      const png = path.join(dir, 'slide.png');
      fs.mkdirSync(dir, { recursive: true });
      const made = run(tools.ffmpeg, [
        '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=0x1c1b19:s=720x480', '-frames:v', '1', png,
      ]);
      assertEqual(made.code, 0, 'Could generate a test menu picture');
      const pngBase64 = fs.readFileSync(png).toString('base64');

      const frontId = 'slide_front';
      const deck = {
        discTitle: 'Pages',
        themeId: 'charcoal',
        slides: [
          {
            id: frontId, title: 'Front', role: 'menu', themeId: 'charcoal',
            elements: [
              { id: 'w', kind: 'text', text: 'Welcome', x: 48, y: 60, width: 400, height: 50 },
            ],
          },
          {
            id: 'slide_second', title: 'Second', role: 'content', themeId: 'charcoal',
            elements: [
              { id: 'p', kind: 'image', x: 100, y: 150, width: 260, height: 190, targetSlideId: frontId },
            ],
          },
        ],
      };

      const built = await pipeline.buildMenus({
        project: pipeline.normaliseProject({ discTitle: 'Pages', deck, videoFormat: 'ntsc' }),
        videos: [],
        tools,
        root: dir,
        BrowserWindow: stubWindow(pngBase64),
      });

      assertEqual(built.menus.length, 2, 'Both pages were built');
      const front = built.menus.find((m) => m.slideId === frontId);
      const second = built.menus.find((m) => m.slideId === 'slide_second');
      assertEqual(front.buttons.length, 0, 'The page of words has nothing on it');
      assertEqual(second.buttons.length, 1, 'And the picture is a button on its own page');
      assertEqual(second.buttons[0].command, 'jump menu 1;', 'Aiming at the page of words');
      assert(fs.existsSync(front.vobPath), 'A page with no buttons still gets its own picture');

      fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('a disc with nothing pressable anywhere is refused', async () => {
      /*
        The dead disc, and the reason it is refused rather than shipped.

        The picture points at a slide that no longer exists, so it resolves to no
        command and disappears; the page it was on is then empty too. There is no
        page on the disc the viewer could choose anything from, and no page to
        escape to — so this has to stop the build with something to read, not
        produce a disc that opens on a menu with nothing on it.
      */
      const dir = tmpdir('dead');
      const png = path.join(dir, 'slide.png');
      fs.mkdirSync(dir, { recursive: true });
      const made = run(tools.ffmpeg, [
        '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=0x1c1b19:s=720x480', '-frames:v', '1', png,
      ]);
      assertEqual(made.code, 0, 'Could generate a test menu picture');
      const pngBase64 = fs.readFileSync(png).toString('base64');

      const deck = {
        discTitle: 'Dangling',
        themeId: 'charcoal',
        slides: [
          {
            id: 'slide_only', title: 'Only', role: 'menu', themeId: 'charcoal',
            elements: [
              { id: 'p', kind: 'image', x: 100, y: 150, width: 260, height: 190, targetSlideId: 'gone' },
            ],
          },
        ],
      };

      let refused = null;
      try {
        await pipeline.buildMenus({
          project: pipeline.normaliseProject({ discTitle: 'Dangling', deck, videoFormat: 'ntsc' }),
          videos: [],
          tools,
          root: dir,
          BrowserWindow: stubWindow(pngBase64),
        });
      } catch (err) {
        refused = String(err.message || err);
      }

      assert(Boolean(refused), 'The build stops');
      assert(
        /nothing on any of the pages can be pressed/i.test(refused || ''),
        'And says why, in words rather than a code',
        refused
      );

      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  // -------------------------------------------------------------- summary ---
  console.log('');
  const total = passed + failed + skipped;
  if (failed === 0) {
    console.log(
      `\u001b[32m${passed} passed\u001b[0m` +
        (skipped ? `, \u001b[33m${skipped} skipped\u001b[0m` : '') +
        ` of ${total}`
    );
  } else {
    console.log(
      `\u001b[31m${failed} failed\u001b[0m, ${passed} passed` +
        (skipped ? `, ${skipped} skipped` : '') +
        ` of ${total}`
    );
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  \u001b[31m\u2022\u001b[0m ${f.name}`);
    }
  }

  if (skipped) {
    console.log('\nSkipped tests mean part of the pipeline is unverified on this machine.');
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nThe test runner itself crashed:');
  console.error(err);
  process.exit(2);
});
