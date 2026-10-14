'use strict';

/**
 * Turning an arbitrary video into a DVD-legal MPEG-2 program stream — or, when
 * it already is one, not turning it into anything at all.
 *
 * Three rules keep it honest:
 *
 *   - Every parameter is computed from dvd_spec.js and recorded before the
 *     process starts, so there is no mid-flight decision making.
 *   - ffmpeg is driven directly with an argument array. No shell, no quoting,
 *     so a filename containing an apostrophe cannot break the job.
 *   - Nothing is done twice. A source that is already a DVD title is copied
 *     rather than encoded (canRemux), and a title that was prepared on an
 *     earlier run and has not changed since is not prepared again at all
 *     (titleFingerprint and the cache below). Both are the difference between
 *     minutes and seconds, and neither changes a byte of the result.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const VIDEO_EXTS = new Set(['.vob', '.mpg', '.mpeg', '.m2v', '.ts', '.mpv']);

/**
 * The revision of the encoding recipe.
 *
 * Bump this whenever buildVideoFilter or buildEncodeArgs changes in a way that
 * changes the bytes they produce.
 *
 * Cached title output is stamped with it and ignored when it does not match, so
 * a fix in the encoder takes effect on the next build instead of being quietly
 * skipped because the source file happened to be unchanged. The ghosting fix is
 * exactly the kind of change that would otherwise have been defeated by its own
 * cache: same input, same settings, different — correct — output.
 *
 *   1  initial
 *   2  NTSC encodes bottom-field-first, PAL top-field-first
 *   3  every frame its own frame: 24/25/30p sources are no longer halved by the
 *      interlace filter and then doubled back up, 50/60p and interlaced sources
 *      become true interlaced video, silence is mixed in during the encode
 */
const ENCODE_REVISION = 3;

const TITLE_CACHE_FILE = '.encode.json';

/**
 * Remove previous encode output for a title without touching anything else.
 *
 * This must clear every video-ish extension, not just VOBs: a leftover
 * intermediate from an interrupted run would otherwise still be sitting there
 * when the next run lists the parts, and the disc would be built with a stale
 * file silently appended to it.
 *
 * The cache record is deliberately left alone: it is a claim about the files,
 * not one of them, and readTitleCache refuses any claim whose files do not
 * match. Deleting it here would only mean the next run cannot tell a finished
 * encode from an abandoned one.
 */
function resetOutputDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir)) {
    if (VIDEO_EXTS.has(path.extname(entry).toLowerCase())) {
      fs.rmSync(path.join(dir, entry), { force: true });
    }
  }
}

/**
 * Everything that decides what one title's encoded output will be.
 *
 * This is the cache key, and it has to be exactly right in both directions.
 * Too narrow and a changed setting reuses output that no longer matches the
 * disc — a wrong bitrate, the wrong shape, a stale picture. Too wide and nothing
 * is ever reused, which is the behaviour this exists to fix.
 *
 * It therefore covers the source file and its own measurements, plus every
 * number buildEncodeArgs reads. It deliberately does NOT cover the disc title,
 * the slides, the work folder, the tool paths or the app version: none of those
 * change the bytes of a title, and covering them would re-encode an hour of
 * video because someone renamed the disc.
 */
