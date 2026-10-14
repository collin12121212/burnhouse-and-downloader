'use strict';

/**
 * The deck: a list of slides, each holding elements.
 *
 * This is the shape of everything the user designs. It is deliberately shared
 * between the on-screen editor, the offscreen renderer that produces the menu
 * pictures, and the authoring step that turns them into DVD menu pages, so
 * there is exactly one definition of what a slide is.
 *
 * A DVD menu is a still picture with invisible button regions the player
 * composites a highlight into. That maps exactly onto this model: a slide is a
 * picture, and a `button` element is a region. So "make a menu slide listing
 * the episodes" is not a special feature — it is what the model already does.
 */

const { THEMES, DEFAULT_THEME_ID } = require('./themes');
/*
  The raster and the safe margin come from safe_area.js, which is also the one
  place that decides where an element may sit. They used to be defined here and
  again in the editor, which is how the two came to disagree about an element
  larger than the area it was being kept inside.

  Re-exported below, so everything that already reads them from this module
  keeps working.
*/
const { RASTER, SAFE_MARGIN } = require('./safe_area');

/**
 * The DVD-Video specification caps a menu at 36 buttons, but a menu with 36
 * entries is unreadable on a television. Eighteen is the practical ceiling: it
 * still fills a screen at a legible size, and it fails visibly here rather than
 * on a player.
 */
const MAX_BUTTONS_PER_SLIDE = 18;

const FONTS = [
  { id: 'title', label: 'Heading', stack: '"Helvetica Neue", Helvetica, Arial, sans-serif', weight: 600 },
  { id: 'plain', label: 'Plain', stack: '"Helvetica Neue", Helvetica, Arial, sans-serif', weight: 400 },
  { id: 'serif', label: 'Serif', stack: 'Georgia, "Times New Roman", serif', weight: 400 },
  { id: 'condensed', label: 'Narrow', stack: '"Helvetica Neue", "Arial Narrow", Arial, sans-serif', weight: 500 },
  { id: 'typewriter', label: 'Typed', stack: '"Courier New", Courier, monospace', weight: 400 },
];

const TEXT_SIZES = [
  { id: 'small', label: 'S', px: 16 },
  { id: 'medium', label: 'M', px: 22 },
  { id: 'large', label: 'L', px: 30 },
  { id: 'huge', label: 'XL', px: 42 },
];

const BACKGROUNDS = ['background', 'panel', 'accent', 'text'];
const ALIGNMENTS = ['left', 'center', 'right'];

const ELEMENT_KINDS = ['text', 'button', 'image', 'frame', 'video'];

/**
 * The range a typed text size is allowed to take.
 *
 * Bounded because this ends up as pixels on a 720x480 menu: below about eight
 * pixels nothing is legible on a television, and above about a hundred the
 * words no longer fit in the safe area whatever the user does.
 */
const TEXT_SIZE_MIN = 8;
const TEXT_SIZE_MAX = 120;

function getFont(id) {
  return FONTS.find((f) => f.id === id) || FONTS[1];
}

function getTheme(id) {
  return THEMES[id] || THEMES[DEFAULT_THEME_ID];
}

function textSizePx(id) {
  return (TEXT_SIZES.find((t) => t.id === id) || TEXT_SIZES[1]).px;
}

/** A size the user typed, clamped, or null to fall back to a named size. */
function pixelSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(TEXT_SIZE_MIN, Math.min(TEXT_SIZE_MAX, Math.round(n)));
}

