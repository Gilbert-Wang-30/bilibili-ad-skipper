// Tests for src/content/26-nn-line.js (the neural line model's plain-JS forward pass and stretch decoder) and its
// shipped weights 26-nn-model.js, on synthetic input (the training transcripts stay private).
import { assert, assertEquals } from './assert.js';
import { loadBAS } from './load.js';

const BAS = loadBAS();
const NL = BAS.nnLine, NM = BAS.nnModel;
const lines = (rows) => rows.map(([a, b, n]) => ({ a, b, n }));

Deno.test('nnLine: a tiny hand-made network gives the GRU / GELU / embedding arithmetic exactly', () => {
  // E = 1, H = 1, one layer: every weight a float tensor so the expected value can be worked out by hand
  const f = (xs) => btoa(String.fromCharCode(...new Uint8Array(Float32Array.from(xs).buffer)));
  const T = (shape, xs) => ({ shape, f: f(xs) });
  const nx = 8, D = 2 + nx;
  const m = {
    cfg: { emb: 1, hid: 1, layers: 1, bits: 2, chars: 4, s0: 0 }, vocab: 'a', mu: null, sd: null,
    w: {
      'eu.weight': T([3, 1], [0, 0.5, 1]), 'eg.weight': T([5, 1], [0, 0, 0, 0, 0]),
      'inp.weight': T([1, D], [1, 1, 0, 0, 0, 0, 0, 0, 0, 0]), 'inp.bias': T([1], [0]),
      'rnn.weight_ih_l0': T([3, 1], [0, 0, 1]), 'rnn.weight_hh_l0': T([3, 1], [0, 0, 0]), 'rnn.bias_ih_l0': T([3], [0, -100, 0]), 'rnn.bias_hh_l0': T([3], [0, 0, 0]),
      'rnn.weight_ih_l0_reverse': T([3, 1], [0, 0, 0]), 'rnn.weight_hh_l0_reverse': T([3, 1], [0, 0, 0]), 'rnn.bias_ih_l0_reverse': T([3], [0, -100, 0]), 'rnn.bias_hh_l0_reverse': T([3], [0, 0, 0]),
      'out.weight': T([1, 2], [2, 0]), 'out.bias': T([1], [0.25]),
    },
  };
  const net = NL.load(m);
  // 'a' is vocabulary id 2 (vector 1): mean 1, max 1 → input 2 → GELU(2); z ≈ 0 so h = tanh(GELU(2)); logit = 2h + 0.25
  const gelu2 = 2 * 0.5 * (1 + 0.9544997361036416);   // GELU(2) = 2 Φ(2), erf(√2)
  const z = NL.scores(net, lines([[0, 2, 'a']]), 10, null);
  assert(Math.abs(z[0] - (2 * Math.tanh(gelu2) + 0.25)) < 1e-5, String(z[0]));
  // an unknown character is id 1 (vector 0.5); an empty line reads as zeros
  const z2 = NL.scores(net, lines([[0, 2, 'b'], [3, 4, '']]), 10, null);
  assert(Math.abs(z2[0] - (2 * Math.tanh(0.5 * 1 * (1 + 0.6826894921370859)) + 0.25)) < 1e-5, String(z2[0]));
  assert(Math.abs(z2[1] - 0.25) < 1e-6, String(z2[1]));
  assertEquals(NL.scores(net, [], 10, null).length, 0);
});

Deno.test('nnLine decoder: hysteresis, gap merging, edge trimming, minimum length', () => {
  const L = Array.from({ length: 30 }, (_, i) => ({ a: 2 * i, b: 2 * i + 1.8 }));
  const p = new Float64Array(30);
  for (const i of [5, 6, 7, 8, 9, 10]) p[i] = 0.99;
  p[4] = 0.6; p[11] = 0.6;                        // extended into (≥ lo), then trimmed off again (< edge)
  for (const i of [14, 15, 16, 17, 18]) p[i] = 0.99;  // 6.2 s after the first run: merged across a 6 s+ gap
  for (const i of [25]) p[i] = 0.99;              // alone: shorter than 8 s
  const D = { hi: 0.95, lo: 0.5, w: 0, gap: 6, edge: 0.95 };
  assertEquals(NL.stretches(p, L, Object.assign({}, D, { gap: 7 })), [[5, 18]]);
  assertEquals(NL.stretches(p, L, Object.assign({}, D, { gap: 1 })), [[5, 10], [14, 18]]);
  p[18] = 0;                                       // 14…17 alone is 7.8 s: too short to be a read
  assertEquals(NL.stretches(p, L, Object.assign({}, D, { gap: 1 })), [[5, 10]]);
  assertEquals(NL.stretches(new Float64Array(30), L, D), []);
  assertEquals(NL.stretches(new Float64Array(0), [], D), []);
});

Deno.test('nn model: shipped weights load, every line gets a finite score, and the scorer fits the feature row', () => {
  if (!NM) return;   // the extension also works without it (the phrase-table path)
  const net = NL.load(NM.net);
  const text = ['大家好今天我们来聊聊这个话题', '本期视频由某某品牌赞助', 'emoji 😀 and English', '', '0000年的事情'];
  const L = lines(text.map((n, i) => [3 * i, 3 * i + 2.5, n]));
  const z = NL.scores(net, L, 60, null);
  assertEquals(z.length, L.length);
  assert(Array.from(z).every(Number.isFinite), String(Array.from(z)));
  const p = Float64Array.from(z, (x) => 1 / (1 + Math.exp(-x)));
  const old = NM.old ? { ps: new Float64Array(L.length).fill(0.5), p0: new Float64Array(L.length).fill(0.5) } : null;
  const f = NL.features(p, L, 60, 0, L.length - 1, 0, null, NM.mu, NM.sd, old);
  assertEquals(f.length, NM.sc.mu.length);
  const pr = NL.probability(f, NM.sc);
  assert(pr >= 0 && pr <= 1, String(pr));
  // deterministic
  assertEquals(Array.from(NL.scores(net, L, 60, null)), Array.from(z));
});

Deno.test('detectSubtitles.warm: the network\'s scores in stages give exactly the detection of the one-go path', async () => {
  if (!NM) return;
  const D = BAS.detectSubtitles;
  const topic = ['这一年他回到了老家', '村里的人都很惊讶', '那时候的条件很差', '他每天天不亮就出门'];
  const read = ['说到熬夜剪视频', '我最近一直在用小象家的电动牙刷', '小象家电动牙刷有三种清洁模式', '评论区置顶链接就能领券下单'];
  const body = [];
  for (let t = 0; t < 600; t += 3) body.push({ from: t, to: t + 2, content: t >= 300 && t < 312 ? read[(t - 300) / 3] : topic[(t / 3) % topic.length] });
  const media = { danmaku: [{ t: 301, text: '恰饭了' }], heat: null };
  let pauses = 0;
  const L = await D.warm(body, 600, undefined, media, () => { pauses++; return Promise.resolve(); });
  assert(pauses >= 3 && L.nnz && L.nnz.z.length === L.length, String(pauses));
  const warmed = D(L, 600, undefined, media), direct = D(body, 600, undefined, media);
  assertEquals(JSON.stringify(warmed), JSON.stringify(direct));
  // other media: the cached scores are not used
  assertEquals(JSON.stringify(D(L, 600, undefined, null)), JSON.stringify(D(body, 600, undefined, null)));
});
