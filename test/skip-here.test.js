// Tests for src/content/35-skip-here.js (BAS.findAdEnd: "skip the ad playing now" for ads the detectors missed).
import { assert, assertEquals } from './assert.js';
import { loadBAS, loadFullFixture, toDanmaku, loadExpected, hasFullFixtures } from './load.js';
// The real-danmaku corpus (test/fixtures-full/) is third-party user content and is not distributed; see README.
const HAS_CORPUS = hasFullFixtures();

const BAS = loadBAS();
const F = BAS.findAdEnd;
const dm = (rows) => rows.map(([t, text]) => ({ t, text }));
const bg = (from, to) => { const r = []; for (let t = from; t < to; t += 2.3) r.push([t, '哈哈哈']); return r; };

Deno.test('findAdEnd: an existing low-confidence segment covering now wins', () => {
  const r = F({ t: 300, duration: 900, danmaku: [], candidates: [{ start: 250, end: 360, confidence: 0.45 }, { start: 600, end: 700, confidence: 0.9 }] });
  assertEquals([r.source, r.end, r.start], ['candidate', 360, 250]);
  assert(/45%/.test(r.reason));
});

Deno.test('findAdEnd: agreeing 空降 coordinates posted at the ad start give the end and an estimated start', () => {
  const rows = bg(200, 420).concat([[254, '空降6:00'], [255, '空降 6:00'], [257, '跳伞6:01'], [362, '欢迎回来'], [363, '欢迎回来']]);
  const r = F({ t: 300, duration: 900, danmaku: dm(rows).sort((a, b) => a.t - b.t) });
  assertEquals(r.source, 'targets');
  assert(Math.abs(r.end - 360) <= 1, 'end ≈ 6:00, got ' + r.end);
  assert(r.start >= 254 && r.start <= 300, 'start from the cue burst, got ' + r.start);
  assert(/空降 3 条/.test(r.reason) && /落地确认/.test(r.reason), r.reason);
});

Deno.test('findAdEnd: landing markers alone give the end; lone bare numbers are ignored', () => {
  const thanks = F({ t: 300, duration: 900, danmaku: dm(bg(200, 420).concat([[362, '欢迎回来'], [363, '空降成功']])).sort((a, b) => a.t - b.t) });
  assertEquals(thanks.source, 'thanks');
  assertEquals(thanks.end, 360);
  const bare = F({ t: 300, duration: 900, danmaku: dm([[290, '520'], [291, '520']]) });
  assertEquals(bare.source, 'fallback');
});

Deno.test('findAdEnd: heat ramp containing now; a second press near its peak jumps the far half', () => {
  const heat = { usable: true, step: 25, runs: [{ start: 225, end: 375, peakStart: 350, peakEnd: 375, n: 6, ramp: 1, peakFromEnd: 0, ratio: 12, adLike: true }] };
  const a = F({ t: 280, duration: 2400, danmaku: [], heat });
  assertEquals([a.source, a.end], ['heat', 375]);
  const b = F({ t: 370, duration: 2400, danmaku: [], heat });
  assertEquals(b.end, 387.5);
});

Deno.test('findAdEnd: only a near chapter boundary, then a 15 s step, and null near the end of the video', () => {
  assertEquals(F({ t: 100, duration: 900, boundaries: [50, 115, 400] }).end, 115);
  // a far boundary was 54 s past the ad's end (median) on crowd-labelled ads: not used
  assertEquals(F({ t: 100, duration: 900, boundaries: [50, 160, 400] }).source, 'fallback');
  const f = F({ t: 100, duration: 900 });
  assertEquals([f.source, f.end], ['fallback', 115]);
  assertEquals(F({ t: 897, duration: 900 }), null);
  assertEquals(F({ t: NaN, duration: 900 }), null);
});

Deno.test('findAdEnd: fast on a dense danmaku list', () => {
  const rows = []; for (let i = 0; i < 20000; i++) rows.push([i * 0.12, i % 7 === 0 ? '空降' + (i % 60) + ':3' + (i % 10) : '哈哈哈哈']);
  const t0 = performance.now();
  F({ t: 1200, duration: 2400, danmaku: dm(rows) });
  assert(performance.now() - t0 < 150, 'took ' + (performance.now() - t0).toFixed(0) + ' ms');
});

Deno.test({ name: 'findAdEnd on the measured ads: presses early / mid / late land near the real end', ignore: !HAS_CORPUS }, () => {
  const exp = loadExpected();
  let n = 0, within3 = 0;
  for (const [bv, [tr]] of Object.entries(exp.segments)) {
    const fx = loadFullFixture(bv);
    const list = toDanmaku(fx.dm);
    for (const t of [tr.start + 5, (tr.start + tr.end) / 2, tr.end - 20]) {
      const r = F({ t, duration: fx.duration, danmaku: list, candidates: [] });
      const err = Math.abs(r.end - tr.end);
      assert(err <= 10, `${bv} press at ${t.toFixed(0)}: end ${r.end} vs ${tr.end} (${r.source})`);
      n++; if (err <= 3) within3++;
    }
  }
  assert(within3 >= n * 0.7, `most presses within 3 s: ${within3}/${n}`);
});
