'use strict';

/**
 * Focused tests for the disc's navigation and menu subpicture.
 *
 * Kept separate from test/run.js on purpose: these are the fastest tests in the
 * project and they cover the part of the pipeline that decides whether the
 * remote works at all and whether the highlight is visible. They run in about a
 * second, so they can be run on every change instead of the full suite.
 *
 * Run with:  npm run test:disc
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dvdNav = require('../src/core/dvd_nav');
const dvdModel = require('../src/core/dvd_model');
const author = require('../src/core/author');
const deckModel = require('../src/core/deck');
const disc = require('../src/core/disc');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, message: String((err && err.message) || err) });
    console.log(`  FAIL ${name}`);
    console.log(`       ${String((err && err.message) || err)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Values differ'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `burnhouse-${tag}-`));
}

function which(binary) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(cmd, [binary], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  const first = String(result.stdout || '').split(/\r?\n/).filter(Boolean)[0];
  return first || null;
}

function section(title) {
  console.log(`\n${title}`);
}

// ------------------------------------------------------------ navigation ---

section('Arrow-key navigation');

const column = [
  { name: 'btn1', x0: 48, y0: 100, x1: 348, y1: 154 },
  { name: 'btn2', x0: 48, y0: 180, x1: 348, y1: 234 },
  { name: 'btn3', x0: 48, y0: 260, x1: 348, y1: 314 },
];

const grid = [
  { name: 'b1', x0: 48, y0: 100, x1: 300, y1: 150 },
  { name: 'b2', x0: 48, y0: 170, x1: 300, y1: 220 },
  { name: 'b3', x0: 380, y0: 100, x1: 632, y1: 150 },
  { name: 'b4', x0: 380, y0: 170, x1: 632, y1: 220 },
];

test('down and up walk a single column', () => {
  const nav = dvdNav.navigationObject(column);
  assertEqual(nav.btn1.down, 'btn2', 'Down from the first leaves the page');
  assertEqual(nav.btn2.down, 'btn3', 'Down from the second');
  assertEqual(nav.btn3.up, 'btn2', 'Up from the last');
  assertEqual(nav.btn2.up, 'btn1', 'Up from the middle');
});

test('a direction with nowhere to go stays put', () => {
  const nav = dvdNav.navigationObject(column);
  // Pointing a direction at the button itself is how a disc says "do nothing".
  assertEqual(nav.btn1.left, 'btn1', 'Left on the leftmost');
  assertEqual(nav.btn1.right, 'btn1', 'Right with nothing to the right');
  assertEqual(nav.btn1.up, 'btn1', 'Up on the topmost');
  assertEqual(nav.btn3.down, 'btn3', 'Down on the bottom-most');
});

test('left and right cross between two columns', () => {
  const nav = dvdNav.navigationObject(grid);
  assertEqual(nav.b1.right, 'b3', 'Right moves across, not down');
  assertEqual(nav.b2.right, 'b4', 'Right from the second row');
  assertEqual(nav.b3.left, 'b1', 'Left comes back across');
  assertEqual(nav.b1.down, 'b2', 'Down stays in its own column');
});

test('every button has all four directions defined', () => {
  for (const buttons of [column, grid]) {
    const nav = dvdNav.navigationObject(buttons);
    for (const button of buttons) {
      const entry = nav[button.name];
      assert(entry, `${button.name} has no entry`);
      for (const direction of ['up', 'down', 'left', 'right']) {
        assert(
          typeof entry[direction] === 'string' && entry[direction],
          `${button.name}.${direction} is not a button name`
        );
      }
    }
  }
});

test('a single button points every direction at itself', () => {
  const nav = dvdNav.navigationObject([column[0]]);
  assertEqual(nav.btn1.up, 'btn1', 'Up');
  assertEqual(nav.btn1.down, 'btn1', 'Down');
  assertEqual(nav.btn1.left, 'btn1', 'Left');
  assertEqual(nav.btn1.right, 'btn1', 'Right');
});

// --------------------------------------------------------- spumux control ---

section('spumux control file');

const sampleButtons = [
  { name: 'btn1', x0: 48, y0: 100, x1: 348, y1: 154 },
  { name: 'btn2', x0: 48, y0: 180, x1: 348, y1: 234 },
];

test('all buttons live inside one spu element', () => {
  const xml = author.buildSpumuxXml({
    buttons: sampleButtons,
    navigation: dvdNav.navigationObject(sampleButtons),
  });
  const spuOpens = (xml.match(/<spu\b/g) || []).length;
  const spuCloses = (xml.match(/<\/spu>/g) || []).length;
  assertEqual(spuOpens, 1, 'There must be exactly one <spu>');
  assertEqual(spuCloses, 1, 'And it must be closed');
  assertEqual((xml.match(/<button\b/g) || []).length, 2, 'Both buttons are present');
});

test('geometry is on the button, never on the spu', () => {
  const xml = author.buildSpumuxXml({
    buttons: sampleButtons,
    navigation: dvdNav.navigationObject(sampleButtons),
  });
  const spuTag = /<spu\b[^>]*>/.exec(xml)[0];
  for (const attr of ['x0', 'y0', 'x1', 'y1']) {
    assert(
      !new RegExp(`${attr}=`).test(spuTag),
      `spumux rejects ${attr} on <spu> and aborts the whole build`
    );
  }
  const buttonTag = /<button\b[^>]*>/.exec(xml)[0];
  for (const attr of ['x0', 'y0', 'x1', 'y1']) {
    assert(new RegExp(`${attr}="`).test(buttonTag), `${attr} must be on <button>`);
  }
});

test('only attributes spumux accepts are emitted', () => {
  // The exact allow-list from spumux's own parser table.
  const allowed = {
    spu: ['image', 'highlight', 'select', 'start', 'end', 'transparent',
      'autooutline', 'outlinewidth', 'autoorder', 'force', 'xoffset', 'yoffset'],
    button: ['name', 'up', 'down', 'left', 'right', 'x0', 'y0', 'x1', 'y1'],
    stream: [],
    subpictures: ['format'],
  };
  const xml = author.buildSpumuxXml({
    buttons: sampleButtons,
    navigation: dvdNav.navigationObject(sampleButtons),
    highlightPath: 'highlight_1.png',
    selectPath: 'select_1.png',
  });

  for (const tag of ['spu', 'button']) {
    const re = new RegExp(`<${tag}\\b([^>]*)>`, 'g');
    let match;
    while ((match = re.exec(xml))) {
      for (const attr of match[1].matchAll(/([a-zA-Z0-9_-]+)="/g)) {
        assert(
          allowed[tag].includes(attr[1]),
          `spumux does not accept "${attr[1]}" on <${tag}>`
        );
      }
    }
  }
});

test('navigation is written into the button tags', () => {
  const buttons = [
    { name: 'btn1', x0: 48, y0: 100, x1: 348, y1: 154 },
    { name: 'btn2', x0: 48, y0: 180, x1: 348, y1: 234 },
  ];
  const xml = author.buildSpumuxXml({
    buttons,
    navigation: dvdNav.navigationObject(buttons),
  });
  assert(/down="btn2"/.test(xml), 'The first button must point down at the second');
  assert(/up="btn1"/.test(xml), 'The second must point up at the first');
});

test('highlight and select are file names, not colours', () => {
  const xml = author.buildSpumuxXml({
    buttons: sampleButtons,
    navigation: dvdNav.navigationObject(sampleButtons),
    highlightPath: 'highlight_1.png',
    selectPath: 'select_1.png',
  });
  assert(/highlight="highlight_1\.png"/.test(xml), 'highlight must be a path');
  assert(/select="select_1\.png"/.test(xml), 'select must be a path');
  assert(!/#/.test(xml), 'a colour where spumux expects a file makes it look for a file named "#e0a34a"');
});

test('button rectangles are even, as the subpicture format needs', () => {
  const odd = [{ name: 'btn1', x0: 49, y0: 101, x1: 349, y1: 155 }];
  const xml = author.buildSpumuxXml({ buttons: odd });
  assert(/x0="50"/.test(xml), `Expected x0 to round up to even, got ${xml}`);
  assert(/y0="102"/.test(xml), 'y0 must be even');
});

// ------------------------------------------------- highlight image on disk ---

section('Highlight picture');

const ffmpeg = which('ffmpeg');

if (!ffmpeg) {
  console.log('  SKIP the highlight picture is generated — ffmpeg is not installed');
} else {
  test('the highlight picture is transparent except over the buttons', () => {
    /*
      This is the layer that shows which button the remote is on. If the alpha
      channel comes out at zero the whole picture is invisible and the menu has
      no highlight at all on a television — which is exactly what happens if
      drawbox is used with an alpha colour instead of alphamerge.
    */
    const dir = tmpdir('highlight');
    const out = path.join(dir, 'highlight.png');
    const args = author.buildHighlightImageArgs({
      outputPng: out,
      boxes: [
        { x0: 48, y0: 100, x1: 348, y1: 154 },
        { x0: 48, y0: 180, x1: 348, y1: 234 },
      ],
      color: '#e0a34a',
      opacity: 84,
    });
    assert(args, 'Arguments were produced');

    const run = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true });
    assertEqual(run.status, 0, `ffmpeg failed: ${run.stderr}`);
    assert(fs.existsSync(out), 'The picture was written');

    const raw = path.join(dir, 'highlight.raw');
    const toRaw = spawnSync(
      ffmpeg,
      ['-nostdin', '-hide_banner', '-y', '-loglevel', 'error',
        '-i', out, '-pix_fmt', 'rgba', '-f', 'rawvideo', raw],
      { encoding: 'utf8', windowsHide: true }
    );
    assertEqual(toRaw.status, 0, 'Could read the picture back');

    const px = fs.readFileSync(raw);
    assertEqual(px.length, 720 * 480 * 4, 'Picture is the size of the menu');

    const at = (x, y) => {
      const o = (y * 720 + x) * 4;
      return { r: px[o], g: px[o + 1], b: px[o + 2], a: px[o + 3] };
    };

    const corner = at(5, 5);
    assertEqual(corner.a, 0, 'Outside the buttons must be fully transparent');

    const inBox = at(200, 125);
    assert(inBox.a > 40, `The highlight must be visible, alpha was ${inBox.a}`);
    assert(inBox.a < 250, `The highlight must be see-through, alpha was ${inBox.a}`);
    assert(inBox.r > inBox.b, 'The highlight carries the accent colour');

    const between = at(200, 165);
    assertEqual(between.a, 0, 'The gap between buttons stays transparent');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('no buttons means no picture rather than a broken command', () => {
    assertEqual(
      author.buildHighlightImageArgs({ outputPng: 'x.png', boxes: [] }),
      null,
      'An empty filter chain is an ffmpeg error, so it must not be attempted'
    );
  });
}

