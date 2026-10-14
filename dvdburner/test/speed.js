'use strict';

/**
 * Focused tests for the things that make a build fast.
 *
 * Three changes, and each one is a claim that has to hold or the disc is wrong
 * rather than slow:
 *
 *   - a title whose source and settings have not changed is reused instead of
 *     re-encoded, and anything that would change the output invalidates it;
 *   - a source that already is a DVD title is copied rather than encoded, and
 *     nothing that would need converting is copied;
 *   - hdiutil is told not to verify when verification is off, because its own
 *     default is to verify and silence does not mean no.
 *
 * And the folders all of that is kept in. Work that is saved is only saved if it
 * can be found again: one folder per project, with the build an older version
 * left in the shared one adopted rather than abandoned.
 *
 * Everything here is pure filesystem and argument inspection, so it runs in well
 * under a second and needs no video tools, no drive and no disc.
 *
 * Run with:  npm run test:speed
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const encode = require('../src/core/encode');
const disc = require('../src/core/disc');
const probeMod = require('../src/core/probe');
const pipeline = require('../src/core/pipeline');
const settingsStore = require('../src/main/settings');
const spec = require('../src/core/dvd_spec');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, message: String((err && err.message) || err) });
    console.log(`  FAIL ${name}`);
    console.log(`       ${String((err && err.message) || err)}`);
  }
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

function assertClose(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message || 'Values differ'}: expected ${expected} (±${tolerance}), got ${actual}`);
  }
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `burnhouse-${tag}-`));
}

function section(title) {
  console.log(`\n${title}`);
}

// ------------------------------------------------------------- fixtures ---

const plan = spec.planBitrate({ totalSeconds: 3600, formatId: 'ntsc' });
const ASPECT = { ratio: '16:9' };

/** The options block the pipeline builds, so the tests key on the same shape. */
function options(overrides = {}) {
  return {
    format: plan.format.id,
    width: plan.format.width,
    height: plan.format.height,
    fps: plan.format.fps,
    gop: plan.gop,
    videoBitrate: plan.videoBitrate,
    audioBitrate: plan.audioBitrate,
    muxrate: plan.muxrate,
    audioChannels: plan.audio.channels,
    aspect: ASPECT.ratio,
    hasAudio: true,
    ...overrides,
  };
}

function sourceFile(dir, name = 'episode.mp4', bytes = 1024) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

/** A probe record shaped like the ones probe.js really produces. */
function probeFor(file, overrides = {}) {
  return {
    path: file,
    name: path.basename(file),
    width: 1920,
    height: 1080,
    fps: 29.97,
    videoCodec: 'h264',
    pixelFormat: 'yuv420p',
    colorSpace: 'bt709',
    displayAspect: '16:9',
    bitrate: 8000000,
    hasAudio: true,
    audioCodec: 'aac',
    audioChannels: 2,
    audioSampleRate: 48000,
    ...overrides,
  };
}

/** A title folder holding one VOB, with a cache record claiming it is current. */
function cachedTitle(dir, fingerprint, { bytes = 4096, mode = 'encode', parts = 1 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 1; i <= parts; i += 1) {
    const file = path.join(dir, `VTS_01_${i}.VOB`);
    fs.writeFileSync(file, Buffer.alloc(bytes, 3));
    files.push({ file, bytes });
  }
  encode.writeTitleCache(dir, { fingerprint, parts: files, mode });
  return files;
}

// ---------------------------------------------------------- title cache ---

section('Reusing a title that has not changed');

test('an unchanged title is found and reused', () => {
  const dir = tmpdir('cache-hit');
  const input = sourceFile(dir);
  const titleDir = path.join(dir, 'title_1');
  const probe = probeFor(input);

  const key = encode.titleFingerprint({ input, probe, options: options(), durationSeconds: 600 });
  const written = cachedTitle(titleDir, key);

  const found = encode.readTitleCache(titleDir, key);
  assert(found, 'The title should have been reused');
  assertEqual(found.parts.length, 1, 'It should carry the parts it found');
  assertEqual(found.parts[0].file, written[0].file, 'The part path must be the real one');
  assertEqual(found.parts[0].bytes, 4096, 'The part size must be carried through');
  assertEqual(found.mode, 'encode', 'The mode should be remembered');
});

test('the parts are returned as absolute paths, whatever the record held', () => {
  const dir = tmpdir('cache-paths');
  const input = sourceFile(dir);
  const titleDir = path.join(dir, 'title_1');
  const key = encode.titleFingerprint({ input, probe: probeFor(input), options: options(), durationSeconds: 60 });

  fs.mkdirSync(titleDir, { recursive: true });
  fs.writeFileSync(path.join(titleDir, 'VTS_01_1.VOB'), Buffer.alloc(100, 1));
  // A record written somewhere else, or by an older build, must still resolve
  // against the folder it is read from — not against whatever it recorded.
  encode.writeTitleCache(titleDir, {
    fingerprint: key,
    parts: [{ file: '/somewhere/else/entirely/VTS_01_1.VOB', bytes: 100 }],
    mode: 'copy',
  });

  const found = encode.readTitleCache(titleDir, key);
  assert(found, 'A bare filename must be resolved from the title folder');
  assertEqual(found.parts[0].file, path.join(titleDir, 'VTS_01_1.VOB'), 'Path must be rebuilt locally');
  assertEqual(found.mode, 'copy', 'A copied title reports itself as copied');
});

test('a changed source file invalidates the title', () => {
  const dir = tmpdir('cache-source');
  const input = sourceFile(dir);
  const titleDir = path.join(dir, 'title_1');
  const probe = probeFor(input);
  const key = encode.titleFingerprint({ input, probe, options: options(), durationSeconds: 600 });
  cachedTitle(titleDir, key);

  // Same path, different contents — the case that a path-only cache would miss.
  fs.writeFileSync(input, Buffer.alloc(2048, 9));
  const after = encode.titleFingerprint({ input, probe, options: options(), durationSeconds: 600 });

  assert(after !== key, 'Replacing the file must change the fingerprint');
  assertEqual(encode.readTitleCache(titleDir, after), null, 'A changed source must not be reused');
});

test('a touch that changes nothing but the clock is noticed too', () => {
  const dir = tmpdir('cache-mtime');
  const input = sourceFile(dir);
  const probe = probeFor(input);
  const before = encode.titleFingerprint({ input, probe, options: options(), durationSeconds: 600 });

  const later = new Date(Date.now() + 60000);
  fs.utimesSync(input, later, later);
  const after = encode.titleFingerprint({ input, probe, options: options(), durationSeconds: 600 });

  assert(after !== before, 'A rewritten file with the same size must still invalidate');
});

test('every setting that changes the output invalidates the title', () => {
  const dir = tmpdir('cache-settings');
  const input = sourceFile(dir);
  const probe = probeFor(input);
  const base = encode.titleFingerprint({ input, probe, options: options(), durationSeconds: 600 });

  const changes = {
    'the video bitrate': { videoBitrate: plan.videoBitrate - 200000 },
    'the audio bitrate': { audioBitrate: 448000 },
    'the mux rate': { muxrate: plan.muxrate - 100000 },
    'the GOP length': { gop: 15 },
    'the frame rate': { fps: 25 },
    'the raster height': { height: 576 },
    'the shape': { aspect: '4:3' },
    'whether there is sound': { hasAudio: false },
    'the channel count': { audioChannels: 6 },
  };

  for (const [what, change] of Object.entries(changes)) {
    const key = encode.titleFingerprint({
      input,
      probe,
      options: options(change),
      durationSeconds: 600,
    });
    assert(key !== base, `Changing ${what} must force the title to be prepared again`);
  }

  // And a re-measured duration, which is what -t is cut to.
  const shorter = encode.titleFingerprint({ input, probe, options: options(), durationSeconds: 900 });
  assert(shorter !== base, 'A different duration must force the title to be prepared again');
});

