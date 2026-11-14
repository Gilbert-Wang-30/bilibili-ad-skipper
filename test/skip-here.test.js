// Tests for src/content/35-skip-here.js (BAS.findAdEnd: "skip the ad playing now" for ads the detectors missed).
import { assert, assertEquals } from './assert.js';
import { loadBAS, loadFullFixture, toDanmaku, loadExpected, hasFullFixtures } from './load.js';
// The real-danmaku corpus (test/fixtures-full/) is third-party user content and is not distributed; see README.
const HAS_CORPUS = hasFullFixtures();

const BAS = loadBAS();
const F = BAS.findAdEnd;
const dm = (rows) => rows.map(([t, text]) => ({ t, text }));
const bg = (from, to) => { const r = []; for (let t = from; t < to; t += 2.3) r.push([t, '哈哈哈']); return r; };

Deno.test('findAdEnd: a segment it was sure of covering now: a second before its end; one it was not sure of: a short step', () => {
  const r = F({ t: 300, duration: 900, danmaku: [], candidates: [{ start: 250, end: 360, confidence: 0.9 }, { start: 600, end: 700, confidence: 0.9 }] });
  assertEquals([r.source, r.end, r.start, r.trusted], ['candidate', 359, 250, true]);
  assert(/90%/.test(r.reason));
  const weak = F({ t: 300, duration: 900, danmaku: [], candidates: [{ start: 250, end: 360, confidence: 0.45 }] });
  assertEquals([weak.source, weak.end, weak.trusted], ['fallback', 305, false]);
  // close to its end: the weak hint itself
  assertEquals(F({ t: 357, duration: 900, danmaku: [], candidates: [{ start: 250, end: 361, confidence: 0.45 }] }).end, 361);
});

Deno.test('findAdEnd: agreeing 空降 coordinates posted at the ad start give the end and an estimated start', () => {
  const rows = bg(200, 420).concat([[254, '空降6:00'], [255, '空降 6:00'], [257, '跳伞6:01'], [362, '欢迎回来'], [363, '欢迎回来']]);
  const r = F({ t: 300, duration: 900, danmaku: dm(rows).sort((a, b) => a.t - b.t) });
  assertEquals(r.source, 'targets');
  assert(r.end >= 358 && r.end <= 360, 'a second before 6:00, got ' + r.end);
  assert(r.start >= 254 && r.start <= 300, 'start from the cue burst, got ' + r.start);
  assert(/空降 3 条/.test(r.reason) && /落地确认/.test(r.reason), r.reason);
});

Deno.test('findAdEnd: landing markers alone are a hint, used only within a step; lone bare numbers are ignored', () => {
  const rows = dm(bg(200, 420).concat([[362, '欢迎回来'], [363, '空降成功']])).sort((a, b) => a.t - b.t);
  const far = F({ t: 300, duration: 900, danmaku: rows });
  assertEquals([far.source, far.end, far.trusted], ['fallback', 305, false]);
  const near = F({ t: 356, duration: 900, danmaku: rows });
  assertEquals([near.source, near.end], ['thanks', 360]);
  const bare = F({ t: 300, duration: 900, danmaku: dm([[290, '520'], [291, '520']]) });
  assertEquals(bare.source, 'fallback');
});

Deno.test('findAdEnd: a number the viewers also post long after its time is a name (a car model), not the end', () => {
  // 'A110' / '110' talked about all through the video: never a jump to 1:10
  const rows = []; for (let t = 10; t < 500; t += 15) rows.push([t, t % 2 ? '110真帅' : '阿尔派110']);
  for (const [t, x] of [[20, '空降1:10'], [21, '110'], [22, '110']]) rows.push([t, x]);
  const list = dm(rows).sort((a, b) => a.t - b.t);
  const r = F({ t: 30, duration: 600, danmaku: list });
  assert(r.source !== 'targets', JSON.stringify([r.source, r.end]));
  assert(BAS.util.nameNumbers(list, 600).has(70));
  assertEquals(BAS.util.extractTargets('A 110', 20, 600).length, 0);
  // a real landing code: posted before its time (and thanked just after it) is not a name
  const code = dm([[100, '745工程'], [101, '745'], [102, '745'], [468, '感谢745工程']]);
  assertEquals(BAS.util.nameNumbers(code, 900).size, 0);
});

Deno.test('findAdEnd: the heat peak is a hint, used only within a step', () => {
  const heat = { usable: true, step: 25, runs: [{ start: 225, end: 375, peakStart: 350, peakEnd: 375, n: 6, ramp: 1, peakFromEnd: 0, ratio: 12, adLike: true }] };
  const a = F({ t: 280, duration: 2400, danmaku: [], heat });
  assertEquals([a.source, a.end, a.trusted], ['fallback', 285, false]);
  assert(/还在广告里可再按/.test(a.reason), a.reason);
  const b = F({ t: 371, duration: 2400, danmaku: [], heat: Object.assign({}, heat, { step: 6 }) });
  assertEquals([b.source, b.end], ['heat', 375]);
});

Deno.test('findAdEnd: a chapter boundary within a step, else a 5 s step, and null near the end of the video', () => {
  assertEquals(F({ t: 100, duration: 900, boundaries: [50, 104.5, 400] }).end, 104.5);
  assertEquals(F({ t: 100, duration: 900, boundaries: [50, 115, 400] }).source, 'fallback');
  const f = F({ t: 100, duration: 900 });
  assertEquals([f.source, f.end, f.trusted], ['fallback', 105, false]);
  assertEquals(F({ t: 897, duration: 900 }), null);
  assertEquals(F({ t: NaN, duration: 900 }), null);
});

Deno.test('findAdEnd: fast on a dense danmaku list', () => {
  const rows = []; for (let i = 0; i < 20000; i++) rows.push([i * 0.12, i % 7 === 0 ? '空降' + (i % 60) + ':3' + (i % 10) : '哈哈哈哈']);
  const t0 = performance.now();
  F({ t: 1200, duration: 2400, danmaku: dm(rows) });
  assert(performance.now() - t0 < 150, 'took ' + (performance.now() - t0).toFixed(0) + ' ms');
});

// (on one of them the viewers' 空降 coordinates point 6 s past the frame-measured end: a press lands up to 5 s late there)
Deno.test({ name: 'findAdEnd on the measured ads: pressing until the ad is over lands at its end, never far past it', ignore: !HAS_CORPUS }, () => {
  const exp = loadExpected();
  let n = 0, within3 = 0;
  for (const [bv, [tr]] of Object.entries(exp.segments)) {
    const fx = loadFullFixture(bv);
    const list = toDanmaku(fx.dm);
    for (const t0 of [tr.start + 5, (tr.start + tr.end) / 2, tr.end - 20]) {
      let t = t0, r = null;
      for (let k = 0; k < 40; k++) {
        r = F({ t, duration: fx.duration, danmaku: list, candidates: [] });
        assert(r.end - tr.end <= 6, `${bv} press at ${t.toFixed(0)}: end ${r.end} vs ${tr.end} (${r.source})`);
        if (r.end >= tr.end - 3) break;
        t = r.end;
      }
      n++; if (Math.abs(r.end - tr.end) <= 3) within3++;
    }
  }
  assert(within3 >= n * 0.85, `presses end within 3 s: ${within3}/${n}`);   // 18 / 21: the 3 misses are that ad
});
