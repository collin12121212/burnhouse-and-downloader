'use strict';

/**
 * Burnhouse interface.
 *
 * The design step is a slide editor: a filmstrip of slides on the left, the
 * slide itself in the middle, and controls for whatever is selected on the
 * right. Dragging a video onto a slide makes a button that plays it; dragging
 * one onto the filmstrip makes a new slide.
 *
 * Written as plain DOM code with one explicit state object and one render pass
 * per step. There is no framework here on purpose: the whole interface is three
 * screens, and a build step would be one more thing that can break on a machine
 * this app cannot be debugged on directly.
 *
 * The slide preview calls the same drawing module the disc renderer uses, with
 * the same resolved layout from the main process, so the picture on screen and
 * the picture burned to the disc come from one implementation.
 */

const api = window.burnhouse;
const draw = window.BurnhouseSlideDraw;
/*
  The raster, the safe margin and the rule about where an element may sit all
  come from safe_area.js, which the authoring side requires as a module. They
  used to be written out again here, which is how the editor and the authoring
  side came to disagree about an element larger than the area it was being held
  inside — and the size a picture may be dragged to is exactly that question.
*/
const safeArea = window.BurnhouseSafeArea;
const RASTER = safeArea.RASTER;
const SAFE_MARGIN = safeArea.SAFE_MARGIN;
const MIN_ELEMENT_WIDTH = safeArea.MIN_WIDTH;
const MIN_ELEMENT_HEIGHT = safeArea.MIN_HEIGHT;
const MAX_BUTTONS_PER_SLIDE = 18;

/**
 * The menu raster is anamorphic.
 *
 * A player stretches 720x480 to fill a widescreen television, so anything that
 * should *look* 16:9 must be 3:2 in raster units. The stretch factor comes from
 * the main process (slide_layout.js), which is the one place that owns the
 * geometry; this is only a fallback for the moment before presets arrive.
 */
let rasterStretch = (16 / 9) / (RASTER.width / RASTER.height);

/** The raster aspect that will display as `displayAspect` on a television. */
function displayAspectToRaster(displayAspect) {
  return rasterStretch > 0 ? displayAspect / rasterStretch : displayAspect;
}

/**
 * The two settings that used to be questions on the disc setup page.
 *
 * They are constants now: the video system is NTSC because she is in North
 * America, and stereo is the right answer for almost everything. The wrong
 * answer to either is a disc that will not play or sounds wrong, so neither is
 * worth asking about.
 */
const DISC_DEFAULTS = {
  audioMode: 'stereo',
  chaptersEnabled: true,
  chapterMinutes: 5,
};

// ---------------------------------------------------------------- state ---

const state = {
  // Opens on the projects screen on program start so the user can choose to
  // continue a recent project, open a file, or start fresh.
  step: 'projects',
  projectId: null,
  projectFilePath: null,
  recentProjects: [],
  newProjectName: 'My DVD',
  newProjectTheme: 'charcoal',

  settings: null,
  appInfo: null,
  tools: null,
  presets: null,

  videos: [],
  videoErrors: [],
  plan: null,
  totalSeconds: 0,

  discTitle: '',

  deck: {
    discTitle: 'My DVD',
    themeId: 'charcoal',
    buttonStyle: 'bar',
    slides: [],
  },
  activeSlideId: null,
  /*
    What is selected, and which of it is the one.

    Several elements can be selected at once, and then a property changed in the
    panel is applied to every one of them that has it. `selectedElementId` is the
    *primary* — the one the resize handles belong to and the one a property is
    read from when the panel needs a single value to show. It is always a member
    of `selectedElementIds`, or null when nothing is selected.

    Both are kept because the single-selection case is the common one and every
    caller that only wants "the element" keeps working unchanged.
  */
  selectedElementId: null,
  selectedElementIds: [],

  layout: null,
  /** Whether to draw the television-safe guide over the slide. */
  showSafeArea: true,
  panelTab: 'design',
  driveSupported: true,
  drives: [],
  driveNote: null,
  selectedDevice: null,

  busy: false,
  lastBuild: null,
  // Set while a burn is running, so its two jobs share one progress bar.
  burnSession: null,
  /*
    What is already built on disk for this project, asked of the main process.

    null      - not asked yet
    'checking'- asked, waiting for the answer
    object    - { built, upToDate, manifest }

    Kept apart from lastBuild, which is a build done in this session and carries
    detail a recorded build does not.
  */
  buildState: null,
  banner: null,
  /**
   * Alignment lines to draw while something is being dragged, as
   * `[{ axis: 'x'|'y', at }]`. Part of the gesture rather than of the slide, so
   * it is cleared when the drag ends.
   */
  snapGuides: [],
};

let inspectTimer = null;
let saveTimer = null;
let renderToken = 0;
/** Decoded pictures for the current slide, keyed by element id. */
const imageCache = new Map();

const $ = (id) => document.getElementById(id);

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'dataset') {
        for (const [dk, dv] of Object.entries(value)) node.dataset[dk] = dv;
      } else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children || [])) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ------------------------------------------------------------- formatting ---

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} bytes`;
}

function basename(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i === -1 ? s : s.slice(i + 1);
}

function stripExtension(name) {
  return String(name).replace(/\.[^.]+$/, '');
}

function videoLabel(video) {
  return video.menuLabel || stripExtension(video.name);
}

/** The main process does the real layout; this keeps the editor responsive. */
function activeSlide() {
  return state.deck.slides.find((s) => s.id === state.activeSlideId) || null;
}

function activeSlideLayout() {
  if (!state.layout) return null;
  return state.layout.slides.find((s) => s.slide && s.slide.id === state.activeSlideId) || null;
}

function findElement(elementId) {
  for (const slide of state.deck.slides) {
    const element = slide.elements.find((e) => e.id === elementId);
    if (element) return { slide, element };
  }
  return { slide: null, element: null };
}

// --------------------------------------------------------------- selection ---

/**
 * Replace the selection.
 *
 * `primary` is the element the handles and the panel's single-value rows belong
 * to; without one it is the last in the list, which is the one just added.
 */
function setElementSelection(ids, primary) {
  const unique = [];
  for (const id of [].concat(ids || [])) {
    if (id && !unique.includes(id)) unique.push(id);
  }
  state.selectedElementIds = unique;
  state.selectedElementId = primary && unique.includes(primary)
    ? primary
    : unique[unique.length - 1] || null;
}

function clearElementSelection() {
  setElementSelection([]);
}

/** The selected elements, in the order they were added to the selection. */
function selectedElements() {
  return state.selectedElementIds
    .map((id) => findElement(id).element)
    .filter(Boolean);
}

function isElementSelected(id) {
  return state.selectedElementIds.includes(id);
}

/**
 * Select what was pressed, but only if it is not already selected.
 *
 * The difference matters for dragging a group: pressing inside a multiple
 * selection must leave the selection alone so that the whole group can be moved.
 * Pressing something outside it replaces the selection with that one element,
 * which is what a click means.
 */
function setElementSelectionIfOutside(element) {
  if (!element) {
    clearElementSelection();
    return;
  }
  if (isElementSelected(element.id)) return;
  setElementSelection([element.id], element.id);
}

/**
 * Add an element to the selection, or take it out if it is already in it.
 *
 * This is what Ctrl-click does — and Cmd-click, and Shift-click. All three are
 * accepted on purpose: Ctrl-click is the natural gesture on Windows, Cmd-click
 * is the one on a Mac, and on a Mac Ctrl-click is also how the system asks for a
 * right-click, so relying on Ctrl alone would make the feature unreachable
 * there. Shift-click works on both and is the one nobody has to be told.
 */
function toggleElementSelection(id) {
  if (!id) return;
  const current = state.selectedElementIds.slice();
  const at = current.indexOf(id);
  if (at === -1) current.push(id);
  else current.splice(at, 1);
  // The element just clicked becomes the primary whether it was added or
  // removed, so the handles and the panel follow what was last touched.
  setElementSelection(current, current.includes(id) ? id : undefined);
}

// ------------------------------------------------------------------ boot ---

async function boot() {
  document.body.classList.add(
    navigator.platform.toLowerCase().includes('mac') ? 'platform-mac' : 'platform-win'
  );

  try {
    const [appInfo, settings, presets, recentProjects] = await Promise.all([
      api.app.info(),
      api.settings.get(),
      api.deck.presets(),
      api.project.listRecent(),
    ]);

    state.appInfo = appInfo;
    state.settings = settings;
    state.presets = presets;
    state.recentProjects = Array.isArray(recentProjects) ? recentProjects : [];

    // Adopt the geometry the main process owns, so the preview and the disc
    // cannot disagree about how wide the picture is.
    if (presets && Number.isFinite(presets.stretch) && presets.stretch > 0) {
      rasterStretch = presets.stretch;
    }

    applySettings(settings);
    await refreshLayout();

    api.tools.detect().then((result) => {
      state.tools = result.tools;
      updateBrandTag();
      /*
        Only complain about what is genuinely missing.

        This used to announce a "preview build" on any computer that was not a
        Mac, which was wrong twice over: both platforms burn with their own
        system tools, and the thing that is actually absent is a program, not a
        capability of the computer. Burning in particular needs nothing installed
        on either platform.
      */
      if (!result.tools.canAuthor) {
        setBanner('info', 'This computer cannot build a disc yet', [
          !result.tools.ffmpeg
            ? 'The video tools (ffmpeg) were not found. Open Setup to see how to get them.'
            : 'The disc-building tool (dvdauthor) was not found. Open Setup to see how to get it. ' +
              'Everything else works: you can design the whole disc and test it on the DVD player.',
        ]);
        render();
      } else if (!result.tools.canBurn) {
        setBanner('info', 'This computer cannot write discs', [
          'The disc can still be built and tested here, and the folder or image copied ' +
            'to a computer that can write it.',
        ]);
        render();
      }
    });

    refreshDrives();
    render();
    bindChrome();
    bindMenuEvents();
    bindJobEvents();
    installTestHooks();
    window.addEventListener('resize', debounce(drawCanvas, 120));
  } catch (err) {
    document.body.innerHTML =
      `<div style="padding:40px;color:#f3ede2">
         <h1>Burnhouse could not start</h1>
         <p style="color:#c4685c;margin-top:10px">${escapeHtml(String(err.message || err))}</p>
       </div>`;
  }
}

function applySettings(settings) {
  state.discTitle = settings.discTitle || '';
  state.selectedDevice = settings.lastDevice || null;
  state.showSafeArea = settings.showSafeArea !== false;

  if (settings.deck && Array.isArray(settings.deck.slides) && settings.deck.slides.length) {
    state.deck = settings.deck;
    state.activeSlideId = settings.activeSlideId || settings.deck.slides[0].id;
  }

  // Normal app startup begins at the Projects page so they can create or
  // continue a project. Test mode opens directly on the slides step.
  if (settings && settings.testHooks === true) {
    state.step = 'slides';
  } else {
    state.step = 'projects';
  }

  // A project with no slides is not a valid starting point, so the first thing
  // she sees is always a deck. The menu slide is created with no buttons; they
  // are generated from the video list as soon as there are any videos.
  ensureStarterSlides();
}

/**
 * Guarantee a deck that is ready to work in: a menu slide, plus a slide to put
 * something on.
 *
 * This runs on every start and after any deck change, so there is no state in
 * which the editor has nothing to show. It only ever adds — it never removes a
 * slide or rearranges what is already there.
 */
function ensureStarterSlides() {
  if (!state.deck.slides.length) {
    const title = state.discTitle || 'My DVD';
    state.deck.slides.push(makeMenuSlide(title));
    state.deck.slides.push(makeVideoSlide('Slide 2'));
    state.activeSlideId = state.deck.slides[0].id;
  }
  if (!state.activeSlideId || !state.deck.slides.some((s) => s.id === state.activeSlideId)) {
    state.activeSlideId = state.deck.slides[0].id;
  }
}

/**
 * The menu slide: a title and a list of buttons, one per video.
 *
 * Marked `role: 'menu'` so the layout knows it is a hub — the page the disc
 * opens on, and the one the remote's Menu key comes back to.
 */
function makeMenuSlide(title) {
  return {
    id: newId('slide'),
    title: title || 'Main menu',
    themeId: state.deck.themeId,
    role: 'menu',
    elements: [
      {
        id: newId('text'),
        kind: 'text',
        text: title || 'Main menu',
        x: SAFE_MARGIN,
        y: 44,
        width: RASTER.width - SAFE_MARGIN * 2,
        fontSize: 'huge',
        fontId: 'title',
        color: 'text',
        align: 'left',
        background: 'none',
        autoHeight: true,
        height: 60,
      },
    ],
  };
}

/** A blank slide for holding a video. */
function makeVideoSlide(title) {
  return {
    id: newId('slide'),
    title: title || 'Slide 2',
    themeId: state.deck.themeId,
    role: 'content',
    elements: [],
  };
}

function newId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function persistDeck() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.settings
      .set({
        deck: state.deck,
        activeSlideId: state.activeSlideId,
        discTitle: state.discTitle,
      })
      .catch(() => {});
  }, 500);
}

function updateBrandTag() {
  const tag = $('brandTag');
  if (!tag) return;
  if (state.step === 'projects') {
    tag.textContent = 'Projects';
    return;
  }

  const title = state.discTitle || 'My DVD';
  if (!state.tools) {
    tag.textContent = title;
    return;
  }

  // What this says is about capability, not about which computer it is. Both
  // platforms can burn with their own system tools; what can still be missing is
  // the disc-building tool, and saying "needs a Mac" when the real gap is a
  // missing program is simply wrong.
  if (state.tools.canAuthor && state.tools.canBurn) {
    tag.textContent = `${title} \u2014 Ready to burn`;
  } else if (!state.tools.ffmpeg) {
    tag.textContent = 'Video tools missing \u2014 open Setup';
  } else if (!state.tools.canAuthor) {
    tag.textContent = 'Disc-building tool missing \u2014 open Setup';
  } else {
    tag.textContent = `${title} \u2014 Ready to build`;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// -------------------------------------------------------------- videos ---

async function addVideoPaths(paths) {
  const incoming = (paths || []).filter(Boolean);
  if (!incoming.length) return [];

  const existing = new Set(state.videos.map((v) => v.path));
  const added = incoming.filter((p) => !existing.has(p) && looksLikeVideo(p));

  const rejected = incoming.filter((p) => !existing.has(p) && !looksLikeVideo(p));
  if (rejected.length) {
    setBanner(
      'info',
      'Some files were not videos',
      rejected.map((p) => `${basename(p)} was skipped.`).slice(0, 4)
    );
  }

  if (!added.length) {
    if (!rejected.length) {
      setBanner('info', 'Already added', 'Every one of those videos is already on the disc.');
    }
    render();
    return [];
  }

  for (const path of added) {
    state.videos.push({
      id: `v${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      path,
      name: basename(path),
      menuLabel: '',
      duration: 0,
      probe: null,
      sizeBytes: 0,
    });
  }

  // A folder name is almost always what the disc is "about", so it makes a
  // better first guess at a title than an empty box.
  if (!state.discTitle) {
    const folder = basename(added[0].slice(0, Math.max(added[0].lastIndexOf('/'), added[0].lastIndexOf('\\'))));
    if (folder && !/^[A-Za-z]:$/.test(folder) && folder.length < 40) {
      state.discTitle = folder.replace(/[_-]+/g, ' ').trim();
      state.deck.discTitle = state.discTitle;
      // Keep the menu slide's heading in step with the disc name, unless she
      // has typed her own words into it.
      const menu = state.deck.slides.find((s) => s.role === 'menu');
      const heading = menu && menu.elements.find((e) => e.kind === 'text');
      if (heading && !heading.edited) heading.text = state.discTitle;
    }
  }

  state.banner = null;
  // The video is on the disc straight away; the reading and the menu buttons
  // follow as soon as they are ready. Returns the videos added by this call
  // (with probe results and posters attached) so a drop onto a slide can put
  // tiles down for exactly the files that were just dropped.
  render();
  await runInspect();
  syncMenuSlides();
  persistDeck();
  render();
  return state.videos.filter((v) => added.includes(v.path));
}

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.mpg',
  '.mpeg', '.m2v', '.vob', '.ts', '.mts', '.m2ts', '.3gp', '.ogv', '.dv',
  '.divx', '.rm', '.rmvb', '.asf', '.f4v',
]);

function looksLikeVideo(path) {
  const lower = String(path).toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot !== -1 && VIDEO_EXTENSIONS.has(lower.slice(dot));
}

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic', '.heif', '.tif', '.tiff',
]);

/**
 * The sound formats offered and accepted.
 *
 * Anything ffmpeg can decode would do, and these are the ones a person actually
 * has: music from a shop, a recording from a phone, an exported track. The list
 * is deliberately longer than the picker's filter, so a dropped file with an
 * unusual extension is still recognised as a sound rather than offered to the
 * video importer.
 */
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.aac', '.wav', '.aif', '.aiff', '.ogg', '.oga', '.opus',
  '.flac', '.wma', '.mp2', '.ac3', '.mka',
]);

/**
 * Whether a path looks like a picture.
 *
 * By extension only, and only to choose a sensible response to a drop — a file
 * that claims to be a picture but cannot be decoded is caught when it is read,
 * which is the check that actually matters.
 */
function looksLikeImage(path) {
  const lower = String(path).toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot !== -1 && IMAGE_EXTENSIONS.has(lower.slice(dot));
}

/**
 * Whether a path looks like a sound.
 *
 * By extension, like the picture check, and for the same reason: it only decides
 * what to do with a dropped file. Whether the file can actually be decoded is
 * settled by ffmpeg when the disc is built, and a sound that cannot be read
 * makes its page silent rather than failing the disc.
 */
function looksLikeAudio(path) {
  const lower = String(path).toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot !== -1 && AUDIO_EXTENSIONS.has(lower.slice(dot));
}

/** Whether a drag is an internal video being dragged onto a slide. */
function hasVideoDrag(event) {
  const types = (event.dataTransfer && event.dataTransfer.types) || [];
  return Array.prototype.includes.call(types, 'application/x-burnhouse-video');
}

/** Whether a drag is a slide being reordered in the list. */
function hasSlideDrag(event) {
  const types = (event.dataTransfer && event.dataTransfer.types) || [];
  return Array.prototype.includes.call(types, 'application/x-burnhouse-slide');
}

async function runInspect() {
  if (!state.videos.length) {
    state.plan = null;
    state.totalSeconds = 0;
    state.videoErrors = [];
    render();
    return;
  }

  try {
    const result = await api.videos.inspect({
      videos: state.videos.map((v) => ({ id: v.id, path: v.path, name: v.name })),
    });

    const byPath = new Map(result.videos.map((v) => [v.path, v]));
    state.videos = state.videos.map((v) => {
      const found = byPath.get(v.path);
      if (!found) return v;
      return {
        ...v,
        probe: found.probe,
        duration: found.duration,
        sizeBytes: found.sizeBytes,
        poster: found.poster || v.poster || null,
      };
    });

    state.videoErrors = result.errors || [];
    state.totalSeconds = result.totalSeconds;
    state.plan = result.plan;
  } catch (err) {
    setBanner('error', 'Those videos could not be read', String(err.message || err));
  }

  render();
}

/**
 * Keep every menu slide's buttons in step with the video list.
 *
 * A menu slide is meant to list everything on the disc, so it should never go
 * stale: add a video and it appears, rename one and the label follows, remove
 * one and its button goes. That only applies to buttons the editor created —
 * marked `source: 'auto'` — so a button she added or repositioned by hand is
 * left exactly where she put it.
 *
 * Runs after the video list changes, which is the only thing that can make a
 * menu slide wrong.
 */
function syncMenuSlides() {
  const ready = state.videos.filter((v) => v.probe || v.duration);
  let changed = false;

  for (const slide of state.deck.slides) {
    if (slide.role === 'menu') {
      const heading = slide.elements.find((e) => e.kind === 'text');
      // The heading follows the disc name until she types over it. Typing sets
      // `edited` on the element (see the inspector's text field), and only that
      // opts out — otherwise a heading she wrote would be overwritten every time
      // a video is added or renamed.
      if (heading && !heading.edited && state.discTitle && heading.text !== state.discTitle) {
        heading.text = state.discTitle;
        changed = true;
      }
    }

    /*
      A generated list is kept in step with the videos: a renamed video renames
      its button, and a video that is gone takes its button with it.

      Nothing is ever *created* here. Dropping a video used to plant a button on
      the menu slide, so the menu changed shape because a file was dragged in —
      which is not what dragging a file in means. A list is made deliberately,
      with "Add menu slide".
    */
    const generated = slide.elements.filter((e) => e.kind === 'button' && e.source === 'auto');
    if (!generated.length) continue;

    const keptIds = new Set(ready.map((v) => v.id));
    const survivors = generated.filter((button) => button.videoId && keptIds.has(button.videoId));
    if (survivors.length !== generated.length) {
      const vanished = new Set(generated.filter((b) => !survivors.includes(b)).map((b) => b.id));
      slide.elements = slide.elements.filter((e) => !vanished.has(e.id));
      changed = true;
    }

    survivors.forEach((button, index) => {
      const video = ready.find((v) => v.id === button.videoId);
      if (!video) return;
      const label = videoLabel(video);
      const sublabel = video.duration ? formatDuration(video.duration) : '';
      if (button.label !== label) {
        button.label = label;
        changed = true;
      }
      if (button.sublabel !== sublabel) {
        button.sublabel = sublabel;
        changed = true;
      }
      // Numbered down the list, so removing one never leaves a gap.
      if (button.number !== index + 1) {
        button.number = index + 1;
        changed = true;
      }
    });
  }

  if (changed) persistDeck();
  return changed;
}

/**
 * Buttons for a list of videos, laid out down two columns.
 *
 * Overflow is not a problem here: a menu slide that cannot hold every video
 * simply lists what fits, and "Add menu slide" makes another page for the rest.
 * Buttons off the bottom of the picture would be invisible on a television,
 * which is worse than a second page.
 */
function episodeButtons(videos) {
  const rows = episodeRows();
  const capacity = rows * 2;

  return videos.slice(0, capacity).map((video, index) => {
    const column = Math.floor(index / rows);
    const row = index % rows;
    return {
      id: newId('btn'),
      kind: 'button',
      label: videoLabel(video),
      sublabel: video.duration ? formatDuration(video.duration) : '',
      videoId: video.id,
      targetSlideId: null,
      x: SAFE_MARGIN + column * 324,
      y: 132 + row * 64,
      width: 300,
      height: 54,
      fontSize: 'medium',
      fontId: 'plain',
      color: 'text',
      align: 'left',
      buttonStyle: state.deck.buttonStyle || 'bar',
      showNumber: true,
      number: index + 1,
      source: 'auto',
    };
  });
}

/** How many episode rows fit down the picture. */
function episodeRows() {
  return Math.max(1, Math.floor((RASTER.height - SAFE_MARGIN - 132) / 64));
}

/** How many videos one menu slide can list. */
function episodeCapacity() {
  return episodeRows() * 2;
}

// -------------------------------------------------------------- slides ---

function addSlide(options = {}) {
  const slide = {
    id: `slide_${Math.random().toString(36).slice(2, 9)}`,
    title: options.title || `Slide ${state.deck.slides.length + 1}`,
    themeId: state.deck.themeId,
    role: options.role || 'content',
    elements: [],
  };

  const index = state.deck.slides.findIndex((s) => s.id === state.activeSlideId);
  const at = options.at !== undefined ? options.at : index + 1;
  state.deck.slides.splice(Math.max(0, at), 0, slide);
  state.activeSlideId = slide.id;
  clearElementSelection();
  persistDeck();
  render();
  return slide;
}

/**
 * Make a new slide at the end of the disc, named for where it is.
 *
 * "Slide 4" when there are three already. Not after the video that was dropped
 * on it: a name taken from a file reads like a title somebody chose, and it
 * stops being true the moment the video is swapped or the slide is moved.
 *
 * `at: length` means the default name — the next position — is always right,
 * which is not true of a slide inserted into the middle.
 */
function addSlideAtEnd(options = {}) {
  return addSlide({ ...options, at: state.deck.slides.length });
}

function duplicateSlide(slideId) {
  const source = state.deck.slides.find((s) => s.id === slideId);
  if (!source) return;
  const copy = JSON.parse(JSON.stringify(source));
  copy.id = `slide_${Math.random().toString(36).slice(2, 9)}`;
  copy.title = `${source.title} copy`;
  copy.elements = copy.elements.map((element) => ({
    ...element,
    id: `${element.kind}_${Math.random().toString(36).slice(2, 9)}`,
  }));

  const index = state.deck.slides.findIndex((s) => s.id === slideId);
  state.deck.slides.splice(index + 1, 0, copy);
  state.activeSlideId = copy.id;
  clearElementSelection();
  persistDeck();
  render();
}

/**
 * Remove a slide, and any link that pointed at it.
 *
 * The links are the part that matters. A button or a picture aimed at a slide
 * that is no longer there resolves to no command, so it is not put on the disc at
 * all — silently, and with nothing on screen to say why. Clearing them on the
 * way out means what is left is what she can see: the picture is just a picture,
 * and the panel's "Goes to" says None rather than naming a slide from another
 * project.
 */
function deleteSlide(slideId) {
  const index = state.deck.slides.findIndex((s) => s.id === slideId);
  if (index === -1) return;
  state.deck.slides.splice(index, 1);
  for (const slide of state.deck.slides) {
    for (const element of slide.elements) {
      if (element.targetSlideId === slideId) element.targetSlideId = null;
    }
  }
  if (state.activeSlideId === slideId) {
    const next = state.deck.slides[Math.min(index, state.deck.slides.length - 1)];
    state.activeSlideId = next ? next.id : null;
  }
  persistDeck();
  render();
}

/**
 * Drop one slide next to another, for dragging in the slide list.
 *
 * Named apart from `moveSlide`, which nudge a slide by one place for the toolbar
 * buttons. They were briefly both called `moveSlide`, and because a later
 * function declaration wins, the nudge buttons silently started doing nothing.
 */
function moveSlideNextTo(slideId, targetId, after) {
  if (slideId === targetId) return;

  const slides = state.deck.slides;
  const from = slides.findIndex((s) => s.id === slideId);
  if (from === -1 || !slides.some((s) => s.id === targetId)) return;

  const [moved] = slides.splice(from, 1);
  // The target's index shifts by one once the moved slide is taken out, if the
  // moved slide was ahead of it.
  let insertAt = slides.findIndex((s) => s.id === targetId);
  if (after) insertAt += 1;
  slides.splice(insertAt, 0, moved);

  persistDeck();
  render();
}

function moveSlide(slideId, delta) {
  const index = state.deck.slides.findIndex((s) => s.id === slideId);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= state.deck.slides.length) return;
  const [slide] = state.deck.slides.splice(index, 1);
  state.deck.slides.splice(target, 0, slide);
  persistDeck();
  render();
}

function addElement(kind, patch = {}) {
  const slide = activeSlide();
  if (!slide) {
    setBanner('info', 'Add a slide first', 'Every element lives on a slide.');
    render();
    return;
  }

  const base = {
    id: `${kind}_${Math.random().toString(36).slice(2, 9)}`,
    kind,
    x: patch.x !== undefined ? patch.x : 120,
    y: patch.y !== undefined ? patch.y : 140,
    width: patch.width || 400,
    height: patch.height || 60,
  };

  if (kind === 'text') {
    Object.assign(base, {
      text: patch.text || 'Double-click to type',
      width: patch.width || 480,
      fontSize: 'large',
      fontId: 'title',
      color: 'text',
      align: 'left',
      background: 'none',
      autoHeight: true,
    });
  } else if (kind === 'button') {
    Object.assign(base, {
      label: patch.label || 'New button',
      videoId: patch.videoId || null,
      targetSlideId: patch.targetSlideId || null,
      width: patch.width || 400,
      height: patch.height || 54,
      fontSize: 'medium',
      fontId: 'plain',
      color: 'text',
      align: 'left',
      buttonStyle: state.deck.buttonStyle || 'bar',
      showNumber: false,
      sublabel: '',
    });
  } else if (kind === 'image') {
    Object.assign(base, {
      src: patch.src || null,
      fileName: patch.fileName || '',
      width: patch.width || 260,
      height: patch.height || 190,
      fit: 'fit',
      // A picture may be given something to do, exactly as a button may.
      videoId: patch.videoId || null,
      targetSlideId: patch.targetSlideId || null,
    });
  } else if (kind === 'video') {
    Object.assign(base, {
      videoId: patch.videoId || null,
      label: patch.label || 'Video',
      sublabel: patch.sublabel || '',
      src: patch.src || null,
      posterMissing: Boolean(patch.posterMissing),
      width: patch.width || 300,
      height: patch.height || 190,
      fit: patch.fit === 'fill' ? 'fill' : 'fit',
      fontSize: 'medium',
      fontId: 'plain',
      color: 'text',
      showLabel: patch.showLabel !== false,
    });
  } else if (kind === 'frame') {
    Object.assign(base, {
      width: patch.width || 480,
      height: patch.height || 240,
      fill: 'panel',
      outline: true,
    });
  }

  // Whatever asked for this element — a drop, the toolbar, a test — it must land
  // where it can be seen. The rule lives in safe_area.js so this agrees with the
  // authoring side and with every drag that follows.
  safeArea.clampElement(base, RASTER.width, RASTER.height);

  slide.elements.push(base);
  setElementSelection([base.id], base.id);
  persistDeck();
  render();
  // Returned so a caller that has just put something on a slide can say what it
  // was and where it went.
  return base;
}

/**
 * Remove one element, or several.
 *
 * Given a list, because deleting a multiple selection is one action and should
 * leave the rest of the selection alone — clearing everything would throw away
 * a selection she had just built for no reason.
 */
