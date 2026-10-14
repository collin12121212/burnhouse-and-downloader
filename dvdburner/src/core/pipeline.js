'use strict';

/**
 * The pipeline: inspect, prepare, build, burn.
 *
 * This is the only module that knows the order of operations, and it is
 * deliberately written as a sequence of small, resumable stages rather than one
 * long function. When something fails, the caller knows exactly which stage
 * failed and the work already done — expensive encoding especially — is not
 * thrown away.
 *
 * The stage order exists because each one needs the previous one's output:
 *
 *   inspect  ffprobe every source, decide the disc format and bitrate budget
 *   encode   ffmpeg -> spec-legal MPEG-2 program streams
 *   menu     render the designed menu to a still, multiplex the buttons in
 *   author   dvdauthor -> a real VIDEO_TS tree
 *   image    a UDF disc image ready to burn or hand to another machine
 *   burn     hdiutil -> an actual disc in an actual drive
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const spec = require('./dvd_spec');
const probeMod = require('./probe');
const encode = require('./encode');
const author = require('./author');
const deckModel = require('./deck');
const slideLayout = require('./slide_layout');
const deckRender = require('./deck_render');
const dvdModel = require('./dvd_model');
const disc = require('./disc');

/**
 * Everything a job needs, resolved once. `project` is the shape the UI edits;
 * `plan` is the shape the pipeline executes.
 */
function normaliseProject(input = {}) {
  const videos = (Array.isArray(input.videos) ? input.videos : []).map((v, i) => ({
    id: v.id || `video-${i + 1}`,
    path: v.path,
    name: v.name || path.basename(String(v.path || `video-${i + 1}`)),
    menuLabel: v.menuLabel || '',
    duration: Number(v.duration) || 0,
    probe: v.probe || null,
    // Populated by the encode stage.
    parts: v.parts || null,
    chapters: v.chapters || null,
    encodeError: null,
    bytes: v.bytes || 0,
  }));

  const discTitle = String(input.discTitle || 'My DVD').slice(0, 60);
  const deck = deckModel.normaliseDeck(
    input.deck && Array.isArray(input.deck.slides) && input.deck.slides.length
      ? { ...input.deck, discTitle: input.deck.discTitle || discTitle }
      : defaultDeck(discTitle, videos, input)
  );

  return {
    /*
      Carried through so every stage agrees which project it is working on.

      The id decides which folder the prepared disc lives in, so a stage that
      lost it would look somewhere else and report a disc that is sitting right
      there as missing. It is deliberately NOT part of the fingerprint: the same
      project saved under a new id is the same disc, and hashing this would
      re-encode an hour of video because a file was copied.
    */
    id: input.id ? String(input.id) : null,
    discTitle,
    // The video system is never chosen by the person using the app: she is in
    // North America, so it is NTSC, and the wrong answer here is the single
    // most common reason a burned DVD will not play.
    videoFormat: 'ntsc',
    titleAspect: String(input.titleAspect || '').toLowerCase() === '4:3' ? '4:3' : '16:9',
    audioMode: input.audioMode === 'surround' ? 'surround' : 'stereo',
    discType: input.discType === 'dvd9' ? 'dvd9' : 'dvd5',
    chaptersEnabled: input.chaptersEnabled !== false,
    chapterMinutes: clamp(Number(input.chapterMinutes) || 5, 1, 30),
    deck,
    videos,
    output: {
      workDir: input.output && input.output.workDir ? input.output.workDir : null,
      buildIso: !input.output || input.output.buildIso !== false,
      keepFolder: Boolean(input.output && input.output.keepFolder),
    },
  };
}

/**
 * The deck to use when nothing has been designed yet.
 *
 * A project always begins with a menu slide. A menu is where a player's menu
 * button goes, where playback returns to when a video ends, and the only way to
 * choose between episodes — a disc that skips straight into a video is a disc
 * someone has to sit through.
 *
 * The videos are listed on it here, which is the opposite of what the editor
 * does. In the editor a menu slide starts empty and its buttons are hers to add,
 * because a button appearing because a file was dropped in is not what dropping
 * a file in means. This deck is the one used when there is no editor session at
 * all, and there a menu with nothing on it is not a menu: it would not be a page,
 * there would be nothing to choose, and the menu key would have nowhere to go.
 */
