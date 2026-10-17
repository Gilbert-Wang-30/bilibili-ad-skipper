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
  function buildSegments(input) {
    const s = input.settings || BAS.DEFAULT_SETTINGS;
    const av = input.av instanceof Map ? input.av : new Map();
    const all = Array.isArray(input.candidates) ? input.candidates : [];
    // Danmaku clusters without a determinable end are sponsor chatter, not skippable segments: keep them out of the
    // progress bar (fusion would otherwise stretch them to the next chapter boundary) but list them for the popup.
    const isOpen = (c) => c.source === 'danmaku' && (c.end == null || !isFinite(c.end));
    let openEnded = all.filter(isOpen);
    let usable = all.filter((c) => !isOpen(c));
    const AV = BAS.avSegment;
    const avOn = !!AV && s.useAvProbe !== false && av.size > 0;
    let avWanted = AV ? openEnded.filter(AV.wants) : [];
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
      avWanted = avWanted.concat(usable.filter((c) => AV.wants(c) && !(c.evidence && c.evidence.av)));
      if (avOn) usable = AV.apply(usable, av, s);
      usable = AV.gate(usable, s);
    }
    const out = BAS.fuse({ candidates: usable, duration: input.duration, boundaries: input.boundaries || [], media: input.media || null, overrides: input.overrides || null, settings: s });
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
    return { segments: segs, dropped, avWanted };
  }

  BAS.buildSegments = buildSegments;
})();
