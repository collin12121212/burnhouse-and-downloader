'use strict';

/**
 * Renders real slide decks in the real offscreen window and inspects the pixels.
 *
 * This is the test that matters most for how the app *looks*. Slides are drawn
 * by canvas code, and a canvas that silently draws nothing produces a perfectly
 * valid DVD with a blank menu — a failure no amount of XML checking would catch.
 *
 * Run with:  npm run test:menu
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const deckModel = require('../src/core/deck');
const { THEMES } = require('../src/core/themes');
const slideLayout = require('../src/core/slide_layout');
const deckRender = require('../src/core/deck_render');

const INSPECTOR = path.join(__dirname, 'inspector.html');
const OUT_DIR = path.join(__dirname, 'menu-samples');

const lines = [];
const problems = [];

function record(ok, label, detail) {
  lines.push(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) problems.push(`${label}${detail ? ` :: ${detail}` : ''}`);
}

const sampleVideos = [
  { id: 'v1', name: 'Arrival.mp4', duration: 245, durationLabel: '4m 5s' },
  { id: 'v2', name: 'The Long Walk.mov', duration: 1830, durationLabel: '30m 30s' },
  { id: 'v3', name: 'Garden, Final.mkv', duration: 96, durationLabel: '1m 36s' },
];

/** Render a deck and inspect the resulting pictures. */
async function renderAndInspect({ inspector, label, deck }) {
  const layout = slideLayout.layoutDeck(deckModel.normaliseDeck(deck));
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-deck-'));

  const rendered = await deckRender.renderDeck({ layout, outputDir, BrowserWindow });

  record(
    rendered.files.length === layout.slides.length,
    `${label}: every slide produced a picture`,
    `${rendered.files.length} of ${layout.slides.length}`
  );

  for (let i = 0; i < rendered.files.length; i += 1) {
    const file = rendered.files[i];
    const slideLayoutEntry = layout.slides[i];
    const slideName = slideLayoutEntry.slide.title;

    const size = fs.statSync(file.path).size;
    record(size > 2000, `${label} / "${slideName}": the picture has content`, `${size} bytes`);

    const stats = await inspector.webContents.executeJavaScript(
      `window.inspect(${JSON.stringify(deckRender.readImageAsDataUrl(file.path))})`,
      true
    );

    const inkRatio = stats.differing / stats.total;
    record(
      inkRatio > 0.02,
      `${label} / "${slideName}": not blank`,
      `${(inkRatio * 100).toFixed(1)}% of pixels carry content`
    );
    record(
      inkRatio < 0.96,
      `${label} / "${slideName}": not a flat block of colour`,
      `${(inkRatio * 100).toFixed(1)}% differing`
    );

    // Every button must have drawn pixels on its own centre row, or its label
    // is missing from the disc.
    for (const button of slideLayoutEntry.buttons) {
      const midY = Math.round((button.box.y + button.box.height / 2));
      const rowInk = stats.rowHasInk[midY] || 0;
      record(
        rowInk > 0,
        `${label} / "${slideName}": button "${button.labelText}" is drawn`,
        `${rowInk} inked pixels`
      );
    }

    // Every text element must have ink somewhere in its box.
    for (const element of slideLayoutEntry.elements.filter((e) => e.kind === 'text')) {
      let ink = 0;
      for (let y = element.box.y; y < element.box.y + element.box.height; y += 1) {
        ink += stats.rowHasInk[y] || 0;
      }
      record(ink > 0, `${label} / "${slideName}": text is drawn`, `${ink} inked pixels`);
    }

    // Overscan safety: no text may sit in the outer margin.
    const margins = await inspector.webContents.executeJavaScript(
      `window.rowSpread(${JSON.stringify(deckRender.readImageAsDataUrl(file.path))})`,
      true
    );
    for (const probe of margins) {
      record(
        probe.spread < 90,
        `${label} / "${slideName}": ${probe.where} margin clear of text`,
        `contrast spread ${probe.spread} (limit 90)`
      );
    }

    // A picture element must actually appear in its box.
    for (const element of slideLayoutEntry.elements.filter((e) => e.kind === 'image' && e.src)) {
      const coverage = await inspector.webContents.executeJavaScript(
        `window.boxCoverage(${JSON.stringify(deckRender.readImageAsDataUrl(file.path))}, ${JSON.stringify(element.box)})`,
        true
      );
      record(
        coverage.inside > 0.85,
        `${label} / "${slideName}": the picture is drawn`,
        `${(coverage.inside * 100).toFixed(0)}% of its box differs from the background`
      );
    }

    // Keep the first few slides for a human to look at.
    if (i < 8) {
      const keep = path.join(OUT_DIR, `${label}-${String(i + 1).padStart(2, '0')}.png`);
      try {
        fs.copyFileSync(file.path, keep);
      } catch {
        /* the sample folder is a convenience, not a requirement */
      }
    }
  }

  fs.rmSync(outputDir, { recursive: true, force: true });
  return layout;
}

