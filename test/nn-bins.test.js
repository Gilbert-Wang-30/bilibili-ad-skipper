// Tests for the danmaku / heat network path of 29-media-features.js (detectBins with BAS.nnBinsModel: 3 s bins read
// by the line network's code, 26-nn-line.js), on synthetic input with a tiny hand-made network (the training danmaku
// stay private).
import { assert, assertEquals } from './assert.js';
import { loadBAS } from './load.js';

const BAS = loadBAS();
const MF = BAS.mediaFeatures;

/** A network that answers ~0.98 on bins whose text holds 'a' and ~0.01 elsewhere (see the comments). */
function tinyModel() {
  const f = (xs) => btoa(String.fromCharCode(...new Uint8Array(Float32Array.from(xs).buffer)));
  const T = (shape, xs) => ({ shape, f: f(xs) });
  const MD = 19, D = 2 + 8 + MD;
  const inp = new Array(D).fill(0); inp[0] = 1; inp[1] = 1;      // mean + max of the character vectors
  const net = {
    cfg: { emb: 1, hid: 1, layers: 1, bits: 2, chars: 96, s0: 0 }, vocab: 'a', mu: new Array(MD).fill(0), sd: new Array(MD).fill(1),
    w: {
      'eu.weight': T([3, 1], [0, 0, 1]), 'eg.weight': T([5, 1], [0, 0, 0, 0, 0]),
      'inp.weight': T([1, D], inp), 'inp.bias': T([1], [-1]),
      // update gate shut (z ≈ 0): h = tanh(x)
      'rnn.weight_ih_l0': T([3, 1], [0, 0, 1]), 'rnn.weight_hh_l0': T([3, 1], [0, 0, 0]), 'rnn.bias_ih_l0': T([3], [0, -100, 0]), 'rnn.bias_hh_l0': T([3], [0, 0, 0]),
      'rnn.weight_ih_l0_reverse': T([3, 1], [0, 0, 0]), 'rnn.weight_hh_l0_reverse': T([3, 1], [0, 0, 0]), 'rnn.bias_ih_l0_reverse': T([3], [0, -100, 0]), 'rnn.bias_hh_l0_reverse': T([3], [0, 0, 0]),
      'out.weight': T([1, 2], [10, 0]), 'out.bias': T([1], [-3]),
    },
  };
  const NF = 16 + 3 * MD + 3, w = new Array(NF + 1).fill(0);
  w[NF] = 2;                                                       // every stretch: p = sigmoid(2) ≈ 0.88
  return {
    v: 1, bin: 3, net, dec: { hi: 0.5, lo: 0.3, w: 0, gap: 6, edge: 0.5, maxLen: 420 },
    sc: { mu: new Array(NF).fill(0), sd: new Array(NF).fill(1), w }, mu: new Array(MD).fill(0), sd: new Array(MD).fill(1),
    params: { auto: 0.85, offer: 0.5 },
  };
}
function withModel(m, fn) {
  const old = BAS.nnBinsModel;
  BAS.nnBinsModel = m;
  const done = () => { if (old === undefined) delete BAS.nnBinsModel; else BAS.nnBinsModel = old; };
  let r;
  try { r = fn(); } catch (e) { done(); throw e; }
  if (r && typeof r.then === 'function') return r.finally(done);
  done();
  return r;
}
/** 10 minutes of chatter with 'a' danmaku at 30–60 s. */
function danmaku() {
  const list = [];
  for (let t = 0; t < 600; t += 1) list.push({ t, text: t >= 30 && t < 60 ? 'aaa' : '哈哈' });
  return list;
}

Deno.test('binTexts: normalised as subtitle lines, distinct per bin, in time order, joined by |, capped', () => {
  const T = MF.binTexts([{ t: 4, text: 'x' }, { t: 1, text: '空降 1:30' }, { t: 1.5, text: '空降 1:30' }, { t: 2, text: 'ＡＢ！' }, { t: -1, text: 'z' }, { t: 9, text: 'y' }], 2, 3, 96);
  assertEquals(T, ['空降000|ab', 'x']);
  assertEquals(MF.binTexts([{ t: 0, text: 'abcdef' }, { t: 1, text: 'ghijkl' }], 1, 3, 8), ['abcdef|g']);
});

Deno.test('xmlCap: the XML danmaku pool size by duration', () => {
  assertEquals([100, 150, 151, 600, 601, 900, 901, 2400, 2401, 3600, 3601, 9000].map(MF.xmlCap), [600, 600, 1200, 1200, 1800, 1800, 3600, 3600, 7200, 7200, 9600, 9600]);
});

