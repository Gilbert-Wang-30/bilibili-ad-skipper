/* Bilibili Ad Skipper — crowd-marked segments from BilibiliSponsorBlock (小电视空降助手, https://github.com/hanydd/BilibiliSponsorBlock).
 *
 * Viewers of that project mark sponsored segments by hand; its server returns, per video, the segments that survived
 * voting (downvoted ones are hidden). Checked against this project's data (2026-10):
 *   - the 7 ads measured frame by frame here are all in it, consensus edges within ~1 s of the measured ones;
 *   - none of the 19 verified ad-free videos has a returned segment (3 had sponsor marks, all downvoted to −2);
 *   - unvoted submissions on videos with a confirmed ad overlap the confirmed segment 90 % of the time
 *     (start ±1.1 s, end ±0.4 s median), downvoted ones only 29 %.
 * Coverage is the limit, not precision: about 1 in 10 of the current popular videos has a mark.
 * The lookup sends only the first 4 hex digits of sha256(BV id) (22-api.js getCrowdSegments). Pure; no DOM / chrome.*.
 */
(() => {
  const BAS = globalThis.BAS;
  if (!BAS || BAS.detectCrowd) return;

  const MIN_LEN = 5;
  const DURATION_TOL = 3;     // a mark made on a different cut of the video (re-upload, edited file) is ignored

  /**
   * @param {Array<{segment:number[], cid?:string, UUID?:string, category?:string, actionType?:string, locked?:number|boolean,
   *                votes?:number, videoDuration?:number}>} segments  server response for one video
   * @param {{cid?:number|string, duration?:number, parts?:number}} video  parts = number of parts (pages) when known
   * @returns {{candidates: object[]}}
   */
  function detectCrowd(segments, video) {
    const out = [];
    const cid = video && video.cid != null ? String(video.cid) : '';
    const dur = video && video.duration > 0 ? video.duration : 0;
    const singlePart = !!video && video.parts === 1;
    for (const s of Array.isArray(segments) ? segments : []) {
      if (!s || !Array.isArray(s.segment) || s.segment.length < 2) continue;
      if ((s.category || 'sponsor') !== 'sponsor' || (s.actionType && s.actionType !== 'skip')) continue;
      const sameLength = s.videoDuration > 0 && dur > 0 && Math.abs(s.videoDuration - dur) <= DURATION_TOL;
      // A mark under another cid is another part of a multi-part video, unless the video has one part and the length
      // matches (the file was replaced). A mark without a cid is only trusted on a single-part video or by its length.
      if (s.cid && cid && String(s.cid) !== cid && !(singlePart && sameLength)) continue;
      if (!s.cid && !(singlePart || sameLength)) continue;
      if (s.videoDuration > 0 && dur > 0 && !sameLength) continue;                  // made on a different cut
      let a = +s.segment[0], b = +s.segment[1];
      if (!isFinite(a) || !isFinite(b)) continue;
      a = Math.max(0, a); if (dur) b = Math.min(dur, b);
      if (!(b - a >= MIN_LEN)) continue;
      const votes = Number(s.votes) || 0, locked = !!s.locked;
      if (votes <= -2) continue;
      // locked = checked by a moderator; votes ≥ 1 = confirmed by other viewers; 0 = one viewer's mark (90 % right);
      // −1 = disputed → shown, not skipped
      const confidence = locked ? 0.98 : votes >= 2 ? 0.95 : votes >= 0 ? 0.9 : 0.5;
      out.push({
        start: Math.round(a * 10) / 10, end: Math.round(b * 10) / 10, source: 'crowd', sources: ['crowd'], confidence,
        offerOnly: votes < 0 ? true : undefined,
        reason: '空降助手众包标记' + (locked ? '（已锁定）' : votes > 0 ? `（${votes} 票）` : votes < 0 ? '（有争议）' : ''),
        evidence: { crowd: { votes, locked, uuid: typeof s.UUID === 'string' ? s.UUID.slice(0, 80) : undefined } },
      });
    }
    out.sort((x, y) => x.start - y.start);
    return { candidates: out };
  }

  detectCrowd.CONST = { MIN_LEN, DURATION_TOL };
  BAS.detectCrowd = detectCrowd;
})();