test('the colour matrix tag invalidates the title', () => {
  const dir = tmpdir('cache-matrix');
  const input = sourceFile(dir);
  const hd = encode.titleFingerprint({
    input,
    probe: probeFor(input, { colorSpace: 'bt709' }),
    options: options(),
    durationSeconds: 600,
  });
  const sd = encode.titleFingerprint({
    input,
    probe: probeFor(input, { colorSpace: 'bt470bg' }),
    options: options(),
    durationSeconds: 600,
  });
  assert(hd !== sd, 'A different source colour matrix is a different conversion');
});

test('a recorded title whose file is the wrong length is not reused', () => {
  const dir = tmpdir('cache-short');
  const input = sourceFile(dir);
  const titleDir = path.join(dir, 'title_1');
  const key = encode.titleFingerprint({ input, probe: probeFor(input), options: options(), durationSeconds: 600 });
  cachedTitle(titleDir, key, { bytes: 4096 });

  // An interrupted run leaves the right name at the wrong length. Reusing it
  // would put a truncated title on the disc and nothing would say so.
  fs.writeFileSync(path.join(titleDir, 'VTS_01_1.VOB'), Buffer.alloc(512, 1));
  assertEqual(encode.readTitleCache(titleDir, key), null, 'A short part must not be reused');

  fs.rmSync(path.join(titleDir, 'VTS_01_1.VOB'));
  assertEqual(encode.readTitleCache(titleDir, key), null, 'A missing part must not be reused');
});

test('a record from an older encoder is not reused', () => {
  const dir = tmpdir('cache-revision');
  const input = sourceFile(dir);
  const titleDir = path.join(dir, 'title_1');
  const key = encode.titleFingerprint({ input, probe: probeFor(input), options: options(), durationSeconds: 600 });
  cachedTitle(titleDir, key);

  // The ghosting fix is the reason this matters: same source, same settings, a
  // different and correct output. A cache that ignored the revision would have
  // quietly kept the broken stream.
  const recordPath = path.join(titleDir, '.encode.json');
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  record.revision = encode.ENCODE_REVISION - 1;
  fs.writeFileSync(recordPath, JSON.stringify(record));

  assertEqual(encode.readTitleCache(titleDir, key), null, 'An older recipe must not be reused');
});

test('a corrupted or absent record is not reused', () => {
  const dir = tmpdir('cache-broken');
  const input = sourceFile(dir);
  const titleDir = path.join(dir, 'title_1');
  const key = encode.titleFingerprint({ input, probe: probeFor(input), options: options(), durationSeconds: 600 });

  assertEqual(encode.readTitleCache(titleDir, key), null, 'No folder at all is not a hit');

  fs.mkdirSync(titleDir, { recursive: true });
  assertEqual(encode.readTitleCache(titleDir, key), null, 'No record is not a hit');

  fs.writeFileSync(path.join(titleDir, '.encode.json'), '{ this is not json');
  assertEqual(encode.readTitleCache(titleDir, key), null, 'An unreadable record is not a hit');
});

test('clearing the cache removes every prepared title', () => {
  const root = tmpdir('cache-clear');
  const input = sourceFile(root);
  const key = encode.titleFingerprint({ input, probe: probeFor(input), options: options(), durationSeconds: 60 });
  cachedTitle(path.join(root, 'titles', 'title_1'), key);
  cachedTitle(path.join(root, 'titles', 'title_2'), key);

  encode.clearTitleCache(root);
  assertEqual(fs.existsSync(path.join(root, 'titles')), false, 'The titles folder should be gone');
  assertEqual(encode.readTitleCache(path.join(root, 'titles', 'title_1'), key), null, 'And nothing is reusable');
});

test('title folders past the end of the video list are removed', () => {
  const root = tmpdir('cache-prune');
  const input = sourceFile(root);
  const key = encode.titleFingerprint({ input, probe: probeFor(input), options: options(), durationSeconds: 60 });
  cachedTitle(path.join(root, 'titles', 'title_1'), key);
  cachedTitle(path.join(root, 'titles', 'title_2'), key);
  cachedTitle(path.join(root, 'titles', 'title_3'), key);

  assertEqual(encode.pruneTitleDirs(root, 2), 1, 'One folder should have been removed');
  assertEqual(fs.existsSync(path.join(root, 'titles', 'title_2')), true, 'A folder still in use stays');
  assertEqual(fs.existsSync(path.join(root, 'titles', 'title_3')), false, 'The one past the end goes');
  assertEqual(encode.pruneTitleDirs(root, 2), 0, 'Running it again removes nothing');
});

// ------------------------------------------------------------- remuxing ---

section('Copying a source that is already a DVD title');

const NTSC = spec.resolveFormat
  ? spec.resolveFormat('ntsc')
  : { width: 720, height: 480, fps: 30000 / 1001 };

function dvdProbe(overrides = {}) {
  return probeFor('/movies/VIDEO_TS/VTS_01_1.VOB', {
    width: 720,
    height: 480,
    fps: 30000 / 1001,
    videoCodec: 'mpeg2video',
    pixelFormat: 'yuv420p',
    colorSpace: 'bt470bg',
    displayAspect: '16:9',
    bitrate: 6000000,
    audioCodec: 'ac3',
    audioChannels: 2,
    audioSampleRate: 48000,
    ...overrides,
  });
}

const REMUX_CONTEXT = { format: NTSC, aspect: '16:9', muxrate: plan.muxrate };

test('a DVD-quality .vob is copied rather than encoded', () => {
  const verdict = encode.canRemux(dvdProbe(), REMUX_CONTEXT);
  assert(verdict.ok, `It should be copyable, but: ${verdict.reason}`);
});

test('anything that would need converting is encoded instead', () => {
  const cases = {
    'a source that is not MPEG-2': dvdProbe({ videoCodec: 'h264' }),
    'the wrong raster': dvdProbe({ width: 704 }),
    'the wrong frame rate': dvdProbe({ fps: 25 }),
    'a colour format DVD cannot carry': dvdProbe({ pixelFormat: 'yuv422p' }),
    'a 4:3 source on a 16:9 disc': dvdProbe({ displayAspect: '4:3' }),
    'a source whose shape is unknown': dvdProbe({ displayAspect: null }),
    'a source above the disc budget': dvdProbe({ bitrate: plan.muxrate + 1000000 }),
    // A .vob carries an average bitrate of almost exactly its own mux rate, so a
    // fraction over is measurement noise rather than a source too big to fit.
    'a source a long way above the disc budget': dvdProbe({ bitrate: plan.muxrate * 1.5 }),
    'a source whose bitrate is unknown': dvdProbe({ bitrate: null }),
    'a plain .mpg that may not be a compliant stream': dvdProbe({ path: '/movies/clip.mpg' }),
  };

  for (const [what, probe] of Object.entries(cases)) {
    const verdict = encode.canRemux(probe, REMUX_CONTEXT);
    assert(!verdict.ok, `${what} must not be copied`);
    assert(verdict.reason, `${what} must say why`);
  }
});