Deno.test('xmlPool: beyond the XML pool size only the newest danmaku (by id) are read; without ids an even spread', () => {
  const list = Array.from({ length: 700 }, (_, i) => ({ t: i % 100, text: 'x' + i, idStr: String(1000 + i) }));
  const kept = MF.xmlPool(list, 120);                            // cap 600
  assertEquals(kept.length, 600);
  assertEquals(Math.min(...kept.map((d) => +d.idStr)), 1100);
  // ids of different lengths compare as numbers
  assertEquals(MF.xmlPool([{ t: 0, text: 'a', idStr: '99' }, ...Array.from({ length: 600 }, (_, i) => ({ t: 1, text: 'b', idStr: String(100 + i) }))], 100).some((d) => d.idStr === '99'), false);
  const noIds = list.map(({ t, text }) => ({ t, text }));
  const spread = MF.xmlPool(noIds, 120);
  assertEquals([spread.length, spread[0].text, spread[599].text], [600, 'x0', 'x698']);
  assertEquals(MF.xmlPool(list.slice(0, 600), 120).length, 600);
});

Deno.test('binsInputs: 3 s bins; danmaku columns NaN in segments that failed to load, heat columns kept', () => {
  const list = danmaku();
  list.missingSegments = [1];                                    // 0–360 s did not load
  const I = MF.binsInputs(list, null, 600), MD = MF.CONST.MEDIA_D;
  assertEquals(I.L.length, 200);
  assertEquals([I.L[0].a, I.L[0].b, I.L[199].b], [0, 3, 600]);
  assert(Number.isNaN(I.rows[50 * MD]) && Number.isNaN(I.rows[50 * MD + 13]));
  assertEquals(I.rows[50 * MD + 14], 0);
  assert(Number.isFinite(I.rows[150 * MD]));
});

Deno.test('detectBins: with the bins network it finds the stretch the network marks, the same warmed or cold', async () => {
  await withModel(tinyModel(), async () => {
    const list = danmaku();
    const cold = MF.detectBins(list.slice(), null, 600, BAS.DEFAULT_SETTINGS, { hasBody: false }).candidates;
    assertEquals(cold.length, 1);
    assertEquals([cold[0].start, cold[0].end, cold[0].offerOnly, cold[0].evidence.bins.net], [30, 60, undefined, true]);
    let pauses = 0;
    await MF.warmBins(list, null, 600, () => { pauses++; return Promise.resolve(); });
    assert(pauses >= 1);
    assertEquals(JSON.stringify(MF.detectBins(list, null, 600, BAS.DEFAULT_SETTINGS, { hasBody: false }).candidates), JSON.stringify(cold));
    // a superseded run: the pause throws, nothing is kept, and a later call still answers
    const l2 = danmaku();
    let err = null;
    try { await MF.warmBins(l2, null, 600, () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }); } catch (e) { err = e; }
    assert(err && err.name === 'AbortError');
    assertEquals(MF.detectBins(l2, null, 600, BAS.DEFAULT_SETTINGS, { hasBody: false }).candidates.length, 1);
  });
});

Deno.test('detectBins: without the bins network the trees still answer (no network path)', () => {
  const had = BAS.nnBinsModel;
  if (had) return;
  const r = MF.detectBins(danmaku(), null, 600, BAS.DEFAULT_SETTINGS, { hasBody: false }).candidates;
  assert(r.every((c) => !(c.evidence && c.evidence.bins && c.evidence.bins.net)));
});

Deno.test('line model reading the bins column: warm() and a cold detectSubtitles agree; without danmaku it reads as unknown', async () => {
  const NM = BAS.nnModel, D = BAS.detectSubtitles;
  if (!NM || !NM.net || NM.net.mu.length !== MF.CONST.MEDIA_D + 1) return;
  const topic = ['这一年他回到了老家', '村里的人都很惊讶', '那时候的条件很差', '他每天天不亮就出门'];
  const read = ['说到熬夜剪视频', '我最近一直在用小象家的电动牙刷', '小象家电动牙刷有三种清洁模式', '评论区置顶链接就能领券下单', '小象家的牙刷真的很好用', '链接放在评论区了'];
  const body = () => { const b = []; for (let t = 0; t < 600; t += 3) b.push({ from: t, to: t + 2, content: t >= 300 && t < 318 ? read[(t - 300) / 3] : topic[(t / 3) % 4] }); return b; };
  const media = { danmaku: danmaku(), heat: null };
  const cold = D(body(), 600, undefined, media).candidates;
  const L = await D.warm(body(), 600, undefined, media, () => Promise.resolve());
  assertEquals(JSON.stringify(D(L, 600, undefined, media).candidates), JSON.stringify(cold));
  // the 20th column is the bins network's view of each line; NaN (unknown) without a danmaku list
  const col = MF.binsLineCol(D.prepare(body(), 600), media.danmaku, null, 600);
  assert(col.every((x) => x >= 0 && x <= 1));
  assert(MF.binsLineCol(D.prepare(body(), 600), null, null, 600).every((x) => Number.isNaN(x)));
});
