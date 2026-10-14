// Tests for src/content/32-media.js — pure math (BAS.mediaMath) and MediaAnalyzer cut bookkeeping.
import { loadBAS } from './load.js';

// Minimal asserts (no remote std import → no network in tests).
function assert(cond, msg) { if (!cond) throw new Error('Assertion failed' + (msg ? ': ' + msg : '')); }
function assertStrictEquals(a, b, msg) { if (!Object.is(a, b)) throw new Error(`Expected ${String(b)}, got ${String(a)}` + (msg ? ' — ' + msg : '')); }
function assertEquals(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb && !Object.is(a, b)) throw new Error(`Expected ${sb}, got ${sa}` + (msg ? ' — ' + msg : ''));
}
function assertAlmostEquals(a, b, eps = 1e-7, msg) { if (!(Math.abs(a - b) <= eps)) throw new Error(`Expected ${a} ≈ ${b} (±${eps})` + (msg ? ' — ' + msg : '')); }

let BAS;
try { BAS = loadBAS(); } catch (_) { BAS = null; }
if (!BAS || !BAS.mediaMath) BAS = loadBAS(['00-ns.js', '32-media.js']);
// loadBAS caches the first successful load; make sure our module is present either way.
if (!BAS.mediaMath) {
  const src = Deno.readTextFileSync(new URL('../src/content/32-media.js', import.meta.url));
  new Function(src)();
  BAS = globalThis.BAS;
}
const M = BAS.mediaMath;
const W = 32, H = 18, N = W * H;

// ---------- helpers ----------
function flatFrame(v) {
  const d = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N * 4; i += 4) { d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  return d;
}
function invert(frame) {
  const d = new Uint8ClampedArray(frame.length);
  for (let i = 0; i < frame.length; i += 4) { d[i] = 255 - frame[i]; d[i + 1] = 255 - frame[i + 1]; d[i + 2] = 255 - frame[i + 2]; d[i + 3] = 255; }
  return d;
}
/** Deterministic pseudo-random noise frame (LCG) so tests are stable. */
function noiseFrame(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const d = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N * 4; i += 4) { d[i] = rnd() * 255; d[i + 1] = rnd() * 255; d[i + 2] = rnd() * 255; d[i + 3] = 255; }
  return d;
}
function feats(frame) { return M.frameFeatures(frame, W, H); }

class FakeVideo {
  constructor() { this.paused = true; this.ended = false; this.listeners = {}; this.currentTime = 0; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { const l = this.listeners[type]; if (l) this.listeners[type] = l.filter((f) => f !== fn); }
  listenerCount() { return Object.values(this.listeners).reduce((a, l) => a + l.length, 0); }
}

// ---------- frameFeatures ----------
Deno.test('frameFeatures: flat gray → mean and one histogram bin', () => {
  const f = feats(flatFrame(50));
  assertEquals(f.mean, 50);
  assertEquals(f.hist.length, 16);
  assertAlmostEquals(f.hist[50 >> 4], 1, 1e-6);
  let sum = 0; for (const b of f.hist) sum += b;
  assertAlmostEquals(sum, 1, 1e-6);
  assertEquals(f.gray.length, N);
  assertEquals(f.gray[0], 50);
});

Deno.test('frameFeatures: gray = (r+g+b)/3 and reuses provided buffers', () => {
  const d = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N * 4; i += 4) { d[i] = 30; d[i + 1] = 60; d[i + 2] = 90; d[i + 3] = 255; }
  const out = { gray: new Uint8Array(N), hist: new Float32Array(16) };
  const f = M.frameFeatures(d, W, H, out);
  assertStrictEquals(f, out);
  assertStrictEquals(f.gray, out.gray);
  assertEquals(f.gray[7], 60);
  assertEquals(f.mean, 60);
});

// ---------- frameDiff + isCut ----------
Deno.test('hard cut: flat gray vs inverted is a cut', () => {
  const a = feats(flatFrame(50)), b = feats(invert(flatFrame(50)));
  const d = M.frameDiff(a, b);
  assertEquals(d.mad, 155);
  assertAlmostEquals(d.histDist, 2, 1e-6);
  assert(M.isCut(d, NaN));          // no history yet
  assert(M.isCut(d, 10));           // calm history
  assert(M.cutStrength(d) === 1);
});

Deno.test('identical frames: no cut', () => {
  const a = feats(flatFrame(120)), b = feats(flatFrame(120));
  const d = M.frameDiff(a, b);
  assertEquals(d.mad, 0);
  assertEquals(d.histDist, 0);
  assert(!M.isCut(d, 0));
});