// ------------------------------------------------------------- disc model ---

section('Disc model');

function slideWithVideos() {
  return {
    discTitle: 'Holiday',
    themeId: 'charcoal',
    buttonStyle: 'bar',
    slides: [
      {
        id: 'menu-1',
        title: 'Holiday',
        role: 'menu',
        themeId: 'charcoal',
        elements: [
          {
            id: 'b1', kind: 'button', label: 'Episode 1', videoId: 'v1',
            x: 48, y: 100, width: 400, height: 54,
          },
          {
            id: 'b2', kind: 'button', label: 'Episode 2', videoId: 'v2',
            x: 48, y: 180, width: 400, height: 54,
          },
          {
            id: 'b3', kind: 'button', label: 'Nowhere', targetSlideId: null,
            x: 48, y: 260, width: 400, height: 54,
          },
        ],
      },
    ],
  };
}

test('a slide with buttons becomes a numbered menu page', () => {
  const model = dvdModel.buildDiscModel({
    deck: slideWithVideos(),
    videos: [{ id: 'v1', name: 'One' }, { id: 'v2', name: 'Two' }],
  });
  assertEqual(model.menus.length, 1, 'One menu page');
  assertEqual(model.menus[0].page, 1, 'Numbered from one');
  assertEqual(model.firstPlay.type, 'menu', 'The disc starts on the menu');
  assertEqual(model.firstPlay.number, 1, 'First play is page one');
});

