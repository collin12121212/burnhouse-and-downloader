'use strict';

/**
 * Persisted settings.
 *
 * Deliberately a plain JSON file read and written synchronously. Settings are
 * tiny and read once at startup, and a synchronous write cannot be interrupted
 * halfway through by the app quitting, which is the failure mode that leaves a
 * user with unreadable preferences and an app that will not start.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let settingsDir = null;

function configure(dir) {
  settingsDir = dir;
  fs.mkdirSync(dir, { recursive: true });
}

function filePath() {
  if (!settingsDir) throw new Error('Settings storage has not been configured.');
  return path.join(settingsDir, 'settings.json');
}

/** Default working folder: inside the user's home, never inside the app bundle. */
function defaultWorkDir() {
  return path.join(os.homedir(), 'Burnhouse');
}

const DEFAULTS = {
  version: 1,
  workDir: null,
  // Last used disc settings, so opening the app again feels like continuing.
  videoFormat: null, // null means "decide from the videos"
  titleAspect: '16:9',
  audioMode: 'stereo',
  discType: 'dvd5',
  chaptersEnabled: true,
  chapterMinutes: 5,
  buildIso: true,
  verifyBurn: true,
  themeId: 'charcoal',
  fontId: 'sans',
  buttonStyle: 'bar',
  showNumbers: true,
  discTitle: '',
  // The slide deck the user designed, saved whole so reopening the app lands
  // where they left off.
  deck: null,
  activeSlideId: null,
  showSafeArea: true,
  // Recent projects metadata list
  recentProjects: [],
  currentProjectId: null,
  // Explicit tool paths, used when auto-detection picks the wrong one.
  toolPaths: {},
  // Remembered burn drive, by device node.
  lastDevice: null,
  // The local sharing server.
  server: {
    enabled: false,
    port: 8137,
  },
  // Only ever set by the launch smoke test, which needs a way to drive the
  // interface without a native file chooser. Never set during normal use.
  testHooks: false,
};

function read() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    return merge(structuredClone(DEFAULTS), JSON.parse(raw));
  } catch {
    // A missing or corrupt settings file must never stop the app starting.
    return structuredClone(DEFAULTS);
  }
}

function write(patch) {
  const next = merge(read(), patch || {});
  const target = filePath();
  const temp = `${target}.tmp`;
  // Write to a temporary file and rename, so an interrupted write cannot leave
  // a half-written settings file behind.
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(temp, target);
  return next;
}

function merge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = merge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * A project id reduced to something safe to use as a folder name.
 *
 * Ids are made by the app and are already plain, so this is not about the usual
 * case — it is about the other one. A project file can be hand-edited, copied
 * from another machine, or written by a future version, and this value is joined
 * onto a path that "Clear Working Files" then deletes recursively. A name
 * containing a slash or a run of dots would put that path somewhere else
 * entirely, so anything unexpected is replaced rather than trusted.
 */
function safeProjectFolder(id) {
  const text = String(id === undefined || id === null ? '' : id).trim();
  if (!text) return '';
  return text
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 80);
}

/** The files the shared, pre-project-folder layout wrote at the top level. */
const SHARED_LAYOUT_ENTRIES = ['build.json', 'titles', 'menu', 'author'];