/** How see-through a background is: 0 fully visible, 1 invisible. */
function transparency(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * How much a background picture is darkened: 0 untouched, 1 the full wash.
 *
 * Anything unreadable, including the absence of a value on every deck saved
 * before this existed, gives 1 — the darkness every existing slide already has,
 * so opening an old project changes nothing about how it looks.
 */
function dim(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

/** The size in pixels to draw an element at: a typed number wins. */
function fontSizeFor(element) {
  const typed = pixelSize(element && element.textPx);
  if (typed !== null) return typed;
  return textSizePx(element && element.fontSize);
}

/**
 * A stable, short identifier.
 *
 * Randomised rather than sequential so two slides made in different sessions
 * cannot collide, and short because it ends up inside button command strings.
 */
function makeId(prefix = 'el') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Normalising must never change an identifier.
 *
 * Everything that refers to a slide or an element — a button's target, the
 * selection in the editor, the mapping between the layout and the pictures
 * being burned — refers to it by id. Regenerating ids while normalising would
 * silently break all of those links: the layout would come back describing
 * slides the editor has never heard of, and the preview would draw nothing.
 */
function keepId(value, prefix) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text || makeId(prefix);
}

/** A finite number, or the fallback. Guards against undefined from old decks. */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Element factories
// ---------------------------------------------------------------------------

function makeTextElement(patch = {}) {
  return {
    id: keepId(patch.id, 'text'),
    kind: 'text',
    text: patch.text !== undefined ? String(patch.text) : 'Your words here',
    x: num(patch.x, 48),
    y: num(patch.y, 60),
    width: num(patch.width, 624),
    fontSize: patch.fontSize || 'large',
    // A size typed straight in. When set it wins over the named size, so the
    // named sizes stay as quick starting points rather than a cage.
    textPx: pixelSize(patch.textPx),
    fontId: patch.fontId || 'title',
    color: patch.color || 'text',
    align: ALIGNMENTS.includes(patch.align) ? patch.align : 'left',
    // The box behind the words. Unlike a button's, this one is invisible unless
    // asked for — but when it is asked for it fills the element's own box, so a
    // label can carry a panel just as a button does.
    background: BACKGROUNDS.includes(patch.background) ? patch.background : 'none',
    backgroundTransparency: transparency(patch.backgroundTransparency),
    autoHeight: patch.autoHeight !== false,
    height: num(patch.height, 60),
  };
}

/**
 * A button is the only thing on a slide that is interactive. It either plays a
 * video or moves to another slide.
 *
 * Two labels, on purpose: the slide shows `label`, and the same text is what a
 * player's on-screen display will call it. Keeping one label means there is
 * nothing to keep in sync.
 */
function makeButtonElement(patch = {}) {
  return {
    id: keepId(patch.id, 'btn'),
    kind: 'button',
    label: patch.label !== undefined ? String(patch.label) : 'New button',
    // Exactly one of these is set.
    videoId: patch.videoId || null,
    targetSlideId: patch.targetSlideId || null,
    x: num(patch.x, 48),
    y: num(patch.y, 120),
    width: num(patch.width, 624),
    height: num(patch.height, 56),
    fontSize: patch.fontSize || 'medium',
    textPx: pixelSize(patch.textPx),
    fontId: patch.fontId || 'plain',
    color: patch.color || 'text',
    align: ALIGNMENTS.includes(patch.align) ? patch.align : 'left',
    buttonStyle: patch.buttonStyle || 'bar',
    backgroundTransparency: transparency(patch.backgroundTransparency),
    showNumber: patch.showNumber === true,
    number: num(patch.number, 0),
    sublabel: patch.sublabel !== undefined ? String(patch.sublabel) : '',
  };
}

function makeImageElement(patch = {}) {
  return {
    id: keepId(patch.id, 'img'),
    kind: 'image',
    // A data URL, so the editor, the offscreen renderer and any saved deck all
    // see the same picture without a file path that might not resolve.
    src: patch.src || null,
    fileName: patch.fileName || '',
    x: num(patch.x, 400),
    y: num(patch.y, 60),
    width: num(patch.width, 272),
    height: num(patch.height, 200),
    fit: patch.fit === 'fill' ? 'fill' : 'fit',
    /*
      A picture can be pressed, exactly as a button can.

      `targetSlideId` is the slide it goes to, and it plays the film on that
      slide if there is one — the same rule a button follows, resolved in the
      same place, so a picture and a button aimed at the same slide do the same
      thing. `None` is the default: with no destination the picture is just a
      picture, and it is not given a highlight the remote can land on.
    */
    videoId: patch.videoId || null,
    targetSlideId: patch.targetSlideId || null,
  };
}

function makeFrameElement(patch = {}) {
  return {
    id: keepId(patch.id, 'frame'),
    kind: 'frame',
    x: num(patch.x, 48),
    y: num(patch.y, 100),
    width: num(patch.width, 624),
    height: num(patch.height, 260),
    fill: BACKGROUNDS.includes(patch.fill) ? patch.fill : 'panel',
    outline: patch.outline !== false,
  };
}

/**
 * A video tile: a picture of the video, on the slide, which plays it.
 *
 * This is what "put a video on a slide" means. It shows a frame from the video
 * with its name and length, so the menu looks like the video rather than like a
 * button that mentions it — and because a DVD menu is a still picture with
 * button regions, a tile is also the thing the remote highlights and chooses.
 *
 * `src` carries a frame extracted from the video as a data URL, so the picture
 * travels with the deck and needs no file to be reachable at render time. When
 * it is missing the tile still draws, with its name and a play mark, because a
 * missing frame must never mean a missing menu entry.
 */
function makeVideoElement(patch = {}) {
  const width = num(patch.width, 300);
  const height = num(patch.height, 190);
  return {
    id: keepId(patch.id, 'video'),
    kind: 'video',
    videoId: patch.videoId || null,
    label: patch.label !== undefined ? String(patch.label) : 'Video',
    sublabel: patch.sublabel !== undefined ? String(patch.sublabel) : '',
    src: patch.src || null,
    x: num(patch.x, 60),
    y: num(patch.y, 120),
    width,
    height,
    // `fit` shows the whole frame with bars; `fill` crops to fill the tile.
    fit: patch.fit === 'fill' ? 'fill' : 'fit',
    fontSize: patch.fontSize || 'medium',
    textPx: pixelSize(patch.textPx),
    fontId: patch.fontId || 'plain',
    color: patch.color || 'text',
    showLabel: patch.showLabel !== false,
    // The frame extraction failed, so this tile shows a placeholder. Recorded
    // rather than inferred, so the editor can offer to try again.
    posterMissing: Boolean(patch.posterMissing),
  };
}

function makeElement(kind, patch = {}) {
  if (kind === 'text') return makeTextElement(patch);
  if (kind === 'button') return makeButtonElement(patch);
  if (kind === 'image') return makeImageElement(patch);
  if (kind === 'frame') return makeFrameElement(patch);
  if (kind === 'video') return makeVideoElement(patch);
  throw new Error(`Unknown element kind "${kind}".`);
}

function normaliseElement(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = ELEMENT_KINDS.includes(raw.kind) ? raw.kind : null;
  if (!kind) return null;
  const element = makeElement(kind, raw);
  // Preserve authored properties the factory would not know about.
  for (const key of ['locked', 'autoPositioned', 'source', 'labelEdited']) {
    if (raw[key] !== undefined) element[key] = raw[key];
  }

  /*
    Stacking order and corner rounding, applied to every kind here rather than
    repeated in five factories.

    Priority reads the way she asked for it: a *lower* number sits in front, so a
    button set to 1 covers one set to 2. Zero is the default, so anything never
    touched keeps the plain kind-based order it always had.

    Roundness is in raster pixels and is clamped to a sane range; the drawing
    code clamps it again to half the box, because a radius bigger than that has
    no meaning.
  */
  element.priority = Math.round(num(raw.priority, 0));
  element.roundness = Math.max(0, Math.min(200, Math.round(num(raw.roundness, 0))));

  return element;
}

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

/**
 * How long a menu page's sound is allowed to run, in seconds.
 *
 * A DVD menu holds one still frame, and the sound is what gives the page its
 * length. Ninety seconds is far more than any menu needs, and it bounds what one
 * page can cost on the disc: at the bitrates used for a held still that is a few
 * megabytes, which cannot push a full disc over its edge. A longer file is
 * trimmed rather than refused, because a song is still the obvious thing to
 * choose and stopping at ninety seconds is not a surprise worth an error over.
 */
const MENU_SOUND_MAX_SECONDS = 90;

/**
 * The sound on a slide, or null.
 *
 * Held as a path rather than a data URL, unlike a background picture: a song is
 * megabytes, and a data URL would put the whole track inside the project file
 * and inside every save. The build reads the file directly, and the editor and
 * the preview ask the main process for a playable URL.
 *
 * It belongs to the slide rather than to an element on it because that is what
 * the format can do — a DVD menu page has exactly one sound track. An element
 * would imply several per page, or a position on the picture, and neither means
 * anything on a disc.
 */
function normaliseSlideAudio(raw) {
  const path = raw && typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!path) return null;

  const duration = Math.max(0, num(raw.duration, 0));
  const wanted = num(raw.seconds, 0);
  const seconds = wanted > 0
    ? Math.min(MENU_SOUND_MAX_SECONDS, wanted)
    : duration > 0
      ? Math.min(MENU_SOUND_MAX_SECONDS, duration)
      : MENU_SOUND_MAX_SECONDS;

  return {
    path,
    fileName: raw.fileName ? String(raw.fileName) : '',
    // How long the file is, as read from it. Zero means it could not be measured.
    duration,
    // How much of it the disc will actually play.
    seconds: Math.round(seconds * 100) / 100,
  };
}

