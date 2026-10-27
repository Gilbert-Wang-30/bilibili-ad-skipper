/* Bilibili Ad Skipper — what the danmaku and the viewer-heat curve say about a moment of the video, as numbers for the
 * learned models (the subtitle line model in 28-detect-subtitles.js, the time-bin model for videos without subtitles).
 * No AI: counts of classified danmaku (31-detect-danmaku.js classify: jump cues and their targets, ad announcements,
 * landing thanks) in windows around the moment, the hand-written danmaku detector's own verdict there, and the heat
 * curve's level and slope. Pure; no DOM / chrome.*.
 */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS || BAS.mediaFeatures) return;

  const MEDIA_D = 19;
  const JUMP_BACK = 240;      // s: jump cues posted this long before a moment can point past it
  const JUMP_FAR = 600;       // s: … and no further than this past it

  const lowerBound = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const k = (lo + hi) >> 1; if (a[k] < x) lo = k + 1; else hi = k; } return lo; };

  /**
   * danmaku: [{t, text, action?}] (any order), heat: the parsed heat curve (BAS.detectHeat.parse) or null.
   * Returns the per-video index mediaAt reads; reusable for every line / bin.
   */
  function prepareMedia(danmaku, heat, duration, settings) {
    const dur = duration > 0 ? duration : 0;
    // time and text only: the models were trained on the danmaku XML pool, which has no 'airborne' actions
    const list = (Array.isArray(danmaku) ? danmaku : []).filter((d) => d && isFinite(d.t) && typeof d.text === 'string').map((d) => ({ t: +d.t, text: d.text })).sort((a, b) => a.t - b.t);
    const n = list.length;
    const t = new Float64Array(n), vocab = new Float64Array(n + 1), endW = new Float64Array(n + 1), ann = new Float64Array(n + 1), soft = new Float64Array(n + 1);
    const cues = [];                    // [posted at, target, weak]
    const D = BAS.detectDanmaku;
    for (let i = 0; i < n; i++) {
      const d = list[i];
      t[i] = d.t;
      let c = null;
      try { c = D && D.classify ? D.classify(d.text, d.t, dur) : null; } catch (e) { c = null; }
      vocab[i + 1] = vocab[i] + (c ? c.vocabW || 0 : 0);
      endW[i + 1] = endW[i] + (c ? c.endW || 0 : 0);
      ann[i + 1] = ann[i] + (c && c.startClass === 'announce' && !c.negated ? 1 : 0);
      soft[i + 1] = soft[i] + (c && (c.startClass === 'moment' || c.startClass === 'bare' || c.startClass === 'weak') ? 1 : 0);
      if (c && Array.isArray(c.targets)) for (const x of c.targets) if (x && isFinite(x.target) && !x.poi) cues.push([d.t, +x.target, !!x.weak]);
    }
    // the hand-written detector's segments (confidence, offer-only halved)
    let segs = [];
    try { segs = D ? (D(list, dur, settings || BAS.DEFAULT_SETTINGS).candidates || []) : []; } catch (e) { segs = []; }
    let ha = null;
    try { ha = heat && BAS.detectHeat ? BAS.detectHeat.analyse(heat, dur) : null; } catch (e) { ha = null; }
    return { dur, n, t, vocab, endW, ann, soft, cues, segs, heat: heat || null, ha };
  }

  /** Fills out[off … off + MEDIA_D) with the features of the moment [a, b] (seconds). */
  function mediaAt(X, a, b, out, off) {
    const len = Math.max(0.5, b - a), rate = X.dur > 0 ? X.n / X.dur : 0;
    const cnt = (lo, hi) => lowerBound(X.t, hi) - lowerBound(X.t, lo);
    const sum = (arr, lo, hi) => arr[lowerBound(X.t, hi)] - arr[lowerBound(X.t, lo)];
    out[off] = Math.log1p(X.n);
    out[off + 1] = rate > 0 ? Math.min(10, cnt(a - 10, b + 10) / (len + 20) / rate) : 0;
    out[off + 2] = sum(X.vocab, a - 30, b + 30);
    out[off + 3] = sum(X.vocab, a - 90, a);
    let over = 0, overWeak = 0, landNear = 0;
    for (const [at, target, weak] of X.cues) {
      if (at >= a - JUMP_BACK && at <= b && target > b + 2 && target <= b + JUMP_FAR) { if (weak) overWeak++; else over++; }
      if (!weak && target >= a - 15 && target <= b + 15 && at < a) landNear++;
    }
    out[off + 4] = over; out[off + 5] = over + overWeak; out[off + 6] = landNear;
    out[off + 7] = sum(X.endW, b, b + 60);
    out[off + 8] = sum(X.endW, a - 60, a);
    out[off + 9] = sum(X.ann, a - 60, b + 10);
    out[off + 10] = sum(X.soft, a - 30, b + 30);
    let conf = 0, inSeg = 0, nearEnd = 0;
    const m = (a + b) / 2;
    for (const s of X.segs) {
      if (m >= s.start && m <= s.end) { const c = (+s.confidence || 0) * (s.offerOnly ? 0.5 : 1); if (c > conf) conf = c; inSeg = 1; }
      if (Math.abs(b - s.end) <= 10) nearEnd = 1;
    }
    out[off + 11] = conf; out[off + 12] = inSeg; out[off + 13] = nearEnd;
    const H = X.heat, A = X.ha;
    if (A && A.usable && H && Array.isArray(H.values) && H.step > 0) {
      const v = H.values, s = H.step, at = (x) => v[Math.max(0, Math.min(v.length - 1, Math.floor(x / s)))];
      out[off + 14] = 1;
      out[off + 15] = Math.min(20, at(m) / A.base);
      out[off + 16] = Math.max(-20, Math.min(20, (at(m + s) - at(m - s)) / A.base));
      let ahead = 0; for (let x = m; x <= m + 60; x += s) ahead = Math.max(ahead, at(x));
      out[off + 17] = Math.min(20, ahead / A.base);
      let run = 0; for (const r of A.runs || []) if (m >= r.start && m <= r.end) run = Math.max(run, r.adLike ? 2 : 1);
      out[off + 18] = run;
    } else { out[off + 14] = 0; out[off + 15] = 0; out[off + 16] = 0; out[off + 17] = 0; out[off + 18] = 0; }
  }

  const BIN_D = MEDIA_D + 6;
  /** Features of time bin [a, b] for the bin model: the moment's media features, where it sits, the danmaku rate. */
  function binRow(X, a, b, hasBody, out, off) {
    mediaAt(X, a, b, out, off);
    const k = off + MEDIA_D, dur = X.dur;
    out[k] = (a + b) / 2 / Math.max(1, dur); out[k + 1] = Math.log(Math.max(1, dur)); out[k + 2] = Math.log1p(a); out[k + 3] = Math.log1p(Math.max(0, dur - b));
    out[k + 4] = X.n / Math.max(1, dur); out[k + 5] = hasBody ? 1 : 0;
  }
  /** The bins of a video and their feature rows (Float32Array n × BIN_D). */
  function binMatrix(X, bin, hasBody) {
    const n = Math.max(1, Math.ceil(X.dur / bin)), F = new Float32Array(n * BIN_D), L = [];
    for (let i = 0; i < n; i++) { const a = i * bin, b = Math.min(X.dur, a + bin); binRow(X, a, b, hasBody, F, i * BIN_D); L.push({ a, b, gap: 0 }); }
    return { F, L, n };
  }

  /**
   * Ads from the danmaku and the heat curve alone (for videos without subtitles): every BIN s scored by the model's `bins`
   * trees, joined by the two-state segmenter, each stretch scored as a whole. Same candidate shape as the other detectors.
   */
  function detectBins(danmaku, heat, duration, settings, opts) {
    const M = BAS.subtitleModel && BAS.subtitleModel.bins, D = BAS.detectSubtitles;
    if (!M || !D || !(duration > 0)) return { candidates: [] };
    const X = prepareMedia(danmaku, heat, duration, settings);
    if (!X.n && !(X.ha && X.ha.usable)) return { candidates: [] };
    const B = binMatrix(X, M.bin, !!(opts && opts.hasBody));
    const G = new Float64Array(B.n);
    for (let i = 0; i < B.n; i++) G[i] = D.predictTrees(M.trees, B.F, i * BIN_D);
    const P = M.params, out = [];
    for (const [i0, i1] of D.segment(B.L, G, P)) {
      const start = B.L[i0].a, end = Math.min(duration, B.L[i1].b);
      if (end - start < 8 || end - start > 420) continue;
      let s = 0, mx = -Infinity; for (let k = i0; k <= i1; k++) { const e = G[k] - P.prior; s += e; if (e > mx) mx = e; }
      const x = [1, s / (i1 - i0 + 1), mx, Math.log(end - start + 1), start / duration, opts && opts.hasBody ? 1 : 0];
      let z = 0; for (let j = 0; j < x.length; j++) z += M.read[j] * x[j];
      const p = 1 / (1 + Math.exp(-z));
      if (p < P.offer) continue;
      const auto = p >= P.auto;
      out.push({
        start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, source: 'danmaku', sources: ['danmaku'],
        confidence: auto ? Math.min(0.9, 0.7 + 0.2 * (p - P.auto) / Math.max(1e-6, 1 - P.auto)) : 0.5,
        offerOnly: !auto || undefined, reason: `弹幕/热度模型：广告（${Math.round(p * 100)}%）`,
        evidence: { bins: { p: Math.round(p * 1000) / 1000 } },
      });
    }
    for (const c of out) if (!c.offerOnly) delete c.offerOnly;
    return { candidates: out };
  }

  BAS.mediaFeatures = { prepareMedia, mediaAt, binRow, binMatrix, detectBins, CONST: { MEDIA_D, BIN_D, JUMP_BACK, JUMP_FAR } };
})();