function deleteElements(elementIds) {
  const wanted = new Set([].concat(elementIds || []).filter(Boolean));
  if (!wanted.size) return;

  let removed = 0;
  for (const slide of state.deck.slides) {
    const before = slide.elements.length;
    slide.elements = slide.elements.filter((e) => !wanted.has(e.id));
    removed += before - slide.elements.length;
  }
  if (!removed) return;

  const remaining = state.selectedElementIds.filter((id) => !wanted.has(id));
  setElementSelection(remaining);
  persistDeck();
  render();
}

function deleteElement(elementId) {
  deleteElements([elementId]);
}

function updateElement(elementId, patch) {
  const { element } = findElement(elementId);
  if (!element) return;
  Object.assign(element, patch);
  persistDeck();
  // Redrawing belongs here, not at each call site: a helper that quietly
  // changes something without showing it is how the right-click "show the whole
  // picture" came to do nothing visible.
  refreshCanvas();
}

// ------------------------------------------------------------- layout ---

async function refreshLayout() {
  try {
    const result = await api.deck.layout({ deck: state.deck });
    state.layout = result;
    return result;
  } catch {
    // A layout the main process refused is not worth interrupting her over: the
    // canvas simply keeps showing the last good slide.
    state.layout = null;
    return null;
  }
}

/**
 * Redraw everything on the slides step.
 *
 * The layout lives in the main process, so this has to be a sequence: ask for
 * the layout, then draw from it. Firing the draw without awaiting that request
 * is what produces a permanently blank canvas — the drawing code correctly
 * finds nothing to draw.
 *
 * A token guards against two refreshes interleaving, so a slow response from an
 * earlier edit cannot paint over a newer one.
 */
async function refreshEditor() {
  const token = ++renderToken;
  await refreshLayout();
  if (token !== renderToken) return;
  if (state.step === 'finish') return;
  await drawCanvas();
  if (token !== renderToken) return;
  renderFilmstrip();
  renderEditorToolbar();
  renderInspector();
}

/** Layout and redraw after a change, without re-rendering the DOM around it. */
function refreshCanvas() {
  return refreshEditor();
}

/**
 * Redraw the slide and the slide list, but leave the inspector alone.
 *
 * The inspector is redrawn by replacing its DOM. Doing that while somebody is
 * typing in one of its fields destroys the field they are typing in, so the next
 * keystroke has nowhere to go — which is why typing a text property only ever
 * accepted one letter before kicking her out. Anything edited in place uses
 * this; anything that changes what the inspector should *show* uses
 * refreshCanvas.
 */
async function refreshCanvasOnly() {
  const token = ++renderToken;
  await refreshLayout();
  if (token !== renderToken) return;
  if (state.step === 'finish') return;
  await drawCanvas();
  if (token !== renderToken) return;
  renderFilmstrip();
}

/*
  Redrawing while something is being dragged.

  The canvas draws from `state.layout`, which is produced by the main process —
  not from the deck being edited. So a drag that only changed the deck and then
  called drawCanvas redrew the *old* layout, and the element never appeared to
  move. Asking for a fresh layout is the only way to draw the truth, and doing it
  once per frame keeps that affordable.

  Filmstrip thumbnails and the inspector are deliberately left alone here: the
  thumbnails are expensive to redraw every frame, and nothing about them has
  changed until the drag finishes.
*/
let dragFrame = null;
let dragToken = 0;

function redrawDuringDrag() {
  if (dragFrame) return;
  dragFrame = window.requestAnimationFrame(async () => {
    dragFrame = null;
    const token = ++dragToken;
    await refreshLayout();
    if (token !== dragToken) return;
    await drawCanvas();
  });
}

// ----------------------------------------------------------------- draw ---

async function loadImage(src) {
  if (!src) return null;
  if (imageCache.has(src)) return imageCache.get(src);
  const image = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  imageCache.set(src, image);
  return image;
}

/**
 * Decode every picture a slide needs: the ones on its elements, and its own
 * background.
 *
 * One helper, so the editor canvas, the filmstrip thumbnails and the simulator
 * cannot disagree about which pictures a slide has — a disagreement that would
 * show up as a background missing from one of the three.
 */
async function loadSlideImages(layout) {
  const images = {};
  for (const element of layout.elements) {
    if ((element.kind === 'image' || element.kind === 'video') && element.src) {
      images[element.id] = await loadImage(element.src);
    }
  }
  if (layout.background && layout.background.src && layout.backgroundKey) {
    images[layout.backgroundKey] = await loadImage(layout.background.src);
  }
  return images;
}

async function drawCanvas() {
  const canvas = $('slideCanvas');
  if (!canvas) return;

  const layout = activeSlideLayout();
  if (!layout) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  // Render at device resolution so text is crisp on a Retina display, while the
  // drawing itself stays in raster coordinates so the layout and the picture
  // agree exactly.
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = layout.width * dpr;
  canvas.height = layout.height * dpr;
  // Show the frame the shape it takes on a television, not the shape it has in
  // pixels. A DVD raster is anamorphic, so displaying it 3:2 here would show a
  // design that is squeezed compared with what the disc actually plays.
  const displayAspect = (state.presets && state.presets.displayAspect) || 16 / 9;
  canvas.style.aspectRatio = `${displayAspect} / 1`;

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Decode every picture first so the draw itself is synchronous.
  const images = await loadSlideImages(layout);

  draw.drawSlide(ctx, layout, images);

  // Anything drawn after this is editor furniture, never burned to the disc.
  drawEditorOverlay(ctx, layout);
}

/**
 * The eight resize handles around a selected element.
 *
 * One list used for drawing them and for hit-testing them, so a handle can
 * never be drawn somewhere it cannot be grabbed.
 */
function handlesFor(box) {
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const midX = box.x + box.width / 2;
  const midY = box.y + box.height / 2;
  return {
    nw: { x: box.x, y: box.y },
    n: { x: midX, y: box.y },
    ne: { x: right, y: box.y },
    w: { x: box.x, y: midY },
    e: { x: right, y: midY },
    sw: { x: box.x, y: bottom },
    s: { x: midX, y: bottom },
    se: { x: right, y: bottom },
  };
}

/** Drawn size of a handle, and how far from its centre still counts as a grab. */
const HANDLE_DRAW = 9;
const HANDLE_GRAB = 11;

const HANDLE_CURSORS = {
  nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize',
  w: 'ew-resize', e: 'ew-resize',
  sw: 'nesw-resize', s: 'ns-resize', se: 'nwse-resize',
};

/** Which handle is under a point, or null. */
function handleAt(box, point) {
  for (const [name, spot] of Object.entries(handlesFor(box))) {
    if (
      Math.abs(point.x - spot.x) <= HANDLE_GRAB &&
      Math.abs(point.y - spot.y) <= HANDLE_GRAB
    ) {
      return name;
    }
  }
  return null;
}

/**
 * Kinds that must keep their shape while being resized, or the picture on the
 * disc looks stretched. Defined in safe_area.js, beside the clamp that depends
 * on it and which the authoring side uses too.
 */
const SHAPE_LOCKED_KINDS = safeArea.SHAPE_LOCKED;

/**
 * The box an element becomes when a handle is dragged.
 *
 * `lockShape` keeps the element's proportions. It is on by default for video
 * tiles and pictures, because a stretched face or a squashed photograph is the
 * kind of thing nobody notices until it is on a television, and it is the whole
 * reason the tile was sized to the video's shape in the first place. Holding
 * Shift overrides it.
 */
function resizeBox(handle, origin, dx, dy, lockShape) {
  let x = origin.x;
  let y = origin.y;
  let width = origin.width;
  let height = origin.height;
  const right = origin.x + origin.width;
  const bottom = origin.y + origin.height;

  const movesWest = handle.includes('w');
  const movesEast = handle.includes('e');
  const movesNorth = handle.includes('n');
  const movesSouth = handle.includes('s');

  if (lockShape && origin.height > 0) {
    const aspect = origin.width / origin.height;
    const horizontal = movesEast || movesWest;
    const vertical = movesNorth || movesSouth;

    if (horizontal && !vertical) {
      width = Math.max(MIN_ELEMENT_WIDTH, origin.width + (movesWest ? -dx : dx));
      height = Math.max(MIN_ELEMENT_HEIGHT, width / aspect);
    } else if (vertical && !horizontal) {
      height = Math.max(MIN_ELEMENT_HEIGHT, origin.height + (movesSouth ? dy : -dy));
      width = Math.max(MIN_ELEMENT_WIDTH, height * aspect);
    } else {
      // A corner: let the wider of the two movements lead, then derive the rest.
      const candidateW = Math.max(MIN_ELEMENT_WIDTH, origin.width + (movesWest ? -dx : dx));
      const candidateH = Math.max(MIN_ELEMENT_HEIGHT, origin.height + (movesSouth ? dy : -dy));
      if (candidateW / aspect >= candidateH) {
        width = candidateW;
        height = candidateW / aspect;
      } else {
        height = candidateH;
        width = candidateH * aspect;
      }
    }

    // Re-anchor so the side being dragged stays under the pointer.
    if (movesWest) x = right - width;
    if (movesNorth) y = bottom - height;
  } else {
    if (movesWest) {
      x = origin.x + dx;
      width = right - x;
    }
    if (movesEast) width = origin.width + dx;
    if (movesNorth) {
      y = origin.y + dy;
      height = bottom - y;
    }
    if (movesSouth) height = origin.height + dy;
  }

  // Never invert or vanish. A zero-width box would be invisible and
  // unselectable, so the minimum wins over the drag.
  if (width < MIN_ELEMENT_WIDTH) {
    if (movesWest) x = right - MIN_ELEMENT_WIDTH;
    width = MIN_ELEMENT_WIDTH;
  }
  if (height < MIN_ELEMENT_HEIGHT) {
    if (movesNorth) y = bottom - MIN_ELEMENT_HEIGHT;
    height = MIN_ELEMENT_HEIGHT;
  }

  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/**
 * Which way the element under the pointer is moving, and the lines it lines up
 * with.
 *
 * The canvas draws from the layout, so the guides are raster coordinates and
 * are drawn across the whole frame — a television-safe way of showing "this edge
 * is level with that one".
 */
const SNAP_TOLERANCE = 6;

/**
 * Every x and y an element could sensibly line up with.
 *
 * The kind is not asked for. A video tile used to have a bottom limit of its own
 * to keep clear of the navigation row, and offering the safe-area bottom instead
 * would have drawn a guide exactly where a tile was not allowed to go — but that
 * row is gone, so every kind now shares the one bottom line.
 */
function snapLines(layout, excludeId) {
  const xs = [SAFE_MARGIN, RASTER.width - SAFE_MARGIN, RASTER.width / 2];
  const ys = [SAFE_MARGIN, RASTER.height - SAFE_MARGIN, RASTER.height / 2];
  for (const other of layout.elements) {
    if (!other.box || other.id === excludeId) continue;
    const box = other.box;
    xs.push(box.x, box.x + box.width / 2, box.x + box.width);
    ys.push(box.y, box.y + box.height / 2, box.y + box.height);
  }
  return { xs, ys };
}

/**
 * Nudge a box onto the nearest line, and report which lines it landed on.
 *
 * All three of the box's own edges and its centre are candidates, so lining up
 * left-to-left, centre-to-centre and right-to-left all work without her having
 * to think about which edge is which.
 */
function snapBox(box, layout, excludeId) {
  const { xs, ys } = snapLines(layout, excludeId);
  const guides = [];

  let bestX = null;
  for (const edge of [box.x, box.x + box.width / 2, box.x + box.width]) {
    for (const line of xs) {
      const delta = line - edge;
      if (Math.abs(delta) <= SNAP_TOLERANCE && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) {
        bestX = { delta, at: line };
      }
    }
  }

  let bestY = null;
  for (const edge of [box.y, box.y + box.height / 2, box.y + box.height]) {
    for (const line of ys) {
      const delta = line - edge;
      if (Math.abs(delta) <= SNAP_TOLERANCE && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) {
        bestY = { delta, at: line };
      }
    }
  }

  const x = box.x + (bestX ? bestX.delta : 0);
  const y = box.y + (bestY ? bestY.delta : 0);
  if (bestX) guides.push({ axis: 'x', at: bestX.at });
  if (bestY) guides.push({ axis: 'y', at: bestY.at });

  return { x: Math.round(x), y: Math.round(y), guides };
}

/** The alignment lines showing while something is being dragged. */
function drawSnapGuides(ctx, layout) {
  const guides = state.snapGuides || [];
  if (!guides.length) return;

  ctx.save();
  ctx.strokeStyle = 'rgba(120, 182, 232, 0.95)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  for (const guide of guides) {
    ctx.beginPath();
    if (guide.axis === 'x') {
      ctx.moveTo(guide.at + 0.5, 0);
      ctx.lineTo(guide.at + 0.5, layout.height);
    } else {
      ctx.moveTo(0, guide.at + 0.5);
      ctx.lineTo(layout.width, guide.at + 0.5);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Selection outlines, resize handles and the television-safe guide.
 *
 * Every selected element is outlined, so a multiple selection is visible as a
 * set rather than as one thing with no indication that others came along. The
 * resize handles belong to the primary alone: resizing several at once means
 * deciding what happens to their relative sizes, and guessing wrong there would
 * silently reshape a design.
 */
function drawEditorOverlay(ctx, layout) {
  const selected = state.selectedElementIds.slice();
  const primary = state.selectedElementId;

  for (const id of selected) {
    const element = layout.elements.find((e) => e.id === id);
    if (!element) continue;
    const box = element.box;
    const isPrimary = id === primary && selected.length === 1;

    ctx.save();
    ctx.strokeStyle = '#d9a353';
    ctx.lineWidth = 2;
    ctx.setLineDash(isPrimary ? [6, 4] : [3, 3]);
    ctx.strokeRect(box.x - 2, box.y - 2, box.width + 4, box.height + 4);
    ctx.restore();

    // The resize handles. Every element on the slide has them now: nothing is
    // placed by the layout behind her back any more.
    if (isPrimary) {
      ctx.save();
      for (const spot of Object.values(handlesFor(box))) {
        const half = HANDLE_DRAW / 2;
        ctx.fillStyle = '#f3ede2';
        ctx.strokeStyle = '#1c1b19';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.rect(spot.x - half, spot.y - half, HANDLE_DRAW, HANDLE_DRAW);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /*
    Nothing is drawn over a picture that has been given somewhere to go.

    There used to be an amber badge with a chevron on the corner of every such
    picture, so that a clickable picture could be told from an ordinary one. It
    was editor furniture and it never reached the disc, but it sat on her
    photograph in the one place she was trying to look at, and the panel already
    says where a picture goes. Those are two ways of saying the same thing, and
    only one of them is worth looking at.
  */

  if (state.showSafeArea) {
    ctx.save();
    ctx.strokeStyle = 'rgba(120, 182, 232, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(
      SAFE_MARGIN + 0.5,
      SAFE_MARGIN + 0.5,
      layout.width - SAFE_MARGIN * 2 - 1,
      layout.height - SAFE_MARGIN * 2 - 1
    );
    ctx.restore();
  }

  drawSnapGuides(ctx, layout);
}

// ---------------------------------------------------------------- hit test ---

function canvasPoint(event) {
  const canvas = $('slideCanvas');
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * RASTER.width,
    y: ((event.clientY - rect.top) / rect.height) * RASTER.height,
  };
}

/**
 * Every element under a point, front to back.
 *
 * Front first, so the first one is what a click should land on: it is the one
 * drawn last and therefore the one being looked at. The order comes from the
 * drawing code itself, because with two copies of that rule a picture that is
 * visibly underneath a panel could be the thing a click selects, and nothing on
 * screen would explain why.
 */
function stackAt(layout, point) {
  if (!layout) return [];
  return layout.elements
    .filter((element) => {
      const box = element.box;
      return (
        point.x >= box.x &&
        point.x <= box.x + box.width &&
        point.y >= box.y &&
        point.y <= box.y + box.height
      );
    })
    .sort(draw.compareStacking)
    // Sorted back to front for drawing, so the front-most is the last one.
    .reverse();
}

/** The element a click lands on: the one on top. */
function hitTest(layout, point) {
  return stackAt(layout, point)[0] || null;
}

/**
 * Which element a second gesture means: the selected one if the pointer is on
 * it, and otherwise the one on top.
 *
 * Double-clicking and right-clicking have to agree with the click-through, or
 * it is only half a feature: having reached a small thing under a big picture,
 * double-clicking it to edit its words would land on the picture again, and the
 * panel would appear to forget what she had just chosen.
 */
function gestureTarget(layout, point) {
  const selected = state.selectedElementId;
  if (selected && layout) {
    const element = layout.elements.find((e) => e.id === selected);
    const box = element && element.box;
    if (
      box &&
      point.x >= box.x &&
      point.x <= box.x + box.width &&
      point.y >= box.y &&
      point.y <= box.y + box.height
    ) {
      return element;
    }
  }
  return hitTest(layout, point);
}

/**
 * What is stacked behind one element.
 *
 * Everything drawn before it whose box it overlaps, rather than everything
 * sharing a point with its middle: a small picture tucked into one corner of a
 * big one is exactly the case this is about, and its middle is nowhere near the
 * middle of the big one.
 *
 * Used for the note in the panel that tells her more is hidden there, which is
 * the only thing that makes the click-through discoverable.
 */
function elementsBeneath(element, layout) {
  if (!layout || !element) return [];
  const resolved = layout.elements.find((e) => e.id === element.id);
  if (!resolved || !resolved.box) return [];

  // Back to front, so everything before it is behind it.
  const order = layout.elements.slice().sort(draw.compareStacking);
  const at = order.findIndex((e) => e.id === element.id);
  if (at === -1) return [];

  const box = resolved.box;
  return order.slice(0, at).filter((other) => {
    const o = other.box;
    if (!o) return false;
    return (
      o.x < box.x + box.width &&
      box.x < o.x + o.width &&
      o.y < box.y + box.height &&
      box.y < o.y + o.height
    );
  });
}

/**
 * Which element the pointer chooses, stepping down through a stack.
 *
 * A large picture with a transparent background is a wall: it covers everything
 * on the slide, so a click anywhere lands on the picture and the smaller things
 * under it can never be reached. Rather than a modifier nobody would discover,
 * pressing the *same place* again takes the next element down and wraps round at
 * the bottom, so every layer is reachable with the gesture everybody already
 * uses. `previousAt` is where the last press was, which is the whole of the state
 * this needs.
 */
function pickAt(layout, point, previousAt) {
  const stack = stackAt(layout, point);
  if (!stack.length) return { element: null, stack, at: null };

  const here =
    previousAt &&
    Math.abs(previousAt.x - point.x) <= 4 &&
    Math.abs(previousAt.y - point.y) <= 4;

  if (!here || stack.length === 1) {
    return { element: stack[0], stack, at: { x: point.x, y: point.y } };
  }

  const current = stack.findIndex((e) => e.id === state.selectedElementId);
  const next = current === -1 ? 0 : (current + 1) % stack.length;
  return { element: stack[next], stack, at: { x: point.x, y: point.y } };
}

// ------------------------------------------------------------- render ---

function render() {
  renderChrome();

  const isProjects = state.step === 'projects';
  const isTesting = state.step === 'testing';
  const isFinish = state.step === 'finish';

  document.body.classList.toggle('wide-stage', !isFinish);

  const stage = $('stage');
  const rail = $('rail');
  stage.replaceChildren();
  rail.replaceChildren();

  if (isProjects) {
    stage.className = 'stage stage-projects';
    renderProjectsStep(stage);
  } else if (isTesting) {
    stage.className = 'stage stage-testing';
    renderTestingStep(stage);
  } else if (isFinish) {
    stage.className = 'stage';
    renderFinishStep(stage);
    renderFinishRail(rail);
  } else {
    stage.className = 'stage stage-slides';
    const banner = state.banner ? buildBanner(state.banner) : null;
    renderSlidesStep(stage, banner);
  }

  if (!isProjects && !isTesting) renderBanner();

  if (!isProjects && !isTesting && !isFinish) {
    // The layout comes from the main process, so drawing has to wait for it.
    refreshEditor();
  }
}

function renderChrome() {
  const isProjects = state.step === 'projects';
  const stepsNav = $('steps');
  if (stepsNav) stepsNav.hidden = isProjects;

  const btnHome = $('btnProjectsHome');
  if (btnHome) btnHome.hidden = isProjects;

  const btnSave = $('btnSaveProject');
  if (btnSave) btnSave.hidden = isProjects;

  if (!isProjects) {
    const order = ['slides', 'testing', 'finish'];
    const currentIndex = order.indexOf(state.step);
    for (const button of document.querySelectorAll('.step')) {
      const index = order.indexOf(button.dataset.step);
      button.setAttribute('aria-current', String(button.dataset.step === state.step));
      button.dataset.complete = String(index < currentIndex);
      button.disabled = state.busy;
    }
  }

  const share = $('btnShare');
  if (share) share.disabled = state.busy;
  updateBrandTag();
}

/**
 * Show, replace or clear the page notice that sits at the top of a step.
 *
 * The removal is matched on a marker class rather than on `.banner`, because
 * `.banner` is the shared look used by the notices *inside* the panels too —
 * "no disc burner found", "the disc is built". Matching on the appearance meant
 * this deleted whichever of those happened to come first, then returned early
 * because there was no page notice to draw. The panel notices were being eaten
 * silently, on every render.
 */
function renderBanner() {
  const stage = $('stage');
  if (!stage) return;

  const existing = stage.querySelector('.stage-notice');
  if (existing) existing.remove();
  if (!state.banner) return;

  const notice = buildBanner(state.banner);
  notice.classList.add('stage-notice');
  stage.prepend(notice);
}

function buildBanner(banner) {
  const mark = banner.kind === 'error' ? '\u26a0' : banner.kind === 'good' ? '\u2713' : '\u2139';
  // `compact` is for a notice that is only a heading — nothing beneath to
  // space out, so it takes less room vertically.
  const classes = ['banner', `banner-${banner.kind}`];
  if (banner.compact) classes.push('banner-compact');
  return el('div', { class: classes.join(' ') }, [
    el('span', { class: 'banner-mark', text: mark }),
    el('div', { class: 'banner-body' }, [
      el('strong', { text: banner.title }),
      ...[].concat(banner.body || []).filter(Boolean).map((line) => el('p', { text: line })),
    ]),
  ]);
}

function setBanner(kind, title, body) {
  state.banner = { kind, title, body };
}

// --------------------------------------------------- projects dashboard ---

/**
 * The projects startup screen: start fresh, resume recent work, or open files.
 *
 * This is the front door of Burnhouse. It opens on startup so she doesn't drop
 * into an arbitrary untitled project without context. Everything she needs to
 * continue or begin is laid out cleanly in two cards.
 */
function renderProjectsStep(stage) {
  const container = el('div', { class: 'projects-view' });

  // Hero header
  container.append(
    el('div', { class: 'projects-hero' }, [
      el('h1', { text: 'Welcome to Burnhouse' }),
      el('p', {
        class: 'lede',
        text: 'Make a DVD that plays. Choose a recent project to continue or start fresh.',
      }),
    ])
  );

  const grid = el('div', { class: 'projects-grid' });

  // ---- Left Card: Start Fresh --------------------------------------------
  const newCard = el('div', { class: 'project-card-new' });
  newCard.append(
    el('div', { class: 'panel-head' }, [
      el('h2', { text: 'Start Fresh' }),
      el('span', { class: 'panel-note', text: 'New DVD' }),
    ]),
    el('p', {
      class: 'hint',
      style: 'margin-bottom: 14px',
      text: 'Creates a project with a menu and blank slides ready for your videos.',
    })
  );

  const nameInput = el('input', {
    class: 'input',
    type: 'text',
    value: state.newProjectName,
    placeholder: 'e.g. Vacation 2024, Episodes, Home Movies',
    'aria-label': 'Project name',
  });
  nameInput.addEventListener('input', () => {
    state.newProjectName = nameInput.value;
  });

  newCard.append(
    el('div', { class: 'field' }, [
      el('label', { class: 'label', text: 'Disc title / Project name' }),
      nameInput,
    ])
  );

  // Theme selector
  const themes = (state.presets && state.presets.themes) || [];
  const themeGrid = el('div', { class: 'theme-grid', style: 'margin-bottom: 18px' });
  for (const theme of themes) {
    const swatch = el('button', {
      class: 'theme-swatch',
      type: 'button',
      'aria-pressed': String(state.newProjectTheme === theme.id),
      title: theme.blurb,
    });
    swatch.append(
      el('div', { class: 'swatch-preview', style: `background:${theme.background}` }, [
        el('span', { class: 'swatch-dot', style: `background:${theme.accent}` }),
        el('span', { class: 'swatch-bar', style: `background:${theme.text}` }),
      ]),
      el('span', { class: 'swatch-label', text: theme.label })
    );
    swatch.addEventListener('click', () => {
      state.newProjectTheme = theme.id;
      renderProjectsStep(stage);
    });
    themeGrid.append(swatch);
  }

  newCard.append(
    el('div', { class: 'field' }, [
      el('label', { class: 'label', text: 'Choose a style' }),
      themeGrid,
    ]),
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        style: 'width: 100%; min-height: 38px; font-size: 14px;',
        text: 'Create Project \u2192',
        onclick: () => {
          createNewProject(state.newProjectName, state.newProjectTheme);
        },
      }),
    ]),
    el('div', { class: 'rule', text: 'Or open a file' }),
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn btn-small btn-quiet',
        type: 'button',
        style: 'width: 100%;',
        text: 'Browse Project File\u2026 (.burnhouse)',
        onclick: openProjectDialog,
      }),
    ])
  );

  // ---- Right Card: Recent Projects ---------------------------------------
  const recentPane = el('div', { class: 'recent-projects-pane' });
  recentPane.append(
    el('div', { class: 'panel-head' }, [
      el('h2', { text: 'Recent Projects' }),
      el('span', { class: 'panel-note', text: `${state.recentProjects.length} saved` }),
    ]),
    el('p', { class: 'hint', text: 'Pick up where you left off.' })
  );

  const recentList = el('div', { class: 'recent-list' });
  if (!state.recentProjects.length) {
    recentList.append(
      el('div', { class: 'library-empty', style: 'padding: 40px 10px;' }, [
        el('p', { class: 'dim', text: 'No saved projects yet.' }),
        el('p', {
          class: 'dim',
          style: 'font-size: 11.5px',
          text: 'Name your disc on the left and click Create Project to begin!',
        }),
      ])
    );
  } else {
    for (const item of state.recentProjects) {
      const row = el('div', { class: 'recent-item' });
      const main = el('div', { class: 'recent-item-main' });
      main.append(
        el('div', { class: 'recent-item-title', text: item.name || 'Untitled Project' })
      );

      const meta = el('div', { class: 'recent-item-meta' });
      meta.append(
        el('span', { text: formatRelativeTime(item.modified) }),
        el('span', { class: 'recent-badge', text: `${item.videoCount || 0} videos` }),
        el('span', { class: 'recent-badge', text: `${item.slideCount || 0} slides` })
      );
      if (item.themeId) {
        meta.append(el('span', { class: 'recent-badge', text: item.themeId }));
      }
      main.append(meta);

      const actions = el('div', { class: 'recent-item-actions' });
      actions.append(
        el('button', {
          class: 'btn btn-small btn-primary',
          type: 'button',
          text: 'Open',
          onclick: (e) => {
            e.stopPropagation();
            openProject(item.id || item.filePath);
          },
        }),
        el('button', {
          class: 'icon-btn',
          type: 'button',
          title: 'Remove from recent projects',
          text: '\u2715',
          onclick: (e) => {
            e.stopPropagation();
            deleteRecentProject(item.id);
          },
        })
      );

      row.append(main, actions);
      row.addEventListener('click', () => {
        openProject(item.id || item.filePath);
      });
      recentList.append(row);
    }
  }

  recentPane.append(recentList);

  grid.append(newCard, recentPane);
  container.append(grid);
  stage.replaceChildren(container);
}