test('a source right at the disc budget is still copied', () => {
  // The muxer pads a DVD stream to exactly its mux rate, so a file this program
  // produced sits on the line. Refusing it would mean never copying the one kind
  // of source the copy path exists for.
  const verdict = encode.canRemux(dvdProbe({ bitrate: plan.muxrate }), REMUX_CONTEXT);
  assert(verdict.ok, `It should be copyable, but: ${verdict.reason}`);
});

test('a 4:3 disc copies a 4:3 source', () => {
  const verdict = encode.canRemux(dvdProbe({ displayAspect: '4:3' }), {
    ...REMUX_CONTEXT,
    aspect: '4:3',
  });
  assert(verdict.ok, `It should be copyable, but: ${verdict.reason}`);
});

test('the copy argument list asks for no conversion at all', () => {
  const args = encode.buildRemuxArgs({
    input: '/movies/VIDEO_TS/VTS_01_1.VOB',
    outputVob: '/work/titles/title_1/VTS_01_1.VOB',
    plan: { ...plan, hasAudio: true, probe: dvdProbe() },
    durationSeconds: 600,
  });
  const joined = args.join(' ');

  assert(joined.includes('-c:v copy'), 'The picture must be copied');
  assert(joined.includes('-c:a copy'), 'Compliant sound must be copied too');
  assert(joined.includes('-f dvd'), 'It must still be remultiplexed as a DVD stream');
  assert(joined.includes('-muxrate'), 'The mux rate still has to be within the disc budget');
  assert(joined.includes('-t 600'), 'The length is still imposed');

  // Every one of these describes a conversion, and a copy is the absence of one.
  for (const forbidden of ['-vf', '-c:v mpeg2video', '-s 720x480', '-aspect', '-r ']) {
    assert(!joined.includes(forbidden), `${forbidden} must not appear in a copy`);
  }
});

test('sound that needs converting is converted without touching the picture', () => {
  const args = encode.buildRemuxArgs({
    input: '/movies/VIDEO_TS/VTS_01_1.VOB',
    outputVob: '/work/out.VOB',
    plan: {
      ...plan,
      hasAudio: true,
      // AAC is not something a DVD may carry, so the sound is re-encoded.
      probe: dvdProbe({ audioCodec: 'aac' }),
    },
    durationSeconds: 600,
  });
  const joined = args.join(' ');

  assert(joined.includes('-c:v copy'), 'The picture must still be copied');
  assert(joined.includes('-c:a ac3'), 'The sound must be converted to AC-3');
  assert(joined.includes('-ar 48000'), 'At the 48 kHz a DVD requires');
});

test('a 5.1 source on a stereo disc has its sound converted, not copied', () => {
  const args = encode.buildRemuxArgs({
    input: '/movies/VIDEO_TS/VTS_01_1.VOB',
    outputVob: '/work/out.VOB',
    plan: { ...plan, hasAudio: true, probe: dvdProbe({ audioChannels: 6 }) },
    durationSeconds: 600,
  });
  const joined = args.join(' ');

  assert(joined.includes('-c:v copy'), 'The picture must still be copied');
  assert(joined.includes('-c:a ac3'), 'A channel count the disc plan did not budget for is converted');
  assert(!joined.includes('-c:a copy'), 'And must not be copied through as it stands');
});

test('a source with no sound is copied with silence mixed in, in the same pass', () => {
  const args = encode.buildRemuxArgs({
    input: '/movies/VIDEO_TS/VTS_01_1.VOB',
    outputVob: '/work/out.VOB',
    plan: { ...plan, hasAudio: false, probe: dvdProbe({ hasAudio: false }) },
    durationSeconds: 600,
  });
  const joined = args.join(' ');

  assert(joined.includes('-c:v copy'), 'The picture must be copied');
  assert(!joined.includes('0:a:0'), 'No audio stream should be mapped from a source that has none');
  // The silence used to be added by writing the whole title out a second time.
  // It is generated alongside instead, and made into the AC-3 a DVD carries.
  assert(joined.includes('anullsrc'), 'Silence is generated during the copy');
  assert(joined.includes('-map 1:a:0'), 'And it is what the audio track is made from');
  assert(joined.includes('-c:a ac3'), 'As AC-3');
  assert(joined.includes('-shortest'), 'Ending with the picture, since silence never ends');
});

test('a plain MPEG-2 file at DVD resolution still goes through the encoder', () => {
  const input = '/movies/holiday.mpg';
  const probe = dvdProbe({ path: input });
  assertEqual(encode.canRemux(probe, REMUX_CONTEXT).ok, false, 'A .mpg is not proof of a compliant stream');

  const args = encode.buildEncodeArgs({
    input,
    outputVob: '/work/out.VOB',
    plan: { ...plan, hasAudio: true, probe },
    durationSeconds: 600,
    aspect: ASPECT,
  });
  assert(args.join(' ').includes('-c:v mpeg2video'), 'It must be encoded');
});

// --------------------------------------------------------- probe shapes ---

section('Reading the shape a video is meant to be seen in');

test('a widescreen DVD is 16:9 from its anamorphic flag', () => {
  assertEqual(
    probeMod.displayAspectOf({ width: 720, height: 480, sample_aspect_ratio: '32/27' }),
    '16:9',
    '32:27 on a 720x480 frame is widescreen'
  );
});

test('a full-frame DVD is 4:3 from its anamorphic flag', () => {
  assertEqual(
    probeMod.displayAspectOf({ width: 720, height: 480, sample_aspect_ratio: '8/9' }),
    '4:3',
    '8:9 on a 720x480 frame is full frame'
  );
});

test('a stated shape is believed over a derived one', () => {
  assertEqual(
    probeMod.displayAspectOf({ width: 720, height: 480, display_aspect_ratio: '16:9', sample_aspect_ratio: '8/9' }),
    '16:9',
    'ffprobe having worked it out is the better answer'
  );
});

test('square-pixel sources are read from their pixel count', () => {
  assertEqual(probeMod.displayAspectOf({ width: 1920, height: 1080, sample_aspect_ratio: '1/1' }), '16:9');
  assertEqual(probeMod.displayAspectOf({ width: 640, height: 480, sample_aspect_ratio: '1/1' }), '4:3');
});

test('a shape a DVD cannot carry is reported as unknown, not forced', () => {
  assertEqual(
    probeMod.displayAspectOf({ width: 1920, height: 800, sample_aspect_ratio: '1/1' }),
    null,
    'Scope is not one of the two shapes a DVD has'
  );
  assertEqual(probeMod.displayAspectOf({ width: 0, height: 0 }), null, 'Nothing readable is nothing');
});

// ------------------------------------------------------------- burning ----

section('Telling hdiutil what to do about verification');

test('verification is asked for outright when it is wanted', () => {
  const args = disc.buildBurnArgs({ isoPath: '/tmp/disc.iso', verify: true });
  assert(args.includes('-verifyburn'), 'It should say so rather than relying on the default');
  assert(!args.includes('-noverifyburn'), 'And must not also say the opposite');
});

test('verification is refused with the option hdiutil actually has', () => {
  const args = disc.buildBurnArgs({ isoPath: '/tmp/disc.iso', verify: false });
  // hdiutil verifies by default, so saying nothing meant verifying anyway. And
  // the word is -noverifyburn: this used to send -noverify, which is not the
  // burn option — rejected outright, or read as attach's image check.
  assert(args.includes('-noverifyburn'), 'Saying nothing is not the same as saying no');
  assert(!args.includes('-noverify'), '-noverify is not the burn option');
  assert(!args.includes('-verifyburn'), 'The two must never both be passed');
});

