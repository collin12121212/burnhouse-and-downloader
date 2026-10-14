'use strict';

/**
 * Reading the facts out of a video file.
 *
 * The whole point of this module is that we ask ffprobe once, up front, and
 * then write down the answers. Everything downstream reads the recorded
 * numbers, so nothing ever re-guesses a duration or a frame rate mid-job.
 */

const { execFile } = require('child_process');

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.mpg',
  '.mpeg', '.m2v', '.vob', '.ts', '.mts', '.m2ts', '.3gp', '.ogv', '.dv',
  '.divx', '.rm', '.rmvb', '.asf', '.f4v',
]);

// Files that already are DVD-Video assets and must not be treated as sources.
const DVD_ARTIFACT_EXTENSIONS = new Set(['.ifo', '.bup']);

function looksLikeVideo(filePath) {
  const lower = String(filePath).toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return false;
  const ext = lower.slice(dot);
  if (DVD_ARTIFACT_EXTENSIONS.has(ext)) return false;
  return VIDEO_EXTENSIONS.has(ext);
}

function run(file, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = String(stderr || '');
          return reject(err);
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

/**
 * Run ffprobe and return a normalised description.
 *
 * `fps` prefers the average frame rate, because a container's nominal `r_frame_rate`
 * is often the timebase rather than the real cadence, and a wrong frame rate is
 * what produces the classic out-of-sync burn.
 */
async function probeVideo(ffprobePath, filePath) {
  if (!ffprobePath) throw new Error('ffprobe is not available.');

  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-i', filePath,
  ];

  let raw;
  try {
    raw = await run(ffprobePath, args);
  } catch (err) {
    throw new Error(`Could not read "${filePath}": ${summariseProbeError(err)}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Could not read "${filePath}": ffprobe returned unreadable output.`);
  }

  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const audio = audioStreams[0] || null;

  const format = data.format || {};
  const duration =
    numberOrNull(format.duration) ??
    numberOrNull(video && video.duration) ??
    numberOrNull(audio && audio.duration);

  if (!video) {
    throw new Error(`"${basename(filePath)}" has no video track.`);
  }

  const fps = pickFrameRate(video);
  const width = numberOrNull(video.width);
  const height = numberOrNull(video.height);

  return {
    path: filePath,
    name: basename(filePath),
    duration: duration || 0,
    durationKnown: Boolean(duration && duration > 0),
    width: width || 0,
    height: height || 0,
    fps,
    interlaced: isInterlaced(video),
    // "tt"/"bb" for interlaced material, "progressive" otherwise. Recorded
    // because a source that is already a DVD title is copied rather than
    // encoded, and then this is the only record of what its fields do.
    fieldOrder: video.field_order || null,
    videoCodec: video.codec_name || 'unknown',
    pixelFormat: video.pix_fmt || null,
    // The shape the picture is meant to be seen in, which for DVD is carried in
    // the anamorphic sample aspect ratio rather than in the pixel count: a
    // 720x480 frame is 16:9 or 4:3 depending only on that flag.
    displayAspect: displayAspectOf(video),
    // Colour metadata, so the encoder can convert HD's BT.709 matrix to the
    // BT.601 matrix a DVD expects. Without this, HD sources come out with a
    // visible colour shift — reds go orange. Nulls mean "unknown", in which
    // case the encoder guesses from the resolution, the way players do.
    colorSpace: video.color_space || null,
    colorTransfer: video.color_transfer || null,
    colorPrimaries: video.color_primaries || null,
    hasAudio: Boolean(audio),
    audioCodec: audio ? audio.codec_name || 'unknown' : null,
    audioChannels: audio ? numberOrNull(audio.channels) || 2 : 0,
    audioChannelLayout: audio ? audio.channel_layout || null : null,
    audioSampleRate: audio ? numberOrNull(audio.sample_rate) : null,
    audioStreamCount: audioStreams.length,
    subtitleStreamCount: streams.filter((s) => s.codec_type === 'subtitle').length,
    sizeBytes: numberOrNull(format.size) || 0,
    bitrate: numberOrNull(format.bit_rate),
    formatName: format.format_name || null,
    warnings: buildWarnings({ video, audio, fps, width, height, duration, audioStreams }),
  };
}

/**
 * Read the facts out of a sound file.
 *
 * Kept apart from probeVideo because a sound file has no video stream and
 * probeVideo refuses anything without one — asking it about an MP3 fails with
 * "has no video track", which says nothing useful about the file.
 */
