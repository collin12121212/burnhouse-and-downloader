'use strict';

/**
 * The disc, as a navigation graph.
 *
 * This is the one description of what the finished disc *does*: which pages
 * exist, which buttons are on them, where those buttons are, which button each
 * arrow key moves to, and what pressing Enter does.
 *
 * It exists so that the thing that gets burned and the thing the simulator
 * plays back are derived from the same source. Before this, the menu numbering,
 * the button rectangles and the jump commands were assembled inline while
 * building the disc, so nothing else could know what the disc would do without
 * re-deriving it — and any re-derivation is a chance to disagree.
 *
 * A menu page is a slide that carries at least one usable button. A title is a
 * video, numbered from 1 in the order the videos are given.
 */

const deckModel = require('./deck');
const slideLayout = require('./slide_layout');
const dvdNav = require('./dvd_nav');

/**
 * Resolve one button to the action pressing Enter performs.
 *
 * Returns null when the button leads nowhere, which the caller drops: a
 * highlight that does nothing is worse than no highlight, because the remote
 * appears to be broken.
 *
 * A button aimed at a slide that is showing a film plays that film directly,
 * rather than opening the slide as a page. Making somebody choose the video a
 * second time, on a page whose only purpose is that one video, is a wasted
 * press — and the disc can express the intent exactly, so there is no reason to
 * leave it to the viewer. A button aimed at a slide with no film on it still
 * opens the page, which is what a menu page is for.
 */
function actionFor(button, titleNumberById, menuNumberBySlideIndex, deck) {
  if (button.videoId && titleNumberById.has(button.videoId)) {
    return { type: 'title', number: titleNumberById.get(button.videoId) };
  }

  if (button.targetSlideId) {
    const targetSlideIndex = deckModel.slideIndexById(deck, button.targetSlideId);
    const targetSlide = deck.slides[targetSlideIndex];

    // The first film on the target slide is the one this button means.
    const onSlide = targetSlide
      ? (targetSlide.elements || []).find((e) => e.kind === 'video' && e.videoId)
      : null;
    if (onSlide && titleNumberById.has(onSlide.videoId)) {
      return { type: 'title', number: titleNumberById.get(onSlide.videoId) };
    }

    const page = menuNumberBySlideIndex.get(targetSlideIndex);
    if (page) return { type: 'menu', number: page };
  }

  return null;
}

/** The dvdauthor command string for an action. */
function commandFor(action) {
  if (!action) return '';
  if (action.type === 'title') return `jump title ${action.number};`;
  if (action.type === 'menu') return `jump menu ${action.number};`;
  if (action.type === 'cell') return 'jump cell 1;';
  return '';
}

/**
 * The sound a menu page plays, or null for a silent page.
 *
 * Resolved here rather than at each consumer so the burn, the preview and the
 * editor all quote the same length — including the trim, which is applied once
 * and then never recomputed. A page whose sound has no usable length is treated
 * as silent rather than turned into a zero-length motion menu.
 */
function soundFor(slide) {
  const audio = slide && slide.audio;
  if (!audio || !audio.path) return null;

  const seconds = Number(audio.seconds) > 0 ? Number(audio.seconds) : Number(audio.duration);
  if (!(seconds > 0)) return null;

  return {
    path: audio.path,
    fileName: audio.fileName || '',
    seconds: Math.round(seconds * 100) / 100,
  };
}

/**
 * Build the disc's navigation graph.
 *
 * @param {object} options
 * @param {object} options.deck     the slide deck
 * @param {Array}  options.videos   `[{ id, name, duration }]`, in disc title order
 * @param {string} [options.aspect] `'16:9'` or `'4:3'`
 * @returns {{ aspect, menus, titles, titleNumberById }}
 */
