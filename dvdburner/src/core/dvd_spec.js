'use strict';

/**
 * DVD-Video format rules.
 *
 * Everything the rest of the app needs to know about what a legal DVD is lives
 * here, so there is exactly one place to be wrong. The numbers below are from
 * the DVD-Video specification, not from trial and error.
 */

const ASPECTS = {
  widescreen: { ratio: '16:9', mpeg2Aspect: 3, label: 'Widescreen (16:9)' },
  standard: { ratio: '4:3', mpeg2Aspect: 2, label: 'Standard (4:3)' },
};

const FORMATS = {
  ntsc: {
    id: 'ntsc',
    label: 'NTSC',
    blurb: 'North America, Japan. 29.97 fps.',
    width: 720,
    height: 480,
    fps: 30000 / 1001, // 29.97 exactly, never the rounded 29.97
    gop: 18, // ~0.6s. Must be 12, 15 or 18 for NTSC to stay spec legal.
    fieldMode: 'Bottom Field First',
  },
  pal: {
    id: 'pal',
    label: 'PAL',
    blurb: 'UK, Europe, Australia. 25 fps.',
    width: 720,
    height: 576,
    fps: 25,
    gop: 15, // ~0.6s, one of the legal PAL GOP sizes.
    fieldMode: 'Top Field First',
  },
};

/**
 * A DVD player must never be starved. The spec caps the combined program
 * stream at 10.08 Mbit/s and video tops out at 9.8 Mbit/s. Short discs get the
 * ceiling minus a small safety margin; long ones get whatever fits, and the
 * caller is told honestly when that means visible compression.
 *
 * The margin is not paranoia: cheap players and old drives stutter when a disc
 * rides the legal edge for minutes at a time, and a disc that stutters is worse
 * than a disc that is marginally softer.
 */
const DVD_MAX_PROGRAM_BITRATE = 10080000;
const DVD_MAX_VIDEO_BITRATE = 9800000;
const SAFE_TOTAL_BITRATE = 9200000;
/** For discs under this many seconds, spend bits freely up to the ceiling. */
const SHORT_DISC_SECONDS = 1800;

const AUDIO_MODES = {
  stereo: { channels: 2, minimum: 96000, preferred: 224000, label: 'Stereo' },
  surround: { channels: 6, minimum: 224000, preferred: 448000, label: 'Surround (5.1)' },
};

/**
 * How much a blank disc actually holds, worked out from its sector count rather
 * than from the figure on the packaging.
 *
 * A DVD-5 is 2,295,104 sectors of 2048 bytes, which is 4,700,372,992 bytes —
 * the "4.7 GB" printed on the box. That figure is decimal, which is why the same
 * disc is 4.38 GiB; both numbers are true of the same object, and using the GiB
 * one as a byte count silently threw away about 320 MB of usable disc.
 */
const DISC_BYTES = {
  dvd5: 2295104 * 2048, // 4,700,372,992 DVD-R / DVD+R, single layer
  dvd9: 4173824 * 2048, // 8,547,991,552 DVD+R double layer
};

/**
 * Container overhead, as a multiplier on the payload.
 *
 * A finished VOB is bigger than the audio and video in it: every pack carries a
 * header, every video object unit carries a navigation pack, and packs are
 * padded out to whole 2048-byte sectors. Measured on a real build that comes to
 * about four per cent.
 *
 * It has to be counted in both places or the numbers disagree — once when
 * working out which bitrate fits, and once when saying how big the disc will be.
 * It was missing from the size, which made the estimate about 4% optimistic: on
 * a nearly full disc that is nearly 200 MB, enough to turn "it fits" into a
 * failed burn at the very end.
 */
const MUX_OVERHEAD = 1.04;

// Room for the parts of a disc that are not video: the IFO and BUP files, the
// menu stills, and the UDF filesystem. Deliberately generous — a typical disc
// uses a couple of megabytes of this — because over-reserving costs a fraction
// of a per cent of bitrate, while under-reserving costs a failed burn.
const AUTHORING_OVERHEAD_BYTES = 40 * 1024 * 1024;

function resolveFormat(id) {
  const format = FORMATS[String(id || '').toLowerCase()];
  if (!format) {
    throw new Error(
      `Unknown DVD format "${id}". Expected one of: ${Object.keys(FORMATS).join(', ')}.`
    );
  }
  return format;
}

function resolveAspect(id) {
  const aspect = ASPECTS[String(id || '').toLowerCase()];
  if (!aspect) {
    throw new Error(
      `Unknown aspect "${id}". Expected one of: ${Object.keys(ASPECTS).join(', ')}.`
    );
  }
  return aspect;
}

/**
 * Work out what video bitrate we can afford for a given amount of material.
 * Clamped to a floor where the picture is still acceptable and a ceiling where
 * the disc stays legal, so neither a 3 minute clip nor a 3 hour film produces a
 * broken disc.
 */