function formatRelativeTime(isoString) {
  if (!isoString) return 'recently';
  try {
    const diff = (Date.now() - new Date(isoString).getTime()) / 1000;
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.round(diff / 86400)}d ago`;
    return new Date(isoString).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return 'recently';
  }
}

function createNewProject(name, themeId) {
  state.projectId = 'proj_' + Date.now();
  state.projectFilePath = null;
  state.discTitle = (name || '').trim() || 'My DVD';
  state.newProjectName = 'My DVD';
  state.videos = [];
  state.totalSeconds = 0;
  state.plan = null;
  state.lastBuild = null;
  // Whatever the last project had built says nothing about this one.
  state.buildState = null;
  state.banner = null;

  const tId = themeId || state.newProjectTheme || 'charcoal';
  state.deck = {
    discTitle: state.discTitle,
    themeId: tId,
    buttonStyle: 'bar',
    slides: [
      makeMenuSlide(state.discTitle),
      makeVideoSlide('Slide 2'),
    ],
  };
  state.activeSlideId = state.deck.slides[0].id;
  clearElementSelection();
  state.step = 'slides';

  saveCurrentProject(false);
  render();
}

async function openProject(idOrPath) {
  try {
    const data = await api.project.load(idOrPath);
    state.projectId = data.id || ('proj_' + Date.now());
    state.projectFilePath = data.filePath || null;
    state.discTitle = data.name || data.discTitle || 'My DVD';
    state.videos = Array.isArray(data.videos) ? data.videos : [];
    state.deck = data.deck || {
      discTitle: state.discTitle,
      themeId: 'charcoal',
      buttonStyle: 'bar',
      slides: [],
    };
    ensureStarterSlides();
    clearElementSelection();
    state.lastBuild = null;
    // The previous project's build is not this project's build.
    state.buildState = null;
    state.step = 'slides';
    // No "Project Opened" notice. Opening a project is the normal way in, and
    // announcing it every time just pushes the editor down the window to say
    // something she already knows. Anything that actually goes wrong still
    // reports itself.
    state.banner = null;
    render();
    if (state.videos.length) {
      runInspect();
    }
  } catch (err) {
    setBanner('error', 'Could not open project', String(err.message || err));
    render();
  }
}

async function saveCurrentProject(showToast = true) {
  if (state.step === 'projects') return;
  try {
    const projectData = {
      id: state.projectId || ('proj_' + Date.now()),
      name: state.discTitle || (state.deck && state.deck.discTitle) || 'My DVD',
      discTitle: state.discTitle || 'My DVD',
      filePath: state.projectFilePath,
      videos: state.videos,
      deck: state.deck,
      themeId: state.deck ? state.deck.themeId : 'charcoal',
      activeSlideId: state.activeSlideId,
      modified: new Date().toISOString(),
    };
    const res = await api.project.save(projectData);
    if (res && res.project) {
      state.projectId = res.project.id;
      state.projectFilePath = res.project.filePath;
    }
    api.project.listRecent().then((recent) => {
      state.recentProjects = recent || [];
    });
    if (showToast) {
      setBanner('good', 'Project Saved', `Saved "${projectData.name}"`);
      render();
    }
  } catch (err) {
    if (showToast) {
      setBanner('error', 'Save Failed', String(err.message || err));
      render();
    }
  }
}

async function saveProjectAs() {
  if (state.step === 'projects') return;
  try {
    const res = await api.project.saveDialog(state.discTitle || 'My DVD');
    if (res.canceled || !res.filePath) return;
    state.projectFilePath = res.filePath;
    await saveCurrentProject(true);
  } catch (err) {
    setBanner('error', 'Save As Failed', String(err.message || err));
    render();
  }
}

async function openProjectDialog() {
  try {
    const res = await api.project.openDialog();
    if (res.canceled || !res.filePath) return;
    await openProject(res.filePath);
  } catch (err) {
    setBanner('error', 'Could not open file', String(err.message || err));
    render();
  }
}

async function closeProjectToHome() {
  if (state.step !== 'projects') {
    await saveCurrentProject(false);
  }
  state.step = 'projects';
  clearElementSelection();
  // Closing a project forgets what it had built, so opening another one cannot
  // inherit the answer.
  state.buildState = null;
  state.banner = null;
  api.project.listRecent().then((recent) => {
    state.recentProjects = recent || [];
    render();
  });
  render();
}

async function deleteRecentProject(id) {
  try {
    const updated = await api.project.delete(id);
    state.recentProjects = updated || [];
    render();
  } catch (err) {
    setBanner('error', 'Could not delete project', String(err.message || err));
    render();
  }
}

// ------------------------------------------------------- video library ---

/**
 * The body of the Videos panel: how full the disc is, the list itself, and the
 * button to add more.
 *
 * This is a panel inside the editor, not a page. Adding a video does not
 * navigate anywhere — it appears on the menu slide straight away, which is what
 * "put this on the disc" should feel like.
 */
function buildVideoLibraryBody() {
  const body = el('div', { class: 'library-body', id: 'videoLibrary' });

  body.append(buildCapacityLine());

  body.append(
    el('div', { class: 'btn-row', style: 'margin-bottom: 10px' }, [
      el('button', {
        class: 'btn btn-small btn-primary',
        type: 'button',
        text: 'Add Videos\u2026',
        onclick: promptForVideos,
      }),
    ])
  );

  const list = el('div', { class: 'library-list' });

  if (!state.videos.length) {
    list.append(
      el('div', { class: 'library-empty' }, [
        el('p', { class: 'dim', text: 'No videos yet.' }),
        el('p', {
          class: 'dim',
          style: 'font-size:11.5px',
          text: 'Add them here, or drag files from Finder onto this window.',
        }),
      ])
    );
  }

  state.videos.forEach((video, index) => {
    list.append(buildLibraryItem(video, index));
  });

  body.append(list);

  if (state.videoErrors.length) {
    const failures = el('div', { class: 'library-errors' });
    for (const problem of state.videoErrors) {
      failures.append(
        el('div', {
          class: 'library-error',
          title: problem.error,
          text: `${problem.name} could not be read`,
        })
      );
    }
    body.append(failures);
  }

  body.append(
    el('p', {
      class: 'hint',
      style: 'margin-top: 12px',
      text: 'Drag a video onto a slide to make a button for it.',
    })
  );

  attachVideoDrag(body);
  return body;
}

/**
 * Make the library's video items draggable onto a slide.
 *
 * The drag carries the video's id, which is all a drop target needs. The body
 * gets a class so the cursor and the canvas can show that a drop is possible —
 * without that feedback, dragging a video over a slide looks like nothing will
 * happen.
 */
function attachVideoDrag(panel) {
  panel.addEventListener('dragstart', (event) => {
    const item = event.target.closest && event.target.closest('.library-item');
    if (!item || !item.dataset.id) return;
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('application/x-burnhouse-video', item.dataset.id);
    // Some drop targets only accept a drag that also carries plain text.
    event.dataTransfer.setData('text/plain', item.dataset.id);
    item.classList.add('dragging');
    document.body.classList.add('dragging-video');
  });

  panel.addEventListener('dragend', (event) => {
    const item = event.target.closest && event.target.closest('.library-item');
    if (item) item.classList.remove('dragging');
    document.body.classList.remove('dragging-video');
  });
}

/** One video in the library: draggable, renamable, removable. */
function buildLibraryItem(video, index) {
  const item = el('div', {
    class: 'library-item',
    draggable: 'true',
    dataset: { index: String(index), id: video.id },
  });

  const nameInput = el('input', {
    class: 'video-name-input',
    type: 'text',
    value: video.menuLabel || stripExtension(video.name),
    'aria-label': 'What this video is called on the disc',
  });
  nameInput.addEventListener('input', () => {
    const target = state.videos.find((v) => v.id === video.id);
    if (target) target.menuLabel = nameInput.value;
  });
  nameInput.addEventListener('change', () => {
    // Renaming a video renames it on the menu, which is the whole point of
    // naming it here at all. A dropped tile keeps the name it was dropped
    // with — two places a video can be named, and neither overwrites the
    // other.
    syncMenuSlides();
    refreshCanvas();
  });

  const meta = video.duration
    ? formatDuration(video.duration)
    : video.probe
      ? 'ready'
      : 'reading\u2026';

  item.append(
    el('span', { class: 'video-order', text: String(index + 1) }),
    el('div', { class: 'library-main' }, [
      nameInput,
      el('div', { class: 'video-meta', text: meta }),
    ]),
    el('button', {
      class: 'icon-btn',
      type: 'button',
      title: `Remove ${video.name}`,
      'aria-label': `Remove ${video.name}`,
      text: '\u2715',
      onclick: () => {
        state.videos = state.videos.filter((v) => v.id !== video.id);
        syncMenuSlides();
        persistDeck();
        render();
      },
    })
  );

  return item;
}

/** How full the disc is, as one compact line for the library header. */
function buildCapacityLine() {
  const plan = state.plan;
  const used = plan ? plan.estimatedBytes : 0;
  const capacity = plan ? plan.discCapacityBytes : 4.38e9;
  const percent = plan ? Math.min(100, Math.round((used / capacity) * 100)) : 0;
  const level = percent > 100 ? 'over' : percent > 92 ? 'warn' : 'ok';

  const fill = el('div', { class: 'meter-fill', dataset: { level } });
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;

  return el('div', { class: 'library-capacity' }, [
    el('div', { class: 'meter' }, [fill]),
    el('div', { class: 'meter-legend' }, [
      el('span', {
        text: plan
          ? `${formatBytes(used)} of ${formatBytes(capacity)}`
          : 'Nothing added yet',
      }),
      el('span', { text: plan ? `${percent}%` : '' }),
    ]),
    plan && plan.warning
      ? el('p', { class: 'hint hint-warn', text: plan.warning })
      : null,
  ]);
}

function renderSlidesStep(stage, banner) {
  stage.className = 'stage stage-slides';
  stage.append(
    banner || '',
    el('div', { class: 'editor' }, [
      el('div', { class: 'editor-filmstrip', id: 'filmstrip' }),
      el('div', { class: 'editor-canvas-area' }, [
        el('div', { class: 'editor-toolbar', id: 'editorToolbar' }),
        el('div', { class: 'canvas-holder' }, [
          el('canvas', {
            class: 'slide-canvas',
            id: 'slideCanvas',
            width: String(RASTER.width),
            height: String(RASTER.height),
          }),
        ]),
        el('div', { class: 'canvas-status', id: 'canvasStatus' }),
      ]),
      el('div', { class: 'editor-inspector', id: 'inspector' }),
    ])
  );
}

/**
 * The panel on the right: switches between the design controls and the video
 * list.
 *
 * The videos need to be reachable at all times, because dragging one onto the
 * slide is how a button gets made — but they are a source of things rather than
 * part of the design, so they share this panel instead of taking a column of
 * their own. Four columns squeezed the slide, the thing she is actually working
 * on, down to a thumbnail.
 */
function renderInspector() {
  const panel = $('inspector');
  if (!panel) return;
  panel.replaceChildren();

  const tabs = el('div', { class: 'panel-tabs' }, [
    panelTabButton('design', 'Design'),
    panelTabButton('videos', state.videos.length ? `Videos (${state.videos.length})` : 'Videos'),
  ]);
  panel.append(tabs);

  if (state.panelTab === 'videos') {
    panel.append(buildVideoLibraryBody());
    return;
  }

  const slide = activeSlide();
  if (!slide) {
    panel.append(el('p', { class: 'dim', text: 'No slide selected.' }));
    return;
  }

  /*
    Whatever was just clicked comes first.

    The selected element's properties used to sit below the whole slide panel,
    which on a real window pushed them off the bottom of the screen — so
    clicking a button appeared to do nothing except draw an outline. The thing
    she just selected is the thing she wants to change.

    With nothing selected the slide's own settings come first, so the panel is
    still useful.
  */
  const selected = state.selectedElementId ? findElement(state.selectedElementId).element : null;

  /*
    Two or more selected: the panel becomes a panel of what they share.

    Only properties every selected element actually has are offered, because
    anything else would be a control that silently does nothing to some of them.
    The single-element panel is untouched, so the common case is not disturbed
    by any of this.
  */
  if (selected && state.selectedElementIds.length > 1) {
    panel.append(buildMultiElementInspector(selectedElements()));
    panel.append(el('div', { class: 'rule', text: 'This slide' }));
    panel.append(buildSlideInspector(slide));
    return;
  }

  if (selected) {
    panel.append(buildElementInspector(slide, selected));
    panel.append(el('div', { class: 'rule', text: 'This slide' }));
  }

  panel.append(buildSlideInspector(slide));
}

function panelTabButton(id, label) {
  const button = el('button', {
    type: 'button',
    class: 'panel-tab',
    'aria-pressed': String(state.panelTab === id),
    text: label,
  });
  button.addEventListener('click', () => {
    state.panelTab = id;
    renderInspector();
  });
  return button;
}

function renderFilmstrip() {
  const strip = $('filmstrip');
  if (!strip) return;
  strip.replaceChildren();

  strip.append(
    el('div', { class: 'filmstrip-head' }, [
      el('span', { class: 'rail-title', style: 'margin:0', text: 'Slides' }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        title: 'Add a blank slide',
        text: '+',
        onclick: () => addSlide(),
      }),
    ])
  );

  const list = el('div', { class: 'filmstrip-list' });

  if (!state.deck.slides.length) {
    list.append(
      el('p', {
        class: 'dim',
        style: 'font-size:12px;padding:8px 4px',
        text: 'No slides yet. Add one, or drop a video here.',
      })
    );
  }

  state.deck.slides.forEach((slide, index) => {
    /*
      A slide card that can be dragged to reorder the disc.

      Order is not cosmetic here: it decides which menu page is which, and which
      film plays after which. Dragging a slide is the direct way to say "this
      one comes first", which is much clearer than renumbering anything by hand.

      The drag carries its own type, so the drop router can tell a slide being
      moved from a video being dropped in — the two mean completely different
      things and must not be confused.
    */
    const entry = el('button', {
      class: 'slide-card',
      type: 'button',
      draggable: 'true',
      'aria-pressed': String(slide.id === state.activeSlideId),
      dataset: { slideId: slide.id, index: String(index) },
    });

    // A miniature of the real slide, drawn by the same code as the disc.
    const thumb = el('canvas', { class: 'slide-thumb', width: '180', height: '120' });
    /*
      Filtered, because this is the DOM's own append and not the helper above:
      `append(null)` writes the word "null" onto the card, which is exactly what
      a silent slide then showed under its name.
    */
    entry.append(
      ...[
        el('span', { class: 'slide-number', text: String(index + 1) }),
        thumb,
        el('span', { class: 'slide-card-title', text: slide.title }),
        // Which slides have a sound, at a glance. It cannot be drawn on the slide
        // itself — the menu picture is what goes on the disc, and a speaker mark
        // printed on it would be printed on the disc too.
        slide.audio
          ? el('span', {
              class: 'slide-card-sound',
              text: '\u266a',
              title: `Plays ${slide.audio.fileName || basename(slide.audio.path)}`,
              'aria-label': 'This slide has a sound',
            })
          : null,
      ].filter(Boolean)
    );

    entry.addEventListener('click', () => {
      state.activeSlideId = slide.id;
      clearElementSelection();
      persistDeck();
      render();
    });

    entry.addEventListener('dragstart', (event) => {
      if (!event.dataTransfer) return;
      event.dataTransfer.setData('application/x-burnhouse-slide', slide.id);
      event.dataTransfer.effectAllowed = 'move';
      // Some platforms refuse to start a drag without a payload of some kind.
      event.dataTransfer.setData('text/plain', slide.title);
      strip.classList.add('reordering');
    });

    entry.addEventListener('dragend', () => {
      strip.classList.remove('reordering');
      clearSlideDropMarks(list);
    });

    entry.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.activeSlideId = slide.id;
      clearElementSelection();
      persistDeck();
      render();
      openSlideMenu(event, slide);
    });

    list.append(entry);
    // Drawn after insertion so the canvas has layout.
    requestAnimationFrame(() => drawThumbnail(thumb, slide));
  });

  attachSlideReorder(list);

  strip.append(list);

  strip.append(
    el('div', { class: 'filmstrip-actions' }, [
      el('button', {
        class: 'btn btn-small btn-quiet',
        type: 'button',
        text: 'Add menu slide',
        title: 'Another slide listing every video',
        onclick: () => {
          const ready = state.videos.filter((v) => v.probe || v.duration);
          const index = state.deck.slides.length + 1;
          const slide = makeMenuSlide(
            ready.length ? `Menu ${index}` : state.discTitle || 'Main menu'
          );
          /*
            The list is filled here and now, because asking for a menu slide is
            the deliberate act. It is not filled by dragging a video in — that is
            the thing this button exists instead of.
          */
          slide.elements = [...slide.elements, ...episodeButtons(ready)];
          state.deck.slides.push(slide);
          state.activeSlideId = slide.id;
          persistDeck();
          render();
        },
      }),
      el('button', {
        class: 'btn btn-small btn-quiet',
        type: 'button',
        text: 'Add blank slide',
        onclick: () => addSlide(),
      }),
    ])
  );

  attachFilmstripHighlight(strip);
}

async function drawThumbnail(canvas, slide) {
  const layout = state.layout && state.layout.slides.find((s) => s.slide && s.slide.id === slide.id);
  if (!layout) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  const scale = canvas.width / layout.width;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.imageSmoothingEnabled = true;
  // Match the main canvas: the thumbnail shows the frame as a television will.
  const displayAspect = (state.presets && state.presets.displayAspect) || 16 / 9;
  canvas.style.aspectRatio = `${displayAspect} / 1`;

  // Same decode rule as the canvas, background included, or the filmstrip shows
  // a slide that the canvas does not.
  const images = await loadSlideImages(layout);
  draw.drawSlide(ctx, layout, images);
}

/**
 * Highlight the slide list while a video is being dragged over it.
 *
 * The drop itself is handled by the single router in bindCanvas; this only
 * provides the visual feedback, because a drag with no response looks broken.
 */
function attachFilmstripHighlight(strip) {
  strip.addEventListener('dragover', (event) => {
    if (!dragVideoId(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    strip.classList.add('dragover');
  });
  strip.addEventListener('dragleave', () => strip.classList.remove('dragover'));
  strip.addEventListener('drop', () => strip.classList.remove('dragover'));
}

/**
 * Set a slide's background from a file on disk.
 *
 * Shared by the file picker and by dropping a picture onto the control, so both
 * routes end up with the same picture, treated the same way.
 */
async function setSlideBackgroundFromPath(slide, filePath) {
  try {
    const dataUrl = await api.files.readImage(filePath);
    const prepared = await shrinkPicture(dataUrl, 1600);
    if (!prepared) {
      setBanner(
        'error',
        'That picture could not be read',
        'It may be in a format this computer cannot open. A JPEG or PNG will always work.'
      );
      render();
      return false;
    }
    slide.backgroundImage = prepared;
    if (!slide.backgroundFit) slide.backgroundFit = 'cover';
    persistDeck();
    refreshCanvas();
    renderInspector();
    return true;
  } catch (err) {
    setBanner('error', 'That picture could not be used', String(err.message || err));
    render();
    return false;
  }
}

/** Choose a picture to sit behind a slide, through the file picker. */
async function chooseSlideBackground(slide) {
  try {
    const result = await api.files.pickImage();
    if (result.canceled) return;
    await setSlideBackgroundFromPath(slide, result.path);
  } catch (err) {
    setBanner('error', 'Could not open the file chooser', String(err.message || err));
    render();
  }
}

/**
 * Accept a picture dropped straight onto the background control.
 *
 * Dragging a picture onto the thing it becomes is the shortest possible way to
 * do it, and it is what everybody tries before they look for a button. The drop
 * is claimed here — `stopPropagation` — because the rest of the window treats a
 * dropped file as a video to put on the disc, which is not what this is.
 */
function attachBackgroundDropTarget(zone, slide) {
  const clear = () => zone.classList.remove('bg-drop-active');

  zone.addEventListener('dragover', (event) => {
    // Only pictures, and only files: an in-app video drag has no business here.
    const types = (event.dataTransfer && event.dataTransfer.types) || [];
    if (!Array.prototype.includes.call(types, 'Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    zone.classList.add('bg-drop-active');
  });

  zone.addEventListener('dragleave', (event) => {
    if (event.relatedTarget && zone.contains(event.relatedTarget)) return;
    clear();
  });

  zone.addEventListener('drop', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    clear();

    const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
    if (!files.length) return;

    const paths = pathsFromFiles(files);
    if (!paths.length) {
      setBanner(
        'info',
        'Use the button instead',
        'Dragging did not provide a file location. Press "Use a picture" and choose it.'
      );
      render();
      return;
    }

    // The first picture wins; a stray video among them gets a straight answer
    // rather than being silently turned into a background.
    const picture = paths.find((p) => looksLikeImage(p));
    if (!picture) {
      setBanner(
        'info',
        'That is not a picture',
        paths.some((p) => looksLikeVideo(p))
          ? 'Videos go on the disc as a video or a tile. A background has to be an image.'
          : 'A background has to be an image file, such as a JPEG or a PNG.'
      );
      render();
      return;
    }

    await setSlideBackgroundFromPath(slide, picture);
  });
}

/** Remove the "drop here" marks from every slide card. */
function clearSlideDropMarks(list) {
  if (!list) return;
  for (const card of list.querySelectorAll('.slide-card')) {
    card.classList.remove('drop-before', 'drop-after');
  }
}

/** The id of the slide being dragged, or null. */
function slideDragId(event) {
  if (!event.dataTransfer) return null;
  return event.dataTransfer.getData('application/x-burnhouse-slide') || null;
}

/**
 * Dropping one slide onto another to change the order.
 *
 * The mark shows which side of the target the slide will land on, because
 * "before" and "after" are a coin toss otherwise, and getting it wrong silently
 * reorders the disc.
 */
function attachSlideReorder(list) {
  list.addEventListener('dragover', (event) => {
    const dragging = slideDragId(event);
    if (!dragging) return;

    // Claimed even over the gaps between cards, so the window's file-drop
    // styling does not appear for a slide being moved.
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';

    const card = event.target.closest && event.target.closest('.slide-card');
    clearSlideDropMarks(list);
    if (!card) return;
    if (card.dataset.slideId === dragging) return;

    const rect = card.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    card.classList.add(after ? 'drop-after' : 'drop-before');
  });

  list.addEventListener('drop', (event) => {
    const dragging = slideDragId(event);
    if (!dragging) return;

    const card = event.target.closest && event.target.closest('.slide-card');
    if (!card) return;

    event.preventDefault();
    event.stopPropagation();

    const rect = card.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    clearSlideDropMarks(list);
    moveSlideNextTo(dragging, card.dataset.slideId, after);
  });
}

function renderEditorToolbar() {
  const bar = $('editorToolbar');
  if (!bar) return;
  bar.replaceChildren();

  const slide = activeSlide();
  const index = state.deck.slides.findIndex((s) => s.id === state.activeSlideId);

  bar.append(
    el('div', { class: 'toolbar-group' }, [
      el('button', {
        class: 'btn btn-small',
        type: 'button',
        text: '+ Text',
        title: 'Add words to this slide',
        onclick: () => addElement('text'),
      }),
      el('button', {
        class: 'btn btn-small',
        type: 'button',
        text: '+ Picture\u2026',
        title: 'Add a picture to this slide',
        onclick: pickPicture,
      }),
      el('button', {
        class: 'btn btn-small',
        type: 'button',
        text: '+ Sound\u2026',
        title: 'Play a sound or a song while this menu page is on screen',
        onclick: addSoundToSlide,
      }),
      el('button', {
        class: 'btn btn-small',
        type: 'button',
        text: '+ Panel',
        title: 'A shaded box to group things',
        onclick: () => addElement('frame'),
      }),
      el('button', {
        class: 'btn btn-small',
        type: 'button',
        text: '+ Video',
        title: 'Put one of your videos on this slide',
        onclick: addVideoTile,
      }),
      el('button', {
        class: 'btn btn-small',
        type: 'button',
        text: '+ Button',
        title: 'A button that goes to another slide',
        onclick: addManualButton,
      }),
    ]),
    el('div', { class: 'toolbar-group' }, [
      el('button', {
        class: 'btn btn-small btn-quiet',
        type: 'button',
        text: state.showSafeArea ? 'Guides on' : 'Guides off',
        title: 'Show the area some televisions crop off',
        onclick: () => {
          state.showSafeArea = !state.showSafeArea;
          api.settings.set({ showSafeArea: state.showSafeArea }).catch(() => {});
          renderEditorToolbar();
          drawCanvas();
        },
      }),
    ]),
    el('div', { class: 'toolbar-spacer' }),
    el('div', { class: 'toolbar-group' }, [
      el('button', {
        class: 'icon-btn',
        type: 'button',
        title: 'Move this slide earlier',
        text: '\u2190',
        disabled: index <= 0,
        onclick: () => moveSlide(state.activeSlideId, -1),
      }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        title: 'Move this slide later',
        text: '\u2192',
        disabled: index < 0 || index >= state.deck.slides.length - 1,
        onclick: () => moveSlide(state.activeSlideId, 1),
      }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        title: 'Duplicate this slide',
        text: '\u29c9',
        disabled: !slide,
        onclick: () => duplicateSlide(state.activeSlideId),
      }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        title: 'Delete this slide',
        text: '\u2715',
        disabled: !slide || state.deck.slides.length <= 1,
        onclick: () => deleteSlide(state.activeSlideId),
      }),
    ])
  );

  const status = $('canvasStatus');
  if (status) {
    const layout = activeSlideLayout();
    const problems = (state.layout && state.layout.problems) || [];
    status.replaceChildren();
    if (layout && layout.buttons.length > MAX_BUTTONS_PER_SLIDE) {
      status.append(
        el('span', {
          class: 'hint-warn',
          text: `This slide has ${layout.buttons.length} buttons. A DVD menu holds ${MAX_BUTTONS_PER_SLIDE} comfortably \u2014 move some to another slide.`,
        })
      );
    } else if (problems.length) {
      status.append(el('span', { class: 'hint-warn', text: problems[0] }));
    } else {
      status.append(
        el('span', {
          class: 'dim',
          text:
            'Drag a video from the Videos panel onto this slide to make a button that ' +
            'plays it, or drop a picture here to place it.',
        })
      );
    }
  }
}

/**
 * Put a video on an episode slide from the toolbar.
 *
 * If she is on the 1st menu slide, it automatically creates a new episode slide
 * and puts the video there, so the menu slide is never cluttered.
 * The video tile is sized full-screen, perfectly centered, ready to burn.
 */
function addVideoTile() {
  let targetSlide = activeSlide();
  if (!targetSlide || targetSlide.role === 'menu' || state.deck.slides.indexOf(targetSlide) === 0) {
    let found = state.deck.slides.find((s) => s.role !== 'menu' && s.elements.filter((e) => e.kind === 'video').length === 0);
    if (!found) {
      found = addSlideAtEnd();
    }
    targetSlide = found;
    state.activeSlideId = targetSlide.id;
  }

  const onThisSlide = new Set(
    targetSlide.elements
      .filter((e) => e.kind === 'video' && e.videoId)
      .map((e) => e.videoId)
  );
  const ready = state.videos.filter((v) => v.probe || v.duration);
  const next = ready.find((v) => !onThisSlide.has(v.id)) || ready[0];

  if (!next) {
    setBanner('info', 'No videos to add yet', 'Open the Videos tab and press Add Videos.');
    render();
    return;
  }

  dropVideoOnCanvas(next);
}

function addManualButton() {
  const others = state.deck.slides.filter((s) => s.id !== state.activeSlideId);
  const slide = activeSlide();
  if (others.length === 0) {
    const target = addSlide({ title: 'Second slide' });
    addElement('button', { label: 'Go to slide 2', targetSlideId: target.id });
    return;
  }
  addElement('button', { label: 'Go to another slide', targetSlideId: others[0].id });
}

/**
 * Put a picture on the current slide.
 *
 * The one route a picture takes onto a slide, whether it was chosen through the
 * file picker or dropped on the canvas, so the two cannot end up different in
 * size, in shape, or in how the file is read and downscaled.
 *
 * `step` staggers a drop of several. Without it they would all be placed at the
 * same starting point and would look like a single picture, with the others
 * hidden underneath.
 */
async function addPictureFromPath(path, step = 0) {
  const src = await api.files.readImage(path);
  return addElement('image', {
    src,
    fileName: basename(path),
    ...(step ? { x: 120 + step * 26, y: 140 + step * 26 } : {}),
  });
}

async function pickPicture() {
  try {
    const result = await api.files.pickImage();
    if (result.canceled) return;
    await addPictureFromPath(result.path);
  } catch (err) {
    setBanner('error', 'That picture could not be used', String(err.message || err));
    render();
  }
}

// ------------------------------------------------------------ menu sound ---

/** How long a page's sound may run. Comes from the deck, which enforces it. */
function menuSoundSecondsCap() {
  const presets = state.presets || {};
  return Number.isFinite(presets.menuSoundMaxSeconds) && presets.menuSoundMaxSeconds > 0
    ? presets.menuSoundMaxSeconds
    : 90;
}

/**
 * The message for a sound, so every place that shows one says the same thing.
 *
 * A trimmed sound says so: the disc will play part of her song, and finding that
 * out from the television rather than from the panel would be a nasty surprise.
 */
function describeSound(sound) {
  if (!sound || !sound.path) return 'Nothing chosen yet.';
  const cap = menuSoundSecondsCap();
  const plays = Number(sound.seconds) || 0;
  if (sound.duration > 0) {
    const trimmed = sound.duration > plays + 0.5;
    return trimmed
      ? `${formatDuration(plays)} of it will play, out of ${formatDuration(sound.duration)} — a menu page is capped at ${formatDuration(cap)}.`
      : `${formatDuration(sound.duration)} — all of it will play.`;
  }
  return `The length could not be read, so the page will run for ${formatDuration(cap)}.`;
}

/**
 * Set a slide's sound from a file on disk.
 *
 * Shared by the picker and by dropping a sound file on a slide, so both routes
 * end up with the same sound treated the same way.
 */
async function setSlideSoundFromPath(slide, filePath) {
  if (!slide) return false;
  try {
    const info = await api.files.probeAudio(filePath);
    const cap = menuSoundSecondsCap();
    const duration = Math.max(0, Number(info && info.duration) || 0);

    slide.audio = {
      path: filePath,
      fileName: basename((info && info.name) || filePath),
      duration,
      seconds: duration > 0 ? Math.min(cap, duration) : cap,
    };

    persistDeck();
    refreshCanvas();
    renderInspector();

    if (info && info.unreadable) {
      setBanner(
        'info',
        'That sound could not be measured',
        'It will still be used. The page will run for the longest length a menu is ' +
          'allowed, and the disc will be silent in that spot if the file cannot be read at all.'
      );
      render();
    }
    return true;
  } catch (err) {
    setBanner('error', 'That sound could not be used', String(err.message || err));
    render();
    return false;
  }
}

/** Choose a sound for this menu page, through the file picker. */
async function chooseSlideSound(slide) {
  try {
    const result = await api.files.pickAudio();
    if (result.canceled) return;
    await setSlideSoundFromPath(slide, result.path);
  } catch (err) {
    setBanner('error', 'Could not open the file chooser', String(err.message || err));
    render();
  }
}

/** The + Sound button: a sound for the page being looked at. */
async function addSoundToSlide() {
  const slide = activeSlide();
  if (!slide) {
    setBanner('info', 'Add a slide first', 'A sound belongs to a menu page.');
    render();
    return;
  }
  await chooseSlideSound(slide);
}

/**
 * A Listen button for a chosen sound.
 *
 * Its own little player rather than the browser's own controls, because the
 * point is to check the file is the right one, not to be a music player. The
 * label is changed in place rather than by redrawing, so pressing it does not
 * rebuild the panel around it.
 */
function buildSoundPreview(path) {
  const button = el('button', {
    class: 'btn btn-small btn-quiet',
    type: 'button',
    text: 'Listen',
  });

  let audio = null;

  button.addEventListener('click', async () => {
    if (audio && !audio.paused) {
      audio.pause();
      button.textContent = 'Listen';
      return;
    }
    if (!audio) {
      try {
        const urls = await api.files.mediaUrls([path]);
        const url = urls && urls[path];
        if (!url) throw new Error('the file could not be found');
        audio = new Audio(url);
        audio.addEventListener('ended', () => {
          button.textContent = 'Listen';
        });
      } catch (err) {
        setBanner('error', 'That sound could not be played', String(err.message || err));
        render();
        return;
      }
    }
    const attempt = audio.play();
    if (attempt && attempt.catch) attempt.catch(() => {});
    button.textContent = 'Stop';
  });

  return button;
}

// ------------------------------------------------------------ inspector ---


function buildSlideInspector(slide) {
  const themes = (state.presets && state.presets.themes) || [];

  const themeGrid = el('div', { class: 'theme-grid' });
  for (const theme of themes) {
    const swatch = el('button', {
      class: 'theme-swatch',
      type: 'button',
      'aria-pressed': String((slide.themeId || state.deck.themeId) === theme.id),
      title: theme.blurb,
    });
    // "None" is the absence of a background, so its swatch shows nothing rather
    // than the usual accent dot and text bar — otherwise it reads as just
    // another dark theme.
    swatch.append(
      theme.plain
        ? el('div', { class: 'swatch-preview swatch-empty' })
        : el('div', { class: 'swatch-preview', style: `background:${theme.background}` }, [
            el('span', { class: 'swatch-dot', style: `background:${theme.accent}` }),
            el('span', { class: 'swatch-bar', style: `background:${theme.text}` }),
          ]),
      el('span', { class: 'swatch-label', text: theme.label })
    );
    swatch.addEventListener('click', () => {
      slide.themeId = theme.id;
      state.deck.themeId = theme.id;
      persistDeck();
      refreshCanvas();
      renderInspector();
    });
    themeGrid.append(swatch);
  }

  /*
    A picture of her own behind the slide.

    The picture is washed toward the theme's colour when it is drawn, so the
    words and buttons on top stay readable — which is why this sits right under
    the background style rather than in a section of its own.
  */
  const hasBackground = Boolean(slide.backgroundImage);

  /** Take the custom picture off this slide. */
  const removeBackground = () => {
    slide.backgroundImage = null;
    persistDeck();
    refreshCanvas();
    renderInspector();
  };

  /*
    The picture, with a way out on top of it.

    A background picture could be replaced but not removed from anywhere
    obvious: the button that did it sat below the picture as another grey
    rectangle among several, which is not where anybody looks for "get rid of
    this". Hovering the picture now covers it with a cross, and pressing that
    takes the picture away — the control is on the thing it acts on.
  */
  const backgroundPreview = hasBackground
    ? el('div', { class: 'bg-preview-wrap' }, [
        el('div', {
          class: 'bg-preview',
          style: `background-image:url("${slide.backgroundImage}")`,
        }),
        el('button', {
          class: 'bg-preview-remove',
          type: 'button',
          title: 'Remove the background picture',
          'aria-label': 'Remove the background picture',
          onclick: removeBackground,
        }, [el('span', { class: 'bg-preview-x', text: '\u2715' })]),
      ])
    : null;

  const backgroundRow = el('div', { class: 'btn-row' }, [
    el('button', {
      class: 'btn btn-small',
      type: 'button',
      text: hasBackground ? 'Replace the picture\u2026' : 'Use a picture\u2026',
      onclick: () => chooseSlideBackground(slide),
    }),
  ]);

  const backgroundFit = hasBackground
    ? el('div', { class: 'segmented wide' }, [
        segmentedButton('Fill the frame', (slide.backgroundFit || 'cover') === 'cover', () => {
          slide.backgroundFit = 'cover';
          persistDeck();
          refreshCanvas();
          renderInspector();
        }),
        segmentedButton('Whole picture', slide.backgroundFit === 'contain', () => {
          slide.backgroundFit = 'contain';
          persistDeck();
          refreshCanvas();
          renderInspector();
        }),
      ])
    : null;

  /*
    How much the picture behind is darkened.

    A picture put behind a slide has always been washed toward the theme colour
    so the words and buttons on top of it stay readable. That wash is right for
    a busy holiday photo and wrong for a dark, quiet one — so it is hers to move.
    1 is the wash it has always had, 0 leaves the picture exactly as it came out
    of the camera.

    Dragging only redraws; the deck is written when she lets go, so a slider
    being moved does not write the project file sixty times.
  */
  const dimValue = typeof slide.backgroundDim === 'number' ? slide.backgroundDim : 1;
  const dimReadout = el('span', {
    class: 'dim-readout',
    text: dimValue === 0 ? 'Original' : Math.round(dimValue * 100) + '%',
  });
  const dimSlider = el('input', {
    class: 'dim-range',
    type: 'range',
    min: '0',
    max: '1',
    step: '0.05',
    value: String(dimValue),
    'aria-label': 'How dark the background picture is',
  });
  dimSlider.addEventListener('input', () => {
    slide.backgroundDim = Number(dimSlider.value);
    dimReadout.textContent = slide.backgroundDim === 0 ? 'Original' : Math.round(slide.backgroundDim * 100) + '%';
    // Only the picture, not the panel. A full refresh replaces the inspector's
    // DOM, and the slider is inside it — so the element being dragged is thrown
    // away on the first movement and the drag ends there, one step per grab.
    refreshCanvasOnly();
  });
  dimSlider.addEventListener('change', () => {
    slide.backgroundDim = Number(dimSlider.value);
    persistDeck();
    refreshCanvas();
  });

  const backgroundDim = hasBackground
    ? el('div', { class: 'field' }, [
        el('label', { class: 'label', text: 'Darkening' }),
        el('div', { class: 'dim-row' }, [dimSlider, dimReadout]),
      ])
    : null;

  const titleField = el('input', {
    class: 'input',
    type: 'text',
    value: slide.title,
    maxlength: '40',
    'aria-label': 'Name for this slide',
    // Named so the slide's right-click menu can put the caret in it.
    dataset: { field: 'slide-title' },
  });
  titleField.addEventListener('input', () => {
    slide.title = titleField.value;
    persistDeck();
    renderFilmstrip();
  });

  const applyAll = el('button', {
    class: 'btn btn-small',
    type: 'button',
    text: 'Use this look on every slide',
    onclick: () => {
      for (const s of state.deck.slides) s.themeId = slide.themeId;
      persistDeck();
      refreshCanvas();
      render();
    },
  });

  /*
    The background picture block, which is also a drop target: a picture dragged
    onto it becomes the background. Built first so the drop handling can be
    attached before it goes into the panel.
  */
  const backgroundField = el('div', { class: 'field bg-drop' }, [
    el('label', { class: 'label', text: 'Background picture' }),
    backgroundPreview,
    backgroundRow,
    backgroundFit,
    backgroundDim,
    el('p', {
      class: 'hint',
      text: hasBackground
        ? 'Drawn behind everything. Darkening decides how far the picture is washed toward the background colour, so the words on top stay readable. Point at the picture to remove it, or drop another one here to swap it.'
        : 'Optional. Drag a picture straight onto this box, or press the button.',
    }),
  ]);
  attachBackgroundDropTarget(backgroundField, slide);

  /*
    The sound this page plays.

    A DVD menu page has exactly one sound track, so this is a property of the
    page rather than an element on it: "one more thing on the slide" would imply
    several, or a place on the picture, and neither means anything on a disc.
    It is here rather than behind a menu because it is a design decision like the
    background picture beside it — both are what the page *is*, not what is
    printed on it.
  */
  const sound = slide.audio;
  const soundField = el('div', { class: 'field' }, [
    el('label', { class: 'label', text: 'Menu sound' }),
    sound
      ? el('div', { class: 'sound-row' }, [
          el('span', {
            class: 'sound-mark',
            text: '\u266a',
            'aria-hidden': 'true',
          }),
          el('div', { class: 'sound-main' }, [
            el('span', {
              class: 'sound-name',
              text: sound.fileName || basename(sound.path),
              title: sound.path,
            }),
            el('span', { class: 'sound-meta', text: describeSound(sound) }),
          ]),
        ])
      : el('p', { class: 'hint', text: 'Nothing chosen, so this page is silent.' }),
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn btn-small',
        type: 'button',
        text: sound ? 'Replace the sound\u2026' : 'Choose a sound\u2026',
        onclick: () => chooseSlideSound(slide),
      }),
      sound ? buildSoundPreview(sound.path) : null,
      sound
        ? el('button', {
            class: 'btn btn-small btn-quiet',
            type: 'button',
            text: 'Remove',
            onclick: () => {
              slide.audio = null;
              persistDeck();
              refreshCanvas();
              renderInspector();
            },
          })
        : null,
    ].filter(Boolean)),
    sound
      ? el('p', {
          class: 'hint',
          text:
            'Plays while this page is on screen. When it ends the page waits for the ' +
            'remote as usual, so a long song does not hold anything up. Drop a sound ' +
            'file on the slide to use it.',
        })
      : null,
  ]);

  return el('div', {}, [
    el('div', { class: 'rail-title', text: 'Slide ' + (state.deck.slides.indexOf(slide) + 1) }),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', text: 'Name (only you see this)' }),
      titleField,
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', text: 'Background style' }),
      themeGrid,
    ]),
    backgroundField,
    soundField,
    el('div', { class: 'btn-row' }, [applyAll]),
    el('div', { class: 'rule', text: 'This slide' }),
    el('p', {
      class: 'hint',
      text: 'Everything you change here is only on this slide.',
    }),
  ]);
}

/**
 * Re-encode a picture at no more than `maxWidth` across.
 *
 * Returns null when the picture cannot be decoded, so the caller can say so
 * rather than storing something that will never appear.
 */
async function shrinkPicture(dataUrl, maxWidth) {
  const image = await loadImage(dataUrl);
  if (!image || !image.naturalWidth) return null;

  const scale = Math.min(1, maxWidth / image.naturalWidth);
  const width = Math.max(2, Math.round(image.naturalWidth * scale));
  const height = Math.max(2, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);

  // JPEG, because a menu background has nothing to be transparent about and a
  // photograph is several times smaller this way.
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** A button for one of a set of mutually exclusive choices. */
function segmentedButton(label, pressed, onClick) {
  const button = el('button', { type: 'button', text: label, 'aria-pressed': String(pressed) });
  button.addEventListener('click', onClick);
  return button;
}

/**
 * A property table, laid out the way a scene editor shows one: a muted name
 * column, an editable value column, and category headings that fold away.
 *
 * Values are borderless until hovered, so a long list reads as data rather than
 * as a wall of input boxes.
 */
function propTable(groups) {
  const table = el('div', { class: 'prop-table' });

  for (const group of groups) {
    if (!group.rows || !group.rows.length) continue;

    const head = el(
      'button',
      {
        class: 'prop-group',
        type: 'button',
        'data-collapsed': String(Boolean(group.collapsed)),
        'aria-expanded': String(!group.collapsed),
      },
      [el('span', { class: 'prop-caret', text: '\u25bc' }), el('span', { text: group.title })]
    );
    head.addEventListener('click', () => {
      const collapsed = head.dataset.collapsed === 'true';
      head.dataset.collapsed = String(!collapsed);
      head.setAttribute('aria-expanded', String(collapsed));
    });

    const rows = el('div', { class: 'prop-rows' });
    for (const row of group.rows) rows.append(row);

    table.append(head, rows);
  }

  return table;
}

/**
 * One name/value line.
 *
 * `name` is the filter key and is what the property filter searches, so it stays
 * the plain identifier. `label` is what she reads, for the rows where the
 * identifier is not a phrase — "GoToSlide" is a name for a variable, not for a
 * thing, and the panel is hers to read.
 */
function propRow(name, control, label) {
  const row = el('div', { class: 'prop-row' });
  row.dataset.prop = String(name).toLowerCase();
  const value = el('span', { class: 'prop-value' });
  value.append(control);
  const shown = label || name;
  row.append(el('span', { class: 'prop-name', text: shown, title: shown }), value);
  return row;
}

function propText(value, onInput, options = {}) {
  const input = el('input', { type: 'text', value: value || '' });
  if (options.field) input.dataset.field = options.field;
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

function propArea(value, onInput, options = {}) {
  const area = el('textarea', { rows: String(options.rows || 3) });
  if (options.field) area.dataset.field = options.field;
  area.value = value || '';
  area.addEventListener('input', () => onInput(area.value));
  return area;
}

/**
 * A number field.
 *
 * `min` defaults to 0 and `min: null` means no floor at all — which is what a
 * picture's position needs, since a picture may be dragged off the slide and
 * typing a negative number is then the only way back to it.
 */
function propNumber(value, onChange, options = {}) {
  const floor = options.min === undefined ? 0 : options.min;
  const unbounded = floor === null;
  const ceiling = options.max === undefined ? undefined : options.max;
  const input = el('input', {
    type: 'number',
    value: String(Math.round((Number(value) || 0) * 100) / 100),
    min: unbounded ? null : String(floor),
    max: ceiling === undefined ? null : String(ceiling),
    step: options.step === undefined ? '1' : String(options.step),
  });
  input.addEventListener('change', () => {
    let next = Number(input.value);
    if (!Number.isFinite(next)) next = unbounded ? 0 : floor;
    if (!unbounded) next = Math.max(floor, next);
    if (ceiling !== undefined) next = Math.min(ceiling, next);
    onChange(next);
  });
  return input;
}

function propCheck(checked, onChange) {
  const input = el('input', { class: 'prop-check', type: 'checkbox' });
  input.checked = Boolean(checked);
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

function propSelect(choices, current, onChange) {
  const select = el('select', {});
  for (const choice of choices) {
    select.append(
      el('option', {
        value: choice.value,
        text: choice.label,
        selected: choice.value === current,
      })
    );
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

/** A colour: a swatch beside the list of choices, as a scene editor shows it. */
function propColor(choices, current, onChange) {
  const swatch = el('span', { class: 'prop-swatch' });
  const paint = () => {
    const found = choices.find((c) => c.value === current);
    swatch.style.background = found ? found.color : '#888';
  };
  paint();

  const select = propSelect(choices, current, (value) => {
    current = value;
    paint();
    onChange(value);
  });

  return el('span', { class: 'prop-color' }, [swatch, select]);
}

function buildElementInspector(slide, element) {
  const panel = el('div', {});

  const kindName =
    element.kind === 'button' ? 'Button' :
    element.kind === 'video' ? 'Video' :
    element.kind === 'text' ? 'Text' :
    element.kind === 'image' ? 'Picture' : 'Panel';

  panel.append(el('div', { class: 'rail-title', text: kindName }));

  /*
    "There is something under this."

    A picture with a transparent background is a wall across the slide: it
    catches every click, and the smaller things behind it look unreachable. The
    click-through solves that, but nobody looks for a gesture whose need they
    cannot see, so when there *is* something underneath, the panel says so.
  */
  const beneath = elementsBeneath(element, activeSlideLayout());
  if (beneath.length) {
    panel.append(
      el('p', {
        class: 'prop-hint',
        text:
          (beneath.length === 1
            ? 'One thing is tucked behind this one'
            : beneath.length + ' things are tucked behind this one') +
          '. Press the same spot again to reach ' +
          (beneath.length === 1 ? 'it' : 'them') +
          '.',
      })
    );
  }

  // Every change goes through here, so saving and redrawing cannot be forgotten
  // on one control out of twenty.
  //
  // `rebuild` is for the rare change that alters what the inspector itself
  // should show — choosing a different video renames the tile, so the rows have
  // to be rebuilt. Everything else redraws the slide and leaves the panel, and
  // the cursor in it, where they are.
  const apply = (patch, options = {}) => {
    Object.assign(element, patch);
    persistDeck();
    if (options.rebuild) refreshCanvas();
    else refreshCanvasOnly();
  };

  const theme = currentTheme();
  const colorChoices = Object.keys(theme || {})
    .filter((key) => typeof theme[key] === 'string' && /^#/.test(theme[key]))
    .map((key) => ({ value: key, label: key, color: theme[key] }));

  /** Rows shared by anything that has lettering. */
  const letteringRows = () => {
    const fonts = (state.presets && state.presets.fonts) || [];
    return [
      propRow('Lettering', propSelect(
        fonts.map((f) => ({ value: f.id, label: f.label })),
        element.fontId,
        (value) => apply({ fontId: value })
      )),
      /*
        A size typed in pixels.

        The named sizes stay as starting points (see elementFontPx), but the
        number is what she can actually set. It shows the size in use, so opening
        the panel on a preset tells her what that preset is worth.
      */
      propRow('TextSize', propNumber(
        elementFontPx(element),
        (value) => apply({ textPx: value }),
        { min: textSizeBounds().min, max: textSizeBounds().max }
      )),
      propRow('TextAlign', propSelect(
        [
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Centre' },
          { value: 'right', label: 'Right' },
        ],
        element.align || 'left',
        (value) => apply({ align: value })
      )),
      colorChoices.length
        ? propRow('TextColor', propColor(colorChoices, element.color, (value) => apply({ color: value })))
        : null,
    ].filter(Boolean);
  };

  /** The box behind the words, shown or not, solid or see-through. */
  const backgroundRows = (choices) => [
    propRow('Background', propSelect(
      [{ value: 'none', label: 'None' }].concat(choices),
      element.background || 'none',
      (value) => apply({ background: value })
    )),
    propRow('BgTransparency', propNumber(
      element.backgroundTransparency || 0,
      (value) => apply({ backgroundTransparency: value }),
      { min: 0, max: 1, step: 0.05 }
    )),
  ];

  /*
    A picture has no position limits, so its X and Y accept a negative number —
    which is the only way to bring one back if it has been dragged clear off the
    slide. Everything else is held on the slide, so 0 is its floor and typing a
    minus sign means nothing.
  */
  const positionFloor = element.kind === 'image' ? null : 0;

  const layoutRows = () => [
    propRow('PositionX', propNumber(element.x, (v) => { element.x = v; clampElementInPlace(element); apply({}, { rebuild: true }); }, { min: positionFloor }), 'Position X'),
    propRow('PositionY', propNumber(element.y, (v) => { element.y = v; clampElementInPlace(element); apply({}, { rebuild: true }); }, { min: positionFloor }), 'Position Y'),
    propRow('Width', propNumber(element.width, (v) => { element.width = v; clampElementInPlace(element); apply({}, { rebuild: true }); }, { min: MIN_ELEMENT_WIDTH })),
    propRow('Height', propNumber(element.height, (v) => { element.height = v; if (element.kind === 'text') element.autoHeight = false; clampElementInPlace(element); apply({}, { rebuild: true }); }, { min: MIN_ELEMENT_HEIGHT })),
    /*
      Lower numbers sit in front. A button set to 1 covers one set to 2, which is
      the way round she asked for. Zero is the default, so nothing that has never
      been given a priority changes places.
    */
    propRow('Priority', propNumber(element.priority || 0, (value) => apply({ priority: Math.round(value) }, { rebuild: true }), { min: -99, max: 99 })),
    // 0 is square. The drawing clamps it to half the shorter side, because a
    // bigger radius than that has no meaning.
    propRow('Roundness', propNumber(element.roundness || 0, (value) => apply({ roundness: Math.round(value) }, { rebuild: true }), { min: 0, max: 200 })),
  ];

  const groups = [];

  if (element.kind === 'video') {
    const ready = state.videos.filter((v) => v.probe || v.duration);
    const appearance = [
      propRow('Name', propText(element.label, (value) => apply({ label: value }))),
      // Which film this tile shows and plays. Distinct from a button's target:
      // a tile *is* the video, it does not point at one.
      propRow('Plays', propSelect(
        [{ value: '', label: 'Choose a video\u2026' }].concat(
          ready.map((v) => ({ value: v.id, label: videoLabel(v) }))
        ),
        element.videoId || '',
        (value) => {
          const chosen = state.videos.find((v) => v.id === value);
          if (!chosen) return apply({ videoId: null }, { rebuild: true });
          apply({
            videoId: chosen.id,
            label: videoLabel(chosen),
            sublabel: chosen.duration ? formatDuration(chosen.duration) : '',
            src: chosen.poster || null,
            posterMissing: !chosen.poster,
          }, { rebuild: true });
        }
      )),
      propRow('Picture', propSelect(
        [
          { value: 'fit', label: 'Whole frame' },
          { value: 'fill', label: 'Fill the tile' },
        ],
        element.fit || 'fit',
        (value) => apply({ fit: value })
      )),
      propRow('ShowName', propCheck(element.showLabel !== false, (checked) => apply({ showLabel: checked }))),
      propRow('FitToSlide', el('button', {
        class: 'btn btn-small btn-quiet',
        type: 'button',
        text: 'Reset size',
        onclick: () => refitElement(element.id),
      })),
    ];
    groups.push({ title: 'Appearance', rows: appearance });
    groups.push({ title: 'Text', rows: letteringRows() });
    groups.push({ title: 'Layout', rows: layoutRows() });
  }

  if (element.kind === 'text') {
    groups.push({
      title: 'Appearance',
      rows: [
        propRow('Text', propArea(element.text, (value) => apply({ text: value, edited: true }), { field: 'text' })),
        ...letteringRows(),
        ...backgroundRows(colorChoices),
      ],
    });
    groups.push({ title: 'Layout', rows: layoutRows() });
  }

  if (element.kind === 'button') {
    groups.push({
      title: 'Appearance',
      rows: [
        propRow('Text', propText(
          element.label,
          (value) => apply({ label: value, labelEdited: true }),
          { field: 'label' }
        )),
        propRow('Style', propSelect(
          (((state.presets && state.presets.buttonStyles) || []).map((s) => ({ value: s.id, label: s.label }))),
          element.buttonStyle || 'bar',
          (value) => apply({ buttonStyle: value })
        )),
        propRow('ShowNumber', propCheck(element.showNumber, (checked) => {
          const patch = { showNumber: checked };
          if (checked && !element.number) {
            const siblings = slide.elements.filter((e) => e.kind === 'button');
            patch.number = siblings.indexOf(element) + 1;
          }
          apply(patch);
        })),
        ...letteringRows(),
        propRow('BgTransparency', propNumber(
          element.backgroundTransparency || 0,
          (value) => apply({ backgroundTransparency: value }),
          { min: 0, max: 1, step: 0.05 }
        )),
      ],
    });
    groups.push({
      title: 'Behaviour',
      rows: [
        /*
          Where the button goes. There is deliberately no "plays a video" row:
          a button that should start a film points at the slide holding that
          film, and arriving on that slide starts it. One idea instead of two
          ways of saying the same thing.
        */
        propRow('GoToSlide', propSelect(
          [{ value: '', label: 'Choose a slide\u2026' }].concat(
            state.deck.slides
              .filter((other) => other.id !== slide.id)
              .map((other) => ({ value: other.id, label: other.title }))
          ),
          element.targetSlideId || '',
          (value) => {
            element.targetSlideId = value || null;
            if (element.targetSlideId) element.videoId = null;
            apply({}, { rebuild: true });
          }
        ), 'Goes to'),
      ],
    });
    groups.push({ title: 'Layout', rows: layoutRows() });
  }

  if (element.kind === 'image') {
    groups.push({
      title: 'Appearance',
      rows: [
        propRow('File', propText(element.fileName || '', () => {}, {})),
        propRow('Picture', propSelect(
          [
            { value: 'fit', label: 'Whole picture' },
            { value: 'fill', label: 'Fill the frame' },
          ],
          element.fit || 'fit',
          (value) => apply({ fit: value })
        )),
        propRow('Replace', el('button', {
          class: 'btn btn-small btn-quiet',
          type: 'button',
          text: 'Choose\u2026',
          onclick: async () => {
            const result = await api.files.pickImage();
            if (result.canceled) return;
            element.src = await api.files.readImage(result.path);
            element.fileName = basename(result.path);
            imageCache.clear();
            apply({}, { rebuild: true });
          },
        })),
      ],
    });
    /*
      What the picture does when it is pressed.

      None is the default and is offered by name, because a picture that is just
      a picture is the ordinary case — it must not read as "something you have
      not filled in yet". Choosing a slide makes the picture a button on the
      disc: the remote lands on it, it lights up when chosen, and pressing it
      goes there, exactly as a button does.
    */
    groups.push({
      title: 'Behaviour',
      rows: [
        propRow('GoToSlide', propSelect(
          [{ value: '', label: 'None \u2014 just a picture' }].concat(
            state.deck.slides
              .filter((other) => other.id !== slide.id)
              .map((other) => ({ value: other.id, label: other.title }))
          ),
          element.targetSlideId || '',
          (value) => {
            element.targetSlideId = value || null;
            if (element.targetSlideId) element.videoId = null;
            apply({}, { rebuild: true });
          }
        ), 'Goes to'),
      ],
    });
    groups.push({ title: 'Layout', rows: layoutRows() });
  }

  if (element.kind === 'frame') {
    groups.push({
      title: 'Appearance',
      rows: [
        propRow('Fill', propSelect(colorChoices, element.fill || 'panel', (value) => apply({ fill: value }, { rebuild: true }))),
        propRow('Outline', propCheck(element.outline !== false, (checked) => apply({ outline: checked }))),
      ],
    });
    groups.push({ title: 'Layout', rows: layoutRows() });
  }

  if (element.posterMissing) {
    panel.append(
      el('p', {
        class: 'hint hint-warn',
        text:
          'A picture could not be taken from this video, so the tile shows its name ' +
          'only. It will still play correctly.',
      })
    );
  }

  // Filter, so a long list can be narrowed to the one property being looked for.
  const filter = el('input', {
    type: 'text',
    placeholder: 'Filter properties',
    'aria-label': 'Filter properties',
  });

  const table = propTable(groups);
  filter.addEventListener('input', () => {
    const query = filter.value.trim().toLowerCase();
    for (const row of table.querySelectorAll('.prop-row')) {
      row.style.display = !query || row.dataset.prop.includes(query) ? '' : 'none';
    }
  });

  panel.append(el('div', { class: 'prop-filter' }, [filter]), table);

  panel.append(
    el('p', {
      class: 'prop-hint',
      text: element.kind === 'image'
        ? 'Drag it to move it, or its handles to resize. A picture can go anywhere — ' +
          'past the edge, or right off the slide — and the X and Y above can bring it back.'
        : 'Drag it on the slide to move it, or its handles to resize. It stays inside ' +
          'the safe area.',
    })
  );

  if (element.kind === 'video') {
    /*
      The question this answers: "I scaled the tile down, so why does it still
      play full-screen?" Because on a disc, the menu is a still picture and the
      film is a separate thing the player switches to. The tile's size decides
      how it looks on the menu, which is where you choose it; it cannot decide
      how big the film plays, because no DVD player can do that.
    */
    panel.append(
      el('p', {
        class: 'prop-hint',
        text:
          'Size and position here are for the tile on the menu. Choosing it plays the ' +
          'film full-screen, which is how every DVD player works.',
      })
    );
  }

  /*
    Everything can be deleted. There used to be an exception here for the
    Back/Next row, because it was placed by the layout rather than by her and
    deleting it would have been a lie — the next redraw put it straight back.
    That row is gone, so every element on the slide is hers to remove.
  */
  panel.append(
    el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
      el('button', {
        class: 'btn btn-small btn-danger',
        type: 'button',
        text: 'Delete',
        onclick: () => deleteElement(element.id),
      }),
    ])
  );

  return panel;
}

// ------------------------------------------------ many elements at once ---

/**
 * Which kinds carry which shared property.
 *
 * Named sets rather than a per-kind list of rows, because the question the panel
 * asks is "do all of these have it?" — and that is the same question whatever
 * the property is.
 */
const LETTERING_KINDS = new Set(['text', 'button', 'video']);
const WORD_BOX_KINDS = new Set(['text', 'button']);
const SHAPE_FIT_KINDS = new Set(['image', 'video']);
const TARGETABLE_KINDS = new Set(['button', 'image']);

/**
 * The panel for a multiple selection.
 *
 * It offers only what every selected element has, and every change goes to all
 * of them. A property some of them lack is left out entirely rather than shown
 * disabled: a control that quietly does nothing to part of the selection is the
 * kind of thing that makes an editor feel broken.
 *
 * Where the values differ the row says so and shows nothing definite, because
 * showing the first element's value would be a lie about the others — and if she
 * then changed something else, the panel would look as though they had already
 * agreed.
 */
function buildMultiElementInspector(elements) {
  const panel = el('div', {});

  panel.append(
    el('div', { class: 'rail-title', text: `${elements.length} elements` })
  );

  /** Every selected element is one of these kinds. */
  const allAre = (kinds) => elements.every((e) => kinds.has(e.kind));

  const values = (key) => elements.map((e) => e[key]);
  const mixed = (key) => values(key).some((v) => v !== values(key)[0]);
  const first = (key) => values(key)[0];

  /** Apply a change to every selected element, then save and redraw once. */
  const change = (mutate) => {
    for (const element of elements) mutate(element);
    persistDeck();
    refreshCanvasOnly();
  };

  /**
   * A number row that writes to all of them.
   *
   * A geometric value is clamped per element rather than once, so a group pushed
   * against the safe area keeps its shape instead of taking the first element's
   * limit for everybody.
   */
  const numberRow = (name, label, key, options = {}) => {
    const differs = mixed(key);
    const input = propNumber(
      differs ? 0 : first(key),
      (v) => change((element) => {
        element[key] = v;
        if (key === 'height' && element.kind === 'text') element.autoHeight = false;
        clampElementInPlace(element);
      }),
      options
    );
    if (differs) {
      input.value = '';
      input.placeholder = 'mixed';
      input.title = 'These are not all the same';
    }
    return propRow(name, input, label);
  };

  const selectRow = (name, label, choices, key) => {
    const differs = mixed(key);
    const options = differs
      ? [{ value: '', label: '\u2014 different \u2014' }].concat(choices)
      : choices;
    return propRow(
      name,
      propSelect(options, differs ? '' : first(key) || '', (value) => {
        if (differs && value === '') return;
        /*
          An empty choice means "none", and these fields store none as null.
          Writing '' instead would be a second way of saying the same thing — and
          an element set that way would compare unequal to one where the field had
          simply never been set, which is how a "has this changed?" check comes to
          lie.
        */
        const stored = value === '' && first(key) === null ? null : value;
        change((element) => { element[key] = stored; });
      }),
      label
    );
  };

  /**
   * The text size, which is not quite a plain number.
   *
   * What is shown is the size each element is actually drawn at, because a
   * named size and a typed one are two ways of saying the same thing and the
   * panel should not pretend the second does not exist. What is written is
   * always the typed size, which is the one that wins.
   */
  const textSizeRow = () => {
    const sizes = elements.map((e) => elementFontPx(e));
    const differs = sizes.some((v) => v !== sizes[0]);
    const input = propNumber(differs ? 0 : sizes[0], (value) => {
      change((element) => { element.textPx = value; });
    }, textSizeBounds());
    if (differs) {
      input.value = '';
      input.placeholder = 'mixed';
      input.title = 'These are not all the same';
    }
    return propRow('TextSize', input, 'TextSize');
  };

  const groups = [];

  // Pictures have no position limits, so a negative X or Y is meaningful for
  // them and only for them — see the single-element panel.
  const positionFloor = elements.every((e) => e.kind === 'image') ? null : 0;

  groups.push({
    title: 'Position and size',
    rows: [
      numberRow('PositionX', 'X', 'x', { min: positionFloor }),
      numberRow('PositionY', 'Y', 'y', { min: positionFloor }),
      numberRow('Width', 'Width', 'width', { min: MIN_ELEMENT_WIDTH }),
      numberRow('Height', 'Height', 'height', { min: MIN_ELEMENT_HEIGHT }),
    ],
  });

  groups.push({
    title: 'Layering',
    rows: [
      numberRow('Priority', 'Priority', 'priority', { min: -99, max: 99 }),
      numberRow('Roundness', 'Roundness', 'roundness', { min: 0, max: 200 }),
    ],
  });

  if (allAre(LETTERING_KINDS)) {
    const fonts = (state.presets && state.presets.fonts) || [];
    const theme = currentTheme();
    const colorChoices = Object.keys(theme || {})
      .filter((key) => typeof theme[key] === 'string' && /^#/.test(theme[key]))
      .map((key) => ({ value: key, label: key, color: theme[key] }));

    groups.push({
      title: 'Lettering',
      rows: [
        selectRow(
          'Lettering',
          'Lettering',
          fonts.map((f) => ({ value: f.id, label: f.label })),
          'fontId'
        ),
        textSizeRow(),
        selectRow('TextAlign', 'TextAlign', [
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Centre' },
          { value: 'right', label: 'Right' },
        ], 'align'),
        colorChoices.length
          ? propRow(
              'TextColor',
              propColor(colorChoices, first('color'), (value) => {
                change((element) => { element.color = value; });
              }),
              'TextColor'
            )
          : null,
      ].filter(Boolean),
    });
  }

  if (allAre(WORD_BOX_KINDS)) {
    const theme = currentTheme();
    const colorChoices = Object.keys(theme || {})
      .filter((key) => typeof theme[key] === 'string' && /^#/.test(theme[key]))
      .map((key) => ({ value: key, label: key, color: theme[key] }));

    groups.push({
      title: 'Box behind',
      rows: [
        selectRow('Background', 'Background', [{ value: 'none', label: 'None' }].concat(colorChoices), 'background'),
        numberRow('BgTransparency', 'BgTransparency', 'backgroundTransparency', { min: 0, max: 1, step: 0.05 }),
      ],
    });
  }

  if (allAre(SHAPE_FIT_KINDS)) {
    groups.push({
      title: 'Picture',
      rows: [
        selectRow('Picture', 'Picture', [
          { value: 'fit', label: 'Whole picture' },
          { value: 'fill', label: 'Fill the frame' },
        ], 'fit'),
      ],
    });
  }

  if (allAre(TARGETABLE_KINDS)) {
    const slide = activeSlide();
    groups.push({
      title: 'Behaviour',
      rows: [
        selectRow(
          'GoToSlide',
          'Goes to',
          [{ value: '', label: 'None \u2014 does nothing' }].concat(
            state.deck.slides
              .filter((other) => !slide || other.id !== slide.id)
              .map((other) => ({ value: other.id, label: other.title }))
          ),
          'targetSlideId'
        ),
      ],
    });
  }
  panel.append(propTable(groups));

  panel.append(
    el('p', {
      class: 'prop-hint',
      text:
        'Every change here is applied to all of them. Drag one and the rest come ' +
        `with it. Hold ${addToSelectionKey()} and click to add or remove one.`,
    })
  );

  panel.append(
    el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
      el('button', {
        class: 'btn btn-small btn-danger',
        type: 'button',
        text: `Delete all ${elements.length}`,
        onclick: () => deleteElements(elements.map((e) => e.id)),
      }),
    ])
  );

  return panel;
}

/** The theme the active slide is drawn with, for the colour choices. */
function currentTheme() {
  const slide = activeSlide();
  const themeId = (slide && slide.themeId) || (state.deck && state.deck.themeId) || 'charcoal';
  const themes = (state.presets && state.presets.themes) || [];
  return themes.find((t) => t.id === themeId) || themes[0] || null;
}

/** Bounds on a typed text size, from the deck that enforces them. */
const TEXT_SIZE_MIN = 8;
const TEXT_SIZE_MAX = 120;

function textSizeBounds() {
  const presets = state.presets || {};
  return {
    min: Number.isFinite(presets.textSizeMin) ? presets.textSizeMin : TEXT_SIZE_MIN,
    max: Number.isFinite(presets.textSizeMax) ? presets.textSizeMax : TEXT_SIZE_MAX,
  };
}

/**
 * The size in pixels an element is drawn at right now.
 *
 * A typed size wins; otherwise the named size it was made with. Shown in the
 * TextSize field, so opening the panel on a preset says what that preset is
 * worth rather than leaving the number blank.
 */
function elementFontPx(element) {
  const typed = Number(element && element.textPx);
  const bounds = textSizeBounds();
  if (Number.isFinite(typed) && typed > 0) {
    return Math.max(bounds.min, Math.min(bounds.max, Math.round(typed)));
  }
  const sizes = (state.presets && state.presets.textSizes) || [];
  const found = sizes.find((s) => s.id === (element && element.fontSize));
  return found ? found.px : 22;
}

/** Put the caret into one of the inspector's fields, if it is on screen. */
function focusInspectorField(name) {
  const field = document.querySelector(`#inspector [data-field="${name}"]`);
  if (!field) return false;
  field.focus();
  if (typeof field.select === 'function') field.select();
  return true;
}