test('every option is one hdiutil burn documents', () => {
  const documented = new Set([
    'burn', '-puppetstrings', '-verifyburn', '-noverifyburn', '-forceclose', '-noforceclose',
    '-eject', '-noeject', '-speed', '-device', '-testburn', '-synthesize', '-nosynthesize',
    '-addpmap', '-noaddpmap',
  ]);
  for (const verify of [true, false]) {
    for (const speed of [null, 4]) {
      for (const arg of disc.buildBurnArgs({ isoPath: '/tmp/disc.iso', verify, speed })) {
        if (arg === '/tmp/disc.iso' || arg === '4') continue;
        assert(documented.has(arg), `${arg} is not an hdiutil burn option`);
      }
    }
  }
});

test('the disc is closed, progress is machine-readable, and the image comes last', () => {
  const args = disc.buildBurnArgs({ isoPath: '/tmp/My Disc.iso', verify: true });
  assertEqual(args[0], 'burn', 'It must be the burn verb');
  assertEqual(args[args.length - 1], '/tmp/My Disc.iso', 'A path with a space is passed as one argument, untouched');
  assert(args.includes('-forceclose'), 'A DVD player wants a closed disc, and hdiutil leaves it open');
  assert(args.includes('-puppetstrings'), 'Real percentages rather than a row of dots');
  assert(args.includes('-nosynthesize') && args.includes('-noaddpmap'), 'The image is burned exactly as written');
  assert(!args.includes('-device'), 'The drive path cannot be reconstructed safely');
  assert(!args.includes('-speed'), 'Full speed unless a retry asks otherwise');
  assertEqual(disc.buildBurnArgs({ isoPath: '/x.iso', speed: 4 }).join(' ').includes('-speed 4'), true, 'The retry burns slower');
});

section('Following an hdiutil burn');

test('percentages move the bar, writing first and checking after', () => {
  const reader = disc.burnProgressReader({ verify: true });
  reader.line('Please insert a disc:');
  assertEqual(reader.state.message, 'Waiting for a blank disc in the drive…');
  reader.line('Preparing data for burn');
  assertEqual(reader.state.message, null, 'Writing clears the waiting message');
  reader.line('PERCENT:-1.000000');
  assertEqual(reader.overall(), 0, 'An indeterminate step does not move the bar');
  reader.line('PERCENT:50.0');
  assert(Math.abs(reader.overall() - 0.275) < 0.001, `Half the writing is half of the write share, got ${reader.overall()}`);
  reader.line('PERCENT:100');
  reader.line('Verifying burn…');
  assertEqual(reader.state.phase, 'verify');
  assertEqual(reader.state.message, 'Checking the disc…');
  reader.line('PERCENT:50');
  assert(Math.abs(reader.overall() - 0.775) < 0.001, `Halfway through the check, got ${reader.overall()}`);
});

test('a percentage that starts again is the check, even unannounced', () => {
  const reader = disc.burnProgressReader({ verify: true });
  reader.line('PERCENT:98');
  reader.line('PERCENT:2');
  assertEqual(reader.state.phase, 'verify');
});

test('without verification, writing is the whole bar', () => {
  const reader = disc.burnProgressReader({ verify: false });
  reader.line('PERCENT:50');
  assertEqual(reader.overall(), 0.5);
});

test('the media prompt every burn prints is not mistaken for a missing disc', () => {
  const transcript = [
    'Please insert a disc:',
    'Preparing data for burn',
    'Opening session',
    'hdiutil: burn failed - The device failed to calibrate the laser power level for this media.',
  ].join('\n');
  const message = disc.describeBurnFailure(transcript);
  assert(!/no disc in it/.test(message), `It said: ${message}`);
  assert(/laser/.test(message), 'The calibration failure is what is described');
  assert(/calibrate the laser power level/.test(message), 'And macOS\'s own words are kept');
});

test('a rejected option is reported as such, not as a disc problem', () => {
  const message = disc.describeBurnFailure('hdiutil: burn: unrecognized option -noverify\nUsage: hdiutil burn <image>');
  assert(/option/.test(message) && /still blank/.test(message), `It said: ${message}`);
});

// ------------------------------------------------------- disc fingerprint ---

section('Noticing a changed project');

test('the disc shape and the disc type are part of the fingerprint', () => {
  const root = tmpdir('fingerprint');
  const file = sourceFile(root, 'a.mp4');
  const video = { path: file, duration: 600, name: 'a.mp4', menuLabel: '' };

  const base = pipeline.normaliseProject({ videos: [video], discTitle: 'Trip' });
  const before = pipeline.projectFingerprint(base);

  // These two silently did not register before, so a finished build was offered
  // as still current after the whole disc had been switched to a different
  // shape or a different size of blank disc.
  const otherAspect = pipeline.projectFingerprint({ ...base, titleAspect: '4:3' });
  const otherDisc = pipeline.projectFingerprint({ ...base, discType: 'dvd9' });

  assert(otherAspect !== before, 'Changing the shape must be noticed');
  assert(otherDisc !== before, 'Changing the disc type must be noticed');
});

test('the disc title and the slides are part of the fingerprint', () => {
  const root = tmpdir('fingerprint-2');
  const file = sourceFile(root, 'a.mp4');
  const video = { path: file, duration: 600, name: 'a.mp4', menuLabel: '' };
  const base = pipeline.normaliseProject({ videos: [video], discTitle: 'Trip' });
  const before = pipeline.projectFingerprint(base);

  assert(pipeline.projectFingerprint({ ...base, discTitle: 'Other Trip' }) !== before, 'A renamed disc is a different disc');

  const moved = { ...base, deck: { ...base.deck, slides: [...base.deck.slides, { id: 's2' }] } };
  assert(pipeline.projectFingerprint(moved) !== before, 'A new slide is a different disc');
});

test('the app version and the tool paths are not part of the fingerprint', () => {
  const root = tmpdir('fingerprint-3');
  const file = sourceFile(root, 'a.mp4');
  const video = { path: file, duration: 600, name: 'a.mp4', menuLabel: '' };
  const base = pipeline.normaliseProject({ videos: [video], discTitle: 'Trip', themeId: 'charcoal' });
  const before = pipeline.projectFingerprint(base);

  // Upgrading the app, or moving the working folder, must not throw away an
  // hour of encoding — that is the whole reason the fingerprint is narrow.
  assertEqual(
    pipeline.projectFingerprint({ ...base, output: { workDir: 'C:\\somewhere\\else' } }),
    before,
    'Where the work is kept does not change the disc'
  );
});

test('the encoder recipe is part of the fingerprint', () => {
  const root = tmpdir('fingerprint-4');
  const file = sourceFile(root, 'a.mp4');
  const video = { path: file, duration: 600, name: 'a.mp4', menuLabel: '' };
  const project = pipeline.normaliseProject({ videos: [video], discTitle: 'Trip' });

  const payload = pipeline.fingerprintPayload(project);
  assertEqual(
    payload.encoderRevision,
    encode.ENCODE_REVISION,
    'The recipe revision has to be hashed, or a fix in the encoder cannot invalidate anything'
  );

  /*
    The case that matters, and the one that actually happened.

    A release that changes the encoder produces different bytes from a project
    that has not moved at all. If the fingerprint is the project alone, the disc
    prepared before that release still claims to be current, the Burn button goes
    straight to writing it, and the fix never reaches a disc. That is how a
    prepared disc from before the ghosting fix survived several releases.
  */
  const bumped = crypto
    .createHash('sha256')
    .update(JSON.stringify(pipeline.fingerprintPayload(project, encode.ENCODE_REVISION + 1)))
    .digest('hex');

  assert(
    bumped !== pipeline.projectFingerprint(project),
    'A new encoder recipe must make a prepared disc out of date'
  );
  assert(
    JSON.stringify(pipeline.fingerprintPayload(project, encode.ENCODE_REVISION + 1)) !==
      JSON.stringify(payload),
    'And the difference has to be in what is hashed, not only in the hash'
  );
});