test('buttons play the right title, in video order', () => {
  const model = dvdModel.buildDiscModel({
    deck: slideWithVideos(),
    videos: [{ id: 'v1', name: 'One' }, { id: 'v2', name: 'Two' }],
  });
  const commands = model.menus[0].buttons.map((b) => b.command);
  assertEqual(commands[0], 'jump title 1;', 'First button plays title 1');
  assertEqual(commands[1], 'jump title 2;', 'Second button plays title 2');
});

test('a button that leads nowhere is left off the disc', () => {
  const model = dvdModel.buildDiscModel({
    deck: slideWithVideos(),
    videos: [{ id: 'v1', name: 'One' }, { id: 'v2', name: 'Two' }],
  });
  // The third button targets nothing and plays nothing: on a disc it would be a
  // highlight that does nothing when chosen, which reads as a broken remote.
  assertEqual(model.menus[0].buttons.length, 2, 'Only the two live buttons remain');
  assert(
    !model.menus[0].buttons.some((b) => b.label === 'Nowhere'),
    'The dead button is gone'
  );
});

test('the model carries the navigation the simulator will use', () => {
  const model = dvdModel.buildDiscModel({
    deck: slideWithVideos(),
    videos: [{ id: 'v1' }, { id: 'v2' }],
  });
  const nav = model.menus[0].navigation;
  assert(nav.btn1 && nav.btn2, 'Both buttons have navigation entries');
  assertEqual(nav.btn1.down, 'btn2', 'Down from the first reaches the second');
});

test('a slide with nothing to press, and nothing pointing at it, is not a page', () => {
  /*
    The rule is what it is because a page with nothing on it *is* one when a
    button goes to it — see the tests below. This is the other half: a page
    nothing reaches and nothing on it can be pressed is not somewhere the viewer
    is ever sent, so it is not on the disc at all.
  */
  const deck = slideWithVideos();
  deck.slides[0].elements = [
    { id: 't1', kind: 'text', text: 'Just words', x: 48, y: 100, width: 400, height: 50 },
  ];
  const model = dvdModel.buildDiscModel({ deck, videos: [] });
  assertEqual(model.menus.length, 0, 'No pages');
  assertEqual(model.firstPlay.type, 'title', 'Playback falls back to the title');
  assertEqual(model.firstPlay.number, 1, 'Numbered from one');
});

test('the disc opens on a page with something to press on it', () => {
  /*
    The bug this covers: the disc opened on the first page in slide order, and a
    page can hold nothing but words. The viewer was put in front of a menu with
    nothing on it, and the Menu key — which returns to that same page — offered no
    way out. The root is the first page with a button on it instead.
  */
  const deck = {
    discTitle: 'Front is words',
    themeId: 'charcoal',
    buttonStyle: 'bar',
    slides: [
      {
        id: 'front', title: 'Front', role: 'menu', themeId: 'charcoal',
        elements: [
          { id: 'w', kind: 'text', text: 'Welcome', x: 48, y: 60, width: 400, height: 50 },
        ],
      },
      {
        id: 'second', title: 'Second', role: 'content', themeId: 'charcoal',
        elements: [
          // Points at the front page, so the front page exists on the disc...
          { id: 'p', kind: 'image', x: 100, y: 150, width: 260, height: 190, targetSlideId: 'front' },
        ],
      },
    ],
  };
  const model = dvdModel.buildDiscModel({ deck, videos: [] });

  assertEqual(model.menus.length, 2, 'Both pages are on the disc');
  const front = model.menus.find((m) => m.slideId === 'front');
  const second = model.menus.find((m) => m.slideId === 'second');
  assertEqual(front.buttons.length, 0, 'The front page still has nothing to press');
  assertEqual(second.buttons.length, 1, 'And the second page has the picture on it');

  // The picture goes to the front page, so the front page is page one and the
  // picture is page two — the numbers are in slide order and must not move.
  assertEqual(front.page, 1, 'Page numbers stay in slide order');
  assertEqual(second.page, 2, 'So the picture is the second page');
  assertEqual(second.buttons[0].command, 'jump menu 1;', 'And it goes back to the first');

  // What matters: the disc opens on the page that has something to press.
  assertEqual(model.firstPlay.type, 'menu', 'The disc starts on a menu page');
  assertEqual(model.firstPlay.number, second.page, 'And that is the one with the button on it');
  assertEqual(
    model.firstPlay.number,
    model.menus.find((m) => m.buttons.length > 0).page,
    'Which is the first page with anything pressable on it'
  );
});

test('a page with nothing on it anywhere is a disc nobody can use', () => {
  /*
    A picture pointing at a slide that has since been deleted resolves to no
    command, so nothing on its own page resolves either — and the disc came out
    as one page with nothing on it and no warning. The model still reports it;
    catching it is the burn stage's job, which is tested in the pipeline suite.
    What matters here is that it is visible in the model rather than silent.
  */
  const deck = {
    discTitle: 'Dangling',
    themeId: 'charcoal',
    buttonStyle: 'bar',
    slides: [
      {
        id: 'only', title: 'Only', role: 'menu', themeId: 'charcoal',
        elements: [
          { id: 'p', kind: 'image', x: 100, y: 150, width: 260, height: 190, targetSlideId: 'gone' },
        ],
      },
    ],
  };
  const model = dvdModel.buildDiscModel({ deck, videos: [] });

  assertEqual(
    model.menus.every((m) => m.buttons.length === 0),
    true,
    'Every page has nothing on it, so the burn stage has to say so'
  );
});

