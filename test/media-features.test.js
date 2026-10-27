// Tests for src/content/29-media-features.js (danmaku / heat features for the learned models, the bin model for videos
// without subtitles) and the danmaku-aware path of 28-detect-subtitles.js.
import { assert, assertEquals } from './assert.js';
import { loadBAS } from './load.js';

const BAS = loadBAS();
const MF = BAS.mediaFeatures, D = BAS.detectSubtitles;

const TOPIC = ['这一年他回到了老家', '村里的人都很惊讶', '那时候的条件很差', '他每天天不亮就出门', '后来的事情大家都知道了', '这件事一直被人提起', '我们接着往下看', '当时的报纸是这样写的'];
const filler = (from, to) => { const r = []; for (let t = from, i = 0; t < to; t += 3, i++) r.push({ from: t, to: t + 2, content: TOPIC[i % TOPIC.length] }); return r; };
const READ = [[300, '说到熬夜剪视频'], [303, '我最近一直在用小象家的电动牙刷'], [306, '小象家电动牙刷有三种清洁模式'], [309, '刷完牙齿特别干净'],
  [312, '续航也很长充一次能用两个月'], [315, '小象家这款现在活动价只要两百多'], [318, '评论区置顶链接就能领券下单'], [321, '还有保价和运费险']].map(([from, content]) => ({ from, to: from + 2, content }));
const VIDEO = [].concat(filler(0, 298), READ, filler(324, 900));
// viewers around the read: chat, jump cues pointing past it, landing thanks after it
const DANMAKU = [];
for (let t = 5; t < 900; t += 4) DANMAKU.push({ t, text: TOPIC[t % TOPIC.length].slice(0, 4) });
for (let k = 0; k < 8; k++) DANMAKU.push({ t: 296 + k, text: '空降5:24' }, { t: 301 + k, text: '恰饭了' });
for (let k = 0; k < 6; k++) DANMAKU.push({ t: 325 + k, text: '欢迎回来' });

Deno.test('mediaAt: finite numbers for any input, and the jump cues / landing thanks around a read show up', () => {
  for (const dm of [[], null, [{ t: 'x', text: 1 }, null, { t: NaN, text: '空降' }], DANMAKU]) {
    for (const heat of [null, { step: 9, values: [] }, { step: 9, values: Array.from({ length: 100 }, (_, i) => 10 + (i === 35 ? 50 : 0)) }]) {
      const X = MF.prepareMedia(dm, heat, 900);
      const out = new Float32Array(MF.CONST.MEDIA_D);
      MF.mediaAt(X, 300, 323, out, 0);
      assert(out.every((x) => Number.isFinite(x)), JSON.stringify(Array.from(out)));
    }
  }
  const X = MF.prepareMedia(DANMAKU, null, 900), inRead = new Float32Array(MF.CONST.MEDIA_D), far = new Float32Array(MF.CONST.MEDIA_D);
  MF.mediaAt(X, 303, 305, inRead, 0); MF.mediaAt(X, 600, 602, far, 0);
  assert(inRead[4] > far[4], 'jump cues pass over the read: ' + inRead[4]);
  assert(inRead[7] > far[7], 'landing thanks right after it: ' + inRead[7]);
});

Deno.test('detectSubtitles with danmaku / heat: the same read, edges within 3 s; without, the text-only model', () => {
  for (const media of [undefined, null, { danmaku: [], heat: null }, { danmaku: DANMAKU, heat: null }]) {
    const c = D(VIDEO, 900, undefined, media).candidates;
    assertEquals(c.length, 1, JSON.stringify(media && media.danmaku && media.danmaku.length));
    assert(c[0].start >= 297 && c[0].start <= 300 && c[0].end >= 323 && c[0].end <= 326 && !c[0].offerOnly, JSON.stringify(c));
  }
  // the skip button's cached run follows the media it was given
  const L = D.prepare(VIDEO, 900);
  assert(D.readEndAt(L, 310, 900).detected);
  assert(D.readEndAt(L, 310, 900, { danmaku: DANMAKU, heat: null }).detected);
});

Deno.test('detectBins: no model, no duration or no danmaku → nothing; candidates have the detector shape', () => {
  assertEquals(MF.detectBins(DANMAKU, null, 0).candidates, []);
  assertEquals(MF.detectBins([], null, 900).candidates, []);
  const M = BAS.subtitleModel;
  try { BAS.subtitleModel = Object.assign({}, M, { bins: undefined }); assertEquals(MF.detectBins(DANMAKU, null, 900).candidates, []); } finally { BAS.subtitleModel = M; }
  const r = MF.detectBins(DANMAKU, null, 900, BAS.DEFAULT_SETTINGS, { hasBody: false });
  for (const c of r.candidates) {
    assert(c.source === 'danmaku' && c.start < c.end && c.end <= 900 && c.end - c.start >= 8 && /弹幕\/热度模型/.test(c.reason), JSON.stringify(c));
    assert(c.offerOnly ? c.confidence === 0.5 : c.confidence >= 0.7, JSON.stringify(c));
  }
  // a long video with a dense danmaku stream stays fast
  const big = Array.from({ length: 50000 }, (_, i) => ({ t: i * 0.2, text: i % 50 ? '哈哈哈' : '空降' + Math.floor(i * 0.2 / 60 + 2) + ':00' }));
  const t0 = performance.now();
  MF.detectBins(big, null, 10000, BAS.DEFAULT_SETTINGS, { hasBody: false });
  assert(performance.now() - t0 < 5000, `${Math.round(performance.now() - t0)} ms`);
});
