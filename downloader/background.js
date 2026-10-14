// Background service worker: monitors network requests for VIDEO streams and files,
// tracks persistent download jobs across tabs/popups, and coordinates reliable downloads.

importScripts("hls.js");

const tabMedia = new Map(); // tabId -> Map(url -> mediaItem)
const tabUrls = new Map(); // tabId -> current tab URL (for Referer header)
const downloadJobs = new Map(); // url -> downloadJob state

const VIDEO_MIME_TYPES = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/ogg": "ogv",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/mp2t": "ts",
  "video/x-flv": "flv",
  "video/3gpp": "3gp",
  "video/x-msvideo": "avi",
  "video/x-ms-wmv": "wmv",
  "application/vnd.apple.mpegurl": "hls",
  "application/x-mpegurl": "hls",
  "application/mpegurl": "hls",
  "application/dash+xml": "dash"
};

const VIDEO_EXTENSIONS = new Set([
  "mp4", "webm", "mkv", "mov", "avi", "flv", "wmv", "m4v", "ts",
  "m3u8", "mpd", "3gp", "ogv"
]);

const TRACKER_DOMAINS = [
  "ads.", "doubleclick.net", "pixel.", "analytics.", "histats.com",
  "facebook.com/tr", "px.ads.", "scorecardresearch.com", "google-analytics.com",
  "adnxs.com", "serving-sys.com", "criteo.com", "taboola.com", "outbrain.com"
];

function getTabStore(tabId) {
  if (!tabId || tabId < 0) return null;
  if (!tabMedia.has(tabId)) {
    tabMedia.set(tabId, new Map());
  }
  return tabMedia.get(tabId);
}


// The service worker is killed after ~30s idle: persist state so the video list and download
// progress survive restarts.
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const media = {};
    for (const [tid, store] of tabMedia) media[tid] = Array.from(store.values());
    chrome.storage.session
      .set({ tabMedia: media, tabUrls: Object.fromEntries(tabUrls), jobs: Array.from(downloadJobs.values()) })
      .catch(() => {});
  }, 500);
}

const ready = (async () => {
  try {
    const d = await chrome.storage.session.get(["tabMedia", "tabUrls", "jobs"]);
    for (const [tid, items] of Object.entries(d.tabMedia || {})) {
      const store = getTabStore(+tid);
      if (!store) continue;
      for (const it of items) if (!store.has(it.url)) store.set(it.url, it);
    }
    for (const [tid, u] of Object.entries(d.tabUrls || {})) if (!tabUrls.has(+tid)) tabUrls.set(+tid, u);
    for (const j of d.jobs || []) if (!downloadJobs.has(j.url)) downloadJobs.set(j.url, j);
  } catch (_) {}
})();

// Debug log (kept in memory + chrome.storage.local, shown via the popup's "Copy debug log").
const debugLog = [];
let dbgTimer = null;
function dbg(kind, data) {
  debugLog.push(Object.assign({ t: new Date().toISOString().slice(11, 23), kind }, data));
  if (debugLog.length > 600) debugLog.splice(0, debugLog.length - 600);
  if (dbgTimer) return;
  dbgTimer = setTimeout(() => {
    dbgTimer = null;
    chrome.storage.local.set({ debugLog }).catch(() => {});
  }, 1000);
}
const NOISE_MIME = /^(image|font)\/|text\/css|javascript/i;

// Toolbar badge: shows how many videos were found in a tab, so you can see detection worked
// without opening the popup (many players only load their stream ~10 s after the page opens).
const badgeTimers = new Map();
function updateBadge(tabId) {
  if (badgeTimers.has(tabId)) return;
  badgeTimers.set(
    tabId,
    setTimeout(() => {
      badgeTimers.delete(tabId);
      const store = tabMedia.get(tabId);
      const items = store ? Array.from(store.values()).filter((i) => !i.candidate) : [];
      const real = items.some((i) => !i.blob);
      const hls = items.filter((i) => i.type === "hls").length;
      let n = items.filter((i) => !i.blob || !real).length;
      if (hls) n = Math.max(1, n - hls + 1); // an HLS stream is usually several playlists: count it once
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#16a34a" }).catch(() => {});
      chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => {});
    }, 300)
  );
}

// A download runs inside its page: if the tab closes or navigates away, the job is gone.
function failJobsForTab(tabId) {
  for (const job of downloadJobs.values()) {
    if (job.tabId === tabId && (job.status === "downloading" || job.status === "transmuxing")) {
      job.status = "error";
      job.error = "The page was closed or left during the download. Keep the tab open until it finishes.";
      scheduleSave();
    }
  }
}