test('the entry point written into the disc file is the page with a button', () => {
  /*
    The same trap one layer down. `entry="root"` is where a player goes on insert
    and where the Menu key returns to, so if it lands on the empty front page the
    disc opens in a dead end however correct the model is.
  */
  const deck = {
    discTitle: 'Root check',
    themeId: 'charcoal',
    buttonStyle: 'bar',
    slides: [
      {
        id: 'front', title: 'Front', role: 'menu', themeId: 'charcoal',
        elements: [
          { id: 'w', kind: 'text', text: 'Welcome', x: 48, y: 60, width: 400, height: 50 },
        ],
      },
      {
        id: 'second', title: 'Second', role: 'content', themeId: 'charcoal',
        elements: [
          { id: 'b', kind: 'button', label: 'Go', videoId: 'v1', x: 48, y: 100, width: 300, height: 54 },
        ],
      },
    ],
  };
  const model = dvdModel.buildDiscModel({ deck, videos: [{ id: 'v1', name: 'One' }] });
  const rootPage = model.firstPlay.type === 'menu' ? model.firstPlay.number : 1;

  const xml = author.buildDvdauthorXml({
    videoFormat: 'ntsc',
    titleAspect: '16:9',
    rootPage,
    menus: model.menus.map((m) => ({ vobPath: 'menu.mpg', buttons: m.buttons })),
    titles: [],
  });

  const rootLine = xml.split('\n').find((line) => /<pgc[^>]*entry="root"/.test(line));
  assert(Boolean(rootLine), 'A page is marked as the entry point');
  assertEqual(
    xml.split('\n').filter((line) => /<pgc/.test(line)).indexOf(rootLine),
    model.firstPlay.number - 1,
    'And it is the page the model says the disc starts on'
  );
});

test('a button pointing at another slide jumps to that menu page', () => {
  const deck = {
    discTitle: 'Two pages',
    themeId: 'charcoal',
    buttonStyle: 'bar',
    slides: [
      {
        id: 'menu-1', title: 'First', role: 'menu', themeId: 'charcoal',
        elements: [
          { id: 'g1', kind: 'button', label: 'Go', targetSlideId: 'menu-2', x: 48, y: 100, width: 300, height: 54 },
        ],
      },
      {
        id: 'menu-2', title: 'Second', role: 'menu', themeId: 'charcoal',
        elements: [
          { id: 'b1', kind: 'button', label: 'One', videoId: 'v1', x: 48, y: 100, width: 300, height: 54 },
        ],
      },
    ],
  };
  const model = dvdModel.buildDiscModel({ deck, videos: [{ id: 'v1' }] });
  assertEqual(model.menus.length, 2, 'Both pages are menus');
  assertEqual(model.menus[0].buttons[0].command, 'jump menu 2;', 'The link jumps to page two');
});

test('a button pointing at a slide showing a film plays that film', () => {
  /*
    Aiming a button at a slide whose whole purpose is one video should start
    that video. Opening the page instead would make the viewer press again to
    do the only thing the page offers.
  */
  const deck = {
    discTitle: 'Play through',
    themeId: 'charcoal',
    buttonStyle: 'bar',
    slides: [
      {
        id: 'menu-1', title: 'First', role: 'menu', themeId: 'charcoal',
        elements: [
          { id: 'g1', kind: 'button', label: 'Watch', targetSlideId: 'ep-1', x: 48, y: 100, width: 300, height: 54 },
        ],
      },
      {
        id: 'ep-1', title: 'Episode', role: 'content', themeId: 'charcoal',
        elements: [
          { id: 'v1', kind: 'video', videoId: 'v1', label: 'Episode', x: 48, y: 40, width: 534, height: 356 },
        ],
      },
    ],
  };
  const model = dvdModel.buildDiscModel({ deck, videos: [{ id: 'v1' }] });

  // The episode slide carries the automatic Back/Next row, so it is a menu page
  // in its own right. That is not what the button should use, though: aiming at
  // it means "play this film".
  assertEqual(model.menus.length, 2, 'Both the menu and the episode slide have buttons');
  assertEqual(
    model.menus[0].buttons[0].command,
    'jump title 1;',
    'The button should start the film, not open the slide'
  );
  assertEqual(model.menus[0].buttons[0].action.type, 'title', 'And it is a title action');
});

