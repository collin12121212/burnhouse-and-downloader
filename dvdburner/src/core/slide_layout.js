'use strict';

/**
 * Slide layout.
 *
 * Turns a slide description into fully-resolved geometry: wrapped text lines,
 * measured boxes, and the button regions that the DVD authoring step needs.
 *
 * This module is pure arithmetic and has no dependency on canvas or Electron,
 * because it runs in three places: the editor's live preview, the offscreen
 * renderer that produces the picture burned to the disc, and the authoring step
 * that writes the button rectangles into the DVD structure. One implementation
 * means the highlight on a real player lines up with the label she sees while
 * designing, which is the thing most likely to be subtly wrong.
 *
 * Text is wrapped here rather than at draw time so that an element's box, the
 * picture, and the clickable area all come from the same measurement.
 */

const deckModel = require('./deck');

const { RASTER, SAFE_MARGIN, MAX_BUTTONS_PER_SLIDE, getTheme, getFont, fontSizeFor } = deckModel;
const safeArea = require('./safe_area');

/** Line spacing as a multiple of the font size. */
const LINE_HEIGHT = 1.32;
/** Padding inside a text element's own box. */
const TEXT_PADDING_X = 10;
const TEXT_PADDING_Y = 8;

/** How a button renders on the slide. */
const BUTTON_STYLES = [
  { id: 'bar', label: 'Filled bar' },
  { id: 'outline', label: 'Outline' },
  { id: 'underline', label: 'Underline' },
  { id: 'plain', label: 'Plain text' },
];

/**
 * A DVD raster is not square pixels.
 *
 * The menu is authored at 720x480 and a player stretches that to fill a
 * widescreen television — the frame is anamorphic. So a shape that should look
 * 16:9 on screen must be 3:2 in raster units, and a picture must be drawn
 * against a box measured the same way. Getting this wrong is invisible in the
 * editor and obvious on the television: a video tile ends up about 19% too
 * wide, and faces look stretched.
 *
 * These two helpers are the only place that conversion happens.
 */
const MENU_DISPLAY_ASPECT = 16 / 9;

/**
 * The name a slide's background picture travels under in the decoded-picture map.
 *
 * Reserved, because element ids are generated and will never be this.
 */
const BACKGROUND_IMAGE_KEY = '__background__';

/** How much wider the raster appears on screen than it is in pixels. */
function rasterStretch(displayAspect = MENU_DISPLAY_ASPECT) {
  const rasterAspect = RASTER.width / RASTER.height;
  return displayAspect / rasterAspect;
}

/** The raster aspect ratio that will *display* as `displayAspect`. */
function displayAspectToRaster(displayAspect, menuDisplayAspect = MENU_DISPLAY_ASPECT) {
  const stretch = rasterStretch(menuDisplayAspect);
  return stretch > 0 ? displayAspect / stretch : displayAspect;
}

/**
 * Measure a string without a canvas.
 *
 * Canvas measurement would be more exact, but it is only available in the
 * browser, and the authoring step runs in the main process without one. An
 * approximate advance width per character is close enough for wrapping and for
 * sizing a button, and — critically — it is the *same* approximation
 * everywhere, so the picture and the button agree.
 *
 * The per-character factor is tuned for Helvetica-like faces at normal weight:
 * average lowercase plus space. Wide fonts wrap slightly early, which is the
 * safe direction.
 */
const CHAR_WIDTH_FACTOR = 0.54;

function measureText(text, fontPx, fontId) {
  const font = getFont(fontId);
  // Monospace is exactly twice as predictable, and headings run slightly wide.
  let factor = CHAR_WIDTH_FACTOR;
  if (font.id === 'typewriter') factor = 0.60;
  else if (font.id === 'condensed') factor = 0.48;
  else if (font.id === 'title') factor = 0.56;
  else if (font.id === 'serif') factor = 0.53;
  return String(text || '').length * fontPx * factor;
}

/**
 * Break text into lines that fit `maxWidth`.
 *
 * Honours explicit newlines, then wraps on spaces. A single word too long for
 * the line is broken mid-word rather than allowed to overflow, because
 * overflowing a menu picture means the words are simply not on the disc.
 */
function wrapText(text, maxWidth, fontPx, fontId) {
  const value = String(text === undefined || text === null ? '' : text);
  const paragraphs = value.split('\n');
  const lines = [];

  for (const paragraph of paragraphs) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    if (!words.length) {
      lines.push('');
      continue;
    }

    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureText(candidate, fontPx, fontId) <= maxWidth || !current) {
        // A single word longer than the line is broken by character.
        if (!current && measureText(word, fontPx, fontId) > maxWidth) {
          const pieces = breakLongWord(word, maxWidth, fontPx, fontId);
          for (let i = 0; i < pieces.length - 1; i += 1) lines.push(pieces[i]);
          current = pieces[pieces.length - 1];
        } else {
          current = candidate;
        }
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }

  return lines.length ? lines : [''];
}

