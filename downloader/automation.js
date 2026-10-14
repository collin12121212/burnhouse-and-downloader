// Automation page: opens a range of episode pages, scans each for its video the moment it is
// available, and (optionally) downloads each one as soon as it is found.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, "0");

  const state = {
    items: [],
    running: false,
    stop: false,
    paused: false,
    slotWins: [], // window id per lane
    laneTabs: [], // the one tab per lane window
    laneBusy: [],
    dlQueue: [],
    dlRunning: 0,
    streamWaiters: new Map(), // tabId -> fn(msg)
    jobWaiters: new Map(), // video url -> fn(msg)
    servers: [], // [{ value, label }] providers the site offers
    serverParam: "server",
    serverMode: "hash",
    serversOrigin: null,
    stats: {}, // per-server race results
    titles: {}, // show id -> title
    collapsed: new Set() // collapsed show / season groups
  };

  const FORM_IDS = ["example", "show", "seasons", "episodes", "parallel", "race", "downloads", "timeout", "activateAfter"];
  const CHECK_IDS = ["autoDownload", "activate", "keepTabs"];

  // ------------------------------------------------------------------ persistence
  let saveTimer = null;
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const form = {};
      FORM_IDS.forEach((id) => (form[id] = $(id).value));
      form.v = 2;
      CHECK_IDS.forEach((id) => (form[id] = $(id).checked));
      const items = state.items.map((i) => ({
        id: i.id, show: i.show, season: i.season, episode: i.episode, url: i.url, status: i.status,
        error: i.error, found: i.found, filename: i.filename, t: i.t
      }));
      chrome.storage.local.set({ autoState: { form, items, titles: state.titles, collapsed: Array.from(state.collapsed) } }).catch(() => {});
    }, 400);
  }

  async function restore() {
    try {
      const { autoState } = await chrome.storage.local.get("autoState");
      if (!autoState) return;
      const old = !autoState.form || autoState.form.v !== 2;
      for (const id of FORM_IDS) {
        if (old && ["parallel", "race", "downloads", "episodes"].includes(id)) continue; // new defaults win once
        if (autoState.form && autoState.form[id] != null) $(id).value = autoState.form[id];
      }
      for (const id of CHECK_IDS) if (autoState.form && autoState.form[id] != null) $(id).checked = autoState.form[id];
      state.titles = autoState.titles || {};
      state.collapsed = new Set(autoState.collapsed || []);
      state.items = (autoState.items || []).map((i) => {
        // Anything that was in flight when the page closed starts over.
        if (["opening", "scanning", "verify"].includes(i.status)) i.status = "queued";
        else if (i.status === "downloading") {
          i.status = "found";
          i.resume = true; // was cut off (page closed / extension reloaded): pick it up again
        }
        return i;
      });
    } catch (_) {}
  }

  // ------------------------------------------------------------------ input parsing
  function parseExample(str) {
    try {
      const u = new URL(String(str).trim());
      for (const k of Array.from(u.searchParams.keys())) if (/^(server|provider|source)$/i.test(k)) u.searchParams.delete(k);
      const m = /^(.*\/)(\d+)\/(\d+)\/(\d+)(\/?)$/.exec(u.pathname);
      if (!m) return null;
      return {
        tpl: u.origin + m[1] + "{show}/{season}/{episode}" + m[5] + u.search,
        show: m[2], season: m[3], episode: m[4], origin: u.origin
      };
    } catch (_) {
      return null;
    }
  }

  function parseList(str) {
    const out = new Set();
    for (const part of String(str).split(/[,\s]+/).filter(Boolean)) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(part);
      if (!m) return null;
      const a = parseInt(m[1], 10);
      const b = m[2] ? parseInt(m[2], 10) : a;
      if (b < a || b - a > 500) return null;
      for (let n = a; n <= b; n++) out.add(n);
    }
    return out.size ? Array.from(out).sort((x, y) => x - y) : null;
  }

  const urlFor = (ex, show, season, episode) =>
    ex.tpl.replace("{show}", show).replace("{season}", season).replace("{episode}", episode);

  function say(text, kind) {
    const b = $("banner");
    if (!text) {
      b.className = "";
      return;
    }
    $("bannerText").textContent = text;
    $("resume").style.display = kind === "verify" ? "" : "none";
    b.className = "show";
  }

  // ------------------------------------------------------------------ windows / tabs
  async function slotWindow(k) {
    const id = state.slotWins[k];
    if (id != null) {
      try {
        await chrome.windows.get(id);
        return id;
      } catch (_) {}
    }
    const w = await chrome.windows.create({
      url: "about:blank", focused: false, width: 520, height: 400, left: 20 + (k % 8) * 36, top: 20 + (k % 8) * 30
    });
    state.slotWins[k] = w.id;
    return w.id;
  }

  // Each lane is one small window holding one tab that is navigated from episode to episode
  // (no extra about:blank tabs, no window flashing for every episode).
  async function laneTab(k, url) {
    const id = state.laneTabs[k];
    if (id != null && !state.laneBusy[k]) {
      try {
        const t = await chrome.tabs.update(id, { url, muted: true });
        if (t) {
          state.laneBusy[k] = true;
          return t;
        }
      } catch (_) {}
    }
    if (id != null && state.laneBusy[k]) {
      // lane tab still held (kept for an in-tab download): give the lane a fresh window
      state.laneTabs[k] = null;
      state.slotWins[k] = null;
    }
    const w = await chrome.windows.create({
      url, focused: false, width: 520, height: 400, left: 20 + (k % 8) * 36, top: 20 + (k % 8) * 30
    });
    const tab = w.tabs[0];
    state.slotWins[k] = w.id;
    state.laneTabs[k] = tab.id;
    state.laneBusy[k] = true;
    chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
    return tab;
  }

  // Done with a lane's tab: stop the page (blank it) so it can be reused for the next episode.
  function releaseLane(k, tabId) {
    if (state.laneTabs[k] !== tabId) return closeTab(tabId);
    state.laneBusy[k] = false;
    if (!$("keepTabs").checked) chrome.tabs.update(tabId, { url: "about:blank" }).catch(() => {});
  }

  async function closeSlotWindows() {
    for (const id of state.slotWins) if (id != null) await chrome.windows.remove(id).catch(() => {});
    state.slotWins = [];
    state.laneTabs = [];
    state.laneBusy = [];
  }

  const closeTab = (id) => (id != null ? chrome.tabs.remove(id).catch(() => {}) : null);

  // ------------------------------------------------------------------ scanning
  function waitForStream(tabId, timeoutMs, activate, activateAfterMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        state.streamWaiters.delete(tabId);
        chrome.runtime.sendMessage({ type: "UNWATCH_TAB", tabId }).catch(() => {});
        resolve(r);
      };
      const timer = setTimeout(() => finish({ timeout: true }), timeoutMs);
      state.streamWaiters.set(tabId, (msg) => {
        if (msg.type === "MEDIA_FOUND") finish({ found: msg.item });
        else if (msg.type === "PAGE_GATE") finish({ gate: true });
        else if (msg.type === "PAGE_GATE_STOP") finish({ stopped: true });
        else if (msg.type === "PAGE_DEAD") finish({ dead: msg.error || "unreachable" });
      });
      chrome.runtime
        .sendMessage({ type: "WATCH_TAB", tabId, activate, activateAfterMs })
        .then((r) => {
          if (r && r.existing) finish({ found: r.existing });
        }, () => {});
    });
  }

  async function bestMedia(tabId, fallback) {
    await sleep(450); // let a master playlist and its children register, then pick the best one
    try {
      const r = await chrome.runtime.sendMessage({ type: "GET_ALL_MEDIA", tabId });
      const vids = ((r && r.videos) || []).filter((v) => !v.blob);
      vids.sort((x, y) => (y.width || 0) * (y.height || 0) - (x.width || 0) * (x.height || 0) || (y.type === "hls") - (x.type === "hls"));
      const pick = vids[0];
      if (pick) return pick;
    } catch (_) {}
    return fallback;
  }

  function slim(v) {
    return { url: v.url, name: v.name, type: v.type, width: v.width, height: v.height, duration: v.duration, frameId: v.frameId };
  }

  // ------------------------------------------------------------------ servers (providers)
  // Sites like this one offer every episode from several providers (?server=...). An episode is
  // raced across several of them at once; once the first stream appears the others get a short
  // grace period, then the winner is picked: highest quality first, then fastest download.
  // Results are remembered, so consistently good servers are tried first and dead ones dropped.
  const GRACE_MS = 2000;
  const MAXK = 4;

  async function loadServers(origin) {
    try {
      const { serverStats, serverLists } = await chrome.storage.local.get(["serverStats", "serverLists"]);
      state.stats = serverStats || {};
      const cached = serverLists && serverLists[origin];
      if (cached && cached.servers && cached.servers.length > 1 && cached.mode) {
        state.servers = cached.servers;
        state.serverParam = cached.param || "server";
        state.serverMode = cached.mode || "hash";
      }
    } catch (_) {}
  }

  function saveServers(origin) {
    chrome.storage.local.get("serverLists").then(({ serverLists }) => {
      const lists = serverLists || {};
      lists[origin] = { servers: state.servers, param: state.serverParam, mode: state.serverMode };
      chrome.storage.local.set({ serverLists: lists, serverStats: state.stats }).catch(() => {});
    }, () => {});
  }

  const stat = (id) =>
    state.stats[id] || (state.stats[id] = { tries: 0, found: 0, wins: 0, findMs: 0, height: 0, mbps: 0, recent: [] });

  async function discoverServers(url) {
    const tab = await laneTab(0, url);
    try {
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        const r = await chrome.tabs.sendMessage(tab.id, { type: "GET_SERVERS" }, { frameId: 0 }).catch(() => null);
        if (r && r.servers && r.servers.length > 1) {
          state.servers = r.servers;
          state.serverParam = r.param || "server";
          state.serverMode = r.mode || "hash";
          return true;
        }
      }
    } finally {
      releaseLane(0, tab.id);
    }
    return false;
  }

  function serverUrl(url, id) {
    if (!id) return url;
    try {
      const u = new URL(url);
      if (state.serverMode === "param") u.searchParams.set(state.serverParam || "server", id);
      else u.hash = id;
      return u.href;
    } catch (_) {
      return url;
    }
  }

  function rankServers() {
    const scored = state.servers.map((s, idx) => {
      const st = stat(s.value);
      let score;
      if (!st.tries) {
        // untried: the site's own recommendation and default first, then page order
        score = 0.55 + (s.recommended ? 0.2 : 0) + (s.active ? 0.1 : 0) - idx * 0.001;
      } else {
        const foundRate = st.found / st.tries;
        const q = Math.min(1, (st.height || 480) / 1080);
        const sp = Math.max(0.25, Math.min(1, (st.mbps || 1) / 4));
        score = foundRate * (0.6 * q + 0.4 * sp) + 0.15 * (st.wins / st.tries);
        if (st.tries >= 3 && !st.found) score = -1; // never produced a stream: last resort only
        if ((st.decoys || 0) >= 2 || (st.dlFails || 0) >= 2) score = -1; // demo clips / undownloadable
        if ((st.dead || 0) >= 1 && !st.found) score = -2; // domain does not resolve / server gone
      }
      return { id: s.value, score };
    });
    scored.sort((x, y) => y.score - x.score);
    return scored.map((x) => x.id);
  }

  function raceSet() {
    const K = Math.max(1, Math.min(MAXK, +$("race").value || 1));
    if (K === 1 || !state.servers.length) return [null];
    const ranked = rankServers();
    // A clear champion (won 3 of its last 4 races) needs only one backup.
    const champ = ranked.find((id) => stat(id).recent.slice(-4).filter((x) => x === "win").length >= 3);
    const k = champ ? Math.min(K, 2) : K;
    const out = ranked.slice(0, k);
    // Keep one slot exploring a server we know little about, so better ones keep being discovered,
    // but never at the cost of the best server we already know.
    if (k >= 3) {
      const explore = ranked.find((id) => stat(id).tries < 2 && !out.includes(id));
      if (explore) out[out.length - 1] = explore;
    }
    return out;
  }

  const withTimeout = (p, ms, fallback) => Promise.race([p, sleep(ms).then(() => fallback)]);

  function heightFromBitrate(bps) {
    if (bps >= 12e6) return 2160;
    if (bps >= 4.5e6) return 1080;
    if (bps >= 2.2e6) return 720;
    if (bps >= 1.1e6) return 480;
    return bps > 0 ? 360 : 0;
  }

  // Quality + speed of a found stream: best variant resolution/bitrate, and a timed fetch of one
  // real segment (per-connection speed of that host), straight from this page.
  // Two phases, filling `out` as it goes so a caller that stops waiting still gets whatever was
  // learned: (1) playlist -> length, resolution, bitrate (fast, decides "is this the real
  // episode"); (2) one timed segment -> per-connection speed (optional, capped at 3 s).
  async function probeStream(media, out) {
    out = out || {};
    Object.assign(out, { direct: true, denied: false, unknown: true, height: media.height || 0, width: media.width || 0, bandwidth: 0, mbps: 0, duration: media.duration || 0, size: 0 });
    const timed = async (url, headers) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3000);
      const t0 = performance.now();
      try {
        const r = await fetch(url, { headers, signal: ac.signal });
        if (r.status === 401 || r.status === 403) {
          out.direct = false;
          out.denied = true;
          return 0;
        }
        if (!r.ok) return 0;
        const b = await r.arrayBuffer();
        return b.byteLength / 1048576 / ((performance.now() - t0) / 1000);
      } catch (_) {
        return 0; // too slow to finish in 3 s: speed unknown, not a failure
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      if (!(media.type === "hls" || /\.m3u8/i.test(media.url))) {
        const p = await VDL_HLS.probeFile(media.url);
        if (!p.ok) {
          out.direct = false;
          return out;
        }
        out.size = p.size || 0;
        out.unknown = false;
        if (media.duration && p.size) out.bandwidth = (p.size * 8) / media.duration;
        out.mbps = await timed(media.url, { Range: "bytes=0-2097151" });
        return out;
      }
      const first = await fetch(media.url);
      if (first.status === 401 || first.status === 403) {
        out.direct = false;
        out.denied = true;
        return out;
      }
      let pl = VDL_HLS.parsePlaylist(await first.text(), media.url);
      if (pl.master) {
        const best = VDL_HLS.pickBest(pl);
        out.height = best.variant.height || out.height;
        out.width = best.variant.width || out.width;
        out.bandwidth = best.variant.bandwidth || 0;
        pl = VDL_HLS.parsePlaylist(await (await fetch(best.variant.url)).text(), best.variant.url);
      }
      const segs = pl.segments || [];
      if (!segs.length) return out;
      out.duration = segs.reduce((t, x) => t + (x.duration || 0), 0) || out.duration;
      out.unknown = false;
      const seg = segs[Math.min(segs.length - 1, Math.floor(segs.length / 3))];
      const headers = seg.range ? { Range: `bytes=${seg.range.offset}-${seg.range.offset + seg.range.length - 1}` } : undefined;
      out.mbps = await timed(seg.url, headers);
    } catch (_) {}
    return out;
  }

  const tierOf = (p) => (p && (p.height || heightFromBitrate(p.bandwidth))) || 0;

  function expectedDuration() {
    const d = (state.durations || []).slice().sort((x, y) => x - y);
    return d.length ? d[d.length >> 1] : 0;
  }

  function plausible(p) {
    if (!p || p.unknown) return false;
    const exp = expectedDuration();
    const minDur = exp ? exp * 0.6 : 180;
    if (p.duration) return p.duration >= minDur;
    if (p.size) return p.size >= 40 * 1048576;
    return false;
  }

  // A result is "good enough to stop waiting" when it is a real episode, at least 720p and
  // downloadable from here.
  const goodEnough = (m) => plausible(m.probe) && m.probe.direct && tierOf(m.probe) >= 720;

  function better(a, b) {
    const ta = tierOf(a.probe);
    const tb = tierOf(b.probe);
    if (ta !== tb) return tb - ta; // higher resolution wins
    if (a.probe.direct !== b.probe.direct) return a.probe.direct ? -1 : 1; // downloadable from here
    if (Math.abs(a.probe.mbps - b.probe.mbps) > 0.15 * Math.max(a.probe.mbps, b.probe.mbps)) return b.probe.mbps - a.probe.mbps;
    return a.findMs - b.findMs;
  }

  function recordRace(members, winner) {
    const ema = (old, v) => (old ? old * 0.7 + v * 0.3 : v);
    for (const m of members) {
      if (!m.id) continue;
      const st = stat(m.id);
      if (!m.probe && !m.decoy && (!m.res || m.res.found)) {
        st.recent = st.recent.concat("slow").slice(-8);
        continue;
      }
      st.tries++;
      let outcome = "miss";
      if (m.probe) {
        st.found++;
        st.findMs = ema(st.findMs, m.findMs);
        if (tierOf(m.probe)) st.height = ema(st.height, tierOf(m.probe));
        if (m.probe.mbps) st.mbps = ema(st.mbps, m.probe.mbps);
        outcome = "found";
      }
      if (m.decoy) {
        st.decoys = (st.decoys || 0) + 1;
        outcome = "decoy";
      }
      if (m.res && m.res.dead) {
        st.dead = (st.dead || 0) + 1;
        outcome = "dead";
      }
      if (m === winner) {
        st.wins++;
        outcome = "win";
      }
      st.recent = st.recent.concat(outcome).slice(-8);
    }
    renderServers();
  }

  async function scanItem(it, slot) {
    it.status = "scanning";
    it.error = "";
    it.pct = 0;
    render();
    const ids = raceSet();
    it.raced = ids.filter(Boolean);
    const timeoutMs = Math.max(10, +$("timeout").value || 45) * 1000;
    const activate = $("activate").checked;
    const after = Math.max(0, +$("activateAfter").value || 0) * 1000;
    const members = ids.map((id, j) => ({ id, lane: slot * MAXK + j }));
    let winner = null;
    let gateMember = null;
    const weak = [];

    try {
      const results = [];
      await new Promise((resolveRace) => {
        let pending = members.length;
        let settled = false;
        let graceTimer = null;
        let firstFoundAt = 0;
        // Hard stop: whatever happens inside (a hung tab, a lost message), a race always ends.
        const hard = setTimeout(() => settle(), timeoutMs + 12000);
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(graceTimer);
          clearTimeout(hard);
          resolveRace();
        };
        for (const m of members) {
          m.task = (async () => {
            try {
              m.tab = $("keepTabs").checked
                ? await chrome.tabs.create({ windowId: await slotWindow(m.lane), url: serverUrl(it.url, m.id), active: true })
                : await laneTab(m.lane, serverUrl(it.url, m.id));
              if (settled) return;
              m.res = await waitForStream(m.tab.id, timeoutMs, activate, after);
              if (m.res.gate) gateMember = gateMember || m;
              if (!m.res.found || settled) return;
              m.findMs = Date.now() - it.startedAt;
              m.media = await bestMedia(m.tab.id, m.res.found);
              const probe = {};
              await withTimeout(probeStream(m.media, probe), 6000, null);
              m.probe = probe;
              if (settled) return;
              if (!plausible(m.probe)) {
                // Measured and too short = demo/teaser clip. Unmeasurable = last resort only.
                if (m.probe.unknown || (!m.probe.duration && !m.probe.size)) weak.push(m);
                else m.decoy = true;
                return;
              }
              results.push(m);
              const top = tierOf(m.probe) >= 1080 && m.probe.direct && m.probe.mbps >= 2;
              if (results.length === members.length || top) settle();
              else if (results.length === 1) {
                const graceUp = () => {
                  // Weak best result and others still searching: give them up to 8 s more.
                  const waited = Date.now() - firstFoundAt;
                  if (!results.some(goodEnough) && waited < GRACE_MS + 8000 && pending > 0) graceTimer = setTimeout(graceUp, 1000);
                  else settle();
                };
                firstFoundAt = Date.now();
                graceTimer = setTimeout(graceUp, members.length > 1 ? GRACE_MS : 0);
              }
            } catch (e) {
              m.err = e;
            } finally {
              if (--pending === 0) settle();
            }
          })();
        }
      });

      // Stop the servers that are still searching; their tabs close as soon as they let go.
      for (const m of members) {
        if (m.tab && state.streamWaiters.has(m.tab.id)) state.streamWaiters.get(m.tab.id)({ type: "PAGE_GATE_STOP" });
      }

      if (state.stop && !results.length) {
        it.status = "queued";
        return;
      }
      if (!results.length && weak.length) {
        if (!it.retriedWeak) {
          it.retriedWeak = true;
          recordRace(members, null);
          it.status = "queued";
          it.error = "";
          return;
        }
        results.push(...weak);
      }
      if (!results.length && gateMember) {
        it.status = "verify";
        state.paused = true;
        gateMember.keep = true;
        it.tabId = gateMember.tab.id;
        chrome.windows.update(gateMember.tab.windowId, { focused: true, drawAttention: true }).catch(() => {});
        say("This site is showing a human-verification page. Pass it once in the window that just opened (nothing is clicked for you), then press Resume.", "verify");
        return;
      }
      if (!results.length) {
        it.status = "notfound";
        it.error = ids.length > 1 ? `No video appeared on ${ids.length} servers within the time limit.` : "No video appeared within the time limit.";
        recordRace(members, null);
        return;
      }

      results.sort(better);
      winner = results[0];
      const sid = showOf(it);
      if (!state.titles[sid]) {
        chrome.tabs.get(winner.tab.id).then((t) => {
          const raw = (t && t.title) || "";
          const m = /^(?:watch\s+)?(.+?)\s*[-|:]\s*s\d+\s*e\d+/i.exec(raw);
          const title = (m ? m[1] : raw.split("|")[0]).replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").trim();
          if (title && !state.titles[sid]) {
            state.titles[sid] = title;
            render();
          }
        }, () => {});
      }
      recordRace(members, winner);
      if (winner.probe.duration) (state.durations = state.durations || []).push(winner.probe.duration);
      // Runner-ups are kept: if the winner fails to download, the next one is used automatically.
      it.alts = results.slice(1).filter((m) => m.probe.direct).map((m) => Object.assign(slim(m.media), { server: m.id || "", height: tierOf(m.probe), mbps: m.probe.mbps }));
      it.found = slim(winner.media);
      it.found.server = winner.id || "";
      it.found.height = tierOf(winner.probe) || it.found.height;
      it.found.mbps = winner.probe.mbps;
      it.foundMs = winner.findMs;
      it.t = { start: it.startedAt, found: Date.now(), raced: members.length, results: results.length };
      it.tabId = winner.tab.id;
      it.status = "found";
      render();

      if ($("autoDownload").checked) {
        if (winner.probe.direct) {
          state.dlQueue.push({ it, mode: "direct" });
        } else {
          // That host only serves requests coming from the page itself: download from the tab.
          winner.keep = true;
          if (state.laneTabs[winner.lane] === winner.tab.id) {
            state.laneTabs[winner.lane] = null;
            state.slotWins[winner.lane] = null;
          }
          state.dlQueue.push({ it, mode: "tab", tab: winner.tab });
        }
        pumpDownloads();
      }
    } catch (e) {
      it.status = "error";
      it.error = e && e.message ? e.message : String(e);
    } finally {
      for (const m of members) {
        if (m.keep || $("keepTabs").checked) continue;
        Promise.resolve(m.task).finally(() => m.tab && releaseLane(m.lane, m.tab.id));
      }
      render();
      save();
      saveServers(originOf(it.url));
    }
  }

  function showOf(it) {
    if (it.show) return String(it.show);
    const ex = parseExample(it.url);
    return (it.show = ex ? ex.show : "?");
  }

  function titleOf(sid) {
    if (state.titles[sid]) return state.titles[sid];
    const named = state.items.find((i) => showOf(i) === sid && i.found && i.found.name);
    if (named) return named.found.name.replace(/\s*[\u00b7-]?\s*S\d+\s*E\d+.*$/i, "").replace(/\.(mp4|m3u8)$/i, "").trim();
    return "Show " + sid;
  }

  const originOf = (url) => {
    try {
      return new URL(url).origin;
    } catch (_) {
      return "";
    }
  };

  function nextQueued() {
    const it = state.items.find((i) => i.status === "queued");
    if (it) {
      it.status = "opening";
      it.startedAt = Date.now();
    }
    return it;
  }

  async function worker(slot) {
    while (!state.stop && !state.paused) {
      const it = nextQueued();
      if (!it) return;
      await scanItem(it, slot);
    }
  }

  async function runQueue() {
    if (state.running) return;
    state.running = true;
    state.stop = false;
    say("");
    render();
    const n = Math.max(1, Math.min(4, +$("parallel").value || 2));
    try {
      const first = state.items.find((i) => i.status === "queued");
      if (first && +$("race").value > 1) {
        const origin = originOf(first.url);
        if (state.serversOrigin !== origin) {
          state.servers = [];
          await loadServers(origin);
          state.serversOrigin = origin;
        }
        if (!state.servers.length) {
          say("Reading the list of servers this site offers...");
          await discoverServers(first.url);
          say("");
          saveServers(origin);
        }
        renderServers();
      }
      await Promise.all(Array.from({ length: n }, (_, k) => worker(k)));
    } finally {
      state.running = false;
      if (!$("keepTabs").checked && !state.paused) closeSlotWindows();
      render();
    }
  }

  // ------------------------------------------------------------------ downloading
  async function probeDirect(media) {
    try {
      if (!/\.m3u8/i.test(media.url) && media.type !== "hls") {
        const p = await VDL_HLS.probeFile(media.url);
        return !!p.ok;
      }
      let text = await (await fetch(media.url)).text();
      let base = media.url;
      let pl = VDL_HLS.parsePlaylist(text, base);
      if (pl.master) {
        base = VDL_HLS.pickBest(pl).variant.url;
        pl = VDL_HLS.parsePlaylist(await (await fetch(base)).text(), base);
      }
      const seg = pl.segments[0];
      if (!seg) return false;
      const r = await fetch(seg.url, { headers: { Range: "bytes=0-1023" } });
      const ok = r.status === 200 || r.status === 206;
      try {
        r.body && r.body.cancel();
      } catch (_) {}
      return ok;
    } catch (_) {
      return false;
    }
  }

  function fileNameFor(it, ext) {
    let base = String((it.found && it.found.name) || "video").replace(/\.(m3u8|mpd|ts|mp4|webm)$/i, "");
    if (!/s0*\d+\s*e0*\d+/i.test(base)) base = `S${pad(it.season)}E${pad(it.episode)} ${base}`;
    return base.replace(/[\\/:*?"<>|]/g, "_").trim() + "." + (ext || "mp4");
  }

  async function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    try {
      const id = await chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
      // Wait for the browser to finish writing the file. Events can be missed (or the download
      // can finish before the listener is attached), so also poll its state.
      const t0 = Date.now();
      for (;;) {
        const [d] = await chrome.downloads.search({ id }).catch(() => []);
        if (!d) break;
        if (d.state === "complete") break;
        if (d.state === "interrupted") throw new Error("saving failed: " + (d.error || "interrupted"));
        if (d.totalBytes > 0 && d.bytesReceived >= d.totalBytes && Date.now() - t0 > 5000) break;
        if (Date.now() - t0 > 120000) break; // the file is in the browser's hands; stop waiting
        await sleep(700);
      }
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    }
  }

  async function downloadDirect(it) {
    const onP = (c, t, stage, bytes) => {
      it.pct = Math.min(100, Math.round((c / t) * 100));
      it.stage = stage;
      it.bytes = bytes;
      renderSoon();
    };
    const isHls = it.found.type === "hls" || /\.m3u8/i.test(it.found.url);
    let blob;
    let ext = "mp4";
    const wd = VDL_HLS.watchdog(onP, 45000);
    it._wd = wd;
    // Compare this download's speed with the others in this run; if it is crawling (typically
    // a host refusing most requests) give it up early so a faster stream can be used.
    const samples = [];
    const slowCheck = setInterval(() => {
      const now = Date.now();
      samples.push([now, it.bytes || 0]);
      while (samples.length && now - samples[0][0] > 30000) samples.shift();
      if (now - it.t.dl0 < 45000 || samples.length < 5 || (it.pct || 0) > 70 || it.stage === "transmux") return;
      const rate = (samples[samples.length - 1][1] - samples[0][1]) / 1048576 / ((now - samples[0][0]) / 1000);
      const peers = (state.rates || []).slice(-12).sort((x, y) => x - y);
      const median = peers.length ? peers[peers.length >> 1] : 0;
      const floor = Math.max(0.35, median * 0.25);
      if (rate < floor) wd.abort(new Error(`too slow (${rate.toFixed(2)} MB/s vs ${median.toFixed(1)} MB/s typical)`));
    }, 5000);
    try {
      if (isHls) {
        const r = await VDL_HLS.download(it.found.url, wd.onProgress, { signal: wd.signal });
        blob = r.blob;
        ext = r.ext || "mp4";
      } else {
        blob = (await VDL_HLS.downloadFile(it.found.url, wd.onProgress, { signal: wd.signal })).blob;
        ext = (/\.(webm|mkv|mov)(\?|$)/i.exec(it.found.url) || [0, "mp4"])[1].toLowerCase();
      }
    } finally {
      wd.stop();
      clearInterval(slowCheck);
      it._wd = null;
    }
    if (it.cancelled) throw new Error("Cancelled");
    it.filename = fileNameFor(it, ext);
    it.t.size = blob.size;
    it.t.saveStart = Date.now();
    (state.rates = state.rates || []).push(blob.size / 1048576 / Math.max(1, (it.t.saveStart - it.t.dl0) / 1000));
    await saveBlob(blob, it.filename);
  }

  function downloadInTab(it, tab) {
    it._tabJob = true;
    return new Promise((resolve, reject) => {
      const isHls = it.found.type === "hls" || /\.m3u8/i.test(it.found.url);
      let idle = setTimeout(() => fail(new Error("no progress for 45 s")), 45000);
      const fail = (e) => {
        clearTimeout(idle);
        state.jobWaiters.delete(it.found.url);
        reject(e);
      };
      state.jobWaiters.set(it.found.url, (msg) => {
        clearTimeout(idle);
        idle = setTimeout(() => fail(new Error("no progress for 45 s")), 45000);
        if (msg.type === "REPORT_DOWNLOAD_PROGRESS") {
          it.pct = msg.percent;
          it.stage = msg.stage;
          it.bytes = msg.bytes;
          renderSoon();
        } else if (msg.type === "REPORT_DOWNLOAD_COMPLETE") {
          clearTimeout(idle);
          state.jobWaiters.delete(it.found.url);
          it.filename = msg.filename;
          resolve();
        } else if (msg.type === "REPORT_DOWNLOAD_ERROR") {
          fail(new Error(msg.error || "download failed"));
        }
      });
      chrome.runtime
        .sendMessage({ type: "START_DOWNLOAD_JOB", video: it.found, kind: isHls ? "hls" : "file", tabId: tab.id })
        .then((r) => {
          if (!r || !r.ok) {
            state.jobWaiters.delete(it.found.url);
            reject(new Error((r && r.error) || "could not start download"));
          }
        }, reject);
    });
  }

  async function pumpDownloads() {
    const maxDl = Math.max(1, Math.min(8, +$("downloads").value || 4));
    while (state.dlRunning < maxDl && state.dlQueue.length) {
      const job = state.dlQueue.shift();
      if (job.it.cancelled) continue;
      state.dlRunning++;
      const it = job.it;
      it.status = "downloading";
      it.t = Object.assign(it.t || {}, { dl0: Date.now() });
      it.pct = 0;
      render();
      try {
        if (job.mode === "direct") await downloadDirect(it);
        else await downloadInTab(it, job.tab);
        it.status = "done";
        it.t.dl1 = Date.now();
        it.pct = 100;
      } catch (e) {
        if (it.cancelled) {
          it.status = "cancelled";
          it.error = "";
          continue;
        }
        // Slow/stalled hosts are a property of that link, not of the server: don't blacklist it.
        if (it.found && it.found.server && !/too slow|stalled/i.test(String(e && e.message))) {
          const st = stat(it.found.server);
          st.dlFails = (st.dlFails || 0) + 1;
        }
        if (it.alts && it.alts.length) {
          // Next-best stream from the same race.
          it.found = it.alts.shift();
          it.status = "found";
          it.error = "";
          state.dlQueue.unshift({ it, mode: "direct" });
        } else if ((it.rescans || 0) < 2) {
          // Stream links expire, hosts stall: find the episode again (fresh race, new link).
          it.rescans = (it.rescans || 0) + 1;
          it.retriedWeak = false;
          it.found = null;
          it.status = "queued";
          it.error = "";
          setTimeout(runQueue, 0);
        } else {
          it.status = "error";
          it.error = "Download failed: " + (e && e.message ? e.message : e);
        }
      } finally {
        if (job.mode === "tab" && !$("keepTabs").checked) closeTab(job.tab.id);
        state.dlRunning--;
        render();
        save();
      }
    }
    if (!state.running && !state.dlRunning && !state.dlQueue.length && !$("keepTabs").checked && !state.paused) closeSlotWindows();
  }

  // ------------------------------------------------------------------ list building
  async function fetchSeasonCounts(ex, season) {
    const tab = await laneTab(0, urlFor(ex, ex.show, season, 1));
    let counts = null;
    for (let i = 0; i < 30 && !counts; i++) {
      await sleep(700);
      const r = await chrome.tabs.sendMessage(tab.id, { type: "GET_SEASONS" }, { frameId: 0 }).catch(() => null);
      if (r && r.seasons && Object.keys(r.seasons).length) counts = r.seasons;
    }
    releaseLane(0, tab.id);
    return counts;
  }

  async function buildItems() {
    const ex = parseExample($("example").value);
    if (!ex) {
      say("Could not read that address. Use an episode URL that ends in /show/season/episode, e.g. https://nepu.gd/watch/tv/52/7/5");
      return false;
    }
    const show = $("show").value.trim() || ex.show;
    const seasons = parseList($("seasons").value);
    if (!seasons) {
      say("Seasons should look like 7, or 1-3, or 1,3,5.");
      return false;
    }
    const epText = $("episodes").value.trim().toLowerCase();
    let counts = null;
    let eps = null;
    if (epText === "all") {
      say("Reading episode counts from the site...");
      counts = await fetchSeasonCounts(ex, seasons[0]);
      say("");
      if (!counts) {
        say("Could not read the episode counts (the site may be showing a verification page). Type a range like 1-12 instead.");
        return false;
      }
    } else {
      eps = parseList(epText);
      if (!eps) {
        say("Episodes should look like 5, or 1-12, or 1,3,5-8, or all.");
        return false;
      }
    }
    const have = new Set(state.items.map((i) => i.url));
    let added = 0;
    for (const s of seasons) {
      const list = eps || Array.from({ length: counts[s] || 0 }, (_, i) => i + 1);
      for (const e of list) {
        const url = urlFor(ex, show, s, e);
        if (have.has(url)) continue;
        state.items.push({ id: ++state.seq, show: String(show), season: s, episode: e, url, status: "queued", error: "" });
        have.add(url);
        added++;
      }
    }
    state.items.sort((a, b) => (+showOf(a) || 0) - (+showOf(b) || 0) || a.season - b.season || a.episode - b.episode);
    if (!added && !state.items.some((i) => i.status === "queued")) say("Those episodes are already in the list.");
    return true;
  }

  // ------------------------------------------------------------------ rendering
  const STATUS = {
    queued: ["Queued", ""], opening: ["Opening", "working"], scanning: ["Scanning", "working"],
    found: ["Found", "good"], downloading: ["Downloading", "working"], done: ["Saved", "good"],
    notfound: ["Not found", "bad"], error: ["Error", "bad"], verify: ["Needs check", "bad"],
    cancelled: ["Cancelled", ""]
  };

  // Stop an episode wherever it is: waiting to download, downloading here, or downloading in a tab.
  function cancelItem(it) {
    it.cancelled = true;
    state.dlQueue = state.dlQueue.filter((j) => j.it !== it);
    if (it._wd) it._wd.abort(new Error("Cancelled"));
    if (it._tabJob && it.found) chrome.runtime.sendMessage({ type: "CANCEL_JOB", url: it.found.url }).catch(() => {});
    if (["queued", "found", "downloading"].includes(it.status)) it.status = "cancelled";
    it.error = "";
    render();
  }

  let renderQueued = false;
  function renderSoon() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function mb(n) {
    return n ? (n / 1048576).toFixed(0) + " MB" : "";
  }

  function renderServers() {
    const box = $("servers");
    if (!box) return;
    if (!state.servers.length) {
      box.innerHTML = '<div class="hint">Servers are read from the site the first time you race (set "Servers to race" above 1).</div>';
      return;
    }
    const allRanked = rankServers();
    // Only the servers that matter: ones already tried plus the next few in line.
    let ranked = allRanked;
    if (!state.showAllServers) {
      const tried = allRanked.filter((id) => stat(id).tries || stat(id).recent.length);
      const next = allRanked.filter((id) => !tried.includes(id)).slice(0, Math.max(0, 8 - tried.length));
      ranked = allRanked.filter((id) => tried.includes(id) || next.includes(id));
    }
    const table = document.createElement("table");
    table.innerHTML = "<thead><tr><th>Server</th><th>Tried</th><th>Found</th><th>Wins</th><th>Quality</th><th>Speed</th><th>Finds in</th></tr></thead>";
    const tb = document.createElement("tbody");
    for (const id of ranked) {
      const s = state.servers.find((x) => x.value === id) || { label: id };
      const st = stat(id);
      const tr = document.createElement("tr");
      const cells = [
        s.label,
        st.tries,
        st.tries ? Math.round((100 * st.found) / st.tries) + "%" : "-",
        st.wins,
        st.height ? Math.round(st.height) + "p" : "-",
        st.mbps ? st.mbps.toFixed(1) + " MB/s" : "-",
        st.findMs ? (st.findMs / 1000).toFixed(1) + "s" : "-"
      ];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = String(c);
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    const more = document.createElement("button");
    more.className = "quiet small";
    more.textContent = state.showAllServers ? "Show fewer" : `Show all ${allRanked.length} servers`;
    more.addEventListener("click", () => {
      state.showAllServers = !state.showAllServers;
      renderServers();
    });
    box.replaceChildren(table, more);
  }

  function render() {
    const counts = {};
    state.items.forEach((i) => (counts[i.status] = (counts[i.status] || 0) + 1));
    const n = state.items.length;
    $("summary").textContent = n
      ? `${n} episodes: ${counts.done || 0} saved, ${(counts.found || 0) + (counts.downloading || 0)} found / downloading, ${(counts.queued || 0) + (counts.opening || 0) + (counts.scanning || 0)} waiting, ${(counts.notfound || 0) + (counts.error || 0) + (counts.verify || 0)} need attention`
      : "";
    $("start").disabled = state.running && !state.paused;
    $("start").textContent = state.running ? "Add to queue" : "Start scanning";

    const list = $("list");
    if (!n) {
      list.innerHTML = '<div class="empty">Nothing queued yet. Choose seasons and episodes above, then press Start scanning.</div>';
      return;
    }
    const groups = new Map(); // show -> season -> items
    for (const it of state.items) {
      const sid = showOf(it);
      if (!groups.has(sid)) groups.set(sid, new Map());
      const seasons = groups.get(sid);
      if (!seasons.has(it.season)) seasons.set(it.season, []);
      seasons.get(it.season).push(it);
    }
    const tally = (items) => {
      const c = { total: items.length, done: 0, active: 0, waiting: 0, bad: 0 };
      for (const i of items) {
        if (i.status === "done") c.done++;
        else if (["found", "downloading", "opening", "scanning"].includes(i.status)) c.active++;
        else if (i.status === "queued") c.waiting++;
        else c.bad++;
      }
      return c;
    };
    const tallyText = (c) =>
      `${c.done}/${c.total} saved` + (c.active ? ` · ${c.active} working` : "") + (c.waiting ? ` · ${c.waiting} waiting` : "") + (c.bad ? ` · ${c.bad} need attention` : "");
    const groupButton = (text, fn) => {
      const b = document.createElement("button");
      b.className = "quiet small";
      b.textContent = text;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      });
      return b;
    };
    const retryAll = (items) => {
      for (const i of items) if (["notfound", "error", "verify"].includes(i.status)) {
        i.status = "queued";
        i.error = "";
      }
      render();
      runQueue();
    };

    const frag = document.createDocumentFragment();
    for (const sid of Array.from(groups.keys()).sort((x, y) => (+x || 0) - (+y || 0) || String(x).localeCompare(String(y)))) {
      const seasons = groups.get(sid);
      const all = Array.from(seasons.values()).flat();
      const showBox = document.createElement("details");
      showBox.className = "show";
      showBox.open = !state.collapsed.has("show:" + sid);
      showBox.addEventListener("toggle", () => {
        if (showBox.open) state.collapsed.delete("show:" + sid);
        else state.collapsed.add("show:" + sid);
        save();
      });
      const sum = document.createElement("summary");
      const title = document.createElement("span");
      title.className = "show-title";
      title.textContent = titleOf(sid);
      const meta = document.createElement("span");
      meta.className = "show-meta";
      meta.textContent = `#${sid} · ${tallyText(tally(all))}`;
      const acts = document.createElement("span");
      acts.className = "group-acts";
      if (all.some((i) => ["notfound", "error", "verify"].includes(i.status))) acts.appendChild(groupButton("Retry failed", () => retryAll(all)));
      if (all.some((i) => ["queued", "downloading"].includes(i.status) || state.dlQueue.some((j) => j.it === i))) {
        acts.appendChild(groupButton("Cancel all", () => all.forEach((i) => ["queued", "found", "downloading"].includes(i.status) && cancelItem(i))));
      }
      if (all.some((i) => i.found)) acts.appendChild(groupButton("Copy links", () => navigator.clipboard.writeText(all.filter((i) => i.found).map((i) => i.found.url).join("\n")).catch(() => {})));
      if (!all.some((i) => ["opening", "scanning", "downloading"].includes(i.status))) {
        acts.appendChild(groupButton("Remove", () => {
          state.items = state.items.filter((i) => showOf(i) !== sid);
          state.dlQueue = state.dlQueue.filter((j) => showOf(j.it) !== sid);
          render();
        }));
      }
      sum.append(title, meta, acts);
      showBox.appendChild(sum);

      for (const season of Array.from(seasons.keys()).sort((x, y) => x - y)) {
        const items = seasons.get(season).sort((x, y) => x.episode - y.episode);
        const c = tally(items);
        const key = `season:${sid}:${season}`;
        const sBox = document.createElement("details");
        sBox.className = "season";
        sBox.open = !state.collapsed.has(key);
        sBox.addEventListener("toggle", () => {
          if (sBox.open) state.collapsed.delete(key);
          else state.collapsed.add(key);
          save();
        });
        const ss = document.createElement("summary");
        const sl = document.createElement("span");
        sl.className = "season-title";
        sl.textContent = `Season ${season}`;
        const bar = document.createElement("span");
        bar.className = "bar season-bar";
        bar.innerHTML = `<i style="width:${c.total ? Math.round((100 * c.done) / c.total) : 0}%"></i>`;
        const sm = document.createElement("span");
        sm.className = "show-meta";
        sm.textContent = tallyText(c);
        const sa = document.createElement("span");
        sa.className = "group-acts";
        if (c.bad) sa.appendChild(groupButton("Retry failed", () => retryAll(items)));
        ss.append(sl, bar, sm, sa);
        sBox.appendChild(ss);

        const table = document.createElement("table");
        const tb = document.createElement("tbody");
        for (const it of items) tb.appendChild(rowFor(it));
        table.appendChild(tb);
        sBox.appendChild(table);
        showBox.appendChild(sBox);
      }
      frag.appendChild(showBox);
    }
    list.replaceChildren(frag);
    save();
  }

  function rowFor(it) {
    {
      const tr = document.createElement("tr");
      const [label, cls] = STATUS[it.status] || [it.status, ""];

      const se = document.createElement("td");
      se.className = "se";
      se.textContent = `E${pad(it.episode)}`;

      const st = document.createElement("td");
      st.innerHTML = `<span class="chip ${cls}">${label}</span>`;

      const dt = document.createElement("td");
      dt.className = "detail";
      if (it.status === "downloading") {
        dt.innerHTML = `<div class="bar"><i style="width:${it.pct || 0}%"></i></div>`;
        dt.title = `${it.pct || 0}% ${it.stage === "transmux" ? "(finishing)" : ""} ${mb(it.bytes)}`;
      } else if (it.error) {
        dt.textContent = it.error;
        dt.title = it.error;
      } else if (it.found) {
        const q = it.found.height ? `${it.found.height}p ` : it.found.width ? `${it.found.width}x${it.found.height} ` : "";
        const srv = it.found.server ? ` via ${(state.servers.find((x) => x.value === it.found.server) || { label: it.found.server }).label}` : "";
        const sp = it.found.mbps ? `, ${it.found.mbps.toFixed(1)} MB/s per connection` : "";
        dt.textContent = `${q}${it.found.type}${srv}${it.foundMs ? " in " + (it.foundMs / 1000).toFixed(1) + "s" : ""}${sp}${it.filename ? " - " + it.filename : ""}`;
        dt.title = it.found.url;
      }

      const act = document.createElement("td");
      act.className = "act";
      const mk = (text, fn) => {
        const b = document.createElement("button");
        b.className = "quiet small";
        b.textContent = text;
        b.addEventListener("click", fn);
        act.appendChild(b);
      };
      if (it.found) mk("Copy link", () => navigator.clipboard.writeText(it.found.url).catch(() => {}));
      if (it.found && ["found", "error", "done"].includes(it.status) && !state.dlQueue.some((j) => j.it === it)) {
        mk(it.status === "done" ? "Download again" : "Download", () => {
          it.cancelled = false;
          state.dlQueue.push({ it, mode: "direct" });
          pumpDownloads();
        });
      }
      if (["downloading", "queued", "found"].includes(it.status) && (it.status !== "found" || state.dlQueue.some((j) => j.it === it))) {
        mk("Cancel", () => cancelItem(it));
      }
      if (["notfound", "error", "verify", "cancelled"].includes(it.status)) {
        mk("Retry", () => {
          it.cancelled = false;
          it.status = "queued";
          it.error = "";
          render();
          runQueue();
        });
      }
      mk("Open page", () => chrome.tabs.create({ url: it.url }));

      tr.append(se, st, dt, act);
      return tr;
    }
  }

  // ------------------------------------------------------------------ wiring
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.tabId != null && state.streamWaiters.has(msg.tabId)) state.streamWaiters.get(msg.tabId)(msg);
    if (msg.url && state.jobWaiters.has(msg.url)) state.jobWaiters.get(msg.url)(msg);
  });

  // Paste an episode URL and everything else is filled in: show, that season, all episodes.
  let lastExample = "";
  $("example").addEventListener("input", () => {
    const v = $("example").value.trim();
    const ex = parseExample(v);
    if (ex && v !== lastExample) {
      lastExample = v;
      $("show").value = ex.show;
      $("seasons").value = ex.season;
      $("episodes").value = "all";
    }
    save();
  });
  // A URL pasted anywhere on the page (outside a text field) goes into the example field.
  document.addEventListener("paste", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    const text = ((e.clipboardData && e.clipboardData.getData("text")) || "").trim();
    if (!parseExample(text)) return;
    e.preventDefault();
    $("example").value = text;
    $("example").dispatchEvent(new Event("input", { bubbles: true }));
    $("example").focus();
  });
  FORM_IDS.concat(CHECK_IDS).forEach((id) => $(id).addEventListener("change", save));

  $("start").addEventListener("click", async () => {
    if (state.paused) return;
    state.stop = false;
    if (await buildItems()) {
      render();
      runQueue();
    } else {
      render();
    }
  });

  $("resume").addEventListener("click", () => {
    state.paused = false;
    say("");
    for (const it of state.items) {
      if (it.status === "verify") {
        it.status = "queued";
        closeTab(it.tabId);
      }
    }
    render();
    runQueue();
  });

  $("stop").addEventListener("click", () => {
    state.stop = true;
    for (const it of state.items) if (["opening", "scanning"].includes(it.status)) it.status = "queued";
    for (const [tabId] of state.streamWaiters) state.streamWaiters.get(tabId)({ type: "PAGE_GATE_STOP" });
    closeSlotWindows();
    render();
  });

  $("retry").addEventListener("click", () => {
    for (const it of state.items) if (["notfound", "error"].includes(it.status) && !it.found) it.status = "queued";
    render();
    runQueue();
  });

  $("copy").addEventListener("click", () => {
    const text = state.items.filter((i) => i.found).map((i) => i.found.url).join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  });

  $("clear").addEventListener("click", () => {
    if (state.running) return;
    state.items = [];
    state.dlQueue = [];
    say("");
    render();
  });

  $("resetServers") &&
    $("resetServers").addEventListener("click", () => {
      state.stats = {};
      state.servers = [];
      state.serversOrigin = null;
      chrome.storage.local.remove(["serverStats", "serverLists"]).catch(() => {});
      renderServers();
    });

  restore().then(async () => {
    const ex = parseExample($("example").value);
    if (ex && !$("show").value) $("show").value = ex.show;
    if (ex) await loadServers(ex.origin);
    // Opened from the popup ("Best quality"): race this one episode and download the winner.
    const q = new URLSearchParams(location.search);
    const one = q.get("url") && parseExample(q.get("url"));
    if (one) {
      $("example").value = q.get("url");
      $("show").value = one.show;
      $("seasons").value = one.season;
      $("episodes").value = one.episode;
      $("autoDownload").checked = true;
      if (+$("race").value < 2) $("race").value = "3";
      history.replaceState(null, "", location.pathname);
      render();
      renderServers();
      $("start").click();
      return;
    }
    render();
    renderServers();
    // Downloads that were cut off continue by themselves (a dead link triggers a fresh search).
    const cut = state.items.filter((i) => i.resume && i.found);
    for (const it of cut) {
      delete it.resume;
      state.dlQueue.push({ it, mode: "direct" });
    }
    if (cut.length) pumpDownloads();
  });
})();
