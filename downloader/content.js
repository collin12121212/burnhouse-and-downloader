// Isolated-world content script: finds <video> elements in DOM & Shadow DOM,
// coordinates with MAIN-world bridge, and performs in-frame HLS segment downloading & assembly.
(function () {
  "use strict";

  const VIDEO_MIME_EXT = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/ogg": "ogv",
    "video/quicktime": "mov",
    "video/x-matroska": "mkv",
    "video/mp2t": "ts",
    "video/x-flv": "flv",
    "video/3gpp": "3gp",
    "application/vnd.apple.mpegurl": "m3u8",
    "application/x-mpegurl": "m3u8",
    "application/dash+xml": "mpd"
  };

  const VIDEO_EXTS = new Set([
    "mp4", "webm", "ogv", "ogg", "mov", "mkv", "avi", "m4v",
    "mpg", "mpeg", "ts", "m3u8", "mpd", "flv", "3gp"
  ]);

  const pending = new Map();
  let nextId = 1;
  const runningDownloads = new Set();

  function extFor(mime, fallback) {
    if (mime) {
      const base = mime.split(";")[0].trim().toLowerCase();
      if (VIDEO_MIME_EXT[base]) return VIDEO_MIME_EXT[base];
    }
    return fallback || "mp4";
  }

  function safeName(name) {
    return String(name || "")
      .replace(/[\\/:*?"<>|#%&{}$!'@+`=\x00-\x1f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
  }

  function urlExtension(url) {
    try {
      const path = new URL(url).pathname;
      const last = path.split("/").pop() || "";
      const dot = last.lastIndexOf(".");
      if (dot > 0) {
        const ext = last.slice(dot + 1).toLowerCase();
        if (VIDEO_EXTS.has(ext)) return ext;
      }
    } catch (_) {}
    return "";
  }

  function hintFor(el) {
    if (el.alt || el.title || el.getAttribute("aria-label")) {
      return el.alt || el.title || el.getAttribute("aria-label");
    }
    const container = el.closest("figure, article, section, main, div");
    if (container) {
      const heading = container.querySelector("figcaption, h1, h2, h3, h4, strong");
      if (heading && heading.textContent.trim()) return heading.textContent.trim();
    }
    return document.title ? document.title.replace(/[-_|].*$/, "").trim() : "";
  }

  function fileNameFor(el, index, url, mime) {
    let base = "";
    try {
      const path = decodeURIComponent(new URL(url).pathname);
      const last = path.split("/").filter(Boolean).pop() || "";
      const dot = last.lastIndexOf(".");
      if (dot > 0) base = last.slice(0, dot);
    } catch (_) {}
    if (!base || base === "master" || base === "index") base = hintFor(el) || `video-${index + 1}`;
    const ext = urlExtension(url) || extFor(mime, "mp4");
    return `${safeName(base) || `video-${index + 1}`}.${ext === "m3u8" || ext === "mpd" ? "mp4" : ext}`;
  }

  // Deep traversal finding <video> elements inside regular DOM and open Shadow DOMs
  function findAllVideoElements(root = document) {
    const elements = [];
    function traverse(node) {
      if (!node) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        if (tag === "video") {
          elements.push(node);
        }
        if (node.shadowRoot) {
          traverse(node.shadowRoot);
        }
      }
      for (const child of node.children || []) {
        traverse(child);
      }
    }
    traverse(root);
    return elements;
  }

  function collectVideos() {
    const seen = new Set();
    const videos = [];
    const elements = findAllVideoElements(document);

    elements.forEach((el, index) => {
      const entries = [];
      if (el.currentSrc) entries.push({ url: el.currentSrc, source: null });
      else if (el.src && el.src !== "about:blank") {
        entries.push({ url: el.src, source: null });
      }
      el.querySelectorAll("source").forEach((s) => {
        if (s.src) entries.push({ url: s.src, source: s });
      });

      entries.forEach(({ url, source }) => {
        if (!url || url === "about:blank" || seen.has(url)) return;
        const mime =
          (source && source.type) ||
          (url === el.currentSrc ? el.getAttribute("type") || el.type : "") ||
          "";
        seen.add(url);
        const isBlob = url.startsWith("blob:");
        const isHls = /\.m3u8(\?|$)/i.test(url);
        const isDash = /\.mpd(\?|$)/i.test(url);

        videos.push({
          url,
          name: fileNameFor(el, index, url, mime),
          type: isBlob ? "blob" : isHls ? "hls" : isDash ? "dash" : "mp4",
          mime: mime || "",
          width: el.videoWidth || 0,
          height: el.videoHeight || 0,
          duration: Number.isFinite(el.duration) ? el.duration : 0,
          blob: isBlob,
          paused: el.paused,
          currentTime: el.currentTime
        });
      });
    });

    return videos;
  }

  function pageMessage(type, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Page bridge timed out"));
      }, timeoutMs || 60000);
      pending.set(id, { resolve, reject, timeout });
      window.postMessage(Object.assign({ source: "vdl-content", id, type }, payload), "*");
    });
  }

  async function getStreamsFromPage() {
    try {
      const res = await pageMessage("VDL_GET_STREAMS", {}, 1500);
      if (res && res.ok && Array.isArray(res.streams)) return res.streams;
    } catch (_) {}
    return [];
  }

  function streamName(url) {
    try {
      const path = decodeURIComponent(new URL(url).pathname);
      const last = path.split("/").filter(Boolean).pop() || "";
      const dot = last.lastIndexOf(".");
      const base = dot > 0 ? last.slice(0, dot) : last;
      if (base && base !== "master" && base !== "index") return safeName(base);
    } catch (_) {}
    return safeName(hintFor(document.body || {})) || "video";
  }

  function anchorDownload(href, filename, keepUrl) {
    const a = document.createElement("a");
    a.href = href;
    a.download = filename || "video.mp4";
    a.style.display = "none";
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      if (!keepUrl) URL.revokeObjectURL(href);
    }, 600000);
    return { ok: true };
  }

  const reportedUrls = new Set();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Find video/stream URLs inside arbitrary text (HTML, inline scripts, JSON API replies).
  function extractUrls(text, base) {
    const out = new Set();
    if (!text || text.length > 5000000) return [];
    const t = text
      .replace(/\\u002[fF]/g, "/")
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&");
    const add = (raw) => {
      if (!raw || /[${}]|%7B/.test(raw)) return;
      try {
        const href = new URL(raw, base).href;
        if (/^https?:/i.test(href)) out.add(href);
      } catch (_) {}
    };
    const abs = /(?:https?:)?\/\/[^\s"'`<>\\()]+?\.(?:m3u8|mpd|mp4|webm)(?=[?#"'`\s<>\\()]|$)(?:\?[^\s"'`<>\\()]*)?/gi;
    const rel = /["'`]((?:\.{0,2}\/)?[^"'`\s<>\\]*?\.(?:m3u8|mpd|mp4|webm)(?:\?[^"'`\s<>\\]*)?)["'`]/gi;
    let m;
    while ((m = abs.exec(t))) add(m[0]);
    while ((m = rel.exec(t))) add(m[1]);
    return Array.from(out);
  }

  function reportMedia(mediaList) {
    if (!mediaList || !mediaList.length) return;
    mediaList.forEach((m) => m && m.url && reportedUrls.add(m.url));
    try {
      chrome.runtime.sendMessage({
        type: "REPORT_MEDIA",
        media: mediaList
      }).catch(() => {});
    } catch (_) {}
  }

  function scanAndReport() {
    const vids = collectVideos();
    if (vids.length) {
      reportMedia(vids);
    }
  }

  // ---- Finding videos without pressing play ---------------------------------------------
  function candidateEntry(url) {
    const isHls = /\.m3u8/i.test(url);
    const isDash = /\.mpd/i.test(url);
    return {
      url,
      name: `${streamName(url)}.mp4`,
      type: isHls ? "hls" : isDash ? "dash" : /\.webm/i.test(url) ? "webm" : "mp4",
      stream: isHls || isDash,
      candidate: true
    };
  }

  // 1) Read the page source (inline scripts, JSON blobs, data attributes) and same-origin scripts.
  async function staticScan(withScripts) {
    const found = new Set(extractUrls(document.documentElement.outerHTML, location.href));
    if (withScripts) {
      const srcs = Array.from(document.scripts)
        .map((s) => s.src)
        .filter((u) => u && u.startsWith(location.origin))
        .slice(0, 30);
      await Promise.all(
        srcs.map(async (u) => {
          try {
            const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
            const t = await r.text();
            extractUrls(t, u).forEach((x) => found.add(x));
          } catch (_) {}
        })
      );
    }
    const list = Array.from(found).map(candidateEntry);
    if (list.length) reportMedia(list);
    return list.length;
  }

  // Never starts or clicks the player: only reads what the page and its network traffic expose.
  async function deepScan(activate) {
    // Activation first (it is what makes the page reveal its stream); the script scan runs alongside.
    await Promise.all([staticScan(true).catch(() => {}), activate ? activatePlayers() : null]);
    scanAndReport();
  }

  // ---- Silent activation ---------------------------------------------------------------
  // Some players only fetch their stream once play is pressed. When the user asks for it
  // (popup opened, nothing found), start them MUTED; the moment the extension sees the stream
  // URL it pauses them again and restores their sound setting, usually within a second.
  const PLAY_SELECTORS = [
    "#bigPlay", ".jw-bigplay", ".jw-icon-display", ".jw-display-icon-container", ".vjs-big-play-button",
    ".plyr__control--overlaid", ".ytp-large-play-button", ".mejs__overlay-play", ".fp-play",
    "[class*='big-play']", "[class*='bigplay']", "[id*='bigPlay']", "[id*='bigplay']",
    "[class*='play-button']", "[class*='playbutton']", "button[aria-label*='play' i]", "[title='Play']"
  ].join(",");

  const pressCount = new WeakMap(); // never press the same control more than twice (it would pause the player)
  const scanState = { active: false, frameIsNew: false, started: new Map() };

  function muteGuard(e) {
    const v = e.target;
    if (!scanState.active || !v || v.tagName !== "VIDEO") return;
    if (!scanState.started.has(v)) scanState.started.set(v, { muted: v.muted, time: v.currentTime });
    v.muted = true;
  }

  function beginSilentScan(frameIsNew) {
    if (scanState.active) return;
    scanState.active = true;
    scanState.frameIsNew = frameIsNew;
    for (const ev of ["play", "playing", "volumechange", "loadstart"]) document.addEventListener(ev, muteGuard, true);
  }

  function endSilentScan() {
    if (!scanState.active) return;
    scanState.active = false;
    for (const ev of ["play", "playing", "volumechange", "loadstart"]) document.removeEventListener(ev, muteGuard, true);
    for (const v of findAllVideoElements(document)) {
      const st = scanState.started.get(v);
      if (!st && !scanState.frameIsNew) continue; // the user's own playback: leave it alone
      try {
        v.pause();
        if (st && st.time < 1) v.currentTime = st.time;
        v.muted = st ? st.muted : false;
      } catch (_) {}
    }
    scanState.started.clear();
  }

  async function activatePlayers() {
    beginSilentScan(false);
    for (const v of findAllVideoElements(document)) {
      if (!v.paused || v.ended) continue;
      scanState.started.set(v, { muted: v.muted, time: v.currentTime });
      v.muted = true;
      Promise.race([v.play(), sleep(1500)]).catch(() => {});
    }
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    // Players with ad overlays often swallow the first press, so press up to twice.
    for (let round = 0; round < 2 && scanState.active; round++) {
      const buttons = Array.from(document.querySelectorAll(PLAY_SELECTORS))
        .filter(visible)
        .filter((b) => (pressCount.get(b) || 0) < 2)
        .slice(0, 2);
      for (const b of buttons) {
        pressCount.set(b, (pressCount.get(b) || 0) + 1);
        try {
          b.click();
        } catch (_) {}
      }
      if (!buttons.length) break;
      await sleep(1500);
    }
  }

  // Frames created while a silent scan runs (e.g. the real player iframe that appears after
  // pressing play) must start muted as well.
  try {
    chrome.runtime.sendMessage({ type: "SCAN_STATE" }).then((r) => {
      if (r && r.active) beginSilentScan(true);
    }, () => {});
  } catch (_) {}


  // ---- Bot-check pages and episode lists (used by the automation page) ---------------------
  // A page that is only a human-verification screen can't be scanned. Tell the extension so the
  // automation can pause and ask the user to pass it once. The extension never clicks it.
  if (window === window.top) {
    const GATE_RE = /not a bot|real person|are you human|verify you|captcha|quick check|checking your browser|just a moment/i;
    const checkGate = () => {
      try {
        const t = ((document.body && document.body.innerText) || "").trim();
        if (t.length < 900 && GATE_RE.test(t) && !document.querySelector("video")) {
          chrome.runtime.sendMessage({ type: "PAGE_GATE" }).catch(() => {});
        }
      } catch (_) {}
    };
    [900, 2500, 6000].forEach((ms) => setTimeout(checkGate, ms));
  }

  // Cheap automatic pass: no interaction, only reads what is already on the page.
  [400, 2500, 6000].forEach((ms) => setTimeout(() => staticScan(false).catch(() => {}), ms));

  let observer = null;
  function startObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(() => {
      scanAndReport();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "currentSrc"]
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      startObserver();
      scanAndReport();
    });
  } else {
    startObserver();
    scanAndReport();
  }

  ["play", "playing", "loadedmetadata", "loadstart", "canplay"].forEach((evtName) => {
    document.addEventListener(
      evtName,
      (e) => {
        if (e.target && e.target.tagName === "VIDEO") {
          setTimeout(scanAndReport, 100);
        }
      },
      { capture: true, passive: true }
    );
  });

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object" || data.source !== "vdl-page") return;

    if (data.type === "VDL_MEDIA_FOUND" && data.media) {
      const m = data.media;
      reportMedia([
        {
          url: m.url,
          name: `${streamName(m.url)}.mp4`,
          type: m.kind,
          mime: m.mime || "",
          size: m.size || 0,
          stream: m.kind === "hls" || m.kind === "dash",
          blob: m.kind === "blob",
          candidate: !!m.candidate
        }
      ]);
      return;
    }

    if (
      data.type !== "VDL_BLOB_RESULT" &&
      data.type !== "VDL_ANCHOR_RESULT" &&
      data.type !== "VDL_STREAMS_RESULT"
    ) {
      return;
    }

    const entry = pending.get(data.id);
    if (!entry) return;
    clearTimeout(entry.timeout);
    pending.delete(data.id);
    if (data.ok || data.tooLarge) entry.resolve(data);
    else entry.reject(new Error(data.error || "Operation failed"));
  });

  function send(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }

  const activeWatchdogs = new Map(); // url -> watchdog (lets the user cancel)

  async function executeDownload(kind, url, rawFilename) {
    if (runningDownloads.has(url)) return;
    runningDownloads.add(url);
    const onProgress = (completed, total, stage, bytes) => {
      send({
        type: "REPORT_DOWNLOAD_PROGRESS",
        url,
        completed,
        total,
        stage,
        percent: Math.min(100, Math.round((completed / total) * 100)),
        bytes
      });
    };
    try {
      let blob = null;
      let filename = rawFilename || "video.mp4";

      if (kind === "hls") {
        // Watchdog + one automatic restart: a stalled host gets a second chance on fresh connections.
        let res;
        for (let attempt = 1; ; attempt++) {
          const wd = VDL_HLS.watchdog(onProgress, 45000);
          activeWatchdogs.set(url, wd);
          try {
            res = await VDL_HLS.download(url, wd.onProgress, { signal: wd.signal });
            break;
          } catch (e) {
            if (wd.signal.aborted && /cancel/i.test(String(wd.signal.reason && wd.signal.reason.message))) throw new Error("Cancelled");
            if (attempt >= 2 || !/stalled/i.test(String(e && e.message))) throw e;
            send({ type: "REPORT_DOWNLOAD_PROGRESS", url, completed: 0, total: 1, stage: "download", percent: 0, bytes: 0 });
          } finally {
            wd.stop();
            activeWatchdogs.delete(url);
          }
        }
        blob = res.blob;
        filename = `${filename.replace(/\.(m3u8|mpd|ts|mp4)$/i, "")}.${res.ext || "mp4"}`;
      } else if (url.startsWith("blob:")) {
        anchorDownload(url, filename, true);
        send({ type: "REPORT_DOWNLOAD_COMPLETE", url, filename, size: 0 });
        return;
      } else {
        try {
          const wd = VDL_HLS.watchdog(onProgress, 45000);
          activeWatchdogs.set(url, wd);
          try {
            blob = (await VDL_HLS.downloadFile(url, wd.onProgress, { signal: wd.signal })).blob;
          } finally {
            wd.stop();
            activeWatchdogs.delete(url);
          }
        } catch (err) {
          // No range support / blocked by CORS: let the browser's download manager do it.
          const res = await chrome.runtime.sendMessage({ type: "DOWNLOAD", url, filename });
          if (!res || !res.ok) throw new Error((res && res.error) || err.message);
          send({ type: "REPORT_DOWNLOAD_COMPLETE", url, filename, size: 0 });
          return;
        }
      }

      anchorDownload(URL.createObjectURL(blob), filename);
      send({ type: "REPORT_DOWNLOAD_COMPLETE", url, filename, size: blob.size });
    } catch (err) {
      send({ type: "REPORT_DOWNLOAD_ERROR", url, error: err.message });
    } finally {
      runningDownloads.delete(url);
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return false;

    if (msg.type === "BENCH") {
      // Diagnostic: segment download speed from inside this frame, at several connection counts.
      (async () => {
        try {
          let pl = VDL_HLS.parsePlaylist(await (await fetch(msg.url)).text(), msg.url);
          if (pl.master) {
            const u = VDL_HLS.pickBest(pl).variant.url;
            pl = VDL_HLS.parsePlaylist(await (await fetch(u)).text(), u);
          }
          const segs = pl.segments.map((s) => s.url);
          const out = [];
          let next = msg.offset || 0;
          for (const conc of msg.conc || [1, 8]) {
            const list = segs.slice(next, next + Math.max(conc * 2, 6));
            next += list.length;
            let idx = 0;
            let bytes = 0;
            const t0 = performance.now();
            await Promise.all(Array.from({ length: conc }, async () => {
              while (idx < list.length) {
                const r = await fetch(list[idx++]);
                bytes += (await r.arrayBuffer()).byteLength;
              }
            }));
            out.push("conc " + conc + ": " + (bytes / 1048576 / ((performance.now() - t0) / 1000)).toFixed(2) + " MB/s");
          }
          sendResponse({ ok: true, out });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }

    if (msg.type === "GET_SERVERS") {
      // Provider switches: links/buttons carrying a server id, either as a data attribute
      // (data-srv / data-server), a hash link (#vidfast) or a query link (?server=vidfast).
      const seen = new Map();
      let mode = "";
      let param = "server";
      document.querySelectorAll("[data-srv], [data-server], a[href]").forEach((el) => {
        let value = el.getAttribute("data-srv") || el.getAttribute("data-server") || "";
        const href = el.getAttribute("href") || "";
        let m = "";
        if (/^#[\w-]+$/.test(href)) {
          value = value || href.slice(1);
          m = "hash";
        } else if (href && !href.startsWith("#")) {
          try {
            const u = new URL(href, location.href);
            if (u.origin !== location.origin) return;
            for (const [k, v] of u.searchParams) {
              if (/^(server|provider|source)$/i.test(k) && v) {
                value = value || v;
                param = k;
                m = "param";
                break;
              }
            }
          } catch (_) {
            return;
          }
        }
        if (!value) return;
        // Only count it as a server switch when it looks like one.
        const cls = (el.className && String(el.className)) || "";
        const hasData = el.hasAttribute("data-srv") || el.hasAttribute("data-server");
        const looksLikeServer = /server|source|provider|srv/i.test(cls + " " + (el.parentElement ? el.parentElement.className : ""));
        if (m !== "param" && !hasData && !looksLikeServer) return;
        if (seen.has(value)) return;
        mode = mode || m || "hash";
        const label = ((el.textContent || "").trim() || value).slice(0, 40);
        seen.set(value, {
          value,
          label,
          active: el.classList.contains("active") || el.getAttribute("aria-selected") === "true",
          recommended: /\u2b50|recommend/i.test(label)
        });
      });
      sendResponse({ ok: true, mode: mode || "hash", param, servers: Array.from(seen.values()) });
      return false;
    }

    if (msg.type === "GET_SEASONS") {
      const seasons = {};
      document.querySelectorAll("select option").forEach((o) => {
        const m = /season\s*(\d+)[^(]*\((\d+)\s*eps?\)/i.exec(o.textContent || "");
        if (m) seasons[m[1]] = parseInt(m[2], 10);
      });
      sendResponse({ ok: true, seasons });
      return false;
    }

    if (msg.type === "CANCEL_DOWNLOAD") {
      const wd = activeWatchdogs.get(msg.url);
      if (wd) wd.abort(new Error("Cancelled"));
      sendResponse({ ok: !!wd });
      return false;
    }

    if (msg.type === "SCAN_DONE") {
      endSilentScan();
      return false;
    }

    if (msg.type === "DEEP_SCAN") {
      Promise.race([deepScan(!!msg.activate), sleep(8000)])
        .catch(() => {})
        .then(() => sendResponse({ ok: true }));
      return true;
    }

    if (msg.type === "VERIFY_URL") {
      (async () => {
        try {
          if (/\.m3u8/i.test(msg.url)) await VDL_HLS.analyze(msg.url, { retries: 1 });
          else {
            const p = await VDL_HLS.probeFile(msg.url);
            if (!p.ok) throw new Error("not a video");
            sendResponse({ ok: true, size: p.size });
            return;
          }
          sendResponse({ ok: true });
        } catch (_) {
          sendResponse({ ok: false });
        }
      })();
      return true;
    }

    if (msg.type === "GET_VIDEOS") {
      (async () => {
        const videos = collectVideos();
        const seenUrls = new Set(videos.map((v) => v.url));
        const streams = await getStreamsFromPage();
        for (const s of streams) {
          if (seenUrls.has(s.url)) continue;
          seenUrls.add(s.url);
          videos.push({
            url: s.url,
            name: `${streamName(s.url)}.mp4`,
            type: s.kind === "m3u8" ? "hls" : s.kind === "mpd" ? "dash" : s.kind,
            mime: s.mime || "",
            width: 0,
            height: 0,
            duration: 0,
            stream: s.kind === "hls" || s.kind === "dash" || s.kind === "m3u8" || s.kind === "mpd",
            candidate: !!s.candidate
          });
        }
        sendResponse({ ok: true, videos });
      })();
      return true;
    }

    if (msg.type === "START_HLS_DOWNLOAD" || msg.type === "START_FILE_DOWNLOAD") {
      // Long-running: answer immediately, progress/result arrive as REPORT_DOWNLOAD_* messages.
      executeDownload(msg.type === "START_HLS_DOWNLOAD" ? "hls" : "file", msg.url, msg.filename);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });
})();
