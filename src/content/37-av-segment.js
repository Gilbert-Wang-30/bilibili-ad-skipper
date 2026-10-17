/* Bilibili Ad Skipper — audio/video judgement of suspected ad segments. Pure; input = BAS.mediaProbe.probe() output.
 *
 * Measured (2026-10) on 7 frame-verified sponsored segments against ~1 700 same-length slices of ordinary content,
 * story/benchmark skips and intros, comparing each 1-second block inside a segment with the 45 s around it:
 *   - a sponsored read is LOUDER than the video around it (+0.7…+3.0 σ),
 *   - its loudness is STEADIER (narration over music, no pauses: −0.6…−0.9 σ),
 *   - it is usually BRIGHTER (+0.8…+3.4 σ) and its spectrum changes more (flux),
 *   while ordinary content stays within about ±0.4 σ on the audio measures. score = z(db) − z(dbsd) + 0.3·z(luma)
 *   + 0.3·z(flux) (clamped) puts every ad at ≥ 1.8 even with boundaries ±5 s off; content slices of ad length
 *   (60–130 s) peak at 1.2. Short slices are noisier: under 40 s a loud passage of content looks just like an ad.
 * An ad's END is a "transition": a short audio dip (≥ 9 dB below its neighbourhood) together with a hard picture cut.
 * Seen from inside the ad, the true end scores ≥ 2.8 on "end-likeness" (inside vs the 15 s after it); transitions inside
 * an ad stay below 1.2 and no content transition reached 2.0. Starts are softer (the uploader segues while talking),
 * so a start is only nudged within a few seconds of the danmaku estimate.
 */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS || BAS.avSegment) return;

  const CTX = 45;                // context on each side of a segment
  const SIDE_W = 12;             // window on each side of a transition when refining an edge
  const END_AFTER = 15;          // "after" window for end-likeness
  const END_INSIDE = 60;         // longest "inside" window for end-likeness
  const W_LUMA = 0.3, W_FLUX = 0.3;
  const DIP_MAX_DB = -26, DIP_DEPTH = 9, DIP_NEIGHBOUR = 5;
  const CUT_PAIR = 0.9, CUT_MIN = 30, DRIFT_MIN = 60;
  // [min duration, score needed to confirm]. Every measured ad is ≥ 60 s; loud, steady 25–40 s passages of ordinary
  // content reach 3.1 and 40–60 s ones 1.9 (audio only), so shorter spans are never confirmed and 40–60 s need 2.2.
  const SEG_AD = [[60, 1.4], [40, 2.2]];
  const SEG_NOT_AD = 0.6, SEG_NOT_AD_MIN_DUR = 30;
  const END_SNAP_R = 8, END_MIN_SIDE = 1.5;
  const END_LATER_MAX = 1;       // an end may only move later by this much: on 84 crowd-labelled ads, later moves of
                                 // the danmaku end cut content more often than they helped (earlier ones never cut)
  const START_BACK = 0.5, START_AHEAD = 3, START_MIN_SIDE = 2.0;   // a start never moves much earlier: that would cut content
  const FIND_MIN = 2.0, FIND_AFTER_NEEDED = 8;
  const AV_BOOST = 0.25, AV_CAP = 0.9;
  const OPEN_SPAN = 240;         // how far past an open-ended danmaku start the end is searched for
  const END_ZONE_AV_MIN = 3;     // score an end-zone segment needs (a 2.55 'ad' was a joke video's real ending)

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const r2 = (x) => Math.round(x * 100) / 100;

  /** Per-second blocks {t, db, dbsd, flux, luma(NaN without video)} from probe frames. */
  function blocks(data) {
    const A = (data && data.audio) || [], V = (data && data.video) || [];
    if (!A.length) return [];
    const t0 = Math.floor(A[0].t), t1 = Math.floor(A[A.length - 1].t);
    const n = t1 - t0 + 1;
    if (!(n > 0) || n > 20000) return [];
    const acc = [];
    for (let k = 0; k < n; k++) acc.push({ na: 0, db: 0, db2: 0, flux: 0, nv: 0, luma: 0 });
    for (const f of A) {
      const k = Math.floor(f.t) - t0;
      if (k < 0 || k >= n || !isFinite(f.db)) continue;
      const b = acc[k]; b.na++; b.db += f.db; b.db2 += f.db * f.db; b.flux += isFinite(f.flux) ? f.flux : 0;
    }
    for (const f of V) {
      const k = Math.floor(f.t) - t0;
      if (k < 0 || k >= n || !isFinite(f.mean)) continue;
      acc[k].nv++; acc[k].luma += f.mean;
    }
    const out = [];
    for (let k = 0; k < n; k++) {
      const b = acc[k];
      if (b.na < 2) continue;
      const m = b.db / b.na;
      out.push({ t: t0 + k, db: m, dbsd: Math.sqrt(Math.max(0, b.db2 / b.na - m * m)), flux: b.flux / b.na, luma: b.nv ? b.luma / b.nv : NaN });
    }
    return out;
  }

  /** Standardised mean difference (Cohen's d) of `key` between two block lists, or null when too few values. */
  function cohen(inside, outside, key) {
    const a = inside.map((x) => x[key]).filter(isFinite), b = outside.map((x) => x[key]).filter(isFinite);
    if (a.length < 3 || b.length < 3) return null;
    const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
    const va = a.reduce((s, x) => s + (x - ma) ** 2, 0), vb = b.reduce((s, x) => s + (x - mb) ** 2, 0);
    const sp = Math.sqrt((va + vb) / Math.max(1, a.length + b.length - 2));
    return (ma - mb) / (sp || 1e-6);
  }
  /** Ad-likeness of `inside` relative to `outside`: {score, z} (score null when there is not enough audio). */
  function contrast(inside, outside) {
    const z = { db: cohen(inside, outside, 'db'), dbsd: cohen(inside, outside, 'dbsd'), luma: cohen(inside, outside, 'luma'), flux: cohen(inside, outside, 'flux') };
    if (z.db == null || z.dbsd == null) return { score: null, z };
    const score = z.db - z.dbsd + W_LUMA * clamp(z.luma == null ? 0 : z.luma, -1, 3) + W_FLUX * clamp(z.flux == null ? 0 : z.flux, -2, 2);
    return { score, z };
  }
  const within = (B, a, b) => B.filter((x) => x.t >= a && x.t < b);

  /** Score of [s, e] against the CTX seconds on both sides; null when the data does not cover it. */
  function segmentScore(B, s, e) {
    const inside = within(B, s + 2, e - 2);
    const outside = within(B, s - CTX, s - 1).concat(within(B, e + 1, e + CTX));
    if (inside.length < 10 || outside.length < 15) return null;
    const c = contrast(inside, outside);
    return c.score == null ? null : { score: c.score, z: c.z, nIn: inside.length, nOut: outside.length };
  }
  function adThreshold(dur) {
    for (const [d, s] of SEG_AD) if (dur >= d) return s;
    return Infinity;
  }
  function verdictOf(score, dur) {
    if (score == null || !isFinite(score)) return 'unknown';
    if (score >= adThreshold(dur)) return 'ad';
    if (score <= SEG_NOT_AD && dur >= SEG_NOT_AD_MIN_DUR) return 'notAd';
    return 'unsure';
  }

  /** Audio dips paired with a hard cut (or bare dips when there is no video): [{t, depth, cut}], sorted. */
  function transitions(data) {
    const A = (data && data.audio) || [], V = (data && data.video) || [];
    const out = [];
    let lo = 0, hi = 0, vLo = 0;
    for (let i = 1; i < A.length - 1; i++) {
      const f = A[i], db = f.db;
      if (!(db <= DIP_MAX_DB && db <= A[i - 1].db && db <= A[i + 1].db)) continue;
      while (lo < A.length && A[lo].t < f.t - DIP_NEIGHBOUR) lo++;
      while (hi < A.length && A[hi].t <= f.t + DIP_NEIGHBOUR) hi++;
      const nb = A.slice(lo, hi).map((x) => x.db).sort((a, b) => a - b);
      const depth = nb[nb.length >> 1] - db;
      if (!(depth >= DIP_DEPTH)) continue;
      if (!V.length) { out.push({ t: f.t, depth, cut: 0 }); continue; }
      while (vLo < V.length && V[vLo].t < f.t - CUT_PAIR) vLo++;
      let best = null, bs = 0;
      for (let k = vLo; k < V.length && V[k].t <= f.t + CUT_PAIR; k++) {
        const v = V[k];
        if (!(v.cut > CUT_MIN || v.drift > DRIFT_MIN)) continue;
        const s = Math.max(v.cut || 0, (v.drift || 0) / 2);
        if (s > bs) { bs = s; best = v; }
      }
      if (best) out.push({ t: best.t, depth, cut: bs });
    }
    out.sort((a, b) => a.t - b.t);
    // one entry per cut (several dips can pair with the same cut)
    const dedup = [];
    for (const x of out) {
      const last = dedup[dedup.length - 1];
      if (last && Math.abs(last.t - x.t) < 0.05) { if (x.depth > last.depth) dedup[dedup.length - 1] = x; } else dedup.push(x);
    }
    return dedup;
  }

  /** Ad-likeness of the side of p where the ad would be (before p for an end, after p for a start). */
  function side(B, p, adBefore) {
    const before = within(B, p - SIDE_W, p - 0.5), after = within(B, p + 0.5, p + SIDE_W);
    if (before.length < 4 || after.length < 4) return null;
    const c = adBefore ? contrast(before, after) : contrast(after, before);
    return c.score;
  }

  function refineEnd(B, T, prior, radius) {
    const R = radius > 0 ? radius : END_SNAP_R;
    let best = null;
    for (const x of T) {
      if (x.t < prior - R || x.t > prior + END_LATER_MAX) continue;
      const sd = side(B, x.t, true);
      if (sd == null || sd < END_MIN_SIDE) continue;
      const sc = sd + 0.15 * Math.min(4, x.depth / 5) + 0.1 * Math.min(3, x.cut / 40) - 0.6 * Math.abs(x.t - prior) / R;
      if (!best || sc > best.score) best = { t: x.t, side: sd, score: sc };
    }
    return best;
  }
  function refineStart(B, T, prior) {
    let best = null;
    for (const x of T) {
      if (x.t < prior - START_BACK || x.t > prior + START_AHEAD) continue;
      const sd = side(B, x.t, false);
      if (sd == null || sd < START_MIN_SIDE) continue;
      const sc = sd - 0.5 * Math.max(0, x.t - prior) - 0.8 * Math.max(0, prior - x.t);
      if (!best || sc > best.score) best = { t: x.t, side: sd, score: sc };
    }
    return best;
  }

  /**
   * Judge a suspected segment [s, e] (data should cover [s − 45, e + 45]).
   * @returns {{verdict:'ad'|'notAd'|'unsure'|'unknown', score:number|null, z:object|null, start:number, end:number,
   *            startBy:'av'|null, endBy:'av'|null}}
   */
  function assess(data, s, e, opts) {
    const o = opts || {};
    const B = blocks(data), T = transitions(data);
    const endFix = isFinite(e) ? refineEnd(B, T, e, o.endRadius) : null;
    const startFix = refineStart(B, T, s);
    let s2 = startFix ? startFix.t : s, e2 = endFix ? endFix.t : e;
    if (!(e2 - s2 >= 5)) { s2 = s; e2 = e; }
    const seg = segmentScore(B, s2, e2);
    const score = seg ? seg.score : null;
    return {
      verdict: verdictOf(score, e2 - s2), score: score == null ? null : r2(score),
      z: seg ? { db: r2(seg.z.db), dbsd: r2(seg.z.dbsd), luma: seg.z.luma == null ? null : r2(seg.z.luma), flux: seg.z.flux == null ? null : r2(seg.z.flux) } : null,
      start: r2(s2), end: r2(e2), startBy: s2 !== s ? 'av' : null, endBy: e2 !== e ? 'av' : null,
      endSide: endFix ? r2(endFix.side) : null,
    };
  }

  /**
   * The viewer is inside an ad at time t: the first transition after t that looks like the ad's end.
   * @returns {{t:number, score:number}|{pending:true, until:number}|null} pending = no end yet in the data seen so far
   */
  function findEnd(data, t, opts) {
    const o = opts || {};
    const B = blocks(data), T = transitions(data);
    if (!B.length) return null;
    const lastT = B[B.length - 1].t;
    const maxT = Math.min(isFinite(o.maxT) ? o.maxT : Infinity, lastT - FIND_AFTER_NEEDED);
    let first = null;
    const hits = [];
    for (const x of T) {
      // a transition the press has only just passed counts too (the caller sees it is behind it: the ad is over)
      if (x.t <= t - 3 || x.t > maxT) continue;
      if (first && x.t > first.t + 3) break;
      const inside = within(B, Math.max(t - 20, x.t - END_INSIDE), x.t - 0.5), after = within(B, x.t + 0.5, x.t + END_AFTER);
      if (inside.length < 6 || after.length < 6) continue;
      const c = contrast(inside, after);
      if (c.score == null) continue;
      const sc = c.score + 0.1 * Math.min(4, x.depth / 5);
      if (sc >= FIND_MIN) { hits.push({ t: x.t, score: r2(sc) }); if (!first) first = x; }
    }
    if (hits.length) return hits.reduce((a, b) => (b.score > a.score ? b : a));
    return { pending: true, until: maxT };
  }

  /**
   * A danmaku start cluster without any end (no landing thanks, no agreeing targets): look for the ad's end in the
   * media after it, then judge the whole span. Data should cover [s − 45, s + OPEN_SPAN + 20].
   */
  function assessOpen(data, s) {
    const f = findEnd(data, s + 20);
    if (!f || f.pending) return { verdict: 'unknown', score: null, z: null, start: s, end: null, startBy: null, endBy: null };
    const r = assess(data, s, f.t, { endRadius: 3 });
    r.endBy = 'av';
    r.found = f.score;
    return r;
  }

  const isOpen = (c) => c.end == null || !isFinite(c.end);
  /** Danmaku that say it is an ad (sponsor vocabulary) or welcome viewers back after it (landing thanks). */
  const adSpecific = (ev) => (ev.adVocab || 0) >= 0.4 || (ev.strongEnd || 0) >= 1;
  const key = (c) => `${c.source}:${Math.round(c.start)}-${isOpen(c) ? 'open' : Math.round(c.end)}`;
  const wants = (c) => !!c && isFinite(c.start) && (c.source === 'danmaku' || c.source === 'heat') &&
    (isOpen(c) ? c.source === 'danmaku' : c.end - c.start >= 10);

  /**
   * Apply A/V results (Map key → assess() result) to candidates. Returns new objects; inputs are not mutated.
   * - the verdict is recorded in evidence; only 'ad' acts: +AV_BOOST confidence for candidates with ad-specific danmaku.
   * - edges of closed candidates are left as the detectors gave them.
   * - an open-ended danmaku start whose span the media confirms gets the end found in the media; any other open-ended
   *   candidate is returned unchanged (the caller drops it).
   */
  function apply(candidates, results, settings) {
    const list = Array.isArray(candidates) ? candidates : [];
    if (!results || !results.size || (settings && settings.useAvProbe === false)) return list;
    const minConf = settings && isFinite(settings.minConfidence) ? settings.minConfidence : 0.6;
    return list.map((c) => {
      if (!wants(c)) return c;
      const r = results.get(key(c));
      if (!r || r.verdict === 'unknown') return c;
      const ev = c.evidence || {};
      const out = Object.assign({}, c, { evidence: Object.assign({}, ev, { av: { verdict: r.verdict, score: r.score, z: r.z, start: r.start, end: r.end } }) });
      if (isOpen(c)) {
        if (r.verdict !== 'ad' || !isFinite(r.end) || r.end - c.start < 20) return c;
        out.idStart = c.start; out.idEnd = r.end;
        out.end = r.end; out.lockEnd = true;
        if (r.startBy) { out.start = r.start; out.lockStart = true; }
        if (adSpecific(ev)) out.confidence = r2(Math.max(c.confidence, Math.min(AV_CAP, c.confidence + AV_BOOST)));
        out.sources = Array.from(new Set([].concat(c.sources || [c.source], ['media'])));
        out.reason = (c.reason || '') + ' · 音视频找到结尾';
        return out;
      }
      // Measured on 305 crowd-labelled ads (BilibiliSponsorBlock) and the candidates of 84 videos without sponsor labels:
      // - 'notAd' is not a veto: a third of the real ads the media judged were no louder, steadier or brighter;
      // - the edges the danmaku give are kept: snapping them to a transition made as many ends worse as better;
      // - a confirmation lifts only candidates whose danmaku name an ad (vocabulary or landing thanks): intros and
      //   OP songs are loud, steady and bright too, and their crowd jumps look exactly like pure 空降 coordinates.
      if (r.verdict === 'ad' && !c.offerOnly && adSpecific(ev)) {
        out.confidence = r2(Math.max(c.confidence, Math.min(AV_CAP, c.confidence + AV_BOOST)));
        out.sources = Array.from(new Set([].concat(c.sources || [c.source], ['media'])));
        out.reason = (c.reason || '') + ' · 音视频确认';
      }
      return out;
    });
  }

  /**
   * Final gate, applied after every boost (heat included): a danmaku segment ending in the last 3 % of the video
   * (detector R14, evidence.endZone) is only auto-skipped with a strong A/V 'ad' verdict and ad-specific danmaku.
   */
  function gate(candidates, settings) {
    const list = Array.isArray(candidates) ? candidates : [];
    const minConf = settings && isFinite(settings.minConfidence) ? settings.minConfidence : 0.6;
    const cap = Math.max(0, r2(minConf - 0.05));
    return list.map((c) => {
      const ev = c && c.evidence;
      if (!c || c.source !== 'danmaku' || !ev || !ev.endZone || !(c.confidence > cap)) return c;
      if (ev.av && ev.av.verdict === 'ad' && ev.av.score >= END_ZONE_AV_MIN && adSpecific(ev)) return c;
      return Object.assign({}, c, { confidence: cap });
    });
  }

  BAS.avSegment = {
    blocks, transitions, segmentScore, verdictOf, adThreshold, assess, assessOpen, findEnd, apply, gate, key, wants, isOpen,
    CONST: { CTX, SEG_AD, SEG_NOT_AD, SEG_NOT_AD_MIN_DUR, END_SNAP_R, FIND_MIN, AV_BOOST, AV_CAP, OPEN_SPAN },
  };
})();