function textField(label, value, onInput) {
  const input = el('input', { class: 'input', type: 'text', value: value || '', 'aria-label': label });
  input.addEventListener('input', () => onInput(input.value));
  return el('div', { class: 'field' }, [el('label', { class: 'label', text: label }), input]);
}

function textAreaField(label, value, onInput, options = {}) {
  const area = el('textarea', { class: 'textarea', rows: '2', 'aria-label': label });
  if (options.field) area.dataset.field = options.field;
  area.value = value || '';
  area.addEventListener('input', () => onInput(area.value));
  return el('div', { class: 'field' }, [el('label', { class: 'label', text: label }), area]);
}

function numberField(label, value, onChange) {
  const input = el('input', {
    class: 'input',
    type: 'number',
    value: String(Math.round(value || 0)),
    min: '24',
    'aria-label': label,
  });
  input.addEventListener('change', () => onChange(Math.max(24, Number(input.value) || 24)));
  return el('div', {}, [el('label', { class: 'label', text: label }), input]);
}

function switchRow({ checked, title, desc, onChange }) {
  const knob = el('button', {
    class: 'switch',
    type: 'button',
    role: 'switch',
    'aria-checked': String(Boolean(checked)),
    'aria-label': title,
  });
  knob.addEventListener('click', () => {
    const next = knob.getAttribute('aria-checked') !== 'true';
    knob.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  return el('div', { class: 'switch-row' }, [
    knob,
    el('div', { class: 'switch-text' }, [
      el('div', { class: 'switch-title', text: title }),
      desc ? el('div', { class: 'switch-desc', text: desc }) : null,
    ].filter(Boolean)),
  ]);
}

/**
 * What to call the modifier that adds to a selection, on this computer.
 *
 * Ctrl on Windows, Cmd on a Mac — and on a Mac Ctrl must not be named at all,
 * because Ctrl-click there is the system's own right-click and would open the
 * context menu instead of adding to the selection. Telling somebody to press a
 * key that does something else is worse than saying nothing.
 *
 * Shift is accepted everywhere and is named everywhere, since it is the one
 * nobody has to be told about twice.
 */
function addToSelectionKey() {
  const isMac = document.body.classList.contains('platform-mac');
  return isMac ? 'Cmd or Shift' : 'Ctrl or Shift';
}

// --------------------------------------------------------- step: finish ---

function renderFinishStep(stage) {
  stage.className = 'stage';
  document.body.classList.remove('wide-stage');

  /*
    Ask what is already built, once, the first time this step is shown in a
    session. A prepared disc belongs to the project and outlives the app, so
    opening the app after an upgrade should offer that disc rather than silently
    re-encoding an hour of video to produce the same bytes again.
  */
  /*
    Ask what is already built, once per project.

    Per project, not per session. This used to be asked the first time the Finish
    step was shown and then never again, so opening a second project reused the
    answer for the first: the page would describe the wrong disc — its video
    count, when it was built, and whether it was ready to burn — and, because the
    answer decides whether a build is needed at all, the second project's own
    prepared disc was never even looked for. Clearing it here means the question
    is asked again for whatever project is actually open.
  */
  if (state.buildState === null) {
    state.buildState = 'checking';
    refreshBuiltState();
  }
  stage.append(el('h1', { text: 'Make the disc' }));

  if (!state.videos.length || !state.deck.slides.length) {
    stage.append(
      el('div', { class: 'panel' }, [
        el('h2', { text: 'Not ready yet' }),
        el('p', {
          class: 'hint',
          text: !state.videos.length
            ? 'Add some videos first.'
            : 'Your disc needs at least one slide with a button on it.',
        }),
        el('div', { class: 'btn-row', style: 'margin-top: 12px' }, [
          el('button', {
            class: 'btn',
            type: 'button',
            text: !state.videos.length ? 'Add Videos' : 'Back to Slides',
            onclick: () =>
              !state.videos.length
                ? promptForVideos()
                : goToStep('slides'),
          }),
        ]),
      ])
    );
    return;
  }

  /*
    A disc built earlier and still matching the project counts as built, even
    though it was not built in this session — that is the whole point of keeping
    the build on disk. One that no longer matches is shown as out of date rather
    than offered.
  */
  const recorded = state.buildState && state.buildState !== 'checking' ? state.buildState : null;
  if (recorded && recorded.built && !recorded.upToDate) stage.append(buildStalePanel());
  else if (state.lastBuild) stage.append(buildDonePanel());
  else if (recorded && recorded.built && recorded.upToDate) stage.append(buildDonePanel());
  stage.append(buildBurnPanel());

  stage.append(
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [el('h2', { text: 'Other ways to keep it' })]),
      el('p', {
        class: 'hint',
        style: 'margin-bottom: 12px',
        text:
          'A disc image is a single file holding the whole DVD. You can burn it later, ' +
          'copy it to another computer, or keep it as a backup.',
      }),
      el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn',
          type: 'button',
          id: 'btnSaveImage',
          text: 'Save a Disc Image\u2026',
          disabled: state.busy,
        }),
        el('button', {
          class: 'btn',
          type: 'button',
          id: 'btnSaveFolder',
          text: 'Save the Disc Files\u2026',
          disabled: state.busy,
        }),
      ]),
    ])
  );
}