function defaultDeck(discTitle, videos, input) {
  const themeId = (input && input.themeId) || 'charcoal';
  const slides = [
    deckModel.episodeListSlide(
      (videos || []).map((v) => ({ id: v.id, name: v.name, menuLabel: v.menuLabel })),
      { title: discTitle, themeId }
    ),
  ];
  return { discTitle, themeId, buttonStyle: 'bar', slides };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Stage one: read every source file and work out whether this disc is possible.
 *
 * No encoding happens here, so the user gets an answer in seconds and can fix
 * an oversized disc before waiting an hour.
 */
async function inspect(project, { tools, onProgress } = {}) {
  if (!tools || !tools.ffprobe) {
    throw new Error('The video inspection tool is missing, so files cannot be read.');
  }
  if (!project.videos.length) {
    throw new Error('Add at least one video first.');
  }

  const videos = [];
  const errors = [];

  for (let i = 0; i < project.videos.length; i += 1) {
    const video = project.videos[i];
    if (onProgress) {
      onProgress({
        stage: 'inspect',
        index: i,
        total: project.videos.length,
        message: `Reading ${video.name}\u2026`,
      });
    }
    try {
      const info = await probeMod.probeVideo(tools.ffprobe, video.path);
      videos.push({ ...video, probe: info, duration: info.duration, bytes: info.sizeBytes });
    } catch (err) {
      errors.push({ video, error: String(err.message || err) });
    }
  }

  const totalSeconds = videos.reduce((sum, v) => sum + (v.duration || 0), 0);
  const plan = spec.planBitrate({
    totalSeconds,
    formatId: project.videoFormat,
    audioMode: project.audioMode,
    discType: project.discType,
  });

  return {
    videos,
    errors,
    totalSeconds,
    plan,
    usable: videos.length > 0,
  };
}

/**
 * Stage two: encode, design, author.
 *
 * Returns a `prepared` object that later stages consume.
 *
 * Encoding is the expensive part — minutes per hour of video on the sort of
 * laptop this is built for — and it is also the part that most often does not
 * need doing again. Changing one slide, renaming the disc, or pressing Build a
 * second time after a failed burn changes nothing about the video streams, so
 * each title is cached against its own fingerprint and reused when it still
 * matches. `force` skips the cache and prepares everything from scratch.
 */
async function prepare(project, { tools, workDir, onProgress, onLog, signal, BrowserWindow, force = false }) {
  requireTools(tools, ['ffmpeg', 'ffprobe']);
  if (!tools.dvdauthor) {
    throw new Error(
      'The disc-building tool (dvdauthor) is not installed, so a playable DVD ' +
        'cannot be built. Open Setup for install instructions.'
    );
  }

  const root = workDir || project.output.workDir;
  if (!root) throw new Error('No working folder has been set.');
  fs.mkdirSync(root, { recursive: true });

  // Work out the plan fresh, so a changed file list is reflected immediately.
  const inspection = await inspect(project, { tools, onProgress });
  if (!inspection.usable) {
    const first = inspection.errors[0];
    throw new Error(
      first
        ? `None of the videos could be read. ${first.error}`
        : 'None of the videos could be read.'
    );
  }

  const plan = inspection.plan;
  const videos = inspection.videos;
  const totalSeconds = inspection.totalSeconds;

  // Weights let one long film account for more of the progress bar than a short
  // clip, so the bar moves at a believable pace.
  const weights = videos.map((v) => Math.max(1, v.duration || 1));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let doneWeight = 0;

  // ---- encode each title -------------------------------------------------
  //
  // What was reused and what was prepared from scratch are counted rather than
  // assumed: the numbers are reported back so the page can say that a rebuild
  // took seconds because there was nothing to do, instead of leaving it to be
  // noticed. Between them they account for every title on the disc.
  let reused = 0;
  let copied = 0;
  let encodedCount = 0;
  const encoded = [];
  // Asked once, and only used for titles that actually need decoding.
  const hwaccel = await encode.hardwareDecoder(tools.ffmpeg);

  for (let i = 0; i < videos.length; i += 1) {
    if (signal && signal.aborted) throw new encode.AbortError('Stopped.');

    const video = videos[i];
    const titleDir = path.join(root, 'titles', `title_${i + 1}`);
    const outputVob = path.join(titleDir, 'VTS_01_1.VOB');
    const weight = weights[i];
    const baseWeight = doneWeight;

    // A source with no audio still needs a silent track, or some players will
    // refuse to navigate past the title. The encoder mixes it in as it goes.
    const needsSilence = !video.probe || !video.probe.hasAudio;

    const displayName = video.menuLabel || video.name;
    const titleAspect = project.titleAspect === '4:3' ? '4:3' : '16:9';

    /*
      Every number the encoder will read, written down as the cache key.

      The bitrates come from the disc-wide plan, so adding a video or changing
      the disc type invalidates all of them at once — which is correct: the plan
      exists precisely because the budget is shared out by total duration, and a
      title encoded at the old rate would either waste the disc or overflow it.
      What does not move the plan — the slides, the disc's name, which menu page
      a title sits on — leaves every title reusable.
    */
    const fingerprint = encode.titleFingerprint({
      input: video.path,
      probe: video.probe,
      durationSeconds: video.duration,
      options: {
        format: plan.format.id,
        width: plan.format.width,
        height: plan.format.height,
        fps: plan.format.fps,
        gop: plan.gop,
        videoBitrate: plan.videoBitrate,
        audioBitrate: plan.audioBitrate,
        muxrate: plan.muxrate,
        audioChannels: plan.audio.channels,
        aspect: titleAspect,
        hasAudio: !needsSilence,
      },
    });

    const cached = force ? null : encode.readTitleCache(titleDir, fingerprint);

    if (cached) {
      reused += 1;
      if (onLog) {
        onLog(
          `${displayName}: already prepared, keeping what is there ` +
            `(${cached.parts.length} ${cached.parts.length === 1 ? 'file' : 'files'}).`
        );
      }
      if (onProgress) {
        const overall = totalWeight > 0 ? (baseWeight + weight) / totalWeight : 0;
        onProgress({
          stage: 'encode',
          fraction: Math.min(1, overall),
          message: `Already prepared: ${displayName}`,
        });
      }
      const parts = cached.parts;
      encoded.push({ ...video, parts, chapters: chaptersFor(project, parts, video) });
      doneWeight += weight;
      continue;
    }

    // Nothing reusable, so this folder is about to be rewritten. Clearing only
    // the video files means an interrupted run can never leave a stale part for
    // the disc to pick up, while leaving the cache record to be replaced at the
    // end of a run that actually finishes.
    encode.resetOutputDir(titleDir);

    try {
      const result = await encode.encodeTitle({
        ffmpegPath: tools.ffmpeg,
        input: video.path,
        outputVob,
        plan: {
          ...plan,
          hasAudio: !needsSilence,
          // The encoder needs the probe for per-source decisions: the colour
          // matrix (BT.709 HD vs BT.601 SD), and whether the source is already
          // a DVD title and can be copied rather than encoded.
          probe: video.probe || null,
        },
        durationSeconds: video.duration,
        aspect: { ratio: titleAspect },
        hwaccel,
        onProgress: (fraction) => {
          if (!onProgress) return;
          const overall = totalWeight > 0 ? (baseWeight + fraction * weight) / totalWeight : 0;
          onProgress({
            stage: 'encode',
            fraction: Math.min(1, overall),
            message: `Preparing ${i + 1} of ${videos.length}: ${displayName}`,
          });
        },
        signal,
      });

      if (result.mode === 'copy') copied += 1;
      else encodedCount += 1;

      if (onLog) {
        onLog(
          result.mode === 'copy'
            ? `${displayName}: already a DVD-quality file, copied as it is.`
            : `${displayName}: converting to DVD video.`
        );
      }
      if (onLog && result.mode !== 'copy' && result.copyReason) {
        onLog(`  (converting rather than copying: ${result.copyReason})`);
      }
      for (const warning of result.warnings || []) {
        if (onLog) onLog(`  ${warning}`);
      }

      const partsAfter = result.parts.map((file) => ({ file, bytes: safeSize(file) }));

      // Written only now, with the final files and their final lengths.
      encode.writeTitleCache(titleDir, {
        fingerprint,
        parts: partsAfter,
        mode: result.mode,
      });

      encoded.push({ ...video, parts: partsAfter, chapters: chaptersFor(project, partsAfter, video) });
    } catch (err) {
      if (err && err.isAbort) throw err;
      // One bad file should not destroy the whole disc: the others are still
      // worth burning, and the error is reported per video.
      encoded.push({ ...video, parts: null, chapters: null, encodeError: String(err.message || err) });
    }

    doneWeight += weight;
  }

  // A video removed from the project leaves its folder behind with nothing
  // pointing at it. Nothing else will ever look at it again, so it goes.
  const pruned = encode.pruneTitleDirs(root, videos.length);
  if (pruned && onLog) {
    onLog(`Removed ${pruned} title folder${pruned === 1 ? '' : 's'} left over from an earlier version of this project.`);
  }

  const good = encoded.filter((v) => v.parts && v.parts.length);
  if (!good.length) {
    const reason = encoded.find((v) => v.encodeError);
    throw new Error(
      `Nothing could be prepared. ${reason ? reason.encodeError : 'All videos failed.'}`
    );
  }

  // ---- menu pages from the slide deck ------------------------------------
  if (onProgress) {
    onProgress({ stage: 'menu', fraction: 0, message: 'Drawing your slides\u2026' });
  }
  const built = await buildMenus({
    project,
    videos: good,
    tools,
    root,
    BrowserWindow,
    signal,
    onLog,
  });

  // ---- author ------------------------------------------------------------
  if (onProgress) {
    onProgress({ stage: 'author', fraction: 0, message: 'Building the disc structure\u2026' });
  }

  const xml = author.buildDvdauthorXml({
    videoFormat: project.videoFormat,
    titleAspect: project.titleAspect,
    menus: built.menus,
    /*
      Where the disc starts, and where the remote's Menu key goes back to.

      It is the first page with a button on it, not the first page written out: a
      page of words can be a page, but opening the disc on one would leave the
      viewer with nothing to press and no way out, since Menu returns here too.
      Taken from the same model the simulator reads, so the preview and the disc
      cannot disagree about it.
    */
    rootPage:
      built.model && built.model.firstPlay.type === 'menu' ? built.model.firstPlay.number : 1,
    // Each title carries where it goes when it finishes, taken from the same
    // model the simulator reads, so the preview and the disc agree about what
    // plays next. Titles are numbered from one, in the order they were prepared.
    titles: good.map((video, index) => ({
      parts: video.parts,
      chapters: video.chapters,
      nextTitle: built.model ? built.model.nextTitleByNumber[index + 1] : null,
    })),
  });

  const authorDir = path.join(root, 'author');
  fs.mkdirSync(authorDir, { recursive: true });
  // dvdauthor refuses to write into a folder holding another VIDEO_TS, so clear
  // the destination's disc structure (and only that) before each run.
  removeDiscStructure(authorDir);

  const authored = await author.runDvdauthor({
    dvdauthorPath: tools.dvdauthor,
    xml,
    workDir: authorDir,
    videoFormat: project.videoFormat,
    onOutput: onLog,
    signal,
  });

  const prepared = {
    plan,
    videos: good,
    failed: encoded.filter((v) => v.encodeError),
    menus: built.menus,
    slideProblems: built.layout.problems,
    videoTsDir: authored.videoTsDir,
    volumeLabel: author.discLabel(project.discTitle),
    totalSeconds: good.reduce((sum, v) => sum + (v.duration || 0), 0),
    builtAt: new Date().toISOString(),
    // Reported so a rebuild that had nothing to do can say so, rather than
    // looking identical to one that re-encoded everything. Between them these
    // three account for every title that made it onto the disc.
    reusedTitles: reused,
    copiedTitles: copied,
    encodedTitles: encodedCount,
  };

  /*
    Record what was built, so the next run can tell whether it is still current.

    This is what makes the prepared disc reusable across an app upgrade. The
    folder it sits in belongs to the user, not the app, and the fingerprint
    describes the project exactly — so opening the app, changing nothing and
    pressing Burn should not re-encode anything, while changing anything at all
    should be noticed rather than silently burning the old disc.
  */
  prepared.fingerprint = projectFingerprint(project);
  try {
    fs.writeFileSync(
      path.join(root, 'build.json'),
      JSON.stringify(
        {
          fingerprint: prepared.fingerprint,
          builtAt: prepared.builtAt,
          volumeLabel: prepared.volumeLabel,
          videoCount: good.length,
          slideCount: built.layout.slides.length,
          totalSeconds: prepared.totalSeconds,
          app: appVersion(),
        },
        null,
        2
      )
    );
  } catch {
    // A build that cannot be recorded is still a build. It just cannot be reused.
  }

  if (onProgress) {
    onProgress({ stage: 'author', fraction: 1, message: 'Disc structure ready.' });
  }

  return prepared;
}

/**
 * Where the chapter stops go for one title.
 *
 * Pulled out because it is worked out the same way whether the title was just
 * encoded or reused from the last build, and a reused title still has to come
 * out with chapters in the same places.
 */
function chaptersFor(project, parts, video) {
  if (!project.chaptersEnabled) return parts.map(() => []);
  return author.distributeChapters(parts, video.duration, {
    intervalSeconds: project.chapterMinutes * 60,
  });
}

/** This app's version, for the build record. */
function appVersion() {
  try {
    return require('../../package.json').version;
  } catch {
    return 'unknown';
  }
}

/**
 * A fingerprint of everything that decides what ends up on the disc.
 *
 * The slides, the films on them, the order, the disc settings — and for each
 * video its size and modification time, so replacing a file in place with a
 * different one is noticed even if the path is the same.
 *
 * Deliberately NOT included: app version, tool paths, the work folder. None of
 * those change the disc, and including them would force a rebuild after every
 * bug fix — which is the thing this exists to avoid.
 *
 * The exception is the encoder recipe revision, which is included, and the
 * distinction is the whole point:
 *
 *   a new app version  changes nothing about the bytes, so a prepared disc
 *                      stays valid and should not be rebuilt
 *   a new recipe       changes the bytes while leaving every input identical,
 *                      so the prepared disc is stale even though the project
 *                      has not moved at all
 *
 * That second case is not hypothetical. The fingerprint used to be the project
 * alone, and the ghosting fix — a change that produces different, correct
 * output from the same source and the same settings — could not invalidate
 * anything. A disc prepared before it stayed "up to date" afterwards and would
 * have been burned as it was, carrying the very bug the release was about.
 * Excluding the app version is right; excluding the recipe with it was not.
 *
 * This is the same guard the per-title cache carries in encode.js, for the same
 * reason, one level up: skip work when nothing that decides the output has
 * changed, and never otherwise.
 */
function projectFingerprint(project) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(fingerprintPayload(project)))
    .digest('hex');
}

