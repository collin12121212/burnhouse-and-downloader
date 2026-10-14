'use strict';

/**
 * Rendering slides to pictures.
 *
 * Each slide is drawn by the same code as the live preview, but in a hidden
 * Chromium window, and the result is read back as a PNG. Doing it this way
 * rather than with a server-side canvas library means there is exactly one
 * drawing implementation in the project, so what she sees while designing is
 * what ends up on the disc. It also keeps the app free of native modules, which
 * is what makes the universal macOS build straightforward.
 */

const fs = require('fs');
const path = require('path');

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.heic') return 'image/heic';
  return 'image/jpeg';
}

/**
 * Read a picture and return it as a data URL.
 *
 * The renderer window has no filesystem access, so this is how a chosen picture
 * reaches the editor. Reading it here rather than handing back a `file://` path
 * also means the preview works regardless of how Electron is configured for
 * local file access.
 */
function readImageAsDataUrl(filePath) {
  const data = fs.readFileSync(filePath);
  // A guard rather than a limit people will hit: this is a picture for a menu,
  // not a video, so anything enormous is a mistake worth reporting clearly.
  if (data.length > 40 * 1024 * 1024) {
    throw new Error('That picture is too large to use on a menu. Try one under 40 MB.');
  }
  return `data:${mimeFor(filePath)};base64,${data.toString('base64')}`;
}

/** Strip anything not JSON-safe so the injected call cannot throw. */
function serialisable(value) {
  return JSON.parse(
    JSON.stringify(value, (key, item) => (typeof item === 'function' ? undefined : item))
  );
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Open the offscreen window that holds the drawing code.
 *
 * The load is retried once, in a fresh window, if it fails. Creating a window
 * directly after another was destroyed can fail with ERR_FAILED while the first
 * is still being torn down — observed when two renders happen back to back, and
 * it is entirely transient. Its only other outcome is a failed build, so it is
 * worth one more try rather than an error about a file that plainly exists.
 */
async function openHelperWindow({ BrowserWindow, helperPath, width, height }) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const window = new BrowserWindow({
      show: false,
      width,
      height,
      // Not `offscreen`: a normal hidden window still gets a real GPU-backed
      // canvas and still runs canvas.toDataURL, which is what is read back.
      // Offscreen rendering would work too but is far more fragile across macOS
      // versions, and this has to work on a 2017 machine.
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

    try {
      await window.loadFile(helperPath);
      return window;
    } catch (err) {
      lastError = err;
      try {
        window.destroy();
      } catch {
        /* already gone */
      }
      // Let the previous window finish going away before opening another.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  throw new Error(
    `The window that draws slides could not be opened. ${
      (lastError && lastError.message) || 'No reason given.'
    }`
  );
}

/**
 * Render every slide in a laid-out deck.
 *
 * @param {object} options
 * @param {object} options.layout        from slide_layout.layoutDeck
 * @param {string} options.outputDir     where the PNGs go
 * @param {Function} options.BrowserWindow  injected so this can be tested
 *        without Electron being required at module load.
 * @returns {Promise<{files: Array<{slideId, path, width, height}>}>}
 */
async function renderDeck({ layout, outputDir, BrowserWindow, parent = null, timeoutMs = 30000 }) {
  if (!BrowserWindow) throw new Error('Rendering slides requires the application window.');

  fs.mkdirSync(outputDir, { recursive: true });

  const helperPath = path.join(__dirname, '..', 'renderer', 'slide_still.html');
  const window = await openHelperWindow({
    BrowserWindow,
    helperPath,
    width: layout.slides[0] ? layout.slides[0].width : 720,
    height: layout.slides[0] ? layout.slides[0].height : 480,
  });

  const files = [];

  try {
    for (let i = 0; i < layout.slides.length; i += 1) {
      const slideLayout = layout.slides[i];

      const payload = {
        layout: serialisable({
          ...slideLayout,
          // Functions never survive JSON, and images arrive as their own map.
          elements: slideLayout.elements,
        }),
        images: collectImages(slideLayout),
      };

      const result = await withTimeout(
        window.webContents.executeJavaScript(`window.renderSlide(${JSON.stringify(payload)})`, true),
        timeoutMs,
        `Drawing "${slideLayout.slide.title}" took too long and was stopped.`
      );

      if (!result || !result.ok) {
        throw new Error(
          `The slide "${slideLayout.slide.title}" could not be drawn. ` +
            `${(result && result.error) || 'Unknown reason.'}`
        );
      }

      const base64 = String(result.dataUrl).replace(/^data:image\/png;base64,/, '');
      // Zero-padded so the files sort in slide order, which makes the
      // authoring log readable when something goes wrong.
      const target = path.join(outputDir, `slide-${String(i + 1).padStart(3, '0')}.png`);
      fs.writeFileSync(target, Buffer.from(base64, 'base64'));

      files.push({
        slideId: slideLayout.slide.id,
        index: i,
        path: target,
        width: slideLayout.width,
        height: slideLayout.height,
      });
    }

    return { files };
  } finally {
    try {
      window.destroy();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Every data-URL picture used on a slide, keyed by element id.
 *
 * Video tiles carry a frame extracted from the video, so they count as pictures
 * here too — that is how the frame reaches the canvas that draws the disc. The
 * slide's own background picture travels under the reserved key the layout
 * carries, so the off-screen renderer decodes it without being told about it
 * separately.
 */
function collectImages(slideLayout) {
  const images = {};
  for (const element of slideLayout.elements) {
    if ((element.kind === 'image' || element.kind === 'video') && element.src) {
      images[element.id] = element.src;
    }
  }
  if (slideLayout.background && slideLayout.background.src && slideLayout.backgroundKey) {
    images[slideLayout.backgroundKey] = slideLayout.background.src;
  }
  return images;
}

module.exports = { renderDeck, readImageAsDataUrl };
