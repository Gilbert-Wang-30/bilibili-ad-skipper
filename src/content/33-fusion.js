/* Bilibili Ad Skipper — fusion of detector candidates into Segments (SPEC §7.4). Pure module. */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS) return;

  const BOUNDARY_SNAP_SEC = 10;   // snap danmaku edges to chapter boundaries within this distance
  const CUT_SNAP_SEC = 4;         // else to media cuts within this distance
  const NULL_END_MAX_SEC = 300;   // end===null: next chapter boundary must be within this distance
  const NULL_END_CONFIDENCE = 0.5;
  const MIN_SEGMENT_SEC = 5;
  const CHAPTER_MERGE_FRACTION = 0.4;   // danmaku overlapping a chapter ad by > 40 % of itself merges into it
  const IGNORE_FRACTION = 0.5;          // override.ignore removes a segment overlapping it by > 50 %
  const SOURCE_PRIORITY = { user: 0, chapter: 1, danmaku: 2, media: 3, heat: 4 };

  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : NaN);
  const round2 = (v) => Math.round(v * 100) / 100;
  const { overlap } = BAS.util;

  function cloneCandidate(c) {
    const out = Object.assign({}, c);
    out.sources = Array.isArray(c.sources) && c.sources.length ? c.sources.slice() : [c.source];
    out.evidence = c.evidence && typeof c.evidence === 'object' ? Object.assign({}, c.evidence) : {};
    return out;
  }

  function sanitize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const start = num(raw.start);
    if (!(start >= 0)) return null;
    const end = raw.end === null || raw.end === undefined ? null : num(raw.end);
    if (end !== null && !isFinite(end)) return null;
    const source = typeof raw.source === 'string' && raw.source ? raw.source : 'danmaku';
    let confidence = num(raw.confidence);
    if (!isFinite(confidence)) confidence = 0;
    const c = cloneCandidate(raw);
    c.start = start; c.end = end; c.source = source;
    c.confidence = BAS.util.clamp(confidence, 0, 1);
    c.reason = typeof raw.reason === 'string' ? raw.reason : '';
    c.offerOnly = !!raw.offerOnly;
    return c;
  }

  function sourceEnabled(source, s) {
    if (source === 'chapter') return s.useChapters !== false;
    if (source === 'danmaku') return s.useDanmaku !== false;
    if (source === 'media') return s.useMedia !== false || s.useAudio === true;
    if (source === 'heat') return s.useHeat !== false;
    return true; // 'user' and unknown sources are always kept
  }

  function addSources(target, sources) {
    for (const s of sources) if (s && !target.sources.includes(s)) target.sources.push(s);
  }

  /**
   * Snap a time to the nearest chapter boundary (within 10 s), else to the nearest media cut (within 4 s).
   * Exposed as BAS.fuse.snap for tests.
   * @param {number} t
   * @param {number[]} boundaries sorted ascending
   * @param {{nearestCut?: function(number, number): ({t:number, strength?:number}|null)}|null} media
   * @returns {{t:number, by:'boundary'|'cut'|null}}
   */
  function snap(t, boundaries, media) {
    if (!isFinite(t)) return { t, by: null };
    let best = null, bestDist = Infinity;
    if (Array.isArray(boundaries)) {
      for (const b of boundaries) {
        if (!isFinite(b)) continue;
        const d = Math.abs(b - t);
        if (d <= BOUNDARY_SNAP_SEC && d < bestDist) { best = b; bestDist = d; }
      }
    }
    if (best !== null) return { t: best, by: 'boundary' };
    if (media && typeof media.nearestCut === 'function') {
      try {
        const cut = media.nearestCut(t, CUT_SNAP_SEC);
        if (cut && isFinite(cut.t) && Math.abs(cut.t - t) <= CUT_SNAP_SEC) return { t: cut.t, by: 'cut' };
      } catch (e) { BAS.debug('fuse: nearestCut failed', e); }
    }
    return { t, by: null };
  }

  function nextBoundaryAfter(t, boundaries) {
    if (!Array.isArray(boundaries)) return null;
    let best = null;
    for (const b of boundaries) {
      if (!isFinite(b) || b <= t + MIN_SEGMENT_SEC) continue;
      if (best === null || b < best) best = b;
    }
    return best;
  }

  function priority(source) { return source in SOURCE_PRIORITY ? SOURCE_PRIORITY[source] : 9; }

  /** Pick the representative of a merge group: highest priority source, then highest confidence. */
  function better(a, b) {
    const pa = priority(a.source), pb = priority(b.source);
    if (pa !== pb) return pa < pb ? a : b;
    if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b;
    return a.start <= b.start ? a : b;
  }

  function mergeTwo(a, b) {
    const primary = better(a, b);
    const other = primary === a ? b : a;
    const out = Object.assign({}, primary);
    out.start = Math.min(a.start, b.start);
    out.end = Math.max(a.end, b.end);
    // An offer-only (intro skip) merged with a real ad candidate is a real ad; confidence from the non-offer side.
    const bothOffer = !!a.offerOnly && !!b.offerOnly;
    if (bothOffer) out.confidence = Math.max(a.confidence, b.confidence);
    else out.confidence = Math.max(a.offerOnly ? 0 : a.confidence, b.offerOnly ? 0 : b.confidence);
    out.offerOnly = bothOffer;
    out.sources = primary.sources.slice();
    addSources(out, other.sources);
    out.evidence = Object.assign({}, primary.evidence);
    out.evidence.merged = (primary.evidence && primary.evidence.merged ? primary.evidence.merged.slice() : [])
      .concat([{ source: other.source, start: other.start, end: other.end, confidence: other.confidence, reason: other.reason }]);
    if (other.enabled === false) out.enabled = false;
    return out;
  }

  /**
   * Merge overlapping (or touching) segments: union range, max confidence, union sources. Sorted by start.
   * Exposed as BAS.fuse.mergeOverlaps for tests. Input items need numeric start/end.
   * @param {Array<object>} items
   * @returns {Array<object>}
   */
  function mergeOverlaps(items) {
    const list = (Array.isArray(items) ? items : []).filter((s) => s && isFinite(s.start) && isFinite(s.end)).map(cloneCandidate)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const out = [];
    for (const s of list) {
      const last = out[out.length - 1];
      if (last && s.start <= last.end) out[out.length - 1] = mergeTwo(last, s);
      else out.push(s);
    }
    return out;
  }

  /**
   * @param {{candidates: Candidate[], duration: number, boundaries?: number[], media?: object|null,
   *          overrides?: {ignore?: Array<{start:number,end:number}>, add?: Array<{start:number,end:number}>}|null,
   *          settings?: object}} input
   * @returns {Segment[]} with a non-enumerable `diagnostics` property: {dropped: Array<Candidate & {dropReason: string}>}
   */
  function fuse(input) {
    const inp = input && typeof input === 'object' ? input : {};
    const settings = Object.assign({}, BAS.DEFAULT_SETTINGS, BAS.state && BAS.state.settings, inp.settings);
    const duration = num(inp.duration);
    const hasDur = isFinite(duration) && duration > 1;
    const boundaries = (Array.isArray(inp.boundaries) ? inp.boundaries : []).filter((b) => isFinite(b)).slice().sort((a, b) => a - b);
    const media = inp.media || null;
    const overrides = inp.overrides && typeof inp.overrides === 'object' ? inp.overrides : {};
    const dropped = [];
    const drop = (c, why) => { dropped.push(Object.assign({}, c, { dropReason: why })); };

    // 1. sanitize + disabled sources
    let cands = [];
    for (const raw of Array.isArray(inp.candidates) ? inp.candidates : []) {
      const c = sanitize(raw);
      if (!c) continue;
      if (!sourceEnabled(c.source, settings)) { drop(c, '来源已停用'); continue; }
      cands.push(c);
    }

    // 2. chapter authority: danmaku candidates overlapping a chapter candidate merge into it
    const chapters = cands.filter((c) => c.source === 'chapter');
    if (chapters.length) {
      const rest = [];
      for (const c of cands) {
        if (c.source !== 'danmaku') { rest.push(c); continue; }
        let host = null;
        for (const ch of chapters) {
          if (c.end === null) {
            if (c.start >= ch.start - BOUNDARY_SNAP_SEC && c.start < ch.end) { host = ch; break; }
          } else {
            const len = c.end - c.start;
            if (len > 0 && overlap(c.start, c.end, ch.start, ch.end) / len > CHAPTER_MERGE_FRACTION) { host = ch; break; }
          }
        }
        if (!host) { rest.push(c); continue; }
        addSources(host, c.sources);
        host.confidence = Math.max(host.confidence, c.offerOnly ? 0 : c.confidence);
        if (!/弹幕佐证/.test(host.reason)) host.reason = host.reason + ' · 弹幕佐证';
        host.evidence.danmaku = (host.evidence.danmaku || []).concat([{ start: c.start, end: c.end, confidence: c.confidence, reason: c.reason }]);
      }
      cands = rest;
    }

    // 3. snap danmaku edges; resolve or drop unknown ends
    const resolved = [];
    for (const c of cands) {
      if (c.source !== 'danmaku') { resolved.push(c); continue; }
      const origStart = c.start, origEnd = c.end;
      // Ids are derived from the detector's own estimate so re-snapping (new media cuts, A/V refinement) keeps them stable.
      c._id0 = isFinite(c.idStart) ? c.idStart : origStart; c._id1 = isFinite(c.idEnd) ? c.idEnd : origEnd;
      // Edges measured by the A/V look-ahead (37-av-segment.js) are more precise than a chapter boundary or a live cut.
      const s = c.lockStart ? { t: c.start, by: 'av' } : snap(c.start, boundaries, media);
      let newStart = s.t;
      let newEnd = c.end, endBy = null;
      if (c.end === null) {
        const nb = nextBoundaryAfter(newStart, boundaries);
        if (nb !== null && nb - newStart <= NULL_END_MAX_SEC) {
          newEnd = nb; endBy = 'next-boundary';
          c.confidence = NULL_END_CONFIDENCE;
        } else {
          drop(c, '无法确定结束时间');
          continue;
        }
      } else {
        const e = c.lockEnd ? { t: c.end, by: 'av' } : snap(c.end, boundaries, media);
        newEnd = e.t; endBy = e.by;
      }
      // A snap must not collapse the segment; revert the end, else the start, else both.
      if (newEnd - newStart < MIN_SEGMENT_SEC && endBy !== 'next-boundary') {
        if (origEnd - newStart >= MIN_SEGMENT_SEC) { newEnd = origEnd; endBy = null; }
        else if (newEnd - origStart >= MIN_SEGMENT_SEC) { newStart = origStart; s.by = null; }
        else { newStart = origStart; newEnd = origEnd; s.by = null; endBy = null; }
      }
      c.start = newStart; c.end = newEnd;
      c.evidence.snapped = { start: { from: origStart, to: newStart, by: s.by }, end: { from: origEnd, to: newEnd, by: endBy } };
      resolved.push(c);
    }
    cands = resolved;

    // 4. overrides: ignore ranges, then user-added ranges
    const ignores = (Array.isArray(overrides.ignore) ? overrides.ignore : [])
      .map((r) => r && { start: num(r.start), end: num(r.end) }).filter((r) => r && isFinite(r.start) && isFinite(r.end) && r.end > r.start);
    if (ignores.length) {
      cands = cands.filter((c) => {
        const len = c.end - c.start;
        const hit = len > 0 && ignores.some((r) => overlap(c.start, c.end, r.start, r.end) / len > IGNORE_FRACTION);
        if (hit) drop(c, '用户已忽略');
        return !hit;
      });
    }
    for (const r of Array.isArray(overrides.add) ? overrides.add : []) {
      const a = r && num(r.start), b = r && num(r.end);
      if (!isFinite(a) || !isFinite(b) || b <= a) continue;
      cands.push({ start: a, end: b, source: 'user', sources: ['user'], confidence: 1, reason: '手动添加', evidence: {}, offerOnly: false });
    }

    // 5. clip, drop short, merge, sort
    const clipped = [];
    for (const c of cands) {
      const start = Math.max(0, c.start);
      let end = c.end;
      if (hasDur) end = Math.min(duration - 1, end);
      if (end - start < MIN_SEGMENT_SEC) { drop(c, '片段过短'); continue; }
      c.start = round2(start); c.end = round2(end);
      clipped.push(c);
    }
    const merged = mergeOverlaps(clipped);

    // 6. finalize
    const minConf = isFinite(settings.minConfidence) ? settings.minConfidence : BAS.DEFAULT_SETTINGS.minConfidence;
    const segments = merged.map((c) => {
      const seg = Object.assign({}, c);
      const a = isFinite(seg._id0) ? seg._id0 : isFinite(seg.idStart) ? seg.idStart : seg.start;
      const b = isFinite(seg._id1) && seg._id1 !== null ? seg._id1 : isFinite(seg.idEnd) ? seg.idEnd : seg.end;
      delete seg._id0; delete seg._id1; delete seg.idStart; delete seg.idEnd; delete seg.lockStart; delete seg.lockEnd;
      seg.id = String(seg.source)[0] + ':' + Math.round(a) + '-' + Math.round(b);
      seg.autoSkip = seg.confidence >= minConf && !seg.offerOnly;
      seg.enabled = c.enabled !== false;
      return seg;
    });
    // Unique ids even if two segments round to the same bucket (rare, after clipping).
    const seen = new Set();
    for (const seg of segments) {
      let id = seg.id, k = 2;
      while (seen.has(id)) id = seg.id + '#' + k++;
      seg.id = id; seen.add(id);
    }
    Object.defineProperty(segments, 'diagnostics', { value: { dropped }, enumerable: false, writable: true, configurable: true });
    return segments;
  }

  fuse.mergeOverlaps = mergeOverlaps;
  fuse.snap = snap;
  fuse.CONST = { BOUNDARY_SNAP_SEC, CUT_SNAP_SEC, NULL_END_MAX_SEC, MIN_SEGMENT_SEC };
  BAS.fuse = fuse;
})();
