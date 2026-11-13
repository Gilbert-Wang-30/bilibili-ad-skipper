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

Deno.test('fuse: overrides.ignore removes segments overlapping > 50 % and clips the rest; overrides.add becomes a user segment', () => {
  const segs = BAS.fuse({
    candidates: [danmaku(100, 160, 0.9), danmaku(300, 360, 0.9)],
    duration: 1000, boundaries: [],
    overrides: { ignore: [{ start: 100, end: 160 }, { start: 340, end: 400 }], add: [{ start: 500, end: 530 }] },
    settings: S,
  });
  // 100-160 fully ignored; 300-360 overlaps 340-400 by 20/60 = 33 % -> kept, without the ignored part; user 500-530 added
  assertEquals(segs.map((s) => [s.start, s.end, s.source, s.id]), [[300, 340, 'danmaku', 'd:300-340'], [500, 530, 'user', 'u:500-530']]);
  const user = segs[1];
  assertStrictEquals(user.confidence, 1);
  assertStrictEquals(user.autoSkip, true);
  assertEquals(user.sources, ['user']);
  assertStrictEquals(user.id, 'u:500-530');
  // the ignored estimate and the cut-out part, both listed for the popup's 恢复
  assertEquals(segs.diagnostics.dropped.map((d) => [d.start, d.end, d.dropReason]), [[100, 160, '用户已忽略'], [340, 360, '用户已忽略']]);
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
  // the two confident estimates join; the weak one merely touching them stays its own (offered) segment
  assertEquals(segs.map((s) => [s.start, s.end, s.autoSkip]), [[100, 200, true], [200, 240, false], [400, 450, false]]);
  assertStrictEquals(segs[0].confidence, 0.9);
  assertEquals(segs[0].sources, ['danmaku']);
  // two weak ones still join (neither would skip on its own)
  const weak = BAS.fuse({ candidates: [danmaku(100, 160, 0.3), danmaku(150, 240, 0.4)], duration: 1000, boundaries: [], settings: S });
  assertEquals(weak.map((s) => [s.start, s.end, s.autoSkip]), [[100, 240, false]]);

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
  // the overlap is the real ad (auto); the offer's own part before it stays offered, it is not skipped through the merge
  assertEquals(segs.map((s) => [s.start, s.end, s.autoSkip, !!s.offerOnly]), [[0, 40, false, true], [40, 120, true, false]]);
  assertStrictEquals(segs[1].confidence, 0.9);
  assert(segs[1].sources.includes('danmaku') && segs[1].evidence.merged.some((m) => m.start === 40 && m.end === 60));
  assertEquals(segs[0].evidence.partOf, { start: 0, end: 60 });
});

Deno.test('fuse: a confident segment leads a merge with a weak one — its range, id, source and reason; the weak parts outside it stay offered', () => {
  // a weak, long danmaku estimate around a confident model skip (the case that stretched a skip over 3 minutes)
  const model = danmaku(138, 156, 0.85, { reason: '弹幕/热度模型：广告（97%）', evidence: { bins: { p: 0.97, net: true } } });
  const weak = danmaku(100, 350, 0.42, { reason: '弹幕 3 条' });
  const segs = BAS.fuse({ candidates: [weak, model], duration: 1000, boundaries: [], settings: S });
  assertEquals(segs.map((s) => [s.start, s.end, s.autoSkip]), [[100, 138, false], [138, 156, true], [156, 350, false]]);
  assertEquals([segs[1].reason, segs[1].id, !!segs[1].evidence.bins], ['弹幕/热度模型：广告（97%）', 'd:138-156', true]);
  // the representative is the confident one even when the weak one has a higher-priority source and a higher score
  const offer = { start: 20, end: 140, source: 'subtitle', confidence: 0.95, offerOnly: true, reason: '字幕：口播（62%）' };
  const s2 = BAS.fuse({ candidates: [offer, danmaku(30, 60, 0.75)], duration: 1000, boundaries: [], settings: S });
  const auto = s2.filter((s) => s.autoSkip);
  assertEquals(auto.map((s) => [s.start, s.end, s.source, s.id]), [[30, 60, 'danmaku', 'd:30-60']]);
  assertEquals(s2.filter((s) => !s.autoSkip).map((s) => [s.start, s.end]), [[20, 30], [60, 140]]);
});