test('a slide with a film and its own buttons still plays the film', () => {
  /*
    A page can hold a film and buttons at once, and that must not change what a
    button aimed at it does: aimed at the film, it plays the film; aimed at a
    page, it opens the page.

    Every page here carries its own button, because a page is only somewhere the
    disc can go if something on it can be pressed, and a page the disc can go to
    is not a page with nothing on it — it is a page nobody can leave. The layout
    used to add a Back/Next row to any slide it judged not to be a hub, which is
    what gave every page a button; with that gone, the test has to author the
    button a person would.
  */
  const deck = {
    discTitle: 'Play through',
    themeId: 'charcoal',
    buttonStyle: 'bar',
    slides: [
      {
        id: 'menu-1', title: 'First', role: 'menu', themeId: 'charcoal',
        elements: [
          { id: 'g1', kind: 'button', label: 'Watch', targetSlideId: 'ep-1', x: 48, y: 100, width: 300, height: 54 },
          { id: 'g2', kind: 'button', label: 'Words', targetSlideId: 'ep-2', x: 48, y: 180, width: 300, height: 54 },
        ],
      },
      {
        id: 'ep-1', title: 'Episode', role: 'content', themeId: 'charcoal',
        elements: [
          { id: 'v1', kind: 'video', videoId: 'v1', label: 'Episode', x: 48, y: 40, width: 534, height: 356 },
        ],
      },
      {
        id: 'ep-2', title: 'Another', role: 'content', themeId: 'charcoal',
        elements: [
          { id: 't1', kind: 'text', text: 'Words only', x: 48, y: 60, width: 400, height: 50 },
          { id: 'b1', kind: 'button', label: 'Back', targetSlideId: 'menu-1', x: 48, y: 380, width: 200, height: 54 },
        ],
      },
    ],
  };
  const model = dvdModel.buildDiscModel({ deck, videos: [{ id: 'v1' }] });

  const first = model.menus[0].buttons[0];
  assertEqual(first.command, 'jump title 1;', 'Still plays the film');

  // The words-only slide has no film, so a button aimed at it must still open
  // the page rather than jumping somewhere unrelated.
  const pageForWords = model.menus.find((m) => m.slideId === 'ep-2');
  assert(pageForWords, 'The slide with buttons is a menu page of its own');
  assertEqual(
    pageForWords.buttons.length,
    1,
    'Carrying the one button it was given, and nothing added for it'
  );
});

// ------------------------------------------------- the disc writer on macOS ---

section('Finding a disc writer');

/*
  Everything here is written against output taken from the Mac this is for,
  running macOS 12.7.6 with the drive attached. Two things in it are worth
  knowing before reading further, because both were assumed wrongly for a long
  time and the app reported no disc writer at all as a result:

    - `drutil list` has NO DeviceNode column. The real header is
      "Vendor Product Rev Bus SupportLevel" and nothing else. Any parser waiting
      for /dev/diskN matches nothing, on any Mac, ever.

    - `drutil list -xml` is a DTD'd element tree with ATTRIBUTES, not a plist of
      key/value pairs.

  And the support level for this drive is genuinely `unSupported` — yet burning
  to it works, which is why nothing gates on that value any more.
*/

const DRUTIL_TEXT = [
  '   Vendor   Product           Rev   Bus       SupportLevel',
  '1  hp       DVDRW  DU8A6SH    DH61  USB       Unsupported',
].join('\n');

const DRUTIL_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<!DOCTYPE  [',
  '    <!ELEMENT deviceList (device)*>',
  '    <!ELEMENT device (vendor, product, firmware, interconnect, support)>',
  '    <!ATTLIST device name CDATA #IMPLIED>',
  '    <!ATTLIST device index CDATA #IMPLIED>',
  '    <!ELEMENT support EMPTY>',
  '    <!ATTLIST support level (appleShipping|appleSupported|vendorSupported|unSupported|notSupported) #REQUIRED>',
  ']>',
  '<deviceList>',
  '    <device name="hp DVDRW DU8A6SH" index="1">',
  '        <vendor name="hp"/>',
  '        <product name="DVDRW  DU8A6SH"/>',
  '        <firmware revision="DH61"/>',
  '        <interconnect name="USB"/>',
  '        <support level="unSupported"/>',
  '    </device>',
  '</deviceList>',
].join('\n');

test('the XML listing is read as the Mac actually prints it', () => {
  const drives = disc.parseDrutilXml(DRUTIL_XML);
  assertEqual(drives.length, 1, 'one drive');
  assertEqual(drives[0].vendor, 'hp', 'the vendor');
  assertEqual(drives[0].product, 'DVDRW  DU8A6SH', 'the product, double space and all');
  assertEqual(drives[0].rev, 'DH61', 'the revision');
  assertEqual(drives[0].bus, 'USB', 'the bus');
  assertEqual(drives[0].supportLevel, 'unSupported', 'the support level as spelled');
  assertEqual(drives[0].label, 'hp DVDRW DU8A6SH', 'and a label worth reading');
});

test('a drive macOS calls unSupported is offered anyway', () => {
  // This drive reports unSupported and burns perfectly. Gating on it greyed out
  // the Burn button for a writer that works, which is the bug this guards.
  const drives = disc.parseDrutilXml(DRUTIL_XML);
  assertEqual(drives[0].writeCapable, true, 'the drive is usable');
});

test('drutil names no device node, and that is fine', () => {
  // hdiutil picks the only attached writer itself, so a node was never needed.
  // Requiring one is what hid the drive for several rounds.
  const drives = disc.parseDrutilXml(DRUTIL_XML);
  assertEqual(drives[0].device, '', 'no node from drutil');
  assert(drives[0].id, 'but an id to select it by');
});

test('two drives in one XML listing are both read', () => {
  const two = DRUTIL_XML.replace(
    '</deviceList>',
    '    <device name="HL-DT-ST DVDRAM GP65NB60" index="2">\n' +
      '        <vendor name="HL-DT-ST"/>\n' +
      '        <product name="DVDRAM GP65NB60"/>\n' +
      '        <firmware revision="PF00"/>\n' +
      '        <interconnect name="USB"/>\n' +
      '        <support level="appleShipping"/>\n' +
      '    </device>\n</deviceList>'
  );
  const drives = disc.parseDrutilXml(two);
  assertEqual(drives.length, 2, 'both drives');
  assertEqual(drives[1].label, 'HL-DT-ST DVDRAM GP65NB60', 'the second one too');
});

test('the plain listing is read by its columns', () => {
  const drives = disc.parseDrutilList(DRUTIL_TEXT);
  assertEqual(drives.length, 1, 'one drive');
  assertEqual(drives[0].product, 'DVDRW  DU8A6SH', 'the product survives its spaces');
  assertEqual(drives[0].bus, 'USB', 'the bus is the bus, not a word of the support level');
  assertEqual(drives[0].supportLevel, 'Unsupported', 'the level');
  assertEqual(drives[0].writeCapable, true, 'and it can still be written to');
});