test('the fingerprint is stable, so an unchanged project is not rebuilt', () => {
  const root = tmpdir('fingerprint-5');
  const file = sourceFile(root, 'a.mp4');
  const video = { path: file, duration: 600, name: 'a.mp4', menuLabel: '' };

  /*
    A deck is always supplied, by the editor, and its ids were minted once when
    the slides were made and have been carried in the project ever since. That
    is what makes the fingerprint stable across calls — and it has to be, because
    the fingerprint written by one build is compared against one computed by a
    later, separate call. If normalising the same project twice gave two answers,
    a prepared disc would look out of date to the very next question and would be
    rebuilt every single time, for ever.
  */
  const deck = {
    discTitle: 'Trip',
    themeId: 'charcoal',
    buttonStyle: 'bar',
    slides: [
      {
        id: 'slide_1',
        title: 'Trip',
        role: 'menu',
        themeId: 'charcoal',
        elements: [{ id: 'el_1', kind: 'text', text: 'Trip', x: 40, y: 44, width: 640 }],
      },
    ],
  };

  const build = () => pipeline.normaliseProject({ videos: [video], discTitle: 'Trip', deck });

  assertEqual(pipeline.projectFingerprint(build()), pipeline.projectFingerprint(build()), 'Asking twice must give the same answer, or nothing would ever be reused');

  // And the ids really are preserved rather than regenerated, which is what the
  // whole thing rests on.
  assertEqual(build().deck.slides[0].id, 'slide_1', 'A slide id must survive normalising');
  assertEqual(build().deck.slides[0].elements[0].id, 'el_1', 'And so must an element id');
});

// ------------------------------------------------------- work folders ---

section('Keeping each project\u2019s prepared disc in its own folder');

/** A stand-in for a prepared disc: the files a build actually leaves behind. */
function fakeBuild(dir, { label = 'DISC', fingerprint = 'f'.repeat(64) } = {}) {
  fs.mkdirSync(path.join(dir, 'titles', 'title_1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'titles', 'title_1', 'VTS_01_1.VOB'), Buffer.alloc(4096, 1));
  fs.mkdirSync(path.join(dir, 'author', 'VIDEO_TS'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'author', 'VIDEO_TS', 'VIDEO_TS.IFO'), 'ifo');
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ fingerprint, volumeLabel: label }));
  fs.writeFileSync(path.join(dir, `${label}.iso`), Buffer.alloc(1024, 2));
  return dir;
}

test('two projects are given two folders', () => {
  const base = tmpdir('workdirs');
  const a = settingsStore.resolveWorkDir({ workDir: base }, 'proj_a');
  const b = settingsStore.resolveWorkDir({ workDir: base }, 'proj_b');

  assert(a !== b, 'Two projects must not resolve to the same folder');
  assert(a.startsWith(base) && b.startsWith(base), 'Both stay inside the working folder');
  assertEqual(fs.existsSync(a), true, 'A project folder is created');
  assertEqual(fs.existsSync(b), true, 'And so is the other');
});

test('one project building does not disturb another', () => {
  const base = tmpdir('workdirs-2');
  const a = settingsStore.resolveWorkDir({ workDir: base }, 'proj_a');
  const b = settingsStore.resolveWorkDir({ workDir: base }, 'proj_b');

  fakeBuild(a, { label: 'TRIP', fingerprint: 'a'.repeat(64) });
  const beforeA = fs.readFileSync(path.join(a, 'build.json'), 'utf8');

  fakeBuild(b, { label: 'WEDDING', fingerprint: 'b'.repeat(64) });

  assertEqual(
    fs.readFileSync(path.join(a, 'build.json'), 'utf8'),
    beforeA,
    'The first project\u2019s build record must be exactly as it was'
  );
  assertEqual(
    fs.existsSync(path.join(a, 'titles', 'title_1', 'VTS_01_1.VOB')),
    true,
    'And its encoded title must still be there'
  );
  assertEqual(
    settingsStore.preparedWorkSummary(base).projects,
    2,
    'Both prepared discs are counted'
  );
});

test('without an id the working folder itself is used, as before', () => {
  const base = tmpdir('workdirs-3');
  assertEqual(settingsStore.resolveWorkDir({ workDir: base }), base, 'No id means the top of the folder');
  assertEqual(settingsStore.resolveWorkDir({ workDir: base }, ''), base, 'An empty id is no id');
  assertEqual(settingsStore.resolveWorkDir({ workDir: base }, null), base, 'And so is a missing one');
});

test('an id cannot put the working folder somewhere else', () => {
  const base = tmpdir('workdirs-4');

  // These ids arrive from a project file, which can be hand-edited, copied from
  // another machine, or written by a future version. The joined path is later
  // deleted recursively by "Clear Working Files", so none of them may escape.
  const hostile = [
    '../../etc',
    '..',
    '.',
    'a/b/c',
    'C:\\Windows',
    'proj\\..\\..\\evil',
    'proj\u0000a',
    '...',
  ];

  for (const id of hostile) {
    const dir = settingsStore.resolveWorkDir({ workDir: base }, id);
    assert(
      dir === base || (path.resolve(dir).startsWith(path.resolve(base) + path.sep)),
      `"${id}" resolved outside the working folder: ${dir}`
    );
  }

  assertEqual(settingsStore.safeProjectFolder('..'), '_', 'A bare parent reference is neutralised');
  assertEqual(settingsStore.safeProjectFolder('proj_123'), 'proj_123', 'A real id is untouched');
  assertEqual(settingsStore.safeProjectFolder('a'.repeat(500)).length, 80, 'An absurd id is truncated');
});

test('a build left by the old shared layout is adopted, not abandoned', () => {
  const base = tmpdir('workdirs-adopt');

  /*
    What an older version wrote: everything at the top of the working folder,
    because there was only ever one of it. Without adopting this, switching to
    per-project folders would make a fully prepared disc invisible and re-encode
    the whole thing to produce the same bytes.
  */
  fakeBuild(base, { label: 'MY_DVD', fingerprint: 'c'.repeat(64) });
  const record = fs.readFileSync(path.join(base, 'build.json'), 'utf8');

  const dir = settingsStore.resolveWorkDir({ workDir: base }, 'proj_1');

  assertEqual(
    fs.readFileSync(path.join(dir, 'build.json'), 'utf8'),
    record,
    'The build record must have moved into the project folder'
  );
  assertEqual(
    fs.existsSync(path.join(dir, 'titles', 'title_1', 'VTS_01_1.VOB')),
    true,
    'And so must the encoded titles'
  );
  assertEqual(
    fs.existsSync(path.join(dir, 'MY_DVD.iso')),
    true,
    'And the image, whose name comes from the disc label rather than a list'
  );
  assertEqual(
    fs.existsSync(path.join(base, 'build.json')),
    false,
    'Nothing may be left claiming the shared folder is still a build'
  );
  assertEqual(
    fs.existsSync(path.join(base, 'titles')),
    false,
    'The old titles folder goes with it'
  );
});

