/* Bilibili Ad Skipper — "skip the ad that is playing now" (manual, for ads the detectors missed).
 *
 * The viewer tells us an ad is playing at time t. We only need its END, and we may use evidence that is too weak to
 * auto-skip on, because a human confirmed the ad — but the landing must not jump past the ad into the video. Trusted
 * ends: a segment / candidate covering t that the extension was sure of; 空降 coordinates posted from LOOK_BACK s before t
 * up to 60 s after it that point past t (≥ 2 agreeing); the sponsor read in the AI subtitles containing t
 * (28-detect-subtitles.js readEndAt). The landing is the earliest trusted end, MARGIN s before it. Without one, weaker
 * hints (landing markers 欢迎回来 / 空降成功 … posted after t, the viewer-heat ramp's peak, a single coordinate, a segment
 * it was not sure of, a chapter boundary ≤ 20 s ahead) are used only when they lie within STEP s; else it steps STEP s
 * forward (pressing again moves on). Bare numbers the viewers also post long after their time are names, not targets.
 * Measured on 936 presses at 1/4, 1/2, 3/4 of crowd-labelled held-out ads (v4.2.0; this policy was chosen on these same
 * presses): the first press lands past the end (content skipped) 1.3 % of the time (v4.1.0, which trusted every source
 * in turn and stepped 15 s: 8.8 %); pressing until the ad is over ends within 3 s of it 84.3 % of the time (83.1 %),
 * past it 1.4 % (14.5 %), after 1.7 presses (1.3).
 * Pure: no DOM / chrome.* access.
 */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS || BAS.findAdEnd) return;
  const U = BAS.util;

  const LOOK_BACK = 150;      // the ad may have started this long before the press (coordinates are posted at its start)
  const LOOK_AHEAD = 300;     // longest ad remainder we accept
  const MIN_AHEAD = 4;        // the end must be at least this far ahead of now
  const TOL = 10;             // targets within this many seconds agree
  // Without a trusted end: a short step (every longer one jumped past the end more often on the held-out presses; the
  // toast offers 再前进). With one: land MARGIN s before it. SURE_CONF: a known segment counts as trusted from here.
  const STEP = 5, MARGIN = 1, SURE_CONF = 0.6;
  // cheap pre-filter before running the full classifier on a danmaku (digits, numerals, jump / landing words)
  const QUICK = /[\d０-９零〇一二三四五六七八九十洞幺两拐勾]|空降|跳|指路|坐标|正片|谢|thx|3q|回来|着陆|落地|降落|穿越|欢迎|成功|结束|躲过|逃过|→|右/i;

  const nameCache = new WeakMap();   // danmaku list → the numbers that are names in it (util.nameNumbers), per press
  function lowerBound(arr, t) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if ((+arr[mid].t || 0) < t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /**
   * @param {{t:number, duration:number, danmaku?:Array<{t:number,text:string,action?:string}>, heat?:object,
   *          boundaries?:number[], candidates?:Array<{start:number,end:number|null,confidence?:number}>,
   *          subtitles?:Array<{from:number,to:number,content:string}>}} ctx  subtitles: the AI subtitle body
   * @returns {{end:number, start:number, source:string, reason:string, evidence:object}|null} null when too close to the end
   */
  function findAdEnd(ctx) {
    const c0 = ctx || {};
    const t = +c0.t;
    const dur = +c0.duration > 0 ? +c0.duration : Infinity;
    if (!isFinite(t)) return null;
    const lo = t + MIN_AHEAD, hi = Math.min(dur - 1, t + LOOK_AHEAD);
    if (!(hi > lo)) return null;
    const evidence = { candidate: null, targets: [], thanks: [], heat: null, chapter: null };

    // 1) an existing segment / candidate covering now
    let cand = null, subCand = null;
    const hasSubs = !!BAS.detectSubtitles && Array.isArray(c0.subtitles) && c0.subtitles.length > 0;
    for (const c of Array.isArray(c0.candidates) ? c0.candidates : []) {
      if (!c || c.end == null || !isFinite(+c.end) || !isFinite(+c.start)) continue;
      if (!(+c.start - 5 <= t && t < +c.end - 1 && +c.end > t + 1 && +c.end <= hi + 1)) continue;
      // a read only the subtitle detector found: step 3 answers it, with the end tables' end (more often within 3 s);
      // kept in case step 3 cannot (scores from the cache, a transcript not scored yet)
      if (hasSubs && (c.sources || [c.source]).every((x) => x === 'subtitle')) {
        if (!subCand || (+c.confidence || 0) > (+subCand.confidence || 0)) subCand = c;
        continue;
      }
      if (!cand || (+c.confidence || 0) > (+cand.confidence || 0)) cand = c;
    }

    // 2/4) danmaku around now
    const classify = BAS.detectDanmaku && BAS.detectDanmaku.classify;
    const list = Array.isArray(c0.danmaku) ? c0.danmaku : [];
    const tg = [], ends = [];
    if (classify && list.length) {
      const durArg = isFinite(dur) ? dur : 0;
      // bare numbers the viewers also post long after their time are names ('A110'), never the ad's end
      let names = nameCache.get(list);
      if (!names || names.dur !== durArg) { names = U.nameNumbers ? U.nameNumbers(list, durArg) : new Set(); names.dur = durArg; nameCache.set(list, names); }
      for (let i = lowerBound(list, t - LOOK_BACK); i < list.length; i++) {
        const d = list[i];
        if (!d) continue;
        const dt = +d.t || 0;
        if (dt > hi) break;
        const text = d.text == null ? '' : String(d.text);
        if (!d.action && !QUICK.test(text)) continue;
        let k;
        try { k = classify(text, dt, durArg, d.action); } catch (e) { continue; }
        if (dt <= t + 60) for (const x of k.targets || []) if (x.target > t + 1 && x.target <= hi && !(x.weak && x.fmt === 'number' && names.has(x.target))) tg.push({ v: x.target, weak: !!x.weak, t: dt, text });
        if (k.endClass === 'strong' && dt >= lo) ends.push({ t: dt, text });
      }
    }
    // largest agreeing group of targets; bare numbers ("weak") only count with company
    let group = null;
    if (tg.length) {
      const sorted = tg.slice().sort((a, b) => a.v - b.v);
      const groups = [];
      for (const x of sorted) {
        const g = groups[groups.length - 1];
        if (g && x.v - g[g.length - 1].v <= TOL) g.push(x); else groups.push([x]);
      }
      const score = (g) => g.reduce((s, x) => s + (x.weak ? 0.5 : 1), 0);
      for (const g of groups) {
        const strong = g.filter((x) => !x.weak).length;
        if (strong === 0 && g.length < 3) continue;
        if (!group || score(g) > score(group)) group = g;
      }
    }
    const teTarget = group ? U.median(group.map((x) => x.v)) : null;
    const nTarget = group ? group.length : 0;
    // landing-marker clusters (gap ≤ 10 s); with targets, the cluster nearest to them
    let thanks = null;
    if (ends.length) {
      const cl = [];
      for (const e of ends) {
        const c = cl[cl.length - 1];
        if (c && e.t - c[c.length - 1].t <= 10) c.push(e); else cl.push([e]);
      }
      thanks = teTarget != null ? cl.reduce((b, c) => (!b || Math.abs(c[0].t - 2 - teTarget) < Math.abs(b[0].t - 2 - teTarget) ? c : b), null) : cl[0];
    }
    const teThanks = thanks ? Math.max(lo, thanks[0].t - 2) : null;

    // 5) heat ramp containing now
    let heatRun = null;
    const H = c0.heat;
    if (H && H.usable && Array.isArray(H.runs)) {
      const s = H.step || 0;
      for (const r of H.runs) {
        const shaped = r.adLike || (r.n >= 2 && r.peakFromEnd <= 2 && r.ramp >= 0.4);
        if (!shaped) continue;
        if (!(r.start - s <= t && t <= r.end + s / 2)) continue;
        if (r.peakEnd < lo - s || r.peakEnd > hi) continue;
        if (!heatRun || r.ratio > heatRun.ratio) heatRun = r;
      }
    }
    // 3) the sponsor read in the subtitles
    let read = null;
    if (BAS.detectSubtitles && Array.isArray(c0.subtitles) && c0.subtitles.length) {
      try { read = BAS.detectSubtitles.readEndAt(c0.subtitles, t, isFinite(dur) ? dur : 0, c0.media || null); } catch (e) { read = null; }
      if (read && !(read.end > t + 1 && read.end <= hi + 1)) read = null;
    }
    if (!read && subCand) read = { end: +subCand.end, start: +subCand.start, reason: subCand.reason || '字幕：口播', detected: !subCand.offerOnly };
    // 7) next chapter boundary
    const nextBoundary = (Array.isArray(c0.boundaries) ? c0.boundaries : []).filter((b) => isFinite(b) && b >= lo && b <= hi).sort((a, b) => a - b)[0];

    evidence.targets = group ? group.slice(0, 20).map((x) => ({ t: x.t, text: x.text, target: x.v })) : [];
    evidence.thanks = thanks ? thanks.slice(0, 20) : [];
    evidence.heat = heatRun ? { start: heatRun.start, end: heatRun.end, peakEnd: heatRun.peakEnd } : null;
    evidence.chapter = nextBoundary != null ? nextBoundary : null;
    evidence.subtitle = read ? { start: read.start, end: read.end } : null;

    const strongTargets = group && (group.filter((x) => !x.weak).length >= 2 || group.length >= 3);
    // Trusted ends: a segment the extension was sure of, ≥ 2 agreeing jump targets, the sponsor read in the subtitles.
    // The landing is the EARLIEST of them, MARGIN s before it. Weaker hints (landing thanks, the heat peak, one coordinate,
    // a segment it was not sure of, a near chapter boundary) are never trusted past a short STEP: pressing again moves on.
    // On 936 held-out presses, first landings past the end (content skipped) fell from 8.8 % to 1.3 % (14.5 % → 1.4 %
    // pressing until the ad is over), ending within 3 s of it 84.3 % of the time after 1.7 presses on average.
    let end, source, reason, start = t, trusted = true;
    const opts = [];
    if (cand && !cand.offerOnly && (+cand.confidence || 0) >= SURE_CONF) opts.push('candidate');
    if (strongTargets) opts.push('targets');
    if (read) opts.push('subtitle');
    const endOf = { candidate: () => +cand.end, targets: () => teTarget, subtitle: () => read.end };
    if (opts.length) {
      source = opts.reduce((a, b) => (endOf[b]() < endOf[a]() ? b : a));
      end = endOf[source]() - MARGIN;
    } else {
      trusted = false;
      const weak = [];
      if (cand) weak.push(['candidate', +cand.end]);
      if (teThanks != null) weak.push(['thanks', teThanks]);
      if (heatRun) {
        // The real end lies within about one heat sample of the peak's end. If we are already past the middle of that
        // window (e.g. a second press after an early landing), the far half instead of creeping forward.
        const s = H.step || 0;
        weak.push(['heat', t >= heatRun.peakEnd - s / 2 ? heatRun.peakEnd + s / 2 : heatRun.peakEnd]);
      }
      if (group) weak.push(['target', teTarget]);
      // the next chapter boundary was 54 s past the ad's end (median) on crowd-labelled ads: only a near one counts
      if (nextBoundary != null && nextBoundary - t <= 20) weak.push(['chapter', nextBoundary]);
      // only hints ahead of the minimum step (an ad does not end within MIN_AHEAD s of a press without a trusted end)
      const ahead = weak.filter((x) => x[1] >= lo);
      const w = ahead.length ? ahead.reduce((a, b) => (b[1] < a[1] ? b : a)) : null;
      if (w && w[1] <= t + STEP) { source = w[0]; end = w[1]; }
      else { source = 'fallback'; end = t + STEP; }
    }
    if (source === 'candidate') {
      start = Math.min(t, +cand.start);
      evidence.candidate = { start: +cand.start, end: +cand.end, confidence: +cand.confidence || 0 };
      reason = '已识别的片段' + (cand.confidence != null ? '（置信度 ' + Math.round((+cand.confidence || 0) * 100) + '%）' : '');
    } else if (source === 'targets') {
      reason = '弹幕空降 ' + nTarget + ' 条' + (teThanks != null && Math.abs(teThanks - teTarget) <= 20 ? ' · 落地确认 ' + thanks.length + ' 条' : '');
      const cues = group.map((x) => x.t).sort((a, b) => a - b).slice(0, 20);
      start = Math.min(t, U.median(cues) + 2);                       // same calibrated rule as the detector
    } else if (source === 'subtitle') {
      reason = read.reason; start = Math.min(t, read.start);
    } else if (source === 'thanks') {
      reason = '弹幕落地确认 ' + thanks.length + ' 条（欢迎回来 / 空降成功 …）';
    } else if (source === 'heat') {
      reason = '播放热度峰值'; start = Math.min(t, heatRun.start + (H.step || 0));
    } else if (source === 'target') {
      reason = '弹幕空降 1 条';
    } else if (source === 'chapter') {
      reason = '下一章节';
    } else {
      reason = '没有可靠的广告结尾，先前进 ' + STEP + ' 秒（还在广告里可再按）';
    }
    // a trusted end just ahead (the ad is ending) is never stepped past: land on it, or let the caller say it is over
    end = Math.round(U.clamp(end, trusted ? t + 0.5 : lo, hi) * 10) / 10;
    start = Math.round(Math.max(0, Math.min(start, t)) * 10) / 10;
    return { end, start, source, reason, evidence, trusted };
  }

  findAdEnd.CONST = { LOOK_BACK, LOOK_AHEAD, MIN_AHEAD, TOL, STEP, MARGIN, SURE_CONF };
  BAS.findAdEnd = findAdEnd;
})();