test('an empty listing is no drives', () => {
  assertEqual(disc.parseDrutilXml('<deviceList/>').length, 0, 'an empty XML list');
  assertEqual(disc.parseDrutilList('').length, 0, 'empty text');
});

test('a line of prose is not a drive', () => {
  // "No drives found" was once read as a drive called "found", and the page
  // offered to burn to it.
  assertEqual(disc.parseDrutilList('No drives found').length, 0, 'prose is not a drive');
  assertEqual(disc.parseDrutilXml('No drives found').length, 0, 'nor is it XML');
});

test('a two-word support level is read whole', () => {
  const out = [
    '   Vendor   Product           Rev   Bus       SupportLevel',
    '   HL-DT-ST DVDRAM GP65NB60   PF00  USB       Apple Shipping',
  ].join('\n');
  const drives = disc.parseDrutilList(out);
  assertEqual(drives.length, 1, 'one drive');
  assertEqual(drives[0].supportLevel, 'Apple Shipping', 'the whole level');
  assertEqual(drives[0].product, 'DVDRAM GP65NB60', 'and the product is not swallowed');
});

// ------------------------------------------------------- the disc's shape ---

/**
 * A DVD player only treats a disc as DVD-Video if VIDEO_TS sits at the ROOT.
 *
 * This is not a detail that shows up in any file the authoring tools produce —
 * dvdauthor's output is identical either way. It only appears when a player
 * reads the finished disc, and what it does then is show a file browser and play
 * the VOBs as files. That is what happened: the image was built from the
 * authoring folder with the folder itself included, so the root held a directory
 * called `author` with the real VIDEO_TS buried inside it.
 *
 * So this asserts the shape of the image itself, which is the only place the
 * mistake is visible on a computer.
 */
async function checkImageRoot() {
  const discWindows = require('../src/core/disc_windows');

  const work = tmpdir('bh-iso-root');
  const authorDir = path.join(work, 'author');
  const videoTs = path.join(authorDir, 'VIDEO_TS');
  fs.mkdirSync(videoTs, { recursive: true });
  fs.mkdirSync(path.join(authorDir, 'AUDIO_TS'), { recursive: true });
  for (const name of ['VIDEO_TS.IFO', 'VIDEO_TS.BUP', 'VTS_01_0.IFO', 'VTS_01_0.VOB', 'VTS_01_1.VOB']) {
    fs.writeFileSync(path.join(videoTs, name), Buffer.alloc(8192, 7));
  }
  // Scratch that lives in the same folder and must not reach the disc.
  fs.writeFileSync(path.join(authorDir, 'dvdauthor.xml'), '<dvdauthor/>', 'utf8');

  const outputIso = path.join(work, 'disc.iso');
  await discWindows.buildIso({ sourceDir: authorDir, outputIso, volumeLabel: 'SHAPETEST' });

  // Mount read-only to read the image's root, then unmount.
  const psPath = path.join(work, 'inspect.ps1');
  fs.writeFileSync(
    psPath,
    '\uFEFF' +
      [
        "$ErrorActionPreference = 'Stop'",
        `$img = Mount-DiskImage -ImagePath '${outputIso}' -PassThru`,
        '$vol = $img | Get-Volume',
        // Joined rather than interpolated: PowerShell reads "$letter:\\" as a
        // drive qualifier on the variable and will not parse it.
        "$root = $($vol.DriveLetter) + ':\\'",
        "Write-Output ('FS=' + $vol.FileSystem)",
        "Get-ChildItem $root -Force | ForEach-Object { Write-Output ('ENTRY=' + $_.Name) }",
        `Dismount-DiskImage -ImagePath '${outputIso}' | Out-Null`,
      ].join('\n'),
    'utf8'
  );

  const run = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath],
    { encoding: 'utf8', windowsHide: true }
  );
  const out = String(run.stdout || '');
  const entries = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('ENTRY='))
    .map((l) => l.slice('ENTRY='.length));

  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}

  assert(/FS=UDF/.test(out), `The image must be UDF, got: ${out.split('\n')[0]}`);
  assert(entries.includes('VIDEO_TS'), `VIDEO_TS must be at the root, found: ${entries.join(', ')}`);
  assert(entries.includes('AUDIO_TS'), 'AUDIO_TS must be at the root');
  assertEqual(entries.includes('author'), false, 'The authoring folder itself must not be on the disc');
  assertEqual(
    entries.includes('dvdauthor.xml'),
    false,
    'Scratch files from the authoring folder must not reach the disc'
  );
}

section('What a Windows drive says about its disc');

