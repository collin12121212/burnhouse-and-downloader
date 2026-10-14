'use strict';

/**
 * The bridge between the window and the pipeline.
 *
 * Every channel is listed here explicitly. The renderer gets a fixed set of
 * named operations and nothing else: no `require`, no filesystem, no way to ask
 * the main process to run an arbitrary command. The interface is small enough
 * to read in one sitting, which is the point.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** Unwrap the {ok, value, error} envelope the main process returns. */
async function call(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (response && response.ok) return response.value;
  const error = new Error((response && response.error) || 'Something went wrong.');
  if (response && response.aborted) error.aborted = true;
  throw error;
}

/**
 * The filesystem path behind a dropped file.
 *
 * `File.path` was removed from Electron; `webUtils.getPathForFile` is the
 * supported replacement and is the only way to learn where a file the user
 * dropped from Finder actually lives. Without it, dragging files onto the
 * window silently does nothing.
 */
function filePath(file) {
  try {
    return webUtils.getPathForFile(file) || null;
  } catch {
    return null;
  }
}

/** Subscribe to a push channel, returning an unsubscribe function. */
function subscribe(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('burnhouse', {
  app: {
    info: () => call('app:info'),
  },

  tools: {
    detect: () => call('tools:detect'),
  },

  settings: {
    get: () => call('settings:get'),
    set: (patch) => call('settings:set', patch),
  },

  project: {
    listRecent: () => call('project:list-recent'),
    save: (project) => call('project:save', project),
    load: (idOrPath) => call('project:load', { idOrPath }),
    delete: (id) => call('project:delete', { id }),
    saveDialog: (defaultName) => call('project:save-dialog', defaultName),
    openDialog: () => call('project:open-dialog'),
  },

  files: {
    addVideos: () => call('dialog:add-videos'),
    pickFolder: (options) => call('dialog:pick-folder', options),
    pickImage: () => call('dialog:pick-image'),
    pickAudio: () => call('dialog:pick-audio'),
    saveImage: (defaultName) => call('dialog:save-image', defaultName),
    readImage: (target) => call('files:read-image', target),
    probeAudio: (target) => call('files:probe-audio', target),
    mediaUrls: (paths) => call('files:media-urls', paths),
    open: (target) => call('shell:open', target),
    reveal: (target) => call('shell:reveal', target),
    // Synchronous, because it is needed while a drop event is still in hand.
    pathFor: (file) => filePath(file),
  },

  videos: {
    inspect: (payload) => call('videos:inspect', payload),
    poster: (payload) => call('video:poster', payload),
  },

  deck: {
    presets: () => call('deck:presets'),
    layout: (payload) => call('deck:layout', payload),
    discModel: (payload) => call('deck:disc-model', payload),
  },

  drives: {
    list: () => call('drives:list'),
    eject: (payload) => call('disc:eject', payload),
  },

  job: {
    build: (payload) => call('job:build', payload),
    built: (payload) => call('job:built', payload),
    image: (payload) => call('job:image', payload),
    burn: (payload) => call('job:burn', payload),
    saveFolder: (payload) => call('job:save-folder', payload),
    status: () => call('job:status'),
    cancel: () => call('job:cancel'),
    clearLog: () => call('job:clear-log'),
    onState: (handler) => subscribe('job:state', handler),
    onLog: (handler) => subscribe('job:log', handler),
  },

  // The prepared disc kept on disk between builds: how much room it takes, and
  // how to get that room back.
  work: {
    info: () => call('work:info'),
    clear: () => call('work:clear'),
  },

  server: {
    start: (payload) => call('server:start', payload),
    stop: () => call('server:stop'),
    info: () => call('server:info'),
  },

  // Menu-bar commands arrive as pushes so the interface stays the single source
  // of truth for what a command does.
  onMenuEvent: (channel, handler) => subscribe(channel, handler),
});