/**
 * Ask the main process what is already built for this project, and show it.
 *
 * The answer decides whether the Finish page offers a disc that is ready to
 * burn, says the project has moved on since it was built, or says nothing has
 * been built at all.
 */
async function refreshBuiltState() {
  try {
    state.buildState = await api.job.built({ project: projectPayload() });
  } catch {
    // Not knowing is not the same as nothing being built, but it has the same
    // consequence — build again — so it is reported the same way.
    state.buildState = { built: false, upToDate: false };
  }
  if (state.step === 'finish') render();
}

/**
 * The banner for a project that has changed since its disc was built.
 *
 * Burning without this would put the older disc on the blank disc and look like
 * the changes had been ignored.
 */
function buildStalePanel() {
  const manifest = (state.buildState && state.buildState.manifest) || {};
  const when = manifest.builtAt ? new Date(manifest.builtAt).toLocaleString() : null;

  return el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('h2', { text: 'Changes not built yet' }),
      when ? el('span', { class: 'panel-note', text: `built ${when}` }) : null,
    ].filter(Boolean)),
    buildBanner({
      kind: 'info',
      title: 'This project has changed since it was last built',
      body:
        'The disc prepared earlier is out of date, so it will not be burned. ' +
        'Press "Build the Disc" below to bring it up to date — only what changed ' +
        'is re-encoded.',
    }),
  ]);
}


function buildDonePanel() {
  // Either a build from this session, which carries the full detail, or one
  // recorded earlier and read back from disk, which carries the summary.
  const recorded = state.buildState && state.buildState !== 'checking' ? state.buildState.manifest : null;
  const build = state.lastBuild || recorded || {};
  const panel = el('div', { class: 'panel' });
  panel.append(
    el('div', { class: 'panel-head' }, [
      el('h2', { text: 'The disc is built' }),
      build.sizeBytes
        ? el('span', { class: 'panel-note', text: formatBytes(build.sizeBytes) })
        : build.builtAt
          ? el('span', { class: 'panel-note', text: `built ${new Date(build.builtAt).toLocaleString()}` })
          : null,
    ].filter(Boolean)),
    buildBanner({
      kind: 'good',
      title: `${build.videoCount} ${build.videoCount === 1 ? 'video' : 'videos'} ready to burn`,
      body: `${build.slideCount} ${build.slideCount === 1 ? 'menu page' : 'menu pages'}, ${formatDuration(build.totalSeconds)} of video.`,
    })
  );

  if (build.failed && build.failed.length) {
    const list = el('ul', { class: 'checklist', style: 'color: #e6b3ac' });
    for (const failure of build.failed) {
      list.append(el('li', { text: `${failure.name}: ${failure.error}` }));
    }
    panel.append(
      el('div', { style: 'margin-top: 12px' }, [
        el('h2', { style: 'font-size: 13px', text: 'These were left off' }),
        list,
      ])
    );
  }

  panel.append(
    el('div', { class: 'btn-row', style: 'margin-top: 13px' }, [
      el('button', {
        class: 'btn btn-small',
        type: 'button',
        text: 'Show the disc files',
        onclick: () => api.files.reveal(build.videoTsDir).catch(() => {}),
      }),
    ])
  );

  return panel;
}

function buildBurnPanel() {
  const panel = el('div', { class: 'panel' });
  panel.append(
    el('div', { class: 'panel-head' }, [
      el('h2', { text: 'Write to a blank disc' }),
      el('span', { class: 'panel-note', text: 'Use a DVD-R or DVD+R' }),
    ])
  );

  const writers = state.driveSupported ? state.drives : [];
  const hasWriter = writers.length > 0;

  if (!state.driveSupported) {
    panel.append(
      buildBanner({
        kind: 'info',
        title: 'This computer cannot write discs',
        body:
          state.driveNote ||
          'The disc can still be built here, then copied to a computer with a disc writer.',
      })
    );
  } else if (!hasWriter) {
    panel.append(
      // Title only. The line under it explained what the writer is and what to
      // do, which the heading already says in fewer words — and the drive list
      // appears on its own the moment one is plugged in.
      buildBanner({ kind: 'info', title: 'No disc burner found', compact: true })
    );
  } else {
    const list = el('div', { class: 'drive-list' });
    for (const drive of writers) {
      /*
        Selected by id, not by device node.

        A drive macOS will not name still has to be selectable: hdiutil picks the
        only attached writer itself, so an empty node costs nothing, but using it
        as the selection key meant the choice never stuck — and the Burn button,
        which is disabled while nothing is selected, stayed dead. Which is what
        happened on a Mac whose burner was plugged in and working.
      */
      const selected = state.selectedDevice === drive.id;
      const hasMedia = Boolean(drive.media && drive.media.present);
      const button = el('button', {
        class: 'drive',
        type: 'button',
        'aria-pressed': String(selected),
        onclick: () => {
          state.selectedDevice = drive.id;
          api.settings.set({ lastDevice: drive.id }).catch(() => {});
          render();
        },
      });
      button.append(
        el('span', { class: 'drive-icon', text: '\u25ce' }),
        el('div', { class: 'drive-main' }, [
          el('div', { class: 'drive-name', text: drive.label || drive.device }),
          el('div', {
            class: 'drive-meta',
            text: !hasMedia
              ? 'No disc in the drive'
              : drive.media.alreadyWritten && !drive.media.erasable
                ? `${drive.media.type || 'Disc'} \u00b7 already has something on it${
                    drive.media.usedSpace ? ` (${drive.media.usedSpace})` : ''
                  }`
                : `${drive.media.type || 'Disc'} \u00b7 ${
                    drive.media.freeSpace || drive.media.capacity || 'capacity unknown'
                  }`,
          }),
        ]),
        el('span', { class: `drive-state${hasMedia ? ' ready' : ''}`, text: hasMedia ? 'Ready' : 'Empty' })
      );
      list.append(button);
    }
    panel.append(list);
    if (!state.selectedDevice) state.selectedDevice = writers[0].id;
  }

  /*
    The burn button is always on the page, and says why it cannot be used.

    It used to appear only once a writer was found, so the page rearranged itself
    and there was nothing to look at to work out what was missing. Now it is
    always in the same place: grey when there is no writer, red when there is,
    with the reason written next to it.
  */
  /*
    The disc has to be there, and it has to be blank.

    Pressing Burn with an empty drive handed hdiutil nothing and it opened the
    tray, which explained itself badly. A disc that already has something on it
    is the same kind of avoidable surprise — drutil reports it with a session on
    it — so the app says so before the press rather than after.
  */
  const chosenDrive = writers.find((d) => d.id === state.selectedDevice) || writers[0] || null;
  const media = (chosenDrive && chosenDrive.media) || null;
  const discInDrive = Boolean(media && media.present);
  const usedDisc = Boolean(media && media.present && media.alreadyWritten && !media.erasable);

  const blocked = state.busy
    ? 'Working\u2026'
    : !state.driveSupported
      ? 'Cannot write discs on this computer'
      : !hasWriter
        ? 'No writer connected'
        : !state.selectedDevice
          ? 'Choose a drive above'
          : !discInDrive
            ? 'No disc in the drive'
            : usedDisc
              ? 'That disc already has something on it'
              : null;

  const burn = el('button', {
    class: 'btn-burn',
    type: 'button',
    id: 'btnBurn',
    disabled: Boolean(blocked),
    'aria-label': blocked ? `Burn the disc \u2014 ${blocked}` : 'Burn the disc',
  });
  burn.append(
    el('span', { class: 'btn-burn-glyph' }),
    el('span', { class: 'btn-burn-label', text: 'Burn' })
  );

  /*
    The two things to do first, before the burn button.

    They used to sit below it, which put the one-way action above the steps that
    are meant to come before it. Reading down the page now goes: check it, build
    it, then write it.
  */
  panel.append(
    el('div', { class: 'rule', text: 'Before you burn' }),
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn btn-small',
        type: 'button',
        text: 'Go to Testing',
        disabled: state.busy,
        onclick: () => goToStep('testing'),
      }),
    ])
  );

  /*
    There is no separate "build" step to press any more.

    Preparing the disc is not something anybody wants to do on purpose — it is
    work the burn needs doing first. Burning now prepares only when it has to:
    from the cached folder when the project has not changed, and afresh when it
    has. Two buttons for one intention was one too many.
  */
  panel.append(
    el('div', { class: 'burn-action' }, [
      burn,
      el('div', { class: 'burn-side' }, [
        el('p', {
          class: blocked ? 'hint burn-blocked' : 'hint',
          text:
            blocked ||
            'Writing takes several minutes and the disc cannot be reused afterwards. ' +
              'Leave the burner connected until it says it is finished.',
        }),
        el('button', {
          class: 'btn btn-small btn-quiet',
          type: 'button',
          // Ejecting from here is the same thing the Finder's Eject does, and
          // saves leaving the app to fetch a disc out.
          text: '\u23cf Eject the tray',
          /*
            Never disabled for want of a disc.

            Ejecting is about the tray, not the media — the Finder's Eject opens
            an empty tray quite happily, and wanting to open it is exactly the
            situation where the app cannot see a disc to begin with. Requiring
            one made the button useless precisely when it was wanted.
          */
          disabled: state.busy,
          onclick: async () => {
            try {
              const chosen = state.drives.find((d) => d.id === state.selectedDevice);
              await api.drives.eject({ device: (chosen && chosen.device) || null });
            } catch (err) {
              setBanner('error', 'The disc could not be ejected', String(err.message || err));
            }
            refreshDrives();
          },
        }),
      ]),
    ])
  );

  return panel;
}

function renderFinishRail(rail) {
  rail.append(buildFinishSummary());
}

/** What this disc is, in the context rail of the finish step. */
function buildFinishSummary() {
  const section = el('div', { class: 'rail-section' });
  section.append(el('div', { class: 'rail-title', text: 'This disc' }));

  const stats = el('div', { class: 'stats' });
  const add = (key, value, tone) => {
    stats.append(
      el('div', { class: 'stat' }, [
        el('span', { class: 'stat-key', text: key }),
        el('span', { class: `stat-value${tone ? ` ${tone}` : ''}`, text: value }),
      ])
    );
  };

  const plan = state.plan;
  add('Videos', state.videos.length ? String(state.videos.length) : '\u2014');
  add('Total length', state.totalSeconds ? formatDuration(state.totalSeconds) : '\u2014');
  add('Slides', String(state.deck.slides.length));
  add('Disc size', plan ? formatBytes(plan.estimatedBytes) : '\u2014');
  add('A blank disc', 'DVD-R or DVD+R');
  add('A disc burner', state.drives.length ? 'Connected' : 'Not found', state.drives.length ? '' : 'dim');

  section.append(stats);
  return section;
}

// ------------------------------------------------------------- interaction ---

function bindChrome() {
  for (const button of document.querySelectorAll('.step')) {
    button.addEventListener('click', () => goToStep(button.dataset.step));
  }
  const btnHome = $('btnProjectsHome');
  if (btnHome) btnHome.addEventListener('click', () => closeProjectToHome());
  const btnSave = $('btnSaveProject');
  if (btnSave) btnSave.addEventListener('click', () => saveCurrentProject(true));

  $('btnSetup').addEventListener('click', () => openSetup());
  $('btnShare').addEventListener('click', () => openShare());
  $('btnCancel').addEventListener('click', () => api.job.cancel().catch(() => {}));
  $('btnLogToggle').addEventListener('click', () => {
    const log = $('log');
    log.hidden = !log.hidden;
    $('btnLogToggle').textContent = log.hidden ? 'Details' : 'Hide Details';
  });

  for (const node of document.querySelectorAll('[data-close-overlay]')) {
    node.addEventListener('click', () => {
      node.closest('.overlay').hidden = true;
    });
  }
  for (const overlay of document.querySelectorAll('.overlay')) {
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) overlay.hidden = true;
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeElementMenu();
      for (const overlay of document.querySelectorAll('.overlay')) overlay.hidden = true;
    }

    /*
      Project shortcuts (New / Open / Save / Save As) are owned by the native
      application menu, which registers the accelerators with the OS. Handling
      them here as well would run each one twice — and two open dialogs for a
      single keypress is very visible. One authority, in the menu.
    */
    if (state.step !== 'slides') return;
    const target = event.target;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

    if ((event.key === 'Backspace' || event.key === 'Delete') && state.selectedElementIds.length) {
      event.preventDefault();
      deleteElements(state.selectedElementIds);
    }

    // Select everything on the slide, and let go of it again, the way every
    // editor does. Cmd on a Mac, Ctrl everywhere else.
    if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 'a') {
      event.preventDefault();
      const slide = activeSlide();
      setElementSelection((slide ? slide.elements : []).map((e) => e.id));
      renderInspector();
      drawCanvas();
    }

    if (event.key === 'Escape' && state.selectedElementIds.length) {
      // A modifier-click already dropped the context menu's copy of this; here it
      // is the selection that goes.
      clearElementSelection();
      renderInspector();
      drawCanvas();
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const targets = selectedElements();
      if (!targets.length) return;
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      // Shift is the fine/coarse modifier here, so it cannot also mean "add to
      // the selection" once something is selected — the arrow keys move whatever
      // is selected, all of it together.
      for (const element of targets) {
        if (event.key === 'ArrowLeft') element.x -= step;
        if (event.key === 'ArrowRight') element.x += step;
        if (event.key === 'ArrowUp') element.y -= step;
        if (event.key === 'ArrowDown') element.y += step;
        clampElementInPlace(element);
      }
      persistDeck();
      refreshCanvas();
    }
  });

  $('btnRecheck').addEventListener('click', recheckTools);
}

function goToStep(step) {
  const next =
    step === 'finish' ? 'finish' :
    step === 'testing' ? 'testing' :
    step === 'projects' ? 'projects' : 'slides';

  // Leaving the player stops whatever it was playing; a film carrying on out of
  // sight somewhere behind another page is not something to leave lying around.
  if (state.step === 'testing' && next !== 'testing') closeSimulator();

  state.step = next;
  state.banner = null;
  document.body.classList.toggle('wide-stage', state.step !== 'finish');

  // Only the Finish page cares about drives, so the polling runs only there.
  if (next === 'finish') startDriveWatch();
  else stopDriveWatch();

  render();
}

function clampElementInPlace(element) {
  return safeArea.clampElement(element, RASTER.width, RASTER.height);
}

/** The project the pipeline executes. */
function projectPayload() {
  return {
    /*
      The project's own identity, so its prepared disc goes in its own folder.

      This was missing, and its absence is why every project shared one prepared
      disc: the main process had nothing to name a folder with, so it fell back
      to the top of the working folder and the next build overwrote the last
      one's encoded video, menu stills and authored VIDEO_TS.

      Null rather than a freshly made id when there is somehow none. A new id per
      call would be far worse than a shared folder: every single build would land
      somewhere the next one could not find.
    */
    id: state.projectId || null,
    discTitle: state.discTitle || state.deck.discTitle || 'My DVD',
    // The two settings that used to be questions. They are constants now.
    audioMode: DISC_DEFAULTS.audioMode,
    chaptersEnabled: DISC_DEFAULTS.chaptersEnabled,
    chapterMinutes: DISC_DEFAULTS.chapterMinutes,
    deck: state.deck,
    videos: state.videos.map((v) => ({
      id: v.id,
      path: v.path,
      name: v.name,
      menuLabel: v.menuLabel,
      duration: v.duration,
    })),
  };
}

function bindMenuEvents() {
  document.addEventListener('click', (event) => {
    // Any click that is not inside the menu dismisses it, the way every
    // right-click menu behaves.
    if (!(event.target.closest && event.target.closest('.context-menu'))) {
      closeElementMenu();
    }

    const target = event.target.closest('button');
    if (!target) return;
    if (target.id === 'btnBuild') runBuild();
    else if (target.id === 'btnBurn') runBurn();
    else if (target.id === 'btnSaveImage') runSaveImage();
    else if (target.id === 'btnSaveFolder') runSaveFolder();
  });

  // Menu bar commands.
  api.onMenuEvent('menu:new-project', () => {
    closeProjectToHome();
  });
  api.onMenuEvent('menu:open-project', () => openProjectDialog());
  api.onMenuEvent('menu:save-project', () => saveCurrentProject(true));
  api.onMenuEvent('menu:save-project-as', () => saveProjectAs());
  api.onMenuEvent('menu:close-project', () => closeProjectToHome());
  api.onMenuEvent('menu:setup', () => openSetup());
  api.onMenuEvent('menu:help', () => openHelp());
  api.onMenuEvent('menu:share', () => openShare());
  api.onMenuEvent('menu:add-videos', () => promptForVideos());
  api.onMenuEvent('menu:step', (step) => goToStep(step));
  api.onMenuEvent('menu:log', () => {
    $('jobbar').hidden = false;
    $('log').hidden = false;
  });
  api.onMenuEvent('menu:build-image', () => runSaveImage());
  api.onMenuEvent('menu:burn', () => runBurn());
  api.onMenuEvent('menu:reveal-work', async () => {
    if (state.lastBuild) await api.files.reveal(state.lastBuild.videoTsDir);
    else await api.files.open((state.settings && state.settings.workDir) || '');
  });
}