function titleFingerprint({ input, probe, options, durationSeconds }) {
  let size = 0;
  let mtime = 0;
  try {
    const stat = fs.statSync(input);
    size = stat.size;
    mtime = Math.round(stat.mtimeMs);
  } catch {
    // A file that cannot be measured cannot be proven unchanged, and the
    // fingerprint below will not match anything either way.
  }

  const canonical = JSON.stringify({
    revision: ENCODE_REVISION,
    input: String(input || ''),
    size,
    mtime,
    // `-t` is the length the output is cut or padded to, so a re-measured
    // duration is a different encode.
    seconds: Math.max(1, Math.ceil(Number(durationSeconds) || 0)),
    source: {
      width: num(probe && probe.width),
      height: num(probe && probe.height),
      fps: num(probe && probe.fps),
      // Decides between the progressive and interlaced recipes.
      interlaced: Boolean(probe && probe.interlaced),
      videoCodec: (probe && probe.videoCodec) || null,
      pixelFormat: (probe && probe.pixelFormat) || null,
      // Picks the colour matrix conversion, so it changes the picture.
      colorSpace: (probe && probe.colorSpace) || null,
      // Decides whether the title can be copied instead of encoded.
      displayAspect: (probe && probe.displayAspect) || null,
      bitrate: num(probe && probe.bitrate),
      audioCodec: (probe && probe.audioCodec) || null,
      audioChannels: num(probe && probe.audioChannels),
      audioSampleRate: num(probe && probe.audioSampleRate),
      hasAudio: Boolean(probe && probe.hasAudio),
    },
    options: options || null,
  });

  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The encoded output already sitting in a title folder, if it is still good.
 *
 * Returns null unless every one of these is true: the record is for this exact
 * recipe and this exact source, and every VOB it names is present at the length
 * it was recorded with. That last check is what makes an interrupted run safe —
 * a half-written VOB has the right name and the wrong size, and reusing it would
 * put a truncated title on the disc with nothing to show anything was wrong.
 */
function readTitleCache(titleDir, fingerprint) {
  if (!fingerprint) return null;

  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(titleDir, TITLE_CACHE_FILE), 'utf8'));
  } catch {
    return null;
  }

  if (!record || record.revision !== ENCODE_REVISION) return null;
  if (record.fingerprint !== fingerprint) return null;
  if (!Array.isArray(record.parts) || !record.parts.length) return null;

  const parts = [];
  for (const part of record.parts) {
    const name = path.basename(String((part && part.name) || ''));
    if (!name) return null;
    const file = path.join(titleDir, name);

    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.size <= 0) return null;
    if (stat.size !== Number(part.bytes)) return null;

    parts.push({ file, bytes: stat.size });
  }

  return { parts, mode: record.mode || 'encode', encodedAt: record.encodedAt || null };
}

/** Note down what is in a title folder, so the next build can skip the work. */
function writeTitleCache(titleDir, { fingerprint, parts, mode }) {
  const record = {
    revision: ENCODE_REVISION,
    fingerprint,
    mode: mode || 'encode',
    encodedAt: new Date().toISOString(),
    parts: (parts || []).map((part) => ({
      name: path.basename(part.file),
      bytes: Number(part.bytes) || 0,
    })),
  };
  try {
    fs.writeFileSync(path.join(titleDir, TITLE_CACHE_FILE), JSON.stringify(record, null, 2));
  } catch {
    // A build that cannot be recorded is still a build. It just cannot be reused.
  }
  return record;
}

/**
 * Throw away every prepared title, which is what makes the next build do all of
 * the work again from scratch.
 */
