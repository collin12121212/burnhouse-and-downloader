const state = { videos: [], activeJobs: new Map() };
let lastKey = "";
let emptyStreak = 0;

// One empty answer (e.g. a frame busy mid-scan) must not wipe a list that was already showing.
function applyList(vids) {
  if (!vids.length && state.videos.length && ++emptyStreak < 3) return false;
  if (vids.length) emptyStreak = 0;
  const key = vids.map((v) => v.url).join("|");
  if (key === lastKey) return false;
  state.videos = vids;
  render();
  return true;
}

async function autoActivateEnabled() {
  try {
    const { autoActivate } = await chrome.storage.local.get("autoActivate");
    return autoActivate !== false;
  } catch (_) {
    return true;
  }
}

const $ = (id) => document.getElementById(id);

let retryTimer = null;
let retriesLeft = 0;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function fmtDuration(seconds) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = kind || "";
}

function deduplicateMedia(list) {
  const seen = new Map();
  const hasRealStreamOrFile = list.some(
    (v) => !v.blob && (v.type === "hls" || v.type === "dash" || v.type === "mp4" || v.type === "webm" || /\.m3u8|\.mpd|\.mp4|\.webm/i.test(v.url))
  );

  for (const item of list) {
    if (!item || !item.url) continue;

    if (item.type === "audio" || (item.mime && item.mime.startsWith("audio/"))) {
      continue;
    }

    if (hasRealStreamOrFile && item.blob) {
      continue;
    }

    if (hasRealStreamOrFile && /\.(ts|m4s|m4a|aac)(\?.*)?$/i.test(item.url)) {
      continue;
    }

    if (item.blob && item.size > 0 && item.size < 50000 && !item.width) {
      continue;
    }

    const normUrl = item.url.split("#")[0];
    if (!seen.has(normUrl)) {
      seen.set(normUrl, item);
    } else {
      const curr = seen.get(normUrl);
      if (!curr.size && item.size) curr.size = item.size;
      if (!curr.duration && item.duration) curr.duration = item.duration;
      if (!curr.width && item.width) {
        curr.width = item.width;
        curr.height = item.height;
      }
    }
  }

  return Array.from(seen.values());
}

function updateButtonForJob(url, job) {
  const btn = document.querySelector(`[data-url="${encodeURIComponent(url)}"]`);
  if (!btn || !job) return;

  const cancelId = "cancel-" + encodeURIComponent(url);
  let cancel = document.getElementById(cancelId);
  const running = job.status === "downloading" || job.status === "transmuxing";
  if (running && !cancel && btn.parentElement) {
    cancel = document.createElement("button");
    cancel.id = cancelId;
    cancel.className = "btn-secondary";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "CANCEL_JOB", url }).catch(() => {});
      cancel.remove();
    });
    btn.after(cancel);
  } else if (!running && cancel) {
    cancel.remove();
  }

  if (job.status === "downloading") {
    btn.disabled = true;
    btn.textContent = `${job.percent}% (${job.completed}/${job.total})`;
    setStatus(`Downloading: ${job.percent}% (${job.completed}/${job.total} segments${job.bytes ? ", " + formatBytes(job.bytes) : ""})...`);
  } else if (job.status === "transmuxing") {
    btn.disabled = true;
    btn.textContent = "Converting to MP4…";
    setStatus("Converting video segments to standard MP4…");
  } else if (job.status === "completed") {
    btn.disabled = false;
    btn.textContent = "Done";
    setStatus(`Downloaded: ${job.filename || "video.mp4"} (${formatBytes(job.size)})`, "ok");
  } else if (job.status === "error") {
    btn.disabled = false;
    btn.textContent = job.error === "Cancelled" ? "Download" : "Retry";
    setStatus(job.error === "Cancelled" ? "Download cancelled." : `Download error: ${job.error || "Failed"}`, job.error === "Cancelled" ? "ok" : "err");
  }
}

