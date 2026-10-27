/* Bilibili Ad Skipper — "skip the ad that is playing now" (manual, for ads the detectors missed).
 *
 * The viewer tells us an ad is playing at time t. We only need its END, and we may use evidence that is too weak to
 * auto-skip on, because a human confirmed the ad. Sources, in order of trust:
 *   1. an existing segment / candidate covering t (low-confidence, ignored, offer or dropped) → its end;
 *   2. 空降 coordinates posted from LOOK_BACK s before t up to 60 s after it that point past t (≥ 2 agreeing);
 *   3. the sponsor read in the AI subtitles that contains t (28-detect-subtitles.js readEndAt);
 *   4. landing markers (欢迎回来 / 空降成功 / 感谢NNN工程 …) posted after t;
 *   5. the viewer-heat ramp that contains t → its peak (±half a heat sample);
 *   6. a single coordinate; 7. a chapter boundary ≤ 20 s ahead; 8. otherwise step forward FALLBACK_STEP s.
 * Measured on 936 presses at 1/4, 1/2, 3/4 of crowd-labelled ads (v2.0.0, this order): within 3 s of the end — targets
 * 89 %, subtitle read 89 %, landing markers 59 % (only presses without a read), heat 63 %, single coordinate 45 %, blind
 * step 21 %. With landing markers first the read was 88 % and the markers 73 %; where both answered, read 91 % vs 79 %.
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
  // A blind step: measured on 930 presses inside crowd-labelled ads, every step size cuts content on the last press;
  // a short one cuts least and the toast offers 再前进.
  const FALLBACK_STEP = 15;
  // cheap pre-filter before running the full classifier on a danmaku (digits, numerals, jump / landing words)
  const QUICK = /[\d０-９零〇一二三四五六七八九十洞幺两拐勾]|空降|跳|指路|坐标|正片|谢|thx|3q|回来|着陆|落地|降落|穿越|欢迎|成功|结束|躲过|逃过|→|右/i;

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
    let cand = null;
    for (const c of Array.isArray(c0.candidates) ? c0.candidates : []) {
      if (!c || c.end == null || !isFinite(+c.end) || !isFinite(+c.start)) continue;
      if (+c.start - 5 <= t && t < +c.end - 1 && +c.end >= lo && +c.end <= hi + 1) {
        if (!cand || (+c.confidence || 0) > (+cand.confidence || 0)) cand = c;
      }
    }

    // 2/4) danmaku around now
    const classify = BAS.detectDanmaku && BAS.detectDanmaku.classify;
    const list = Array.isArray(c0.danmaku) ? c0.danmaku : [];
    const tg = [], ends = [];
    if (classify && list.length) {
      const durArg = isFinite(dur) ? dur : 0;
      for (let i = lowerBound(list, t - LOOK_BACK); i < list.length; i++) {
        const d = list[i];
        if (!d) continue;
        const dt = +d.t || 0;
        if (dt > hi) break;
        const text = d.text == null ? '' : String(d.text);
        if (!d.action && !QUICK.test(text)) continue;
        let k;
        try { k = classify(text, dt, durArg, d.action); } catch (e) { continue; }
        if (dt <= t + 60) for (const x of k.targets || []) if (x.target >= lo && x.target <= hi) tg.push({ v: x.target, weak: !!x.weak, t: dt, text });
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
      try { read = BAS.detectSubtitles.readEndAt(c0.subtitles, t, isFinite(dur) ? dur : 0); } catch (e) { read = null; }
      if (read && !(read.end >= lo && read.end <= hi + 1)) read = null;
    }
    // 7) next chapter boundary
    const nextBoundary = (Array.isArray(c0.boundaries) ? c0.boundaries : []).filter((b) => isFinite(b) && b >= lo && b <= hi).sort((a, b) => a - b)[0];

    evidence.targets = group ? group.slice(0, 20).map((x) => ({ t: x.t, text: x.text, target: x.v })) : [];
    evidence.thanks = thanks ? thanks.slice(0, 20) : [];
    evidence.heat = heatRun ? { start: heatRun.start, end: heatRun.end, peakEnd: heatRun.peakEnd } : null;
    evidence.chapter = nextBoundary != null ? nextBoundary : null;
    evidence.subtitle = read ? { start: read.start, end: read.end } : null;

    const strongTargets = group && (group.filter((x) => !x.weak).length >= 2 || group.length >= 3);
    let end, source, reason, start = t;
    if (cand) {
      end = +cand.end; source = 'candidate'; start = Math.min(t, +cand.start);
      evidence.candidate = { start: +cand.start, end: +cand.end, confidence: +cand.confidence || 0 };
      reason = '已识别但未自动跳过的片段' + (cand.confidence != null ? '（置信度 ' + Math.round((+cand.confidence || 0) * 100) + '%）' : '');
    } else if (strongTargets) {
      end = teTarget; source = 'targets';
      reason = '弹幕空降 ' + nTarget + ' 条' + (teThanks != null && Math.abs(teThanks - teTarget) <= 20 ? ' · 落地确认 ' + thanks.length + ' 条' : '');
      const cues = group.map((x) => x.t).sort((a, b) => a - b).slice(0, 20);
      start = Math.min(t, U.median(cues) + 2);                       // same calibrated rule as the detector
    } else if (read) {
      end = read.end; source = 'subtitle'; reason = read.reason; start = Math.min(t, read.start);
    } else if (teThanks != null) {
      end = teThanks; source = 'thanks'; reason = '弹幕落地确认 ' + thanks.length + ' 条（欢迎回来 / 空降成功 …）';
    } else if (heatRun) {
      // The real end lies within about one heat sample of the peak's end. If we are already past the middle of that
      // window (e.g. a second press after an early landing), jump to its far half instead of creeping forward.
      const s = H.step || 0;
      end = t >= heatRun.peakEnd - s / 2 ? heatRun.peakEnd + s / 2 : heatRun.peakEnd;
      source = 'heat'; reason = '播放热度峰值'; start = Math.min(t, heatRun.start + s);
    } else if (group) {
      end = teTarget; source = 'target'; reason = '弹幕空降 1 条';
    } else if (nextBoundary != null && nextBoundary - t <= 20) {
      // the next chapter boundary was 54 s past the ad's end (median) on crowd-labelled ads: only a near one counts
      end = nextBoundary; source = 'chapter'; reason = '下一章节';
    } else {
      end = Math.min(hi, t + FALLBACK_STEP); source = 'fallback'; reason = '未找到广告结尾，前进 ' + Math.round(end - t) + ' 秒';
    }
    end = Math.round(U.clamp(end, lo, hi) * 10) / 10;
    start = Math.round(Math.max(0, Math.min(start, t)) * 10) / 10;
    return { end, start, source, reason, evidence };
  }

  findAdEnd.CONST = { LOOK_BACK, LOOK_AHEAD, MIN_AHEAD, TOL, FALLBACK_STEP };
  BAS.findAdEnd = findAdEnd;
})();