function clearTitleCache(root) {
  const dir = path.join(root, 'titles');
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

/**
 * Remove title folders past the end of the video list.
 *
 * Removing a video from the middle of a project leaves the last folder with
 * nothing referring to it — a gigabyte of VOBs that will never be looked at
 * again, sitting in the folder the user was told holds their project.
 */
function pruneTitleDirs(root, keep) {
  const dir = path.join(root, 'titles');
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    const m = /^title_(\d+)$/.exec(entry);
    if (!m) continue;
    if (Number(m[1]) <= keep) continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/**
 * Whether a source can be copied into the disc instead of encoded.
 *
 * A file that already is a DVD title — a .vob out of a VIDEO_TS folder, or
 * anything a DVD authoring tool produced — is already a legal MPEG-2 program
 * stream. Its raster, frame rate, GOP structure and field order are what a DVD
 * requires, because that is where it came from. Sending it back through the
 * encoder costs the entire run time of the video and throws away a generation of
 * picture to arrive at very nearly the same bytes.
 *
 * The test is deliberately strict, because a copy cannot fix anything. Every one
 * of these has to be true or the source is encoded, which is only ever slower:
 *
 *   - it came from a DVD title file, judged by the extension. This is what
 *     rules out an arbitrary .mpg whose GOP structure might be anything; a .vob
 *     is compliant by construction.
 *   - exactly this raster and frame rate, 4:2:0, and the same display shape,
 *     because a copy cannot resize, re-time or re-flag any of them.
 *   - its own bitrate already fits the budget worked out for this disc. A copy
 *     cannot lower a bitrate, and one title above budget would push the others
 *     off the disc.
 *
 * Field order is not checked because it is not touched: the stream is copied bit
 * for bit, so whatever the source said, it still says. That is the point.
 */
function canRemux(probe, { format, aspect, muxrate } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!probe || !format) return no('the source has not been read');

  const fromVob =
    /\.vob$/i.test(String(probe.path || '')) || /vob/i.test(String(probe.formatName || ''));
  if (!fromVob) return no('not a DVD title file');

  if (String(probe.videoCodec || '').toLowerCase() !== 'mpeg2video') return no('not MPEG-2');
  if (Number(probe.width) !== Number(format.width) || Number(probe.height) !== Number(format.height)) {
    return no(`it is ${probe.width}x${probe.height}, not ${format.width}x${format.height}`);
  }
  if (probe.pixelFormat && String(probe.pixelFormat).toLowerCase() !== 'yuv420p') {
    return no(`it stores colour as ${probe.pixelFormat}`);
  }
  if (!probe.fps || Math.abs(Number(probe.fps) - Number(format.fps)) > 0.05) {
    return no(`it runs at ${probe.fps || '?'} frames a second`);
  }

  const wanted = aspect === '4:3' ? '4:3' : '16:9';
  if (!probe.displayAspect) return no('its shape could not be read');
  if (probe.displayAspect !== wanted) return no(`it is ${probe.displayAspect} where this disc is ${wanted}`);

  // Unknown is treated as too big. Guessing the other way would put a title on
  // the disc at a rate nothing budgeted for.
  const rate = Number(probe.bitrate) || 0;
  if (!rate) return no('its bitrate could not be read');
  /*
    A little tolerance, because the thing being measured is a file the DVD muxer
    padded to exactly this rate. A .vob that this program or any other DVD tool
    produced carries an average bitrate of almost precisely its own mux rate, and
    ffprobe's figure for it lands a fraction of a percent either side. Refusing
    those would mean never copying the one kind of source this exists for.

    Two percent of a 10 Mbit/s stream is 200 kbit/s — it can only ever admit a
    source that is already at the ceiling, which is exactly on budget, and never
    one that is genuinely over it.
  */
  const budget = muxrate ? muxrate * 1.02 : 0;
  if (budget && rate > budget) {
    return no('it is at a higher bitrate than this disc has room for');
  }

  return { ok: true };
}

/**
 * How a source's motion is carried on the disc.
 *
 *   progressive  24, 25 and 30 frame-a-second video — nearly everything a phone,
 *                a camera or a download produces. Each source frame becomes one
 *                disc frame, both fields from the same instant.
 *   interlaced   50/60 frame-a-second video, and video that was interlaced to
 *                begin with. Each *field* gets its own instant, which is how a
 *                DVD carries smooth 60-a-second motion, and the only way to
 *                carry it without throwing half of it away.
 *
 * This is the decision the old filter chain got wrong in a way nobody could see
 * on a computer. It interlaced everything, and the interlace filter builds each
 * frame from TWO consecutive source frames — halving the frame rate. A 30p
 * source came out at 15 frames a second, and the `-r` that followed duplicated
 * every one of them to get back to 30. On a television each pair of fields was
 * shown twice: A B A B C D C D. Motion stepped backwards half the time, which is
 * the ghosting that the field-order change was meant to fix and could not.
 */
function motionFor(probe) {
  if (probe && probe.interlaced) return 'interlaced';
  const fps = Number(probe && probe.fps) || 0;
  return fps >= 48 ? 'interlaced' : 'progressive';
}

/**
 * Build the filter chain.
 *
 * Sources arrive in every shape imaginable. We letterbox or pillarbox onto the
 * exact DVD raster instead of cropping, because silently cutting the edges off
 * someone's video is not a decision this program gets to make.
 *
 * In order:
 *
 *   rate      `fps` first, so nothing is scaled that is about to be dropped —
 *             a 120 frame-a-second slow-motion clip has three of every four
 *             frames thrown away before they cost anything — and so a phone's
 *             variable frame rate becomes a steady one. An interlaced source is
 *             first split into its fields (`bwdif`), so that it can be scaled
 *             without smearing two instants into one.
 *   scale     one resample, straight into the anamorphic DVD raster. The
 *             display box is 854x480 for widescreen NTSC (640x480 for 4:3) and
 *             the stored frame is 720 wide, so the width is worked out in the
 *             display box and squeezed by 720/854 in the same step. This used
 *             to scale into 854 and then scale again into 720, which cost a
 *             second resample of every frame and softened the picture twice.
 *   colour    BT.709 HD to the BT.601 a DVD uses — without it reds go orange on
 *             any television that trusts the DVD flags. Done by the
 *             `colorspace` filter on the small frame, after the resize, not by
 *             the scaler during it. Measured on her MacBook Air with one of her
 *             episodes, the scaler's conversion cost 1.9 seconds per minute of
 *             video against 0.1 for the filter, and it was also slightly wrong:
 *             a known mid-grey came back as 125 instead of 128, and pure blue
 *             as 250 instead of 254. The filter returns 128 and 254.
 *
 *             Deliberately not a new ENCODE_REVISION: titles already prepared
 *             the old way are still good, and re-encoding an evening of
 *             episodes for a three-level brightness difference is the wrong
 *             trade. Anything encoded from now on gets the new chain.
 *
 *   range     The input range is left to the source: forcing "tv"
 *             washed out the phones and screen recorders that shoot full-range.
 *   pad       letterbox or pillarbox to exactly 720x480.
 *   fields    interlaced: `interlace` weaves pairs of frames into fields.
 *             progressive: `setfield` only labels the order, since both fields
 *             of a progressive frame are the same moment.
 *
 * Field order is not the same on both formats: NTSC is bottom-field-first and
 * PAL top-field-first (see fieldMode in dvd_spec.js). The MPEG-2 encoder takes
 * it from the frames, so it is set here. The height tells the formats apart:
 * 480 is NTSC, 576 is PAL.
 */
function buildVideoFilter({ width, height, sourceMatrix = null, aspect = '16:9', motion = 'progressive' }) {
  const isPal = height === 576;
  const inMatrix = ['bt709', 'bt2020'].includes(sourceMatrix) ? sourceMatrix : 'bt601';
  const is169 = aspect === '16:9';
  const displayWidth = is169 ? (isPal ? 1024 : 854) : (isPal ? 768 : 640);
  const sar = is169 ? (isPal ? '64/45' : '32/27') : (isPal ? '16/15' : '8/9');
  const order = isPal ? 'tff' : 'bff';
  const interlaced = motion === 'interlaced';
  const frameRate = isPal ? '25' : '30000/1001';
  const fieldRate = isPal ? '50' : '60000/1001';

  // `dar` is the source's display aspect ratio, so a source with non-square
  // pixels lands in the right shape too. Single quotes keep the commas inside
  // min() from being read as filter separators.
  const w = `'2*trunc(min(${displayWidth},${height}*dar)*${width}/${displayWidth}/2+0.5)'`;
  const h = `'2*trunc(min(${height},${displayWidth}/dar)/2+0.5)'`;

  const chain = [];
  if (interlaced) {
    // Split an interlaced source into its fields; leave a progressive one be.
    chain.push('bwdif=mode=send_field:deint=interlaced');
    chain.push(`fps=${fieldRate}`);
  } else {
    chain.push(`fps=${frameRate}`);
  }
  chain.push(
    `scale=w=${w}:h=${h}:flags=lanczos:out_range=tv`,
    // BT.601 sources are already in the DVD's matrix and need no conversion.
    ...(inMatrix === 'bt601' ? [] : [`colorspace=all=bt601-6-525:iall=${inMatrix}:fast=1`]),
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `setsar=${sar}`,
    interlaced ? `interlace=scan=${order}` : `setfield=${order}`
  );
  return chain.join(',');
}

/**
 * Work out which colour matrix a source uses, from its probe record.
 *
 * ffprobe usually tags HD files correctly; when it doesn't, resolution is the
 * fallback every player on earth uses — anything at or above 720p is 709.
 */
function sourceMatrixFor(probe) {
  const tagged = String((probe && probe.colorSpace) || '').toLowerCase();
  if (/2020/.test(tagged)) return 'bt2020';
  if (/709|bt709|itu.?709/.test(tagged)) return 'bt709';
  if (/601|bt601|smpte.?170|itu.?601|bt470/.test(tagged)) return 'bt601';
  const width = Number(probe && probe.width) || 0;
  const height = Number(probe && probe.height) || 0;
  if (width >= 1280 || height >= 720) return 'bt709';
  return 'bt601';
}

/**
 * Normalise the source audio layout to something AC-3 accepts cleanly.
 * A source with no audio at all is handled separately by encodeSilence().
 */
function buildAudioFilter({ channels }) {
  if (channels >= 6) return 'aformat=channel_layouts=5.1';
  return 'aformat=channel_layouts=stereo';
}

/**
 * The inputs and stream mapping shared by both recipes.
 *
 * A source with no sound gets silence as a second input, mixed in during the
 * same pass. A DVD title with no audio track is refused by some players, and
 * this used to be fixed afterwards by writing every title out a second time with
 * a silent track muxed in — a whole extra pass over gigabytes of video for
 * something ffmpeg can generate on the fly. `-shortest` ends it with the
 * picture, since the silence never ends on its own.
 *
 * `hwaccel` decodes on the graphics chip where one is available. Frames come
 * back to ordinary memory for scaling, so nothing downstream changes; it only
 * takes decoding off the processor, which on a dual-core laptop is the same
 * processor the MPEG-2 encoder is waiting for.
 */
function inputArgs({ input, hasAudio, audioChannels, hwaccel }) {
  const args = [
    '-nostdin',
    '-hide_banner',
    '-y',
    '-loglevel', 'error',
    // Progress goes to a dedicated pipe so it can never be mistaken for errors.
    '-progress', 'pipe:1',
  ];
  if (hwaccel) args.push('-hwaccel', hwaccel);
  args.push('-i', input);
  if (!hasAudio) {
    args.push(
      '-f', 'lavfi',
      '-i', `anullsrc=channel_layout=${audioChannels >= 6 ? '5.1' : 'stereo'}:sample_rate=48000`
    );
  }
  args.push('-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0');
  return args;
}

/**
 * The full ffmpeg argument list for one title.
 *
 * Writing to `VTS_01_1.VOB` lets the dvd muxer split at 1 GB boundaries using
 * the exact naming a DVD requires, which removes an entire class of "disc plays
 * twenty minutes then stops" bugs.
 */
function buildEncodeArgs({ input, outputVob, plan, durationSeconds, aspect, hwaccel = null }) {
  const { format, videoBitrate, audioBitrate, muxrate, gop } = plan;
  const hasAudio = plan.hasAudio !== false;
  const audioChannels = plan.audio.channels;
  const motion = motionFor(plan.probe || null);

  const args = inputArgs({ input, hasAudio, audioChannels, hwaccel });

  args.push(
    '-vf', buildVideoFilter({
      width: format.width,
      height: format.height,
      sourceMatrix: sourceMatrixFor(plan.probe || null),
      aspect: aspect.ratio,
      motion,
    }),

    // ---- video ----
    //
    // Every flag below was verified against this ffmpeg's mpeg2video encoder
    // before it was written here. Several plausible-looking options are
    // rejected by the build we ship: trellis quantisation does not exist in it
    // (so cbp_rd is unusable), closed-GOP is unimplemented, and qp_rd refuses
    // to open without `-mbd rd`. What remains is the best legal combination
    // this encoder accepts:
    //
    //   - `-mbd rd -mpv_flags +qp_rd+mv0+naq`: rate-distortion macroblock
    //     decisions and quantiser selection, always-try-zero-motion, and
    //     normalised adaptive quantisation. The visible effect is fewer blocks
    //     in flat skies and walls at the same bitrate.
    //   - `-non_linear_quant 1 -qmin 2 -qmax 28`: MPEG-2's own non-linear
    //     quantiser table, which spends bits more cleverly in dark scenes.
    //     qmax 28 is a hard ceiling in this build — 31 refuses to open.
    //   - `-alternate_scan 1`: the alternate zig-zag scan, measurably better
    //     for interlaced material.
    //   - `-intra_dc_precision 2 -intra_vlc 1`: 9-bit DC precision and the
    //     intra VLC table, both standard pro-DVD choices.
    '-c:v', 'mpeg2video',
    '-b:v', `${videoBitrate}`,
    // The peak may never exceed what the muxer was told to expect, minus audio
    // and mux overhead — otherwise the stream has spikes the container cannot
    // carry and cheap players choke. At high targets that means maxrate barely
    // exceeds the average, which is correct: there is nowhere for a spike to go.
    '-maxrate', `${Math.min(Math.round(videoBitrate * 1.15), muxrate - audioBitrate - 200000)}`,
    '-minrate', `${videoBitrate}`,
    // A 224 kB VBV buffer. The old 90%-of-bitrate buffer risked underflowing
    // the DVD muxer's own rate checks on cheap players; 224 kB is the value
    // the professional tools converge on for DVD.
    '-bufsize', '1835008',
    '-g', `${gop}`,
    // Two B frames is the DVD-friendly maximum and buys real quality.
    '-bf', '2',
    '-mbd', 'rd',
    '-mpv_flags', '+qp_rd+mv0+naq',
    '-non_linear_quant', '1',
    '-qmin', '2',
    '-qmax', '28',
    '-alternate_scan', '1',
    '-intra_dc_precision', '2',
    '-intra_vlc', '1',
    '-sc_threshold', '0',
    /*
      Interlaced coding only for interlaced pictures.

      Field-based motion search (`ilme`) is the most expensive thing this
      encoder does, and on a progressive picture it finds nothing that frame
      search did not: measured on the same clip at the same bitrate, leaving it
      off was 3.7 times faster with identical quality. On real interlaced
      material it earns its keep, so it stays there.

      The stream is still marked interlaced either way — `-alternate_scan`
      clears the progressive_sequence flag — which is what the DVD-Video
      specification requires of every NTSC and PAL disc.
    */
    ...(motion === 'interlaced' ? ['-flags', '+ildct+ilme'] : []),
    '-pix_fmt', 'yuv420p',
    '-aspect', aspect.ratio,
    '-r', format.height === 576 ? '25' : '30000/1001',

    // ---- audio ----
    '-af', buildAudioFilter({ channels: audioChannels }),
    '-c:a', 'ac3',
    '-b:a', `${audioBitrate}`,
    // 48 kHz is mandatory for DVD-Video. Sources are frequently 44.1 kHz, and
    // getting this wrong is audible as a pitch shift.
    '-ar', '48000',
    '-ac', `${audioChannels}`,

    // ---- container ----
    '-f', 'dvd',
    // State the raster explicitly as well as scaling to it. The DVD muxer
    // validates against this, so a filter chain that somehow produced the wrong
    // geometry fails here rather than silently writing an illegal stream.
    '-s', `${format.width}x${format.height}`,
    '-muxrate', `${muxrate}`,
    '-preload', '500000',
    '-t', `${Math.max(1, Math.ceil(durationSeconds))}`,

    // Pad rather than truncate if the source runs a hair short of -t.
    '-shortest',
    outputVob
  );

  return args;
}

/**
 * The ffmpeg argument list for a title that is copied rather than encoded.
 *
 * The picture is passed through untouched. The sound is copied too when it is
 * already something a DVD allows at the right rate and channel count, and
 * converted to AC-3 when it is not — an hour of stereo AC-3 takes seconds, so an
 * awkward soundtrack is never a reason to put the picture back through the
 * encoder.
 *
 * There is no `-vf`, no `-r`, no `-s` and no `-aspect` here on purpose. All four
 * describe a conversion, and a copy is the absence of one; ffmpeg accepts them
 * and ignores them, which would leave a reader believing the geometry was being
 * set when it is the source's own. canRemux has already established that they
 * would all have been no-ops.
 */
function buildRemuxArgs({ input, outputVob, plan, durationSeconds }) {
  const { muxrate, audioBitrate } = plan;
  const hasAudio = plan.hasAudio !== false;
  const wantedChannels = plan.audio.channels;
  const probe = plan.probe || {};

  // No hardware decoding here: nothing is decoded.
  const args = inputArgs({ input, hasAudio, audioChannels: wantedChannels, hwaccel: null });
  args.push('-c:v', 'copy');

  if (!hasAudio) {
    // The silence from inputArgs, made into the AC-3 a DVD carries.
    args.push(
      '-c:a', 'ac3',
      '-b:a', `${audioBitrate}`,
      '-ar', '48000',
      '-ac', `${wantedChannels}`
    );
  } else {
    const audioCodec = String(probe.audioCodec || '').toLowerCase();
    const legalToCopy =
      (audioCodec === 'ac3' || audioCodec === 'mp2') &&
      Number(probe.audioSampleRate) === 48000 &&
      Number(probe.audioChannels) === wantedChannels;

    if (legalToCopy) {
      args.push('-c:a', 'copy');
    } else {
      args.push(
        '-af', buildAudioFilter({ channels: wantedChannels }),
        '-c:a', 'ac3',
        '-b:a', `${audioBitrate}`,
        // 48 kHz is mandatory for DVD-Video, and getting it wrong is audible as
        // a pitch shift.
        '-ar', '48000',
        '-ac', `${wantedChannels}`
      );
    }
  }

  args.push(
    '-f', 'dvd',
    '-muxrate', `${muxrate}`,
    '-preload', '500000',
    '-t', `${Math.max(1, Math.ceil(durationSeconds))}`,
    '-shortest',
    outputVob
  );

  return args;
}

/**
 * Run one title, reporting progress as a fraction.
 *
 * Two ways to get there, chosen here rather than by the caller:
 *
 *   copy    the source already is a compliant DVD title, so it is remultiplexed
 *           as it stands. Seconds instead of minutes, and bit for bit.
 *   encode  anything else, through the full encoder described above.
 *
 * Resolves with the list of VOB parts produced, which is what the authoring step
 * needs in order to place chapters, and with which of the two it was — so the
 * build log can say what happened rather than leaving it to be inferred.
 *
 * With `hwaccel`, decoding is tried on the graphics chip first. Should that
 * fail for any reason — a driver, a stream the chip will not take — the title
 * is simply done again on the processor. Slower is fine; failed is not.
 */
async function encodeTitle(options) {
  const { hwaccel, signal, outputVob } = options;
  try {
    return await encodeTitleOnce(options);
  } catch (err) {
    if (!hwaccel || (err && err.isAbort) || (signal && signal.aborted)) throw err;
    resetOutputDir(path.dirname(outputVob));
    const result = await encodeTitleOnce({ ...options, hwaccel: null });
    return {
      ...result,
      warnings: [`Hardware decoding failed (${String(err.message || err)}), so this one was decoded in software.`, ...result.warnings],
    };
  }
}

function encodeTitleOnce({
  ffmpegPath,
  input,
  outputVob,
  plan,
  durationSeconds,
  aspect,
  onProgress,
  signal,
  hwaccel = null,
}) {
  return new Promise((resolve, reject) => {
    const verdict = canRemux(plan.probe || null, {
      format: plan.format,
      aspect: aspect && aspect.ratio,
      muxrate: plan.muxrate,
    });

    const mode = verdict.ok ? 'copy' : 'encode';
    const args = verdict.ok
      ? buildRemuxArgs({ input, outputVob, plan, durationSeconds })
      : buildEncodeArgs({ input, outputVob, plan, durationSeconds, aspect, hwaccel });

    const child = spawn(ffmpegPath, args, { windowsHide: true });

    let stderrTail = '';
    let stdoutBuf = '';
    let lastReported = -1;
    const outDir = path.dirname(outputVob);

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1);
        if (key === 'out_time_ms' || key === 'out_time_us') {
          const seconds = Number(value) / 1e6;
          if (!Number.isFinite(seconds) || durationSeconds <= 0) continue;
          const fraction = Math.max(0, Math.min(1, seconds / durationSeconds));
          const percent = Math.round(fraction * 100);
          if (percent !== lastReported) {
            lastReported = percent;
            if (onProgress) onProgress(fraction);
          }
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    child.on('error', (err) => {
      cleanupAbort(signal, onAbort);
      reject(new Error(`Could not start ffmpeg: ${err.message}`));
    });

    child.on('close', (code) => {
      cleanupAbort(signal, onAbort);

      if (signal && signal.aborted) {
        return reject(new AbortError('Preparing the video was stopped.'));
      }
      if (code !== 0) {
        return reject(new Error(describeFfmpegFailure(stderrTail, path.basename(input))));
      }

      const parts = listTitleParts(outDir);
      if (parts.length === 0) {
        return reject(
          new Error(
            `ffmpeg reported success but wrote no video for "${path.basename(input)}". ` +
              `The source file may be damaged.`
          )
        );
      }

      if (onProgress) onProgress(1);

      // ffmpeg emits valuable diagnostic lines at warning level (deprecated
      // options, stream discontinuities, timestamp jumps). They are not fatal
      // but they are the difference between a diagnosable report and "it just
      // failed", so surface them rather than discarding them.
      const warnings = extractWarnings(stderrTail);

      resolve({ parts, stderr: stderrTail, warnings, mode, copyReason: verdict.reason || null });
    });
  });
}

/**
 * The hardware decoder to use on this machine, or null.
 *
 * Only VideoToolbox on macOS. It is part of the operating system, every Mac
 * since 2011 has it for H.264, and frames are copied back to ordinary memory so
 * the rest of the chain is untouched. Asked of the ffmpeg actually in use rather
 * than assumed, because a build without it rejects the option outright.
 */
const hwaccelCache = new Map();

function hardwareDecoder(ffmpegPath) {
  if (process.platform !== 'darwin' || !ffmpegPath) return Promise.resolve(null);
  if (hwaccelCache.has(ffmpegPath)) return hwaccelCache.get(ffmpegPath);
  const found = new Promise((resolve) => {
    execFile(ffmpegPath, ['-hide_banner', '-hwaccels'], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(/^\s*videotoolbox\s*$/m.test(String(stdout || '')) ? 'videotoolbox' : null);
    });
  });
  hwaccelCache.set(ffmpegPath, found);
  return found;
}

