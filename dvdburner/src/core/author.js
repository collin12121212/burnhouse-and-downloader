'use strict';

/**
 * Building a real VIDEO_TS tree.
 *
 * Authoring is handed to dvdauthor rather than written by hand. A DVD-Video
 * filesystem is a nest of binary IFO tables containing video-object-unit
 * pointers, navigation packs and a small virtual machine; hand-rolling that
 * produces discs that play on one player and freeze on the next. dvdauthor has
 * done this correctly for twenty years, so we generate its XML and let it work.
 *
 * The mapping from the slide deck to a disc is direct:
 *
 *   one slide          -> one DVD menu page (a PGC in the titleset menu domain)
 *   one button element -> one button region on that page
 *   one video          -> one DVD title
 *
 * The division of labour that matters: spumux decides WHERE the buttons are
 * (the subpicture rectangles), dvdauthor decides WHAT they do (the commands,
 * matched up by button name in order). Getting that backwards produces a menu
 * that looks correct and responds to nothing.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { AbortError } = require('./encode');

/** Escape a string for XML text or an attribute value. */
function xmlEscape(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * A filesystem-safe, human-readable name for the disc volume. Uppercase with
 * underscores is what DVD players display most reliably on their front panel.
 */
function discLabel(title) {
  const cleaned = String(title || '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9 _.-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '')
    .toUpperCase();
  return (cleaned || 'MY_DVD').slice(0, 32);
}

/**
 * Format a seconds value the way dvdauthor wants a chapter mark:
 * [[h:]mm:]ss[.frac]
 */
function formatChapterTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Spread chapter marks across a title.
 *
 * A title is usually several VOB files (the dvd muxer splits at 1 GB), and
 * dvdauthor applies a `chapters` list to the single `<vob>` it is attached to,
 * with times relative to that file. So chapters have to be distributed across
 * the parts by duration share, and the last few seconds of each file are
 * skipped because a mark there is unreachable.
 */
function distributeChapters(parts, totalSeconds, { intervalSeconds = 300, maxChapters = 24 } = {}) {
  const duration = Number(totalSeconds) || 0;
  const sizes = parts.map((p) => p.bytes || 0);
  const totalBytes = sizes.reduce((a, b) => a + b, 0);

  if (duration < 90 || totalBytes <= 0) {
    return parts.map(() => []);
  }

  const wanted = Math.min(maxChapters, Math.max(2, Math.floor(duration / intervalSeconds)));
  const marks = [];
  for (let i = 1; i < wanted; i += 1) {
    const t = (duration / wanted) * i;
    if (t > 8 && t < duration - 8) marks.push(t);
  }

  const result = parts.map(() => []);
  let partStart = 0;

  parts.forEach((part, index) => {
    const share = (sizes[index] / totalBytes) * duration;
    const partEnd = partStart + share;
    const isLast = index === parts.length - 1;

    for (const mark of marks) {
      if (mark <= partStart) continue;
      if (!isLast && mark >= partEnd) continue;
      const relative = mark - partStart;
      if (relative < 2) continue;
      if (relative > share - 2) continue;
      result[index].push(relative);
    }

    partStart = partEnd;
  });

  return result;
}

/**
 * Build the dvdauthor control file.
 *
 * @param {object} options
 * @param {string} options.videoFormat  'ntsc' | 'pal'
 * @param {string} options.titleAspect  '16:9' | '4:3'
 * @param {Array} options.menus         one entry per slide, in order:
 *        `{ vobPath, aspect, buttons: [{ name, command, videoId, targetSlideId }] }`
 * @param {Array} options.titles        `[{ parts: [{file,bytes}], chapters: [[]] }]`
 * @param {number} [options.rootPage]   the page the disc opens on and the Menu
 *        key returns to. It is the first page with a button on it, which is not
 *        necessarily the first one written out — see the note where it is used.
 */
function buildDvdauthorXml({ videoFormat, titleAspect, menus, titles, rootPage = 1 }) {
  const isPal = String(videoFormat).toLowerCase() === 'pal';
  const tvsystem = isPal ? 'PAL' : 'NTSC';
  // No GOP size is declared anywhere in the control file. dvdauthor reads the
  // real GOP structure out of the encoded stream, and it rejects a `gop`
  // attribute on <video> outright — its reader only accepts mpeg, format,
  // aspect, resolution, widescreen and caption there. The encoder sets the
  // actual GOP length, which is the one that matters.
  const resolution = isPal ? '720x576' : '720x480';
  const aspect = titleAspect === '4:3' ? '4:3' : '16:9';
  const hasMenus = Array.isArray(menus) && menus.some((m) => m && m.vobPath);

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  /*
    No `xmlns`, and no `jumppad`.

    dvdauthor does not parse namespaces: its reader walks every attribute and
    aborts on any it does not recognise, and the root element's list is exactly
    `jumppad`, `allgprm`, `format` and `provider`. An `xmlns` declaration is
    presented as one more attribute, so the build stopped with "Cannot match
    attribute 'xmlns' in tag 'dvdauthor'".

    `jumppad` was there to widen how many destinations a jump can reach, but it
    requires a video-manager menu to exist, and we only ever jump within a single
    titleset. Leaving it off removes a requirement we were not meeting.
  */
  out.push('<dvdauthor>');
  /*
    The video manager has to declare the video format, even with no menu of its
    own.

    dvdauthor builds the video manager regardless, and needs to know whether the
    frames are NTSC or PAL to write its tables. It cannot be told on the command
    line — with `-x` it accepts no other option at all, and says so — so it has
    to be here. `<video>` is not accepted directly inside `<vmgm>`; it belongs in
    a `<menus>` element, which is allowed to be empty of pages.
  */
  out.push('  <vmgm>');
  out.push('    <menus>');
  out.push(
    `      <video format="${tvsystem}" aspect="${aspect}" resolution="${resolution}" />`
  );
  out.push('    </menus>');
  out.push('  </vmgm>');
  out.push('  <titleset>');

  // ----------------------------------------------------------- menu pages ---
  if (hasMenus) {
    out.push('    <menus>');
    out.push(
      `      <video format="${tvsystem}" aspect="${aspect}" ` +
        `resolution="${resolution}" />`
    );

    let menuNumber = 1;
    menus.forEach((menu, index) => {
      /*
        A page with no buttons is written out too.

        It is a page a button somewhere points at — a page of words, or one
        photograph — and the disc has to be able to go there. Leaving it out here
        while the model had already given it a number is the disc-wide bug this
        whole ordering exists to avoid: every page after it would be one out, and
        a button saying "jump menu 2" would land on the third page. A `<pgc>` with
        a still and no `<button>` children is a legal page; it simply has nothing
        to light up.
      */
      if (!menu || !menu.vobPath) return;

      /*
        The entry point, which is the page with a button on it rather than
        necessarily the first one written.

        A player shows this page when the disc goes in and returns to it when the
        Menu key is pressed. A page with nothing pressable on it would therefore
        be a dead end from the very first second — and since the Menu key returns
        here, there would be no way out of it either. The page *numbers* stay in
        slide order so that every command already written stays true; only the
        entry moves.
      */
      const entryAttr = menuNumber === rootPage ? ' entry="root"' : '';
      out.push(`      <pgc${entryAttr}>`);
      /*
        No `<pre>` block here.

        There is no command to run before a menu page, and an empty block is not
        allowed: dvdauthor's command parser stops with "syntax error,
        unexpected CLOSEBRACE_TOK" on the closing brace of `{ }`. A page with no
        pre-commands simply has no `<pre>` element.
      */
      out.push(`        <vob file="${xmlEscape(menu.vobPath)}" pause="inf" />`);

      for (const button of menu.buttons) {
        out.push(
          `        <button name="${xmlEscape(button.name)}">{ ${button.command} }</button>`
        );
      }

      /*
        No `<post>` on a menu page.

        The page is shown with `pause="inf"`, so it never finishes and there is
        nothing for a post-command to follow. dvdauthor rejects one here — it
        stopped with "in VTS pgc 0, <post>" — and the "does not park in an
        undefined state" concern it was meant to address does not arise, because
        an infinite pause has no end to reach.
      */
      out.push('      </pgc>');

      menuNumber += 1;
      void index;
    });

    out.push('    </menus>');
  }

  // -------------------------------------------------------------- titles ----
  out.push('    <titles>');
  out.push(
    `      <video format="${tvsystem}" aspect="${aspect}" ` +
      `resolution="${resolution}" />`
  );

  titles.forEach((title, index) => {
    /*
      A title page carries no `entry` attribute.

      Using `entry="title"` here was meant to make a disc with no menu pages
      start playing, but dvdauthor rejects it: for a titles PGC the only entry it
      accepts is `notitle`, and anything else stops the build with "Unknown entry
      'title'". It is not needed anyway — with no first-play chain defined,
      dvdauthor makes one that jumps to title 1, which is exactly the behaviour
      that was wanted.
    */
    out.push('      <pgc>');

    const parts = title.parts || [];
    const chapterLists = title.chapters || parts.map(() => []);

    parts.forEach((part, partIndex) => {
      const list = chapterLists[partIndex] || [];
      const chaptersAttr = list.length
        ? ` chapters="${list.map(formatChapterTime).join(',')}"`
        : '';
      out.push(`        <vob file="${xmlEscape(part.file)}"${chaptersAttr} />`);
    });

    /*
      Where the disc goes when a film ends.

      Normally straight on to the next film in slide order, so a disc of
      episodes plays back to back without anybody reaching for the remote.

      The last film returns to the menu — and it has to be `call`, not `jump`.
      A title lives in the titles domain and a menu lives in the menu domain, and
      dvdauthor refuses to jump between them: "Cannot jump to a menu from a
      title, use 'call' instead". This is the DVD-Video navigation model, not a
      quirk: `call` saves a resume point, and choosing a button on the menu then
      jumps away, discarding it. It is what commercial discs do.
    */
    const next = Number(title.nextTitle);
    const post = Number.isFinite(next) && next > 0
      ? `jump title ${next};`
      : hasMenus
        ? 'call menu entry root;'
        : 'jump title 1;';
    out.push(`        <post> { ${post} } </post>`);
    out.push('      </pgc>');
  });

  out.push('    </titles>');
  out.push('  </titleset>');
  out.push('</dvdauthor>');

  return out.join('\n');
}

/**
 * Build the spumux configuration: the button rectangles that light up as the
 * remote moves between entries.
 *
 * The shape of this file is not a matter of taste. spumux parses it against a
 * fixed table of element/attribute pairs, and its reader aborts the moment an
 * attribute is not in that table:
 *
 *   - `x0`/`y0`/`x1`/`y1` are accepted on `<button>`, and NOT on `<spu>`.
 *     Putting the geometry on `<spu>` stops the build with
 *     "Cannot match attribute 'x0' in tag 'spu'".
 *   - `<button>` is only accepted as a child of `<spu>`, so the rectangles must
 *     all sit inside one `<spu>` element.
 *   - `highlight` and `select` are FILENAMES — spumux loads them with
 *     localize_filename. Passing a colour there makes it try to open a file
 *     called "#e0a34a" and fail. The pictures are built by
 *     buildHighlightImageArgs and passed in as paths.
 *
 * Geometry must be even numbers: DVD subpicture coordinates are measured in
 * two-pixel units by the decoder, and an odd value shifts the highlight half a
 * pixel out of alignment with the label underneath it.
 *
 * `navigation` is the table from dvd_nav.navigationFor. Writing it out
 * explicitly is what makes the disc's behaviour knowable — and it is the same
 * table the simulator reads, so the two cannot disagree.
 */
function buildSpumuxXml({ buttons, navigation = null, highlightPath = null, selectPath = null, videoFormat = 'ntsc' }) {
  const out = [];
  // spumux refuses to run without being told the video format: it has to know
  // whether the frames are 480 or 576 lines before it can place anything.
  out.push(`<subpictures format="${String(videoFormat).toLowerCase() === 'pal' ? 'PAL' : 'NTSC'}">`);
  out.push('  <stream>');

  const images =
    (highlightPath ? ` highlight="${xmlEscape(highlightPath)}"` : '') +
    (selectPath ? ` select="${xmlEscape(selectPath)}"` : '');

  out.push(`    <spu start="00:00:00.00" end="00:00:00.00" force="yes"${images}>`);

  for (const button of buttons) {
    const moves = navigation && navigation[button.name] ? navigation[button.name] : {};
    const navAttrs = ['up', 'down', 'left', 'right']
      .filter((direction) => moves[direction])
      .map((direction) => `${direction}="${xmlEscape(moves[direction])}"`)
      .join(' ');

    out.push(
      `      <button name="${xmlEscape(button.name)}" ` +
        `x0="${even(button.x0)}" y0="${even(button.y0)}" ` +
        `x1="${even(button.x1)}" y1="${even(button.y1)}"` +
        (navAttrs ? ` ${navAttrs}` : '') +
        ' />'
    );
  }

  out.push('    </spu>');
  out.push('  </stream>');
  out.push('</subpictures>');
  return out.join('\n');
}

/**
 * The picture a DVD player lays over the menu to show which button is lit.
 *
 * One frame, the size of the menu, transparent everywhere except the button
 * rectangles. `opacity` out of 255 is what makes the highlight translucent, so
 * the label underneath stays readable.
 *
 * Two ffmpeg inputs are combined: an opaque layer carrying the colour, and a
 * grayscale layer carrying the opacity, merged by `alphamerge`. `drawbox` with
 * an alpha colour cannot do this on its own — it premultiplies the colour and
 * leaves the alpha channel at zero, producing a highlight that is completely
 * invisible on a television.
 *
 * Returns null when there are no rectangles, because an empty filter chain is a
 * hard ffmpeg error rather than an empty picture.
 */
function buildHighlightImageArgs({
  outputPng,
  boxes = [],
  color = '#e0a34a',
  opacity = 90,
  width = 720,
  height = 480,
}) {
  if (!boxes.length) return null;

  const colorSpec = String(color).startsWith('#')
    ? `0x${String(color).slice(1)}`
    : String(color);

  const level = Math.max(0, Math.min(255, Math.round(opacity)));
  const nibble = level.toString(16).padStart(2, '0');
  const graySpec = `0x${nibble}${nibble}${nibble}`;

  const drawAll = (fill) =>
    boxes
      .map((box) => {
        const x = even(box.x0);
        const y = even(box.y0);
        const w = Math.max(2, even(box.x1) - x);
        const h = Math.max(2, even(box.y1) - y);
        return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${fill}:t=fill`;
      })
      .join(',');

  const filterComplex =
    `[0:v]${drawAll(colorSpec)}[base];` +
    `[1:v]${drawAll(graySpec)}[mask];` +
    '[base][mask]alphamerge,format=rgba';

  return [
    '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}`,
    '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}`,
    '-filter_complex', filterComplex,
    '-frames:v', '1',
    outputPng,
  ];
}

function even(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  return v % 2 === 0 ? v : v + 1;
}

/**
 * Convert a rendered slide picture into an MPEG-2 still that dvdauthor can use
 * as a menu page.
 *
 * A DVD menu is a one-frame MPEG-2 video stream, so this is a genuine encode,
 * not a rename. The PNG comes from the offscreen Chromium canvas, which is why
 * the designer can offer real fonts, pictures and layout.
 *
 * The picture handed in is ALREADY the DVD raster (720x480), drawn by the
 * designer in that space. So the only thing to do here is label its shape: set
 * the sample aspect ratio for widescreen and encode. It must NOT be scaled into
 * a square-pixel intermediate and padded — doing that pillarboxes the design,
 * and the menu then plays as a narrow card with black bars down each side
 * instead of filling a widescreen television. Verified by measuring the encoded
 * frame: with the intermediate the edges came out black, without it the design
 * reaches both edges.
 *
 * The field order is labelled to match the titles — bottom first on NTSC, top
 * first on PAL. A menu that disagrees with the titles makes some televisions
 * re-sync between the menu and the film, which shows up as a black flicker. It
 * used to say top-first on both while the titles said bottom-first on NTSC,
 * which is exactly that disagreement. And it is a label, not an `interlace`
 * filter: that filter builds each frame out of two, which for a still picture
 * is the same picture twice for no benefit.
 *
 * With `audioPath` the page becomes a motion menu: the same still frame is held
 * for as long as the sound runs, and the player waits for the remote afterwards
 * exactly as it did before. That changes one thing about the encoder — see the
 * note on the GOP below — because a still held for a minute and a half is a very
 * different thing to encode from a still held for one second.
 */
function buildMenuStillArgs({
  inputPng,
  outputVob,
  videoFormat,
  seconds = 1,
  aspect = '16:9',
  audioPath = null,
}) {
  const isPal = String(videoFormat).toLowerCase() === 'pal';
  const width = 720;
  const height = isPal ? 576 : 480;
  const fps = isPal ? 25 : 30000 / 1001;
  const is169 = aspect === '16:9';
  // NTSC 16:9 displays 720x480 as 854x480, so its sample aspect ratio is 32:27.
  // 4:3 displays the same raster as 640x480, so 8/9.
  const sar = is169 ? (isPal ? '64/45' : '32/27') : (isPal ? '16/15' : '8/9');

  const hold = Math.max(1, Math.round(Number(seconds) || 1));
  const hasSound = Boolean(audioPath);

  const args = [
    '-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
    '-loop', '1',
    '-framerate', String(fps),
    '-i', inputPng,
  ];

  if (hasSound) {
    /*
      The chosen sound, in place of the silence.

      A menu page has one sound track, so this is the whole of what a menu can
      do with audio — no mixing, no second track.
    */
    args.push('-i', audioPath, '-map', '0:v:0', '-map', '1:a:0');
  } else {
    args.push(
      /*
        A silent audio track, so the menu can go through the DVD muxer.

        This is not decoration: the DVD muxer is what writes the navigation packs
        that make a file a VOB, and dvdauthor locates its VOBUs by those packs. A
        video-only program stream has no nav packs at all, so dvdauthor walked the
        file, found nothing it recognised and stopped with "no VOBUs found" — the
        whole reason a menu could never be built. A menu with a silent track is
        also what every commercial disc has.
      */
      '-f', 'lavfi',
      '-t', String(hold),
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'
    );
  }

  args.push(
    '-vf',
    `scale=${width}:${height}:flags=lanczos:in_range=tv:out_range=tv,` +
      `setsar=${sar},format=yuv420p,setfield=${isPal ? 'tff' : 'bff'}`,
    '-c:v', 'mpeg2video',
    /*
      The headline bitrate stays at the maximum legal still rate either way, and
      that is deliberate: it is what the one frame that carries the whole design
      is encoded at, so the menu is as sharp as a DVD allows.

      What changes with sound is the GOP. A one-second menu is encoded all-intra,
      which is instant to seek and cost nothing at that length. Held for a minute
      and a half it would cost the same nine megabits *per frame* — hundreds of
      megabytes of disc for a picture that never changes. With ordinary
      prediction the first frame still gets the full bitrate and every frame after
      it is the same picture again, so it costs almost nothing and looks
      identical.
    */
    '-b:v', '9800000',
    '-maxrate', '9800000',
    '-bufsize', '1835008',
    '-g', isPal ? '15' : '18',
    '-bf', hasSound ? '2' : '0',
    '-intra_dc_precision', '2',
    '-intra_vlc', '1',
    '-non_linear_quant', '1',
    '-qmin', '2',
    '-qmax', '28',
    /*
      Interlaced DCT keeps the stream marked interlaced, as a DVD must be. Not
      interlaced motion search: there is no motion in a still, and on a page
      with a minute and a half of music that search ran over every one of
      thousands of identical frames.
    */
    '-flags', '+ildct',
    '-pix_fmt', 'yuv420p',
    '-aspect', aspect,
    '-r', isPal ? '25' : '30000/1001',
    '-c:a', 'ac3',
    '-b:a', '192000',
    '-ar', '48000',
    '-ac', '2',
    '-t', String(hold),
    '-shortest',
    '-f', 'dvd',
    outputVob
  );

  return args;
}

/** Run dvdauthor over a prepared tree, returning the VIDEO_TS directory. */
function runDvdauthor({ dvdauthorPath, xml, workDir, videoFormat = 'ntsc', onOutput, signal }) {
  return new Promise((resolve, reject) => {
    if (!dvdauthorPath) {
      return reject(
        new Error(
          'The disc-building tool (dvdauthor) is not installed, so a playable ' +
            'DVD cannot be built. Open Setup for how to install it.'
        )
      );
    }

    const xmlPath = path.join(workDir, 'dvdauthor.xml');
    fs.writeFileSync(xmlPath, xml, 'utf8');
    /*
      Only `-x` and `-o`.

      dvdauthor accepts no other command-line option once a control file is
      given — it stops with "Cannot use command line options after specifying XML
      config file" — so everything the video manager needs, including its video
      format, has to be declared inside the file. That is why the VMGM carries a
      <video> element.
    */
    const args = ['-x', xmlPath, '-o', workDir];

    const child = spawn(dvdauthorPath, args, { windowsHide: true, cwd: workDir });

    let log = '';
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

    const collect = (chunk) => {
      const text = chunk.toString();
      log = (log + text).slice(-16000);
      if (onOutput) onOutput(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('error', (err) => reject(new Error(`Could not start dvdauthor: ${err.message}`)));

    child.on('close', (code) => {
      if (signal && signal.aborted) return reject(new AbortError('Authoring was stopped.'));
      if (code !== 0) return reject(new Error(describeDvdauthorFailure(log)));

      const videoTsDir = path.join(workDir, 'VIDEO_TS');
      if (!fs.existsSync(path.join(videoTsDir, 'VIDEO_TS.IFO'))) {
        return reject(
          new Error(
            'The disc structure was built but came out incomplete. This usually ' +
              'means there was too much material for one disc.'
          )
        );
      }
      resolve({ videoTsDir, log });
    });
  });
}

function lastLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || '';
}

function describeDvdauthorFailure(output) {
  const text = String(output || '');
  if (/no space/i.test(text)) {
    return 'Ran out of disk space while building the disc.';
  }
  if (/Cannot open|No such file/i.test(text)) {
    return (
      'The disc could not be built because one of the prepared video files was ' +
        'missing. Run Build again.'
    );
  }
  if (/too (big|large)|exceeds/i.test(text)) {
    return 'There is too much material for one disc. Remove a video or lower the quality.';
  }
  if (/button/i.test(text) && /(too many|limit)/i.test(text)) {
    return (
      'A slide has too many buttons for a DVD menu. Move some buttons to another ' +
        'slide.'
    );
  }
  /*
    Several lines, not just the last one.

    dvdauthor reports a bad attribute as a small block: the error, then the list
    of attributes it would have accepted. Taking only the final line showed the
    last item of that list — the word "provider" — which says nothing at all
    about what went wrong.
  */
  const interesting = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^DVDAuthor::dvdauthor|^INFO:|^STAT:/i.test(l));

  const tail = interesting.slice(-4).join(' \u2014 ');
  return `Building the disc failed. ${tail || 'dvdauthor gave no reason.'}`;
}

module.exports = {
  buildDvdauthorXml,
  buildSpumuxXml,
  buildHighlightImageArgs,
  buildMenuStillArgs,
  runDvdauthor,
  distributeChapters,
  formatChapterTime,
  discLabel,
  xmlEscape,
  describeDvdauthorFailure,
};