Deno.test('gradual brightness ramp (fade) is NOT a cut at any step', () => {
  const med = new M.RollingMedian(15);
  let prev = feats(flatFrame(0));
  let cuts = 0;
  for (let v = 4; v <= 255; v += 4) {           // +4 per sample ≈ 1.3 s fade at 5 fps from black to white
    const cur = feats(flatFrame(v));
    const d = M.frameDiff(prev, cur);
    if (M.isCut(d, med.median)) cuts++;
    med.push(d.mad);
    prev = cur;
  }
  assertEquals(cuts, 0);
});

Deno.test('a small step that crosses a histogram bin boundary is not a cut (hist high, mad low)', () => {
  const d = M.frameDiff(feats(flatFrame(63)), feats(flatFrame(64)));
  assertAlmostEquals(d.histDist, 2, 1e-6);
  assertEquals(d.mad, 1);
  assert(!M.isCut(d, 0));
});

Deno.test('hard cut inside a fade sequence is detected', () => {
  const med = new M.RollingMedian(15);
  let prev = feats(flatFrame(20));
  const hits = [];
  const frames = [];
  for (let v = 24; v <= 80; v += 4) frames.push(flatFrame(v));   // slow ramp
  frames.push(invert(flatFrame(80)));                             // hard cut → 175
  frames.push(flatFrame(176));
  frames.forEach((fr, i) => {
    const cur = feats(fr);
    const d = M.frameDiff(prev, cur);
    if (M.isCut(d, med.median)) hits.push(i);
    med.push(d.mad);
    prev = cur;
  });
  assertEquals(hits, [frames.length - 2]);
});

Deno.test('adaptive rule: high-motion content raises the bar (mad must exceed 2.5 × median)', () => {
  assert(!M.isCut({ mad: 100, histDist: 1.0 }, 60));   // 100 < 150
  assert(M.isCut({ mad: 160, histDist: 1.0 }, 60));    // 160 > 150
  assert(!M.isCut({ mad: 45, histDist: 0.5 }, 0));     // hist below threshold
  assert(!M.isCut({ mad: 39, histDist: 1.5 }, 0));     // mad below threshold
  assert(!M.isCut(null, 0));
});

Deno.test('random noise frames: high mad but flat histograms → never a cut', () => {
  const med = new M.RollingMedian(15);
  let prev = feats(noiseFrame(1));
  let cuts = 0;
  for (let i = 2; i < 40; i++) {
    const cur = feats(noiseFrame(i * 7919));
    const d = M.frameDiff(prev, cur);
    assert(d.mad > 40, 'noise should have large mad');
    if (M.isCut(d, med.median)) cuts++;
    med.push(d.mad);
    prev = cur;
  }
  assertEquals(cuts, 0);
});

// ---------- RollingMedian ----------
Deno.test('RollingMedian: window semantics', () => {
  const r = new M.RollingMedian(5);
  assert(Number.isNaN(r.median));
  r.push(5); assertEquals(r.median, 5);
  r.push(1); assertEquals(r.median, 3);          // even count → average of middle two
  r.push(9); assertEquals(r.median, 5);
  r.push(7); r.push(3); assertEquals(r.median, 5);   // [5,1,9,7,3]
  r.push(100);                                       // evicts 5 → [1,9,7,3,100]
  assertEquals(r.median, 7);
  r.push(100); r.push(100);                          // [7,3,100,100,100]
  assertEquals(r.median, 100);
  r.clear(); assert(Number.isNaN(r.median)); assertEquals(r.length, 0);
  r.push(NaN); assertEquals(r.length, 0);            // ignored
});

Deno.test('RollingMedian: matches a naive median over a long random stream', () => {
  const r = new M.RollingMedian(15);
  const hist = [];
  let s = 42;
  for (let i = 0; i < 500; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const v = (s % 1000) / 10;
    r.push(v); hist.push(v); if (hist.length > 15) hist.shift();
    assertAlmostEquals(r.median, BAS.util.median(hist), 1e-9);
  }
});