function breakLongWord(word, maxWidth, fontPx, fontId) {
  const pieces = [];
  let current = '';
  for (const character of word) {
    const candidate = current + character;
    if (measureText(candidate, fontPx, fontId) > maxWidth && current) {
      pieces.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** How tall a wrapped block is, in raster pixels. */
function textBlockHeight(lineCount, fontPx) {
  return Math.round(lineCount * fontPx * LINE_HEIGHT);
}

/**
 * Resolve one element's geometry into something the renderer can draw from
 * directly, with no further measurement.
 */
function resolveElement(element, theme) {
  if (element.kind === 'text') {
    const fontPx = fontSizeFor(element);
    const innerWidth = Math.max(20, element.width - TEXT_PADDING_X * 2);
    const lines = wrapText(element.text, innerWidth, fontPx, element.fontId);
    const blockHeight = textBlockHeight(lines.length, fontPx);
    const boxHeight = element.autoHeight === false
      ? Math.max(blockHeight + TEXT_PADDING_Y * 2, element.height)
      : blockHeight + TEXT_PADDING_Y * 2;

    return {
      ...element,
      fontPx,
      font: getFont(element.fontId),
      lines,
      lineHeight: Math.round(fontPx * LINE_HEIGHT),
      box: {
        x: element.x,
        y: element.y,
        width: element.width,
        height: boxHeight,
      },
      color: theme[element.color] || theme.text,
      background: element.background === 'none' ? null : theme[element.background] || null,
    };
  }

  if (element.kind === 'button') {
    const fontPx = fontSizeFor(element);
    const innerWidth = Math.max(20, element.width - 32);

    // The visible label is what a player highlights, so it must fit inside the
    // button. It is shrunk rather than wrapped: a two-line button on a
    // television is harder to read than a slightly smaller one-line button.
    let labelFontPx = fontPx;
    while (labelFontPx > 10 && measureText(element.label, labelFontPx, element.fontId) > innerWidth) {
      labelFontPx -= 1;
    }
    const labelText = element.label;

    return {
      ...element,
      fontPx: labelFontPx,
      font: getFont(element.fontId),
      labelText,
      color: theme[element.color] || theme.text,
      box: {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      },
    };
  }

  if (element.kind === 'image') {
    return {
      ...element,
      box: {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      },
    };
  }

  if (element.kind === 'video') {
    const fontPx = fontSizeFor(element);
    const innerWidth = Math.max(20, element.width - 32);

    let labelFontPx = fontPx;
    while (labelFontPx > 10 && measureText(element.label, labelFontPx, element.fontId) > innerWidth) {
      labelFontPx -= 1;
    }

    const box = {
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
    };

    // The play mark sits centered in the video frame
    const markSize = Math.max(24, Math.min(52, Math.round(Math.min(box.width, box.height) * 0.18)));
    const captionHeight = element.showLabel
      ? Math.max(30, Math.min(50, Math.round(box.height * 0.16)))
      : 0;

    return {
      ...element,
      fontPx: labelFontPx,
      fontFamily: getFont(element.fontId),
      color: theme[element.color] || theme.text,
      box,
      captionHeight,
      // The video picture fills the full box edge-to-edge with no black bars
      imageBox: {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      },
      mark: {
        size: markSize,
        x: box.x + Math.round((box.width - markSize) / 2),
        y: box.y + Math.round((box.height - (element.showLabel ? captionHeight / 2 : 0) - markSize) / 2),
      },
    };
  }

  // frame
  return {
    ...element,
    box: {
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
    },
    fillColor: theme[element.fill] || theme.panel,
  };
}

/**
 * Whether the remote can land on an element.
 *
 * A button always can. A video tile can, because pressing it plays the film. A
 * picture can only when it has been given somewhere to go: with no destination
 * it is a picture and nothing else, and putting a highlight on it would light up
 * something that does nothing when pressed — which reads as a broken remote.
 *
 * This is the one place that decides, so the picture on the disc and the
 * simulator that plays it back cannot disagree about which parts are clickable.
 */
function isSelectable(element) {
  if (!element) return false;
  if (element.kind === 'button' || element.kind === 'video') return true;
  if (element.kind === 'image') return Boolean(element.targetSlideId || element.videoId);
  return false;
}

/**
 * Resolve a whole slide.
 *
 * Returns the resolved elements, the buttons that must exist on this menu page
 * in the DVD structure, and any problems the user should be told about.
 *
 * There is deliberately no automatic navigation row. A `‹ Menu` and `Next ›`
 * pair used to be added to every slide that was not a menu hub, which meant
 * every page she designed had two buttons on it she had not asked for, sitting
 * over her own design in the bottom corners — and they could not be moved or
 * deleted, because they were generated rather than saved. A page wants what she
 * puts on it, so now it gets exactly that: buttons are hers to place, and the
 * remote's own Menu key still returns to the disc's root menu on a real player.
 */
function layoutSlide(deck, slide) {
  const theme = getTheme(slide.themeId || deck.themeId);
  const all = slide.elements.map((element) => resolveElement(element, theme));

  // A video tile plays something, and a picture that has been given a
  // destination goes somewhere, so both need a button region just as a button
  // does. Everything downstream then treats them exactly alike, which is what
  // makes the remote able to choose them.
  const buttonElements = all.filter(isSelectable);

  const problems = [];
  if (buttonElements.length > MAX_BUTTONS_PER_SLIDE) {
    problems.push(
      `"${slide.title}" has ${buttonElements.length} buttons. A DVD menu can hold ` +
        `${MAX_BUTTONS_PER_SLIDE} comfortably \u2014 move some to another slide.`
    );
  }

  return {
    slide,
    theme,
    width: RASTER.width,
    height: RASTER.height,
    // How much wider this raster appears on a television than it is in pixels.
    // The drawing code needs it to place square-pixel pictures correctly.
    stretch: rasterStretch(deck.displayAspect || MENU_DISPLAY_ASPECT),
    /*
      A picture behind everything, if she chose one.

      `key` is the name it travels under in the decoded-picture map. It rides on
      the layout so the editor, the off-screen renderer and the drawing code all
      agree on it without a constant duplicated in three files.
    */
    background: {
      src:
        slide.backgroundImage && typeof slide.backgroundImage === 'string'
          ? slide.backgroundImage
          : null,
      fit: slide.backgroundFit === 'contain' ? 'contain' : 'cover',
      // How much the picture is darkened so words stay readable over it. Travels
      // with the rest of the background so the editor, the off-screen renderer
      // and the burned menu all apply the same amount.
      dim: Number.isFinite(Number(slide.backgroundDim)) ? Math.max(0, Math.min(1, Number(slide.backgroundDim))) : 1,
    },
    backgroundKey: BACKGROUND_IMAGE_KEY,
    elements: all,
    buttons: buttonElements,
    problems,
  };
}

/**
 * Build the button rectangles the DVD structure needs.
 *
 * Coordinates come from the same resolved boxes the picture is drawn from, so
 * the highlight cannot drift away from the label. They are rounded to even
 * numbers because a DVD subpicture is addressed in two-pixel units, and an odd
 * value shifts the highlight half a pixel out of alignment.
 */
function buttonsForAuthoring(layout) {
  return layout.buttons.map((element, index) => ({
    id: element.id,
    index,
    // dvdauthor matches spumux rectangles to commands by button name, in order,
    // within a single menu page, so a simple positional name is correct and
    // unambiguous.
    name: `btn${index + 1}`,
    // Buttons resolve their label to `labelText`; video tiles keep theirs in
    // `label`. Both end up as the same thing here.
    label: element.labelText || element.label || '',
    videoId: element.videoId || null,
    targetSlideId: element.targetSlideId || null,
    x0: even(element.box.x),
    y0: even(element.box.y),
    x1: even(element.box.x + element.box.width),
    y1: even(element.box.y + element.box.height),
  }));
}

function even(n) {
  const value = Math.max(0, Math.round(Number(n) || 0));
  return value % 2 === 0 ? value : value + 1;
}

/**
 * Apply safe-area limits to every element of every slide.
 *
 * Runs over the whole deck, so there is a single invariant: whatever is in the
 * deck is placeable on a television. That keeps the guard honest no matter which
 * interaction produced the change — a drag, a resize, a template, or a deck
 * loaded from settings.
 */
function clampDeck(deck) {
  const width = RASTER.width;
  const height = RASTER.height;
  return {
    ...deck,
    slides: deck.slides.map((slide) => ({
      ...slide,
      elements: slide.elements.map((element) => {
        const clamped = safeArea.clampElement(
          { ...element, x: (element.box || element).x, y: (element.box || element).y },
          width,
          height
        );
        const placed = { ...element, x: clamped.x, y: clamped.y, width: clamped.width, height: clamped.height };
        // Text and buttons grow to fit their content, so their stored height is
        // a floor rather than a fixed size.
        if (element.kind === 'text' && element.autoHeight !== false) {
          return { ...placed, height: element.height };
        }
        return placed;
      }),
    })),
  };
}

/**
 * The whole deck, laid out.
 *
 * The problems are per slide. There used to be a deck-wide check here for a
 * button pointing at a slide with nothing to press on it, warning that it would
 * not be a page — which was true, and was the bug: the pointer was dropped, and
 * took its own page with it. A page a button points at is now a page whatever is
 * on it, so there is nothing left to warn about. The way off such a page is the
 * remote's own Menu key, and a button on it if she wants one.
 */
function layoutDeck(deck) {
  const slides = deck.slides.map((slide) => layoutSlide(deck, slide));
  const problems = slides.flatMap((layout) => layout.problems);
  return { deck, slides, problems };
}

module.exports = {
  BUTTON_STYLES,
  MENU_DISPLAY_ASPECT,
  LINE_HEIGHT,
  TEXT_PADDING_X,
  TEXT_PADDING_Y,
  CHAR_WIDTH_FACTOR,
  measureText,
  wrapText,
  textBlockHeight,
  resolveElement,
  isSelectable,
  layoutSlide,
  layoutDeck,
  buttonsForAuthoring,
  // The shared rule, re-exported so anything that reached for it here keeps
  // working and keeps getting the same answer as the editor.
  clampElement: safeArea.clampElement,
  clampDeck,
  rasterStretch,
  displayAspectToRaster,
  even,
};