function render() {
  lastKey = state.videos.map((v) => v.url).join("|");
  const list = $("list");
  list.innerHTML = "";
  if (!state.videos.length) {
    setStatus("No videos found on this page.", "ok");
    list.innerHTML =
      '<div class="empty">No videos detected yet.<br>Some players load their stream 10-15 s after the page opens;<br>this list updates by itself, no need to play the video.</div>';
    $("downloadAll").disabled = true;
    return;
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  setStatus(`${state.videos.length} video${state.videos.length === 1 ? "" : "s"} found.`, "ok");
  $("downloadAll").disabled = false;

  state.videos.forEach((video, i) => {
    const item = document.createElement("div");
    item.className = "item";

    const info = document.createElement("div");
    info.className = "info";

    const name = document.createElement("div");
    name.className = "name";
    const displayName = (video.name || `video-${i + 1}`).replace(/\.(m3u8|mpd|ts)$/i, ".mp4");
    name.textContent = displayName.endsWith(".mp4") || displayName.endsWith(".webm") || displayName.endsWith(".mov") || displayName.endsWith(".mkv") ? displayName : `${displayName}.mp4`;
    name.title = name.textContent;

    const url = document.createElement("div");
    url.className = "url";
    const metaParts = [];
    if (video.width && video.height) metaParts.push(`${video.width}×${video.height}`);
    if (video.duration) metaParts.push(fmtDuration(video.duration));
    if (video.size) metaParts.push(formatBytes(video.size));
    const metaStr = metaParts.join(" · ");
    url.textContent = metaStr ? `${metaStr} — ${video.url}` : video.url;
    url.title = video.url;

    info.append(name, url);

    const isHls = video.type === "hls" || /\.m3u8/i.test(video.url);
    const badgeType = isHls ? "hls" : (video.type || "video").toLowerCase();
    const badge = document.createElement("span");
    badge.className = `badge ${badgeType}`;
    badge.textContent = isHls ? "HLS" : badgeType.toUpperCase();

    const btn = document.createElement("button");
    btn.className = "dl";
    btn.textContent = "Download";
    btn.setAttribute("data-url", encodeURIComponent(video.url));
    btn.id = `dl-btn-${i}`;
    btn.addEventListener("click", () => downloadOne(video, btn));

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.appendChild(btn);

    const copyBtn = document.createElement("button");
    copyBtn.className = "btn-secondary";
    copyBtn.textContent = "Copy";
    copyBtn.title = "Copy direct video/stream URL to clipboard";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(video.url);
        setStatus("URL copied to clipboard.", "ok");
      } catch (_) {
        setStatus("Could not copy URL.", "err");
      }
    });
    actions.appendChild(copyBtn);

    item.append(badge, info, actions);
    list.appendChild(item);

    // If job is already active in background, restore its progress
    const activeJob = state.activeJobs.get(video.url);
    if (activeJob) {
      updateButtonForJob(video.url, activeJob);
    }
  });
}

async function syncActiveJobs() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_DOWNLOADS" });
    if (res && res.ok && Array.isArray(res.jobs)) {
      state.activeJobs.clear();
      for (const job of res.jobs) {
        state.activeJobs.set(job.url, job);
        updateButtonForJob(job.url, job);
      }
    }
  } catch (_) {}
}

async function refresh(deep) {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  setStatus("Scanning page…");
  try {
    const tab = await getActiveTab();
    if (!tab || tab.id == null) throw new Error("No active tab");

    await syncActiveJobs();

    if (deep) {
      const activate = await autoActivateEnabled();
      setStatus(activate ? "Starting the player silently to find its video…" : "Looking deeper in the page…");
      await chrome.runtime.sendMessage({ type: "DEEP_SCAN", tabId: tab.id, activate }).catch(() => null);
    }

    const res = await chrome.runtime.sendMessage({
      type: "GET_ALL_MEDIA",
      tabId: tab.id
    });

    const vids = res && res.ok && Array.isArray(res.videos) ? deduplicateMedia(res.videos) : [];
    if (!applyList(vids)) render();
  } catch (err) {
    setStatus("Could not scan this page (reload the tab or open a regular web page).", "err");
    $("list").innerHTML = "";
    $("downloadAll").disabled = true;
  }
}

function scheduleRetry() {
  if (retryTimer || retriesLeft <= 0) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retriesLeft--;
    refresh().then(() => {
      if (!state.videos.length) scheduleRetry();
    });
  }, 1200);
}

// Live real-time updates from background worker / content scripts
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;

  if (msg.type === "REPORT_DOWNLOAD_PROGRESS" || msg.type === "HLS_PROGRESS") {
    const job = {
      status: msg.stage === "transmux" ? "transmuxing" : "downloading",
      completed: msg.completed,
      total: msg.total,
      percent: msg.percent,
      bytes: msg.bytes
    };
    state.activeJobs.set(msg.url, job);
    updateButtonForJob(msg.url, job);
  } else if (msg.type === "REPORT_DOWNLOAD_COMPLETE") {
    const job = {
      status: "completed",
      percent: 100,
      size: msg.size,
      filename: msg.filename
    };
    state.activeJobs.set(msg.url, job);
    updateButtonForJob(msg.url, job);
  } else if (msg.type === "REPORT_DOWNLOAD_ERROR") {
    const job = {
      status: "error",
      error: msg.error
    };
    state.activeJobs.set(msg.url, job);
    updateButtonForJob(msg.url, job);
  }
});