/**
 * What the fingerprint is taken of, before it is hashed.
 *
 * Separate from the hash so it can be read and tested directly: the revision is
 * a parameter, which is how a test can prove that bumping the recipe really
 * does invalidate a prepared disc rather than having to take the mechanism on
 * trust.
 */
function fingerprintPayload(project, encoderRevision = encode.ENCODE_REVISION) {
  const videos = (project.videos || []).map((video) => {
    let size = 0;
    let mtime = 0;
    try {
      const stat = fs.statSync(video.path);
      size = stat.size;
      mtime = Math.round(stat.mtimeMs);
    } catch {
      // A missing file still has to fingerprint, or removing one would look
      // like no change at all.
    }
    return {
      path: video.path,
      size,
      mtime,
      duration: video.duration || null,
      name: video.name || null,
      menuLabel: video.menuLabel || null,
    };
  });

  return {
    // The disc title is the volume label on the finished disc, so changing it
    // changes the disc.
    discTitle: project.discTitle || null,
    deck: project.deck,
    videos,
    videoFormat: project.videoFormat,
    /*
      `titleAspect`, not `aspect`.

      This read `project.aspect`, which normaliseProject never sets — it was
      always undefined, so switching the whole disc between 4:3 and 16:9 left
      the fingerprint untouched and a finished build was reported as still
      matching the project. It would then have been burned as it was, at the old
      shape, with the page saying nothing had changed.
    */
    titleAspect: project.titleAspect,
    audioMode: project.audioMode,
    /*
      And the disc type, which decides how much room there is and therefore the
      bitrate every title is encoded at. Burning a DVD-5 plan at DVD-9 rates is
      the fastest way to make a disc that does not fit.
    */
    discType: project.discType,
    chaptersEnabled: project.chaptersEnabled,
    chapterMinutes: project.chapterMinutes,
    /*
      Last, and not because it matters least.

      Every field above describes the project. This one describes the program
      that turns it into video, and it is the only field here that can change
      while the project stays exactly as it was. Without it, a release that fixes
      the encoder produces a prepared disc that still claims to be current, and
      the fix never reaches a burned disc unless somebody happens to change a
      slide first.
    */
    encoderRevision,
  };
}

