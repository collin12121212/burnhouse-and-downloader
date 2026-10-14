// MAIN-world script: runs inside the page context at document_start.
// Hooks fetch, XHR, URL.createObjectURL, and HTMLMediaElement strictly for VIDEO sources.
(function () {
  "use strict";

  const MAX_BLOB_BYTES = 45 * 1024 * 1024;
  const captured = new Map(); // href -> { url, kind, size, mime }
  const seen = new Set();


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

  function classifyVideo(raw) {
    if (!raw || typeof raw !== "string") return "";
    try {
      const u = new URL(raw, location.href);
      if (u.protocol !== "https:" && u.protocol !== "http:" && u.protocol !== "blob:") return "";

      const path = u.pathname;
      const full = u.pathname + u.search;

      if (/\.m3u8([?#].*)?$/i.test(path) || /[?&](file|url|src|manifest)=[^&]*\.m3u8/i.test(full)) return "hls";
      if (/\.mpd([?#].*)?$/i.test(path)) return "dash";
      if (/\.mp4([?#].*)?$/i.test(path)) return "mp4";
      if (/\.webm([?#].*)?$/i.test(path)) return "webm";
      if (/\.(mov|mkv|avi|flv|wmv|m4v|ogv|3gp)([?#].*)?$/i.test(path)) return "media";
      if (u.pathname.includes("videoplayback")) return "mp4";
    } catch (_) {}
    return "";
  }

  function noteVideo(raw, extra = {}) {
    if (!raw) return;
    try {
      const rawUrl = typeof raw === "string" ? raw : raw && raw.url;
      if (!rawUrl || typeof rawUrl !== "string") return;
      const u = new URL(rawUrl, location.href);
      if (u.protocol !== "https:" && u.protocol !== "http:" && u.protocol !== "blob:") return;

      const kind = extra.kind || classifyVideo(u.href);
      if (!kind && !rawUrl.startsWith("blob:")) return;

      const href = u.href;
      if (seen.has(href)) return;
      seen.add(href);

      const entry = {
        url: href,
        kind: kind || "media",
        mime: extra.mime || "",
        size: extra.size || 0,
        candidate: !!extra.candidate
      };
      captured.set(href, entry);

      // Notify content script
      window.postMessage(
        {
          source: "vdl-page",
          type: "VDL_MEDIA_FOUND",
          media: entry
        },
        "*"
      );
    } catch (_) {}
  }

  function seedFromPerformance() {
    try {
      if (window.performance && performance.getEntriesByType) {
        performance.getEntriesByType("resource").forEach((e) => noteVideo(e.name));
      }
    } catch (_) {}
  }

  // Players often receive the stream URL from an API reply long before play is pressed:
  // read text/JSON responses and pull video URLs out of them.
  const TEXTY = /json|javascript|html|text\/plain/i;
  function scanBody(text, baseUrl) {
    try {
      for (const u of extractUrls(text, baseUrl)) noteVideo(u, { candidate: true });
    } catch (_) {}
  }

  // Hook window.fetch
  try {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const raw = typeof input === "string" ? input : input && input.url;
        noteVideo(raw);
      } catch (_) {}
      const p = origFetch.apply(this, arguments);
      p.then(
        (r) => {
          try {
            const ct = r.headers.get("content-type") || "";
            const len = parseInt(r.headers.get("content-length") || "0", 10);
            if (TEXTY.test(ct) && len < 3000000) {
              r.clone().text().then((t) => scanBody(t, r.url), () => {});
            }
          } catch (_) {}
        },
        () => {}
      );
      return p;
    };
  } catch (_) {}

  // Hook XMLHttpRequest
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        noteVideo(url);
        this.addEventListener("load", () => {
          try {
            if ((this.responseType === "" || this.responseType === "text") && TEXTY.test(this.getResponseHeader("content-type") || "")) {
              scanBody(this.responseText, this.responseURL || location.href);
            }
          } catch (_) {}
        });
      } catch (_) {}
      return origOpen.apply(this, arguments);
    };
  } catch (_) {}

  // Hook URL.createObjectURL (only capture true video Blobs, ignore MediaSource MSE buffers)
  try {
    const origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      const url = origCreateObjectURL.apply(this, arguments);
      try {
        if (obj && !(typeof MediaSource !== "undefined" && obj instanceof MediaSource)) {
          const type = (obj.type || "").toLowerCase();
          // Only capture if it is an actual video blob with reasonable size
          if (type.startsWith("video/") && (obj.size > 50000 || !obj.size)) {
            noteVideo(url, {
              kind: "blob",
              mime: type,
              size: obj.size || 0
            });
          }
        }
      } catch (_) {}
      return url;
    };
  } catch (_) {}

  // Hook HTMLMediaElement prototype
  try {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      try {
        if (this.tagName === "VIDEO") {
          if (this.currentSrc) noteVideo(this.currentSrc);
          if (this.src) noteVideo(this.src);
        }
      } catch (_) {}
      return origPlay.apply(this, arguments);
    };
  } catch (_) {}

  seedFromPerformance();
  if (document.readyState === "complete") seedFromPerformance();
  else window.addEventListener("load", seedFromPerformance, { once: true });

  function respond(id, payload) {
    window.postMessage(
      Object.assign({ source: "vdl-page", id, type: "VDL_BLOB_RESULT" }, payload),
      "*"
    );
  }

  // Handle messages from isolated content script
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object" || data.source !== "vdl-content") return;

    if (data.type === "VDL_GET_STREAMS") {
      seedFromPerformance();
      window.postMessage(
        {
          source: "vdl-page",
          id: data.id,
          type: "VDL_STREAMS_RESULT",
          ok: true,
          streams: Array.from(captured.values())
        },
        "*"
      );
    } else if (data.type === "VDL_FETCH_BLOB") {
      fetch(data.url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.blob();
        })
        .then((blob) => {
          if (blob.size > MAX_BLOB_BYTES) {
            respond(data.id, { tooLarge: true, size: blob.size });
            return;
          }
          const reader = new FileReader();
          reader.onload = () =>
            respond(data.id, { ok: true, dataUrl: reader.result, size: blob.size });
          reader.onerror = () => respond(data.id, { ok: false, error: "FileReader error" });
          reader.readAsDataURL(blob);
        })
        .catch((err) => respond(data.id, { ok: false, error: err.message }));
    } else if (data.type === "VDL_ANCHOR_DOWNLOAD") {
      const a = document.createElement("a");
      a.href = data.url;
      a.download = data.filename || "video.mp4";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 1000);
      window.postMessage(
        { source: "vdl-page", id: data.id, type: "VDL_ANCHOR_RESULT", ok: true },
        "*"
      );
    }
  });
})();