async function promptForVideos() {
  try {
    const result = await api.files.addVideos();
    if (result.canceled) return;
    await addVideoPaths(result.files);
  } catch (err) {
    setBanner('error', 'Could not open the file chooser', String(err.message || err));
    render();
  }
}

/*
  Keep the drive list current without being asked.

  Plugging the burner in, taking it out, or putting a disc in or out are the
  things that change the answer, and all of them happen outside the app. Making
  somebody press "Refresh" to be told about them is asking them to guess when
  their own hardware changed.

  Cheap on purpose: one short-lived command every few seconds, and the page is
  only redrawn when the answer is actually different — otherwise the poll would
  fight every click on the page.
*/
let driveWatch = null;

function driveSignature(drives) {
  return JSON.stringify(
    (drives || []).map((d) => [d.id, d.label, Boolean(d.media && d.media.present), d.media && d.media.type, d.media && d.media.freeSpace, d.media && d.media.alreadyWritten])
  );
}

function startDriveWatch() {
  if (driveWatch) return;
  driveWatch = setInterval(async () => {
    if (state.step !== 'finish' || state.busy) return;
    try {
      const result = await api.drives.list();
      const drives = result.drives || [];
      if (driveSignature(drives) === driveSignature(state.drives)) return;
      state.drives = drives;
      state.driveSupported = result.supported !== false;
      state.driveNote = result.note || null;
      if (state.selectedDevice && !drives.some((d) => d.id === state.selectedDevice)) {
        state.selectedDevice = drives.length ? drives[0].id : null;
      }
      if (!state.selectedDevice && drives.length) state.selectedDevice = drives[0].id;
      render();
    } catch {
      // A failed poll is not worth reporting; the next one may work, and the
      // page still shows what it last knew.
    }
  }, 3000);
}

function stopDriveWatch() {
  if (driveWatch) clearInterval(driveWatch);
  driveWatch = null;
}

async function refreshDrives() {
  try {
    const result = await api.drives.list();
    state.drives = result.drives || [];
    state.driveSupported = result.supported !== false;
    state.driveNote = result.note || null;
    if (state.selectedDevice && !state.drives.some((d) => d.id === state.selectedDevice)) {
      state.selectedDevice = state.drives.length ? state.drives[0].id : null;
    }
    if (!state.selectedDevice && state.drives.length) state.selectedDevice = state.drives[0].id;
    if (state.step === 'finish') render();
  } catch (err) {
    state.drives = [];
    state.driveSupported = false;
    state.driveNote = String(err.message || err);
  }
}

// ------------------------------------------------------------------ jobs ---

function bindJobEvents() {
  api.job.onState((status) => {
    state.busy = Boolean(status.busy);
    const bar = $('jobbar');
    const label = $('jobLabel');
    const progress = $('jobProgress');
    const percent = $('jobPercent');
    const cancel = $('btnCancel');

    /*
      A burn is two jobs behind the scenes — getting the disc ready, then writing
      it — but one bar and one number to look at. The first half of the bar is
      step 1 of 2, the second half is step 2 of 2, and it only ever moves forward.
    */
    const session = state.burnSession;
    if (session && status.busy) {
      const overall = burnOverall(status, session);
      session.floor = Math.max(session.floor, overall.fraction);
      bar.hidden = false;
      label.textContent = `Step ${overall.step} of 2 \u00b7 ${status.message || 'Working\u2026'}`;
      progress.classList.remove('indeterminate');
      progress.style.width = `${(session.floor * 100).toFixed(1)}%`;
      percent.textContent = `${Math.floor(session.floor * 100)}%`;
      cancel.disabled = false;
    } else if (session) {
      // Between the two jobs, and at the end of the second: runBurn finishes the
      // bar itself once the whole thing is done.
      cancel.disabled = true;
    } else if (status.busy) {
      bar.hidden = false;
      label.textContent = status.message || 'Working\u2026';
      const fraction = typeof status.fraction === 'number' ? status.fraction : 0;
      const indeterminate = ['author', 'menu', 'inspect', 'starting'].includes(status.stage);
      progress.classList.toggle('indeterminate', indeterminate);
      if (!indeterminate) progress.style.width = `${Math.round(fraction * 100)}%`;
      percent.textContent = indeterminate ? '' : `${Math.round(fraction * 100)}%`;
      cancel.disabled = false;
    } else {
      cancel.disabled = true;
      if (status.finished === 'cancelled') label.textContent = 'Stopped.';
      else if (status.finished === 'ok') {
        label.textContent = 'Finished.';
        progress.classList.remove('indeterminate');
        progress.style.width = '100%';
        percent.textContent = '100%';
        setTimeout(() => {
          if (!state.busy) $('jobbar').hidden = true;
        }, 2600);
      }
    }

    if (status.log) {
      const log = $('log');
      log.textContent = status.log.join('\n');
      log.scrollTop = log.scrollHeight;
    }
    renderChrome();
    if (state.step === 'finish') render();
  });

  api.job.onLog((line) => {
    const log = $('log');
    log.textContent += `${log.textContent ? '\n' : ''}${line}`;
    log.scrollTop = log.scrollHeight;
  });
}

/**
 * Where a job's progress falls on the one bar a burn shows.
 *
 *   0 to 50%    step 1 of 2: converting and authoring the disc (only when it has
 *               to be built), then making the disc image
 *   50 to 100%  step 2 of 2: writing to the disc, and checking it
 */
function burnOverall(status, session) {
  const f = Math.max(0, Math.min(1, typeof status.fraction === 'number' ? status.fraction : 0));
  const span = (from, to) => from + f * (to - from);
  switch (status.stage) {
    case 'burn':
      return { step: 2, fraction: span(0.5, 1) };
    case 'image':
      return { step: 1, fraction: session.needsBuild ? span(0.42, 0.5) : span(0, 0.5) };
    case 'encode':
      return { step: 1, fraction: span(0.02, 0.36) };
    case 'menu':
      return { step: 1, fraction: 0.37 };
    case 'author':
      return { step: 1, fraction: f >= 1 ? 0.41 : 0.39 };
    case 'verify':
      return { step: 1, fraction: 0.415 };
    default:
      return { step: 1, fraction: 0.01 };
  }
}

async function runBuild() {
  setBanner(null);
  try {
    const result = await api.job.build({ project: projectPayload() });
    state.lastBuild = result;
    // The disc on disk now matches the project, so the out-of-date notice has
    // to go without waiting for another round trip.
    state.buildState = { built: true, upToDate: true, manifest: result };
    setBanner('good', 'The disc is built', [
      `${result.videoCount} ${result.videoCount === 1 ? 'video' : 'videos'}, ` +
        `${result.slideCount} ${result.slideCount === 1 ? 'menu page' : 'menu pages'}, ` +
        `${formatDuration(result.totalSeconds)}.`,
      /*
        Say when there was nothing to do.

        Confirming that a rebuild was quick because it reused the last one is
        worth a line: without it, a build that finishes in seconds looks like it
        did not happen, and the honest answer to "did it work?" is that it did.
      */
      result.reusedTitles >= result.videoCount && result.videoCount > 0
        ? 'Nothing had changed, so the videos already prepared were kept. That took seconds.'
        : result.reusedTitles
          ? `${result.reusedTitles} of ${result.videoCount} were already prepared and were kept.`
          : null,
      result.copiedTitles
        ? `${result.copiedTitles} ${result.copiedTitles === 1 ? 'was' : 'were'} already DVD video, so ` +
          `${result.copiedTitles === 1 ? 'it was' : 'they were'} copied rather than converted.`
        : null,
      result.failed && result.failed.length
        ? `${result.failed.length} could not be prepared and were left off.`
        : 'Put in a blank disc and press Burn when you are ready.',
    ].filter(Boolean));
  } catch (err) {
    if (err.aborted) setBanner('info', 'Stopped', 'Nothing was written to a disc.');
    else setBanner('error', 'The disc could not be built', String(err.message || err));
  }
  render();
}

async function runBurn() {
  /*
    Build first if there is nothing to burn, or if what is there no longer
    matches the project. Burning the older disc would look like the changes had
    been ignored, which is worse than taking the time to build again.
  */
  const recorded = state.buildState && state.buildState !== 'checking' ? state.buildState : null;
  const outOfDate = Boolean(recorded && recorded.built && !recorded.upToDate);
  const needsBuild = !state.lastBuild || outOfDate;
  state.burnSession = { needsBuild, floor: 0 };
  const jobbar = $('jobbar');
  const finishBar = (text) => {
    state.burnSession = null;
    $('jobLabel').textContent = text;
    $('jobProgress').classList.remove('indeterminate');
    $('btnCancel').disabled = true;
    if (text === 'Finished.') {
      $('jobProgress').style.width = '100%';
      $('jobPercent').textContent = '100%';
      setTimeout(() => {
        if (!state.busy && !state.burnSession) jobbar.hidden = true;
      }, 2600);
    }
  };
  if (needsBuild) {
    await runBuild();
    if (!state.lastBuild) {
      finishBar('Stopped.');
      return;
    }
  }
  setBanner(null);
  try {
    /*
      The selection is a drive id; the burn wants the device node.

      A drive macOS will not name has no node, and that is fine — hdiutil uses
      the only attached writer when it is not told which. Passing null is what
      makes that happen, where passing the id would name a device that does not
      exist.
    */
    const chosen = state.drives.find((d) => d.id === state.selectedDevice);
    await api.job.burn({ device: (chosen && chosen.device) || null, project: projectPayload() });
    const checked = !state.settings || state.settings.verifyBurn !== false;
    setBanner('good', 'The disc was written successfully', [
      checked ? 'The disc has been checked and is ready to use.' : 'The disc is ready to use.',
      'Take it out and try it in a DVD player.',
    ]);
    finishBar('Finished.');
  } catch (err) {
    finishBar(err.aborted ? 'Stopped.' : 'Failed.');
    if (err.aborted) setBanner('info', 'Stopped', 'The disc in the drive may not be usable. Use a fresh one.');
    else setBanner('error', 'The disc could not be written', String(err.message || err));
  }
  refreshDrives();
  render();
}

async function runSaveImage() {
  try {
    const label = state.lastBuild ? state.lastBuild.volumeLabel : 'MY_DVD';
    const chosen = await api.files.saveImage(label);
    if (chosen.canceled) return;
    setBanner(null);
    const result = await api.job.image({ path: chosen.path, project: projectPayload() });
    setBanner('good', 'The disc image was saved', [
      `${result.isoPath} (${formatBytes(result.sizeBytes)})`,
      'You can burn this later, or keep it as a backup.',
    ]);
    render();
  } catch (err) {
    if (!err.aborted) setBanner('error', 'The disc image could not be saved', String(err.message || err));
    render();
  }
}

async function runSaveFolder() {
  try {
    const chosen = await api.files.pickFolder({
      title: 'Where should the disc files go?',
      buttonLabel: 'Save Here',
    });
    if (chosen.canceled) return;
    setBanner(null);
    await api.job.saveFolder({ path: chosen.path, project: projectPayload() });
    setBanner('good', 'The disc files were saved', [
      chosen.path,
      'This folder holds a VIDEO_TS directory, which is the DVD itself.',
    ]);
    render();
  } catch (err) {
    setBanner('error', 'The disc files could not be saved', String(err.message || err));
    render();
  }
}

// --------------------------------------------------------------- dialogs ---

async function openSetup() {
  $('setupOverlay').hidden = false;
  $('setupBody').replaceChildren(el('p', { class: 'dim', text: 'Checking\u2026' }));
  await renderSetupDialog();
}

async function renderSetupDialog() {
  const body = $('setupBody');
  body.replaceChildren();

  let detected = null;
  try {
    detected = await api.tools.detect();
    state.tools = detected.tools;
  } catch (err) {
    body.append(buildBanner({ kind: 'error', title: 'Could not check', body: String(err.message || err) }));
    return;
  }

  const { tools, versions, workDir } = detected;

  /*
    How much room the prepared files are taking.

    Burnhouse keeps the encoded videos and the authored disc between builds so
    that rebuilding does not mean re-encoding an hour of footage. That is the
    right trade for time and the wrong one for disk space unless it can be seen
    and reclaimed, so the figure is shown here rather than discovered later.
  */
  let work = { dir: workDir, bytes: 0, exists: false };
  try {
    work = await api.work.info();
  } catch {
    // An unreadable folder is reported as nothing kept, which is what the
    // Clear button below would leave behind anyway.
  }

  // The writing options below are stored settings, so they have to be read
  // rather than assumed — this dialog is where they are the only copy.
  try {
    state.settings = await api.settings.get();
  } catch {
    /* the switches fall back to their defaults */
  }

  const rows = [
    ['Video conversion', tools.ffmpeg, versions.ffmpeg, true],
    ['Video reading', tools.ffprobe, versions.ffprobe, true],
    ['Disc building', tools.dvdauthor, versions.dvdauthor, true],
    ['Menu buttons', tools.spumux, versions.spumux, true],
    ['Disc writing (macOS)', tools.hdiutil, versions.hdiutil, false],
  ];

  const table = el('table', { class: 'diag-table' });
  table.append(el('tr', {}, [el('th', { text: 'Part' }), el('th', { text: 'Status' }), el('th', { text: 'Location' })]));
  for (const [label, path, version, required] of rows) {
    table.append(
      el('tr', {}, [
        el('td', {}, [
          el('div', { text: label }),
          el('div', { class: 'dim', style: 'font-size:11px', text: version || (path ? '' : 'not found') }),
        ]),
        el('td', {
          class: path ? 'diag-ok' : required ? 'diag-bad' : 'dim',
          text: path ? 'Ready' : required ? 'Missing' : 'Not needed here',
        }),
        el('td', { class: 'path-cell', text: path || '\u2014' }),
      ])
    );
  }

  body.append(
    el('div', { class: 'stats', style: 'margin-bottom: 16px' }, [
      el('div', { class: 'stat' }, [
        el('span', { class: 'stat-key', text: 'This computer' }),
        el('span', { class: 'stat-value', text: `${tools.platform} ${tools.arch}` }),
      ]),
      el('div', { class: 'stat' }, [
        el('span', { class: 'stat-key', text: 'Working folder' }),
        el('span', { class: 'stat-value mono', text: workDir }),
      ]),
      el('div', { class: 'stat' }, [
        el('span', { class: 'stat-key', text: 'Prepared files' }),
        el('span', {
          class: 'stat-value',
          text: work.bytes
            ? `${formatBytes(work.bytes)} \u2014 ${
                (work.projects || 0) > 1
                  ? `${work.projects} projects, kept so rebuilding does not re-encode`
                  : 'kept so rebuilding does not re-encode'
              }`
            : 'nothing kept',
        }),
      ]),
    ]),
    table
  );

  /*
    What the disc writer check found, verbatim.

    A burner that is plugged in and still not listed is the one failure with no
    useful symptom: the page simply says none was found. The raw output of the
    system's own drive listing is included because an unfamiliar layout is the
    likeliest reason, and reading it back is the only way to tell.
  */
  try {
    const driveInfo = await api.drives.list();
    const found = (driveInfo && driveInfo.drives) || [];
    const section = el('div', { style: 'margin-top: 18px' }, [
      el('div', { class: 'rule', text: 'Disc writer' }),
      el('p', {
        class: 'hint',
        style: 'margin-bottom: 10px',
        text: found.length
          ? `${found.length} ${found.length === 1 ? 'writer' : 'writers'} found.`
          : driveInfo && driveInfo.note
            ? driveInfo.note
            : 'No disc writer was found. Plug the burner in and press Refresh.',
      }),
    ]);

    for (const drive of found) {
      section.append(
        el('div', { class: 'stat', style: 'margin-bottom: 4px' }, [
          el('span', { class: 'stat-key', text: drive.device }),
          el('span', {
            class: 'stat-value',
            text: `${drive.label || 'unknown'}  \u00b7  ${drive.supportLevel || 'no support level'}${
              drive.media && drive.media.present ? '  \u00b7  disc in drive' : '  \u00b7  no disc'
            }`,
          }),
        ])
      );
    }

    if (driveInfo && driveInfo.raw) {
      section.append(
        el('details', { style: 'margin-top: 10px' }, [
          el('summary', { class: 'hint', text: 'What the system reported' }),
          el('pre', { class: 'diag-raw', text: String(driveInfo.raw).trim() || '(nothing)' }),
        ])
      );
    }
    if (driveInfo && driveInfo.error) {
      section.append(el('p', { class: 'hint', text: `Error: ${driveInfo.error}` }));
    }

    body.append(section);
  } catch (err) {
    body.append(
      el('p', { class: 'hint', style: 'margin-top: 14px', text: `Disc writer check failed: ${String(err.message || err)}` })
    );
  }

  /*
    Say exactly what is missing and how to get it.

    This used to tell Windows users the tools "cannot be installed", which is
    wrong: they exist, they are just not in any Windows package manager. Burning
    needs nothing installed on any platform — Windows writes discs through its
    own IMAPI2 — so the only gap is the disc-building program, and that is worth
    naming precisely rather than blaming the operating system.
  */
  if (!tools.canAuthor) {
    const missing = !tools.ffmpeg ? 'ffmpeg' : 'dvdauthor';
    const how = tools.platform === 'darwin'
      ? 'Open Terminal and run:  brew install ffmpeg dvdauthor'
      : 'dvdauthor has no Windows package, so it has to come from a program that ships it: ' +
        '"GUI for dvdauthor" and DVD Styler both include dvdauthor.exe and spumux.exe. ' +
        'Copy those two files into ' +
        '%LOCALAPPDATA%\\Burnhouse\\bin, or leave them in that program\'s folder and ' +
        'press Check Again.';

    body.append(
      el('div', { style: 'margin-top: 18px' }, [
        buildBanner({
          kind: 'info',
          title: `Missing: ${missing}`,
          body: how,
        }),
      ])
    );
  }

  if (tools.canAuthor && !tools.canBurn) {
    body.append(
      el('div', { style: 'margin-top: 18px' }, [
        buildBanner({
          kind: 'info',
          title: 'This computer cannot write discs',
          body:
            'The disc can be built and tested here, then the folder or image copied to a ' +
            'computer with a disc writer.',
        }),
      ])
    );
  }

  /*
    The writing options that are worth a choice.

    Checking a disc after writing it is the difference between knowing it is good
    and hoping — and it is also the single biggest cost left in a burn, because
    it reads the whole disc back and that takes about as long again as writing
    it. It stays on, but it is hers to turn off, and the wording says what
    turning it off actually costs rather than pretending it is free.
  */
  if (tools.canBurn) {
    body.append(
      el('div', { style: 'margin-top: 18px' }, [
        el('div', { class: 'rule', text: 'Writing a disc' }),
        switchRow({
          checked: state.settings ? state.settings.verifyBurn !== false : true,
          title: 'Check the disc after writing it',
          desc:
            'Reading the disc back proves it was written properly. It takes about as long ' +
            'again as the writing did. Turn it off and the burn finishes in half the time, ' +
            'but a bad disc is only found when you play it.',
          onChange: async (next) => {
            await api.settings.set({ verifyBurn: next });
            state.settings = await api.settings.get();
          },
        }),
      ])
    );
  }

  body.append(
    el('div', { class: 'btn-row', style: 'margin-top: 16px' }, [
      el('button', {
        class: 'btn btn-small',
        type: 'button',
        text: 'Change Working Folder\u2026',
        onclick: async () => {
          const chosen = await api.files.pickFolder({ title: 'Where should Burnhouse keep its working files?' });
          if (chosen.canceled) return;
          await api.settings.set({ workDir: chosen.path });
          state.settings = await api.settings.get();
          renderSetupDialog();
        },
      }),
      el('button', {
        class: 'btn btn-small btn-quiet',
        type: 'button',
        text: 'Open Working Folder',
        onclick: () => api.files.open(workDir).catch(() => {}),
      }),
      work.bytes
        ? el('button', {
            class: 'btn btn-small btn-quiet',
            type: 'button',
            text: 'Clear Working Files\u2026',
            title:
              'Deletes the prepared videos and disc structure. Your project and your ' +
              'own video files are not touched.',
            onclick: async () => {
              try {
                const answer = await api.work.clear();
                if (answer && answer.canceled) return;
                /*
                  The page was told a disc was ready. It is not any more, and
                  leaving that showing would offer a Burn that fails.
                */
                state.lastBuild = null;
                state.buildState = null;
                renderSetupDialog();
                render();
              } catch (err) {
                body.prepend(
                  buildBanner({
                    kind: 'error',
                    title: 'The working files could not be deleted',
                    body: String(err.message || err),
                  })
                );
              }
            },
          })
        : null,
    ].filter(Boolean))
  );
}

async function recheckTools() {
  $('setupBody').replaceChildren(el('p', { class: 'dim', text: 'Checking\u2026' }));
  await renderSetupDialog();
  updateBrandTag();
  render();
}

async function openShare() {
  $('shareOverlay').hidden = false;
  const body = $('shareBody');
  body.replaceChildren(el('p', { class: 'dim', text: 'Starting\u2026' }));

  try {
    const info = await api.server.start({});
    body.replaceChildren();
    body.append(
      buildBanner({
        kind: 'info',
        title: 'Sharing is on',
        body: 'Another computer on this network can send videos here and download the app.',
      })
    );

    const rows = el('div', { class: 'stats' });
    for (const address of info.addresses || []) {
      rows.append(
        el('div', { class: 'stat' }, [
          el('span', { class: 'stat-key', text: address.label || 'Address' }),
          el('span', { class: 'stat-value mono', text: address.url }),
        ])
      );
    }
    body.append(rows);

    body.append(el('div', { class: 'rule', text: 'Ready to download' }));
    if (info.downloads && info.downloads.length) {
      body.append(
        el('ul', { class: 'checklist' }, info.downloads.map((d) =>
          el('li', { text: `${d.name} (${formatBytes(d.sizeBytes)})` })
        ))
      );
    } else {
      body.append(
        el('p', {
          class: 'hint',
          text: 'No built app was found yet. Once the Mac build finishes, the .dmg appears here.',
        })
      );
    }

    body.append(
      el('div', { class: 'btn-row', style: 'margin-top: 16px' }, [
        el('button', {
          class: 'btn btn-small btn-danger',
          type: 'button',
          text: 'Turn Sharing Off',
          onclick: async () => {
            await api.server.stop();
            body.replaceChildren(el('p', { class: 'dim', text: 'Sharing is off.' }));
          },
        }),
      ])
    );
  } catch (err) {
    body.replaceChildren(
      buildBanner({ kind: 'error', title: 'Sharing could not start', body: String(err.message || err) })
    );
  }
}

function openHelp() {
  $('helpOverlay').hidden = false;
  $('helpBody').replaceChildren(
    el('h2', { text: 'Three steps' }),
    el('ol', { class: 'checklist', style: 'margin-bottom: 18px' }, [
      el('li', { text: 'Open the Videos tab and add your videos. They appear on the menu slide straight away.' }),
      el('li', { text: 'Arrange the slides. The first one is the menu; the rest are yours to fill.' }),
      el('li', { text: 'Press Finish, put a blank DVD-R in the burner, and press Burn.' }),
    ]),
    el('h2', { text: 'What a slide is' }),
    el('p', {
      class: 'hint',
      style: 'margin-bottom: 18px',
      text:
        'A slide is one page of the disc menu \u2014 what appears on screen when the ' +
        'disc starts. Make as many as you like. Add one with "Add blank slide", or ' +
        'press "Add menu slide" for a page that lists every video. Nothing is ever ' +
        'put on a page for you, so a page is exactly what you see on it: a way back ' +
        'is a button you add and point at the page you want. The Menu key on any ' +
        'DVD remote goes back to the first page from anywhere.',
    }),
    el('h2', { text: 'Putting a video on a slide' }),
    el('p', {
      class: 'hint',
      style: 'margin-bottom: 18px',
      text:
        'Open the Videos tab on the right, then drag a video from that list onto a ' +
        'slide. That puts a tile showing the video itself, with its name and ' +
        'length \u2014 sized to fit, in the video\u2019s own shape. Choosing it on the ' +
        'disc plays the video. Drop it on the slide list on the left instead and ' +
        'it makes a whole new slide for that video.',
    }),
    el('h2', { text: 'Making something clickable' }),
    el('p', {
      class: 'hint',
      style: 'margin-bottom: 18px',
      text:
        'A button goes to another slide: choose where in "Goes to". A picture can do ' +
        'exactly the same \u2014 click it, set "Goes to" in the panel on the right, and the ' +
        'remote will land on the picture and open that slide when it is pressed. Leave ' +
        'it on "None" and the picture is just a picture. Point either one at a slide ' +
        'holding a video and it plays that video straight away.',
    }),
    el('h2', { text: 'Choosing something that is underneath something else' }),
    el('p', {
      class: 'hint',
      style: 'margin-bottom: 18px',
      text:
        'A big picture covers everything behind it, so it is what a click lands on. ' +
        'Click the same spot again and the click goes to the next thing down, and ' +
        'again for the one below that \u2014 so a small picture or a line of text under ' +
        'a large one is always reachable, whichever one is on top. The panel says ' +
        'when there is something under what you have selected, so you know to click ' +
        'once more.',
    }),
    el('h2', { text: 'A picture behind the words' }),
    el('p', {
      class: 'hint',
      style: 'margin-bottom: 18px',
      text:
        'A picture used as the background is darkened a little, so words and buttons ' +
        'stay readable over it. The "Darkening" slider under it decides how much: all ' +
        'the way to the left leaves the picture exactly as it came out of the camera, ' +
        'all the way right is the usual amount. Each slide has its own.',
    }),
    el('h2', { text: 'Working on several things at once' }),
    el('p', {
      class: 'hint',
      style: 'margin-bottom: 18px',
      text:
        `Hold ${addToSelectionKey()} and click to select more than one thing on a slide. ` +
        'The panel on the right then shows only the properties they all have, and ' +
        'changing one changes it on all of them \u2014 line up three buttons, or give every ' +
        'label the same size, in one go. Where they differ the row says "mixed". Drag ' +
        'one of them and the rest come too. Delete removes the lot, and Escape lets go ' +
        'of the selection.',
    }),
    el('h2', { text: 'Music on a menu page' }),
    el('p', {
      class: 'hint',
      style: 'margin-bottom: 18px',
      text:
        'Press "+ Sound" in the toolbar, or drop a sound file straight onto a slide, and ' +
        'that page plays it while it is on screen. A DVD menu has one sound track, so it ' +
        'is one per page \u2014 give another slide its own if you want something else there. ' +
        'When the sound ends the page waits for the remote as usual, so a long song never ' +
        'holds anything up. Music shows up in the DVD player on the Testing step, and a ' +
        'small note appears on the slide in the list so you can see which pages have it.',
    }),
    el('h2', { text: 'Moving things around' }),
    el('p', {
      class: 'hint',
      style: 'margin-bottom: 18px',
      text:
        'Drag anything on the slide to move it, or use the arrow keys. Click it once and ' +
        'little square handles appear on its edges and corners \u2014 drag those to make it ' +
        'bigger or smaller. Videos and pictures keep their shape while you do, so nothing ' +
        'gets stretched; hold Shift if you really do want to stretch one. Words and ' +
        'buttons are held inside the safe area, because some televisions crop the edge ' +
        'of the picture. A picture has no such limit: make it as big as you like and drag ' +
        'it anywhere, including right off the slide, so a photograph can fill the frame. ' +
        'If one ends up out of reach, its X and Y in the panel will bring it back. A ' +
        'background picture is removed by pointing at it in the panel and pressing the ' +
        'cross that appears over it.',
    }),
    el('h2', { text: 'Right-clicking' }),
    el('p', {
      class: 'hint',
      style: 'margin-bottom: 18px',
      text:
        'Right-click anything on a slide for a menu: delete it, duplicate it, put it in ' +
        'front of or behind the other things, swap a video between filling the frame and ' +
        'showing the whole picture, or put it back to its automatic size. Right-clicking ' +
        'empty space offers to add something new.',
    }),
    el('h2', { text: 'Checking it before you burn' }),
    el('p', {
      class: 'hint',
      style: 'margin-bottom: 18px',
      text:
        'Step 2, Testing, plays the disc through a pretend DVD player. The menus, the ' +
        'button positions and the arrow-key movement are the disc\u2019s own, so the ' +
        'highlight moves exactly where your remote will move it. Arrow keys move, Enter ' +
        'chooses, Menu goes back, Escape returns to the slides. The film plays your ' +
        'original file, so the burned copy will look the same but a little softer.',
    }),
    el('h2', { text: 'If something goes wrong' }),
    el('ul', { class: 'checklist', style: 'margin-bottom: 18px' }, [
      el('li', { text: 'The disc will not play: use a fresh DVD-R, and keep the burner plugged in.' }),
      el('li', { text: 'A video was left off: it may be damaged, or in a format that cannot be read.' }),
      el('li', { text: 'Anything else: press Details at the bottom to see exactly what happened.' }),
    ]),
    el('h2', { text: 'Your videos are never changed' }),
    el('p', {
      class: 'hint',
      text:
        'Burnhouse only ever reads your original files. Everything it makes goes in ' +
        'its own folder, so nothing you already have can be altered or lost.',
    })
  );
}

// ------------------------------------------------------------ canvas input ---