async function probeAudio(ffprobePath, filePath) {
  if (!ffprobePath) throw new Error('ffprobe is not available.');

  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-select_streams', 'a:0',
    '-i', filePath,
  ];

  let raw;
  try {
    raw = await run(ffprobePath, args);
  } catch (err) {
    throw new Error(`Could not read "${basename(filePath)}": ${summariseProbeError(err)}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Could not read "${basename(filePath)}": ffprobe returned unreadable output.`);
  }

  const stream = (Array.isArray(data.streams) ? data.streams : [])
    .find((s) => s.codec_type === 'audio');
  if (!stream) {
    throw new Error(`"${basename(filePath)}" has no sound in it.`);
  }

  const format = data.format || {};
  const duration =
    numberOrNull(format.duration) ?? numberOrNull(stream.duration) ?? 0;

  return {
    path: filePath,
    name: basename(filePath),
    duration: duration || 0,
    codec: stream.codec_name || 'unknown',
    channels: numberOrNull(stream.channels) || 0,
    sampleRate: numberOrNull(stream.sample_rate) || 0,
    sizeBytes: numberOrNull(format.size) || 0,
  };
}

function pickFrameRate(video) {
  const avg = parseRational(video.avg_frame_rate);
  const real = parseRational(video.r_frame_rate);
  // A very small or absurd average usually means ffprobe could not measure it.
  if (avg && avg > 1 && avg < 121) return round(avg, 3);
  if (real && real > 1 && real < 121) return round(real, 3);
  return 0;
}

function parseRational(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (!text.includes('/')) {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  const [a, b] = text.split('/').map(Number);
  if (!b) return null;
  return a / b;
}

function isInterlaced(video) {
  const order = String(video.field_order || '').toLowerCase();
  return order === 'tt' || order === 'bb' || order === 'tb' || order === 'bt';
}

/**
 * The shape a video is meant to be displayed in, as "16:9", "4:3" or null.
 *
 * Two sources, in order of reliability. ffprobe usually works it out and calls
 * it `display_aspect_ratio`, but it is absent often enough — an MPEG-2 stream
 * with no sequence display extension, a container that never recorded one — that
 * the sample aspect ratio has to be the fallback.
 *
 * For a DVD that flag is the whole answer: 720x480 pixels with a 32:27 sample
 * aspect ratio is widescreen, and the same pixels at 8:9 are not. Multiplying it
 * out and comparing against the two shapes a DVD can carry is what distinguishes
 * them; anything that is neither — 2.39:1 scope, an odd square-pixel capture —
 * reports null rather than being forced into a shape it does not have.
 */
function displayAspectOf(video) {
  const stated = String(video.display_aspect_ratio || '').trim();
  if (stated === '16:9' || stated === '4:3') return stated;

  const sar = parseRational(video.sample_aspect_ratio);
  const width = numberOrNull(video.width);
  const height = numberOrNull(video.height);
  if (!sar || !width || !height) return stated || null;

  const value = (sar * width) / height;
  if (Math.abs(value - 16 / 9) < 0.06) return '16:9';
  if (Math.abs(value - 4 / 3) < 0.06) return '4:3';
  return stated || null;
}

function buildWarnings({ video, audio, fps, width, height, duration, audioStreams }) {
  const out = [];

  if (!duration || duration <= 0) {
    out.push('Length could not be read. It will be measured during encoding.');
  }
  if (!fps) {
    out.push('Frame rate could not be read. 29.97 will be assumed.');
  }
  if (!width || !height) {
    out.push('Dimensions could not be read.');
  }
  if (!audio) {
    out.push('No sound track. A silent one will be added so the menu still works.');
  }
  if (audioStreams.length > 1) {
    out.push(
      `${audioStreams.length} sound tracks found. The first one will be used.`
    );
  }
  if (audio && String(audio.codec_name) === 'pcm_s16le' && audio.channel_layout === 'stereo') {
    // Fine, just noting CD-style audio is common in old captures.
  }
  if (/mpeg2video/.test(String(video.codec_name)) && width === 720 && (height === 480 || height === 576)) {
    // Kept vague on purpose: whether it really is copied depends on the rest of
    // the checks in encode.canRemux, and the build log says which happened.
    out.push('Already DVD resolution. It can be copied rather than converted.');
  }
  return out;
}

function summariseProbeError(err) {
  const stderr = String(err.stderr || err.message || '').trim();
  const lastMeaningful = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^ffprobe version|^configuration:|^lib(postproc|avutil|avcodec|avformat|avfilter|swscale|swresample)/.test(l))
    .pop();
  return lastMeaningful || 'the file could not be opened.';
}

function basename(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i === -1 ? s : s.slice(i + 1);
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(n, places) {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

module.exports = {
  probeVideo,
  probeAudio,
  looksLikeVideo,
  displayAspectOf,
  VIDEO_EXTENSIONS,
};
