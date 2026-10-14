// Tests for src/content/33-fusion.js (BAS.fuse)
import { ok as assert, deepStrictEqual as assertEquals, strictEqual as assertStrictEquals } from 'node:assert';
import { loadBAS } from './load.js';

function bas() {
  try { return loadBAS(); } catch (_e) { return loadBAS(['00-ns.js', '30-detect-chapters.js', '33-fusion.js', '40-skipper.js']); }
}
const BAS = bas();
const S = BAS.DEFAULT_SETTINGS;

const chapter = (start, end, extra) => Object.assign({ start, end, source: 'chapter', confidence: 0.95, reason: '章节「广告」' }, extra);
const danmaku = (start, end, confidence, extra) => Object.assign({ start, end, source: 'danmaku', confidence, reason: '弹幕 10 条' }, extra);
const fakeMedia = (cuts) => ({
  nearestCut(t, w) {
    let best = null;
    for (const c of cuts) if (Math.abs(c.t - t) <= w && (!best || Math.abs(c.t - t) < Math.abs(best.t - t))) best = c;
    return best;
  },
});

Deno.test('fuse: chapter candidate is authoritative; overlapping danmaku merges into it', () => {
  const segs = BAS.fuse({
    candidates: [chapter(100, 160), danmaku(97, 150, 0.8)],
    duration: 600, boundaries: [100, 160], settings: S,
  });
  assertEquals(segs.length, 1);
  const s = segs[0];
  assertEquals([s.start, s.end], [100, 160]);
  assertStrictEquals(s.source, 'chapter');
  assertEquals(s.sources, ['chapter', 'danmaku']);
  assertStrictEquals(s.confidence, 0.95);
  assertStrictEquals(s.autoSkip, true);
  assert(/弹幕佐证/.test(s.reason));
});

Deno.test('fuse: danmaku overlapping a chapter by <= 40 % of itself stays separate (then merges by overlap rule)', () => {
  // danmaku 50-150 overlaps chapter 130-200 by 20 s of 100 s = 20 % -> not absorbed; still overlapping -> merged in step 5 as union
  const segs = BAS.fuse({ candidates: [chapter(130, 200), danmaku(50, 150, 0.8)], duration: 600, boundaries: [], settings: S });
  assertEquals(segs.length, 1);
  assertEquals([segs[0].start, segs[0].end], [50, 200]);
  assertStrictEquals(segs[0].source, 'chapter');
  assertEquals(segs[0].sources.sort(), ['chapter', 'danmaku']);
  // Non-overlapping: two segments
  const segs2 = BAS.fuse({ candidates: [chapter(300, 360), danmaku(50, 150, 0.8)], duration: 600, boundaries: [], settings: S });
  assertEquals(segs2.map((s) => [s.start, s.end]), [[50, 150], [300, 360]]);
});

Deno.test('fuse.snap: boundary within 10 s wins over cuts; cut within 4 s otherwise; else unchanged', () => {
  const media = fakeMedia([{ t: 203, strength: 0.9 }, { t: 400, strength: 0.5 }]);
  assertEquals(BAS.fuse.snap(205, [210], media), { t: 210, by: 'boundary' });
  assertEquals(BAS.fuse.snap(205, [216], media), { t: 203, by: 'cut' });     // boundary 11 s away -> cut
  assertEquals(BAS.fuse.snap(205, [], media), { t: 203, by: 'cut' });
  assertEquals(BAS.fuse.snap(300, [], media), { t: 300, by: null });
  assertEquals(BAS.fuse.snap(405, [], media), { t: 405, by: null });         // cut 5 s away -> no snap
  assertEquals(BAS.fuse.snap(205, [195, 212], media), { t: 212, by: 'boundary' }); // nearest boundary
  assertEquals(BAS.fuse.snap(205, null, null), { t: 205, by: null });
  // a throwing media object must not break snapping
  assertEquals(BAS.fuse.snap(205, [], { nearestCut() { throw new Error('boom'); } }), { t: 205, by: null });
});

Deno.test('fuse: danmaku start/end snap to boundaries (10 s) and media cuts (4 s)', () => {
  const media = fakeMedia([{ t: 252.4, strength: 1 }, { t: 361, strength: 0.7 }]);
  const segs = BAS.fuse({ candidates: [danmaku(254, 358, 0.9)], duration: 1000, boundaries: [], media, settings: S });
  assertEquals(segs.length, 1);
  assertEquals([segs[0].start, segs[0].end], [252.4, 361]);
  assertEquals(segs[0].evidence.snapped.start.by, 'cut');
  assertEquals(segs[0].evidence.snapped.end.by, 'cut');

  const segs2 = BAS.fuse({ candidates: [danmaku(254, 358, 0.9)], duration: 1000, boundaries: [250, 365], media, settings: S });
  assertEquals([segs2[0].start, segs2[0].end], [250, 365]);
  assertEquals(segs2[0].evidence.snapped.start.by, 'boundary');
  assertEquals(segs2[0].evidence.snapped.end.by, 'boundary');
});