// Silent activation window per tab: while it is open, newly created frames start muted, and
// the first real stream that shows up ends it (players are paused again right away).
const activeScans = new Map(); // tabId -> { until, timer }

function endScan(tabId, reason) {
  const s = activeScans.get(tabId);
  if (!s) return;
  clearTimeout(s.timer);
  activeScans.delete(tabId);
  dbg("scan-end", { url: reason });
  chrome.webNavigation.getAllFrames({ tabId }).then((frames) => {
    for (const f of frames || []) chrome.tabs.sendMessage(tabId, { type: "SCAN_DONE" }, { frameId: f.frameId }).catch(() => {});
  }, () => {});
}

// ---- Automation support ----------------------------------------------------------------
// The automation page watches tabs it opened: the moment a real stream is registered for a
// watched tab, MEDIA_FOUND is pushed to it. Frames that finish loading in a watched tab are
// silently activated (muted) after `after` ms if no stream has shown up yet.
const watched = new Map(); // tabId -> { activate, after, start, lastKick }

function hasRealMedia(tabId) {
  const store = tabMedia.get(tabId);
  if (!store) return null;
  for (const it of store.values()) {
    if (!it.candidate && !it.blob && ["hls", "dash", "mp4", "webm"].includes(it.type)) return it;
  }
  return null;
}

// Every frame that finishes loading in a watched tab gets its own silent activation (the real
// player often lives in a frame that appears several seconds after the page), repeated a few
// times because ad overlays can swallow the first press. The scan window stays open until a
// stream shows up or the tab is unwatched.
function kickFrame(tabId, frameId, round) {
  const w = watched.get(tabId);
  if (!w || !w.activate || hasRealMedia(tabId)) return;
  if (!activeScans.has(tabId)) {
    activeScans.set(tabId, { timer: null });
    dbg("scan-start", { url: "watched " + tabId });
  }
  dbg("kick", { f: frameId, type: "round " + round, url: String(tabId) });
  chrome.tabs.sendMessage(tabId, { type: "DEEP_SCAN", activate: true }, { frameId }).catch(() => {});
  if (round < 4) setTimeout(() => kickFrame(tabId, frameId, round + 1), 3500);
}

// A provider whose domain no longer resolves (or refuses connections) shows Chrome's error page
// inside the player frame. Report it so the race drops that server at once instead of waiting.
chrome.webNavigation.onErrorOccurred.addListener((d) => {
  if (!watched.has(d.tabId) || d.frameId === 0) return;
  if (!/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_TIMED_OUT|ERR_SSL_PROTOCOL_ERROR|ERR_CERT_/.test(d.error || "")) return;
  if (d.parentFrameId !== 0) return; // only the provider frame itself, not ads deeper inside
  const w = watched.get(d.tabId);
  if (Date.now() - w.start > 20000) return;
  dbg("frame-dead", { type: d.error, url: (d.url || "").slice(0, 120) });
  chrome.runtime.sendMessage({ type: "PAGE_DEAD", tabId: d.tabId, error: d.error }).catch(() => {});
});

chrome.webNavigation.onCompleted.addListener((d) => {
  const w = watched.get(d.tabId);
  if (!w || !w.activate) return;
  const wait = Math.max(300, w.after - (Date.now() - w.start));
  setTimeout(() => kickFrame(d.tabId, d.frameId, 0), wait);
});

function safeName(name) {
  return String(name || "")
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function isTracker(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return TRACKER_DOMAINS.some((d) => host.includes(d));
  } catch (_) {
    return false;
  }
}

function parseVideoFilename(url, mime) {
  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname);
    const last = pathname.split("/").filter(Boolean).pop() || "";
    const dot = last.lastIndexOf(".");
    if (dot > 0) {
      const ext = last.slice(dot + 1).toLowerCase();
      const base = last.slice(0, dot);
      if (VIDEO_EXTENSIONS.has(ext)) {
        return `${safeName(base)}.${ext === "m3u8" || ext === "mpd" ? "mp4" : ext}`;
      }
    }
    for (const [key, val] of parsed.searchParams.entries()) {
      if (["file", "url", "src", "source", "manifest", "video", "stream"].includes(key.toLowerCase())) {
        const pDot = val.lastIndexOf(".");
        if (pDot > 0) {
          const pExt = val.slice(pDot + 1).toLowerCase();
          if (VIDEO_EXTENSIONS.has(pExt)) {
            return `${safeName(val.slice(0, pDot))}.${pExt === "m3u8" || pExt === "mpd" ? "mp4" : pExt}`;
          }
        }
      }
    }
  } catch (_) {}

  const ext = (mime && VIDEO_MIME_TYPES[mime.toLowerCase().split(";")[0].trim()]) || "mp4";
  return `video-${Date.now().toString(36)}.${ext === "hls" || ext === "dash" ? "mp4" : ext}`;
}