function bindCanvas() {
  // Bound once, on the document, because the canvas is recreated on each
  // render. Handlers check whether the event is on the canvas.
  let drag = null;
  /**
   * Where the last press landed, so pressing the same place again can step down
   * through whatever is stacked there.
   *
   * Nothing has to clear it: a press anywhere else fails the "same place" test,
   * so the next press there starts at the top of the stack again.
   */
  let lastPress = null;

  document.addEventListener('pointerdown', (event) => {
    const canvas = event.target.closest && event.target.closest('#slideCanvas');
    if (!canvas) return;
    if (event.button === 2) return; // right-click is the context menu's job
    const layout = activeSlideLayout();
    if (!layout) return;

    closeElementMenu();

    const point = canvasPoint(event);

    /*
      A handle wins over whatever is underneath it.

      The handles sit on the element's own border, so without this a press on a
      corner would be read as a press on the element and would start a move
      instead of a resize.
    */
    const current = state.selectedElementId
      ? layout.elements.find((e) => e.id === state.selectedElementId)
      : null;
    if (current) {
      const handle = handleAt(current.box, point);
      if (handle) {
        drag = {
          mode: 'resize',
          handle,
          id: current.id,
          startX: point.x,
          startY: point.y,
          origin: {
            x: current.x,
            y: current.y,
            width: current.width,
            height: current.height,
          },
          lockShape: SHAPE_LOCKED_KINDS.has(current.kind),
          moved: false,
        };
        canvas.setPointerCapture(event.pointerId);
        drawCanvas();
        return;
      }
    }

    /*
      What the press lands on, and where it landed.

      Pressing the same place twice steps down through the stack, which is how a
      smaller thing under a big transparent picture is reached at all.
    */
    const picked = pickAt(layout, point, lastPress);
    lastPress = picked.at;
    const hit = picked.element;

    /*
      A modifier means "add this to what I have", not "start over".

      Cmd, Ctrl and Shift all count, because the natural one differs by platform
      and on a Mac Ctrl-click is the system's own right-click anyway — a feature
      reachable only with Ctrl would be unreachable there.

      A modifier press toggles and stops; it never begins a drag. Dragging is how
      you move something, and doing it by accident while building a selection
      would be worse than having to press once more to move it.
    */
    const additive = event.metaKey || event.ctrlKey || event.shiftKey;
    if (additive) {
      if (hit) toggleElementSelection(hit.id);
      renderInspector();
      drawCanvas();
      return;
    }

    /*
      Pressing something already in a multiple selection keeps that selection, so
      the whole group can be dragged. Whether it turns out to be a click or a drag
      is only known on release — so the expansion is recorded here and undone
      there if nothing moved.
    */
    const wasSelected = hit ? isElementSelected(hit.id) : false;
    setElementSelectionIfOutside(hit);
    renderInspector();

    if (hit) {
      const group = selectedElements();
      const origins = group.map((element) => ({ id: element.id, x: element.x, y: element.y }));

      drag = {
        mode: 'move',
        id: hit.id,
        startX: point.x,
        startY: point.y,
        originX: hit.x,
        originY: hit.y,
        // Every element that will move, with where it started.
        group: origins.length > 1 ? origins : null,
        /*
          If this press kept a multiple selection alive and then nothing moves,
          it was a plain click after all: "just this one". Collapsing on release
          is what lets a click narrow the selection while a drag moves all of it,
          without having to guess which one it is going to be.
        */
        collapseTo: wasSelected && state.selectedElementIds.length > 1 ? hit.id : null,
        moved: false,
      };
      canvas.setPointerCapture(event.pointerId);
      drawCanvas();
    } else {
      drawCanvas();
    }
  });

  document.addEventListener('pointermove', (event) => {
    if (!drag) {
      // Show the resize cursor before the press, so the border reads as grabbable.
      const canvas = event.target.closest && event.target.closest('#slideCanvas');
      if (!canvas) return;
      const current = state.selectedElementId
        ? (activeSlideLayout() || { elements: [] }).elements.find(
            (e) => e.id === state.selectedElementId
          )
        : null;
      const handle = current ? handleAt(current.box, canvasPoint(event)) : null;
      canvas.style.cursor = handle ? HANDLE_CURSORS[handle] : 'default';
      return;
    }
    const canvas = $('slideCanvas');
    if (!canvas) return;
    const point = canvasPoint(event);
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    if (!drag.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    drag.moved = true;

    const { element } = findElement(drag.id);
    if (!element) return;

    // The laid-out slide, for the things there are to line up with. Only the
    // element being dragged moves during a drag, and it is excluded by id, so
    // the other boxes stay good even as the layout is refreshed.
    const layout = activeSlideLayout();

    if (drag.mode === 'resize') {
      // Shift frees the shape, for the rare case she wants it stretched.
      const lock = drag.lockShape && !event.shiftKey;
      const box = resizeBox(drag.handle, drag.origin, dx, dy, lock);
      element.x = box.x;
      element.y = box.y;
      element.width = box.width;
      element.height = box.height;
      // A text box that has been sized by hand keeps that size, rather than
      // snapping back to however tall its words happen to be. This is what makes
      // its background box usable as a panel.
      if (element.kind === 'text') element.autoHeight = false;
      clampElementInPlace(element);
      state.snapGuides = [];
    } else if (drag.group) {
      /*
        Several elements moving as one.

        Each keeps the offset it started with and is clamped on its own, so a
        group dragged into the edge of the safe area stacks up against it instead
        of the whole group stopping dead the moment its leading element does.
        Snapping and guides are left out here for the same reason: they describe
        one box, and there is no single box to describe.
      */
      for (const start of drag.group) {
        const moving = findElement(start.id).element;
        if (!moving) continue;
        moving.x = start.x + dx;
        moving.y = start.y + dy;
        clampElementInPlace(moving);
      }
      state.snapGuides = [];
    } else if (layout) {
      // Line it up with the safe area and with everything else on the slide.
      const snapped = snapBox(
        {
          x: drag.originX + dx,
          y: drag.originY + dy,
          width: element.width,
          height: element.height,
        },
        layout,
        element.id
      );
      element.x = snapped.x;
      element.y = snapped.y;
      state.snapGuides = snapped.guides;
      clampElementInPlace(element);
    } else {
      element.x = drag.originX + dx;
      element.y = drag.originY + dy;
      clampElementInPlace(element);
    }

    // A real layout, once a frame, so what is on screen is the element where it
    // actually is — including the caption and play mark a video tile re-derives
    // from its new size.
    redrawDuringDrag();
  });

  document.addEventListener('pointerup', () => {
    if (!drag) return;
    if (drag.moved) {
      // A full refresh now, so the filmstrip and the inspector numbers catch up.
      persistDeck();
      refreshCanvas();
      // The guides are part of the drag, not of the slide.
      state.snapGuides = [];
      drawCanvas();
    } else if (drag.collapseTo) {
      // It never moved, so it was a click on one of several: narrow to it.
      setElementSelection([drag.collapseTo], drag.collapseTo);
      renderInspector();
      drawCanvas();
    }
    drag = null;
  });

  /*
    Double-clicking an element to change its words.

    Nobody expects to have to find the panel and then find the right field in it
    to type into something they can see. Double-clicking is what everybody tries
    first, so it puts the caret in the field for them.
  */
  document.addEventListener('dblclick', (event) => {
    const canvas = event.target.closest && event.target.closest('#slideCanvas');
    if (!canvas) return;
    const layout = activeSlideLayout();
    if (!layout) return;

    const hit = gestureTarget(layout, canvasPoint(event));
    if (!hit) return;

    setElementSelection([hit.id]);
    renderInspector();
    drawCanvas();

    if (hit.kind === 'text') focusInspectorField('text');
    else if (hit.kind === 'button') focusInspectorField('label');
  });

  /*
    Right-click an element for the things she would otherwise have to hunt for.
    Anything that can be done to the thing under the pointer is here, including
    the one operation everybody expects and no menu ever shows: deleting it.
  */
  document.addEventListener('contextmenu', (event) => {
    const canvas = event.target.closest && event.target.closest('#slideCanvas');
    if (!canvas) return;
    const layout = activeSlideLayout();
    if (!layout) return;

    event.preventDefault();
    const point = canvasPoint(event);
    const hit = gestureTarget(layout, point);

    if (hit) {
      setElementSelection([hit.id]);
      renderInspector();
      drawCanvas();
      openElementMenu(event, hit, layout);
    } else {
      clearElementSelection();
      renderInspector();
      drawCanvas();
      openCanvasMenu(event);
    }
  });

  /*
    Single unified drop router for the whole window.
  */
  window.addEventListener('dragover', (event) => {
    // A slide being reordered is not a file arriving. Styling it as one, and
    // offering a "copy" cursor for a move, would both be wrong.
    if (hasSlideDrag(event)) {
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      return;
    }
    event.preventDefault();
    if (!hasVideoDrag(event)) {
      document.body.classList.add('dropping-files');
    }
    event.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (event) => {
    if (event.relatedTarget) return;
    document.body.classList.remove('dropping-files');
  });

  window.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    document.body.classList.remove('dropping-files');

    const overFilmstrip = event.target.closest && event.target.closest('.editor-filmstrip');

    // Case 1: Dragging a video from the Videos tab inside the app
    const videoId = dragVideoId(event);
    if (videoId) {
      const video = state.videos.find((v) => v.id === videoId);
      if (!video) return;

      if (overFilmstrip) {
        dropVideoOnFilmstrip(video);
      } else {
        dropVideoOnCanvas(video);
      }
      return;
    }

    // Case 2: Dragging video files from Finder or Windows Explorer
    const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
    if (!files.length) return;

    if (overFilmstrip) {
      importFilesOntoFilmstrip(files);
    } else {
      importFilesOntoSlide(files);
    }
  });
}

/**
 * The id of the video being dragged, or null.
 */
function dragVideoId(event) {
  if (!event.dataTransfer) return null;
  return event.dataTransfer.getData('application/x-burnhouse-video') || null;
}

// ------------------------------------------------------------ context menu ---

/** Close any open right-click menu. Cheap enough to call defensively. */
function closeElementMenu() {
  for (const node of document.querySelectorAll('.context-menu')) node.remove();
}

/** Place a menu at the pointer, nudged so it never hangs off the window. */
function placeMenu(menu, event) {
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  const margin = 8;
  const x = Math.min(event.clientX, window.innerWidth - rect.width - margin);
  const y = Math.min(event.clientY, window.innerHeight - rect.height - margin);
  menu.style.left = `${Math.max(margin, x)}px`;
  menu.style.top = `${Math.max(margin, y)}px`;
  const first = menu.querySelector('.context-item:not(:disabled)');
  if (first) first.focus();
}

function buildContextMenu(entries) {
  const menu = el('div', { class: 'context-menu', role: 'menu' });
  for (const entry of entries) {
    if (entry.separator) {
      menu.append(el('div', { class: 'context-sep' }));
      continue;
    }
    const button = el('button', {
      class: `context-item${entry.danger ? ' context-danger' : ''}`,
      type: 'button',
      role: 'menuitem',
      text: entry.label,
      disabled: Boolean(entry.disabled),
      onclick: () => {
        closeElementMenu();
        entry.action();
      },
    });
    if (entry.hint) button.append(el('span', { class: 'context-hint', text: entry.hint }));
    menu.append(button);
  }
  return menu;
}

/**
 * What can be done to the element that was right-clicked.
 *
 * Everything here is also reachable some other way, but this is where a person
 * looks first — and deleting is the one nobody can find otherwise.
 */
function openElementMenu(event, element, layout) {
  closeElementMenu();

  const { slide } = findElement(element.id);
  const entries = [];

  if (element.kind === 'text') {
    entries.push({
      label: 'Edit the words',
      action: () => {
        if (!focusInspectorField('text')) openInspectorTextPrompt(element.id);
      },
    });
  } else if (element.kind === 'button') {
    entries.push({
      label: 'Edit the words',
      action: () => {
        if (!focusInspectorField('label')) openInspectorTextPrompt(element.id);
      },
    });
  }

  if (element.kind === 'video' || element.kind === 'image') {
    const isFill = element.fit === 'fill';
    entries.push({
      label: isFill ? 'Show the whole picture' : 'Fill the frame',
      hint: isFill ? '' : 'may crop',
      action: () => {
        updateElement(element.id, { fit: isFill ? 'fit' : 'fill' });
      },
    });
    entries.push({
      label: 'Fit to the slide again',
      action: () => refitElement(element.id),
    });
  }

  if (element.videoId) {
    const video = state.videos.find((v) => v.id === element.videoId);
    if (video) {
      entries.push({
        label: 'Preview on the DVD player',
        action: async () => {
          // Starts that film, then shows the Testing step, which is where the
          // player lives.
          await openSimulator({ startTitleVideoId: video.id });
        },
      });
    }
  }

  if (entries.length) entries.push({ separator: true });

  entries.push(
    {
      label: 'Duplicate',
      action: () => duplicateElement(element.id),
    },
    {
      label: 'Bring to the front',
      action: () => reorderElement(element.id, 'front'),
    },
    {
      label: 'Send to the back',
      action: () => reorderElement(element.id, 'back'),
    }
  );

  entries.push({ separator: true });

  /*
    Everything can be deleted, with nothing exempt.

    The Back/Next row used to appear here as a disabled entry, because it was
    placed by the layout rather than by her and removing it would have been a
    lie — the next redraw would have put it back. That row is gone, so this is
    the only case left.
  */
  entries.push({
    label: 'Delete',
    danger: true,
    hint: 'Del',
    action: () => deleteElement(element.id),
  });

  void layout;
  void slide;
  placeMenu(buildContextMenu(entries), event);
}

/** Right-clicking bare canvas: put something new here. */
function openCanvasMenu(event) {
  closeElementMenu();
  placeMenu(
    buildContextMenu([
      { label: 'Add a text box', action: () => addElement('text', { x: 120, y: 160 }) },
      { label: 'Add a picture\u2026', action: () => pickPicture() },
      { label: 'Add a panel', action: () => addElement('frame', { x: 140, y: 150 }) },
      { separator: true },
      { label: 'Add a blank slide', action: () => addSlide({ title: 'New slide' }) },
      {
        label: 'Test the disc on the DVD player',
        action: () => goToStep('testing'),
      },
    ]),
    event
  );
}

/**
 * Right-clicking a slide in the list.
 *
 * The same idea as the element menu, for the other thing on screen. Deleting a
 * slide had no home at all before this: it could only be reached by selecting
 * the slide and finding a button somewhere else, which is not where anybody
 * looks for "get rid of this one".
 *
 * Moving a slide lives here too, because the order is not cosmetic — it decides
 * which menu page is which and which film plays after which.
 */
function openSlideMenu(event, slide) {
  closeElementMenu();

  const index = state.deck.slides.findIndex((s) => s.id === slide.id);
  const entries = [
    {
      label: 'Rename',
      action: () => {
        if (!focusInspectorField('slide-title')) openInspectorTextPrompt(slide.id);
      },
    },
    { label: 'Duplicate', action: () => duplicateSlide(slide.id) },
    { separator: true },
    {
      label: 'Move up',
      disabled: index <= 0,
      action: () => moveSlide(slide.id, -1),
    },
    {
      label: 'Move down',
      disabled: index === state.deck.slides.length - 1,
      action: () => moveSlide(slide.id, 1),
    },
    {
      label: 'Add a blank slide after',
      action: () => addSlide({ at: index + 1 }),
    },
    { separator: true },
    {
      label: 'Delete this slide',
      danger: true,
      disabled: state.deck.slides.length <= 1,
      hint: state.deck.slides.length <= 1 ? 'the last one' : '',
      action: () => deleteSlide(slide.id),
    },
  ];

  placeMenu(buildContextMenu(entries), event);
}

/** Put a copy of an element on the same slide, offset so it is visibly a copy. */
function duplicateElement(elementId) {
  const { slide, element } = findElement(elementId);
  if (!slide || !element) return;
  const copy = JSON.parse(JSON.stringify(element));
  copy.id = newId(element.kind);
  copy.x = element.x + 16;
  copy.y = element.y + 16;
  slide.elements.push(copy);
  clampElementInPlace(copy);
  setElementSelection([copy.id]);
  persistDeck();
  render();
}

/**
 * Move an element in front of everything else on its slide, or behind it.
 *
 * This changes the element's priority rather than only its place in the array,
 * because priority is what decides stacking now. The array is reordered as well
 * so that elements which share a priority keep a stable order between them.
 */
function reorderElement(elementId, where) {
  const { slide, element } = findElement(elementId);
  if (!slide) return;

  const others = slide.elements.filter((e) => e.id !== elementId);
  const priorities = others.map((e) => Number(e.priority) || 0);

  // Lower is nearer the front, so coming forward means going below everything
  // else and going back means going above it.
  if (priorities.length) {
    element.priority =
      where === 'front' ? Math.min(...priorities) - 1 : Math.max(...priorities) + 1;
  }

  slide.elements = others;
  if (where === 'front') slide.elements.push(element);
  else slide.elements.unshift(element);

  persistDeck();
  render();
}

/** Give a video tile or picture its automatic size and place back. */
function refitElement(elementId) {
  const { element } = findElement(elementId);
  if (!element) return;

  if (element.kind === 'video') {
    const video = state.videos.find((v) => v.id === element.videoId);
    const geom = fitTileToSlide(video || { probe: null });
    Object.assign(element, geom, { fit: 'fill' });
  } else if (element.kind === 'image') {
    // A picture keeps its own shape; only its footprint is reset.
    const width = RASTER.width - SAFE_MARGIN * 2;
    const box = resizeBox('se', { x: 0, y: 0, width, height: width }, 0, 0, true);
    element.width = width;
    element.height = Math.max(MIN_ELEMENT_HEIGHT, Math.round(box.height));
    element.x = SAFE_MARGIN;
    element.y = SAFE_MARGIN;
    element.fit = 'fit';
  } else {
    return;
  }

  clampElementInPlace(element);
  persistDeck();
  render();
}

/** Fallback for editing text when the inspector has nothing to focus. */
function openInspectorTextPrompt(elementId) {
  const { element } = findElement(elementId);
  if (!element) return;
  const next = window.prompt('The words on this slide:', element.text || '');
  if (next === null) return;
  updateElement(elementId, { text: next, edited: true });
}

// ---------------------------------------------------------- dvd simulator ---

/**
 * The simulator's state. One object, so the whole of the pretend player can be
 * reasoned about at once.
 */
const sim = {
  open: false,
  model: null,
  /** 'menu' or 'title' — the two domains a real player switches between. */
  domain: 'menu',
  page: 1,
  title: null,
  focus: null,
  /** Which menu page the Menu key returns to. */
  rootPage: 1,
  showsHighlight: true,
  message: null,
  messageUntil: 0,
  /** The page's sound, while it is playing. Stopped whenever the page is left. */
  menuAudio: null,
};

/**
 * The keys the pretend player answers to.
 *
 * Chosen so every one of them exists on both a Mac and a Windows keyboard, and
 * so none of them needs a modifier — a laptop with no numeric keypad still has
 * all of these. Digits pick a title directly, which is what a real remote's
 * number buttons do.
 */
const SIM_KEY_LEGEND = [
  { keys: '\u2190 \u2191 \u2193 \u2192', what: 'move' },
  { keys: 'Enter', what: 'choose' },
  { keys: 'M', what: 'menu' },
  { keys: 'Backspace', what: 'back' },
  { keys: 'Space', what: 'play / pause' },
  { keys: '1\u20139', what: 'title' },
  { keys: ', .', what: 'previous / next' },
  { keys: 'S', what: 'stop' },
  { keys: 'Esc', what: 'exit' },
];

/** Back to the previous menu page, the way a remote's Return does. */
function simulateBack() {
  if (!sim.model || !sim.model.menus.length) return;
  if (sim.domain === 'title') {
    simulateMenuKey();
    return;
  }
  const current = sim.page;
  const earlier = sim.model.menus.filter((m) => m.page < current);
  enterMenu(earlier.length ? earlier[earlier.length - 1].page : sim.rootPage);
  renderSimulator();
}

/** Play or pause the film, if one is playing. */
function simulatePlayPause() {
  const player = simVideoElement();
  if (!player || sim.domain !== 'title') return;
  if (player.paused) {
    const attempt = player.play();
    if (attempt && attempt.catch) attempt.catch(() => {});
  } else {
    player.pause();
  }
  updateSimClock();
}

/** Stop the film and go back to the menu, like a player's Stop button. */
function simulateStop() {
  if (sim.domain === 'title') {
    simulateMenuKey();
    return;
  }
  // On a menu, Stop restarts whatever a player would: the first-play item.
  if (sim.model && sim.model.firstPlay.type === 'menu') enterMenu(sim.model.firstPlay.number);
  else if (sim.model && sim.model.titles.length) enterTitle(1);
  renderSimulator();
}

/** Step to the next or previous film, as the skip keys do. */
function simulateSkip(delta) {
  if (!sim.model || !sim.model.titles.length) return;
  const current = sim.domain === 'title' ? sim.title : 0;
  const wanted = current + delta;
  if (wanted < 1) {
    simulateMenuKey();
    return;
  }
  const target = sim.model.titles.find((t) => t.number === wanted);
  if (target) enterTitle(target.number);
  else simulateMenuKey();
}

/** A digit key: play that title by number, as a remote's number pad does. */
function simulateTitleNumber(digit) {
  if (!sim.model) return;
  const target = sim.model.titles.find((t) => t.number === digit);
  if (target) enterTitle(target.number);
}

/**
 * Play the disc the way a DVD player would.
 *
 * This is not a mock-up of the design: it runs the disc's actual navigation
 * graph — the same table that gets written into the spumux file as explicit
 * up/down/left/right button names — over the same menu pictures the burn
 * renders. So arrow keys move the highlight exactly where the remote will move
 * it, Enter runs the same jump command, and a finished title returns to the
 * menu because the disc's post-command says so.
 *
 * Expected differences from the real thing, stated plainly because a preview
 * that quietly lies is worse than none:
 *   - the film plays the original file, not the MPEG-2 on the disc, so it looks
 *     the same but cleaner than the burned copy will;
 *   - a player decodes its highlight in a four-colour subpicture, so the real
 *     one is slightly flatter than the rectangle drawn here.
 * Everything about the menu — position, shape, which button, where the arrows
 * go — is the disc's own data.
 */
async function openSimulator(options = {}) {
  closeElementMenu();

  let model;
  try {
    model = await api.deck.discModel({
      deck: state.deck,
      videos: state.videos.map((v) => ({ id: v.id, name: v.name, menuLabel: v.menuLabel, duration: v.duration })),
      aspect: (state.deck && state.deck.aspect) || '16:9',
    });
  } catch (err) {
    setBanner('error', 'The DVD player could not start', String(err.message || err));
    render();
    return;
  }

  sim.model = model;
  sim.open = true;
  sim.rootPage = model.firstPlay.type === 'menu' ? model.firstPlay.number : 1;
  sim.message = null;

  // Resolve every film's URL up front, so pressing OK starts playback at once.
  simUrlCache.clear();
  try {
    const paths = state.videos.map((v) => v.path).filter(Boolean);
    const urls = await api.files.mediaUrls(paths);
    for (const [key, value] of Object.entries(urls || {})) simUrlCache.set(key, value);
  } catch {
    /* a film that cannot be resolved reports itself when it is chosen */
  }

  if (options.startTitleVideoId) {
    const title = model.titles.find((t) => t.videoId === options.startTitleVideoId);
    if (title) {
      enterTitle(title.number);
    } else {
      enterMenu(sim.rootPage);
    }
  } else {
    // A disc starts on its first-play item: the first menu page, or the film if
    // there is no menu at all.
    if (model.firstPlay.type === 'menu' && model.menus.length) enterMenu(model.firstPlay.number);
    else if (model.titles.length) enterTitle(1);
    else enterMenu(1);
  }

  bindSimulatorKeysOnce();

  /*
    Where the player should appear.

    Opening it takes a moment, because the disc's navigation comes from the main
    process. When the Testing step asks for it, that step owns the container and
    mounts it — and this must NOT navigate afterwards, or a request that was made
    while the Testing step was open would drag her back to it after she had
    already moved on. That is exactly what used to happen: leave Testing quickly
    and you would be returned to it a moment later.
  */
  if (options.navigate === false) {
    const wrap = $('testingPlayer');
    if (wrap && state.step === 'testing') mountSimulator(wrap);
    return true;
  }

  if (state.step !== 'testing') {
    goToStep('testing');
    return true;
  }

  const wrap = $('testingPlayer');
  if (wrap) mountSimulator(wrap);
  return true;
}

function closeSimulator() {
  sim.open = false;
  sim.model = null;
  sim.title = null;
  stopMenuSound();

  // The video element lives inside the player, so it goes with it; pause first
  // so a film does not keep playing invisibly.
  if (sim.dom) {
    try {
      sim.dom.video.pause();
      sim.dom.video.removeAttribute('src');
    } catch {
      /* nothing worth reporting */
    }
    sim.dom.root.remove();
    sim.dom = null;
  }
}

/**
 * The Testing step: the disc, playing, in the page.
 *
 * It is the second step rather than a button somewhere, because trying the disc
 * is something to do between designing it and writing it — and burning is
 * one-way, so it is the step that matters most.
 */
async function renderTestingStep(stage) {
  const wrap = el('div', { class: 'testing-step', id: 'testingPlayer' });
  stage.append(wrap);

  if (sim.open && sim.model) {
    mountSimulator(wrap);
    return;
  }

  // Opening asks the main process for the disc's navigation, so it is async. It
  // is told not to navigate, because this step is already where it belongs — and
  // by the time the answer arrives she may have left.
  await openSimulator({ navigate: false });
  if (state.step !== 'testing') return;
  if (sim.open && sim.model) mountSimulator(wrap);
}

/** Switch to a menu page, focusing its first button the way a player does. */
function enterMenu(pageNumber) {
  if (!sim.model || !sim.model.menus.length) return;
  const page = sim.model.menus.find((m) => m.page === pageNumber) || sim.model.menus[0];
  if (!page) return;
  pauseSimVideo();
  sim.domain = 'menu';
  sim.page = page.page;
  sim.title = null;
  sim.focus = page.buttons.length ? page.buttons[0].name : null;
  sim.showsHighlight = true;
  playMenuSound(page);
}

/**
 * Play the sound a menu page carries, if it has one.
 *
 * Straight from the source file rather than from the encoded AC-3, like the
 * films: what she hears is the song, not a second-generation copy of it. The
 * disc plays it for the same length, because the length was settled in the disc
 * model before either of them got hold of it.
 */
async function playMenuSound(page) {
  stopMenuSound();
  const sound = page && page.sound;
  if (!sound || !sound.path) return;

  try {
    const urls = await api.files.mediaUrls([sound.path]);
    const url = urls && urls[sound.path];
    if (!url) return;

    const audio = new Audio(url);
    audio.volume = 0.85;
    sim.menuAudio = audio;
    const attempt = audio.play();
    if (attempt && attempt.catch) attempt.catch(() => {});
  } catch {
    // A sound that will not play is not worth interrupting the preview over: the
    // picture, the buttons and the navigation are all still correct.
  }
}

function stopMenuSound() {
  if (!sim.menuAudio) return;
  try {
    sim.menuAudio.pause();
  } catch {
    /* already stopped */
  }
  sim.menuAudio = null;
}

/**
 * What the screen shows when the disc has no menu pages.
 *
 * A slide with no buttons is not a menu page — on a real disc it would be a page
 * with no way off it, so it is left out. But that left the simulator showing a
 * black rectangle, which reads as a broken preview rather than an empty project.
 * Showing the slide she actually designed, with an explanation, is both more
 * useful and more honest about why nothing can be chosen.
 */
function simFallbackSlide() {
  const slides = (state.deck && state.deck.slides) || [];
  return slides.length ? slides[0] : null;
}

function enterTitle(titleNumber) {
  if (!sim.model) return;
  const title = sim.model.titles.find((t) => t.number === titleNumber);
  if (!title) return;
  // The page's music belongs to the page. A film starting is the page ending.
  stopMenuSound();
  sim.domain = 'title';
  sim.title = title.number;
  sim.focus = null;
  sim.showsHighlight = false;
  playSimVideo(title.videoId);
}

/** The menu page currently on screen. */
function currentSimPage() {
  if (!sim.model) return null;
  return sim.model.menus.find((m) => m.page === sim.page) || null;
}

/** The button the highlight is on. */
function currentSimButton() {
  const page = currentSimPage();
  if (!page || !sim.focus) return null;
  return page.buttons.find((b) => b.name === sim.focus) || null;
}

/** Move the highlight the way the disc's own navigation table says. */
function simulateArrow(direction) {
  if (!sim.open || sim.domain !== 'menu') return;
  const page = currentSimPage();
  if (!page) return;
  const moves = page.navigation[sim.focus];
  if (!moves) return;
  const next = moves[direction];
  if (next && next !== sim.focus) {
    sim.focus = next;
    renderSimulator();
  }
}

/** Press Enter: run the button's command. */
function simulateEnter() {
  if (!sim.open || sim.domain !== 'menu') return;
  const button = currentSimButton();
  if (!button) return;

  // A player shows the "selected" state briefly before acting.
  sim.showsSelect = true;
  renderSimulator();

  window.setTimeout(() => {
    sim.showsSelect = false;
    if (!sim.open) return;
    if (button.action.type === 'title') enterTitle(button.action.number);
    else if (button.action.type === 'menu') enterMenu(button.action.number);
    renderSimulator();
  }, 180);
}

/** The Menu key, and returning from a finished film. */
function simulateMenuKey() {
  if (!sim.open || !sim.model || !sim.model.menus.length) return;
  enterMenu(sim.rootPage);
  renderSimulator();
}

function simVideoElement() {
  return $('simVideo');
}