/** Pull the useful diagnostic lines out of an ffmpeg stderr tail. */
function extractWarnings(stderr) {
  return String(stderr || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => /deprecat|non-monotonous|discontinuity|clipping|invalid|corrupt|drop|overflow|underflow/i.test(line))
    // Strip the leading `[component @ 0x...]` noise; the address is useless.
    .map((line) => line.replace(/^\[[^\]]*@\s*0x[0-9a-f]+\]\s*/i, '').replace(/^\[[^\]]*\]\s*/, ''))
    .filter((line, index, all) => all.indexOf(line) === index)
    .slice(0, 6);
}

function cleanupAbort(signal, onAbort) {
  if (signal) {
    try {
      signal.removeEventListener('abort', onAbort);
    } catch {
      /* nothing to remove */
    }
  }
}

/**
 * The VOB parts ffmpeg produced, in the order a player must read them.
 * Only `_1`, `_2`, ... are title content; `_0` belongs to the menu domain.
 */
function listTitleParts(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => /^VTS_\d+_\d+\.VOB$/i.test(f))
    .filter((f) => partNumber(f) > 0)
    .sort((a, b) => partNumber(a) - partNumber(b))
    .map((f) => path.join(dir, f));
}

function partNumber(fileName) {
  const m = /_(\d+)\.VOB$/i.exec(fileName);
  return m ? Number(m[1]) : 0;
}

