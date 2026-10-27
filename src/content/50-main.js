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
  // A/V look-ahead (36-media-probe.js / 37-av-segment.js)
  const AV_CTX = 45;                  // seconds of context fetched on each side of a suspected segment
  const AV_MAX_PROBES = 4;            // per video
  const AV_MAX_SPAN = 420;            // longer candidates are not probed
  const AV_VIDEO_MAX_SPAN = 330;      // above this (incl. context) only the audio track is fetched
  const AV_SKIP_HERE_MS = 10000;      // the skip button waits at most this long for the A/V answer
  const AV_MAX_BYTES = 60 * 1024 * 1024;   // background look-ahead budget per video
  const SUB_WAIT_MS = 4000;           // wait this long for the player's own info (it lists the subtitle files)
  const SKIP_WAIT_MS = 2500;          // the skip button never waits longer than this for danmaku / subtitles

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
    bridgeSubs: new Map(),     // cid(string) -> {list:[{lan,url}], signed} subtitle files listed in the player's own request
    subtitles: null,           // {cid, lines, lan} — prepared AI subtitle lines of the current video (skip button)
    heat: null,                // parsed 高能进度条 curve for the current video {step, values, events}
    heatAnalysis: null,        // BAS.detectHeat.analyse(heat)
    lastDanmaku: null,         // {cid, list} — kept so keyword edits can re-run detection without re-downloading
    av: new Map(),             // candidate key → BAS.avSegment.assess() result (look-ahead A/V verdicts)
    avWanted: [],              // candidates (before A/V) that could be probed
    avTried: new Set(),
    avBusy: null,              // runId of the probe loop that is running
    avErrors: 0,
    avBytes: 0,
    cacheable: false,          // detection results were complete, so A/V results may be cached with them
    cacheTs: 0,                // when those results were detected (A/V updates must not make stale results look fresh)
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
      stats: Object.assign({}, state.stats, { cuts: state.media ? state.media.cuts.length : 0, av: { probed: state.av.size, busy: state.avBusy != null, bytes: state.avBytes } }),
      currentTime,
      duration: duration || (state.video && state.video.duration) || null,
    };
  }
  /** Cached candidates do not need the (large) evidence arrays. */
  const slimCandidate = (c) => {
    const o = Object.assign({}, c);
    const ev = c.evidence || {};
    o.evidence = { targetsAgree: ev.targetsAgree, adVocab: ev.adVocab, strongEnd: ev.strongEnd, mediumEnd: ev.mediumEnd, endZone: ev.endZone,
      nTargets: Array.isArray(ev.targets) ? ev.targets.length : ev.nTargets };
    return o;
  };

  const slimAv = (r) => ({ verdict: r.verdict, score: r.score, z: r.z, start: r.start, end: r.end, startBy: r.startBy, endBy: r.endBy });

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
        label: seg.offerOnly ? offerLabel(seg) : '跳过广告',
        sub: `${fmtTime(seg.start)} → ${fmtTime(seg.end)}`,
        onClick: () => { try { state.skipper && state.skipper.skipNow(seg); } catch (e) { /* ignore */ } },
      });
    } catch (e) { /* ignore */ }
  }
  /** Who suggests an offered segment: the button names the source. */
  function offerLabel(seg) {
    const src = Array.isArray(seg.sources) && seg.sources.length ? seg.sources : [seg.source];
    if (src.includes('danmaku')) return '弹幕建议跳过';
    if (src.includes('subtitle')) return '字幕建议跳过';
    if (src.includes('crowd')) return '众包建议跳过';
    return '建议跳过';
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
    // Several seconds can pass below (danmaku download, A/V analysis): if the viewer seeks meanwhile, do nothing.
    let seeked = false;
    const onSeeking = () => { seeked = true; };
    // same video, same element, same page, no seek since the press
    const stillHere = () => !seeked && !!state.video && state.video.cid === info.cid && state.videoEl === v && urlShowsVideo(info);
    try { v.addEventListener('seeking', onSeeking); } catch (e) { /* ignore */ }
    try {
      let list = state.lastDanmaku && state.lastDanmaku.cid === info.cid ? state.lastDanmaku.list : null;
      const subsOn = settings().useSubtitles !== false;
      let subs = subsOn && state.subtitles && state.subtitles.cid === String(info.cid) ? state.subtitles.lines : null;
      const wantSubs = !subs && subsOn && !!BAS.detectSubtitles;
      if (!list || wantSubs) {
        // results came from the cache: load what is missing, but never hold the press up for long
        const wait = BAS.ui ? BAS.ui.showToast({ text: '正在查找广告结尾…', durationMs: SKIP_WAIT_MS + 1000, force: true }) : null;
        const deadline = (p) => Promise.race([p, new Promise((res) => setTimeout(() => res(null), SKIP_WAIT_MS))]);
        const tasks = [];
        if (!list) {
          const preloaded = state.preloadedDm.get(String(info.cid));
          tasks.push(deadline(BAS.api.getDanmaku(info.aid, info.cid, info.duration, { preloaded }).then((l) => {
            if (state.video && state.video.cid === info.cid) state.lastDanmaku = { cid: info.cid, list: l };
            return l;
          })).then((l) => { list = l; }).catch((e) => { BAS.debug('skip-here: danmaku unavailable', e); }));
        }
        if (wantSubs) tasks.push(deadline(loadSubtitles(info, null)).then((x) => { subs = x && x.lines; }).catch(() => {}));
        await Promise.all(tasks);
        if (wait) wait.close();
        if (!list) list = [];
        if (!stillHere()) return null;
      }
      const dur = info.duration || (isFinite(v.duration) ? v.duration : 0);
      let r = BAS.findAdEnd({
        t, duration: dur, danmaku: list, heat: state.heatAnalysis,
        boundaries: state.boundaries, candidates: knownSpans(), subtitles: subs,
      });
      if (!r) { if (BAS.ui) BAS.ui.showToast({ text: '已接近视频结尾', force: true }); return null; }
      // Unless the press is inside a segment we already know, measure the end from the video's own audio/picture:
      // on the measured ads this lands within 2.5 s of the real end from anywhere inside the ad.
      if (r.source !== 'candidate' && skipHereMediaAvailable()) {
        const wait = BAS.ui ? BAS.ui.showToast({ text: '正在分析音视频，寻找广告结尾…', durationMs: AV_SKIP_HERE_MS + 2000, force: true }) : null;
        let f = null;
        try { f = await avFindEnd(info, t, dur); } catch (e) { BAS.debug('skip-here: A/V failed', e); }
        if (wait) wait.close();
        if (!stillHere()) return null;
        let nowAv = t;
        try { nowAv = v.currentTime; } catch (e) { /* ignore */ }
        if (f && f.t <= nowAv + 1) { if (BAS.ui) BAS.ui.showToast({ text: '广告已经结束', force: true }); return null; }
        if (f) r = { end: f.t, start: r.start, source: 'av', reason: '音视频：广告结束处的转场（静音 + 切镜）', evidence: { score: f.score } };
      }
      // Waiting (danmaku download, A/V analysis) let playback run on: judge the answer against the position now.
      let now = t;
      try { now = v.currentTime; } catch (e) { /* ignore */ }
      if (r.end <= now + 1) {
        // a real end estimate that is already behind us means the ad is over; only a blind step is recomputed
        if (r.source !== 'fallback') { if (BAS.ui) BAS.ui.showToast({ text: '广告已经结束', force: true }); return null; }
        const again = BAS.findAdEnd({ t: now, duration: dur, danmaku: list, heat: state.heatAnalysis, boundaries: state.boundaries, candidates: knownSpans(), subtitles: subs });
        if (!again) { if (BAS.ui) BAS.ui.showToast({ text: '已接近视频结尾', force: true }); return null; }
        r = Object.assign({}, again, { start: Math.min(again.start, r.start) });
      }
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
    } finally {
      skipHereBusy = false;
      try { v.removeEventListener('seeking', onSeeking); } catch (e) { /* ignore */ }
    }
  }
  /** Everything known about this video for the skip button (crowd marks and subtitle reads only while enabled). */
  const knownSpans = () => {
    const s = settings();
    const only = (src) => (c) => c.source === src && (c.sources || [src]).every((x) => x === src);
    return [].concat(state.segments, state.dropped, state.candidates)
      .filter((c) => (s.useCrowd !== false || !only('crowd')(c)) && (s.useSubtitles !== false || !only('subtitle')(c)));
  };
  const avAvailable = () => { const s = settings(); return s.enabled && s.useAvProbe !== false && !!BAS.mediaProbe && !!BAS.avSegment && typeof fetch === 'function'; };
  const skipHereMediaAvailable = () => { const s = settings(); return s.enabled && s.skipHereMedia !== false && !!BAS.mediaProbe && !!BAS.avSegment && typeof fetch === 'function'; };
  function mergeProbe(a, b) {
    const lastA = a.audio.length ? a.audio[a.audio.length - 1].t : -Infinity, lastV = a.video.length ? a.video[a.video.length - 1].t : -Infinity;
    return { audio: a.audio.concat(b.audio.filter((x) => x.t > lastA)), video: a.video.concat(b.video.filter((x) => x.t > lastV)) };
  }
  /** Fetch the media after t in two steps and return the first transition that looks like the ad's end (or null). */
  async function avFindEnd(info, t, dur) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), AV_SKIP_HERE_MS);
    let data = { audio: [], video: [] };
    try {
      for (const [a, b] of [[t - 25, t + 130], [t + 115, t + 300]]) {
        const t0 = Math.max(0, a), t1 = dur > 0 ? Math.min(dur - 0.5, b) : b;
        if (t1 <= t0 + 10 || ac.signal.aborted) break;
        const p = await BAS.mediaProbe.probe(info, t0, t1, { signal: ac.signal, headersMs: 3000 });
        if (p.errors.length) BAS.debug('skip-here A/V', p.errors);
        data = mergeProbe(data, p);
        const f = BAS.avSegment.findEnd(data, t);
        if (!f) return null;
        if (!f.pending) return f;
      }
      return null;
    } finally { clearTimeout(timer); }
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
      const media = s.useMedia ? state.media : null;
      const r = BAS.buildSegments({
        candidates: state.candidates, duration: dur, boundaries: state.boundaries, heatAnalysis: state.heatAnalysis,
        av: state.av, media, overrides: state.overrides, settings: s,
      });
      const segs = r.segments, dropped = r.dropped;
      state.avWanted = r.avWanted;
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
    if (reason !== 'av') setTimeout(runAvProbes, 0);
  }

  // ---------------------------------------------------------------- A/V look-ahead of suspected segments
  function pickAvCandidate() {
    if (state.avTried.size >= AV_MAX_PROBES) return null;
    let now = 0;
    try { now = state.videoEl ? state.videoEl.currentTime || 0 : 0; } catch (e) { /* ignore */ }
    const { key, isOpen } = BAS.avSegment, OPEN = BAS.avSegment.CONST.OPEN_SPAN;
    const list = state.avWanted.filter((c) => {
      if (state.av.has(key(c)) || state.avTried.has(key(c))) return false;
      const end = isOpen(c) ? c.start + OPEN : c.end;
      return end - c.start <= AV_MAX_SPAN && end > now + 5;
    });
    // auto-skip candidates first (a wrong one costs the viewer content), then offers; earliest first
    list.sort((a, b) => (!!a.offerOnly - !!b.offerOnly) || a.start - b.start);
    return list[0] || null;
  }
  /** Probe suspected segments one at a time in the background; each result re-runs fusion. */
  async function runAvProbes() {
    if (state.avBusy === state.runId || !avAvailable() || !state.video || state.status !== 'ready') return;
    const info = state.video, runId = state.runId, signal = state.abort ? state.abort.signal : undefined;
    state.avBusy = runId;   // a loop of an older run may still be unwinding; it stops at its next check
    try {
      for (;;) {
        if (!state.video || state.video.cid !== info.cid || runId !== state.runId || !avAvailable()) break;
        if (state.avBytes >= AV_MAX_BYTES) { BAS.debug('A/V budget used up for this video'); break; }
        const c = pickAvCandidate();
        if (!c) break;
        const k = BAS.avSegment.key(c);
        state.avTried.add(k);
        const dur = info.duration || 0;
        const open = BAS.avSegment.isOpen(c);
        const reach = open ? c.start + BAS.avSegment.CONST.OPEN_SPAN + 20 : c.end + AV_CTX;
        const t0 = Math.max(0, c.start - AV_CTX), t1 = dur > 0 ? Math.min(dur - 0.5, reach) : reach;
        const T = Date.now();
        let data;
        try {
          data = await BAS.mediaProbe.probe(info, t0, t1, { video: t1 - t0 <= AV_VIDEO_MAX_SPAN, signal });
        } catch (e) {
          state.avBytes += (e && e.bytes) || 0;
          if (e && e.name === 'AbortError') break;
          BAS.debug('A/V probe failed', e);
          if (++state.avErrors >= 2) break;
          continue;
        }
        state.avBytes += data.bytes || 0;
        if (runId !== state.runId || !state.video || state.video.cid !== info.cid || !urlShowsVideo(info)) break;
        if (data.errors.length) BAS.debug('A/V probe', data.errors);
        // nothing could be fetched or decoded: not a verdict (keep it out of the cache; retried on the next visit)
        if (!data.audio.length && data.errors.length) { if (++state.avErrors >= 2) break; continue; }
        const step = state.heatAnalysis && state.heatAnalysis.step;
        const r = open ? BAS.avSegment.assessOpen(data, c.start)
          : BAS.avSegment.assess(data, c.start, c.end, { endRadius: c.source === 'heat' ? Math.max(8, Math.min(30, step || 8)) : undefined });
        state.av.set(k, slimAv(r));
        BAS.log(`A/V ${fmtTime(c.start)}–${open ? '?' : fmtTime(c.end)}: ${r.verdict} (${r.score})` + (r.endBy && r.end != null ? ` end → ${fmtTime(r.end)}` : '') + ` in ${Date.now() - T} ms`);
        applyFusion('av');
        if (state.cacheable) cacheResults(info);
      }
    } finally {
      if (state.avBusy === runId) state.avBusy = null;
      if (runId !== state.runId) setTimeout(runAvProbes, 0);   // the next video's loop may have been turned away
    }
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
  /** A/V verdicts of the current candidates only (keys drift as danmaku arrive), newest last. */
  function avForCache() {
    if (!BAS.avSegment) return [];
    const live = new Set(state.avWanted.map(BAS.avSegment.key));
    return Array.from(state.av.entries()).filter(([k]) => live.has(k)).slice(-20);
  }
  function cacheResults(info) {
    BAS.storage.setCache(info.cid, {
      version: BAS.VERSION, ts: state.cacheTs || Date.now(),
      candidates: state.candidates.map(slimCandidate), boundaries: state.boundaries, viewPoints: state.viewPoints, stats: state.stats,
      heat: state.heat,
      av: avForCache(),
    }).catch(() => {});
  }

  /**
   * The AI subtitles of this video: the file the player itself lists (bridge), downloaded once from bilibili's subtitle
   * CDN. A file whose last line is far from the video's end belongs to another video and is ignored.
   * @returns {Promise<{lines: object[]|null, lan?: string, note: string}>}
   */
  async function loadSubtitles(info, signal) {
    const cid = String(info.cid);
    if (state.subtitles && state.subtitles.cid === cid) return { lines: state.subtitles.lines, lan: state.subtitles.lan, note: '已读取' };
    let entry = state.bridgeSubs.get(cid);
    for (let waited = 0; !entry && waited < SUB_WAIT_MS; waited += 250) {
      await new Promise((r) => setTimeout(r, 250));
      if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      entry = state.bridgeSubs.get(cid);
    }
    // an AI subtitle file is named after its video (/bfs/ai_subtitle/prod/<aid><cid><hash>): a listing that names
    // another video's file (an unsigned request can get one) is not used
    const ownFile = (p) => !p || !/ai_subtitle/.test(p.url) || !info.aid || p.url.includes(String(info.aid) + String(info.cid));
    let pick = entry ? BAS.api.pickSubtitle(entry.list) : null;
    if (!ownFile(pick)) pick = null;
    let signed = !!(entry && entry.signed), via = 'player';
    if (!pick && BAS.api.getDmViewSubtitles && info.aid) {
      // signed out (the player lists AI subtitles only to signed-in viewers), or its request was missed;
      // a failed lookup is a failure (retried next time), not "this video has no subtitles"
      const list = await BAS.api.getDmViewSubtitles(info.aid, info.cid, { signal });
      pick = BAS.api.pickSubtitle(list);
      if (!ownFile(pick)) pick = null;
      signed = true; via = 'dm/view';
    }
    if (!pick) return { lines: null, note: entry && entry.list.length ? '没有中文字幕' : '视频没有 AI 字幕' };
    const body = await BAS.api.getSubtitleBody(pick.url, { signal });
    const dur = +info.duration || 0;
    const last = body.length ? body[body.length - 1].to : 0;
    const slack = signed ? Math.max(60, 0.25 * dur) : Math.max(30, 0.1 * dur);
    if (!body.length || (dur > 0 && (last > dur + 5 || last < dur - slack))) return { lines: null, note: `字幕与视频时长不符（${Math.round(last)} / ${Math.round(dur)} 秒），已忽略` };
    const lines = BAS.detectSubtitles.prepare(body, dur);
    if (state.video && String(state.video.cid) === cid) state.subtitles = { cid, lines, lan: pick.lan };
    return { lines, lan: pick.lan + (via === 'dm/view' ? '*' : ''), note: '' };
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
    if (state.subtitles && state.subtitles.cid !== String(info.cid)) state.subtitles = null;
    state.av = new Map(); state.avWanted = []; state.avTried = new Set(); state.avErrors = 0; state.avBytes = 0;
    state.cacheable = false; state.cacheTs = 0;
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
        if (Array.isArray(cached.av)) for (const e of cached.av) if (Array.isArray(e) && typeof e[0] === 'string' && e[1] && typeof e[1] === 'object') state.av.set(e[0], e[1]);
        state.cacheable = true; state.cacheTs = cached.ts || Date.now();
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

    const crowdP = (async () => {
      if (!BAS.detectCrowd || s.useCrowd === false || !info.bvid) return { candidates: [] };
      const segs = await BAS.api.getCrowdSegments(info.bvid, { signal: ac.signal });
      return BAS.detectCrowd(segs, { cid: info.cid, duration: info.duration, parts: info.parts });
    })().catch((e) => { BAS.log('众包片段库查询失败：' + ((e && e.message) || e)); return { candidates: [], failed: true }; });
    // marks known from the cache survive a failed lookup during the hourly refresh
    const cachedCrowd = () => state.candidates.filter((c) => c.source === 'crowd');

    const subtitleP = (async () => {
      if (!BAS.detectSubtitles || s.useSubtitles === false) return { candidates: [], note: '关闭' };
      const got = await loadSubtitles(info, ac.signal);
      if (!got.lines) return { candidates: [], note: got.note };
      const r = BAS.detectSubtitles(got.lines, info.duration, s);
      return { candidates: r.candidates, note: `${got.lan} ${r.lines} 句→${r.candidates.length}` };
    })().catch((e) => {
      if (e && e.name === 'AbortError') return { candidates: [], note: '已取消', failed: true };
      BAS.log('字幕读取失败：' + ((e && e.message) || e));
      return { candidates: [], note: '读取失败', failed: true };
    });
    const cachedSubtitle = () => state.candidates.filter((c) => c.source === 'subtitle');

    const [ch, dm, heat, crowd, sub] = await Promise.all([chaptersP, danmakuP, heatP, crowdP, subtitleP]);
    if (!alive()) { if (!settings().enabled && runId === state.runId) { state.status = 'disabled'; clearUi(); sendBadge(0); } return; }

    const crowdCands = crowd.failed ? cachedCrowd() : crowd.candidates;
    const subCands = sub.failed ? cachedSubtitle() : sub.candidates;
    state.candidates = [].concat(ch.candidates, crowdCands, subCands, dm.candidates);
    state.stats.crowd = crowdCands.length;
    state.stats.subtitle = subCands.length;
    state.boundaries = ch.boundaries; state.viewPoints = ch.viewPoints || [];
    if (heat) { state.heat = heat; state.heatAnalysis = BAS.detectHeat.analyse(heat, info.duration); }
    state.stats.heat = state.heatAnalysis ? { step: state.heatAnalysis.step, usable: state.heatAnalysis.usable, adRuns: state.heatAnalysis.runs.filter((r) => r.adLike).length } : null;
    state.stats.danmakuCount = dm.count; state.stats.viewPoints = state.viewPoints.length; state.stats.missingSegments = dm.missing || [];
    const errMsg = (e) => String((e && e.message) || e || '未知错误');
    if (dm.error) { state.status = 'error'; state.error = errMsg(dm.error); }
    else if (ch.error && !s.useDanmaku) { state.status = 'error'; state.error = errMsg(ch.error); }
    else { state.status = 'ready'; state.error = null; }
    applyFusion('detect');
    logSummary(info, [
      `章节 ${ch.candidates.length}`,
      `众包 ${crowd.failed ? '查询失败' : crowdCands.length}`,
      `字幕 ${sub.note}`,
      `弹幕 ${dm.count} 条→${dm.candidates.length}`,
      `热度 ${state.heat ? '有' : '无'}`,
    ]);
    // Only complete results are cached; failures and partial danmaku are retried on the next visit.
    // a failed crowd lookup is not "no marks": leave it out of the cache so the next visit asks again
    state.cacheable = !dm.error && !ch.error && !(dm.missing && dm.missing.length) && !(crowd.failed && !crowdCands.length) && !(sub.failed && !subCands.length);
    if (state.cacheable) { state.cacheTs = Date.now(); cacheResults(info); }
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
      const kept = state.candidates.filter((c) => c.source === 'crowd' || c.source === 'subtitle');
      state.candidates = [].concat(ch.candidates || [], kept, dm.candidates || []);
      state.boundaries = ch.boundaries || state.boundaries;
      applyFusion('keywords');
      if (state.status === 'ready') { state.cacheTs = Date.now(); cacheResults(info); }
    } catch (e) { BAS.warn('re-detect failed', e); }
  }
  const redetectDebounced = debounce(redetectFromMemory, 1200);

  // ---------------------------------------------------------------- identity tracking
  async function resolveIdentity() {
    const bs = state.bridgeState;
    const u = parseUrlIdentity();
    if (bs && bs.cid && (!u || !u.bvid || String(bs.bvid) === String(u.bvid)) && (!u || Number(bs.p || 1) === Number(u.p || 1))) {
      return { bvid: bs.bvid, aid: bs.aid, cid: bs.cid, p: bs.p || 1, title: bs.title, duration: bs.duration, mid: bs.mid, upName: bs.upName, parts: bs.parts };
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
      const info = { bvid: v.bvid, aid: v.aid, cid: (page && page.cid) || v.cid, p: u.p, title: v.title, duration: (page && page.duration) || v.duration, mid: v.owner && String(v.owner.mid), upName: v.owner && v.owner.name, parts: Array.isArray(v.pages) ? v.pages.length : null };
      state.urlInfo = { key, info };
      return info;
    } catch (e) {
      BAS.warn('getView failed', e);
      state.urlInfo = { key, info: null, failedAt: Date.now() };
      return null;
    }
  }

  /** Called synchronously on URL changes: never let the previous video's segments fire on the new one. */
  function urlShowsVideo(v) {
    const u = parseUrlIdentity();
    const sameVideo = !!u && ((u.bvid && String(u.bvid) === String(v.bvid)) || (u.aid && Number(u.aid) === Number(v.aid)));
    return sameVideo && Number(u.p || 1) === Number(v.p || 1);
  }
  function disarmIfUrlChanged() {
    const v = state.video;
    if (!v) return;
    if (!urlShowsVideo(v)) {
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
          parts: Array.isArray(st.pages) ? Math.min(999, st.pages.length) : null,
        };
        tick();
      } else if (d.type === 'BAS_PLAYER_INFO' && isId(d.cid)) {
        const vps = Array.isArray(d.view_points) ? d.view_points.slice(0, 200).filter((x) => x && typeof x === 'object') : [];
        state.bridgePlayerInfo.set(String(d.cid), vps);
        if (state.bridgePlayerInfo.size > 20) state.bridgePlayerInfo.delete(state.bridgePlayerInfo.keys().next().value);
        const subs = (Array.isArray(d.subtitles) ? d.subtitles.slice(0, 12) : [])
          .filter((x) => x && typeof x.lan === 'string' && typeof x.url === 'string').map((x) => ({ lan: x.lan.slice(0, 24), url: x.url.slice(0, 800) }));
        state.bridgeSubs.set(String(d.cid), { list: subs, signed: d.signed === true });
        if (state.bridgeSubs.size > 20) state.bridgeSubs.delete(state.bridgeSubs.keys().next().value);
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
    if (changed('useCrowd') && next.useCrowd && state.video && !state.candidates.some((c) => c.source === 'crowd')) { detect(state.video, { force: true }).catch(() => {}); return; }
    if (changed('useSubtitles') && next.useSubtitles !== false && state.video && !state.candidates.some((c) => c.source === 'subtitle')) { detect(state.video, { force: true }).catch(() => {}); return; }
    if (['minConfidence', 'showMarkers', 'mode', 'useMedia', 'useAudio', 'useHeat', 'useAvProbe', 'useCrowd', 'useSubtitles'].some(changed)) applyFusion('settings');
  }
  function onStorageChanged(changes, area) {
    if (area !== 'local' || !state.video) return;
    const key = BAS.storage.overrideKey(state.video.bvid, state.video.cid);
    if (Object.prototype.hasOwnProperty.call(changes, key)) reloadOverrides();
  }

  // ---------------------------------------------------------------- boot
  /**
   * An unpacked extension whose files were updated without pressing reload runs the new files under the OLD manifest:
   * new modules are never injected and new permissions never granted. Detect that (and a withheld crowd permission)
   * and say so on screen instead of silently degrading.
   */
  async function selfCheck() {
    if (!chromeOk()) return;
    let r = null;
    try { r = await new Promise((res) => { try { chrome.runtime.sendMessage({ type: 'BAS_PING' }, (x) => { void chrome.runtime.lastError; res(x || null); }); } catch (e) { res(null); } }); } catch (e) { r = null; }
    const problems = [];
    if (!r || !r.version) problems.push('后台服务没有响应');
    else if (r.version !== BAS.VERSION) problems.push(`文件已更新到 ${BAS.VERSION}，但 Chrome 还在运行 ${r.version}`);
    const missing = ['detectCrowd', 'buildSegments', 'detectHeat', 'findAdEnd', 'detectSubtitles', 'subtitleModel'].filter((k) => !BAS[k]);
    if (missing.length) problems.push('缺少模块 ' + missing.join('、'));
    if (r && r.crowdPermission === false && settings().useCrowd !== false) problems.push('没有访问 bsbsb.top（众包片段库）的权限');
    state.selfCheck = problems;
    if (!problems.length) return;
    BAS.warn('self-check:', problems.join('; '));
    const show = () => {
      if (!BAS.ui || !ensureUi()) return false;
      BAS.ui.showToast({ html: `<b>恰饭跳过需要重新加载</b><span class="bas-toast-sub">${escapeHtml(problems.join('；'))}。请打开 chrome://extensions，在本扩展上点「重新加载」（刷新图标）。</span>`, durationMs: 20000, force: true });
      return true;
    };
    if (!show()) setTimeout(show, 4000);
  }
  /** One line per video in the console: what each source found and what will be skipped. */
  function logSummary(info, parts) {
    const segs = state.segments.filter((x) => !x.ignored).map((x) => `${fmtTime(x.start)}–${fmtTime(x.end)} ${(x.sources || [x.source]).join('+')} ${Math.round(x.confidence * 100)}%${x.autoSkip ? ' 自动' : ' 按钮'}`);
    BAS.log(`${info.bvid}${info.p > 1 ? ' p' + info.p : ''}: ${parts.join(' · ')} → ${segs.length ? segs.join('；') : '无广告片段'}`);
  }

  async function boot() {
    try { await BAS.storage.loadSettings(); } catch (e) { BAS.warn('settings load failed', e); }
    setTimeout(selfCheck, 1500);
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