function playSimVideo(videoId) {
  const video = state.videos.find((v) => v.id === videoId);
  const player = simVideoElement();
  if (!player || !video) return;

  // The URL was resolved when the simulator opened, so playback can start in
  // the same beat as the key press rather than waiting on the main process.
  const url = simUrlCache.get(video.path);
  if (!url) {
    sim.message = `Cannot play "${videoLabel(video)}" — the file could not be opened.`;
    renderSimulator();
    return;
  }

  sim.message = null;
  player.hidden = false;
  player.src = url;
  player.currentTime = 0;
  const attempt = player.play();
  if (attempt && attempt.catch) attempt.catch(() => {});
  renderSimulator();
}

function pauseSimVideo() {
  const player = simVideoElement();
  if (player) player.pause();
}

/** Path to playable URL, filled in by openSimulator before anything plays. */
const simUrlCache = new Map();

/**
 * Build the pretend player's DOM once.
 *
 * Every render used to rebuild the whole thing, which threw away the <video>
 * element: choosing a film set its source and started it playing, and then the
 * next render replaced it with a fresh, empty one. The result was a black
 * screen and silence. A media element has to survive from one render to the
 * next, so the skeleton is created here and only its contents are updated.
 */
function buildSimulatorDom() {
  const canvas = el('canvas', { class: 'sim-canvas', id: 'simCanvas' });

  const highlight = el('div', { class: 'sim-highlight', id: 'simHighlight', hidden: true });

  const video = el('video', { class: 'sim-video', id: 'simVideo', playsinline: 'true', hidden: true });
  video.addEventListener('ended', () => {
    /*
      What happens when a film finishes, which is whatever the disc's own
      post-command does: on to the next film in slide order, or back to the menu
      if there is not one. Both come from the same model, so the preview cannot
      promise something the burned disc will not do.
    */
    const next = sim.model && sim.model.nextTitleByNumber
      ? sim.model.nextTitleByNumber[sim.title]
      : null;
    if (next) {
      enterTitle(next);
      renderSimulator();
      return;
    }
    if (sim.model && sim.model.menus.length) simulateMenuKey();
  });
  video.addEventListener('timeupdate', () => updateSimClock());
  video.addEventListener('error', () => {
    sim.message = 'This film could not be played.';
    renderSimulator();
  });

  const osdBadge = el('span', { class: 'sim-osd-badge' });
  const osdName = el('span', { class: 'sim-osd-name' });
  const osdClock = el('span', { class: 'sim-osd-clock', id: 'simClock' });
  const osd = el('div', { class: 'sim-osd' }, [osdBadge, osdName, osdClock]);

  const empty = el('div', { class: 'sim-empty', hidden: true }, [
    el('strong', { text: 'Nothing to choose yet' }),
    el('span', {
      text:
        'This disc has no menu pages, so there is nothing to press. Put a button on ' +
        'a slide, or point a picture at another slide, and the pages appear here.',
    }),
  ]);

  /*
    The same notice, for a disc that has pages but the one on screen has nothing
    to press.

    A page of words, or a single photograph, is a real page — it is somewhere a
    button sends the viewer — so it is drawn like any other. Without a word about
    it, though, a page with no highlight on it looks like a player that has
    stopped working rather than a page with nothing on it. The remote's Menu key
    goes back to the first page from here, which is worth saying.
  */
  const barePage = el('div', { class: 'sim-empty', hidden: true }, [
    el('strong', { text: 'Nothing to press on this page' }),
    el('span', {
      text:
        'This page is here because something on the disc goes to it, and there is ' +
        'nothing on it to press. Put a button on it to come back, or press Menu to ' +
        'return to the first page.',
    }),
  ]);

  const message = el('div', { class: 'sim-message', hidden: true });

  const keys = el(
    'div',
    { class: 'sim-keys' },
    SIM_KEY_LEGEND.map((entry) =>
      el('span', { class: 'sim-key-hint' }, [
        el('kbd', { text: entry.keys }),
        el('span', { text: entry.what }),
      ])
    )
  );

  const screen = el('div', { class: 'sim-screen' }, [
    canvas,
    highlight,
    video,
    osd,
    empty,
    barePage,
    message,
    keys,
  ]);

  const root = el('div', { class: 'sim-root sim-embedded' });
  root.append(screen);

  return {
    root, screen, canvas, highlight, video, osdBadge, osdName, empty, barePage, message,
  };
}

/**
 * Put the player on screen.
 *
 * There is one player and one place it appears — the Testing step. It used to
 * have a second life as a full-screen overlay, which meant two containers and a
 * flag to say which one was in use; leaving that flag unstuck was how Escape
 * could close the player and leave the Testing page empty behind it. One
 * container means there is no flag to get wrong.
 */
function mountSimulator(container) {
  if (!sim.dom) sim.dom = buildSimulatorDom();
  const { root } = sim.dom;
  if (root.parentNode !== container) container.replaceChildren(root);
  renderSimulator();
}

function renderSimulator() {
  if (!sim.open || !sim.model) return;
  if (!sim.dom) sim.dom = buildSimulatorDom();

  const { root, screen, canvas, highlight, video, osdBadge, osdName, empty, barePage, message } =
    sim.dom;

  const page = currentSimPage();
  const button = currentSimButton();
  const title = sim.model.titles.find((t) => t.number === sim.title) || null;

  // With no menu pages there is nothing to choose, but the design is still worth
  // showing: a black rectangle looks like the preview is broken.
  const emptyDisc = !sim.model.menus.length;
  const fallbackSlide = emptyDisc ? simFallbackSlide() : null;
  const showingFilm = sim.domain === 'title';

  function layoutForSlideId(slideId) {
    if (!state.layout) return null;
    return state.layout.slides.find((s) => s.slide && s.slide.id === slideId) || null;
  }

  // The menu picture, drawn by the same code that renders the disc's menu, so
  // the layout cannot differ from what gets burned.
  if (!showingFilm) {
    const layout = page
      ? layoutForSlideId(page.slideId)
      : fallbackSlide
        ? layoutForSlideId(fallbackSlide.id)
        : null;
    if (layout) drawSimCanvas(canvas, layout);
  }

  // Hidden while a film plays, or the menu shows through the letterbox bars.
  canvas.hidden = showingFilm;

  // The highlight, positioned from the disc's own button rectangle. The screen
  // box is the same 16:9 stretch a television applies to the raster, so a
  // percentage of the raster is a percentage of the screen.
  const showHighlight = Boolean(button) && !showingFilm && sim.showsHighlight !== false;
  highlight.hidden = !showHighlight;
  if (showHighlight) {
    highlight.classList.toggle('sim-highlight-selected', Boolean(sim.showsSelect));
    highlight.style.left = `${(button.x0 / RASTER.width) * 100}%`;
    highlight.style.top = `${(button.y0 / RASTER.height) * 100}%`;
    highlight.style.width = `${((button.x1 - button.x0) / RASTER.width) * 100}%`;
    highlight.style.height = `${((button.y1 - button.y0) / RASTER.height) * 100}%`;
  }

  video.hidden = !showingFilm;

  osdBadge.textContent = showingFilm
    ? `Title ${sim.title}`
    : emptyDisc
      ? 'No menus'
      : `Menu ${sim.page}`;
  osdName.textContent = showingFilm
    ? (title ? title.name : '')
    : page
      ? page.title
      : fallbackSlide
        ? fallbackSlide.title
        : '';

  empty.hidden = !(emptyDisc && sim.domain === 'menu');
  /*
    A page that exists but has nothing on it. Shown only when the disc has other
    pages with something to press, so that it never competes with the notice
    above: if nothing anywhere is pressable, that is the thing to say.
  */
  barePage.hidden = !(
    !emptyDisc &&
    sim.domain === 'menu' &&
    page &&
    page.buttons.length === 0 &&
    sim.model.menus.some((other) => other.buttons.length > 0)
  );
  message.hidden = !sim.message;
  if (sim.message) message.textContent = sim.message;

  updateSimClock();
}

/**
 * A plain snapshot of the pretend player, for tests and for anything that wants
 * to know where the highlight is without re-deriving it.
 */
function simState() {
  const page = currentSimPage();
  const button = currentSimButton();
  return {
    open: sim.open,
    domain: sim.domain,
    page: sim.page,
    title: sim.title,
    focus: sim.focus,
    focusLabel: button ? button.label : null,
    focusRect: button
      ? { x0: button.x0, y0: button.y0, x1: button.x1, y1: button.y1 }
      : null,
    command: button ? button.command : null,
    moves: page && button && page.navigation[button.name] ? page.navigation[button.name] : null,
    menus: sim.model ? sim.model.menus.length : 0,
    titles: sim.model ? sim.model.titles.length : 0,
    rootPage: sim.rootPage,
  };
}

function updateSimClock() {
  const clock = $('simClock');
  if (!clock) return;
  const player = $('simVideo');
  if (sim.domain !== 'title' || !player) {
    clock.textContent = '';
    return;
  }
  const position = Number.isFinite(player.currentTime) ? player.currentTime : 0;
  const total = Number.isFinite(player.duration) ? player.duration : 0;
  clock.textContent = total ? `${formatDuration(position)} / ${formatDuration(total)}` : formatDuration(position);
}

/** Draw one menu page exactly as the disc renders it, with no editor furniture. */
async function drawSimCanvas(canvas, layout) {
  if (!canvas || !layout) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = layout.width * dpr;
  canvas.height = layout.height * dpr;
  const ctx = canvas.getContext('2d', { alpha: false });

  const images = await loadSlideImages(layout);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  draw.drawSlide(ctx, layout, images);
}

let simKeysBound = false;
function bindSimulatorKeysOnce() {
  if (simKeysBound) return;
  simKeysBound = true;

  document.addEventListener('keydown', (event) => {
    if (!sim.open) return;
    // The simulator owns the keyboard while it is up, or an arrow key would
    // nudge whichever element happened to be selected behind it.
    const keys = {
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    };
    if (keys[event.key]) {
      event.preventDefault();
      event.stopPropagation();
      simulateArrow(keys[event.key]);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      simulateEnter();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      // Back to the slides. The player is the Testing step, so there is nothing
      // to close — leaving the step is what closing it used to be.
      goToStep('slides');
      return;
    }
    if (event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      simulateBack();
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      simulatePlayPause();
      return;
    }
    if (event.key === 'm' || event.key === 'M') {
      event.preventDefault();
      event.stopPropagation();
      simulateMenuKey();
      return;
    }
    if (event.key === 's' || event.key === 'S') {
      event.preventDefault();
      event.stopPropagation();
      simulateStop();
      return;
    }
    if (event.key === '.' || event.key === '>') {
      event.preventDefault();
      event.stopPropagation();
      simulateSkip(1);
      return;
    }
    if (event.key === ',' || event.key === '<') {
      event.preventDefault();
      event.stopPropagation();
      simulateSkip(-1);
      return;
    }
    // The number pad, as a remote has.
    if (/^[1-9]$/.test(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      simulateTitleNumber(Number(event.key));
    }
  }, true);
}

/**
 * Dropping a video onto the slide puts the video itself there.
 *
 * It is automatically sized full-screen and centered perfectly in the television-safe
 * viewing area, leaving clean space for the navigation bar below it.
 * "I don't want to have to position or scale anything myself."
 *
 * If she is on Slide 1 (the master menu), it automatically creates a new slide for the
 * video so the menu is never cluttered with video tiles.
 */
function dropVideoOnCanvas(video) {
  let targetSlide = activeSlide();

  // Videos do not go on the first slide, which is the menu hub.
  if (!targetSlide || targetSlide.role === 'menu' || state.deck.slides.indexOf(targetSlide) === 0) {
    let found = state.deck.slides.find((s) => s.role !== 'menu' && s.elements.filter((e) => e.kind === 'video').length === 0);
    if (!found) {
      found = addSlideAtEnd();
    }
    targetSlide = found;
    state.activeSlideId = targetSlide.id;
  }

  // Clear any existing video tile or unedited text so the slide is a clean episode slide
  targetSlide.elements = targetSlide.elements.filter((e) => e.kind !== 'video' && !(e.kind === 'text' && !e.edited));

  /*
    The slide keeps the name it had.

    Dropping a video used to rename the slide after it, which quietly replaced a
    name she may have chosen and left a title that was a lie the moment the video
    was swapped or the slide moved. A slide is named "Slide 4" for where it is,
    or whatever she types.
  */

  const geom = fitTileToSlide(video);
  addElement('video', {
    videoId: video.id,
    label: videoLabel(video),
    sublabel: video.duration ? formatDuration(video.duration) : '',
    src: video.poster || null,
    posterMissing: !video.poster,
    width: geom.width,
    height: geom.height,
    x: geom.x,
    y: geom.y,
    fit: 'fill',
  });
}

/**
 * The size and centered position a video tile should be.
 *
 * The menu raster is anamorphic: a player stretches 720x480 to fill a
 * widescreen television. So the tile is computed in that stretched space — a
 * video that should look 16:9 on screen is 3:2 in raster units. Sizing it 16:9
 * in raster units instead makes it about 19% too wide on the television, which
 * is invisible here and obvious there.
 *
 * It fills the available space: the full safe height, then as wide as that
 * allows, exactly centred. Nothing to position or scale by hand.
 */
function fitTileToSlide(video) {
  const margin = SAFE_MARGIN;
  const maxAvailWidth = RASTER.width - margin * 2;
  /*
    The whole safe height, top margin to bottom margin.

    This stopped at 396 to leave the navigation row its band at y = 408..440 —
    a row that no longer exists, so leaving the gap would now be a strip of the
    picture reserved for nothing.
  */
  const maxAvailHeight = RASTER.height - margin * 2;

  const probe = (video && video.probe) || {};
  let displayAspect = probe.width && probe.height ? probe.width / probe.height : 16 / 9;
  if (!Number.isFinite(displayAspect) || displayAspect <= 0) displayAspect = 16 / 9;

  // Convert the shape it should *look* like into the raster shape to draw.
  const aspect = displayAspectToRaster(displayAspect);

  let width = maxAvailWidth;
  let height = Math.round(width / aspect);

  if (height > maxAvailHeight) {
    height = maxAvailHeight;
    width = Math.round(height * aspect);
  }
  if (width > maxAvailWidth) {
    width = maxAvailWidth;
    height = Math.round(width / aspect);
  }

  // Even dimensions, so the button rectangle lands on clean subpicture pixels.
  width = width % 2 === 0 ? width : width - 1;
  height = height % 2 === 0 ? height : height - 1;

  const x = Math.round((RASTER.width - width) / 2);
  const y = margin + Math.round((maxAvailHeight - height) / 2);

  return { width, height, x, y };
}

/**
 * Resolve dropped files to filesystem paths.
 */
function pathsFromFiles(files) {
  return Array.from(files || [])
    .map((f) => {
      try {
        return api.files.pathFor(f);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Files dropped straight from Finder / Windows Explorer.
 *
 * A picture becomes a picture on the slide, exactly as pressing "Add a picture"
 * would. Anything else is a video for the disc: the video is added and put on
 * the slide in one single gesture, with no second drag.
 */
async function importFilesOntoSlide(files) {
  const paths = pathsFromFiles(files);
  if (!paths.length) {
    setBanner(
      'info',
      'Use the Add Videos button instead',
      'Dragging from outside the window did not provide a file location. ' +
        'Open the Videos tab and press Add Videos.'
    );
    render();
    return;
  }
  return importPathsOntoSlide(paths);
}

/**
 * The same, from paths rather than from dropped files.
 *
 * Split out because resolving a dropped file to a path needs the main process,
 * and because this is the part worth testing: what a given set of files becomes.
 */
async function importPathsOntoSlide(paths) {
  /*
    Pictures are handled here and never handed to addVideoPaths.

    That is all that was wrong with dropping an image before: the drop went to
    the video importer, which answered "Some files were not videos — photo.png
    was skipped", and the picture never appeared. Dropping one on the slide is
    the first thing anybody tries, so it has to do the obvious thing.
  */
  const pictures = paths.filter((path) => looksLikeImage(path));
  for (let i = 0; i < pictures.length; i += 1) {
    try {
      await addPictureFromPath(pictures[i], i);
    } catch (err) {
      setBanner(
        'error',
        'That picture could not be used',
        `${basename(pictures[i])}: ${String(err.message || err)}`
      );
      render();
    }
  }

  /*
    A sound becomes this page's sound, the same as pressing + Sound.

    One per page, because a DVD menu page carries a single sound track — so a
    drop of several uses the first and says so rather than silently discarding
    the rest.
  */
  const sounds = paths.filter((path) => !looksLikeImage(path) && looksLikeAudio(path));
  if (sounds.length) {
    await setSlideSoundFromPath(activeSlide(), sounds[0]);
    if (sounds.length > 1) {
      setBanner(
        'info',
        'One sound per page',
        `A menu page has a single sound track, so "${basename(sounds[0])}" was used and ` +
          'the rest were left out. Add another slide to use one of those.'
      );
      render();
    }
  }

  const videos = paths.filter(
    (path) => !looksLikeImage(path) && !looksLikeAudio(path)
  );
  if (!videos.length) return;

  const added = await addVideoPaths(videos);
  if (!added.length) return;

  for (let i = 0; i < added.length; i++) {
    const video = added[i];
    if (i === 0) {
      const current = activeSlide();
      if (current && current.role !== 'menu' && state.deck.slides.indexOf(current) !== 0 && current.elements.filter((e) => e.kind === 'video').length === 0) {
        state.activeSlideId = current.id;
      } else {
        const newSlide = addSlideAtEnd();
        state.activeSlideId = newSlide.id;
      }
    } else {
      const newSlide = addSlideAtEnd();
      state.activeSlideId = newSlide.id;
    }
    dropVideoOnCanvas(video);
  }

  syncMenuSlides();
  persistDeck();
  render();
}

/** Files dropped onto the slide list: one new slide per file, showing it. */
async function importFilesOntoFilmstrip(files) {
  const paths = pathsFromFiles(files);
  if (!paths.length) return;
  return importPathsOntoFilmstrip(paths);
}

async function importPathsOntoFilmstrip(paths) {
  // A picture makes a new slide showing it, exactly as a video does. Sent to the
  // video importer it would be rejected as "not a video" and the drop would
  // quietly do nothing.
  const pictures = paths.filter((path) => looksLikeImage(path));
  for (const picture of pictures) {
    const slide = addSlideAtEnd();
    state.activeSlideId = slide.id;
    try {
      await addPictureFromPath(picture);
    } catch (err) {
      setBanner(
        'error',
        'That picture could not be used',
        `${basename(picture)}: ${String(err.message || err)}`
      );
      render();
    }
  }

  const videos = paths.filter((path) => !looksLikeImage(path));
  if (!videos.length) return;

  const added = await addVideoPaths(videos);
  if (!added.length) return;
  for (const video of added) dropVideoOnFilmstrip(video);
}

/**
 * Dropping a video onto the slide list makes a new slide at the end, showing it.
 *
 * The slide is named for where it landed — "Slide 4" when there are three
 * already — rather than after the video. A name taken from the file reads like
 * a title somebody chose, and stops being true the moment the video is swapped.
 */
function dropVideoOnFilmstrip(video) {
  const slide = addSlideAtEnd();
  state.activeSlideId = slide.id;
  dropVideoOnCanvas(video);
}

// ------------------------------------------------------------ test hooks ---

function installTestHooks() {
  if (!state.settings || state.settings.testHooks !== true) return;
  window.__burnhouseTest = {
    addVideos: (paths) => addVideoPaths(paths),
    goToStep: (step) => goToStep(step),
    getState: () => ({
      step: state.step,
      videos: state.videos.map((v) => ({
        id: v.id,
        name: v.name,
        duration: v.duration,
        hasPoster: Boolean(v.poster),
      })),
      slides: state.deck.slides.map((s) => ({
        id: s.id,
        title: s.title,
        role: s.role,
        elements: s.elements.map((e) => ({
          id: e.id,
          kind: e.kind,
          label: e.label,
          text: e.text,
          videoId: e.videoId,
          targetSlideId: e.targetSlideId,
          source: e.source,
          number: e.number,
          x: e.x,
          y: e.y,
          width: e.width,
          height: e.height,
          fit: e.fit,
          hasPoster: Boolean(e.src),
        })),
      })),
      activeSlideId: state.activeSlideId,
      selectedElementId: state.selectedElementId,
      hasPlan: Boolean(state.plan),
      layout: state.layout
        ? {
            problems: state.layout.problems,
            slides: state.layout.slides.map((s) => ({
              id: s.slide.id,
              buttons: s.buttons.length,
              elements: s.elements.map((e) => ({
                id: e.id,
                kind: e.kind,
                box: e.box,
                labelText: e.labelText,
              })),
            })),
          }
        : null,
    }),
    addSlide: (options) => addSlide(options),
    addElement: (kind, patch) => addElement(kind, patch),
    // What a drop becomes, from paths rather than from dropped files. Resolving
    // a File to a path needs the main process and a real drag, so the part worth
    // checking — which a given file turns into — is reached directly.
    importPathsOntoSlide: (paths) => importPathsOntoSlide(paths),
    importPathsOntoFilmstrip: (paths) => importPathsOntoFilmstrip(paths),
    clampElement: (element) => clampElementInPlace({ ...element }),
    banner: () => (state.banner ? { kind: state.banner.kind, title: state.banner.title } : null),
    // The multiple selection, and what each selected element was told to be.
    selection: () => state.selectedElementIds.slice(),
    elements: () =>
      (activeSlide() ? activeSlide().elements : []).map((e) => ({
        id: e.id,
        kind: e.kind,
        x: e.x,
        y: e.y,
        width: e.width,
        height: e.height,
        fontId: e.fontId,
        color: e.color,
        fit: e.fit,
        targetSlideId: e.targetSlideId,
      })),
    // The sound and the background picture on a slide, which are properties of
    // the page rather than elements on it.
    setSlideSound: (path) => setSlideSoundFromPath(activeSlide(), path),
    slideAudio: (slideId) => {
      const slide = slideId
        ? state.deck.slides.find((s) => s.id === slideId)
        : activeSlide();
      return slide && slide.audio ? { ...slide.audio } : null;
    },
    setSlideBackground: (path) => setSlideBackgroundFromPath(activeSlide(), path),
    hasSlideBackground: (slideId) => {
      const slide = slideId
        ? state.deck.slides.find((s) => s.id === slideId)
        : activeSlide();
      return Boolean(slide && slide.backgroundImage);
    },
    /*
      How far the background picture is washed toward the theme colour. The
      number the slider writes, and what the drawing code is handed, are the same
      one, so this reads back what would actually be drawn.
    */
    setSlideBackgroundDim: (value) => {
      const slide = activeSlide();
      if (!slide) return null;
      slide.backgroundDim = Math.max(0, Math.min(1, Number(value)));
      persistDeck();
      refreshCanvas();
      return slide.backgroundDim;
    },
    slideBackgroundDim: (slideId) => {
      const slide = slideId
        ? state.deck.slides.find((s) => s.id === slideId)
        : activeSlide();
      if (!slide) return null;
      // The layout clamps and defaults this; asking it is asking what is drawn.
      const layout = state.layout && state.layout.slides.find((s) => s.slide && s.slide.id === slide.id);
      return layout && layout.background ? layout.background.dim : null;
    },
    // The slide being edited, and what the disc makes of the deck as it stands —
    // the same model the burn and the simulator are both built from.
    goToSlide: (slideId) => {
      if (!state.deck.slides.some((s) => s.id === slideId)) return false;
      state.activeSlideId = slideId;
      clearElementSelection();
      render();
      return true;
    },
    selectElement: (elementId) => {
      setElementSelection([elementId]);
      renderInspector();
      return state.selectedElementId;
    },
    /*
      The hit test, as the canvas does it.

      `stack` is everything under a point, front to back, and `press` is what a
      press there reaches: the same call the canvas makes, with the caller
      holding the "where was the last press" memory the closure would otherwise
      keep. Both are here because the click-through is the whole fix for a big
      transparent picture covering a small one, and it is invisible in a
      screenshot.
    */
    stack: (point) => stackAt(activeSlideLayout(), point).map((e) => e.id),
    press: (point, previous) => {
      const picked = pickAt(activeSlideLayout(), point, previous);
      return { id: picked.element ? picked.element.id : null, at: picked.at };
    },
    beneathSelected: () => {
      const found = state.selectedElementId ? findElement(state.selectedElementId) : null;
      return elementsBeneath(found && found.element, activeSlideLayout()).map((e) => e.id);
    },
    setImageTarget: (elementId, targetSlideId) => {
      const { element } = findElement(elementId);
      if (!element || element.kind !== 'image') return false;
      element.targetSlideId = targetSlideId || null;
      if (element.targetSlideId) element.videoId = null;
      persistDeck();
      refreshCanvas();
      return element.targetSlideId;
    },
    /*
      What the disc makes of the deck as it stands.

      Asked of the main process rather than cached, so it is the same model the
      burn is built from and cannot be a stale copy of it.
    */
    discButtons: async () =>
      (await api.deck.discModel({ videos: state.videos, deck: state.deck })).menus.map((page) => ({
        page: page.page,
        slideId: page.slideId,
        title: page.title,
        buttons: page.buttons.map((b) => ({
          name: b.name,
          x0: b.x0,
          y0: b.y0,
          x1: b.x1,
          y1: b.y1,
          command: b.command,
        })),
      })),
    // The slide list's right-click menu, so its contents can be checked without
    // a person at the mouse.
    openSlideMenuFor: (slideId) => {
      const slide = state.deck.slides.find((s) => s.id === slideId);
      if (!slide) return null;
      openSlideMenu({ clientX: 40, clientY: 60, preventDefault() {}, stopPropagation() {} }, slide);
      return [...document.querySelectorAll('.context-menu .context-item')].map((b) => b.textContent.trim());
    },
    moveSlideBy: (slideId, delta) => {
      moveSlide(slideId, delta);
      return state.deck.slides.map((s) => s.id);
    },
    deleteSlide: (slideId) => {
      deleteSlide(slideId);
      return state.deck.slides.map((s) => s.id);
    },
    addMenuSlide: () => {
      const slide = makeMenuSlide(state.discTitle || 'Main menu');
      state.deck.slides.push(slide);
      state.activeSlideId = slide.id;
      syncMenuSlides();
      persistDeck();
      render();
      return slide.id;
    },
    syncMenu: () => {
      syncMenuSlides();
      return true;
    },
    activeSlide: () => state.activeSlideId,
    openProject: (idOrPath) => openProject(idOrPath),
    createNewProject: (name, themeId) => createNewProject(name, themeId),
    closeProject: () => closeProjectToHome(),
    saveProject: () => saveCurrentProject(false),
    // Exactly what the main process is sent when a disc is built, so a test can
    // check the project's identity is in it. It has to be: without an id every
    // project shares one prepared-disc folder and overwrites the last one.
    projectPayload: () => projectPayload(),
    getRecentProjects: () => state.recentProjects,
    // The simulator, so its accuracy can be checked without a person at the
    // keyboard. Returning the state is the point: a test can assert where the
    // highlight moved, not just that a window appeared.
    openSimulator: (options) => openSimulator(options || {}),
    closeSimulator: () => closeSimulator(),
    simulateArrow: (direction) => {
      simulateArrow(direction);
      return simState();
    },
    simulateEnter: () => {
      simulateEnter();
      return simState();
    },
    simulateMenuKey: () => {
      simulateMenuKey();
      return simState();
    },
    simulatorState: () => simState(),
    // Forces a redraw, to prove a playing film survives one. Rebuilding the DOM
    // on every render used to throw the <video> element away mid-playback.
    redrawSimulator: () => {
      renderSimulator();
      return simState();
    },
    simulatorVideo: () => {
      const video = document.getElementById('simVideo');
      if (!video) return null;
      return {
        src: video.currentSrc || video.getAttribute('src') || '',
        paused: video.paused,
        time: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        readyState: video.readyState,
        error: video.error ? video.error.code : null,
        marker: video.dataset.marker || null,
      };
    },
    markSimulatorVideo: (value) => {
      const video = document.getElementById('simVideo');
      if (!video) return false;
      video.dataset.marker = value;
      return true;
    },
    resizeElement: (id, handle, dx, dy) => {
      // Exercises the same geometry the mouse drag uses.
      const { element } = findElement(id);
      if (!element) return null;
      const box = resizeBox(
        handle,
        { x: element.x, y: element.y, width: element.width, height: element.height },
        dx,
        dy,
        SHAPE_LOCKED_KINDS.has(element.kind)
      );
      Object.assign(element, box);
      clampElementInPlace(element);
      persistDeck();
      render();
      return { x: element.x, y: element.y, width: element.width, height: element.height };
    },
    handleAt: (id, x, y) => {
      const { element } = findElement(id);
      if (!element) return null;
      return handleAt({ x: element.x, y: element.y, width: element.width, height: element.height }, { x, y });
    },
    openElementMenuFor: (id) => {
      const { element } = findElement(id);
      if (!element) return null;
      const layout = activeSlideLayout();
      if (!layout) return null;
      const resolved = layout.elements.find((e) => e.id === id) || element;
      openElementMenu({ clientX: 40, clientY: 60, preventDefault() {} }, resolved, layout);
      return [...document.querySelectorAll('.context-menu .context-item')].map((b) => b.textContent.trim());
    },
    contextMenuLabels: () =>
      [...document.querySelectorAll('.context-menu .context-item')].map((b) => b.textContent.trim()),
    clickContextItem: (label) => {
      const item = [...document.querySelectorAll('.context-menu .context-item')].find(
        (b) => b.textContent.trim().startsWith(label)
      );
      if (!item) return false;
      item.click();
      return true;
    },
    closeElementMenu: () => closeElementMenu(),
    selectElement: (id) => {
      setElementSelection([id]);
      drawCanvas();
      renderInspector();
    },
    setActiveSlide: (id) => {
      state.activeSlideId = id;
      render();
    },
    project: () => projectPayload(),
  };
}

// -------------------------------------------------------------------- go ---

bindCanvas();
boot();