function makeSlide(patch = {}) {
  return {
    id: keepId(patch.id, 'slide'),
    title: patch.title !== undefined ? String(patch.title) : 'New slide',
    themeId: patch.themeId || DEFAULT_THEME_ID,
    backgroundId: null,
    /*
      A picture behind the whole slide.

      Kept as a data URL rather than a path because the window that draws the
      disc has no filesystem access, and the editor keeps it in the saved
      project so reopening a project still shows the picture. It is downscaled
      when chosen, so a project file does not carry a twelve megapixel
      photograph around.
    */
    backgroundImage:
      typeof patch.backgroundImage === 'string' && patch.backgroundImage
        ? patch.backgroundImage
        : null,
    // `cover` fills the frame and crops whatever spills over, which is what a
    // background picture almost always wants. `contain` shows all of it.
    backgroundFit: patch.backgroundFit === 'contain' ? 'contain' : 'cover',
    /*
      How much the background picture is darkened so words stay readable.

      1 is the wash this has always applied and is the default; 0 leaves the
      photograph exactly as it is. A picture that is already dark, or one that is
      meant to be looked at rather than read over, needs less of it — and only
      she can see which she has.
    */
    backgroundDim: dim(patch.backgroundDim),
    // A sound to play while this page is on screen, or null for a silent page.
    audio: normaliseSlideAudio(patch.audio),
    /*
      `menu` marks the page the disc opens on, and the one a player's Menu key
      returns to; `content` is every other page. It is a label for the editor,
      not a rule about what appears on the page — nothing is added to a slide for
      being one or the other.
    */
    role: patch.role === 'menu' ? 'menu' : 'content',
    elements: Array.isArray(patch.elements)
      ? patch.elements.map(normaliseElement).filter(Boolean)
      : [],
  };
}