function classifyVideoUrl(rawUrl, mime = "") {
  if (isTracker(rawUrl)) return "";

  const normMime = mime ? mime.toLowerCase().split(";")[0].trim() : "";
  if (normMime) {
    if (
      normMime.startsWith("image/") ||
      normMime.startsWith("text/") ||
      normMime.startsWith("audio/") ||
      normMime.includes("javascript") ||
      normMime.includes("css") ||
      normMime.includes("font")
    ) {
      return "";
    }
    if (normMime.includes("mpegurl")) return "hls";
    if (normMime.includes("dash+xml")) return "dash";
    if (normMime.startsWith("video/")) {
      const sub = normMime.split("/")[1];
      return sub === "mp4" ? "mp4" : sub === "webm" ? "webm" : "media";
    }
  }

  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname;
    const full = parsed.pathname + parsed.search;

    if (/\.m3u8([?#].*)?$/i.test(path) || /[?&](file|url|src|manifest)=[^&]*\.m3u8/i.test(full)) return "hls";
    if (/\.mpd([?#].*)?$/i.test(path)) return "dash";
    if (/\.mp4([?#].*)?$/i.test(path)) return "mp4";
    if (/\.webm([?#].*)?$/i.test(path)) return "webm";
    if (/\.(mov|mkv|avi|flv|wmv|m4v|ogv|3gp)([?#].*)?$/i.test(path)) return "media";
    if (parsed.pathname.includes("videoplayback")) return "mp4";
  } catch (_) {}

  return "";
}

const suppressed = new Set(); // URLs we are probing ourselves: don't list our own requests

function registerMedia(tabId, media) {
  const store = getTabStore(tabId);
  if (!store || !media || !media.url) return;

  const url = media.url;
  // A real response (status < 400, seen by onHeadersReceived) confirms a URL even if we probed it ourselves.
  if (suppressed.has(url) && media.fromNetwork && media.candidate) return;
  if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("blob:")) return;
  if (url.startsWith("chrome-extension://")) return;

  const type = media.type || classifyVideoUrl(url, media.mime);
  if (!type && !media.blob) return;
  if (type === "audio") return;

  if (media.blob && media.size > 0 && media.size < 50000 && !media.width) return;

  const existing = store.get(url);
  const name = media.name || (existing && existing.name) || parseVideoFilename(url, media.mime);

  dbg("register", { type: type || "media", cand: !!media.candidate, f: media.frameId, url: url.slice(0, 200) });
  store.set(url, {
    url,
    name,
    type: type || "media",
    mime: media.mime || (existing && existing.mime) || "",
    size: media.size || (existing && existing.size) || 0,
    width: media.width || (existing && existing.width) || 0,
    height: media.height || (existing && existing.height) || 0,
    duration: media.duration || (existing && existing.duration) || 0,
    frameId: media.frameId != null ? media.frameId : (existing && existing.frameId) || 0,
    tabId,
    blob: !!media.blob || url.startsWith("blob:"),
    candidate: media.candidate ? (existing ? !!existing.candidate : true) : false,
    stream: !!media.stream || type === "hls" || type === "dash",
    timestamp: Date.now()
  });
  scheduleSave();
  updateBadge(tabId);
  const kind = type || "media";
  if (watched.has(tabId) && !media.candidate && !media.blob && !url.startsWith("blob:") && ["hls", "dash", "mp4", "webm"].includes(kind)) {
    chrome.runtime.sendMessage({ type: "MEDIA_FOUND", tabId, item: store.get(url) }).catch(() => {});
  }
  if (activeScans.has(tabId) && !media.candidate && !media.blob && !url.startsWith("blob:") && kind !== "media") {
    endScan(tabId, "found " + kind);
  }
}

// Inspect network requests
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId <= 0) return;
    const url = details.url;
    let mime = "";
    let contentLength = 0;

    if (details.responseHeaders) {
      for (const h of details.responseHeaders) {
        const name = h.name.toLowerCase();
        if (name === "content-type" && h.value) mime = h.value;
        if (name === "content-length" && h.value) contentLength = parseInt(h.value, 10) || 0;
      }
    }
    if (details.type !== "image" && details.type !== "stylesheet" && details.type !== "font" && !NOISE_MIME.test(mime)) {
      dbg("net", { type: details.type, st: details.statusCode, mime: mime.slice(0, 40), len: contentLength, f: details.frameId, url: url.slice(0, 200) });
    }
    if (details.statusCode >= 400) return;

    const type = classifyVideoUrl(url, mime);
    if (!type) return;

    if (type !== "hls" && type !== "dash" && contentLength > 0 && contentLength < 30000) return;

    registerMedia(details.tabId, {
      url,
      type,
      mime,
      size: contentLength,
      frameId: details.frameId,
      fromNetwork: true
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId <= 0) return;
    const type = classifyVideoUrl(details.url);
    if (type === "hls" || type === "dash" || type === "mp4" || type === "webm") {
      registerMedia(details.tabId, {
        url: details.url,
        type,
        frameId: details.frameId,
        candidate: true, // confirmed later by response headers (status < 400)
        fromNetwork: true
      });
    }
  },
  { urls: ["<all_urls>"] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  watched.delete(tabId);
  tabMedia.delete(tabId);
  tabUrls.delete(tabId);
  failJobsForTab(tabId);
  scheduleSave();
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) {
    tabMedia.delete(details.tabId);
    tabUrls.set(details.tabId, details.url);
    failJobsForTab(details.tabId);
    updateBadge(details.tabId);
    scheduleSave();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab && tab.url) {
    tabUrls.set(tabId, tab.url);
  }
});


// HLS de-duplication: a master playlist, its per-quality playlists and its separate audio
// playlist are ONE video. Analyse playlists and hide the children so each video is listed once.
const analysisCache = new Map(); // url -> { p: Promise<info|null>, t }

function analyzeCached(url) {
  const hit = analysisCache.get(url);
  if (hit && (Date.now() - hit.t < 60000 || hit.ok)) return hit.p;
  const entry = { t: Date.now(), ok: false, p: null };
  entry.p = self.VDL_HLS.analyze(url).then(
    (info) => {
      entry.ok = true;
      return info;
    },
    () => null
  );
  analysisCache.set(url, entry);
  return entry.p;
}

// Candidates (URLs found inside page source / API replies, never requested) are only listed once
// they prove to be real videos. Try from the extension first, then from inside the page's frame
// (same Referer/cookies as the player) for hosts that reject extension requests.
const verifyCache = new Map(); // url -> { p, t, ok }

function verifyCandidate(item) {
  const hit = verifyCache.get(item.url);
  if (hit && (hit.ok || Date.now() - hit.t < 60000)) return hit.p;
  const entry = { t: Date.now(), ok: false, p: null };
  suppressed.add(item.url);
  setTimeout(() => suppressed.delete(item.url), 30000);
  const isHls = item.type === "hls" || /\.m3u8/i.test(item.url);
  entry.p = (async () => {
    try {
      if (isHls) await self.VDL_HLS.analyze(item.url, { retries: 1 });
      else {
        const pr = await self.VDL_HLS.probeFile(item.url);
        if (!pr.ok) throw new Error("not video");
        return { ok: true, size: pr.size };
      }
      return { ok: true };
    } catch (_) {
      try {
        const res = await chrome.tabs.sendMessage(
          item.tabId,
          { type: "VERIFY_URL", url: item.url },
          { frameId: item.frameId || 0 }
        );
        if (res && res.ok) return res;
      } catch (_) {}
      return { ok: false };
    }
  })().then((r) => {
    entry.ok = r.ok;
    return r;
  });
  verifyCache.set(item.url, entry);
  return entry.p;
}

async function verifyCandidates(list) {
  const timeout = new Promise((r) => setTimeout(() => r({ ok: false }), 6000));
  const cands = list.filter((i) => i.candidate);
  const results = await Promise.all(cands.map((i) => Promise.race([verifyCandidate(i), timeout])));
  const bad = new Set();
  cands.forEach((item, n) => {
    if (!results[n].ok) bad.add(item.url);
    else if (results[n].size && !item.size) item.size = results[n].size;
  });
  return list.filter((i) => !bad.has(i.url));
}

async function dedupeHls(list) {
  list = await verifyCandidates(list);
  const isHls = (i) => i.type === "hls" || /\.m3u8([?#]|$)/i.test(i.url);
  const timeout = new Promise((r) => setTimeout(() => r(null), 5000));
  const hls = list.filter(isHls);
  const infos = await Promise.all(hls.map((i) => Promise.race([analyzeCached(i.url), timeout])));
  const hidden = new Set();
  hls.forEach((item, n) => {
    const info = infos[n];
    if (!info) return;
    if (info.kind === "audio") hidden.add(item.url);
    if (info.kind === "master") info.children.forEach((c) => hidden.add(c));
    if (info.duration && !item.duration) item.duration = info.duration;
    if (info.width && !item.width) {
      item.width = info.width;
      item.height = info.height;
    }
  });
  // Same playlist re-requested with rotating tokens: keep the newest.
  const newest = new Map();
  for (const item of hls) {
    let key = item.url;
    try {
      const u = new URL(item.url);
      key = u.origin + u.pathname;
    } catch (_) {}
    const cur = newest.get(key);
    if (!cur || item.timestamp > cur.timestamp) newest.set(key, item);
  }
  const keep = new Set(newest.values());
  return list.filter((i) => !hidden.has(i.url) && (!isHls(i) || keep.has(i)));
}

async function collectAllFramesMedia(tabId) {
  const store = getTabStore(tabId);
  const mediaList = [];

  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (frames && frames.length > 0) {
      const promises = frames.map((frame) =>
        chrome.tabs
          .sendMessage(tabId, { type: "GET_VIDEOS" }, { frameId: frame.frameId })
          .catch(() => null)
      );
      const results = await Promise.all(promises);
      for (const res of results) {
        if (res && Array.isArray(res.videos)) {
          for (const v of res.videos) {
            registerMedia(tabId, v);
          }
        }
      }
    }
  } catch (_) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "GET_VIDEOS" });
      if (res && Array.isArray(res.videos)) {
        for (const v of res.videos) registerMedia(tabId, v);
      }
    } catch (_) {}
  }

  if (store) {
    for (const item of store.values()) {
      if (item.type !== "audio") {
        mediaList.push(item);
      }
    }
  }

  return dedupeHls(mediaList);
}

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === "REPORT_MEDIA") {
    const tabId = (sender.tab && sender.tab.id) || msg.tabId;
    if (tabId && Array.isArray(msg.media)) {
      for (const m of msg.media) {
        m.frameId = sender.frameId != null ? sender.frameId : msg.frameId;
        registerMedia(tabId, m);
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "WATCH_TAB") {
    watched.set(msg.tabId, { activate: !!msg.activate, after: msg.activateAfterMs || 3000, start: Date.now(), lastKick: 0 });
    sendResponse({ ok: true, existing: hasRealMedia(msg.tabId) });
    return false;
  }

  if (msg.type === "UNWATCH_TAB") {
    watched.delete(msg.tabId);
    if (activeScans.has(msg.tabId)) endScan(msg.tabId, "unwatched");
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "PAGE_GATE") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null && watched.has(tabId)) chrome.runtime.sendMessage({ type: "PAGE_GATE", tabId }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "SCAN_STATE") {
    const tabId = sender.tab && sender.tab.id;
    sendResponse({ active: activeScans.has(tabId) });
    return false;
  }

  if (msg.type === "DEEP_SCAN") {
    const tabId = msg.tabId || (sender.tab && sender.tab.id);
    if (msg.activate && !activeScans.has(tabId)) {
      activeScans.set(tabId, { timer: setTimeout(() => endScan(tabId, "timeout"), 15000) });
      dbg("scan-start", { url: String(tabId) });
    }
    (async () => {
      try {
        const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
        await Promise.all(
          frames.map((f) =>
            chrome.tabs
              .sendMessage(tabId, { type: "DEEP_SCAN", activate: !!msg.activate }, { frameId: f.frameId })
              .catch(() => null)
          )
        );
      } catch (_) {}
      // Give the player a moment to request its stream before answering.
      if (msg.activate) {
        for (let i = 0; i < 20 && activeScans.has(tabId); i++) await new Promise((r) => setTimeout(r, 500));
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "GET_DEBUG_LOG") {
    sendResponse({ ok: true, log: debugLog });
    return false;
  }

  if (msg.type === "GET_ALL_MEDIA") {
    const tabId = msg.tabId || (sender.tab && sender.tab.id);
    if (!tabId) {
      sendResponse({ ok: false, error: "No tabId provided" });
      return false;
    }
    ready.then(() => collectAllFramesMedia(tabId)).then((videos) => {
      sendResponse({ ok: true, videos });
    });
    return true;
  }

  // Persistent download job tracking
  if (msg.type === "START_DOWNLOAD_JOB") {
    const { video, tabId } = msg;
    if (!video || !video.url) {
      sendResponse({ ok: false, error: "No video specified" });
      return false;
    }

    const job = {
      url: video.url,
      name: video.name,
      tabId: tabId || (sender.tab && sender.tab.id),
      frameId: video.frameId != null ? video.frameId : 0,
      status: "downloading",
      stage: "download",
      completed: 0,
      total: 0,
      percent: 0,
      size: 0,
      startTime: Date.now()
    };
    downloadJobs.set(video.url, job);
    scheduleSave();

    // Send start signal to content script in the appropriate frame
    chrome.tabs.sendMessage(
      job.tabId,
      {
        type: msg.kind === "hls" ? "START_HLS_DOWNLOAD" : "START_FILE_DOWNLOAD",
        url: video.url,
        filename: video.name
      },
      job.frameId != null ? { frameId: job.frameId } : {}
    ).catch((err) => {
      job.status = "error";
      job.error = "Page script not ready - reload the tab and try again (" + err.message + ")";
      chrome.runtime.sendMessage({ type: "REPORT_DOWNLOAD_ERROR", url: video.url, error: job.error }).catch(() => {});
    });

    sendResponse({ ok: true, job });
    return true;
  }

  if (msg.type === "REPORT_DOWNLOAD_PROGRESS") {
    const job = downloadJobs.get(msg.url);
    if (job) {
      job.completed = msg.completed;
      job.total = msg.total;
      job.percent = msg.percent;
      job.bytes = msg.bytes || 0;
      job.stage = msg.stage || "download";
      job.status = msg.stage === "transmux" ? "transmuxing" : "downloading";
      scheduleSave();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "REPORT_DOWNLOAD_COMPLETE") {
    const job = downloadJobs.get(msg.url);
    if (job) {
      job.status = "completed";
      job.endTime = Date.now();
      job.percent = 100;
      job.size = msg.size;
      job.filename = msg.filename;
      scheduleSave();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "REPORT_DOWNLOAD_ERROR") {
    const job = downloadJobs.get(msg.url);
    if (job) {
      job.status = "error";
      job.error = msg.error;
      scheduleSave();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "CANCEL_JOB") {
    const job = downloadJobs.get(msg.url);
    if (job && job.tabId != null) {
      chrome.tabs.sendMessage(job.tabId, { type: "CANCEL_DOWNLOAD", url: msg.url }, { frameId: job.frameId || 0 }).catch(() => {});
      job.status = "error";
      job.error = "Cancelled";
      scheduleSave();
      chrome.runtime.sendMessage({ type: "REPORT_DOWNLOAD_ERROR", url: msg.url, error: "Cancelled" }).catch(() => {});
    }
    sendResponse({ ok: !!job });
    return false;
  }

  if (msg.type === "GET_ACTIVE_DOWNLOADS") {
    ready.then(() => sendResponse({ ok: true, jobs: Array.from(downloadJobs.values()) }));
    return true;
  }

  if (msg.type === "DOWNLOAD") {
    const downloadOptions = {
      url: msg.url,
      filename: msg.filename,
      saveAs: !!msg.saveAs
    };

    const tabUrl = msg.tabId ? tabUrls.get(msg.tabId) : (sender.tab && sender.tab.url);
    if (tabUrl && (msg.url.startsWith("http://") || msg.url.startsWith("https://"))) {
      try {
        const origin = new URL(tabUrl).origin;
        downloadOptions.headers = [
          { name: "Referer", value: tabUrl },
          { name: "Origin", value: origin }
        ];
      } catch (_) {}
    }

    chrome.downloads
      .download(downloadOptions)
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((err) => {
        if (downloadOptions.headers) {
          delete downloadOptions.headers;
          chrome.downloads
            .download(downloadOptions)
            .then((downloadId) => sendResponse({ ok: true, downloadId }))
            .catch((retryErr) => sendResponse({ ok: false, error: String(retryErr) }));
        } else {
          sendResponse({ ok: false, error: String(err) });
        }
      });
    return true;
  }

  return false;
});
