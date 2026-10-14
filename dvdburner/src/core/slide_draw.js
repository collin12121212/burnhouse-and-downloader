/**
 * Slide drawing.
 *
 * Like the layout module, this is environment-agnostic on purpose: it runs
 * unchanged in the editor's live preview and in the offscreen renderer that
 * produces the picture actually burned to the disc. One implementation means
 * the preview cannot lie about what will be on the disc.
 *
 * Everything is drawn from a resolved layout, so this file contains no
 * measurement or positioning arithmetic of its own — if something is in the
 * wrong place, the fault is in slide_layout.js, and there is only one place to
 * fix it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BurnhouseSlideDraw = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function parseHex(hex) {
    const h = String(hex || '#000000').replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const num = parseInt(full, 16);
    if (!Number.isFinite(num)) return [0, 0, 0];
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }

  function hexToRgba(hex, alpha) {
    const [r, g, b] = parseHex(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha === undefined ? 1 : alpha})`;
  }

  function mix(a, b, amount) {
    const pa = parseHex(a);
    const pb = parseHex(b);
    const t = Math.max(0, Math.min(1, amount));
    return `rgb(${Math.round(pa[0] + (pb[0] - pa[0]) * t)}, ${Math.round(
      pa[1] + (pb[1] - pa[1]) * t
    )}, ${Math.round(pa[2] + (pb[2] - pa[2]) * t)})`;
  }

  function isLight(hex) {
    const [r, g, b] = parseHex(hex);
    // Rec. 601 luma, which is what determines perceived brightness on video.
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
  }

  /**
   * Draw text with optional letter spacing.
   *
   * The Chromium that Electron 31 ships has no canvas letter-spacing, so spaced
   * type is drawn one glyph at a time.
   */
  function drawText(ctx, text, x, y, opts) {
    const o = opts || {};
    const font = o.font || 'sans-serif';
    const size = o.size || 16;
    const weight = o.weight || '400';
    const color = o.color || '#ffffff';
    const align = o.align || 'left';
    const tracking = o.tracking || 0;
    const baseline = o.baseline || 'alphabetic';

    ctx.save();
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.fillStyle = color;
    ctx.textBaseline = baseline;

    const value = String(text === undefined || text === null ? '' : text);

    if (!tracking) {
      ctx.textAlign = align;
      ctx.fillText(value, x, y);
      ctx.restore();
      return;
    }

    const chars = value.split('');
    const widths = chars.map((c) => ctx.measureText(c).width);
    const total = widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, chars.length - 1);

    let cursor = x;
    if (align === 'center') cursor = x - total / 2;
    else if (align === 'right') cursor = x - total;

    ctx.textAlign = 'left';
    for (let i = 0; i < chars.length; i += 1) {
      ctx.fillText(chars[i], cursor, y);
      cursor += widths[i] + tracking;
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Background
  // -------------------------------------------------------------------------

  /**
   * The slide background.
   *
   * A flat ground with a soft vignette so the centre reads as lit. There is
   * deliberately no noise or grain: per-pixel texture is the worst possible
   * input to an MPEG-2 encoder, consuming bitrate that should go to the
   * picture and shimmering around text on a real television. A smooth gradient
   * costs almost nothing and looks the same from a sofa.
   */
  function drawBackground(ctx, layout, images) {
    const theme = layout.theme;
    const width = layout.width;
    const height = layout.height;
    const light = isLight(theme.background);

    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, width, height);

    const picture = images && layout.backgroundKey ? images[layout.backgroundKey] : null;

    if (picture) {
      const iw = picture.naturalWidth || picture.width || 1;
      // The raster is stretched to 16:9 on a television, so the picture has to
      // be measured in that same stretched space. Without it a widescreen
      // photograph would leave bars down the sides of a frame it should fill.
      const ih = (picture.naturalHeight || picture.height || 1) * (layout.stretch || 1);
      const fit = layout.background && layout.background.fit;
      const scale = fit === 'contain'
        ? Math.min(width / iw, height / ih)
        : Math.max(width / iw, height / ih);
      const dw = iw * scale;
      const dh = ih * scale;

      ctx.drawImage(picture, (width - dw) / 2, (height - dh) / 2, dw, dh);

      /*
        Wash the photograph toward the theme's own background colour.

        A picture chosen for its subject is rarely chosen for its contrast, and
        white menu text over a bright sky is unreadable from a sofa. Washing it
        with the theme's colour keeps whichever theme she picked in charge of how
        the words look.

        How much is up to her, and 1 — the default — is the wash this has always
        applied. At 0 the photograph is left exactly as it is, which is the right
        answer for a picture that is already dark, or for a background that is
        meant to be looked at rather than read over.
      */
      const dim = layout.background && Number.isFinite(layout.background.dim)
        ? Math.max(0, Math.min(1, layout.background.dim))
        : 1;

      if (dim > 0) {
        ctx.save();
        ctx.globalAlpha = 0.42 * dim;
        ctx.fillStyle = theme.background;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
      }
    }

    // A plain background means no glow and no vignette: "none" is the theme
    // where the decoration is deliberately absent.
    if (theme.plain) return;

    const vignette = ctx.createRadialGradient(
      width / 2, height / 2, Math.min(width, height) * 0.18,
      width / 2, height / 2, Math.max(width, height) * 0.8
    );
    vignette.addColorStop(0, light ? 'rgba(255,255,255,0.30)' : 'rgba(255,255,255,0.04)');
    vignette.addColorStop(1, light ? 'rgba(60,50,35,0.11)' : 'rgba(0,0,0,0.30)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
  }

  // -------------------------------------------------------------------------
  // Elements
  // -------------------------------------------------------------------------

  /**
   * Trace a rectangle with rounded corners.
   *
   * Returns the radius actually used, so a caller can tell whether to bother
   * clipping. The radius is capped at half the shorter side: past that the
   * corners would overlap and the shape stops being a rectangle at all.
   */
  function roundRectPath(ctx, x, y, width, height, radius) {
    const limit = Math.floor(Math.min(width, height) / 2);
    const r = Math.max(0, Math.min(limit, Math.round(Number(radius) || 0)));

    ctx.beginPath();
    if (r <= 0) {
      ctx.rect(x, y, width, height);
      return 0;
    }

    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    return r;
  }

  function drawFrame(ctx, element) {
    const box = element.box;
    const theme = element.themeRef;

    if (element.fill && element.fill !== 'none') {
      ctx.fillStyle = element.fillColor;
      roundRectPath(ctx, box.x, box.y, box.width, box.height, element.roundness);
      ctx.fill();
    }
    if (element.outline) {
      ctx.strokeStyle = theme ? theme.panelOutline : 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 2;
      roundRectPath(ctx, box.x + 1, box.y + 1, box.width - 2, box.height - 2, element.roundness);
      ctx.stroke();
    }
  }

  /**
   * How tall a square-pixel picture is in raster units.
   *
   * The menu raster is stretched horizontally on a television, and everything
   * drawn into it is stretched along with it. A picture stored in square pixels
   * therefore has to be measured against the box in the same stretched space —
   * otherwise "fill" crops the sides off a picture that already matched, and
   * "fit" adds bars around one that needed none.
   */
  function pictureRasterHeight(imageHeight, stretch) {
    return imageHeight * (stretch || 1);
  }

  function drawImage(ctx, element, image, stretch) {
    const box = element.box;
    const scaleX = stretch || 1;

    ctx.save();
    ctx.beginPath();
    roundRectPath(ctx, box.x, box.y, box.width, box.height, element.roundness);
    ctx.clip();

    if (!image) {
      // A placeholder, so a slide under construction still looks intentional
      // rather than showing a hole.
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(box.x, box.y, box.width, box.height);
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width - 1, box.height - 1);
      ctx.restore();
      return;
    }

    const iw = image.naturalWidth || image.width || 1;
    const ih = pictureRasterHeight(image.naturalHeight || image.height || 1, scaleX);
    const fill = element.fit === 'fill';
    const scale = fill
      ? Math.max(box.width / iw, box.height / ih)
      : Math.min(box.width / iw, box.height / ih);
    const dw = iw * scale;
    const dh = ih * scale;

    ctx.drawImage(
      image,
      box.x + (box.width - dw) / 2,
      box.y + (box.height - dh) / 2,
      dw,
      dh
    );
    ctx.restore();
  }

  /**
   * The alpha to paint a background at.
   *
   * The property is *transparency*: 0 means the box is solid, 1 means it is
   * gone. Anything at or past 1 is skipped entirely rather than painted with
   * zero alpha, so a fully transparent box costs nothing and cannot leave a
   * faint edge from rounding.
   */
  function backgroundAlpha(element) {
    const transparency = Number(element.backgroundTransparency);
    if (!Number.isFinite(transparency) || transparency <= 0) return 1;
    return Math.max(0, 1 - transparency);
  }

  function drawTextElement(ctx, element) {
    const box = element.box;

    if (element.background) {
      const alpha = backgroundAlpha(element);
      if (alpha > 0.002) {
        ctx.fillStyle = hexToRgba(element.background, alpha);
        roundRectPath(ctx, box.x, box.y, box.width, box.height, element.roundness);
        ctx.fill();
      }
    }

    // The first line's baseline sits one ascent below the box top.
    let baseline = box.y + 8 + Math.round(element.fontPx * 0.82);
    const innerWidth = box.width - 20;
    let x = box.x + 10;
    if (element.align === 'center') x = box.x + box.width / 2;
    else if (element.align === 'right') x = box.x + box.width - 10;

    element.lines.forEach((line, index) => {
      // A long word broken mid-way is marked so it reads as a continuation
      // rather than a mistake.
      const isContinuation = index > 0 && element.lines[index - 1].length > 0 &&
        !/\s$/.test(element.lines[index - 1]) && line.length > 0;

      drawText(ctx, line, x, baseline, {
        font: element.font.stack,
        size: element.fontPx,
        weight: element.font.weight,
        color: element.color,
        align: element.align,
        tracking: isContinuation ? 0 : 0,
      });
      baseline += element.lineHeight;
    });

    // Keep `innerWidth` referenced so a future change to wrapping stays honest.
    void innerWidth;
  }

  /**
   * Draw a button.
   *
   * The resting state only. The highlight that follows the remote is a
   * subpicture layer the player composites on top, which is why it stays crisp
   * and why it works identically on hardware rather than being faked here.
   */
  function drawButton(ctx, element, theme) {
    const box = element.box;
    const style = element.buttonStyle || 'bar';
    const inset = 8;

    if (style === 'bar') {
      // The bar is the button's background, so the transparency property fades
      // it — and its keyline with it, so "1" really does mean nothing behind the
      // words rather than an accidental outline.
      const alpha = backgroundAlpha(element);
      if (alpha > 0.002) {
        ctx.fillStyle = hexToRgba(theme.panel, alpha);
        roundRectPath(ctx, box.x, box.y, box.width, box.height, element.roundness);
        ctx.fill();
        ctx.strokeStyle = hexToRgba(theme.panelOutline, alpha);
        ctx.lineWidth = 2;
        roundRectPath(ctx, box.x + 1, box.y + 1, box.width - 2, box.height - 2, element.roundness);
        ctx.stroke();
      }
    } else if (style === 'outline') {
      ctx.strokeStyle = theme.panelOutline;
      ctx.lineWidth = 2;
      ctx.strokeRect(box.x + 1, box.y + 1, box.width - 2, box.height - 2);
    } else if (style === 'underline') {
      ctx.strokeStyle = hexToRgba(theme.rule, 0.9);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(box.x, box.y + box.height);
      ctx.lineTo(box.x + box.width, box.y + box.height);
      ctx.stroke();
    }

    let textLeft = box.x + inset + 8;
    let textRight = box.x + box.width - inset - 8;

    // An automatically numbered button, for a track listing.
    if (element.showNumber) {
      drawText(ctx, String(element.number).padStart(2, '0'), box.x + inset + 8, box.y + box.height / 2 + 6, {
        font: element.font.stack,
        size: Math.max(11, Math.round(element.fontPx * 0.85)),
        weight: '600',
        color: theme.accent,
        tracking: 1,
      });
      textLeft += 30;
    }

    // The duration sits right-aligned, leaving the label the remaining room.
    let sublabelWidth = 0;
    if (element.sublabel) {
      ctx.save();
      ctx.font = `400 ${Math.max(11, Math.round(element.fontPx * 0.8))}px ${element.font.stack}`;
      sublabelWidth = ctx.measureText(element.sublabel).width;
      ctx.restore();
    }

    const labelBaseline = element.sublabel
      ? box.y + box.height / 2 - 2
      : box.y + box.height / 2 + 6;

    const align = element.align || 'left';
    let labelX = textLeft;
    if (align === 'center') labelX = box.x + box.width / 2;
    else if (align === 'right') labelX = textRight - sublabelWidth - 12;

    drawText(ctx, element.labelText, labelX, labelBaseline, {
      font: element.font.stack,
      size: element.fontPx,
      weight: element.font.weight,
      color: element.color,
      align,
    });

    if (element.sublabel) {
      drawText(ctx, element.sublabel, textRight, box.y + box.height / 2 + Math.round(element.fontPx * 0.6), {
        font: element.font.stack,
        size: Math.max(11, Math.round(element.fontPx * 0.8)),
        weight: '400',
        color: theme.muted,
        align: 'right',
      });
    }
  }

  /**
   * Draw a video tile.
   *
   * A DVD menu is a still picture, so the video cannot play here — what shows
   * is a frame from it, which is what makes a menu of episodes look like the
   * episodes. The frame is cover-fitted or letterboxed inside the picture area,
   * a soft scrim keeps the caption readable over any frame, and a play mark
   * says what choosing it will do.
   *
   * When no frame was extracted the tile still draws: a plain panel with the
   * name and the play mark. A video with no picture must never become a menu
   * entry with nothing to select.
   */
  function drawVideoTile(ctx, element, layout, image) {
    const box = element.box;
    const imageBox = element.imageBox;
    const theme = layout.theme;

    ctx.save();
    ctx.beginPath();
    roundRectPath(ctx, box.x, box.y, box.width, box.height, element.roundness);
    ctx.clip();

    // The ground behind the frame
    ctx.fillStyle = mix(theme.background, '#000000', 0.4);
    ctx.fillRect(box.x, box.y, box.width, box.height);

    if (image) {
      const iw = image.naturalWidth || image.width || 1;
      // The frame is a square-pixel picture; the tile is measured in stretched
      // raster units. Comparing them in the same space is what makes a 16:9
      // frame fill a 16:9 tile exactly, with no crop and no bars.
      const ih = pictureRasterHeight(image.naturalHeight || image.height || 1, layout.stretch);
      // Default to fill so the video frame fills the tile edge-to-edge with no black bars
      const fill = element.fit !== 'fit';
      const scale = fill
        ? Math.max(imageBox.width / iw, imageBox.height / ih)
        : Math.min(imageBox.width / iw, imageBox.height / ih);
      const dw = iw * scale;
      const dh = ih * scale;

      ctx.drawImage(
        image,
        imageBox.x + (imageBox.width - dw) / 2,
        imageBox.y + (imageBox.height - dh) / 2,
        dw,
        dh
      );
    } else {
      // Elegant placeholder
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(imageBox.x, imageBox.y, imageBox.width, imageBox.height);
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 1;
      ctx.strokeRect(imageBox.x + 0.5, imageBox.y + 0.5, imageBox.width - 1, imageBox.height - 1);
    }

    // Modern glass scrim across the bottom of the video for the caption
    if (element.showLabel) {
      const scrimHeight = Math.max(element.captionHeight + 16, 56);
      const captionTop = box.y + box.height - scrimHeight;
      const scrim = ctx.createLinearGradient(0, captionTop, 0, box.y + box.height);
      scrim.addColorStop(0, 'rgba(0,0,0,0)');
      scrim.addColorStop(0.35, 'rgba(0,0,0,0.45)');
      scrim.addColorStop(1, 'rgba(0,0,0,0.88)');
      ctx.fillStyle = scrim;
      ctx.fillRect(box.x, captionTop, box.width, scrimHeight);
    }

    // Beautiful centered play badge: frosted dark glass circle with white triangle
    const mark = element.mark;
    const radius = mark.size / 2;
    const cx = mark.x + radius;
    const cy = mark.y + radius;

    // Drop shadow under play badge
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 2;

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(18, 17, 16, 0.7)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Centered equilateral play triangle
    const tri = radius * 0.44;
    ctx.beginPath();
    ctx.moveTo(cx - tri * 0.45, cy - tri);
    ctx.lineTo(cx + tri * 0.85, cy);
    ctx.lineTo(cx - tri * 0.45, cy + tri);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    // Crisp typography with subtle text shadow so it pops over any video scene
    if (element.showLabel) {
      const captionBaseline = box.y + box.height - Math.round(element.captionHeight * 0.38);
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1;

      drawText(ctx, element.label, box.x + 16, captionBaseline, {
        font: element.fontFamily.stack,
        size: element.fontPx,
        weight: '600',
        color: '#f3ede2',
      });

      if (element.sublabel) {
        drawText(ctx, element.sublabel, box.x + box.width - 16, captionBaseline, {
          font: element.fontFamily.stack,
          size: Math.max(12, Math.round(element.fontPx * 0.8)),
          weight: '400',
          color: 'rgba(255, 255, 255, 0.78)',
          align: 'right',
        });
      }
      ctx.restore();
    }

    ctx.restore();

    // Clean outer keyline
    ctx.save();
    ctx.strokeStyle = theme.panelOutline;
    ctx.lineWidth = 2;
    ctx.strokeRect(box.x + 1, box.y + 1, box.width - 2, box.height - 2);
    ctx.restore();
  }

  /** Draw one resolved element. `images` maps element id to a decoded image. */
  function drawElement(ctx, element, layout, images) {
    const theme = layout.theme;
    if (element.kind === 'frame') return drawFrame(ctx, { ...element, themeRef: theme });
    if (element.kind === 'image') {
      const image = images && images[element.id] ? images[element.id] : null;
      return drawImage(ctx, element, image, layout.stretch);
    }
    if (element.kind === 'video') {
      const image = images && images[element.id] ? images[element.id] : null;
      return drawVideoTile(ctx, element, layout, image);
    }
    if (element.kind === 'text') return drawTextElement(ctx, element);
    if (element.kind === 'button') return drawButton(ctx, element, theme);
    return undefined;
  }

  /**
   * The order elements are drawn in, which is also the order they are stacked.
   *
   * Back to front: the last one drawn is the one on top. Exported because the
   * editor has to decide which element a click lands on, and it has to agree with
   * what is actually visible — with two copies of this rule, clicking a picture
   * that looks like it is underneath a panel would select the picture and
   * nothing on screen would explain why.
   *
   * Priority first, and the lower number is nearer the front — which means drawn
   * last. Kind order still breaks ties, so an element that has never been given a
   * priority behaves exactly as it did before priorities existed: buttons on top,
   * then text, then pictures.
   */
  const STACK_ORDER = { frame: 0, image: 1, video: 2, text: 3, button: 4 };

  function compareStacking(a, b) {
    const byPriority = (Number(b.priority) || 0) - (Number(a.priority) || 0);
    if (byPriority !== 0) return byPriority;
    return (STACK_ORDER[a.kind] || 0) - (STACK_ORDER[b.kind] || 0);
  }

  /**
   * Draw a whole slide, in the order a reader would expect: background, then
   * frames, then pictures and text, then buttons on top.
   *
   * Buttons last is not cosmetic. A button is what a player highlights, so if
   * anything overlaps it the highlight would appear to surround the wrong
   * thing. Drawing them last also means a frame can be used as a panel behind a
   * group of buttons without covering them.
   */
  function drawSlide(ctx, layout, images) {
    ctx.save();
    ctx.clearRect(0, 0, layout.width, layout.height);

    drawBackground(ctx, layout, images);

    const sorted = layout.elements.slice().sort(compareStacking);

    for (const element of sorted) {
      drawElement(ctx, element, layout, images || {});
    }

    ctx.restore();
    return layout;
  }

  return {
    drawSlide,
    drawElement,
    drawBackground,
    drawFrame,
    drawImage,
    drawVideoTile,
    drawTextElement,
    drawButton,
    drawText,
    hexToRgba,
    mix,
    isLight,
    compareStacking,
    STACK_ORDER,
  };
});