Deno.test('fuse: what auto-skips never depends on the weak estimates (touching confident segments still join)', () => {
  const sure = [danmaku(100, 160, 0.8), danmaku(160, 200, 0.7)];
  const plain = BAS.fuse({ candidates: sure, duration: 1000, boundaries: [], settings: S });
  for (const w of [danmaku(150, 190, 0.4), danmaku(150, 205, 0.4), { start: 160, end: 170, source: 'heat', confidence: 0.5, offerOnly: true, reason: '热度' }]) {
    const segs = BAS.fuse({ candidates: sure.concat([w]), duration: 1000, boundaries: [], settings: S });
    assertEquals(segs.filter((s) => s.autoSkip).map((s) => [s.start, s.end, s.id]), plain.map((s) => [s.start, s.end, s.id]));
  }
  assertEquals(BAS.fuse.mergeOverlaps([danmaku(5, 10, 0.8), danmaku(0, 20, 0.4), danmaku(10, 25, 0.8)], 0.6).map((s) => [s.start, s.end]), [[0, 5], [5, 25]]);
});

Deno.test('fuse: ignored ranges also clip what they only partly cover (a skip undone, a part of a weak estimate ignored)', () => {
  const model = danmaku(138, 156, 0.85), weak = danmaku(100, 350, 0.42), ad2 = danmaku(300, 330, 0.8);
  const run = (ignore) => BAS.fuse({ candidates: [weak, model, ad2], duration: 1000, boundaries: [], settings: S, overrides: { ignore } })
    .map((s) => [s.start, s.end, s.autoSkip]);
  assertEquals(run([]), [[100, 138, false], [138, 156, true], [156, 300, false], [300, 330, true], [330, 350, false]]);
  // the model skip undone / ignored: nothing over it, the other ad still skips, the weak estimate's other parts stay offered
  assertEquals(run([{ start: 138, end: 156 }]), [[100, 138, false], [156, 300, false], [300, 330, true], [330, 350, false]]);
  // one offered part ignored: it goes, the rest stays
  assertEquals(run([{ start: 100, end: 138 }]), [[138, 156, true], [156, 300, false], [300, 330, true], [330, 350, false]]);
  // most of a weak estimate ignored: only that range goes (its other part stays offered), listed for the popup's 恢复
  const r = BAS.fuse({ candidates: [weak, model], duration: 1000, boundaries: [], settings: S, overrides: { ignore: [{ start: 156, end: 350 }] } });
  assertEquals(r.map((s) => [s.start, s.end, s.autoSkip]), [[100, 138, false], [138, 156, true]]);
  assertEquals(r.diagnostics.dropped.filter((d) => d.dropReason === '用户已忽略').map((d) => [d.start, d.end]), [[156, 350]]);
});

Deno.test('fuse: pieces cut by an ignored range keep ids of their own; a read below minConfidence does not take over danmaku', () => {
  const ids = (cands, ignore) => BAS.fuse({ candidates: cands, duration: 1000, boundaries: [], settings: S, overrides: { ignore } }).map((s) => [s.start, s.end, s.id]);
  assertEquals(ids([danmaku(100, 200, 0.9)], [{ start: 140, end: 160 }]), [[100, 140, 'd:100-140'], [160, 200, 'd:160-200']]);
  // the first piece gone (its start refined to 136): the second keeps its id
  assertEquals(ids([danmaku(136, 200, 0.9, { lockStart: true, idStart: 100 })], [{ start: 140, end: 160 }]), [[160, 200, 'd:160-200']]);
  // a weak piece sharing the skip's anchors does not take its id
  const segs = BAS.fuse({ candidates: [danmaku(104, 160, 0.9, { lockStart: true, idStart: 100, idEnd: 160 }), danmaku(95, 140, 0.4, { idStart: 100, idEnd: 160 })], duration: 1000, boundaries: [], settings: S });
  assertEquals(segs.filter((s) => s.autoSkip).map((s) => s.id), ['d:100-160']);
  // minConfidence 0.8: a 0.78 read does not swallow a 0.85 danmaku estimate
  const S8 = Object.assign({}, S, { minConfidence: 0.8 });
  const r = BAS.fuse({ candidates: [{ start: 100, end: 200, source: 'subtitle', confidence: 0.78, reason: '字幕：口播' }, danmaku(150, 180, 0.85)], duration: 1000, boundaries: [], settings: S8 });
  assert(r.some((s) => s.autoSkip && s.start === 150 && s.end === 180), JSON.stringify(r.map((s) => [s.start, s.end, s.source, s.autoSkip])));
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
