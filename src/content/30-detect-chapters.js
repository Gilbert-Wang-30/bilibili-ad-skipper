/* Bilibili Ad Skipper — chapter detector (SPEC §7.1). Pure: no DOM / chrome.* access. */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS) return;

  // Ad chapter vocabulary (matched against normalizeText(content), case-insensitive).
  const AD_RE = /广告|恰饭|恰个饭|赞助|推广|商单|商务|商业(合作|推广)|合作(推广|伙伴)?|金主|品牌(时间|合作)|软广|硬广|植入|带货|sponsor|\bad\b|^ad$|恰烂钱|打钱|广子/i;
  // Chapters that *talk about* ads without being one ("无广告", "广告结束", "正片").
  const NOT_AD_RE = /无广告|没有广告|非广告|广告结束|正片/;

  const MIN_LEN = 3;    // seconds — shorter chapters are noise
  const MAX_LEN = 600;  // seconds — longer "ads" are whole-video sponsorship, not skippable

  const toNum = (v) => {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return isFinite(n) ? n : NaN; }
    return NaN;
  };

  /**
   * Classify a chapter title. Exported for tests / other modules.
   * @param {string} content raw chapter title
   * @param {object} [settings] uses settings.extraStartKeywords (substrings)
   * @returns {boolean}
   */
  function isAdChapterTitle(content, settings) {
    const text = BAS.util.normalizeText(content);
    if (!text) return false;
    if (NOT_AD_RE.test(text)) return false;
    if (AD_RE.test(text)) return true;
    const extra = settings && Array.isArray(settings.extraStartKeywords) ? settings.extraStartKeywords : [];
    for (const kw of extra) {
      const k = BAS.util.normalizeText(kw);
      if (k && text.includes(k)) return true;
    }
    return false;
  }

  /**
   * @param {ViewPoint[]} viewPoints  data.view_points from x/player/v2 (may be null/undefined/empty)
   * @param {number} duration         video duration in seconds
   * @param {object} [settings]
   * @returns {{candidates: Candidate[], boundaries: number[]}}
   */
  function detectChapters(viewPoints, duration, settings) {
    const candidates = [];
    const boundarySet = new Set();
    const dur = toNum(duration);
    const hasDur = isFinite(dur) && dur > 0;
    const list = Array.isArray(viewPoints) ? viewPoints : [];
    const n = list.length;

    for (let i = 0; i < n; i++) {
      const vp = list[i];
      if (!vp || typeof vp !== 'object') continue;
      let from = toNum(vp.from);
      let to = toNum(vp.to);
      // The player back-fills from=0 on the first and to=duration on the last chapter when they are missing.
      if (!isFinite(from) && i === 0) from = 0;
      if (!isFinite(to) && i === n - 1 && hasDur) to = dur;
      if (!isFinite(from) || !isFinite(to)) continue;
      if (to < from) { const tmp = from; from = to; to = tmp; }
      if (hasDur) { from = BAS.util.clamp(from, 0, dur); to = BAS.util.clamp(to, 0, dur); }

      for (const b of [from, to]) {
        if (b > 0 && (!hasDur || b < dur)) boundarySet.add(Math.round(b * 1000) / 1000);
      }

      const content = vp.content == null ? '' : String(vp.content);
      let isAd = false;
      try { isAd = isAdChapterTitle(content, settings); } catch (e) { BAS.debug('detectChapters: classify failed', e); }
      if (!isAd) continue;
      const len = to - from;
      if (len < MIN_LEN || len > MAX_LEN) {
        BAS.debug('detectChapters: ad-like chapter rejected by length', content, len);
        continue;
      }
      candidates.push({
        start: from,
        end: to,
        source: 'chapter',
        confidence: 0.95,
        reason: '章节「' + content.trim() + '」',
        evidence: { index: i, type: vp.type, content, from, to },
      });
    }

    const boundaries = Array.from(boundarySet).sort((a, b) => a - b);
    candidates.sort((a, b) => a.start - b.start);
    return { candidates, boundaries };
  }

  detectChapters.isAdChapterTitle = isAdChapterTitle;
  detectChapters.AD_RE = AD_RE;
  detectChapters.NOT_AD_RE = NOT_AD_RE;
  BAS.detectChapters = detectChapters;
})();