(() => {
  const { windowsMedia } = require('../src/core/disc_windows');
  const base = { mediaText: 'Blank', mediaPresent: true, mediaReadable: false, mediaUsedBytes: 0, mediaPhysicalType: 9 };
  const media = (row, over) =>
    windowsMedia({ ...base, ...row }, {
      present: Boolean((row.mediaPresent === undefined ? base.mediaPresent : row.mediaPresent)),
      type: row.mediaText || base.mediaText,
      erasable: false,
      blank: false,
      freeSpace: null,
      ...over,
    });

  test('a blank DVD-R is blank, named, and has a size', () => {
    const m = media({}, { blank: true, freeSpace: 'blank, 4.7 GB free' });
    assertEqual(m.type, 'DVD-R');
    assertEqual(m.alreadyWritten, false);
    assertEqual(m.capacity, '4.7 GB', 'The size never reads "unknown" for a disc it can name');
  });

  test('a disc that was just burned is used, even though IMAPI cannot see it', () => {
    // IMAPI reports nothing for a closed disc; Windows has mounted its filesystem.
    const m = media({ mediaPresent: false, mediaText: 'No disc', mediaReadable: true, mediaUsedBytes: 4.1e9, mediaPhysicalType: 0 }, { present: false });
    assertEqual(m.present, true, 'The disc is in the drive');
    assertEqual(m.alreadyWritten, true, 'So Burn must be refused');
    assertEqual(m.usedSpace, '4.1 GB used');
  });

  test('a finalised disc IMAPI does describe is used too', () => {
    const m = media({ mediaText: 'Already written' }, { blank: false, erasable: false });
    assertEqual(m.alreadyWritten, true);
  });

  test('a rewritable disc with data on it can still be burned', () => {
    const m = media({ mediaText: 'Rewritable', mediaPhysicalType: 10 }, { erasable: true });
    assertEqual(m.alreadyWritten, false);
  });

  test('an empty drive has no disc', () => {
    const m = media({ mediaPresent: false, mediaText: 'No disc' }, { present: false });
    assertEqual(m.present, false);
    assertEqual(m.alreadyWritten, false);
  });
})();

// --------------------------------------------------------------------- go ---

/**
 * Burnhouse's own disc image, read back by Windows' own UDF driver.
 *
 * The image is written byte by byte by dvd_image.js, so the proof that it is a
 * real filesystem is an operating system mounting it and handing back every file
 * intact. One of the files is bigger than a single UDF extent can describe — a
 * full one-gigabyte VOB is — so the multi-extent path is exercised too.
 */
async function checkOwnImageMounts() {
  const dvdImage = require('../src/core/dvd_image');
  const work = tmpdir('bh-own-image');
  const videoTs = path.join(work, 'VIDEO_TS');
  fs.mkdirSync(videoTs, { recursive: true });
  const small = {};
  for (const name of ['VIDEO_TS.IFO', 'VIDEO_TS.BUP', 'VTS_01_0.IFO', 'VTS_01_0.BUP']) {
    const data = Buffer.alloc(6000 + name.length * 97, name.charCodeAt(4));
    fs.writeFileSync(path.join(videoTs, name), data);
    small[name] = data;
  }
  const bigSize = 0x3ffff800 + 2048 * 3 + 123;
  const big = fs.openSync(path.join(videoTs, 'VTS_01_1.VOB'), 'w');
  fs.ftruncateSync(big, bigSize);
  fs.writeSync(big, Buffer.from('LAST-BYTES'), 0, 10, bigSize - 10);
  fs.closeSync(big);

  const iso = path.join(work, 'own.iso');
  await dvdImage.writeDvdImage({ sourceDir: work, outputIso: iso, volumeLabel: 'OWN IMAGE' });
  fs.rmSync(path.join(videoTs, 'VTS_01_1.VOB'), { force: true });

  const psPath = path.join(work, 'inspect.ps1');
  fs.writeFileSync(
    psPath,
    '﻿' +
      [
        "$ErrorActionPreference = 'Stop'",
        `$img = Mount-DiskImage -ImagePath '${iso}' -PassThru`,
        '$vol = $img | Get-Volume',
        "$root = $($vol.DriveLetter) + ':\\'",
        "Write-Output ('FS=' + $vol.FileSystem + '|' + $vol.FileSystemLabel)",
        "Get-ChildItem ($root + 'VIDEO_TS') -Force | ForEach-Object { Write-Output ('FILE=' + $_.Name + '|' + $_.Length) }",
        "foreach ($n in @('VIDEO_TS.IFO','VTS_01_0.BUP')) { Write-Output ('HASH=' + $n + '|' + (Get-FileHash -Algorithm SHA256 -LiteralPath ($root + 'VIDEO_TS\\' + $n)).Hash) }",
        "$f = [System.IO.File]::OpenRead($root + 'VIDEO_TS\\VTS_01_1.VOB'); $f.Seek(-10, 'End') | Out-Null; $b = New-Object byte[] 10; $f.Read($b, 0, 10) | Out-Null; $f.Close()",
        "Write-Output ('TAIL=' + [System.Text.Encoding]::ASCII.GetString($b))",
        `Dismount-DiskImage -ImagePath '${iso}' | Out-Null`,
      ].join('\n'),
    'utf8'
  );
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const out = String(run.stdout || '');
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}

  const value = (key) => out.split('\n').filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1).trim());
  assert(/^UDF\|OWN IMAGE$/.test(value('FS')[0] || ''), `Windows must read it as UDF named OWN IMAGE, got: ${out.slice(0, 300)} ${run.stderr || ''}`);
  const sizes = new Map(value('FILE').map((l) => l.split('|')).map(([n, s]) => [n, Number(s)]));
  assertEqual(sizes.get('VTS_01_1.VOB'), bigSize, 'The file larger than one extent keeps its full length');
  assertEqual(value('TAIL')[0], 'LAST-BYTES', 'And its last bytes are its own');
  const crypto = require('crypto');
  for (const line of value('HASH')) {
    const [name, hash] = line.split('|');
    const expected = crypto.createHash('sha256').update(small[name]).digest('hex').toUpperCase();
    assertEqual(hash, expected, `${name} reads back identical`);
  }
}

/**
 * The same image, mounted by macOS.
 *
 * Apple's UDF driver is the one that will read the burned disc on her Mac, and
 * `hdiutil attach` uses it for an image exactly as it would for a disc. Every
 * file has to come back intact, the large one included.
 */