test('the shared build is adopted once, by the first project to ask', () => {
  const base = tmpdir('workdirs-adopt-2');
  fakeBuild(base, { label: 'ONE', fingerprint: 'd'.repeat(64) });

  const first = settingsStore.resolveWorkDir({ workDir: base }, 'proj_1');
  const second = settingsStore.resolveWorkDir({ workDir: base }, 'proj_2');

  assertEqual(fs.existsSync(path.join(first, 'build.json')), true, 'The first to ask gets it');
  assertEqual(
    fs.existsSync(path.join(second, 'build.json')),
    false,
    'The second does not, because there was only ever one build there'
  );
  assertEqual(settingsStore.preparedWorkSummary(base).shared, false, 'And the shared layout is gone');
});

test('a project that has its own build is never overwritten by the old one', () => {
  const base = tmpdir('workdirs-adopt-3');
  const dir = settingsStore.resolveWorkDir({ workDir: base }, 'proj_1');
  fakeBuild(dir, { label: 'MINE', fingerprint: 'e'.repeat(64) });

  // The shared folder appears afterwards — a second copy of the app, or a
  // restore from a backup. It must not land on top of a prepared disc.
  fakeBuild(base, { label: 'OLDER', fingerprint: 'f'.repeat(64) });
  settingsStore.adoptSharedBuild(base, dir);

  const record = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
  assertEqual(record.volumeLabel, 'MINE', 'The project\u2019s own build must be left alone');
  assertEqual(
    fs.existsSync(path.join(base, 'build.json')),
    true,
    'And the other one stays where it was, to be adopted or cleared'
  );
});

test('the project id is carried through normalising but left out of the fingerprint', () => {
  const root = tmpdir('workdirs-fingerprint');
  const file = sourceFile(root, 'a.mp4');
  const video = { path: file, duration: 600, name: 'a.mp4', menuLabel: '' };
  const deck = {
    discTitle: 'Trip',
    themeId: 'charcoal',
    slides: [{ id: 'slide_1', title: 'Trip', role: 'menu', elements: [] }],
  };

  const asA = pipeline.normaliseProject({ id: 'proj_a', videos: [video], discTitle: 'Trip', deck });
  const asB = pipeline.normaliseProject({ id: 'proj_b', videos: [video], discTitle: 'Trip', deck });

  assertEqual(asA.id, 'proj_a', 'The id must survive normalising, or stages look in different folders');

  // The same project saved under a new id is the same disc. Hashing the id would
  // re-encode an hour of video because a project file was copied.
  assertEqual(
    pipeline.projectFingerprint(asA),
    pipeline.projectFingerprint(asB),
    'The id must not change what the fingerprint says about the disc'
  );
});

// -------------------------------------------------------- the safe area ---

section('Dragging an element that is bigger than the safe area');

const safeArea = require('../src/core/safe_area');

/** An element of the given size, dragged to the given corner of the world. */
function dragged(kind, x, y, width, height) {
  return safeArea.clampElement({ kind, x, y, width, height });
}

test('an element the size of the safe area can still be moved to both edges', () => {
  const box = { x: safeArea.SAFE_MARGIN, y: safeArea.SAFE_MARGIN, width: 640, height: 400 };

  const left = safeArea.clampEdge(-500, box.width, safeArea.SAFE_MARGIN, 720 - safeArea.SAFE_MARGIN);
  const right = safeArea.clampEdge(5000, box.width, safeArea.SAFE_MARGIN, 720 - safeArea.SAFE_MARGIN);

  assertEqual(left, 40, 'It stops at the left guide');
  assertEqual(right, 40, 'And at the right one, which is the same place when it is exactly full width');
});

test('a picture is not clamped at all, however far it is dragged', () => {
  /*
    Three complaints, one rule, arrived at by removing it.

    First: a picture scaled past the safe area was pinned, because the clamp's
    two halves collapsed to the same negative number and every drag snapped it
    back there. Then it could be dragged but only as far as the safe margin,
    which read as being clamped by the edge of the slide. Then, allowed past the
    margin, it still stopped once a grabbable strip was all that was left.

    Every one of those limits was hit in turn, so there is no limit: a picture
    keeps the position it is given, however far out, including clear off the
    slide. The size keeps its floor, as every kind does, so it cannot be resized
    into nothing — and its position can be typed back in the panel.
  */
  const cases = [
    ['hard right', 9999, 9999],
    ['hard left', -9999, -9999],
    ['clear off the slide', 5000, 5000],
    ['just past the edge', 760, -60],
  ];

  for (const [what, x, y] of cases) {
    const box = dragged('image', x, y, 900, 600);
    assertEqual(box.x, x, `${what}: the x it was given must be the x it keeps`);
    assertEqual(box.y, y, `${what}: and the y`);
  }

  // A picture that fits is not clamped either: there is one rule for pictures,
  // not one for each size.
  const small = dragged('image', -120, -80, 260, 190);
  assertEqual(small.x, -120, 'A small picture keeps a negative position too');
  assertEqual(small.y, -80, 'On both axes');

  // The size floor is the one thing that stays, so a picture cannot be lost by
  // being resized to nothing.
  const empty = dragged('image', 10, 10, 0, 0);
  assert(empty.width >= safeArea.MIN_WIDTH, `Width must keep a floor, got ${empty.width}`);
  assert(empty.height >= safeArea.MIN_HEIGHT, `Height must keep a floor, got ${empty.height}`);
});

test('text and buttons are pulled back to the safe area instead of getting stuck', () => {
  for (const kind of ['text', 'button', 'frame']) {
    const box = dragged(kind, 0, 0, 5000, 5000);
    // The size comes down rather than the position collapsing. Without this an
    // element this big has exactly one legal position, so it cannot be moved.
    assertEqual(box.width, 640, `${kind} should be no wider than the safe area`);
    assertEqual(box.height, 400, `${kind} should be no taller than the safe area`);
    assert(box.x >= safeArea.SAFE_MARGIN, `${kind} x must be inside`);
    assert(box.y >= safeArea.SAFE_MARGIN, `${kind} y must be inside`);
    assertEqual(box.x, safeArea.SAFE_MARGIN, `${kind} fills the width, so it sits at the left guide`);
  }
});

test('a video tile is pulled back without being squashed', () => {
  const box = dragged('video', 0, 0, 1600, 900);
  const before = 1600 / 900;

  assert(box.width <= 640, 'It fits the safe area across');
  assertClose(box.width / box.height, before, 0.01, 'A stretched face on the disc is what this prevents');
  /*
    And it uses the whole safe height. A tile used to stop at 396 to leave the
    navigation row its band, which capped this one at 356 tall even though it was
    nowhere near the bottom guide; with the row gone the width is what limits it,
    so it is the full 640 across and 360 down.
  */
  assert(
    box.y + box.height <= safeArea.RASTER.height - safeArea.SAFE_MARGIN,
    'And it stays inside the bottom guide'
  );
  assertEqual(box.width, 640, 'It fills the safe width, which is what limits it now');
  assertEqual(box.height, 360, 'Rather than stopping short of a row that is gone');
});