function buildDiscModel({ deck, videos, aspect = '16:9' }) {
  const normalised = deckModel.normaliseDeck(deck || {});
  const layout = slideLayout.layoutDeck(normalised);

  const titleNumberById = new Map();
  (videos || []).forEach((video, index) => titleNumberById.set(video.id, index + 1));

  /*
    Which slides are menu pages, and what number each one gets.

    A slide is a page when something on it can be pressed, *or* when a button
    somewhere points at it. Either is enough, and the second half is not an
    afterthought: a page of words, or a page carrying one photograph, has nothing
    to press on it. Dropping such a page took the button pointing at it with it,
    and then the page that button was on — so a deck whose only link was
    "picture goes to a page of words" produced a disc with no menus at all, and
    the picture silently did nothing when it was pressed.

    Destinations are collected here, before any numbering, from the authored
    buttons rather than from their resolved commands. A button aimed at a page
    that is not yet a page has no command yet, so waiting for the command would
    mean the destination never became one.

    Numbering still has to settle after the buttons resolve. If a slide whose
    every button leads nowhere were given a number, every page after it would be
    off by one — so a button saying "jump menu 2" would arrive at the third page.
    That is a silent, disc-wide navigation bug, and it is why this runs as a
    short loop. Two passes settle it for any deck that can actually be built, and
    the cap stops a pathological one from spinning.
  */
  const slideIndexById = new Map();
  layout.slides.forEach((entry, index) => slideIndexById.set(entry.slide.id, index));

  const pointedAt = new Set();
  for (const entry of layout.slides) {
    for (const element of entry.elements) {
      // A button that names a film plays that film; it does not open a page, so
      // it says nothing about whether its destination has to exist as one.
      if (!element.targetSlideId || element.videoId) continue;
      const at = slideIndexById.get(element.targetSlideId);
      if (at !== undefined) pointedAt.add(at);
    }
  }

  const candidateIndexes = [];
  layout.slides.forEach((entry, index) => {
    if (entry.buttons.length || pointedAt.has(index)) candidateIndexes.push(index);
  });

  let menuNumberBySlideIndex = new Map();
  let menus = [];

  for (let pass = 0; pass < 4; pass += 1) {
    const numbering = new Map();
    candidateIndexes.forEach((slideIndex, position) => {
      numbering.set(slideIndex, position + 1);
    });

    const built = [];
    for (const slideIndex of candidateIndexes) {
      const entry = layout.slides[slideIndex];

      const buttons = [];
      for (const authored of slideLayout.buttonsForAuthoring(entry)) {
        const action = actionFor(authored, titleNumberById, numbering, normalised);
        if (!action) continue;
        buttons.push({
          name: authored.name,
          label: authored.label,
          videoId: authored.videoId || null,
          targetSlideId: authored.targetSlideId || null,
          x0: authored.x0,
          y0: authored.y0,
          x1: authored.x1,
          y1: authored.y1,
          action,
          command: commandFor(action),
        });
      }

      /*
        Built even with no buttons on it.

        A page pointed at by a button is a page whether or not anything on it can
        be pressed: it is somewhere the viewer is sent, and the only way off it is
        the remote's Menu key, which returns to the disc root. Leaving it out here
        is what made the pointer dangle.
      */
      built.push({
        page: numbering.get(slideIndex),
        slideIndex,
        slideId: entry.slide.id,
        title: entry.slide.title,
        buttons,
        navigation: dvdNav.navigationObject(buttons),
        // The page's sound, if the slide has one. Carried on the page because
        // that is what it belongs to on a disc.
        sound: soundFor(entry.slide),
      });
    }

    /*
      Renumber in slide order, and resolve again with the settled numbers. The
      numbering a pass used is the one it was built with, so a command written
      during it can be one page out until the next pass agrees.
    */
    const settled = new Map();
    built.forEach((page, index) => settled.set(page.slideIndex, index + 1));

    const sameNumbering =
      settled.size === numbering.size &&
      [...settled].every(([slideIndex, page]) => numbering.get(slideIndex) === page);

    const sameButtons =
      built.length === menus.length &&
      built.every((page, index) => {
        const before = menus[index];
        return (
          before &&
          before.slideId === page.slideId &&
          before.buttons.length === page.buttons.length &&
          before.buttons.every((b, i) => b.command === page.buttons[i].command)
        );
      });

    menus = built.map((page, index) => ({ ...page, page: index + 1 }));
    menuNumberBySlideIndex = settled;

    if (sameNumbering && sameButtons) break;
  }

  const titles = (videos || []).map((video, index) => ({
    number: index + 1,
    videoId: video.id,
    name: video.menuLabel || video.name || `Title ${index + 1}`,
    duration: video.duration || 0,
  }));

  /*
    The order the films play in.
    
    It follows the order of the *slides*, not the order the videos were added,
    because the slides are the thing she arranges and the thing the disc
    presents. That is what makes watching episodes back to back work: when one
    film ends, the disc moves on to whichever film is on the next slide along.
  */
  const playOrder = [];
  const remember = (videoId) => {
    if (videoId && titleNumberById.has(videoId) && !playOrder.includes(videoId)) {
      playOrder.push(videoId);
    }
  };

  for (const slide of normalised.slides) {
    for (const element of slide.elements) {
      if (element.kind === 'video') remember(element.videoId);
    }
  }
  // A film nobody put on a slide still has to be reachable, so it goes on the
  // end rather than being left with nowhere to play from.
  for (const video of videos || []) remember(video.id);

  const nextTitleByNumber = {};
  playOrder.forEach((videoId, index) => {
    const number = titleNumberById.get(videoId);
    const nextId = playOrder[index + 1];
    // The last film has nowhere to go, so the disc falls back to the menu.
    nextTitleByNumber[number] = nextId ? titleNumberById.get(nextId) : null;
  });

  /*
    The page the disc opens on, and the one the remote's Menu key returns to.

    It has to be a page with something on it. It used to be simply the first page
    in slide order, which is wrong now that a page can be empty: a deck whose
    first page holds only words put the viewer there on insert, with nothing to
    press and a Menu key that returned them to the same dead end. So the root is
    the first page that has at least one button, falling back to the first page of
    all — and if that too has nothing on it the disc cannot be saved by pressing
    anything, which the burn stage says rather than shipping.

    Page *numbers* are untouched by this. They stay in slide order, because that
    is what the already-written commands say; only which page is the entry point
    moves.
  */
  const firstPressable = menus.find((page) => page.buttons.length > 0);
  const rootMenuNumber = firstPressable ? firstPressable.page : menus.length ? menus[0].page : null;

  return {
    aspect,
    // The normalised deck this was built from, so a caller does not have to
    // normalise it a second time and risk working from a different one.
    deck: normalised,
    // The disc starts on the root menu page, and that page is also where the
    // remote's Menu key returns to (entry="root" in the dvdauthor file).
    firstPlay: rootMenuNumber ? { type: 'menu', number: rootMenuNumber } : { type: 'title', number: 1 },
    menus,
    titles,
    nextTitleByNumber,
    playOrder: playOrder.map((videoId) => titleNumberById.get(videoId)),
    titleNumberById,
    layout,
  };
}

module.exports = {
  buildDiscModel,
  actionFor,
  commandFor,
  soundFor,
};