/** A decorated slide, to prove the tools produce something visible. */
function decoratedDeck({ themeId = 'charcoal' } = {}) {
  const slide = deckModel.episodeListSlide(sampleVideos, { title: 'Summer 2024', themeId });
  slide.elements.push(
    deckModel.makeTextElement({
      text: 'Three episodes from the back garden.',
      x: 40,
      y: 96,
      width: 500,
      fontSize: 'small',
      fontId: 'plain',
      color: 'muted',
    })
  );
  return {
    discTitle: 'Summer 2024',
    themeId,
    buttonStyle: 'bar',
    slides: [slide],
  };
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const inspector = new BrowserWindow({
    show: false,
    width: 800,
    height: 640,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  try {
    await inspector.loadFile(INSPECTOR);

    // ---- the default episode menu ---------------------------------------
    await renderAndInspect({
      inspector,
      label: 'episode-menu',
      deck: decoratedDeck(),
    });

    // ---- every preset look ----------------------------------------------
    for (const theme of Object.values(THEMES)) {
      const layout = slideLayout.layoutDeck(
        deckModel.normaliseDeck(decoratedDeck({ themeId: theme.id }))
      );
      const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-theme-'));
      const rendered = await deckRender.renderDeck({ layout, outputDir, BrowserWindow });
      const file = rendered.files[0];
      const size = file && fs.existsSync(file.path) ? fs.statSync(file.path).size : 0;
      record(size > 3000, `theme "${theme.label}" renders`, `${size} bytes`);
      if (file) {
        try {
          fs.copyFileSync(file.path, path.join(OUT_DIR, `theme-${theme.id}.png`));
        } catch {
          /* convenience only */
        }
      }
      fs.rmSync(outputDir, { recursive: true, force: true });
    }

    // ---- a multi-slide deck with navigation -----------------------------
    const menu = deckModel.episodeListSlide(sampleVideos, { title: 'Episodes', themeId: 'darkroom' });
    const about = deckModel.makeSlide({ title: 'About', role: 'content', themeId: 'darkroom' });
    about.elements = [
      deckModel.makeTextElement({
        text: 'Filmed over one summer.',
        x: 60,
        y: 120,
        width: 600,
        fontSize: 'large',
        fontId: 'serif',
        align: 'center',
        autoHeight: true,
      }),
      deckModel.makeImageElement({ x: 220, y: 200, width: 280, height: 180 }),
      /*
        A way back that she made herself.

        The layout used to add this button for her, which is why the deck here
        did not need one. It no longer does — nothing appears on a page that is
        not in the deck — so a page she wants to leave has to carry its own
        button pointing at the page it goes back to.
      */
      deckModel.makeButtonElement({
        label: 'Back to the menu',
        targetSlideId: menu.id,
        x: 60,
        y: 400,
        width: 240,
        height: 46,
      }),
    ];

    const multi = await renderAndInspect({
      inspector,
      label: 'multi-slide',
      deck: {
        discTitle: 'Two Slides',
        themeId: 'darkroom',
        slides: [menu, about],
      },
    });

    // The About slide carries exactly the one button it was given and no
    // others: a page no longer gains a row of its own, so what the inspector
    // lists is what the disc gets.
    const aboutLayout = multi.slides[1];
    record(
      aboutLayout.buttons.length === 1,
      'multi-slide: the page carries the button she put on it, and only that one',
      `${aboutLayout.buttons.length} buttons`
    );
    record(
      aboutLayout.buttons[0] && aboutLayout.buttons[0].targetSlideId === menu.id,
      'multi-slide: that button goes back to the menu',
      `${aboutLayout.buttons[0] && aboutLayout.buttons[0].targetSlideId}`
    );

    // ---- the densely packed case ----------------------------------------
    const many = Array.from({ length: 14 }, (_, i) => ({
      id: `m${i}`,
      name: `Episode ${i + 1}.mp4`,
      duration: 600,
      durationLabel: '10m 0s',
    }));
    await renderAndInspect({
      inspector,
      label: 'many-episodes',
      deck: {
        discTitle: 'A Long Series',
        themeId: 'cedar',
        slides: [deckModel.episodeListSlide(many, { title: 'All Episodes', themeId: 'cedar' })],
      },
    });

    // ---- a graphic title slide ------------------------------------------
    const cover = deckModel.makeSlide({ title: 'Cover', role: 'menu', themeId: 'projection' });
    cover.elements = [
      deckModel.makeFrameElement({ x: 80, y: 90, width: 560, height: 240, fill: 'panel' }),
      deckModel.makeTextElement({
        text: 'The Collected Works',
        x: 110,
        y: 130,
        width: 500,
        fontSize: 'huge',
        fontId: 'serif',
        align: 'center',
        autoHeight: true,
      }),
      deckModel.makeTextElement({
        text: '1998 \u2013 2024',
        x: 110,
        y: 210,
        width: 500,
        fontSize: 'medium',
        fontId: 'plain',
        color: 'muted',
        align: 'center',
        autoHeight: true,
      }),
      deckModel.makeButtonElement({
        label: 'Begin',
        videoId: 'v1',
        x: 280,
        y: 270,
        width: 160,
        height: 52,
        align: 'center',
        buttonStyle: 'outline',
      }),
    ];
    await renderAndInspect({
      inspector,
      label: 'title-card',
      deck: { discTitle: 'Collected', themeId: 'projection', slides: [cover] },
    });

    // ---- awkward text ----------------------------------------------------
    const awkward = deckModel.makeSlide({ title: 'Awkward', role: 'menu', themeId: 'newsprint' });
    awkward.elements = [
      deckModel.makeTextElement({
        text: 'Supercalifragilisticexpialidociousandthenevenmorelettersthatwillnotfitononeline',
        x: 40,
        y: 60,
        width: 400,
        fontSize: 'large',
        fontId: 'title',
        autoHeight: true,
      }),
      deckModel.makeTextElement({
        text: 'One\nTwo\nThree\nFour\nFive\nSix\nSeven',
        x: 40,
        y: 150,
        width: 300,
        fontSize: 'small',
        fontId: 'plain',
        autoHeight: true,
      }),
      deckModel.makeButtonElement({ label: 'A Very Long Button Label That Must Shrink To Fit', videoId: 'v1', x: 360, y: 150, width: 300 }),
      deckModel.makeButtonElement({ label: 'Wide', videoId: 'v2', x: 360, y: 220, width: 300, align: 'right' }),
    ];
    await renderAndInspect({
      inspector,
      label: 'awkward-text',
      deck: { discTitle: 'Awkward', themeId: 'newsprint', slides: [awkward] },
    });

    // ---- a real picture --------------------------------------------------
    const coverPng = path.join(OUT_DIR, 'cover-source.png');
    const coverData = await inspector.webContents.executeJavaScript('window.makeCover()', true);
    fs.writeFileSync(
      coverPng,
      Buffer.from(String(coverData).replace(/^data:image\/png;base64,/, ''), 'base64')
    );
    const coverUrl = deckRender.readImageAsDataUrl(coverPng);

    const withPicture = deckModel.makeSlide({ title: 'With Picture', role: 'menu', themeId: 'charcoal' });
    withPicture.elements = [
      deckModel.makeImageElement({ src: coverUrl, fileName: 'cover.png', x: 400, y: 60, width: 272, height: 200, fit: 'fill' }),
      deckModel.makeTextElement({ text: 'With a picture', x: 40, y: 90, width: 330, fontSize: 'huge', fontId: 'title', autoHeight: true }),
      deckModel.makeButtonElement({ label: 'Play', videoId: 'v1', x: 40, y: 180, width: 330 }),
    ];
    await renderAndInspect({
      inspector,
      label: 'with-picture',
      deck: { discTitle: 'Pictured', themeId: 'charcoal', slides: [withPicture] },
    });
  } catch (err) {
    record(false, 'rendering completed', (err && err.stack) || String(err));
  } finally {
    try {
      inspector.destroy();
    } catch {
      /* already gone */
    }
  }

  console.log('\nBurnhouse slide rendering\n');
  for (const line of lines) console.log(line);

  const passed = lines.filter((l) => l.startsWith('  PASS')).length;
  if (problems.length) {
    console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
    for (const problem of problems) console.log(`  - ${problem}`);
    console.log(`\nSample pictures are in ${OUT_DIR}`);
    app.exit(1);
  } else {
    console.log(`\nAll ${passed} checks passed.`);
    console.log(`Sample pictures are in ${OUT_DIR}`);
    app.exit(0);
  }
});