test('the editor and the authoring side share one clamp', () => {
  const deck = require('../src/core/deck');
  const slideLayout = require('../src/core/slide_layout');

  // Two copies of this rule is what let them disagree in the first place: the
  // editor's version and the authoring version were not the same arithmetic, and
  // only one of them was ever called.
  assertEqual(slideLayout.clampElement, safeArea.clampElement, 'One implementation, not two');
  assertEqual(deck.RASTER, safeArea.RASTER, 'And one definition of the raster');
  assertEqual(deck.SAFE_MARGIN, safeArea.SAFE_MARGIN, 'And of the margin');
});

test('an oversized picture survives being written to the disc and read back', () => {
  // The deck guard has to agree with the editor, or a picture that drags nicely
  // would be moved the moment anything laid the deck out again.
  const deckModel = require('../src/core/deck');
  const slideLayout = require('../src/core/slide_layout');

  const deck = {
    themeId: 'charcoal',
    slides: [
      deckModel.makeSlide({
        title: 'Full bleed',
        elements: [deckModel.makeImageElement({ x: -200, y: -150, width: 1100, height: 780 })],
      }),
    ],
  };

  const clamped = slideLayout.clampDeck(deckModel.normaliseDeck(deck));
  const image = clamped.slides[0].elements[0];
  assert(image.width > 640, `A picture may be wider than the safe area, got ${image.width}`);
  assert(image.x <= safeArea.SAFE_MARGIN, 'And is placed so it covers the area');
});

// ------------------------------------------- pictures that go somewhere ---

section('A picture the remote can land on');

test('a picture is only clickable when it has been given somewhere to go', () => {
  const slideLayout = require('../src/core/slide_layout');
  const deckModel = require('../src/core/deck');

  assertEqual(slideLayout.isSelectable(deckModel.makeButtonElement({ label: 'B' })), true, 'A button always is');
  assertEqual(slideLayout.isSelectable(deckModel.makeImageElement({})), false, 'A plain picture is not');
  assertEqual(
    slideLayout.isSelectable(deckModel.makeImageElement({ targetSlideId: 'other' })),
    true,
    'A picture with a slide to open is'
  );
  assertEqual(
    slideLayout.isSelectable(deckModel.makeImageElement({ videoId: 'v1' })),
    true,
    'And one pointed straight at a film is too'
  );
  for (const kind of ['text', 'frame']) {
    assertEqual(
      slideLayout.isSelectable({ kind, targetSlideId: 'other' }),
      false,
      `A ${kind} is not clickable even with a destination`
    );
  }
});

test('a picture keeps the slide it points at, and defaults to none', () => {
  const deckModel = require('../src/core/deck');

  const plain = deckModel.makeImageElement({ src: 'data:image/png;base64,x' });
  assertEqual(plain.targetSlideId, null, 'A new picture goes nowhere');
  assertEqual(plain.videoId, null, 'And plays nothing');

  const linked = deckModel.makeImageElement({ targetSlideId: 'second' });
  assertEqual(linked.targetSlideId, 'second', 'A destination survives being made');

  // Through normalising, which is what a saved deck and the pipeline both do.
  const slide = deckModel.makeSlide({ elements: [linked] });
  assertEqual(slide.elements[0].targetSlideId, 'second', 'And survives normalising');
});

test('a linked picture is a button on the disc, in every respect', () => {
  const deckModel = require('../src/core/deck');
  const dvdModel = require('../src/core/dvd_model');

  const slides = [
    deckModel.makeSlide({
      id: 'menu',
      title: 'Menu',
      role: 'menu',
      elements: [
        deckModel.makeImageElement({ id: 'linked', x: 40, y: 60, width: 200, height: 150, targetSlideId: 'second' }),
        deckModel.makeImageElement({ id: 'plain', x: 300, y: 60, width: 200, height: 150 }),
      ],
    }),
    deckModel.makeSlide({
      id: 'second',
      title: 'Second',
      role: 'menu',
      elements: [
        deckModel.makeImageElement({ id: 'back', x: 40, y: 300, width: 200, height: 100, targetSlideId: 'menu' }),
      ],
    }),
  ];

  const model = dvdModel.buildDiscModel({
    deck: { discTitle: 'T', themeId: 'charcoal', slides },
    videos: [],
  });

  assertEqual(model.menus.length, 2, 'Both slides become pages, because both have something to press');

  const page = model.menus[0];
  assertEqual(page.buttons.length, 1, 'Only the linked picture is a button on the first page');
  assertEqual(page.buttons[0].name, 'btn1', 'It is named like any other button');
  assertEqual(page.buttons[0].x0, 40, 'And carries the picture\u2019s own rectangle');
  assertEqual(page.buttons[0].y0, 60, 'Including its position');
  assertEqual(page.buttons[0].command, 'jump menu 2;', 'And jumps where a button pointing there would');

  // The remote has to be able to reach it, which is what makes it usable with a
  // handset rather than only with a mouse.
  assert(page.navigation.btn1, 'It takes part in arrow-key navigation');
  assertEqual(page.navigation.btn1.up, 'btn1', 'With somewhere for every arrow to go');

  // And the picture with nothing to do is not a button, so a plain picture
  // cannot turn a slide into a menu page or light up when the remote passes it.
  assert(
    !page.buttons.some((b) => b.label === '' && b.x0 === 300),
    'The plain picture was not made pressable'
  );
});

test('a plain picture does not turn its slide into a menu page', () => {
  const deckModel = require('../src/core/deck');
  const dvdModel = require('../src/core/dvd_model');

  const slides = [
    deckModel.makeSlide({
      id: 'art',
      title: 'Art',
      role: 'menu',
      elements: [
        deckModel.makeImageElement({ id: 'deco', x: 40, y: 60, width: 600, height: 300 }),
        deckModel.makeButtonElement({ id: 'go', label: 'Second', targetSlideId: 'second', x: 40, y: 380 }),
      ],
    }),
    deckModel.makeSlide({
      id: 'second',
      title: 'Second',
      role: 'menu',
      elements: [deckModel.makeButtonElement({ id: 'back', label: 'Back', targetSlideId: 'art' })],
    }),
  ];

  const model = dvdModel.buildDiscModel({
    deck: { discTitle: 'T', themeId: 'charcoal', slides },
    videos: [],
  });

  assertEqual(model.menus.length, 2, 'Two pages, one per slide');
  assertEqual(
    model.menus[0].buttons.length,
    1,
    'The decorative picture is not one of them'
  );
  assertEqual(model.menus[0].buttons[0].command, 'jump menu 2;', 'Only the button is');
});

test('a picture pointed at a slide holding a film plays the film', () => {
  const deckModel = require('../src/core/deck');
  const dvdModel = require('../src/core/dvd_model');

  const slides = [
    deckModel.makeSlide({
      id: 'menu',
      title: 'Menu',
      role: 'menu',
      elements: [
        deckModel.makeImageElement({ id: 'poster', targetSlideId: 'episode' }),
        deckModel.makeImageElement({ id: 'backdrop', targetSlideId: 'extras' }),
      ],
    }),
    deckModel.makeSlide({
      id: 'episode',
      title: 'Episode',
      role: 'content',
      elements: [deckModel.makeVideoElement({ id: 'v', videoId: 'v1' })],
    }),
    deckModel.makeSlide({
      id: 'extras',
      title: 'Extras',
      role: 'menu',
      elements: [deckModel.makeImageElement({ id: 'e2', targetSlideId: 'menu' })],
    }),
  ];

  const model = dvdModel.buildDiscModel({
    deck: { discTitle: 'T', themeId: 'charcoal', slides },
    videos: [{ id: 'v1', name: 'Episode one', duration: 600 }],
  });

  // The same rule a button follows: aiming at a slide that holds exactly one
  // film plays it rather than making the viewer choose it a second time.
  assertEqual(model.menus[0].buttons[0].command, 'jump title 1;', 'The poster plays the film');
  // Every slide here carries something pressable, so the pages are numbered in
  // slide order: the menu, the episode, then the extras.
  assertEqual(model.menus[0].buttons[1].command, 'jump menu 3;', 'The other opens the page');
});

