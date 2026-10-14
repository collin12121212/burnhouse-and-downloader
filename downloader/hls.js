// HLS engine shared by the content script (downloads) and the service worker (analysis).
// - Resolves master playlists to the best video variant AND its separate audio rendition.
// - Downloads segments in parallel, decrypts AES-128 (correct IVs), muxes while downloading.
// - Remuxes MPEG-TS (via mux.js) and fMP4 into ONE mp4 with every track on a shared timeline,
//   so audio/video offsets from the source are preserved exactly.
(function (root) {
  "use strict";

  const CONCURRENCY = 16;
  const LOOKAHEAD = 256;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- fetching
  const STALL_MS = root.VDL_STALL_MS || 8000; // abort a request that receives nothing for this long, then resume it
  const newNet = () => ({ bytes: 0, errors: 0, signal: null });
  const MIN_WINDOW_BYTES = 32768; // a request delivering less than this per stall window is stalled

  // Per-host gate, shared by every download running in this page. Several episodes are often
  // served by the same host; together they must not exceed what that host tolerates. AIMD:
  // a 429 halves the host's connection budget and pauses it (Retry-After or 1-8 s backoff);
  // sustained success slowly raises the budget again.
  const hostGates = new Map();

  function gateFor(url) {
    let host = "";
    try {
      host = new URL(url).host;
    } catch (_) {}
    let g = hostGates.get(host);
    if (!g) hostGates.set(host, (g = { limit: 48, inflight: 0, until: 0, ok: 0, last429: 0, strikes: 0, waiters: [], gap: 0, lastStart: 0 }));
    return g;
  }

  async function acquireHost(g, outer) {
    for (;;) {
      if (outer && outer.aborted) throw outer.reason || new Error("cancelled");
      const now = Date.now();
      if (now < g.until) {
        await sleep(Math.min(g.until - now, 500));
        continue;
      }
      // Pacing: a host that answers 429 at a given request rate gets requests spaced out, so we
      // settle at the rate it accepts instead of wasting round trips on refusals.
      if (g.gap && now - g.lastStart < g.gap) {
        await sleep(g.gap - (now - g.lastStart));
        continue;
      }
      if (g.inflight < g.limit) {
        g.inflight++;
        g.lastStart = Date.now();
        return;
      }
      await Promise.race([new Promise((r) => g.waiters.push(r)), sleep(500)]);
    }
  }

  function releaseHost(g) {
    g.inflight = Math.max(0, g.inflight - 1);
    const w = g.waiters.shift();
    if (w) w();
  }

  function hostThrottled(g, retryAfter) {
    const now = Date.now();
    g.strikes = now - g.last429 < 15000 ? Math.min(g.strikes + 1, 4) : 0;
    g.last429 = now;
    g.ok = 0;
    g.limit = Math.max(2, Math.floor(Math.min(g.limit, Math.max(g.inflight, 2)) * 0.5));
    // Concurrency already minimal and still refused: the host limits request *rate*, so pace.
    if (g.limit <= 3) g.gap = Math.min(1500, Math.max(60, g.gap * 1.6));
    // Once pacing is active the spacing itself is the remedy; only pause long when the host
    // names a delay or keeps refusing with plenty of spacing.
    const backoff = retryAfter > 0 ? Math.min(retryAfter * 1000, 30000) : g.gap && g.gap < 1500 ? g.gap : Math.min(4000, 300 * Math.pow(2, g.strikes));
    g.until = Math.max(g.until, now + backoff);
  }

  function hostOk(g) {
    if (g.gap) g.gap = g.gap < 30 ? 0 : g.gap * 0.85;
    if (++g.ok >= 12 && Date.now() - g.last429 > 8000) {
      g.ok = 0;
      g.limit = Math.min(96, g.limit + 2);
    }
  }

  // One HTTP attempt. On failure the error carries `partial` (bytes already received) so the
  // retry can resume with a Range request instead of starting the segment over.
  async function fetchOnce(url, range, text, net) {
    const gate = gateFor(url);
    await acquireHost(gate, net && net.signal);
    try {
      return await fetchOnceGated(url, range, text, net, gate);
    } finally {
      releaseHost(gate);
    }
  }

  async function fetchOnceGated(url, range, text, net, gate) {
    const ac = new AbortController();
    const chunks = [];
    let got = 0;
    let status = 0;
    // Stall detection by rate, not just silence: a host trickling a few bytes every few seconds
    // would otherwise hold a segment (and everything queued behind it) forever.
    let windowStart = 0;
    const timer = setInterval(() => {
      if (got - windowStart < MIN_WINDOW_BYTES) ac.abort(new Error(`stalled (under ${MIN_WINDOW_BYTES >> 10} KB in ${STALL_MS / 1000}s)`));
      windowStart = got;
    }, STALL_MS);
    const outer = net && net.signal;
    const onOuterAbort = () => ac.abort(outer.reason instanceof Error ? outer.reason : new Error("cancelled"));
    if (outer) {
      if (outer.aborted) onOuterAbort();
      else outer.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
      let headers;
      if (range) {
        const end = range.length != null ? range.offset + range.length - 1 : "";
        headers = { Range: `bytes=${range.offset}-${end}` };
      }
      const r = await fetch(url, { headers, signal: ac.signal });
      status = r.status;
      if (r.status === 429 || r.status === 503) {
        hostThrottled(gate, parseFloat(r.headers.get("retry-after")) || 0);
        if (net) net.last429 = Date.now();
        try {
          r.body && r.body.cancel();
        } catch (_) {}
      } else if (r.ok) {
        hostOk(gate);
      }
      if (!r.ok) {
        const e = new Error(`HTTP ${r.status}`);
        e.status = r.status;
        throw e;
      }
      if (text) return await r.text();
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
        if (net) net.bytes += value.byteLength;
      }
      let bytes = concatChunks(chunks, got);
      if (range && r.status === 200) {
        bytes = range.length != null ? bytes.subarray(range.offset, range.offset + range.length) : bytes.subarray(range.offset);
      }
      return bytes;
    } catch (e) {
      const err = ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : e;
      if (got && status === (range ? 206 : 200)) err.partial = concatChunks(chunks, got);
      throw err;
    } finally {
      clearInterval(timer);
      if (outer) outer.removeEventListener("abort", onOuterAbort);
    }
  }

  function concatChunks(chunks, total) {
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  }

  async function fetchRetry(url, opts) {
    const { range, text, retries = 8, net } = opts || {};
    let lastErr;
    let prefix = null; // bytes received by earlier, interrupted attempts
    let throttled = 0;
    for (let a = 1; a <= retries; a++) {
      if (net && net.signal && net.signal.aborted) throw net.signal.reason || new Error("cancelled");
      try {
        if (!prefix || text) return await fetchOnce(url, range, text, net);
        const off = (range ? range.offset : 0) + prefix.byteLength;
        const len = range ? range.length - prefix.byteLength : null;
        const rest = await fetchOnce(url, { offset: off, length: len }, false, net);
        const out = new Uint8Array(prefix.byteLength + rest.byteLength);
        out.set(prefix, 0);
        out.set(rest, prefix.byteLength);
        return out;
      } catch (e) {
        lastErr = e;
        if (net) net.errors++;
        if (e.partial && !text) {
          if (!prefix) prefix = e.partial;
          else {
            const merged = new Uint8Array(prefix.byteLength + e.partial.byteLength);
            merged.set(prefix, 0);
            merged.set(e.partial, prefix.byteLength);
            prefix = merged;
          }
        }
        if ((e.status === 404 || e.status === 410) && a >= 2) break;
        if (e.status === 429 || e.status === 503) {
          if (a > 2 && ++throttled < 60) a--; // the gate already waits; throttling does not burn retries
          continue;
        }
        if (e.status === 416) prefix = null; // server can't resume: start over
        if (a < retries) await sleep(Math.min(6000, 250 * a * a));
      }
    }
    throw lastErr;
  }

  // Adaptive parallel task pool: starts moderately wide, keeps adding connections while throughput
  // keeps growing, halves on errors/throttling, and hedges slow stragglers with a duplicate request.
  async function runPool(tasks, net, { run, accept, gate, startLimit = 24, maxLimit = 96 }) {
    const total = tasks.length;
    let qi = 0;
    let done = 0;
    let failure = null;
    let limit = Math.min(startLimit, maxLimit);
    const inflight = new Set();
    const durs = [];

    // Controller, every 500 ms. Hosts that cap speed per connection scale almost linearly with
    // connections, so keep widening while throughput rises; only real trouble (failed or
    // throttled requests) makes it narrower.
    // Hill-climbing controller (every 700 ms): keep adding connections while throughput rises,
    // step back to the best-known width when more connections stop helping (a host that caps
    // its total speed gains nothing from 90 streams, they only slow each segment down), and
    // cut back hard on failed or throttled requests.
    let lastBytes = 0;
    let lastErr = 0;
    let bestThr = 0;
    let bestLimit = limit;
    let flat = 0;
    const ctl = setInterval(() => {
      const thr = net.bytes - lastBytes;
      const errs = net.errors - lastErr;
      lastBytes = net.bytes;
      lastErr = net.errors;
      net.thr = thr / 0.7;
      net.limit = limit;
      if (errs >= 4) {
        limit = Math.max(6, Math.floor(limit * 0.6));
        bestThr *= 0.7;
        flat = 0;
        return;
      }
      if (thr > bestThr * 1.05) {
        bestThr = thr;
        bestLimit = limit;
        flat = 0;
        limit = Math.min(maxLimit, Math.ceil(limit * 1.4) + 2);
      } else if (++flat >= 3) {
        flat = 0;
        if (limit > bestLimit) limit = Math.max(bestLimit, Math.floor(limit * 0.75));
        else limit = Math.min(maxLimit, limit + 4); // probe upwards now and then
      }
      bestThr *= 0.985; // let the target follow a host whose speed changes
    }, 700);

    const median = () => {
      if (!durs.length) return 1000;
      const sorted = durs.slice(-64).sort((x, y) => x - y);
      return sorted[sorted.length >> 1];
    };

    // Duplicate the oldest request that is taking far longer than normal: the first copy to
    // finish wins. Used both at the tail and when a slow segment blocks in-order muxing.
    function pickStraggler() {
      if (Date.now() - (net.last429 || 0) < 15000) return null; // never pile on a throttling host
      const minAge = Math.max(2500, median() * 4);
      const now = Date.now();
      let pick = null;
      for (const t of inflight) {
        if (!t.done && !t.hedged && now - t.started > minAge && (!pick || t.started < pick.started)) pick = t;
      }
      return pick;
    }

    async function exec(t, hedge) {
      const started = Date.now();
      try {
        const res = await run(t);
        if (t.done) return;
        t.done = true;
        durs.push(Date.now() - started);
        accept(t, res);
        done++;
      } catch (e) {
        t.fails = (t.fails || 0) + 1;
        if (t.done || hedge) return;
        // Give the task more rounds later (after the server/CDN had time to recover).
        t.rounds = (t.rounds || 0) + 1;
        if (t.rounds < 4) {
          t.hedged = false;
          t.fails = 0;
          tasks.splice(qi, 0, t); // next in line, so ordered consumers never deadlock
        } else {
          failure = e;
        }
      }
    }

    async function hedgeOrWait(ms) {
      const pick = pickStraggler();
      if (pick) {
        pick.hedged = true;
        await exec(pick, true);
      } else {
        await sleep(ms);
      }
    }

    async function worker(id) {
      while (!failure && done < total) {
        if (net.signal && net.signal.aborted) {
          failure = net.signal.reason || new Error("cancelled");
          break;
        }
        if (id >= limit) {
          await sleep(60);
          continue;
        }
        if (qi < tasks.length) {
          const t = tasks[qi];
          if (gate && !gate(t)) {
            await hedgeOrWait(25); // blocked behind a slow segment: race it
            continue;
          }
          qi++;
          t.started = Date.now();
          inflight.add(t);
          await exec(t, false);
          inflight.delete(t);
        } else {
          await hedgeOrWait(50); // tail: race the slowest remaining requests
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: maxLimit }, (_, i) => worker(i)));
    } finally {
      clearInterval(ctl);
    }
    if (failure) throw failure;
  }

  // ---------------------------------------------------------------- playlists
  function parseAttrs(str) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(str))) {
      let v = m[2];
      if (v[0] === '"') v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  }

  function parseRange(str, prevEnd) {
    const [len, off] = String(str).split("@");
    const length = parseInt(len, 10);
    const offset = off != null ? parseInt(off, 10) : prevEnd || 0;
    return { offset, length };
  }

  function parsePlaylist(text, base) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length || !lines[0].startsWith("#EXTM3U")) throw new Error("Not an HLS playlist");

    if (lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"))) {
      const variants = [];
      const audio = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith("#EXT-X-STREAM-INF:")) {
          const a = parseAttrs(l.slice(18));
          let j = i + 1;
          while (j < lines.length && lines[j][0] === "#") j++;
          if (j >= lines.length) continue;
          const [w, h] = (a.RESOLUTION || "").split("x").map(Number);
          variants.push({
            url: new URL(lines[j], base).href,
            bandwidth: parseInt(a.BANDWIDTH, 10) || 0,
            width: w || 0,
            height: h || 0,
            audioGroup: a.AUDIO || "",
            codecs: a.CODECS || ""
          });
        } else if (l.startsWith("#EXT-X-MEDIA:")) {
          const a = parseAttrs(l.slice(13));
          if (a.TYPE === "AUDIO" && a.URI) {
            audio.push({
              url: new URL(a.URI, base).href,
              group: a["GROUP-ID"] || "",
              isDefault: a.DEFAULT === "YES"
            });
          }
        }
      }
      return { master: true, variants, audio };
    }

    let seq = 0;
    let key = null;
    let map = null;
    let disc = false;
    let dur = 0;
    let br = null;
    const lastEnd = new Map();
    const segments = [];
    for (const l of lines) {
      if (l[0] !== "#") {
        const url = new URL(l, base).href;
        let range = null;
        if (br) {
          range = parseRange(br, lastEnd.get(url));
          lastEnd.set(url, range.offset + range.length);
        }
        segments.push({ url, duration: dur, disc, key, map, range, seq: seq++ });
        disc = false;
        dur = 0;
        br = null;
      } else if (l.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        seq = parseInt(l.slice(22), 10) || 0;
      } else if (l.startsWith("#EXTINF:")) {
        dur = parseFloat(l.slice(8)) || 0;
      } else if (l === "#EXT-X-DISCONTINUITY") {
        disc = true;
      } else if (l.startsWith("#EXT-X-BYTERANGE:")) {
        br = l.slice(17);
      } else if (l.startsWith("#EXT-X-KEY:")) {
        const a = parseAttrs(l.slice(11));
        key =
          !a.METHOD || a.METHOD === "NONE"
            ? null
            : { method: a.METHOD, url: a.URI ? new URL(a.URI, base).href : "", iv: a.IV || null };
      } else if (l.startsWith("#EXT-X-MAP:")) {
        const a = parseAttrs(l.slice(11));
        map = a.URI
          ? { url: new URL(a.URI, base).href, range: a.BYTERANGE ? parseRange(a.BYTERANGE, 0) : null }
          : null;
      }
    }
    return { master: false, segments };
  }

  const hasVideoCodec = (c) => !c || /avc|hvc|hev|vp0?9|av01|mp4v/i.test(c);

  function pickBest(master) {
    let vs = master.variants.filter((v) => v.url);
    const withVideo = vs.filter((v) => hasVideoCodec(v.codecs));
    if (withVideo.length) vs = withVideo;
    vs.sort((a, b) => b.bandwidth - a.bandwidth || b.width * b.height - a.width * a.height);
    const variant = vs[0];
    if (!variant) throw new Error("Master playlist has no variants");
    let audioUrl = null;
    if (variant.audioGroup) {
      const c = master.audio.filter((a) => a.group === variant.audioGroup);
      const a = c.find((x) => x.isDefault) || c[0];
      if (a && a.url !== variant.url) audioUrl = a.url;
    }
    return { variant, audioUrl };
  }

  const AUDIO_EXT = /\.(aac|m4a|mp3|ac3|eac3)(\?|$)/i;

  // Light-weight description of a playlist, used to de-duplicate what the popup lists.
  async function analyze(url, opts) {
    const retries = (opts && opts.retries) || 2;
    const p = parsePlaylist(await fetchRetry(url, { text: true, retries }), url);
    if (p.master) {
      const best = pickBest(p);
      const info = {
        kind: "master",
        children: p.variants.map((v) => v.url).concat(p.audio.map((a) => a.url)),
        width: best.variant.width,
        height: best.variant.height,
        separateAudio: !!best.audioUrl,
        duration: 0
      };
      try {
        const v = parsePlaylist(await fetchRetry(best.variant.url, { text: true, retries }), best.variant.url);
        if (!v.master) info.duration = v.segments.reduce((s, x) => s + x.duration, 0);
      } catch (_) {}
      return info;
    }
    const first = p.segments[0];
    let isAudio = false;
    try {
      isAudio = !!first && AUDIO_EXT.test(new URL(first.url).pathname);
    } catch (_) {}
    return {
      kind: isAudio ? "audio" : "media",
      children: [],
      duration: p.segments.reduce((s, x) => s + x.duration, 0)
    };
  }

  // ---------------------------------------------------------------- crypto
  const keyCache = new Map();

  function getKey(keyInfo) {
    if (!keyCache.has(keyInfo.url)) {
      keyCache.set(
        keyInfo.url,
        fetchRetry(keyInfo.url).then((raw) =>
          crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["decrypt"])
        )
      );
    }
    return keyCache.get(keyInfo.url);
  }

  function ivFor(keyInfo, seq) {
    const iv = new Uint8Array(16);
    if (keyInfo.iv) {
      const hex = keyInfo.iv.replace(/^0x/i, "").padStart(32, "0");
      for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    } else {
      // Spec: IV defaults to the segment's media sequence number, big-endian.
      const dv = new DataView(iv.buffer);
      dv.setUint32(8, Math.floor(seq / 4294967296));
      dv.setUint32(12, seq >>> 0);
    }
    return iv;
  }

  async function decrypt(keyInfo, data, seq) {
    if (keyInfo.method !== "AES-128") {
      throw new Error(`Unsupported encryption (${keyInfo.method}); this stream is DRM protected`);
    }
    const key = await getKey(keyInfo);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivFor(keyInfo, seq) }, key, data));
  }

  // ---------------------------------------------------------------- MP4 boxes
  const td = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  const dvOf = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

  function readBoxes(buf, start, end) {
    const dv = dvOf(buf);
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      let hdr = 8;
      if (size === 1) {
        if (p + 16 > end) break;
        size = Number(dv.getBigUint64(p + 8));
        hdr = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < hdr || p + size > end) break;
      out.push({ type: td(buf, p + 4), start: p, end: p + size, hdr });
      p += size;
    }
    return out;
  }

  const kids = (buf, b) => readBoxes(buf, b.start + b.hdr, b.end);

  function mkBox(type, ...parts) {
    let size = 8;
    for (const p of parts) size += p.byteLength;
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    return out;
  }

  const u32 = (...vals) => {
    const out = new Uint8Array(vals.length * 4);
    const dv = new DataView(out.buffer);
    vals.forEach((v, i) => dv.setUint32(i * 4, v >>> 0));
    return out;
  };
  const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

  function parseInit(init) {
    const top = readBoxes(init, 0, init.length);
    const ftyp = top.find((b) => b.type === "ftyp");
    const moov = top.find((b) => b.type === "moov");
    if (!moov) throw new Error("Init segment has no moov box");
    const mk = kids(init, moov);
    const dv = dvOf(init);
    const mvhd = mk.find((b) => b.type === "mvhd");
    const mvVer = init[mvhd.start + mvhd.hdr];
    const traks = mk
      .filter((b) => b.type === "trak")
      .map((box) => {
        const tk = kids(init, box);
        const tkhd = tk.find((b) => b.type === "tkhd");
        const mdia = tk.find((b) => b.type === "mdia");
        const md = kids(init, mdia);
        const mdhd = md.find((b) => b.type === "mdhd");
        const hdlr = md.find((b) => b.type === "hdlr");
        const tv = init[tkhd.start + tkhd.hdr];
        const mv = init[mdhd.start + mdhd.hdr];
        return {
          box,
          id: dv.getUint32(tkhd.start + tkhd.hdr + 4 + (tv === 1 ? 16 : 8)),
          timescale: dv.getUint32(mdhd.start + mdhd.hdr + 4 + (mv === 1 ? 16 : 8)),
          handler: hdlr ? td(init, hdlr.start + hdlr.hdr + 8) : ""
        };
      });
    const mvex = mk.find((b) => b.type === "mvex");
    const trexs = mvex ? kids(init, mvex).filter((b) => b.type === "trex") : [];
    return {
      ftyp: ftyp ? init.slice(ftyp.start, ftyp.end) : null,
      mvhd,
      movieTimescale: dv.getUint32(mvhd.start + mvhd.hdr + 4 + (mvVer === 1 ? 16 : 8)),
      traks,
      trexs,
      dv
    };
  }

  // Describe every moof in a buffer: where to patch ids / sequence / decode times.
  function analyzeFrag(buf) {
    const dv = dvOf(buf);
    const moofs = [];
    for (const top of readBoxes(buf, 0, buf.length)) {
      if (top.type !== "moof") continue;
      const ks = kids(buf, top);
      const mfhd = ks.find((b) => b.type === "mfhd");
      const trafs = [];
      for (const traf of ks.filter((b) => b.type === "traf")) {
        const tk = kids(buf, traf);
        const tfhd = tk.find((b) => b.type === "tfhd");
        const tfdt = tk.find((b) => b.type === "tfdt");
        if (!tfhd || !tfdt) continue;
        const fl = (dv.getUint32(tfhd.start + tfhd.hdr) & 0xffffff) >>> 0;
        const trackId = dv.getUint32(tfhd.start + tfhd.hdr + 4);
        let p = tfhd.start + tfhd.hdr + 8;
        if (fl & 1) p += 8;
        if (fl & 2) p += 4;
        const defDur = fl & 8 ? dv.getUint32(p) : 0;
        const tv = buf[tfdt.start + tfdt.hdr];
        const tpos = tfdt.start + tfdt.hdr + 4;
        let dur = 0;
        for (const trun of tk.filter((b) => b.type === "trun")) {
          const tf = dv.getUint32(trun.start + trun.hdr) & 0xffffff;
          const count = dv.getUint32(trun.start + trun.hdr + 4);
          if (tf & 0x100) {
            let q = trun.start + trun.hdr + 8 + (tf & 1 ? 4 : 0) + (tf & 4 ? 4 : 0);
            const per = 4 * ((tf & 0x100 ? 1 : 0) + (tf & 0x200 ? 1 : 0) + (tf & 0x400 ? 1 : 0) + (tf & 0x800 ? 1 : 0));
            for (let i = 0; i < count; i++, q += per) dur += dv.getUint32(q);
          } else {
            dur += defDur * count;
          }
        }
        trafs.push({
          trackId,
          idPos: tfhd.start + tfhd.hdr + 4,
          tfdtPos: tpos,
          tfdtVer: tv,
          tfdt: tv === 1 ? Number(dv.getBigUint64(tpos)) : dv.getUint32(tpos),
          dur
        });
      }
      moofs.push({ seqPos: mfhd ? mfhd.start + mfhd.hdr + 4 : -1, trafs });
    }
    return moofs;
  }

  // ---------------------------------------------------------------- sinks
  function getMux() {
    const m = typeof muxjs !== "undefined" ? muxjs : root.muxjs;
    if (!m || !m.mp4 || !m.mp4.Transmuxer) throw new Error("MP4 muxer is not available");
    return m;
  }

  class TsSink {
    constructor() {
      this.groups = [];
      this.tx = null;
    }
    newGroup() {
      const g = { video: null, audio: null };
      this.groups.push(g);
      // remux:false => independent video/audio tracks that keep their original timestamps.
      const tx = new (getMux().mp4.Transmuxer)({ keepOriginalTimestamps: true, remux: false });
      tx.on("data", (s) => {
        if (s.type !== "video" && s.type !== "audio") return;
        const t = g[s.type] || (g[s.type] = { init: null, frags: [] });
        if (!t.init && s.initSegment && s.initSegment.byteLength) t.init = s.initSegment.slice();
        if (s.data && s.data.byteLength) t.frags.push(s.data);
      });
      this.tx = tx;
    }
    feed(seg, data) {
      if (!this.tx || seg.disc) this.newGroup();
      this.tx.push(data);
      this.tx.flush();
    }
    units() {
      const out = [];
      for (const kind of ["video", "audio"]) {
        const first = this.groups.find((g) => g[kind]);
        if (!first || !first[kind].init) continue;
        out.push({
          origin: "ts",
          init: first[kind].init,
          groups: this.groups.map((g) => (g[kind] ? g[kind].frags : []))
        });
      }
      return out;
    }
  }

  class Mp4Sink {
    constructor() {
      this.init = null;
      this.groups = [];
    }
    feed(seg, data, mapBytes) {
      const boxes = readBoxes(data, 0, data.length);
      if (!this.init) {
        if (mapBytes) {
          this.init = mapBytes;
        } else {
          const ftyp = boxes.find((b) => b.type === "ftyp");
          const moov = boxes.find((b) => b.type === "moov");
          if (moov) this.init = data.slice(ftyp ? ftyp.start : moov.start, moov.end);
        }
      }
      if (!this.groups.length || seg.disc) this.groups.push([]);
      const frags = this.groups[this.groups.length - 1];
      let moofAt = -1;
      for (const b of boxes) {
        if (b.type === "moof") moofAt = b.start;
        else if (b.type === "mdat" && moofAt >= 0) {
          frags.push(data.subarray(moofAt, b.end));
          moofAt = -1;
        }
      }
    }
    units() {
      return this.init ? [{ origin: "fmp4", init: this.init, groups: this.groups }] : [];
    }
  }

  const looksTs = (d) => d[0] === 0x47 && (d.length < 189 || d[188] === 0x47);
  const looksAac = (d) => (d[0] === 0x49 && d[1] === 0x44 && d[2] === 0x33) || (d[0] === 0xff && (d[1] & 0xf0) === 0xf0);
  const looksMp4 = (d) => /^(ftyp|styp|moof|sidx|moov)$/.test(td(d, 4));

  // Some hosts serve segments disguised as images (a PNG/JPEG/GIF header in front of the real
  // MPEG-TS or fMP4 data). Find where the real stream starts and drop the wrapper.
  function unwrapSegment(d) {
    if (!d || d.length < 8 || looksTs(d) || looksAac(d) || looksMp4(d)) return d;
    const lim = Math.min(d.length - 8, 65536);
    for (let i = 1; i < lim; i++) {
      if (d[i] === 0x47 && i + 376 < d.length && d[i + 188] === 0x47 && d[i + 376] === 0x47) return d.subarray(i);
      if (i >= 4 && /^(ftyp|styp|moof)$/.test(td(d, i))) {
        const start = i - 4;
        const size = ((d[start] << 24) | (d[start + 1] << 16) | (d[start + 2] << 8) | d[start + 3]) >>> 0;
        if (size >= 8 && start + size <= d.length) return d.subarray(start);
      }
    }
    return d;
  }

  // ---------------------------------------------------------------- assembly
  // Merge all tracks of all units into ONE fragmented mp4 on a single shared timeline.
  function assemble(units) {
    const tracks = [];
    for (const unit of units) {
      unit.info = parseInit(unit.init);
      unit.info.traks.forEach((trak) => tracks.push({ unit, trak, oldId: trak.id }));
    }
    if (!tracks.length) throw new Error("No tracks to mux");
    tracks.sort((a, b) => (b.trak.handler === "vide") - (a.trak.handler === "vide"));
    tracks.forEach((t, i) => {
      t.idx = i;
      t.newId = i + 1;
      t.stats = []; // per group {start,end} in track ticks
    });
    const trackOf = (unit, id) => tracks.find((t) => t.unit === unit && t.oldId === id);

    // Analyse fragments + collect per-group time ranges.
    const frags = [];
    for (const unit of units) {
      unit.groups.forEach((list, k) => {
        const prevTs = new Map();
        for (const buf of list) {
          const moofs = analyzeFrag(buf);
          for (const m of moofs) {
            for (const tf of m.trafs) {
              const tr = trackOf(unit, tf.trackId);
              if (!tr) continue;
              let dur = tf.dur;
              if (!dur && prevTs.has(tr)) dur = tf.tfdt - prevTs.get(tr);
              prevTs.set(tr, tf.tfdt);
              const s = tr.stats[k] || (tr.stats[k] = { start: tf.tfdt, end: tf.tfdt });
              s.end = Math.max(s.end, tf.tfdt + dur);
            }
          }
          frags.push({ unit, k, buf, moofs });
        }
      });
    }

    const offsetsFor = (stats, scale) => {
      const offs = [0];
      for (let k = 1; k < stats.length; k++) {
        const a = stats[k - 1];
        const b = stats[k];
        offs[k] = a && b ? offs[k - 1] + a.end / scale - b.start / scale : offs[k - 1];
      }
      return offs;
    };
    const anchor = tracks[0];
    const anchorOffs = offsetsFor(anchor.stats, anchor.trak.timescale);
    for (const t of tracks) {
      t.offs =
        t === anchor || t.unit.groups.length === anchor.unit.groups.length
          ? anchorOffs
          : offsetsFor(t.stats, t.trak.timescale);
    }

    // TS-derived timelines start at their original PTS (e.g. 10s); shift everything by the same T0
    // so the file starts near 0 but all relative audio/video offsets stay byte-exact.
    let T0 = 0;
    if (units.every((u) => u.origin === "ts")) {
      T0 = Infinity;
      for (const t of tracks) {
        const k = t.stats.findIndex(Boolean);
        if (k >= 0) T0 = Math.min(T0, t.stats[k].start / t.trak.timescale + t.offs[k]);
      }
      if (!Number.isFinite(T0)) T0 = 0;
    }

    // Patch track ids + decode times, collect fragments with their start time.
    const timed = [];
    for (const f of frags) {
      const dv = dvOf(f.buf);
      let t0 = Infinity;
      for (const m of f.moofs) {
        for (const tf of m.trafs) {
          const tr = trackOf(f.unit, tf.trackId);
          if (!tr) continue;
          const shift = Math.round((tr.offs[f.k] - T0) * tr.trak.timescale);
          const nv = tf.tfdt + shift;
          if (nv < 0) throw new Error("Negative timestamp while muxing");
          if (tf.tfdtVer === 1) dv.setBigUint64(tf.tfdtPos, BigInt(nv));
          else if (nv > 0xffffffff) throw new Error("Timestamp overflow while muxing");
          else dv.setUint32(tf.tfdtPos, nv);
          dv.setUint32(tf.idPos, tr.newId);
          t0 = Math.min(t0, nv / tr.trak.timescale);
        }
      }
      timed.push({ buf: f.buf, moofs: f.moofs, t: t0 });
    }
    timed.sort((a, b) => a.t - b.t);
    let seq = 1;
    for (const f of timed) {
      const dv = dvOf(f.buf);
      for (const m of f.moofs) if (m.seqPos >= 0) dv.setUint32(m.seqPos, seq++);
    }

    // Build the init segment: ftyp + moov(mvhd, all traks, mvex(mehd, trexs)).
    const base = tracks[0].unit.info;
    const mvTs = base.movieTimescale;
    let durSec = 0;
    for (const t of tracks) {
      const k = t.stats.length - 1;
      if (k >= 0 && t.stats[k]) durSec = Math.max(durSec, t.stats[k].end / t.trak.timescale + t.offs[k] - T0);
    }
    const movieDur = Math.min(0xffffffff, Math.round(durSec * mvTs));

    const mvhdBytes = tracks[0].unit.init.slice(base.mvhd.start, base.mvhd.end);
    const mvdv = dvOf(mvhdBytes);
    const mvVer = mvhdBytes[base.mvhd.hdr];
    if (mvVer === 1) mvdv.setBigUint64(base.mvhd.hdr + 4 + 20, BigInt(movieDur));
    else mvdv.setUint32(base.mvhd.hdr + 4 + 12, movieDur);
    mvdv.setUint32(mvhdBytes.length - 4, tracks.length + 1);

    const trakBytes = [];
    const trexBytes = [];
    for (const t of tracks) {
      const src = t.unit.init;
      const copy = src.slice(t.trak.box.start, t.trak.box.end);
      const tkhd = kids(copy, { start: 0, end: copy.length, hdr: t.trak.box.hdr }).find((b) => b.type === "tkhd");
      const tv = copy[tkhd.start + tkhd.hdr];
      dvOf(copy).setUint32(tkhd.start + tkhd.hdr + 4 + (tv === 1 ? 16 : 8), t.newId);
      if (t.unit.info.movieTimescale !== mvTs) {
        // elst durations are in the movie timescale, which differs per source init: rescale.
        const top = { start: 0, end: copy.length, hdr: t.trak.box.hdr };
        const edts = kids(copy, top).find((b) => b.type === "edts");
        const elst = edts && kids(copy, edts).find((b) => b.type === "elst");
        if (elst) {
          const cdv = dvOf(copy);
          const ver = copy[elst.start + elst.hdr];
          const n = cdv.getUint32(elst.start + elst.hdr + 4);
          let p = elst.start + elst.hdr + 8;
          const ratio = mvTs / t.unit.info.movieTimescale;
          for (let i = 0; i < n; i++, p += ver === 1 ? 20 : 12) {
            if (ver === 1) cdv.setBigUint64(p, BigInt(Math.round(Number(cdv.getBigUint64(p)) * ratio)));
            else cdv.setUint32(p, Math.round(cdv.getUint32(p) * ratio));
          }
        }
      }
      trakBytes.push(copy);

      const srcTrex = t.unit.info.trexs.find((b) => src[b.start + b.hdr + 4 + 3] === (t.oldId & 0xff) && dvOf(src).getUint32(b.start + b.hdr + 4) === t.oldId);
      if (srcTrex) {
        const tc = src.slice(srcTrex.start, srcTrex.end);
        dvOf(tc).setUint32(srcTrex.hdr + 4, t.newId);
        trexBytes.push(tc);
      } else {
        trexBytes.push(mkBox("trex", u32(0, t.newId, 1, 0, 0, 0)));
      }
    }
    const mehd = mkBox("mehd", u32(0, movieDur));
    const moov = mkBox("moov", mvhdBytes, ...trakBytes, mkBox("mvex", mehd, ...trexBytes));
    const ftyp = base.ftyp || mkBox("ftyp", ascii("isom"), u32(512), ascii("isom"), ascii("iso6"), ascii("mp41"));

    const parts = [ftyp, moov];
    for (const f of timed) parts.push(f.buf);
    return { blob: new Blob(parts, { type: "video/mp4" }), duration: durSec, tracks: tracks.length };
  }

  // ---------------------------------------------------------------- download
  async function download(url, onProgress, opts) {
    const report = (c, t, stage, bytes) => onProgress && onProgress(c, t, stage, bytes);
    const net = newNet();
    net.signal = (opts && opts.signal) || null;
    root.VDL_LAST_NET = net;

    const first = parsePlaylist(await fetchRetry(url, { text: true }), url);
    let videoPl = first;
    let audioPl = null;
    if (first.master) {
      const best = pickBest(first);
      const getPl = async (u) => parsePlaylist(await fetchRetry(u, { text: true }), u);
      [videoPl, audioPl] = await Promise.all([getPl(best.variant.url), best.audioUrl ? getPl(best.audioUrl) : null]);
    }
    if (videoPl.master || (audioPl && audioPl.master)) throw new Error("Nested master playlists are not supported");
    if (!videoPl.segments.length) throw new Error("No video segments found in playlist");

    const streams = [{ role: "video", pl: videoPl }];
    if (audioPl && audioPl.segments.length) streams.push({ role: "audio", pl: audioPl });
    for (const st of streams) {
      st.segs = st.pl.segments;
      st.buf = [];
      st.next = 0;
      st.sink = null;
      st.raw = [];
    }
    const sepAudio = streams.length > 1;

    // Task order: interleave streams by playlist time so both advance together.
    const tasks = [];
    for (const st of streams) {
      let t = 0;
      st.segs.forEach((seg, i) => {
        tasks.push({ st, i, t });
        t += seg.duration || 4;
      });
    }
    tasks.sort((a, b) => a.t - b.t || (a.st.role === "video" ? -1 : 1));
    const total = tasks.length;

    let completed = 0;
    let skipped = 0;
    let lastReport = 0;
    const mapCache = new Map();
    const getMap = (map) => {
      const k = `${map.url}#${map.range ? map.range.offset + "-" + map.range.length : ""}`;
      if (!mapCache.has(k)) mapCache.set(k, fetchRetry(map.url, { range: map.range, net }));
      return mapCache.get(k);
    };

    async function fetchTask(t) {
      const seg = t.st.segs[t.i];
      try {
        let data = await fetchRetry(seg.url, { range: seg.range, net });
        if (seg.key) data = await decrypt(seg.key, data, seg.seq);
        const mapBytes = seg.map ? await getMap(seg.map) : null;
        return { data, mapBytes };
      } catch (e) {
        // A missing trailing segment (stream end / 404) must not abort a whole movie.
        if ((e.status === 404 || e.status === 410) && t.i >= t.st.segs.length - 2) {
          skipped++;
          return null;
        }
        throw new Error(`Segment ${t.i + 1}/${t.st.segs.length} failed: ${e.message}`);
      }
    }

    function consume(st, i, item) {
      if (!item) return;
      const seg = st.segs[i];
      const data = unwrapSegment(item.data);
      const mapBytes = item.mapBytes ? unwrapSegment(item.mapBytes) : null;
      if (!st.sink) {
        if (!seg.map && (looksTs(data) || looksAac(data))) st.sink = new TsSink();
        else if (seg.map || looksMp4(data)) st.sink = new Mp4Sink();
        else throw new Error("Unsupported segment format (not MPEG-TS or fMP4)");
      }
      if (st.sink instanceof TsSink) {
        if (st.role === "video" && !sepAudio) st.raw.push(new Blob([data]));
        st.sink.feed(seg, data);
      } else {
        st.sink.feed(seg, data, mapBytes);
      }
    }

    function drain(st) {
      while (st.buf[st.next] !== undefined) {
        const item = st.buf[st.next];
        st.buf[st.next] = undefined;
        consume(st, st.next, item);
        st.next++;
      }
    }

    await runPool(tasks, net, {
      run: fetchTask,
      gate: (t) => t.i - t.st.next < LOOKAHEAD,
      accept: (t, res) => {
        t.st.buf[t.i] = res;
        completed++;
        drain(t.st);
        const now = Date.now();
        if (now - lastReport > 250) {
          lastReport = now;
          report(completed, total, "download", net.bytes);
        }
      },
      startLimit: (opts && opts.concurrency) || CONCURRENCY,
      maxLimit: (opts && opts.maxConcurrency) || 96
    });

    report(total, total, "transmux", net.bytes);
    const vs = streams[0];
    const warnings = [];
    const hasHandler = (x, h) => parseInit(x.init).traks.some((t) => t.handler === h);
    try {
      if (!vs.sink) throw new Error("Stream produced no data");
      let units = vs.sink.units();
      if (sepAudio) {
        // Use the dedicated audio rendition only; drop audio muxed inside the video stream.
        const as = streams[1].sink;
        if (!as) throw new Error("Audio rendition produced no data");
        units = units.filter((x) => !hasHandler(x, "soun")).concat(as.units().filter((x) => hasHandler(x, "soun")));
        if (!units.some((x) => hasHandler(x, "soun"))) throw new Error("Audio rendition could not be read");
      }
      if (!units.some((x) => hasHandler(x, "vide"))) throw new Error("No video track could be muxed");
      const out = assemble(units);
      return { blob: out.blob, ext: "mp4", duration: out.duration, skipped, bytes: net.bytes, warnings };
    } catch (err) {
      // Codec the muxer can't handle (e.g. HEVC in TS): keep the raw stream so nothing is lost.
      if (!sepAudio && vs.raw.length) {
        return { blob: new Blob(vs.raw, { type: "video/mp2t" }), ext: "ts", skipped, bytes: net.bytes, warnings: [err.message] };
      }
      throw err;
    }
  }

  // Fast path for plain video files: split into byte ranges and fetch them in parallel.
  async function downloadFile(url, onProgress, opts) {
    const net = newNet();
    net.signal = (opts && opts.signal) || null;
    const probe = await fetchOnceHead(url);
    if (!probe.total) throw new Error("Server does not support ranged downloads");
    const CHUNK = Math.max(1024 * 1024, Math.ceil(probe.total / 192));
    const tasks = [];
    for (let off = 0, i = 0; off < probe.total; off += CHUNK, i++) {
      tasks.push({ i, range: { offset: off, length: Math.min(CHUNK, probe.total - off) } });
    }
    const parts = new Array(tasks.length);
    let completed = 0;
    let lastReport = 0;
    await runPool(tasks, net, {
      run: async (t) => {
        const data = await fetchRetry(url, { range: t.range, net });
        if (data.byteLength !== t.range.length) throw new Error("Short range response");
        return data;
      },
      accept: (t, data) => {
        parts[t.i] = new Blob([data]); // let the browser spill finished parts to disk
        completed++;
        const now = Date.now();
        if (now - lastReport > 250) {
          lastReport = now;
          onProgress && onProgress(completed, tasks.length, "download", net.bytes);
        }
      },
      startLimit: (opts && opts.concurrency) || 24,
      maxLimit: (opts && opts.maxConcurrency) || 96
    });
    onProgress && onProgress(tasks.length, tasks.length, "download", net.bytes);
    return { blob: new Blob(parts, { type: probe.type || "video/mp4" }), bytes: probe.total };
  }

  async function fetchOnceHead(url) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), STALL_MS);
    try {
      const r = await fetch(url, { headers: { Range: "bytes=0-0" }, signal: ac.signal });
      const m = /\/(\d+)\s*$/.exec(r.headers.get("content-range") || "");
      try {
        r.body && r.body.cancel();
      } catch (_) {}
      if (r.status !== 206 || !m) return { total: 0 };
      return { total: parseInt(m[1], 10), type: (r.headers.get("content-type") || "").split(";")[0] };
    } finally {
      clearTimeout(timer);
    }
  }

  // Is this URL really a playable video? (Range probe: status, content-type, size.)
  async function probeFile(url) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), STALL_MS);
    try {
      const r = await fetch(url, { headers: { Range: "bytes=0-0" }, signal: ac.signal });
      try {
        r.body && r.body.cancel();
      } catch (_) {}
      const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const m = /\/(\d+)\s*$/.exec(r.headers.get("content-range") || "");
      const size = m ? parseInt(m[1], 10) : parseInt(r.headers.get("content-length") || "0", 10) || 0;
      const ok = (r.status === 200 || r.status === 206) && /^video\/|octet-stream|^binary\//.test(type) && (size === 0 || size > 30000);
      return { ok, size, type };
    } finally {
      clearTimeout(timer);
    }
  }

  // Download-level watchdog. Single segments recover on their own (rate-based stall detection,
  // resume, hedging); this catches a whole download that stopped moving and aborts it so the
  // caller can switch to another stream or find the episode again.
  function watchdog(onProgress, idleMs) {
    const ac = new AbortController();
    let lastBytes = -1;
    let lastAt = Date.now();
    let stage = "download";
    const timer = setInterval(() => {
      if (stage === "download" && Date.now() - lastAt > idleMs) {
        ac.abort(new Error(`stalled: no data for ${Math.round(idleMs / 1000)} s`));
      }
    }, 2000);
    return {
      signal: ac.signal,
      abort: (reason) => ac.abort(reason || new Error("Cancelled")),
      stop: () => clearInterval(timer),
      onProgress: (c, t, st, bytes) => {
        stage = st || stage;
        if (bytes !== lastBytes) {
          lastBytes = bytes;
          lastAt = Date.now();
        }
        if (onProgress) onProgress(c, t, st, bytes);
      }
    };
  }

  const api = { download, downloadFile, probeFile, watchdog, analyze, parsePlaylist, pickBest, assemble, parseInit, analyzeFrag };
  root.VDL_HLS = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