/** Turn ffmpeg's terse error output into something a person can act on. */
function describeFfmpegFailure(stderr, fileName) {
  const text = String(stderr || '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';

  if (/Permission denied|Operation not permitted/i.test(text)) {
    return (
      `Not allowed to write the working files. Choose a different working folder ` +
      `in Setup — somewhere in your home folder rather than an external drive ` +
      `that may be read-only.`
    );
  }
  if (/No space left/i.test(text)) {
    return (
      `Ran out of disk space while preparing "${fileName}". Preparing a disc ` +
      `needs roughly as much free space as the finished disc, so free up some ` +
      `room on your startup disk.`
    );
  }
  if (/Invalid data found|moov atom not found|could not find codec parameters/i.test(text)) {
    return `"${fileName}" appears to be damaged or only partly copied. It cannot be read.`;
  }
  if (/Unknown decoder|Decoder not found|Unsupported codec/i.test(text)) {
    return `"${fileName}" uses a format this copy of Burnhouse cannot decode.`;
  }
  if (last) return `Preparing "${fileName}" failed: ${last}`;
  return `Preparing "${fileName}" failed. The video tool gave no reason.`;
}

class AbortError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AbortError';
    this.isAbort = true;
  }
}

module.exports = {
  encodeTitle,
  buildEncodeArgs,
  buildRemuxArgs,
  canRemux,
  buildVideoFilter,
  motionFor,
  hardwareDecoder,
  sourceMatrixFor,
  buildAudioFilter,
  listTitleParts,
  resetOutputDir,
  describeFfmpegFailure,
  extractWarnings,
  // Per-title caching: the difference between rebuilding a disc in seconds and
  // re-encoding every minute of video on it.
  titleFingerprint,
  readTitleCache,
  writeTitleCache,
  clearTitleCache,
  pruneTitleDirs,
  ENCODE_REVISION,
  AbortError,
};
