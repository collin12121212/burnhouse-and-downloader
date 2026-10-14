/**
 * Where an element is allowed to sit on a slide.
 *
 * One rule, in one place. There were two copies of it and they had already
 * drifted apart: the editor held an element inside the television-safe area, and
 * the authoring side did its own arithmetic, and the two disagreed about what
 * happens when an element is larger than the area it is being held inside. Only
 * one of them was ever called, so the disagreement was invisible until a picture
 * was scaled up too far and would not move.
 *
 * Loaded as a plain script by the editor and required as a module by the
 * authoring side, in the same shape as slide_draw.js, so the numbers that decide
 * whether a picture ends up on the disc exist once.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BurnhouseSafeArea = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** The DVD raster every slide is drawn on. */
  const RASTER = { width: 720, height: 480 };

  /**
   * How far in from the edge anything worth reading has to stay.
   *
   * Televisions overscan: they crop the outer edge of the picture, by an amount
   * that varies between sets. A word inside that band is a word that is not on
   * some televisions at all. The editor draws this as the blue guide.
   */
  const SAFE_MARGIN = 40;

  const MIN_WIDTH = 40;
  const MIN_HEIGHT = 24;

  /** Kinds that must keep their proportions, or the picture on the disc looks stretched. */
  const SHAPE_LOCKED = new Set(['video', 'image']);

  /**
   * Whether an element is free of the safe-area rules.
   *
   * A picture is. It may be bigger than the frame and it may be dragged anywhere
   * at all, including clear off the slide — choosing a crop sometimes means
   * pushing the picture right out of the way, and every limit here turned out to
   * be one somebody hit and then had to work around. The size keeps its floor,
   * as every kind does, so a picture cannot be resized into nothing by mistake,
   * and the position can always be typed back in the panel.
   *
   * Nothing else is free. Text half off the edge is text that is simply not on
   * the disc, and a button outside the area cannot be relied on with a remote —
   * so both are pulled back to where they can be read and pressed.
   */
  function mayOverflow(kind) {
    return kind === 'image';
  }

  /**
   * Where an element's edge may sit along one axis.
   *
   * For elements that have to stay on screen, and it is a real clamp: an element
   * that fits is held inside the limits, and one that does not — which only
   * happens to a video tile whose shape makes it too tall — is held covering
   * them, so the drag chooses which part shows.
   *
   * The version this replaces applied only the first form, as `min(max(lo, v),
   * hi - size)`. With an element larger than the area, `hi - size` came out
   * *below* `lo`, so the two halves fought each other and every value collapsed
   * to the same negative number — an element that could not be moved at all.
   */
  function clampEdge(start, size, boxStart, boxEnd) {
    const value = Math.round(Number(start) || 0);
    const extent = Number(size) || 0;

    if (extent <= boxEnd - boxStart) {
      return Math.min(Math.max(boxStart, value), boxEnd - extent);
    }
    return Math.min(Math.max(boxEnd - extent, value), boxStart);
  }

  /**
   * Move and size an element so that it is where it can be seen.
   *
   * Mutates and returns the element: every caller has one in hand and wants it
   * adjusted, not replaced. This runs on every mutation rather than only when
   * drawing, so an element that cannot be placed on a television cannot be saved
   * or burned either.
   */
  function clampElement(element, width, height) {
    if (!element) return element;

    const rasterWidth = Number(width) || RASTER.width;
    const rasterHeight = Number(height) || RASTER.height;
    const boxRight = rasterWidth - SAFE_MARGIN;
    /*
      One bottom for everything.

      A video tile used to stop higher than the rest, to keep clear of the
      navigation row that was drawn at y = 408..440 on every page it did not
      belong to. That row is gone, so there is nothing to keep clear of and no
      reason for a second number: the overscan margin is the only limit left.
    */
    const boxBottom = rasterHeight - SAFE_MARGIN;

    let w = Math.max(MIN_WIDTH, Math.round(Number(element.width) || MIN_WIDTH));
    let h = Math.max(MIN_HEIGHT, Math.round(Number(element.height) || MIN_HEIGHT));

    if (mayOverflow(element.kind)) {
      /*
        A picture is not clamped at all — not to the safe area and not to the
        slide. It may be dragged past either edge, or entirely off the frame.

        Two narrower rules were tried first: hold an oversized picture so the
        area it sits on stays covered, and then let it cross the edge but keep a
        grabbable strip on screen. Both were still a wall to walk into, and both
        were reported. The size keeps its floor so a picture cannot be resized
        into nothing, and its position can be typed back in the panel if it ends
        up somewhere awkward — which is enough to make "anywhere at all" safe to
        allow.
      */
      element.width = w;
      element.height = h;
      element.x = Math.round(Number(element.x) || 0);
      element.y = Math.round(Number(element.y) || 0);
      return element;
    }

    /*
      Everything else is held wholly inside, which means the size gives way
      rather than the position.

      Resizing past the safe area used to leave an element too big to be placed
      anywhere: every position was illegal, so every position collapsed to the
      same one and the element could not be moved at all. Pulling it back to fit
      makes the blue guide a real limit she can feel, rather than a line the
      element crosses and then stops responding to.
    */
    const maxWidth = boxRight - SAFE_MARGIN;
    const maxHeight = boxBottom - SAFE_MARGIN;

    if (w > maxWidth || h > maxHeight) {
      if (SHAPE_LOCKED.has(element.kind)) {
        // A tile keeps its shape, so both sides come down together rather than
        // one being squashed to fit — which is what puts a stretched face on the
        // disc.
        const scale = Math.min(maxWidth / w, maxHeight / h);
        if (scale > 0 && Number.isFinite(scale)) {
          w = Math.max(MIN_WIDTH, Math.round(w * scale));
          h = Math.max(MIN_HEIGHT, Math.round(h * scale));
        }
      } else {
        w = Math.min(w, maxWidth);
        h = Math.min(h, maxHeight);
      }
    }

    element.width = w;
    element.height = h;
    element.x = clampEdge(element.x, w, SAFE_MARGIN, boxRight);
    element.y = clampEdge(element.y, h, SAFE_MARGIN, boxBottom);
    return element;
  }

  return {
    RASTER,
    SAFE_MARGIN,
    MIN_WIDTH,
    MIN_HEIGHT,
    SHAPE_LOCKED,
    mayOverflow,
    clampEdge,
    clampElement,
  };
});