async function checkOwnImageMountsOnMac() {
  const dvdImage = require('../src/core/dvd_image');
  const work = tmpdir('bh-own-image-mac');
  const videoTs = path.join(work, 'VIDEO_TS');
  fs.mkdirSync(videoTs, { recursive: true });
  const expected = new Map();
  for (const [name, size] of [['VIDEO_TS.IFO', 6144], ['VIDEO_TS.BUP', 6144], ['VTS_01_0.IFO', 12288], ['VTS_01_0.BUP', 12288], ['VTS_01_1.VOB', 0x3ffff800 + 4096 + 77]]) {
    const fd = fs.openSync(path.join(videoTs, name), 'w');
    fs.ftruncateSync(fd, size);
    const marker = Buffer.from(`${name}-${size}`);
    fs.writeSync(fd, marker, 0, marker.length, 0);
    fs.writeSync(fd, marker, 0, marker.length, size - marker.length);
    fs.closeSync(fd);
    expected.set(name, size);
  }
  const iso = path.join(work, 'own.iso');
  await dvdImage.writeDvdImage({ sourceDir: work, outputIso: iso, volumeLabel: 'OWN IMAGE' });

  const attach = spawnSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-noverify', '-plist', iso], { encoding: 'utf8' });
  assertEqual(attach.status, 0, `hdiutil could not attach the image: ${attach.stderr}`);
  const mounts = [...attach.stdout.matchAll(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1]);
  const device = (/<key>dev-entry<\/key>\s*<string>(\/dev\/disk\d+)<\/string>/.exec(attach.stdout) || [])[1];
  try {
    assert(mounts.length > 0, `macOS mounted no filesystem from the image: ${attach.stdout.slice(0, 400)}`);
    const root = mounts[0];
    for (const [name, size] of expected) {
      const file = path.join(root, 'VIDEO_TS', name);
      assertEqual(fs.statSync(file).size, size, `${name} has its full length on macOS`);
      const fd = fs.openSync(file, 'r');
      const marker = Buffer.from(`${name}-${size}`);
      const head = Buffer.alloc(marker.length);
      const tail = Buffer.alloc(marker.length);
      fs.readSync(fd, head, 0, marker.length, 0);
      fs.readSync(fd, tail, 0, marker.length, size - marker.length);
      fs.closeSync(fd);
      assert(head.equals(marker) && tail.equals(marker), `${name} reads back its own bytes`);
    }
    assert(fs.existsSync(path.join(root, 'AUDIO_TS')), 'AUDIO_TS is there too');
  } finally {
    if (device) spawnSync('hdiutil', ['detach', device, '-force'], { encoding: 'utf8' });
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
}

/**
 * The burn's progress stream, through IMAPI, without a burner.
 *
 * A burn hands IMAPI a .NET stream that counts what is read from it. IMAPI's
 * filesystem builder accepts a stream through exactly the same kind of COM call
 * — `AddFile(name, stream)` — so it stands in for the drive: if it accepts the
 * stream, reads all of it and gets the right bytes, so will a burn.
 */
async function checkProgressStream() {
  const w = require('../src/core/disc_windows');
  const crypto = require('crypto');
  const work = tmpdir('bh-progress');
  const src = path.join(work, 'payload.bin');
  const payload = crypto.randomBytes(2048 * 900);
  fs.writeFileSync(src, payload);
  const out = path.join(work, 'through.iso');

  const reports = [];
  await w.runScript(
    `${w.PRELUDE}
${w.STREAM_HELPERS}
$src = ${w.psQuote(src)}
$length = (Get-Item -LiteralPath $src).Length
$file = [BurnhouseFileStream]::Open($src)
$progress = New-Object BurnhouseProgressStream($file, $length)
$image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
$image.FileSystemsToCreate = 4
$image.FreeMediaBlocks = 0
$image.Root.AddFile('PAYLOAD.BIN', $progress)
$result = $image.CreateResultImage()
[BurnhouseStreamCopy]::ToFile($result.ImageStream, ${w.psQuote(out)}) | Out-Null
`,
    { onOutput: (t) => { for (const m of t.matchAll(/BURNHOUSE_PROGRESS (\d+)/g)) reports.push(Number(m[1])); } }
  );
  const image = fs.readFileSync(out);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}

  assert(reports.length > 0, 'The stream reported progress');
  assertEqual(reports[reports.length - 1], 1000, 'All the way to the end');
  assert(image.includes(payload), 'And IMAPI received every byte, in order');
}

/** A failing disc script says what failed, not PowerShell's error furniture. */
async function checkScriptErrors() {
  const w = require('../src/core/disc_windows');
  let message = '';
  try {
    await w.runScript(`${w.PRELUDE}\nthrow 'The specific thing that went wrong'\n`);
  } catch (err) {
    message = String(err.message);
  }
  assertEqual(message, 'The specific thing that went wrong');
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, message: String((err && err.message) || err) });
    console.log(`  FAIL ${name}`);
    console.log(`       ${String((err && err.message) || err)}`);
  }
}

(async () => {
  if (process.platform === 'win32') {
    section("The disc image's shape");
    await asyncTest('VIDEO_TS and AUDIO_TS sit at the root of the image', checkImageRoot);
    await asyncTest("Burnhouse's own image is read back intact by Windows' UDF driver", checkOwnImageMounts);
    section('Burning on Windows, without a burner');
    await asyncTest('the progress stream is accepted and read to the end by IMAPI', checkProgressStream);
    await asyncTest('a failing disc script reports its own message', checkScriptErrors);
  } else if (process.platform === 'darwin') {
    section("The disc image's shape");
    await asyncTest("Burnhouse's own image is read back intact by macOS's UDF driver", checkOwnImageMountsOnMac);
  } else {
    section("The disc image's shape");
    console.log('  SKIP building a disc image — this test mounts an ISO, which needs Windows or macOS');
  }

  console.log('');
  if (failed) {
    console.log(`${failed} of ${passed + failed} checks failed.`);
    for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
    process.exit(1);
  } else {
    console.log(`All ${passed} checks passed.`);
  }
  void deckModel;
})();