async function downloadOne(video, btn) {
  const original = "Download";
  btn.disabled = true;
  btn.textContent = "Starting…";
  setStatus(`Starting download for ${video.name}…`);

  try {
    const saveAs = $("saveAs") ? $("saveAs").checked : false;
    const tab = await getActiveTab();
    const isHls = video.type === "hls" || /\.m3u8/i.test(video.url);

    // Everything (HLS, plain files, blobs) runs as a persistent background job.
    const res = await chrome.runtime.sendMessage({
      type: "START_DOWNLOAD_JOB",
      video,
      kind: isHls ? "hls" : "file",
      tabId: tab ? tab.id : null
    });
    if (res && res.ok) {
      state.activeJobs.set(video.url, res.job);
      setStatus(`Download started in background for ${video.name}`);
      return;
    }
    if (res && res.error) throw new Error(res.error);

    // Direct video download fallback
    const direct = await chrome.runtime.sendMessage({
      type: "DOWNLOAD",
      url: video.url,
      filename: video.name,
      saveAs,
      tabId: tab ? tab.id : null
    });

    if (direct && direct.ok) {
      setStatus(`Started download: ${video.name}`, "ok");
      btn.textContent = "Done";
      setTimeout(() => {
        btn.textContent = original;
        btn.disabled = false;
      }, 3000);
    } else {
      setStatus(`Download failed: ${(direct && direct.error) || "Network restriction"}`, "err");
      btn.textContent = original;
      btn.disabled = false;
    }
  } catch (err) {
    setStatus(`Download error: ${err.message}`, "err");
    btn.textContent = original;
    btn.disabled = false;
  }
}

$("refresh").addEventListener("click", () => {
  retriesLeft = 6;
  refresh(true).then(() => {
    if (!state.videos.length) scheduleRetry();
  });
});

$("downloadAll").addEventListener("click", async () => {
  $("downloadAll").disabled = true;
  let ok = 0;
  let failed = 0;
  setStatus(`Downloading ${state.videos.length} video(s)…`);

  for (let i = 0; i < state.videos.length; i++) {
    const video = state.videos[i];
    const btn = document.getElementById(`dl-btn-${i}`);
    try {
      await downloadOne(video, btn || document.createElement("button"));
      ok++;
    } catch (_) {
      failed++;
    }
  }
  setStatus(`Queued ${ok} downloads.`, failed ? "err" : "ok");
  $("downloadAll").disabled = false;
});

retriesLeft = 6;
refresh().then(async () => {
  // Nothing found passively: search the page itself for videos that were never started.
  if (!state.videos.length) {
    await refresh(true);
    if (!state.videos.length) scheduleRetry();
  }
});

$("debugLog") && $("debugLog").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "GET_DEBUG_LOG" }).catch(() => null);
  const text = ((res && res.log) || []).map((e) => JSON.stringify(e)).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Copied ${((res && res.log) || []).length} debug log lines to clipboard.`, "ok");
  } catch (_) {
    setStatus("Could not copy debug log.", "err");
  }
});

// Keep the list live while the popup is open (streams often appear several seconds after page load).
setInterval(async () => {
  try {
    const tab = await getActiveTab();
    if (!tab || tab.id == null) return;
    const res = await chrome.runtime.sendMessage({ type: "GET_ALL_MEDIA", tabId: tab.id });
    if (!res || !res.ok) return;
    if (applyList(deduplicateMedia(res.videos))) syncActiveJobs();
  } catch (_) {}
}, 2500);

autoActivateEnabled().then((on) => {
  const box = $("autoActivate");
  if (!box) return;
  box.checked = on;
  box.addEventListener("change", () => chrome.storage.local.set({ autoActivate: box.checked }).catch(() => {}));
});

$("automate") && $("automate").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("automation.html") });
  window.close();
});

$("best") && $("best").addEventListener("click", async () => {
  const tab = await getActiveTab();
  const url = chrome.runtime.getURL("automation.html") + "?url=" + encodeURIComponent((tab && tab.url) || "");
  chrome.tabs.create({ url });
  window.close();
});
