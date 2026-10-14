/* Bilibili Ad Skipper — orchestrator (ISOLATED world, document_idle). Ties bridge → API → detectors → fusion → skipper/UI. */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS || BAS.__mainStarted) return;
  BAS.__mainStarted = true;

  const { util, events } = BAS;
  const { fmtTime, debounce } = util;
  const CACHE_TTL_MS = 12 * 3600 * 1000;
  const CACHE_REFRESH_MS = 60 * 60 * 1000;
  const BRIDGE_WAIT_MS = 1500;        // give the MAIN-world bridge this long before falling back to the view API
  const VIEW_RETRY_MS = 10 * 1000;    // retry a failed view-API identity lookup after this long
  const MAX_DM_SEGMENTS = 200;        // sanity cap for bridge-forwarded segment indexes (= 20 h of video)
  const MAX_DM_BUFFER = 16 * 1024 * 1024;

  const state = {
    video: null,               // {bvid, aid, cid, p, title, duration, mid, upName}
    status: 'idle',            // idle | loading | ready | error | ignored | disabled
    error: null,
    candidates: [],            // raw detector candidates (chapter + danmaku)
    boundaries: [],            // chapter boundaries
    viewPoints: [],
    segments: [],              // fused (ignored ones are kept with enabled:false, ignored:true)
    dropped: [],
    overrides: null,
    stats: { danmakuCount: 0, viewPoints: 0, cuts: 0, missingSegments: [] },
    abort: null,
    runId: 0,
    videoEl: null,
    skipper: null,
    skipperVideo: null,
    media: null,
    mediaVideo: null,
    mediaAudio: false,
    bridgeState: null,
    urlInfo: null,             // fallback identity resolved from URL + view API: {key, info, failedAt?, pending?}
    preloadedDm: new Map(),    // cid(string) -> Map(segmentIndex -> Danmaku[])
    bridgePlayerInfo: new Map(), // cid(string) -> view_points
    bridgeHeat: new Map(),     // cid(string) -> parsed heat curve captured from the player's own request
    heat: null,                // parsed 高能进度条 curve for the current video {step, values, events}
    heatAnalysis: null,        // BAS.detectHeat.analyse(heat)
    lastDanmaku: null,         // {cid, list} — kept so keyword edits can re-run detection without re-downloading
    lastKey: null,
    bootAt: Date.now(),
  };
  BAS.state.main = state;

  const settings = () => BAS.state.settings || BAS.DEFAULT_SETTINGS;
  const chromeOk = () => { try { return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };

  // ---------------------------------------------------------------- helpers
  const notInline = (el) => !!el && !el.closest('.v-recommend-inline-player');
  function findVideoEl() {
    const pick = (sel) => Array.from(document.querySelectorAll(sel)).find(notInline) || null;
    return pick('#bilibili-player .bpx-player-video-wrap video') || pick('#bilibili-player video') || pick('.bpx-player-container video');
  }
  function findPlayerContainer() {
    const pick = (sel) => Array.from(document.querySelectorAll(sel)).find(notInline) || null;
    return pick('#bilibili-player .bpx-player-container') || pick('.bpx-player-container') || document.querySelector('#bilibili-player');
  }
  function parseUrlIdentity() {
    const m = /\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i.exec(location.pathname) || /\/(?:list|festival)\/[^?]*\?.*?bvid=(BV[0-9A-Za-z]{10})/i.exec(location.href);
    let bvid = null, aid = null;
    if (m) { if (/^BV/i.test(m[1])) bvid = m[1]; else aid = Number(m[1].slice(2)); }
    if (!bvid && !aid) {
      const q = new URLSearchParams(location.search);
      if (q.get('bvid')) bvid = q.get('bvid');
      else if (q.get('aid')) aid = Number(q.get('aid'));
    }
    const p = Number(new URLSearchParams(location.search).get('p') || 1) || 1;
    return (bvid || aid) ? { bvid, aid, p } : null;
  }
  function sendBadge(count) {
    if (!chromeOk()) return;
    try { chrome.runtime.sendMessage({ type: 'BAS_BADGE', count }, () => { void chrome.runtime.lastError; }); } catch (e) { /* context invalidated */ }
  }
  const activeCount = () => state.segments.filter((x) => x.enabled !== false).length;
  function publicState() {
    const v = state.videoEl;
    let currentTime = null, duration = null;
    try { currentTime = v ? v.currentTime : null; duration = v && isFinite(v.duration) ? v.duration : null; } catch (e) { /* ignore */ }
    return {
      ok: true,
      version: BAS.VERSION,
      video: state.video,
      status: state.status,
      error: state.error,
      segments: state.segments,
      candidates: state.candidates,
      dropped: state.dropped,
      settings: settings(),
      stats: Object.assign({}, state.stats, { cuts: state.media ? state.media.cuts.length : 0 }),
      currentTime,
      duration: duration || (state.video && state.video.duration) || null,
    };
  }
  /** Cached candidates do not need the (large) evidence arrays. */
  const slimCandidate = (c) => {
    const o = Object.assign({}, c);
    const ev = c.evidence || {};
    o.evidence = { targetsAgree: ev.targetsAgree, adVocab: ev.adVocab, strongEnd: ev.strongEnd, mediumEnd: ev.mediumEnd };
    return o;
  };

  // ---------------------------------------------------------------- UI glue
  function ensureUi() {
    if (!BAS.ui) return false;
    const c = findPlayerContainer();
    if (!c) return false;
    try { return BAS.ui.mount(c) !== false; } catch (e) { BAS.warn('ui.mount failed', e); return false; }
  }
  function renderMarkers() {
    if (!BAS.ui) return;
    try {
      if (!ensureUi()) return;
      const s = settings();
      let dur = 0;
      try { dur = (state.videoEl && isFinite(state.videoEl.duration) && state.videoEl.duration) || 0; } catch (e) { /* ignore */ }
      dur = dur || (state.video && state.video.duration) || 0;
      if (!s.enabled || !s.showMarkers || !dur) BAS.ui.renderMarkers([], dur || 1);
      else BAS.ui.renderMarkers(state.segments, dur);   // ignored segments render dimmed (enabled:false)
    } catch (e) { BAS.warn('renderMarkers failed', e); }
  }
  function clearUi() {
    if (!BAS.ui) return;
    try { BAS.ui.renderMarkers([], 1); BAS.ui.hideSkipButton(); BAS.ui.dismissToasts && BAS.ui.dismissToasts(); } catch (e) { /* ignore */ }
  }
  /** bilibili renders the progress bar lazily and re-renders the control bar on layout changes; re-attach when needed. */
  function uiHealthCheck() {
    if (!BAS.ui || !state.video) return;
    try {
      const c = findPlayerContainer();
      if (!c) return;
      const area = c.querySelector('.bpx-player-video-area');
      const layerOk = !area || !!area.querySelector(':scope > .bas-layer');
      const bars = c.querySelectorAll('.bpx-player-progress, .bpx-player-shadow-progress-area');
      let barsOk = true;
      for (const b of bars) if (!b.querySelector(':scope > .bas-markers')) { barsOk = false; break; }
      const ctrlHost = c.querySelector('.bpx-player-control-bottom-right');
      const ctrlOk = !skipHereWanted() || !ctrlHost || !!ctrlHost.querySelector(':scope > .bas-ctrl-skip');
      if (!layerOk || !barsOk || !ctrlOk) { BAS.ui.refresh && BAS.ui.refresh(); renderMarkers(); }
    } catch (e) { BAS.debug('ui health check failed', e); }
  }

  function onSkip(seg, from) {
    BAS.debug('skipped', seg, from);
    const s = settings();
    if (!s.showToast || !BAS.ui || !ensureUi()) return;
    const v = state.video;
    try {
      BAS.ui.showToast({
        html: `<b>已跳过广告</b> ${fmtTime(from)} → ${fmtTime(seg.end)}<span class="bas-toast-sub">${escapeHtml(seg.reason || '')}</span>`,
        actionLabel: '撤销',
        durationMs: s.toastDurationMs,
        onAction: () => {
          try { state.skipper && state.skipper.undo(seg, from); } catch (e) { /* ignore */ }
          if (v && state.video && state.video.cid === v.cid) {
            BAS.storage.addIgnore(v.bvid, v.cid, { start: seg.start, end: seg.end }).then(() => reloadOverrides()).catch(() => {});
          }
        },
      });
    } catch (e) { BAS.warn('toast failed', e); }
  }
  function onEnter(seg) {
    if (!BAS.ui || !ensureUi()) return;
    try {
      BAS.ui.showSkipButton({
        label: seg.offerOnly ? '弹幕建议跳过' : '跳过广告',
        sub: `${fmtTime(seg.start)} → ${fmtTime(seg.end)}`,
        onClick: () => { try { state.skipper && state.skipper.skipNow(seg); } catch (e) { /* ignore */ } },
      });
    } catch (e) { /* ignore */ }
  }
  function onLeave() { try { BAS.ui && BAS.ui.hideSkipButton(); } catch (e) { /* ignore */ } }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------------------------------------------------------------- manual skip (ads the detectors missed)
  let skipHereBusy = false;
  /** The viewer says an ad is playing now: find its end from every available signal and jump there. */
  async function skipHere() {
    const v = state.videoEl, info = state.video;
    if (!v || !info || skipHereBusy || !BAS.findAdEnd) return null;
    let t;
    try { t = v.currentTime; } catch (e) { return null; }
    if (!isFinite(t)) return null;
    skipHereBusy = true;
    try {
      let list = state.lastDanmaku && state.lastDanmaku.cid === info.cid ? state.lastDanmaku.list : null;
      if (!list) {
        // results came from the cache (or danmaku analysis is off): load the danmaku now
        const wait = BAS.ui ? BAS.ui.showToast({ text: '正在查找广告结尾…', durationMs: 8000, force: true }) : null;
        try { list = await BAS.api.getDanmaku(info.aid, info.cid, info.duration, {}); state.lastDanmaku = { cid: info.cid, list }; }
        catch (e) { BAS.debug('skip-here: danmaku unavailable', e); list = []; }
        if (wait) wait.close();
        if (!state.video || state.video.cid !== info.cid) return null;
      }
      const r = BAS.findAdEnd({
        t, duration: info.duration || (isFinite(v.duration) ? v.duration : 0), danmaku: list, heat: state.heatAnalysis,
        boundaries: state.boundaries, candidates: [].concat(state.segments, state.dropped, state.candidates),
      });
      if (!r) { if (BAS.ui) BAS.ui.showToast({ text: '已接近视频结尾', force: true }); return null; }
      try { v.currentTime = r.end; } catch (e) { return null; }
      BAS.log('skip-here', fmtTime(t), '->', fmtTime(r.end), r.source);
      const actions = [{ label: '撤销', onAction: () => { try { v.currentTime = t; } catch (e) { /* ignore */ } } }];
      if (r.source === 'fallback') {
        actions.push({ label: '再前进', title: '广告还没结束？继续查找结尾', onAction: () => { skipHere(); } });
      } else {
        actions.push({
          label: '记住', title: '把这段标记为广告，下次自动跳过',
          onAction: () => {
            if (!state.video || state.video.cid !== info.cid) return;
            BAS.storage.addUser(info.bvid, info.cid, { start: r.start, end: r.end }).then(reloadOverrides).catch(() => {});
          },
        });
      }
      if (BAS.ui) {
        BAS.ui.showToast({
          html: `<b>已跳过</b> ${fmtTime(t)} → ${fmtTime(r.end)}<span class="bas-toast-sub">依据：${escapeHtml(r.reason)}</span>`,
          actions, durationMs: Math.max(8000, settings().toastDurationMs || 0), force: true,
        });
      }
      return r;
    } finally { skipHereBusy = false; }
  }
  function skipHereWanted() { const s = settings(); return !!(s.enabled && s.skipHereButton !== false && state.video); }
  function syncSkipHereButton() {
    if (!BAS.ui || !BAS.ui.setSkipHereButton) return;
    try { BAS.ui.setSkipHereButton(skipHereWanted() ? { onClick: skipHere } : null); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- skipper / media lifecycle
  function ensureSkipper(videoEl) {
    if (!BAS.Skipper || !videoEl) return;
    const getSegments = () => (settings().enabled ? state.segments : []);
    if (!state.skipper) {
      state.skipper = new BAS.Skipper(videoEl, { getSegments, getSettings: settings, onSkip, onEnter, onLeave });
      state.skipperVideo = videoEl;
    } else if (state.skipperVideo !== videoEl) {
      try { state.skipper.attach(videoEl); state.skipperVideo = videoEl; } catch (e) { BAS.warn('skipper.attach failed', e); }
    }
  }
  const refuseDebounced = debounce(() => applyFusion('media'), 500);
  function destroyMedia() {
    if (state.media) { try { state.media.destroy(); } catch (e) { /* ignore */ } }
    state.media = null; state.mediaVideo = null;
  }
  function ensureMedia(videoEl) {
    const s = settings();
    const want = s.enabled && (s.useMedia || s.useAudio) && !!BAS.MediaAnalyzer && !!videoEl;
    if (!want) { destroyMedia(); return; }
    if (state.media && state.mediaAudio !== !!s.useAudio) destroyMedia();   // audio pipeline is fixed at construction
    const onCut = (cut) => {
      if (!settings().useMedia) return;
      // only re-fuse when the cut is near a known boundary
      const near = state.candidates.some((c) => Math.abs(c.start - cut.t) <= 6 || (c.end != null && Math.abs(c.end - cut.t) <= 6));
      if (near) refuseDebounced();
    };
    if (!state.media) {
      try {
        state.media = new BAS.MediaAnalyzer(videoEl, { audio: !!s.useAudio, onCut });
        state.mediaVideo = videoEl; state.mediaAudio = !!s.useAudio;
        if (state.media.start) state.media.start();
      } catch (e) { BAS.warn('MediaAnalyzer failed', e); state.media = null; state.mediaVideo = null; }
    } else if (state.mediaVideo !== videoEl) {
      try { state.media.attach(videoEl); state.mediaVideo = videoEl; } catch (e) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- fusion
  function applyFusion(reason) {
    if (!state.video) return;
    const s = settings();
    const dur = state.video.duration || (state.videoEl && state.videoEl.duration) || 0;
    try {
      // Danmaku clusters without a determinable end are sponsor chatter, not skippable segments: keep them out of the
      // progress bar (fusion would otherwise stretch them to the next chapter boundary) but list them for the popup.
      const openEnded = state.candidates.filter((c) => c.source === 'danmaku' && (c.end == null || !isFinite(c.end)));
      let usable = state.candidates.filter((c) => !openEnded.includes(c));
      if (BAS.detectHeat && s.useHeat !== false && state.heatAnalysis) {
        usable = BAS.detectHeat.corroborate(usable, state.heatAnalysis, s);
        usable = usable.concat(BAS.detectHeat.offers(usable, state.heatAnalysis, s));
      }
      const media = s.useMedia ? state.media : null;
      const out = BAS.fuse({ candidates: usable, duration: dur, boundaries: state.boundaries, media, overrides: state.overrides, settings: s });
      const segs = Array.isArray(out) ? out.slice() : ((out && out.segments) || []).slice();
      const diag = (out && out.diagnostics) || {};
      const dropped = [];
      for (const d of diag.dropped || (out && out.dropped) || []) {
        if (d.dropReason === '用户已忽略' && isFinite(d.start) && isFinite(d.end) && d.end > d.start) {
          // Keep ignored segments visible (dimmed) so the user can restore them from the popup.
          const id = String(d.source || 'd')[0] + ':' + Math.round(d.start) + '-' + Math.round(d.end) + ':ignored';
          segs.push(Object.assign({}, d, { id, enabled: false, ignored: true, autoSkip: false }));
        } else dropped.push(d);
      }
      for (const c of openEnded) dropped.push(Object.assign({}, c, { dropReason: '无法确定结束时间' }));
      segs.sort((a, b) => a.start - b.start);
      // keep session-only enabled flags (ids are stable across re-fusion)
      const prev = new Map(state.segments.filter((x) => !x.ignored).map((x) => [x.id, x.enabled]));
      for (const seg of segs) if (!seg.ignored && prev.has(seg.id)) seg.enabled = prev.get(seg.id);
      state.segments = segs;
      state.dropped = dropped;
    } catch (e) {
      BAS.warn('fuse failed', e);
      state.segments = [];
    }
    BAS.debug('fusion', reason, state.segments);
    renderMarkers();
    sendBadge(activeCount());
    events.emit('segments', state.segments);
  }
  async function reloadOverrides() {
    const v = state.video;
    if (!v) return;
    let ov = null;
    try { ov = await BAS.storage.getOverrides(v.bvid, v.cid); } catch (e) { ov = null; }
    if (!state.video || state.video.cid !== v.cid) return;   // navigated away meanwhile
    state.overrides = ov;
    applyFusion('overrides');
  }

  // ---------------------------------------------------------------- detection run
  function abortDetection() {
    state.runId++;
    if (state.abort) { try { state.abort.abort(); } catch (e) { /* ignore */ } }
    state.abort = null;
  }
  function cacheResults(info) {
    BAS.storage.setCache(info.cid, {
      version: BAS.VERSION, ts: Date.now(),
      candidates: state.candidates.map(slimCandidate), boundaries: state.boundaries, viewPoints: state.viewPoints, stats: state.stats,
      heat: state.heat,
    }).catch(() => {});
  }

  async function detect(info, { force } = {}) {
    abortDetection();
    const runId = state.runId;
    const ac = new AbortController();
    state.abort = ac;
    const alive = () => runId === state.runId && !ac.signal.aborted && settings().enabled;

    state.video = info;
    state.status = 'loading'; state.error = null;
    state.candidates = []; state.boundaries = []; state.viewPoints = []; state.segments = []; state.dropped = [];
    state.stats = { danmakuCount: 0, viewPoints: 0, cuts: 0, missingSegments: [] };
    state.heat = null; state.heatAnalysis = null;
    clearUi();
    sendBadge(0);
    try { state.skipper && state.skipper.reset && state.skipper.reset(); } catch (e) { /* ignore */ }
    try { state.media && state.media.clearCuts && state.media.clearCuts(); } catch (e) { /* ignore */ }

    const s = settings();
    if (!s.enabled) { state.status = 'disabled'; return; }
    if ((s.ignoreUps || []).map(String).includes(String(info.mid))) { state.status = 'ignored'; return; }

    let ov = null;
    try { ov = await BAS.storage.getOverrides(info.bvid, info.cid); } catch (e) { ov = null; }
    if (!alive()) return;
    state.overrides = ov;

    // cache
    if (!force) {
      let cached = null;
      try { cached = await BAS.storage.getCache(info.cid); } catch (e) { cached = null; }
      if (!alive()) return;
      if (cached && cached.version === BAS.VERSION && Date.now() - (cached.ts || 0) < CACHE_TTL_MS && Array.isArray(cached.candidates)) {
        state.candidates = cached.candidates; state.boundaries = cached.boundaries || []; state.viewPoints = cached.viewPoints || [];
        if (cached.heat && BAS.detectHeat) { state.heat = cached.heat; state.heatAnalysis = BAS.detectHeat.analyse(cached.heat, info.duration); }
        state.stats = Object.assign(state.stats, cached.stats || {});
        state.status = 'ready';
        applyFusion('cache');
        if (Date.now() - (cached.ts || 0) < CACHE_REFRESH_MS) return; // fresh enough
      }
    }

    // live detection — chapters and danmaku in parallel, each failure isolated
    const chaptersP = (async () => {
      if (!BAS.detectChapters) return { candidates: [], boundaries: [], viewPoints: [] };
      let vps = state.bridgePlayerInfo.get(String(info.cid));
      if (!vps) {
        const pi = await BAS.api.getPlayerInfo(info.aid, info.cid, { signal: ac.signal });
        vps = (pi && pi.view_points) || [];
      }
      const r = BAS.detectChapters(vps, info.duration, s);
      return { candidates: r.candidates || [], boundaries: r.boundaries || [], viewPoints: vps };
    })().catch((e) => { BAS.warn('chapters failed', e); return { candidates: [], boundaries: [], viewPoints: [], error: e }; });

    const danmakuP = (async () => {
      if (!s.useDanmaku) return { candidates: [], count: 0, missing: [] };
      const preloaded = state.preloadedDm.get(String(info.cid));
      const list = await BAS.api.getDanmaku(info.aid, info.cid, info.duration, { preloaded, signal: ac.signal });
      state.preloadedDm.delete(String(info.cid));   // decoded copies are no longer needed
      if (!alive()) return { candidates: [], count: list.length, missing: [] };
      const missing = list.missingSegments || [];
      const total = list.segmentCount || Math.max(1, Math.ceil((info.duration || 0) / 360));
      if (!list.length && missing.length && missing.length >= total) throw new Error('弹幕获取失败');
      state.lastDanmaku = { cid: info.cid, list };
      const t0 = performance.now();
      const r = BAS.detectDanmaku(list, info.duration, s);
      BAS.debug(`detectDanmaku ${list.length} items in ${(performance.now() - t0).toFixed(1)} ms`, r);
      return { candidates: r.candidates || [], count: list.length, missing };
    })().catch((e) => { if (e && e.name === 'AbortError') return { aborted: true, candidates: [], count: 0, missing: [] }; BAS.warn('danmaku failed', e); return { candidates: [], count: 0, missing: [], error: e }; });

    const heatP = (async () => {
      if (!BAS.detectHeat || s.useHeat === false) return null;
      let parsed = state.bridgeHeat.get(String(info.cid)) || null;
      if (!parsed) parsed = BAS.detectHeat.parse(await BAS.api.getHeat(info.aid, info.cid, info.bvid, { signal: ac.signal }));
      return parsed;
    })().catch((e) => { BAS.debug('heat failed', e); return null; });

    const [ch, dm, heat] = await Promise.all([chaptersP, danmakuP, heatP]);
    if (!alive()) { if (!settings().enabled && runId === state.runId) { state.status = 'disabled'; clearUi(); sendBadge(0); } return; }

    state.candidates = [].concat(ch.candidates, dm.candidates);
    state.boundaries = ch.boundaries; state.viewPoints = ch.viewPoints || [];
    if (heat) { state.heat = heat; state.heatAnalysis = BAS.detectHeat.analyse(heat, info.duration); }
    state.stats.heat = state.heatAnalysis ? { step: state.heatAnalysis.step, usable: state.heatAnalysis.usable, adRuns: state.heatAnalysis.runs.filter((r) => r.adLike).length } : null;
    state.stats.danmakuCount = dm.count; state.stats.viewPoints = state.viewPoints.length; state.stats.missingSegments = dm.missing || [];
    const errMsg = (e) => String((e && e.message) || e || '未知错误');
    if (dm.error) { state.status = 'error'; state.error = errMsg(dm.error); }
    else if (ch.error && !s.useDanmaku) { state.status = 'error'; state.error = errMsg(ch.error); }
    else { state.status = 'ready'; state.error = null; }
    applyFusion('detect');
    // Only complete results are cached; failures and partial danmaku are retried on the next visit.
    if (!dm.error && !ch.error && !(dm.missing && dm.missing.length)) cacheResults(info);
  }

  /** Keyword edits: re-run detectors on the danmaku already in memory instead of downloading everything again. */
  function redetectFromMemory() {
    const info = state.video;
    if (!info) return;
    const s = settings();
    if (!s.enabled) return;
    const mem = state.lastDanmaku && state.lastDanmaku.cid === info.cid ? state.lastDanmaku.list : null;
    if (!mem && s.useDanmaku) { detect(info, { force: true }).catch(() => {}); return; }
    try {
      const ch = BAS.detectChapters ? BAS.detectChapters(state.viewPoints, info.duration, s) : { candidates: [], boundaries: state.boundaries };
      const dm = s.useDanmaku && mem ? BAS.detectDanmaku(mem, info.duration, s) : { candidates: [] };
      state.candidates = [].concat(ch.candidates || [], dm.candidates || []);
      state.boundaries = ch.boundaries || state.boundaries;
      applyFusion('keywords');
      if (state.status === 'ready') cacheResults(info);
    } catch (e) { BAS.warn('re-detect failed', e); }
  }
  const redetectDebounced = debounce(redetectFromMemory, 1200);

  // ---------------------------------------------------------------- identity tracking
  async function resolveIdentity() {
    const bs = state.bridgeState;
    const u = parseUrlIdentity();
    if (bs && bs.cid && (!u || !u.bvid || String(bs.bvid) === String(u.bvid)) && (!u || Number(bs.p || 1) === Number(u.p || 1))) {
      return { bvid: bs.bvid, aid: bs.aid, cid: bs.cid, p: bs.p || 1, title: bs.title, duration: bs.duration, mid: bs.mid, upName: bs.upName };
    }
    if (!u) return null;
    // The bridge normally answers within a few hundred ms; avoid a redundant view-API call on every page load.
    if (!bs && Date.now() - state.bootAt < BRIDGE_WAIT_MS) return null;
    const key = `${u.bvid || u.aid}:${u.p}`;
    const ui = state.urlInfo;
    if (ui && ui.key === key) {
      if (ui.pending) return null;
      if (ui.info) return ui.info;
      if (Date.now() - (ui.failedAt || 0) < VIEW_RETRY_MS) return null;
    }
    state.urlInfo = { key, info: null, pending: true };
    try {
      const v = await BAS.api.getView(u.bvid ? { bvid: u.bvid } : { aid: u.aid });
      const page = (v.pages && v.pages[u.p - 1]) || null;
      const info = { bvid: v.bvid, aid: v.aid, cid: (page && page.cid) || v.cid, p: u.p, title: v.title, duration: (page && page.duration) || v.duration, mid: v.owner && String(v.owner.mid), upName: v.owner && v.owner.name };
      state.urlInfo = { key, info };
      return info;
    } catch (e) {
      BAS.warn('getView failed', e);
      state.urlInfo = { key, info: null, failedAt: Date.now() };
      return null;
    }
  }

  /** Called synchronously on URL changes: never let the previous video's segments fire on the new one. */
  function disarmIfUrlChanged() {
    const v = state.video;
    if (!v) return;
    const u = parseUrlIdentity();
    const sameVideo = u && ((u.bvid && String(u.bvid) === String(v.bvid)) || (u.aid && Number(u.aid) === Number(v.aid)));
    if (!sameVideo || Number(u.p || 1) !== Number(v.p || 1)) {
      if (state.segments.length) { state.segments = []; clearUi(); sendBadge(0); }
    }
  }

  let ticking = false;
  async function tick() {
    if (ticking) return; ticking = true;
    try {
      disarmIfUrlChanged();
      const videoEl = findVideoEl();
      if (videoEl !== state.videoEl) {
        state.videoEl = videoEl;
        if (videoEl) { ensureSkipper(videoEl); ensureMedia(videoEl); renderMarkers(); }
      }
      const info = await resolveIdentity();
      const key = info ? `${info.bvid}:${info.cid}` : null;
      if (key !== state.lastKey) {
        if (info) {
          state.lastKey = key;
          BAS.log('video', info.bvid, 'cid', info.cid, 'p', info.p);
          state.video = info;
          syncSkipHereButton();
          detect(info).catch((e) => { BAS.warn('detect failed', e); state.status = 'error'; state.error = String(e && e.message || e); });
        } else if (!parseUrlIdentity()) {
          state.lastKey = null; state.video = null; state.segments = []; clearUi(); syncSkipHereButton();
        }
      } else if (info && state.video && info.duration && !state.video.duration) {
        state.video.duration = info.duration;
      }
      uiHealthCheck();
    } catch (e) { BAS.warn('tick failed', e); }
    finally { ticking = false; }
  }

  // ---------------------------------------------------------------- bridge (page-originated: validate everything)
  const isId = (x) => (typeof x === 'number' && isFinite(x) && x > 0) || (typeof x === 'string' && /^\d{1,20}$/.test(x));
  function onBridgeMessage(ev) {
    if (ev.source !== window || ev.origin !== location.origin || !ev.data || ev.data.__bas !== true) return;
    const d = ev.data;
    try {
      if (d.type === 'BAS_URL_CHANGED') { disarmIfUrlChanged(); setTimeout(tick, 0); }
      else if (d.type === 'BAS_PAGE_STATE' && d.state && typeof d.state === 'object') {
        const st = d.state;
        if (!isId(st.cid) || (st.aid != null && !isId(st.aid))) return;
        state.bridgeState = {
          aid: st.aid, bvid: typeof st.bvid === 'string' ? st.bvid.slice(0, 16) : null, cid: st.cid, p: Number(st.p) || 1,
          duration: Number(st.duration) || 0, title: typeof st.title === 'string' ? st.title.slice(0, 200) : '',
          mid: st.mid != null ? String(st.mid).slice(0, 20) : null, upName: typeof st.upName === 'string' ? st.upName.slice(0, 60) : '',
        };
        tick();
      } else if (d.type === 'BAS_PLAYER_INFO' && isId(d.cid)) {
        const vps = Array.isArray(d.view_points) ? d.view_points.slice(0, 200).filter((x) => x && typeof x === 'object') : [];
        state.bridgePlayerInfo.set(String(d.cid), vps);
        if (state.bridgePlayerInfo.size > 20) state.bridgePlayerInfo.delete(state.bridgePlayerInfo.keys().next().value);
      } else if (d.type === 'BAS_HEAT' && isId(d.cid) && d.data && typeof d.data === 'object' && BAS.detectHeat) {
        const parsed = BAS.detectHeat.parse(d.data);
        if (parsed && parsed.values.length <= 2000) {
          state.bridgeHeat.set(String(d.cid), parsed);
          if (state.bridgeHeat.size > 5) state.bridgeHeat.delete(state.bridgeHeat.keys().next().value);
          // arrived after detection finished (the player loads it lazily): apply it now
          if (state.video && String(state.video.cid) === String(d.cid) && !state.heat && settings().useHeat !== false) {
            state.heat = parsed; state.heatAnalysis = BAS.detectHeat.analyse(parsed, state.video.duration);
            applyFusion('heat');
          }
        }
      } else if (d.type === 'BAS_DM_SEG' && isId(d.oid) && BAS.decodeDmSeg) {
        const idx = Number(d.segment_index);
        if (!(d.buffer instanceof ArrayBuffer) || d.buffer.byteLength > MAX_DM_BUFFER || !Number.isInteger(idx) || idx < 1 || idx > MAX_DM_SEGMENTS) return;
        const cid = String(d.oid);
        // Only keep segments for the video being (or about to be) analysed.
        const cur = (state.video && String(state.video.cid)) || (state.bridgeState && String(state.bridgeState.cid));
        if (cur && cur !== cid) return;
        if (!state.preloadedDm.has(cid)) state.preloadedDm.set(cid, new Map());
        const m = state.preloadedDm.get(cid);
        if (!m.has(idx)) m.set(idx, BAS.decodeDmSeg(d.buffer));
        if (state.preloadedDm.size > 3) state.preloadedDm.delete(state.preloadedDm.keys().next().value);
      }
    } catch (e) { BAS.warn('bridge message failed', e); }
  }

  // ---------------------------------------------------------------- popup messages
  function onRuntimeMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string' || !msg.type.startsWith('BAS_')) return false;
    // Only our own extension pages (popup/options) talk to the content script.
    if (sender && sender.id && chromeOk() && sender.id !== chrome.runtime.id) return false;
    const v = state.video;
    const done = () => { try { sendResponse(publicState()); } catch (e) { /* channel closed */ } };
    const later = (p) => { p.then(done, done); return true; };
    try {
      switch (msg.type) {
        case 'BAS_GET_STATE': done(); return false;
        case 'BAS_SET_SEGMENT_ENABLED': {
          const seg = state.segments.find((x) => x.id === msg.id);
          if (seg && seg.ignored && msg.enabled && v) return later(BAS.storage.removeIgnore(v.bvid, v.cid, { start: seg.start, end: seg.end }).then(reloadOverrides));
          if (seg) { seg.enabled = !!msg.enabled; renderMarkers(); sendBadge(activeCount()); }
          done(); return false;
        }
        case 'BAS_SEEK': {
          if (state.videoEl && typeof msg.t === 'number' && isFinite(msg.t)) {
            state.videoEl.currentTime = Math.max(0, msg.t);
            if (state.videoEl.paused) state.videoEl.play().catch(() => {});
          }
          done(); return false;
        }
        case 'BAS_SKIP_HERE': {
          // reply at once; loading danmaku can take longer than the popup waits
          if (v) skipHere().catch(() => {});
          done(); return false;
        }
        case 'BAS_RESCAN': {
          // Reply right away (status 'loading'); the popup polls for the result.
          if (v) {
            BAS.storage.remove('local', BAS.storage.cacheKey(v.cid)).catch(() => {});
            state.lastDanmaku = null;
            detect(v, { force: true }).catch((e) => { state.status = 'error'; state.error = String(e && e.message || e); });
          }
          done(); return false;
        }
        case 'BAS_ADD_SEGMENT': {
          if (v && typeof msg.start === 'number' && typeof msg.end === 'number' && isFinite(msg.start) && isFinite(msg.end) && msg.end > msg.start) {
            return later(BAS.storage.addUser(v.bvid, v.cid, { start: msg.start, end: msg.end }).then(reloadOverrides));
          }
          done(); return false;
        }
        case 'BAS_IGNORE_SEGMENT': {
          const seg = state.segments.find((x) => x.id === msg.id) || state.dropped.find((x) => x.id === msg.id);
          if (v && seg) return later(BAS.storage.addIgnore(v.bvid, v.cid, { start: seg.start, end: seg.end }).then(reloadOverrides));
          done(); return false;
        }
        case 'BAS_CLEAR_OVERRIDES': {
          if (v) return later(BAS.storage.clearOverrides(v.bvid, v.cid).then(reloadOverrides));
          done(); return false;
        }
        default: return false;
      }
    } catch (e) { try { sendResponse({ ok: false, status: 'error', error: String(e && e.message || e) }); } catch (_) { /* ignore */ } return false; }
  }

  // ---------------------------------------------------------------- settings / storage changes
  let prevSettingsJson = null;
  function onSettingsChanged(next) {
    const prevJson = prevSettingsJson; prevSettingsJson = JSON.stringify(next);
    if (!prevJson) return;
    let prev = {}; try { prev = JSON.parse(prevJson); } catch (e) { /* ignore */ }
    const changed = (k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]);

    if (changed('enabled') || changed('skipHereButton')) syncSkipHereButton();
    if (changed('enabled') && !next.enabled) {
      abortDetection();
      state.status = 'disabled'; state.segments = []; clearUi(); sendBadge(0); destroyMedia();
      return;
    }
    if (state.videoEl) ensureMedia(state.videoEl);
    if ((changed('enabled') && next.enabled) || changed('ignoreUps') || changed('useDanmaku')) {
      if (state.video) detect(state.video, { force: true }).catch(() => {});
      return;
    }
    if (['extraStartKeywords', 'extraEndKeywords', 'useChapters'].some(changed)) { redetectDebounced(); return; }
    if (changed('useHeat') && next.useHeat && !state.heat && state.video) { detect(state.video, { force: true }).catch(() => {}); return; }
    if (['minConfidence', 'showMarkers', 'mode', 'useMedia', 'useAudio', 'useHeat'].some(changed)) applyFusion('settings');
  }
  function onStorageChanged(changes, area) {
    if (area !== 'local' || !state.video) return;
    const key = BAS.storage.overrideKey(state.video.bvid, state.video.cid);
    if (Object.prototype.hasOwnProperty.call(changes, key)) reloadOverrides();
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    try { await BAS.storage.loadSettings(); } catch (e) { BAS.warn('settings load failed', e); }
    prevSettingsJson = JSON.stringify(settings());
    try { BAS.storage.onSettingsChanged((s) => { BAS.state.settings = s; onSettingsChanged(s); }); } catch (e) { /* ignore */ }
    try { BAS.storage.onChanged && BAS.storage.onChanged(onStorageChanged); } catch (e) { /* ignore */ }

    window.addEventListener('message', onBridgeMessage);
    try { window.postMessage({ __bas: true, type: 'BAS_REQUEST_STATE' }, location.origin); } catch (e) { /* ignore */ }
    if (chromeOk()) { try { chrome.runtime.onMessage.addListener(onRuntimeMessage); } catch (e) { /* ignore */ } }

    window.addEventListener('popstate', () => { disarmIfUrlChanged(); setTimeout(tick, 50); });
    // A 1 s poll covers everything the bridge cannot report (element swaps, lazily rendered progress bar).
    // There is deliberately no MutationObserver on the player: bilibili's danmaku layer mutates it constantly.
    setInterval(tick, 1000);
    setTimeout(tick, 300);
    document.addEventListener('durationchange', (e) => { if (e.target === state.videoEl) renderMarkers(); }, true);

    BAS.log(`v${BAS.VERSION} ready`);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