// ---------- audio math ----------
Deno.test('rmsDb: silence clamps to -100, 0.5-amplitude sine ≈ -9.03 dBFS', () => {
  assertEquals(M.rmsDb(new Float32Array(1024)), -100);
  assertEquals(M.rmsDb(new Float32Array(0)), -100);
  assertEquals(M.rmsDb(null), -100);
  const sine = new Float32Array(48000);
  for (let i = 0; i < sine.length; i++) sine[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  assertAlmostEquals(M.rmsDb(sine), 20 * Math.log10(0.5 / Math.SQRT2), 0.02);
  const full = new Float32Array(16).fill(1);
  assertEquals(M.rmsDb(full), 0);
});

Deno.test('spectralCentroid: single bin is exact, higher energy → higher centroid, zero spectrum → 0', () => {
  const sr = 48000, fft = 1024, bins = fft / 2;
  const one = new Uint8Array(bins); one[10] = 200;
  assertAlmostEquals(M.spectralCentroid(one, sr, fft), (10 * sr) / fft, 1e-9);
  const low = new Uint8Array(bins), mid = new Uint8Array(bins), high = new Uint8Array(bins);
  for (let k = 0; k < bins; k++) { low[k] = k < 40 ? 150 : 5; mid[k] = k > 100 && k < 200 ? 150 : 5; high[k] = k > 400 ? 150 : 5; }
  const cl = M.spectralCentroid(low, sr, fft), cm = M.spectralCentroid(mid, sr, fft), ch = M.spectralCentroid(high, sr, fft);
  assert(cl < cm && cm < ch, `${cl} < ${cm} < ${ch}`);
  assertEquals(M.spectralCentroid(new Uint8Array(bins), sr, fft), 0);
  assertEquals(M.spectralCentroid(null, sr, fft), 0);
  // monotonic in a sweep
  let last = -1;
  for (let k = 0; k < bins; k += 37) { const s = new Uint8Array(bins); s[k] = 100; const c = M.spectralCentroid(s, sr, fft); assert(c > last); last = c; }
});

Deno.test('audioChange: dB jump, centroid ratio, silence guard, sustained strength', () => {
  assertEquals(M.audioChange({ db: -20, cen: 1000 }, { db: -22, cen: 1100 }).changed, false);
  const byDb = M.audioChange({ db: -12, cen: 1000 }, { db: -22, cen: 1000 });
  assert(byDb.changed && byDb.strength >= 0.3 && byDb.strength <= 1);
  const byCen = M.audioChange({ db: -20, cen: 2000 }, { db: -21, cen: 1000 });
  assert(byCen.changed);
  // centroid ratio is ignored when either sample is silent (noise floor has random centroid)
  assertEquals(M.audioChange({ db: -70, cen: 3000 }, { db: -72, cen: 300 }).changed, false);
  // but a dB jump out of silence counts
  assert(M.audioChange({ db: -20, cen: 1000 }, { db: -80, cen: 300 }).changed);
  // bigger change → stronger
  assert(M.audioChange({ db: 0, cen: 1000 }, { db: -30, cen: 1000 }).strength > byDb.strength);
});

// ---------- MediaAnalyzer bookkeeping (no sampling: paused FakeVideo) ----------
Deno.test('MediaAnalyzer: construct/attach/start on a paused fake video does not sample', () => {
  const v = new FakeVideo();
  const got = [];
  const a = new BAS.MediaAnalyzer(v, { onCut: (c, how) => got.push([c, how]) });
  assert(v.listenerCount() > 0, 'listeners registered');
  a.start();
  const st = a.stats();
  assertEquals(st.running, true);
  assertEquals(st.videoLoop, 'off');
  assertEquals(st.videoSamples, 0);
  assertEquals(st.audio, 'off');
  assertEquals(a.cuts.length, 0);
  a.stop();
  assertEquals(a.stats().running, false);
  a.destroy();
  assertEquals(v.listenerCount(), 0, 'listeners removed on destroy');
  assertEquals(got.length, 0);
});

Deno.test('MediaAnalyzer: _pushCut keeps cuts sorted, debounces 0.4 s, upgrades to both', () => {
  const v = new FakeVideo();
  const events = [];
  const a = new BAS.MediaAnalyzer(v, { onCut: (c, how) => events.push(how + '@' + c.t + ':' + c.kind) });
  a._pushCut({ t: 30, strength: 0.5, kind: 'video' });
  a._pushCut({ t: 10, strength: 0.6, kind: 'video' });
  a._pushCut({ t: 20, strength: 0.7, kind: 'black' });
  assertEquals(a.cuts.map((c) => c.t), [10, 20, 30]);

  // debounce: same family within 0.4 s merges, keeps max strength
  const m = a._pushCut({ t: 10.2, strength: 0.9, kind: 'video' });
  assertEquals(a.cuts.length, 3);
  assertStrictEquals(m, a.cuts[0]);
  assertEquals(a.cuts[0].strength, 0.9);
  const dup = a._pushCut({ t: 10.3, strength: 0.1, kind: 'video' });
  assertStrictEquals(dup, a.cuts[0]);
  assertEquals(a.cuts[0].strength, 0.9);

  // audio within 0.6 s of a video cut → upgrade the existing entry (timestamp stays visual)
  a._pushCut({ t: 30.5, strength: 0.4, kind: 'audio' });
  assertEquals(a.cuts.length, 3);
  assertEquals(a.cuts[2].kind, 'both');
  assertEquals(a.cuts[2].t, 30);
  assert(a.cuts[2].strength > 0.5);

  // audio far from any video cut → own entry
  a._pushCut({ t: 40, strength: 0.5, kind: 'audio' });
  assertEquals(a.cuts.map((c) => c.kind), ['video', 'black', 'both', 'audio']);

  // video arriving after an audio cut adopts the video timestamp and re-sorts
  a._pushCut({ t: 39.6, strength: 0.6, kind: 'video' });
  assertEquals(a.cuts.length, 4);
  assertEquals(a.cuts[3].kind, 'both');
  assertEquals(a.cuts[3].t, 39.6);
  for (let i = 1; i < a.cuts.length; i++) assert(a.cuts[i - 1].t <= a.cuts[i].t, 'sorted');

  // black upgrades a nearby video cut's kind
  a._pushCut({ t: 50, strength: 0.5, kind: 'video' });
  a._pushCut({ t: 50.1, strength: 0.6, kind: 'black' });
  assertEquals(a.cuts[4].kind, 'black');

  // rejected inputs
  assertEquals(a._pushCut(null), null);
  assertEquals(a._pushCut({ t: NaN }), null);
  assertEquals(a._pushCut({ t: -1 }), null);

  assert(events.includes('new@10:video'));
  assert(events.includes('upgrade@30:both'));
  a.destroy();
});

Deno.test('MediaAnalyzer: nearestCut and cutsBetween', () => {
  const a = new BAS.MediaAnalyzer(new FakeVideo(), {});
  const data = [[12, 0.5, 'video'], [60, 1.0, 'both'], [63, 0.4, 'video'], [100, 0.7, 'black'], [250, 0.6, 'video'], [252, 0.6, 'audio']];
  for (const [t, strength, kind] of data) a._pushCut({ t, strength, kind });
  assertEquals(a.cuts.length, 6);

  assertEquals(a.nearestCut(12.3, 4).t, 12);
  assertEquals(a.nearestCut(20, 4), null);                   // nothing within window
  assertEquals(a.nearestCut(98, 4).t, 100);
  assertEquals(a.nearestCut(5, 10).t, 12);
  // strength preference: at t=62 the 1.0 cut at 60 (dist 2) beats the 0.4 cut at 63 (dist 1): 2+0 < 1+1.2
  assertEquals(a.nearestCut(62, 4).t, 60);
  // at t=63 the weak one is exactly on target: 0+1.2 < 3+0
  assertEquals(a.nearestCut(63, 4).t, 63);
  // equal strength → nearest
  assertEquals(a.nearestCut(251.2, 4).t, 252);
  assertEquals(a.nearestCut(250.8, 4).t, 250);
  assertEquals(a.nearestCut(NaN, 4), null);
  assertEquals(a.nearestCut(12), a.cuts[0]);                 // default window 4

  assertEquals(a.cutsBetween(0, 50).map((c) => c.t), [12]);
  assertEquals(a.cutsBetween(60, 100).map((c) => c.t), [60, 63, 100]);   // inclusive ends
  assertEquals(a.cutsBetween(101, 249), []);
  assertEquals(a.cutsBetween(300, 10), []);
  assertEquals(a.cutsBetween(-10, 1000).length, 6);
  a.destroy();
});

Deno.test('MediaAnalyzer: cap at 2000 entries, oldest dropped; clearCuts; attach swaps listeners', () => {
  const v1 = new FakeVideo(), v2 = new FakeVideo();
  const a = new BAS.MediaAnalyzer(v1, {});
  for (let i = 0; i < 2300; i++) a._pushCut({ t: i * 2, strength: 0.5, kind: 'video' });
  assertEquals(a.cuts.length, BAS.MediaAnalyzer.MAX_CUTS);
  assertEquals(a.cuts[0].t, 600);
  assertEquals(a.cuts[a.cuts.length - 1].t, 4598);

  a.attach(v2);
  assertEquals(v1.listenerCount(), 0);
  assert(v2.listenerCount() > 0);
  assertEquals(a.cuts.length, 2000, 'cuts survive re-attach');
  a.attach(v2);                                              // same element: no-op
  assertEquals(a.stats().attached, true);

  a.clearCuts();
  assertEquals(a.cuts.length, 0);
  a.destroy();
  assertEquals(v2.listenerCount(), 0);
  a.destroy();                                               // idempotent
  a.start();                                                 // no-op after destroy
  assertEquals(a.stats().running, false);
});

Deno.test('MediaAnalyzer: swallows a throwing onCut callback', () => {
  const a = new BAS.MediaAnalyzer(new FakeVideo(), { onCut: () => { throw new Error('boom'); } });
  const c = a._pushCut({ t: 5, strength: 0.5, kind: 'video' });
  assert(c);
  assertEquals(a.cuts.length, 1);
  assert(a.stats().errors >= 1);
  a.destroy();
});
