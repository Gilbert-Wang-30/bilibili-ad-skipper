/* Bilibili Ad Skipper — player heat curve (高能进度条, bvc.bilivideo.com/pbp/data) analysis.
 *
 * The curve is ~100 samples per video (step = duration / ~99 s, 25 s for a 40-minute video) of viewer activity
 * (event_count is in the millions, far above the danmaku count). Measured on 6 sponsored segments whose boundaries
 * were checked frame by frame, an ad shows a distinctive shape: viewers drag forward through it and land ever closer
 * to its end, so the curve RAMPS UP across the ad (≥ 3 hot samples, mostly increasing), PEAKS in the sample that
 * contains the ad's end (alignment: value i covers ((i−1)·step, i·step]) and then falls off a CLIFF (3–9× drop).
 * Highlights people rewatch look different: a single spike, or a plateau that is not rising. Intros decay from t=0.
 *
 * Precision is about half a sample, so heat is used to CONFIRM danmaku candidates (and lift the confidence caps that
 * keep thin-danmaku candidates from auto-skipping), and on its own only as a manual skip OFFER, never an auto-skip.
 * Pure functions; no DOM / chrome.* access.
 */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS || BAS.detectHeat) return;
  const U = BAS.util;

  const HOT_K = 2.5;            // hot sample: value ≥ HOT_K × video median
  const CORR = { minN: 3, minDur: 30, minRamp: 0.4, maxPeakFromEnd: 2, minCliff: 2.5, maxFirstOverMax: 0.9, minRatio: 4 };
  const OFFER = { minN: 4, minDur: 60, minRamp: 0.5, maxPeakFromEnd: 1, minCliff: 3, maxFirstOverMax: 0.6, minRatio: 5, maxDur: 300 };
  const BOOST = 0.2;            // confidence added to a heat-confirmed danmaku candidate
  const BOOST_CAP = 0.85;
  const MIN_EVENTS = 20000;     // too little viewing activity → curve is noise
  const MAX_SPIKE = 3;
  const VETO_MIN_EVENTS = 200000; // popular enough that skipping an ad always shows up in the curve          // peak / previous sample; above this it is a jump-to-highlight spike, not an ad ramp

  /** Accepts the raw endpoint JSON (new {modules:[{params:{data}}]} or old {step_sec, events}) or a parsed object. */
  function parse(raw) {
    if (!raw || typeof raw !== 'object') return null;
    let d = raw;
    if (Array.isArray(raw.modules)) {
      const m = raw.modules.find((x) => x && x.params && x.params.data) || null;
      d = m ? m.params.data : null;
    }
    if (!d) return null;
    if (Array.isArray(d.values) && isFinite(d.step)) return { step: +d.step, values: d.values.map((x) => +x || 0), events: +d.events || 0 };
    const step = +d.step_sec;
    const values = d.events && Array.isArray(d.events.default) ? d.events.default.map((x) => +x || 0) : null;
    if (!(step > 0) || !values || values.length < 8) return null;
    let events = 0;
    try { events = +JSON.parse(d.debug || '{}').event_count || 0; } catch (e) { events = 0; }
    return { step, values, events };
  }

  /**
   * @param {{step:number, values:number[], events?:number}} heat
   * @returns {{step:number, base:number, usable:boolean, runs:Array<object>}}
   */
  function analyse(heat, duration) {
    const out = { step: 0, base: 0, usable: false, events: 0, runs: [] };
    if (!heat || !(heat.step > 0) || !Array.isArray(heat.values)) return out;
    const v = heat.values, n = v.length, s = heat.step;
    out.step = s; out.events = +heat.events || 0;
    if (n < 8 || (heat.events && heat.events < MIN_EVENTS)) return out;
    const core = v.slice(3, Math.max(4, n - 3)).filter((x) => isFinite(x)).sort((a, b) => a - b);
    const base = core.length ? core[core.length >> 1] : 0;
    if (!(base > 0)) return out;
    out.base = base; out.usable = true;
    const dur = duration > 0 ? duration : n * s;
    const hot = v.map((x, i) => i >= 2 && x >= HOT_K * base);
    for (let i = 0; i < n; i++) {
      if (!hot[i]) continue;
      let j = i;
      while (j + 1 < n && hot[j + 1]) j++;
      const seg = v.slice(i, j + 1);
      const max = Math.max(...seg);
      const pk = i + seg.indexOf(max);
      let inc = 0;
      for (let k = 1; k < seg.length; k++) if (seg[k] > seg[k - 1]) inc++;
      const next = j + 1 < n ? v[j + 1] : 0;
      const run = {
        i, j, n: j - i + 1,
        start: Math.max(0, (i - 1) * s), end: Math.min(dur, j * s),
        peakStart: Math.max(0, (pk - 1) * s), peakEnd: Math.min(dur, pk * s),
        ramp: seg.length > 1 ? inc / (seg.length - 1) : 0,
        firstOverMax: seg[0] / max,
        peakFromEnd: j - pk,
        cliff: Math.max(v[j], j > i ? v[j - 1] : 0) / Math.max(1, next),
        ratio: max / base,
        // ads ramp gradually (peak ≈ 1.2–1.5× the sample before it); a landing spike on a famous moment jumps ≥ 10×
        spike: pk > 0 ? max / Math.max(1, v[pk - 1]) : Infinity,
      };
      run.duration = run.n * s;
      run.adLike = shapeOk(run, CORR);
      run.offer = run.adLike && shapeOk(run, OFFER) && run.duration <= OFFER.maxDur && run.start > 0.05 * dur && run.end < dur - s;
      out.runs.push(run);
      i = j;
    }
    return out;
  }
  function shapeOk(r, t) {
    return r.n >= t.minN && r.duration >= t.minDur && r.ramp >= t.minRamp && r.peakFromEnd <= t.maxPeakFromEnd &&
      r.cliff >= t.minCliff && r.firstOverMax <= t.maxFirstOverMax && r.ratio >= t.minRatio && r.spike <= MAX_SPIKE;
  }

  /** The ad-like run (if any) whose peak brackets `end` and which covers most of [start, end]. */
  function matchRun(analysis, start, end) {
    if (!analysis || !analysis.usable || !isFinite(end)) return null;
    const s = analysis.step;
    let best = null;
    for (const r of analysis.runs) {
      if (!r.adLike) continue;
      if (end < r.peakStart - s || end > r.peakEnd + s) continue;
      const len = Math.max(1, end - start);
      if (U.overlap(start, end, r.start, r.end) / len < 0.4) continue;
      if (!best || r.ratio > best.ratio) best = r;
    }
    return best;
  }

  /**
   * Confirm danmaku candidates with the heat curve. Returns new candidate objects (inputs are not mutated).
   * - A confirmed candidate gets +BOOST confidence (up to BOOST_CAP, never lowered), lifting the thin-danmaku caps,
   *   but only when it already has independent danmaku evidence (a coordinate, an announcement or a landing marker).
   * - Guard: on a popular video (≥ VETO_MIN_EVENTS) an auto-skip candidate WITHOUT agreeing coordinates whose span
   *   shows no skip pattern is capped below the auto-skip threshold (announcement chatter, story skips).
   */
  function corroborate(candidates, analysis, settings) {
    const list = Array.isArray(candidates) ? candidates : [];
    if (!analysis || !analysis.usable || (settings && settings.useHeat === false)) return list;
    const minConf = settings && isFinite(settings.minConfidence) ? settings.minConfidence : 0.6;
    return list.map((c) => {
      if (!c || c.source !== 'danmaku' || c.offerOnly || c.end == null || !isFinite(c.end)) return c;
      if (c.evidence && c.evidence.bins) return c;   // the danmaku / heat model already weighed the curve
      const ev = c.evidence || {};
      const r = matchRun(analysis, c.start, c.end);
      if (!r) {
        if (c.confidence >= minConf && (ev.targetsAgree || 0) < 2 && analysis.events >= VETO_MIN_EVENTS) {
          return Object.assign({}, c, { confidence: Math.min(c.confidence, Math.max(0, minConf - 0.05)), reason: (c.reason || '') + ' · 热度未见跳过' });
        }
        return c;
      }
      const independent = (ev.targetsAgree || 0) >= 1 || (ev.strongEnd || 0) >= 1 || (ev.adVocab || 0) >= 1;
      if (!independent) return c;
      const conf = Math.max(c.confidence, Math.min(BOOST_CAP, c.confidence + BOOST));
      const heat = { start: r.start, end: r.end, peakEnd: r.peakEnd, ratio: Math.round(r.ratio * 10) / 10, cliff: Math.round(r.cliff * 10) / 10 };
      return Object.assign({}, c, {
        confidence: Math.round(conf * 100) / 100,
        reason: (c.reason || '') + ' · 热度佐证',
        sources: Array.from(new Set([].concat(c.sources || [c.source], ['heat']))),
        evidence: Object.assign({}, ev, { heat }),
      });
    });
  }

  /** Strong ad-shaped runs not explained by any candidate → manual skip offers (source 'heat', never auto-skipped). */
  function offers(candidates, analysis, settings) {
    if (!analysis || !analysis.usable || (settings && settings.useHeat === false)) return [];
    const list = Array.isArray(candidates) ? candidates : [];
    const out = [];
    for (const r of analysis.runs) {
      if (!r.offer) continue;
      const explained = list.some((c) => c && c.end != null && U.overlap(c.start, c.end, r.start, r.end) > 0.3 * (r.end - r.start));
      if (explained) continue;
      // The ramp begins before the ad and the onset is imprecise: offer from the second hot sample to the peak's end.
      const start = Math.min(r.peakStart, r.start + analysis.step);
      out.push({
        start, end: r.peakEnd, source: 'heat', sources: ['heat'], confidence: 0.5, offerOnly: true,
        reason: '播放热度：大量观众在此拖动跳过',
        evidence: { heat: { start: r.start, end: r.end, peakEnd: r.peakEnd, ratio: Math.round(r.ratio * 10) / 10, cliff: Math.round(r.cliff * 10) / 10 } },
      });
    }
    return out;
  }

  function detectHeat(raw, duration) { return analyse(raw && raw.values ? raw : parse(raw), duration); }
  detectHeat.parse = parse;
  detectHeat.analyse = analyse;
  detectHeat.matchRun = matchRun;
  detectHeat.corroborate = corroborate;
  detectHeat.offers = offers;
  detectHeat.CONST = { HOT_K, CORR, OFFER, BOOST, BOOST_CAP, MIN_EVENTS, MAX_SPIKE, VETO_MIN_EVENTS };
  BAS.detectHeat = detectHeat;
})();
