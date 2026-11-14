/* Bilibili Ad Skipper — detector candidates → segments: heat confirmation, A/V verdicts, end-zone gate, fusion.
 * Pure (no DOM / chrome.*); used by the orchestrator (50-main.js) and by the offline evaluation (tools/eval-bsb.js), so
 * both judge exactly the same way.
 */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS || BAS.buildSegments) return;

  /**
   * @param {{candidates: object[], duration: number, boundaries?: number[], heatAnalysis?: object|null,
   *          av?: Map<string, object>|null, media?: object|null, overrides?: object|null, settings: object}} input
   * @returns {{segments: object[], dropped: object[], avWanted: object[]}} avWanted = candidates (as the detectors made
   *          them) that the A/V look-ahead could still judge
   */
  // An auto-skip needs two kinds of evidence that agree, unless one piece of it is strong on its own. On 876 popular
  // videos (2026-11, every auto-skip judged blind from the transcript or the danmaku) all 71 auto-skips where two kinds
  // agreed were real ads; alone, a crowd mark nobody had voted on was judged not an ad or unclear 6 times in 21 (of 160
  // such marks sampled from the labelled corpus, 23 were not ads), a subtitle read not an ad 3 times in 18, and danmaku
  // alone can be viewers talking about a sponsor that is the video's topic. Those become offers (a skip button).
  // Judged on the candidates that make up the segment (not the merged segment's labels): a kind counts when one of them
  // would auto-skip on its own, or is a fair sign of it (a subtitle or network offer of p ≥ OFFER_P), or is the heat
  // curve (viewers dragging past it). The A/V check is not a kind of its own: it only runs on a danmaku estimate's request.
  const KINDS = ['chapter', 'crowd', 'subtitle', 'danmaku', 'heat'];
  const SUB_ALONE = 0.9;      // subtitle read alone: the line model's stretch probability
  const NET_ALONE = 0.95;     // danmaku / heat network alone: its stretch probability
  const TARGETS_ALONE = 3;    // hand-written danmaku rules alone: agreeing 空降 coordinates (viewers pointing past it)
  const OFFER_P = 0.5;        // a subtitle read / network stretch below its auto threshold still counts as a kind from here
  function strongAlone(c) {
    const ev = c.evidence || {}, src = c.source;
    if (src === 'chapter' || src === 'user') return true;
    if (src === 'crowd') return !!(ev.crowd && (ev.crowd.locked || ev.crowd.votes >= 1));
    if (src === 'subtitle') return !!(ev.subtitle && ev.subtitle.p >= SUB_ALONE);
    if (src === 'danmaku') return ev.bins ? (ev.bins.net ? ev.bins.p >= NET_ALONE : true) : (ev.targetsAgree || 0) >= TARGETS_ALONE;
    return false;
  }
  /** The kinds of evidence a candidate adds to a segment it is part of. */
  function kindsOf(c, minConf) {
    const src = Array.isArray(c.sources) && c.sources.length ? c.sources : [c.source];
    const out = src.includes('heat') ? ['heat'] : [];
    const ev = c.evidence || {};
    const sure = !c.offerOnly && c.confidence >= minConf;
    const fair = (c.source === 'subtitle' && ev.subtitle && ev.subtitle.p >= OFFER_P) || (c.source === 'danmaku' && ev.bins && ev.bins.net && ev.bins.p >= OFFER_P);
    if (sure || fair) for (const k of src) if (KINDS.includes(k) && k !== 'heat') out.push(k);
    return out;
  }
  function oneSourceGate(seg, members, minConf) {
    if (!seg || !seg.autoSkip || seg.source === 'user') return seg;
    const len = (c) => Math.max(0, c.end - c.start);
    const part = (members || []).filter((c) => c && isFinite(c.end) && Math.min(c.end, seg.end) - Math.max(c.start, seg.start) > 0.3 * Math.min(len(c), len(seg)));
    const kinds = new Set();
    let strong = false;
    for (const c of part.length ? part : [seg]) {
      for (const k of kindsOf(c, minConf)) kinds.add(k);
      if (!c.offerOnly && c.confidence >= minConf && strongAlone(c)) strong = true;
    }
    if (kinds.size >= 2 || strong) return seg;
    return Object.assign({}, seg, { autoSkip: false, oneSource: true, reason: (seg.reason || '') + ' · 仅单一来源，改为提示' });
  }

  function buildSegments(input) {
    const s = input.settings || BAS.DEFAULT_SETTINGS;
    const av = input.av instanceof Map ? input.av : new Map();
    const all = (Array.isArray(input.candidates) ? input.candidates : []).filter((c) => c && (c.source !== 'crowd' || s.useCrowd !== false));
    const crowd = all.filter((c) => c.source === 'crowd' && !c.offerOnly);
    const decided = (c) => crowd.some((m) => (c.end == null ? c.start >= m.start - 10 && c.start < m.end : Math.min(c.end, m.end) > Math.max(c.start, m.start)));
    // Danmaku clusters without a determinable end are sponsor chatter, not skippable segments: keep them out of the
    // progress bar (fusion would otherwise stretch them to the next chapter boundary) but list them for the popup.
    const isOpen = (c) => c.source === 'danmaku' && (c.end == null || !isFinite(c.end));
    let openEnded = all.filter(isOpen);
    let usable = all.filter((c) => !isOpen(c));
    const AV = BAS.avSegment;
    const avOn = !!AV && s.useAvProbe !== false && av.size > 0;
    let avWanted = AV ? openEnded.filter((c) => AV.canChange(c, s) && !decided(c)) : [];
    // The A/V look-ahead can supply the end of a danmaku start cluster that has none (thin danmaku).
    if (avOn) {
      const closed = AV.apply(openEnded, av, s);
      usable = usable.concat(closed.filter((c) => !isOpen(c)));
      openEnded = closed.filter(isOpen);
    }
    if (BAS.detectHeat && s.useHeat !== false && input.heatAnalysis) {
      usable = BAS.detectHeat.corroborate(usable, input.heatAnalysis, s);
      usable = usable.concat(BAS.detectHeat.offers(usable, input.heatAnalysis, s));
    }
    if (AV) {
      // probe targets are the candidates as the detectors produced them (A/V-closed ones are already done)
      avWanted = avWanted.concat(usable.filter((c) => !(c.evidence && c.evidence.av) && AV.canChange(c, s) && !decided(c)));
      if (avOn) usable = AV.apply(usable, av, s);
      usable = AV.gate(usable, s);
    }
    const out = BAS.fuse({ candidates: usable, duration: input.duration, boundaries: input.boundaries || [], media: input.media || null, overrides: input.overrides || null, settings: s });
    const minConf = isFinite(s.minConfidence) ? s.minConfidence : BAS.DEFAULT_SETTINGS.minConfidence;
    const segs = (Array.isArray(out) ? out.slice() : ((out && out.segments) || []).slice()).map((seg) => oneSourceGate(seg, usable, minConf));
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
    return { segments: segs, dropped, avWanted };
  }

  buildSegments.oneSourceGate = oneSourceGate;
  BAS.buildSegments = buildSegments;
})();