function normaliseSlide(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return makeSlide(raw);
}

// ---------------------------------------------------------------------------
// The deck
// ---------------------------------------------------------------------------

function normaliseDeck(raw = {}) {
  const slides = Array.isArray(raw.slides) ? raw.slides.map(normaliseSlide).filter(Boolean) : [];
  return {
    discTitle: String(raw.discTitle || 'My DVD').slice(0, 60),
    themeId: THEMES[raw.themeId] ? raw.themeId : DEFAULT_THEME_ID,
    buttonStyle: raw.buttonStyle || 'bar',
    slides,
  };
}

function slideIndexById(deck, id) {
  return deck.slides.findIndex((s) => s.id === id);
}

function findElement(deck, elementId) {
  for (const slide of deck.slides) {
    const element = slide.elements.find((e) => e.id === elementId);
    if (element) return { slide, element };
  }
  return { slide: null, element: null };
}

function findSlideOfElement(deck, elementId) {
  return deck.slides.find((s) => s.elements.some((e) => e.id === elementId)) || null;
}

// ---------------------------------------------------------------------------
// Button commands
//
// These are the DVD virtual machine instructions a player executes when a
// button is chosen. They are strings because that is what dvdauthor consumes.
// ---------------------------------------------------------------------------

function commandForButton(element) {
  if (!element) return '';
  if (element.videoId) {
    return ''; // resolved to a title number by the authoring step
  }
  if (element.targetSlideId) {
    return ''; // resolved to a menu number by the authoring step
  }
  return '';
}

/** The command that plays title `n` (titles are numbered from 1). */
function playTitleCommand(n) {
  return `jump title ${n};`;
}

/** The command that shows menu `n` (menus are numbered from 1). */
function gotoMenuCommand(n) {
  return `jump menu ${n};`;
}

// ---------------------------------------------------------------------------
// Generated slides
// ---------------------------------------------------------------------------

/** How many buttons fit on a slide, given a two-column layout. */
const EPISODE_COLUMNS = 2;
const EPISODE_ROW_HEIGHT = 64;
const EPISODE_TOP = 132;
const EPISODE_COLUMN_WIDTH = 300;

/**
 * A menu slide listing every video as a button.
 *
 * This is the single most useful slide on a disc of several episodes, and it is
 * also what a disc falls back to when nothing has been designed. Generating it
 * in one place means the editor's "Add episode list" button and the automatic
 * default produce exactly the same thing.
 *
 * `startNumber` continues the numbering, so adding a second list to hold the
 * overflow picks up where the first left off.
 */