/**
 * Read the record of what was last built into this folder.
 *
 * Returns null when nothing has been built there, so a first run is not
 * mistaken for a stale one.
 */
function readBuildRecord(workDir) {
  try {
    const raw = fs.readFileSync(path.join(workDir, 'build.json'), 'utf8');
    const record = JSON.parse(raw);
    return record && record.fingerprint ? record : null;
  } catch {
    return null;
  }
}

/**
 * Build every menu page from the slide deck.
 *
 * Each slide becomes one DVD menu page: the picture is rendered, encoded as a
 * legal one-frame MPEG-2 stream, and then given its button subpictures by
 * spumux. Button commands are resolved here, because this is the only place
 * that knows both the title numbering (position in the prepared video list) and
 * the menu numbering (position among the slides that actually have buttons).
 */
async function buildMenus({ project, videos, tools, root, BrowserWindow, signal, onLog }) {
  // The whole navigation graph — pages, buttons, rectangles, arrow-key
  // movement and jump commands — comes from one place, so the disc that gets
  // burned and the simulator that previews it are derived from the same data.
  const model = dvdModel.buildDiscModel({
    deck: project.deck || {},
    videos,
    aspect: project.titleAspect || '16:9',
  });
  const { deck, layout } = model;

  /*
    A page can have nothing on it that can be pressed, and still be a page.

    Which slides are pages is decided in the disc model, and it counts a slide a
    button points at as well as a slide with buttons on it — a page of words is
    somewhere the viewer is sent, and the remote's Menu key brings them back. All
    this needs to know is whether there is anything to build at all.
  */
  if (!model.menus.length) {
    return { menus: [], layout, deck, model };
  }

  if (signal && signal.aborted) throw new encode.AbortError('Stopped.');

  const menuDir = path.join(root, 'menu');
  const pngDir = path.join(menuDir, 'slides');
  fs.mkdirSync(menuDir, { recursive: true });

  const rendered = await deckRender.renderDeck({
    layout,
    outputDir: pngDir,
    BrowserWindow,
  });
  const pngBySlideId = new Map(rendered.files.map((f) => [f.slideId, f.path]));

  const highlightColor = deck.highlightColor || '#e0a34a';
  const selectColor = deck.selectColor || '#f2c477';

  const menus = [];

  for (const page of model.menus) {
    const pngPath = pngBySlideId.get(page.slideId);
    if (!pngPath) {
      throw new Error(`The picture for "${page.title}" was not produced.`);
    }

    const stillPath = path.join(menuDir, `menu_still_${page.slideIndex + 1}.mpg`);

    /*
      The page's own sound, if it has one.

      A menu page with audio is a motion menu: the still is held on screen for as
      long as the sound lasts and the player waits for the remote afterwards,
      exactly as it does for a silent page. Everything that decides the length —
      including the trim to what the format can afford — was settled in the disc
      model, so this only has to encode it.

      A file that has been moved or deleted since it was chosen falls back to a
      silent page, and so does one this ffmpeg cannot decode. The menu is the
      thing that has to work: losing the music is a disappointment, losing the
      disc is a failure, and it must never be the second one.
    */
    const sound = page.sound;
    const soundUsable = Boolean(sound && sound.path && fs.existsSync(sound.path));
    if (sound && !soundUsable && onLog) {
      onLog(
        `The sound chosen for "${page.title}" is no longer at ${sound.path}, ` +
          `so that page will be silent.`
      );
    }

    const stillArgs = (withSound) =>
      author.buildMenuStillArgs({
        inputPng: pngPath,
        outputVob: stillPath,
        videoFormat: project.videoFormat,
        aspect: project.titleAspect || '16:9',
        audioPath: withSound ? sound.path : null,
        seconds: withSound ? sound.seconds : 1,
      });

    try {
      await runFfmpeg(tools.ffmpeg, stillArgs(soundUsable));
    } catch (err) {
      if (!soundUsable) throw err;
      if (onLog) {
        onLog(
          `The sound for "${page.title}" could not be used (${String(err.message || err)}), ` +
            `so that page will be silent.`
        );
      }
      await runFfmpeg(tools.ffmpeg, stillArgs(false));
    }

    /*
      The layer the player puts over the menu to show which button is lit.

      spumux takes these as image files, so they are pictures of the button
      rectangles: transparent everywhere else. Both are referenced by bare
      filename, which resolves because spumux is run with the menu folder as its
      working directory.
    */
    const boxes = page.buttons.map((button) => ({
      x0: button.x0,
      y0: button.y0,
      x1: button.x1,
      y1: button.y1,
    }));

    const highlightName = `highlight_${page.page}.png`;
    const selectName = `select_${page.page}.png`;

    const highlightArgs = author.buildHighlightImageArgs({
      outputPng: path.join(menuDir, highlightName),
      boxes,
      color: highlightColor,
      // Lit, but see-through enough to read the label underneath.
      opacity: 84,
    });
    const selectArgs = author.buildHighlightImageArgs({
      outputPng: path.join(menuDir, selectName),
      boxes,
      color: selectColor,
      // The button just pressed, so brighter.
      opacity: 210,
    });

    if (highlightArgs) await runFfmpeg(tools.ffmpeg, highlightArgs);
    if (selectArgs) await runFfmpeg(tools.ffmpeg, selectArgs);

    /*
      A page with nothing to press is the still on its own.

      Spumux exists here to attach the button rectangles and the highlight
      pictures to a still. With no buttons there is nothing to attach — both
      highlight pictures come back empty for an empty box list — so asking it for
      an empty subpicture stream is work with a failure mode and no upside. The
      still VOB is already a page a player can show and leave with the remote's
      Menu key. Such a page is only ever built because a button points at it,
      which is settled in the disc model.
    */
    let buttonedPath = stillPath;
    if (page.buttons.length) {
      buttonedPath = path.join(menuDir, `menu_buttoned_${page.slideIndex + 1}.mpg`);
      await runSpumuxToFile({
        spumuxPath: tools.spumux,
        xml: author.buildSpumuxXml({
          buttons: page.buttons,
          navigation: page.navigation,
          highlightPath: highlightArgs ? highlightName : null,
          selectPath: selectArgs ? selectName : null,
          videoFormat: project.videoFormat,
        }),
        inputVob: stillPath,
        outputPath: buttonedPath,
        workDir: menuDir,
        signal,
      });
    }

    menus.push({
      slideId: page.slideId,
      title: page.title,
      pngPath,
      vobPath: buttonedPath,
      buttons: page.buttons,
      // Carried through so what was actually built can be reported — a page
      // whose music was dropped for a missing file should be visible afterwards,
      // not only in the log at the moment it happened.
      sound: page.sound || null,
    });
  }

  if (!menus.length) {
    throw new Error(
      'None of the slides had a button that could be used, so there would be no ' +
        'way to choose anything on the disc. Add a button, or turn the menu off.'
    );
  }

  /*
    Nothing anywhere to press.

    A page with no buttons on it is legitimate — it is somewhere a button sends
    the viewer — but a disc of nothing *but* those is a disc nobody can do
    anything with, and there is no page for the viewer to escape to. This used to
    be caught by the same error above, back when a page with no buttons was not a
    page at all; now it takes its own check, because pages can be empty
    individually.

    The usual cause is a picture or button pointing at a slide that has since been
    deleted: the link resolves to nothing, so nothing on that page resolves
    either.
  */
  if (!menus.some((page) => page.buttons.length)) {
    throw new Error(
      'Nothing on any of the pages can be pressed, so the disc could not be ' +
        'chosen from. A link pointing at a slide that has been deleted does this.'
    );
  }

  return { menus, layout, deck, model };
}