Deno.test('fuse: snapping never collapses a segment', () => {
  // start 100 and end 106 would both snap to boundary 103 -> end snap reverted
  const segs = BAS.fuse({ candidates: [danmaku(100, 106, 0.9)], duration: 1000, boundaries: [103], settings: S });
  assertEquals(segs.length, 1);
  assert(segs[0].end - segs[0].start >= 5);
});

Deno.test('fuse: end === null resolves to the next boundary within 300 s with confidence 0.5', () => {
  const segs = BAS.fuse({ candidates: [danmaku(250, null, 0.4)], duration: 1000, boundaries: [100, 360, 500], settings: S });
  assertEquals(segs.length, 1);
  assertEquals([segs[0].start, segs[0].end], [250, 360]);
  assertStrictEquals(segs[0].confidence, 0.5);
  assertStrictEquals(segs[0].autoSkip, false);
  assertEquals(segs.diagnostics.dropped, []);
});

Deno.test('fuse: end === null with no boundary within 300 s is dropped into diagnostics', () => {
  const segs = BAS.fuse({ candidates: [danmaku(250, null, 0.4)], duration: 1000, boundaries: [100, 600], settings: S });
  assertEquals(segs.length, 0);
  assertEquals(segs.diagnostics.dropped.length, 1);
  assertEquals(segs.diagnostics.dropped[0].start, 250);
  assertStrictEquals(segs.diagnostics.dropped[0].end, null);
  assert(typeof segs.diagnostics.dropped[0].dropReason === 'string');
  const segs2 = BAS.fuse({ candidates: [danmaku(250, null, 0.4)], duration: 1000, settings: S });
  assertEquals(segs2.length, 0);
  assertEquals(segs2.diagnostics.dropped.length, 1);
});

Deno.test('fuse: overrides.ignore removes segments overlapping > 50 %; overrides.add becomes a user segment', () => {
  const segs = BAS.fuse({
    candidates: [danmaku(100, 160, 0.9), danmaku(300, 360, 0.9)],
    duration: 1000, boundaries: [],
    overrides: { ignore: [{ start: 100, end: 160 }, { start: 340, end: 400 }], add: [{ start: 500, end: 530 }] },
    settings: S,
  });
  // 100-160 fully ignored; 300-360 overlaps 340-400 by 20/60 = 33 % -> kept; user 500-530 added
  assertEquals(segs.map((s) => [s.start, s.end, s.source]), [[300, 360, 'danmaku'], [500, 530, 'user']]);
  const user = segs[1];
  assertStrictEquals(user.confidence, 1);
  assertStrictEquals(user.autoSkip, true);
  assertEquals(user.sources, ['user']);
  assertStrictEquals(user.id, 'u:500-530');
  assertEquals(segs.diagnostics.dropped.length, 1);
  assertEquals(segs.diagnostics.dropped[0].start, 100);
});

Deno.test('fuse: clipping to [0, duration-1] and dropping segments shorter than 5 s', () => {
  const segs = BAS.fuse({
    candidates: [chapter(580, 640), danmaku(10, 14, 0.9), danmaku(20, 25, 0.9)],
    duration: 600, boundaries: [], settings: S,
  });
  assertEquals(segs.map((s) => [s.start, s.end]), [[20, 25], [580, 599]]);
  assert(segs.diagnostics.dropped.some((d) => d.start === 10));
});

Deno.test('fuse: merging overlaps unions range, keeps max confidence and unions sources', () => {
  const segs = BAS.fuse({
    candidates: [danmaku(100, 160, 0.7), danmaku(150, 200, 0.9), danmaku(200, 240, 0.3), danmaku(400, 450, 0.5)],
    duration: 1000, boundaries: [], settings: S,
  });
  assertEquals(segs.map((s) => [s.start, s.end]), [[100, 240], [400, 450]]);
  assertStrictEquals(segs[0].confidence, 0.9);
  assertEquals(segs[0].sources, ['danmaku']);
  assertStrictEquals(segs[0].autoSkip, true);
  assertStrictEquals(segs[1].autoSkip, false);

  const merged = BAS.fuse.mergeOverlaps([
    { start: 50, end: 80, source: 'danmaku', confidence: 0.4, sources: ['danmaku'] },
    { start: 10, end: 60, source: 'chapter', confidence: 0.95, sources: ['chapter'] },
    { start: 90, end: 100, source: 'user', confidence: 1 },
  ]);
  assertEquals(merged.map((s) => [s.start, s.end, s.source, s.confidence]), [[10, 80, 'chapter', 0.95], [90, 100, 'user', 1]]);
  assertEquals(merged[0].sources, ['chapter', 'danmaku']);
  assertEquals(merged[1].sources, ['user']);
});