function episodeListSlide(videos, { title = 'Main menu', themeId, startNumber = 1 } = {}) {
  const slide = makeSlide({
    title,
    role: 'menu',
    themeId,
  });

  slide.elements = [
    makeTextElement({
      text: title,
      x: 40,
      y: 44,
      width: 640,
      fontSize: 'huge',
      fontId: 'title',
      background: 'none',
    }),
  ];

  const rows = episodeRows();
  const capacity = rows * EPISODE_COLUMNS;

  // Only as many buttons as actually fit. Overflowing the picture would put
  // buttons where a television cannot show them, so a long series gets further
  // slides rather than one impossible one — see `episodeListSlides`.
  videos.slice(0, capacity).forEach((video, index) => {
    const column = Math.floor(index / rows);
    const row = index % rows;
    slide.elements.push(
      makeButtonElement({
        label: video.menuLabel || stripExtension(video.name || `Video ${index + 1}`),
        sublabel: video.durationLabel || '',
        videoId: video.id,
        x: SAFE_MARGIN + column * (EPISODE_COLUMN_WIDTH + 24),
        y: EPISODE_TOP + row * EPISODE_ROW_HEIGHT,
        width: EPISODE_COLUMN_WIDTH,
        height: 54,
        fontSize: 'medium',
        showNumber: true,
        number: startNumber + index,
        // Marks this button as one the editor owns, so it can be regenerated
        // when the video list changes without disturbing buttons she added or
        // arranged herself.
        source: 'auto',
      })
    );
  });

  return slide;
}

/** How many episode rows fit down the picture. */
function episodeRows() {
  return Math.max(
    1,
    Math.floor((RASTER.height - SAFE_MARGIN - EPISODE_TOP) / EPISODE_ROW_HEIGHT)
  );
}

/** How many episode buttons fit on one slide. */
function episodeCapacity() {
  return episodeRows() * EPISODE_COLUMNS;
}

/**
 * As many menu slides as it takes to list every video.
 *
 * A series longer than one slide holds is normal, so this pages the list rather
 * than producing a menu with buttons off the bottom of the picture. Numbering
 * continues across pages, so the on-screen numbers still read 1, 2, 3, ...
 *
 * It only builds the pages. Nothing links them: the layout no longer adds a
 * Back/Next row to anything, so a disc built from these needs a button of its
 * own on each page pointing at the next one — and a full page has no room left
 * for one, which is why the page size is worth checking before relying on this.
 */
function episodeListSlides(videos, { title = 'Episodes', themeId, startNumber = 1 } = {}) {
  const capacity = episodeCapacity();
  const slides = [];

  for (let offset = 0; offset < videos.length; offset += capacity) {
    const chunk = videos.slice(offset, offset + capacity);
    const pageNumber = Math.floor(offset / capacity) + 1;
    const pageCount = Math.ceil(videos.length / capacity);
    slides.push(
      episodeListSlide(chunk, {
        title: pageCount > 1 ? `${title} (${pageNumber} of ${pageCount})` : title,
        themeId,
        startNumber: startNumber + offset,
      })
    );
  }

  if (!slides.length) slides.push(episodeListSlide([], { title, themeId }));
  return slides;
}

function stripExtension(name) {
  return String(name).replace(/\.[^.]+$/, '');
}

module.exports = {
  RASTER,
  SAFE_MARGIN,
  MENU_SOUND_MAX_SECONDS,
  MAX_BUTTONS_PER_SLIDE,
  THEMES,
  DEFAULT_THEME_ID,
  FONTS,
  TEXT_SIZES,
  TEXT_SIZE_MIN,
  TEXT_SIZE_MAX,
  textSizePx,
  pixelSize,
  transparency,
  fontSizeFor,
  BACKGROUNDS,
  ALIGNMENTS,
  ELEMENT_KINDS,
  getFont,
  getTheme,
  textSizePx,
  makeId,
  makeTextElement,
  makeButtonElement,
  makeImageElement,
  makeFrameElement,
  makeVideoElement,
  makeElement,
  normaliseElement,
  makeSlide,
  normaliseSlide,
  normaliseDeck,
  slideIndexById,
  findElement,
  findSlideOfElement,
  commandForButton,
  playTitleCommand,
  gotoMenuCommand,
  episodeListSlide,
  episodeListSlides,
  episodeRows,
  episodeCapacity,
  EPISODE_COLUMNS,
  EPISODE_ROW_HEIGHT,
  EPISODE_TOP,
  EPISODE_COLUMN_WIDTH,
};