/**
 * spumux writes to stdout, which we redirect into the target file. Running it
 * as a shell redirect would mean a shell and a quoting problem, so the output
 * stream is piped by hand instead.
 */
function runSpumuxToFile({ spumuxPath, xml, inputVob, outputPath, workDir, signal }) {
  return new Promise((resolve, reject) => {
    if (!spumuxPath) {
      return reject(
        new Error(
          'The menu tool (spumux) is not installed, so a menu cannot be built. ' +
            'Turn the menu off, or open Setup for install instructions.'
        )
      );
    }

    const xmlPath = path.join(workDir, 'menu_buttons.xml');
    fs.writeFileSync(xmlPath, xml, 'utf8');
    fs.rmSync(outputPath, { force: true });

    const out = fs.createWriteStream(outputPath);
    /*
      spumux takes exactly one argument — the control file — and reads the video
      to attach subtitles to from its standard input, writing the result to
      standard output:

        spumux [options] script.sub < in.mpg > out.mpg

      Passing the VOB as a second argument is rejected outright with "Only one
      argument expected", so the VOB is piped in instead.
    */
    const child = spawn(spumuxPath, [xmlPath], { windowsHide: true, cwd: workDir });
    const input = fs.createReadStream(inputVob);
    input.on('error', (err) => {
      out.destroy();
      reject(new Error(`Could not read the menu video: ${err.message}`));
    });
    input.pipe(child.stdin);

    const logs = [];
    child.stdout.pipe(out);
    child.stderr.on('data', (c) => logs.push(c));

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

    child.on('error', (err) => {
      out.destroy();
      reject(new Error(`Could not start the menu tool: ${err.message}`));
    });

    out.on('error', (err) => {
      reject(new Error(`Could not write the menu video: ${err.message}`));
    });

    child.on('close', (code) => {
      out.end(() => {
        if (signal && signal.aborted) return reject(new encode.AbortError('Stopped.'));
        const log = Buffer.concat(logs).toString();
        if (code !== 0) {
          const line = log.split('\n').map((l) => l.trim()).filter(Boolean).pop();
          return reject(new Error(`Building the menu failed. ${line || 'No reason given.'}`));
        }
        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
          return reject(new Error('Building the menu produced an empty file.'));
        }
        resolve(outputPath);
      });
    });
  });
}

