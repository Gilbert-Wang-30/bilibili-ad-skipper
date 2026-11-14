// Tests for the v4.0.2 fixes of the neural subtitle path (review of v4.0.1): sliced scoring, the skip button's use of
// known reads, the press cache after warm(), media columns that were not known, and disputed crowd marks in fusion.
// Synthetic input only (the training transcripts stay private).
import { assert, assertEquals } from './assert.js';
import { loadBAS } from './load.js';

const BAS = loadBAS();
const NL = BAS.nnLine, NM = BAS.nnModel, D = BAS.detectSubtitles;

const topic = ['这一年他回到了老家', '村里的人都很惊讶', '那时候的条件很差', '他每天天不亮就出门'];
const read = ['说到熬夜剪视频', '我最近一直在用小象家的电动牙刷', '小象家电动牙刷有三种清洁模式', '评论区置顶链接就能领券下单', '小象家的牙刷真的很好用', '链接放在评论区了'];
/** A 10-minute transcript with one product read at 300–318 s. */
function body() {
  const b = [];
  for (let t = 0; t < 600; t += 3) b.push({ from: t, to: t + 2, content: t >= 300 && t < 318 ? read[(t - 300) / 3] : topic[(t / 3) % topic.length] });
  return b;
}

Deno.test('scoresAsync: a long transcript is scored in many short slices with the one-go result; a throwing pause stops it', async () => {
  if (!NM) return;
  const net = NL.load(NM.net);
  const L = Array.from({ length: 3000 }, (_, i) => ({ a: 2 * i, b: 2 * i + 1.8, n: topic[i % topic.length] }));
  const want = NL.scores(net, L, 6000, null);
  let pauses = 0;
  const got = await NL.scoresAsync(net, L, 6000, null, () => { pauses++; return Promise.resolve(); });
  assertEquals(Array.from(got), Array.from(want));
  assert(pauses >= 10, `only ${pauses} pauses for 3000 lines`);
  let calls = 0, err = null;
  try {
    await NL.scoresAsync(net, L, 6000, null, () => { if (++calls === 2) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } return Promise.resolve(); });
  } catch (e) { err = e; }
  assert(err && err.name === 'AbortError' && calls === 2, String(err));
});

Deno.test('readEndAt: a press before warm() finished does not keep the phrase-only answer once the scores are there', async () => {
  if (!NM) return;
  const media = { danmaku: [{ t: 301, text: '恰饭了' }], heat: null };
  const early = D.prepare(body(), 600);
  D.readEndAt(early, 306, 600, media);                       // press while not warmed: phrase-table path
  await D.warm(early, 600, undefined, media, () => Promise.resolve());
  const fresh = await D.warm(body(), 600, undefined, media, () => Promise.resolve());
  assertEquals(JSON.stringify(D.readEndAt(early, 306, 600, media)), JSON.stringify(D.readEndAt(fresh, 306, 600, media)));
});

Deno.test('findAdEnd: a read only the subtitle detector found keeps its end when the transcript cannot answer (cached visit)', () => {
  // subtitles loaded but with no read near t (as when the scores came from the cache and this transcript is not scored)
  const subs = Array.from({ length: 200 }, (_, i) => ({ from: 3 * i, to: 3 * i + 2, content: topic[i % topic.length] }));
  const cand = { start: 120, end: 180, source: 'subtitle', sources: ['subtitle'], confidence: 0.5, offerOnly: true, reason: '字幕：口播（62%）' };
  const r = BAS.findAdEnd({ t: 140, duration: 600, danmaku: [], candidates: [cand], subtitles: subs });
  assertEquals([r.source, r.end], ['subtitle', 179]);
  // without the transcript the offered read is only a hint: a short step
  const r2 = BAS.findAdEnd({ t: 140, duration: 600, danmaku: [], candidates: [cand] });
  assertEquals([r2.source, r2.end], ['fallback', 145]);
});

Deno.test('mediaRows: unknown danmaku is NaN, a missing heat curve is 0 (as in training), failed danmaku segments are NaN', () => {
  const MF = BAS.mediaFeatures;
  if (!MF) return;
  const DM = MF.CONST.MEDIA_D;
  const L = D.prepare(Array.from({ length: 300 }, (_, i) => ({ from: 3 * i, to: 3 * i + 2, content: topic[i % 4] })), 900);
  const none = D.mediaRows(L, 900, undefined, null);
  assert(none && none.length === L.length * DM);
  for (let k = 0; k < 14; k++) assert(Number.isNaN(none[k]), `col ${k}`);
  for (let k = 14; k < DM; k++) assertEquals(none[k], 0);
  const list = Array.from({ length: 400 }, (_, i) => ({ t: 2 * i + (i >= 180 ? 400 : 0), text: '哈哈' }));
  list.missingSegments = [2];                               // 360–720 s did not load
  const part = D.mediaRows(L, 900, undefined, { danmaku: list, heat: null });
  const row = (t) => L.findIndex((l) => l.a >= t) * DM;
  assert(Number.isFinite(part[row(100)]) && Number.isFinite(part[row(800)]));
  assert(Number.isNaN(part[row(500)]) && Number.isNaN(part[row(500) + 13]));
  assertEquals(part[row(500) + 14], 0);
});

Deno.test('prepareMedia: the viewer\'s extra danmaku keywords do not change what the learned models read', () => {
  const MF = BAS.mediaFeatures;
  if (!MF) return;
  const list = [];
  for (let t = 0; t < 600; t += 1.5) list.push({ t, text: t > 200 && t < 230 ? '小象牙刷' : '哈哈哈' });
  const a = MF.prepareMedia(list, null, 600), b = MF.prepareMedia(list, null, 600, Object.assign({}, BAS.DEFAULT_SETTINGS, { extraStartKeywords: ['小象'] }));
  assertEquals(JSON.stringify(a.segs), JSON.stringify(b.segs));
});

Deno.test('fuse: a disputed crowd mark does not turn a confident read into an offer; it corroborates it instead', () => {
  const read = { start: 100, end: 160, source: 'subtitle', sources: ['subtitle'], confidence: 0.9, reason: '字幕：口播（90%）' };
  const disputed = BAS.detectCrowd([{ segment: [95, 165], category: 'sponsor', votes: -1, UUID: 'u' }], { duration: 600, parts: 1 }).candidates;
  assertEquals(disputed.length, 1);
  const segs = BAS.fuse({ candidates: [read, ...disputed], duration: 600, boundaries: [], settings: BAS.DEFAULT_SETTINGS });
  assertEquals(segs.length, 1);
  assertEquals([segs[0].start, segs[0].end, segs[0].autoSkip, segs[0].source], [100, 160, true, 'subtitle']);
  assert(segs[0].sources.includes('crowd'));
  assert(segs.diagnostics.dropped.some((c) => c.source === 'crowd'));
  // a weak read is still taken in by the mark, which stays an offer
  const weak = Object.assign({}, read, { confidence: 0.5, offerOnly: true });
  const s2 = BAS.fuse({ candidates: [weak, ...disputed], duration: 600, boundaries: [], settings: BAS.DEFAULT_SETTINGS });
  assertEquals([s2.length, s2[0].source, s2[0].autoSkip], [1, 'crowd', false]);
});