Deno.test('fuse: ids are source-letter:start-end and unique', () => {
  const segs = BAS.fuse({
    candidates: [chapter(100, 160), danmaku(300.4, 360.6, 0.9)],
    duration: 1000, boundaries: [], overrides: { add: [{ start: 500, end: 540 }] }, settings: S,
  });
  assertEquals(segs.map((s) => s.id), ['c:100-160', 'd:300-361', 'u:500-540']);
  assertEquals(new Set(segs.map((s) => s.id)).size, segs.length);
  for (const s of segs) {
    assertStrictEquals(s.enabled, true);
    assert(Array.isArray(s.sources) && s.sources.length >= 1);
    assert(typeof s.autoSkip === 'boolean');
  }
});

Deno.test('fuse: autoSkip follows minConfidence; offerOnly never auto-skips', () => {
  const cands = [danmaku(100, 160, 0.6), danmaku(300, 360, 0.59), danmaku(500, 560, 0.95, { offerOnly: true })];
  const segs = BAS.fuse({ candidates: cands, duration: 1000, boundaries: [], settings: S });
  assertEquals(segs.map((s) => s.autoSkip), [true, false, false]);
  assertStrictEquals(segs[2].offerOnly, true);
  const strict = BAS.fuse({ candidates: cands, duration: 1000, boundaries: [], settings: Object.assign({}, S, { minConfidence: 0.9 }) });
  assertEquals(strict.map((s) => s.autoSkip), [false, false, false]);
  const lax = BAS.fuse({ candidates: cands, duration: 1000, boundaries: [], settings: Object.assign({}, S, { minConfidence: 0.1 }) });
  assertEquals(lax.map((s) => s.autoSkip), [true, true, false]);
});

Deno.test('fuse: offerOnly merged with a real ad candidate becomes a real ad', () => {
  const segs = BAS.fuse({
    candidates: [danmaku(0, 60, 0.5, { offerOnly: true }), danmaku(40, 120, 0.9)],
    duration: 1000, boundaries: [], settings: S,
  });
  assertEquals(segs.length, 1);
  assertStrictEquals(segs[0].offerOnly, false);
  assertStrictEquals(segs[0].confidence, 0.9);
  assertStrictEquals(segs[0].autoSkip, true);
});

Deno.test('fuse: disabled sources are removed', () => {
  const cands = [chapter(100, 160), danmaku(300, 360, 0.9)];
  const noCh = BAS.fuse({ candidates: cands, duration: 1000, boundaries: [], settings: Object.assign({}, S, { useChapters: false }) });
  assertEquals(noCh.map((s) => s.source), ['danmaku']);
  const noDm = BAS.fuse({ candidates: cands, duration: 1000, boundaries: [], settings: Object.assign({}, S, { useDanmaku: false }) });
  assertEquals(noDm.map((s) => s.source), ['chapter']);
  const none = BAS.fuse({ candidates: cands, duration: 1000, boundaries: [], settings: Object.assign({}, S, { useChapters: false, useDanmaku: false }) });
  assertEquals(none.length, 0);
  assertEquals(none.diagnostics.dropped.length, 2);
  // user overrides survive regardless
  const user = BAS.fuse({ candidates: cands, duration: 1000, overrides: { add: [{ start: 10, end: 20 }] }, settings: Object.assign({}, S, { useChapters: false, useDanmaku: false }) });
  assertEquals(user.map((s) => s.source), ['user']);
});

Deno.test('fuse: inputs are not mutated and garbage is tolerated', () => {
  const c = danmaku(254, 358, 0.9);
  const frozen = JSON.stringify(c);
  BAS.fuse({ candidates: [c], duration: 1000, boundaries: [250], media: fakeMedia([{ t: 361 }]), settings: S });
  assertEquals(JSON.stringify(c), frozen);
  assertEquals(BAS.fuse(null).length, 0);
  assertEquals(BAS.fuse({}).length, 0);
  const segs = BAS.fuse({ candidates: [null, 'x', { start: 'a' }, { start: -5, end: 10 }, { start: 10, end: 'b' }, danmaku(20, 60, 'high')], duration: 100 });
  assertEquals(segs.map((s) => [s.start, s.end, s.confidence]), [[20, 60, 0]]);
});