// ------------------------------------------------------------ menu sound ---

section('A sound on a menu page');

test('a slide with no sound has none, and one with a sound keeps it', () => {
  const deckModel = require('../src/core/deck');

  const silent = deckModel.makeSlide({ title: 'Silent' });
  assertEqual(silent.audio, null, 'A new slide is silent');

  const withSound = deckModel.makeSlide({
    title: 'Music',
    audio: { path: '/music/song.mp3', fileName: 'song.mp3', duration: 42 },
  });
  assertEqual(withSound.audio.path, '/music/song.mp3', 'The file is remembered');
  assertEqual(withSound.audio.fileName, 'song.mp3', 'And its name, for the panel');
  assertEqual(withSound.audio.seconds, 42, 'A short sound plays in full');

  // Through normalising, which is what a saved deck and every main-process view
  // does — a sound dropped on the way in would be a silent disc.
  const round = deckModel.normaliseDeck({ slides: [withSound] });
  assertEqual(round.slides[0].audio.path, '/music/song.mp3', 'And survives normalising');
});

test('a sound longer than a menu may run is trimmed, not refused', () => {
  const deckModel = require('../src/core/deck');
  const cap = deckModel.MENU_SOUND_MAX_SECONDS;

  const long = deckModel.makeSlide({
    audio: { path: '/music/album.flac', duration: cap * 4 },
  });
  assertEqual(long.audio.duration, cap * 4, 'The real length is kept, so it can be said');
  assertEqual(long.audio.seconds, cap, 'But only the cap will play');

  // A length that could not be read at all still yields a usable page rather
  // than a zero-length motion menu, which is a disc that misbehaves.
  const unknown = deckModel.makeSlide({ audio: { path: '/music/odd.ogg' } });
  assertEqual(unknown.audio.duration, 0, 'An unreadable length is zero');
  assertEqual(unknown.audio.seconds, cap, 'And the page runs for the cap');
});

test('a sound with no file is the same as no sound', () => {
  const deckModel = require('../src/core/deck');
  for (const audio of [null, undefined, {}, { fileName: 'x.mp3' }, { path: '   ' }]) {
    assertEqual(
      deckModel.makeSlide({ audio }).audio,
      null,
      `audio ${JSON.stringify(audio)} should not become a sound`
    );
  }
});

test('a menu page carries its slide sound, and a silent one carries none', () => {
  const deckModel = require('../src/core/deck');
  const dvdModel = require('../src/core/dvd_model');

  const slides = [
    deckModel.makeSlide({
      id: 'one',
      title: 'One',
      role: 'menu',
      audio: { path: '/music/a.mp3', fileName: 'a.mp3', duration: 30 },
      elements: [deckModel.makeButtonElement({ id: 'b1', label: 'Next', targetSlideId: 'two' })],
    }),
    deckModel.makeSlide({
      id: 'two',
      title: 'Two',
      role: 'menu',
      elements: [deckModel.makeButtonElement({ id: 'b2', label: 'Back', targetSlideId: 'one' })],
    }),
  ];

  const model = dvdModel.buildDiscModel({
    deck: { discTitle: 'T', themeId: 'charcoal', slides },
    videos: [],
  });

  assertEqual(model.menus.length, 2, 'Both slides are pages');
  assertEqual(model.menus[0].sound.path, '/music/a.mp3', 'The first page has its sound');
  assertEqual(model.menus[0].sound.seconds, 30, 'With the length that will play');
  assertEqual(model.menus[1].sound, null, 'The silent page has none');

  // And a page whose sound has no usable length is treated as silent rather than
  // becoming a motion menu of no length.
  assertEqual(dvdModel.soundFor({ audio: { path: '/x.mp3', seconds: 0, duration: 0 } }), null, 'No length, no sound');
  assertEqual(dvdModel.soundFor({}), null, 'No audio at all, no sound');
});

test('the menu encoder holds the still with prediction when there is sound', () => {
  const author = require('../src/core/author');

  const silent = author.buildMenuStillArgs({
    inputPng: 'menu.png',
    outputVob: 'menu.mpg',
    videoFormat: 'ntsc',
  }).join(' ');

  const sounded = author.buildMenuStillArgs({
    inputPng: 'menu.png',
    outputVob: 'menu.mpg',
    videoFormat: 'ntsc',
    audioPath: '/music/song.mp3',
    seconds: 90,
  }).join(' ');

  // Silent pages stay all-intra: instant to seek, and at one second it costs
  // nothing. A sounded page held for a minute and a half at that rate would be
  // hundreds of megabytes, so it uses ordinary prediction instead.
  assert(silent.includes('-bf 0'), 'A silent menu is encoded all-intra');
  assert(silent.includes('anullsrc'), 'And carries a silent track so the DVD muxer can work');
  assert(!silent.includes('-map 1:a:0'), 'With nothing else mapped in');

  assert(sounded.includes('-bf 2'), 'A menu with sound predicts from the previous frame');
  assert(sounded.includes('-map 1:a:0'), 'And takes its audio from the chosen file');
  assert(!sounded.includes('anullsrc'), 'Instead of generating silence');
  assert(sounded.includes('-c:a ac3'), 'The sound is AC-3, which is what a DVD menu may carry');
  assert(sounded.includes('-ar 48000'), 'At 48 kHz, which is mandatory');
  assert(sounded.includes('-t 90'), 'And runs for the length the disc model settled on');

  // The picture quality of the one frame that matters is not given up for it.
  assert(sounded.includes('-b:v 9800000'), 'The still is still encoded at the maximum still rate');
});

test('a sound does not change the disc fingerprint by being played once', () => {
  const deckModel = require('../src/core/deck');

  // The sound lives in the deck, and the deck is fingerprinted — so choosing or
  // removing one makes a prepared disc out of date, which is what has to happen
  // for the change to reach a burned disc.
  const root = tmpdir('sound-fingerprint');
  const file = sourceFile(root, 'a.mp4');
  const video = { path: file, duration: 600, name: 'a.mp4', menuLabel: '' };
  const base = () => ({
    id: 'proj',
    videos: [video],
    discTitle: 'Trip',
    deck: {
      discTitle: 'Trip',
      themeId: 'charcoal',
      slides: [
        deckModel.makeSlide({
          id: 's1',
          title: 'Menu',
          role: 'menu',
          elements: [deckModel.makeButtonElement({ id: 'b', label: 'Go', targetSlideId: 's2' })],
        }),
        deckModel.makeSlide({ id: 's2', title: 'Two', role: 'menu' }),
      ],
    },
  });

  const without = pipeline.projectFingerprint(pipeline.normaliseProject(base()));
  const payload = base();
  payload.deck.slides[0].audio = { path: '/music/a.mp3', duration: 30 };
  const withSound = pipeline.projectFingerprint(pipeline.normaliseProject(payload));

  assert(withSound !== without, 'Adding a sound must make a prepared disc out of date');
});

// --------------------------------------------------------------------- go ---

console.log('');
if (failed) {
  console.log(`${failed} of ${passed + failed} checks failed.`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
} else {
  console.log(`All ${passed} checks passed.`);
}