function planBitrate({ totalSeconds, formatId, audioMode = 'stereo', discType = 'dvd5' }) {
  const format = resolveFormat(formatId);
  const audio = AUDIO_MODES[audioMode] || AUDIO_MODES.stereo;
  const capacity = DISC_BYTES[discType] || DISC_BYTES.dvd5;

  const usableBits = (capacity - AUTHORING_OVERHEAD_BYTES) * 8;
  const seconds = Math.max(1, Number(totalSeconds) || 0);

  /*
    What is affordable is the payload, so the container has to be divided out.

    Everything written to the disc is multiplied by MUX_OVERHEAD, so the video
    rate has to be divided by it to find what fits: whatever is chosen, the
    finished VOB is that much bigger again.
  */
  const affordable = usableBits / (seconds * MUX_OVERHEAD) - audio.preferred;

  // 9.8 Mbit/s is the absolute video ceiling. Short discs get it minus a small
  // safety margin; long ones share the safe budget by duration. We never go
  // under 2.5 Mbit/s: below that DVD looks bad enough that the user should be
  // told to use fewer videos instead.
  const ceiling = seconds <= SHORT_DISC_SECONDS
    ? DVD_MAX_VIDEO_BITRATE - 300000
    : SAFE_TOTAL_BITRATE - audio.preferred;
  let videoBitrate = Math.min(affordable, ceiling, DVD_MAX_VIDEO_BITRATE);
  let fits = true;
  let warning = null;

  if (videoBitrate < 2500000) {
    videoBitrate = 2500000;
    fits = false;
    warning =
      `This is more material than a single DVD holds at good quality ` +
      `(${formatForDuration(seconds)} of ${format.label}). The disc will still ` +
      `burn, but expect visible compression. Split it across two discs, or drop ` +
      `a video or two, for a clean result.`;
  } else if (videoBitrate < 4000000) {
    warning =
      `That is a lot of material for one disc (${formatForDuration(seconds)}). ` +
      `Quality will be acceptable but not sharp.`;
  }

  // Round down to the nearest 100 kbit/s so the numbers in the UI look
  // deliberate rather than computed.
  videoBitrate = Math.max(0, Math.floor(videoBitrate / 100000) * 100000);

  const totalBitrate = videoBitrate + audio.preferred;

  return {
    format,
    audio,
    videoBitrate,
    audioBitrate: audio.preferred,
    muxrate: Math.min(DVD_MAX_PROGRAM_BITRATE, Math.round(totalBitrate * MUX_OVERHEAD)),
    totalBitrate,
    fits,
    warning,
    gop: format.gop,
    // The finished size, container and all, so the figure shown matches what
    // actually lands on the disc rather than the payload inside it.
    estimatedBytes: Math.round(((videoBitrate + audio.preferred) / 8) * seconds * MUX_OVERHEAD),
    // What the structure will take: IFOs, menus and the filesystem.
    structureBytes: AUTHORING_OVERHEAD_BYTES,
    discType,
    discCapacityBytes: capacity,
  };
}

/**
 * Decide the percentage of the disc this project will use, for the UI's
 * capacity meter.
 */
function usagePercent(estimatedBytes, discType = 'dvd5') {
  const capacity = DISC_BYTES[discType] || DISC_BYTES.dvd5;
  return Math.min(999, Math.round((estimatedBytes / capacity) * 100));
}

function formatForDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

/**
 * Which broadcast standard a source video most likely belongs to. This is only
 * ever used to pre-select a radio button, never to make a silent decision:
 * DVD Styler's "would you like to convert this?" prompt is what drove the user
 * here, and the answer is to choose the target format once, up front.
 */
function guessFormatFromProbe(info) {
  const fps = Number(info && info.fps) || 0;
  if (fps > 0) {
    // PAL territories use 25 and its double, 50. Everything else that a
    // camcorder or a download realistically produces (23.976, 24, 29.97, 30,
    // 59.94, 60) belongs on an NTSC disc, with 24p carried at 29.97.
    if (Math.abs(fps - 25) < 0.6) return 'pal';
    if (Math.abs(fps - 50) < 1.2) return 'pal';
    return 'ntsc';
  }
  const height = Number(info && info.height) || 0;
  if (height === 576 || height === 288) return 'pal';
  if (height === 480 || height === 240) return 'ntsc';
  return 'ntsc';
}

module.exports = {
  ASPECTS,
  FORMATS,
  AUDIO_MODES,
  DISC_BYTES,
  DVD_MAX_PROGRAM_BITRATE,
  DVD_MAX_VIDEO_BITRATE,
  SAFE_TOTAL_BITRATE,
  SHORT_DISC_SECONDS,
  MUX_OVERHEAD,
  AUTHORING_OVERHEAD_BYTES,
  resolveFormat,
  resolveAspect,
  planBitrate,
  usagePercent,
  formatForDuration,
  guessFormatFromProbe,
};