function isEmptyDir(dir) {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Take over a prepared disc that an older version left in the shared folder.
 *
 * Before projects had their own folders, every build wrote to one directory
 * directly under the working folder: build.json, titles, menu, author and the
 * image all at the top. Those builds were mutually destructive — each one
 * overwrote the last — but a single one of them may be sitting there right now,
 * fully prepared and ready to burn.
 *
 * Without this it would become invisible the moment work folders are per
 * project: the Finish page would say nothing had been prepared and an hour of
 * encoding would be thrown away to produce the same bytes again.
 *
 * Only into an empty project folder, which is what makes it unambiguous — an
 * empty folder means nothing has been prepared for this project, so whatever is
 * in the shared one cannot have been put there by anyone else more recently. The
 * shared layout held exactly one build, so whichever project asks first is
 * entitled to it.
 *
 * Moved, not copied: both are under the same working folder, so this is a rename
 * and costs nothing however many gigabytes are involved.
 */
function adoptSharedBuild(base, projectDir) {
  if (base === projectDir) return null;

  let record;
  try {
    record = fs.statSync(path.join(base, 'build.json'));
  } catch {
    return null; // nothing prepared in the old layout
  }
  if (!record.isFile()) return null;
  if (!isEmptyDir(projectDir)) return null;

  const moved = [];

  const move = (name) => {
    try {
      fs.renameSync(path.join(base, name), path.join(projectDir, name));
      moved.push(name);
    } catch {
      // An entry that will not move stays where it was. That is the old
      // behaviour, so it is no worse than not having tried.
    }
  };

  for (const entry of SHARED_LAYOUT_ENTRIES) {
    if (fs.existsSync(path.join(base, entry))) move(entry);
  }
  // The image is named after the disc's label, so it is not in the list above.
  for (const entry of safeReaddir(base)) {
    if (/\.(iso|img)$/i.test(entry)) move(entry);
  }

  return moved.length ? moved : null;
}

/**
 * How much is prepared, and for how many projects.
 *
 * Reported so the page can say what is being kept and what clearing it would
 * free, rather than showing a bare number that grows as projects are added.
 */
function preparedWorkSummary(base) {
  let projects = 0;
  let shared = false;

  for (const entry of safeReaddir(base)) {
    const full = path.join(base, entry);
    let isDir = false;
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (fs.existsSync(path.join(full, 'build.json'))) projects += 1;
  }

  if (fs.existsSync(path.join(base, 'build.json'))) shared = true;

  return { projects, shared };
}

/**
 * The working folder actually in use, creating it if needed.
 *
 * With a project id it is that project's own folder, so builds cannot overwrite
 * each other and a build survives upgrading the app. Which is the point: fixing
 * a bug on the Mac should not mean re-encoding an hour of video to try it.
 *
 * It also adopts a build left behind by the old shared-folder layout, and does
 * it here rather than at each caller because every caller that needs a prepared
 * disc has to come through this function to find it. Somewhere else, and the
 * first one that forgot would report a prepared disc as missing.
 */
function resolveWorkDir(settings, projectId) {
  const base = (settings && settings.workDir) || defaultWorkDir();
  fs.mkdirSync(base, { recursive: true });

  const folder = safeProjectFolder(projectId);
  if (!folder) return base;

  const dir = path.join(base, folder);
  fs.mkdirSync(dir, { recursive: true });
  adoptSharedBuild(base, dir);
  return dir;
}

function projectsDir() {
  if (!settingsDir) throw new Error('Settings storage has not been configured.');
  const dir = path.join(settingsDir, 'projects');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveProject(project) {
  if (!project || !project.id) throw new Error('Invalid project data');
  const dir = projectsDir();
  const filePath = project.filePath || path.join(dir, `${project.id}.burnhouse`);
  project.filePath = filePath;
  project.modified = new Date().toISOString();

  // Write atomically to temporary file first
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(project, null, 2), 'utf8');
  fs.renameSync(temp, filePath);

  // Update recent projects in settings
  const settings = read();
  const recent = Array.isArray(settings.recentProjects) ? settings.recentProjects.slice() : [];
  const meta = {
    id: project.id,
    name: project.name || project.discTitle || 'Untitled Project',
    filePath,
    modified: project.modified,
    videoCount: Array.isArray(project.videos) ? project.videos.length : 0,
    slideCount: project.deck && Array.isArray(project.deck.slides) ? project.deck.slides.length : 0,
    themeId: (project.deck && project.deck.themeId) || project.themeId || 'charcoal',
  };
  const existingIndex = recent.findIndex((r) => r.id === project.id || r.filePath === filePath);
  if (existingIndex !== -1) {
    recent.splice(existingIndex, 1);
  }
  recent.unshift(meta);
  write({ recentProjects: recent.slice(0, 25), currentProjectId: project.id });
  return { ok: true, project, meta };
}

function loadProject(idOrPath) {
  let filePath = String(idOrPath || '');
  if (!filePath.endsWith('.burnhouse') && !filePath.endsWith('.json') && !filePath.includes(path.sep) && !filePath.includes('/')) {
    filePath = path.join(projectsDir(), `${idOrPath}.burnhouse`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Project file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const project = JSON.parse(raw);
  project.filePath = filePath;
  return project;
}

function listRecentProjects() {
  const settings = read();
  const recent = Array.isArray(settings.recentProjects) ? settings.recentProjects : [];
  return recent.filter((r) => {
    try {
      return fs.existsSync(r.filePath);
    } catch {
      return false;
    }
  });
}

function deleteProject(id) {
  const settings = read();
  const recent = Array.isArray(settings.recentProjects) ? settings.recentProjects.slice() : [];
  const item = recent.find((r) => r.id === id);
  if (item && item.filePath) {
    try {
      if (item.filePath.startsWith(projectsDir())) {
        fs.rmSync(item.filePath, { force: true });
      }
    } catch {
      /* ignore deletion errors */
    }
  }
  const updated = recent.filter((r) => r.id !== id);
  write({ recentProjects: updated });
  return updated;
}

module.exports = {
  DEFAULTS,
  configure,
  read,
  write,
  resolveWorkDir,
  safeProjectFolder,
  adoptSharedBuild,
  preparedWorkSummary,
  defaultWorkDir,
  filePath,
  projectsDir,
  saveProject,
  loadProject,
  listRecentProjects,
  deleteProject,
};