/** Run ffmpeg to completion for a one-shot filter job. */
function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (c) => {
      err = (err + c.toString()).slice(-4000);
    });
    child.on('error', (e) => reject(new Error(`Could not start the video tool: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        const line = err.split('\n').map((l) => l.trim()).filter(Boolean).pop();
        reject(new Error(`Preparing the menu picture failed. ${line || 'No reason given.'}`));
      } else {
        resolve();
      }
    });
  });
}

/** Build a disc image from a prepared project. */
async function makeImage(prepared, { tools, outputIso, onProgress, signal, log }) {
  const iso = outputIso || path.join(path.dirname(prepared.videoTsDir), `${prepared.volumeLabel}.iso`);

  return disc.buildIso({
    // The image must contain the VIDEO_TS folder at its root, so the source is
    // the *parent* of VIDEO_TS.
    sourceDir: path.dirname(prepared.videoTsDir),
    outputIso: iso,
    volumeLabel: prepared.volumeLabel,
    hdiutil: tools.hdiutil,
    mkisofs: tools.mkisofs,
    onProgress,
    signal,
    log,
  });
}

/**
 * What an image was built from: the image format, the disc's label, and every
 * file in VIDEO_TS with its size and modification time.
 *
 * dvdauthor rewrites every file on every build, so any rebuild at all changes
 * this — which is what makes it safe to burn an image again without making it
 * again.
 */
function imageSignature(prepared) {
  const files = [];
  try {
    for (const name of fs.readdirSync(prepared.videoTsDir).sort()) {
      const stat = fs.statSync(path.join(prepared.videoTsDir, name));
      if (stat.isFile()) files.push([name, stat.size, Math.round(stat.mtimeMs)]);
    }
  } catch {
    return null;
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ format: disc.IMAGE_REVISION, label: prepared.volumeLabel, files }))
    .digest('hex');
}

/** The image already on disk for this exact build, or null. */
function reusableImage(isoPath, signature) {
  if (!signature) return null;
  try {
    const stamp = JSON.parse(fs.readFileSync(`${isoPath}.json`, 'utf8'));
    if (stamp.signature !== signature) return null;
    if (fs.statSync(isoPath).size !== stamp.bytes) return null;
    return isoPath;
  } catch {
    return null;
  }
}

/** Burn a prepared project to a real disc. */
async function burn(prepared, { tools, device, onProgress, signal, verify = true, workDir, log }) {
  const isoPath = path.join(workDir || path.dirname(prepared.videoTsDir), `${prepared.volumeLabel}.iso`);
  const stampPath = `${isoPath}.json`;

  /*
    The image is reused only when it is provably this build's image.

    It once skipped the build whenever a file of that name existed — and the name
    comes from the disc's label, so it is the same file every time for a given
    project. The second burn of a project then wrote the first burn's image, with
    no sign anything was wrong until the disc came out of the player.

    So the image now carries a stamp of exactly what it was made from (see
    imageSignature), and anything short of an exact match builds it again.
    Burning a second copy of the same disc goes straight to the drive; a rebuilt
    disc cannot be mistaken for the old one.
  */
  const signature = imageSignature(prepared);
  if (reusableImage(isoPath, signature)) {
    if (log) log('The disc image from the last burn is still current, so it is being used again.');
  } else {
    fs.rmSync(stampPath, { force: true });
    if (log) log('Building the disc image…');
    const built = await makeImage(prepared, {
      tools,
      outputIso: isoPath,
      onProgress: (f) =>
        onProgress && onProgress({ stage: 'image', fraction: f, message: 'Building the disc image…' }),
      signal,
      log,
    });
    try {
      fs.writeFileSync(stampPath, JSON.stringify({ signature, bytes: fs.statSync(built.isoPath).size }));
    } catch {
      // Without a stamp the next burn just builds the image again.
    }
  }

  const writing = 'Writing to disc. Do not remove it…';
  // Calibrating and spinning up take a while before any data moves; say so
  // rather than pretending to write.
  if (onProgress) onProgress({ stage: 'burn', fraction: 0, message: 'Getting the drive ready' + String.fromCharCode(0x2026) });

  const result = await disc.burnIso({
    isoPath,
    device,
    hdiutil: tools.hdiutil,
    onProgress: (f, message) =>
      onProgress && onProgress({ stage: 'burn', fraction: f, message: message || writing }),
    signal,
    verify,
    log,
  });

  return { ...result, isoPath };
}

/** Copy the finished VIDEO_TS folder somewhere the user chose. */
function saveFolder(prepared, destination, onProgress) {
  return disc.copyDiscFolder({
    videoTsDir: prepared.videoTsDir,
    destination,
    onProgress,
  });
}

/**
 * Remove only the files that make up a disc structure, leaving anything else in
 * the folder alone. This mirrors what dvdauthor's own `-O` does, and it is why
 * a crashed run cannot leave a stale VIDEO_TS behind to confuse the next one.
 */
function removeDiscStructure(dir) {
  const videoTs = path.join(dir, 'VIDEO_TS');
  const audioTs = path.join(dir, 'AUDIO_TS');
  for (const target of [videoTs, audioTs]) {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
  for (const entry of safeReaddir(dir)) {
    if (/\.(iso|img|log)$/i.test(entry)) fs.rmSync(path.join(dir, entry), { force: true });
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function requireTools(tools, names) {
  const missing = names.filter((n) => !tools[n]);
  if (missing.length) {
    throw new Error(
      `These required tools are missing: ${missing.join(', ')}. Open Setup for how to install them.`
    );
  }
}

/**
 * A quick sanity check of a finished disc, run after authoring.
 *
 * This is cheap insurance: it reads the *actual* encoded files back with
 * ffprobe and confirms the resolution, frame rate and audio format match the
 * format that was asked for. Catching a spec violation here costs seconds;
 * catching it after a burn costs a blank disc and twenty minutes.
 */
async function verifyDisc(prepared, { tools }) {
  const problems = [];
  const isPal = prepared.plan.format.id === 'pal';
  const expected = {
    width: 720,
    height: isPal ? 576 : 480,
    fps: isPal ? 25 : 30000 / 1001,
  };

  for (const video of prepared.videos) {
    for (const part of video.parts || []) {
      try {
        const info = await probeMod.probeVideo(tools.ffprobe, part.file);
        if (info.width !== expected.width) {
          problems.push(`${video.name}: width is ${info.width}, expected ${expected.width}.`);
        }
        if (info.height !== expected.height) {
          problems.push(`${video.name}: height is ${info.height}, expected ${expected.height}.`);
        }
        if (Math.abs(info.fps - expected.fps) > 0.05) {
          problems.push(
            `${video.name}: frame rate is ${info.fps}, expected ${expected.fps.toFixed(3)}.`
          );
        }
        if (info.audioCodec && info.audioCodec !== 'ac3') {
          problems.push(`${video.name}: sound is ${info.audioCodec}, expected ac3.`);
        }
        if (info.audioSampleRate && Number(info.audioSampleRate) !== 48000) {
          problems.push(
            `${video.name}: sound is ${info.audioSampleRate} Hz, expected 48000 Hz.`
          );
        }
      } catch (err) {
        problems.push(`${video.name}: could not be read back (${err.message}).`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

module.exports = {
  normaliseProject,
  defaultDeck,
  inspect,
  prepare,
  makeImage,
  burn,
  saveFolder,
  verifyDisc,
  removeDiscStructure,
  buildMenus,
  // For deciding whether what is on disk is still what the project says.
  projectFingerprint,
  fingerprintPayload,
  readBuildRecord,
};
